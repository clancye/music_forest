"""
Request identity for the hosted sync layer (H1.1).

Two completely separate things unlock the beta (BETA_PLAN.md §2): a Supabase
**magic link** proves *who you are* (this module), and an encryption
**passphrase** unlocks *your data* (client-side, H1.2). This module only does
the first: turn an incoming request into a user UUID, or refuse it.

Identity is carried by a Supabase-issued JWT in the `Authorization: Bearer …`
header, and we verify it ourselves. Supabase supports two signing systems and we
handle BOTH, dispatching on the token's `alg` so a project can migrate between
them with no downtime:

  * Asymmetric signing keys (ES256/RS256) — Supabase's current best practice. The
    public key is fetched from the project's JWKS discovery endpoint; the private
    key can't be extracted from Supabase, so nobody (not even the operator) can
    mint a token to impersonate a user. Verified with PyJWT (+ cryptography),
    imported lazily so it's only a dependency in the hosted env.
  * Legacy shared secret (HS256) — the older single JWT secret. Verified here
    with the standard library (HMAC-SHA256). Kept as a transition fallback.

Either way this is *token verification* — proving identity — not the end-to-end
encryption, which stays in vetted WebCrypto/libsodium primitives in the browser
(BETA_PLAN.md §3). The server only ever sees ciphertext, so the verification
library lives outside the E2EE trusted path (whose minimal-dependency concern is
the browser, not the server).

Bypass-when-unconfigured: if no JWT secret is set (local dev, the test suite,
`python server.py` on your laptop), there is no auth server to talk to, so every
request is attributed to config.LOCAL_USER_ID and signature checks are skipped.
The moment AOTD_SUPABASE_JWT_SECRET is set (i.e. on Render), a valid token is
required or the request is rejected — enforcement is real in the hosted env.
"""
import base64
import hashlib
import hmac
import json
import time

import config


class AuthError(Exception):
    """Raised when a request cannot be authenticated. `status` is the HTTP code
    the route layer should return (401 unless noted)."""

    def __init__(self, message, status=401):
        super().__init__(message)
        self.message = message
        self.status = status


def _b64url_decode(segment):
    """Decode a base64url JWT segment (no padding) to bytes."""
    pad = "=" * (-len(segment) % 4)
    return base64.urlsafe_b64decode(segment + pad)


def _verify_hs256(token, secret, *, audience, issuer, leeway=30):
    """Verify a compact HS256 JWT (legacy shared secret) and return its claims.

    Hardened against the usual JWT footguns:
      * the algorithm is pinned to HS256 here — the token header's `alg` is NOT
        trusted, so an attacker can't downgrade to `none` or swap algorithms;
      * the signature is compared in constant time;
      * `exp` (required) and `nbf`/`iat` (if present) are checked with a small
        leeway for clock skew;
      * `aud` must match; `iss` is checked only when we were given one.
    Raises AuthError on any failure.
    """
    if not isinstance(token, str) or token.count(".") != 2:
        raise AuthError("malformed token")
    header_b64, payload_b64, sig_b64 = token.split(".")

    # Validate the signature over EXACTLY the received header.payload bytes.
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    expected = hmac.new(
        secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    try:
        got = _b64url_decode(sig_b64)
    except (ValueError, base64.binascii.Error):
        raise AuthError("bad token signature encoding")
    if not hmac.compare_digest(expected, got):
        raise AuthError("bad token signature")

    # Only after the signature is proven do we trust the header/payload, and even
    # then we pin the algorithm rather than believing the header's `alg`.
    try:
        header = json.loads(_b64url_decode(header_b64))
        claims = json.loads(_b64url_decode(payload_b64))
    except (ValueError, base64.binascii.Error):
        raise AuthError("unparseable token")
    if header.get("alg") != "HS256":
        raise AuthError(f"unexpected token alg: {header.get('alg')!r}")
    if not isinstance(claims, dict):
        raise AuthError("unparseable token claims")

    now = int(time.time())
    exp = claims.get("exp")
    if exp is None:
        raise AuthError("token missing exp")
    if now > int(exp) + leeway:
        raise AuthError("token expired")
    nbf = claims.get("nbf")
    if nbf is not None and now < int(nbf) - leeway:
        raise AuthError("token not yet valid")

    aud = claims.get("aud")
    aud_ok = (aud == audience) or (isinstance(aud, list) and audience in aud)
    if audience and not aud_ok:
        raise AuthError("token audience mismatch")
    if issuer and claims.get("iss") != issuer:
        raise AuthError("token issuer mismatch")

    sub = claims.get("sub")
    if not sub:
        raise AuthError("token missing sub")
    return claims


def _bearer_token(headers):
    """Pull the bearer token out of an Authorization header, or None."""
    raw = headers.get("Authorization") or headers.get("authorization") or ""
    parts = raw.split(None, 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1].strip()
    return None


def _peek_alg(token):
    """Read the (unverified) `alg` from a compact JWT header, so we can route to
    the right verifier. Safe because each verifier independently re-checks the
    algorithm and validates the signature; this only chooses the method."""
    if not isinstance(token, str) or token.count(".") != 2:
        raise AuthError("malformed token")
    try:
        header = json.loads(_b64url_decode(token.split(".", 1)[0]))
    except (ValueError, base64.binascii.Error):
        raise AuthError("unparseable token header")
    return header.get("alg")


# One PyJWKClient per JWKS URL (it caches fetched keys in memory + handles kid
# lookup and rotation). Built lazily on first asymmetric verification.
_JWKS_CLIENTS = {}


def _verify_asymmetric(token, jwks_url, *, algorithms, audience, issuer, leeway=30):
    """Verify an ES256/RS256 Supabase JWT against the project's public JWKS, and
    return its claims. Uses PyJWT (+ cryptography), imported lazily so it's only
    a dependency in the hosted env. PyJWKClient fetches/caches the public keys and
    resolves the token's `kid`, so key rotation needs no redeploy."""
    try:
        import jwt  # PyJWT  # noqa: WPS433 - lazy, hosted-only
        from jwt import PyJWKClient
    except ImportError as e:  # pragma: no cover - exercised only when hosted
        raise AuthError(
            "PyJWT[crypto] is required to verify asymmetric Supabase tokens "
            "(pip install 'pyjwt[crypto]')", status=500) from e
    client = _JWKS_CLIENTS.get(jwks_url)
    if client is None:
        client = PyJWKClient(jwks_url)
        _JWKS_CLIENTS[jwks_url] = client
    try:
        signing_key = client.get_signing_key_from_jwt(token)
        kwargs = {"algorithms": algorithms, "leeway": leeway,
                  "options": {"require": ["exp", "sub"]}}
        if audience:
            kwargs["audience"] = audience
        if issuer:
            kwargs["issuer"] = issuer
        return jwt.decode(token, signing_key.key, **kwargs)
    except AuthError:
        raise
    except Exception as e:  # noqa: BLE001 - normalize PyJWT/JWKS errors to 401
        raise AuthError(f"invalid token: {e}")


def auth_enforced():
    """True when token verification is configured (hosted mode) — by an
    asymmetric JWKS URL, a legacy HS256 secret, or both."""
    return bool(config.SUPABASE_JWKS_URL or config.SUPABASE_JWT_SECRET)


def user_id_from_headers(headers):
    """Return the authenticated user's UUID (str) for a request, or raise
    AuthError. With nothing configured, returns config.LOCAL_USER_ID without
    inspecting the request (local/dev/test bypass). Otherwise the token is
    verified by the method matching its `alg`: asymmetric (ES256/RS256) against
    the JWKS, or legacy HS256 against the shared secret."""
    if not auth_enforced():
        return config.LOCAL_USER_ID
    token = _bearer_token(headers)
    if not token:
        raise AuthError("missing bearer token")
    alg = _peek_alg(token)
    if alg in ("ES256", "RS256"):
        if not config.SUPABASE_JWKS_URL:
            raise AuthError(f"{alg} token but no JWKS URL configured")
        claims = _verify_asymmetric(
            token, config.SUPABASE_JWKS_URL, algorithms=[alg],
            audience=config.JWT_AUDIENCE, issuer=config.JWT_ISSUER)
    elif alg == "HS256":
        if not config.SUPABASE_JWT_SECRET:
            raise AuthError("HS256 token but no legacy JWT secret configured")
        claims = _verify_hs256(
            token, config.SUPABASE_JWT_SECRET,
            audience=config.JWT_AUDIENCE, issuer=config.JWT_ISSUER)
    else:
        raise AuthError(f"unsupported token alg: {alg!r}")
    sub = claims.get("sub")
    if not sub:
        raise AuthError("token missing sub")
    return str(sub)


# --- test/dev helper --------------------------------------------------------

def make_token(sub, secret, *, audience="authenticated", issuer=None,
               expires_in=3600, extra=None, alg="HS256"):
    """Mint a compact HS256 JWT — used by the test suite (and handy for manual
    curl testing) to stand in for a real Supabase token. Not used in the request
    path. `alg` is overridable only so tests can assert non-HS256 is rejected."""
    def seg(obj):
        raw = json.dumps(obj, separators=(",", ":")).encode("utf-8")
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")

    now = int(time.time())
    header = {"alg": alg, "typ": "JWT"}
    claims = {"sub": sub, "aud": audience, "iat": now,
              "exp": now + expires_in}
    if issuer:
        claims["iss"] = issuer
    if extra:
        claims.update(extra)
    signing_input = f"{seg(header)}.{seg(claims)}".encode("ascii")
    sig = hmac.new(secret.encode("utf-8"), signing_input,
                   hashlib.sha256).digest()
    sig_b64 = base64.urlsafe_b64encode(sig).rstrip(b"=").decode("ascii")
    return f"{seg(header)}.{seg(claims)}.{sig_b64}"
