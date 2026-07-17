"""
Pool-backed reads for the P3 unified daily-pick pool (phase 2a — additive).

Reads `config.POOL_DB_PATH` (data/pool.sqlite — built by tools/build_pool_db.py,
filled per-day by tools/precompute_availability.py). The daily pick draws from the
AVAILABLE pool (availability.listenable = 1); dig mode reads the full union (both
arms, no gate). A Discogs pool album is joined back to albums.db (via
db.albums_by_ids) for the rich row — art, genres, the exact Apple link; an MB-only
album has no albums.db row, so a lean row is shaped here (search links only) and the
exact art/links are filled LAZILY at the door (iTunes/Odesli), per the P3 design.

This is ADDITIVE and FLAG-GATED: nothing here is reached unless config.POOL_ENABLED
and the /api/pool/* endpoints are hit, so the live serving path (db.albums_for_day /
choice_for_day over albums.db) is completely unchanged. All pool SQL lives here; the
albums.db SQL stays in db.py (its "all SQL in one place" seam, one level down).
"""
import json
import os
import random
import sqlite3
import sys
from datetime import date, datetime, timedelta, timezone

import config
import db
import opsdb
from poolshape import (  # noqa: F401 - re-exported so pooldb.<name> call sites keep working
    _door_platforms,
    _door_shape,
    _door_unresolved,
    _lean_row,
    _links_without_spotify,
    _merge_platforms,
    _now,
    _parse_ts,
    _platform_filter,
    _rep_release_id,
    _spotify_fresh,
)


def _conn():
    c = sqlite3.connect(config.POOL_DB_PATH, timeout=30)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA busy_timeout=30000")
    return c


_SELECT = (
    "SELECT p.uid, p.album_id, p.source, p.month, p.day, p.year, "
    "p.original_date, p.artist, p.title, p.country, p.release_ids, "
    "p.mb_release_ids, "
    "a.listenable AS listenable, a.deezer_url AS deezer_url "
    "FROM pool p LEFT JOIN availability a ON a.uid = p.uid "
    "WHERE p.month = ? AND p.day = ?")


_DOOR_PLATFORMS_SELECT = (
    "SELECT uid, spotify_url, apple_music_url, youtube_url, spotify_fetched_at, "
    "links_json FROM door_links WHERE status = 'ok' AND uid IN ({ph})")


def _cached_door_platforms(uids, *, now=None):
    """Batch-read the on-demand door's CACHE (door_links) for `uids` ->
    {uid: {platform: exact_url}} of the platforms an earlier open (or the local
    prewarm) ALREADY resolved (spotify / apple / youtube; Deezer is an
    availability fact carried on the row, not the door). This lets a pool row
    advertise its FULL confirmed set without opening the door — we only READ what
    the cache already holds, never fire a door call. It also powers the pool-wide
    'my platforms' filter, so it must reflect exactly what the door would surface.

    Spotify TTL: a directly-resolved Spotify link (one carrying a spotify_fetched_at
    stamp) is a TEMPORARY cache; once it's past config.SPOTIFY_CACHE_TTL_DAYS it is
    NOT surfaced here (mirrors the door read-rule, so a stale link never lingers in
    a card badge or the filter). An UNSTAMPED spotify_url is Odesli-sourced and
    permanent (same footing as the row's other Odesli links), so it always folds.

    Honesty rule: only a cached 'ok' row with an EXACT, still-valid link contributes;
    an un-crawled uid is simply absent (unknown), never surfaced as 'unavailable'.
    Pure read — a missing door_links table (an older / never-crawled pool) maps to
    {} and NEVER CREATEs the table on the serving path."""
    uids = [u for u in uids if u]
    if not uids:
        return {}
    out = {}
    try:
        with _conn() as c:
            for i in range(0, len(uids), 400):
                chunk = uids[i:i + 400]
                ph = ",".join("?" * len(chunk))
                rows = c.execute(
                    _DOOR_PLATFORMS_SELECT.format(ph=ph), chunk).fetchall()
                for r in rows:
                    sp = r["spotify_url"]
                    if (sp and r["spotify_fetched_at"] is not None
                            and not _spotify_fresh(r["spotify_fetched_at"], now=now)):
                        sp = None   # stale directly-resolved link -> not surfaced
                    plats = _door_platforms(
                        apple=r["apple_music_url"],
                        spotify=sp,
                        youtube=r["youtube_url"],
                        links=r["links_json"])
                    if plats:
                        out[r["uid"]] = plats
    except sqlite3.OperationalError:
        return {}
    return out


# Bandcamp confirmed links via the MB crosswalk (F20). The MB release dump's
# url-relationships carry album-exact bandcamp URLs; tools/build_mb_bandcamp.py
# harvests them into config.BANDCAMP_DB_PATH (mbid -> url, type). A pool row reaches
# them through its mb_release_ids — the MB-only arm's own releases, AND the Discogs
# arm's exposed crosswalk (F20 step 1) — so the link is exact BY CONSTRUCTION: no
# Odesli/Deezer resolve, no door open, valid for every calendar day. Inclusive
# policy: any crosswalk match qualifies (the tier lives on the pool row for a future
# UPC-only escape hatch). When two mbids of one album both carry a link, the best
# LISTEN type wins (a streamable page over a buy-only link).
_BC_PREF = {"free streaming": 0, "streaming": 1, "download for free": 2,
            "purchase for download": 3, "purchase for mail-order": 4,
            "discography entry": 5}


def _bc_rank(typ):
    return _BC_PREF.get(typ, 9)


def _cached_bandcamp(rows):
    """{uid: bandcamp_url} for pool `rows` that reach an album-exact Bandcamp link
    through their mb_release_ids. One batched read of config.BANDCAMP_DB_PATH; a
    missing/never-built artifact maps to {} (unknown, never an error — the honesty
    rule). Best listen type wins across an album's mbids. Pure read."""
    want = {}
    all_mbids = set()
    for r in rows:
        mrj = r["mb_release_ids"]
        if not mrj or mrj == "[]":
            continue
        try:
            mbids = [m for m in json.loads(mrj) if m]
        except (ValueError, TypeError):
            continue
        if mbids:
            want[r["uid"]] = mbids
            all_mbids.update(mbids)
    if not all_mbids:
        return {}
    hit = {}  # mbid -> (rank, url)
    try:
        con = sqlite3.connect(f"file:{config.BANDCAMP_DB_PATH}?mode=ro",
                              uri=True, timeout=30)
    except sqlite3.OperationalError:
        return {}
    try:
        con.execute("PRAGMA busy_timeout=30000")
        mbid_list = list(all_mbids)
        for i in range(0, len(mbid_list), 400):
            chunk = mbid_list[i:i + 400]
            ph = ",".join("?" * len(chunk))
            for mbid, url, typ in con.execute(
                    "SELECT mbid, url, type FROM mb_bandcamp "
                    f"WHERE mbid IN ({ph})", chunk):
                hit[mbid] = (_bc_rank(typ), url)
    except sqlite3.OperationalError:
        return {}
    finally:
        con.close()
    out = {}
    for uid, mbids in want.items():
        best = None
        for m in mbids:
            h = hit.get(m)
            if h is not None and (best is None or h[0] < best[0]):
                best = h
        if best is not None:
            out[uid] = best[1]
    return out


def _cached_mb_enrich(rows):
    """{uid: {cover?, discogs_url?, genres?}} folded from the mb_enrich harvest
    (FB1 #23 ingest; F29 wiring) for MB-only pool rows, reached through their
    mb_release_ids. One batched read; an un-ingested album or a DB predating the
    harvest maps to nothing (unknown, never an error — the honesty rule). Per
    album, in mb_release_ids order: the first release with a Cover-Art-Archive
    front image gives the cover (a deterministic coverartarchive.org URL,
    hotlinked like any other remote cover — the CAA host is already in the CSP
    art allowlist), the first with a Discogs crosswalk gives an EXACT release door
    (replacing the lean name-search link), and the first with genres wins."""
    want = {}          # uid -> [mbid, ...] in list order
    all_mbids = set()
    for r in rows:
        if r["source"] != "mb_only":
            continue
        mrj = r["mb_release_ids"]
        if not mrj:
            continue
        try:
            mbids = [m for m in json.loads(mrj) if m]
        except (ValueError, TypeError):
            continue
        if mbids:
            want[r["uid"]] = mbids
            all_mbids.update(mbids)
    if not all_mbids:
        return {}
    enrich = db.mb_enrich_for(all_mbids)
    if not enrich:
        return {}
    out = {}
    for uid, mbids in want.items():
        cover = discogs_url = genres = label = None
        for m in mbids:
            e = enrich.get(m)
            if not e:
                continue
            if cover is None and e["caa_front"]:
                cover = f"https://coverartarchive.org/release/{m}/front"
            if discogs_url is None and e["discogs_release_id"] is not None:
                discogs_url = ("https://www.discogs.com/release/"
                               f"{e['discogs_release_id']}")
            if genres is None and e["genres"]:
                genres = e["genres"]
            if label is None and e["labels"]:
                nm = (e["labels"][0] or {}).get("name")
                if nm:
                    label = nm
        info = {}
        if cover:
            info["cover"] = cover
        if discogs_url:
            info["discogs_url"] = discogs_url
        if genres:
            # genresOf() (frontend) splits a comma string, like Discogs genres;
            # keep MB's own lower-case names.
            info["genres"] = ", ".join(genres)
        if label:
            info["label"] = label
        if info:
            out[uid] = info
    return out


def _catalog_fields(uids):
    """UC1 Phase 1b: {uid: entity_fields} when config.CATALOG_ENABLED and the catalog
    layer is present, else {} (serving falls back to the pool). Lazy-imported so the
    pool path carries no hard dependency on catalogdb; any error yields {}."""
    if not getattr(config, "CATALOG_ENABLED", False) or not uids:
        return {}
    try:
        import catalogdb
        return catalogdb.fields_for_uids(uids)
    except Exception:  # noqa: BLE001 - display re-sourcing only; never break serving
        return {}


def _entity_genres(raw):
    """The entity's genres JSON array -> the comma-joined string genresOf() /
    split_genres expect. The resolver preserves source casing, so joining the array
    reproduces the atomic Discogs genre 'Folk, World, & Country' verbatim (its
    fragments stay adjacent + TitleCase) and genresOf re-protects it before splitting.
    '' for empty/absent/unparseable input (serving keeps the pool's own genres)."""
    if not raw:
        return ""
    try:
        gs = json.loads(raw)
    except (ValueError, TypeError):
        return ""
    if not isinstance(gs, list):
        return ""
    return ", ".join(g for g in gs if g)


# --- A8: coarse genre buckets --------------------------------------------------
# One shared, server-owned taxonomy that maps a record's merged `genres` string to
# ONE coarse top-level bucket. It powers two things: the client's genre-BALANCED
# draw (Phase 1 — deal one bucket per round so Today doesn't lead with a run of the
# dominant genre; the catalog skews ~heavily electronic/rock) and, later, the opt-in
# genre FILTER (Phase 2, mirroring the platform chooser). The client reads the
# `bucket` field _enrich attaches — it never re-implements this map, so there's one
# source of truth. A record with no genre data (~30% of the pool, mostly the MB arm)
# is UNKNOWN — a first-class bucket, so genre-blind albums aren't buried in the deal.
GENRE_UNKNOWN = "unknown"
_GENRE_BUCKETS = (
    ("electronic", ("electronic", "electronica", "house", "techno", "trance",
                    "ambient", "idm", "downtempo", "dubstep", "drum and bass",
                    "drum n bass", "breakbeat", "electro", "edm", "acid",
                    "big beat", "trip hop", "synth", "leftfield")),
    ("hip hop", ("hip hop", "hip-hop", "rap", "trap", "grime")),
    ("funk / soul", ("funk", "soul", "r&b", "rhythm and blues", "disco", "motown")),
    ("jazz", ("jazz", "bebop", "swing", "big band")),
    ("reggae", ("reggae", "ska", "dancehall", "dub reggae", "rocksteady")),
    ("classical", ("classical", "baroque", "orchestral", "opera", "choral",
                   "romantic era", "chamber music")),
    ("folk", ("folk", "singer-songwriter", "americana", "country", "bluegrass")),
    ("latin", ("latin", "salsa", "cumbia", "bossa", "samba", "tango", "reggaeton")),
    ("blues", ("blues",)),
    ("stage & screen", ("soundtrack", "score", "musical", "stage & screen", "theme")),
    ("world", ("world", "african", "afrobeat", "celtic", "flamenco", "highlife")),
    ("rock", ("rock", "punk", "metal", "grunge", "hardcore", "emo", "shoegaze",
              "post-", "indie", "new wave", "goth")),
    ("pop", ("pop",)),
)


def genre_bucket(genres):
    """Coarse top-level bucket for a record's merged `genres` string (comma-joined,
    as _enrich produces it). Returns the bucket of the FIRST classifiable token, so
    an unclassifiable leading token (MB's 'experimental', 'instrumental') is skipped
    rather than swallowing the record; GENRE_UNKNOWN when nothing classifies or there
    are no genres. Case-insensitive substring match; deliberately coarse."""
    if not genres:
        return GENRE_UNKNOWN
    for tok in genres.split(","):
        t = tok.strip().lower()
        if not t:
            continue
        for name, kws in _GENRE_BUCKETS:
            if any(kw in t for kw in kws):
                return name
    return GENRE_UNKNOWN


def _enrich(rows):
    """Turn pool rows into full album dicts. Discogs rows are joined back to
    albums.db in ONE batched query (db.albums_by_ids), preserving the input order;
    a Discogs row missing from albums.db (shouldn't happen) and every MB-only row
    fall back to the lean shape. Each dict carries source/uid/listenable.

    Phase 2: the on-demand door's CACHE (door_links) is folded into each row's
    `platforms` in ONE batched read, so a card knows its full confirmed set
    (Spotify / Apple / YouTube the door already resolved, ∪ Deezer / Apple from
    the row) WITHOUT opening the door. Cache-only — no door call is ever fired
    here; an un-crawled album just gets nothing extra (unknown, never
    'unavailable')."""
    rid_for = {}
    for r in rows:
        if r["source"] == "discogs":
            rid = _rep_release_id(r)
            if rid is not None:
                rid_for[r["uid"]] = rid
    rich = {a["release_id"]: a for a in db.albums_by_ids(list(rid_for.values()))}
    door_for = _cached_door_platforms([r["uid"] for r in rows])
    bc_for = _cached_bandcamp(rows)
    mbe_for = _cached_mb_enrich(rows)   # F29: CAA cover / genres / exact Discogs
    ent_for = _catalog_fields([r["uid"] for r in rows])   # UC1 Phase 1b (flag-gated)

    out = []
    for r in rows:
        rid = rid_for.get(r["uid"])
        a = rich.get(rid) if rid is not None else None
        if a is not None:
            a = dict(a)
            a["source"] = "discogs"
            a["uid"] = r["uid"]
            a["listenable"] = (None if r["listenable"] is None
                               else bool(r["listenable"]))
            # HONESTY GUARDRAIL: the row was FILED under (p.month, p.day) — the
            # month/day of its VERIFIED original_date (build_pool_db derives
            # month/day/year straight from it, so p.year == original_date's year).
            # But albums.db's representative pressing carries its OWN `released`,
            # often a reissue on a different day; serving that would let a card read
            # e.g. "2017-09-01" under a "released on July 7" header (~42% of Discogs
            # rows diverge on month/day). Anchor the served date to the pool's
            # original_date so the card can never contradict the day it's filed
            # under — mirroring what _lean_row already does for MB-only rows.
            if r["original_date"]:
                a["released"] = r["original_date"]
                a["year"] = r["year"]
                a["release_month"] = r["month"]
                a["release_day"] = r["day"]
            # db._row_to_album already set the exact-Apple confirmed platform +
            # the Discogs source provenance (keyed off this release_id, == the
            # uid); fold in Deezer from availability. Spotify / YouTube arrive
            # lazily at the door (Apple-seeded — live on Render for Discogs).
            deezer_url = r["deezer_url"]
            a["deezer_url"] = deezer_url
            a["platforms"] = db.confirmed_platforms(
                deezer_url=deezer_url,
                apple_url=(a.get("platforms") or {}).get("apple"))
        else:
            a = _lean_row(r, rep_rid=rid)
        # UC1 Phase 1b: when the catalog entity layer is on, the album's fields come
        # from the resolved entity (one entity, one date/genre-set/cover — the source
        # of truth that retires the DQ3-class overlays). Flag-gated + best-effort: no
        # catalog / no entity -> the pool row stands.
        ef = ent_for.get(r["uid"])
        if ef:
            # DATE (Phase 1b): today equals the pool date the branches above set
            # (Phase 1a took the pool date), a parity-safe re-sourcing; Phase 2's
            # cross-source reconciliation flows here automatically.
            if ef.get("original_date"):
                a["released"] = ef["original_date"]
                a["year"] = ef["year"]
                a["release_month"] = ef["month"]
                a["release_day"] = ef["day"]
            # GENRES (1b-ii): the cross-source UNION (Discogs genres+styles ∪ MB),
            # deduped, as the comma string genresOf() splits. Overrides the pool's
            # single-source genres — it's a superset — so a Discogs card gains MB's
            # genres and vice-versa. Only when the entity actually has some.
            g = _entity_genres(ef.get("genres"))
            if g:
                a["genres"] = g
            # TYPE (1b-ii): MB primary(+secondary) type. Not rendered by the shell
            # yet, but part of the entity's served contract for the API / future UI.
            if ef.get("type"):
                a["type"] = ef["type"]
            # COVER (1b-ii): GAP-FILL only — never override the cover the pool path
            # already produced (db._row_to_album's cache-mode local/remote precedence
            # is a serving concern the entity's raw URL doesn't know). Purely additive:
            # an album with no art gets the entity's best (Discogs cached -> CAA).
            if ef.get("cover") and not a.get("cover"):
                a["cover"] = ef["cover"]
        # Fold the door cache's confirmed platforms onto whatever the row knew
        # synchronously, so badges/ranking see the full set without a door call.
        a["platforms"] = _merge_platforms(a["platforms"], door_for.get(r["uid"]))
        # Fold in the crosswalk Bandcamp link (F20) — exact, static, so it's known
        # here without a door open. Don't override an Odesli-sourced bandcamp the
        # door already resolved; both are exact, but the door's is already merged.
        # bandcamp is last in the canonical order, so appending keeps that order.
        bc = bc_for.get(r["uid"])
        if bc and not a["platforms"].get("bandcamp"):
            a["platforms"]["bandcamp"] = bc
        # F29: fold the mb_enrich harvest onto MB-only rows — a real Cover-Art-
        # Archive cover (was a placeholder), MB's genres (were none), and the exact
        # Discogs release door (was a name search). Only fills a gap: never
        # overrides a cover the door already resolved.
        mbe = mbe_for.get(r["uid"])
        if mbe:
            if mbe.get("cover") and not a.get("cover"):
                a["cover"] = mbe["cover"]
            if mbe.get("genres") and not a.get("genres"):
                a["genres"] = mbe["genres"]
            if mbe.get("label") and not a.get("label"):
                a["label"] = mbe["label"]
            if mbe.get("discogs_url"):
                a["discogs_url"] = mbe["discogs_url"]
        # A8: the coarse genre bucket for the client's balanced draw (+ future
        # filter). Computed AFTER every genre fold above, so it sees the full
        # cross-source union (entity genres+styles ∪ MB) this record ends up with.
        a["bucket"] = genre_bucket(a.get("genres"))
        out.append(a)
    return out


def _cluster_rep_better(cand, cur):
    """Which of two members of one cluster represents it in the draw: prefer a
    LISTENABLE row (so de-dup never drops the streamable copy for an un-crawled one),
    then Discogs (richer art/tracklist), else keep the first seen. Works for both a
    cross-source cluster and a same-source dup (UC2): a same-source tie falls through
    the Discogs test to first-seen (newest, by pool_day's ORDER BY year DESC)."""
    cl, cul = bool(cand.get("listenable")), bool(cur.get("listenable"))
    if cl != cul:
        return cl
    return cand.get("source") == "discogs" and cur.get("source") != "discogs"


def _dedup_clusters(rows):
    """UC1 Phase 2 serve-flip: collapse rows whose entities share a merged cluster — a
    Discogs + MB entry for the SAME album, or (UC2) a same-source dup like two masterless
    Discogs pressings — to ONE representative, so the daily draw shows an album once. Order
    preserved; the kept row's fields already come from the entity (CATALOG_ENABLED). No-op
    unless CLUSTER_DEDUP_ENABLED and the catalog resolves clusters — any error leaves the
    rows un-deduped (the pool is the fallback)."""
    if not getattr(config, "CLUSTER_DEDUP_ENABLED", False) or len(rows) < 2:
        return rows
    try:
        import catalogdb
        cl = catalogdb.clusters_for_uids([r["uid"] for r in rows])
    except Exception:  # noqa: BLE001 - never let a catalog read break the draw
        return rows
    if not cl:
        return rows
    out, at = [], {}                      # cluster_id -> index of its kept row in out
    for r in rows:
        cid = cl.get(r["uid"])
        if cid is None:                   # not clustered -> its own album, keep
            out.append(r)
        elif cid not in at:
            at[cid] = len(out)
            out.append(r)
        elif _cluster_rep_better(r, out[at[cid]]):
            out[at[cid]] = r
    return out


def pool_day(month, day, *, available_only=True, limit=None, platforms=None):
    """Albums for a calendar day from the unified pool. available_only=True is the
    daily-pick AVAILABLE pool (Deezer-listenable); False is dig mode (full union,
    both arms). Ordered newest-first.

    `platforms` (a set/list of platform keys, opt-in) restricts the result to albums
    confirmed on at least one of those services — the surface-only-my-platforms
    filter. It's applied AFTER enrichment (platform confirmation comes from the
    availability + door-cache fold), so when it's active LIMIT is applied in Python
    post-filter rather than pushed into SQL (else the filter could under-return)."""
    # de-dup + platform filter both act AFTER enrichment, so LIMIT can't be pushed into
    # SQL when either is on (it would cut rows before they're collapsed/filtered).
    dedup = getattr(config, "CLUSTER_DEDUP_ENABLED", False)
    post = bool(platforms) or dedup
    sql = _SELECT
    params = [month, day]
    if available_only:
        sql += " AND a.listenable = 1"
    sql += " ORDER BY p.year DESC"
    if limit and not post:
        sql += " LIMIT ?"
        params.append(int(limit))
    with _conn() as c:
        rows = c.execute(sql, params).fetchall()
    out = _enrich(rows)
    if dedup:
        out = _dedup_clusters(out)
    if platforms:
        out = _platform_filter(out, platforms)
    if limit and post:
        out = out[:int(limit)]
    return out


def pool_pick(month, day, n=2, *, available_only=True, platforms=None):
    """`n` random albums for the decide-for-me pick, from the unified pool (both
    arms). available_only=True (default) draws from the AVAILABLE pool (Deezer-
    listenable); False is dig mode — the full union for the day, including albums
    with no confirmed stream yet.

    `platforms` (opt-in) restricts to albums confirmed on one of those services. When
    it's active the candidate set is filtered FIRST and then sampled, so a filtered
    pick never draws an all-hidden pair (a plain SQL RANDOM/LIMIT would pick n rows
    and only then filter, collapsing to zero even when the day has matches)."""
    # When de-dup (or platforms) is on, sample from the collapsed/filtered day pool so
    # the pick never draws the two halves of one clustered album as its two records.
    if platforms or getattr(config, "CLUSTER_DEDUP_ENABLED", False):
        pool = pool_day(month, day, available_only=available_only,
                        platforms=platforms)
        random.shuffle(pool)
        return pool[:int(n)]
    sql = _SELECT
    if available_only:
        sql += " AND a.listenable = 1"
    sql += " ORDER BY RANDOM() LIMIT ?"
    with _conn() as c:
        rows = c.execute(sql, [month, day, int(n)]).fetchall()
    return _enrich(rows)


_SELECT_BY_UID = (
    "SELECT p.uid, p.album_id, p.source, p.month, p.day, p.year, "
    "p.original_date, p.artist, p.title, p.country, p.release_ids, "
    "p.mb_release_ids, "
    "a.listenable AS listenable, a.deezer_url AS deezer_url "
    "FROM pool p LEFT JOIN availability a ON a.uid = p.uid "
    "WHERE p.uid = ?")


def album_by_uid(uid):
    """One album from the unified pool by its uid, enriched the same way as the
    day/pick reads (Discogs rows joined back to albums.db, MB-only rows shaped
    lean with the cover/links deferred to the door). Returns None if the uid isn't
    in the pool. This is the pool side of the server's uid->album resolver, used
    for note/mark snapshots so an MB-only album resolves without a Discogs row."""
    with _conn() as c:
        row = c.execute(_SELECT_BY_UID, (uid,)).fetchone()
    if row is None:
        return None
    return _enrich([row])[0]


def albums_by_uids(uids):
    """Batch form of album_by_uid (F28: the person door's MB fold): pool rows
    for `uids`, enriched exactly like the day/pick reads, in input order; uids
    the pool doesn't know are simply absent. One chunked query + one _enrich
    pass, so a person credited on hundreds of MB-only albums doesn't fan out
    into per-uid reads."""
    uids = [u for u in uids if u]
    if not uids:
        return []
    rows = {}
    with _conn() as c:
        for i in range(0, len(uids), 400):
            chunk = uids[i:i + 400]
            ph = ",".join("?" * len(chunk))
            for r in c.execute(_SELECT_BY_UID.replace(
                    "p.uid = ?", f"p.uid IN ({ph})"), chunk):
                rows[r["uid"]] = r
    ordered = [rows[u] for u in uids if u in rows]
    return _enrich(ordered) if ordered else []


_SELECT_ARTIST_MB = _SELECT_BY_UID.replace(
    "WHERE p.uid = ?",
    "WHERE p.artist = ? COLLATE NOCASE AND p.uid LIKE 'm:%' "
    "ORDER BY COALESCE(p.original_date, printf('%04d', p.year)) DESC "
    "LIMIT ?")


def albums_by_artist(name, limit=500):
    """MB-only pool albums by an EXACT artist (case-insensitive), newest first —
    the pool arm of the /api/artist door (FB1 #16). An MB-only artist you arrived
    from has no Discogs catalogue, so albums.db's own artist index returns nothing
    and the panel read "0 albums"; these are the 'm:' rows that fill that gap.
    Discogs albums stay with db.albums_by_artist (their own NOCASE index), so this
    returns ONLY 'm:' rows — the two arms don't overlap. Exact match (not the
    prefix FTS), same honest-home discipline as the Discogs side; rides the
    ix_pool_artist (artist COLLATE NOCASE) index. [] for a blank name."""
    name = (name or "").strip()
    if not name:
        return []
    with _conn() as c:
        rows = c.execute(_SELECT_ARTIST_MB, (name, int(limit))).fetchall()
    return _enrich(list(rows)) if rows else []


def pool_dates_for(rows):
    """DQ3 — map catalog (albums.db) rows to their pool on-this-day date, so a
    search / browse-catalog card can't show a pressing date the pool contradicts.

    The Discogs `released`/`year` come from the album's representative pressing,
    which can be an outlier (J Dilla — *The Diary*'s canonical is a 2016-03-04 TEST
    PRESSING, while the pool files it under the real 2016-04-15 after DQ2). This is
    the reverse of what `_enrich` does for pool-served cards: anchor to the pool's
    `original_date`. Keyed off the Discogs `album_id` (`m:<master_id>:<vsig>`, or
    `r:<release_id>` for masterless) via the ix_pool_album index. `album_id` is NOT
    unique (build_pool_db docstring), so a shared one is refined by release_id
    membership in `release_ids`.

    Returns {release_id: {"released","year","release_month","release_day"}} for the
    subset of `rows` in the pool. Best-effort: any error yields {} so the caller's
    catalog dates simply stand."""
    try:
        from tools.dedup_stage1 import variant_sig
    except Exception:  # noqa: BLE001 - overlay is optional; catalog dates stand
        return {}
    per_row = []          # (release_id, album_id)
    want = set()
    for r in rows:
        rid = r.get("release_id")
        if rid is None:
            continue
        mid = r.get("master_id")
        aid = (f"m:{mid}:{variant_sig(r.get('title') or '')}"
               if mid and mid > 0 else f"r:{rid}")
        per_row.append((rid, aid))
        want.add(aid)
    if not want:
        return {}
    cand = {}             # album_id -> [(set(release_ids), datefields), ...]
    aids = list(want)
    with _conn() as c:
        for i in range(0, len(aids), 400):
            chunk = aids[i:i + 400]
            ph = ",".join("?" * len(chunk))
            for row in c.execute(
                    "SELECT album_id, release_ids, original_date, year, month, day "
                    f"FROM pool WHERE album_id IN ({ph})", chunk):
                try:
                    rids = {int(x) for x in json.loads(row["release_ids"] or "[]")}
                except (ValueError, TypeError):
                    rids = set()
                cand.setdefault(row["album_id"], []).append((rids, {
                    "released": row["original_date"], "year": row["year"],
                    "release_month": row["month"], "release_day": row["day"]}))
    out = {}
    for rid, aid in per_row:
        cands = cand.get(aid)
        if not cands:
            continue
        # A non-unique album_id can hold >1 album: prefer the one whose pressings
        # include this release_id; else the first (their dates usually agree).
        chosen = next((d for (rids, d) in cands if rid in rids), cands[0][1])
        if chosen.get("released"):
            out[rid] = chosen
    return out


def mb_release_ids_for(uid):
    """The MB release mbids folded into an MB-only pool album, in list order —
    the keying for its room (F28: uid -> mb_release_ids -> mb_credits). [] for
    a uid the pool doesn't know, a Discogs row, or a malformed list."""
    with _conn() as c:
        r = c.execute("SELECT mb_release_ids FROM pool WHERE uid = ?",
                      (uid,)).fetchone()
    if not r or not r["mb_release_ids"]:
        return []
    try:
        ids = json.loads(r["mb_release_ids"])
    except ValueError:
        return []
    return [m for m in ids if m] if isinstance(ids, list) else []


def pool_day_count(month, day, *, available_only=True):
    """How many albums the day has (available, or the full union)."""
    sql = ("SELECT COUNT(*) FROM pool p "
           "LEFT JOIN availability a ON a.uid = p.uid "
           "WHERE p.month = ? AND p.day = ?")
    if available_only:
        sql += " AND a.listenable = 1"
    with _conn() as c:
        return c.execute(sql, (month, day)).fetchone()[0]


# --------------------------------------------------------------------- the door
# The LAZY door: when a user OPENS one album, resolve its real cover + the exact
# per-platform streaming links (iTunes for the Apple link + upsized art, then an
# Odesli fan-out for Spotify/YouTube/...), and CACHE the result in a door_links
# table in pool.sqlite. This is what gives an MB-only album real art + links (a
# Discogs album already carries art/apple from the albums.db join-back; the door
# adds the platform fan-out). iTunes self-throttles ~3.1s/call/IP, so the door is
# strictly on-demand, one album at a time — never batched.

_DOOR_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS door_links (uid TEXT PRIMARY KEY, status TEXT, "
    "artwork_url TEXT, itunes_url TEXT, spotify_url TEXT, apple_music_url TEXT, "
    "youtube_url TEXT, links_json TEXT, fetched_at TEXT, spotify_fetched_at TEXT)")

# Columns added to door_links after it first shipped; ALTER any pre-existing table
# up to the current shape so an older local/host pool.sqlite keeps working.
# `spotify_fetched_at` timestamps the on-demand Spotify link INDEPENDENTLY of the
# row's `fetched_at` (the Odesli cover/links stay permanent; only the Spotify link
# is TTL-bounded — see backfill_spotify / evict_stale_spotify).
_DOOR_ADDED_COLUMNS = (("spotify_fetched_at", "TEXT"),)

_DOOR_POOL_SELECT = (
    "SELECT p.uid, p.source, p.artist, p.title, p.release_ids, "
    "a.deezer_url AS deezer_url "
    "FROM pool p LEFT JOIN availability a ON a.uid = p.uid WHERE p.uid = ?")

_DOOR_CACHE_SELECT = (
    "SELECT uid, status, artwork_url, itunes_url, spotify_url, apple_music_url, "
    "youtube_url, links_json, fetched_at, spotify_fetched_at "
    "FROM door_links WHERE uid = ?")

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
    links = cs.odesli_links(url, **odesli_kw) if url else {}
    return {"status": "ok", "artwork_url": artwork, "itunes_url": url,
            "links": links}


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
    rate-limited and returns no extra platforms. Same shape as _resolve_with."""
    cs = _coverage_study()
    links = cs.odesli_links(apple_url, **odesli_kw) if apple_url else {}
    return {"status": "ok", "artwork_url": artwork_url, "itunes_url": apple_url,
            "links": links}


def _resolve_from_deezer(deezer_url, *, odesli_kw):
    """Door resolve for any AVAILABLE album using its exact Deezer album link as the
    Odesli seed — the LIVE-on-Render path for MB-only and seedless-Discogs albums
    (no Apple seed, and iTunes is 403-blocked on Render, but Odesli's egress is
    open). Odesli fans out to Spotify / Apple / YouTube and returns a cover
    thumbnail for art-less rows. An Odesli REQUEST failure returns 'err' (door does
    NOT cache it -> retried), so a transient outage never freezes a Deezer-only
    result; a successful-but-sparse response is 'ok' (the album IS on Deezer)."""
    cs = _coverage_study()
    links, art, err = cs.odesli_door(deezer_url, **odesli_kw)
    if err:
        return {"status": "err"}
    return {"status": "ok", "artwork_url": art, "itunes_url": None, "links": links}


def _current_fresh_spotify(uid, *, ttl_days=None, now=None):
    """The row's stored Spotify link IFF it is still within its TTL, else None — a
    stale link is NEVER surfaced (so it can't outlive its window even before the
    eviction sweep runs). Pure read."""
    with _conn() as c:
        _ensure_door_table(c)
        row = c.execute("SELECT spotify_url, spotify_fetched_at FROM door_links "
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
    if cached is not None and cached["status"] in ("ok", "miss"):
        shaped = _door_shape(uid, cached, source)
        return shaped if crawler_driven else _apply_door_spotify(uid, prow, shaped)

    rid = _rep_release_id(prow) if source == "discogs" else None
    seed_apple, seed_art = (db.door_seed_for(rid) if rid is not None
                            else (None, None))
    # Patient upstream when the prewarm drives the door; bounded fast-fail on the
    # user request path. (Both seed paths use Odesli, which self-throttles.)
    odesli_kw = {} if resolver is patient_resolver else _door_profile()
    if seed_apple:
        res = _resolve_from_apple(seed_apple, seed_art, odesli_kw=odesli_kw)
    elif prow["deezer_url"]:
        res = _resolve_from_deezer(prow["deezer_url"], odesli_kw=odesli_kw)
    else:
        res = resolver(prow["artist"] or "", prow["title"] or "")
    status = res.get("status", "err")
    if status == "err":
        return _door_unresolved(uid, source, "err")

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
            "INSERT OR REPLACE INTO door_links (uid, status, artwork_url, "
            "itunes_url, spotify_url, apple_music_url, youtube_url, links_json, "
            "fetched_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (uid, status, artwork, itunes_url, spotify, apple, youtube,
             json.dumps(links), fetched_at))
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
    have = {r[1] for r in c.execute("PRAGMA table_info(door_links)")}
    for name, decl in _DOOR_ADDED_COLUMNS:
        if name not in have:
            c.execute(f"ALTER TABLE door_links ADD COLUMN {name} {decl}")


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
            "UPDATE door_links SET youtube_url = ?, links_json = ? WHERE uid = ?",
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
        "UPDATE door_links SET spotify_url = NULL, spotify_fetched_at = NULL, "
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
            "UPDATE door_links SET spotify_url = ?, spotify_fetched_at = ?, "
            "links_json = ? WHERE uid = ?", (url, stamp, json.dumps(links), uid))
    return "filled"


def platform_day_counts(month, day, *, available_only=True):
    """{"total": n, "counts": {platform: how many of the day's records a person could
    actually PLAY there}} — the number the admin panel never had.

    ONE pool_day load, counted in a single pass, rather than eight filtered loads
    (~115ms instead of ~1s). Counts EXACTLY what the "where you listen" filter
    surfaces: an album counts for a platform iff its CONFIRMED map holds that key —
    the same membership test poolshape._platform_filter applies — so the panel and
    the filter can't disagree. An un-crawled album has an empty map and counts for
    nothing (honesty rule: unknown, never "unavailable").

    Every key in db.PLATFORM_ORDER is present, ZERO INCLUDED. That's the point: a
    service that resolved nothing is what you want to see. A 0 for Spotify means the
    prewarm didn't run; Apple sat near 12/day for weeks because nothing reported it."""
    rows = pool_day(month, day, available_only=available_only)
    counts = {k: 0 for k in db.PLATFORM_ORDER}
    for r in rows:
        for k in (r.get("platforms") or {}):
            if k in counts:
                counts[k] += 1
    return {"total": len(rows), "counts": counts}


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
            "SELECT apple_music_url, artwork_url FROM door_links WHERE uid = ?",
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
    _set_door_apple(uid, hit_url, hit_art)
    return "filled"


def _set_door_apple(uid, url, artwork=None):
    """UPDATE-only write of a CONFIRMED Apple link onto an EXISTING door row: sets
    apple_music_url, and fills artwork_url only where the row has none (COALESCE — a
    cover the door already resolved always wins). Shared by both Apple lifts
    (backfill_apple_by_upc, backfill_apple_from_art) so they can never drift on what
    "filling Apple" means."""
    with _conn() as c:
        _ensure_door_table(c)
        if artwork:
            c.execute(
                "UPDATE door_links SET apple_music_url = ?, "
                "artwork_url = COALESCE(NULLIF(artwork_url, ''), ?) WHERE uid = ?",
                (url, artwork, uid))
        else:
            c.execute("UPDATE door_links SET apple_music_url = ? WHERE uid = ?",
                      (url, uid))


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
            "SELECT apple_music_url FROM door_links WHERE uid = ?", (uid,)).fetchone()
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
            "SELECT uid, links_json, spotify_fetched_at FROM door_links "
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
            "SELECT uid, links_json FROM door_links "
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
    "CREATE TABLE IF NOT EXISTS spotify_daily_log (warmed_date TEXT, run_at TEXT, "
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
            "INSERT OR REPLACE INTO spotify_daily_log (warmed_date, run_at, pool_size, "
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
                "miss, err FROM spotify_daily_log ORDER BY run_at DESC LIMIT ?",
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
    "CREATE TABLE IF NOT EXISTS crawl_status (id TEXT PRIMARY KEY, "
    "updated_at TEXT, day TEXT, seen INT, ok INT, miss INT, err INT, "
    "aborted INT, note TEXT, state TEXT, total INT)")

# Columns added after the table first shipped; ALTER any pre-existing crawl_status
# up to the current shape so an older local pool.sqlite keeps working.
_CRAWL_ADDED_COLUMNS = (("state", "TEXT"), ("total", "INT"))


def _ensure_crawl_table(c):
    c.execute(_CRAWL_SCHEMA)
    have = {r[1] for r in c.execute("PRAGMA table_info(crawl_status)")}
    for name, decl in _CRAWL_ADDED_COLUMNS:
        if name not in have:
            c.execute(f"ALTER TABLE crawl_status ADD COLUMN {name} {decl}")


def write_crawl_status(id="door", *, day=None, seen=0, ok=0, miss=0, err=0,
                       aborted=False, note=None, state=None, total=None):
    """Upsert the heartbeat row for a crawl source (default 'door'). Written by the
    local prewarm both mid-run (state='running', with a partial seen/total) and at
    day end (state='done' or 'throttled'); `updated_at` is stamped now (UTC)."""
    with _conn() as c:
        _ensure_crawl_table(c)
        c.execute(
            "INSERT OR REPLACE INTO crawl_status (id, updated_at, day, seen, ok, "
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
                "SELECT * FROM crawl_status WHERE id = ?", (id,)).fetchone()
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
    today = today or date.today()
    try:
        with _conn() as c:
            rows = c.execute(
                "SELECT p.month, p.day, COUNT(*) AS n, "
                "SUM(CASE WHEN a.uid IS NOT NULL THEN 1 ELSE 0 END) AS resolved "
                "FROM pool p LEFT JOIN availability a ON a.uid = p.uid "
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
                "AS last24 FROM door_links WHERE spotify_fetched_at IS NOT NULL",
                (cutoff,)).fetchone()
    except sqlite3.OperationalError:
        return None
    newest = _parse_ts(row["newest"])
    age_h = None if newest is None else round(
        (now - newest).total_seconds() / 3600, 1)
    return {"stamped": row["stamped"], "stamped_24h": row["last24"] or 0,
            "newest_age_hours": age_h}
