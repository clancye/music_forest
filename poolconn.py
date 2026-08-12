"""
Pool connection factory (leaf module).

Extracted from pooldb.py (2026-08-08) into its own leaf so both the read layer
(pooldb) and the door/backfill layer (pooldoor) share _conn without an import
cycle: the module graph is a strict DAG, poolconn <- pooldoor <- pooldb.

BE2a — the LIVE-layer split. The crawler's irreplaceable warmth (`availability`,
`door_links`, `crawl_status`, `spotify_daily_log`) moved OUT of pool.sqlite into
`config.LIVE_DB_PATH` (data/live.sqlite) so a pool rebuild can't touch it. This module
is the ONE place that decides whether the split has happened and, if so, ATTACHes the
live file onto every pool connection AS `live`. Callers reference the four tables with
the `LIVE` prefix (== "live." when split, "" otherwise), so:

  * BEFORE the migration (no live.sqlite): LIVE == "", nothing is attached, and every
    query is byte-identical to the pre-split behaviour — the four tables are still read
    and written in pool.sqlite. The split is a pure no-op until the file exists.
  * AFTER the migration: LIVE == "live.", live.sqlite is attached on each _conn(), and
    the four tables resolve to it while `pool` stays in the (now fully static) main DB.

The decision is made ONCE at import (a process serves either the pre- or post-migration
world, never both mid-run); the migration coordinates a crawler restart + server
redeploy so every consumer re-reads it cleanly.
"""
import sqlite3
from pathlib import Path

import config


def _live_enabled():
    """True iff the live-split migration has run — i.e. config.LIVE_DB_PATH exists AND
    carries the split tables (checked via `availability`, its anchor table). A bare/empty
    live.sqlite (e.g. one an ATTACH auto-created) does NOT count, so a half-migration
    can't hijack the four tables away from a still-populated pool.sqlite."""
    p = Path(config.LIVE_DB_PATH)
    if not p.exists():
        return False
    try:
        con = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
        try:
            row = con.execute("SELECT 1 FROM sqlite_master WHERE type='table' "
                              "AND name='availability'").fetchone()
            return row is not None
        finally:
            con.close()
    except sqlite3.Error:
        return False


# Decided once per process (see module docstring). LIVE is the schema prefix every
# reader/writer of the four live tables interpolates into its SQL.
LIVE_ENABLED = _live_enabled()
LIVE = "live." if LIVE_ENABLED else ""


def attach_live(c):
    """ATTACH live.sqlite AS `live` onto an existing pool.sqlite connection, IFF the
    split has happened (else a no-op). Used by _conn() and by the standalone availability
    writers (precompute_availability / availability_lap), which open their own pool
    connection but still need `live.availability` in scope for the pool<->availability
    join + write. Idempotent-safe: never attach twice on one connection."""
    if LIVE_ENABLED:
        c.execute("ATTACH DATABASE ? AS live", (str(config.LIVE_DB_PATH),))
    return c


def _conn():
    c = sqlite3.connect(config.POOL_DB_PATH, timeout=30)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA busy_timeout=30000")
    attach_live(c)
    return c
