#!/usr/bin/env python3
"""
Fetch and cache cover art + Apple Music links for a day's albums.

Strategy (no API keys required):
  1. iTunes Search API  -> high-res artwork + the exact Apple Music album URL.
  2. MusicBrainz / Cover Art Archive -> fallback when iTunes has no match.

Designed to be run nightly for *tomorrow* so the next day's covers are already
cached locally and the app is fully offline at browse time. Results are stored
in the `art` table; images are downloaded under static/art/ keyed by release id.
Re-running only fetches rows that are still missing, so it's safe to repeat.

Usage:
    python fetch_art.py                 # today
    python fetch_art.py --tomorrow      # pre-cache tomorrow (use in cron)
    python fetch_art.py --date 06-13    # specific MM-DD
    python fetch_art.py --max 200       # cap lookups this run
    python fetch_art.py --dry-run       # show what would be queried, no network
    python fetch_art.py --audit         # re-check cached covers for wrong artists
    python fetch_art.py --audit --fix   # ...and repair the mismatches in place
"""
import argparse
import re
import sys
import time
import unicodedata
from datetime import date, timedelta

import requests

import config
import db
import safefetch


def _norm(s):
    return re.sub(r"\s*\(\d+\)$", "", s or "").strip()


# How many iTunes results to consider when verifying the artist (B5). iTunes
# ranks by popularity, so the correct artist may not be result[0] for a generic
# title — look a little deeper before giving up.
ITUNES_MATCH_LIMIT = 5


def _artist_key(s):
    """A loose, comparable key for an artist name: lowercased, Discogs '(2)'
    disambiguators and 'feat.' tails dropped, a leading 'the' removed, and
    everything but alphanumerics collapsed to single spaces."""
    s = _norm(s or "").lower()
    # Fold accents so "Sigur Rós" == "Sigur Ros".
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    s = re.sub(r"\bfeat\.?\b.*$", "", s)        # drop "feat. ..." tails
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    s = re.sub(r"^the\s+", "", s)
    return s


def _artist_matches(want, got):
    """True if iTunes result artist `got` plausibly belongs to album artist
    `want`. Deliberately loose — handles 'Artist & Friends', punctuation, and
    word-order noise — but strict enough to reject an unrelated famous artist
    (the Re Boom vs Marvin Gaye case, B5). A miss is better than a wrong cover.
    """
    a, b = _artist_key(want), _artist_key(got)
    if not a or not b:
        return False
    if a == b or a in b or b in a:
        return True
    ta, tb = set(a.split()), set(b.split())
    if not ta or not tb:
        return False
    # Share most of the words of the shorter name (e.g. "miles davis quintet"
    # vs "miles davis") without matching on a single common token alone.
    overlap = len(ta & tb)
    return overlap >= 2 and overlap / min(len(ta), len(tb)) >= 0.6


def itunes_search(term, limit=1):
    """Raw iTunes album search -> list of result dicts."""
    params = {
        "term": term,
        "entity": "album",
        "limit": limit,
        "country": config.ITUNES_COUNTRY,
    }
    r = requests.get(config.ITUNES_ENDPOINT, params=params,
                     headers={"User-Agent": config.USER_AGENT}, timeout=15)
    r.raise_for_status()
    return r.json().get("results", [])


def _best_art_url(hit):
    """Bump the iTunes thumbnail up to a crisp 600px square."""
    art = hit.get("artworkUrl100", "")
    return art.replace("100x100bb", "600x600bb") if art else None


def itunes_lookup(artist, title):
    """Return (artwork_url, apple_music_url, matched_artist) for the best result
    whose artist actually matches `artist`, or (None, None, None) if none do.

    We ask for several results and verify the artist (B5) instead of trusting
    iTunes' top hit: a generic title like "What's Going On" otherwise returns
    Marvin Gaye's cover no matter whose album we're looking up. Returning nothing
    on a miss is intentional — a placeholder beats a confidently-wrong cover."""
    results = itunes_search(f"{_norm(artist)} {_norm(title)}",
                            limit=ITUNES_MATCH_LIMIT)
    for hit in results:
        got = hit.get("artistName") or ""
        if _artist_matches(artist, got):
            return _best_art_url(hit), hit.get("collectionViewUrl"), got
    return None, None, None


def search_candidates(term, limit=8):
    """Return a list of pickable artwork candidates for the fix-art UI."""
    out = []
    for hit in itunes_search(term, limit=limit):
        art = _best_art_url(hit)
        if not art:
            continue
        out.append({
            "name": hit.get("collectionName"),
            "artist": hit.get("artistName"),
            "artwork_url": art,
            "apple_music_url": hit.get("collectionViewUrl"),
        })
    return out


def set_manual_art(release_id, artwork_url, apple_music_url=None):
    """Apply a user-chosen/pasted cover: download, cache, record. Returns
    the local served path (or None if the image couldn't be fetched)."""
    config.ensure_dirs()
    # In hotlink mode this returns None and we never fetch the user-supplied
    # image, so we just store + serve the URL (also avoids the SSRF risk).
    local = cache_image(artwork_url, release_id)
    db.save_art(release_id, artwork_url=artwork_url, local_path=local,
                apple_music_url=apple_music_url, source="manual",
                status="ok" if (local or artwork_url) else "error")
    return local


def coverart_lookup(artist, title):
    """MusicBrainz release-group -> Cover Art Archive front image."""
    q = f'releasegroup:"{_norm(title)}" AND artist:"{_norm(artist)}"'
    r = requests.get(config.MUSICBRAINZ_ENDPOINT,
                     params={"query": q, "fmt": "json", "limit": 1},
                     headers={"User-Agent": config.USER_AGENT}, timeout=15)
    r.raise_for_status()
    groups = r.json().get("release-groups", [])
    if not groups:
        return None
    mbid = groups[0]["id"]
    # CAA redirects to the actual image; 500px front cover.
    return f"https://coverartarchive.org/release-group/{mbid}/front-500"


def cache_image(url, release_id):
    """Download an image's bytes locally if caching is enabled (F13), else
    return None so the caller serves the remote URL (hotlink mode). Centralizes
    the AOTD_CACHE_ART_BYTES gate for every fetch path."""
    if not url or not config.CACHE_ART_BYTES:
        return None
    return download_image(url, release_id)


# --- SSRF guard (S1) --------------------------------------------------------
# `download_image` fetches arbitrary URLs, including ones a user pastes into the
# "Fix art" box, so it is a server-side request forgery surface. The scheme/host/
# IP policy + size-capped, redirect-revalidating GET live in `safefetch` (shared
# with the artist-bio fetch, A4); here we add the image-specific check that the
# returned bytes are a real image (content-type + magic bytes). Returning nothing
# on a bad payload means a placeholder + Fix art shows, never a wrong/junk cover.
_IMAGE_MAGIC = (
    (b"\xff\xd8\xff", ".jpg"),                 # JPEG
    (b"\x89PNG\r\n\x1a\n", ".png"),            # PNG
    (b"GIF87a", ".gif"), (b"GIF89a", ".gif"),  # GIF
    (b"RIFF", ".webp"),                        # WEBP (RIFF....WEBP)
)


def _detect_image_ext(content):
    """Return the file extension implied by the payload's magic bytes, or raise
    if it isn't a recognized image format. The content-type header is attacker-
    controllable, so we trust the bytes, not the label."""
    ext = next((e for magic, e in _IMAGE_MAGIC if content.startswith(magic)),
               None)
    if ext is None:
        raise ValueError("payload is not a recognized image format")
    if ext == ".webp" and content[8:12] != b"WEBP":
        raise ValueError("RIFF payload is not WEBP")
    return ext


def _check_image_dimensions(content):
    """Reject decompression bombs and absurdly-large images (S5) before they are
    cached to disk. Reads only the image header via Pillow and enforces the
    pixel/side caps from config. Pillow is an optional dependency: if it can't be
    imported this is a no-op (returns None) and the magic-byte + size guards still
    hold. Raises ValueError on a corrupt/oversized image. Returns (w, h) on pass.
    """
    try:
        from PIL import Image
    except Exception:  # noqa: BLE001 - Pillow optional; degrade to size+magic only
        return None
    from io import BytesIO
    # Set Pillow's own bomb ceiling to our cap so a crafted header trips
    # DecompressionBombError instead of trying to allocate the pixels.
    Image.MAX_IMAGE_PIXELS = config.ART_MAX_PIXELS
    try:
        with Image.open(BytesIO(content)) as im:
            w, h = im.size            # header read; no full decode
            im.verify()               # structural check: truncated/corrupt -> raises
    except Exception as e:  # noqa: BLE001 - any decode failure => reject the image
        raise ValueError(f"image failed to decode: {e}")
    if w <= 0 or h <= 0:
        raise ValueError(f"image has non-positive dimensions: {w}x{h}")
    if w > config.ART_MAX_DIMENSION or h > config.ART_MAX_DIMENSION:
        raise ValueError(
            f"image side too large: {w}x{h} (cap {config.ART_MAX_DIMENSION})")
    if w * h > config.ART_MAX_PIXELS:
        raise ValueError(
            f"image pixel count too large: {w * h} (cap {config.ART_MAX_PIXELS})")
    return (w, h)


def _safe_get_image(url):
    """SSRF-hardened image GET. Returns (content_bytes, ext) or raises."""
    content, ctype = safefetch.safe_get(
        url, config.ART_ALLOWED_HOSTS,
        max_bytes=config.ART_MAX_BYTES, max_redirects=config.ART_MAX_REDIRECTS)
    if not ctype.startswith("image/"):
        raise ValueError(f"not an image content-type: {ctype!r}")
    ext = _detect_image_ext(content)
    _check_image_dimensions(content)
    return content, ext


def download_image(url, release_id):
    """Download an image into static/art/ and return its relative path, or None
    if the URL is rejected by the SSRF guard or can't be fetched."""
    try:
        content, ext = _safe_get_image(url)
    except Exception as e:  # noqa: BLE001 - any rejection/fetch error => no cache
        print(f"  ! art download blocked/failed for {release_id}: {e}",
              file=sys.stderr)
        return None
    fname = f"{release_id}{ext}"
    (config.ART_DIR / fname).write_bytes(content)
    # Path the server serves from: /static/art/<file>
    return f"static/art/{fname}"


def _lookup_and_store(release_id, artist, title, use_fallback=True):
    """Shared core: iTunes (then optionally Cover Art Archive) lookup, cache the
    image bytes if enabled, and record the result in the `art` table. Returns
    ``(result, source, status)`` where ``result`` is the cached local path or
    the remote URL or None. Both fetch_one() (on-demand, server) and
    fetch_for_day() (bulk) go through here so the lookup logic lives once (R5)."""
    art_url, apple_url, _matched = itunes_lookup(artist, title)
    source = "itunes"
    if not art_url and use_fallback:
        try:
            art_url = coverart_lookup(artist, title)
            source = "coverartarchive" if art_url else "none"
        except Exception:  # noqa: BLE001 - MusicBrainz is flaky; treat as miss
            art_url, source = None, "none"
    local = cache_image(art_url, release_id)
    status = "ok" if (local or art_url) else "notfound"
    db.save_art(release_id, artwork_url=art_url, local_path=local,
                apple_music_url=apple_url, source=source, status=status)
    return (local or art_url), source, status


def fetch_one(release_id, artist, title, use_fallback=True):
    """Look up, download and record art for a single release. Used by the
    on-demand path (server) and the bulk fetcher. Returns the cached local
    path, or the remote URL, or None. Records the result either way so we
    don't re-query the same miss repeatedly."""
    result, _source, _status = _lookup_and_store(
        release_id, artist, title, use_fallback=use_fallback)
    return result


def fetch_for_day(month, day, max_items=None, dry_run=False):
    config.ensure_dirs()
    todo = db.albums_missing_art(month, day)
    if max_items:
        todo = todo[:max_items]
    print(f"{month:02d}-{day:02d}: {len(todo)} album(s) need artwork.")
    ok = 0
    for i, a in enumerate(todo, 1):
        rid, artist, title = a["release_id"], a["artist"], a["title"]
        if dry_run:
            print(f"  [{i}] would query iTunes: {artist} - {title}")
            continue
        try:
            _result, source, status = _lookup_and_store(rid, artist, title)
            if status == "ok":
                ok += 1
            print(f"\r  [{i}/{len(todo)}] {source:15s} {artist[:30]:30s}",
                  end="", flush=True)
        except Exception as e:  # noqa: BLE001 - one bad row shouldn't stop the run
            db.save_art(rid, status="error")
            print(f"\n  ! {artist} - {title}: {e}", file=sys.stderr)
        time.sleep(config.ART_REQUEST_DELAY)  # be polite to the APIs
    if not dry_run:
        print(f"\nCached artwork for {ok}/{len(todo)} albums.")


def _same_art(u1, u2):
    """Compare two iTunes artwork URLs ignoring the `600x600bb` size segment, so
    the stored URL and a freshly-built one compare on the underlying image."""
    def key(u):
        return re.sub(r"/\d+x\d+bb\b", "/SIZE", u or "")
    return bool(u1) and bool(u2) and key(u1) == key(u2)


def audit_cached_covers(max_items=None, fix=False, verbose=True):
    """Re-check already-cached iTunes covers against the artist-verified lookup
    (B5). For each cached cover we re-run itunes_lookup and compare:

      * no artist match now      -> the stored cover is almost certainly wrong
        (it was a popularity match for a generic title);
      * a match but different art -> the stored cover is the wrong (popular) one.

    Returns the list of flagged entries. With ``fix=True`` it re-stores the
    verified result in place — a correct cover, or a recorded miss that falls
    back to the placeholder + "Fix art" so the wrong image stops showing.

    Network-bound and rate-limited (one lookup per cached cover); use
    ``max_items`` to run it in chunks."""
    config.ensure_dirs()
    rows = db.cached_itunes_art()
    if max_items:
        rows = rows[:max_items]
    n = len(rows)
    flagged = []
    if verbose:
        print(f"Auditing {n} cached iTunes cover(s)"
              f"{' (repairing)' if fix else ''}…")
    for i, r in enumerate(rows, 1):
        rid, artist, title = r["release_id"], r["artist"], r["title"]
        stored = r["artwork_url"]
        try:
            new_art, new_apple, matched = itunes_lookup(artist, title)
        except Exception as e:  # noqa: BLE001 - skip a row that errors, keep going
            if verbose:
                print(f"\n  ! lookup failed for {rid} ({artist} - {title}): {e}",
                      file=sys.stderr)
            time.sleep(config.ART_REQUEST_DELAY)
            continue
        if not _same_art(new_art, stored):
            flagged.append({
                "release_id": rid, "artist": artist, "title": title,
                "stored": stored, "verified": new_art, "matched_artist": matched,
            })
            if fix:
                local = cache_image(new_art, rid) if new_art else None
                status = "ok" if (local or new_art) else "notfound"
                db.save_art(rid, artwork_url=new_art, local_path=local,
                            apple_music_url=new_apple,
                            source="itunes" if new_art else "none",
                            status=status)
            if verbose:
                print(f"\n  [{'FIXED' if fix else 'MISMATCH'}] {rid} "
                      f"{artist} — {title}\n"
                      f"        stored:   {stored}\n"
                      f"        verified: {new_art or '(no artist match)'}")
        if verbose:
            print(f"\r  [{i}/{n}] checked", end="", flush=True)
        time.sleep(config.ART_REQUEST_DELAY)
    if verbose:
        print(f"\nDone. {len(flagged)} mismatch(es)"
              f"{' repaired' if fix else ' found'} of {n} checked.")
    return flagged


def main():
    ap = argparse.ArgumentParser(description="Fetch/cache cover art for a day")
    ap.add_argument("--date", help="MM-DD (default: today)")
    ap.add_argument("--tomorrow", action="store_true",
                    help="pre-cache tomorrow (handy in a nightly cron)")
    ap.add_argument("--max", type=int, help="cap number of lookups this run")
    ap.add_argument("--dry-run", action="store_true",
                    help="print planned lookups without calling the network")
    ap.add_argument("--audit", action="store_true",
                    help="re-check already-cached iTunes covers for wrong-artist "
                         "matches (B5); report only unless --fix is given")
    ap.add_argument("--fix", action="store_true",
                    help="with --audit, repair the mismatches it finds in place")
    args = ap.parse_args()

    if args.audit:
        audit_cached_covers(max_items=args.max, fix=args.fix)
        return

    if args.tomorrow:
        d = date.today() + timedelta(days=1)
        month, day = d.month, d.day
    elif args.date:
        month, day = (int(x) for x in args.date.split("-"))
    else:
        t = date.today()
        month, day = t.month, t.day

    fetch_for_day(month, day, max_items=args.max, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
