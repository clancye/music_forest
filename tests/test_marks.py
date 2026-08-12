"""Platform-availability marks (F16): the user's own, manual 'found it here /
not here' tags per album + service. Pure user input — no auto-detection.

Marks are keyed on the source-agnostic uid (P3 M2), PK (uid, service); the
Discogs release_id rides along as denormalized provenance."""
import pytest

UID = "d:100"
ALBUM = {
    "uid": UID, "release_id": 100, "artist": "Alpha", "title": "First Pressing",
    "released": "1985-03-10",
    "discogs_url": "https://www.discogs.com/release/100",
}


def test_no_marks_by_default(fresh_journal):
    assert fresh_journal.get_marks(UID) == {}


def test_set_and_get_mark(fresh_journal):
    j = fresh_journal
    marks = j.set_mark(UID, ALBUM, "bandcamp", "here")
    assert marks == {"bandcamp": "here"}
    assert j.get_marks(UID) == {"bandcamp": "here"}


def test_multiple_services_independent(fresh_journal):
    j = fresh_journal
    j.set_mark(UID, ALBUM, "bandcamp", "here")
    j.set_mark(UID, ALBUM, "spotify", "not_here")
    assert j.get_marks(UID) == {"bandcamp": "here", "spotify": "not_here"}


def test_resetting_state_upserts_not_duplicates(fresh_journal):
    j = fresh_journal
    j.set_mark(UID, ALBUM, "youtube", "here")
    j.set_mark(UID, ALBUM, "youtube", "not_here")     # change, not a second row
    assert j.get_marks(UID) == {"youtube": "not_here"}


def test_unknown_state_clears_the_mark(fresh_journal):
    j = fresh_journal
    j.set_mark(UID, ALBUM, "qobuz", "here")
    assert j.set_mark(UID, ALBUM, "qobuz", "unknown") == {}
    assert j.get_marks(UID) == {}


def test_mb_only_album_can_be_marked(fresh_journal):
    # Full parity: an MB-only ('m:') album gets the same marks as a Discogs one,
    # with NULL release_id provenance.
    j = fresh_journal
    mb = {"uid": "m:xyz", "artist": "Theta", "title": "Field Recording"}
    assert j.set_mark("m:xyz", mb, "bandcamp", "here") == {"bandcamp": "here"}
    assert j.get_marks("m:xyz") == {"bandcamp": "here"}
    assert j.get_marks(UID) == {}          # independent of the Discogs album


def test_invalid_service_rejected(fresh_journal):
    with pytest.raises(ValueError):
        fresh_journal.set_mark(UID, ALBUM, "soundcloud", "here")


def test_invalid_state_rejected(fresh_journal):
    with pytest.raises(ValueError):
        fresh_journal.set_mark(UID, ALBUM, "spotify", "maybe")


def test_marks_round_trip_export_import(fresh_journal):
    j = fresh_journal
    j.set_mark(UID, ALBUM, "bandcamp", "here")
    j.set_mark(UID, ALBUM, "apple", "not_here")
    dump = j.export_data()
    assert dump["version"] >= 6
    assert len(dump["platform_marks"]) == 2

    # Wipe and re-import → the marks come back intact (keyed on uid).
    j.import_data(dump, mode="replace")
    assert j.get_marks(UID) == {"bandcamp": "here", "apple": "not_here"}


def test_import_skips_existing_and_bad_marks(fresh_journal):
    j = fresh_journal
    j.set_mark(UID, ALBUM, "bandcamp", "here")
    dump = j.export_data()
    dump["platform_marks"].append(
        {"uid": UID, "release_id": 100, "service": "nope",
         "state": "here"})   # bad service
    res = j.import_data(dump, mode="merge")
    # The one real mark already exists (skipped); the bad one is skipped too.
    assert res["marks_added"] == 0
    assert res["marks_skipped"] == 2
    assert j.get_marks(UID) == {"bandcamp": "here"}
