"""
L3 — the Privacy Policy + Terms pages (/privacy, /terms).

The scaffold is flag-gated OFF by default (config.LEGAL_PAGES_ENABLED, env
AOTD_PUBLISH_LEGAL): the pages are still attorney-review DRAFTs with unfilled
[PLACEHOLDERS], so they must not surface to real users until reviewed. These
assert both halves of that contract — 404 when off, served when on — plus the
honesty guardrail that they ship visibly marked as drafts.
"""
import config


def test_legal_pages_404_when_flag_off(client, monkeypatch):
    monkeypatch.setattr(config, "LEGAL_PAGES_ENABLED", False)
    assert client.get("/privacy").status_code == 404
    assert client.get("/terms").status_code == 404


def test_legal_pages_served_when_flag_on(client, monkeypatch):
    monkeypatch.setattr(config, "LEGAL_PAGES_ENABLED", True)
    privacy = client.get("/privacy")
    assert privacy.status_code == 200
    assert b"Privacy Policy" in privacy.data
    assert b"end-to-end encrypted" in privacy.data
    terms = client.get("/terms")
    assert terms.status_code == 200
    assert b"Terms of Service" in terms.data


def test_legal_pages_are_published_with_no_unfilled_placeholders(client, monkeypatch):
    """Once published: no DRAFT banner, no leftover [PLACEHOLDER], and the real
    operator + contact details are present. Guards against shipping a half-filled
    legal page."""
    monkeypatch.setattr(config, "LEGAL_PAGES_ENABLED", True)
    for path in ("/privacy", "/terms"):
        body = client.get(path).data
        assert b"NOT YET IN FORCE" not in body           # the removed DRAFT banner
        assert b"[LEGAL ENTITY" not in body
        assert b"[CONTACT EMAIL]" not in body
        assert b"[GOVERNING" not in body
        assert b"[MINIMUM AGE]" not in body
        assert b"info@musicforest.lol" in body
        assert b"Clancy Emanuel" in body
