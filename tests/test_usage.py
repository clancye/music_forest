"""Tests for the /admin Usage panel's data sources (all anonymized, counts only).

Covers the opsdb feature counters and the sync store's metadata aggregates —
the pieces that feed /api/admin/usage. No auth.users here (that's hosted
Postgres only), so account_activity is asserted to report unavailable on SQLite.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import config  # noqa: E402


def test_opsdb_usage_counters(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "OPS_DB_PATH", str(tmp_path / "ops.sqlite"))
    import opsdb
    opsdb.bump("today_served")
    opsdb.bump("today_served")
    opsdb.bump("explore_search")
    opsdb.bump("door_open", delta=3)
    totals = {}
    for r in opsdb.usage_recent(30):
        totals[r["key"]] = totals.get(r["key"], 0) + r["n"]
    assert totals == {"today_served": 2, "explore_search": 1, "door_open": 3}


def test_opsdb_bump_never_raises(tmp_path, monkeypatch):
    # A counter must never break the request it's counting: an unwritable path degrades
    # to a no-op, not an exception.
    monkeypatch.setattr(config, "OPS_DB_PATH", "/nonexistent-dir/ops.sqlite")
    import opsdb
    opsdb.bump("today_served")           # must not raise
    assert opsdb.usage_recent(7) == []


def test_content_stats_counts_by_kind_only(tmp_path):
    import store
    st = store.SQLiteStore(tmp_path / "sync.db")
    st.upsert_rows("u1", [
        {"kind": "choice", "client_id": "c1", "ciphertext": b"x", "nonce": b"n"},
        {"kind": "choice", "client_id": "c2", "ciphertext": b"x", "nonce": b"n"},
        {"kind": "pick", "client_id": "p1", "ciphertext": b"x", "nonce": b"n"},  # legacy keep
        {"kind": "note", "client_id": "n1", "ciphertext": b"x", "nonce": b"n"},
        {"kind": "note", "client_id": "n2", "ciphertext": b"x", "nonce": b"n"},
    ])
    st.upsert_rows("u1", [{"kind": "note", "client_id": "n2", "deleted": True}])
    # keeps = choice + legacy pick, live only; the deleted note is excluded.
    assert st.content_stats() == {"keeps": 3, "notes": 1}


def test_account_activity_hosted_only_on_sqlite(tmp_path):
    import store
    st = store.SQLiteStore(tmp_path / "sync.db")
    assert st.account_activity() == {"available": False}


def test_listen_beacon_counts_service_and_tier(client, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "OPS_DB_PATH", str(tmp_path / "ops.sqlite"))
    import opsdb
    assert client.post("/api/usage/listen?svc=spotify&tier=guest").status_code == 204
    assert client.post("/api/usage/listen?svc=SPOTIFY&tier=account").status_code == 204
    # A junk service folds into "other" (never a counter key minted from input);
    # a junk tier is simply not counted. The beacon still answers 204.
    assert client.post("/api/usage/listen?svc=%3BDROP&tier=alien").status_code == 204
    assert client.post("/api/usage/listen").status_code == 204
    totals = {}
    for r in opsdb.usage_recent(7):
        totals[r["key"]] = totals.get(r["key"], 0) + r["n"]
    assert totals == {
        "listen_click": 4,
        "listen_svc_spotify": 2,
        "listen_svc_other": 2,
        "listen_guest": 1,
        "listen_account": 1,
    }


def test_opsdb_usage_totals_all_time(tmp_path, monkeypatch):
    from datetime import datetime, timezone, timedelta
    monkeypatch.setattr(config, "OPS_DB_PATH", str(tmp_path / "ops.sqlite"))
    import opsdb
    old = datetime.now(timezone.utc) - timedelta(days=45)
    opsdb.bump("listen_click", now=old)          # before every day window
    opsdb.bump("listen_click", delta=2)
    t = opsdb.usage_totals()
    assert t["keys"]["listen_click"] == 3
    assert t["since"] == old.strftime("%Y-%m-%d")
    recent = sum(r["n"] for r in opsdb.usage_recent(30) if r["key"] == "listen_click")
    assert recent == 2


def test_content_series_dates_by_creation_not_edit(tmp_path, monkeypatch):
    from datetime import datetime, timezone, timedelta
    import store
    st = store.SQLiteStore(tmp_path / "sync.db")
    old = (datetime.now(timezone.utc) - timedelta(days=10)
           ).isoformat(timespec="microseconds")
    fake = {"v": old}
    monkeypatch.setattr(store, "_now", lambda: fake["v"])
    st.upsert_rows("u1", [
        {"kind": "note", "client_id": "n1", "ciphertext": b"x", "nonce": b"n"},
        {"kind": "choice", "client_id": "c1", "ciphertext": b"x", "nonce": b"n"},
    ])
    # Edit the note today: updated_at moves, created_at must not — the whole
    # point of 0008 is that an edit never resurfaces as a new entry.
    fake["v"] = datetime.now(timezone.utc).isoformat(timespec="microseconds")
    st.upsert_rows("u1", [
        {"kind": "note", "client_id": "n1", "ciphertext": b"y", "nonce": b"n"},
    ])
    s = st.content_series(7)
    assert s["available"] is True
    assert s["by_day"] == []                       # nothing NEW inside 7 days
    assert s["baseline"] == {"keeps": 1, "notes": 1}
    wide = st.content_series(30)
    assert wide["by_day"] == [{"day": old[:10], "keeps": 1, "notes": 1}]
    assert wide["baseline"] == {"keeps": 0, "notes": 0}


def test_content_series_falls_back_to_updated_at_for_old_rows(tmp_path):
    # A row from before the created_at column (NULL) dates by updated_at.
    import store
    st = store.SQLiteStore(tmp_path / "sync.db")
    with st._conn() as c:
        c.execute(
            "INSERT INTO journal_rows (user_id, kind, client_id, ciphertext, "
            "nonce, created_at, updated_at) VALUES ('u1','note','n0',x'00',x'00',"
            "NULL, ?)", (store._now(),))
        c.commit()
    s = st.content_series(7)
    assert s["baseline"] == {"keeps": 0, "notes": 0}
    assert sum(d["notes"] for d in s["by_day"]) == 1


def test_access_request_counts_by_status(tmp_path):
    import store
    st = store.SQLiteStore(tmp_path / "sync.db")
    st.add_access_request("a@example.com")
    st.add_access_request("b@example.com")
    st.add_access_request("c@example.com")
    with st._conn() as c:
        c.execute("UPDATE access_requests SET status='invited' "
                  "WHERE email='b@example.com'")
        c.commit()
    assert st.access_request_counts() == {"new": 2, "invited": 1, "declined": 0}


def test_admin_usage_payload_has_new_blocks(client, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "OPS_DB_PATH", str(tmp_path / "ops.sqlite"))
    import opsdb
    opsdb.bump("listen_click")
    r = client.get("/api/admin/usage")
    assert r.status_code == 200
    data = r.get_json()
    assert data["features"]["totals_all"]["listen_click"] == 1
    assert data["features"]["since"]
    assert data["content_series"]["available"] is True
    assert data["requests"] == {"new": 0, "invited": 0, "declined": 0}
