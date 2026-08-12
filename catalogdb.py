"""UC1 Phase 0 — read layer for the source-neutral catalog entities.

Reads config.CATALOG_DB_PATH (data/catalog.sqlite, built by
tools/build_catalog_entities.py). Purely ADDITIVE and flag-gated
(config.CATALOG_ENABLED): nothing in the serving path calls this in Phase 0 — it
exists so later phases can build on it, and so Phase 0 is testable. See
UNIFIED_CATALOG_DESIGN.md Appendix A.

The headline function is `alb_id_for_uid` — the OLD-UID RESOLVER (decision #4): any
legacy `d:<rid>` / `m:mb:<X>` uid decomposes to a source member ref that
`entity_members` maps to an `alb_id`, so old journal entries + shared links keep
resolving after the migration with no data rewrite. It resolves ANY member's uid,
not just the representative pressing's.
"""
import sqlite3
from pathlib import Path

import config


def _conn():
    c = sqlite3.connect(f"file:{Path(config.CATALOG_DB_PATH).resolve()}?mode=ro",
                        uri=True)
    c.row_factory = sqlite3.Row
    return c


def uid_to_member_ref(uid):
    """Decompose a legacy pool uid into the source member ref it implies.
    `d:8170683` -> `discogs:release:8170683`; `m:mb:<X>` -> `mb:group:<X>`."""
    if not uid:
        return None
    if uid.startswith("d:"):
        return f"discogs:release:{uid[2:]}"
    if uid.startswith("m:mb:"):
        return f"mb:group:{uid[5:]}"
    if uid.startswith("m:"):        # defensive: other 'm:' shapes
        return f"mb:group:{uid[2:]}"
    return None


def alb_id_for_member(source_ref):
    """The entity a source member ref belongs to, or None."""
    if not source_ref:
        return None
    with _conn() as c:
        r = c.execute("SELECT alb_id FROM entity_members WHERE source_ref = ?",
                      (source_ref,)).fetchone()
    return r["alb_id"] if r else None


def alb_id_for_uid(uid):
    """Resolve a legacy pool uid to its entity's alb_id (the old-uid resolver)."""
    return alb_id_for_member(uid_to_member_ref(uid))


def uid_for_alb_id(alb_id):
    """The current pool uid (serving key) for an entity, or None."""
    if not alb_id:
        return None
    with _conn() as c:
        r = c.execute("SELECT pool_uid FROM entities WHERE alb_id = ?",
                      (alb_id,)).fetchone()
    return r["pool_uid"] if r else None


def canonical_pool_uid(uid):
    """Resolve a (possibly STALE) journal uid to the CURRENT canonical pool uid of the
    entity it belongs to. Unlike `uid_to_member_ref` (which assumes `m:mb:<x>` is always
    a release-GROUP), this also tries the release-level ref `mb:release:<x>` — so a
    journal entry keyed on an MB *release* mbid, a folded twin, or a since-merged
    release-group resolves to the entity's release-group pool uid. Returns None if the
    catalog can't map it (caller keeps the original uid). This is what heals an
    'unknown album' orphan — the journal-links-carry-forward guarantee (UC1). One indexed
    lookup (entity_members.source_ref); best-effort, so any error -> None."""
    if not uid:
        return None
    if uid.startswith("d:"):
        refs = (f"discogs:release:{uid[2:]}",)
    elif uid.startswith("m:mb:"):
        x = uid[5:]
        refs = (f"mb:group:{x}", f"mb:release:{x}")
    elif uid.startswith("m:"):        # defensive: other 'm:' shapes
        x = uid[2:]
        refs = (f"mb:group:{x}", f"mb:release:{x}")
    else:
        return None
    try:
        with _conn() as c:
            ph = ",".join("?" * len(refs))
            r = c.execute(
                "SELECT e.pool_uid AS u FROM entity_members m "
                "JOIN entities e ON e.alb_id = m.alb_id "
                f"WHERE m.source_ref IN ({ph}) LIMIT 1", refs).fetchone()
            return r["u"] if r and r["u"] else None
    except sqlite3.OperationalError:
        return None


def members_for(alb_id):
    """[{source, source_ref, role}, ...] for an entity, or []."""
    if not alb_id:
        return []
    with _conn() as c:
        rows = c.execute("SELECT source, source_ref, role FROM entity_members "
                         "WHERE alb_id = ? ORDER BY source_ref", (alb_id,)).fetchall()
    return [dict(r) for r in rows]


_FIELD_COLS = ("original_date", "year", "month", "day", "country", "type",
               "genres", "labels", "cover")


def fields_for_uids(uids):
    """Batched serving read (UC1 Phase 1b): {uid: {field: value}} for the resolved
    entity behind each pool uid. Maps uid -> member ref -> alb_id -> entity_fields in
    two chunked queries. {} for any uid the catalog doesn't resolve, or if
    entity_fields hasn't been built (Phase 1a not run). Best-effort: any error -> {}
    so the caller's pool-based serving stands."""
    refs, ref_uid = [], {}
    for u in uids:
        r = uid_to_member_ref(u)
        if r:
            refs.append(r)
            ref_uid[r] = u
    if not refs:
        return {}
    try:
        with _conn() as c:
            if not c.execute("SELECT name FROM sqlite_master WHERE type='table' AND "
                             "name='entity_fields'").fetchone():
                return {}
            uid_alb = {}
            for i in range(0, len(refs), 400):
                chunk = refs[i:i + 400]
                ph = ",".join("?" * len(chunk))
                for row in c.execute("SELECT source_ref, alb_id FROM entity_members "
                                     f"WHERE source_ref IN ({ph})", chunk):
                    uid_alb[ref_uid[row["source_ref"]]] = row["alb_id"]
            if not uid_alb:
                return {}
            albs = list(set(uid_alb.values()))
            fields = {}
            cols = ", ".join(_FIELD_COLS)
            for i in range(0, len(albs), 400):
                chunk = albs[i:i + 400]
                ph = ",".join("?" * len(chunk))
                for row in c.execute(f"SELECT alb_id, {cols} FROM entity_fields "
                                     f"WHERE alb_id IN ({ph})", chunk):
                    fields[row["alb_id"]] = {k: row[k] for k in _FIELD_COLS}
    except sqlite3.OperationalError:
        return {}
    return {u: fields[a] for u, a in uid_alb.items() if a in fields}


def clusters_for_uids(uids):
    """Batched serving read (UC1 Phase 2): {uid: cluster_id} for each pool uid whose
    entity is in a merged cluster (`entity_clusters`, size>=2 — cross-source, or a
    same-source dup since UC2). Maps uid -> member ref -> alb_id -> cluster_id in one
    chunked query. A uid ABSENT from the result
    is a singleton (its own album) and the caller keeps it. Best-effort: any error, or
    `entity_clusters` not built (Phase 2 shadow not run), -> {} so serving stands."""
    refs, ref_uid = [], {}
    for u in uids:
        r = uid_to_member_ref(u)
        if r:
            refs.append(r)
            ref_uid[r] = u
    if not refs:
        return {}
    out = {}
    try:
        with _conn() as c:
            if not c.execute("SELECT name FROM sqlite_master WHERE type='table' AND "
                             "name='entity_clusters'").fetchone():
                return {}
            for i in range(0, len(refs), 400):
                chunk = refs[i:i + 400]
                ph = ",".join("?" * len(chunk))
                for row in c.execute(
                        "SELECT m.source_ref AS sref, c.cluster_id AS cid "
                        "FROM entity_members m JOIN entity_clusters c "
                        f"ON c.alb_id = m.alb_id WHERE m.source_ref IN ({ph})", chunk):
                    out[ref_uid[row["sref"]]] = row["cid"]
    except sqlite3.OperationalError:
        return {}
    return out


def cluster_sibling_uids(uid):
    """The pool uids of every entity in the same merged cluster as `uid` (including it),
    or [] if it isn't clustered. Serving reads this to pick the MOST-COMPLETE tracklist
    across a merge (design §4) so a de-duped card never drops a bonus track."""
    ref = uid_to_member_ref(uid)
    if not ref:
        return []
    try:
        with _conn() as c:
            if not c.execute("SELECT name FROM sqlite_master WHERE type='table' AND "
                             "name='entity_clusters'").fetchone():
                return []
            row = c.execute(
                "SELECT c.cluster_id AS cid FROM entity_members m "
                "JOIN entity_clusters c ON c.alb_id = m.alb_id "
                "WHERE m.source_ref = ?", (ref,)).fetchone()
            if not row:
                return []
            rows = c.execute(
                "SELECT e.pool_uid AS u FROM entity_clusters c "
                "JOIN entities e ON e.alb_id = c.alb_id WHERE c.cluster_id = ?",
                (row["cid"],)).fetchall()
    except sqlite3.OperationalError:
        return []
    return [r["u"] for r in rows if r["u"]]


# --------------------------------------------------------------- quality drill
# The treemap drill dimensions, in priority order. Server owns the order + the
# "skip a constant dimension" logic; the page owns colours/labels. Ordered by
# how much each varies in today's pool (Phase 1a finding: date_agreement is the
# rich signal; confidence/sources are near-binary until Phase 2 clustering).
_QUALITY_DIMS = [
    ("date_agreement", "date_agreement"),
    ("sources", "sources"),
    ("releases", "CASE WHEN release_count<=1 THEN '1' WHEN release_count<=5 THEN "
                 "'2-5' WHEN release_count<=20 THEN '6-20' ELSE '21+' END"),
    ("name_agreement", "name_agreement"),
    ("confidence", "confidence"),
]
_DIM_EXPR = {k: e for k, e in _QUALITY_DIMS}


def has_quality():
    """True if entity_quality has been resolved (Phase 1a ran)."""
    try:
        with _conn() as c:
            return bool(c.execute("SELECT name FROM sqlite_master WHERE type='table' "
                                  "AND name='entity_quality'").fetchone())
    except sqlite3.OperationalError:
        return False


def quality_drill(filters, cap=500):
    """One treemap level. `filters`: [(dim_key, value), ...] already drilled into.
    Returns either a split — {dim, total, blocks:[{value,count}]} for the next
    dimension that still varies (constant ones skipped) — or a leaf —
    {leaf:True, total, items:[{artist,title}], more}. Dimension keys are validated
    against the whitelist; every value travels as a bound parameter."""
    where, params = [], []
    used = set()
    for key, val in filters or []:
        if key not in _DIM_EXPR:
            continue
        where.append(f"{_DIM_EXPR[key]} = ?")
        params.append(val)
        used.add(key)
    wsql = (" WHERE " + " AND ".join(where)) if where else ""
    with _conn() as c:
        for key, expr in _QUALITY_DIMS:
            if key in used:
                continue
            n = c.execute(f"SELECT COUNT(DISTINCT {expr}) FROM entity_quality{wsql}",
                          params).fetchone()[0]
            if n > 1:
                rows = c.execute(
                    f"SELECT {expr} AS v, COUNT(*) AS n FROM entity_quality{wsql} "
                    f"GROUP BY v ORDER BY n DESC", params).fetchall()
                blocks = [{"value": r["v"], "count": r["n"]}
                          for r in rows if r["v"] is not None]
                return {"dim": key, "total": sum(b["count"] for b in blocks),
                        "blocks": blocks}
        # leaf — every remaining dimension is constant
        total = c.execute(f"SELECT COUNT(*) FROM entity_quality{wsql}",
                          params).fetchone()[0]
        items = c.execute(
            "SELECT primary_artist AS artist, title FROM entity_fields WHERE alb_id IN "
            f"(SELECT alb_id FROM entity_quality{wsql} LIMIT ?)",
            params + [cap]).fetchall()
        return {"leaf": True, "total": total,
                "items": [{"artist": r["artist"], "title": r["title"]} for r in items],
                "more": max(0, total - len(items))}
