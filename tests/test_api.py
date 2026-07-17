"""API smoke tests via the app factory + throwaway DBs (R1, exercises R3)."""


def test_day_endpoint(client):
    r = client.get("/api/day?date=03-10")
    assert r.status_code == 200
    data = r.get_json()
    assert data["count"] == 2
    assert {a["release_id"] for a in data["albums"]} == {100, 102}


def test_search_endpoint(client):
    r = client.get("/api/search?q=alpha")
    assert r.status_code == 200
    ids = {a["release_id"] for a in r.get_json()["albums"]}
    assert 100 in ids


def test_choice_endpoint(client):
    data = client.get("/api/choice?date=03-10").get_json()
    assert len(data["albums"]) == 2


def test_tracks_endpoint(client):
    data = client.get("/api/album/104/tracks").get_json()
    assert [t["title"] for t in data["tracks"]] == ["Opener", "Closer"]


def test_album_credits_endpoint(client):
    # The room (F27): sleeve order, roles quoted, unlinked credit carries no id.
    data = client.get("/api/album/100/credits").get_json()
    assert [(c["person_id"], c["name"], c["role"]) for c in data["credits"]] == [
        (900, "Producer Pam", "Producer"),
        (None, "Uncredited Ursula", "Photography By"),
    ]
    # An MB-only uid has no albums.db release -> an empty room, never an error.
    assert client.get("/api/album/m:mb:abc/credits").get_json()["credits"] == []


def test_album_pressings_endpoint(client):
    # F27-1b: lineage of the shared master, current pressing flagged.
    data = client.get("/api/album/101/pressings").get_json()
    assert data["count"] == 2
    assert [p["release_id"] for p in data["pressings"]] == [100, 101]
    assert data["pressings"][1]["current"] is True
    # Standalone / MB-only: an empty door, never an error.
    assert client.get("/api/album/102/pressings").get_json()["count"] == 0
    assert client.get("/api/album/m:mb:abc/pressings").get_json()["pressings"] == []


def test_person_endpoint(client):
    # The person's door (F27): honest total, newest-first survey, the role
    # quoted per record, and the Discogs link out.
    data = client.get("/api/person?id=900").get_json()
    assert data["name"] == "Producer Pam"
    assert data["count"] == 2 and data["shown"] == 2
    assert [a["release_id"] for a in data["albums"]] == [104, 100]
    assert [a["credit_roles"] for a in data["albums"]] == ["Mixed By", "Producer"]
    assert data["discogs_url"] == "https://www.discogs.com/artist/900"
    # F27-p2 fields degrade gracefully on a DB with no crosswalk table.
    assert data["wikipedia_url"] is None and data["musicbrainz_url"] is None
    assert data["merged_ids"] == 1


def test_person_endpoint_reissue_only_credit(client):
    # Credited only on the non-canonical reissue 101 -> the album still
    # surfaces, via its canonical pressing 100.
    data = client.get("/api/person?id=901").get_json()
    assert [a["release_id"] for a in data["albums"]] == [100]
    assert data["albums"][0]["credit_roles"] == "Remastered By"


def test_person_endpoint_validation(client):
    assert client.get("/api/person").status_code == 400
    assert client.get("/api/person?id=abc").status_code == 400
    assert client.get("/api/person?id=0").status_code == 400
    # Unknown id: an honest empty door, with the client's name as fallback.
    data = client.get("/api/person?id=424242&name=Ghost").get_json()
    assert data["count"] == 0 and data["albums"] == []
    assert data["name"] == "Ghost"


def test_journal_note_roundtrip(client):
    # add a note...
    r = client.post("/api/journal/note", json={"release_id": 100, "body": "great"})
    assert r.status_code == 200
    note_id = r.get_json()["id"]

    # ...it shows up for that album...
    got = client.get("/api/journal/album/100").get_json()
    assert any(n["id"] == note_id and n["body"] == "great" for n in got["notes"])

    # ...and the feed counts it...
    feed = client.get("/api/journal").get_json()
    assert feed["summary"]["notes"] >= 1

    # ...then delete it.
    d = client.delete(f"/api/journal/note/{note_id}")
    assert d.status_code == 200 and d.get_json()["ok"] is True


def test_journal_note_validation(client):
    r = client.post("/api/journal/note", json={"release_id": 100, "body": "  "})
    assert r.status_code == 400


def test_journal_typed_note_roundtrip(client):
    # v8 (Phase 0): a note can tie to a non-album entity. The client sends a typed
    # uid + a `ref` snapshot (there's no catalog row to hydrate); the route stores
    # it and the album door reads it back with the ref decoded to an object.
    from urllib.parse import quote
    ref = {"kind": "artist", "name": "Radiohead", "mbid": None}
    r = client.post("/api/journal/note",
                    json={"uid": "art:Radiohead", "body": "their use of silence",
                          "ref": ref})
    assert r.status_code == 200 and r.get_json()["ok"] is True

    got = client.get(f"/api/journal/album/{quote('art:Radiohead')}").get_json()
    assert got["uid"] == "art:Radiohead" and got["release_id"] is None
    note = got["notes"][0]
    assert note["body"] == "their use of silence"
    assert note["ref"] == ref                       # decoded back to an object
    assert note["artist"] is None                   # no album snapshot on a typed note


def test_journal_album_note_has_no_ref(client):
    # an ordinary album note carries no ref (the snapshot comes from the catalog).
    client.post("/api/journal/note", json={"release_id": 100, "body": "album note"})
    got = client.get("/api/journal/album/100").get_json()
    assert got["notes"][0]["ref"] is None


def test_person_search_route(client):
    # Phase 1: search credited people by name (persons_fts, built with the catalog).
    # The persons index is built by tools/ (the private pipeline); skip when absent.
    import pytest
    pytest.importorskip("tools.build_search_aux")
    d = client.get("/api/person/search?q=producer+pam").get_json()
    assert any(p["person_id"] == 900 and p["name"] == "Producer Pam"
               for p in d["persons"])
    # an empty query is a clean no-op, not a 400.
    assert client.get("/api/person/search?q=").get_json()["persons"] == []


def test_track_search_route(client, built_db):
    # Phase 1: with the opt-in tracks_fts built, track search returns the title
    # with its album context. (The empty-index degrade is covered in isolation by
    # test_search_aux; built_db is session-shared, so we don't assert on it here.)
    import sqlite3
    import pytest
    build_search_aux = pytest.importorskip("tools.build_search_aux")
    sc = sqlite3.connect(built_db["search"])
    try:
        build_search_aux.build_tracks_fts(sc, built_db["db"], log=lambda *a: None)
    finally:
        sc.close()
    d = client.get("/api/track/search?q=opener").get_json()
    assert any(t["album_uid"] == "d:104" and t["pos"] == "A1"
               and t["title"] == "Opener" for t in d["tracks"])


def test_album_includes_bandcamp_link(client):
    # F17: every album carries a no-key Bandcamp search link.
    a = next(x for x in client.get("/api/day?date=03-10").get_json()["albums"]
             if x["release_id"] == 100)
    assert a["bandcamp_url"].startswith("https://bandcamp.com/search?q=")


def test_platform_marks_roundtrip(client):
    # F16: set a mark, read it back, then clear it.
    r = client.post("/api/album/100/marks",
                    json={"service": "bandcamp", "state": "here"})
    assert r.status_code == 200 and r.get_json()["marks"] == {"bandcamp": "here"}

    got = client.get("/api/album/100/marks").get_json()
    assert got["marks"] == {"bandcamp": "here"}

    cleared = client.post("/api/album/100/marks",
                          json={"service": "bandcamp", "state": "unknown"})
    assert cleared.get_json()["marks"] == {}


def test_platform_marks_bad_service_400(client):
    r = client.post("/api/album/100/marks",
                    json={"service": "myspace", "state": "here"})
    assert r.status_code == 400


def test_journal_note_edit(client):
    nid = client.post("/api/journal/note",
                      json={"release_id": 100, "body": "draft"}).get_json()["id"]
    r = client.patch(f"/api/journal/note/{nid}", json={"body": "final"})
    assert r.status_code == 200 and r.get_json()["ok"] is True
    notes = client.get("/api/journal/album/100").get_json()["notes"]
    assert any(n["id"] == nid and n["body"] == "final" for n in notes)


def test_journal_note_edit_rejects_empty(client):
    nid = client.post("/api/journal/note",
                      json={"release_id": 100, "body": "keep"}).get_json()["id"]
    r = client.patch(f"/api/journal/note/{nid}", json={"body": "   "})
    assert r.status_code == 400


def test_journal_summary_has_no_gamification(client):
    # The journal summary is a neutral mirror: counts + the genres you write
    # about. Milestone badges + explorer coverage (G3/G4) and streaks were
    # removed as gamification (VISION: no engagement mechanics); this guards
    # against any of them creeping back into the payload.
    client.post("/api/journal/note", json={"release_id": 100, "body": "first"})
    summary = client.get("/api/journal").get_json()["summary"]
    for gone in ("badges", "streaks", "genres_covered", "decades_covered",
                 "decades"):
        assert gone not in summary, f"gamification field {gone!r} came back"
    assert summary["notes"] >= 1                          # neutral count stays
    assert "top_genres" in summary                        # neutral genre mirror stays


def test_choices_roundtrip(client):
    # Record a choice (release 100 chosen over 102), then read it back, patch its
    # reason, and delete it — exercising the renamed /api/choices routes end to end.
    r = client.post("/api/choices",
                    json={"chosen_id": 100, "not_chosen_id": 102,
                          "reasons": ["the cover"], "note": "calmer tonight"})
    assert r.status_code == 200 and r.get_json()["ok"] is True
    cid = r.get_json()["id"]

    feed = client.get("/api/choices").get_json()
    assert feed["stats"]["total"] == 1
    row = feed["choices"][0]
    assert row["chosen_id"] == 100 and row["not_chosen_id"] == 102
    assert row["reasons"] == ["the cover"] and row["note"] == "calmer tonight"
    assert row["album"]["release_id"] == 100          # enriched with the album

    assert client.patch(f"/api/choices/{cid}",
                        json={"note": "changed my mind on why"}).get_json()["ok"]
    assert client.get("/api/choices").get_json()["choices"][0]["note"] \
        == "changed my mind on why"

    assert client.delete(f"/api/choices/{cid}").get_json()["ok"] is True
    assert client.get("/api/choices").get_json()["stats"]["total"] == 0


def test_subjects_endpoint(client):
    client.post("/api/journal/note",
                json={"release_id": 100, "body": "the animation is lovely"})
    client.post("/api/journal/note",
                json={"release_id": 100, "body": "more animation, love it"})
    data = client.get("/api/subjects").get_json()
    assert any(s["term"].lower() == "animation" for s in data["subjects"])
    assert data["notes"] >= 2 and data["min_notes"] == 2


def test_connections_endpoint(client):
    # Two notes sharing two subjects -> a clearing with a trail between them (C1).
    # Keep the shared words ("donegal", "rain") from ever sitting adjacent in the
    # same order in both notes, or the recurring bigram would (by design) subsume
    # the unigrams — see subjects()'s sub-phrase subsumption.
    client.post("/api/journal/note",
                json={"release_id": 100, "body": "Donegal hills, then heavy rain"})
    client.post("/api/journal/note",
                json={"release_id": 100, "body": "rain falling, missing Donegal"})
    data = client.get("/api/connections").get_json()
    nodes = {s["term"].lower(): s for s in data["subjects"]}
    assert "donegal" in nodes and "rain" in nodes
    trails = {t["term"].lower() for t in nodes["donegal"]["trails"]}
    assert "rain" in trails
    # the clearing's notes are resolvable from the returned notes map
    nid = nodes["donegal"]["note_ids"][0]
    assert str(nid) in data["notes"] or nid in data["notes"]


def test_note_body_stored_as_markdown(client):
    # the server stores the raw markdown; rendering is the client's job
    md = "**bold** and a [link](https://example.com)"
    nid = client.post("/api/journal/note",
                      json={"release_id": 100, "body": md}).get_json()["id"]
    notes = client.get("/api/journal/album/100").get_json()["notes"]
    assert any(n["id"] == nid and n["body"] == md for n in notes)


def test_journal_note_soft_delete_and_restore(client):
    nid = client.post("/api/journal/note",
                      json={"release_id": 100, "body": "oops"}).get_json()["id"]
    client.delete(f"/api/journal/note/{nid}")
    notes = client.get("/api/journal/album/100").get_json()["notes"]
    assert all(n["id"] != nid for n in notes)
    r = client.post(f"/api/journal/note/{nid}/restore")
    assert r.status_code == 200 and r.get_json()["ok"] is True
    notes = client.get("/api/journal/album/100").get_json()["notes"]
    assert any(n["id"] == nid for n in notes)
