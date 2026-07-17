"""
Listening journal + notes — your personal, durable data.

This is deliberately separate from db.py (the read-only album cache) and from
albums.db (which build_db.py deletes and rebuilds on every dump refresh). The
journal lives in its own file, config.JOURNAL_DB_PATH, that nothing else
touches, so a dump rebuild can never wipe your history.

Each row carries a denormalized snapshot of the album (artist / title / date /
Discogs link) so an entry stays meaningful on its own — even if the album cache
is rebuilt, an album row changes, or you read the journal without the big DB at
all. That self-containment is also what would let this be lifted into its own
service or synced later: all journal access goes through this one module.
"""
import json
import re
import sqlite3
import unicodedata
from collections import Counter
from datetime import datetime, timezone

import config
from genres import split_genres as _split_genres

# Bump if the export schema ever changes; import_data() checks it.
# v2 added the `picks` table (duel choices + opt-in reasons).
# v3: note bodies are markdown, and "subjects" emerge from the note text itself
# (the short-lived structured-connections experiment was removed — any
# `connections` field in an older v3 export is simply ignored on import).
# v4 added the `trails` table (T1): a saved wander — a named, ordered map of the
# doors you pulled — kept as a first-class object beside your notes.
# v5 added the `platform_marks` table (F16): your own, manual "found it here /
# not here" tags per album + streaming service. Pure user input, never auto-
# detected. An older app reading a v5 export refuses (newer than it supports);
# this app ignores the field if it's missing from an older export.
# v6 (P3 M2): every row is keyed on a source-agnostic `uid` (notes/listens get
# `uid`, picks get `winner_uid`/`loser_uid`, platform_marks is PK'd `(uid,
# service)`). The numeric Discogs `release_id`/`winner_id`/`loser_id` survive ONLY
# as denormalized provenance (NULL for MB-only albums). A v6 export carries the
# uid fields; importing an older (≤v5) export synthesizes `uid = 'd:'+release_id`
# so legacy data folds onto the same namespace. See the uid scheme in
# tools/build_pool_db.py::uid_of.
# v7 (choices rename): the `picks` table + its `winner_*`/`loser_*` columns are
# renamed to `choices` with `chosen_*`/`not_chosen_*` (and `picked_at` →
# `chosen_at`) — the "duel/winner/loser" framing retired for good. A v7 export
# carries a `choices` array with the new field names; importing a ≤v6 export maps
# the old `picks`/`winner_*`/`loser_*` names onto the new ones.
# v8 (typed note refs): a note's `uid` may now name a non-album entity — an artist
# ('art:<name>'), a credited person ('per:<person_id>'), or a track
# ('trk:<album_uid>#<pos>') — not only an album ('d:'/'m:'). Because those entities
# have no albums.db row to hydrate a snapshot from, such a note carries a `ref`: a
# small JSON snapshot (the entity's name/label + context) so it renders on its own.
# `ref` is NULL for an album or free note (they hydrate from the catalog / carry
# nothing). An older (≤v7) app refuses a v8 export via the version guard rather than
# silently dropping the ref; a v8 app reading a ≤v7 export just sees ref=NULL.
EXPORT_VERSION = 8

# PRAGMA user_version tracks the one-time table-rebuilding migrations so they run
# once, not on every connection. 0 = pre-uid (or never opened); 1 = the uid re-key
# (v6) has run; 2 = the `picks`→`choices` rename has run. Each step is applied in
# order for any DB below the current version.
JOURNAL_SCHEMA_VERSION = 2

SCHEMA = """
CREATE TABLE IF NOT EXISTS listens (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    uid         TEXT,                -- source-agnostic album identity (d:/m:/…)
    release_id  INTEGER,             -- denormalized Discogs provenance (NULL=MB-only)
    artist      TEXT,
    title       TEXT,
    released    TEXT,
    discogs_url TEXT,
    listened_at TEXT NOT NULL        -- ISO timestamp (UTC)
);

CREATE TABLE IF NOT EXISTS notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    uid         TEXT,                -- source-agnostic entity identity (d:/m:/art:/per:/trk:)
    release_id  INTEGER,             -- denormalized Discogs provenance (NULL=MB-only/typed)
    artist      TEXT,
    title       TEXT,
    released    TEXT,
    discogs_url TEXT,
    track       TEXT,                -- optional, free text e.g. "3" or "Track 3"
    timestamp   TEXT,                -- optional, free text e.g. "1:45"
    body        TEXT NOT NULL,
    ref         TEXT,                -- v8: JSON snapshot for a typed (non-album) note; NULL otherwise
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT                 -- soft-delete (D3); NULL = live note
);

-- Choices (G5). Every "Choose" is recorded here so the history is never lost;
-- the *reason* (why it called to you) is opt-in. Like notes, each row carries a
-- denormalized snapshot (incl. genres/year) so the patterns view works without
-- the rebuildable album cache. The chosen/not-chosen record are identified by
-- uid (source-agnostic); chosen_id/not_chosen_id are denormalized Discogs
-- provenance. (Renamed from `picks`/`winner_*`/`loser_*` in v7 — see _migrate.)
CREATE TABLE IF NOT EXISTS choices (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    chosen_uid             TEXT,        -- source-agnostic chosen identity
    chosen_id              INTEGER,     -- denormalized Discogs provenance (NULL=MB-only)
    chosen_artist          TEXT,
    chosen_title           TEXT,
    chosen_released        TEXT,
    chosen_discogs_url     TEXT,
    chosen_genres          TEXT,
    chosen_year            INTEGER,
    not_chosen_uid         TEXT,        -- source-agnostic not-chosen identity
    not_chosen_id          INTEGER,
    not_chosen_artist      TEXT,
    not_chosen_title       TEXT,
    day_context            TEXT,        -- the MM-DD this was for (optional)
    reasons                TEXT,        -- JSON array of reason tags, '[]' if none
    note                   TEXT,        -- optional free-text reason
    chosen_at              TEXT NOT NULL,
    updated_at             TEXT NOT NULL
);

-- Saved Trails (T1): a wander you chose to keep. The third layer of "doors, not
-- corridors" — once a rabbit-hole meant something, name it and it becomes a
-- first-class object beside your notes. `nodes` is the JSON pull-tree of the
-- walk (each step: its parent index, a human label, and the door's nav
-- descriptor), so a trail can be re-opened and re-walked later. Pull-only: a
-- trail is never resurfaced at you; you go to Connections and open it yourself.
CREATE TABLE IF NOT EXISTS trails (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    nodes       TEXT NOT NULL,       -- JSON array of {parent, label, nav}
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

-- Platform availability marks (F16): your own manual note of which streaming
-- services an album is (or isn't) on. Every Listen link is a blind *search*, so
-- you only learn a record isn't on a service by clicking through; this lets you
-- record what you found so it's there next time. Strictly user-entered — no
-- auto-detection, no platform APIs (that would make it a recommendation engine,
-- which the vision rules out). One row per (album, service); a denormalized
-- artist/title keeps it meaningful after a catalog rebuild.
CREATE TABLE IF NOT EXISTS platform_marks (
    uid         TEXT NOT NULL,       -- source-agnostic album identity (d:/m:/…)
    service     TEXT NOT NULL,       -- bandcamp/youtube/apple/spotify/qobuz
    state       TEXT NOT NULL,       -- 'here' or 'not_here'
    release_id  INTEGER,             -- denormalized Discogs provenance (NULL=MB-only)
    artist      TEXT,
    title       TEXT,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (uid, service)
);
"""

# Indexes are kept SEPARATE from the table DDL and created only AFTER _migrate
# runs, because the uid indexes reference columns that don't exist yet on a
# pre-v6 table (the migration adds them). _conn() applies these last, so they're
# created once every table is guaranteed to be the v6 shape. All idempotent.
INDEXES = """
CREATE INDEX IF NOT EXISTS idx_listens_release   ON listens (release_id);
CREATE INDEX IF NOT EXISTS idx_listens_time      ON listens (listened_at);
CREATE INDEX IF NOT EXISTS idx_listens_uid       ON listens (uid);
CREATE INDEX IF NOT EXISTS idx_notes_release     ON notes (release_id);
CREATE INDEX IF NOT EXISTS idx_notes_time        ON notes (created_at);
CREATE INDEX IF NOT EXISTS idx_notes_uid         ON notes (uid);
CREATE INDEX IF NOT EXISTS idx_choices_time      ON choices (chosen_at);
CREATE INDEX IF NOT EXISTS idx_choices_chosen    ON choices (chosen_id);
CREATE INDEX IF NOT EXISTS idx_choices_chosen_uid ON choices (chosen_uid);
CREATE INDEX IF NOT EXISTS idx_trails_time       ON trails (created_at);
"""

# The streaming services a mark can be made against, mirroring the Listen door.
MARK_SERVICES = {"bandcamp", "youtube", "apple", "spotify", "qobuz"}
MARK_STATES = {"here", "not_here"}


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --- safe dynamic UPDATE ... SET building (S7) ------------------------------
# update_note()/update_choice() build the SET clause by joining "col=?" fragments
# (values stay parameterized). Those fragments are code-built, never user text —
# but "build SQL by string-join" is exactly the pattern that quietly rots into an
# injection the day someone interpolates a value. So we assert, before the SQL
# touches the database, that every fragment is a bare `column=?` drawn from a
# fixed allow-list of that table's columns. A stray fragment raises rather than
# executing. Defense-in-depth: it changes nothing today, it fails loudly if a
# future edit gets careless.
_NOTE_SET_COLS = frozenset(
    {"body", "track", "timestamp", "updated_at", "deleted_at"})
_CHOICE_SET_COLS = frozenset({
    "chosen_uid", "chosen_id", "chosen_artist", "chosen_title",
    "chosen_released", "chosen_discogs_url", "chosen_genres", "chosen_year",
    "not_chosen_uid", "not_chosen_id", "not_chosen_artist", "not_chosen_title",
    "reasons", "note", "updated_at",
})


def _set_clause(sets, allowed):
    """Validate then join code-built ``col=?`` SET fragments. Raises ValueError
    if any fragment isn't a bare assignment to an allow-listed column."""
    for frag in sets:
        col, _, rest = frag.partition("=")
        if rest != "?" or col not in allowed:
            raise ValueError(f"unsafe SET fragment: {frag!r}")
    return ", ".join(sets)


def _conn():
    config.JOURNAL_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(config.JOURNAL_DB_PATH, timeout=30)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA busy_timeout=30000")
    c.executescript(SCHEMA)        # idempotent; CREATE TABLE IF NOT EXISTS only
    _migrate(c)                    # rebuild pre-v6 tables to the uid-keyed shape
    c.executescript(INDEXES)       # indexes last: every table is now the v6 shape
    return c


def _migrate(c):
    """Lightweight in-place migrations for journals created by older versions.
    CREATE TABLE IF NOT EXISTS won't add a new column to an existing table, so
    we add any missing ones here. Cheap and idempotent."""
    cols = {r[1] for r in c.execute("PRAGMA table_info(notes)")}
    if "deleted_at" not in cols:   # D3 soft-delete (pre-versioning)
        c.execute("ALTER TABLE notes ADD COLUMN deleted_at TEXT")
        c.commit()
    # Staged, table-rebuilding migrations, each gated on user_version so it runs
    # exactly once, in order, for any DB below the current version. A fresh DB
    # already has the current shape (SCHEMA above), so each step no-ops and we
    # just stamp the version.
    #   v1: (P3 M2) re-key everything on a source-agnostic uid (_migrate_uid).
    #   v2: rename the `picks` table + winner_*/loser_* columns to
    #       `choices`/chosen_*/not_chosen_* (_rename_picks_to_choices).
    uv = c.execute("PRAGMA user_version").fetchone()[0]
    if uv < JOURNAL_SCHEMA_VERSION:
        if uv < 1:
            _migrate_uid(c)               # produces the v6 `picks`/winner shape
        if uv < 2:
            _rename_picks_to_choices(c)   # `picks` (v6 shape) -> `choices`
        c.execute(f"PRAGMA user_version = {JOURNAL_SCHEMA_VERSION}")
        c.commit()
    # v8 notes.ref (typed-entity snapshot) — a plain nullable column-add, like
    # deleted_at above, so it isn't gated on user_version. Runs AFTER the staged
    # table rebuilds so it lands on the final notes shape (a pre-v6 rebuild recreates
    # notes without ref). Idempotent.
    cols = {r[1] for r in c.execute("PRAGMA table_info(notes)")}
    if "ref" not in cols:
        c.execute("ALTER TABLE notes ADD COLUMN ref TEXT")
        c.commit()


def _rename_picks_to_choices(c):
    """v7: rename the legacy `picks` table and its winner_*/loser_* columns to
    `choices` / chosen_* / not_chosen_* (and picked_at -> chosen_at), retiring the
    "duel/winner/loser" framing. Runs once, after the uid re-key, so `picks` (if
    present) always has the full v6 column set here.

    SCHEMA (run just before this on every connection) has already created an empty
    `choices` table; on a legacy DB the real data is still in `picks`, so we drop
    that empty shell (asserting it's empty first — it can only have been created
    this connection) and rename `picks` onto it via ALTER RENAME (SQLite ≥3.25,
    metadata-only — no data copy, so nothing to corrupt). A fresh DB has no
    `picks` and this no-ops."""
    tables = {r[0] for r in c.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    if "picks" not in tables:
        return                              # fresh DB: `choices` already correct
    if "choices" in tables:
        n = c.execute("SELECT COUNT(*) FROM choices").fetchone()[0]
        if n:                               # never true (SCHEMA just made it), but
            raise RuntimeError(             # refuse to clobber real rows if it is
                "cannot rename picks->choices: a non-empty choices table exists")
        c.execute("DROP TABLE choices")
    c.execute("ALTER TABLE picks RENAME TO choices")
    renames = {
        "winner_uid": "chosen_uid", "winner_id": "chosen_id",
        "winner_artist": "chosen_artist", "winner_title": "chosen_title",
        "winner_released": "chosen_released",
        "winner_discogs_url": "chosen_discogs_url",
        "winner_genres": "chosen_genres", "winner_year": "chosen_year",
        "loser_uid": "not_chosen_uid", "loser_id": "not_chosen_id",
        "loser_artist": "not_chosen_artist", "loser_title": "not_chosen_title",
        "picked_at": "chosen_at",
    }
    have = {r[1] for r in c.execute("PRAGMA table_info(choices)")}
    for old, new in renames.items():
        if old in have and new not in have:
            c.execute(f"ALTER TABLE choices RENAME COLUMN {old} TO {new}")
    # The old idx_picks_* indexes moved with the table (still valid, wrong names);
    # drop them so INDEXES can (re)create the idx_choices_* set cleanly.
    for idx in ("idx_picks_time", "idx_picks_winner", "idx_picks_winner_uid"):
        c.execute(f"DROP INDEX IF EXISTS {idx}")


def _uid_of(release_id):
    """The synthetic Discogs uid for a numeric release_id, or None. The same
    'd:'+id scheme as the pool (tools/build_pool_db.py::uid_of) so a legacy row
    folds onto the pool namespace. The *representative* member of a folded album
    maps cleanly; a non-representative member is remapped via _pool_uid_map."""
    return None if release_id is None else f"d:{release_id}"


# The uid-prefix → entity-kind map (v8). A note/mark uid names an album by default
# ('d:' Discogs, 'm:' MB), but a note may now tie to a non-album entity: an artist,
# a credited person, or a track. Kind is a pure function of the prefix — nothing is
# stored redundantly — and drives whether a snapshot is hydrated from the catalog
# (album) or carried on the note as a `ref` (typed). Mirrored in app.js /
# journal-store.js / store-bridge.js (kindFromUid).
def kind_from_uid(uid):
    """Classify a note/mark uid by its prefix: 'free' (no uid), 'album' (d:/m:),
    'artist' (art:), 'person' (per:), 'track' (trk:), else 'other'."""
    if uid is None or uid == "":
        return "free"
    s = str(uid)
    if s.startswith(("d:", "m:")):
        return "album"
    if s.startswith("art:"):
        return "artist"
    if s.startswith("per:"):
        return "person"
    if s.startswith("trk:"):
        return "track"
    return "other"


def _encode_ref(ref):
    """Serialize a typed note's `ref` snapshot for storage: a dict → compact JSON
    string, an already-encoded string → itself, anything falsy → None. Never
    raises on a non-serializable value — a bad ref stores as NULL rather than
    failing the write (the note's body is what matters)."""
    if not ref:
        return None
    if isinstance(ref, str):
        return ref
    try:
        return json.dumps(ref, separators=(",", ":"))
    except (TypeError, ValueError):
        return None


def _decode_ref(val):
    """Parse a stored `ref` JSON string back to an object for the client, or None.
    A malformed/blank value decodes to None (degrade to identity-only, never
    raise)."""
    if not val:
        return None
    if isinstance(val, (dict, list)):
        return val
    try:
        return json.loads(val)
    except (TypeError, ValueError):
        return None


def _note_out(row):
    """A note row as a plain dict with its `ref` decoded from JSON to an object.
    Used by the reads that hand notes to the client (feed / for_album / export)."""
    d = dict(row)
    if "ref" in d:
        d["ref"] = _decode_ref(d.get("ref"))
    return d


# Notebook search over a typed note (v8): an album/free note is found by its
# artist/title/body, but a typed note (artist/person/track) has NULL artist/title,
# so its entity label lives only in `ref`. _ref_search_text pulls the human label
# out of a ref so the search box can find it. Mirrored EXACTLY in
# journal-store.js refSearchText — same fields, order, join, lowercasing — so the
# local and hosted feeds match (the analytics parity check covers this).
def _ref_search_text(ref):
    """The searchable label text of a typed note's ref: the entity name
    (artist/person) or the track title + its album context, space-joined and
    lowercased. '' for an album/free note (ref None) or a malformed ref."""
    if not isinstance(ref, dict):
        return ""
    return " ".join(
        str(ref[k]) for k in ("name", "title", "album_artist", "album_title")
        if ref.get(k)).lower()


def _note_matches(note, q):
    """True when the (lowercased) query is a substring of a note's artist, title,
    body, or — for a typed note — its ref label. `note` is a decoded note dict."""
    return (q in str(note.get("artist") or "").lower()
            or q in str(note.get("title") or "").lower()
            or q in str(note.get("body") or "").lower()
            or q in _ref_search_text(note.get("ref")))


def _pool_uid_map(rids):
    """Best-effort {release_id -> pool uid} for the given release_ids, used during
    the v6 backfill so a legacy note/mark keyed on a NON-representative member of a
    folded pool album re-keys onto the SAME uid as the pool (not a synthetic
    'd:<that_member>' that nothing else shares).

    Reads config.POOL_DB_PATH if it exists (it won't locally / in tests, and that
    is fine — the synthetic 'd:'+id is then used and still resolves via the
    albums.db join-back). One scan of the pool, once, at migration time; only ids
    in `rids` are mapped. Returns {} when the pool is absent or unreadable."""
    want = {int(r) for r in rids if r is not None}
    if not want:
        return {}
    try:
        if not config.POOL_DB_PATH.exists():
            return {}
    except (OSError, TypeError):
        return {}
    out = {}
    try:
        pc = sqlite3.connect(config.POOL_DB_PATH, timeout=30)
        pc.row_factory = sqlite3.Row
        try:
            rows = pc.execute(
                "SELECT uid, release_ids FROM pool WHERE source='discogs'")
            for row in rows:
                try:
                    members = json.loads(row["release_ids"] or "[]")
                except (ValueError, TypeError):
                    continue
                for m in members:
                    try:
                        m = int(m)
                    except (ValueError, TypeError):
                        continue
                    if m in want:
                        out[m] = row["uid"]
        finally:
            pc.close()
    except sqlite3.Error:
        return out
    return out


def _migrate_uid(c):
    """The one-time v6 re-key: rebuild notes/listens/picks/platform_marks with a
    source-agnostic uid, backfilling `uid = 'd:'+release_id` (remapped through the
    pool's folded-album membership where available), relaxing the old NOT NULL on
    release_id/winner_id, and moving platform_marks' PK to (uid, service).

    SQLite can't ALTER a column's NOT NULL or a table's PRIMARY KEY in place, so
    each table is rebuilt (create-new / copy / drop / rename) inside the caller's
    transaction. Idempotent: if the notes table already has a `uid` column (a
    fresh DB built from SCHEMA, or an already-migrated one) this is a no-op."""
    cols = {r[1] for r in c.execute("PRAGMA table_info(notes)")}
    if "uid" in cols:
        return  # already the v6 shape — nothing to rebuild

    # Gather every release_id referenced anywhere, so the pool remap is one scan
    # over a small set (a single user's noted/picked/marked albums).
    rids = set()
    for tbl, col in (("notes", "release_id"), ("listens", "release_id"),
                     ("picks", "winner_id"), ("picks", "loser_id"),
                     ("platform_marks", "release_id")):
        try:
            for (rid,) in c.execute(
                    f"SELECT DISTINCT {col} FROM {tbl} WHERE {col} IS NOT NULL"):
                rids.add(rid)
        except sqlite3.OperationalError:
            pass  # an older journal may predate a table; skip it
    fold = _pool_uid_map(rids)

    # notes ------------------------------------------------------------------
    c.execute("""
        CREATE TABLE notes_v6 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            uid TEXT, release_id INTEGER,
            artist TEXT, title TEXT, released TEXT, discogs_url TEXT,
            track TEXT, timestamp TEXT, body TEXT NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)""")
    c.execute("""
        INSERT INTO notes_v6 (id, uid, release_id, artist, title, released,
            discogs_url, track, timestamp, body, created_at, updated_at, deleted_at)
        SELECT id,
            CASE WHEN release_id IS NULL THEN NULL ELSE 'd:'||release_id END,
            release_id, artist, title, released, discogs_url, track, timestamp,
            body, created_at, updated_at, deleted_at
        FROM notes""")
    c.execute("DROP TABLE notes")
    c.execute("ALTER TABLE notes_v6 RENAME TO notes")

    # listens ----------------------------------------------------------------
    c.execute("""
        CREATE TABLE listens_v6 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            uid TEXT, release_id INTEGER,
            artist TEXT, title TEXT, released TEXT, discogs_url TEXT,
            listened_at TEXT NOT NULL)""")
    c.execute("""
        INSERT INTO listens_v6 (id, uid, release_id, artist, title, released,
            discogs_url, listened_at)
        SELECT id,
            CASE WHEN release_id IS NULL THEN NULL ELSE 'd:'||release_id END,
            release_id, artist, title, released, discogs_url, listened_at
        FROM listens""")
    c.execute("DROP TABLE listens")
    c.execute("ALTER TABLE listens_v6 RENAME TO listens")

    # picks ------------------------------------------------------------------
    c.execute("""
        CREATE TABLE picks_v6 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            winner_uid TEXT, winner_id INTEGER,
            winner_artist TEXT, winner_title TEXT, winner_released TEXT,
            winner_discogs_url TEXT, winner_genres TEXT, winner_year INTEGER,
            loser_uid TEXT, loser_id INTEGER, loser_artist TEXT, loser_title TEXT,
            day_context TEXT, reasons TEXT, note TEXT,
            picked_at TEXT NOT NULL, updated_at TEXT NOT NULL)""")
    c.execute("""
        INSERT INTO picks_v6 (id, winner_uid, winner_id, winner_artist,
            winner_title, winner_released, winner_discogs_url, winner_genres,
            winner_year, loser_uid, loser_id, loser_artist, loser_title,
            day_context, reasons, note, picked_at, updated_at)
        SELECT id,
            CASE WHEN winner_id IS NULL THEN NULL ELSE 'd:'||winner_id END,
            winner_id, winner_artist, winner_title, winner_released,
            winner_discogs_url, winner_genres, winner_year,
            CASE WHEN loser_id IS NULL THEN NULL ELSE 'd:'||loser_id END,
            loser_id, loser_artist, loser_title,
            day_context, reasons, note, picked_at, updated_at
        FROM picks""")
    c.execute("DROP TABLE picks")
    c.execute("ALTER TABLE picks_v6 RENAME TO picks")

    # platform_marks (PK moves to (uid, service)) ----------------------------
    c.execute("""
        CREATE TABLE platform_marks_v6 (
            uid TEXT NOT NULL, service TEXT NOT NULL, state TEXT NOT NULL,
            release_id INTEGER, artist TEXT, title TEXT, updated_at TEXT NOT NULL,
            PRIMARY KEY (uid, service))""")
    c.execute("""
        INSERT INTO platform_marks_v6 (uid, release_id, service, state, artist,
            title, updated_at)
        SELECT 'd:'||release_id, release_id, service, state, artist, title,
            updated_at
        FROM platform_marks""")
    c.execute("DROP TABLE platform_marks")
    c.execute("ALTER TABLE platform_marks_v6 RENAME TO platform_marks")

    # Remap the folded-album members onto their pool uid. The representative
    # member already got the right synthetic uid above; only non-representatives
    # need fixing. For marks the (uid, service) PK can collide if two members of
    # the same folded album were marked on the same service, so use the conflict-
    # replacing form there (keep the row being remapped).
    for rid, uid in fold.items():
        c.execute("UPDATE notes   SET uid=? WHERE release_id=?", (uid, rid))
        c.execute("UPDATE listens SET uid=? WHERE release_id=?", (uid, rid))
        c.execute("UPDATE picks SET winner_uid=? WHERE winner_id=?", (uid, rid))
        c.execute("UPDATE picks SET loser_uid=?  WHERE loser_id=?",  (uid, rid))
        c.execute("UPDATE OR REPLACE platform_marks SET uid=? WHERE release_id=?",
                  (uid, rid))
    # Indexes are (re)created by _conn() via INDEXES, after this returns.


def _snapshot(album):
    """Pull the durable album fields out of a resolved album dict. N3b: a free
    note (record-optional) passes no album — every field comes back None."""
    album = album or {}
    return (
        album.get("artist"), album.get("title"),
        album.get("released"), album.get("discogs_url"),
    )


def _album_uid(album):
    """The uid for a resolved album dict: its own `uid` (pool/door-sourced) if it
    has one, else the synthetic Discogs uid from its release_id, else None. Lets a
    caller pass either a pool album (carries uid) or a legacy albums.db album
    (release_id only) and get the right source-agnostic key."""
    a = album or {}
    return a.get("uid") or _uid_of(a.get("release_id"))


# --- writes -----------------------------------------------------------------
# NOTE: the listens table is retained (so any history from older versions is
# never destroyed), but the app no longer logs or surfaces listens — the
# journal is notes-only. Nothing writes to `listens` anymore.

def add_note(uid, album, body, track=None, timestamp=None, ref=None):
    """Record a note. The body is free-form markdown and is the only requirement.
    N3b: a note is **record-optional** — pass `uid=None, album=None` for a free
    noticing (identity columns stay NULL, which the schema already allows). When an
    album is attached, `album` is the resolved dict whose snapshot + release_id
    provenance are denormalized onto the row.

    v8: `uid` may instead name a typed entity (an artist 'art:', a person 'per:', a
    track 'trk:') that has no albums.db row. For those, pass `ref` — a small dict
    snapshot (the entity's name/label + context) — which is stored as JSON so the
    note renders on its own. `album`/`ref` are independent: an album note has an
    album snapshot and no ref; a typed note has a ref and (usually) no album.
    Returns the new note id."""
    artist, title, released, url = _snapshot(album)
    release_id = (album or {}).get("release_id")
    now = _now()
    with _conn() as c:
        cur = c.execute(
            """INSERT INTO notes
               (uid, release_id, artist, title, released, discogs_url,
                track, timestamp, body, ref, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (uid, release_id, artist, title, released, url,
             track or None, timestamp or None, body, _encode_ref(ref), now, now))
        c.commit()
        return cur.lastrowid


def update_note(note_id, body=None, track=None, timestamp=None):
    """Edit an existing note in place (D4). Only the provided fields change;
    pass an empty string to clear an optional field (track/timestamp). Returns
    True if a row was updated. Refuses to blank out the body (it's required)."""
    sets, params = [], []
    if body is not None:
        body = body.strip()
        if not body:
            raise ValueError("note body cannot be empty")
        sets.append("body=?")
        params.append(body)
    if track is not None:
        sets.append("track=?")
        params.append(track.strip() or None)
    if timestamp is not None:
        sets.append("timestamp=?")
        params.append(timestamp.strip() or None)
    if not sets:
        return False
    sets.append("updated_at=?")
    params += [_now(), note_id]
    with _conn() as c:
        cur = c.execute(
            f"UPDATE notes SET {_set_clause(sets, _NOTE_SET_COLS)} WHERE id=?",
            params)
        c.commit()
        return cur.rowcount > 0


def delete_note(note_id):
    """Soft-delete a note (D3): stamp deleted_at instead of removing the row, so
    an accidental delete can be undone. Reads all filter on deleted_at IS NULL,
    so a soft-deleted note disappears everywhere immediately. Returns True if a
    live note was deleted."""
    with _conn() as c:
        cur = c.execute(
            "UPDATE notes SET deleted_at=? WHERE id=? AND deleted_at IS NULL",
            (_now(), note_id))
        c.commit()
        return cur.rowcount > 0


def restore_note(note_id):
    """Undo a soft-delete (D3): clear deleted_at so the note reappears. Returns
    True if a deleted note was restored."""
    with _conn() as c:
        cur = c.execute(
            "UPDATE notes SET deleted_at=NULL WHERE id=? AND deleted_at IS NOT NULL",
            (note_id,))
        c.commit()
        return cur.rowcount > 0


# --- platform marks (F16) ---------------------------------------------------

def get_marks(uid):
    """Your manual availability marks for one album (by uid): {service: state}.
    Empty if you've marked nothing."""
    with _conn() as c:
        return {r["service"]: r["state"] for r in c.execute(
            "SELECT service, state FROM platform_marks WHERE uid=?",
            (uid,))}


def set_mark(uid, album, service, state):
    """Set (or clear) one album+service mark, the album identified by `uid`.
    `state` of 'here'/'not_here' upserts the mark; anything else (None/''/'unknown')
    clears it. `album` is the resolved album dict whose artist/title + release_id
    provenance are denormalized onto the row. Raises ValueError on an unknown
    service or invalid state. Returns the album's full marks afterward."""
    service = (service or "").strip().lower()
    if service not in MARK_SERVICES:
        raise ValueError(f"unknown service: {service!r}")
    clearing = state in (None, "", "unknown")
    if not clearing and state not in MARK_STATES:
        raise ValueError(f"invalid state: {state!r}")
    with _conn() as c:
        if clearing:
            c.execute("DELETE FROM platform_marks WHERE uid=? AND service=?",
                      (uid, service))
        else:
            artist = (album or {}).get("artist")
            title = (album or {}).get("title")
            release_id = (album or {}).get("release_id")
            c.execute(
                """INSERT INTO platform_marks
                   (uid, release_id, service, state, artist, title, updated_at)
                   VALUES (?,?,?,?,?,?,?)
                   ON CONFLICT(uid, service) DO UPDATE SET
                     state=excluded.state, release_id=excluded.release_id,
                     artist=excluded.artist, title=excluded.title,
                     updated_at=excluded.updated_at""",
                (uid, release_id, service, state, artist, title, _now()))
        c.commit()
        return {r["service"]: r["state"] for r in c.execute(
            "SELECT service, state FROM platform_marks WHERE uid=?",
            (uid,))}


# --- reads ------------------------------------------------------------------

def for_album(uid):
    """All notes for one album (by uid), newest first, plus any choice-reasons for
    it (N1 §4.1: your notes and the reasons you gave when you chose this record are
    one body of writing per album, assembled at read time). `release_id` is echoed
    back only as provenance for older callers — uid is the identity."""
    with _conn() as c:
        notes = [_note_out(r) for r in c.execute(
            "SELECT * FROM notes WHERE uid=? AND deleted_at IS NULL "
            "ORDER BY created_at DESC", (uid,))]
        # Only choices where this record was chosen AND carried a reason (a note or
        # reason tags) — bare history isn't "your words".
        crows = [_choice_row(r) for r in c.execute(
            "SELECT * FROM choices WHERE chosen_uid=? "
            "AND (note IS NOT NULL OR (reasons IS NOT NULL AND reasons != '[]')) "
            "ORDER BY chosen_at DESC", (uid,))]
    choices = [{
        "id": r["id"], "note": r.get("note"), "reasons": r.get("reasons"),
        "not_chosen_artist": r.get("not_chosen_artist"),
        "not_chosen_title": r.get("not_chosen_title"),
        "chosen_at": r.get("chosen_at"),
    } for r in crows]
    rid = None
    if isinstance(uid, str) and uid.startswith("d:") and uid[2:].lstrip("-").isdigit():
        rid = int(uid[2:])
    return {"uid": uid, "release_id": rid, "notes": notes, "choices": choices}


def feed(query=None, limit=2000):
    """All notes for the Journal view, newest first, optionally text-filtered by
    artist / title / note body — and, for a typed note (artist/person/track), by
    its `ref` label (v8), so searching the entity's name finds the note you tied to
    it. Searching a recurring subject is still just a body match — the subject came
    out of the note text in the first place.

    The query case fetches all live notes and filters in Python (a personal journal
    is small, and the ref label lives in JSON, not a column), matching
    journal-store.js's in-memory feed exactly."""
    q = query.lower() if query else ""     # mirror journal-store.js: no strip/trim
    with _conn() as c:
        if q:
            rows = c.execute(
                "SELECT * FROM notes WHERE deleted_at IS NULL "
                "ORDER BY created_at DESC").fetchall()
            notes = [n for n in (_note_out(r) for r in rows)
                     if _note_matches(n, q)][:limit]
        else:
            rows = c.execute(
                "SELECT * FROM notes WHERE deleted_at IS NULL "
                "ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
            notes = [_note_out(r) for r in rows]
    return {"notes": notes}


def notes_for_artist(artist):
    """Your notes on records by one artist, newest first — the retrieval echo
    behind the artist door (N1 §4.4). EXACT (case-insensitive) artist match only:
    the honesty rule turned on your own words — a fuzzy/partial match is never
    surfaced as a connection. Pure lookup; nothing is aggregated or interpreted."""
    a = (artist or "").strip()
    if not a:
        return {"artist": artist, "notes": []}
    with _conn() as c:
        rows = [dict(r) for r in c.execute(
            "SELECT * FROM notes WHERE lower(artist)=lower(?) AND deleted_at IS NULL "
            "ORDER BY created_at DESC", (a,))]
    return {"artist": a, "notes": rows}


# 3a person echo (N1 §4.4). The person-door retrieval echo — catalog-anchored fuzzy.
# We only ever run this FROM a credited person's door, so a private name in your
# life is never a starting point; and the match is case/punctuation/accent-
# insensitive (a typed name shouldn't have to be byte-exact) but never semantic.
def _person_norm(s):
    """Fold a name or note body to a comparable form: drop a trailing Discogs '(2)'
    disambiguator, strip accents, lowercase, collapse every non-alphanumeric run to
    one space. So 'Beyoncé (2)' and 'beyonce' compare equal — the honest forgiveness
    a typed name needs, nothing semantic."""
    s = re.sub(r"\s*\(\d+\)\s*$", "", s or "")
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def notes_for_person(name):
    """Your notes that mention a credited person, for the person door (3a). Each hit
    is tagged ``match_kind``: 'full' (the whole name appears) or 'partial' (only a
    single distinctive name token does). The CLIENT shows every 'full' hit but keeps
    a 'partial' only when the note's album actually credits this person — so 'rick'
    surfaces for Rick Rubin on a record he's on, never elsewhere, and a friend named
    in a note about an unrelated album is never surfaced (the catalog is the anchor,
    not your private life). Pull-only, verbatim; empty (silent) when nothing matches."""
    norm = _person_norm(name)
    tokens = [t for t in norm.split() if len(t) >= 2]
    if not tokens:
        return {"person": name, "notes": []}
    full_re = re.compile(r"\b" + r"\s+".join(re.escape(t) for t in tokens) + r"\b")
    # A 'partial' may only be anchored by a DISTINCTIVE token — never a common word
    # that happens to be a name ("Will", "May", "June") — so reuse the note stopword
    # set to drop those. (A one-token name like "Madonna" always hits 'full' first.)
    part_res = [re.compile(r"\b" + re.escape(t) + r"\b")
                for t in tokens if len(t) >= 3 and t not in _STOPWORDS]
    with _conn() as c:
        rows = [dict(r) for r in c.execute(
            "SELECT * FROM notes WHERE deleted_at IS NULL ORDER BY created_at DESC")]
    out = []
    for r in rows:
        body = _person_norm(r.get("body") or "")
        if full_re.search(body):
            r["match_kind"] = "full"
            out.append(r)
        elif any(rx.search(body) for rx in part_res):
            r["match_kind"] = "partial"
            out.append(r)
    return {"person": name, "notes": out}


# 3b the in-note word pull (N1 §4.4, owner 2026-07-07: recurring-only, on-demand).
# The T3 subject machinery repurposed the only way VISION allows: never a standing
# map, never marked until you ask — a lookup you trigger from inside one note. Both
# functions reuse _note_terms (the same tokeniser as `subjects`).
def note_threads(note_id, min_notes=2):
    """The pull-threads for ONE note (3b): the terms in it that ALSO recur across at
    least ``min_notes`` of your live notes, busiest first — [{term, count}]. A term is
    dropped if a longer term in the same note contains it and recurs at least as often
    (so 'wall of sound' hides 'wall'/'sound'). Empty when nothing here recurs; computed
    only on this pull, never a standing map."""
    with _conn() as c:
        row = c.execute("SELECT body FROM notes WHERE id=? AND deleted_at IS NULL",
                        (note_id,)).fetchone()
        if not row:
            return {"threads": []}
        bodies = [r[0] for r in c.execute(
            "SELECT body FROM notes WHERE deleted_at IS NULL")]
    df = Counter()
    for b in bodies:
        for lw in _note_terms(b):
            df[lw] += 1
    kept = [(lw, surf) for lw, surf in _note_terms(row["body"]).items()
            if df[lw] >= min_notes]
    words = {lw: lw.split() for lw, _ in kept}

    def contained(small, big):
        n = len(small)
        return any(big[i:i + n] == small for i in range(len(big) - n + 1))

    out = []
    for lw, surf in kept:
        if any(o != lw and len(words[o]) > len(words[lw]) and df[o] >= df[lw]
               and contained(words[lw], words[o]) for o, _ in kept):
            continue
        out.append({"term": surf, "count": df[lw]})
    out.sort(key=lambda x: (-x["count"], x["term"].lower()))
    return {"threads": out}


def notes_with_term(term):
    """Your live notes whose text contains ``term`` (matched through _note_terms — the
    same tokeniser, so it's an exact term/phrase hit, never a loose substring),
    verbatim, newest first. The pull result behind one 3b thread."""
    key = (term or "").strip().lower()
    if not key:
        return {"term": term, "notes": []}
    with _conn() as c:
        rows = [dict(r) for r in c.execute(
            "SELECT * FROM notes WHERE deleted_at IS NULL ORDER BY created_at DESC")]
    return {"term": term, "notes": [r for r in rows if key in _note_terms(r["body"])]}


def counts():
    """Headline numbers for the journal summary. Distinct entities are counted by
    the source-agnostic uid (falling back to 'd:'+release_id), matching
    journal-store.js counts()/albumKeyOf — so an MB-only or typed note is counted
    the same in local and hosted mode (a bare COUNT(DISTINCT release_id) missed
    every uid-only row)."""
    with _conn() as c:
        nn = c.execute(
            "SELECT COUNT(*) FROM notes WHERE deleted_at IS NULL").fetchone()[0]
        na = c.execute(
            "SELECT COUNT(DISTINCT COALESCE(uid, 'd:' || release_id)) FROM notes "
            "WHERE deleted_at IS NULL").fetchone()[0]
        nar = c.execute(
            "SELECT COUNT(DISTINCT artist) FROM notes "
            "WHERE deleted_at IS NULL").fetchone()[0]
    return {"notes": nn, "albums": na, "artists": nar}


# --- emergent subjects ------------------------------------------------------
# Instead of asking you to file each note under our categories, we let structure
# emerge from your own words: the terms and phrases that recur ACROSS your notes.
# This is deliberately simple and transparent — it's word counting over your own
# text, nothing more. No model, no network, no interpretation: we surface what
# recurs and never say what it "means" (that's yours). Computed only when you
# open the view; never pushed (VISION.md).

# Common words to ignore, plus a few that are ubiquitous in a music journal and
# so carry little signal here. Tunable against real notes.
_STOPWORDS = frozenset("""
a an the and or but if then else so because as of to in on at for with from by
about into over under again further this that these those here there
i me my we our us you your he him his she her it its they them their
is am are was were be been being do does did doing have has had having
not no nor only own same too very can will just don dont didnt cant
what which who whom when where why how all any both each few more most other
some such than that up out off down then once
song songs album albums track tracks record records note notes listen listened
listening really got get like one two
""".split())

_WORD_RE = re.compile(r"[A-Za-z][A-Za-z'’]+")


def _note_terms(body):
    """The distinct unigram/bigram/trigram terms in one note's text.

    Returns a dict ``lower_term -> a surface form`` (so we can show the term the
    way it was written). Markdown link targets and bare URLs are stripped so we
    index what you *wrote*, not URLs. Phrases whose first/last word is a stopword
    are dropped, which kills most filler ("in the morning") while keeping real
    ones ("irish cancer society")."""
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r" \1 ", body or "")  # [label](url)->label
    text = re.sub(r"https?://\S+", " ", text)                     # bare URLs out
    words = _WORD_RE.findall(text)
    lowers = [w.lower() for w in words]
    terms = {}
    for w, lw in zip(words, lowers):
        if len(lw) >= 3 and lw not in _STOPWORDS:
            terms.setdefault(lw, w)
    for size in (2, 3):
        for i in range(len(words) - size + 1):
            gram = lowers[i:i + size]
            if gram[0] in _STOPWORDS or gram[-1] in _STOPWORDS:
                continue
            terms.setdefault(" ".join(gram), " ".join(words[i:i + size]))
    return terms


def subjects(min_notes=2, limit=40):
    """The subjects emerging from your notes: terms/phrases that recur across at
    least ``min_notes`` distinct (live) notes, busiest first.

    Ranking is by how many notes a term appears in (document frequency, so one
    chatty note can't manufacture a subject), with a gentle nudge for multi-word
    and capitalized terms (a capitalized phrase is probably "a thing worth
    noticing" — though we never say *what kind* of thing). A unigram that only
    ever appears inside a higher-or-equal phrase is dropped as redundant."""
    with _conn() as c:
        bodies = [r[0] for r in c.execute(
            "SELECT body FROM notes WHERE deleted_at IS NULL")]
    doc_count = Counter()
    surface_votes = {}
    for body in bodies:
        for lw, surf in _note_terms(body).items():
            doc_count[lw] += 1
            surface_votes.setdefault(lw, Counter())[surf] += 1

    items = []
    for lw, cnt in doc_count.items():
        if cnt < min_notes:
            continue
        disp = surface_votes[lw].most_common(1)[0][0]
        words = lw.split()
        multiword = len(words) > 1
        capitalized = disp[:1].isupper()
        score = cnt + (0.3 if multiword else 0) + (0.2 if capitalized else 0)
        items.append({"term": disp, "words": words, "count": cnt,
                      "score": score})

    # Drop a term if a longer term that contains it (contiguously) recurs at
    # least as often — so "Irish Cancer Society" hides the redundant "Irish
    # Cancer" / "Cancer Society" / "cancer", but a word that *also* shows up on
    # its own elsewhere (higher count) still stands.
    def contained(small, big):
        n = len(small)
        return any(big[i:i + n] == small for i in range(len(big) - n + 1))

    kept = []
    for it in items:
        if any(len(o["words"]) > len(it["words"]) and o["count"] >= it["count"]
               and contained(it["words"], o["words"]) for o in items):
            continue
        kept.append(it)

    kept.sort(key=lambda x: (-x["score"], -x["count"], x["term"].lower()))
    return [{"term": it["term"], "count": it["count"]} for it in kept[:limit]]


def subject_graph(min_notes=2, limit=40):
    """The emergent subjects as a *place to wander* (C1): each subject is a
    clearing you can stand in, with the notes it came from and trails to the
    other subjects you've written about *in the same notes*.

    Built only from your own words and only when you open the view (pull, never
    push — VISION.md). A "trail" between two subjects is a co-occurrence: they
    both appear in some live note. There is no imposed map; the shape is just
    which of your words keep company with which.

    Returns::

        {
          "subjects": [
            {"term", "count",
             "trails": [{"term", "shared"}],   # neighbours, busiest trail first
             "note_ids": [id, ...]},           # notes in this clearing, newest first
          ],
          "notes": {id: {note fields}},        # the notes referenced above, once each
          "notes_total": N, "min_notes": min_notes,
        }
    """
    subs = subjects(min_notes=min_notes, limit=limit)
    # lower-term -> display surface, and -> headline count, for the kept subjects
    surface = {s["term"].lower(): s["term"] for s in subs}
    count_of = {s["term"].lower(): s["count"] for s in subs}
    keys = set(surface)

    with _conn() as c:
        rows = c.execute(
            "SELECT id, release_id, artist, title, body, track, timestamp, "
            "created_at, updated_at FROM notes WHERE deleted_at IS NULL "
            "ORDER BY created_at DESC").fetchall()

    members = {k: [] for k in keys}       # subject -> note ids (newest first)
    notes_by_id = {}
    cooc = Counter()                      # (lo, hi) subject pair -> shared notes
    for r in rows:
        present = sorted(k for k in _note_terms(r["body"]) if k in keys)
        if not present:
            continue
        notes_by_id[r["id"]] = {
            "id": r["id"], "release_id": r["release_id"],
            "artist": r["artist"], "title": r["title"], "body": r["body"],
            "track": r["track"], "timestamp": r["timestamp"],
            "created_at": r["created_at"], "updated_at": r["updated_at"],
        }
        for k in present:
            members[k].append(r["id"])
        for i in range(len(present)):
            for j in range(i + 1, len(present)):
                cooc[(present[i], present[j])] += 1

    trails = {k: [] for k in keys}
    for (a, b), shared in cooc.items():
        trails[a].append((b, shared))
        trails[b].append((a, shared))

    out = []
    for s in subs:
        lw = s["term"].lower()
        nb = sorted(trails[lw],
                    key=lambda x: (-x[1], -count_of.get(x[0], 0), x[0]))
        out.append({
            "term": s["term"], "count": s["count"],
            "trails": [{"term": surface[t], "shared": sh} for t, sh in nb],
            "note_ids": members[lw],
        })
    return {"subjects": out, "notes": notes_by_id,
            "notes_total": counts()["notes"], "min_notes": min_notes}


# --- choices (G5) -----------------------------------------------------------

def _choice_snapshot(album):
    """Durable fields out of a resolved album dict (incl. genres/year so the
    patterns view doesn't need the album cache). `uid` is the source-agnostic
    identity; release_id is denormalized provenance (NULL for MB-only)."""
    a = album or {}
    return {
        "uid": _album_uid(a),
        "release_id": a.get("release_id"),
        "artist": a.get("artist"), "title": a.get("title"),
        "released": a.get("released"), "discogs_url": a.get("discogs_url"),
        "genres": a.get("genres"), "year": a.get("year"),
    }


def add_choice(chosen, not_chosen=None, day_context=None, reasons=None,
               note=None):
    """Record a choice. `chosen`/`not_chosen` are db.get_album() dicts. Returns
    the new choice id. The reason (tags + note) is optional and can be added later
    via update_choice()."""
    ch = _choice_snapshot(chosen)
    nc = _choice_snapshot(not_chosen)
    now = _now()
    with _conn() as c:
        cur = c.execute(
            """INSERT INTO choices
               (chosen_uid, chosen_id, chosen_artist, chosen_title,
                chosen_released, chosen_discogs_url, chosen_genres, chosen_year,
                not_chosen_uid, not_chosen_id, not_chosen_artist, not_chosen_title,
                day_context, reasons, note, chosen_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (ch["uid"], ch["release_id"], ch["artist"], ch["title"],
             ch["released"], ch["discogs_url"], ch["genres"], ch["year"],
             nc["uid"], nc["release_id"], nc["artist"], nc["title"],
             day_context, json.dumps(list(reasons or [])), (note or None),
             now, now))
        c.commit()
        return cur.lastrowid


def update_choice(choice_id, chosen=None, not_chosen=None, reasons=None,
                  note=None):
    """Patch a choice: swap which record was chosen (changed-your-mind), and/or
    set the reason tags + note. Only the provided fields change."""
    sets, params = [], []
    if chosen is not None:
        ch = _choice_snapshot(chosen)
        sets += ["chosen_uid=?", "chosen_id=?", "chosen_artist=?",
                 "chosen_title=?", "chosen_released=?", "chosen_discogs_url=?",
                 "chosen_genres=?", "chosen_year=?"]
        params += [ch["uid"], ch["release_id"], ch["artist"], ch["title"],
                   ch["released"], ch["discogs_url"], ch["genres"], ch["year"]]
    if not_chosen is not None:
        nc = _choice_snapshot(not_chosen)
        sets += ["not_chosen_uid=?", "not_chosen_id=?", "not_chosen_artist=?",
                 "not_chosen_title=?"]
        params += [nc["uid"], nc["release_id"], nc["artist"], nc["title"]]
    if reasons is not None:
        sets += ["reasons=?"]
        params += [json.dumps(list(reasons))]
    if note is not None:
        sets += ["note=?"]
        params += [note.strip() or None]
    if not sets:
        return False
    sets += ["updated_at=?"]
    params += [_now()]
    params.append(choice_id)
    with _conn() as c:
        cur = c.execute(
            f"UPDATE choices SET {_set_clause(sets, _CHOICE_SET_COLS)} WHERE id=?",
            params)
        c.commit()
        return cur.rowcount > 0


def delete_choice(choice_id):
    with _conn() as c:
        c.execute("DELETE FROM choices WHERE id=?", (choice_id,))
        c.commit()


def _choice_row(r):
    d = dict(r)
    try:
        d["reasons"] = json.loads(d.get("reasons") or "[]")
    except (TypeError, ValueError):
        d["reasons"] = []
    return d


def choices_feed(limit=2000):
    """All choices, newest first, with reasons decoded to a list."""
    with _conn() as c:
        rows = c.execute(
            "SELECT * FROM choices ORDER BY chosen_at DESC, id DESC LIMIT ?",
            (limit,)).fetchall()
    return [_choice_row(r) for r in rows]


def choices_stats():
    """Aggregates for the patterns panel: what you choose and why."""
    choices = choices_feed(limit=1000000)
    artists, genres, decades, reasons = (Counter() for _ in range(4))
    for p in choices:
        if p.get("chosen_artist"):
            artists[p["chosen_artist"]] += 1
        for g in _split_genres(p.get("chosen_genres")):
            genres[g] += 1
        y = p.get("chosen_year")
        if y:
            decades[f"{(int(y) // 10) * 10}s"] += 1
        for r in p.get("reasons") or []:
            reasons[r] += 1

    def top(counter, n=8):
        return [{"label": k, "count": v} for k, v in counter.most_common(n)]

    decade_rows = sorted(
        ({"label": k, "count": v} for k, v in decades.items()),
        key=lambda x: (-x["count"], x["label"]))[:8]
    return {
        "total": len(choices),
        "with_reason": sum(1 for p in choices if p.get("reasons")),
        "top_artists": top(artists),
        "top_genres": top(genres),
        "top_decades": decade_rows,
        "reasons": top(reasons, 12),
    }


# --- saved trails (T1) ------------------------------------------------------

def _trail_row(r):
    """Decode a trails row, with `nodes` parsed back to a list."""
    d = dict(r)
    try:
        d["nodes"] = json.loads(d.get("nodes") or "[]")
    except (TypeError, ValueError):
        d["nodes"] = []
    return d


def add_trail(name, nodes):
    """Save a wander as a named Trail. `nodes` is the pull-tree of the walk: a
    list of {parent, label, nav} steps. Returns the new trail id. Raises
    ValueError on an empty name or empty walk."""
    name = (name or "").strip()
    if not name:
        raise ValueError("a trail needs a name")
    if not isinstance(nodes, list) or not nodes:
        raise ValueError("a trail needs at least one step")
    now = _now()
    with _conn() as c:
        cur = c.execute(
            "INSERT INTO trails (name, nodes, created_at, updated_at) "
            "VALUES (?,?,?,?)",
            (name[:200], json.dumps(nodes), now, now))
        c.commit()
        return cur.lastrowid


def rename_trail(trail_id, name):
    name = (name or "").strip()
    if not name:
        raise ValueError("a trail needs a name")
    with _conn() as c:
        cur = c.execute(
            "UPDATE trails SET name=?, updated_at=? WHERE id=?",
            (name[:200], _now(), trail_id))
        c.commit()
        return cur.rowcount > 0


def delete_trail(trail_id):
    with _conn() as c:
        c.execute("DELETE FROM trails WHERE id=?", (trail_id,))
        c.commit()


def trails_feed(limit=2000):
    """All saved trails, newest first, with `nodes` decoded to a list."""
    with _conn() as c:
        rows = c.execute(
            "SELECT * FROM trails ORDER BY created_at DESC, id DESC LIMIT ?",
            (limit,)).fetchall()
    return [_trail_row(r) for r in rows]


# --- integrity (D5) ---------------------------------------------------------

def integrity_check():
    """Run SQLite's ``PRAGMA integrity_check`` on the journal — the one
    irreplaceable, user-authored database — so corruption is caught early
    (ideally before the startup backup snapshots a bad file).

    Returns ``(ok, problems)``: ok is True when the database is healthy;
    otherwise problems is the list of issues SQLite reported. A missing journal
    file is treated as healthy (there's simply nothing to check yet)."""
    if not config.JOURNAL_DB_PATH.exists():
        return True, []
    with _conn() as c:
        rows = c.execute("PRAGMA integrity_check").fetchall()
    messages = [r[0] for r in rows]
    ok = messages == ["ok"]
    return ok, ([] if ok else messages)


# --- backups (D1) -----------------------------------------------------------

def backup(keep=None):
    """Write a hot-safe snapshot of the journal to config.JOURNAL_BACKUP_DIR via
    `VACUUM INTO`, then prune to the newest `keep` copies. Returns the snapshot
    Path (or None if there's nothing to back up / backups are disabled).

    `VACUUM INTO` takes a read lock only, so it's safe to run while the app is
    serving. The journal is the one irreplaceable file here, so this runs on
    every startup; point a nightly cron at it too if you like."""
    if keep is None:
        keep = config.JOURNAL_BACKUP_KEEP
    if keep <= 0 or not config.JOURNAL_DB_PATH.exists():
        return None
    backup_dir = config.JOURNAL_BACKUP_DIR
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dest = backup_dir / f"journal-{stamp}.db"
    # VACUUM INTO refuses to overwrite, so a same-second double-run is harmless.
    if not dest.exists():
        with _conn() as c:
            c.execute("VACUUM INTO ?", (str(dest),))
    # Prune oldest beyond `keep` (lexical sort works: timestamped names).
    snaps = sorted(backup_dir.glob("journal-*.db"))
    for old in snaps[:-keep]:
        try:
            old.unlink()
        except OSError:
            pass
    return dest


# --- export / import (D2) ---------------------------------------------------

def export_data():
    """A portable, self-contained dump of the journal as a plain dict (JSON-
    serializable). Includes notes and any legacy listens so nothing is lost on a
    round-trip; the denormalized album snapshot in each row keeps it meaningful
    even without the album cache."""
    with _conn() as c:
        notes = [_note_out(r) for r in c.execute(
            "SELECT * FROM notes WHERE deleted_at IS NULL ORDER BY id")]
        listens = [dict(r) for r in c.execute(
            "SELECT * FROM listens ORDER BY id")]
        choices = [dict(r) for r in c.execute(
            "SELECT * FROM choices ORDER BY id")]
        trails = [_trail_row(r) for r in c.execute(
            "SELECT * FROM trails ORDER BY id")]
        marks = [dict(r) for r in c.execute(
            "SELECT * FROM platform_marks ORDER BY release_id, service")]
    return {
        "app": "album-of-the-day",
        "kind": "journal-export",
        "version": EXPORT_VERSION,
        "exported_at": _now(),
        "notes": notes,
        "listens": listens,
        "choices": choices,
        "trails": trails,
        "platform_marks": marks,
    }


def import_data(payload, mode="merge"):
    """Import a dump produced by export_data(). `mode="merge"` (default) adds
    rows that aren't already present and leaves existing ones untouched;
    `mode="replace"` clears the journal first. Idempotent: a note is considered a
    duplicate if (release_id, created_at, body) already exists, so re-importing
    the same file is a no-op. Original ids are NOT preserved (they're reassigned)
    to avoid clobbering current rows. Returns counts."""
    if not isinstance(payload, dict) or payload.get("kind") != "journal-export":
        raise ValueError("not an Album-of-the-Day journal export")
    if int(payload.get("version", 0)) > EXPORT_VERSION:
        raise ValueError(
            f"export version {payload.get('version')} is newer than this app "
            f"supports ({EXPORT_VERSION})")
    notes = payload.get("notes") or []
    # v7 carries `choices`; a ≤v6 export carries `picks` (winner_*/loser_*),
    # mapped onto the new names on the way in.
    choices = payload.get("choices")
    if choices is None:
        choices = payload.get("picks") or []
    trails = payload.get("trails") or []
    marks = payload.get("platform_marks") or []
    added = skipped = choices_added = choices_skipped = 0
    trails_added = trails_skipped = 0
    marks_added = marks_skipped = 0
    with _conn() as c:
        if mode == "replace":
            c.execute("DELETE FROM notes")
            c.execute("DELETE FROM choices")
            c.execute("DELETE FROM trails")
            c.execute("DELETE FROM platform_marks")
        existing = set()
        for r in c.execute("SELECT uid, created_at, body FROM notes"):
            existing.add((r["uid"], r["created_at"], r["body"]))
        for n in notes:
            rid = n.get("release_id")
            # v6 carries uid; an older (≤v5) export is folded onto 'd:'+release_id.
            uid = n.get("uid") or _uid_of(rid)
            body = n.get("body")
            if uid is None or not body:
                skipped += 1
                continue
            created = n.get("created_at") or _now()
            key = (uid, created, body)
            if key in existing:
                skipped += 1
                continue
            c.execute(
                """INSERT INTO notes
                   (uid, release_id, artist, title, released, discogs_url,
                    track, timestamp, body, ref, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (uid, rid, n.get("artist"), n.get("title"), n.get("released"),
                 n.get("discogs_url"), n.get("track"), n.get("timestamp"),
                 body, _encode_ref(n.get("ref")), created,
                 n.get("updated_at") or created))
            existing.add(key)
            added += 1

        # Choices (v2+). Dedup on (chosen_uid, chosen_at). v7 carries the
        # chosen_*/not_chosen_*/chosen_at names; a ≤v6 export carries
        # winner_*/loser_*/picked_at, read via the `old` fallback below. A pre-v6
        # row without a uid folds onto 'd:'+<id>.
        seen_c = set()
        for r in c.execute("SELECT chosen_uid, chosen_at FROM choices"):
            seen_c.add((r["chosen_uid"], r["chosen_at"]))
        for p in choices:
            def g(new, old, _p=p):
                v = _p.get(new)
                return v if v is not None else _p.get(old)
            ch_id = g("chosen_id", "winner_id")
            ch_uid = g("chosen_uid", "winner_uid") or _uid_of(ch_id)
            nc_uid = (g("not_chosen_uid", "loser_uid")
                      or _uid_of(g("not_chosen_id", "loser_id")))
            at = g("chosen_at", "picked_at")
            if ch_uid is None or not at:
                choices_skipped += 1
                continue
            key = (ch_uid, at)
            if key in seen_c:
                choices_skipped += 1
                continue
            # Normalize reasons to a JSON-array string whether the source stored
            # a list or already-encoded string.
            raw = p.get("reasons")
            if isinstance(raw, list):
                reasons = json.dumps(raw)
            elif isinstance(raw, str) and raw.strip():
                reasons = raw
            else:
                reasons = "[]"
            c.execute(
                """INSERT INTO choices
                   (chosen_uid, chosen_id, chosen_artist, chosen_title,
                    chosen_released, chosen_discogs_url, chosen_genres,
                    chosen_year, not_chosen_uid, not_chosen_id, not_chosen_artist,
                    not_chosen_title, day_context, reasons, note, chosen_at,
                    updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (ch_uid, ch_id, g("chosen_artist", "winner_artist"),
                 g("chosen_title", "winner_title"),
                 g("chosen_released", "winner_released"),
                 g("chosen_discogs_url", "winner_discogs_url"),
                 g("chosen_genres", "winner_genres"),
                 g("chosen_year", "winner_year"),
                 nc_uid, g("not_chosen_id", "loser_id"),
                 g("not_chosen_artist", "loser_artist"),
                 g("not_chosen_title", "loser_title"),
                 p.get("day_context"), reasons, p.get("note"),
                 at, p.get("updated_at") or at))
            seen_c.add(key)
            choices_added += 1

        # Trails (v4+). Dedup on (name, created_at).
        seen_t = set()
        for r in c.execute("SELECT name, created_at FROM trails"):
            seen_t.add((r["name"], r["created_at"]))
        for t in trails:
            name = (t.get("name") or "").strip()
            raw_nodes = t.get("nodes")
            if isinstance(raw_nodes, str):
                try:
                    raw_nodes = json.loads(raw_nodes)
                except (TypeError, ValueError):
                    raw_nodes = None
            if not name or not isinstance(raw_nodes, list) or not raw_nodes:
                trails_skipped += 1
                continue
            created = t.get("created_at") or _now()
            key = (name, created)
            if key in seen_t:
                trails_skipped += 1
                continue
            c.execute(
                "INSERT INTO trails (name, nodes, created_at, updated_at) "
                "VALUES (?,?,?,?)",
                (name[:200], json.dumps(raw_nodes), created,
                 t.get("updated_at") or created))
            seen_t.add(key)
            trails_added += 1

        # Platform marks (v5+). One row per (uid, service); merge keeps an
        # existing mark, replace already cleared the table above. v6 carries uid;
        # an older export folds onto 'd:'+release_id.
        seen_m = set()
        for r in c.execute("SELECT uid, service FROM platform_marks"):
            seen_m.add((r["uid"], r["service"]))
        for m in marks:
            rid = m.get("release_id")
            uid = m.get("uid") or _uid_of(rid)
            svc = (m.get("service") or "").strip().lower()
            state = m.get("state")
            if uid is None or svc not in MARK_SERVICES or state not in MARK_STATES:
                marks_skipped += 1
                continue
            if (uid, svc) in seen_m:
                marks_skipped += 1
                continue
            c.execute(
                """INSERT INTO platform_marks
                   (uid, release_id, service, state, artist, title, updated_at)
                   VALUES (?,?,?,?,?,?,?)""",
                (uid, rid, svc, state, m.get("artist"), m.get("title"),
                 m.get("updated_at") or _now()))
            seen_m.add((uid, svc))
            marks_added += 1
        c.commit()
    return {"added": added, "skipped": skipped,
            "choices_added": choices_added, "choices_skipped": choices_skipped,
            "trails_added": trails_added, "trails_skipped": trails_skipped,
            "marks_added": marks_added, "marks_skipped": marks_skipped,
            "mode": mode}
