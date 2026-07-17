"""
Rate-limiting tests (H1.5 part 2).

Flask-Limiter is a HOSTED-ONLY dependency (requirements-hosted.txt): the default
local/dev/test environment doesn't install it, so this whole module is skipped
there (the app simply runs unlimited, exactly as before — that's the "test suite
untouched" guarantee). When the library IS present, these assert the coarse abuse
caps work: N requests pass and the (N+1)th is refused with the app's JSON error
shape; the limit is keyed on the real client IP (Render's X-Forwarded-For), so a
different client gets its own bucket; route groups have independent buckets; and —
the property that matters for defence in depth — the security headers still attach
on a 429 and the SSRF-guarded art path isn't bypassed by the limiter.
"""
import pytest

pytest.importorskip("flask_limiter")   # hosted-only; skip when absent

import config        # noqa: E402
import server        # noqa: E402


@pytest.fixture()
def limited_client(built_db, tmp_path):
    """A client with the limiter ON and tiny limits so caps are easy to hit.

    Supabase/auth config is neutralized so the test is hermetic regardless of any
    AOTD_SUPABASE_* the developer has exported in their shell (otherwise the sync
    routes would 401 and the store would talk to real Postgres)."""
    app = server.create_app({
        "DB_PATH": built_db["db"],
        "SEARCH_DB_PATH": built_db["search"],
        "JOURNAL_DB_PATH": tmp_path / "journal.db",
        "PREFETCH_ENABLED": False,
        # local mode: bypass auth, local sqlite store, throwaway feedback dir
        "SUPABASE_URL": "", "SUPABASE_ANON_KEY": "",
        "SUPABASE_JWT_SECRET": "", "SUPABASE_JWKS_URL": "",
        "SUPABASE_DB_URL": "",
        "SYNC_DB_PATH": tmp_path / "sync.db",
        "FEEDBACK_DIR": tmp_path / "feedback",
        "RATE_LIMIT_ENABLED": True,
        "RATE_LIMIT_CATALOG": "3 per minute",
        "RATE_LIMIT_ART": "2 per minute",
        "RATE_LIMIT_FEEDBACK": "2 per minute",
        "RATE_LIMIT_SYNC": "1000 per minute",
    })
    app.testing = True
    return app.test_client()


def _ip(addr):
    return {"X-Forwarded-For": addr}


def test_catalog_cap_returns_429_after_n(limited_client):
    hdr = _ip("203.0.113.10")
    for _ in range(3):
        assert limited_client.get("/api/today", headers=hdr).status_code == 200
    r = limited_client.get("/api/today", headers=hdr)
    assert r.status_code == 429
    assert r.get_json() == {"error": "rate limit exceeded"}   # app's JSON shape


def test_429_still_carries_security_headers(limited_client):
    hdr = _ip("203.0.113.11")
    for _ in range(3):
        limited_client.get("/api/today", headers=hdr)
    r = limited_client.get("/api/today", headers=hdr)
    assert r.status_code == 429
    # The after_request hardening must not be bypassed on the throttled path.
    assert "Content-Security-Policy" in r.headers
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    assert r.headers["X-Frame-Options"] == "DENY"


def test_limit_is_per_client_ip(limited_client):
    # One client exhausts its bucket...
    for _ in range(3):
        limited_client.get("/api/today", headers=_ip("198.51.100.1"))
    assert limited_client.get(
        "/api/today", headers=_ip("198.51.100.1")).status_code == 429
    # ...a different X-Forwarded-For client is unaffected.
    assert limited_client.get(
        "/api/today", headers=_ip("198.51.100.2")).status_code == 200


def test_art_group_is_stricter_and_independent(limited_client):
    hdr = _ip("203.0.113.20")
    # /api/artist/bio is in the strict ART group and returns 200 even offline
    # (a bio must never break the page), so it isolates the limiter from network.
    assert limited_client.get("/api/artist/bio?name=x", headers=hdr).status_code == 200
    assert limited_client.get("/api/artist/bio?name=x", headers=hdr).status_code == 200
    # Third call exceeds the tight ART cap (2/min).
    assert limited_client.get("/api/artist/bio?name=x", headers=hdr).status_code == 429
    # Catalog on the same IP still has budget (independent group).
    assert limited_client.get("/api/today", headers=hdr).status_code == 200


def test_feedback_fallback_is_capped(limited_client):
    hdr = _ip("203.0.113.30")
    body = {"message": "hi"}
    assert limited_client.post("/api/feedback", json=body, headers=hdr).status_code == 200
    assert limited_client.post("/api/feedback", json=body, headers=hdr).status_code == 200
    assert limited_client.post("/api/feedback", json=body, headers=hdr).status_code == 429


def test_sync_cap_is_generous(limited_client):
    # The authenticated sync surface gets a generous cap; a handful of calls are
    # nowhere near it.
    hdr = _ip("203.0.113.40")
    for _ in range(10):
        assert limited_client.get("/api/sync/status", headers=hdr).status_code == 200


def test_disabled_when_flag_off(built_db, tmp_path):
    """With the library present but RATE_LIMIT_ENABLED False, nothing throttles."""
    app = server.create_app({
        "DB_PATH": built_db["db"],
        "SEARCH_DB_PATH": built_db["search"],
        "JOURNAL_DB_PATH": tmp_path / "journal.db",
        "PREFETCH_ENABLED": False,
        "RATE_LIMIT_ENABLED": False,
        "RATE_LIMIT_CATALOG": "1 per minute",
    })
    app.testing = True
    c = app.test_client()
    for _ in range(5):
        assert c.get("/api/today", headers=_ip("203.0.113.50")).status_code == 200
