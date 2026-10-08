"""The first card (v348): /api/pool/first answers a fresh visit with a few READY records
from a set the server keeps warm, so the first card doesn't wait for the whole day.

Pinned here:
  * the ready test matches the client's (cover + Spotify + YouTube), minus compilations;
  * the set is built once, served from memory while fresh, served STALE while a rebuild
    runs in the background (no reader waits on it), and handed over by the boot warm-up;
  * a saved place leads when it's still today's and on your platforms, from the warm set
    or a one-row lookup — and never when it's another day's or unlistenable;
  * the route ranks held covers first, then other Cover Art Archive covers, then the rest;
  * callers get copies, so marking a cover cached never leaks into the shared set;
  * the share card never carries Apple artwork (option A: Apple art only beside an Apple
    Music link, and a link preview has none).
"""
import datetime
import threading
import time

import pytest

import config
import covercache
import pooldb

CAA = "https://coverartarchive.org/release/{}/front"
APPLE = "https://is1-ssl.mzstatic.com/image/thumb/Music/x/600x600bb.jpg"
IDS = ["64a9ebd7-3984-45a3-ae1f-117152ecbf8e", "50c46e6f-1610-469c-ad1c-e086603a6ef6",
       "2267bf18-ac1b-4452-a0a9-13052750c2c1", "5ddfd3d6-23c1-437e-86c4-4b61791f71ab"]


def rec(uid, *, cover=None, ready=True, comp=False, month=10, day=5, **plat):
    platforms = dict(plat) or ({"spotify": "s", "youtube": "y"} if ready else {"deezer": "d"})
    return {"uid": uid, "cover": cover if cover is not None else CAA.format(IDS[0]),
            "platforms": platforms, "is_compilation": comp,
            "release_month": month, "release_day": day, "listenable": True}


@pytest.fixture(autouse=True)
def _pinned_today(monkeypatch):
    # These tests use Oct 5 as the reader's today. Only today and tomorrow are held in
    # memory, so on the wall clock the build-once test passed on the day it was written
    # and failed from Oct 7 on (every call a rebuild) — CLAUDE.md's wall-clock trap.
    monkeypatch.setattr(config, "today_local", lambda: datetime.date(2026, 10, 5))


@pytest.fixture(autouse=True)
def _fresh_memo():
    for d in (pooldb._day_memo, pooldb._day_building, pooldb._day_cold):
        d.clear()
    yield
    for d in (pooldb._day_memo, pooldb._day_building, pooldb._day_cold):
        d.clear()


def test_ready_means_cover_spotify_youtube_and_not_a_compilation():
    assert pooldb._first_card_ready(rec("a"))
    assert not pooldb._first_card_ready(rec("b", ready=False))
    assert not pooldb._first_card_ready(rec("c", cover=""))
    assert not pooldb._first_card_ready(rec("d", comp=True))
    assert not pooldb._first_card_ready(rec("e", spotify="s"))


def test_the_ready_set_is_built_once_and_served_from_memory(monkeypatch):
    calls = []
    monkeypatch.setattr(pooldb, "pool_day",
                        lambda m, d, **kw: calls.append((m, d)) or [rec("a"), rec("b", ready=False)])
    assert [a["uid"] for a in pooldb.ready_for_day(10, 5)] == ["a"]
    assert [a["uid"] for a in pooldb.ready_for_day(10, 5)] == ["a"]
    assert calls == [(10, 5)]


def test_the_boot_warm_up_hands_over_its_day(monkeypatch):
    monkeypatch.setattr(pooldb, "pool_day", lambda *a, **k: pytest.fail("rebuilt"))
    pooldb.ready_for_day(10, 5, rows=[rec("a"), rec("b", comp=True)])
    assert [a["uid"] for a in pooldb.ready_for_day(10, 5)] == ["a"]


def test_a_stale_set_is_served_while_one_rebuild_runs_behind_it(monkeypatch):
    gate, built = threading.Event(), []

    def slow_day(m, d, **kw):
        gate.wait(5)
        built.append(1)
        return [rec("new")]
    monkeypatch.setattr(pooldb, "pool_day", slow_day)
    pooldb.ready_for_day(10, 5, rows=[rec("old")])
    held = pooldb._day_memo[(10, 5, False)]
    pooldb._day_memo[(10, 5, False)] = (time.monotonic() - pooldb._DAY_TTL - 1,) + held[1:]
    assert [a["uid"] for a in pooldb.ready_for_day(10, 5)] == ["old"]   # no wait
    assert [a["uid"] for a in pooldb.ready_for_day(10, 5)] == ["old"]   # one rebuild only
    gate.set()
    for _ in range(100):
        if pooldb._day_memo[(10, 5, False)][3][0]["uid"] == "new":
            break
        time.sleep(0.02)
    assert [a["uid"] for a in pooldb.ready_for_day(10, 5)] == ["new"] and built == [1]


def test_old_days_drop_out_of_memory():
    for d in range(1, 6):
        pooldb.ready_for_day(10, d, rows=[rec(f"r{d}")])
    assert sorted(pooldb._day_memo) == [(10, 3, False), (10, 4, False), (10, 5, False)]


def test_candidates_are_copies_honour_platforms_and_sample(monkeypatch):
    rows = [rec(f"r{i}") for i in range(10)] + [rec("ap", apple="a", spotify="s", youtube="y")]
    pooldb.ready_for_day(10, 5, rows=rows)
    got = pooldb.first_candidates(10, 5, n=4)
    assert len(got) == 4 and len({a["uid"] for a in got}) == 4
    got[0]["cover_cached"] = True
    assert not any("cover_cached" in a for a in pooldb._day_memo[(10, 5, False)][3])
    assert [a["uid"] for a in pooldb.first_candidates(10, 5, platforms={"apple"}, n=4)] == ["ap"]


def test_your_saved_place_leads_when_it_is_still_todays(monkeypatch):
    pooldb.ready_for_day(10, 5, rows=[rec("r1"), rec("r2")])
    assert pooldb.first_candidates(10, 5, uid="r2", n=1)[0]["uid"] == "r2"
    # Not in the ready set (it needs the door): a one-row lookup finds it.
    lookups = {"slow": rec("slow", ready=False), "other-day": rec("other-day", day=6),
               "gone": dict(rec("gone"), listenable=False)}
    monkeypatch.setattr(pooldb, "albums_by_uids",
                        lambda uids: [lookups[u] for u in uids if u in lookups])
    assert pooldb.first_candidates(10, 5, uid="slow", n=1)[0]["uid"] == "slow"
    for uid in ("other-day", "gone", "unknown"):
        assert pooldb.first_candidates(10, 5, uid=uid, n=1)[0]["uid"] != uid, uid
    # ...and not when it's off your platforms.
    assert pooldb.first_candidates(10, 5, uid="slow", platforms={"spotify"}, n=1)[0]["uid"] != "slow"


@pytest.fixture()
def held(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "POOL_ENABLED", True)
    monkeypatch.setattr(config, "COVER_CACHE_ENABLED", True)
    monkeypatch.setattr(config, "COVER_CACHE_DIR", tmp_path / "covers")
    monkeypatch.setattr(config, "COVER_BLOCKLIST", tmp_path / "blocklist.txt")
    p = tmp_path / "covers" / "release" / f"{IDS[1]}-500.jpg"
    p.parent.mkdir(parents=True)
    p.write_bytes(b"\xff\xd8\xff")
    covercache.cached_keys(fresh=True)


def test_the_route_ranks_held_covers_first_and_keeps_your_place_ahead(client, held):
    pooldb.ready_for_day(10, 5, rows=[
        rec("apple", cover=APPLE), rec("caa", cover=CAA.format(IDS[2])),
        rec("held", cover=CAA.format(IDS[1])), rec("caa2", cover=CAA.format(IDS[3]))])
    for _ in range(5):                       # the sample is random; the ranking isn't
        got = client.get("/api/pool/first?date=10-05").get_json()["albums"]
        assert [a["uid"] for a in got][0] == "held" and got[0]["cover_cached"] is True
        assert [a["uid"] for a in got][-1] == "apple"
    got = client.get("/api/pool/first?date=10-05&uid=apple&n=2").get_json()["albums"]
    assert [a["uid"] for a in got] == ["apple", "held"]


def test_the_route_is_off_without_the_pool(client, monkeypatch):
    monkeypatch.setattr(config, "POOL_ENABLED", False)
    assert client.get("/api/pool/first").status_code == 404


def test_the_share_card_never_carries_apple_art(client):
    import server
    with client.application.test_request_context("/", headers={"Host": "musicforest.lol"}):
        apple = server._record_og_tags({"artist": "X", "title": "Y", "cover": APPLE}, "u")
        caa = server._record_og_tags({"artist": "X", "title": "Y",
                                      "cover": CAA.format(IDS[0])}, "u")
    assert "mzstatic" not in apple and "icon-512.png" in apple
    assert CAA.format(IDS[0]) in caa
