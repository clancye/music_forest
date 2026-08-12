"""Data-magnitude ("is this a REAL dataset, or a test-fixture STUB?") checks.

WHY THIS EXISTS. Incident 2026-08-09: a `pytest tools/` run overwrote
data/pool.sqlite + data/albums.db with 2-row test fixtures; the always-on crawler
rsynced the pool stub to prod + staging and every deck went blank — while /healthz
stayed GREEN and the operator console's markers all read healthy. The reason nothing
caught it: every health check asked "does the DB open / answer a query?", which a
valid tiny stub passes, and NONE asked "is it a real-sized dataset?". This module is
that missing question, so a stub can never again pass silently.

It is deliberately dependency-light (config + sqlite3 only) so the bash agents can
call it too. One question, asked in four places:
  * tools/rsync_pool.sh   -> REFUSE to ship a stub to prod (prevention; this guard
                             alone would have stopped the 08-09 outage).
  * server.py /healthz    -> a NON-FATAL `data` check (stays 200 so Render can't
                             crash-loop on it — the 07-08 Shell-lockout lesson — but
                             flips the operator console + the uptime pinger).
  * tools/uptime_ping.sh  -> a macOS "STUB DETECTED" alert within ~5 min.
  * tools/db_watchdog.sh  -> a local watchdog that ALSO covers albums.db (never
                             rsynced, so prod's /healthz can't see it; its stub is the
                             one that silently zeroed Apple for days).

The check is cheap: a bounded "does the floor-th row exist?" OFFSET walk (O(floor),
~1-40ms), never a full COUNT of a multi-GB table. Reads are best-effort and
immutable-mode-tolerant, so a concurrent writer (the crawler) or a missing file never
raises — it reports `unknown`, which is NOT treated as a stub (a fresh host legitimately
lacks catalog.sqlite; only a file that EXISTS and is below its floor is a stub).

Floors: config.POOL_MIN_ROWS / CATALOG_MIN_ENTITIES / ALBUMS_MIN_ROWS / AVAIL_MIN_ROWS
(the last floors live.sqlite's availability — BE2a; all env-overridable).
"""
import argparse
import sqlite3
import sys
from pathlib import Path

import config

# name -> (path, table, floor). The datasets whose sudden tininess means a stub
# overwrote a real DB. `albums` is included for the local watchdog / rsync gate even
# though rsync_pool.sh never ships it: a stubbed albums.db silently zeros the Apple
# backfill (the 08-09 symptom that went unnoticed for days).
def _specs():
    return {
        "pool":    (config.POOL_DB_PATH,    "pool",         config.POOL_MIN_ROWS),
        "catalog": (config.CATALOG_DB_PATH, "entities",     config.CATALOG_MIN_ENTITIES),
        "albums":  (config.DB_PATH,         "albums",       config.ALBUMS_MIN_ROWS),
        # BE2a: the LIVE layer's warmth. A wiped/stubbed live.sqlite would silently zero
        # availability (the daily-draw gate) exactly like a stubbed pool once did. Floored
        # on `availability` (its ~1.97M-row anchor). Absent file => `unknown`, never a stub
        # (a pre-migration host has no live.sqlite; a legit partial isn't blocked).
        "live":    (config.LIVE_DB_PATH,    "availability", config.AVAIL_MIN_ROWS),
    }


def _open_ro(path):
    """A best-effort read-only connection that tolerates a concurrent writer. Tries
    mode=ro first, then immutable=1 (main-file-only, ignores the WAL and never fails on
    an active writer) — fine for a magnitude check, where WAL staleness can't turn a
    2M-row dataset into a 2-row one. None if the file is absent/unopenable."""
    p = Path(path).resolve()
    if not p.exists():
        return None
    for uri in (f"file:{p}?mode=ro", f"file:{p}?immutable=1"):
        try:
            return sqlite3.connect(uri, uri=True)
        except sqlite3.Error:
            continue
    return None


def _has_floor_rows(path, table, floor):
    """True if `table` has >= floor rows, False if it's a STUB (fewer), None if
    unknown (missing/unreadable file or table). Bounded OFFSET walk — reads at most
    `floor` rows, never a full table scan."""
    con = _open_ro(path)
    if con is None:
        return None
    try:
        row = con.execute(
            f"SELECT 1 FROM {table} LIMIT 1 OFFSET ?", (max(0, floor - 1),)).fetchone()
        return bool(row)
    except sqlite3.Error:
        return None
    finally:
        con.close()


def probe(names=None):
    """[{name, ok, floor, table, path}] for each dataset (or the subset in `names`).
    ok: True (>= floor, healthy) · False (STUB — exists but below floor) · None
    (unknown — file/table absent or unreadable)."""
    out = []
    for name, (path, table, floor) in _specs().items():
        if names and name not in names:
            continue
        out.append({"name": name, "ok": _has_floor_rows(path, table, floor),
                    "floor": floor, "table": table, "path": str(path)})
    return out


def stubs(names=None):
    """Names whose dataset is DEFINITIVELY a stub (exists but below floor). `unknown`
    is intentionally NOT a stub — a missing catalog.sqlite on a fresh host is graceful
    degradation, not a fixture overwrite. This is the boolean the gates key on."""
    return [p["name"] for p in probe(names) if p["ok"] is False]


def _fmt(p):
    state = {True: "ok", False: "STUB", None: "unknown"}[p["ok"]]
    return f"  {p['name']:8s} {state:8s} (floor {p['floor']:,} rows · {p['path']})"


def main(argv=None):
    ap = argparse.ArgumentParser(description="Data-magnitude stub check. Exit 1 if any "
                                             "checked dataset is a stub, else 0.")
    ap.add_argument("--check", default="",
                    help="comma-separated subset (pool,catalog,albums,live); default all")
    ap.add_argument("--quiet", action="store_true",
                    help="print only when a stub is found")
    args = ap.parse_args(argv)
    names = tuple(n for n in args.check.split(",") if n) or None
    rows = probe(names)
    bad = [p for p in rows if p["ok"] is False]
    if bad or not args.quiet:
        print("data magnitude:")
        for p in rows:
            print(_fmt(p))
    if bad:
        print(f"!! STUB DETECTED: {', '.join(p['name'] for p in bad)} — a real DB was "
              f"overwritten by a test fixture (see dbsanity.py).", file=sys.stderr)
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
