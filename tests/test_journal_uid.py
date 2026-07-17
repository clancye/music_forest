"""P3 M2 step 2: the journal's one-time uid re-key (v6) migration.

Builds a pre-uid (v5-shape) journal by hand — release_id NOT NULL, platform_marks
PK'd (release_id, service), picks winner_id NOT NULL, user_version 0 — then opens
it through journal._conn() (which runs the migration) and asserts the source-
agnostic uid re-key: backfill 'd:'+release_id, the folded-album remap through the
pool, the PK move to (uid, service), release_id kept as provenance, idempotency,
and that MB-only writes work afterward. No network, no albums.db — only sqlite +
journal.py, mirroring the injected-fake pattern in test_pooldb.py.
"""
import sqlite3

import pytest

import config
import journal

# The exact pre-uid schema a real journal would have been created with (v5).
OLD_SCHEMA = """
CREATE TABLE listens (
    id INTEGER PRIMARY KEY AUTOINCREMENT, release_id INTEGER NOT NULL,
    artist TEXT, title TEXT, released TEXT, discogs_url TEXT,
    listened_at TEXT NOT NULL);
CREATE TABLE notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, release_id INTEGER NOT NULL,
    artist TEXT, title TEXT, released TEXT, discogs_url TEXT, track TEXT,
    timestamp TEXT, body TEXT NOT NULL, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, deleted_at TEXT);
CREATE TABLE picks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, winner_id INTEGER NOT NULL,
    winner_artist TEXT, winner_title TEXT, winner_released TEXT,
    winner_discogs_url TEXT, winner_genres TEXT, winner_year INTEGER,
    loser_id INTEGER, loser_artist TEXT, loser_title TEXT, day_context TEXT,
    reasons TEXT, note TEXT, picked_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE trails (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, nodes TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE platform_marks (
    release_id INTEGER NOT NULL, service TEXT NOT NULL, state TEXT NOT NULL,
    artist TEXT, title TEXT, updated_at TEXT NOT NULL,
    PRIMARY KEY (release_id, service));
"""

T = "2026-06-01T00:00:00"


def _make_old_journal(path):
    """Create a populated v5-shape journal at `path`. release_id 999 is a NON-
    representative member of a folded album (see _make_pool); 100 is the
    representative; 102 is a standalone loser."""
    c = sqlite3.connect(path)
    c.executescript(OLD_SCHEMA)
    c.execute("INSERT INTO notes (release_id, artist, title, body, created_at, "
              "updated_at) VALUES (100,'Alpha','First','rep note',?,?)", (T, T))
    c.execute("INSERT INTO notes (release_id, artist, title, body, created_at, "
              "updated_at) VALUES (999,'Alpha','First (alt)','member note',?,?)",
              (T, T))
    c.execute("INSERT INTO listens (release_id, artist, title, listened_at) "
              "VALUES (100,'Alpha','First',?)", (T,))
    c.execute("INSERT INTO picks (winner_id, winner_artist, winner_title, "
              "loser_id, loser_artist, loser_title, reasons, picked_at, "
              "updated_at) VALUES (100,'Alpha','First',102,'Beta','Standalone',"
              "'[]',?,?)", (T, T))
    c.execute("INSERT INTO platform_marks (release_id, service, state, "
              "updated_at) VALUES (100,'bandcamp','here',?)", (T,))
    c.execute("INSERT INTO platform_marks (release_id, service, state, "
              "updated_at) VALUES (999,'spotify','not_here',?)", (T,))
    c.commit()
    c.close()


def _make_pool(path):
    """A minimal pool.sqlite whose one album folds release_ids [100, 999] under
    uid 'd:100' — so the legacy note/mark keyed on the non-representative 999
    re-keys onto the same uid as the pool."""
    c = sqlite3.connect(path)
    c.execute("CREATE TABLE pool (uid TEXT, source TEXT, release_ids TEXT)")
    c.execute("INSERT INTO pool (uid, source, release_ids) "
              "VALUES ('d:100','discogs','[100, 999]')")
    c.commit()
    c.close()


@pytest.fixture()
def old_journal(tmp_path, monkeypatch):
    """A pre-uid journal repointed into config, with no pool present by default."""
    jpath = tmp_path / "journal.db"
    _make_old_journal(jpath)
    monkeypatch.setattr(config, "JOURNAL_DB_PATH", jpath)
    monkeypatch.setattr(config, "JOURNAL_BACKUP_DIR", tmp_path / "backups")
    monkeypatch.setattr(config, "POOL_DB_PATH", tmp_path / "nope.sqlite")
    return jpath


def _user_version(path):
    c = sqlite3.connect(path)
    try:
        return c.execute("PRAGMA user_version").fetchone()[0]
    finally:
        c.close()


def _marks_pk(path):
    c = sqlite3.connect(path)
    try:
        return [r[1] for r in c.execute("PRAGMA table_info(platform_marks)")
                if r[5]]  # r[5] = pk position (>0 means part of the PK)
    finally:
        c.close()


def test_backfill_synthetic_uid_without_pool(old_journal):
    # No pool present -> every legacy row gets the synthetic 'd:'+release_id.
    rep = journal.for_album("d:100")["notes"]
    member = journal.for_album("d:999")["notes"]
    assert [n["body"] for n in rep] == ["rep note"]
    assert [n["body"] for n in member] == ["member note"]
    # release_id survives as provenance.
    assert rep[0]["release_id"] == 100 and member[0]["release_id"] == 999
    assert _user_version(old_journal) == journal.JOURNAL_SCHEMA_VERSION


def test_marks_and_choices_backfilled_without_pool(old_journal):
    assert journal.get_marks("d:100") == {"bandcamp": "here"}
    assert journal.get_marks("d:999") == {"spotify": "not_here"}
    # The pre-v6 pick row survives the uid re-key AND the v7 rename onto choices.
    p = journal.choices_feed()[0]
    assert p["chosen_uid"] == "d:100" and p["chosen_id"] == 100
    assert p["not_chosen_uid"] == "d:102" and p["not_chosen_id"] == 102


def test_marks_pk_moved_to_uid_service(old_journal):
    journal.get_marks("d:100")        # trigger the migration
    assert _marks_pk(old_journal) == ["uid", "service"]


def test_folded_member_remaps_to_pool_uid(tmp_path, monkeypatch):
    # WITH a pool, the non-representative member 999 re-keys onto the album's pool
    # uid 'd:100' rather than a lonely synthetic 'd:999'.
    jpath = tmp_path / "journal.db"
    _make_old_journal(jpath)
    _make_pool(tmp_path / "pool.sqlite")
    monkeypatch.setattr(config, "JOURNAL_DB_PATH", jpath)
    monkeypatch.setattr(config, "JOURNAL_BACKUP_DIR", tmp_path / "backups")
    monkeypatch.setattr(config, "POOL_DB_PATH", tmp_path / "pool.sqlite")

    # Both notes now live under the one album uid.
    bodies = {n["body"] for n in journal.for_album("d:100")["notes"]}
    assert bodies == {"rep note", "member note"}
    assert journal.for_album("d:999")["notes"] == []
    # The member's mark folds onto d:100 too (distinct service -> no collision).
    assert journal.get_marks("d:100") == {"bandcamp": "here",
                                          "spotify": "not_here"}


def test_folded_member_mark_collision_is_resolved(tmp_path, monkeypatch):
    # If two folded members carry a mark for the SAME service, the (uid, service)
    # PK would collide; the migration must resolve it, not crash.
    jpath = tmp_path / "journal.db"
    c = sqlite3.connect(jpath)
    c.executescript(OLD_SCHEMA)
    c.execute("INSERT INTO platform_marks (release_id, service, state, "
              "updated_at) VALUES (100,'bandcamp','here',?)", (T,))
    c.execute("INSERT INTO platform_marks (release_id, service, state, "
              "updated_at) VALUES (999,'bandcamp','not_here',?)", (T,))
    c.commit()
    c.close()
    _make_pool(tmp_path / "pool.sqlite")
    monkeypatch.setattr(config, "JOURNAL_DB_PATH", jpath)
    monkeypatch.setattr(config, "JOURNAL_BACKUP_DIR", tmp_path / "backups")
    monkeypatch.setattr(config, "POOL_DB_PATH", tmp_path / "pool.sqlite")

    marks = journal.get_marks("d:100")
    assert set(marks) == {"bandcamp"}          # exactly one row survived
    assert marks["bandcamp"] in ("here", "not_here")


def test_migration_is_idempotent(old_journal):
    journal.add_note("d:100", {"uid": "d:100", "release_id": 100}, "first open")
    before = journal.counts()
    # Several more opens must not re-run the rebuild or duplicate anything.
    for _ in range(3):
        journal.for_album("d:100")
    assert journal.counts() == before
    assert _user_version(old_journal) == journal.JOURNAL_SCHEMA_VERSION


def test_mb_only_write_after_migration(old_journal):
    # Post-migration the table accepts an MB-only row (NULL release_id) — the
    # whole point of relaxing the old NOT NULL.
    journal.add_note("m:abc", {"uid": "m:abc", "artist": "Theta",
                               "title": "Field"}, "MB note")
    notes = journal.for_album("m:abc")["notes"]
    assert [n["body"] for n in notes] == ["MB note"]
    assert notes[0]["release_id"] is None
    journal.set_mark("m:abc", {"uid": "m:abc"}, "youtube", "here")
    assert journal.get_marks("m:abc") == {"youtube": "here"}


def test_legacy_export_imports_onto_uid(old_journal):
    # A v5 export (no uid fields) imports by synthesizing 'd:'+release_id, so old
    # backups still restore onto the new key.
    dump = journal.export_data()
    assert dump["version"] == journal.EXPORT_VERSION   # exports at v7 now
    legacy_notes = [{"release_id": 555, "body": "legacy", "created_at": T,
                     "updated_at": T, "artist": "Old", "title": "Tape"}]
    legacy_marks = [{"release_id": 555, "service": "apple", "state": "here"}]
    payload = {"app": "album-of-the-day", "kind": "journal-export", "version": 5,
               "notes": legacy_notes, "picks": [], "trails": [],
               "platform_marks": legacy_marks}
    res = journal.import_data(payload, mode="merge")
    assert res["added"] == 1 and res["marks_added"] == 1
    assert [n["body"] for n in journal.for_album("d:555")["notes"]] == ["legacy"]
    assert journal.get_marks("d:555") == {"apple": "here"}


# --- v7: the picks -> choices rename ----------------------------------------
# The owner's real journal is already v6 (uid-keyed `picks`), so the rename step
# must run cleanly straight from user_version 1 — not only via the pre-v6 chain
# exercised above. This builds a v6-shape journal by hand and opens it.
V6_SCHEMA = """
CREATE TABLE notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT, release_id INTEGER,
    artist TEXT, title TEXT, released TEXT, discogs_url TEXT, track TEXT,
    timestamp TEXT, body TEXT NOT NULL, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, deleted_at TEXT);
CREATE TABLE listens (
    id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT, release_id INTEGER,
    artist TEXT, title TEXT, released TEXT, discogs_url TEXT,
    listened_at TEXT NOT NULL);
CREATE TABLE picks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, winner_uid TEXT, winner_id INTEGER,
    winner_artist TEXT, winner_title TEXT, winner_released TEXT,
    winner_discogs_url TEXT, winner_genres TEXT, winner_year INTEGER,
    loser_uid TEXT, loser_id INTEGER, loser_artist TEXT, loser_title TEXT,
    day_context TEXT, reasons TEXT, note TEXT, picked_at TEXT NOT NULL,
    updated_at TEXT NOT NULL);
CREATE TABLE trails (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, nodes TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE platform_marks (
    uid TEXT NOT NULL, service TEXT NOT NULL, state TEXT NOT NULL,
    release_id INTEGER, artist TEXT, title TEXT, updated_at TEXT NOT NULL,
    PRIMARY KEY (uid, service));
"""


@pytest.fixture()
def v6_journal(tmp_path, monkeypatch):
    """A v6-shape journal (uid-keyed `picks`, user_version 1) with one choice row,
    repointed into config. Opening it runs only the v7 rename step."""
    jpath = tmp_path / "journal.db"
    c = sqlite3.connect(jpath)
    c.executescript(V6_SCHEMA)
    c.execute(
        "INSERT INTO picks (winner_uid, winner_id, winner_artist, winner_title, "
        "winner_genres, winner_year, loser_uid, loser_id, loser_artist, "
        "loser_title, reasons, note, picked_at, updated_at) VALUES "
        "('d:100',100,'Alpha','First','Jazz',1971,'d:102',102,'Beta','Second',"
        "'[\"the cover\"]','because',?,?)", (T, T))
    c.execute("PRAGMA user_version = 1")
    c.commit()
    c.close()
    monkeypatch.setattr(config, "JOURNAL_DB_PATH", jpath)
    monkeypatch.setattr(config, "JOURNAL_BACKUP_DIR", tmp_path / "backups")
    monkeypatch.setattr(config, "POOL_DB_PATH", tmp_path / "nope.sqlite")
    return jpath


def _tables(path):
    c = sqlite3.connect(path)
    try:
        return {r[0] for r in c.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
    finally:
        c.close()


def test_v6_picks_renamed_to_choices(v6_journal):
    # Trigger the migration and read back through the renamed API + columns.
    p = journal.choices_feed()[0]
    assert p["chosen_uid"] == "d:100" and p["chosen_id"] == 100
    assert p["chosen_artist"] == "Alpha" and p["chosen_year"] == 1971
    assert p["not_chosen_uid"] == "d:102" and p["not_chosen_title"] == "Second"
    assert p["reasons"] == ["the cover"] and p["note"] == "because"
    assert "chosen_at" in p                      # picked_at renamed
    # The physical rename happened: choices table exists, picks is gone.
    tables = _tables(v6_journal)
    assert "choices" in tables and "picks" not in tables
    assert _user_version(v6_journal) == journal.JOURNAL_SCHEMA_VERSION


def test_v6_rename_preserves_stats_and_is_idempotent(v6_journal):
    stats = journal.choices_stats()
    assert stats["total"] == 1 and stats["with_reason"] == 1
    assert {a["label"] for a in stats["top_artists"]} == {"Alpha"}
    # Re-opening several times must not re-run the rename or lose the row.
    for _ in range(3):
        journal.choices_feed()
    assert journal.choices_stats()["total"] == 1
    assert _user_version(v6_journal) == journal.JOURNAL_SCHEMA_VERSION


def test_v6_export_import_maps_winner_to_chosen(v6_journal):
    # A ≤v6 export carries `picks` with winner_*/loser_*; importing it onto a fresh
    # (post-rename) journal must map the old names onto the new columns.
    v6_export = {
        "app": "album-of-the-day", "kind": "journal-export", "version": 6,
        "notes": [], "trails": [], "platform_marks": [],
        "picks": [{
            "winner_uid": "d:200", "winner_id": 200, "winner_artist": "Gamma",
            "winner_title": "Third", "winner_genres": "Soul", "winner_year": 1969,
            "loser_uid": "d:201", "loser_id": 201, "loser_artist": "Delta",
            "loser_title": "Fourth", "reasons": ["a memory"], "note": "n",
            "picked_at": "2026-05-01T00:00:00", "updated_at": "2026-05-01T00:00:00",
        }],
    }
    res = journal.import_data(v6_export, mode="merge")
    assert res["choices_added"] == 1
    row = next(p for p in journal.choices_feed() if p["chosen_uid"] == "d:200")
    assert row["chosen_artist"] == "Gamma" and row["chosen_year"] == 1969
    assert row["not_chosen_uid"] == "d:201" and row["not_chosen_title"] == "Fourth"
    assert row["reasons"] == ["a memory"]
