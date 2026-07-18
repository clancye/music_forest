"""opsdb.py — ops.sqlite: small operational counters owned by THIS HOST.

WHY A SEPARATE DATABASE, and not a table in pool.sqlite.
Everything else the server reads is SHIPPED from the Mac and replaced wholesale:
`tools/rsync_pool.sh` pushes `pool.sqlite` (+ catalog / mb_bandcamp) as WHOLE FILES,
so anything the SERVER writes into pool.sqlite is destroyed on the next push — which
happens several times a day, whenever the door crawler finishes a calendar day. The
pool already documents this for the availability rows ("on Render they're ephemeral
until the Mac's lap catches up — the whole-file rsync_pool.sh push overwrites them;
acceptable, self-healing", BACKLOG). For a link cache that's fine: it re-resolves.
For a COUNTER it is not — it would silently reset several times a day and under-report
exactly when the number matters. `ops.sqlite` is never in rsync_pool.sh's FILES, so
it accumulates, and it rides the Render disk across deploys.

WHAT IT COUNTS (`spotify_burn`). Spotify is the one KEYED resolver, and its budget is
shared and hard: ~780 Searches/day for the whole app, measured 2026-07-16 — prod uses
ONE client_id, so exhausting it 429s the on-demand door for EVERY user at once (a 7.3h
ban, that day). Two things spend it: the bounded nightly prewarm, and real users'
on-demand door opens. Only the prewarm was ever counted (`pool.spotify_daily_log`,
written by the Mac). The door's spend — the half that grows with every new person
invited — was invisible, so the first warning would have been the 429 itself.

Counting happens per-HOST, which falls out of `pooldb.backfill_spotify` being the one
place a Search is issued: on PROD this table is real users' door opens; on the Mac it's
the prewarm's own burn. Same code, and each host's file answers "what did I spend today".

NEVER FAILS A REQUEST. Every function swallows its errors: a counter must not be able
to break a door open. A missing table, a locked file, a read-only disk — all degrade to
"no number", never to an exception on the request path.
"""
import sqlite3
from datetime import datetime, timezone

import config

_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS spotify_burn ("
    "day TEXT PRIMARY KEY, searches INT NOT NULL DEFAULT 0, "
    "filled INT NOT NULL DEFAULT 0, miss INT NOT NULL DEFAULT 0, "
    "err INT NOT NULL DEFAULT 0, last_at TEXT)")

# Anonymized daily feature counters (the /admin Usage panel). One row per (day, key);
# `key` is a feature name like "today_served" / "explore_search" / "door_open". Counts
# only — NO user id, NO content — so it's an aggregate of what the SERVER already sees on
# the request path, never a per-person or per-notebook record. Same "never fails a
# request" discipline as spotify_burn: a counter must not be able to break a page load.
_USAGE_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS usage_counter ("
    "day TEXT NOT NULL, key TEXT NOT NULL, n INT NOT NULL DEFAULT 0, "
    "PRIMARY KEY (day, key))")

# The outcomes a Search can have, and the only strings interpolated into SQL below —
# an unknown one is folded into `miss` rather than trusted.
_OUTCOMES = ("filled", "miss", "err")


def _conn():
    c = sqlite3.connect(config.OPS_DB_PATH, timeout=10)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA busy_timeout=10000")
    # WAL: 2 gunicorn workers x 8 threads can all be opening doors at once, and a
    # counter must never be the thing that blocks one.
    c.execute("PRAGMA journal_mode=WAL")
    return c


def _today(now=None):
    return (now or datetime.now(timezone.utc)).strftime("%Y-%m-%d")


def record_spotify_search(outcome, *, now=None):
    """Count ONE Spotify Search that actually went out to the API. Call it only where
    the call is made — not where a cached link short-circuits (a 'have'/'skip' spends
    no quota, and counting it would overstate the burn we're protecting)."""
    now_dt = now or datetime.now(timezone.utc)
    col = outcome if outcome in _OUTCOMES else "miss"
    try:
        with _conn() as c:
            c.execute(_SCHEMA)
            c.execute(
                f"INSERT INTO spotify_burn (day, searches, {col}, last_at) "
                f"VALUES (?, 1, 1, ?) "
                f"ON CONFLICT(day) DO UPDATE SET searches = searches + 1, "
                f"{col} = {col} + 1, last_at = excluded.last_at",
                (_today(now_dt), now_dt.strftime("%Y-%m-%dT%H:%M:%SZ")))
    except Exception:  # noqa: BLE001 — a counter never breaks a door open
        pass


def spotify_burn_today(*, now=None):
    """{day, searches, filled, miss, err, last_at} for today (UTC — the same clock the
    quota resets on). Zeros when nothing has been spent yet; None only if the DB itself
    can't be read, so the caller can tell "nothing spent" from "no answer"."""
    day = _today(now)
    try:
        with _conn() as c:
            c.execute(_SCHEMA)
            row = c.execute(
                "SELECT day, searches, filled, miss, err, last_at FROM spotify_burn "
                "WHERE day = ?", (day,)).fetchone()
    except Exception:  # noqa: BLE001
        return None
    if row is None:
        return {"day": day, "searches": 0, "filled": 0, "miss": 0, "err": 0,
                "last_at": None}
    return dict(row)


def bump(key, *, now=None, delta=1):
    """Count ONE anonymized feature event (e.g. a Today load, an Explore search, a door
    open) into today's (UTC) bucket. Counts only — no user, no content. Swallows every
    error: a counter must never break the request it's counting."""
    try:
        with _conn() as c:
            c.execute(_USAGE_SCHEMA)
            c.execute(
                "INSERT INTO usage_counter (day, key, n) VALUES (?, ?, ?) "
                "ON CONFLICT(day, key) DO UPDATE SET n = n + excluded.n",
                (_today(now), str(key), int(delta)))
    except Exception:  # noqa: BLE001 — a counter never breaks a request
        pass


def usage_recent(days=30, *, now=None):
    """Every (day, key, n) within the last `days` days, newest day first — so the panel
    can sum per feature over a window and draw a per-day trend. [] when unreadable."""
    try:
        from datetime import timedelta
        start = ((now or datetime.now(timezone.utc)) - timedelta(days=int(days) - 1)
                 ).strftime("%Y-%m-%d")
        with _conn() as c:
            c.execute(_USAGE_SCHEMA)
            rows = c.execute(
                "SELECT day, key, n FROM usage_counter WHERE day >= ? "
                "ORDER BY day DESC", (start,)).fetchall()
    except Exception:  # noqa: BLE001
        return []
    return [dict(r) for r in rows]


def spotify_burn_recent(limit=14):
    """Recent days, newest first — the trend, so a creeping burn is visible before it
    is a 429. [] when unreadable."""
    try:
        with _conn() as c:
            c.execute(_SCHEMA)
            rows = c.execute(
                "SELECT day, searches, filled, miss, err, last_at FROM spotify_burn "
                "ORDER BY day DESC LIMIT ?", (int(limit),)).fetchall()
    except Exception:  # noqa: BLE001
        return []
    return [dict(r) for r in rows]
