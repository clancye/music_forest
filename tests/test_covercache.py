"""The cover cache (covercache.py): today's and tomorrow's Cover Art Archive thumbnails
held on the host so the first card doesn't wait on the archive's redirects.

What's pinned here is the arrangement it was approved under (owner, 2026-10-05), not
just the plumbing:
  * CAA only — the key parser refuses every other address, and the fetch is pinned to
    the archive's own hosts;
  * a rolling window — re-fetched once a cycle old, deleted when the archive answers
    404/410, swept when it leaves today+tomorrow, and never swept on an UNKNOWN window
    (a pool mid-re-seed reading empty must not mean "delete everything");
  * a takedown blocklist by MusicBrainz id — never fetched, 404 at once, withheld from
    the served day, the door, art-ensure and the share card;
  * disk guards — a size cap and a free-space floor stop the pass, never fill the disk.
"""
import json
import os
import subprocess
import sys
import time
from datetime import date
from pathlib import Path

import pytest
import requests

import config
import covercache

ROOT = Path(__file__).resolve().parent.parent
A = "64a9ebd7-3984-45a3-ae1f-117152ecbf8e"
B = "50c46e6f-1610-469c-ad1c-e086603a6ef6"
C = "2267bf18-ac1b-4452-a0a9-13052750c2c1"
D = "5ddfd3d6-23c1-437e-86c4-4b61791f71ab"
E = "26978137-f69f-4ad7-a1b1-42af5bd1932c"
JPEG = b"\xff\xd8\xff\xe0" + b"x" * 100


def caa(mbid, kind="release"):
    return f"https://coverartarchive.org/{kind}/{mbid}/front"


def rec(mbid, ready=False, kind="release"):
    plat = {"spotify": "s", "youtube": "y"} if ready else {"deezer": "d"}
    return {"uid": "m:" + mbid, "cover": caa(mbid, kind), "platforms": plat}


@pytest.fixture()
def cache(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "COVER_CACHE_ENABLED", True)
    monkeypatch.setattr(config, "COVER_CACHE_DIR", tmp_path / "covers")
    monkeypatch.setattr(config, "COVER_BLOCKLIST", tmp_path / "cover_blocklist.txt")
    monkeypatch.setattr(config, "COVER_CACHE_MAX_MB", 600)
    monkeypatch.setattr(config, "COVER_CACHE_MIN_FREE_MB", 0)
    monkeypatch.setattr(config, "COVER_CACHE_MAX_AGE_H", 24)
    monkeypatch.setattr(config, "COVER_CACHE_DELAY", 0)
    covercache.cached_keys(fresh=True)
    return tmp_path / "covers"


def put(cache, mbid, kind="release", age_h=0.0, body=JPEG):
    p = cache / kind / f"{mbid}-500.jpg"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(body)
    t = time.time() - age_h * 3600
    os.utime(p, (t, t))
    return p


def block(mbid_line):
    with open(config.COVER_BLOCKLIST, "a") as f:
        f.write(mbid_line + "\n")


# --- the key: CAA front images, nothing else ------------------------------------

def test_caa_key_reads_only_archive_front_images():
    assert covercache.caa_key(caa(A)) == ("release", A)
    assert covercache.caa_key(caa(A, "release-group") + "-1200") == ("release-group", A)
    assert covercache.caa_key(caa(A.upper())) == ("release", A)
    for other in (None, "", "/static/art/1.jpg", "https://i.discogs.com/x.jpg",
                  "https://is1-ssl.mzstatic.com/image/thumb/x/600x600bb.jpg",
                  f"https://coverartarchive.org/release/{A}/12345.jpg",
                  f"https://coverartarchive.org.evil.example/release/{A}/front"):
        assert covercache.caa_key(other) is None, other


def test_cover_cache_is_on_exactly_in_hotlink_mode_unless_told():
    def flag(**env):
        e = {k: v for k, v in os.environ.items() if not k.startswith("AOTD_")}
        e.update(env)
        out = subprocess.run([sys.executable, "-c",
                              "import config; print(config.COVER_CACHE_ENABLED)"],
                             cwd=ROOT, env=e, capture_output=True, text=True, check=True)
        return out.stdout.strip()
    assert flag(AOTD_CACHE_ART_BYTES="0") == "True"      # the hosted app
    assert flag(AOTD_CACHE_ART_BYTES="1") == "False"     # a local run
    assert flag(AOTD_CACHE_ART_BYTES="0", AOTD_COVER_CACHE="0") == "False"
    assert flag(AOTD_CACHE_ART_BYTES="1", AOTD_COVER_CACHE="1") == "True"


# --- the blocklist ---------------------------------------------------------------

def test_blocklist_reads_ids_notes_and_pasted_addresses(cache):
    assert covercache.blocked() == frozenset()
    block(f"{A}   # DMCA notice 2026-10-05")
    block(f"https://musicbrainz.org/release/{B.upper()}")
    block(f"# {C} is only mentioned in a note")
    assert covercache.blocked() == {A, B}
    block(D)
    assert covercache.blocked() == {A, B, D}          # re-read when the file changes


def test_annotate_marks_held_covers_and_withholds_blocked_ones(cache):
    put(cache, A)
    put(cache, B, "release-group")
    block(C)
    covercache.cached_keys(fresh=True)
    albums = [rec(A), rec(B, kind="release-group"), rec(C), rec(D),
              {"uid": "d:1", "cover": "https://is1-ssl.mzstatic.com/a.jpg"}, {"uid": "d:2"}]
    out = covercache.annotate(albums)
    assert out is albums
    assert out[0]["cover_cached"] is True and out[1]["cover_cached"] is True
    assert out[2]["cover"] is None and "cover_cached" not in out[2]
    assert "cover_cached" not in out[3] and out[3]["cover"] == caa(D)
    assert "cover_cached" not in out[4] and "cover_cached" not in out[5]


def test_annotate_with_the_cache_off_still_honours_a_takedown(cache, monkeypatch):
    monkeypatch.setattr(config, "COVER_CACHE_ENABLED", False)
    put(cache, A)
    block(B)
    covercache.cached_keys(fresh=True)
    out = covercache.annotate([rec(A), rec(B)])
    assert "cover_cached" not in out[0]
    assert out[1]["cover"] is None


def test_serve_path_refuses_anything_it_should_not_serve(cache, monkeypatch):
    p = put(cache, A)
    put(cache, B)
    block(B)
    assert covercache.serve_path("release", f"{A}-500.jpg") == p
    assert covercache.serve_path("release", f"{B}-500.jpg") is None        # blocked
    assert covercache.serve_path("release", f"{C}-500.jpg") is None        # not held
    assert covercache.serve_path("release-group", f"{A}-500.jpg") is None  # wrong kind dir
    assert covercache.serve_path("art", f"{A}-500.jpg") is None
    assert covercache.serve_path("release", f"../{A}-500.jpg") is None
    assert covercache.serve_path("release", f"{A}-1200.jpg") is None
    monkeypatch.setattr(config, "COVER_CACHE_ENABLED", False)
    assert covercache.serve_path("release", f"{A}-500.jpg") is None        # off means off


# --- the warm pass ---------------------------------------------------------------

class Archive:
    """A stand-in for CAA: records what was asked, answers per mbid."""

    def __init__(self, answers=None):
        self.asked, self.answers = [], answers or {}

    def __call__(self, url):
        mbid = url.split("/")[-2]
        self.asked.append(mbid)
        a = self.answers.get(mbid, JPEG)
        if isinstance(a, int):
            r = requests.Response()
            r.status_code = a
            raise requests.HTTPError(response=r)
        if isinstance(a, Exception):
            raise a
        return a


def run(days, archive, **kw):
    """warm_once with today = Oct 5; `days` maps "MM-DD" -> rows."""
    def rows_for(m, d):
        v = days.get(f"{m:02d}-{d:02d}")
        if isinstance(v, Exception):
            raise v
        return v or []
    return covercache.warm_once(today=date(2026, 10, 5), rows_for=rows_for,
                                fetch=archive, sleep=lambda s: None, **kw)


def test_warm_fetches_ready_records_first_then_the_rest(cache):
    arc = Archive()
    st = run({"10-05": [rec(A), rec(B, ready=True)],
              "10-06": [rec(C), rec(D, ready=True), rec(B, ready=True)]}, arc)
    assert arc.asked == [B, D, A, C]       # ready today, ready tomorrow, rest, rest
    assert st["fetched"] == 4 and st["wanted"] == 4 and st["files"] == 4
    assert (cache / "release" / f"{B}-500.jpg").read_bytes() == JPEG
    assert json.loads((cache / "status.json").read_text())["fetched"] == 4
    assert covercache.cached_keys() == {("release", m) for m in (A, B, C, D)}


def test_warm_keeps_fresh_copies_and_refetches_a_cycle_old_one(cache):
    put(cache, A, age_h=2)
    old = put(cache, B, age_h=25, body=b"\xff\xd8\xff old")
    arc = Archive()
    st = run({"10-05": [rec(A), rec(B)], "10-06": [rec(C)]}, arc)
    assert arc.asked == [B, C]
    assert st["kept"] == 1 and st["fetched"] == 2
    assert old.read_bytes() == JPEG


def test_warm_deletes_what_the_archive_no_longer_serves(cache):
    gone = put(cache, A, age_h=30)
    flaky = put(cache, B, age_h=30)
    arc = Archive({A: 404, B: 503})
    st = run({"10-05": [rec(A), rec(B)], "10-06": [rec(C)]}, arc)
    assert not gone.exists()               # 404: the archive dropped it, so do we
    assert flaky.exists()                  # 503: the archive is struggling, keep ours
    assert st["gone"] == 1 and st["errors"] == 1


def test_warm_never_fetches_and_always_deletes_a_blocked_cover(cache):
    held = put(cache, A, age_h=1)
    block(A)
    arc = Archive()
    st = run({"10-05": [rec(A, ready=True), rec(B)], "10-06": [rec(C)]}, arc)
    assert A not in arc.asked and not held.exists()
    assert st["blocked"] == 1


def test_warm_sweeps_covers_that_left_the_window(cache):
    yesterday = put(cache, E, age_h=20)
    run({"10-05": [rec(A)], "10-06": [rec(B)]}, Archive())
    assert not yesterday.exists()


def test_an_unknown_window_never_sweeps(cache):
    keep = put(cache, E, age_h=20)
    run({"10-05": [rec(A)], "10-06": []}, Archive())            # tomorrow read empty
    assert keep.exists()
    run({"10-05": RuntimeError("pool mid-re-seed"), "10-06": [rec(B)]}, Archive())
    assert keep.exists()


def test_anything_two_cycles_old_goes_even_when_the_window_is_unknown(cache):
    ancient = put(cache, E, age_h=49)
    run({"10-05": [], "10-06": []}, Archive())
    assert not ancient.exists()


def test_the_size_cap_and_the_free_space_floor_stop_the_pass(cache, monkeypatch):
    monkeypatch.setattr(config, "COVER_CACHE_MAX_MB", 0)
    arc = Archive()
    st = run({"10-05": [rec(A)], "10-06": [rec(B)]}, arc)
    assert arc.asked == [] and st["stopped"] == "cap"
    monkeypatch.setattr(config, "COVER_CACHE_MAX_MB", 600)
    monkeypatch.setattr(config, "COVER_CACHE_MIN_FREE_MB", 10 ** 9)
    st = run({"10-05": [rec(A)], "10-06": [rec(B)]}, arc)
    assert arc.asked == [] and st["stopped"] == "free"


def test_the_fetch_is_pinned_to_the_archive_and_wants_a_jpeg(monkeypatch):
    seen = {}

    def fake_get(url, hosts, **kw):
        seen["hosts"] = hosts
        return seen["body"], "image/jpeg"
    monkeypatch.setattr(covercache.safefetch, "safe_get", fake_get)
    seen["body"] = JPEG
    assert covercache._fetch(covercache.thumb_source("release", A)) == JPEG
    assert set(seen["hosts"]) == {"coverartarchive.org", "archive.org"}
    seen["body"] = b"\x89PNG\r\n\x1a\n...."
    with pytest.raises(ValueError):
        covercache._fetch(covercache.thumb_source("release", A))


def test_the_warmer_is_elected_by_a_disk_lock(cache):
    first = covercache._try_lock()
    assert first not in (None, True)
    assert covercache._try_lock() is None          # a second process would lose
    first.close()
    again = covercache._try_lock()
    assert again is not None
    again.close()


# --- the routes ------------------------------------------------------------------

def test_covers_route_serves_held_thumbnails_only(client, cache):
    put(cache, A)
    put(cache, B)
    block(B)
    r = client.get(f"/covers/release/{A}-500.jpg")
    assert r.status_code == 200 and r.data == JPEG
    assert r.mimetype == "image/jpeg"
    assert "max-age=21600" in r.headers["Cache-Control"]
    for path in (f"/covers/release/{B}-500.jpg", f"/covers/release/{C}-500.jpg",
                 f"/covers/art/{A}-500.jpg", f"/covers/release/{A}.jpg"):
        assert client.get(path).status_code == 404, path


def test_pool_day_marks_held_covers_and_withholds_blocked(client, cache, monkeypatch):
    import pooldb
    monkeypatch.setattr(config, "POOL_ENABLED", True)
    monkeypatch.setattr(pooldb, "pool_day",
                        lambda m, d, **kw: [rec(A, ready=True), rec(B), rec(C)])
    put(cache, A)
    block(C)
    covercache.cached_keys(fresh=True)
    albums = client.get("/api/pool/day?date=10-05").get_json()["albums"]
    assert albums[0].get("cover_cached") is True
    assert "cover_cached" not in albums[1] and albums[1]["cover"] == caa(B)
    assert albums[2]["cover"] is None


def test_the_door_withholds_a_blocked_cover(client, cache, monkeypatch):
    import pooldb
    monkeypatch.setattr(config, "POOL_ENABLED", True)
    monkeypatch.setattr(pooldb, "door_links", lambda uid: {
        "uid": uid, "status": "ok", "cover": caa(A), "platforms": {}})
    block(A)
    assert client.get(f"/api/pool/door?uid=m:{A}").get_json()["cover"] is None


def test_the_share_card_never_uses_a_blocked_cover(client, cache):
    import server
    block(A)
    with client.application.test_request_context("/", headers={"Host": "musicforest.lol"}):
        tags = server._record_og_tags({"artist": "X", "title": "Y", "cover": caa(A)},
                                      "https://musicforest.lol/?album=m:1")
        kept = server._record_og_tags({"artist": "X", "title": "Y", "cover": caa(B)},
                                      "https://musicforest.lol/?album=m:2")
    assert "coverartarchive" not in tags and "icon-512.png" in tags
    assert caa(B) in kept                  # the archive's address, never /covers/
