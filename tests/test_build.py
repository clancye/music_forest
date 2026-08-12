"""End-to-end build + canonical-flagging tests against the fixture dump (R1)."""
import sqlite3

import build_db


def _albums(built_db):
    con = sqlite3.connect(built_db["db"])
    con.row_factory = sqlite3.Row
    return con


def test_only_full_dated_releases_kept(built_db):
    con = _albums(built_db)
    ids = {r[0] for r in con.execute("SELECT release_id FROM albums")}
    # 103 (00-00) and 105 (no date) are dropped; the rest are kept.
    assert ids == {100, 101, 102, 104}


def test_canonical_collapses_to_earliest_pressing(built_db):
    con = _albums(built_db)
    canon = {r[0] for r in con.execute(
        "SELECT release_id FROM albums WHERE is_canonical = 1")}
    # 100 (1985) beats its reissue 101 (1990) for master 50; standalone 102 &
    # 104 are canonical on their own.
    assert canon == {100, 102, 104}


def test_artist_join_persisted(built_db):
    con = _albums(built_db)
    artist = con.execute(
        "SELECT artist FROM albums WHERE release_id = 102").fetchone()[0]
    assert artist == "Beta feat. Gamma"


def test_formats_and_label_persisted(built_db):
    con = _albums(built_db)
    row = con.execute(
        "SELECT formats, label, country FROM albums WHERE release_id = 100"
    ).fetchone()
    assert row[0] == "Vinyl (LP, Album)"
    assert row[1] == "Acme Records"
    assert row[2] == "UK"


def test_tracklist_stored_without_headings(built_db):
    con = _albums(built_db)
    row = con.execute(
        "SELECT tracks FROM tracklists WHERE release_id = 104").fetchone()
    assert row is not None
    import json
    tracks = json.loads(row[0])
    assert [t["title"] for t in tracks] == ["Opener", "Closer"]
    # the "Side A" heading row (no pos/dur) was skipped
    assert all(t["pos"] for t in tracks)


def test_barcode_extracted_and_normalized(built_db):
    con = _albums(built_db)
    # 104 carries a Barcode (Text + String dupes) -> one normalized GTIN-14.
    row = con.execute(
        "SELECT barcodes FROM albums WHERE release_id = 104").fetchone()[0]
    import json
    assert json.loads(row) == ["00074646362822"]
    # releases without an <identifiers> Barcode stay NULL.
    assert con.execute(
        "SELECT barcodes FROM albums WHERE release_id = 100").fetchone()[0] is None


def test_search_index_built(built_db):
    con = sqlite3.connect(built_db["search"])
    n = con.execute("SELECT count(*) FROM albums_fts").fetchone()[0]
    # one FTS row per canonical album
    assert n == 3


def test_credits_extracted_in_sleeve_order(built_db):
    con = _albums(built_db)
    rows = con.execute(
        "SELECT person_id, name, role, seq FROM credits "
        "WHERE release_id = 100 ORDER BY seq").fetchall()
    # Linked credit keeps its Discogs id; the unlinked (id 0) one stores NULL —
    # a name, not a person. Names/roles are the raw sleeve strings.
    assert [tuple(r) for r in rows] == [
        (900, "Producer Pam (2)", "Producer", 0),
        (None, "Uncredited Ursula", "Photography By", 1),
    ]


def test_credits_follow_the_dated_population(built_db):
    con = _albums(built_db)
    # 103 (partial date) is excluded from albums, so its credit line must not
    # be ingested either; the reissue 101 (dated, non-canonical) keeps its own.
    assert con.execute("SELECT COUNT(*) FROM credits "
                       "WHERE release_id = 103").fetchone()[0] == 0
    assert con.execute("SELECT COUNT(*) FROM credits "
                       "WHERE release_id = 101").fetchone()[0] == 1


def test_credits_indexed(built_db):
    con = _albums(built_db)
    names = {r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='index' "
        "AND tbl_name='credits'")}
    assert {"idx_credits_release", "idx_credits_person"} <= names


def test_backfill_credits_is_idempotent(built_db, capsys):
    import build_db as bd
    from tests.fixtures import write_dump
    dump = write_dump(built_db["db"].parent / "refill_releases.xml.gz")
    bd.backfill_credits(dump, built_db["db"])
    con = _albums(built_db)
    # Refilled, not duplicated: same rows the build pass produced.
    assert con.execute("SELECT COUNT(*) FROM credits").fetchone()[0] == 4
    assert con.execute(
        "SELECT name FROM credits WHERE release_id = 104").fetchone()[0] == \
        "Producer Pam"


def test_mark_canonical_is_rerunnable(built_db):
    # mark_canonical doubles as an in-place migration; re-running is a no-op.
    con = sqlite3.connect(built_db["db"])
    build_db.mark_canonical(con)
    canon = {r[0] for r in con.execute(
        "SELECT release_id FROM albums WHERE is_canonical = 1")}
    assert canon == {100, 102, 104}
    con.close()
