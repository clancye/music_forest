"""Typed note refs (v8, Phase 0).

A note's uid may now name a non-album entity — an artist ('art:<name>'), a credited
person ('per:<person_id>'), or a track ('trk:<album_uid>#<pos>') — not only an album
('d:'/'m:'). Because those entities have no albums.db row to hydrate a snapshot from,
such a note carries a `ref`: a small JSON snapshot stored so it renders on its own.
These tests pin the classifier, the round-trip through add_note/for_album/feed, and
the export/import (v8) carrying the ref."""
import journal

ARTIST_REF = {"kind": "artist", "name": "Radiohead", "mbid": None}
PERSON_REF = {"kind": "person", "name": "Nigel Godrich", "person_id": "12345"}
TRACK_REF = {"kind": "track", "title": "Idioteque", "pos": "8",
             "album_uid": "d:100", "album_artist": "Radiohead",
             "album_title": "Kid A"}


def test_kind_from_uid_classifies_by_prefix():
    assert journal.kind_from_uid(None) == "free"
    assert journal.kind_from_uid("") == "free"
    assert journal.kind_from_uid("d:100") == "album"
    assert journal.kind_from_uid("m:abc") == "album"
    assert journal.kind_from_uid("art:Radiohead") == "artist"
    assert journal.kind_from_uid("per:12345") == "person"
    assert journal.kind_from_uid("trk:d:100#8") == "track"
    assert journal.kind_from_uid("weird:thing") == "other"


def test_typed_note_stores_and_reads_back_its_ref(fresh_journal):
    j = fresh_journal
    nid = j.add_note("art:Radiohead", None, "the way they use silence", ref=ARTIST_REF)
    data = j.for_album("art:Radiohead")
    assert [n["id"] for n in data["notes"]] == [nid]
    note = data["notes"][0]
    # a typed note has no album snapshot / provenance...
    assert note["uid"] == "art:Radiohead"
    assert note["release_id"] is None
    assert note["artist"] is None and note["title"] is None
    # ...but its ref is decoded back to an object for the client.
    assert note["ref"] == ARTIST_REF


def test_person_and_track_refs_round_trip(fresh_journal):
    j = fresh_journal
    j.add_note("per:12345", None, "his production fingerprints", ref=PERSON_REF)
    j.add_note("trk:d:100#8", None, "that stutter-cut vocal", ref=TRACK_REF)
    assert j.for_album("per:12345")["notes"][0]["ref"] == PERSON_REF
    assert j.for_album("trk:d:100#8")["notes"][0]["ref"] == TRACK_REF


def test_album_and_free_notes_carry_no_ref(fresh_journal):
    j = fresh_journal
    album = {"uid": "d:100", "release_id": 100, "artist": "A", "title": "T"}
    j.add_note("d:100", album, "album note")
    j.add_note(None, None, "a free noticing")
    assert j.for_album("d:100")["notes"][0]["ref"] is None
    # the free note comes back through the feed (uid NULL) with ref None too.
    free = [n for n in j.feed()["notes"] if n["uid"] is None]
    assert len(free) == 1 and free[0]["ref"] is None


def test_feed_decodes_ref(fresh_journal):
    j = fresh_journal
    j.add_note("art:Radiohead", None, "silence again", ref=ARTIST_REF)
    typed = [n for n in j.feed()["notes"] if n["uid"] == "art:Radiohead"]
    assert len(typed) == 1 and typed[0]["ref"] == ARTIST_REF


def test_encode_ref_tolerates_junk():
    assert journal._encode_ref(None) is None
    assert journal._encode_ref({}) is None            # falsy dict -> nothing to store
    assert journal._encode_ref('{"kind":"artist"}') == '{"kind":"artist"}'
    # a non-serializable value degrades to NULL rather than raising on the write.
    assert journal._encode_ref({"x": {1, 2, 3}}) is None


def test_decode_ref_tolerates_junk():
    assert journal._decode_ref(None) is None
    assert journal._decode_ref("") is None
    assert journal._decode_ref("not json") is None
    assert journal._decode_ref('{"kind":"person"}') == {"kind": "person"}
    assert journal._decode_ref({"already": "obj"}) == {"already": "obj"}


def test_feed_search_finds_typed_note_by_ref_label(fresh_journal):
    # v8: a typed note has NULL artist/title, so the Notebook search must match its
    # ref label — the entity name (artist/person) or the track title + album.
    j = fresh_journal
    j.add_note("per:12345", None, "his production", ref=PERSON_REF)      # name in ref
    j.add_note("art:Radiohead", None, "the silences", ref=ARTIST_REF)
    j.add_note("trk:d:100#8", None, "the cut", ref=TRACK_REF)

    def bodies(q):
        return sorted(n["body"] for n in j.feed(q)["notes"])

    assert bodies("nigel") == ["his production"]          # person name -> ref match
    assert bodies("radiohead") == ["the cut", "the silences"]  # artist name + track's album_artist
    assert bodies("idioteque") == ["the cut"]             # track title -> ref match
    assert bodies("kid a") == ["the cut"]                 # track's album_title -> ref match
    # a body match still works, and doesn't over-reach into other notes.
    assert bodies("production") == ["his production"]
    # an unrelated query finds nothing.
    assert j.feed("nonexistent zzz")["notes"] == []


def test_feed_search_does_not_match_ref_json_keys(fresh_journal):
    # only ref VALUES are searchable — never the JSON keys (no "kind"/"person_id"
    # false positives that would surface every typed note).
    j = fresh_journal
    j.add_note("per:12345", None, "body one", ref=PERSON_REF)
    assert j.feed("person")["notes"] == []       # would match "kind":"person" if we grepped JSON
    assert j.feed("person_id")["notes"] == []


def test_counts_include_typed_notes_by_uid(fresh_journal):
    # counts distinct entities by uid (matches journal-store.js), so a typed note
    # (uid, no release_id) is counted — a bare COUNT(DISTINCT release_id) missed it.
    j = fresh_journal
    album = {"uid": "d:100", "release_id": 100, "artist": "A", "title": "T"}
    j.add_note("d:100", album, "album note")
    j.add_note("per:12345", None, "person note", ref=PERSON_REF)
    j.add_note("art:Radiohead", None, "artist note", ref=ARTIST_REF)
    c = j.counts()
    assert c["notes"] == 3
    assert c["albums"] == 3          # d:100 + per:12345 + art:Radiohead, all distinct uids


def test_export_import_round_trips_typed_ref(fresh_journal):
    j = fresh_journal
    j.add_note("art:Radiohead", None, "silence", ref=ARTIST_REF)
    j.add_note("trk:d:100#8", None, "the cut", ref=TRACK_REF)
    dump = j.export_data()
    assert dump["version"] == journal.EXPORT_VERSION == 8
    # the exported note carries its ref as a decoded object.
    exported = {n["uid"]: n for n in dump["notes"]}
    assert exported["art:Radiohead"]["ref"] == ARTIST_REF
    assert exported["trk:d:100#8"]["ref"] == TRACK_REF

    # import into a fresh journal (a second throwaway DB beside the fixture's)
    # reconstitutes the typed refs.
    import config
    config.JOURNAL_DB_PATH = config.JOURNAL_DB_PATH.parent / "journal2.db"
    res = j.import_data(dump, mode="replace")
    assert res["added"] == 2
    assert j.for_album("art:Radiohead")["notes"][0]["ref"] == ARTIST_REF
    assert j.for_album("trk:d:100#8")["notes"][0]["ref"] == TRACK_REF
    # a re-import is a no-op (dedup on uid|created_at|body), refs intact.
    res2 = j.import_data(dump, mode="merge")
    assert res2["added"] == 0 and res2["skipped"] == 2
