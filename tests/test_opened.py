"""Opened (v9, owner 2026-10-03): a Listen tap leaves an "opened" Notebook entry.

Keep was retired the same day — writing a note is how a record becomes yours — and
this is the quiet trace of reaching for one. It records the TAP and the service,
never a claim that you listened. One row per record per reader-local day."""
import pytest

UID = "d:100"
DAY = "2026-10-03"


def test_add_and_feed(fresh_journal):
    j = fresh_journal
    row = j.add_opened(UID, "spotify", DAY, artist="Alpha", title="First Pressing",
                       release_id=100)
    assert row["uid"] == UID and row["service"] == "spotify" and row["day"] == DAY
    assert row["artist"] == "Alpha" and row["release_id"] == 100 and row["opened_at"]
    assert [o["id"] for o in j.opened_feed()] == [row["id"]]


def test_one_per_record_per_day(fresh_journal):
    # A second tap the same day — even in another service — keeps the first row.
    j = fresh_journal
    first = j.add_opened(UID, "spotify", DAY)
    again = j.add_opened(UID, "apple", DAY)
    assert again["id"] == first["id"] and again["service"] == "spotify"
    assert len(j.opened_feed()) == 1
    # A new day is a new entry.
    j.add_opened(UID, "apple", "2026-10-04")
    assert len(j.opened_feed()) == 2


@pytest.mark.parametrize("uid,service,day", [
    (None, "spotify", DAY),            # no record
    (UID, "napster", DAY),             # not a service we open
    (UID, "spotify", "10/03/2026"),    # not a YYYY-MM-DD day
    (UID, "spotify", None),
])
def test_rejects_what_it_cannot_record_honestly(fresh_journal, uid, service, day):
    assert fresh_journal.add_opened(uid, service, day) is None
    assert fresh_journal.opened_feed() == []


def test_service_is_normalised(fresh_journal):
    assert fresh_journal.add_opened(UID, " Spotify ", DAY)["service"] == "spotify"


def test_delete(fresh_journal):
    j = fresh_journal
    row = j.add_opened(UID, "deezer", DAY)
    assert j.delete_opened(row["id"]) is True
    assert j.opened_feed() == []
    assert j.delete_opened(row["id"]) is False       # already gone


def test_export_import_round_trip(fresh_journal):
    j = fresh_journal
    j.add_opened(UID, "youtube", DAY, artist="Alpha", title="First Pressing")
    dump = j.export_data()
    assert dump["version"] == 9
    assert [o["uid"] for o in dump["opened"]] == [UID]
    # merge on top of itself: nothing new
    r = j.import_data(dump)
    assert r["opened_added"] == 0 and r["opened_skipped"] == 1
    # replace: cleared then restored, original tap time preserved
    r = j.import_data(dump, mode="replace")
    assert r["opened_added"] == 1
    got = j.opened_feed()[0]
    assert got["opened_at"] == dump["opened"][0]["opened_at"]
    assert got["service"] == "youtube"


def test_import_of_older_export_has_no_opened(fresh_journal):
    # A ≤v8 export simply carries no `opened` array.
    r = fresh_journal.import_data({"kind": "journal-export", "version": 8,
                                   "notes": [], "choices": []})
    assert r["opened_added"] == 0 and r["opened_skipped"] == 0


def test_routes(client):
    r = client.post("/api/opened", json={"uid": UID, "service": "spotify",
                                         "day": DAY, "artist": "Alpha",
                                         "title": "First Pressing"})
    assert r.status_code == 200 and r.get_json()["ok"]
    oid = r.get_json()["id"]
    # a double tap is the same row
    assert client.post("/api/opened", json={"uid": UID, "service": "apple",
                                            "day": DAY}).get_json()["id"] == oid
    feed = client.get("/api/opened").get_json()["opened"]
    assert [o["id"] for o in feed] == [oid] and "cover" in feed[0]
    assert client.post("/api/opened", json={"uid": UID, "service": "spotify"}
                       ).status_code == 400            # no day
    assert client.delete(f"/api/opened/{oid}").get_json()["ok"] is True
    assert client.get("/api/opened").get_json()["opened"] == []
