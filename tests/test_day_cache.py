"""The day, held in memory (2026-10-05, server-only): /api/pool/day serves today and
tomorrow from a copy each process keeps, instead of rebuilding ~3,000 enriched records
(~1.1 s on Render, ~20 s cold) for every reader.

Pinned here — the owner's terms (2026-10-05):
  * only today and tomorrow (config.today_local), never another date — dig included,
    as its own copy beside the day (it's ~5,300 records read off a cold disk: 10 s on
    prod, 24-30 s on staging, per request, before it was held);
  * built once; every caller gets copies, so per-request stamps never leak into it;
  * the platform filter is applied per request and matches what pool_day would build;
  * rebuilt when 10 minutes old OR when the Mac pushes new pool files (a whole-file
    swap = a new inode), but NOT on the server's own writes (same inode);
  * a reader never waits on a rebuild (the held copy is served meanwhile), and a cold
    start builds once even when several readers arrive together;
  * /api/pool/first draws from the same held day.
"""
import os
import threading
import time
from datetime import date

import pytest

import config
import pooldb

CAA = "https://coverartarchive.org/release/64a9ebd7-3984-45a3-ae1f-117152ecbf8e/front"


def rec(uid, **plat):
    return {"uid": uid, "cover": CAA,
            "platforms": dict(plat) or {"spotify": "s", "youtube": "y"},
            "is_compilation": False, "release_month": 10, "release_day": 5,
            "listenable": True}


@pytest.fixture(autouse=True)
def _clean(tmp_path, monkeypatch):
    for d in (pooldb._day_memo, pooldb._day_building, pooldb._day_cold):
        d.clear()
    monkeypatch.setattr(config, "today_local", lambda: date(2026, 10, 5))
    for name in pooldb._DAY_FILES:                    # stand-in pool files
        p = tmp_path / f"{name}.sqlite"
        p.write_bytes(b"v1")
        monkeypatch.setattr(config, name, p)
    yield
    for d in (pooldb._day_memo, pooldb._day_building, pooldb._day_cold):
        d.clear()


class Builder:
    """A stand-in pool_day that counts builds (optionally slow, optionally gated)."""

    def __init__(self, rows, gate=None):
        self.rows, self.gate, self.calls = rows, gate, 0
        self.lock = threading.Lock()

    def __call__(self, month, day, **kw):
        with self.lock:
            self.calls += 1
        if self.gate:
            self.gate.wait(5)
        rows = self.rows() if callable(self.rows) else self.rows
        return [dict(a) for a in rows]


def wait_for(cond):
    for _ in range(200):
        if cond():
            return True
        time.sleep(0.01)
    return False


def test_only_today_and_tomorrow_are_held():
    assert pooldb.day_in_window(10, 5) and pooldb.day_in_window(10, 6)
    assert not pooldb.day_in_window(10, 4) and not pooldb.day_in_window(10, 7)


def test_built_once_served_as_copies_and_filtered_per_request(monkeypatch):
    b = Builder([rec("a"), rec("b", deezer="d"), rec("c", apple="a", spotify="s")])
    monkeypatch.setattr(pooldb, "pool_day", b)
    first = pooldb.held_day(10, 5)
    first[0]["cover_cached"] = True                 # a per-request stamp
    again = pooldb.held_day(10, 5)
    assert b.calls == 1 and "cover_cached" not in again[0]
    assert [a["uid"] for a in pooldb.held_day(10, 5, platforms={"spotify"})] == ["a", "c"]
    assert [a["uid"] for a in pooldb.held_day(10, 5, platforms={"deezer"})] == ["b"]
    assert b.calls == 1


def test_a_ten_minute_old_day_is_served_while_it_rebuilds(monkeypatch):
    gate = threading.Event()
    version = {"v": "old"}
    b = Builder(lambda: [rec(version["v"])], gate=gate)
    monkeypatch.setattr(pooldb, "pool_day", b)
    gate.set()
    assert pooldb.held_day(10, 5)[0]["uid"] == "old"
    gate.clear()
    version["v"] = "new"
    held = pooldb._day_memo[(10, 5, False)]
    pooldb._day_memo[(10, 5, False)] = (time.monotonic() - pooldb._DAY_TTL - 1,) + held[1:]
    assert pooldb.held_day(10, 5)[0]["uid"] == "old"      # no waiting
    assert pooldb.held_day(10, 5)[0]["uid"] == "old"      # and only one rebuild
    gate.set()
    assert wait_for(lambda: pooldb._day_memo[(10, 5, False)][2][0]["uid"] == "new")
    assert b.calls == 2 and pooldb.held_day(10, 5)[0]["uid"] == "new"


def test_a_push_from_the_mac_rebuilds_but_the_servers_own_writes_dont(monkeypatch):
    version = {"v": "old"}
    b = Builder(lambda: [rec(version["v"])])
    monkeypatch.setattr(pooldb, "pool_day", b)
    pooldb.held_day(10, 5)
    # The server writes into live.sqlite in place (a reader's link lookup): same inode.
    with open(config.LIVE_DB_PATH, "ab") as f:
        f.write(b" door")
    assert pooldb.held_day(10, 5)[0]["uid"] == "old" and b.calls == 1
    # rsync_pool.sh lands a new pool.sqlite: written beside it, renamed over it.
    version["v"] = "pushed"
    tmp = str(config.POOL_DB_PATH) + ".tmp"
    with open(tmp, "wb") as f:
        f.write(b"v2")
    os.replace(tmp, config.POOL_DB_PATH)
    assert pooldb.held_day(10, 5)[0]["uid"] == "old"      # served while it rebuilds
    assert wait_for(lambda: pooldb._day_memo[(10, 5, False)][2][0]["uid"] == "pushed")
    assert b.calls == 2


def test_a_cold_start_builds_once_for_everyone_waiting(monkeypatch):
    gate = threading.Event()
    b = Builder([rec("a")], gate=gate)
    monkeypatch.setattr(pooldb, "pool_day", b)
    got = []
    readers = [threading.Thread(target=lambda: got.append(pooldb.held_day(10, 5)))
               for _ in range(4)]
    for t in readers:
        t.start()
    time.sleep(0.05)
    gate.set()
    for t in readers:
        t.join(5)
    assert len(got) == 4 and b.calls == 1


def test_a_failed_rebuild_keeps_serving_the_held_day(monkeypatch):
    monkeypatch.setattr(pooldb, "pool_day", Builder([rec("a")]))
    pooldb.held_day(10, 5)

    def broken(*a, **k):
        raise RuntimeError("pool mid-swap")
    monkeypatch.setattr(pooldb, "pool_day", broken)
    held = pooldb._day_memo[(10, 5, False)]
    pooldb._day_memo[(10, 5, False)] = (time.monotonic() - pooldb._DAY_TTL - 1,) + held[1:]
    assert pooldb.held_day(10, 5)[0]["uid"] == "a"
    assert wait_for(lambda: (10, 5, False) not in pooldb._day_building)
    assert pooldb.held_day(10, 5)[0]["uid"] == "a"


# --- the route -------------------------------------------------------------------

@pytest.fixture()
def pool_on(monkeypatch):
    monkeypatch.setattr(config, "POOL_ENABLED", True)
    b = Builder([rec("a"), rec("b", deezer="d")])
    monkeypatch.setattr(pooldb, "pool_day", b)
    return b


def test_the_route_serves_today_and_tomorrow_from_the_held_day(client, pool_on):
    r1 = client.get("/api/pool/day?date=10-05")
    r2 = client.get("/api/pool/day?date=10-05&platforms=deezer")
    assert pool_on.calls == 1
    assert [a["uid"] for a in r2.get_json()["albums"]] == ["b"]
    assert r2.get_json()["filtered"] is True
    assert int(r1.headers["X-MF-Day-Age"]) >= 0
    client.get("/api/pool/day?date=10-06")
    assert pool_on.calls == 2                       # tomorrow is held too (its own build)
    client.get("/api/pool/day?date=10-06")
    assert pool_on.calls == 2


def test_other_dates_are_built_per_request_dig_or_not(client, pool_on):
    for _ in range(2):
        client.get("/api/pool/day?date=12-25&dig=1")
        r = client.get("/api/pool/day?date=12-25")
    assert pool_on.calls == 4 and "X-MF-Day-Age" not in r.headers
    assert not pooldb._day_memo


class DigBuilder(Builder):
    """pool_day that answers dig (available_only=False) with the full union."""

    def __init__(self):
        super().__init__(None)
        self.asked = []

    def __call__(self, month, day, *, available_only=True, **kw):
        self.asked.append(available_only)
        rows = [rec("a")] if available_only else [rec("a"), rec("z", deezer="d")]
        return [dict(a) for a in rows]


def test_dig_is_held_as_its_own_copy_beside_the_day(monkeypatch):
    b = DigBuilder()
    monkeypatch.setattr(pooldb, "pool_day", b)
    assert [a["uid"] for a in pooldb.held_day(10, 5)] == ["a"]
    dig = pooldb.held_day(10, 5, dig=True)
    assert [a["uid"] for a in dig] == ["a", "z"]
    dig[0]["cover_cached"] = True                   # a per-request stamp
    assert "cover_cached" not in pooldb.held_day(10, 5, dig=True)[0]
    pooldb.held_day(10, 6, dig=True)
    assert b.asked == [True, False, False]          # one build each, dig asked as dig
    assert pooldb._day_memo[(10, 5, True)][3] == []   # a first card never comes from dig
    assert [a["uid"] for a in pooldb.ready_for_day(10, 5)] == ["a"]


def test_dig_days_and_days_drop_out_of_memory_separately():
    for d in range(1, 6):
        pooldb.ready_for_day(10, d, rows=[rec(f"r{d}")])
    for d in range(1, 5):
        pooldb._held(10, d, rows=[rec(f"z{d}")], dig=True)
    assert sorted(pooldb._day_memo) == [(10, 2, True), (10, 3, False), (10, 3, True),
                                        (10, 4, False), (10, 4, True), (10, 5, False)]


def test_the_route_serves_dig_from_its_held_copy(client, monkeypatch):
    monkeypatch.setattr(config, "POOL_ENABLED", True)
    b = DigBuilder()
    monkeypatch.setattr(pooldb, "pool_day", b)
    r1 = client.get("/api/pool/day?date=10-05&dig=1&platforms=spotify")
    r2 = client.get("/api/pool/day?date=10-05&dig=1")
    assert b.asked == [False]
    assert [a["uid"] for a in r1.get_json()["albums"]] == ["a", "z"]   # dig: unfiltered
    assert r1.get_json()["dig"] is True and r2.get_json()["count"] == 2
    assert int(r2.headers["X-MF-Day-Age"]) >= 0
    assert [a["uid"] for a in client.get("/api/pool/day?date=10-05").get_json()["albums"]] \
        == ["a"] and b.asked == [False, True]


def test_a_first_card_for_another_date_is_built_but_not_held(client, pool_on):
    client.get("/api/pool/first?date=12-25")
    client.get("/api/pool/first?date=12-25")
    assert pool_on.calls == 2 and (12, 25, False) not in pooldb._day_memo


def test_the_first_card_draws_from_the_same_held_day(client, pool_on):
    client.get("/api/pool/day?date=10-05")
    got = client.get("/api/pool/first?date=10-05").get_json()["albums"]
    assert [a["uid"] for a in got] == ["a"] and pool_on.calls == 1
