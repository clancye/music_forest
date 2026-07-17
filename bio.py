"""
Optional, cached artist bios (A4).

An *outward* thread (VISION.md, Principle 2): a short, plain-language blurb about
an artist, pulled only when the user opens it inside an album's story door —
never auto-surfaced, never a wall of text. No API key required: we read the
Wikipedia REST summary for the artist and keep only a music-relevant match (a
miss beats a confidently-wrong bio — the same rule as cover art, B5). Results,
hits AND misses, are cached in their own small SQLite file so we ask the network
at most once per artist, and a catalog rebuild never touches it.

The fetch goes through `safefetch` — the same SSRF guard the cover-art download
uses (https-only, host allowlist, public-IP-only, redirect-revalidating, size
capped).
"""
import json
import re
import sqlite3
import unicodedata
from datetime import datetime, timezone
from urllib.parse import quote

import config
import safefetch

WIKI_SUMMARY = "https://en.wikipedia.org/api/rest_v1/page/summary/"
# Keep the blurb a thread to pull, not a wall of text (Principle 1).
MAX_SENTENCES = 4

# Words that mark a Wikipedia page as plausibly about a musical act/person, used
# to reject a same-named non-music page (e.g. "Bread" the food, "Kiss" the
# verb). Deliberately loose — a miss just falls back to "no bio", which is fine.
_MUSIC_HINTS = (
    "band", "musician", "singer", "songwriter", "rapper", "composer",
    "duo", "trio", "quartet", "group", "dj", "disc jockey", "producer",
    "vocalist", "guitarist", "drummer", "bassist", "pianist", "saxophonist",
    "orchestra", "ensemble", "choir", "rock", "pop", "jazz", "hip hop",
    "hip-hop", "metal", "punk", "folk", "electronic", "techno", "house music",
    "soul", "funk", "r&b", "reggae", "blues", "country music", "classical",
    "album", "record label", "discography", "recording", "music",
)


def _norm(s):
    """Drop the Discogs '(2)' disambiguator and trim."""
    return re.sub(r"\s*\(\d+\)$", "", s or "").strip()


def _key(s):
    """Stable cache key for an artist name: accent-folded, lowercased, the
    Discogs '(2)' disambiguator dropped, non-alphanumerics collapsed to spaces."""
    s = _norm(s).lower()
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def _looks_musical(text):
    t = (text or "").lower()
    return any(h in t for h in _MUSIC_HINTS)


def _trim(extract):
    extract = (extract or "").strip()
    parts = re.split(r"(?<=[.!?])\s+", extract)
    return " ".join(parts[:MAX_SENTENCES]).strip()


def fetch_wikipedia(artist):
    """Best-effort Wikipedia summary for `artist`. Returns
    {extract, url, title, source:'wikipedia'} on a music-relevant hit, else None.
    Every network/parse error degrades to None (treated as a miss)."""
    title = _norm(artist)
    if not title:
        return None
    url = WIKI_SUMMARY + quote(title.replace(" ", "_"), safe="")
    try:
        content, ctype = safefetch.safe_get(
            url, config.BIO_ALLOWED_HOSTS,
            max_bytes=config.BIO_MAX_BYTES,
            max_redirects=config.BIO_MAX_REDIRECTS)
    except Exception:  # noqa: BLE001 - any rejection/fetch error => a miss
        return None
    if "json" not in ctype:
        return None
    try:
        data = json.loads(content.decode("utf-8", "replace"))
    except ValueError:
        return None
    if data.get("type") == "disambiguation":
        return None
    extract = _trim(data.get("extract"))
    if not extract:
        return None
    # Reject a same-named non-music page (a miss beats a wrong bio).
    if not _looks_musical(f"{data.get('description', '')} {data.get('extract', '')}"):
        return None
    page = (((data.get("content_urls") or {}).get("desktop") or {}).get("page")
            or "https://en.wikipedia.org/wiki/"
            + quote(title.replace(" ", "_"), safe=""))
    return {"extract": extract, "url": page,
            "title": data.get("title") or title, "source": "wikipedia"}


# --- cache ------------------------------------------------------------------

def _conn():
    config.BIO_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(config.BIO_DB_PATH, timeout=30)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA busy_timeout=30000")
    c.execute(
        """CREATE TABLE IF NOT EXISTS bios (
               artist_key TEXT PRIMARY KEY,
               artist     TEXT,
               extract    TEXT,
               url        TEXT,
               title      TEXT,
               source     TEXT,
               status     TEXT,
               fetched_at TEXT)""")
    return c


def _cached(key):
    with _conn() as c:
        r = c.execute("SELECT * FROM bios WHERE artist_key=?", (key,)).fetchone()
    return dict(r) if r else None


def _store(key, artist, result, status):
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    r = result or {}
    with _conn() as c:
        c.execute(
            """INSERT OR REPLACE INTO bios
               (artist_key, artist, extract, url, title, source, status, fetched_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (key, artist, r.get("extract"), r.get("url"), r.get("title"),
             r.get("source"), status, now))
        c.commit()


def for_artist(artist, refresh=False):
    """Cache-first artist bio. Returns
    ``{artist, status, extract?, url?, title?, source?}`` where status is 'ok'
    or 'notfound'. Pull-only: the server calls this only when the user opens the
    bio door. Misses are cached too, so the network is asked at most once."""
    key = _key(artist)
    if not key:
        return {"artist": artist, "status": "notfound"}
    if not refresh:
        hit = _cached(key)
        if hit:
            return {"artist": artist, "status": hit["status"],
                    "extract": hit["extract"], "url": hit["url"],
                    "title": hit["title"], "source": hit["source"]}
    result = fetch_wikipedia(artist)
    status = "ok" if result else "notfound"
    _store(key, artist, result, status)
    return {"artist": artist, "status": status, **(result or {})}
