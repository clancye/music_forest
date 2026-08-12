"""Artist-verified cover lookup + the cached-cover audit (B5)."""
import io

import pytest

import config
import db
import fetch_art


def _require_cover_study():
    """The title gate calls tools/coverage_study, part of the private pipeline; skip
    cleanly where it isn't present (the OSS mirror's pipeline-less test run — the same
    guarantee sync_public.sh relies on)."""
    if fetch_art._cover_study() is None:
        pytest.skip("tools/coverage_study not present (pipeline-less checkout)")


# --- image validation: magic bytes + dimension/bomb cap (S5) -----------------

def _png_bytes(w, h):
    """A real (tiny) PNG of the given size, via Pillow."""
    Image = pytest.importorskip("PIL.Image")
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (3, 4, 5)).save(buf, format="PNG")
    return buf.getvalue()


def test_detect_image_ext_by_magic():
    assert fetch_art._detect_image_ext(b"\xff\xd8\xff and more") == ".jpg"
    assert fetch_art._detect_image_ext(b"\x89PNG\r\n\x1a\nrest") == ".png"
    assert fetch_art._detect_image_ext(b"GIF89a...") == ".gif"
    with pytest.raises(ValueError):
        fetch_art._detect_image_ext(b"not an image at all")
    with pytest.raises(ValueError):              # RIFF header but not WEBP
        fetch_art._detect_image_ext(b"RIFF\x00\x00\x00\x00AVI ")


def test_check_image_dimensions_accepts_normal_cover():
    pytest.importorskip("PIL.Image")
    assert fetch_art._check_image_dimensions(_png_bytes(600, 600)) == (600, 600)


def test_check_image_dimensions_rejects_oversized(monkeypatch):
    pytest.importorskip("PIL.Image")
    # Tighten the caps so the test image is cheap to create yet trips the guard.
    monkeypatch.setattr(config, "ART_MAX_DIMENSION", 256)
    monkeypatch.setattr(config, "ART_MAX_PIXELS", 256 * 256)
    with pytest.raises(ValueError):
        fetch_art._check_image_dimensions(_png_bytes(300, 100))   # side cap


def test_check_image_dimensions_rejects_pixel_count(monkeypatch):
    pytest.importorskip("PIL.Image")
    monkeypatch.setattr(config, "ART_MAX_DIMENSION", 10000)
    monkeypatch.setattr(config, "ART_MAX_PIXELS", 100 * 100)
    with pytest.raises(ValueError):
        fetch_art._check_image_dimensions(_png_bytes(200, 200))   # pixel cap


def test_check_image_dimensions_rejects_corrupt():
    pytest.importorskip("PIL.Image")
    # Valid PNG magic, garbage body -> Pillow refuses to decode it.
    with pytest.raises(ValueError):
        fetch_art._check_image_dimensions(b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)


def test_check_image_dimensions_noop_without_pillow(monkeypatch):
    # Simulate Pillow not installed: the function must degrade to a no-op rather
    # than crash, leaving the magic-byte + size guards as the only checks.
    import builtins
    real_import = builtins.__import__

    def fake_import(name, *a, **k):
        if name == "PIL" or name.startswith("PIL."):
            raise ImportError("no PIL")
        return real_import(name, *a, **k)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    assert fetch_art._check_image_dimensions(b"\xff\xd8\xff anything") is None


# --- artist matching (pure) -------------------------------------------------

def test_artist_matches_accepts_variants():
    assert fetch_art._artist_matches("Re Boom", "Re Boom")
    assert fetch_art._artist_matches("The Beatles", "Beatles")          # article
    assert fetch_art._artist_matches("Miles Davis", "Miles Davis Quintet")  # substr
    assert fetch_art._artist_matches("Sigur Rós", "Sigur Ros")         # punctuation


def test_artist_matches_rejects_unrelated():
    assert not fetch_art._artist_matches("Re Boom", "Marvin Gaye")
    assert not fetch_art._artist_matches("John Williams", "John Coltrane")  # 1 token
    assert not fetch_art._artist_matches("Re Boom", "")
    assert not fetch_art._artist_matches("", "Anyone")


# --- itunes_lookup verifies the artist --------------------------------------

def _hit(artist, name, slug):
    return {"artistName": artist, "collectionName": name,
            "artworkUrl100": f"https://art/{slug}/100x100bb.jpg",
            "collectionViewUrl": f"https://music/{slug}"}


def test_lookup_skips_more_popular_wrong_artist(monkeypatch):
    _require_cover_study()
    # iTunes ranks Marvin Gaye first; we must pick the actual artist's record.
    results = [_hit("Marvin Gaye", "What's Going On", "marvin"),
               _hit("Re Boom", "What's Going On", "reboom")]
    monkeypatch.setattr(fetch_art, "itunes_search", lambda *a, **k: results)
    art, apple, matched = fetch_art.itunes_lookup("Re Boom", "What's Going On")
    assert "reboom" in art and "600x600bb" in art
    assert apple == "https://music/reboom"
    assert matched == "Re Boom"


def test_lookup_returns_nothing_on_no_match(monkeypatch):
    results = [_hit("Marvin Gaye", "What's Going On", "marvin")]
    monkeypatch.setattr(fetch_art, "itunes_search", lambda *a, **k: results)
    assert fetch_art.itunes_lookup("Re Boom", "What's Going On") == (None, None, None)


# --- itunes_lookup verifies the title too (B5 / feedback #82) ----------------

def test_lookup_rejects_wrong_title_same_artist(monkeypatch):
    _require_cover_study()
    # The #82 class: right artist, WRONG album. iTunes offers only "Freedom Piano
    # Stories 4" for a "Piano Stories" lookup — a different record whose cover would
    # otherwise be cached. Artist-only matching used to accept it; now it's a miss.
    results = [_hit("Joe Hisaishi", "Freedom Piano Stories 4", "ps4")]
    monkeypatch.setattr(fetch_art, "itunes_search", lambda *a, **k: results)
    assert fetch_art.itunes_lookup("Joe Hisaishi", "Piano Stories") == (None, None, None)


def test_lookup_picks_correct_title_over_wrong_same_artist(monkeypatch):
    _require_cover_study()
    # A wrong-title hit must not short-circuit the search: iteration continues to the
    # actual album further down iTunes' ranking.
    results = [_hit("Joe Hisaishi", "Freedom Piano Stories 4", "ps4"),
               _hit("Joe Hisaishi", "Piano Stories", "ps")]
    monkeypatch.setattr(fetch_art, "itunes_search", lambda *a, **k: results)
    art, apple, matched = fetch_art.itunes_lookup("Joe Hisaishi", "Piano Stories")
    assert apple == "https://music/ps" and "ps/" in art


def test_lookup_keeps_single_ep_suffix(monkeypatch):
    _require_cover_study()
    # iTunes appends "- Single" / "- EP" to a non-album release, so a Discogs "Money"
    # comes back as "Money - Single" — the SAME record. That suffix must not read as a
    # title mismatch (it did in a first cut; ~half a 60-cover audit sample were these).
    for got in ["Money - Single", "Money - EP"]:
        monkeypatch.setattr(fetch_art, "itunes_search", lambda *a, **k: [
            _hit("The Flying Lizards", got, "money")])
        art, apple, matched = fetch_art.itunes_lookup("The Flying Lizards", "Money")
        assert apple == "https://music/money", got


def test_lookup_keeps_non_latin_title_on_artist_match(monkeypatch):
    _require_cover_study()
    # No regression: a title that collapses to nothing under normalization (CJK etc.)
    # can't be judged, so a solid artist match still keeps its cover — the same
    # coverage the artist-only check gave Japanese and other non-Latin pressings.
    results = [_hit("Joe Hisaishi", "東京物語", "tokyo")]
    monkeypatch.setattr(fetch_art, "itunes_search", lambda *a, **k: results)
    art, apple, matched = fetch_art.itunes_lookup("Joe Hisaishi", "東京")
    assert apple == "https://music/tokyo" and matched == "Joe Hisaishi"


# --- audit of already-cached covers -----------------------------------------

def test_audit_flags_and_repairs_a_mismatch(built_db, monkeypatch):
    rid = 100
    album = db.get_album(rid)
    # Pretend we'd cached a (wrong) cover for this album from iTunes.
    db.save_art(rid, artwork_url="https://art/wrong/600x600bb.jpg",
                local_path=None, apple_music_url="https://music/wrong",
                source="itunes", status="ok")
    # iTunes now only offers an unrelated artist -> no verified match.
    monkeypatch.setattr(fetch_art, "itunes_search", lambda *a, **k: [
        _hit("Totally Different Person", album["title"], "tdp")])
    monkeypatch.setattr(config, "ART_REQUEST_DELAY", 0)

    flagged = fetch_art.audit_cached_covers(fix=True, verbose=False)
    assert any(f["release_id"] == rid for f in flagged)
    # Repaired in place: the wrong cover is gone (placeholder + Fix art instead).
    assert db.get_album(rid)["cover"] is None


def test_audit_leaves_a_correct_cover_alone(built_db, monkeypatch):
    rid = 102
    album = db.get_album(rid)
    good = "https://art/right/600x600bb.jpg"
    db.save_art(rid, artwork_url=good, local_path=None,
                apple_music_url="https://music/right", source="itunes", status="ok")
    # iTunes returns the same artist + same artwork -> nothing to flag.
    monkeypatch.setattr(fetch_art, "itunes_search", lambda *a, **k: [
        {"artistName": album["artist"], "collectionName": album["title"],
         "artworkUrl100": "https://art/right/100x100bb.jpg",
         "collectionViewUrl": "https://music/right"}])
    monkeypatch.setattr(config, "ART_REQUEST_DELAY", 0)

    flagged = fetch_art.audit_cached_covers(fix=True, verbose=False)
    assert all(f["release_id"] != rid for f in flagged)
    assert db.get_album(rid)["cover"] == good
