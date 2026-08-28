"""
SQLite connection lifecycle (leaf module — imports nothing from the project).

`managed(c)` wraps an already-opened sqlite3 connection so that `with … as c:`
COMMITS on success / ROLLS BACK on error / and — the part the bare
`with sqlite3_connection:` context manager omits — always CLOSES it.

WHY THIS EXISTS. `sqlite3.Connection.__exit__` commits or rolls back but does
NOT close the connection; closing was left to garbage collection. Under threaded
gunicorn (2 workers x 8 threads) GC lags badly, so per-request connections piled
up (a live worker was observed holding 41 open `albums.db` fds) and — worse —
every catalog re-seed's `rsync` atomic-rename left the OLD database file pinned
as a deleted-but-open inode for hours. That defeated the `rm`-first disk
reclaim the re-seed runbook depends on (the freed space never came back until the
service restarted), and quietly grew fd/disk usage in steady state. Closing the
connection when its `with` block ends removes all three problems: no restart
ritual to reclaim a re-seed's space, no unbounded fd growth.

Every serving-layer connection factory returns `managed(<conn>)`, so callers keep
writing the exact same `with _conn() as c:` they always did — only now it closes.
"""
from contextlib import contextmanager


@contextmanager
def managed(c):
    """Yield `c`; commit on clean exit, roll back on exception, always close.

    Faithful superset of `with sqlite3.connect(...) as c:` (which commits/rolls
    back but leaks the open handle) — commit/rollback is a no-op on a read-only
    (`mode=ro`) connection, so the same wrapper is correct for read and write
    handles alike."""
    try:
        yield c
        c.commit()
    except BaseException:
        c.rollback()
        raise
    finally:
        c.close()
