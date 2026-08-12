"""vintage.py — build-vintage stamps + cross-artifact coherence (BE2b).

WHY. Six files must share a vintage, and enforcement was operator memory (BACKEND_
REDESIGN.md §3.2). The concrete silent failures: a newer pool beside an older catalog
degrades Discogs cards to lean rows; `mb_release_map`'s ingest-time uid snapshot silently
empties MB albums out of person doors after a pool rebuild; stale poolsearch uids shrink
Explore; an interrupted push leaves new-catalog-beside-old-pool. None of these raised —
they just served worse.

THE MODEL. A pool BUILD mints ONE `vintage_id` (a sortable, unique token) and stamps it
into pool.sqlite's `meta`. Every DERIVED artifact — catalog.sqlite, poolsearch.sqlite,
and albums.db's `mb_release_map` — records, at ITS build, the `pool_vintage` it was built
against. Coherent = every present derived artifact points at the CURRENT pool's
`vintage_id`. A mismatch is a real incoherence (refuse to ship / flag on /admin); a
MISSING file or an UNSTAMPED (pre-BE2b) artifact degrades to `unknown`, never to
"incoherent" — the honesty rule (unknown != unavailable) applied to coherence itself.

Leaf module: config + sqlite3 only, so the bash agents and the build tools can all call
it. Reads are best-effort and tolerate a concurrent writer / missing file (they answer
`None`, never raise) — a coherence probe must never be the thing that breaks serving.
"""
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import config

VINTAGE_KEY = "vintage_id"        # the pool's OWN build id (only pool.sqlite sets this)
POOL_VINTAGE_KEY = "pool_vintage"  # a derived artifact records the pool vintage it used
BUILT_AT_KEY = "built_at"
COUNTS_KEY = "counts"

# Each artifact and the meta table it keeps its stamp in. catalog.sqlite reuses the
# pre-existing `catalog_meta` (extended, not replaced); the others get a plain `meta`.
_ARTIFACTS = {
    "pool":           (lambda: config.POOL_DB_PATH,        "meta"),
    "catalog":        (lambda: config.CATALOG_DB_PATH,     "catalog_meta"),
    "poolsearch":     (lambda: config.POOL_SEARCH_DB_PATH, "meta"),
    "mb_release_map": (lambda: config.DB_PATH,             "meta"),  # in albums.db
}
# The derived artifacts whose pool_vintage is compared to the pool's vintage_id.
_DERIVED = ("catalog", "poolsearch", "mb_release_map")


def mint(*, now=None):
    """A fresh pool vintage id: a UTC build timestamp + a short random suffix, so it is
    sortable (newest wins by string compare) AND collision-proof across same-second
    builds. e.g. 'v20260812T044702Z-9f3a1c'."""
    ts = (now or datetime.now(timezone.utc)).strftime("%Y%m%dT%H%M%SZ")
    return f"v{ts}-{os.urandom(3).hex()}"


def write_meta(con, mapping, *, table="meta"):
    """Upsert str key -> str value rows into a `meta(key,value)` table (created if
    absent). Values are coerced to str; a dict/list value is JSON-encoded (for `counts`).
    Operates on an OPEN connection so a build can stamp inside its own transaction."""
    con.execute(f"CREATE TABLE IF NOT EXISTS {table} "
                f"(key TEXT PRIMARY KEY, value TEXT)")
    rows = []
    for k, v in mapping.items():
        if isinstance(v, (dict, list)):
            v = json.dumps(v, separators=(",", ":"))
        rows.append((str(k), None if v is None else str(v)))
    con.executemany(
        f"INSERT INTO {table} (key, value) VALUES (?,?) "
        f"ON CONFLICT(key) DO UPDATE SET value = excluded.value", rows)


def stamp_pool(con, *, counts=None, now=None, vintage_id=None):
    """Mint (or accept) a vintage_id and stamp pool.sqlite's `meta`. Returns the id, so
    the same build can hand it to the derived-artifact builds. counts is a small dict."""
    vid = vintage_id or mint(now=now)
    write_meta(con, {VINTAGE_KEY: vid, BUILT_AT_KEY:
                     (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                     COUNTS_KEY: counts or {}}, table="meta")
    return vid


def stamp_derived(con, pool_vintage, *, table="meta", counts=None, now=None):
    """Stamp a derived artifact (catalog / poolsearch / mb_release_map) with the pool
    vintage it was built against + its own built_at/counts. `pool_vintage` should be the
    id read from the pool it consumed (None if that pool predates BE2b — recorded as
    'unknown' so coherence degrades gracefully rather than false-flagging)."""
    write_meta(con, {POOL_VINTAGE_KEY: pool_vintage if pool_vintage else "unknown",
                     BUILT_AT_KEY:
                     (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                     COUNTS_KEY: counts or {}}, table=table)


def _open_ro(path):
    p = Path(path)
    if not p.exists():
        return None
    for uri in (f"file:{p}?mode=ro", f"file:{p}?immutable=1"):
        try:
            return sqlite3.connect(uri, uri=True)
        except sqlite3.Error:
            continue
    return None


def read_meta_value(path, key, *, table="meta"):
    """One value from a DB's meta table, or None (missing file / table / key /
    unreadable — all degrade to None, never raise)."""
    con = _open_ro(path)
    if con is None:
        return None
    try:
        row = con.execute(f"SELECT value FROM {table} WHERE key = ?", (key,)).fetchone()
        return row[0] if row else None
    except sqlite3.Error:
        return None
    finally:
        con.close()


def pool_vintage_id():
    """The current pool.sqlite's own vintage_id, or None if unstamped/absent."""
    path, table = _ARTIFACTS["pool"][0](), _ARTIFACTS["pool"][1]
    return read_meta_value(path, VINTAGE_KEY, table=table)


def coherence():
    """Compare each present derived artifact's `pool_vintage` to the pool's `vintage_id`.

    Returns:
      {
        "pool_vintage": <id or None>,
        "artifacts": {name: {"pool_vintage": <id|None>, "status": <str>}},
        "coherent": True | False | None,   # None when the pool vintage is unknown
      }
    where per-artifact status is one of:
      "ok"       — matches the pool vintage,
      "mismatch" — a DIFFERENT vintage (a real incoherence: the gate/UI flags it),
      "unknown"  — file present but unstamped (pre-BE2b) — NOT an incoherence,
      "absent"   — file missing (a fresh host legitimately lacks it) — NOT an incoherence.

    `coherent` is True only when the pool has a vintage AND no derived artifact mismatches;
    False on any mismatch; None when the pool itself is unstamped (can't judge — the
    honesty-rule 'unknown' at the whole-set level). A missing/unstamped derived artifact
    NEVER makes the set incoherent, mirroring dbsanity's unknown-is-not-a-stub rule."""
    pool_vid = pool_vintage_id()
    out = {"pool_vintage": pool_vid, "artifacts": {}, "coherent": None}
    any_mismatch = False
    for name in _DERIVED:
        path, table = _ARTIFACTS[name][0](), _ARTIFACTS[name][1]
        if not Path(path).exists():
            out["artifacts"][name] = {"pool_vintage": None, "status": "absent"}
            continue
        av = read_meta_value(path, POOL_VINTAGE_KEY, table=table)
        if av is None or av == "unknown":
            status = "unknown"
        elif pool_vid is not None and av == pool_vid:
            status = "ok"
        elif pool_vid is None:
            status = "unknown"          # can't compare without a pool vintage
        else:
            status = "mismatch"
            any_mismatch = True
        out["artifacts"][name] = {"pool_vintage": av, "status": status}
    if pool_vid is None:
        out["coherent"] = None
    else:
        out["coherent"] = not any_mismatch
    return out


def mismatches():
    """The names of derived artifacts DEFINITIVELY on a different vintage than the pool.
    Empty when coherent / unknown — the boolean the fail-closed rsync gate keys on (it
    refuses only a DEFINITE mismatch, never an unknown)."""
    c = coherence()
    return [n for n, a in c["artifacts"].items() if a["status"] == "mismatch"]


def _fmt(c):
    pv = c["pool_vintage"] or "(unstamped)"
    lines = [f"vintage coherence — pool: {pv}"]
    for name, a in c["artifacts"].items():
        av = a["pool_vintage"] or "—"
        lines.append(f"  {name:16s} {a['status']:9s} (pool_vintage {av})")
    state = {True: "COHERENT", False: "MISMATCH", None: "unknown (pool unstamped)"}[c["coherent"]]
    lines.append(f"  => {state}")
    return "\n".join(lines)


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(
        description="Cross-artifact build-vintage coherence. Exit 2 if a derived "
                    "artifact is DEFINITELY on a different vintage than the pool "
                    "(a mismatch); exit 0 when coherent or unknown.")
    ap.add_argument("--quiet", action="store_true",
                    help="print only on a mismatch")
    a = ap.parse_args(argv)
    c = coherence()
    bad = mismatches()
    if bad or not a.quiet:
        print(_fmt(c))
    if bad:
        import sys
        print(f"!! VINTAGE MISMATCH: {', '.join(bad)} built against a different pool "
              f"vintage than the live pool — a mixed-vintage set (see vintage.py).",
              file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
