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
from datetime import datetime, timedelta, timezone

import config
import sqliteconn

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

# The SAME counts, bucketed by UTC hour ("%Y-%m-%dT%H") instead of day — so the
# operator console's time selector can answer sub-day windows (1h..12h) that the day
# table physically can't. bump() writes BOTH; the day table stays the long-history
# store (it predates this and carries weeks), the hourly one only has depth from the
# day hour-bucketing shipped. It's small (≈ keys × 24 rows/day) so it isn't pruned
# here; the day table remains authoritative for coarse windows.
_USAGE_HOURLY_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS usage_hourly ("
    "hour TEXT NOT NULL, key TEXT NOT NULL, n INT NOT NULL DEFAULT 0, "
    "PRIMARY KEY (hour, key))")

# The outcomes a Search can have, and the only strings interpolated into SQL below —
# an unknown one is folded into `miss` rather than trusted.
_OUTCOMES = ("filled", "miss", "err")

# BE2b — silent catalog-overlay/dedup fallbacks. The entity overlay (_catalog_fields),
# cluster dedup (_dedup_clusters), and search-arm dedup all fail SOFT to {} on the serve
# path (good for uptime), so a broken/absent catalog.sqlite degrades serving INVISIBLY —
# staging ran six days without catalog.sqlite, unnoticed (BACKEND_REDESIGN.md §3). This
# counter makes each degrade visible: one row per (day, kind), surfaced on /admin. Same
# host-local, never-fails discipline as spotify_burn (a counter can't break the draw).
_FALLBACK_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS catalog_fallback ("
    "day TEXT NOT NULL, kind TEXT NOT NULL, n INT NOT NULL DEFAULT 0, "
    "last_at TEXT, PRIMARY KEY (day, kind))")
# The overlay/dedup readers that can degrade; an unknown kind folds into `fields`.
_FALLBACK_KINDS = ("fields", "clusters", "search")


def _conn():
    c = sqlite3.connect(config.OPS_DB_PATH, timeout=10)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA busy_timeout=10000")
    # WAL: 2 gunicorn workers x 8 threads can all be opening doors at once, and a
    # counter must never be the thing that blocks one.
    c.execute("PRAGMA journal_mode=WAL")
    return sqliteconn.managed(c)


def _today(now=None):
    return (now or datetime.now(timezone.utc)).strftime("%Y-%m-%d")


def _hour(now=None):
    return (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H")


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


# The on-demand door's PAUSE (2026-10-07, owner: "gracefully let users know"). When
# Spotify stops answering — a rate limit, an outage, a refused credential — every door
# open used to make a fresh failing call (up to ~12s of spinner each) and, during a 429
# ban, fed the penalty. Now a short run of errors pauses the request path's lookups for a
# while; a paused lookup is "couldn't check", never "not on Spotify". One row, shared by
# every worker on this host. The Mac's prewarm never reads it (it has its own patience
# and its own 10-in-a-row stop).
_PAUSE_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS spotify_pause (id INTEGER PRIMARY KEY CHECK (id = 1), "
    "streak INT NOT NULL DEFAULT 0, first_err_at TEXT, last_err_at TEXT, "
    "paused_until TEXT, pauses INT NOT NULL DEFAULT 0, reason TEXT)")
# Errors this close together count as one run; this many in a run pause the lookups.
SPOTIFY_PAUSE_AFTER = 3
_STREAK_WINDOW_MIN = 10
# The first pause is short; each one that follows without a success in between doubles,
# up to two hours (a 429 ban is measured in hours — no point knocking every 15 minutes).
_PAUSE_FIRST_MIN = 15
_PAUSE_MAX_MIN = 120


def _iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse(ts):
    try:
        return datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def spotify_pause_state(*, now=None):
    """{paused, until, since, reason, streak} for the on-demand Spotify lookups. `since`
    is when the run of errors began. Never raises: an unreadable table reads as not
    paused (a counter can't be the thing that blocks a lookup)."""
    now_dt = now or datetime.now(timezone.utc)
    try:
        with _conn() as c:
            c.execute(_PAUSE_SCHEMA)
            row = c.execute("SELECT * FROM spotify_pause WHERE id = 1").fetchone()
    except Exception:  # noqa: BLE001
        row = None
    if row is None:
        return {"paused": False, "until": None, "since": None, "reason": None, "streak": 0}
    until = _parse(row["paused_until"])
    return {"paused": bool(until and until > now_dt), "until": row["paused_until"],
            "since": row["first_err_at"], "reason": row["reason"], "streak": row["streak"]}


def note_spotify_outcome(err, *, now=None):
    """Record one on-demand lookup's outcome. A success clears everything; an error
    extends the run, and SPOTIFY_PAUSE_AFTER errors within _STREAK_WINDOW_MIN of each
    other pause the lookups (15 min, doubling per repeat pause, at most 2 h). Once paused,
    the first failure after the pause ends pauses again — no success in between means
    the trouble hasn't passed. Returns the new state. Never raises."""
    now_dt = now or datetime.now(timezone.utc)
    try:
        with _conn() as c:
            c.execute(_PAUSE_SCHEMA)
            row = c.execute("SELECT * FROM spotify_pause WHERE id = 1").fetchone()
            if not err:
                c.execute("INSERT OR REPLACE INTO spotify_pause (id, streak, pauses) "
                          "VALUES (1, 0, 0)")
            else:
                last = _parse(row["last_err_at"]) if row else None
                fresh = last is None or (now_dt - last).total_seconds() > _STREAK_WINDOW_MIN * 60
                pauses = row["pauses"] if row else 0
                streak = 1 if fresh else row["streak"] + 1
                # Still in trouble (paused before, no success since): keep the original
                # start, and one more failure pauses again rather than three.
                first = (row["first_err_at"] if row and row["first_err_at"] and
                         (pauses or not fresh) else _iso(now_dt))
                until = row["paused_until"] if row else None
                if streak >= SPOTIFY_PAUSE_AFTER or pauses:
                    minutes = min(_PAUSE_MAX_MIN, _PAUSE_FIRST_MIN * (2 ** pauses))
                    until = _iso(now_dt + timedelta(minutes=minutes))
                    pauses += 1
                c.execute(
                    "INSERT OR REPLACE INTO spotify_pause (id, streak, first_err_at, "
                    "last_err_at, paused_until, pauses, reason) VALUES (1,?,?,?,?,?,?)",
                    (streak, first, _iso(now_dt), until, pauses, "not answering"))
    except Exception:  # noqa: BLE001
        pass
    return spotify_pause_state(now=now_dt)


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
        now_dt = now or datetime.now(timezone.utc)
        with _conn() as c:
            c.execute(_USAGE_SCHEMA)
            c.execute(_USAGE_HOURLY_SCHEMA)
            c.execute(
                "INSERT INTO usage_counter (day, key, n) VALUES (?, ?, ?) "
                "ON CONFLICT(day, key) DO UPDATE SET n = n + excluded.n",
                (_today(now_dt), str(key), int(delta)))
            c.execute(
                "INSERT INTO usage_hourly (hour, key, n) VALUES (?, ?, ?) "
                "ON CONFLICT(hour, key) DO UPDATE SET n = n + excluded.n",
                (_hour(now_dt), str(key), int(delta)))
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


def usage_totals():
    """All-time per-key sums plus the first counted day — the "All" window for the
    /admin Usage panel (day-window sums come from usage_recent). Shape
    {"keys": {key: n}, "since": "YYYY-MM-DD" | None}; the empty shape when
    unreadable, same never-fails discipline as every read here."""
    try:
        with _conn() as c:
            c.execute(_USAGE_SCHEMA)
            rows = c.execute(
                "SELECT key, SUM(n) AS n FROM usage_counter GROUP BY key").fetchall()
            since = c.execute("SELECT MIN(day) FROM usage_counter").fetchone()[0]
    except Exception:  # noqa: BLE001
        return {"keys": {}, "since": None}
    return {"keys": {r["key"]: r["n"] for r in rows}, "since": since}


def usage_by_local_day(days, tz_name, *, now=None):
    """Per-key counts for each of the last `days` LOCAL calendar days (the reader's zone,
    config.APP_TZ) — the operator Log's rows (2026-10-07). Built from the UTC-hour buckets,
    each hour placed on the local day it falls in, so a day runs midnight to midnight
    Eastern rather than UTC. Days older than the hourly table's first hour fall back to the
    UTC day table and are listed in `approx` (their edges are off by the zone offset).
    -> {"days": {"YYYY-MM-DD": {key: n}}, "approx": [day, ...]}. Never raises."""
    from datetime import timedelta
    from zoneinfo import ZoneInfo
    out = {"days": {}, "approx": []}
    try:
        tz = ZoneInfo(tz_name)
    except Exception:  # noqa: BLE001
        tz = timezone.utc
    now_dt = now or datetime.now(timezone.utc)
    today = now_dt.astimezone(tz).date()
    first = today - timedelta(days=int(days) - 1)
    start_utc = datetime(first.year, first.month, first.day, tzinfo=tz).astimezone(timezone.utc)
    for i in range(int(days)):
        out["days"][(first + timedelta(days=i)).isoformat()] = {}
    try:
        with _conn() as c:
            c.execute(_USAGE_SCHEMA)
            c.execute(_USAGE_HOURLY_SCHEMA)
            earliest = c.execute("SELECT MIN(hour) FROM usage_hourly").fetchone()[0]
            rows = c.execute("SELECT hour, key, n FROM usage_hourly WHERE hour >= ?",
                             (start_utc.strftime("%Y-%m-%dT%H"),)).fetchall()
            day_rows = c.execute("SELECT day, key, n FROM usage_counter WHERE day >= ?",
                                 (first.isoformat(),)).fetchall()
    except Exception:  # noqa: BLE001
        return out
    covered_from = None
    if earliest:
        try:
            covered_from = datetime.strptime(earliest, "%Y-%m-%dT%H").replace(
                tzinfo=timezone.utc).astimezone(tz).date() + timedelta(days=1)
        except ValueError:
            covered_from = None
    for r in rows:
        try:
            d = datetime.strptime(r["hour"], "%Y-%m-%dT%H").replace(
                tzinfo=timezone.utc).astimezone(tz).date().isoformat()
        except ValueError:
            continue
        bucket = out["days"].get(d)
        if bucket is not None and (covered_from is None or d >= covered_from.isoformat()):
            bucket[r["key"]] = bucket.get(r["key"], 0) + r["n"]
    for r in day_rows:
        d = r["day"]
        if d in out["days"] and (covered_from is None or d < covered_from.isoformat()):
            out["days"][d][r["key"]] = out["days"][d].get(r["key"], 0) + r["n"]
            if d not in out["approx"]:
                out["approx"].append(d)
    return out


def usage_in_range(hours, *, now=None):
    """Per-key event counts within a trailing window, as {key: n} — the data behind the
    console's time selector. `hours` is the span:
      - <= 0 / None -> all time (the day table's full history).
      - 1..24       -> the hourly buckets (rolling, hour resolution; only as deep as
                       usage_hourly goes, which starts when hour-bucketing shipped).
      - > 24        -> whole-day resolution from the mature day table, which carries the
                       long history (a window of ceil(hours/24) calendar days).
    {} when unreadable — same never-fails discipline as every read here."""
    from datetime import timedelta
    import math
    now_dt = now or datetime.now(timezone.utc)
    try:
        h = 0 if hours is None else int(hours)
        with _conn() as c:
            c.execute(_USAGE_SCHEMA)
            c.execute(_USAGE_HOURLY_SCHEMA)
            if h <= 0:
                rows = c.execute(
                    "SELECT key, SUM(n) AS n FROM usage_counter GROUP BY key").fetchall()
            elif h <= 24:
                cutoff = (now_dt - timedelta(hours=h)).strftime("%Y-%m-%dT%H")
                rows = c.execute(
                    "SELECT key, SUM(n) AS n FROM usage_hourly WHERE hour >= ? "
                    "GROUP BY key", (cutoff,)).fetchall()
            else:
                cutoff = (now_dt - timedelta(days=math.ceil(h / 24) - 1)
                          ).strftime("%Y-%m-%d")
                rows = c.execute(
                    "SELECT key, SUM(n) AS n FROM usage_counter WHERE day >= ? "
                    "GROUP BY key", (cutoff,)).fetchall()
        return {r["key"]: r["n"] for r in rows}
    except Exception:  # noqa: BLE001
        return {}


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


def record_catalog_fallback(kind, *, now=None):
    """Count ONE silent catalog fallback: an overlay/dedup read raised and serving
    degraded to the pool. `kind` ∈ {fields, clusters, search}. Swallows every error —
    an ops counter must never be the thing that breaks the draw it's observing."""
    kind = kind if kind in _FALLBACK_KINDS else "fields"
    now_dt = now or datetime.now(timezone.utc)
    try:
        with _conn() as c:
            c.execute(_FALLBACK_SCHEMA)
            c.execute(
                "INSERT INTO catalog_fallback (day, kind, n, last_at) VALUES (?,?,1,?) "
                "ON CONFLICT(day, kind) DO UPDATE SET n = n + 1, last_at = excluded.last_at",
                (_today(now_dt), kind, now_dt.strftime("%Y-%m-%dT%H:%M:%SZ")))
    except Exception:  # noqa: BLE001 — a counter never breaks the draw
        pass


def catalog_fallback_today(*, now=None):
    """{kind: {n, last_at}} for today (UTC) — the /admin health signal. Empty dict when
    the day was clean (no fallbacks) OR unreadable; a NON-empty dict means the catalog
    overlay/dedup silently degraded today, which is exactly the invisible-degradation
    BE2b exists to surface."""
    day = _today(now)
    try:
        with _conn() as c:
            c.execute(_FALLBACK_SCHEMA)
            rows = c.execute(
                "SELECT kind, n, last_at FROM catalog_fallback WHERE day = ?",
                (day,)).fetchall()
    except Exception:  # noqa: BLE001
        return {}
    return {r["kind"]: {"n": r["n"], "last_at": r["last_at"]} for r in rows}


def catalog_fallback_recent(days=7, *, now=None):
    """Recent per-(day, kind) fallback counts, newest day first — the trend behind the
    /admin panel, so a creeping degradation shows before it's a week of stale serving.
    [] when clean or unreadable."""
    try:
        from datetime import timedelta
        start = ((now or datetime.now(timezone.utc)) - timedelta(days=int(days) - 1)
                 ).strftime("%Y-%m-%d")
        with _conn() as c:
            c.execute(_FALLBACK_SCHEMA)
            rows = c.execute(
                "SELECT day, kind, n, last_at FROM catalog_fallback WHERE day >= ? "
                "ORDER BY day DESC", (start,)).fetchall()
    except Exception:  # noqa: BLE001
        return []
    return [dict(r) for r in rows]
