"""
SSRF guard regression tests (H1.3 re-confirmed in H1.5 part 2).

`safefetch` is the single chokepoint every server-side fetch of a third-party /
user-influenced URL goes through (cover art via fetch_art, artist bios via bio).
These lock in the invariants that stop SSRF: https-only, an explicit host
allowlist, rejection of any host that resolves to a private/loopback/link-local/
reserved address (cloud-metadata + intranet defence), and — critically — that
EVERY redirect hop is re-validated, not just the first URL.

No network: socket.getaddrinfo is stubbed so "DNS" is deterministic, and
requests.get is stubbed to script redirect chains.
"""
import pytest

import safefetch

ALLOWED = ("mzstatic.com", "coverartarchive.org", "archive.org")


def _addrinfo(*ips):
    """Build a getaddrinfo() return value resolving to the given IP strings."""
    return [(2, 1, 6, "", (ip, 443)) for ip in ips]


@pytest.fixture()
def fake_dns(monkeypatch):
    """A controllable name resolver. Map host -> list of IPs; default public."""
    table = {}

    def resolver(host, *a, **k):
        return _addrinfo(*table.get(host, ["93.184.216.34"]))  # public default

    monkeypatch.setattr(safefetch.socket, "getaddrinfo", resolver)
    return table


# --- host allowlisting (pure) ----------------------------------------------

def test_host_allowed_matches_apex_and_subdomains():
    assert safefetch.host_allowed("mzstatic.com", ALLOWED)
    assert safefetch.host_allowed("is1-ssl.mzstatic.com", ALLOWED)
    assert safefetch.host_allowed("ARCHIVE.ORG", ALLOWED)        # case-insensitive


def test_host_allowed_rejects_lookalikes_and_others():
    assert not safefetch.host_allowed("evil.com", ALLOWED)
    assert not safefetch.host_allowed("notmzstatic.com", ALLOWED)   # suffix w/o dot
    assert not safefetch.host_allowed("mzstatic.com.evil.com", ALLOWED)
    assert not safefetch.host_allowed("", ALLOWED)


# --- resolves_to_public: the private-IP fail-closed -------------------------

@pytest.mark.parametrize("ip", [
    "127.0.0.1",          # loopback
    "10.0.0.5",           # private
    "192.168.1.1",        # private
    "169.254.169.254",    # link-local (cloud metadata)
    "0.0.0.0",            # unspecified
    "224.0.0.1",          # multicast
])
def test_resolves_to_public_rejects_nonpublic(ip, fake_dns):
    fake_dns["host.example"] = [ip]
    assert safefetch.resolves_to_public("host.example") is False


def test_resolves_to_public_accepts_public(fake_dns):
    fake_dns["cdn.example"] = ["17.253.144.10"]
    assert safefetch.resolves_to_public("cdn.example") is True


def test_resolves_to_public_fails_if_any_address_is_private(fake_dns):
    # A host that resolves to BOTH a public and a private IP must fail closed
    # (a DNS-rebinding / split-horizon attempt).
    fake_dns["mixed.example"] = ["17.253.144.10", "10.0.0.5"]
    assert safefetch.resolves_to_public("mixed.example") is False


# --- check_url: scheme + host + IP policy ----------------------------------

def test_check_url_rejects_non_https(fake_dns):
    with pytest.raises(ValueError):
        safefetch.check_url("http://mzstatic.com/a.jpg", ALLOWED)


def test_check_url_rejects_unlisted_host(fake_dns):
    with pytest.raises(ValueError):
        safefetch.check_url("https://evil.com/a.jpg", ALLOWED)


def test_check_url_rejects_private_resolution(fake_dns):
    fake_dns["mzstatic.com"] = ["169.254.169.254"]   # allowlisted but private IP
    with pytest.raises(ValueError):
        safefetch.check_url("https://mzstatic.com/a.jpg", ALLOWED)


def test_check_url_accepts_good_url(fake_dns):
    fake_dns["mzstatic.com"] = ["17.253.144.10"]
    assert safefetch.check_url("https://mzstatic.com/a.jpg", ALLOWED) == "mzstatic.com"


# --- safe_get: every redirect hop is re-validated ---------------------------

class _FakeResp:
    def __init__(self, *, redirect_to=None, body=b"", ctype="image/jpeg"):
        self._redirect_to = redirect_to
        self.is_redirect = redirect_to is not None
        self.is_permanent_redirect = False
        self.headers = {}
        if redirect_to is not None:
            self.headers["Location"] = redirect_to
        else:
            self.headers["Content-Type"] = ctype
        self._body = body

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def raise_for_status(self):
        pass

    def iter_content(self, n):
        yield self._body


def _script(monkeypatch, responses):
    """Stub requests.get to return queued responses in order."""
    calls = {"urls": []}
    it = iter(responses)

    def fake_get(url, **k):
        calls["urls"].append(url)
        return next(it)

    monkeypatch.setattr(safefetch.requests, "get", fake_get)
    return calls


def test_safe_get_follows_a_valid_redirect(fake_dns, monkeypatch):
    fake_dns["coverartarchive.org"] = ["93.184.216.34"]
    fake_dns["ia800000.us.archive.org"] = ["207.241.224.2"]
    calls = _script(monkeypatch, [
        _FakeResp(redirect_to="https://ia800000.us.archive.org/img.jpg"),
        _FakeResp(body=b"\xff\xd8\xff\xe0imagebytes"),
    ])
    data, ctype = safefetch.safe_get(
        "https://coverartarchive.org/release/1/front", ALLOWED,
        max_bytes=10_000, max_redirects=4)
    assert data == b"\xff\xd8\xff\xe0imagebytes"
    assert ctype == "image/jpeg"
    assert len(calls["urls"]) == 2          # original + the redirect target


def test_safe_get_rejects_redirect_to_unlisted_host(fake_dns, monkeypatch):
    fake_dns["coverartarchive.org"] = ["93.184.216.34"]
    # The redirect points off-allowlist; the hop must be re-checked and refused
    # BEFORE any second request is issued.
    calls = _script(monkeypatch, [
        _FakeResp(redirect_to="https://evil.com/steal"),
        _FakeResp(body=b"should-never-be-reached"),
    ])
    with pytest.raises(ValueError):
        safefetch.safe_get(
            "https://coverartarchive.org/release/1/front", ALLOWED,
            max_bytes=10_000, max_redirects=4)
    assert calls["urls"] == ["https://coverartarchive.org/release/1/front"]


def test_safe_get_rejects_redirect_to_private_ip(fake_dns, monkeypatch):
    fake_dns["coverartarchive.org"] = ["93.184.216.34"]
    # Allowlisted redirect host, but it resolves to the cloud-metadata address.
    fake_dns["archive.org"] = ["169.254.169.254"]
    _script(monkeypatch, [
        _FakeResp(redirect_to="https://archive.org/internal"),
        _FakeResp(body=b"nope"),
    ])
    with pytest.raises(ValueError):
        safefetch.safe_get(
            "https://coverartarchive.org/release/1/front", ALLOWED,
            max_bytes=10_000, max_redirects=4)


def test_safe_get_enforces_size_cap(fake_dns, monkeypatch):
    fake_dns["mzstatic.com"] = ["17.253.144.10"]
    _script(monkeypatch, [_FakeResp(body=b"x" * 5000)])
    with pytest.raises(ValueError):
        safefetch.safe_get("https://mzstatic.com/big.jpg", ALLOWED,
                           max_bytes=1000, max_redirects=2)
