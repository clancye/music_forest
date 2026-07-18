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
