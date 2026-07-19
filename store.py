"""
The hosted sync layer's storage backend (H1.1).

Under end-to-end encryption the server can never read a journal row — every
note, pick, trail and mark is opaque ciphertext (BETA_PLAN.md §3). So this is a
deliberately dumb key/value store: it keeps `(ciphertext, nonce)` blobs scoped
by user UUID and hands them back, and keeps each user's wrapped data-encryption
keys. All the logic that used to read these rows (subjects, forest, picks
stats, search) moves into the browser over the decrypted-in-memory journal
(H1.2). The server's whole job here is store / fetch by user.

Two interchangeable backends behind one interface:

  * SQLiteStore — a local file. Powers `python server.py` on your laptop and the
    test suite, so neither needs a database or a network.
  * PostgresStore — Supabase Postgres via psycopg, used in the hosted env. Chosen
    automatically when config.SUPABASE_DB_URL is set. psycopg is imported lazily
    so local/dev/test never need it installed.

Both expose:

    get_rows(user_id, kind=None, since=None) -> [Row, ...]   # incl. tombstones
    upsert_rows(user_id, rows)               -> int           # rows written
    delete_row(user_id, kind, client_id)     -> bool          # tombstone
    get_keys(user_id)                        -> dict | None
    put_keys(user_id, key_material)          -> dict          # stored material

A "Row" is a dict: {kind, client_id, ciphertext(bytes), nonce(bytes),
updated_at(iso str), deleted(bool)}. The HTTP layer (server.py) base64-encodes
ciphertext/nonce at the boundary; inside the store they are raw bytes.

Deletes are tombstones (`deleted_at` stamped, blob cleared) so a second device
syncing later learns the row is gone instead of silently keeping it. The app
always scopes every query by user_id; Postgres RLS (`user_id = auth.uid()`) is a
backstop for any access that doesn't come through this trusted server path.
"""
import json
import sqlite3
import threading
from datetime import datetime, timedelta, timezone

import config

# "choice" was "pick" before v7. Legacy "pick" is still accepted so a migrated
# client can tombstone its old pick-kind rows after re-keying them to "choice"
# (journal-store.js::_migrateChoiceKind); nothing writes new "pick" rows.
KINDS = ("note", "choice", "trail", "mark", "pick")


class StoreError(Exception):
    """A storage-layer failure the route layer should surface as a 5xx/4xx."""

    def __init__(self, message, status=500):
        super().__init__(message)
        self.message = message
        self.status = status


def _now():
    # Microsecond precision so delta-sync `since` filtering doesn't collapse two
    # writes made in the same second into one cursor value.
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def _days_ago(days):
    # Same shape as _now(), so lexicographic comparison against stored SQLite
    # timestamps is a correct time comparison.
    return (datetime.now(timezone.utc)
            - timedelta(days=days)).isoformat(timespec="microseconds")


def _validate_kind(kind):
    if kind not in KINDS:
        raise StoreError(f"unknown row kind: {kind!r}", status=400)


def _as_bytes(value, field):
    if isinstance(value, memoryview):
        return value.tobytes()
    if isinstance(value, bytearray):
        return bytes(value)
    if isinstance(value, bytes):
        return value
    raise StoreError(f"{field} must be bytes", status=400)


# ---------------------------------------------------------------------------
# SQLite backend (local + tests)
# ---------------------------------------------------------------------------
class SQLiteStore:
    SCHEMA = """
    CREATE TABLE IF NOT EXISTS journal_rows (
        user_id     TEXT NOT NULL,
        kind        TEXT NOT NULL,
        client_id   TEXT NOT NULL,
        ciphertext  BLOB,
        nonce       BLOB,
        created_at  TEXT,               -- 0008 parity: set on insert, kept on edit
        updated_at  TEXT NOT NULL,
        deleted_at  TEXT,
        PRIMARY KEY (user_id, kind, client_id)
    );
    CREATE INDEX IF NOT EXISTS idx_journal_rows_user_updated
        ON journal_rows (user_id, updated_at);

    CREATE TABLE IF NOT EXISTS user_keys (
        user_id       TEXT PRIMARY KEY,
        key_material  TEXT NOT NULL,   -- JSON; opaque to the server
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS access_requests (
        email       TEXT PRIMARY KEY,   -- one row per email (repeat asks collapse)
        note        TEXT,
        user_agent  TEXT,
        status      TEXT NOT NULL DEFAULT 'new',   -- new | invited | declined
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    );
    """

    def __init__(self, path):
        self.path = path

    def _conn(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        c = sqlite3.connect(self.path, timeout=30)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA busy_timeout=30000")
        c.executescript(self.SCHEMA)
        # 0008 parity: a store file from before created_at gains the column here
        # (nullable — content_series COALESCEs to updated_at for those old rows).
        # On a current file the ALTER errors as duplicate and is ignored.
        try:
            c.execute("ALTER TABLE journal_rows ADD COLUMN created_at TEXT")
        except sqlite3.OperationalError:
            pass
        return c

    def ping(self):
        """Cheap liveness probe for /healthz: prove the store file is reachable
        and answers a trivial query. Raises StoreError on failure."""
        try:
            with self._conn() as c:
                c.execute("SELECT 1").fetchone()
        except Exception as e:  # noqa: BLE001 - normalize to StoreError
            raise StoreError(f"sqlite store ping failed: {e}", status=503)
        return True

    def get_rows(self, user_id, kind=None, since=None):
        sql = ("SELECT kind, client_id, ciphertext, nonce, updated_at, "
               "deleted_at FROM journal_rows WHERE user_id=?")
        params = [user_id]
        if kind is not None:
            _validate_kind(kind)
            sql += " AND kind=?"
            params.append(kind)
        if since:
            sql += " AND updated_at > ?"
            params.append(since)
        sql += " ORDER BY updated_at ASC, kind ASC, client_id ASC"
        with self._conn() as c:
            rows = c.execute(sql, params).fetchall()
        return [{
            "kind": r["kind"], "client_id": r["client_id"],
            "ciphertext": (b"" if r["ciphertext"] is None
                           else _as_bytes(r["ciphertext"], "ciphertext")),
            "nonce": (b"" if r["nonce"] is None
                      else _as_bytes(r["nonce"], "nonce")),
            "updated_at": r["updated_at"],
            "deleted": r["deleted_at"] is not None,
        } for r in rows]

    def upsert_rows(self, user_id, rows):
        now = _now()
        written = 0
        with self._conn() as c:
            for row in rows:
                _validate_kind(row.get("kind"))
                cid = row.get("client_id")
                if not cid or not isinstance(cid, str):
                    raise StoreError("each row needs a string client_id",
                                     status=400)
                if row.get("deleted"):
                    c.execute(
                        """INSERT INTO journal_rows
                           (user_id, kind, client_id, ciphertext, nonce,
                            created_at, updated_at, deleted_at)
                           VALUES (?,?,?,NULL,NULL,?,?,?)
                           ON CONFLICT(user_id, kind, client_id) DO UPDATE SET
                             ciphertext=NULL, nonce=NULL,
                             updated_at=excluded.updated_at,
                             deleted_at=excluded.deleted_at""",
                        (user_id, row["kind"], cid, now, now, now))
                else:
                    ct = _as_bytes(row.get("ciphertext"), "ciphertext")
                    no = _as_bytes(row.get("nonce"), "nonce")
                    c.execute(
                        """INSERT INTO journal_rows
                           (user_id, kind, client_id, ciphertext, nonce,
                            created_at, updated_at, deleted_at)
                           VALUES (?,?,?,?,?,?,?,NULL)
                           ON CONFLICT(user_id, kind, client_id) DO UPDATE SET
                             ciphertext=excluded.ciphertext,
                             nonce=excluded.nonce,
                             updated_at=excluded.updated_at,
                             deleted_at=NULL""",
                        (user_id, row["kind"], cid, ct, no, now, now))
                written += 1
            c.commit()
        return written

    def delete_row(self, user_id, kind, client_id):
        _validate_kind(kind)
        now = _now()
        with self._conn() as c:
            cur = c.execute(
                """UPDATE journal_rows
                   SET ciphertext=NULL, nonce=NULL, updated_at=?, deleted_at=?
                   WHERE user_id=? AND kind=? AND client_id=?
                     AND deleted_at IS NULL""",
                (now, now, user_id, kind, client_id))
            c.commit()
            return cur.rowcount > 0

    def delete_user(self, user_id):
        """Hard-delete ALL of a user's stored data — every journal row (tombstones
        included) and their wrapped keys. Irreversible; the account-deletion path.
        Because user_keys holds the ONLY copy of the wrapped DEK, dropping it
        renders any residual ciphertext permanently undecryptable. Returns
        {'rows': n, 'keys': m} — the counts removed."""
        with self._conn() as c:
            rows = c.execute(
                "DELETE FROM journal_rows WHERE user_id=?", (user_id,)).rowcount
            keys = c.execute(
                "DELETE FROM user_keys WHERE user_id=?", (user_id,)).rowcount
            c.commit()
        return {"rows": max(rows, 0), "keys": max(keys, 0)}

    def delete_auth_user(self, user_id):
        """No-op on SQLite: local/dev/test has no Supabase auth.users table, so
        there is no login/email to remove. Returns False so the route reports the
        auth identity was untouched (only PostgresStore can delete it)."""
        return False

    def get_keys(self, user_id):
        with self._conn() as c:
            r = c.execute(
                "SELECT key_material, created_at, updated_at "
                "FROM user_keys WHERE user_id=?", (user_id,)).fetchone()
        if not r:
            return None
        return {"key_material": json.loads(r["key_material"]),
                "created_at": r["created_at"], "updated_at": r["updated_at"]}

    def put_keys(self, user_id, key_material):
        now = _now()
        blob = json.dumps(key_material)
        with self._conn() as c:
            c.execute(
                """INSERT INTO user_keys
                   (user_id, key_material, created_at, updated_at)
                   VALUES (?,?,?,?)
                   ON CONFLICT(user_id) DO UPDATE SET
                     key_material=excluded.key_material,
                     updated_at=excluded.updated_at""",
                (user_id, blob, now, now))
            c.commit()
        return self.get_keys(user_id)

    # --- access requests (a logged-out guest asking for an invite) ----------
    # Not E2EE and not per-user: an uninvited visitor has no account. Upsert by
    # email so repeated asks collapse to one row (created_at preserved); the
    # operator reviews these and invites by hand. Unrelated to journal_rows.
    def add_access_request(self, email, note=None, user_agent=None):
        now = _now()
        with self._conn() as c:
            c.execute(
                """INSERT INTO access_requests
                   (email, note, user_agent, status, created_at, updated_at)
                   VALUES (?,?,?, 'new', ?, ?)
                   ON CONFLICT(email) DO UPDATE SET
                     note=excluded.note,
                     user_agent=excluded.user_agent,
                     updated_at=excluded.updated_at""",
                (email, note, user_agent, now, now))
            c.commit()
        return {"email": email, "created_at": now}

    def list_access_requests(self):
        """Every pending/handled request, newest first. Operator convenience for
        the local backend; in hosted mode the operator reads the Postgres table."""
        with self._conn() as c:
            rows = c.execute(
                "SELECT email, note, user_agent, status, created_at, updated_at "
                "FROM access_requests ORDER BY created_at DESC").fetchall()
        return [dict(r) for r in rows]

    def prune_access_requests(self, handled_days, max_days):
        """Retention prune (Privacy Policy §6): delete handled (invited/declined)
        requests `handled_days` after the decision, and ANY request `max_days`
        after its last activity, so no email outlives its stated window. Either
        window can be 0 to disable that rule. Returns rows deleted."""
        deleted = 0
        with self._conn() as c:
            if handled_days:
                deleted += c.execute(
                    "DELETE FROM access_requests "
                    "WHERE status != 'new' AND updated_at < ?",
                    (_days_ago(handled_days),)).rowcount
            if max_days:
                deleted += c.execute(
                    "DELETE FROM access_requests WHERE updated_at < ?",
                    (_days_ago(max_days),)).rowcount
            c.commit()
        return max(deleted, 0)

    def usage_stats(self):
        """Best-effort storage metrics for the operator cost panel (H4b): how
        many accounts / live rows / access requests we hold, plus the store
        file's size on disk. Read-only and cheap; _conn() guarantees the schema,
        so every table exists. Same shape as the Postgres backend."""
        with self._conn() as c:
            out = {
                "backend": "sqlite",
                "accounts": c.execute(
                    "SELECT COUNT(*) FROM user_keys").fetchone()[0],
                "journal_rows": c.execute(
                    "SELECT COUNT(*) FROM journal_rows "
                    "WHERE deleted_at IS NULL").fetchone()[0],
                "access_requests": c.execute(
                    "SELECT COUNT(*) FROM access_requests").fetchone()[0],
            }
        try:
            out["db_bytes"] = self.path.stat().st_size
        except OSError:
            out["db_bytes"] = None
        return out

    def content_stats(self):
        """Anonymized notebook METADATA for the /admin Usage panel: how many live
        keeps and notes are stored, by row kind. Counts only — the ciphertext is
        never read, so this can never reveal what anyone kept or wrote (E2EE)."""
        with self._conn() as c:
            keeps = c.execute(
                "SELECT COUNT(*) FROM journal_rows "
                "WHERE kind IN ('choice','pick') AND deleted_at IS NULL").fetchone()[0]
            notes = c.execute(
                "SELECT COUNT(*) FROM journal_rows "
                "WHERE kind='note' AND deleted_at IS NULL").fetchone()[0]
        return {"keeps": keeps, "notes": notes}

    def content_series(self, days=30):
        """Per-day NEW live-entry counts by kind (keeps/notes) for the Usage tab's
        notebook chart, plus the totals from before the window so a running total
        starts at the right height. Dated by created_at where the row has one,
        else updated_at (rows older than that column) — server-arrival time either
        way; the E2EE ciphertext, including any timestamp inside it, is never
        read. Counts only, no user ids."""
        start = _days_ago(int(days))[:10]
        day = "substr(COALESCE(created_at, updated_at), 1, 10)"
        with self._conn() as c:
            rows = c.execute(
                f"SELECT {day} AS d, "
                "SUM(kind IN ('choice','pick')) AS keeps, "
                "SUM(kind = 'note') AS notes "
                "FROM journal_rows WHERE deleted_at IS NULL "
                "AND kind IN ('choice','pick','note') "
                f"AND {day} >= ? GROUP BY d ORDER BY d", (start,)).fetchall()
            base = c.execute(
                "SELECT SUM(kind IN ('choice','pick')) AS keeps, "
                "SUM(kind = 'note') AS notes "
                "FROM journal_rows WHERE deleted_at IS NULL "
                "AND kind IN ('choice','pick','note') "
                f"AND {day} < ?", (start,)).fetchone()
        return {"available": True, "days": int(days), "dated_by": "created_at",
                "by_day": [{"day": r["d"], "keeps": r["keeps"], "notes": r["notes"]}
                           for r in rows],
                "baseline": {"keeps": base["keeps"] or 0, "notes": base["notes"] or 0}}

    def access_request_counts(self):
        """Counts by status for the Usage tab's Guests row ({new, invited,
        declined}). Metadata only — no address leaves this query."""
        with self._conn() as c:
            rows = c.execute(
                "SELECT status, COUNT(*) AS n FROM access_requests "
                "GROUP BY status").fetchall()
        out = {"new": 0, "invited": 0, "declined": 0}
        for r in rows:
            if r["status"] in out:
                out[r["status"]] = r["n"]
        return out

    def account_activity(self, days=30):
        """SQLite/dev has no Supabase auth.users, so account activity (sign-ins,
        signups) is a hosted-only metric. Say so plainly rather than fake zeros."""
        return {"available": False}


# ---------------------------------------------------------------------------
# Postgres backend (Supabase, hosted)
# ---------------------------------------------------------------------------
class PostgresStore:
    """Same interface as SQLiteStore, over Supabase Postgres via psycopg (v3).

    Connects with the DB-role credentials (config.SUPABASE_DB_URL), so this
    trusted server path is not itself constrained by RLS; it enforces user
    scoping in every query instead, and RLS guards the public PostgREST/anon
    path as a backstop. psycopg is imported lazily so it's only a dependency in
    the hosted env."""

    def __init__(self, dsn):
        self.dsn = dsn
        self._conn = None
        # psycopg is imported HERE — on the constructing thread — and not
        # lazily inside _connect, because the retention sweep and gthread
        # request threads all hit _connect concurrently right at worker boot,
        # and a first `import psycopg` racing across threads can hand one of
        # them a partially initialized module ("module 'psycopg' has no
        # attribute 'connect'" — seen live 2026-07-02, wedging the worker for
        # good). get_store() constructs under _STORE_LOCK before the sweep
        # thread is spawned, so this import is single-flight and complete
        # before any other thread can reach the store. Still hosted-only: the
        # constructor only runs when SUPABASE_DB_URL is set. ImportError stays
        # non-fatal so a misconfigured env still boots and serves the catalog;
        # _connect reports it per-request exactly as before.
        try:
            import psycopg  # noqa: WPS433 - hosted-only dependency
            from psycopg.types.json import Jsonb
            self._psycopg = psycopg
            self._jsonb = Jsonb
        except ImportError:  # pragma: no cover - exercised only when hosted
            self._psycopg = None
            self._jsonb = None

    def _connect(self):
        if self._psycopg is None:
            raise StoreError(
                "psycopg is required for the hosted Postgres store "
                "(pip install 'psycopg[binary]')", status=500)
        if self._conn is None or self._conn.closed:
            self._conn = self._psycopg.connect(self.dsn, autocommit=True)
        return self._conn

    def _cursor(self):
        try:
            return self._connect().cursor()
        except Exception as e:  # noqa: BLE001 - normalize to StoreError
            self._conn = None
            raise StoreError(f"database connection failed: {e}", status=503)

    def ping(self):
        """Liveness probe for /healthz: a trivial query that also proves the
        Supabase Postgres connection is up. Raises StoreError(503) on failure
        (via _cursor, which already normalizes connection errors)."""
        with self._cursor() as cur:
            cur.execute("SELECT 1")
            cur.fetchone()
        return True

    def get_rows(self, user_id, kind=None, since=None):
        sql = ("SELECT kind, client_id, ciphertext, nonce, updated_at, "
               "deleted_at FROM journal_rows WHERE user_id=%s")
        params = [user_id]
        if kind is not None:
            _validate_kind(kind)
            sql += " AND kind=%s"
            params.append(kind)
        if since:
            sql += " AND updated_at > %s::timestamptz"
            params.append(since)
        sql += " ORDER BY updated_at ASC, kind ASC, client_id ASC"
        with self._cursor() as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()
        out = []
        for kind_, cid, ct, no, updated, deleted_at in rows:
            out.append({
                "kind": kind_, "client_id": cid,
                "ciphertext": b"" if ct is None else _as_bytes(ct, "ciphertext"),
                "nonce": b"" if no is None else _as_bytes(no, "nonce"),
                "updated_at": updated.isoformat() if hasattr(updated, "isoformat")
                else str(updated),
                "deleted": deleted_at is not None,
            })
        return out

    def upsert_rows(self, user_id, rows):
        written = 0
        with self._cursor() as cur:
            for row in rows:
                _validate_kind(row.get("kind"))
                cid = row.get("client_id")
                if not cid or not isinstance(cid, str):
                    raise StoreError("each row needs a string client_id",
                                     status=400)
                if row.get("deleted"):
                    cur.execute(
                        """INSERT INTO journal_rows
                           (user_id, kind, client_id, ciphertext, nonce,
                            updated_at, deleted_at)
                           VALUES (%s,%s,%s,NULL,NULL,now(),now())
                           ON CONFLICT (user_id, kind, client_id) DO UPDATE SET
                             ciphertext=NULL, nonce=NULL,
                             updated_at=now(), deleted_at=now()""",
                        (user_id, row["kind"], cid))
                else:
                    ct = _as_bytes(row.get("ciphertext"), "ciphertext")
                    no = _as_bytes(row.get("nonce"), "nonce")
                    cur.execute(
                        """INSERT INTO journal_rows
                           (user_id, kind, client_id, ciphertext, nonce,
                            updated_at, deleted_at)
                           VALUES (%s,%s,%s,%s,%s,now(),NULL)
                           ON CONFLICT (user_id, kind, client_id) DO UPDATE SET
                             ciphertext=excluded.ciphertext,
                             nonce=excluded.nonce,
                             updated_at=now(), deleted_at=NULL""",
                        (user_id, row["kind"], cid, ct, no))
                written += 1
        return written

    def delete_row(self, user_id, kind, client_id):
        _validate_kind(kind)
        with self._cursor() as cur:
            cur.execute(
                """UPDATE journal_rows
                   SET ciphertext=NULL, nonce=NULL,
                       updated_at=now(), deleted_at=now()
                   WHERE user_id=%s AND kind=%s AND client_id=%s
                     AND deleted_at IS NULL""",
                (user_id, kind, client_id))
            return cur.rowcount > 0

    def delete_user(self, user_id):
        """Hard-delete ALL of a user's app data (journal rows + wrapped keys).
        Irreversible; the account-deletion path. Dropping user_keys removes the
        only copy of the wrapped DEK, so any residual ciphertext becomes
        permanently undecryptable. Returns {'rows': n, 'keys': m}."""
        with self._cursor() as cur:
            cur.execute("DELETE FROM journal_rows WHERE user_id=%s", (user_id,))
            rows = cur.rowcount
            cur.execute("DELETE FROM user_keys WHERE user_id=%s", (user_id,))
            keys = cur.rowcount
        return {"rows": max(rows, 0), "keys": max(keys, 0)}

    def delete_auth_user(self, user_id):
        """Remove the Supabase Auth identity — the auth.users row (login + email),
        cascading to Supabase's own auth sub-tables — via the trusted Postgres
        role, and drop any access_requests that share the email. Best-effort:
        returns True iff the auth.users row was deleted. The route gates this
        behind config.ACCOUNT_DELETE_AUTH so it only runs when the operator has
        confirmed the DB role may touch the auth schema. Call delete_user() FIRST
        so the app data is gone even if this can't remove the login."""
        with self._cursor() as cur:
            cur.execute("SELECT email FROM auth.users WHERE id=%s::uuid",
                        (user_id,))
            row = cur.fetchone()
            if row and row[0]:
                cur.execute(
                    "DELETE FROM access_requests WHERE lower(email)=lower(%s)",
                    (row[0],))
            cur.execute("DELETE FROM auth.users WHERE id=%s::uuid", (user_id,))
            return cur.rowcount > 0

    def get_keys(self, user_id):
        with self._cursor() as cur:
            cur.execute(
                "SELECT key_material, created_at, updated_at "
                "FROM user_keys WHERE user_id=%s", (user_id,))
            r = cur.fetchone()
        if not r:
            return None
        material, created, updated = r
        if isinstance(material, (str, bytes)):
            material = json.loads(material)
        return {"key_material": material,
                "created_at": created.isoformat() if hasattr(created, "isoformat")
                else str(created),
                "updated_at": updated.isoformat() if hasattr(updated, "isoformat")
                else str(updated)}

    def put_keys(self, user_id, key_material):
        with self._cursor() as cur:
            cur.execute(
                """INSERT INTO user_keys
                   (user_id, key_material, created_at, updated_at)
                   VALUES (%s,%s,now(),now())
                   ON CONFLICT (user_id) DO UPDATE SET
                     key_material=excluded.key_material,
                     updated_at=now()""",
                (user_id, self._jsonb(key_material)))
        return self.get_keys(user_id)

    # --- access requests (a logged-out guest asking for an invite) ----------
    # Written by the trusted server path (DB role), so RLS doesn't constrain it;
    # the migration adds the table + an admin-only read policy. Upsert by email
    # so repeated asks collapse to one row (created_at preserved).
    def add_access_request(self, email, note=None, user_agent=None):
        with self._cursor() as cur:
            cur.execute(
                """INSERT INTO access_requests
                   (email, note, user_agent, status, created_at, updated_at)
                   VALUES (%s,%s,%s, 'new', now(), now())
                   ON CONFLICT (email) DO UPDATE SET
                     note=excluded.note,
                     user_agent=excluded.user_agent,
                     updated_at=now()""",
                (email, note, user_agent))
        return {"email": email}

    def list_access_requests(self):
        with self._cursor() as cur:
            cur.execute(
                "SELECT email, note, user_agent, status, created_at, updated_at "
                "FROM access_requests ORDER BY created_at DESC")
            rows = cur.fetchall()
        out = []
        for email, note, ua, status, created, updated in rows:
            out.append({
                "email": email, "note": note, "user_agent": ua, "status": status,
                "created_at": created.isoformat() if hasattr(created, "isoformat") else str(created),
                "updated_at": updated.isoformat() if hasattr(updated, "isoformat") else str(updated),
            })
        return out

    def prune_access_requests(self, handled_days, max_days):
        """Retention prune (Privacy Policy §6) — same rules as the SQLite
        backend: handled rows go `handled_days` after the decision, any row goes
        `max_days` after its last activity. Returns rows deleted."""
        deleted = 0
        with self._cursor() as cur:
            if handled_days:
                cur.execute(
                    "DELETE FROM access_requests WHERE status != 'new' "
                    "AND updated_at < now() - make_interval(days => %s)",
                    (int(handled_days),))
                deleted += max(cur.rowcount, 0)
            if max_days:
                cur.execute(
                    "DELETE FROM access_requests "
                    "WHERE updated_at < now() - make_interval(days => %s)",
                    (int(max_days),))
                deleted += max(cur.rowcount, 0)
        return deleted

    def usage_stats(self):
        """Best-effort storage metrics for the operator cost panel (H4b), same
        shape as the SQLite backend: account / live-row / access-request counts
        plus the Supabase database size via pg_database_size(). autocommit means
        each statement is its own transaction, so guarding the access-request
        count (absent on a pre-0003 store) never poisons the session, and it runs
        last so a miss can't strand the guaranteed metrics."""
        out = {"backend": "postgres"}
        with self._cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM user_keys")
            out["accounts"] = cur.fetchone()[0]
            cur.execute(
                "SELECT COUNT(*) FROM journal_rows WHERE deleted_at IS NULL")
            out["journal_rows"] = cur.fetchone()[0]
            cur.execute("SELECT pg_database_size(current_database())")
            out["db_bytes"] = cur.fetchone()[0]
            try:
                cur.execute("SELECT COUNT(*) FROM access_requests")
                out["access_requests"] = cur.fetchone()[0]
            except Exception:  # noqa: BLE001 - pre-0003 store: table may be absent
                out["access_requests"] = None
        return out

    def content_stats(self):
        """Anonymized notebook METADATA (Usage panel): live keep/note COUNTS by kind.
        The ciphertext is never read — counts only, so E2EE content is untouched."""
        out = {}
        with self._cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM journal_rows "
                        "WHERE kind IN ('choice','pick') AND deleted_at IS NULL")
            out["keeps"] = cur.fetchone()[0]
            cur.execute("SELECT COUNT(*) FROM journal_rows "
                        "WHERE kind='note' AND deleted_at IS NULL")
            out["notes"] = cur.fetchone()[0]
        return out

    def content_series(self, days=30):
        """Per-day NEW live-entry counts by kind (keeps/notes) + the totals from
        before the window, for the Usage tab's notebook chart and its running
        total. Tries created_at (migration 0008; ON CONFLICT never touches it, so
        an edit keeps its day) and degrades to updated_at on a pre-0008 store —
        `dated_by` says which, so the panel can be honest about it. Either way
        this is server-arrival time: the real write moment lives inside the E2EE
        ciphertext, which is never read. Counts only, no user ids. autocommit
        means the failed created_at probe can't poison the retry."""
        for col in ("created_at", "updated_at"):
            try:
                with self._cursor() as cur:
                    cur.execute(
                        f"SELECT to_char(date_trunc('day', {col}), 'YYYY-MM-DD') AS d, "
                        "COUNT(*) FILTER (WHERE kind IN ('choice','pick')) AS keeps, "
                        "COUNT(*) FILTER (WHERE kind = 'note') AS notes "
                        "FROM journal_rows WHERE deleted_at IS NULL "
                        "AND kind IN ('choice','pick','note') "
                        f"AND {col} >= now() - (%s || ' days')::interval "
                        "GROUP BY 1 ORDER BY 1", (int(days),))
                    by_day = [{"day": d, "keeps": k, "notes": n}
                              for d, k, n in cur.fetchall()]
                    cur.execute(
                        "SELECT COUNT(*) FILTER (WHERE kind IN ('choice','pick')), "
                        "COUNT(*) FILTER (WHERE kind = 'note') "
                        "FROM journal_rows WHERE deleted_at IS NULL "
                        "AND kind IN ('choice','pick','note') "
                        f"AND {col} < now() - (%s || ' days')::interval", (int(days),))
                    bk, bn = cur.fetchone()
                return {"available": True, "days": int(days), "dated_by": col,
                        "by_day": by_day, "baseline": {"keeps": bk, "notes": bn}}
            except Exception:  # noqa: BLE001 - pre-0008 store: created_at absent
                continue
        return {"available": False}

    def access_request_counts(self):
        """Counts by status for the Usage tab's Guests row. Metadata only — no
        address leaves this query. Guarded at the endpoint: a pre-0003 store
        without the table raises and reports requests_error instead."""
        with self._cursor() as cur:
            cur.execute(
                "SELECT status, COUNT(*) FROM access_requests GROUP BY status")
            rows = cur.fetchall()
        out = {"new": 0, "invited": 0, "declined": 0}
        for status, n in rows:
            if status in out:
                out[status] = n
        return out

    def account_activity(self, days=30):
        """Account metadata for the Usage panel, from Supabase auth.users —
        created_at + last_sign_in_at ONLY, never anything a person wrote. Totals,
        new signups (7/30d), active accounts (DAU/WAU/MAU via last sign-in), a
        dormant count, and a per-day signup histogram for the window. autocommit
        means each statement stands alone, so a missing column degrades to
        available:False rather than poisoning the session."""
        try:
            with self._cursor() as cur:
                cur.execute(
                    "SELECT COUNT(*) AS total, "
                    "COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days') AS new_7d, "
                    "COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days') AS new_30d, "
                    "COUNT(*) FILTER (WHERE last_sign_in_at >= now() - interval '1 day') AS active_1d, "
                    "COUNT(*) FILTER (WHERE last_sign_in_at >= now() - interval '7 days') AS active_7d, "
                    "COUNT(*) FILTER (WHERE last_sign_in_at >= now() - interval '30 days') AS active_30d, "
                    "COUNT(*) FILTER (WHERE last_sign_in_at IS NULL "
                    "  OR last_sign_in_at < now() - interval '30 days') AS dormant "
                    "FROM auth.users")
                keys = ["total", "new_7d", "new_30d", "active_1d", "active_7d",
                        "active_30d", "dormant"]
                out = {"available": True}
                out.update(dict(zip(keys, cur.fetchone())))
                cur.execute(
                    "SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS d, "
                    "COUNT(*) AS n FROM auth.users "
                    "WHERE created_at >= now() - (%s || ' days')::interval "
                    "GROUP BY 1 ORDER BY 1", (int(days),))
                out["signups_by_day"] = [{"day": d, "n": n} for d, n in cur.fetchall()]
                # A truer "actively using it" signal than last-sign-in (which a persistent
                # PWA session leaves stale): accounts that TOUCHED their notebook — kept or
                # wrote something — in the window. Metadata only (user_id + updated_at), the
                # ciphertext is never read. Distinct users, not rows.
                cur.execute("SELECT COUNT(DISTINCT user_id) FROM journal_rows "
                            "WHERE updated_at >= now() - interval '7 days'")
                out["active_savers_7d"] = cur.fetchone()[0]
                cur.execute("SELECT COUNT(DISTINCT user_id) FROM journal_rows "
                            "WHERE updated_at >= now() - interval '30 days'")
                out["active_savers_30d"] = cur.fetchone()[0]
            out["invites"] = self._invite_funnel(days)
            return out
        except Exception as e:  # noqa: BLE001 - report, never 500 the panel
            return {"available": False, "error": str(e)}

    def _invite_funnel(self, days=30):
        """Invite → account, from auth.users. Its OWN statement + guard so a Supabase
        schema that lacks `invited_at`/`confirmed_at` degrades to available:False here
        instead of taking the whole Usage panel down with it.

        WHY THIS EXISTS. Supabase's "Invite user" creates the auth.users row at SEND
        time, so `created_at` is when *we invited them*, not when they joined — which
        made the panel's "accounts created" histogram really a record of invite waves
        (15 rows on 2026-07-17 = the 15 invites sent that day, not 15 signups). The
        honest join signal is `confirmed_at`: for a magic-link invite, confirming the
        email IS the moment the account becomes theirs.

        Counts only over rows that were actually invited (`invited_at IS NOT NULL`), so
        an operator account made another way can't inflate "never opened it". Returns
        counts + the accept latency (median/max) + a per-day JOINED series to sit beside
        the invited one. Metadata only — no address ever leaves this query."""
        try:
            with self._cursor() as cur:
                cur.execute(
                    "SELECT COUNT(*) AS invited, "
                    "COUNT(*) FILTER (WHERE confirmed_at IS NOT NULL) AS joined, "
                    "COUNT(*) FILTER (WHERE confirmed_at IS NULL) AS never_opened, "
                    "COUNT(*) FILTER (WHERE confirmed_at IS NULL "
                    "  AND invited_at < now() - interval '7 days') AS cold, "
                    "EXTRACT(EPOCH FROM percentile_cont(0.5) WITHIN GROUP "
                    "  (ORDER BY confirmed_at - invited_at)) AS median_s, "
                    "EXTRACT(EPOCH FROM MAX(confirmed_at - invited_at)) AS max_s "
                    "FROM auth.users WHERE invited_at IS NOT NULL")
                row = cur.fetchone()
                keys = ["invited", "joined", "never_opened", "cold",
                        "median_accept_s", "max_accept_s"]
                out = {"available": True}
                out.update(dict(zip(keys, row)))
                for k in ("median_accept_s", "max_accept_s"):
                    out[k] = None if out[k] is None else int(out[k])
                # The series the old "accounts created" chart should have been: the day
                # someone actually joined, not the day we mailed them.
                cur.execute(
                    "SELECT to_char(date_trunc('day', confirmed_at), 'YYYY-MM-DD') AS d, "
                    "COUNT(*) AS n FROM auth.users "
                    "WHERE confirmed_at >= now() - (%s || ' days')::interval "
                    "GROUP BY 1 ORDER BY 1", (int(days),))
                out["joined_by_day"] = [{"day": d, "n": n} for d, n in cur.fetchall()]
            return out
        except Exception as e:  # noqa: BLE001 - one optional block, never the panel
            return {"available": False, "error": str(e)}


# ---------------------------------------------------------------------------
# Backend selection
# ---------------------------------------------------------------------------
_STORE = None
_STORE_KEY = None
# Serializes construction: without it, two request threads first-touching the
# store could both build a PostgresStore and race its psycopg import (see
# PostgresStore.__init__). With it, exactly one thread imports + constructs.
_STORE_LOCK = threading.Lock()


def get_store():
    """Return the process's store, building it from current config on first use
    (and rebuilding it if the relevant config changed — which is what lets a test
    repoint SYNC_DB_PATH between apps). Postgres when SUPABASE_DB_URL is set,
    else a local SQLite file."""
    global _STORE, _STORE_KEY
    key = (config.SUPABASE_DB_URL or None, str(config.SYNC_DB_PATH))
    with _STORE_LOCK:
        if _STORE is None or key != _STORE_KEY:
            if config.SUPABASE_DB_URL:
                _STORE = PostgresStore(config.SUPABASE_DB_URL)
            else:
                _STORE = SQLiteStore(config.SYNC_DB_PATH)
            _STORE_KEY = key
        return _STORE


def reset_store():
    """Drop the cached store (tests build several apps against different files)."""
    global _STORE, _STORE_KEY
    with _STORE_LOCK:
        _STORE = None
        _STORE_KEY = None
