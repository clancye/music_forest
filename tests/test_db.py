"""Data-access layer tests against the fixture DB (R1)."""
import db


def test_albums_for_day_canonical_only(built_db):
    # 1985-03-10 has canonical 100 and 102 (101 is a non-canonical reissue).
    rows = db.albums_for_day(3, 10)
    ids = {a["release_id"] for a in rows}
    assert ids == {100, 102}


def test_albums_for_day_limit(built_db):
    assert len(db.albums_for_day(3, 10, limit=1)) == 1


def test_day_count(built_db):
    assert db.day_count(3, 10) == 2
    assert db.day_count(12, 1) == 1
    assert db.day_count(1, 1) == 0


def test_get_album_drops_canonical_filter(built_db):
    # 101 is a non-canonical reissue but must still be fetchable by id.
    a = db.get_album(101)
    assert a is not None and a["release_id"] == 101
    assert a["discogs_url"].endswith("/release/101")
    assert "cover" in a
    # F17: Bandcamp leads the no-key Listen links.
    assert a["bandcamp_url"].startswith("https://bandcamp.com/search?q=")


def test_albums_by_ids_preserves_order(built_db):
    ids = [104, 100, 102]
    got = [a["release_id"] for a in db.albums_by_ids(ids)]
    assert got == ids


def test_albums_by_ids_skips_missing(built_db):
    got = [a["release_id"] for a in db.albums_by_ids([100, 999999])]
    assert got == [100]


def test_search_albums(built_db):
    # FTS over canonical rows: "alpha" matches release 100.
    hits = db.search_albums("alpha")
    assert any(a["release_id"] == 100 for a in hits)
    # reissue 101 is not in the (canonical-only) index
    assert all(a["release_id"] != 101 for a in hits)


def test_search_field_scoped(built_db):
    # scope to artist; "epsilon" is the artist on 104
    hits = db.search_albums("epsilon", field="artist")
    assert any(a["release_id"] == 104 for a in hits)


def test_albums_on_label_exact_match(built_db):
    # release 100 is the only canonical album on "Acme Records".
    rows = db.albums_on_label("Acme Records")
    assert {a["release_id"] for a in rows} == {100}
    # case-insensitive
    assert {a["release_id"] for a in db.albums_on_label("acme records")} == {100}
    # exact only: a prefix that the FTS would have matched must NOT count here
    assert db.albums_on_label("Acme") == []
    # newest-first ordering holds
    years = [a["year"] or 0 for a in db.albums_on_label("Acme Records")]
    assert years == sorted(years, reverse=True)


def test_albums_on_label_blank_guard(built_db):
    assert db.albums_on_label("") == []
    assert db.albums_on_label(None) == []
    assert db.albums_on_label("   ") == []


def test_albums_by_artist_exact_match(built_db):
    # "Alpha" has one canonical album (100); 101 is a non-canonical reissue.
    rows = db.albums_by_artist("Alpha")
    assert {a["release_id"] for a in rows} == {100}
    # case-insensitive, like the label panel
    assert {a["release_id"] for a in db.albums_by_artist("alpha")} == {100}
    # exact only: a prefix the artist-FTS path WOULD have matched must not count
    # here. This is the "clicked B.J. Thomas, got a bunch of different artists"
    # regression — the panel only ever shows records actually by this artist.
    assert db.albums_by_artist("Alph") == []
    # newest-first ordering holds
    years = [a["year"] or 0 for a in db.albums_by_artist("Alpha")]
    assert years == sorted(years, reverse=True)


def test_albums_by_artist_blank_guard(built_db):
    assert db.albums_by_artist("") == []
    assert db.albums_by_artist(None) == []
    assert db.albums_by_artist("   ") == []


def test_panel_indexes_exist(built_db):
    # build_db.mark_canonical must create the partial NOCASE indexes backing the
    # artist/label panels — their absence is what made the panels full-scan a
    # multi-GB catalog and time out (feedback #9, #12).
    import sqlite3
    c = sqlite3.connect(built_db["db"])
    names = {r[0] for r in c.execute(
        "SELECT name FROM sqlite_master WHERE type='index'")}
    c.close()
    assert {"idx_canon_label", "idx_canon_artist"} <= names


def test_label_panel_query_uses_index(built_db):
    # The label lookup must be an index SEARCH, not a full table SCAN: that is the
    # whole fix for the "minutes to load" / "Couldn't load the catalog" reports.
    import sqlite3
    c = sqlite3.connect(built_db["db"])
    plan = c.execute(
        "EXPLAIN QUERY PLAN "
        "SELECT al.release_id FROM albums al "
        "WHERE al.label = ? COLLATE NOCASE AND al.is_canonical = 1 "
        "ORDER BY al.year DESC LIMIT ?",
        ("Acme Records", 500)).fetchall()
    c.close()
    detail = " ".join(str(row[-1]) for row in plan)
    assert "idx_canon_label" in detail
    assert "SCAN" not in detail.upper().replace("USING INDEX", "")


def test_artist_panel_query_uses_index(built_db):
    import sqlite3
    c = sqlite3.connect(built_db["db"])
    plan = c.execute(
        "EXPLAIN QUERY PLAN "
        "SELECT al.release_id FROM albums al "
        "WHERE al.artist = ? COLLATE NOCASE AND al.is_canonical = 1 "
        "ORDER BY al.year DESC LIMIT ?",
        ("Alpha", 500)).fetchall()
    c.close()
    detail = " ".join(str(row[-1]) for row in plan)
    assert "idx_canon_artist" in detail


def test_choice_for_day_returns_two(built_db):
    choice = db.choice_for_day(3, 10)
    assert len(choice) == 2
    assert {a["release_id"] for a in choice} == {100, 102}


def test_credits_for_room_in_sleeve_order(built_db):
    room = db.credits_for(100)
    # Sleeve order, roles quoted raw; the '(2)' display suffix is stripped but
    # identity stays the person_id; the unlinked credit has person_id None.
    assert [(c["person_id"], c["name"], c["role"]) for c in room] == [
        (900, "Producer Pam", "Producer"),
        (None, "Uncredited Ursula", "Photography By"),
    ]


def test_credits_for_empty_and_none(built_db):
    assert db.credits_for(102) == []      # a release with no <extraartists>
    assert db.credits_for(None) == []


def test_person_name_most_frequent_spelling(built_db):
    # 900 appears as "Producer Pam (2)" (on 100) and "Producer Pam" (on 104):
    # a 1-1 tie breaks lexicographically, and both strip to the same display.
    assert db.person_name(900) == "Producer Pam"
    assert db.person_name(901) == "Remaster Rhea"
    assert db.person_name(999999) is None


def test_albums_by_credit_dedupes_to_master(built_db):
    # 901 is credited ONLY on the non-canonical reissue 101; their door must
    # still surface the album — via its canonical pressing 100 — with the role
    # quoted from where the credit actually sits.
    albums, total = db.albums_by_credit(901)
    assert total == 1
    assert [a["release_id"] for a in albums] == [100]
    assert albums[0]["credit_roles"] == "Remastered By"


def test_albums_by_credit_newest_first_with_local_roles(built_db):
    # 900 is credited on master 50 (via 100, 1985) and standalone 104 (2000):
    # two albums, newest first, each quoting the role THERE — never merged
    # into what the person "is".
    albums, total = db.albums_by_credit(900)
    assert total == 2
    assert [a["release_id"] for a in albums] == [104, 100]
    assert albums[0]["credit_roles"] == "Mixed By"
    assert albums[1]["credit_roles"] == "Producer"


def test_albums_by_credit_bounded_survey(built_db):
    # The hub-door rule: `total` stays the honest count even when the page is
    # cut to the newest-N survey.
    albums, total = db.albums_by_credit(900, limit=1)
    assert total == 2
    assert [a["release_id"] for a in albums] == [104]


def test_albums_by_credit_unknown_person(built_db):
    assert db.albums_by_credit(999999) == ([], 0)


def test_pressings_for_lineage_order(built_db):
    # Master 50: original 100 (1985, canonical) then reissue 101 (1990) —
    # lineage order, each with its own room size, the open one flagged.
    rows = db.pressings_for(101)
    assert [r["release_id"] for r in rows] == [100, 101]
    assert [r["room"] for r in rows] == [2, 1]
    assert rows[0]["is_canonical"] and not rows[1]["is_canonical"]
    assert [r["current"] for r in rows] == [False, True]
    assert rows[0]["label"] == "Acme Records"


def test_pressings_for_standalone_and_unknown(built_db):
    # A standalone release (master 0/NULL) has nothing honest to group.
    assert db.pressings_for(102) == []
    assert db.pressings_for(None) == []
    assert db.pressings_for(999999) == []


def test_pressings_query_uses_master_index(built_db):
    # The `AND master_id > 0` literal is what lets the partial idx_master
    # apply to a parameterized lookup — without it this is a full scan.
    import sqlite3
    c = sqlite3.connect(built_db["db"])
    plan = " ".join(str(r[-1]) for r in c.execute(
        "EXPLAIN QUERY PLAN SELECT release_id FROM albums "
        "WHERE master_id = ? AND master_id > 0 ORDER BY released, release_id",
        (50,)))
    c.close()
    assert "idx_master" in plan


def test_credit_readers_degrade_without_table(tmp_path):
    # A DB predating the F27 backfill has no credits table: every reader must
    # come back empty, never raise (the UI just shows no room). Same contract
    # for the p2 crosswalk readers on a DB predating person_xref.
    import sqlite3
    import config
    old = config.DB_PATH
    bare = tmp_path / "bare.db"
    con = sqlite3.connect(bare)
    con.execute("CREATE TABLE albums (release_id INTEGER PRIMARY KEY)")
    con.close()
    config.DB_PATH = bare
    try:
        assert db.credits_for(100) == []
        assert db.person_name(900) is None
        assert db.albums_by_credit(900) == ([], 0)
        assert db.person_links(900) is None
        assert db.merged_person_ids(900) == [900]
    finally:
        config.DB_PATH = old


def _fresh_db_with_xref(tmp_path):
    """A private fixture-dump build + a person_xref asserting 900 and 901 are
    the same person (one Wikidata item, two Discogs entries). Isolated from
    the session DB so the merge can't leak into other tests' expectations."""
    import build_db
    import config
    from tests.fixtures import write_dump
    import pytest
    _bpx = pytest.importorskip("tools.build_person_xref")
    load, parse_rows = _bpx.load, _bpx.parse_rows

    dump = write_dump(tmp_path / "dump.xml.gz")
    db_path = tmp_path / "albums.db"
    old_search = config.SEARCH_DB_PATH
    config.SEARCH_DB_PATH = tmp_path / "search.db"
    try:
        from pathlib import Path
        build_db.build(Path(dump), db_path)
    finally:
        config.SEARCH_DB_PATH = old_search
    csv_text = (
        "d,item,mbid,article\n"
        "900,http://www.wikidata.org/entity/Q77,mbid-pam,"
        "https://en.wikipedia.org/wiki/Producer_Pam\n"
        "901,http://www.wikidata.org/entity/Q77,mbid-pam,\n")
    load(str(db_path), parse_rows(csv_text))
    return db_path


def test_person_crosswalk_links_and_merge(tmp_path):
    import config
    old = config.DB_PATH
    config.DB_PATH = _fresh_db_with_xref(tmp_path)
    try:
        links = db.person_links(900)
        assert links["wikidata_url"] == "https://www.wikidata.org/wiki/Q77"
        assert links["musicbrainz_url"] == "https://musicbrainz.org/artist/mbid-pam"
        assert links["wikipedia_url"].endswith("/Producer_Pam")
        # Wikidata says 900 and 901 are one person: the group is symmetric.
        assert db.merged_person_ids(900) == [900, 901]
        assert db.merged_person_ids(901) == [900, 901]
        assert db.merged_person_ids(902) == [902]     # unknown -> itself
        # The door spans the merge: 901's reissue-only credit now sits on the
        # same album as 900's Producer credit (master 50 -> canonical 100),
        # roles quoted side by side; 104 still rides along. Same door from
        # either id, and the sparse entry wears the catalog's name.
        for pid in (900, 901):
            albums, total = db.albums_by_credit(pid)
            assert total == 2
            assert [a["release_id"] for a in albums] == [104, 100]
            assert albums[1]["credit_roles"] == "Producer, Remastered By"
        assert db.person_name(901) == "Producer Pam"
    finally:
        config.DB_PATH = old
