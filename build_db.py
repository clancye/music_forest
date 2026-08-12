#!/usr/bin/env python3
"""
Build the offline SQLite album database from a Discogs releases dump.

We stream the gzipped XML and split it into raw <release>…</release> byte
blocks, which are parsed + extracted in a pool of worker processes (lxml's C
parser). The main process stays the sole SQLite writer. Memory stays flat
regardless of file size (the dump is ~100+ GB uncompressed): we only ever hold a
bounded number of in-flight blocks, never the whole stream. For every <release>
that has a *full* YYYY-MM-DD date we store one row, indexed by month/day so
"what came out today" is an instant lookup.

Parsing — not decompression or the SQLite writes — is the bottleneck, and it's
pure-Python per-release work, so we parallelize with *processes* (the GIL makes
threads useless here). Override the worker count with AOTD_BUILD_WORKERS.

Discogs uses 00 for unknown month/day (e.g. 1969-00-00); those are excluded
because they're useless for an on-this-day app.

Usage:
    python build_db.py                      # uses data/dumps/latest.txt
    python build_db.py path/to/dump.xml.gz  # explicit file
    python build_db.py --credits-only dump.xml.gz
        # F27 backfill: re-stream the dump and (re)populate ONLY the credits
        # table inside the EXISTING albums.db — no rebuild, art/FTS untouched.
        # For when the catalog rows are already current for this dump vintage.
"""
import argparse
import gzip
import json
import multiprocessing as mp
import os
import re
import sqlite3
import sys
import time
from collections import deque
from pathlib import Path

from lxml import etree as LET

import config

FULL_DATE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
_NON_DIGIT = re.compile(r"\D")

SCHEMA = """
CREATE TABLE IF NOT EXISTS albums (
    release_id    INTEGER PRIMARY KEY,
    master_id     INTEGER,
    title         TEXT NOT NULL,
    artist        TEXT NOT NULL,
    released      TEXT NOT NULL,   -- YYYY-MM-DD
    year          INTEGER,
    release_month INTEGER NOT NULL,
    release_day   INTEGER NOT NULL,
    country       TEXT,
    genres        TEXT,
    styles        TEXT,
    formats       TEXT,
    label         TEXT,
    barcodes      TEXT             -- JSON list of normalized GTIN-14, or NULL
);
CREATE INDEX IF NOT EXISTS idx_monthday ON albums (release_month, release_day);

-- Artwork is filled in lazily by fetch_art.py. Kept in its own table so
-- rebuilding the album data never wipes a hard-won art cache.
CREATE TABLE IF NOT EXISTS art (
    release_id      INTEGER PRIMARY KEY,
    artwork_url     TEXT,   -- remote source URL
    local_path      TEXT,   -- cached file under static/art (relative)
    apple_music_url TEXT,
    source          TEXT,   -- itunes | coverartarchive | none
    status          TEXT,   -- ok | notfound | error
    fetched_at      TEXT
);

-- Tracklists, one compact JSON row per release (only for albums we keep).
-- Separate table so the big browse queries never drag tracklist text around;
-- we read it only when a note's track dropdown opens.
CREATE TABLE IF NOT EXISTS tracklists (
    release_id INTEGER PRIMARY KEY,
    tracks     TEXT      -- JSON: [{"pos": "A1", "title": "...", "dur": "3:21"}, ...]
);
"""

CREDITS_SCHEMA = """
-- Release-level personnel (F27): one row per <extraartists> credit line, the
-- name and role kept exactly as the sleeve credited them (roles are quoted,
-- never normalized). person_id is the stable Discogs artist id — NULL means an
-- unlinked credit (a name, not a person: shown as plain text, never a door).
-- seq preserves sleeve order within the release. Indexed by index_credits()
-- after the bulk load.
CREATE TABLE IF NOT EXISTS credits (
    release_id INTEGER NOT NULL,
    person_id  INTEGER,
    name       TEXT NOT NULL,
    role       TEXT,
    seq        INTEGER NOT NULL
);
"""
SCHEMA += CREDITS_SCHEMA


def parse_date(text):
    """Return (year, month, day) for a usable full date, else None."""
    if not text:
        return None
    m = FULL_DATE.match(text.strip())
    if not m:
        return None
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if not (1 <= mo <= 12 and 1 <= d <= 31):
        return None
    return y, mo, d


def text_of(elem, tag):
    child = elem.find(tag)
    return child.text if child is not None and child.text else None


def collect_artists(release):
    """Join artist names, honoring Discogs <join> connectors.

    Discogs encodes credits like  Artist A  <join>feat.</join>  Artist B,
    or uses "," for plain lists. We rebuild a readable string such as
    "Artist A feat. Artist B" or "Artist A, Artist B".
    """
    node = release.find("artists")
    if node is None:
        return None
    out = ""
    for artist in node.findall("artist"):
        name = text_of(artist, "name")
        if name:
            # Strip Discogs disambiguation suffixes like "Cher (2)".
            out += re.sub(r"\s*\(\d+\)$", "", name)
        join = text_of(artist, "join")
        if join:
            out += join if join == "," else f" {join} "
    out = re.sub(r"\s{2,}", " ", out.replace(",", ", ")).strip().strip(",").strip()
    return out or None


def csv_children(release, container, tag):
    node = release.find(container)
    if node is None:
        return None
    vals = [c.text for c in node.findall(tag) if c.text]
    return ", ".join(vals) if vals else None


def collect_formats(release):
    node = release.find("formats")
    if node is None:
        return None
    out = []
    for fmt in node.findall("format"):
        name = fmt.get("name")
        descs = fmt.find("descriptions")
        if descs is not None:
            extra = [d.text for d in descs.findall("description") if d.text]
            if extra:
                name = f"{name} ({', '.join(extra)})" if name else ", ".join(extra)
        if name:
            out.append(name)
    return "; ".join(out) if out else None


def first_label(release):
    node = release.find("labels")
    if node is None:
        return None
    label = node.find("label")
    return label.get("name") if label is not None else None


def norm_barcode(raw):
    """Normalize a raw barcode string to a canonical GTIN-14, or None if junk.

    The barcode is the UPC/EAN join key to MusicBrainz. Discogs stores it in many
    surface forms — a spaced "Text" form ("0 7464-63628-2 2") and a clean "String"
    form, plus genuine variants across pressings. We strip all non-digits, then
    keep only UPC-A (12) / EAN-13 (13) / GTIN-14 (14) and left-zero-pad to 14, so a
    Discogs UPC-A and an MB EAN-13 (== leading-0 + the same UPC-A) collapse to one
    key. Other lengths are runout numbers, catalog ids, or garbage misfiled under
    type="Barcode" -> dropped. Apply this same normalization on the MB side.
    """
    if not raw:
        return None
    d = _NON_DIGIT.sub("", raw)
    if len(d) in (12, 13, 14):
        return d.zfill(14)
    return None


def collect_barcodes(release):
    """Normalized, de-duplicated GTIN-14 barcodes for a release, as a JSON list.

    Pulls only <identifier type="Barcode"> out of <identifiers> (the block is
    mostly Matrix/Runout + SID codes), normalizes each, and returns a sorted JSON
    array — or None when the release carries no usable barcode (the common case, so
    the column stays NULL and the join side never has to parse empty JSON). A
    release legitimately can carry more than one distinct barcode (multi-disc /
    re-barcoded pressings); we keep them all so the UPC join gets every edge.
    """
    node = release.find("identifiers")
    if node is None:
        return None
    out = set()
    for idn in node.findall("identifier"):
        if idn.get("type") == "Barcode":
            v = norm_barcode(idn.get("value"))
            if v:
                out.add(v)
    if not out:
        return None
    return json.dumps(sorted(out), ensure_ascii=False)


def collect_credits(release):
    """Release-level personnel from <extraartists> (F27), in sleeve order:
    [(person_id, name, role), ...]. name/role are kept exactly as Discogs stores
    them — the role is a quote, never a vocabulary. person_id is the stable
    Discogs artist id, or None for an unlinked credit (id 0/missing: a name, not
    a person — the UI shows it as plain text, never a door). Track-level credits
    (inside <tracklist>) are intentionally out of scope for v1."""
    node = release.find("extraartists")
    if node is None:
        return []
    out = []
    for a in node.findall("artist"):
        name = text_of(a, "name")
        if not name:
            continue
        aid = (text_of(a, "id") or "").strip()
        pid = int(aid) if aid.isdigit() and int(aid) > 0 else None
        out.append((pid, name, text_of(a, "role")))
    return out


def collect_tracks(release):
    """Compact list of real tracks: [{'pos','title','dur'}, ...].
    Skips heading rows (no title) so the note dropdown only shows real tracks."""
    node = release.find("tracklist")
    if node is None:
        return None
    out = []
    for tr in node.findall("track"):
        title = text_of(tr, "title")
        if not title:
            continue
        pos = (text_of(tr, "position") or "").strip()
        dur = (text_of(tr, "duration") or "").strip()
        # Skip section/heading rows (e.g. "Side A", "Disc 1"): a title but no
        # position and no duration. Real tracks have at least one of those.
        if not pos and not dur:
            continue
        out.append({"pos": pos, "title": title.strip(), "dur": dur})
    return out or None


def mark_canonical(conn):
    """Collapse Discogs pressings to one entry per album, anchored to its
    earliest known full release date (F6).

    Every Discogs *release* (pressing/reissue) is its own row, so a later
    edition can otherwise surface as an "on this day" original. We flag exactly
    one canonical row per album:

      - Releases that share a real ``master_id`` collapse to their earliest
        pressing (tie-break: lowest ``release_id``).
      - Standalone releases (``master_id`` 0 or NULL, i.e. no master) are each
        canonical on their own date.

    The day/browse/choice queries then read only ``is_canonical = 1`` rows, so an
    album appears once, on the earliest full date we have. (That earliest date
    can still post-date the true original if Discogs only has a year for the
    first pressing — ingesting the masters dump would close that gap.)

    A partial index keeps the day lookup fast. Safe to re-run: it resets and
    recomputes the flag, so it doubles as a migration for an existing DB.
    """
    cols = [r[1] for r in conn.execute("PRAGMA table_info(albums)")]
    if "is_canonical" not in cols:
        conn.execute(
            "ALTER TABLE albums ADD COLUMN is_canonical INTEGER NOT NULL DEFAULT 0")
    else:
        conn.execute("UPDATE albums SET is_canonical = 0")
    # Standalone releases (no master) are always canonical.
    conn.execute(
        "UPDATE albums SET is_canonical = 1 WHERE master_id IS NULL OR master_id = 0")
    # Grouped releases: keep the earliest pressing per master. Stage the winning
    # release_ids in an indexed temp table first, then flag by join — far faster
    # on millions of rows than a correlated IN-subquery.
    conn.execute("DROP TABLE IF EXISTS _canon")
    conn.execute("""
        CREATE TEMP TABLE _canon AS
        SELECT release_id FROM (
            SELECT release_id,
                   ROW_NUMBER() OVER (
                       PARTITION BY master_id
                       ORDER BY released ASC, release_id ASC) AS rn
            FROM albums
            WHERE master_id IS NOT NULL AND master_id > 0
        ) WHERE rn = 1
    """)
    conn.execute("CREATE UNIQUE INDEX _canon_rid ON _canon (release_id)")
    conn.execute(
        "UPDATE albums SET is_canonical = 1 "
        "WHERE release_id IN (SELECT release_id FROM _canon)")
    conn.execute("DROP TABLE _canon")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_canon_monthday "
        "ON albums (release_month, release_day) WHERE is_canonical = 1")
    # Partial NOCASE indexes backing the artist/label panels (db.albums_by_artist
    # / db.albums_on_label). The leading column carries the COLLATE NOCASE so a
    # `col = ? COLLATE NOCASE` lookup is an index seek, and the trailing `year`
    # supplies the newest-first order for free. Without these, opening a label or
    # artist panel full-scans every canonical row of a multi-GB catalog — the
    # "minutes to load" / "Couldn't load the catalog" reports (feedback #9, #12).
    # Like idx_canon_monthday, IF NOT EXISTS makes re-running this a migration for
    # an already-built DB.
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_canon_label "
        "ON albums (label COLLATE NOCASE, year DESC) WHERE is_canonical = 1")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_canon_artist "
        "ON albums (artist COLLATE NOCASE, year DESC) WHERE is_canonical = 1")
    # Partial master index backing the "other releases of this album" door
    # (F27-1b, db.pressings_for): master -> its pressings in lineage (released)
    # order, straight off the index. Partial (master_id > 0) because standalone
    # rows are never looked up by master; like the rest, IF NOT EXISTS makes a
    # re-run a migration.
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_master "
        "ON albums (master_id, released) WHERE master_id > 0")
    conn.commit()


def index_credits(conn):
    """Indexes for the two F27 read paths: the room (release → its credits) and
    the person's door (person → everywhere they're credited; partial, since an
    unlinked NULL person_id can never be looked up). Created after the bulk
    insert — cheaper than maintaining them during it — and IF NOT EXISTS makes
    re-running this a migration for an already-built DB."""
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_credits_release "
        "ON credits (release_id)")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_credits_person "
        "ON credits (person_id) WHERE person_id IS NOT NULL")
    conn.commit()


def build_search_index(db_path, search_path):
    """Build the full-text search index (search.db) from albums.db.

    A contentless FTS5 table (`content=''`) over artist/title/genres/styles/label,
    keyed by ``rowid = release_id`` and populated from canonical rows only (one
    entry per album, matching what Browse shows). Contentless keeps it small —
    it stores the inverted index, not a copy of the text — and self-contained in
    its own file, so it can be rebuilt or shipped independently of the big album
    DB. Safe to re-run: the file is recreated from scratch.
    """
    search_path = Path(search_path)
    if search_path.exists():
        search_path.unlink()
    sc = sqlite3.connect(search_path)
    sc.execute("PRAGMA journal_mode=OFF")
    sc.execute("PRAGMA synchronous=OFF")
    sc.execute(
        "CREATE VIRTUAL TABLE albums_fts USING fts5("
        "artist, title, genres, styles, label, content='', tokenize='unicode61')")
    sc.execute("ATTACH ? AS src", (str(db_path),))
    sc.execute(
        "INSERT INTO albums_fts(rowid, artist, title, genres, styles, label) "
        "SELECT release_id, artist, title, genres, styles, label "
        "FROM src.albums WHERE is_canonical = 1")
    sc.commit()
    sc.execute("INSERT INTO albums_fts(albums_fts) VALUES('optimize')")
    sc.commit()
    n = sc.execute("SELECT count(*) FROM albums_fts").fetchone()[0]
    # Aux entity index: persons_fts, in the same search.db (cheap, ~114 MB), so a
    # rebuild keeps it same-vintage with albums_fts. The heavy tracks_fts (~2.7 GB)
    # is NOT built here — it's opt-in via `python tools/build_search_aux.py
    # --tracks` and its own rsync-headroom decision (CLAUDE.md disk incident).
    try:
        from tools import build_search_aux
        build_search_aux.build_persons_fts(sc, db_path)
    except Exception as e:  # noqa: BLE001 - the album index is what must not fail
        print(f"Search index: persons_fts skipped ({e})")
    sc.close()
    print(f"Search index: {search_path}  ({n:,} albums, "
          f"{search_path.stat().st_size/1e6:.0f} MB)")


# --- Parallel parse pipeline ------------------------------------------------
# How many blocks to ship to a worker per task. Big enough to amortize the
# pickling/IPC cost, small enough to keep memory bounded and progress smooth.
_BATCH_BLOCKS = 200


def _worker_count():
    """Worker processes for parsing. Leave one core for the main writer/producer."""
    env = os.environ.get("AOTD_BUILD_WORKERS")
    if env:
        try:
            return max(1, int(env))
        except ValueError:
            pass
    return max(1, (os.cpu_count() or 2) - 1)


def _parse_block(buf):
    """Parse one raw ``<release>…</release>`` byte block.

    Returns ``(album_tuple, track_tuple_or_None, credit_rows)`` for a release
    with a full date, else ``None``. Runs inside a worker process; uses the same
    extraction helpers as before (their find/findall/get/.text API is
    lxml-compatible).
    """
    try:
        elem = LET.fromstring(buf)
    except LET.XMLSyntaxError:
        return None
    parsed = parse_date(text_of(elem, "released"))
    if not parsed:
        return None
    y, mo, d = parsed
    rid = int(elem.get("id"))
    mid = elem.find("master_id")
    album = (
        rid,
        int(mid.text) if mid is not None and mid.text else None,
        text_of(elem, "title") or "(untitled)",
        collect_artists(elem) or "(unknown artist)",
        text_of(elem, "released"),
        y, mo, d,
        text_of(elem, "country"),
        csv_children(elem, "genres", "genre"),
        csv_children(elem, "styles", "style"),
        collect_formats(elem),
        first_label(elem),
        collect_barcodes(elem),
    )
    tracks = collect_tracks(elem)
    track = (rid, json.dumps(tracks, ensure_ascii=False)) if tracks else None
    credits = [(rid, pid, name, role, i)
               for i, (pid, name, role) in enumerate(collect_credits(elem))]
    return album, track, credits


def _parse_batch(blocks):
    """Worker entry point: parse raw blocks → (albums, tracks, credits) lists."""
    albums = []
    tracks = []
    credits = []
    for buf in blocks:
        r = _parse_block(buf)
        if r is None:
            continue
        a, t, cr = r
        albums.append(a)
        if t is not None:
            tracks.append(t)
        credits.extend(cr)
    return albums, tracks, credits


def _parse_block_credits(buf):
    """Credits-only parse for the ``--credits-only`` backfill: the credit rows
    ``[(release_id, person_id, name, role, seq), ...]`` for a release with a
    full date (the same population filter as ``_parse_block``), else ``None``.
    Skipping the album-tuple extraction keeps the backfill workers lean."""
    try:
        elem = LET.fromstring(buf)
    except LET.XMLSyntaxError:
        return None
    if not parse_date(text_of(elem, "released")):
        return None
    rid = int(elem.get("id"))
    return [(rid, pid, name, role, i)
            for i, (pid, name, role) in enumerate(collect_credits(elem))]


def _parse_batch_credits(blocks):
    """Worker entry point for the backfill: raw blocks → (credit_rows, dated)."""
    rows = []
    dated = 0
    for buf in blocks:
        r = _parse_block_credits(buf)
        if r is None:
            continue
        dated += 1
        rows.extend(r)
    return rows, dated


def _iter_release_blocks(dump_path, counter):
    """Stream the gzip and yield raw bytes for each ``<release>…</release>``.

    Splitting on the closing tag is safe and cheap: releases never nest, and the
    literal ``</release>`` never appears inside text (it'd be entity-escaped).
    This keeps the expensive XML parsing out of the producer so it can race
    ahead of the workers. ``counter`` is bumped per block for progress display.
    """
    opener = gzip.open if str(dump_path).endswith(".gz") else open
    CLOSE = b"</release>"
    OPEN = b"<release "
    buf = b""
    with opener(dump_path, "rb") as fh:
        while True:
            chunk = fh.read(1 << 20)
            if not chunk:
                break
            buf += chunk
            parts = buf.split(CLOSE)
            # All but the last part are complete releases; the last is a partial
            # tail carried into the next read.
            for p in parts[:-1]:
                block = p + CLOSE
                s = block.find(OPEN)
                if s >= 0:
                    counter[0] += 1
                    yield block[s:]
            buf = parts[-1]


def _batched(it, n):
    """Group an iterable into lists of up to n items."""
    batch = []
    for x in it:
        batch.append(x)
        if len(batch) >= n:
            yield batch
            batch = []
    if batch:
        yield batch


def build(dump_path, db_path):
    # Fresh albums build. Remove the DB *and* any stale WAL/SHM sidecars: a
    # leftover -wal from a previous or crashed build must never be replayed into
    # the new file (and a giant orphaned -wal just wastes disk).
    for p in (db_path, Path(f"{db_path}-wal"), Path(f"{db_path}-shm")):
        if p.exists():
            p.unlink()
    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=OFF")
    # Keep the write-ahead log small: with periodic commits below, SQLite
    # checkpoints the WAL back into the main DB every ~1000 pages instead of
    # letting it grow to many GB (an unbounded -wal was what exhausted the disk
    # and crashed the build with "Bus error: 10").
    conn.execute("PRAGMA wal_autocheckpoint=1000")

    kept = 0
    batch = []
    track_batch = []
    credit_batch = []
    t0 = time.time()

    def flush():
        if batch:
            conn.executemany(
                "INSERT OR REPLACE INTO albums VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                batch)
            batch.clear()
        if track_batch:
            conn.executemany(
                "INSERT OR REPLACE INTO tracklists VALUES (?,?)", track_batch)
            track_batch.clear()
        if credit_batch:
            conn.executemany(
                "INSERT INTO credits VALUES (?,?,?,?,?)", credit_batch)
            credit_batch.clear()
        # Commit each batch so the WAL checkpoints and stays small. Without this
        # the entire multi-million-row build is one open transaction and the WAL
        # balloons to many GB. The build is rebuilt from the dump on any failure,
        # so we don't need a single all-or-nothing transaction anyway.
        conn.commit()

    def absorb(albums, tracks, credits):
        nonlocal kept
        batch.extend(albums)
        track_batch.extend(tracks)
        credit_batch.extend(credits)
        kept += len(albums)
        if len(batch) >= 5000:
            flush()

    # Producer (this process) decompresses + splits raw <release> blocks; a pool
    # of workers parses + extracts in parallel; we stay the sole SQLite writer.
    # apply_async with a bounded pending queue caps how far the producer races
    # ahead, so memory stays flat over the whole 100+ GB stream.
    workers = _worker_count()
    print(f"Parsing across {workers} worker process(es) (lxml) ...")
    counter = [0]  # blocks seen by the producer (== releases scanned)
    batches = _batched(_iter_release_blocks(dump_path, counter), _BATCH_BLOCKS)
    ctx = mp.get_context("spawn")
    pending = deque()
    max_pending = workers * 3
    with ctx.Pool(workers) as pool:
        for b in batches:
            pending.append(pool.apply_async(_parse_batch, (b,)))
            if len(pending) >= max_pending:
                albums, tracks, credits = pending.popleft().get()
                absorb(albums, tracks, credits)
                rate = counter[0] / max(time.time() - t0, 1)
                print(f"\r  scanned {counter[0]:,}  kept {kept:,}  "
                      f"({rate:,.0f}/s)", end="", flush=True)
        while pending:
            albums, tracks, credits = pending.popleft().get()
            absorb(albums, tracks, credits)

    scanned = counter[0]
    flush()
    conn.commit()
    print("Marking one canonical entry per album (earliest pressing) ...")
    mark_canonical(conn)
    print("Indexing credits ...")
    index_credits(conn)
    conn.execute("ANALYZE")
    conn.commit()
    # Fold the WAL back into the main DB and shrink the sidecar to zero so we
    # don't leave a large -wal behind.
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    conn.close()
    print(f"\nDone. Scanned {scanned:,} releases, kept {kept:,} with full dates.")
    print(f"Database: {db_path}  ({db_path.stat().st_size/1e6:.0f} MB)")
    # Exact, unbiased Discogs UPC coverage over the whole kept population — the
    # P2 join's clean-key reach on the Discogs side. (Pairs with MB's ~28%.)
    _report_barcode_coverage(db_path)
    print("Building full-text search index ...")
    build_search_index(db_path, config.SEARCH_DB_PATH)


def backfill_credits(dump_path, db_path):
    """Populate ONLY the credits table (F27) inside an EXISTING albums.db by
    re-streaming the dump — the cheap alternative to a full rebuild when the
    catalog rows are already current for this dump's vintage. Drops and refills
    the table (so a re-run is idempotent), indexes it, then prunes any rows
    whose release isn't in the catalog, so a mismatched dump can't leave orphan
    credits. albums/art/tracklists/search are never touched, and writes are
    WAL-batched, so the app can keep reading while this runs (db.credits_for
    degrades to an empty room mid-backfill, never an error)."""
    conn = sqlite3.connect(db_path)
    have = conn.execute(
        "SELECT name FROM sqlite_master WHERE name='albums'").fetchone()
    if not have:
        conn.close()
        sys.exit(f"{db_path} has no albums table — run a full build first "
                 "(--credits-only only refills credits inside an existing DB).")
    total_albums = conn.execute("SELECT COUNT(*) FROM albums").fetchone()[0]
    conn.execute("PRAGMA journal_mode=WAL")
    # NORMAL, not OFF: unlike a from-scratch build this DB holds the hard-won
    # art cache, so a crash mid-backfill must never risk the whole file.
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA wal_autocheckpoint=1000")
    conn.execute("DROP TABLE IF EXISTS credits")
    conn.executescript(CREDITS_SCHEMA)
    conn.commit()

    workers = _worker_count()
    print(f"Backfilling credits into {db_path} ({total_albums:,} albums) "
          f"from {Path(dump_path).name}")
    print(f"Parsing across {workers} worker process(es) (lxml) ...")
    kept = rows = 0
    batch = []
    t0 = time.time()

    def flush():
        if batch:
            conn.executemany("INSERT INTO credits VALUES (?,?,?,?,?)", batch)
            batch.clear()
        conn.commit()

    counter = [0]
    batches = _batched(_iter_release_blocks(dump_path, counter), _BATCH_BLOCKS)
    ctx = mp.get_context("spawn")
    pending = deque()
    max_pending = workers * 3

    def absorb(credits, dated):
        nonlocal kept, rows
        kept += dated
        rows += len(credits)
        batch.extend(credits)
        if len(batch) >= 5000:
            flush()

    with ctx.Pool(workers) as pool:
        for b in batches:
            pending.append(pool.apply_async(_parse_batch_credits, (b,)))
            if len(pending) >= max_pending:
                credits, dated = pending.popleft().get()
                absorb(credits, dated)
                rate = counter[0] / max(time.time() - t0, 1)
                print(f"\r  scanned {counter[0]:,}  dated {kept:,}  "
                      f"credits {rows:,}  ({rate:,.0f}/s)", end="", flush=True)
        while pending:
            credits, dated = pending.popleft().get()
            absorb(credits, dated)
    flush()

    print("\nIndexing credits ...")
    index_credits(conn)
    # A credits row for a release we never ingested would be an unreachable
    # orphan (and, worse, an off-vintage dump silently half-applied). With the
    # same dump the catalog was built from this deletes exactly nothing.
    pruned = conn.execute(
        "DELETE FROM credits WHERE release_id NOT IN "
        "(SELECT release_id FROM albums)").rowcount
    conn.commit()
    conn.execute("ANALYZE credits")
    conn.commit()
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    n, people = conn.execute(
        "SELECT COUNT(*), COUNT(DISTINCT person_id) FROM credits").fetchone()
    conn.close()
    mins = (time.time() - t0) / 60
    print(f"Done in {mins:,.0f} min. Scanned {counter[0]:,} releases "
          f"({kept:,} dated); kept {n:,} credit rows "
          f"({people:,} distinct people), pruned {pruned:,} orphans.")
    print(f"Database: {db_path}  ({Path(db_path).stat().st_size/1e6:,.0f} MB)")


def _report_barcode_coverage(db_path):
    """Print Discogs UPC/barcode coverage over the kept population (overall + by
    decade). This is the exact, full-catalog figure the P2 spike wanted — no
    sampling — and it falls out for free at the end of a rebuild."""
    conn = sqlite3.connect(db_path)
    total, with_bc = conn.execute(
        "SELECT COUNT(*), COUNT(barcodes) FROM albums").fetchone()
    if total:
        print(f"Discogs UPC coverage (kept rows): {with_bc:,}/{total:,} "
              f"= {with_bc / total:.1%}")
        rows = conn.execute(
            "SELECT (year/10)*10 AS dec, COUNT(*), COUNT(barcodes) "
            "FROM albums WHERE year IS NOT NULL GROUP BY dec ORDER BY dec")
        for dec, n, b in rows:
            if n >= 1000:
                print(f"    {dec}s: {b / n:5.1%}  (n={n:,})")
    conn.close()


def _app_running():
    """True if something (almost certainly the app) is serving on HOST:PORT."""
    import socket
    try:
        with socket.create_connection((config.HOST, config.PORT), timeout=0.5):
            return True
    except OSError:
        return False


def _stop_app_message():
    return (
        f"\nThe app appears to be running at http://{config.HOST}:{config.PORT}.\n"
        "The database can't be rebuilt while the app has it open.\n\n"
        "  → Stop the app first: press Ctrl+C in the terminal running it\n"
        "    (or close that window), then run the rebuild again.\n")


def main():
    ap = argparse.ArgumentParser(
        description="Build albums.db from a Discogs releases dump")
    ap.add_argument("dump", nargs="?", default=None,
                    help="dump file (default: data/dumps/latest.txt)")
    ap.add_argument("--credits-only", action="store_true",
                    help="F27 backfill: refill ONLY the credits table inside "
                         "the existing albums.db (no rebuild)")
    args = ap.parse_args()

    config.ensure_dirs()
    if args.dump:
        dump = Path(args.dump)
    else:
        ptr = config.DUMP_DIR / "latest.txt"
        if not ptr.exists():
            sys.exit("No dump specified and no latest.txt. Run download.py first.")
        dump = Path(ptr.read_text().strip())
    if not dump.exists():
        sys.exit(f"Dump not found: {dump}")

    if args.credits_only:
        # WAL-safe alongside a running app (nothing is deleted or rewritten),
        # so no _app_running() gate here.
        backfill_credits(dump, config.DB_PATH)
        return

    # Refuse to rebuild while the app is live — otherwise deleting/rewriting the
    # open database fails midway with a cryptic "disk I/O error".
    if _app_running():
        sys.exit(_stop_app_message())

    print(f"Building {config.DB_PATH} from {dump.name} ...")
    try:
        build(dump, config.DB_PATH)
    except sqlite3.OperationalError as e:
        # Safety net: if it's still a lock/IO error, the app is likely running.
        sys.exit(f"\nDatabase write failed: {e}\n{_stop_app_message()}")


if __name__ == "__main__":
    main()
