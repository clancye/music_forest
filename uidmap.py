"""
uid identity helpers (P3 M2) — extracted from server.py.

Album identity is the source-agnostic uid (d:<release_id> for Discogs,
m:<album_id> for MB-only); release_id is denormalized provenance only. These
bridge the string uid the journal/marks/tracks routes take to the right data
source, and keep BOTH the flag-off path and the not-yet-uid-aware client
working: a bare numeric id in a URL segment or note body is read as a legacy
Discogs release_id and folded onto 'd:<id>', which is exactly how migrated
journal rows are keyed.

Pure of Flask (no request/response coupling), so the identity logic can be
reasoned about and tested on its own; server.py re-imports these names, so its
call sites are unchanged. Depends on config/db/pooldb, none of which import this.
"""
import config
import db
import pooldb


def _canon_uid(raw):
    """Canonicalize a uid taken from a URL segment or request body. A namespaced
    uid ('d:..'/'m:..') passes through; a bare integer (the legacy client's
    release_id) folds onto 'd:<id>'; empty -> None."""
    s = ("" if raw is None else str(raw)).strip()
    if not s:
        return None
    if ":" in s:
        return s
    if s.lstrip("-").isdigit():
        return "d:" + s
    return s


def _rid_from_uid(uid):
    """The numeric Discogs release_id embedded in a 'd:<id>' uid, else None (an
    'm:'/other-source uid has no albums.db release)."""
    if isinstance(uid, str) and uid.startswith("d:"):
        tail = uid[2:]
        if tail.lstrip("-").isdigit():
            return int(tail)
    return None


def _album_for_uid(uid):
    """Resolve a uid to its album dict (for note/mark snapshots + tracks): the
    pool — and its lazy door — first, so an MB-only album resolves, then the
    albums.db join-back for a 'd:' uid. Returns None if nothing resolves; never
    assumes a Discogs row exists."""
    if uid is None:
        return None
    if config.POOL_ENABLED:
        try:
            a = pooldb.album_by_uid(uid)
            if a:
                return a
        except Exception:  # noqa: BLE001 - pool is optional; fall back to albums.db
            pass
        # Fold-aware fallback (journal orphan healing): a stored journal uid may be an
        # MB release-level id, a folded twin, or a since-merged release-group that no
        # longer matches the canonical pool uid (the release-group). Resolve it to the
        # entity's CURRENT pool uid via the catalog and re-read, so an 'unknown album'
        # heals to the record it always was. (UC1: journal links carry forward. An MB
        # album has one rg-based pool uid but folds several release mbids — a journal
        # entry keyed on one of those releases must still find its album.)
        if getattr(config, "CATALOG_ENABLED", False):
            try:
                import catalogdb
                canon = catalogdb.canonical_pool_uid(uid)
                if canon and canon != uid:
                    a = pooldb.album_by_uid(canon)
                    if a:
                        return a
            except Exception:  # noqa: BLE001 - catalog is optional; keep degrading
                pass
    rid = _rid_from_uid(uid)
    if rid is not None:
        return db.get_album(rid)
    return None
