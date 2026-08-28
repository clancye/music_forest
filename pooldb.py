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
import random
import sqlite3
import sys
from datetime import date, datetime, timedelta, timezone

import config
import db
import opsdb
import sqliteconn
from poolconn import LIVE, _conn  # noqa: F401 - shared leaf; _conn re-exported so pooldb._conn keeps working; LIVE is the live.sqlite schema prefix (BE2a)
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


# {LIVE} is poolconn's live.sqlite schema prefix ("live." after the BE2a split, else
# "" — the four warmth tables then resolve to the attached live DB or, pre-migration,
# to pool.sqlite unchanged). `pool` always stays in the main (pool.sqlite) connection.
_SELECT = (
    "SELECT p.uid, p.album_id, p.source, p.month, p.day, p.year, "
    "p.original_date, p.artist, p.title, p.country, p.release_ids, "
    "p.mb_release_ids, "
    "a.listenable AS listenable, a.deezer_url AS deezer_url "
    f"FROM pool p LEFT JOIN {LIVE}availability a ON a.uid = p.uid "
    "WHERE p.month = ? AND p.day = ?")


_DOOR_PLATFORMS_SELECT = (
    "SELECT uid, spotify_url, apple_music_url, youtube_url, spotify_fetched_at, "
    f"links_json FROM {LIVE}door_links WHERE status = 'ok' AND uid IN ({{ph}})")


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
        cover = discogs_url = genres = label = n_tracks = None
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
            # B25: first release with a stored tracklist gives the length, same
            # first-wins rule as the fields above (and as db.mb_tracks_for, so the
            # count agrees with the list the tracks door actually renders).
            if n_tracks is None and e.get("n_tracks"):
                n_tracks = e["n_tracks"]
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
        if n_tracks:
            info["n_tracks"] = n_tracks
        if info:
            out[uid] = info
    return out


# BE2b — the catalog overlay/dedup are best-effort on the serve path (they fail SOFT to
# the pool so a broken catalog can't take serving down), which is exactly why a broken or
# ABSENT catalog.sqlite once degraded staging for six days UNNOTICED. These make each
# silent degrade visible: an ops.sqlite counter (surfaced on /admin) + a once-per-process
# stderr line. Observability only — it never changes the honest fallback behaviour.
_logged_fallback = set()   # kinds already logged this process (log once, keep counting)


def _note_catalog_fallback(kind, exc):
    """Bump the ops counter for a silent catalog fallback and log it ONCE per process per
    kind (so a persistent breakage neither floods the log nor stays invisible). Never
    raises — observability must not be the thing that breaks the draw it's observing."""
    try:
        opsdb.record_catalog_fallback(kind)
    except Exception:  # noqa: BLE001
        pass
    if kind not in _logged_fallback:
        _logged_fallback.add(kind)
        print(f"[pooldb] catalog {kind} overlay unavailable — serving from the pool "
              f"(degraded but honesty-safe): {exc!r}", file=sys.stderr)


def _catalog_fields(uids):
    """UC1 Phase 1b: {uid: entity_fields} when config.CATALOG_ENABLED and the catalog
    layer is present, else {} (serving falls back to the pool). Lazy-imported so the
    pool path carries no hard dependency on catalogdb; any error yields {} — counted +
    logged (BE2b) so the degrade isn't silent."""
    if not getattr(config, "CATALOG_ENABLED", False) or not uids:
        return {}
    try:
        import catalogdb
        return catalogdb.fields_for_uids(uids)
    except Exception as e:  # noqa: BLE001 - display re-sourcing only; never break serving
        _note_catalog_fallback("fields", e)
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


# --- B25: is this record a compilation / box set? ------------------------------
# Feedback #64/#65: "Slim Gaillard — Laughing in Rhythm" is a Proper Records BOX SET
# (102 tracks, measured) served as one album, and "Various — Jamz Vol. 1" is a generic
# Various-Artists comp. Both read as an album, neither is one you sit with.
#
# The signal is already resolved and cross-source: the catalog entity layer's `type`
# carries MB's release-group primary+secondary types ("Album · Compilation" — which
# BOTH reported records carry). Various-Artists is the second, independent shape: a
# comp with no single artist to have a story with, which the entity type doesn't
# always mark. Track count is deliberately NOT part of this test — a long record is a
# separate fact the card states on its own, and plenty of legitimate albums are long.
#
# Server-owned, like genre_bucket: the client reads the flag, never re-derives the
# taxonomy, so there's one source of truth.
_VARIOUS_ARTISTS = {"various", "various artists", "va", "v.a.", "verschiedene"}


def _is_compilation(a):
    """True when the record is a compilation/anthology or a Various-Artists set.
    Reads the entity `type` when the catalog resolved one, else the artist name.
    Unknown type + a real artist -> False (we don't guess an album is a comp)."""
    if "compilation" in (a.get("type") or "").lower():
        return True
    return (a.get("artist") or "").strip().lower() in _VARIOUS_ARTISTS


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
    # B25: how long the record is, batched (~7 ms for a full day). MB-only rows get
    # theirs from the mb_enrich fold below, which already reads that table.
    ntr_for = db.track_counts_for(list(rid_for.values()))
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
        # B25: how long the record is + whether it's a compilation. A 102-track box
        # set presented exactly like a 40-minute album is what feedback #64 hit; the
        # deck says so when it's notable, and the deal uses it. Discogs counts come
        # from the batched tracklists read, MB's ride the mb_enrich fold above.
        # ABSENT when unknown (never 0) — an un-ingested tracklist is not "no tracks".
        n_tracks = ntr_for.get(rid) if rid is not None else (mbe or {}).get("n_tracks")
        if n_tracks:
            a["n_tracks"] = n_tracks
        a["is_compilation"] = _is_compilation(a)
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
    except Exception as e:  # noqa: BLE001 - never let a catalog read break the draw
        _note_catalog_fallback("clusters", e)
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


def dedup_search_arms(albums):
    """B24 — collapse the merged Discogs+MB search result to ONE card per clustered
    album, keeping the FIRST occurrence. Same cluster data as _dedup_clusters, a
    deliberately different keep-rule: the day draw picks a representative
    (_cluster_rep_better: listenable, then Discogs), but in a ranked/merged list
    POSITION is the answer, and the Discogs search rows don't carry `listenable` at
    all (they come from albums.db, not the pool), so that rule would swap a
    top-ranked Discogs card for a lean MB twin. First-seen keeps the merge order's
    intent instead.

    Takes album dicts from EITHER arm: an MB row has `uid`; a Discogs search row is
    keyed by its release_id, whose pool uid is 'd:<release_id>' by construction.
    No-op unless CLUSTER_DEDUP_ENABLED and the catalog resolves clusters — any error
    leaves the rows un-deduped, exactly like the draw's path."""
    if not getattr(config, "CLUSTER_DEDUP_ENABLED", False) or len(albums) < 2:
        return albums
    keys = [a.get("uid") or (f"d:{a['release_id']}" if a.get("release_id") is not None
                             else None) for a in albums]
    try:
        import catalogdb
        cl = catalogdb.clusters_for_uids([k for k in keys if k])
    except Exception as e:  # noqa: BLE001 - never let a catalog read break search
        _note_catalog_fallback("search", e)
        return albums
    if not cl:
        return albums
    out, seen = [], set()
    for a, k in zip(albums, keys):
        cid = cl.get(k) if k else None
        if cid is None:                   # unclustered -> its own album, keep
            out.append(a)
        elif cid not in seen:
            seen.add(cid)
            out.append(a)
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


def health_probe():
    """Cheap liveness read for /healthz. Runs the daily serving JOIN for today,
    LIMIT 1 — the exact query shape every /api/pool/* uses — so a truncated or
    malformed pool.sqlite raises here instead of only surfacing as a user-facing
    500. (2026-07-24: an interrupted rsync left a partial pool.sqlite, every pick
    500'd for hours, and /healthz stayed green because it never touched the pool.)
    Returns the row count; 0 is still healthy — an empty calendar day is legal, a
    broken file is not. NOT a full integrity scan: PRAGMA quick_check reads the
    whole ~1 GB file and is far too heavy to run per health check. This only proves
    the file opens and the serving query executes."""
    today = config.today_local()
    sql = _SELECT + " AND a.listenable = 1 LIMIT 1"
    with _conn() as c:
        return len(c.execute(sql, [today.month, today.day]).fetchall())


_SELECT_BY_UID = (
    "SELECT p.uid, p.album_id, p.source, p.month, p.day, p.year, "
    "p.original_date, p.artist, p.title, p.country, p.release_ids, "
    "p.mb_release_ids, "
    "a.listenable AS listenable, a.deezer_url AS deezer_url "
    f"FROM pool p LEFT JOIN {LIVE}availability a ON a.uid = p.uid "
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


# --- B24: the MB arm of Explore search ----------------------------------------
# Explore searched only albums_fts (search.db, built from albums.db), so the pool's
# MB-only half — 46.3% of it, ~915 k rows — was un-findable: an MB-only artist read
# "No albums or songs match" for a record Today had just served. pool_fts
# (tools/build_pool_search.py) is that missing index; server.api_search merges this
# arm with db.search_albums.

def _pool_search_conn():
    """Read-only handle on the MB pool index. Its own file (POOL_SEARCH_DB_PATH)
    because it takes the POOL's vintage, not albums.db's — see the tool's docstring."""
    c = sqlite3.connect(f"file:{config.POOL_SEARCH_DB_PATH}?mode=ro", uri=True,
                        timeout=30)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA busy_timeout=30000")
    return sqliteconn.managed(c)


# pool_fts has artist/title/genres only. `styles` and `label` are Discogs-shaped
# facets with no MB-arm column, so scoping to one returns nothing from this arm —
# honest ("nothing on file for that scope"), where silently widening to an
# unscoped search would answer a question the reader didn't ask.
_POOL_FTS_FIELDS = {"artist", "title", "genres"}

# Same guard, same reason as db._TRACK_RANK_CAP (#70, commit 9c13800): past this many
# matches, ORDER BY rank has to bm25-score a huge doclist to find the top few. Measured
# here 2026-07-18 on 915 k rows: a stopword prefix ("the*") costs 0.45 s ranked vs
# 0.02 s unranked, and the bounded probe that decides costs 0.02 s. Past the cap the
# first `limit` matches are a sample either way.
_POOL_RANK_CAP = 50_000


def search_albums(q, limit=500, month=None, day=None, field=None):
    """Full-text search the pool's MB-only records, ranked by relevance — the arm
    albums_fts can't see. If month/day are given, restrict to that calendar day; if
    `field` is one of artist/title/genres, scope matching to it. Returns the same
    enriched album dicts as the day/pick reads (via albums_by_uids), in rank order.

    Degrades to [] when the index isn't built or is corrupt (a half-shipped file),
    exactly like db.search_albums — an un-built index is 'nothing on file', never a
    500, and search falls back to the Discogs arm alone."""
    if field is not None and field not in _POOL_FTS_FIELDS:
        return []
    fq = db._fts_query(q or "", field=field)   # one escaping rule for both arms
    if not fq:
        return []
    scoped = month is not None and day is not None
    where = "pool_fts MATCH ?"
    params = [fq]
    if scoped:
        # month/day are UNINDEXED payload, so this filters the matched set in SQL
        # BEFORE the limit — no over-fetch-and-post-filter (the Discogs arm has to
        # over-fetch 6x because albums_fts carries no date).
        where += " AND month = ? AND day = ?"
        params += [int(month), int(day)]
    try:
        with _pool_search_conn() as sc:
            n = sc.execute(
                f"SELECT count(*) FROM (SELECT 1 FROM pool_fts WHERE {where} "
                "LIMIT ?)", params + [_POOL_RANK_CAP + 1]).fetchone()[0]
            order = "" if n > _POOL_RANK_CAP else "ORDER BY rank "
            rows = sc.execute(
                f"SELECT uid FROM pool_fts WHERE {where} " + order + "LIMIT ?",
                params + [int(limit)]).fetchall()
    except sqlite3.Error:
        return []
    return albums_by_uids([r["uid"] for r in rows])


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
           f"LEFT JOIN {LIVE}availability a ON a.uid = p.uid "
           "WHERE p.month = ? AND p.day = ?")
    if available_only:
        sql += " AND a.listenable = 1"
    with _conn() as c:
        return c.execute(sql, (month, day)).fetchone()[0]


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


# ------------------------------------------------------------------- door layer
# The door resolver, streaming backfills, Spotify TTL, and operator telemetry were
# extracted to pooldoor.py (2026-08-08). Re-exported here so every existing
# pooldb.<name> call site AND monkeypatch target keeps working unchanged (tests do
# monkeypatch.setattr(pooldb, "backfill_spotify", ...)). IMPORTANT: _CS is a shared
# MUTABLE box -- import it, never re-create it, or the test stand-in
# (pooldb._CS[0] = fake) and pooldoor's own read diverge (green while the real
# network resolvers fire under test).
from pooldoor import (  # noqa: F401,E402 - re-exported for back-compat
    _CRAWL_SCHEMA,
    _CS,
    _DOOR_SCHEMA,
    _coverage_study,
    _current_fresh_spotify,
    _ensure_door_table,
    _spotify_resolver,
    availability_runway,
    backfill_apple_by_name,
    backfill_apple_by_upc,
    backfill_apple_from_art,
    backfill_spotify,
    backfill_youtube,
    door_links,
    evict_stale_spotify,
    patient_resolver,
    purge_spotify,
    read_crawl_status,
    record_spotify_day_log,
    spotify_log,
    spotify_stamp_stats,
    write_crawl_status,
)
