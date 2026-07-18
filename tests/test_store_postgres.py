"""
Behavioral coverage for store.PostgresStore — the backend that holds every hosted
user's encrypted rows in production.

The default suite exercises only SQLiteStore, so the Postgres SQL (its `%s`
placeholders, `ON CONFLICT`, `now()`, `bytea`/`jsonb`/`timestamptz` handling) has
no automated coverage — it is proven only by running in production. This file runs
the SAME round-trips against a real Postgres when one is provided, so a
dialect/logic bug is caught before it reaches a user's irreplaceable journal.

It is gated, not skipped-forever: point AOTD_TEST_PG_DSN at a THROWAWAY Postgres
(the test creates its own tables + a minimal `auth.users`, and cleans up its user
after each test) and it runs. Locally with no Postgres it skips. E.g.:

    docker run --rm -e POSTGRES_PASSWORD=x -p 5432:5432 postgres:16
    AOTD_TEST_PG_DSN=postgresql://postgres:x@localhost:5432/postgres \
        pytest tests/test_store_postgres.py -v

The interface contract (both stores expose the same methods/signatures) is guarded
separately and always-on by tests/test_store_parity.py.
"""
import os
import uuid

import pytest

DSN = os.environ.get("AOTD_TEST_PG_DSN")
if not DSN:
    pytest.skip("set AOTD_TEST_PG_DSN to a throwaway Postgres to run these",
                allow_module_level=True)

psycopg = pytest.importorskip("psycopg")

import store  # noqa: E402

_SCHEMA = """
CREATE TABLE IF NOT EXISTS journal_rows (
    user_id text NOT NULL, kind text NOT NULL, client_id text NOT NULL,
    ciphertext bytea, nonce bytea,
    updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
    PRIMARY KEY (user_id, kind, client_id)
);
CREATE TABLE IF NOT EXISTS user_keys (
    user_id text PRIMARY KEY, key_material jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS access_requests (
    email text PRIMARY KEY, note text, user_agent text,
    status text NOT NULL DEFAULT 'new',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
    id uuid PRIMARY KEY, email text,
    created_at timestamptz, last_sign_in_at timestamptz,
    invited_at timestamptz, confirmed_at timestamptz
);
"""


@pytest.fixture(scope="module", autouse=True)
def _schema():
    with psycopg.connect(DSN, autocommit=True) as conn:
        conn.execute(_SCHEMA)
    yield


@pytest.fixture()
def pg():
    """A PostgresStore plus a unique user_id; the user's data is wiped after."""
    s = store.PostgresStore(DSN)
    uid = str(uuid.uuid4())
    try:
        yield s, uid
    finally:
        s.delete_user(uid)


def _note(cid, ct=b"cipher", nonce=b"nonce", deleted=False):
    return {"kind": "note", "client_id": cid, "ciphertext": ct,
            "nonce": nonce, "deleted": deleted}


def test_upsert_then_get_round_trip(pg):
    s, uid = pg
    assert s.upsert_rows(uid, [_note("c1", ct=b"AAAA", nonce=b"BB")]) == 1
    rows = s.get_rows(uid)
    assert len(rows) == 1
    r = rows[0]
    assert r["kind"] == "note" and r["client_id"] == "c1"
    assert r["ciphertext"] == b"AAAA" and r["nonce"] == b"BB"
    assert r["deleted"] is False


def test_upsert_updates_in_place(pg):
    s, uid = pg
    s.upsert_rows(uid, [_note("c1", ct=b"one")])
    s.upsert_rows(uid, [_note("c1", ct=b"two")])
    rows = s.get_rows(uid)
    assert len(rows) == 1 and rows[0]["ciphertext"] == b"two"


def test_tombstone_via_deleted_flag(pg):
    s, uid = pg
    s.upsert_rows(uid, [_note("c1")])
    s.upsert_rows(uid, [_note("c1", deleted=True)])
    rows = s.get_rows(uid)
    assert len(rows) == 1
    assert rows[0]["deleted"] is True and rows[0]["ciphertext"] == b""


def test_kind_filter_and_since_cursor(pg):
    s, uid = pg
    s.upsert_rows(uid, [_note("c1"),
                        {"kind": "pick", "client_id": "p1",
                         "ciphertext": b"x", "nonce": b"y", "deleted": False}])
    assert {r["kind"] for r in s.get_rows(uid, kind="note")} == {"note"}
    newest = max(r["updated_at"] for r in s.get_rows(uid))
    assert s.get_rows(uid, since=newest) == []  # nothing strictly after the newest


def test_delete_row_is_idempotent(pg):
    s, uid = pg
    s.upsert_rows(uid, [_note("c1")])
    assert s.delete_row(uid, "note", "c1") is True
    assert s.delete_row(uid, "note", "c1") is False  # already tombstoned


def test_keys_round_trip(pg):
    s, uid = pg
    out = s.put_keys(uid, {"wrapped": "abc", "v": 1})
    assert out["key_material"] == {"wrapped": "abc", "v": 1}
    assert s.get_keys(uid)["key_material"] == {"wrapped": "abc", "v": 1}


def test_delete_user_wipes_rows_and_keys(pg):
    s, uid = pg
    s.upsert_rows(uid, [_note("c1")])
    s.put_keys(uid, {"wrapped": "abc"})
    summary = s.delete_user(uid)
    assert summary["rows"] >= 1 and summary["keys"] == 1
    assert s.get_rows(uid) == [] and s.get_keys(uid) is None


def test_access_request_upsert_and_list(pg):
    s, _ = pg
    email = f"{uuid.uuid4().hex}@example.test"
    try:
        s.add_access_request(email, note="hi", user_agent="pytest")
        s.add_access_request(email, note="again")  # collapses to one row
        listed = [r for r in s.list_access_requests() if r["email"] == email]
        assert len(listed) == 1 and listed[0]["note"] == "again"
        assert listed[0]["status"] == "new"
    finally:
        with psycopg.connect(DSN, autocommit=True) as conn:
            conn.execute("DELETE FROM access_requests WHERE email=%s", (email,))


# --- Usage panel: invite → account ------------------------------------------
# Supabase's "Invite user" creates the auth.users row at SEND time, so created_at
# is when we invited someone, not when they joined — which made the old "accounts
# created" chart a record of invite waves. _invite_funnel reads invited_at /
# confirmed_at instead. This is the only place that SQL runs against a real
# Postgres (percentile_cont over an interval, FILTER clauses, EXTRACT(EPOCH ...)),
# so without a DSN it is unproven.

@pytest.fixture()
def invited_users():
    """Seed auth.users with a known invite cohort, and clean it up after."""
    ids = []

    def add(invited_ago, confirmed_ago=None):
        uid = str(uuid.uuid4())
        ids.append(uid)
        with psycopg.connect(DSN, autocommit=True) as conn:
            conn.execute(
                "INSERT INTO auth.users (id, email, created_at, invited_at, confirmed_at) "
                "VALUES (%s, %s, now() - %s::interval, now() - %s::interval, "
                "        CASE WHEN %s IS NULL THEN NULL ELSE now() - %s::interval END)",
                (uid, f"{uid}@example.test", invited_ago, invited_ago,
                 confirmed_ago, confirmed_ago))
        return uid
    try:
        yield add
    finally:
        with psycopg.connect(DSN, autocommit=True) as conn:
            for uid in ids:
                conn.execute("DELETE FROM auth.users WHERE id=%s", (uid,))


def test_invite_funnel_counts_joined_and_never_opened(invited_users):
    invited_users("2 days", "1 day")      # invited, joined a day later
    invited_users("3 days", "3 days")     # invited, joined immediately
    invited_users("10 days", None)        # invited, never opened it
    f = store.PostgresStore(DSN)._invite_funnel(30)
    assert f["available"] is True
    assert f["invited"] >= 3
    assert f["joined"] >= 2
    assert f["never_opened"] >= 1


def test_invite_funnel_flags_a_cold_invite(invited_users):
    """Invited over a week ago and still hasn't opened it — the number worth acting on."""
    invited_users("10 days", None)
    invited_users("1 day", None)          # recent, not yet cold
    f = store.PostgresStore(DSN)._invite_funnel(30)
    assert f["cold"] >= 1
    assert f["cold"] < f["never_opened"] + 1


def test_invite_funnel_accept_latency(invited_users):
    """percentile_cont over an interval is the one bit of SQL here with no fallback."""
    invited_users("5 days", "5 days")     # ~0s to accept
    invited_users("5 days", "4 days")     # ~1 day to accept
    f = store.PostgresStore(DSN)._invite_funnel(30)
    assert f["median_accept_s"] is not None
    assert isinstance(f["median_accept_s"], int)
    assert f["max_accept_s"] >= f["median_accept_s"] >= 0


def test_invite_funnel_survives_a_cohort_nobody_accepted(invited_users):
    """All-NULL latency must yield None, not a crash or a fake zero."""
    with psycopg.connect(DSN, autocommit=True) as conn:
        conn.execute("DELETE FROM auth.users WHERE invited_at IS NOT NULL")
    invited_users("2 days", None)
    f = store.PostgresStore(DSN)._invite_funnel(30)
    assert f["available"] is True
    assert f["joined"] == 0
    assert f["median_accept_s"] is None and f["max_accept_s"] is None


def test_invite_funnel_ignores_uninvited_accounts(invited_users):
    """An operator account made another way must not inflate 'never opened it'."""
    with psycopg.connect(DSN, autocommit=True) as conn:
        conn.execute("DELETE FROM auth.users WHERE invited_at IS NOT NULL")
    uid = str(uuid.uuid4())
    try:
        with psycopg.connect(DSN, autocommit=True) as conn:
            conn.execute(
                "INSERT INTO auth.users (id, email, created_at, invited_at) "
                "VALUES (%s, %s, now(), NULL)", (uid, f"{uid}@example.test"))
        invited_users("1 day", None)
        f = store.PostgresStore(DSN)._invite_funnel(30)
        assert f["invited"] == 1        # the uninvited row is not counted
    finally:
        with psycopg.connect(DSN, autocommit=True) as conn:
            conn.execute("DELETE FROM auth.users WHERE id=%s", (uid,))


def test_account_activity_survives_a_missing_invite_column():
    """The funnel is its OWN statement + guard: an auth schema without invite
    columns must degrade to invites.available=False, never take the panel down."""
    with psycopg.connect(DSN, autocommit=True) as conn:
        conn.execute("ALTER TABLE auth.users DROP COLUMN IF EXISTS invited_at")
    try:
        act = store.PostgresStore(DSN).account_activity()
        assert act["available"] is True            # the panel still works
        assert act["invites"]["available"] is False
        assert act["invites"]["error"]
    finally:
        with psycopg.connect(DSN, autocommit=True) as conn:
            conn.execute("ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS "
                         "invited_at timestamptz")
