"""
Observability surface (H1.5 part 2): structured request logging + /healthz.

Two things the hosted app gained: a JSON request-completion log per call, and a
richer health probe. The security-critical property here is REDACTION — the log
must never emit the Authorization header, request/response bodies, the raw query
string, or any secret (BETA_PLAN.md §3). The /healthz tests cover the 200-healthy
and 503-when-a-dep-is-down paths plus the no-secrets payload.
"""
import logging

import pytest

import config
import db
import server
import store


class _CapturingHandler(logging.Handler):
    """Collect the FORMATTED output of every record on the `aotd` logger, so the
    redaction assertions run against the exact bytes that reach stdout."""

    def __init__(self, formatter):
        super().__init__()
        self.setFormatter(formatter)
        self.lines = []

    def emit(self, record):
        self.lines.append(self.format(record))

    @property
    def text(self):
        return "\n".join(self.lines)


@pytest.fixture()
def client(built_db, tmp_path):
    """A test client in local mode, hermetic against any AOTD_SUPABASE_* the
    developer has exported: auth bypassed and the sync store is local sqlite, so
    /healthz deterministically reports the sqlite backend and a reachable store.
    Shadows the conftest `client` fixture for this module."""
    app = server.create_app({
        "DB_PATH": built_db["db"],
        "SEARCH_DB_PATH": built_db["search"],
        "JOURNAL_DB_PATH": tmp_path / "journal.db",
        "PREFETCH_ENABLED": False,
        "SUPABASE_URL": "", "SUPABASE_ANON_KEY": "",
        "SUPABASE_JWT_SECRET": "", "SUPABASE_JWKS_URL": "",
        "SUPABASE_DB_URL": "",
        "SYNC_DB_PATH": tmp_path / "sync.db",
        "FEEDBACK_DIR": tmp_path / "feedback",
        "RATE_LIMIT_ENABLED": False,
    })
    app.testing = True
    return app.test_client()


@pytest.fixture()
def capture_logs():
    handler = _CapturingHandler(server._JsonFormatter())
    server.log.addHandler(handler)
    server.log.setLevel(logging.DEBUG)
    try:
        yield handler
    finally:
        server.log.removeHandler(handler)


# --- request logging + redaction -------------------------------------------

SECRET_TOKEN = "SUPERSECRETBEARERTOKEN-do-not-log"
SECRET_BODY = "TOPSECRET-note-body-must-never-be-logged"
SECRET_QUERY = "SECRETQUERYTERM"


def test_request_is_logged_with_structured_fields(client, capture_logs):
    r = client.get("/api/day?date=03-10")
    assert r.status_code == 200
    # The completion line is present and structured.
    assert '"event": "request"' in capture_logs.text
    assert '"path": "/api/day"' in capture_logs.text
    assert '"status": 200' in capture_logs.text
    assert '"latency_ms"' in capture_logs.text
    assert '"request_id"' in capture_logs.text


def test_log_redacts_auth_header_body_and_query(client, capture_logs):
    # A request carrying a bearer token, a secret body, and a secret query term.
    r = client.post(
        "/api/journal/note",
        headers={"Authorization": f"Bearer {SECRET_TOKEN}"},
        query_string={"trace": SECRET_QUERY},
        json={"release_id": 100, "body": SECRET_BODY},
    )
    assert r.status_code == 200
    text = capture_logs.text
    # The request WAS logged...
    assert '"event": "request"' in text
    assert '"path": "/api/journal/note"' in text
    # ...but nothing sensitive leaked into the logs.
    assert SECRET_TOKEN not in text          # no Authorization header value
    assert SECRET_BODY not in text           # no request body
    assert SECRET_QUERY not in text          # no raw query string
    assert "Authorization" not in text       # not even the header name
    assert "Bearer" not in text


def test_500_logs_traceback_serverside_but_returns_generic(client, capture_logs,
                                                            monkeypatch):
    # Force an unexpected error inside a route and confirm the client sees a
    # generic JSON 500 (no stack) while the traceback is captured server-side.
    def boom(*a, **k):
        raise RuntimeError("INTERNAL-DETAIL-should-not-reach-client")

    monkeypatch.setattr(server.db, "day_count", boom)
    r = client.get("/api/today")
    assert r.status_code == 500
    body = r.get_json()
    assert body == {"error": "internal server error"}
    # Client never sees internals; server log does (traceback, server-side only).
    assert "INTERNAL-DETAIL-should-not-reach-client" not in r.get_data(as_text=True)
    assert "INTERNAL-DETAIL-should-not-reach-client" in capture_logs.text
    assert '"event": "unhandled_exception"' in capture_logs.text


# --- /healthz ---------------------------------------------------------------

def test_healthz_ok_when_deps_up(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    body = r.get_json()
    assert body["status"] == "ok"
    assert body["checks"] == {"catalog": True, "store": True}
    assert body["backend"] == "sqlite"
    assert "auth_enforced" in body and "version" in body
    # No secret ever appears in the payload.
    flat = r.get_data(as_text=True)
    for needle in ("password", "secret", "jwt", "db_url", "anon_key", "token"):
        assert needle not in flat.lower()


# --- /version (deploy gate) -------------------------------------------------

def test_version_reports_build_and_no_store(client):
    # The PWA compares /version against the version its shell booted with to tell
    # whether a new deploy is fully live before offering a reload (avoids 502s).
    r = client.get("/version")
    assert r.status_code == 200
    body = r.get_json()
    assert body.get("version") == server.BUILD_VERSION
    # Must never be read from a cache, or it couldn't detect a fresh deploy.
    assert "no-store" in r.headers.get("Cache-Control", "")


def test_build_version_matches_service_worker(client):
    # Single source of truth: /version must mirror static/sw.js's VERSION.
    import re
    from pathlib import Path
    sw = (Path(server.__file__).resolve().parent / "static" / "sw.js").read_text("utf-8")
    m = re.search(r"VERSION\s*=\s*['\"]([^'\"]+)['\"]", sw)
    assert m, "sw.js VERSION constant not found"
    assert server.BUILD_VERSION == m.group(1)


def test_healthz_security_headers_attach(client):
    r = client.get("/healthz")
    assert "Content-Security-Policy" in r.headers
    assert r.headers["X-Content-Type-Options"] == "nosniff"


def test_healthz_503_when_catalog_down(client, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("catalog unreachable")

    monkeypatch.setattr(server.db, "day_count", boom)
    r = client.get("/healthz")
    assert r.status_code == 503
    body = r.get_json()
    assert body["status"] == "degraded"
    assert body["checks"]["catalog"] is False


def test_healthz_503_when_store_down(client, monkeypatch):
    class _DeadStore:
        def ping(self):
            raise store.StoreError("store down", status=503)

    monkeypatch.setattr(server.store, "get_store", lambda: _DeadStore())
    r = client.get("/healthz")
    assert r.status_code == 503
    assert r.get_json()["checks"]["store"] is False
