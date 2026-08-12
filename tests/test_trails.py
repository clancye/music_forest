"""Saved Trails (T1): the journal store + the API + export/import round-trip."""
import pytest


NODES = [
    {"parent": -1, "label": "Browse", "nav": None},
    {"parent": 0, "label": "Aphex Twin", "nav": {"t": "artist", "name": "Aphex Twin"}},
    {"parent": 1, "label": "“Drukqs”", "nav": {"t": "story", "rid": 42}},
]


# --- journal store ----------------------------------------------------------

def test_add_and_read_trail(fresh_journal):
    j = fresh_journal
    tid = j.add_trail("A late-night wander", NODES)
    feed = j.trails_feed()
    assert [t["id"] for t in feed] == [tid]
    t = feed[0]
    assert t["name"] == "A late-night wander"
    assert t["nodes"] == NODES          # JSON round-trips back to a list
    assert len(t["nodes"]) == 3


def test_add_trail_requires_name(fresh_journal):
    with pytest.raises(ValueError):
        fresh_journal.add_trail("   ", NODES)


def test_add_trail_requires_steps(fresh_journal):
    with pytest.raises(ValueError):
        fresh_journal.add_trail("empty", [])


def test_rename_and_delete_trail(fresh_journal):
    j = fresh_journal
    tid = j.add_trail("first name", NODES)
    assert j.rename_trail(tid, "second name") is True
    assert j.trails_feed()[0]["name"] == "second name"
    j.delete_trail(tid)
    assert j.trails_feed() == []


def test_trails_in_export_import_roundtrip(fresh_journal):
    j = fresh_journal
    j.add_trail("keep me", NODES)
    payload = j.export_data()
    assert payload["version"] >= 4
    assert len(payload["trails"]) == 1

    # Re-import into a clean journal in replace mode: the trail comes back intact.
    res = j.import_data(payload, mode="replace")
    assert res["trails_added"] == 1
    feed = j.trails_feed()
    assert len(feed) == 1
    assert feed[0]["nodes"] == NODES

    # Importing the same payload again is idempotent (dedup on name+created_at).
    res2 = j.import_data(payload, mode="merge")
    assert res2["trails_added"] == 0
    assert res2["trails_skipped"] == 1
    assert len(j.trails_feed()) == 1


# --- API --------------------------------------------------------------------

def test_api_trails_crud(client):
    # Empty to start.
    assert client.get("/api/trails").get_json()["trails"] == []

    # Create.
    r = client.post("/api/trails", json={"name": "tonight", "nodes": NODES})
    assert r.status_code == 200
    tid = r.get_json()["id"]

    feed = client.get("/api/trails").get_json()["trails"]
    assert len(feed) == 1 and feed[0]["name"] == "tonight"
    assert feed[0]["nodes"][1]["nav"]["name"] == "Aphex Twin"

    # Rename.
    assert client.patch(f"/api/trails/{tid}", json={"name": "renamed"}).status_code == 200
    assert client.get("/api/trails").get_json()["trails"][0]["name"] == "renamed"

    # Delete.
    assert client.delete(f"/api/trails/{tid}").status_code == 200
    assert client.get("/api/trails").get_json()["trails"] == []


def test_api_trail_rejects_empty_name(client):
    r = client.post("/api/trails", json={"name": "", "nodes": NODES})
    assert r.status_code == 400


def test_api_trail_rejects_empty_nodes(client):
    r = client.post("/api/trails", json={"name": "x", "nodes": []})
    assert r.status_code == 400


def test_api_trail_node_cleaning_drops_junk(client):
    # Malformed entries are dropped; well-formed ones kept and trimmed.
    nodes = [
        {"parent": -1, "label": "ok", "nav": None},
        "not a dict",
        {"parent": "bad", "label": 123, "nav": "not a dict"},
    ]
    r = client.post("/api/trails", json={"name": "mixed", "nodes": nodes})
    assert r.status_code == 200
    saved = client.get("/api/trails").get_json()["trails"][0]["nodes"]
    assert len(saved) == 2
    assert saved[0] == {"parent": -1, "label": "ok", "nav": None}
    # the junk-but-dict row is normalized: bad parent -> -1, nav -> None
    assert saved[1]["parent"] == -1 and saved[1]["nav"] is None
