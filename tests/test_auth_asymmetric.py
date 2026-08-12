"""
Asymmetric (ES256) JWT verification — auth._verify_asymmetric and the ES256/RS256
dispatch in auth.user_id_from_headers.

This is the token path Supabase uses under its current signing-keys system, i.e.
the one that actually runs in production once the project rotates off the legacy
HS256 secret. The rest of the suite only ever mints HS256 tokens, so before this
file _verify_asymmetric (and the ES256 branch of user_id_from_headers) had ZERO
coverage — a bug there would let a bad token through, or reject a good one, for
every hosted user, and no test would notice.

No network and no real JWKS fetch: we generate an EC P-256 keypair in-process,
pre-seed auth._JWKS_CLIENTS with a fake client that hands back the matching public
key, and mint tokens with PyJWT. The signature check itself is real (PyJWT +
cryptography verifying an actual ES256 signature) — only the key *delivery* is
stubbed. Skips cleanly if pyjwt[crypto]/cryptography aren't installed.
"""
import time

import pytest

jwt = pytest.importorskip("jwt")               # PyJWT
pytest.importorskip("cryptography")            # ES256 needs the crypto backend
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402

import auth    # noqa: E402
import config  # noqa: E402

JWKS_URL = "https://example.test/.well-known/jwks.json"


class _FakeSigningKey:
    def __init__(self, key):
        self.key = key


class _FakeJWKClient:
    """Stands in for PyJWT's PyJWKClient so nothing hits the network. Returns one
    fixed public key for any token — kid resolution isn't what these tests probe;
    the real signature verification below is what matters."""

    def __init__(self, public_key):
        self._public_key = public_key

    def get_signing_key_from_jwt(self, token):
        return _FakeSigningKey(self._public_key)


def _mint(private_key, *, sub="user-abc-123", aud="authenticated",
          iss=None, exp_delta=3600, extra=None, alg="ES256"):
    now = int(time.time())
    claims = {"aud": aud, "iat": now, "exp": now + exp_delta}
    if sub is not None:
        claims["sub"] = sub
    if iss:
        claims["iss"] = iss
    if extra:
        claims.update(extra)
    return jwt.encode(claims, private_key, algorithm=alg)


def _hdr(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture()
def asym(monkeypatch):
    """Hosted mode with an asymmetric JWKS configured, keyed to an in-process EC
    keypair. Yields (good_private_key, wrong_private_key)."""
    good = ec.generate_private_key(ec.SECP256R1())
    wrong = ec.generate_private_key(ec.SECP256R1())
    monkeypatch.setitem(auth._JWKS_CLIENTS, JWKS_URL,
                        _FakeJWKClient(good.public_key()))
    monkeypatch.setattr(config, "SUPABASE_JWKS_URL", JWKS_URL)
    monkeypatch.setattr(config, "SUPABASE_JWT_SECRET", "")
    monkeypatch.setattr(config, "JWT_AUDIENCE", "authenticated")
    monkeypatch.setattr(config, "JWT_ISSUER", "")
    return good, wrong


def test_valid_es256_token_returns_sub(asym):
    good, _ = asym
    token = _mint(good, sub="user-abc-123")
    assert auth.user_id_from_headers(_hdr(token)) == "user-abc-123"


def test_signature_from_the_wrong_key_is_rejected(asym):
    _, wrong = asym
    token = _mint(wrong)  # signed by a key the JWKS doesn't vouch for
    with pytest.raises(auth.AuthError):
        auth.user_id_from_headers(_hdr(token))


def test_expired_es256_token_is_rejected(asym):
    good, _ = asym
    token = _mint(good, exp_delta=-4000)  # well past the 30s leeway
    with pytest.raises(auth.AuthError):
        auth.user_id_from_headers(_hdr(token))


def test_wrong_audience_is_rejected(asym):
    good, _ = asym
    token = _mint(good, aud="some-other-service")
    with pytest.raises(auth.AuthError):
        auth.user_id_from_headers(_hdr(token))


def test_issuer_is_enforced_when_configured(asym, monkeypatch):
    good, _ = asym
    monkeypatch.setattr(config, "JWT_ISSUER", "https://issuer.example")
    ok = _mint(good, iss="https://issuer.example")
    assert auth.user_id_from_headers(_hdr(ok)) == "user-abc-123"
    bad = _mint(good, iss="https://evil.example")
    with pytest.raises(auth.AuthError):
        auth.user_id_from_headers(_hdr(bad))


def test_token_without_sub_is_rejected(asym):
    good, _ = asym
    token = _mint(good, sub=None)  # exp present, sub missing → require fails
    with pytest.raises(auth.AuthError):
        auth.user_id_from_headers(_hdr(token))


def test_es256_token_but_no_jwks_url_configured(asym, monkeypatch):
    good, _ = asym
    # Still "enforced" via a legacy secret, but no JWKS URL to verify ES256 against.
    monkeypatch.setattr(config, "SUPABASE_JWKS_URL", "")
    monkeypatch.setattr(config, "SUPABASE_JWT_SECRET", "legacy-secret")
    token = _mint(good)
    with pytest.raises(auth.AuthError):
        auth.user_id_from_headers(_hdr(token))


def test_hs256_token_without_legacy_secret_is_rejected(asym, monkeypatch):
    # JWKS is set (asymmetric configured) but no HS256 secret; an HS256 token
    # must be refused rather than silently accepted.
    monkeypatch.setattr(config, "SUPABASE_JWT_SECRET", "")
    secret = "x" * 48
    token = jwt.encode({"sub": "u", "aud": "authenticated",
                        "exp": int(time.time()) + 3600}, secret, algorithm="HS256")
    with pytest.raises(auth.AuthError):
        auth.user_id_from_headers(_hdr(token))


def test_unsupported_algorithm_is_rejected(asym):
    # An alg we don't handle (HS384) routes to neither verifier → refused.
    secret = "x" * 48
    token = jwt.encode({"sub": "u", "aud": "authenticated",
                        "exp": int(time.time()) + 3600}, secret, algorithm="HS384")
    with pytest.raises(auth.AuthError):
        auth.user_id_from_headers(_hdr(token))
