"""
Sync-layer tests (H1.1): the authenticated store/fetch of end-to-end-encrypted
rows that becomes the beta's spine (BETA_PLAN.md §4).

The server only ever moves opaque ciphertext, so these treat row bodies as
arbitrary bytes and never assume the server can read them. Auth is tested in
both modes:

  * bypass — no JWT secret configured (the local/dev/test default): every call
    is attributed to config.LOCAL_USER_ID, no token needed.
  * enforced — a secret set (hosted): a valid Supabase-style HS256 token is
    required, and one user can never see another's rows.

No catalog DB is needed (the sync routes don't touch albums.db), so this builds
its own throwaway-SQLite app rather than using the `built_db` fixture.
"""
import base64

import pytest

import auth
import config
import server

LOCAL = "00000000-0000-0000-0000-000000000000"
SECRET = "test-jwt-signing-secret"
USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"


def _make_client(tmp_path, secret=""):
    app = server.create_app({
        "SYNC_DB_PATH": tmp_path / "sync.db",
        "SUPABASE_DB_URL": "",
        "SUPABASE_JWT_SECRET": secret,
        "JWT_AUDIENCE": "authenticated",
        "JWT_ISSUER": "",
        "LOCAL_USER_ID": LOCAL,
        "PREFETCH_ENABLED": False,
    })
    app.testing = True
    return app.test_client()


def _b64(raw):
    return base64.b64encode(raw).decode("ascii")


def _bearer(sub, secret=SECRET, **kw):
    return {"Authorization": f"Bearer {auth.make_token(sub, secret, **kw)}"}


@pytest.fixture()
def local_client(tmp_path):
    """A client in bypass mode (no JWT secret) — the local/dev default."""
    return _make_client(tmp_path)


@pytest.fixture()
def hosted_client(tmp_path):
    """A client in enforced mode (JWT secret set) — the hosted behaviour."""
    return _make_client(tmp_path, secret=SECRET)


# --- bypass mode -----------------------------------------------------------

def test_status_reports_bypass_and_sqlite(local_client):
    r = local_client.get("/api/sync/status")
    assert r.status_code == 200
    body = r.get_json()
    assert body["user_id"] == LOCAL
    assert body["auth_enforced"] is False
    assert body["backend"] == "sqlite"


def test_rows_round_trip(local_client):
    ct, nonce = b"\x00\x01\x02ciphertext", b"\xaa\xbb\xccnonce"
    r = local_client.post("/api/sync/rows", json={"rows": [
        {"kind": "note", "client_id": "n1",
         "ciphertext": _b64(ct), "nonce": _b64(nonce)},
    ]})
    assert r.status_code == 200 and r.get_json()["written"] == 1

    rows = local_client.get("/api/sync/rows").get_json()["rows"]
    assert len(rows) == 1
    row = rows[0]
    assert row["kind"] == "note" and row["client_id"] == "n1"
    assert base64.b64decode(row["ciphertext"]) == ct
    assert base64.b64decode(row["nonce"]) == nonce
    assert row["deleted"] is False


def test_kind_filter(local_client):
    local_client.post("/api/sync/rows", json={"rows": [
        {"kind": "note", "client_id": "n1", "ciphertext": _b64(b"a"),
         "nonce": _b64(b"x")},
        {"kind": "pick", "client_id": "p1", "ciphertext": _b64(b"b"),
         "nonce": _b64(b"y")},
    ]})
    picks = local_client.get("/api/sync/rows?kind=pick").get_json()["rows"]
    assert [r["client_id"] for r in picks] == ["p1"]


def test_delta_since_cursor(local_client):
    local_client.post("/api/sync/rows", json={"rows": [
        {"kind": "note", "client_id": "n1", "ciphertext": _b64(b"a"),
         "nonce": _b64(b"x")},
    ]})
    cursor = local_client.get("/api/sync/rows").get_json()["server_time"]
    local_client.post("/api/sync/rows", json={"rows": [
        {"kind": "trail", "client_id": "t1", "ciphertext": _b64(b"b"),
         "nonce": _b64(b"y")},
    ]})
    delta = local_client.get(f"/api/sync/rows?since={cursor}").get_json()["rows"]
    assert [r["client_id"] for r in delta] == ["t1"]


def test_update_in_place(local_client):
    local_client.post("/api/sync/rows", json={"rows": [
        {"kind": "note", "client_id": "n1", "ciphertext": _b64(b"first"),
         "nonce": _b64(b"x")},
    ]})
    local_client.post("/api/sync/rows", json={"rows": [
        {"kind": "note", "client_id": "n1", "ciphertext": _b64(b"second"),
         "nonce": _b64(b"z")},
    ]})
    rows = local_client.get("/api/sync/rows").get_json()["rows"]
    assert len(rows) == 1
    assert base64.b64decode(rows[0]["ciphertext"]) == b"second"


def test_delete_tombstones_row(local_client):
    local_client.post("/api/sync/rows", json={"rows": [
        {"kind": "note", "client_id": "n1", "ciphertext": _b64(b"a"),
         "nonce": _b64(b"x")},
    ]})
    r = local_client.delete("/api/sync/rows/note/n1")
    assert r.status_code == 200 and r.get_json()["deleted"] is True
    rows = local_client.get("/api/sync/rows").get_json()["rows"]
    assert len(rows) == 1 and rows[0]["deleted"] is True
    assert rows[0]["ciphertext"] == ""        # blob cleared
    # idempotent: a second delete reports nothing newly deleted
    assert local_client.delete("/api/sync/rows/note/n1").get_json()["deleted"] is False


def test_delete_via_upsert_flag(local_client):
    local_client.post("/api/sync/rows", json={"rows": [
        {"kind": "pick", "client_id": "p1", "ciphertext": _b64(b"a"),
         "nonce": _b64(b"x")},
    ]})
    local_client.post("/api/sync/rows", json={"rows": [
        {"kind": "pick", "client_id": "p1", "deleted": True},
    ]})
    rows = local_client.get("/api/sync/rows").get_json()["rows"]
    assert rows[0]["deleted"] is True


def test_keys_put_get_and_rewrap(local_client):
    assert local_client.get("/api/sync/keys").get_json() == {"exists": False}
    material = {"kdf": "argon2id", "passphrase_salt": "AAAA",
                "wrapped_dek_passphrase": "BBBB", "recovery_salt": "CCCC",
                "wrapped_dek_recovery": "DDDD"}
    r = local_client.put("/api/sync/keys", json={"key_material": material})
    assert r.status_code == 200 and r.get_json()["ok"] is True

    got = local_client.get("/api/sync/keys").get_json()
    assert got["exists"] is True and got["key_material"] == material
    created = got["created_at"]

    rewrapped = dict(material, wrapped_dek_passphrase="ZZZZ")
    local_client.put("/api/sync/keys", json={"key_material": rewrapped})
    after = local_client.get("/api/sync/keys").get_json()
    assert after["key_material"]["wrapped_dek_passphrase"] == "ZZZZ"
    assert after["created_at"] == created        # created_at preserved on rewrap


def test_keys_rejects_empty_material(local_client):
    assert local_client.put("/api/sync/keys", json={}).status_code == 400
    assert local_client.put(
        "/api/sync/keys", json={"key_material": {}}).status_code == 400


def test_bad_kind_rejected(local_client):
    r = local_client.post("/api/sync/rows", json={"rows": [
        {"kind": "bogus", "client_id": "x", "ciphertext": _b64(b"a"),
         "nonce": _b64(b"x")},
    ]})
    assert r.status_code == 400


def test_bad_base64_rejected(local_client):
    r = local_client.post("/api/sync/rows", json={"rows": [
        {"kind": "note", "client_id": "x", "ciphertext": "not base64!!",
         "nonce": "x"},
    ]})
    assert r.status_code == 400


def test_rows_must_be_a_list(local_client):
    assert local_client.post(
        "/api/sync/rows", json={"rows": "nope"}).status_code == 400


# --- enforced mode ---------------------------------------------------------

def test_enforced_requires_token(hosted_client):
    assert hosted_client.get("/api/sync/status").status_code == 401
    assert hosted_client.get("/api/sync/rows").status_code == 401
    assert hosted_client.post(
        "/api/sync/rows", json={"rows": []}).status_code == 401


def test_enforced_valid_token_resolves_user(hosted_client):
    r = hosted_client.get("/api/sync/status", headers=_bearer(USER_A))
    assert r.status_code == 200
    body = r.get_json()
    assert body["user_id"] == USER_A and body["auth_enforced"] is True


def test_enforced_rejects_bad_signature(hosted_client):
    headers = _bearer(USER_A, secret="WRONG-SECRET")
    assert hosted_client.get("/api/sync/status", headers=headers).status_code == 401


def test_enforced_rejects_expired(hosted_client):
    headers = _bearer(USER_A, expires_in=-3600)
    assert hosted_client.get("/api/sync/status", headers=headers).status_code == 401


def test_enforced_rejects_wrong_audience(hosted_client):
    headers = _bearer(USER_A, audience="anon")
    assert hosted_client.get("/api/sync/status", headers=headers).status_code == 401


def test_enforced_user_isolation(hosted_client):
    # A writes a row...
    w = hosted_client.post("/api/sync/rows", headers=_bearer(USER_A), json={
        "rows": [{"kind": "note", "client_id": "n1",
                  "ciphertext": _b64(b"secret"), "nonce": _b64(b"x")}]})
    assert w.status_code == 200
    # ...A can read it back...
    a_rows = hosted_client.get(
        "/api/sync/rows", headers=_bearer(USER_A)).get_json()["rows"]
    assert [r["client_id"] for r in a_rows] == ["n1"]
    # ...but B sees nothing of A's.
    b_rows = hosted_client.get(
        "/api/sync/rows", headers=_bearer(USER_B)).get_json()["rows"]
    assert b_rows == []


def test_enforced_keys_isolation(hosted_client):
    hosted_client.put("/api/sync/keys", headers=_bearer(USER_A),
                      json={"key_material": {"k": "A"}})
    assert hosted_client.get(
        "/api/sync/keys", headers=_bearer(USER_B)).get_json() == {"exists": False}
    got = hosted_client.get("/api/sync/keys", headers=_bearer(USER_A)).get_json()
    assert got["key_material"] == {"k": "A"}


# --- account deletion (GDPR/CCPA erasure) ----------------------------------

def _seed_account(client, headers=None):
    """Give an account one row + wrapped keys, so a delete has something to erase."""
    headers = headers or {}
    client.post("/api/sync/rows", headers=headers, json={"rows": [
        {"kind": "note", "client_id": "n1", "ciphertext": _b64(b"secret"),
         "nonce": _b64(b"x")}]})
    client.put("/api/sync/keys", headers=headers,
               json={"key_material": {"wrapped_dek_passphrase": "BBBB"}})


def test_account_delete_requires_confirmation(local_client):
    _seed_account(local_client)
    # No body / wrong confirmation -> 400, and nothing is erased.
    assert local_client.delete("/api/sync/account").status_code == 400
    assert local_client.delete(
        "/api/sync/account", json={"confirm": "yes"}).status_code == 400
    assert len(local_client.get("/api/sync/rows").get_json()["rows"]) == 1
    assert local_client.get("/api/sync/keys").get_json()["exists"] is True


def test_account_delete_erases_rows_and_keys(local_client):
    _seed_account(local_client)
    r = local_client.delete("/api/sync/account", json={"confirm": "DELETE"})
    assert r.status_code == 200
    body = r.get_json()
    assert body["ok"] is True
    assert body["erased"] == {"rows": 1, "keys": 1}
    # Data is gone — not tombstoned: a fresh pull sees nothing at all.
    assert local_client.get("/api/sync/rows").get_json()["rows"] == []
    assert local_client.get("/api/sync/keys").get_json() == {"exists": False}


def test_account_delete_reports_auth_pending_by_default(local_client):
    _seed_account(local_client)
    body = local_client.delete(
        "/api/sync/account", json={"confirm": "DELETE"}).get_json()
    # SQLite backend + flag off: the login/email can't be removed here, and the
    # response says so rather than pretending it was.
    assert body["auth_user_deleted"] is False


def test_account_delete_scoped_to_caller(hosted_client):
    _seed_account(hosted_client, headers=_bearer(USER_A))
    _seed_account(hosted_client, headers=_bearer(USER_B))
    r = hosted_client.delete("/api/sync/account", headers=_bearer(USER_A),
                             json={"confirm": "DELETE"})
    assert r.status_code == 200 and r.get_json()["erased"]["rows"] == 1
    # A is wiped...
    assert hosted_client.get(
        "/api/sync/rows", headers=_bearer(USER_A)).get_json()["rows"] == []
    assert hosted_client.get(
        "/api/sync/keys", headers=_bearer(USER_A)).get_json() == {"exists": False}
    # ...B is untouched.
    assert len(hosted_client.get(
        "/api/sync/rows", headers=_bearer(USER_B)).get_json()["rows"]) == 1
    assert hosted_client.get(
        "/api/sync/keys", headers=_bearer(USER_B)).get_json()["exists"] is True


def test_account_delete_requires_auth_when_enforced(hosted_client):
    assert hosted_client.delete(
        "/api/sync/account", json={"confirm": "DELETE"}).status_code == 401
