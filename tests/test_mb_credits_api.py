"""
F28 read-path tests: the room for an MB-only ('m:') album and the person
door's MB fold, served over hand-built throwaway albums.db + pool.sqlite
(schemas kept in line with test_pooldb.py / tools/build_mb_credits.py). The
fixture restores every config attribute it touches so the pool flag and DB
paths never leak into the rest of the suite.
"""
import json
import sqlite3

import pytest

import config
import db


@pytest.fixture()
def f28_client(tmp_path):
    flask = pytest.importorskip("flask")  # noqa: F841
    db_path = tmp_path / "albums.db"
    pool_path = tmp_path / "pool.sqlite"

    con = sqlite3.connect(db_path)
    con.execute("CREATE TABLE albums (release_id INTEGER PRIMARY KEY, "
                "master_id INTEGER, title TEXT, artist TEXT, released TEXT, "
                "year INT, release_month INT, release_day INT, country TEXT, "
                "genres TEXT, styles TEXT, formats TEXT, label TEXT, "
                "is_canonical INT)")
    con.execute("CREATE TABLE credits (release_id INTEGER NOT NULL, "
                "person_id INTEGER, name TEXT NOT NULL, role TEXT, "
                "seq INTEGER NOT NULL)")
    con.execute("CREATE TABLE person_xref (person_id INTEGER PRIMARY KEY, "
                "qid TEXT NOT NULL, mbid TEXT, wikipedia TEXT)")
    con.execute("INSERT INTO person_xref VALUES (900, 'Q77', 'amb-1', NULL)")
    con.execute("CREATE TABLE mb_credits (release_mbid TEXT NOT NULL, "
                "artist_mbid TEXT, name TEXT NOT NULL, role TEXT, "
                "seq INTEGER NOT NULL)")
    con.executemany("INSERT INTO mb_credits VALUES (?,?,?,?,?)", [
        ("relA1", "amb-1", "Pam Producer", "Producer", 0),
        ("relA1", "amb-2", "Solo Uncross", "Guitar, Keyboard", 1),
        ("relA2", "amb-1", "Pam Producer", "Producer", 0),
        ("relA2", "amb-3", "Late Adder", "Mastering", 1),
    ])
    con.execute("CREATE TABLE mb_release_map (release_mbid TEXT PRIMARY KEY, "
                "uid TEXT NOT NULL, pos INTEGER NOT NULL)")
    con.executemany("INSERT INTO mb_release_map VALUES (?,?,?)", [
        ("relA1", "m:mb:rgA", 0), ("relA2", "m:mb:rgA", 1),
        ("relB", "m:mb:rgB", 0)])
    con.commit()
    con.close()

    con = sqlite3.connect(pool_path)
    con.execute("CREATE TABLE pool (uid TEXT PRIMARY KEY, album_id TEXT, "
                "source TEXT, month INT, day INT, year INT, "
                "original_date TEXT, artist TEXT, title TEXT, country TEXT, "
                "n_pressings INT, variant_of TEXT, release_ids TEXT, "
                "mb_release_ids TEXT, folded_mbids TEXT)")
    con.executemany("INSERT INTO pool VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [
        ("m:mb:rgA", "mb:rgA", "mb_only", 9, 26, 2020, "2020-09-26", "Act A",
         "Album A", "JP", 1, None, "[]", json.dumps(["relA1", "relA2"]), "[]"),
        ("m:mb:rgB", "mb:rgB", "mb_only", 3, 3, 2021, "2021-03-03", "Act B",
         "Album B", "BR", 1, None, "[]", json.dumps(["relB"]), "[]")])
    con.execute("CREATE TABLE availability (uid TEXT PRIMARY KEY, "
                "listenable INT, deezer_hit INT, deezer_url TEXT, "
                "resolved_at TEXT, method TEXT)")
    con.commit()
    con.close()

    keys = ("DB_PATH", "SEARCH_DB_PATH", "JOURNAL_DB_PATH",
            "JOURNAL_BACKUP_DIR", "POOL_DB_PATH", "POOL_ENABLED",
            "PREFETCH_ENABLED")
    saved = {k: getattr(config, k) for k in keys}
    import server
    app = server.create_app({
        "DB_PATH": db_path,
        "SEARCH_DB_PATH": tmp_path / "search.db",
        "JOURNAL_DB_PATH": tmp_path / "journal.db",
        "JOURNAL_BACKUP_DIR": tmp_path / "backups",
        "POOL_DB_PATH": pool_path,
        "POOL_ENABLED": True,
        "PREFETCH_ENABLED": False,
    })
    app.testing = True
    try:
        yield app.test_client()
    finally:
        for k, v in saved.items():
            setattr(config, k, v)


def test_mb_room_unions_dedups_and_crosswalks(f28_client):
    data = f28_client.get("/api/album/m:mb:rgA/credits").get_json()
    assert data["source"] == "musicbrainz"
    # relA1's rows lead (list order), relA2 adds only what's new (the
    # (artist, role) dedup); amb-1 is crosswalked -> a door, the rest plain.
    assert [(c["person_id"], c["name"], c["role"]) for c in data["credits"]] \
        == [(900, "Pam Producer", "Producer"),
            (None, "Solo Uncross", "Guitar, Keyboard"),
            (None, "Late Adder", "Mastering")]


def test_mb_room_empty_and_discogs_source(f28_client):
    # An MB-only album whose releases carry no relations: an empty room, no
    # error (unknown, never 'nobody').
    data = f28_client.get("/api/album/m:mb:rgB/credits").get_json()
    assert data["credits"] == []
    # A 'd:' (or bare legacy) uid stays the sleeve path, and says so.
    data = f28_client.get("/api/album/100/credits").get_json()
    assert data["source"] == "discogs"


def test_person_door_folds_mb_albums(f28_client):
    data = f28_client.get("/api/person?id=900").get_json()
    # No Discogs credits at all: the count, the album list, and even the
    # display name come from the MB arm (via the crosswalk).
    assert data["count"] == 1
    assert data["name"] == "Pam Producer"
    assert [a["uid"] for a in data["albums"]] == ["m:mb:rgA"]
    assert data["albums"][0]["credit_roles"] == "Producer"
    assert data["albums"][0]["source"] == "mb_only"


def test_mb_readers_degrade_without_tables(tmp_path):
    # A DB predating the F28 ingest: every reader comes back empty, never
    # raises (same contract as the F27 readers).
    old = config.DB_PATH
    bare = tmp_path / "bare.db"
    con = sqlite3.connect(bare)
    con.execute("CREATE TABLE albums (release_id INTEGER PRIMARY KEY)")
    con.close()
    config.DB_PATH = bare
    try:
        assert db.mb_credits_for(["relA1"]) == []
        assert db.mb_albums_by_credit(900) == ([], 0)
        assert db.person_mbids(900) == []
    finally:
        config.DB_PATH = old
