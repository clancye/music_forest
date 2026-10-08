"""The operator console's Log (owner, 2026-10-07): one row per LOCAL day.

Pins: counts land on the reader's local day (an 11pm-Eastern tap belongs to that
Eastern day, not the next UTC one); days older than the hourly table fall back to
the UTC day table and say so (`approx`); the three new coarse flags — the kind of
open, where a Listen link came from, a search's tier — are counted from an
allowlist and never from free input; and a Log event query that fails is named, never
read as a quiet day. The console endpoint itself (/api/admin/log) is pinned in
test_admin_log.py — kept apart because the operator console stays out of the public mirror.
"""
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import config  # noqa: E402

TZ = "America/New_York"


def test_hours_land_on_the_local_day(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "OPS_DB_PATH", str(tmp_path / "ops.sqlite"))
    import opsdb
    now = datetime(2026, 10, 8, 15, 0, tzinfo=timezone.utc)          # 11am Eastern, Oct 8
    # Hourly records begin a few days earlier (the first, partial day is never trusted).
    opsdb.bump("door_open", now=datetime(2026, 10, 4, 12, 0, tzinfo=timezone.utc))
    opsdb.bump("today_served", now=datetime(2026, 10, 8, 3, 30, tzinfo=timezone.utc))   # 11:30pm Oct 7 ET
    opsdb.bump("today_served", now=datetime(2026, 10, 8, 13, 0, tzinfo=timezone.utc))   # 9am Oct 8 ET
    r = opsdb.usage_by_local_day(3, TZ, now=now)
    assert list(r["days"]) == ["2026-10-06", "2026-10-07", "2026-10-08"]
    assert r["days"]["2026-10-07"] == {"today_served": 1}
    assert r["days"]["2026-10-08"] == {"today_served": 1}
    assert r["approx"] == []


def test_days_before_the_hourly_table_fall_back_and_say_so(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "OPS_DB_PATH", str(tmp_path / "ops.sqlite"))
    import opsdb
    import sqlite3
    now = datetime(2026, 10, 8, 15, 0, tzinfo=timezone.utc)
    opsdb.bump("today_served", now=now)                               # hourly starts today
    con = sqlite3.connect(config.OPS_DB_PATH)
    con.execute("INSERT INTO usage_counter (day, key, n) VALUES ('2026-10-05', 'today_served', 7)")
    con.commit()
    con.close()
    r = opsdb.usage_by_local_day(5, TZ, now=now)
    assert r["days"]["2026-10-05"] == {"today_served": 7}
    assert "2026-10-05" in r["approx"]
    assert r["days"]["2026-10-08"] == {"today_served": 1}


def test_local_days_never_raise(monkeypatch):
    monkeypatch.setattr(config, "OPS_DB_PATH", "/nonexistent-dir/ops.sqlite")
    import opsdb
    r = opsdb.usage_by_local_day(3, TZ)
    assert len(r["days"]) == 3 and all(v == {} for v in r["days"].values())


def test_listen_source_is_counted_from_an_allowlist(client, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "OPS_DB_PATH", str(tmp_path / "ops.sqlite"))
    import opsdb
    client.post("/api/usage/listen?svc=spotify&tier=guest&src=warm")
    client.post("/api/usage/listen?svc=apple&tier=account&src=other")
    client.post("/api/usage/listen?svc=apple&tier=account&src=%3Bdrop")
    keys = opsdb.usage_in_range(0)
    assert keys.get("listen_src_warm") == 1 and keys.get("listen_src_other") == 1
    assert not any(k.startswith("listen_src_") and k not in ("listen_src_warm", "listen_src_other")
                   for k in keys)


def test_searches_carry_the_tier(client, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "OPS_DB_PATH", str(tmp_path / "ops.sqlite"))
    import opsdb
    client.get("/api/search?q=love", headers={"X-MF-Mode": "guest"})
    client.get("/api/search?q=love", headers={"X-MF-Mode": "account"})
    client.get("/api/search?q=love", headers={"X-MF-Mode": "alien"})
    keys = opsdb.usage_in_range(0)
    assert keys.get("explore_search") == 3
    assert keys.get("explore_search_guest") == 1 and keys.get("explore_search_account") == 1


def test_open_kind_is_counted(client, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "OPS_DB_PATH", str(tmp_path / "ops.sqlite"))
    monkeypatch.setattr(config, "POOL_ENABLED", True)
    import covercache
    import opsdb
    import pooldb
    monkeypatch.setattr(pooldb, "day_in_window", lambda m, d: False)
    monkeypatch.setattr(pooldb, "pool_day", lambda *a, **k: [])
    monkeypatch.setattr(pooldb, "spotify_trouble", lambda **k: None)
    monkeypatch.setattr(covercache, "annotate", lambda a: a)
    client.get("/api/pool/day", headers={"X-MF-Mode": "guest", "X-MF-Open": "first"})
    client.get("/api/pool/day", headers={"X-MF-Mode": "guest", "X-MF-Open": "again"})
    client.get("/api/pool/day", headers={"X-MF-Mode": "account", "X-MF-Open": "platforms"})
    client.get("/api/pool/day", headers={"X-MF-Mode": "account", "X-MF-Open": "sneaky"})
    keys = opsdb.usage_in_range(0)
    assert keys.get("open_first_guest") == 1 and keys.get("open_again_guest") == 1
    assert keys.get("open_platforms_account") == 1
    assert not any("sneaky" in k for k in keys)
    assert keys.get("today_served") == 4


class _FakeCursor:
    """Stands in for a psycopg cursor: answers by which table the SQL reads, and raises
    where the test says a part is broken — no Postgres needed to pin the guard."""
    def __init__(self, answers, broken):
        self.answers, self.broken, self.rows = answers, broken, []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, args):
        for needle, msg in self.broken.items():
            if needle in sql:
                raise RuntimeError(msg + "\nLINE 1: SELECT ...\n       ^")
        self.rows = next(v for k, v in self.answers.items() if k in sql)

    def fetchall(self):
        return self.rows


def test_a_broken_event_query_is_named_never_a_quiet_day(monkeypatch):
    import store
    pg = store.PostgresStore("postgresql://unused")
    answers = {"journal_rows": [("2026-10-07", 3, 2)],
               "access_requests": [("2026-10-07", "a@example.com")],
               "feedback": [("2026-10-07", 41, True)]}
    # A pre-0008 store has no journal_rows.created_at (the updated_at retry is expected
    # and stays quiet); auth.users is the part that really broke.
    broken = {"kind IN ('note','opened') AND created_at": "column \"created_at\" does not exist",
              "auth.users": "permission denied for schema auth"}
    monkeypatch.setattr(pg, "_cursor", lambda: _FakeCursor(answers, broken))
    days, errors = pg.log_events(7, TZ)
    assert errors == ["joined: permission denied for schema auth"]
    d = days["2026-10-07"]
    assert (d["notes"], d["opened"], d["joined"]) == (3, 2, 0)
    assert d["asked"] == ["a@example.com"] and d["feedback"] == [{"id": 41, "guest": True}]
