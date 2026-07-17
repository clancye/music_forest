"""
The H4b /admin cost panel: store.usage_stats() on the SQLite backend, and the
/api/admin/cost endpoint — fixed costs from config, live-measured usage, the
derived cost-per-account, and the operator gate.

Like test_attention / test_crawl_status, no catalog DB is needed: the endpoint
reads the sync store, config, and os.statvfs, all pointed at tmp_path.
"""
import auth
import config
import server
import store as store_mod

SECRET = "test-jwt-signing-secret"
USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"


def _make_client(tmp_path, *, secret="", operators=frozenset(), overrides=None):
    opts = {
        "SYNC_DB_PATH": tmp_path / "sync.db",
        "DATA_DIR": tmp_path,          # statvfs target — always an existing dir
        "SUPABASE_DB_URL": "",
        "SUPABASE_JWT_SECRET": secret,
        "SUPABASE_JWKS_URL": "",
        "JWT_AUDIENCE": "authenticated",
        "JWT_ISSUER": "",
        "OPERATOR_IDS": operators,
        "PREFETCH_ENABLED": False,
    }
    if overrides:
        opts.update(overrides)
    app = server.create_app(opts)
    app.testing = True
    return app.test_client()


def _bearer(sub):
    return {"Authorization": f"Bearer {auth.make_token(sub, SECRET)}"}


# --- store.usage_stats() -------------------------------------------------------

def test_usage_stats_counts(tmp_path):
    st = store_mod.SQLiteStore(tmp_path / "sync.db")
    u0 = st.usage_stats()
    assert u0["backend"] == "sqlite"
    assert u0["accounts"] == 0
    assert u0["journal_rows"] == 0
    assert u0["access_requests"] == 0
    assert isinstance(u0["db_bytes"], int) and u0["db_bytes"] > 0

    st.put_keys(USER_A, {"wrapped": "x"})
    st.upsert_rows(USER_A, [{"kind": "note", "client_id": "n1",
                             "ciphertext": b"ab", "nonce": b"cd"}])
    st.add_access_request("someone@example.com")
    u1 = st.usage_stats()
    assert u1["accounts"] == 1
    assert u1["journal_rows"] == 1
    assert u1["access_requests"] == 1

    # A tombstoned row drops out of the LIVE count (deleted_at set).
    st.delete_row(USER_A, "note", "n1")
    assert st.usage_stats()["journal_rows"] == 0


# --- the endpoint --------------------------------------------------------------

def test_cost_payload_defaults(tmp_path):
    body = _make_client(tmp_path).get("/api/admin/cost").get_json()
    # Fixed costs are the config defaults (real invoices, annual lines ÷12):
    # 11.75 + 37.19 + 0.13 + 3.00.
    assert body["costs"] == {"render": 11.75, "supabase": 37.19,
                             "domain": 0.13, "email": 3.0}
    assert body["fixed_monthly"] == 52.07
    assert body["ceilings"]["supabase_db_gb"] == 8
    u = body["usage"]
    assert u["backend"] == "sqlite"
    assert u["accounts"] == 0
    assert u["db_bytes"] > 0
    assert u["disk_total_bytes"] > 0
    assert u["disk_used_bytes"] >= 0
    # No accounts yet -> cost-per-account is undefined, never a divide-by-zero.
    assert body["cost_per_account"] is None


def test_cost_reflects_usage(tmp_path):
    client = _make_client(tmp_path)
    st = store_mod.get_store()          # the same file the endpoint reads
    st.put_keys(USER_A, {"wrapped": "x"})
    st.put_keys(USER_B, {"wrapped": "y"})
    body = client.get("/api/admin/cost").get_json()
    assert body["usage"]["accounts"] == 2
    # 52.07 / 2 = 26.035 (assert on the value, not its last-cent rounding).
    assert abs(body["cost_per_account"] - 26.035) < 0.01


def test_cost_operator_gate(tmp_path):
    client = _make_client(tmp_path, secret=SECRET,
                          operators=frozenset({USER_A}))
    assert client.get("/api/admin/cost").status_code == 401
    assert client.get("/api/admin/cost",
                      headers=_bearer(USER_B)).status_code == 403
    assert client.get("/api/admin/cost",
                      headers=_bearer(USER_A)).status_code == 200


def test_cost_price_overrides(tmp_path):
    """Prices are env/config-driven, so a plan change is one var, not a code
    edit. Restore the globals after — no other test reads COST_*."""
    saved = (config.COST_RENDER_MONTHLY, config.COST_SUPABASE_MONTHLY,
             config.COST_DOMAIN_MONTHLY, config.COST_EMAIL_MONTHLY)
    try:
        client = _make_client(tmp_path, overrides={
            "COST_RENDER_MONTHLY": 25.0, "COST_SUPABASE_MONTHLY": 25.0,
            "COST_DOMAIN_MONTHLY": 0.0, "COST_EMAIL_MONTHLY": 0.0})
        body = client.get("/api/admin/cost").get_json()
        assert body["costs"]["render"] == 25.0
        assert body["fixed_monthly"] == 50.0
    finally:
        (config.COST_RENDER_MONTHLY, config.COST_SUPABASE_MONTHLY,
         config.COST_DOMAIN_MONTHLY, config.COST_EMAIL_MONTHLY) = saved
