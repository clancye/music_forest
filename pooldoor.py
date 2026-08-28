"""
The lazy door resolver, streaming backfills, Spotify TTL machinery, and operator
telemetry for the pool -- extracted from pooldb.py (2026-08-08).

Unlike pooldb's fail-loud read path, everything here is BEST-EFFORT: nothing may
take serving down. It imports the shared _conn from poolconn (the leaf) -- never
from pooldb -- so the module graph stays acyclic (poolconn <- pooldoor <- pooldb);
pooldb re-exports these names for back-compat. Network resolvers stay lazy behind
_coverage_study(): importing pooldoor never loads ytmusicapi / requests.
"""
import json
import os
import sqlite3
import sys
from datetime import date, datetime, timedelta, timezone

import config
import db
import opsdb
from poolconn import LIVE, _conn  # LIVE == "live." after the BE2a split (else ""); prefixes the warmth tables
from poolshape import (
    _door_platforms,
    _door_shape,
    _door_unresolved,
    _links_without_spotify,
    _now,
    _parse_ts,
    _rep_release_id,
    _spotify_fresh,
)




# --------------------------------------------------------------------- the door
# The LAZY door: when a user OPENS one album, resolve its real cover + the exact
# per-platform streaming links (iTunes for the Apple link + upsized art, then an
# Odesli fan-out for Spotify/YouTube/...), and CACHE the result in a door_links
# table in pool.sqlite. This is what gives an MB-only album real art + links (a
# Discogs album already carries art/apple from the albums.db join-back; the door
# adds the platform fan-out). iTunes self-throttles ~3.1s/call/IP, so the door is
# strictly on-demand, one album at a time — never batched.

# {LIVE} is poolconn's live.sqlite schema prefix ("live." after the BE2a split, so the
# warmth tables live in the attached live DB; "" before it, so they stay in pool.sqlite
# byte-for-byte as before). DDL, reads, and writes all carry it so a post-split ensure
# CREATEs into live.sqlite, never back into the now-static pool.sqlite.
_DOOR_SCHEMA = (
    f"CREATE TABLE IF NOT EXISTS {LIVE}door_links (uid TEXT PRIMARY KEY, status TEXT, "
    "artwork_url TEXT, itunes_url TEXT, spotify_url TEXT, apple_music_url TEXT, "
    "youtube_url TEXT, links_json TEXT, fetched_at TEXT, spotify_fetched_at TEXT, "
    "apple_source TEXT)")

# Columns added to door_links after it first shipped; ALTER any pre-existing table
# up to the current shape so an older local/host pool.sqlite keeps working.
# `spotify_fetched_at` timestamps the on-demand Spotify link INDEPENDENTLY of the
# row's `fetched_at` (the Odesli cover/links stay permanent; only the Spotify link
# is TTL-bounded — see backfill_spotify / evict_stale_spotify).
# `apple_source` is the PROVENANCE of apple_music_url — 'upc' (exact barcode lookup),
# 'name' (the guarded fuzzy name-match, 2b), or NULL (the door/Odesli seed path or the
# art-cache fold). It exists so the fuzzy name-match badges are auditable and reversible
# in one query (UPDATE … SET apple_music_url=NULL, apple_source=NULL WHERE apple_source='name').
_DOOR_ADDED_COLUMNS = (("spotify_fetched_at", "TEXT"), ("apple_source", "TEXT"))

_DOOR_POOL_SELECT = (
    "SELECT p.uid, p.source, p.artist, p.title, p.release_ids, "
    "a.deezer_url AS deezer_url "
    f"FROM pool p LEFT JOIN {LIVE}availability a ON a.uid = p.uid WHERE p.uid = ?")

_DOOR_CACHE_SELECT = (
    "SELECT uid, status, artwork_url, itunes_url, spotify_url, apple_music_url, "
    "youtube_url, links_json, fetched_at, spotify_fetched_at "
    f"FROM {LIVE}door_links WHERE uid = ?")

_CS = [None]


def _coverage_study():
    """Lazy-import tools/coverage_study (the validated resolver cascade). Imported
    on the first real door fetch only, so importing pooldb stays cheap and nothing
    network-facing loads unless the door is actually hit."""
    if _CS[0] is None:
        tools_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools")
        if tools_dir not in sys.path:
            sys.path.insert(0, tools_dir)
        import coverage_study
        _CS[0] = coverage_study
    return _CS[0]


def _door_profile():
    """The bounded fast-fail HTTP profile for the user-facing door (config.DOOR_
    HTTP_*). The door is on the request path, so each upstream call must return in
    seconds, not stall for minutes past the gunicorn worker timeout. Read fresh
    each call so a test (or env) override takes effect."""
    return {"timeout": config.DOOR_HTTP_TIMEOUT, "tries": config.DOOR_HTTP_TRIES,
            "backoff": config.DOOR_HTTP_BACKOFF}


def _resolve_with(artist, title, *, itunes_kw, odesli_kw):
    """Shared door resolve: one throttled iTunes album search (exact Apple link +
    upsized cover), then an Odesli fan-out from that seed for the per-platform exact
    links. `itunes_kw`/`odesli_kw` are the per-call _get retry profiles (empty =
    each function's patient default). Returns {status, artwork_url, itunes_url,
    links}; status is 'ok' (matched), 'miss' (API answered, no match) or 'err'
    (request failed)."""
    cs = _coverage_study()
    hit, url, artwork, err = cs.itunes_door(artist, title, **itunes_kw)
    if err:
        return {"status": "err"}
    if not hit:
        return {"status": "miss", "artwork_url": None, "itunes_url": None,
                "links": {}}
    links, lerr = cs.odesli_links(url, **odesli_kw) if url else ({}, False)
    return {"status": "ok", "artwork_url": artwork, "itunes_url": url,
            "links": None if lerr else links}


def _default_resolver(artist, title):
    """The ON-DEMAND door resolver (the request path). Uses the BOUNDED fast-fail
    profile (config.DOOR_HTTP_*) for both upstream calls, so a slow/throttled
    iTunes/Odesli returns 'err' in seconds — and an 'err' is NOT cached by
    door_links, so the next open retries; the request never hangs for minutes.

    NOTE: iTunes 403-throttles Render's shared egress IP, so ON THE HOST this
    resolver almost always fast-fails to 'err' (graceful — the album keeps its
    search links). Real cover/link resolution happens LOCALLY via patient_resolver
    (tools/prewarm_door.py), whose results ride up in pool.sqlite's door_links."""
    prof = _door_profile()
    return _resolve_with(artist, title, itunes_kw=prof, odesli_kw=prof)


def patient_resolver(artist, title):
    """The OFF-REQUEST-PATH door resolver for the LOCAL nightly prewarm
    (tools/prewarm_door.py). Uses each upstream's patient defaults (iTunes
    tries=5/backoff=3.0, Odesli tries=4/backoff=6.0) — right off Render's blocked
    egress, where iTunes actually answers and a retry is worth the wait."""
    return _resolve_with(artist, title, itunes_kw={}, odesli_kw={})


def _resolve_from_apple(apple_url, artwork_url, *, odesli_kw):
    """Door resolve for a Discogs album that ALREADY has an exact Apple link (from
    the albums.db art cache): seed Odesli's fan-out DIRECTLY from that Apple URL —
    NO iTunes call — so the per-platform exact links resolve LIVE on Render (iTunes
    is the only upstream 403-blocked there; Odesli's egress is open and fast). The
    Apple link stays the known-exact one and artwork is the catalog's, so the
    status is always 'ok' (the album IS confirmed on Apple) even if Odesli is
    rate-limited and returns no extra platforms. Same shape as _resolve_with.

    An Odesli REQUEST failure returns links=None ('fan-out not resolved') rather than
    {} ('resolved, nothing to add'), so door_links caches the confirmed Apple link +
    cover but leaves links_json NULL and the crawler re-tries the fan-out later. The
    album stays honestly available either way — only the extra platforms wait."""
    cs = _coverage_study()
    links, lerr = cs.odesli_links(apple_url, **odesli_kw) if apple_url else ({}, False)
    return {"status": "ok", "artwork_url": artwork_url, "itunes_url": apple_url,
            "links": None if lerr else links}


def _resolve_from_deezer(deezer_url, *, odesli_kw):
    """Door resolve for any AVAILABLE album using its exact Deezer album link as the
    Odesli seed — the path for MB-only and seedless-Discogs albums (no Apple seed,
    and iTunes is 403-blocked on Render). Odesli fans out to Spotify / Apple / YouTube
    and returns a cover thumbnail for art-less rows.

    An Odesli REQUEST failure returns a SPARSE 'ok' — NOT 'err' — with links=None
    (unresolved) and no cover. The album's availability is a Deezer FACT independent
    of Odesli, so the door still deserves an 'ok' anchor row; links=None marks the
    fan-out incomplete (see _door_links_incomplete) so it retries if Odesli ever comes
    back. This is the DECOUPLE (2026-08-26): Odesli retired keyless access on
    2026-08-19 (permanent 401), which used to make this return 'err' -> door_links
    cached NOTHING -> the independent Spotify/Apple/YouTube backfills all returned
    'skip' (they only fill an existing 'ok' row, never create one), so today's whole
    streaming window went empty. Returning a Deezer-confirmed 'ok' gives those
    resolvers the anchor they need. Tidal/Pandora/Amazon still wait on the fan-out
    (Odesli-only), but Deezer is already confirmed and the rest fill live."""
    cs = _coverage_study()
    links, art, err = cs.odesli_door(deezer_url, **odesli_kw)
    if err:
        return {"status": "ok", "artwork_url": None, "itunes_url": None, "links": None}
    return {"status": "ok", "artwork_url": art, "itunes_url": None, "links": links}


def _current_fresh_spotify(uid, *, ttl_days=None, now=None):
    """The row's stored Spotify link IFF it is still within its TTL, else None — a
    stale link is NEVER surfaced (so it can't outlive its window even before the
    eviction sweep runs). Pure read."""
    with _conn() as c:
        _ensure_door_table(c)
        row = c.execute(f"SELECT spotify_url, spotify_fetched_at FROM {LIVE}door_links "
                        "WHERE uid = ?", (uid,)).fetchone()
    if row is None or not row["spotify_url"]:
        return None
    # Unstamped -> Odesli-sourced, permanent (not TTL-managed); always surfaced.
    if row["spotify_fetched_at"] is None:
        return row["spotify_url"]
    if not _spotify_fresh(row["spotify_fetched_at"], ttl_days=ttl_days, now=now):
        return None
    return row["spotify_url"]


def _apply_door_spotify(uid, prow, result):
    """On the request path: fill/refresh this opened album's Spotify link via the
    TTL-bounded temporary cache (backfill_spotify), then reflect the current, fresh
    link — or its removal — into the door `result` (spotify_url + links + platforms).
    Best-effort: any failure leaves the door untouched. Only meaningful for an 'ok'
    door (a 'miss'/unresolved outcome has no album to look up). This is what makes
    Spotify surface at runtime for any album on any day, without a stored index."""
    if not result or result.get("status") != "ok":
        return result
    try:
        backfill_spotify(uid)
    except Exception:
        pass                                    # never let Spotify break the door
    try:
        sp = _current_fresh_spotify(uid)
    except Exception:
        return result
    result["spotify_url"] = sp
    links = dict(result.get("links") or {})
    if sp:
        links["spotify"] = sp
    else:
        links.pop("spotify", None)
    result["links"] = links
    result["platforms"] = _door_platforms(apple=result.get("apple_music_url"),
                                           spotify=sp,
                                           youtube=result.get("youtube_url"),
                                           links=links)
    return result


def _door_links_incomplete(row):
    """True for a cached 'ok' row whose Odesli fan-out never landed — links_json is
    NULL, not '{}'. NULL is written only when the fan-out REQUEST failed (see
    _resolve_from_apple); '{}' means Odesli answered and had nothing to add, which is
    a real verdict worth keeping forever. Only the crawler acts on this: it re-tries
    the fan-out on the next lap instead of skipping the row as resolved, so an
    upstream auth outage costs a retry rather than permanently sparse links."""
    return row["status"] == "ok" and row["links_json"] is None


def _odesli_auth_dead():
    """True once coverage_study has latched song.link's keyless API as permanently
    auth-blocked (401 PUBLIC_API_ACCESS_DEPRECATED, 2026-08-19). Reads the latch only
    if the resolver module is ALREADY loaded — never force-imports it (this runs on
    the door read/guard path, which must stay cheap and network-free). When dead, the
    crawler must NOT re-resolve an incomplete row every lap: the fan-out can't land, so
    re-resolving only re-writes a sparse row and (via INSERT OR REPLACE) would wipe the
    youtube/apple links the independent backfills just filled — re-spending iTunes
    quota endlessly. Treating the row as resolved lets those fills accumulate."""
    cs = _CS[0]
    if cs is None:
        return False
    fn = getattr(cs, "songlink_auth_dead", None)   # test fakes won't define it -> False
    return bool(fn()) if callable(fn) else False


def door_links(uid, *, resolver=None):
    """Lazily resolve + CACHE the door for ONE opened album (by uid), returning the
    cover + per-platform exact links to merge onto the album's story view.

    Cache (a door_links row in pool.sqlite, keyed by uid): a resolved 'ok' or a
    genuine 'miss' is cached, so a reopen is free; a request 'err' (throttle /
    network) is NOT cached, so the next open retries. An unknown uid returns a lean
    'unknown' payload without touching the resolver. `resolver(artist, title)` is
    injectable for tests (no network); the default is the iTunes+Odesli cascade.

    Three resolve strategies, in preference order — both seed strategies fan out
    LIVE on Render (Odesli's egress is open there; only iTunes is 403-blocked):
     - A Discogs album whose albums.db art carries an EXACT Apple link seeds Odesli
       from it (no iTunes). The injected `resolver` is bypassed here.
     - Otherwise, any AVAILABLE album (it has an exact `deezer_url`) seeds Odesli
       from THAT — the live path for MB-only and seedless-Discogs albums, which used
       to be reachable only via the local iTunes prewarm. Resolver bypassed.
     - Only an album with neither seed (e.g. an unavailable dig-mode album someone
       opens) falls to the iTunes->Odesli `resolver` — bounded fast-fail on the
       request path, patient on the local prewarm. Tests inject `resolver` via a
       seedless, deezer-less uid."""
    # B21: the Spotify on-demand fill belongs to the REQUEST path (a real user
    # opening one album) — NEVER the patient crawler drive. Routing crawler
    # calls through _apply_door_spotify made the forever calendar walk a
    # calendar-wide Spotify search loop (the exact thing the Developer Terms +
    # CLAUDE.md forbid) that burned the dev-mode app's whole daily quota within
    # ~30 min of each reset, 429-blocking the app for the other ~23.5 h. The
    # crawler's Spotify counterpart is the CAPPED prewarm_spotify pass.
    crawler_driven = resolver is patient_resolver
    resolver = resolver or _default_resolver
    with _conn() as c:
        _ensure_door_table(c)
        prow = c.execute(_DOOR_POOL_SELECT, (uid,)).fetchone()
        cached = c.execute(_DOOR_CACHE_SELECT, (uid,)).fetchone()
    if prow is None:
        return _door_unresolved(uid, None, "unknown")
    source = prow["source"]
    if (cached is not None and cached["status"] in ("ok", "miss")
            and not (crawler_driven and _door_links_incomplete(cached)
                     and not _odesli_auth_dead())):
        shaped = _door_shape(uid, cached, source)
        return shaped if crawler_driven else _apply_door_spotify(uid, prow, shaped)

    rid = _rep_release_id(prow) if source == "discogs" else None
    seed_apple, seed_art = (db.door_seed_for(rid) if rid is not None
                            else (None, None))
    # Patient upstream when the prewarm drives the door; bounded fast-fail on the
    # user request path. The patient drive ALSO paces song.link to its free-tier rate
    # (throttle=True) so a cold-cache day can't over-run the endpoint into a 429
    # penalty that stalls the whole crawl (BE2f); the request path never waits.
    odesli_kw = ({"throttle": True} if crawler_driven
                 else {**_door_profile(), "throttle": False})
    if seed_apple:
        res = _resolve_from_apple(seed_apple, seed_art, odesli_kw=odesli_kw)
    elif prow["deezer_url"]:
        res = _resolve_from_deezer(prow["deezer_url"], odesli_kw=odesli_kw)
    else:
        res = resolver(prow["artist"] or "", prow["title"] or "")
    status = res.get("status", "err")
    if status == "err":
        return _door_unresolved(uid, source, "err")

    # links is None when the Odesli fan-out FAILED (auth/network) as opposed to {}
    # when it answered with nothing to add. The row is still cached — its Apple/cover
    # /Deezer facts are real — but links_json stays NULL so _door_links_incomplete
    # sends the crawler back for the fan-out instead of skipping it as resolved.
    links_unresolved = res.get("links") is None
    links = res.get("links") or {}
    itunes_url = res.get("itunes_url")
    artwork = res.get("artwork_url")
    spotify = links.get("spotify")
    apple = links.get("appleMusic") or itunes_url
    youtube = links.get("youtubeMusic") or links.get("youtube")
    fetched_at = _now()
    with _conn() as c:
        _ensure_door_table(c)
        c.execute(
            f"INSERT OR REPLACE INTO {LIVE}door_links (uid, status, artwork_url, "
            "itunes_url, spotify_url, apple_music_url, youtube_url, links_json, "
            "fetched_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (uid, status, artwork, itunes_url, spotify, apple, youtube,
             None if links_unresolved else json.dumps(links), fetched_at))
    shaped = {
        "uid": uid, "status": status, "source": source, "cover": artwork,
        "itunes_url": itunes_url, "apple_music_url": apple,
        "spotify_url": spotify, "youtube_url": youtube,
        "platforms": _door_platforms(apple=apple, spotify=spotify,
                                     youtube=youtube, links=links),
        "links": links, "fetched_at": fetched_at}
    return shaped if crawler_driven else _apply_door_spotify(uid, prow, shaped)


def _ensure_door_table(c):
    c.execute(_DOOR_SCHEMA)
    have = {r[1] for r in c.execute(f"PRAGMA {LIVE}table_info(door_links)")}
    for name, decl in _DOOR_ADDED_COLUMNS:
        if name not in have:
            c.execute(f"ALTER TABLE {LIVE}door_links ADD COLUMN {name} {decl}")


def _ytmusic_resolver():
    """coverage_study.ytmusic_album, or None if the cascade module doesn't expose it
    (e.g. a test that injected a stand-in coverage_study). Loaded via the same lazy
    importer as the door, so pooldb import stays cheap and ytmusicapi is only touched
    when the local crawler actually backfills."""
    return getattr(_coverage_study(), "ytmusic_album", None)


def backfill_youtube(uid, *, resolver=None):
    """LOCAL-CRAWLER-ONLY: fill an already-cached door row's EMPTY youtube_url from
    the keyless YouTube Music crawler. Odesli returns YouTube for our (mostly MB-only)
    catalogue almost never, so this pass is what makes `youtube` a real confirmable
    platform; the read side (_cached_door_platforms) folds the populated column into
    a row's `platforms` with no further change. NEVER call on the request path —
    ytmusicapi isn't a hosted dep and the search isn't bounded for a gunicorn worker.

    Resumable + honest. Only a cached 'ok' door row with an EMPTY youtube_url is a
    candidate: a filled row is skipped (free re-run), and a 'miss'/'err' door row is
    never touched. On a crawler hit we UPDATE only youtube_url and fold `youtubeMusic`
    into links_json — nothing else in the row changes. `resolver(artist, title) ->
    (hit, url, err)` is injectable for tests; the default is
    coverage_study.ytmusic_album, which itself no-ops when ytmusicapi is absent.

    Returns one of: 'filled' (a URL was written), 'have' (already had YouTube), 'skip'
    (no cached 'ok' row / uid not in pool), 'miss' (crawler found nothing), 'err'
    (crawler request failed), 'absent' (no ytmusic resolver available)."""
    with _conn() as c:
        _ensure_door_table(c)
        prow = c.execute(_DOOR_POOL_SELECT, (uid,)).fetchone()
        cached = c.execute(_DOOR_CACHE_SELECT, (uid,)).fetchone()
    if prow is None or cached is None or cached["status"] != "ok":
        return "skip"
    if cached["youtube_url"]:
        return "have"
    resolver = resolver or _ytmusic_resolver()
    if resolver is None:
        return "absent"
    hit, url, err = resolver(prow["artist"] or "", prow["title"] or "")
    if err:
        return "err"
    if not hit or not url:
        return "miss"
    try:
        links = json.loads(cached["links_json"] or "{}")
    except (ValueError, TypeError):
        links = {}
    if not isinstance(links, dict):
        links = {}
    links.setdefault("youtubeMusic", url)
    with _conn() as c:
        _ensure_door_table(c)
        c.execute(
            f"UPDATE {LIVE}door_links SET youtube_url = ?, links_json = ? WHERE uid = ?",
            (url, json.dumps(links), uid))
    return "filled"


# --------------------------------------------------- on-demand Spotify (TTL cache)
# Odesli returns Spotify for ~0% of this (mostly MusicBrainz-only) catalogue, so
# `spotify` only becomes a confirmed platform via a DIRECT Spotify Search call. We
# make that call ON REAL USER DEMAND (when someone opens an album's door) and cache
# the link only TEMPORARILY — a rolling TTL window — so it stays a performance cache
# under the Spotify Developer Terms (v10 §IV.3.b), never a permanent index
# (§IV.3.a.i / §IX.8.7). NEVER add this to the forever full-calendar crawl_doors.sh
# loop: a calendar-wide crawl would be the §IV.2.d.i spider/index the Terms forbid.

def _spotify_configured():
    """Does THIS host actually hold Spotify creds — i.e. can a call go out at all?

    The burn counter needs this because `coverage_study.spotify_album` no-ops CLEANLY
    without creds: it returns (False, None, False), byte-identical to a genuine
    no-match. Counting that would report quota spent on a box that never called
    anything — a dev sim, the public tree, a lapsed app — and this panel's whole job is
    to be an honest read of a shared, invisible budget. Prod holds creds, so every call
    counted there is a real Search.
    Read from the env, not config, because that's where coverage_study reads them (and
    it re-reads until they appear, so a mid-life config change is picked up)."""
    return bool(os.environ.get("SPOTIFY_CLIENT_ID")
                and os.environ.get("SPOTIFY_CLIENT_SECRET"))


def _spotify_resolver():
    """coverage_study.spotify_album, or None if the cascade module doesn't expose it
    (e.g. a test that injected a stand-in coverage_study). Lazy via the same importer
    as the door, so pooldb import stays cheap and no Spotify token is minted unless an
    album's door is actually opened."""
    return getattr(_coverage_study(), "spotify_album", None)


def _clear_spotify(c, uid, links_json):
    """NULL a row's Spotify link + stamp and strip `spotify` from links_json —
    column-level, so the shared Odesli/YouTube cache in the row is untouched."""
    links = _links_without_spotify(links_json)
    c.execute(
        f"UPDATE {LIVE}door_links SET spotify_url = NULL, spotify_fetched_at = NULL, "
        "links_json = ? WHERE uid = ?", (json.dumps(links), uid))


def backfill_spotify(uid, *, resolver=None, ttl_days=None, now=None):
    """ON-DEMAND (safe on the request path): fill or refresh a cached 'ok' door row's
    Spotify link from the DIRECT Spotify Search resolver (coverage_study.spotify_
    album), TTL-bounded so the link stays a TEMPORARY performance cache and never a
    permanent index. Unlike backfill_youtube (ytmusicapi, unbounded, prewarm-only)
    this is one bounded Search call for the single album a real user is looking at.

    Honest + self-cleaning. Only a cached 'ok' row is a candidate (a 'miss'/'err'
    row or an unknown uid is never touched -> 'skip'). A link still inside its TTL is
    left alone -> 'have'. Otherwise (absent OR stale) we re-resolve:
      - hit  -> write spotify_url + spotify_fetched_at, fold `spotify` into
                links_json                                          -> 'filled'
      - miss -> a STALE link is deleted (a confirmed no-match now is authoritative);
                an already-absent link stays absent          -> 'evicted' / 'miss'
      - err  -> transient; the row is left as-is (the read rule still hides a stale
                link, the sweep still deletes a truly-aged one)     -> 'err'
    With NO resolver available (no creds / a lapsed app) a stale link is deleted so
    it can't linger past its window -> 'evicted'; an absent one -> 'absent'. This is
    what makes termination cleanup automatic once spotify_album() no-ops.

    `resolver(artist, title) -> (hit, url, err)` is injectable for tests; the default
    is coverage_study.spotify_album (itself a no-op without creds)."""
    now_dt = now or datetime.now(timezone.utc)
    with _conn() as c:
        _ensure_door_table(c)
        prow = c.execute(_DOOR_POOL_SELECT, (uid,)).fetchone()
        cached = c.execute(_DOOR_CACHE_SELECT, (uid,)).fetchone()
    if prow is None or cached is None or cached["status"] != "ok":
        return "skip"
    existing = cached["spotify_url"]
    stamp = cached["spotify_fetched_at"]
    # An UNSTAMPED spotify_url came from Odesli (song.link), NOT the Spotify Platform,
    # so it's on the same footing as the row's Tidal/Deezer links — permanent, and
    # NOT subject to the Spotify Developer Terms TTL. Only OUR directly-resolved links
    # (which carry a spotify_fetched_at stamp) are TTL-managed.
    if existing and stamp is None:
        return "have"
    if existing and _spotify_fresh(stamp, ttl_days=ttl_days, now=now_dt):
        return "have"
    resolver = resolver or _spotify_resolver()
    if resolver is None:
        if existing:                       # stale + can't refresh -> drop, don't linger
            with _conn() as c:
                _ensure_door_table(c)
                _clear_spotify(c, uid, cached["links_json"])
            return "evicted"
        return "absent"
    hit, url, err = resolver(prow["artist"] or "", prow["title"] or "")
    # A Search just went out — this is the ONLY line in the app that spends Spotify
    # quota, so it's the only honest place to count it. Everything above short-circuits
    # on the cache ('have'/'skip') or on having no resolver, and spends nothing.
    # Counted per-host (opsdb): on prod that's real users' door opens — the half of the
    # ~780/day budget that grows with every person invited and was never measured; on
    # the Mac it's the prewarm's own burn. A miss/err costs a Search just like a hit,
    # so all three outcomes count — but only where creds mean a call could REALLY go
    # out (see _spotify_configured: a credless no-op is shaped exactly like a no-match).
    if _spotify_configured():
        opsdb.record_spotify_search(
            "err" if err else ("filled" if (hit and url) else "miss"), now=now_dt)
    if err:
        return "err"                       # transient: leave the row as-is
    if not hit or not url:
        if existing:                       # confirmed no-match now -> drop the stale link
            with _conn() as c:
                _ensure_door_table(c)
                _clear_spotify(c, uid, cached["links_json"])
            return "evicted"
        return "miss"
    links = _links_without_spotify(cached["links_json"])
    links["spotify"] = url
    stamp = now_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    with _conn() as c:
        _ensure_door_table(c)
        c.execute(
            f"UPDATE {LIVE}door_links SET spotify_url = ?, spotify_fetched_at = ?, "
            "links_json = ? WHERE uid = ?", (url, stamp, json.dumps(links), uid))
    return "filled"


def backfill_apple_by_upc(uid, upcs, *, resolver=None):
    """Lift Apple coverage on an ALREADY-resolved door row that has no apple_music_url,
    by an EXACT iTunes UPC lookup — the fuzzy artist+title search only hits ~2% of this
    deep/MB catalogue, while ~30% of it carries a UPC. `upcs` is the album's barcodes
    (the lap reads them from albums.db); `resolver(upc) -> (hit, url, artwork, err)` is
    injectable (default coverage_study.itunes_lookup_by_upc).

    Deliberately UPDATE-only: it never CREATES a door_links row, so an un-crawled uid
    is left for the door crawl to reach first (creating a bare 'ok' row here would wall
    off its youtube/tidal resolve). Column-level — sets apple_music_url (+ artwork_url
    if the row had none), touches nothing else, and the door surfaces the column
    directly. Returns 'have' (already on Apple), 'filled', 'miss', 'err', or 'skip'."""
    resolver = resolver or getattr(_coverage_study(), "itunes_lookup_by_upc", None)
    if resolver is None:
        return "skip"
    ups = [u for u in (upcs or []) if u]
    with _conn() as c:
        _ensure_door_table(c)
        row = c.execute(
            f"SELECT apple_music_url, artwork_url FROM {LIVE}door_links WHERE uid = ?",
            (uid,)).fetchone()
    if row is None:
        return "skip"                     # not crawled yet — the door reaches it first
    if row["apple_music_url"]:
        return "have"                     # already confirmed on Apple
    if not ups:
        return "skip"
    hit_url = hit_art = None
    saw_err = False
    for upc in ups:
        ok, url, art, err = resolver(upc)
        if ok and url:
            hit_url, hit_art = url, art
            break
        if err:
            saw_err = True
    if hit_url is None:
        return "err" if saw_err else "miss"   # err is retryable; miss is a real 'no'
    _set_door_apple(uid, hit_url, hit_art, source="upc")
    return "filled"


def backfill_apple_by_name(uid, artist, title, *, resolver=None):
    """Lift Apple coverage on an ALREADY-resolved, no-Apple door row by a GUARDED fuzzy
    artist+title name-search — the fallback (design 2b) for the ~46% of the pool that
    carries NO UPC, so the exact backfill_apple_by_upc can't reach it. `resolver(artist,
    title) -> (hit, url, artwork, err)` is injectable (default
    coverage_study.itunes_lookup_by_name), which filters to _is_match_strict: the shared
    honesty gate + artist-agreement + serial guards, measured ~100% precise on an
    owner-labeled barcodeless sample (vs ~91% for the bare gate).

    Same contract as backfill_apple_by_upc: UPDATE-only (never CREATES a row — the door
    crawl reaches an un-crawled uid first), no-op if Apple is already set, and it stamps
    apple_source='name' so these fuzzy badges are auditable + reversible in one query.
    Exact-UPC always runs first; call this ONLY for a record with no UPC. Returns 'have',
    'filled', 'miss', 'err', or 'skip'."""
    resolver = resolver or getattr(_coverage_study(), "itunes_lookup_by_name", None)
    if resolver is None or not (artist or title):
        return "skip"
    with _conn() as c:
        _ensure_door_table(c)
        row = c.execute(
            f"SELECT apple_music_url FROM {LIVE}door_links WHERE uid = ?", (uid,)).fetchone()
    if row is None:
        return "skip"                         # not crawled yet — the door reaches it first
    if row["apple_music_url"]:
        return "have"                         # already confirmed on Apple
    ok, url, art, err = resolver(artist or "", title or "")
    if err:
        return "err"                          # retryable (throttle/transport)
    if not ok or not url:
        return "miss"                         # answered, no confident match -> honest 'no'
    _set_door_apple(uid, url, art, source="name")
    return "filled"


def _set_door_apple(uid, url, artwork=None, source=None):
    """UPDATE-only write of a CONFIRMED Apple link onto an EXISTING door row: sets
    apple_music_url (+ its `apple_source` provenance), and fills artwork_url only where
    the row has none (COALESCE — a cover the door already resolved always wins). Shared
    by the Apple lifts (backfill_apple_by_upc='upc', backfill_apple_by_name='name',
    backfill_apple_from_art) so they can never drift on what "filling Apple" means."""
    with _conn() as c:
        _ensure_door_table(c)
        if artwork:
            c.execute(
                f"UPDATE {LIVE}door_links SET apple_music_url = ?, apple_source = ?, "
                "artwork_url = COALESCE(NULLIF(artwork_url, ''), ?) WHERE uid = ?",
                (url, source, artwork, uid))
        else:
            c.execute(f"UPDATE {LIVE}door_links SET apple_music_url = ?, apple_source = ? "
                      "WHERE uid = ?", (url, source, uid))


def backfill_apple_from_art(uid, apple_url, *, artwork=None):
    """Fill Apple on an ALREADY-crawled door row from a link we ALREADY hold — no
    network. `apple_url` comes from albums.db's `art` cache, which fetch_art.py fills
    as a byproduct of pulling cover art from iTunes (it keeps the collectionViewUrl).

    WHY THIS EXISTS. Those links reached NOBODY. The art cache lives in albums.db
    (~8GB, never whole-file rsync'd — the 2026-07-08 disk incident), and Render can't
    rebuild it because iTunes 403s there (see db.py's art_for). So ~36k confirmed Apple
    links sat on the owner's Mac while prod served 3.6k. door_links lives in
    pool.sqlite, which the crawler rsyncs daily — same confirmed link, shippable home.

    Same contract as backfill_apple_by_upc: UPDATE-only (never CREATES a row — an
    un-crawled uid is left for the door crawl to reach first, since a bare 'ok' row
    would wall off its youtube/tidal resolve), column-level, and EXACT links only (the
    art cache never stores a search fallback). Returns 'have', 'filled', or 'skip' —
    there is no 'miss'/'err' because nothing is being asked, so nothing can fail."""
    if not apple_url:
        return "skip"
    with _conn() as c:
        _ensure_door_table(c)
        row = c.execute(
            f"SELECT apple_music_url FROM {LIVE}door_links WHERE uid = ?", (uid,)).fetchone()
    if row is None:
        return "skip"                     # not crawled yet — the door reaches it first
    if row["apple_music_url"]:
        return "have"                     # already confirmed on Apple
    _set_door_apple(uid, apple_url, artwork)
    return "filled"


def evict_stale_spotify(*, ttl_days=None, now=None):
    """Sweep the whole door cache and delete every Spotify link whose TTL has expired
    (and any Spotify link with a missing/bad stamp), column-level. The rolling-window
    enforcer for rows nobody has reopened. Pure Spotify — Odesli cover/links are never
    touched. Returns the count evicted."""
    now_dt = now or datetime.now(timezone.utc)
    n = 0
    with _conn() as c:
        _ensure_door_table(c)
        # Only OUR directly-resolved links (stamped) are TTL-managed; unstamped
        # Odesli-sourced spotify links are left alone (see backfill_spotify).
        rows = c.execute(
            f"SELECT uid, links_json, spotify_fetched_at FROM {LIVE}door_links "
            "WHERE spotify_url IS NOT NULL AND spotify_url <> '' "
            "AND spotify_fetched_at IS NOT NULL").fetchall()
        for r in rows:
            if not _spotify_fresh(r["spotify_fetched_at"], ttl_days=ttl_days,
                                  now=now_dt):
                _clear_spotify(c, r["uid"], r["links_json"])
                n += 1
    return n


def purge_spotify():
    """Delete EVERY Spotify link everywhere (column + links_json), unconditionally —
    the one-shot cleanup for Spotify Developer Terms §IX.8.7 (on termination /
    discontinuance, delete all Spotify Content, including from your servers). Safe to
    run locally and on the host. Returns the count purged."""
    n = 0
    with _conn() as c:
        _ensure_door_table(c)
        rows = c.execute(
            f"SELECT uid, links_json FROM {LIVE}door_links "
            "WHERE (spotify_url IS NOT NULL AND spotify_url <> '') "
            "OR links_json LIKE '%spotify%'").fetchall()
        for r in rows:
            _clear_spotify(c, r["uid"], r["links_json"])
            n += 1
    return n


# ----------------------------------------------------- Spotify daily-found log
# An APPEND-ONLY trail of how many of a day's AVAILABLE pool got a confirmed
# Spotify link on each prewarm run — owner-requested metadata (2026-07-14). It's
# Terms-safe: it stores COUNTS, never a cached link. Its diagnostic value is
# spotting a STALLED prewarm — a run of found=0, or simply no recent rows, which
# is exactly how the 2026-07-08 agent-unload hid: warming stopped, every later
# day drained to 0 Spotify within the 2-day TTL, and nothing surfaced it until the
# pool was queried by hand. (Distinct from the single-row crawl_status heartbeat:
# this keeps the HISTORY, so the trend/gap is visible, not just the latest run.)
_SPOTIFY_LOG_SCHEMA = (
    f"CREATE TABLE IF NOT EXISTS {LIVE}spotify_daily_log (warmed_date TEXT, run_at TEXT, "
    "pool_size INT, attempted INT, found INT, filled INT, miss INT, err INT, "
    "PRIMARY KEY (warmed_date, run_at))")


def _ensure_spotify_log_table(c):
    c.execute(_SPOTIFY_LOG_SCHEMA)


def record_spotify_day_log(warmed_date, *, pool_size, attempted, found,
                           filled, miss, err, run_at=None):
    """Append one day's Spotify-warm counts: `found` = confirmed links after the run
    (newly filled + already fresh), `filled` = newly resolved this run, `miss` =
    Spotify answered but no album matched, `err` = request errors. Returns the row
    written as a dict. COUNTS ONLY — never a link (Spotify Terms)."""
    run_at = run_at or _now()
    row = {"warmed_date": warmed_date, "run_at": run_at, "pool_size": int(pool_size),
           "attempted": int(attempted), "found": int(found), "filled": int(filled),
           "miss": int(miss), "err": int(err)}
    with _conn() as c:
        _ensure_spotify_log_table(c)
        c.execute(
            f"INSERT OR REPLACE INTO {LIVE}spotify_daily_log (warmed_date, run_at, pool_size, "
            "attempted, found, filled, miss, err) VALUES (?,?,?,?,?,?,?,?)",
            (row["warmed_date"], row["run_at"], row["pool_size"], row["attempted"],
             row["found"], row["filled"], row["miss"], row["err"]))
    return row


def spotify_log(limit=30):
    """Recent Spotify-warm log rows, newest first (pure read; [] on an older pool
    without the table — never creates it on the serving path)."""
    try:
        with _conn() as c:
            rows = c.execute(
                "SELECT warmed_date, run_at, pool_size, attempted, found, filled, "
                f"miss, err FROM {LIVE}spotify_daily_log ORDER BY run_at DESC LIMIT ?",
                (int(limit),)).fetchall()
    except sqlite3.OperationalError:
        return []
    return [dict(r) for r in rows]


# ----------------------------------------------------------- crawler heartbeat
# A single-row-per-source health record the LOCAL prewarm/crawler writes into
# pool.sqlite after each day. Because pool.sqlite delta-rsyncs up to the host, the
# operator console can read this WITHOUT shelling into the Mac or tailing a log:
# "last ran N min ago, day MM-DD, ok/err counts, throttled?". It carries no secrets
# (just counts + a timestamp); the /api/admin endpoint that serves it is what gates
# who can read it.

_CRAWL_SCHEMA = (
    f"CREATE TABLE IF NOT EXISTS {LIVE}crawl_status (id TEXT PRIMARY KEY, "
    "updated_at TEXT, day TEXT, seen INT, ok INT, miss INT, err INT, "
    "aborted INT, note TEXT, state TEXT, total INT)")

# Columns added after the table first shipped; ALTER any pre-existing crawl_status
# up to the current shape so an older local pool.sqlite keeps working.
_CRAWL_ADDED_COLUMNS = (("state", "TEXT"), ("total", "INT"))


def _ensure_crawl_table(c):
    c.execute(_CRAWL_SCHEMA)
    have = {r[1] for r in c.execute(f"PRAGMA {LIVE}table_info(crawl_status)")}
    for name, decl in _CRAWL_ADDED_COLUMNS:
        if name not in have:
            c.execute(f"ALTER TABLE {LIVE}crawl_status ADD COLUMN {name} {decl}")


def write_crawl_status(id="door", *, day=None, seen=0, ok=0, miss=0, err=0,
                       aborted=False, note=None, state=None, total=None):
    """Upsert the heartbeat row for a crawl source (default 'door'). Written by the
    local prewarm both mid-run (state='running', with a partial seen/total) and at
    day end (state='done' or 'throttled'); `updated_at` is stamped now (UTC)."""
    with _conn() as c:
        _ensure_crawl_table(c)
        c.execute(
            f"INSERT OR REPLACE INTO {LIVE}crawl_status (id, updated_at, day, seen, ok, "
            "miss, err, aborted, note, state, total) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (id, _now(), day, int(seen), int(ok), int(miss), int(err),
             1 if aborted else 0, note, state,
             None if total is None else int(total)))


def read_crawl_status(id="door"):
    """The heartbeat row for a crawl source as a dict (aborted -> bool), or None if
    nothing has been written yet (or the table doesn't exist on an older pool).

    Pure READ — never creates or alters the table. On the host this file is
    read-only (the local crawler is the only writer; the row arrives via the
    pool.sqlite rsync — though health now travels by HTTP push, not this row), so a
    CREATE/ALTER here would needlessly take a write lock on the serving path. A
    missing table just means 'no heartbeat yet' -> the SELECT raises
    OperationalError, which we map to None. SELECT * tolerates older column sets."""
    try:
        with _conn() as c:
            row = c.execute(
                f"SELECT * FROM {LIVE}crawl_status WHERE id = ?", (id,)).fetchone()
    except sqlite3.OperationalError:
        return None
    if row is None:
        return None
    d = dict(row)
    d["aborted"] = bool(d["aborted"])
    d.setdefault("state", None)
    d.setdefault("total", None)
    return d


# --- operator telemetry (H4 /admin attention panel) --------------------------
# Read-only aggregates over pool.sqlite for the admin console. Pure READs like
# read_crawl_status — never create/alter tables on the serving path.

def availability_runway(today=None):
    """How warm the availability calendar is, per day: one aggregate pass over
    pool LEFT JOIN availability grouped by (month, day).

    A day counts WARM when >= 99% of its pool rows carry a verdict (the lap and
    the crawler resolve whole days; the 1% tolerance absorbs a handful of
    persistently-errored rows), PARTIAL when it has some rows but isn't warm.
    `runway_days` walks forward from `today` through consecutive warm days —
    "how far ahead can any date serve a duel" — and `runway_end` is the MM-DD
    where that run stops.

    EXPENSIVE (~seconds on the ~2M-row pool): the server caches the result;
    don't call this per-request."""
    # The reader's day (ET), so "runway from today" counts the same days the app
    # actually serves — on a UTC box this walked from tomorrow all evening.
    today = today or config.today_local()
    try:
        with _conn() as c:
            rows = c.execute(
                "SELECT p.month, p.day, COUNT(*) AS n, "
                "SUM(CASE WHEN a.uid IS NOT NULL THEN 1 ELSE 0 END) AS resolved "
                f"FROM pool p LEFT JOIN {LIVE}availability a ON a.uid = p.uid "
                "GROUP BY p.month, p.day").fetchall()
    except sqlite3.OperationalError:
        return None
    warm, partial, resolved_total, pool_total = set(), 0, 0, 0
    for r in rows:
        pool_total += r["n"]
        resolved_total += r["resolved"]
        if r["n"] and r["resolved"] >= 0.99 * r["n"]:
            warm.add((r["month"], r["day"]))
        elif r["resolved"]:
            partial += 1
    # Walk the leap calendar (2024 holds Feb 29) forward from today.
    runway, runway_end = 0, None
    d = date(2024, today.month, today.day)
    while (d.month, d.day) in warm and runway < len(rows):
        runway += 1
        runway_end = f"{d.month:02d}-{d.day:02d}"
        d += timedelta(days=1)
    return {
        "total_days": len(rows), "warm_days": len(warm),
        "partial_days": partial, "runway_days": runway,
        "runway_end": runway_end,
        "pool_rows": pool_total, "resolved_rows": resolved_total,
    }


def spotify_stamp_stats(now=None):
    """The pulse of the stamped (TTL-managed) Spotify links: how many exist, how
    fresh the newest stamp is, and how many landed in the last 24 h. A healthy
    setup stamps daily (the capped prewarm + on-demand door fills); a silent
    24 h+ gap while stamps exist reads as quota-blocked or prewarm-asleep.
    Aggregated in SQL — stamps are uniform '%Y-%m-%dT%H:%M:%SZ' strings, so
    MAX() and a >= cutoff string-compare are correct — because door_links has
    hundreds of thousands of rows and this runs on the hosted request path."""
    now = now or datetime.now(timezone.utc)
    cutoff = (now - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        with _conn() as c:
            row = c.execute(
                "SELECT COUNT(*) AS stamped, MAX(spotify_fetched_at) AS newest, "
                "SUM(CASE WHEN spotify_fetched_at >= ? THEN 1 ELSE 0 END) "
                f"AS last24 FROM {LIVE}door_links WHERE spotify_fetched_at IS NOT NULL",
                (cutoff,)).fetchone()
    except sqlite3.OperationalError:
        return None
    newest = _parse_ts(row["newest"])
    age_h = None if newest is None else round(
        (now - newest).total_seconds() / 3600, 1)
    return {"stamped": row["stamped"], "stamped_24h": row["last24"] or 0,
            "newest_age_hours": age_h}
