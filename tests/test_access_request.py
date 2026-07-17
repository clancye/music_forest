"""
Tests for the Phase D request-access endpoint (POST /api/access-request).

A logged-out, uninvited guest asks for an invite instead of hitting a wall
(onboarding plan, locked decision 8). The ask is recorded server-side via the
trusted store path (SQLite here, Postgres in prod), the anon Supabase key never
gets an open write policy, and the route is rate-limited.

Like test_sync, this needs no catalog DB (the route doesn't touch albums.db), so
it builds its own throwaway-SQLite app via the factory.
"""
import config
import server
import store


def _make_client(tmp_path):
    app = server.create_app({
        "SYNC_DB_PATH": tmp_path / "sync.db",
        "SUPABASE_DB_URL": "",
        "SUPABASE_JWT_SECRET": "",      # bypass auth — the route is public anyway
        "PREFETCH_ENABLED": False,
    })
    app.testing = True
    return app.test_client()


def test_records_a_valid_request(tmp_path):
    client = _make_client(tmp_path)
    r = client.post("/api/access-request",
                    json={"email": "Alice@Example.com", "note": "loved the duel"})
    assert r.status_code == 200 and r.get_json()["ok"] is True

    rows = store.get_store().list_access_requests()
    assert len(rows) == 1
    row = rows[0]
    assert row["email"] == "alice@example.com"      # normalized to lowercase
    assert row["note"] == "loved the duel"
    assert row["status"] == "new"
    assert row["user_agent"]                         # the test client sends a UA


def test_note_is_optional(tmp_path):
    client = _make_client(tmp_path)
    r = client.post("/api/access-request", json={"email": "bob@example.com"})
    assert r.status_code == 200
    rows = store.get_store().list_access_requests()
    assert rows[0]["email"] == "bob@example.com" and rows[0]["note"] is None


def test_repeat_email_collapses_to_one_row(tmp_path):
    client = _make_client(tmp_path)
    client.post("/api/access-request", json={"email": "c@example.com", "note": "first"})
    client.post("/api/access-request", json={"email": "c@example.com", "note": "second"})
    rows = store.get_store().list_access_requests()
    assert len(rows) == 1
    assert rows[0]["note"] == "second"              # upsert updated the note


def test_rejects_garbage_email(tmp_path):
    client = _make_client(tmp_path)
    for bad in ["", "not-an-email", "a@b", "no spaces@x.com ".replace(" ", "\t"), "x" * 300 + "@y.com"]:
        r = client.post("/api/access-request", json={"email": bad})
        assert r.status_code == 400, bad
    assert store.get_store().list_access_requests() == []


def test_note_is_capped(tmp_path):
    client = _make_client(tmp_path)
    long_note = "z" * 5000
    r = client.post("/api/access-request", json={"email": "d@example.com", "note": long_note})
    assert r.status_code == 200
    rows = store.get_store().list_access_requests()
    assert len(rows[0]["note"]) == 1000             # capped at _MAX_ACCESS_NOTE


def test_response_does_not_leak_account_existence(tmp_path):
    """The response is uniform whether or not the email is already known, so it
    can't be used to enumerate accounts."""
    client = _make_client(tmp_path)
    first = client.post("/api/access-request", json={"email": "e@example.com"})
    second = client.post("/api/access-request", json={"email": "e@example.com"})
    assert first.get_json() == second.get_json() == {"ok": True}


# --- retention prune (Privacy Policy §6) ------------------------------------

def _backdate(tmp_path, email, days, status=None):
    """Rewrite a stored request's timestamps to `days` ago (and optionally its
    status), simulating a row that has been sitting in the table."""
    import sqlite3
    from datetime import datetime, timedelta, timezone
    stamp = (datetime.now(timezone.utc)
             - timedelta(days=days)).isoformat(timespec="microseconds")
    c = sqlite3.connect(tmp_path / "sync.db")
    if status is not None:
        c.execute("UPDATE access_requests SET status=?, created_at=?, "
                  "updated_at=? WHERE email=?", (status, stamp, stamp, email))
    else:
        c.execute("UPDATE access_requests SET created_at=?, updated_at=? "
                  "WHERE email=?", (stamp, stamp, email))
    c.commit()
    c.close()


def test_prune_deletes_handled_requests_after_window(tmp_path):
    client = _make_client(tmp_path)
    for email in ("old-invited@example.com", "old-declined@example.com",
                  "fresh-invited@example.com", "old-but-new@example.com"):
        client.post("/api/access-request", json={"email": email})
    _backdate(tmp_path, "old-invited@example.com", 200, status="invited")
    _backdate(tmp_path, "old-declined@example.com", 200, status="declined")
    _backdate(tmp_path, "fresh-invited@example.com", 30, status="invited")
    _backdate(tmp_path, "old-but-new@example.com", 200)   # still status='new'

    deleted = store.get_store().prune_access_requests(
        handled_days=180, max_days=365)
    assert deleted == 2
    left = {r["email"] for r in store.get_store().list_access_requests()}
    assert left == {"fresh-invited@example.com", "old-but-new@example.com"}


def test_prune_max_age_catches_even_unhandled_requests(tmp_path):
    client = _make_client(tmp_path)
    client.post("/api/access-request", json={"email": "ancient@example.com"})
    client.post("/api/access-request", json={"email": "recent@example.com"})
    _backdate(tmp_path, "ancient@example.com", 400)       # still status='new'

    deleted = store.get_store().prune_access_requests(
        handled_days=180, max_days=365)
    assert deleted == 1
    left = {r["email"] for r in store.get_store().list_access_requests()}
    assert left == {"recent@example.com"}


def test_prune_zero_window_disables_that_rule(tmp_path):
    client = _make_client(tmp_path)
    client.post("/api/access-request", json={"email": "kept@example.com"})
    _backdate(tmp_path, "kept@example.com", 999, status="invited")

    assert store.get_store().prune_access_requests(
        handled_days=0, max_days=0) == 0
    assert len(store.get_store().list_access_requests()) == 1
