"""
Behavioral coverage for store.PostgresStore — the backend that holds every hosted
user's encrypted rows in production.

The default suite exercises only SQLiteStore, so the Postgres SQL (its `%s`
placeholders, `ON CONFLICT`, `now()`, `bytea`/`jsonb`/`timestamptz` handling) has
no automated coverage — it is proven only by running in production. This file runs
the SAME round-trips against a real Postgres when one is provided, so a
dialect/logic bug is caught before it reaches a user's irreplaceable journal.

It is gated, not skipped-forever: point AOTD_TEST_PG_DSN at a THROWAWAY Postgres
(the test creates its own tables + a minimal `auth.users`, and cleans up its user
after each test) and it runs. Locally with no Postgres it skips. E.g.:

    docker run --rm -e POSTGRES_PASSWORD=x -p 5432:5432 postgres:16
    AOTD_TEST_PG_DSN=postgresql://postgres:x@localhost:5432/postgres \
        pytest tests/test_store_postgres.py -v

The interface contract (both stores expose the same methods/signatures) is guarded
separately and always-on by tests/test_store_parity.py.
"""
import os
import uuid

import pytest

DSN = os.environ.get("AOTD_TEST_PG_DSN")
if not DSN:
    pytest.skip("set AOTD_TEST_PG_DSN to a throwaway Postgres to run these",
                allow_module_level=True)

psycopg = pytest.importorskip("psycopg")

import store  # noqa: E402

_SCHEMA = """
CREATE TABLE IF NOT EXISTS journal_rows (
    user_id text NOT NULL, kind text NOT NULL, client_id text NOT NULL,
    ciphertext bytea, nonce bytea,
    updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
    PRIMARY KEY (user_id, kind, client_id)
);
CREATE TABLE IF NOT EXISTS user_keys (
    user_id text PRIMARY KEY, key_material jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS access_requests (
    email text PRIMARY KEY, note text, user_agent text,
    status text NOT NULL DEFAULT 'new',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text);
"""


@pytest.fixture(scope="module", autouse=True)
def _schema():
    with psycopg.connect(DSN, autocommit=True) as conn:
        conn.execute(_SCHEMA)
    yield


@pytest.fixture()
def pg():
    """A PostgresStore plus a unique user_id; the user's data is wiped after."""
    s = store.PostgresStore(DSN)
    uid = str(uuid.uuid4())
    try:
        yield s, uid
    finally:
        s.delete_user(uid)


def _note(cid, ct=b"cipher", nonce=b"nonce", deleted=False):
    return {"kind": "note", "client_id": cid, "ciphertext": ct,
            "nonce": nonce, "deleted": deleted}


def test_upsert_then_get_round_trip(pg):
    s, uid = pg
    assert s.upsert_rows(uid, [_note("c1", ct=b"AAAA", nonce=b"BB")]) == 1
    rows = s.get_rows(uid)
    assert len(rows) == 1
    r = rows[0]
    assert r["kind"] == "note" and r["client_id"] == "c1"
    assert r["ciphertext"] == b"AAAA" and r["nonce"] == b"BB"
    assert r["deleted"] is False


def test_upsert_updates_in_place(pg):
    s, uid = pg
    s.upsert_rows(uid, [_note("c1", ct=b"one")])
    s.upsert_rows(uid, [_note("c1", ct=b"two")])
    rows = s.get_rows(uid)
    assert len(rows) == 1 and rows[0]["ciphertext"] == b"two"


def test_tombstone_via_deleted_flag(pg):
    s, uid = pg
    s.upsert_rows(uid, [_note("c1")])
    s.upsert_rows(uid, [_note("c1", deleted=True)])
    rows = s.get_rows(uid)
    assert len(rows) == 1
    assert rows[0]["deleted"] is True and rows[0]["ciphertext"] == b""


def test_kind_filter_and_since_cursor(pg):
    s, uid = pg
    s.upsert_rows(uid, [_note("c1"),
                        {"kind": "pick", "client_id": "p1",
                         "ciphertext": b"x", "nonce": b"y", "deleted": False}])
    assert {r["kind"] for r in s.get_rows(uid, kind="note")} == {"note"}
    newest = max(r["updated_at"] for r in s.get_rows(uid))
    assert s.get_rows(uid, since=newest) == []  # nothing strictly after the newest


def test_delete_row_is_idempotent(pg):
    s, uid = pg
    s.upsert_rows(uid, [_note("c1")])
    assert s.delete_row(uid, "note", "c1") is True
    assert s.delete_row(uid, "note", "c1") is False  # already tombstoned


def test_keys_round_trip(pg):
    s, uid = pg
    out = s.put_keys(uid, {"wrapped": "abc", "v": 1})
    assert out["key_material"] == {"wrapped": "abc", "v": 1}
    assert s.get_keys(uid)["key_material"] == {"wrapped": "abc", "v": 1}


def test_delete_user_wipes_rows_and_keys(pg):
    s, uid = pg
    s.upsert_rows(uid, [_note("c1")])
    s.put_keys(uid, {"wrapped": "abc"})
    summary = s.delete_user(uid)
    assert summary["rows"] >= 1 and summary["keys"] == 1
    assert s.get_rows(uid) == [] and s.get_keys(uid) is None


def test_access_request_upsert_and_list(pg):
    s, _ = pg
    email = f"{uuid.uuid4().hex}@example.test"
    try:
        s.add_access_request(email, note="hi", user_agent="pytest")
        s.add_access_request(email, note="again")  # collapses to one row
        listed = [r for r in s.list_access_requests() if r["email"] == email]
        assert len(listed) == 1 and listed[0]["note"] == "again"
        assert listed[0]["status"] == "new"
    finally:
        with psycopg.connect(DSN, autocommit=True) as conn:
            conn.execute("DELETE FROM access_requests WHERE email=%s", (email,))
