"""
Operator crawler-health endpoint (/api/admin/crawl-status).

The local door prewarm writes a heartbeat row into pool.sqlite (counts + the day
it last resolved + a UTC timestamp); pool.sqlite rsyncs up to the host, and the
operator console reads it here so you can see the crawler is alive without shelling
in. These tests cover the derived `health` verdict and the operator gate.

No catalog DB is needed (the endpoint only reads pool.sqlite), so this builds its
own throwaway-SQLite app like test_sync rather than using the `built_db` fixture.
"""
import sqlite3

import pytest

import auth
import config
import pooldb
import server

SECRET = "test-jwt-signing-secret"
LOCAL = "00000000-0000-0000-0000-000000000000"
USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"


PUSH_TOKEN = "push-secret-123"


def _make_client(tmp_path, *, secret="", operators=frozenset(), push_token=""):
    pool_path = tmp_path / "pool.sqlite"
    app = server.create_app({
        "POOL_DB_PATH": pool_path,
        "CRAWL_STATUS_FILE": tmp_path / "crawl_status.json",
        "CRAWL_PUSH_TOKEN": push_token,
        "SYNC_DB_PATH": tmp_path / "sync.db",
        "SUPABASE_DB_URL": "",
        "SUPABASE_JWT_SECRET": secret,
        "SUPABASE_JWKS_URL": "",
        "JWT_AUDIENCE": "authenticated",
        "JWT_ISSUER": "",
        "LOCAL_USER_ID": LOCAL,
        "OPERATOR_IDS": operators,
        "PREFETCH_ENABLED": False,
    })
    app.testing = True
    return app.test_client(), pool_path


def _bearer(sub):
    return {"Authorization": f"Bearer {auth.make_token(sub, SECRET)}"}


# --- the health verdict (bypass auth: local single-user mode) ----------------

def test_never_when_no_heartbeat(tmp_path):
    client, _ = _make_client(tmp_path)
    body = client.get("/api/admin/crawl-status").get_json()
    assert body["health"] == "never"
    assert body["heartbeat"] is None


def test_ok_after_a_clean_run(tmp_path):
    client, _ = _make_client(tmp_path)
    pooldb.write_crawl_status("door", day="07-04", seen=20, ok=18, miss=1, err=1,
                              aborted=False)
    body = client.get("/api/admin/crawl-status").get_json()
    assert body["health"] == "ok"
    assert body["heartbeat"]["day"] == "07-04"
    assert body["heartbeat"]["ok"] == 18
    assert body["age_seconds"] is not None and body["age_seconds"] < 60


def test_throttled_when_aborted(tmp_path):
    client, _ = _make_client(tmp_path)
    pooldb.write_crawl_status("door", day="07-04", seen=9, ok=0, miss=0, err=9,
                              aborted=True, note="throttle abort")
    body = client.get("/api/admin/crawl-status").get_json()
    assert body["health"] == "throttled"


def test_stale_when_old(tmp_path):
    client, pool_path = _make_client(tmp_path)
    # Write a heartbeat directly with a timestamp well past the staleness budget.
    con = sqlite3.connect(pool_path)
    con.execute(pooldb._CRAWL_SCHEMA)
    con.execute(
        "INSERT OR REPLACE INTO crawl_status (id, updated_at, day, seen, ok, "
        "miss, err, aborted, note) VALUES (?,?,?,?,?,?,?,?,?)",
        ("door", "2020-01-01T00:00:00Z", "01-01", 5, 5, 0, 0, 0, None))
    con.commit()
    con.close()
    body = client.get("/api/admin/crawl-status").get_json()
    assert body["health"] == "stale"
    assert body["age_seconds"] > 36 * 3600


# --- the operator gate (enforced auth) ---------------------------------------

def test_gate_allows_operator(tmp_path):
    client, _ = _make_client(tmp_path, secret=SECRET, operators=frozenset({USER_A}))
    r = client.get("/api/admin/crawl-status", headers=_bearer(USER_A))
    assert r.status_code == 200


def test_gate_blocks_non_operator(tmp_path):
    client, _ = _make_client(tmp_path, secret=SECRET, operators=frozenset({USER_A}))
    r = client.get("/api/admin/crawl-status", headers=_bearer(USER_B))
    assert r.status_code == 403


def test_gate_requires_a_token(tmp_path):
    client, _ = _make_client(tmp_path, secret=SECRET, operators=frozenset({USER_A}))
    r = client.get("/api/admin/crawl-status")
    assert r.status_code == 401


# --- the push channel (PUT) --------------------------------------------------

def test_push_then_get_running(tmp_path):
    client, _ = _make_client(tmp_path, push_token=PUSH_TOKEN)
    r = client.put("/api/admin/crawl-status",
                   json={"day": "06-30", "state": "running", "total": 3330,
                         "seen": 1905, "ok": 1700, "miss": 200, "err": 5,
                         "aborted": False},
                   headers={"X-Crawl-Token": PUSH_TOKEN})
    assert r.status_code == 200 and r.get_json()["ok"] is True
    body = client.get("/api/admin/crawl-status").get_json()
    assert body["health"] == "running"
    assert body["heartbeat"]["seen"] == 1905 and body["heartbeat"]["total"] == 3330
    assert body["age_seconds"] is not None and body["age_seconds"] < 60


def test_push_rejected_without_token(tmp_path):
    client, _ = _make_client(tmp_path, push_token=PUSH_TOKEN)
    r = client.put("/api/admin/crawl-status", json={"day": "06-30"})
    assert r.status_code == 403


def test_push_rejected_bad_token(tmp_path):
    client, _ = _make_client(tmp_path, push_token=PUSH_TOKEN)
    r = client.put("/api/admin/crawl-status", json={"day": "06-30"},
                   headers={"X-Crawl-Token": "wrong"})
    assert r.status_code == 403


def test_push_disabled_when_no_token(tmp_path):
    client, _ = _make_client(tmp_path, push_token="")
    r = client.put("/api/admin/crawl-status", json={"day": "06-30"},
                   headers={"X-Crawl-Token": "anything"})
    assert r.status_code == 403


def test_pushed_status_preferred_over_db(tmp_path):
    # A stale DB heartbeat plus a fresh pushed one: GET should serve the pushed one.
    client, _ = _make_client(tmp_path, push_token=PUSH_TOKEN)
    pooldb.write_crawl_status("door", day="01-01", seen=5, ok=5, state="done")
    client.put("/api/admin/crawl-status",
               json={"day": "06-30", "state": "running", "total": 100, "seen": 40,
                     "ok": 38, "miss": 2, "err": 0},
               headers={"X-Crawl-Token": PUSH_TOKEN})
    body = client.get("/api/admin/crawl-status").get_json()
    assert body["heartbeat"]["day"] == "06-30"   # the pushed one, not the DB row
    assert body["health"] == "running"
