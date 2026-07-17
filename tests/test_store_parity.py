"""
Contract parity between the two sync-store backends.

`store.SQLiteStore` is exercised end-to-end by the suite (test_sync, test_api,
test_retention, …). `store.PostgresStore` — the backend that actually holds
every hosted user's encrypted rows — has NO automated coverage, because the tests
run without a Postgres. That asymmetry is a standing risk: a method added to /
changed on SQLiteStore but not mirrored on PostgresStore (or a drifted parameter)
would pass the whole suite and only break in production, for real users.

This test can't run the Postgres SQL, but it can lock the *interface contract* so
the two backends can't silently diverge: identical public method sets and
identical call signatures. It needs no database — signatures are read off the
unbound methods, and psycopg is imported lazily inside PostgresStore, so nothing
here connects.

If you intentionally change one store's surface, change both, then update this
test in the same commit.
"""
import inspect

import store


def _public_methods(cls):
    return {
        name: fn
        for name, fn in inspect.getmembers(cls, predicate=inspect.isfunction)
        if not name.startswith("_")
    }


def test_stores_expose_the_same_public_methods():
    sqlite_api = set(_public_methods(store.SQLiteStore))
    postgres_api = set(_public_methods(store.PostgresStore))
    assert sqlite_api == postgres_api, (
        "SQLiteStore and PostgresStore public surfaces have drifted — "
        f"only on SQLite: {sorted(sqlite_api - postgres_api)}; "
        f"only on Postgres: {sorted(postgres_api - sqlite_api)}"
    )


def test_shared_methods_have_matching_signatures():
    sqlite_api = _public_methods(store.SQLiteStore)
    postgres_api = _public_methods(store.PostgresStore)
    mismatches = []
    for name in sqlite_api.keys() & postgres_api.keys():
        sig_sqlite = inspect.signature(sqlite_api[name])
        sig_postgres = inspect.signature(postgres_api[name])
        if sig_sqlite != sig_postgres:
            mismatches.append(f"{name}: SQLite{sig_sqlite} vs Postgres{sig_postgres}")
    assert not mismatches, "store method signatures drifted:\n  " + "\n  ".join(mismatches)
