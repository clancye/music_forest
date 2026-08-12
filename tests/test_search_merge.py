"""B24 — /api/search unions the Discogs arm with the pool's MB-only arm.

Explore searched only `albums_fts` (search.db, built from albums.db), so the 46.3%
of the pool that is MB-only was un-findable: an MB-only artist returned "No albums
or songs match" for a record Today had just served. The index itself is covered by
test_pooldb.test_pool_search_mb_arm (it needs a fixture pool); these tests cover the
MERGE — the part that decides what a reader actually gets back — with the MB arm
faked, so they pin the composition rules without needing a pool on disk.
"""
import config
import pooldb
import pytest
import server


@pytest.fixture()
def mb_arm(monkeypatch):
    """Fake the MB arm and turn the pool gate on. Returns a setter taking the album
    dicts pooldb.search_albums should hand back."""
    monkeypatch.setattr(config, "POOL_ENABLED", True)

    def _set(albums, *, raises=False):
        def fake(q, limit=500, month=None, day=None, field=None):
            if raises:
                raise RuntimeError("pool exploded")
            return albums
        monkeypatch.setattr(pooldb, "search_albums", fake)
    return _set


def _mb(n, start=0):
    return [{"uid": f"m:mb:{i}", "artist": "MB Act", "title": f"MB {i}",
             "year": 2000 + i, "source": "mb_only"} for i in range(start, start + n)]


def test_mb_only_record_is_findable(client, mb_arm):
    """The report: a term with NO Discogs match still returns its MB records."""
    mb_arm(_mb(3))
    data = client.get("/api/search?q=zzzznomatchzzzz").get_json()
    assert data["count"] == 3
    assert [a["uid"] for a in data["albums"]] == ["m:mb:0", "m:mb:1", "m:mb:2"]


def test_discogs_results_are_kept(client, mb_arm):
    """Folding in the MB arm must not cost a single Discogs result."""
    before = {a["release_id"] for a in
              client.get("/api/search?q=alpha").get_json()["albums"]}
    mb_arm(_mb(2))
    after = client.get("/api/search?q=alpha").get_json()["albums"]
    assert before <= {a.get("release_id") for a in after}
    assert 100 in before


# The ordering rules are checked against _merge_search_arms directly: the fixture
# catalog is one-album-per-term, too small to show an interleave through the endpoint.

def _d(n):
    return [{"release_id": i, "artist": "D Act", "title": f"D {i}"} for i in range(n)]


def _kinds(albums):
    return ["mb" if str(a.get("uid", "")).startswith("m:") else "d" for a in albums]


def test_arms_are_interleaved(mb_arm):
    """Round-robin, so the 500-cap can't hide an arm — the actual bug. bm25 scores
    aren't comparable across two indexes, so this is a fairness rule, not a ranking
    claim."""
    mb_arm(_mb(3))
    got = server._merge_search_arms(_d(3), "q", None, None, None)
    assert _kinds(got) == ["d", "mb"] * 3


def test_longer_arm_is_not_truncated(mb_arm):
    """Interleaving stops pairing when one arm runs out; the rest still ships —
    a short Discogs arm must not cut the MB one (that IS the reported bug)."""
    mb_arm(_mb(5))
    got = server._merge_search_arms(_d(1), "q", None, None, None)
    assert _kinds(got) == ["d"] + ["mb"] * 5
    mb_arm(_mb(1))
    got = server._merge_search_arms(_d(4), "q", None, None, None)
    assert _kinds(got) == ["d", "mb", "d", "d", "d"]


def test_each_arm_gets_half_the_cap_when_both_are_full(mb_arm):
    """Both arms over-supply: neither may crowd the other out of the capped set."""
    mb_arm(_mb(500))
    got = server._merge_search_arms(_d(500), "q", None, None, None)
    assert len(got) == 500
    assert _kinds(got).count("mb") == 250 == _kinds(got).count("d")


def test_merged_result_is_capped(client, mb_arm):
    """The client's "first 500 matches — refine your terms" copy is only honest if
    the server caps at the same number it did before the MB arm existed."""
    mb_arm(_mb(600))
    data = client.get("/api/search?q=alpha").get_json()
    assert data["count"] == 500 == len(data["albums"])


def test_pool_disabled_is_discogs_only(client, mb_arm, monkeypatch):
    mb_arm(_mb(3))
    monkeypatch.setattr(config, "POOL_ENABLED", False)
    albums = client.get("/api/search?q=alpha").get_json()["albums"]
    assert not any(str(a.get("uid", "")).startswith("m:") for a in albums)


def test_pool_failure_never_breaks_search(client, mb_arm):
    """The MB arm is additive. A pool/index problem degrades to the Discogs results,
    never a 500 — the same discipline as _overlay_pool_dates."""
    mb_arm([], raises=True)
    r = client.get("/api/search?q=alpha")
    assert r.status_code == 200
    assert 100 in {a["release_id"] for a in r.get_json()["albums"]}


def test_empty_mb_arm_changes_nothing(client, mb_arm):
    mb_arm([])
    r = client.get("/api/search?q=alpha")
    assert r.status_code == 200
    assert 100 in {a["release_id"] for a in r.get_json()["albums"]}


def test_scope_args_reach_the_mb_arm(client, mb_arm, monkeypatch):
    """A day/field-scoped search must scope BOTH arms, or the MB half would ignore
    the reader's filter."""
    seen = {}
    monkeypatch.setattr(config, "POOL_ENABLED", True)

    def fake(q, limit=500, month=None, day=None, field=None):
        seen.update(q=q, limit=limit, month=month, day=day, field=field)
        return []
    monkeypatch.setattr(pooldb, "search_albums", fake)
    client.get("/api/search?q=alpha&date=03-10&field=artist")
    assert seen == {"q": "alpha", "limit": 500, "month": 3, "day": 10,
                    "field": "artist"}


def test_empty_query_never_reaches_the_pool(client, mb_arm):
    """A blank q short-circuits before either arm (and before the usage counter)."""
    mb_arm(_mb(3))
    data = client.get("/api/search?q=  ").get_json()
    assert data["albums"] == [] and data["count"] == 0
