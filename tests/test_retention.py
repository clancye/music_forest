"""The data-retention sweep (Privacy Policy §6).

server._start_retention_sweep is the glue that makes the policy's stated
windows real without operator memory: a daily daemon thread pruning handled/
stale access requests (store.py) and old on-disk feedback (feedback.py).
The thread body is tested synchronously here so nothing depends on timing;
the latch test fakes threading.Thread so no real thread starts.
"""
import json
import sqlite3
from datetime import datetime, timedelta, timezone

import config
import feedback
import server
import store


def _iso_days_ago(days):
    return (datetime.now(timezone.utc)
            - timedelta(days=days)).isoformat(timespec="microseconds")


def _point_at(tmp_path):
    config.SYNC_DB_PATH = tmp_path / "sync.db"
    config.SUPABASE_DB_URL = ""
    config.FEEDBACK_DIR = tmp_path / "feedback"
    store.reset_store()
    return store.get_store()


def test_sweep_once_prunes_both_stores(tmp_path):
    st = _point_at(tmp_path)
    st.add_access_request("handled-long-ago@example.com")
    c = sqlite3.connect(config.SYNC_DB_PATH)
    c.execute("UPDATE access_requests SET status='invited', updated_at=?",
              (_iso_days_ago(200),))
    c.commit()
    c.close()
    old = feedback.save(message="stale feedback")
    p = config.FEEDBACK_DIR / old["id"] / "entry.json"
    rec = json.loads(p.read_text(encoding="utf-8"))
    rec["created_at"] = _iso_days_ago(200)
    p.write_text(json.dumps(rec), encoding="utf-8")

    server._retention_sweep_once(st, handled_days=180, max_days=365,
                                 feedback_days=180)
    assert st.list_access_requests() == []
    assert feedback.list_entries() == []


def test_sweep_once_swallows_a_store_failure(tmp_path):
    """A dead database must not stop the disk prune (or raise into the app)."""
    _point_at(tmp_path)
    old = feedback.save(message="stale despite db outage")
    p = config.FEEDBACK_DIR / old["id"] / "entry.json"
    rec = json.loads(p.read_text(encoding="utf-8"))
    rec["created_at"] = _iso_days_ago(200)
    p.write_text(json.dumps(rec), encoding="utf-8")

    class BoomStore:
        def prune_access_requests(self, handled_days, max_days):
            raise RuntimeError("db down")

    server._retention_sweep_once(BoomStore(), 180, 365, 180)
    assert feedback.list_entries() == []


def test_start_latch_is_per_target_and_gated(tmp_path, monkeypatch):
    started = []

    class FakeThread:
        def __init__(self, **kw):
            self.kw = kw

        def start(self):
            started.append(self.kw.get("name"))

    monkeypatch.setattr(server.threading, "Thread", FakeThread)

    _point_at(tmp_path / "one")
    config.RETENTION_SWEEP = True
    server._start_retention_sweep()
    server._start_retention_sweep()          # same target: latched
    assert started == ["retention-sweep"]

    _point_at(tmp_path / "two")              # new target: a new thread
    server._start_retention_sweep()
    assert started == ["retention-sweep"] * 2

    _point_at(tmp_path / "three")
    config.RETENTION_SWEEP = False           # gate off: nothing starts
    server._start_retention_sweep()
    assert started == ["retention-sweep"] * 2
    config.RETENTION_SWEEP = True
