"""
Pure shaping/parsing helpers for the pool reads (extracted from pooldb.py).

Everything here is a pure transform: it takes a sqlite Row / dict / string and
returns a plain value, with NO database connection, NO network, and no module
state. The DB- and network-facing code (connections, the door resolvers, the
Spotify/YouTube backfills, the crawler heartbeat) stays in pooldb.py, which
re-imports these names so existing call sites — including `pooldb._now`,
`pooldb._spotify_fresh`, etc. — are unchanged. Kept DB-free so the row shaping,
link parsing and TTL logic can be reasoned about (and tested) on their own.

Depends only on `config` (a couple of constants) and `db` (its pure link/
provenance/platform helpers); `db` never imports this, so there's no cycle.
"""
import json
import urllib.parse
from datetime import datetime, timedelta, timezone

import config
import db


def _now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _rep_release_id(row):
    """The representative Discogs release_id (release_ids[0]) for a pool row, or
    None (MB-only rows carry no Discogs release_ids)."""
    try:
        rids = json.loads(row["release_ids"] or "[]")
    except (ValueError, TypeError):
        return None
    return rids[0] if rids else None


def _lean_row(row, rep_rid=None):
    """A lean album dict with no albums.db richness — used for every MB-only album
    (cover deferred to the door) and as a defensive fallback for a Discogs album
    whose representative release_id isn't in albums.db (shouldn't happen). Source is
    preserved; the Discogs link is release-exact when we have a release_id, else a
    name search. Links are no-auth searches that work for any artist/title."""
    artist = row["artist"] or ""
    title = row["title"] or ""
    links = db._listen_links(artist, title)
    if rep_rid is not None:
        discogs_url = f"https://www.discogs.com/release/{rep_rid}"
    else:
        discogs_url = ("https://www.discogs.com/search/?q="
                       + urllib.parse.quote_plus(f"{artist} {title}"))
    # Source-aware provenance from the uid (d: -> Discogs release, m:mb: ->
    # MusicBrainz release-group); falls back to the legacy discogs_url for the
    # rare uid the helper can't key (the frontend just shows no thread then).
    source_url, source_label = db.source_provenance(row["uid"])
    # Confirmed-listen platforms known synchronously for a lean (MB-only or
    # albums.db-missing) row: just Deezer when the album is Deezer-listenable. The
    # door's Odesli fan-out (iTunes-seeded for these seedless rows) fills the rest.
    deezer_url = row["deezer_url"]
    return {
        "uid": row["uid"], "album_id": row["album_id"], "source": row["source"],
        "release_id": rep_rid, "master_id": None,
        "artist": artist, "title": title,
        "year": row["year"], "released": row["original_date"],
        "release_month": row["month"], "release_day": row["day"],
        "country": row["country"],
        "genres": None, "styles": None, "formats": None, "label": None,
        "cover": None,  # filled lazily at the door (iTunes/Odesli)
        "bandcamp_url": links["bandcamp"], "youtube_url": links["youtube"],
        "spotify_url": links["spotify"], "qobuz_url": links["qobuz"],
        "apple_music_url": links["apple_search"],
        "deezer_url": deezer_url,
        "platforms": db.confirmed_platforms(deezer_url=deezer_url),
        "discogs_url": discogs_url,
        "source_url": source_url, "source_label": source_label,
        "listenable": (None if row["listenable"] is None
                       else bool(row["listenable"])),
    }


# The long-tail Listen platforms that ride in a door row's Odesli links_json (not a
# dedicated column) — our canonical key -> the key Odesli uses in linksByPlatform.
# Most match; Amazon's STREAMING link is Odesli's `amazonMusic` (we deliberately do
# NOT surface `amazonStore`, the buy-the-MP3 link — that's a store, not a listen).
# All are PERMANENT (Odesli-sourced, no TTL — same footing as the row's Deezer link,
# unlike the direct-resolve Spotify link). Keys line up with _door_platforms' extras.
_ODESLI_EXTRA_KEYS = {
    "tidal": "tidal",
    "amazon": "amazonMusic",
    "pandora": "pandora",
    "bandcamp": "bandcamp",
}


def _odesli_extras(links):
    """Canonical {platform: exact_url} for the long-tail platforms carried in a door
    row's Odesli link map — Tidal / Amazon Music / Pandora / Bandcamp. `links` is the
    parsed links_json dict OR the raw links_json string; the result is keyed by our
    canonical names (see _ODESLI_EXTRA_KEYS), omitting any platform absent or not a
    non-empty string. A pure lookup — no network."""
    if not isinstance(links, dict):
        try:
            links = json.loads(links or "{}")
        except (ValueError, TypeError):
            return {}
        if not isinstance(links, dict):
            return {}
    out = {}
    for canon, okey in _ODESLI_EXTRA_KEYS.items():
        u = links.get(okey)
        if isinstance(u, str) and u:
            out[canon] = u
    return out


def _merge_platforms(base, door):
    """Union the row's own confirmed platforms (`base` — Deezer from availability +
    the exact catalog Apple link) with the door cache's (`door` — Spotify / Apple /
    YouTube) into ONE map in the canonical big-four order. `base` wins a key clash:
    the catalog's exact Apple link is authoritative over a door re-resolve of the
    same platform."""
    if not door:
        return base
    merged = dict(door)
    merged.update(base)
    return db.confirmed_platforms(
        spotify_url=merged.get("spotify"), apple_url=merged.get("apple"),
        youtube_url=merged.get("youtube"), deezer_url=merged.get("deezer"),
        tidal_url=merged.get("tidal"), amazon_url=merged.get("amazon"),
        pandora_url=merged.get("pandora"), bandcamp_url=merged.get("bandcamp"))


def _platform_filter(albums, platforms):
    """Keep only albums whose CONFIRMED platforms intersect `platforms` (an iterable
    of platform keys). Honesty guardrail: an album's `platforms` map holds only
    confirmed-exact links, so an un-crawled ('unknown') album has an empty map and
    never matches — it's hidden under the opt-in filter, and still shown in dig mode
    (which never passes a filter). An empty/None `platforms` request is a no-op (the
    filter isn't active). Order is preserved."""
    if not platforms:
        return albums
    wanted = set(platforms)
    return [a for a in albums
            if wanted & set((a.get("platforms") or {}).keys())]


def _door_platforms(*, apple=None, spotify=None, youtube=None, links=None):
    """The CONFIRMED platforms the door resolved (exact links only) — what the
    frontend merges onto the album's `platforms` map. Deezer is NOT here: it's an
    availability fact carried on the row, not resolved by the door. The long-tail
    platforms (Tidal / Amazon Music / Pandora / Bandcamp) are mined from `links` —
    the parsed Odesli links_json dict OR the raw string — via _odesli_extras, and are
    permanent like the row's other Odesli links (apple/spotify/youtube are passed
    explicitly because they come from dedicated columns / have fallback logic)."""
    extras = _odesli_extras(links)
    return db.confirmed_platforms(
        apple_url=apple, spotify_url=spotify, youtube_url=youtube,
        tidal_url=extras.get("tidal"), amazon_url=extras.get("amazon"),
        pandora_url=extras.get("pandora"), bandcamp_url=extras.get("bandcamp"))


def _door_unresolved(uid, source, status):
    """The lean door payload for a non-cacheable outcome (request error or an
    unknown uid): same shape as a resolved door, but every link is absent."""
    return {"uid": uid, "status": status, "source": source, "cover": None,
            "itunes_url": None, "apple_music_url": None, "spotify_url": None,
            "youtube_url": None, "platforms": {}, "links": {}, "fetched_at": None}


def _door_shape(uid, row, source):
    """A cached door_links row -> the dict the frontend merges onto an opened
    album. links_json is the full Odesli platform map (extra platforms beyond the
    three surfaced explicitly)."""
    try:
        links = json.loads(row["links_json"] or "{}")
    except (ValueError, TypeError):
        links = {}
    return {"uid": uid, "status": row["status"], "source": source,
            "cover": row["artwork_url"], "itunes_url": row["itunes_url"],
            "apple_music_url": row["apple_music_url"],
            "spotify_url": row["spotify_url"], "youtube_url": row["youtube_url"],
            "platforms": _door_platforms(apple=row["apple_music_url"],
                                         spotify=row["spotify_url"],
                                         youtube=row["youtube_url"],
                                         links=links),
            "links": links, "fetched_at": row["fetched_at"]}


def _parse_ts(ts):
    """A stored UTC stamp ('%Y-%m-%dT%H:%M:%SZ') -> aware datetime, or None if
    absent/unparseable."""
    if not ts:
        return None
    try:
        return datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def _spotify_fresh(ts, *, ttl_days=None, now=None):
    """Is a Spotify link stamped `ts` still inside its TTL window? A missing/bad
    stamp is never fresh (treated as absent -> re-resolved or dropped)."""
    when = _parse_ts(ts)
    if when is None:
        return False
    ttl = config.SPOTIFY_CACHE_TTL_DAYS if ttl_days is None else ttl_days
    now = now or datetime.now(timezone.utc)
    return (now - when) <= timedelta(days=ttl)


def _links_without_spotify(links_json):
    """Load a links_json blob and drop any `spotify` key, returning a plain dict."""
    try:
        links = json.loads(links_json or "{}")
    except (ValueError, TypeError):
        links = {}
    if not isinstance(links, dict):
        return {}
    links.pop("spotify", None)
    return links
