"""
Thin data-access layer.

All SQL lives here so the rest of the app talks to albums via plain functions.
If you ever move off local SQLite (e.g. to Postgres for a shared deployment),
this is the only file that changes.
"""
import sqlite3
import urllib.parse

import config


def _conn():
    # timeout makes writers wait for a lock instead of erroring; with the
    # database in WAL mode this lets the background prefetch worker and the
    # on-demand fetches write concurrently without "database is locked".
    c = sqlite3.connect(config.DB_PATH, timeout=30)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA busy_timeout=30000")
    return c


def _listen_links(artist, title):
    """Build no-auth streaming search links (work for any release)."""
    q = urllib.parse.quote_plus(f"{artist} {title}")
    q_path = urllib.parse.quote(f"{artist} {title}")   # Spotify uses path-style
    return {
        # Bandcamp first (F17): an artist-direct, often-lossless home that pays
        # musicians better — built as a no-key search, same pattern as the rest.
        "bandcamp": f"https://bandcamp.com/search?q={q}",
        "youtube": f"https://www.youtube.com/results?search_query={q}+full+album",
        "apple_search": f"https://music.apple.com/{config.ITUNES_COUNTRY.lower()}"
                        f"/search?term={q}",
        "spotify": f"https://open.spotify.com/search/{q_path}",
        "qobuz": f"https://www.qobuz.com/us-en/search?q={q}",
    }


# --- confirmed-listen platforms + provenance (P3 confirmed door) -------------
# The confirmed Listen door surfaces ONLY platforms where the album is GUARANTEED
# listenable — exact links, never a blind search (the honesty rule). Deezer (from
# availability) and the exact Apple album link are known at row-build time;
# Spotify / YouTube Music are filled lazily by the door's Odesli fan-out. The
# surfaced set is the big-four (owner's call): spotify, apple, youtube, deezer —
# store/download-only platforms are never shown.
# The canonical order the confirmed door renders in — mirrors static/app.js's
# CONFIRMED_PLATFORMS and reqparams._FILTER_PLATFORM_KEYS. Named here so a COUNTING
# reader (pooldb.platform_day_counts -> the admin pool view) can report a platform
# that resolved to nothing: confirmed_platforms() below omits absent keys, which is
# right for a card (an un-crawled album is unknown, never "unavailable") but wrong
# for a panel — a MISSING count is exactly the signal worth seeing. Apple sat at ~12
# a day for weeks because nothing ever reported the zero.
PLATFORM_ORDER = ("spotify", "apple", "youtube", "deezer",
                  "tidal", "amazon", "pandora", "bandcamp")


def confirmed_platforms(*, deezer_url=None, apple_url=None, spotify_url=None,
                        youtube_url=None, tidal_url=None, amazon_url=None,
                        pandora_url=None, bandcamp_url=None):
    """An ordered {platform: exact_url} map of CONFIRMED-listenable platforms,
    omitting any that aren't known. Keys are the frontend's canonical order.
    NEVER pass a blind search link here — only exact, guaranteed-listenable URLs.
    `tidal_url` / `amazon_url` / `pandora_url` / `bandcamp_url` come from the Odesli
    fan-out (cached in door_links.links_json) — permanent, same footing as Deezer,
    with no external API or TTL."""
    out = {}
    if spotify_url:
        out["spotify"] = spotify_url
    if apple_url:
        out["apple"] = apple_url
    if youtube_url:
        out["youtube"] = youtube_url
    if deezer_url:
        out["deezer"] = deezer_url
    if tidal_url:
        out["tidal"] = tidal_url
    if amazon_url:
        out["amazon"] = amazon_url
    if pandora_url:
        out["pandora"] = pandora_url
    if bandcamp_url:
        out["bandcamp"] = bandcamp_url
    return out


def source_provenance(uid):
    """(source_url, source_label) for the provenance button, keyed off album
    identity (the uid prefix), NOT a separate identity field. A 'd:<release_id>'
    uid -> the exact Discogs release; an 'm:mb:<rgid>' uid -> the MusicBrainz
    release-GROUP page (the uid carries a release-group mbid; see
    tools/build_pool_db.uid_of). Anything else -> (None, None), and the frontend
    shows no provenance thread."""
    s = "" if uid is None else str(uid)
    if s.startswith("m:mb:"):
        mbid = s[len("m:mb:"):]
        if mbid:
            return f"https://musicbrainz.org/release-group/{mbid}", "MusicBrainz"
    if s.startswith("d:"):
        rid = s[2:]
        if rid.lstrip("-").isdigit():
            return f"https://www.discogs.com/release/{rid}", "Discogs"
    return None, None


def door_seed_for(release_id):
    """The exact Apple album link + remote artwork for a Discogs release from the
    art cache, used to seed the door's Odesli fan-out WITHOUT an iTunes call (the
    live-on-Render path; iTunes is the only thing 403-blocked there). Returns
    (apple_url, artwork_url); either may be None. Only the EXACT art apple link is
    returned (the art cache never stores a search fallback)."""
    try:
        with _conn() as c:
            r = c.execute("SELECT apple_music_url, artwork_url FROM art "
                          "WHERE release_id=?", (int(release_id),)).fetchone()
    except sqlite3.OperationalError:
        return None, None
    if not r:
        return None, None
    return r["apple_music_url"], r["artwork_url"]


def _row_to_album(row):
    a = dict(row)
    links = _listen_links(a["artist"], a["title"])
    a["bandcamp_url"] = links["bandcamp"]
    a["youtube_url"] = links["youtube"]
    a["spotify_url"] = links["spotify"]
    a["qobuz_url"] = links["qobuz"]
    # Provenance: the exact Discogs release this date/row came from. `discogs_url`
    # is kept for back-compat (pick/journal/shelf readers); `source_url` /
    # `source_label` are the source-aware provenance the confirmed door renders.
    a["discogs_url"] = f"https://www.discogs.com/release/{a['release_id']}"
    a["source_url"], a["source_label"] = source_provenance(f"d:{a['release_id']}")
    # The exact Apple album link from the art cache (None when uncached) is the
    # only confirmed link known synchronously on the catalog path; the door's
    # Odesli fan-out (seeded from it) fills Spotify / YouTube on open.
    exact_apple = a.get("apple_music_url")
    a["platforms"] = confirmed_platforms(apple_url=exact_apple)
    # Prefer the exact Apple Music album link from the art cache if we have it,
    # otherwise fall back to an Apple Music search (kept for legacy readers; the
    # confirmed door reads `platforms`, not this field).
    a["apple_music_url"] = exact_apple or links["apple_search"]
    # Cover source depends on the art mode (config.CACHE_ART_BYTES):
    #  - cache mode (local build/dev): prefer the locally-cached file we serve —
    #    it's instant and works offline — falling back to the remote URL.
    #  - hotlink mode (hosted, AOTD_CACHE_ART_BYTES=0): only the catalog DB is on
    #    the host, NOT the cached art bytes, so a stored local_path points at a
    #    /static/art/<id>.jpg that 404s. Prefer the remote (Apple / Cover Art
    #    Archive) URL — already allowed by the CSP img-src — and ignore local_path.
    #    Falling through to local_path only if there is no remote URL at all.
    local = a.get("local_path")
    remote = a.get("artwork_url")
    local_cover = ("/" + local.lstrip("/")) if local else None
    if config.CACHE_ART_BYTES and local_cover:
        a["cover"] = local_cover
    elif remote:
        a["cover"] = remote
    else:
        a["cover"] = local_cover
    return a


# The album row shape every read returns. Only the WHERE/ORDER/LIMIT change
# between queries, so we compose those rather than string-surgering this SELECT.
_COLUMNS = """
SELECT al.release_id, al.master_id, al.title, al.artist, al.released,
       al.year, al.release_month, al.release_day, al.country,
       al.genres, al.styles, al.formats, al.label,
       ar.artwork_url, ar.local_path, ar.apple_music_url
FROM albums al
LEFT JOIN art ar ON ar.release_id = al.release_id
"""

# Whitelisted ORDER BY clauses. ORDER BY can't be parameterized, so we map a
# caller-supplied key to a fixed, trusted SQL fragment (never user text).
_ORDER = {
    "year": "al.year DESC",
    "year-asc": "al.year ASC",
    "random": "RANDOM()",
}


def _build(where, *, order=None, limit=False):
    """Compose a full album query from a WHERE fragment, an optional whitelisted
    ORDER key, and an optional (parameterized) LIMIT placeholder. The caller is
    responsible for matching params: WHERE params first, then the LIMIT value
    last if limit=True."""
    sql = _COLUMNS + " WHERE " + where
    if order:
        # ORDER BY can't be parameterized, so it must come from the trusted map,
        # never from caller text. Guard explicitly (S7): an unknown key is a bug,
        # and failing here with a clear message beats letting a stray string
        # reach the query. `where` fragments are likewise module constants, never
        # user input — every user value travels as a `?` placeholder.
        if order not in _ORDER:
            raise ValueError(f"unknown ORDER key: {order!r}")
        sql += " ORDER BY " + _ORDER[order]
    if limit:
        sql += " LIMIT ?"
    return sql


_DAY_WHERE = "al.release_month = ? AND al.release_day = ? AND al.is_canonical = 1"


def albums_for_day(month, day, limit=None, order="year"):
    """All albums released on a given month/day across all years."""
    order_key = "year" if order == "year" else "random"
    sql = _build(_DAY_WHERE, order=order_key, limit=limit is not None)
    params = [month, day] + ([int(limit)] if limit is not None else [])
    with _conn() as c:
        return [_row_to_album(r) for r in c.execute(sql, params)]


def get_album(release_id):
    """One album (with any cached art) by release id, or None. Fetches any
    single release (e.g. a journal link to a specific pressing), so it
    intentionally drops the canonical filter."""
    sql = _build("al.release_id = ?")
    with _conn() as c:
        r = c.execute(sql, (release_id,)).fetchone()
    return _row_to_album(r) if r else None


def albums_by_ids(ids):
    """Fetch full album rows for a list of release ids, returned in the SAME
    order as `ids` (so a search engine's ranking is preserved). Ids not found
    are silently skipped."""
    ids = [int(i) for i in ids]
    if not ids:
        return []
    qs = ",".join("?" * len(ids))
    sql = _build(f"al.release_id IN ({qs})")
    with _conn() as c:
        by_id = {r["release_id"]: r for r in c.execute(sql, ids)}
    return [_row_to_album(by_id[i]) for i in ids if i in by_id]


def albums_in_decade(decade, limit=500):
    """Canonical albums whose year falls in a decade like '1970s', newest first.
    A queryless catalog door (A3): backs the clickable-decade pull. Returns the
    same album dicts as the day/browse/search queries. An unparseable decade
    yields []."""
    import re
    m = re.match(r"^\s*(\d{3,4})s\s*$", str(decade or ""))
    if not m:
        return []
    start = int(m.group(1))
    start -= start % 10
    sql = _build("al.year >= ? AND al.year < ? AND al.is_canonical = 1",
                 order="year", limit=True)
    with _conn() as c:
        rows = c.execute(sql, (start, start + 10, int(limit))).fetchall()
    return [_row_to_album(r) for r in rows]


def albums_on_label(label, limit=500):
    """Canonical albums released on an *exact* label, newest first. Backs the
    label panel (T2): a label's catalogue treated as a bounded, surveyable object
    — a door like the artist panel, not a grid pull. Matched exactly (case-
    insensitively), NOT via the prefix FTS, so the panel only ever shows records
    actually on that label (no 'shares the word Records' bleed). Empty -> []."""
    label = (label or "").strip()
    if not label:
        return []
    # `col = ? COLLATE NOCASE` (not `lower(col) = lower(?)`) so the lookup is
    # sargable: it can ride the partial NOCASE index `idx_canon_label`
    # (label, year DESC) built in build_db.mark_canonical. Without that index
    # this was a full scan of every canonical row over a 5M-row, multi-GB table
    # — seconds locally, minutes on the hosted starter box, and past gunicorn's
    # 120s timeout often enough to surface as "Couldn't load the catalog"
    # (feedback #9, #12). NOCASE folds ASCII case exactly like the old lower(),
    # so matching is unchanged; the index also supplies the year-DESC order,
    # dropping the temp b-tree sort.
    sql = _build("al.label = ? COLLATE NOCASE AND al.is_canonical = 1",
                 order="year", limit=True)
    with _conn() as c:
        rows = c.execute(sql, (label, int(limit))).fetchall()
    return [_row_to_album(r) for r in rows]


def albums_by_artist(artist, limit=500):
    """Canonical albums by an *exact* artist, newest first. Backs the A2 artist
    panel: an artist treated as a bounded, surveyable home — a door, not a grid
    pull. Matched exactly (case-insensitively), NOT via the prefix FTS, so the
    panel only ever shows records actually by that artist. The old FTS path
    (``search_albums(name, field='artist')``) ANDed prefix tokens, so a name like
    'B.J. Thomas' became ``artist:b* artist:j* artist:thomas*`` and pulled in
    every artist that merely shared those word-starts (Thomas J. Bergersen, Johann
    … Thomas, …) — the 'door to a bunch of different artists' bug. Same exact-match
    discipline as ``albums_on_label``. Empty -> []."""
    artist = (artist or "").strip()
    if not artist:
        return []
    # Sargable exact match (see albums_on_label): `= ? COLLATE NOCASE` lets the
    # query ride the partial NOCASE index `idx_canon_artist` (artist, year DESC)
    # instead of full-scanning the catalog, same loading-time fix as the label
    # panel (feedback #9, #12). NOCASE preserves the case-insensitive contract.
    sql = _build("al.artist = ? COLLATE NOCASE AND al.is_canonical = 1",
                 order="year", limit=True)
    with _conn() as c:
        rows = c.execute(sql, (artist, int(limit))).fetchall()
    return [_row_to_album(r) for r in rows]


# --- personnel / credits (F27): the room + the person's door -----------------
# A record is a room full of people; these back the two halves of that pull.
# We key on the stable Discogs person id and QUOTE the role exactly as each
# sleeve credited it — per appearance, never aggregated into what someone "is"
# (no imposed vocabulary; VISION P2). Every reader degrades to empty when the
# credits table doesn't exist yet (a DB predating the F27 backfill), so the UI
# simply shows no room rather than erroring.

def _display_name(name):
    """Strip the Discogs '(N)' disambiguation suffix ('Cher (2)') for display,
    exactly like collect_artists does in build_db. Identity stays the person_id,
    never the name."""
    import re
    return re.sub(r"\s*\(\d+\)$", "", name or "").strip()


def credits_for(release_id):
    """The room: everyone credited on a release, in sleeve order. Returns
    [{'person_id', 'name', 'role'}, ...]; person_id None means an unlinked
    credit — shown as plain text, never a door (the honesty rule)."""
    if release_id is None:
        return []
    try:
        with _conn() as c:
            rows = c.execute(
                "SELECT person_id, name, role FROM credits "
                "WHERE release_id = ? ORDER BY seq",
                (int(release_id),)).fetchall()
    except sqlite3.OperationalError:
        return []
    return [{"person_id": r["person_id"], "name": _display_name(r["name"]),
             "role": r["role"] or ""} for r in rows]


def person_links(person_id):
    """Outward doors for a person from the Wikidata crosswalk (F27-p2):
    {'qid','wikidata_url','mbid','musicbrainz_url','wikipedia_url'} — values
    None where Wikidata doesn't know — or None entirely when the person isn't
    in the crosswalk (or the DB predates it). Links are doors out, never
    content pulled in."""
    try:
        with _conn() as c:
            r = c.execute(
                "SELECT qid, mbid, wikipedia FROM person_xref "
                "WHERE person_id = ?", (int(person_id),)).fetchone()
    except sqlite3.OperationalError:
        return None
    if not r:
        return None
    return {
        "qid": r["qid"],
        "wikidata_url": f"https://www.wikidata.org/wiki/{r['qid']}",
        "mbid": r["mbid"],
        "musicbrainz_url": (f"https://musicbrainz.org/artist/{r['mbid']}"
                            if r["mbid"] else None),
        "wikipedia_url": r["wikipedia"],
    }


def merged_person_ids(person_id):
    """All Discogs person ids Wikidata asserts are the SAME person (one item,
    several P1953 values — duplicate Discogs entries), always including the id
    asked about. The merge is an external identity claim, so callers surface
    it honestly ("across N Discogs entries") rather than silently. [id] when
    the crosswalk is absent or knows nothing."""
    pid = int(person_id)
    try:
        with _conn() as c:
            r = c.execute("SELECT qid FROM person_xref WHERE person_id = ?",
                          (pid,)).fetchone()
            if not r:
                return [pid]
            ids = [row["person_id"] for row in c.execute(
                "SELECT person_id FROM person_xref WHERE qid = ?",
                (r["qid"],))]
    except sqlite3.OperationalError:
        return [pid]
    return sorted(set(ids) | {pid})


def person_name(person_id):
    """Display name for a person id: the most frequent name-as-credited across
    our rows (F27 fork decision 1 — no Discogs artists dump in v1), stripped for
    display — counted across the person's merged ids, so a door keyed by a
    sparse duplicate entry still wears the name the catalog knows them by.
    Falls back to the MB credits (F28) for a person whose only appearances are
    on the MB arm; None when we hold no credits for any of them."""
    ids = merged_person_ids(person_id)
    qs = ",".join("?" * len(ids))
    try:
        with _conn() as c:
            r = c.execute(
                f"SELECT name FROM credits WHERE person_id IN ({qs}) "
                f"GROUP BY name ORDER BY COUNT(*) DESC, name LIMIT 1",
                ids).fetchone()
    except sqlite3.OperationalError:
        return None
    if r:
        return _display_name(r["name"])
    mbids = person_mbids(person_id)
    if not mbids:
        return None
    qs = ",".join("?" * len(mbids))
    try:
        with _conn() as c:
            r = c.execute(
                f"SELECT name FROM mb_credits WHERE artist_mbid IN ({qs}) "
                f"GROUP BY name ORDER BY COUNT(*) DESC, name LIMIT 1",
                mbids).fetchone()
    except sqlite3.OperationalError:
        return None
    return r["name"] if r else None


def albums_by_credit(person_id, limit=500):
    """The person's door — the mirror of the room: every album they're credited
    on, deduped to master (a credit on ANY pressing counts, so a reissue-only
    credit still surfaces the album via its canonical row), newest-first like
    the artist/label panels. Credits under any of the person's MERGED Discogs
    ids count too (F27-p2: Wikidata's duplicate-entry assertion; the API
    surfaces the merge honestly). Returns (albums, total): `total` is the
    honest count of distinct albums on file (the bounded hub-door number) and
    `albums` the newest-`limit` survey, each dict carrying `credit_roles` —
    the role(s) exactly as credited on that album's pressings."""
    ids = merged_person_ids(person_id)
    qs = ",".join("?" * len(ids))
    try:
        with _conn() as c:
            hits = c.execute(
                f"SELECT c.release_id AS rid, c.role AS role, "
                f"       al.master_id AS mid, al.is_canonical AS canon "
                f"FROM credits c JOIN albums al ON al.release_id = c.release_id "
                f"WHERE c.person_id IN ({qs}) ORDER BY c.release_id, c.seq",
                ids).fetchall()
    except sqlite3.OperationalError:
        return [], 0
    if not hits:
        return [], 0

    # One group per album: pressings sharing a real master collapse; a
    # standalone release (master 0/NULL, always canonical) is its own group.
    groups = {}
    for h in hits:
        mid = h["mid"] if (h["mid"] or 0) > 0 else None
        key = ("m", mid) if mid else ("r", h["rid"])
        g = groups.setdefault(key, {"roles": [], "canon_rid": None, "mid": mid})
        role = (h["role"] or "").strip()
        if role and role not in g["roles"]:
            g["roles"].append(role)
        if h["canon"]:
            g["canon_rid"] = h["rid"]

    # A credit that lives only on a non-canonical pressing still needs the
    # master's canonical row to stand for the album — look those up (chunked:
    # a prolific engineer can reach thousands of masters).
    missing = sorted({g["mid"] for g in groups.values()
                      if g["canon_rid"] is None and g["mid"]})
    if missing:
        found = {}
        with _conn() as c:
            for i in range(0, len(missing), 500):
                chunk = missing[i:i + 500]
                qs = ",".join("?" * len(chunk))
                # `AND master_id > 0` is the partial-index proof (see
                # pressings_for): it lets the IN probes ride idx_master
                # instead of scanning the catalog per chunk.
                for mid, rid in c.execute(
                        f"SELECT master_id, release_id FROM albums "
                        f"WHERE is_canonical = 1 AND master_id > 0 "
                        f"AND master_id IN ({qs})",
                        chunk):
                    found[mid] = rid
        for g in groups.values():
            if g["canon_rid"] is None:
                g["canon_rid"] = found.get(g["mid"])
    chosen = [g for g in groups.values() if g["canon_rid"] is not None]

    # Newest-first by the canonical row's date (the panels' order), then cut to
    # the bounded survey and fetch full album dicts only for that page.
    rids = [g["canon_rid"] for g in chosen]
    dates = {}
    with _conn() as c:
        for i in range(0, len(rids), 500):
            chunk = rids[i:i + 500]
            qs = ",".join("?" * len(chunk))
            for rid, rel in c.execute(
                    f"SELECT release_id, released FROM albums "
                    f"WHERE release_id IN ({qs})", chunk):
                dates[rid] = rel or ""
    chosen.sort(key=lambda g: dates.get(g["canon_rid"], ""), reverse=True)
    page = chosen[:int(limit)]
    albums = albums_by_ids([g["canon_rid"] for g in page])
    roles_by_rid = {g["canon_rid"]: ", ".join(g["roles"]) for g in page}
    for a in albums:
        a["credit_roles"] = roles_by_rid.get(a["release_id"], "")
    return albums, len(chosen)


def _mbid_person_ids(artist_mbids):
    """Crosswalk MB artist mbids -> Discogs person ids via person_xref (F28):
    {mbid: person_id}. When Wikidata's duplicate-entry merge puts several
    person ids on one mbid, the lowest wins (deterministic; any merged id
    opens the same door — merged_person_ids folds them by qid). {} when the
    crosswalk is absent."""
    mbids = sorted({m for m in artist_mbids if m})
    if not mbids:
        return {}
    out = {}
    try:
        with _conn() as c:
            for i in range(0, len(mbids), 500):
                chunk = mbids[i:i + 500]
                qs = ",".join("?" * len(chunk))
                for mbid, pid in c.execute(
                        f"SELECT mbid, MIN(person_id) FROM person_xref "
                        f"WHERE mbid IN ({qs}) GROUP BY mbid", chunk):
                    out[mbid] = pid
    except sqlite3.OperationalError:
        return {}
    return out


def mb_credits_for(release_mbids):
    """The room for an MB-only album (F28): the artist-targeted relations of
    its listed releases, unioned in list order, deduped on (artist_mbid, role)
    — first appearance wins, so the canonical (first-listed) release's credits
    lead. Same row shape as credits_for ({'person_id','name','role'}), so the
    UI renders one room either way: a crosswalked mbid (person_xref) carries
    the Discogs person id and is a door; an un-crosswalked name is plain text
    (the same contract as an unlinked sleeve credit). Roles are MB's typed
    vocabulary — the caller labels the source honestly. [] when mb_credits is
    absent (a DB predating the F28 ingest) or nothing matches."""
    mbids = [m for m in (release_mbids or []) if m]
    if not mbids:
        return []
    by_release = {}
    try:
        with _conn() as c:
            for i in range(0, len(mbids), 500):
                chunk = mbids[i:i + 500]
                qs = ",".join("?" * len(chunk))
                for r in c.execute(
                        f"SELECT release_mbid, artist_mbid, name, role "
                        f"FROM mb_credits WHERE release_mbid IN ({qs}) "
                        f"ORDER BY seq", chunk):
                    by_release.setdefault(r["release_mbid"], []).append(r)
    except sqlite3.OperationalError:
        return []
    pids = _mbid_person_ids(
        r["artist_mbid"] for rows in by_release.values() for r in rows)
    out = []
    seen = set()
    for mbid in mbids:
        for r in by_release.get(mbid, []):
            key = (r["artist_mbid"], r["role"] or "")
            if key in seen:
                continue
            seen.add(key)
            out.append({"person_id": pids.get(r["artist_mbid"]),
                        "name": r["name"], "role": r["role"] or ""})
    return out


def person_mbids(person_id):
    """The MB artist mbids Wikidata pins on this person (across their merged
    Discogs ids) — the key into mb_credits. [] when the crosswalk is absent or
    carries no mbid."""
    ids = merged_person_ids(person_id)
    qs = ",".join("?" * len(ids))
    try:
        with _conn() as c:
            rows = c.execute(
                f"SELECT DISTINCT mbid FROM person_xref "
                f"WHERE person_id IN ({qs}) AND mbid IS NOT NULL",
                ids).fetchall()
    except sqlite3.OperationalError:
        return []
    return sorted(r["mbid"] for r in rows)


def mb_albums_by_credit(person_id):
    """The MB half of the person's door (F28): every MB-only album this person
    is credited on, via the crosswalk (person -> mbid -> mb_credits) and the
    ingest-time keying snapshot (mb_release_map). Returns ([(uid, roles)],
    total) with roles the distinct MB terms in listing order; the caller
    resolves uids to pool rows (albums.db knows no MB-only albums). ([], 0)
    when the crosswalk / F28 tables are absent."""
    mbids = person_mbids(person_id)
    if not mbids:
        return [], 0
    qs = ",".join("?" * len(mbids))
    try:
        with _conn() as c:
            rows = c.execute(
                f"SELECT m.uid AS uid, c.role AS role "
                f"FROM mb_credits c "
                f"JOIN mb_release_map m ON m.release_mbid = c.release_mbid "
                f"WHERE c.artist_mbid IN ({qs}) "
                f"ORDER BY m.uid, m.pos, c.seq", mbids).fetchall()
    except sqlite3.OperationalError:
        return [], 0
    groups = {}
    for r in rows:
        roles = groups.setdefault(r["uid"], [])
        role = (r["role"] or "").strip()
        if role and role not in roles:
            roles.append(role)
    out = [(uid, ", ".join(roles)) for uid, roles in groups.items()]
    return out, len(out)


def pressings_for(release_id):
    """The "other releases of this album" thread (F27-1b): every full-dated
    pressing sharing the open release's master, in lineage (release-date)
    order — one door, two story threads: the pressings themselves, and the
    label column reading as the licensing/territory lineage (A7). Light rows,
    not full album dicts (this is a survey list, not a card grid):
    [{'release_id','released','year','country','label','formats',
      'is_canonical','room','current'}]. `room` is that pressing's own credits
    count (each sleeve has its own room; F27's per-release honesty is why this
    door exists). Standalone releases (no master) return [] — nothing honest
    to group. Bounded by what we ingested (full dates only), never a
    completeness claim."""
    if release_id is None:
        return []
    with _conn() as c:
        r = c.execute("SELECT master_id FROM albums WHERE release_id = ?",
                      (int(release_id),)).fetchone()
        if not r or not r["master_id"] or r["master_id"] <= 0:
            return []
        mid = r["master_id"]
        # The credits subquery rides idx_credits_release; without the credits
        # table (a pre-F27 DB) fall back to the same list with room = None —
        # unknown, never "empty room".
        # The literal `AND master_id > 0` looks redundant next to `= ?`, but it
        # is what lets SQLite prove the partial index idx_master (WHERE
        # master_id > 0) applies — a bare parameter can't be proven positive at
        # prepare time, and without the proof this is a 5M-row scan per open.
        try:
            rows = c.execute(
                "SELECT release_id, released, year, country, label, formats, "
                "       is_canonical, "
                "       (SELECT COUNT(*) FROM credits cr "
                "        WHERE cr.release_id = al.release_id) AS room "
                "FROM albums al WHERE master_id = ? AND master_id > 0 "
                "ORDER BY released ASC, release_id ASC", (mid,)).fetchall()
        except sqlite3.OperationalError:
            rows = c.execute(
                "SELECT release_id, released, year, country, label, formats, "
                "       is_canonical, NULL AS room "
                "FROM albums al WHERE master_id = ? AND master_id > 0 "
                "ORDER BY released ASC, release_id ASC", (mid,)).fetchall()
    return [{"release_id": r["release_id"], "released": r["released"],
             "year": r["year"], "country": r["country"], "label": r["label"],
             "formats": r["formats"], "is_canonical": bool(r["is_canonical"]),
             "room": r["room"], "current": r["release_id"] == int(release_id)}
            for r in rows]


def _search_conn():
    c = sqlite3.connect(config.SEARCH_DB_PATH, timeout=30)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA busy_timeout=30000")
    return c


# FB#57b: `styles` (finer Discogs sub-genres — "Art Rock", "IDM", "Thrash") is already
# an albums_fts column (build_db.build_search_index), so scoping to it needs no rebuild.
_FTS_FIELDS = {"artist", "title", "genres", "styles", "label"}

def _fts_query(q, field=None):
    """Turn free user text into a safe FTS5 prefix query.

    Each word becomes a prefix term (`miles*`), joined by spaces so FTS5 ANDs
    them — typing "mile dav" matches "Miles Davis". We keep only word
    characters so stray quotes/operators can't break the MATCH syntax.

    B26 EXCEPTION: a ONE-CHARACTER token is matched EXACTLY, not as a prefix.
    A 1-char prefix constrains nothing — `a*` matches every word starting with
    "a", ~1/6 of the whole index — but it costs enormously, because `ORDER BY
    rank` then has to bm25-score that entire doclist. Measured 2026-07-18 over
    3.5 M albums: `a tribe called quest` 526 ms -> 6 ms (83x), `a perfect
    circle` 529 ms -> 73x, bare `a` 1772 ms -> 140 ms. Those are REAL queries,
    not a synthetic worst case — any band whose name starts with a bare "A" hit
    the slow path. Results are unchanged for every query with no 1-char token,
    and effectively unchanged for the ones above (same albums, occasional
    trivial reorder); a bare `a` actually gets *better* (albums really called
    "A_A" rather than arbitrary a-prefixed ones). A 2-char prefix IS a real
    narrowing ("ra" -> Radiohead), so the line is drawn at 1.

    If *field* is one of the indexed column names, every token is scoped to
    that column (e.g. ``artist:miles* artist:davis*``)."""
    import re
    toks = re.findall(r"\w+", q.lower())
    if not toks:
        return None
    col = field if field in _FTS_FIELDS else None
    prefix = f"{col}:" if col else ""
    return " ".join(f"{prefix}{t}" if len(t) == 1 else f"{prefix}{t}*"
                    for t in toks)


def search_albums(q, limit=500, month=None, day=None, field=None):
    """Full-text search the whole catalog (canonical albums only), ranked by
    relevance. If month/day are given, restrict to that calendar day. If field
    is set, restrict matching to that FTS column. Returns the same album dicts
    as the day/browse queries."""
    fq = _fts_query(q or "", field=field)
    if not fq:
        return []
    scoped = month is not None and day is not None
    # Over-fetch when day-scoping so the post-filter still has enough to show.
    fetch = limit * 6 if scoped else limit
    try:
        with _search_conn() as sc:
            rows = sc.execute(
                "SELECT rowid AS release_id FROM albums_fts "
                "WHERE albums_fts MATCH ? ORDER BY rank LIMIT ?",
                (fq, fetch)).fetchall()
    except sqlite3.Error:
        # search.db missing, no FTS table yet, or CORRUPT (e.g. a half-shipped /
        # interrupted index file) — degrade to no results, never a 500. sqlite3.Error
        # covers OperationalError (missing table) AND DatabaseError (malformed file).
        return []
    albums = albums_by_ids([r["release_id"] for r in rows])
    if scoped:
        albums = [a for a in albums
                  if a["release_month"] == month and a["release_day"] == day]
    return albums[:limit]


def search_persons(q, limit=8):
    """Full-text search the credited people (persons_fts in search.db), ranked by
    relevance. Returns [{'person_id', 'name'}] — the id is the Discogs artist id
    ('per:<person_id>' in the note namespace), the name the modal name-as-credited.

    Degrades to [] when persons_fts isn't built (the aux index is opt-in per
    tools/build_search_aux.py — an un-built index is 'nothing on file', never an
    error). Prefix-AND matching, same as album search: 'nigel godr' -> Nigel
    Godrich."""
    fq = _fts_query(q or "")
    if not fq:
        return []
    try:
        with _search_conn() as sc:
            rows = sc.execute(
                "SELECT rowid AS person_id, name FROM persons_fts "
                "WHERE persons_fts MATCH ? ORDER BY rank LIMIT ?",
                (fq, int(limit))).fetchall()
    except sqlite3.Error:              # missing/absent/corrupt search.db -> [] (see search_albums)
        return []
    return [{"person_id": r["person_id"], "name": r["name"]} for r in rows]


# Above this many track matches, ORDER BY rank has to bm25-score a huge doclist to find
# the top few — 0.5s+ for a common word like "love" (~510k tracks), the whole reason
# Explore search felt slow (feedback #70). Past the cap we take the first `limit` matches
# unranked (~24x faster); 8 of half a million common-word tracks is a sample either way.
_TRACK_RANK_CAP = 50_000


def search_tracks(q, limit=8):
    """Full-text search track titles (tracks_fts in search.db), ranked by
    relevance. Returns [{'title', 'album_uid', 'pos', 'album_artist',
    'album_title'}] — enough to render + link a result to its album at that
    position ('trk:<album_uid>#<pos>' in the note namespace).

    Degrades to [] when tracks_fts isn't built (the heavy aux index is opt-in per
    tools/build_search_aux.py). Prefix-AND matching, same as album search. A cheap MATCH
    count gates the ranking: specific terms (the common case) keep bm25 order; a
    pathologically common term skips it so it can't cost seconds for 8 rows (#70)."""
    fq = _fts_query(q or "")
    if not fq:
        return []
    try:
        with _search_conn() as sc:
            # Bounded probe: stop counting at the cap so even a stopword like "the"
            # (~2.5M matches) can't make the COUNT itself the bottleneck.
            n = sc.execute(
                "SELECT count(*) FROM "
                "(SELECT 1 FROM tracks_fts WHERE tracks_fts MATCH ? LIMIT ?)",
                (fq, _TRACK_RANK_CAP + 1)).fetchone()[0]
            order = "" if n > _TRACK_RANK_CAP else "ORDER BY rank "
            rows = sc.execute(
                "SELECT title, album_uid, pos, album_artist, album_title "
                "FROM tracks_fts WHERE tracks_fts MATCH ? " + order + "LIMIT ?",
                (fq, int(limit))).fetchall()
    except sqlite3.Error:             # missing/absent/corrupt search.db -> [] (see search_albums)
        return []
    return [{"title": r["title"], "album_uid": r["album_uid"], "pos": r["pos"],
             "album_artist": r["album_artist"], "album_title": r["album_title"]}
            for r in rows]


def tracks_for(release_id):
    """Tracklist for a release: [{'pos','title','dur'}, ...].
    Returns [] if there's no tracklist, or if the tracklists table doesn't
    exist yet (i.e. the DB predates the F5 rebuild) — so the UI degrades to a
    free-text track field instead of erroring."""
    import json
    try:
        with _conn() as c:
            r = c.execute(
                "SELECT tracks FROM tracklists WHERE release_id=?",
                (release_id,)).fetchone()
    except sqlite3.OperationalError:
        return []
    return json.loads(r["tracks"]) if r and r["tracks"] else []


def mb_tracks_for(release_mbids):
    """Tracklist for an MB-only album (FB1 #23): the first of its release mbids
    (canonical order) that carries a stored MB tracklist in mb_enrich — same
    {'pos','title','dur'} shape as tracks_for, so the UI renders it identically.
    Falls back to a Discogs tracklist BORROWED through the release's discogs
    crosswalk when MB itself has no media on file. [] when neither source has it
    or mb_enrich is absent (a DB predating the enrich ingest)."""
    import json
    mbids = [m for m in (release_mbids or []) if m]
    if not mbids:
        return []
    try:
        with _conn() as c:
            qs = ",".join("?" * len(mbids))
            rows = {r["release_mbid"]: r for r in c.execute(
                f"SELECT release_mbid, tracks, discogs_release_id "
                f"FROM mb_enrich WHERE release_mbid IN ({qs})", mbids)}
    except sqlite3.OperationalError:
        return []
    # 1) MB's own tracklist, from the first listed release that has one.
    for m in mbids:
        r = rows.get(m)
        if r and r["tracks"]:
            tracks = json.loads(r["tracks"])
            if tracks:
                return tracks
    # 2) borrow a Discogs tracklist via the crosswalk (an MB release with no
    #    media of its own but a link to a Discogs release we DID ingest).
    for m in mbids:
        r = rows.get(m)
        if r and r["discogs_release_id"] is not None:
            tracks = tracks_for(r["discogs_release_id"])
            if tracks:
                return tracks
    return []


def mb_enrich_for(release_mbids):
    """Batched mb_enrich read for a set of MB release mbids (the FB1 #23 harvest;
    F29 folds it onto the card): {release_mbid: {'caa_front','discogs_release_id',
    'genres','labels'}} for the ones on file. `genres` and `labels` are parsed from
    their JSON (MB's own lower-case genre vocabulary; labels are [{'name','catno'}]).
    Absent releases are simply missing from the map; a DB predating the enrich
    ingest returns {} (unknown, never an error)."""
    import json
    mbids = [m for m in (release_mbids or []) if m]
    if not mbids:
        return {}

    def _load(v):
        try:
            return json.loads(v) if v else None
        except (ValueError, TypeError):
            return None

    out = {}
    try:
        with _conn() as c:
            for i in range(0, len(mbids), 500):
                chunk = mbids[i:i + 500]
                qs = ",".join("?" * len(chunk))
                for r in c.execute(
                        f"SELECT release_mbid, caa_front, discogs_release_id, "
                        f"genres, labels FROM mb_enrich WHERE release_mbid "
                        f"IN ({qs})", chunk):
                    out[r["release_mbid"]] = {
                        "caa_front": bool(r["caa_front"]),
                        "discogs_release_id": r["discogs_release_id"],
                        "genres": _load(r["genres"]),
                        "labels": _load(r["labels"]),
                    }
    except sqlite3.OperationalError:
        return {}
    return out


def choice_for_day(month, day):
    """Two random albums from a given day, for the decide-for-me mode."""
    sql = _build(_DAY_WHERE, order="random", limit=True)
    with _conn() as c:
        rows = c.execute(sql, (month, day, 2)).fetchall()
    return [_row_to_album(r) for r in rows]


def day_count(month, day):
    with _conn() as c:
        return c.execute(
            "SELECT COUNT(*) FROM albums "
            "WHERE release_month=? AND release_day=? AND is_canonical=1",
            (month, day)).fetchone()[0]


def albums_missing_art(month, day):
    """Rows for a day that have no successful art lookup yet."""
    sql = _build(_DAY_WHERE + " AND (ar.status IS NULL OR ar.status = 'error')")
    with _conn() as c:
        return [dict(r) for r in c.execute(sql, (month, day))]


def cached_itunes_art():
    """Every release whose cover came from iTunes and is currently stored, with
    the album's artist/title and the stored artwork_url — the input to the
    cover-mismatch audit (B5). Ordered by release_id for stable, resumable runs."""
    sql = ("SELECT al.release_id, al.artist, al.title, "
           "       ar.artwork_url, ar.local_path "
           "FROM art ar JOIN albums al ON al.release_id = ar.release_id "
           "WHERE ar.source = 'itunes' AND ar.status = 'ok' "
           "ORDER BY al.release_id")
    with _conn() as c:
        return [dict(r) for r in c.execute(sql)]


def save_art(release_id, *, artwork_url=None, local_path=None,
             apple_music_url=None, source="none", status="notfound"):
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with _conn() as c:
        c.execute(
            """INSERT OR REPLACE INTO art
               (release_id, artwork_url, local_path, apple_music_url,
                source, status, fetched_at)
               VALUES (?,?,?,?,?,?,?)""",
            (release_id, artwork_url, local_path, apple_music_url,
             source, status, now))
        c.commit()
