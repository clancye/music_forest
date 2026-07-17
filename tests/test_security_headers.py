"""
Security-headers regression tests (H1.3 re-confirmed in H1.5 part 2).

The app attaches a strict CSP + a baseline of hardening headers to EVERY response
via an after_request hook (server.security_headers). These lock in that the key
headers are present, that the CSP carries the directives that matter for in-browser
E2EE (script-src locked down, frame-ancestors 'none', object-src 'none'), and that
they still attach on non-200s (404 / 500) — i.e. the hook isn't bypassed on the
error paths an attacker is most likely to probe.
"""
import server


def _headers(resp):
    return resp.headers


def test_core_headers_present_on_200(client):
    h = _headers(client.get("/api/today"))
    assert "Content-Security-Policy" in h
    assert h["X-Content-Type-Options"] == "nosniff"
    assert h["X-Frame-Options"] == "DENY"
    assert h["Referrer-Policy"] == "no-referrer"
    assert h["Cross-Origin-Opener-Policy"] == "same-origin"
    assert "Strict-Transport-Security" in h
    assert "max-age=" in h["Strict-Transport-Security"]


def test_csp_locks_down_the_xss_surface(client):
    csp = client.get("/api/today").headers["Content-Security-Policy"]
    assert "default-src 'self'" in csp
    assert "object-src 'none'" in csp
    assert "frame-ancestors 'none'" in csp
    assert "base-uri 'self'" in csp
    # script-src is same-origin + the two vetted CDNs only; no unsafe-inline/eval.
    assert "script-src 'self' https://cdn.jsdelivr.net 'wasm-unsafe-eval'" in csp
    assert "'unsafe-inline'" not in csp.split("script-src")[1].split(";")[0]
    assert "'unsafe-eval'" not in csp


def test_headers_attach_on_404(client):
    r = client.get("/api/does-not-exist")
    assert r.status_code == 404
    assert "Content-Security-Policy" in r.headers
    assert r.headers["X-Content-Type-Options"] == "nosniff"


def test_headers_attach_on_500(client, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("kaboom")

    monkeypatch.setattr(server.db, "day_count", boom)
    r = client.get("/api/today")
    assert r.status_code == 500
    assert "Content-Security-Policy" in r.headers
    assert r.headers["X-Frame-Options"] == "DENY"
