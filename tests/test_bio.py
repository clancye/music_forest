"""Optional artist bio (A4): the music-relevance heuristic, the cache (hits and
misses asked once), and the pull-only API. No network — safefetch is stubbed."""
import json

import pytest

import bio
import config
import safefetch


@pytest.fixture()
def bio_db(tmp_path):
    """Point the bio cache at a throwaway file for the test."""
    config.BIO_DB_PATH = tmp_path / "bio.db"
    return config.BIO_DB_PATH


def _wiki(payload):
    """A fake safefetch.safe_get returning a Wikipedia-summary JSON body."""
    return lambda *a, **k: (json.dumps(payload).encode("utf-8"), "application/json")


# --- the music-relevance guard ---------------------------------------------

def test_keeps_a_musical_summary(monkeypatch):
    monkeypatch.setattr(safefetch, "safe_get", _wiki({
        "type": "standard",
        "title": "Radiohead",
        "description": "English rock band",
        "extract": "Radiohead are an English rock band formed in Abingdon. "
                   "They are widely considered one of their era's defining acts. "
                   "Extra sentence one. Extra sentence two. Extra sentence three.",
        "content_urls": {"desktop": {"page": "https://en.wikipedia.org/wiki/Radiohead"}},
    }))
    out = bio.fetch_wikipedia("Radiohead")
    assert out and out["source"] == "wikipedia"
    assert out["url"] == "https://en.wikipedia.org/wiki/Radiohead"
    # Trimmed to at most MAX_SENTENCES sentences.
    assert out["extract"].count(".") <= bio.MAX_SENTENCES


def test_rejects_a_same_named_non_music_page(monkeypatch):
    # "Bread" the food: no musical hint -> a miss beats a wrong bio.
    monkeypatch.setattr(safefetch, "safe_get", _wiki({
        "type": "standard", "title": "Bread",
        "description": "staple food",
        "extract": "Bread is a staple food prepared from a dough of flour and water.",
    }))
    assert bio.fetch_wikipedia("Bread") is None


def test_rejects_a_disambiguation_page(monkeypatch):
    monkeypatch.setattr(safefetch, "safe_get", _wiki({
        "type": "disambiguation", "title": "Kiss",
        "extract": "Kiss may refer to a band, a touch of the lips, ...",
    }))
    assert bio.fetch_wikipedia("Kiss") is None


# --- the cache: hits AND misses are asked once ------------------------------

def test_hit_is_cached_and_not_refetched(bio_db, monkeypatch):
    calls = {"n": 0}

    def once(*a, **k):
        calls["n"] += 1
        return (json.dumps({
            "type": "standard", "title": "Sigur Rós",
            "description": "Icelandic post-rock band",
            "extract": "Sigur Rós are an Icelandic post-rock band from Reykjavík.",
            "content_urls": {"desktop": {"page": "https://en.wikipedia.org/wiki/Sigur_Ros"}},
        }).encode("utf-8"), "application/json")

    monkeypatch.setattr(safefetch, "safe_get", once)
    first = bio.for_artist("Sigur Rós")
    second = bio.for_artist("Sigur Rós")     # accent/key-folded, same row
    assert first["status"] == "ok" and second["status"] == "ok"
    assert second["extract"] == first["extract"]
    assert calls["n"] == 1                    # network hit only once


def test_miss_is_cached_too(bio_db, monkeypatch):
    calls = {"n": 0}

    def miss(*a, **k):
        calls["n"] += 1
        return (json.dumps({"type": "standard", "title": "Nobody",
                            "description": "a film", "extract": "Nobody is a film."}
                           ).encode("utf-8"), "application/json")

    monkeypatch.setattr(safefetch, "safe_get", miss)
    assert bio.for_artist("Nobody Here")["status"] == "notfound"
    assert bio.for_artist("Nobody Here")["status"] == "notfound"
    assert calls["n"] == 1                    # the miss is remembered, not re-asked


def test_network_error_is_a_miss(bio_db, monkeypatch):
    def boom(*a, **k):
        raise ValueError("host not allowlisted")
    monkeypatch.setattr(safefetch, "safe_get", boom)
    assert bio.for_artist("Whoever")["status"] == "notfound"


# --- the API is pull-only and never 500s ------------------------------------

def test_api_returns_bio(client, monkeypatch):
    import server
    monkeypatch.setattr(server.bio, "for_artist", lambda name: {
        "artist": name, "status": "ok", "extract": "A short blurb.",
        "url": "https://en.wikipedia.org/wiki/X", "source": "wikipedia"})
    r = client.get("/api/artist/bio?name=Miles%20Davis")
    assert r.status_code == 200
    assert r.get_json()["extract"] == "A short blurb."


def test_api_requires_a_name(client):
    assert client.get("/api/artist/bio").status_code == 400


def test_api_never_500s_on_error(client, monkeypatch):
    import server

    def boom(name):
        raise RuntimeError("unexpected")
    monkeypatch.setattr(server.bio, "for_artist", boom)
    r = client.get("/api/artist/bio?name=X")
    assert r.status_code == 200               # a bio must never break the page
    assert r.get_json()["status"] == "error"
