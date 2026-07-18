#!/usr/bin/env python3
"""
Local web server for Album-of-the-Day.

Serves the single-page UI and a small JSON API. Reads only from the SQLite
database, so it's fast and fully offline once artwork is cached.

Endpoints:
    GET /                       -> the app
    GET /api/today              -> all albums released on today's month/day
    GET /api/day?date=MM-DD     -> all albums for a specific month/day
    GET /api/choice?date=MM-DD    -> two random albums for the decide mode
    GET /static/...             -> UI assets + cached cover images

Run:  python server.py     (then open http://127.0.0.1:8000)
"""
import base64
import hmac
import html
import json
import logging
import mimetypes
import os
import re
import sys
import threading
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote, quote_plus

from flask import (Blueprint, Flask, abort, current_app, g, jsonify, request,
                   send_from_directory)
from werkzeug.exceptions import HTTPException

# Flask-Limiter is a HOSTED-ONLY dependency (requirements-hosted.txt), imported
# lazily the way psycopg is: when it isn't installed — local dev and the default
# test suite — `_HAVE_LIMITER` is False, no limiting is wired, and the app
# behaves exactly as before. When it IS installed (the Render host, or a test
# env that adds it), the limits below attach to the public routes.
try:  # pragma: no cover - exercised by env, not by a single code path
    from flask_limiter import Limiter
    from flask_limiter.errors import RateLimitExceeded
    _HAVE_LIMITER = True
except ImportError:  # pragma: no cover
    Limiter = None
    RateLimitExceeded = None
    _HAVE_LIMITER = False

# Serve the web app manifest with the correct media type. Without this, Flask's
# static handler may guess application/octet-stream for `.webmanifest`, which —
# combined with our `X-Content-Type-Options: nosniff` — makes the browser refuse
# the manifest and silently drop installability.
mimetypes.add_type("application/manifest+json", ".webmanifest")

import attention
import auth
import bio
import catalogdb
import config
import db
import feedback
import fetch_art
import journal
import opsdb
import pooldb
import prefetch
import store
from genres import split_genres as _split_genres
from reqparams import (  # noqa: F401 - re-exported so server.<name> call sites keep working
    _md_or_today,
    _parse_md,
    _platforms_param,
)
from uidmap import (  # noqa: F401 - re-exported so server.<name> call sites keep working
    _album_for_uid,
    _canon_uid,
    _rid_from_uid,
)

# Routes live on a Blueprint so create_app() can build a fresh, isolated Flask
# app (e.g. a test app pointed at a throwaway DB) without import-time globals.
bp = Blueprint("aotd", __name__)

# Application version, surfaced in /healthz. Best-effort: read once at import.
try:
    from importlib import metadata as _ilmd  # noqa: WPS433
    APP_VERSION = _ilmd.version("album-of-the-day")
except Exception:  # noqa: BLE001 - not a packaged dist; fall back to a constant
    APP_VERSION = "0"


def _read_build_version():
    """The deployed PWA build version. Single source of truth is
    ``static/sw.js`` (``const VERSION = 'vNN'``) so there's exactly one number to
    bump per release. Read once at import: each running instance reports the
    version of the code *it* is serving, so a client comparing /version against
    the version its own shell booted with can tell whether a new deploy has fully
    rolled out (and, by a 502/timeout, whether the host is still mid-deploy)."""
    try:
        from pathlib import Path as _P  # noqa: WPS433 - local, import-time only
        txt = (_P(__file__).resolve().parent / "static" / "sw.js").read_text("utf-8")
        m = re.search(r"VERSION\s*=\s*['\"]([^'\"]+)['\"]", txt)
        if m:
            return m.group(1)
    except Exception:  # noqa: BLE001 - fall back to the packaged/app version
        pass
    return APP_VERSION


BUILD_VERSION = _read_build_version()


# ===========================================================================
# Structured logging (H1.5 part 2)
#
# gunicorn imports `server:app` and never calls main(), so the old print()
# startup logging produced almost nothing on the host. We configure the stdlib
# logging module with a JSON formatter at app creation; gunicorn's stdout flows
# to Render's logs. One request-completion line is emitted per call.
#
# REDACTION IS THE CORE INVARIANT (BETA_PLAN.md §3): the emitted line carries
# only method, path (NOT the raw query string), status, latency, an opaque
# per-request id, the resolved user_id (itself an opaque UUID), and the store
# backend. It NEVER logs the Authorization header, request/response bodies, or
# any secret. Nothing here ever touches request.get_data()/headers/args.
# ===========================================================================
log = logging.getLogger("aotd")

# The set of extra fields _JsonFormatter promotes to top-level JSON keys. Kept
# to a known whitelist so a stray logging call can never smuggle a raw header or
# body into the structured output.
_LOG_EXTRA_KEYS = (
    "event", "request_id", "method", "path", "status", "latency_ms",
    "user_id", "backend", "error",
)


class _JsonFormatter(logging.Formatter):
    """Render each log record as a single-line JSON object. Only a whitelist of
    known extra keys is included, plus the message, level, logger and timestamp.
    A traceback (when present) is included server-side only — these records go to
    stdout/Render logs, never to an HTTP client."""

    def format(self, record):
        payload = {
            "ts": datetime.fromtimestamp(
                record.created, tz=timezone.utc).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for key in _LOG_EXTRA_KEYS:
            if key in record.__dict__ and record.__dict__[key] is not None:
                payload[key] = record.__dict__[key]
        if record.exc_info:
            # Server-side only (stdout -> Render logs); never returned to a client.
            payload["traceback"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def _configure_logging():
    """Attach the JSON formatter + a stdout handler to the `aotd` logger once.

    Idempotent: tests build many apps in one process, so we never stack
    handlers. Level comes from config.AOTD_LOG_LEVEL (default INFO)."""
    level = getattr(logging, str(config.LOG_LEVEL).upper(), logging.INFO)
    log.setLevel(level)
    log.propagate = False
    if not any(getattr(h, "_aotd", False) for h in log.handlers):
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(_JsonFormatter())
        handler._aotd = True  # tag so we don't add a second one
        log.addHandler(handler)
    else:
        for h in log.handlers:
            if getattr(h, "_aotd", False):
                h.setLevel(level)


# --- Live request-concurrency gauge (operator capacity panel) -----------------
# The Render box's real ceiling is its worker threads, not any billing meter
# (INVITE_ROLLOUT_PLAN §2). This is a cheap in-process gauge of requests in flight
# for THIS worker — current + lifetime peak — surfaced in /api/admin/cost so the
# operator can watch the box approach saturation during the beta. With more than
# one gunicorn worker each has its own gauge, so the panel labels it "this worker"
# and the number is never overread as the whole box.
_concurrency = {"now": 0, "peak": 0}
_concurrency_lock = threading.Lock()


def _concurrency_enter():
    with _concurrency_lock:
        _concurrency["now"] += 1
        if _concurrency["now"] > _concurrency["peak"]:
            _concurrency["peak"] = _concurrency["now"]


def _concurrency_exit(_exc=None):
    """teardown_request handler — always runs, even when the view raised, so the
    gauge can never leak a slot. Its return value is ignored by Flask."""
    with _concurrency_lock:
        if _concurrency["now"] > 0:
            _concurrency["now"] -= 1


def _begin_request():
    """Stamp the request with a start time + opaque id, before anything else
    (incl. the limiter) can short-circuit it, so the completion log always fires
    with a latency and id."""
    g._t0 = time.monotonic()
    g.request_id = uuid.uuid4().hex[:12]
    _concurrency_enter()


def _log_request(resp):
    """One structured line per completed request. Redacted by construction: only
    method, path, status, latency, ids and backend — never headers/body/query."""
    try:
        t0 = getattr(g, "_t0", None)
        latency_ms = round((time.monotonic() - t0) * 1000, 1) if t0 else None
        backend = "postgres" if config.SUPABASE_DB_URL else "sqlite"
        level = logging.INFO
        if resp.status_code >= 500:
            level = logging.ERROR
        elif resp.status_code >= 400:
            level = logging.WARNING
        log.log(level, "request", extra={
            "event": "request",
            "request_id": getattr(g, "request_id", None),
            "method": request.method,
            "path": request.path,            # NOT request.full_path (no query)
            "status": resp.status_code,
            "latency_ms": latency_ms,
            "user_id": getattr(g, "user_id", None),
            "backend": backend,
        })
    except Exception:  # noqa: BLE001 - logging must never break a response
        pass
    return resp


# ===========================================================================
# Rate limiting (H1.5 part 2) — see config.RATE_LIMIT_* and create_app().
# ===========================================================================
def _client_ip():
    """The limiter key: the real client IP. On Render the app sits behind a
    proxy, so request.remote_addr is the proxy; the true client is the FIRST
    entry of X-Forwarded-For. Falls back to remote_addr when unproxied (local).
    Keying on the proxy IP instead would make every request look like one client
    and collapse all users into a single bucket."""
    xff = request.headers.get("X-Forwarded-For", "")
    if xff:
        return xff.split(",")[0].strip()
    return request.remote_addr or "127.0.0.1"


# A single Limiter instance, created only when the library is present. The
# per-route limits are read from config via callables so they can be tuned by
# env (or overridden in a test) and so importing this module never requires the
# hosted dependency. Storage is in-memory ("memory://").
if _HAVE_LIMITER:
    limiter = Limiter(
        key_func=_client_ip,
        default_limits=[],            # we only apply explicit per-route limits
        storage_uri="memory://",
        headers_enabled=True,
        strategy="fixed-window",
    )
else:
    limiter = None


def _limit(get_value):
    """Decorator factory that applies a Flask-Limiter limit when the library is
    installed, and is a transparent no-op when it isn't (local/dev/test). The
    limit value is a callable so it's resolved per-request from config."""
    if _HAVE_LIMITER:
        return limiter.limit(get_value)

    def _noop(fn):
        return fn
    return _noop


# The four route groups (see the plan / BACKLOG H1.5). Defined as callables so a
# test can repoint config.RATE_LIMIT_* before building its app.
_LIMIT_ART = _limit(lambda: config.RATE_LIMIT_ART)
_LIMIT_CATALOG = _limit(lambda: config.RATE_LIMIT_CATALOG)
_LIMIT_FEEDBACK = _limit(lambda: config.RATE_LIMIT_FEEDBACK)
_LIMIT_SYNC = _limit(lambda: config.RATE_LIMIT_SYNC)
_LIMIT_ACCESS = _limit(lambda: config.RATE_LIMIT_ACCESS)


def add_cors(resp):
    # Off by default; set AOTD_CORS_ORIGIN to share the API cross-origin later.
    if config.CORS_ALLOW_ORIGIN:
        resp.headers["Access-Control-Allow-Origin"] = config.CORS_ALLOW_ORIGIN
    return resp


def build_csp():
    """Build the Content-Security-Policy string (H1.3 hardening, BETA_PLAN.md §3).

    XSS is the real threat to in-browser E2EE, so `script-src` is strict: only
    same-origin app code and the two vetted, SRI-pinned jsDelivr primitives
    (supabase-js + libsodium). No 'unsafe-inline', no 'unsafe-eval' — there are no
    inline scripts or inline event handlers in the app. 'wasm-unsafe-eval' is the
    one concession, required to compile the libsodium (Argon2id) WASM module.

    The other directives whitelist exactly the cross-origin surfaces the app uses
    and nothing else: jsDelivr for scripts, the project's Supabase origin for
    auth/sync fetches, and the artwork CDNs for hotlinked covers.
    """
    # connect-src: same-origin sync/API + the Supabase project origin (auth, JWKS,
    # encrypted-row sync). Empty in local single-user mode.
    connect = ["'self'"]
    if config.SUPABASE_URL:
        connect.append(config.SUPABASE_URL.rstrip("/"))

    # img-src: same-origin (cached art) + data: (inline svg favicon) + the art
    # hotlink hosts, derived from the same allowlist fetch_art enforces so the two
    # never drift. Each host suffix is allowed as both apex and any subdomain.
    # blob: lets the operator feedback view (/admin) show screenshots it pulls
    # from the private Storage bucket as object URLs (H1.4). Generic + harmless.
    img = ["'self'", "data:", "blob:"]
    for host in config.ART_ALLOWED_HOSTS:
        img.append(f"https://{host}")
        img.append(f"https://*.{host}")

    directives = [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "script-src 'self' https://cdn.jsdelivr.net 'wasm-unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src " + " ".join(img),
        "font-src 'self'",
        "connect-src " + " ".join(connect),
        "worker-src 'self'",
        "manifest-src 'self'",
    ]
    return "; ".join(directives)


def security_headers(resp):
    """Attach the CSP + a baseline of hardening headers to every response.

    Sent globally (cheap, and harmless on JSON/asset responses). HSTS is included
    unconditionally — browsers ignore it over plain HTTP / on localhost, and it
    takes effect once the app is served over HTTPS on the deployed origin.
    """
    csp = build_csp()
    header = ("Content-Security-Policy-Report-Only"
              if config.CSP_REPORT_ONLY else "Content-Security-Policy")
    resp.headers[header] = csp

    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    # Deny powerful features we never use; explicitly allow WebAuthn on our own
    # origin (these default to self anyway, but listing them documents that the
    # opt-in biometric device-unlock — BETA_PLAN §3a — is intentional and keeps
    # working if a stricter default is ever assumed). Note biometric unlock uses
    # the platform authenticator, not the camera/microphone permissions.
    resp.headers["Permissions-Policy"] = (
        "accelerometer=(), camera=(), geolocation=(), gyroscope=(), "
        "magnetometer=(), microphone=(), payment=(), usb=(), "
        "publickey-credentials-get=(self), publickey-credentials-create=(self)")
    resp.headers["Strict-Transport-Security"] = (
        "max-age=15552000; includeSubDomains")
    return resp


# --- H6: per-record link previews ---------------------------------------------
# The ↗ Share door sends `/?album=<uid>`. Without this, that link unfurls in
# iMessage/Slack/WhatsApp as the app icon + site tagline — but in a group chat THE
# UNFURL IS THE SHARE: most recipients decide whether to tap from the card alone. So
# when the shell is requested with an `album` param we swap the generic og:/twitter:
# block (marked off in static/index.html) for the record's own cover and title.
#
# Rules this path holds to:
#   * LOCAL CATALOG ONLY. _album_for_uid reads the pool + albums.db and the door
#     CACHE; it never fires a door call, so an unfurl bot can't burn the metered
#     iTunes/Spotify budget. Nothing here may ever call out.
#   * NO CLOAKING. Bots and people get the same HTML — the app reads ?album itself
#     and opens the record as a door. This only changes the <head>.
#   * FAIL BACK TO GENERIC. No param, an unknown/stale uid, a missing marker, or any
#     error serves the file exactly as written.
_OG_BLOCK_RE = re.compile(r"<!--og:start-->.*?<!--og:end-->", re.S)
_SHELL_PATH = Path(__file__).resolve().parent / "static" / "index.html"


def _abs_url(url):
    """Absolutize a URL for og:/twitter: (they require absolute, and several
    unfurlers reject or downgrade http). Render terminates TLS at its proxy and the
    app has no ProxyFix, so request.url_root reports the INTERNAL http scheme —
    X-Forwarded-Proto is the only honest source of the scheme a recipient will use.
    Derived from the request rather than hard-coded, so staging unfurls as staging."""
    if not url:
        return None
    if url.startswith("http://") or url.startswith("https://"):
        return url
    proto = (request.headers.get("X-Forwarded-Proto") or "").split(",")[0].strip()
    scheme = proto or request.scheme
    return f"{scheme}://{request.host}/{url.lstrip('/')}"


def _record_og_tags(album, share_url):
    """The og:/twitter: block for one record. Every interpolated value is
    HTML-escaped — artist/title are catalog text and land inside an attribute."""
    e = lambda s: html.escape(str(s or ""), quote=True)      # noqa: E731
    artist, title = (album.get("artist") or "").strip(), (album.get("title") or "").strip()
    name = " — ".join([p for p in (artist, title) if p]) or "A record"
    # The canonical tagline stands as its own sentence, verbatim (BRAND.md).
    released = (album.get("released") or "")[:10]
    desc = (f"Released {released}. Find music, write notes." if released
            else "Find music, write notes.")
    cover = _abs_url(album.get("cover")) or _abs_url("/static/icons/icon-512.png")
    tags = [
        # Kept as `website`: music.album is the semantically tighter type but is
        # unevenly supported, and a wrong-typed card is worse than a plain one.
        '<meta property="og:type" content="website">',
        '<meta property="og:site_name" content="Music Forest">',
        f'<meta property="og:title" content="{e(name)}">',
        f'<meta property="og:description" content="{e(desc)}">',
        f'<meta property="og:url" content="{e(share_url)}">',
        f'<meta property="og:image" content="{e(cover)}">',
        f'<meta property="og:image:alt" content="{e("Cover of " + name)}">',
        # summary, not summary_large_image: album art is square, and the wide card
        # would crop it. The square thumbnail is the right frame for a record.
        '<meta name="twitter:card" content="summary">',
        f'<meta name="twitter:title" content="{e(name)}">',
        f'<meta name="twitter:description" content="{e(desc)}">',
        f'<meta name="twitter:image" content="{e(cover)}">',
    ]
    return "\n".join(tags)


def _shell_html():
    """static/index.html, cached in-process and re-read when it changes on disk (one
    stat per shell request, only on the ?album path)."""
    st = _SHELL_PATH.stat()
    stamp = (st.st_mtime_ns, st.st_size)
    if getattr(_shell_html, "_stamp", None) != stamp:
        _shell_html._text = _SHELL_PATH.read_text(encoding="utf-8")
        _shell_html._stamp = stamp
    return _shell_html._text


@bp.route("/")
def index():
    uid = _canon_uid(request.args.get("album"))
    if not uid:
        return send_from_directory("static", "index.html")
    try:
        album = _album_for_uid(uid)
        if not album:
            return send_from_directory("static", "index.html")
        share_url = _abs_url("/?album=" + quote(uid, safe=""))
        html_text, n = _OG_BLOCK_RE.subn(
            lambda _m: _record_og_tags(album, share_url), _shell_html(), count=1)
        if not n:                      # markers gone -> serve the file as written
            return send_from_directory("static", "index.html")
    except Exception:  # noqa: BLE001 - a preview is polish; never fail the app shell
        log.exception("share_preview_failed")
        return send_from_directory("static", "index.html")
    resp = current_app.response_class(html_text, mimetype="text/html")
    # Crawlers refetch per platform; let them (and any CDN) hold it briefly, but keep
    # it short so a re-crawl picks up corrected catalog data the same day.
    resp.headers["Cache-Control"] = "public, max-age=300"
    return resp


@bp.route("/admin")
def admin():
    """Operator-only feedback view (H1.4). It carries no privilege of its own —
    it's a static page that logs in via the same magic link and reads feedback
    through Supabase, where the app_admins allow-list (0002 migration) is what
    actually grants read-all. A non-operator who opens it just sees their own
    (usually none)."""
    return send_from_directory("static", "admin.html")


@bp.route("/architecture")
def architecture_guide():
    """The architecture guide (docs/architecture-guide.html) — a standalone,
    self-contained doc opened in a new tab from the "What is this?" welcome as a
    pull-only "how it works" door. Served straight from docs/ (single source, not
    duplicated into static/); the SW hands /architecture off to the network so its
    body is never cached under the shell key. CSP allows its inline styles and it
    ships no scripts, so it renders under the app's headers unchanged."""
    return send_from_directory("docs", "architecture-guide.html")


@bp.route("/privacy")
def privacy():
    """The Privacy Policy page (static/privacy.html) — a standalone, self-contained
    doc in the same visual family as /architecture. Gated behind
    config.LEGAL_PAGES_ENABLED (env AOTD_PUBLISH_LEGAL), OFF by default: the page
    is still an attorney-review DRAFT with unfilled placeholders, so it must not
    surface to real users until reviewed — it 404s until the flag is flipped. The
    SW hands /privacy off to the network (like /architecture) so its body is never
    cached under the shell key. See NEXT_SESSION_LEGAL.md §4."""
    if not config.LEGAL_PAGES_ENABLED:
        abort(404)
    return send_from_directory("static", "privacy.html")


@bp.route("/terms")
def terms():
    """The Terms of Service page (static/terms.html). Same gate + SW-bypass as
    /privacy: a DRAFT until legal review, so it 404s unless AOTD_PUBLISH_LEGAL is
    set. See NEXT_SESSION_LEGAL.md §4."""
    if not config.LEGAL_PAGES_ENABLED:
        abort(404)
    return send_from_directory("static", "terms.html")


@bp.route("/sw.js")
def service_worker():
    """Serve the PWA service worker from the origin root so its scope is the whole
    site ("/"), letting it handle top-level navigations rather than only /static/.
    The file itself lives in static/; this just re-exposes it at /sw.js with the
    right content type and an explicit Service-Worker-Allowed header."""
    resp = send_from_directory("static", "sw.js",
                               mimetype="application/javascript")
    resp.headers["Service-Worker-Allowed"] = "/"
    # The worker is tiny and versioned internally; don't let a stale copy pin an
    # old shell. The browser re-checks sw.js on navigation regardless.
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@bp.route("/version")
def version():
    """The deployed build version (mirrors ``static/sw.js`` VERSION). The PWA
    fetches this network-only to confirm a new deploy is *fully live on the host*
    before it lights the 'update ready' glow or reloads — so it never offers a
    reload into a still-rolling deploy (which 502s while Render swaps instances).
    Tiny, unauthenticated, no secrets; ``no-store`` so it's never read from a
    cache and always reflects the instance that actually answered."""
    resp = jsonify({"version": BUILD_VERSION})
    resp.headers["Cache-Control"] = "no-store"
    return resp


@bp.route("/api/public-config")
def api_public_config():
    """The handful of *public* Supabase values the no-build frontend needs to
    talk to Auth (BETA_PLAN.md §4). The anon key is public by design — it only
    permits the anon role, and every per-user row is still guarded by RLS and is
    opaque ciphertext besides. Nothing secret is exposed here: the JWT secret,
    the DB password and the service-role key all stay server-side.

    `configured` is false when the operator hasn't exported AOTD_SUPABASE_URL /
    AOTD_SUPABASE_ANON_KEY, which is exactly the single-user local mode where the
    client skips the login + unlock flow and the app behaves as it always has.
    """
    return jsonify({
        "configured": bool(config.SUPABASE_URL and config.SUPABASE_ANON_KEY),
        "supabase_url": config.SUPABASE_URL,
        "anon_key": config.SUPABASE_ANON_KEY,
    })


@bp.route("/api/config")
def api_config():
    """Client-facing feature flags, fetched once on boot (app.js init()). The only
    flag today is whether the unified P3 pool serving path is live
    (config.POOL_ENABLED, set by AOTD_USE_POOL): the frontend's data-access seam
    reads it to pick the /api/pool/* endpoints over the legacy /api/choice|day, so
    the P3 cutover ships DARK until the flag is set on the host. Distinct from
    /api/public-config (Supabase auth values); kept separate so client feature
    flags have one obvious home with room to grow. No secrets here."""
    return jsonify({"pool_enabled": bool(config.POOL_ENABLED)})


@bp.route("/api/today")
@_LIMIT_CATALOG
def api_today():
    t = config.today_local()          # the READER's day (ET), not the box's UTC one
    return jsonify({
        "date": t.isoformat(),
        "month": t.month, "day": t.day,
        "count": db.day_count(t.month, t.day),
        "albums": db.albums_for_day(t.month, t.day),
    })


@bp.route("/api/day")
@_LIMIT_CATALOG
def api_day():
    month, day = _parse_md(request.args.get("date"))
    return jsonify({
        "month": month, "day": day,
        "count": db.day_count(month, day),
        "albums": db.albums_for_day(month, day),
    })


@bp.route("/api/choice")
@_LIMIT_CATALOG
def api_choice():
    month, day = _parse_md(request.args.get("date"))
    return jsonify({
        "month": month, "day": day,
        "count": db.day_count(month, day),
        "albums": db.choice_for_day(month, day),
    })


# --- P3 unified pool (ADDITIVE, flag-gated by config.POOL_ENABLED) -----------
# These read the deduped both-arms pool (data/pool.sqlite) + its Deezer
# availability table — the daily pick draws from the AVAILABLE pool, dig mode is
# the full union. They are SEPARATE from /api/today|day|choice above, which are
# untouched: with the flag off these 404, so shipping this changes nothing in the
# live app until AOTD_USE_POOL is set. The frontend cutover is a later step.
# (The MM-DD / ?platforms= query parsing these routes share lives in reqparams.)
@bp.route("/api/pool/day")
@_LIMIT_CATALOG
def api_pool_day():
    """The unified pool for a calendar day. Default = the AVAILABLE pool
    (Deezer-listenable); ?dig=1 = the full union (both arms, no gate).
    ?date=MM-DD, else today. On-this-day anchor is the verified original_date."""
    if not config.POOL_ENABLED:
        return jsonify({"error": "pool serving disabled"}), 404
    month, day = _md_or_today()
    dig = request.args.get("dig") == "1"
    if not dig:
        opsdb.bump("today_served")     # anonymized Usage counter (count only, no user)
        _mode = request.headers.get("X-MF-Mode")   # coarse tier flag, not an identity
        if _mode in ("guest", "account"):
            opsdb.bump("today_" + _mode)
    platforms = _platforms_param(dig)
    albums = pooldb.pool_day(month, day, available_only=not dig,
                             platforms=platforms)
    return jsonify({"month": month, "day": day, "dig": dig,
                    "filtered": bool(platforms),
                    "count": len(albums), "albums": albums})


@bp.route("/api/pool/pick")
@_LIMIT_CATALOG
def api_pool_pick():
    """N random albums from the unified pool for the decide-for-me pick (default 2,
    capped 10). Default = the AVAILABLE pool (Deezer-listenable); ?dig=1 = the full
    union for the day (no availability gate). ?date=MM-DD, else today."""
    if not config.POOL_ENABLED:
        return jsonify({"error": "pool serving disabled"}), 404
    month, day = _md_or_today()
    dig = request.args.get("dig") == "1"
    try:
        n = min(max(int(request.args.get("n", 2)), 1), 10)
    except (TypeError, ValueError):
        n = 2
    platforms = _platforms_param(dig)
    albums = pooldb.pool_pick(month, day, n, available_only=not dig,
                              platforms=platforms)
    return jsonify({"month": month, "day": day, "dig": dig,
                    "filtered": bool(platforms),
                    "count": len(albums), "albums": albums})


@bp.route("/api/pool/door")
@_LIMIT_CATALOG
def api_pool_door():
    """The LAZY door for ONE opened album: ?uid=... -> its real cover + the exact
    per-platform streaming links (iTunes/Odesli), resolved on first open and cached
    in pool.sqlite. This is what fills an MB-only album's art + links. On-demand and
    per-album (iTunes self-throttles ~3.1s/call), never batched. Flag-gated."""
    if not config.POOL_ENABLED:
        return jsonify({"error": "pool serving disabled"}), 404
    uid = (request.args.get("uid") or "").strip()
    if not uid:
        return jsonify({"error": "uid required"}), 400
    opsdb.bump("door_open")            # anonymized Usage counter (count only, no user)
    return jsonify(pooldb.door_links(uid))


# --- uid identity helpers (P3 M2) -------------------------------------------
# Album identity is the source-agnostic uid (d:<release_id> for Discogs,
# m:<album_id> for MB-only). The helpers that bridge a request's string uid to
# the right data source (_canon_uid / _rid_from_uid / _album_for_uid) live in
# uidmap.py and are imported at the top of this module.
@bp.route("/api/search")
@_LIMIT_CATALOG
def api_search():
    """Full-text search across the whole catalog (all release dates). Pass
    ?q=terms; add ?date=MM-DD to restrict to a single calendar day; add
    ?field=artist|title|genres|styles|label to scope to a single FTS column."""
    q = (request.args.get("q") or "").strip()
    if not q:
        return jsonify({"q": q, "albums": [], "count": 0})
    opsdb.bump("explore_search")       # anonymized Usage counter (count only, no query)
    month = day = None
    if request.args.get("date"):
        month, day = _parse_md(request.args.get("date"))
    field = (request.args.get("field") or "").strip() or None
    if field not in (None, "artist", "title", "genres", "styles", "label"):
        field = None
    albums = db.search_albums(q, limit=_SEARCH_LIMIT, month=month, day=day,
                              field=field)
    # DQ3: anchor Discogs cards to the pool's on-this-day date (as pooldb._enrich
    # does for pool-served cards), so a card can't show a test-pressing/promo
    # pressing date the pool contradicts. Skip when day-scoped — that search filters
    # on albums.db's own month/day, so its dates must stay consistent with the scope.
    if month is None and day is None:
        albums = _overlay_pool_dates(albums)
    # B24: fold in the pool's MB-only arm, which albums_fts can't see (see
    # _merge_search_arms). MB rows already carry the pool's date, so they join
    # AFTER the overlay above.
    albums = _merge_search_arms(albums, q, month, day, field)
    return jsonify({"q": q, "month": month, "day": day,
                    "count": len(albums), "albums": albums})


# What one search returns, both arms together. Matches the client's own CAP in
# applyBrowseFilters, whose "first 500 matches — refine your terms" copy is only
# honest if the server doesn't quietly send a different number.
_SEARCH_LIMIT = 500


def _merge_search_arms(discogs, q, month, day, field):
    """B24 — union the Discogs arm (albums_fts, over albums.db) with the pool's
    MB-only arm (pool_fts), which nothing in search.db can index.

    Nearly half the pool a reader meets on Today is MB-only (46.3%, ~915 k rows),
    and searching one returned "No albums or songs match" for a record just served.
    Two indexes can't be ranked against each other — bm25 scores aren't comparable
    across files — so this INTERLEAVES them round-robin. That's not a ranking claim;
    it's the one merge the 500-cap can't use to hide an arm, which is the actual bug.
    (Display order is the client's anyway: applyBrowseFilters re-sorts by year.)

    Pool-gated and best-effort: no pool, no index, or any error leaves the Discogs
    results exactly as they are — search degrades to today's behaviour, never a 500."""
    if not config.POOL_ENABLED:
        return discogs
    try:
        mb = pooldb.search_albums(q, limit=_SEARCH_LIMIT, month=month, day=day,
                                  field=field)
    except Exception:  # noqa: BLE001 - the MB arm is additive; never fail the search
        return discogs
    if not mb:
        return discogs
    merged = []
    for i in range(max(len(discogs), len(mb))):
        if i < len(discogs):
            merged.append(discogs[i])
        if i < len(mb):
            merged.append(mb[i])
    try:
        merged = pooldb.dedup_search_arms(merged)
    except Exception:  # noqa: BLE001 - de-dup is polish; a duplicate beats a 500
        pass
    return merged[:_SEARCH_LIMIT]


def _overlay_pool_dates(albums):
    """Overlay the pool's on-this-day date onto catalog (Discogs) album dicts in
    place, for the ones that are in the pool (DQ3). Best-effort + pool-gated: no
    pool, or any error, leaves the catalog dates untouched."""
    if not config.POOL_ENABLED or not albums:
        return albums
    try:
        dates = pooldb.pool_dates_for(albums)
    except Exception:  # noqa: BLE001 - display polish only; never fail the search
        return albums
    for a in albums:
        d = dates.get(a.get("release_id"))
        if d:
            a.update(d)
    return albums


@bp.route("/api/person/search")
@_LIMIT_CATALOG
def api_person_search():
    """Search the credited people by name (v8 typed notes: tie a note to a
    person/producer). Returns {persons: [{person_id, name}]} — each result maps to
    a 'per:<person_id>' note target and the person door (/api/person?id=). Honest
    degrade: [] when persons_fts isn't built (the aux index is opt-in)."""
    q = (request.args.get("q") or "").strip()
    if not q:
        return jsonify({"q": q, "persons": []})
    try:
        limit = min(max(int(request.args.get("limit") or 8), 1), 25)
    except ValueError:
        limit = 8
    persons = db.search_persons(q, limit=limit)
    return jsonify({"q": q, "count": len(persons), "persons": persons})


@bp.route("/api/track/search")
@_LIMIT_CATALOG
def api_track_search():
    """Search track titles (v8 typed notes: tie a note to a song). Returns
    {tracks: [{title, album_uid, pos, album_artist, album_title}]} — each result
    maps to a 'trk:<album_uid>#<pos>' note target and its album story at that
    position. Honest degrade: [] when tracks_fts isn't built (the heavy aux index
    is opt-in — an un-built index is 'nothing on file,' never an error)."""
    q = (request.args.get("q") or "").strip()
    if not q:
        return jsonify({"q": q, "tracks": []})
    try:
        limit = min(max(int(request.args.get("limit") or 8), 1), 25)
    except ValueError:
        limit = 8
    tracks = db.search_tracks(q, limit=limit)
    return jsonify({"q": q, "count": len(tracks), "tracks": tracks})


@bp.route("/api/artist")
@_LIMIT_CATALOG
def api_artist():
    """An artist's catalog for the A2 artist panel: their albums newest-first,
    plus a Discogs artist-search link. Exact-match (db.albums_by_artist), like the
    label panel — so the panel is an honest home that shows only records actually
    by this artist, not every name that shares a word-start under the prefix FTS
    (the 'clicked B.J. Thomas, got a bunch of different artists' bug)."""
    name = (request.args.get("name") or "").strip()
    if not name:
        return jsonify({"name": "", "count": 0, "albums": []})
    albums = db.albums_by_artist(name, limit=500)
    # DQ3: anchor the Discogs half to the pool's on-this-day date before the fold +
    # newest-first sort, so a test-pressing/promo pressing date can't mis-date (or
    # mis-order) a card. The MB half below already carries pool dates.
    albums = _overlay_pool_dates(albums)
    # #16: fold the MB arm in — an MB-only artist you arrived from has no Discogs
    # catalogue, so albums.db returns nothing and the panel read "0 albums". Their
    # MB-only pool rows fill that gap; the merged list re-sorts newest-first and
    # caps like the Discogs half. Pool-gated + best-effort: without the pool the
    # Discogs door is unchanged. (Same-shape cards — browseCard renders both.)
    if config.POOL_ENABLED:
        try:
            mb_albums = pooldb.albums_by_artist(name, limit=500)
        except Exception:  # noqa: BLE001 - pool is optional; Discogs half stands
            mb_albums = []
        if mb_albums:
            albums = sorted(
                albums + mb_albums,
                key=lambda a: str(a.get("released") or a.get("year") or ""),
                reverse=True)[:500]
    discogs = ("https://www.discogs.com/search/?type=artist&q="
               + quote_plus(name))
    return jsonify({"name": name, "count": len(albums),
                    "albums": albums, "discogs_url": discogs})


@bp.route("/api/label")
@_LIMIT_CATALOG
def api_label():
    """A label's catalogue for the T2 label panel: its canonical albums
    newest-first, plus a Discogs label-search link. A bounded door like the
    artist panel; exact-match (db.albums_on_label) so the panel stays honest."""
    name = (request.args.get("name") or "").strip()
    if not name:
        return jsonify({"name": "", "count": 0, "albums": []})
    albums = db.albums_on_label(name, limit=500)
    discogs = ("https://www.discogs.com/search/?type=label&q="
               + quote_plus(name))
    return jsonify({"name": name, "count": len(albums),
                    "albums": albums, "discogs_url": discogs})


@bp.route("/api/person")
@_LIMIT_CATALOG
def api_person():
    """A person from the credits as a bounded door (F27): every album we have
    them credited on — deduped to master, newest-first, each quoting the role as
    credited THERE (never aggregated into what they 'are') — plus the honest
    total and a Discogs artist link out. `count` is the true number on file;
    `albums` the newest-500 survey (the hub-door rule: a mastering engineer's
    thousands of credits stay a window, never a corridor). The display name is
    derived from our own rows (the most frequent name-as-credited); ?name= is
    only the client's fallback for a person we hold no credits for."""
    raw = (request.args.get("id") or "").strip()
    if not raw.isdigit() or int(raw) <= 0:
        return jsonify({"error": "id (a Discogs artist id) required"}), 400
    pid = int(raw)
    albums, total = db.albums_by_credit(pid, limit=500)
    # F28: fold the MB arm in — MB-only albums this person is credited on via
    # the Wikidata crosswalk (person -> mbid -> mb_credits). Pool rows, shaped
    # lean like any dig-mode card; the merged list re-sorts newest-first and
    # the count stays the honest total across both arms. Pool-gated and
    # best-effort: without the pool the Discogs door is unchanged.
    mb_rows, mb_total = db.mb_albums_by_credit(pid)
    if mb_rows and config.POOL_ENABLED:
        try:
            mb_albums = pooldb.albums_by_uids([u for u, _ in mb_rows])
        except Exception:  # noqa: BLE001 - pool is optional; Discogs half stands
            mb_albums = []
        if mb_albums:
            roles = dict(mb_rows)
            for a in mb_albums:
                a["credit_roles"] = roles.get(a["uid"], "")
            albums = sorted(
                albums + mb_albums,
                key=lambda a: str(a.get("released") or a.get("year") or ""),
                reverse=True)[:500]
            total += mb_total
    name = db.person_name(pid) or (request.args.get("name") or "").strip() \
        or f"#{pid}"
    # F27-p2: outward doors via the Wikidata crosswalk (Wikipedia /
    # MusicBrainz / Wikidata), plus the merged-duplicate-id count — the door
    # spans them, and the client says so honestly ("across N Discogs
    # entries") because the merge is Wikidata's identity claim, not ours.
    links = db.person_links(pid) or {}
    merged = db.merged_person_ids(pid)
    return jsonify({"id": pid, "name": name, "count": total,
                    "shown": len(albums), "albums": albums,
                    "discogs_url": f"https://www.discogs.com/artist/{pid}",
                    "wikipedia_url": links.get("wikipedia_url"),
                    "musicbrainz_url": links.get("musicbrainz_url"),
                    "wikidata_url": links.get("wikidata_url"),
                    "merged_ids": len(merged)})


@bp.route("/api/browse")
@_LIMIT_CATALOG
def api_browse():
    """Queryless catalog browse for the A3 decade door: ?decade=1970s returns
    canonical albums from that decade, newest first (capped)."""
    decade = (request.args.get("decade") or "").strip()
    albums = db.albums_in_decade(decade) if decade else []
    return jsonify({"decade": decade or None,
                    "count": len(albums), "albums": albums})


@bp.route("/api/art/ensure", methods=["POST"])
@_LIMIT_ART
def api_art_ensure():
    """On-demand artwork: for the given release ids, return cached covers and
    fetch any that are missing. Capped per request so a page never blocks for
    long — the UI calls this in small batches for what's actually on screen."""
    data = request.get_json(silent=True) or {}
    ids = (data.get("release_ids") or [])[:8]
    out = {}
    for rid in ids:
        try:
            rid = int(rid)
        except (TypeError, ValueError):
            continue
        a = db.get_album(rid)
        if not a:
            continue
        if a["cover"]:                       # already cached
            out[str(rid)] = a["cover"]
            continue
        try:
            fetch_art.fetch_one(rid, a["artist"], a["title"])
            out[str(rid)] = db.get_album(rid)["cover"]  # may be None on a miss
        except Exception:                    # noqa: BLE001 - never fail the batch
            out[str(rid)] = None
    return jsonify(out)


@bp.route("/api/art/search")
@_LIMIT_ART
def api_art_search():
    """Find alternate cover candidates for the fix-art picker."""
    term = (request.args.get("term") or "").strip()
    if not term:
        return jsonify({"candidates": []})
    try:
        cands = fetch_art.search_candidates(term, limit=8)
        return jsonify({"candidates": cands})
    except Exception as e:  # noqa: BLE001 - surface a friendly error to the UI
        return jsonify({"error": str(e), "candidates": []}), 502


@bp.route("/api/art/set", methods=["POST"])
@_LIMIT_ART
def api_art_set():
    """Apply a chosen or pasted cover URL to a release."""
    data = request.get_json(silent=True) or {}
    rid = data.get("release_id")
    art_url = (data.get("artwork_url") or "").strip()
    if not rid or not art_url:
        return jsonify({"error": "release_id and artwork_url required"}), 400
    try:
        local = fetch_art.set_manual_art(
            int(rid), art_url, data.get("apple_music_url"))
        cover = ("/" + local.lstrip("/")) if local else art_url
        return jsonify({"ok": True, "cover": cover})
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": str(e)}), 502


# --- Journal (F2): notes, stored separately from albums.db ------------------
@bp.route("/api/journal/note", methods=["POST"])
def api_journal_note():
    data = request.get_json(silent=True) or {}
    # Identity is the uid; accept it directly, or fold a legacy `release_id` body
    # (the not-yet-uid-aware client) onto 'd:<id>'.
    uid = _canon_uid(data.get("uid") if data.get("uid") is not None
                     else data.get("release_id")) or None
    body = (data.get("body") or "").strip()
    # N3b: a note is record-optional — a free noticing has no uid/album, and body
    # is the only requirement. v8: a uid may instead name a typed entity (artist /
    # person / track) that has no albums.db row — those carry a client-provided
    # `ref` snapshot instead. Only hydrate an album snapshot for an actual album
    # uid ('d:'/'m:'); a typed uid keeps its ref and gets no album lookup.
    kind = journal.kind_from_uid(uid)
    album = _album_for_uid(uid) if kind == "album" else None
    ref = data.get("ref") if kind in ("artist", "person", "track") else None
    if not body:
        return jsonify({"error": "non-empty body required"}), 400
    nid = journal.add_note(uid, album, body,
                           track=(data.get("track") or "").strip() or None,
                           timestamp=(data.get("timestamp") or "").strip() or None,
                           ref=ref)
    return jsonify({"ok": True, "id": nid})


@bp.route("/api/journal/note/<int:note_id>", methods=["PATCH"])
def api_journal_note_update(note_id):
    """Edit a note's body/track/timestamp in place (D4). Only provided fields
    change."""
    data = request.get_json(silent=True) or {}
    kw = {}
    if "body" in data:
        kw["body"] = data.get("body") or ""
    if "track" in data:
        kw["track"] = data.get("track") or ""
    if "timestamp" in data:
        kw["timestamp"] = data.get("timestamp") or ""
    try:
        ok = journal.update_note(note_id, **kw)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": bool(ok)})


@bp.route("/api/journal/note/<int:note_id>", methods=["DELETE"])
def api_journal_note_delete(note_id):
    """Soft-delete a note (D3). Recoverable via the restore route below."""
    ok = journal.delete_note(note_id)
    return jsonify({"ok": True, "deleted": bool(ok)})


@bp.route("/api/journal/note/<int:note_id>/restore", methods=["POST"])
def api_journal_note_restore(note_id):
    """Undo a soft-delete (D3) — powers the 'Note deleted · Undo' toast."""
    ok = journal.restore_note(note_id)
    return jsonify({"ok": bool(ok)})


def _tracks_for_uid(uid):
    """One uid's tracklist: a 'd:' uid -> its Discogs release in albums.db; an MB-only
    ('m:') uid -> MB's tracklist via the pool's mb_release_ids (or a Discogs one borrowed
    via the crosswalk). Same {pos,title,dur} shape; [] when neither source has it."""
    rid = _rid_from_uid(uid)
    if rid is not None:
        return db.tracks_for(rid)
    if uid and config.POOL_ENABLED:
        try:
            mbids = pooldb.mb_release_ids_for(uid)
        except Exception:  # noqa: BLE001 - pool is optional; no tracks, no error
            mbids = []
        if mbids:
            return db.mb_tracks_for(mbids)
    return []


@bp.route("/api/album/<uid>/tracks")
@_LIMIT_CATALOG
def api_album_tracks(uid):
    """Tracklist for an opened album (by uid). [] gracefully when no source has it
    (unknown, never a lie). Phase 2 serve-flip: when the album is a de-duped cross-source
    cluster, serve the MOST-COMPLETE tracklist across the cluster's members (design §4) so
    the merged card never drops a bonus track — the fuller edition's tracklist wins."""
    cuid = _canon_uid(uid)
    tracks = _tracks_for_uid(cuid)
    if getattr(config, "CLUSTER_DEDUP_ENABLED", False):
        try:
            for sib in catalogdb.cluster_sibling_uids(cuid):
                if sib == cuid:
                    continue
                t = _tracks_for_uid(sib)
                if len(t) > len(tracks):
                    tracks = t
        except Exception:  # noqa: BLE001 - never let a catalog read break tracks serving
            pass
    return jsonify({"tracks": tracks})


@bp.route("/api/album/<uid>/pressings")
@_LIMIT_CATALOG
def api_album_pressings(uid):
    """The "other releases of this album" door (F27-1b): every full-dated
    pressing sharing this album's master, in lineage order — each with its own
    room size, and the label column doubling as the licensing/territory
    lineage (A7). `count` includes the open pressing itself (flagged
    `current`); the client hides the door when there's nothing beyond it.
    Standalone releases and MB-only uids return [] gracefully; bounded by what
    we ingested, never a completeness claim."""
    rid = _rid_from_uid(_canon_uid(uid))
    rows = db.pressings_for(rid) if rid is not None else []
    return jsonify({"count": len(rows), "pressings": rows})


@bp.route("/api/album/<uid>/credits")
@_LIMIT_CATALOG
def api_album_credits(uid):
    """The room (F27/F28): release-level personnel for an opened album. A 'd:'
    uid resolves to its release and quotes each role exactly as the sleeve
    credited it; an 'm:' uid (F28) resolves through the pool's mb_release_ids
    to the MB relations ingest — typed vocabulary, not sleeve quotes, which is
    why `source` rides along ('discogs' | 'musicbrainz') so the UI can label
    the room honestly. A catalog predating either ingest returns [] gracefully
    and the UI shows no room (unknown, never 'nobody'). A credit with a
    person_id is a door; one without is plain text."""
    cuid = _canon_uid(uid)
    rid = _rid_from_uid(cuid)
    if rid is not None:
        return jsonify({"credits": db.credits_for(rid), "source": "discogs"})
    credits = []
    if cuid and config.POOL_ENABLED:
        try:
            mbids = pooldb.mb_release_ids_for(cuid)
        except Exception:  # noqa: BLE001 - pool is optional; no room, no error
            mbids = []
        if mbids:
            credits = db.mb_credits_for(mbids)
    return jsonify({"credits": credits, "source": "musicbrainz"})


@bp.route("/api/albums")
@_LIMIT_CATALOG
def api_albums_batch():
    """Batch album lookup: ?ids=<tokens> -> {albums:{token:album}}. Each token is a
    uid ('d:<id>' / 'm:mb:<rgid>') or a bare release_id (folded to 'd:<id>'), and
    resolves through the **pool + door** first (so the album carries its confirmed
    platforms — Deezer from availability + the exact Apple link — exactly like a
    browse card), then falls back to the albums.db catalog row. This is what lets a
    journal choice surface its Listen door; resolving via the
    catalog-only path here was why choices showed no Listen (no Deezer). Keyed by
    the EXACT token the client sent, so both `chosen_id` and `chosen_uid` callers
    map back. Public catalog data only (no journal). (BETA_PLAN.md §1, §4)"""
    raw = (request.args.get("ids") or "").strip()
    out = {}
    if raw:
        seen = 0
        for part in raw.split(","):
            part = part.strip()
            if not part:
                continue
            seen += 1
            if seen > 500:
                break
            cuid = _canon_uid(part)
            a = _album_for_uid(cuid) if cuid else None
            if a:
                out[part] = a
    return jsonify({"albums": out})


@bp.route("/api/journal/album/<uid>")
def api_journal_album(uid):
    return jsonify(journal.for_album(_canon_uid(uid)))


@bp.route("/api/journal/artist")
def api_journal_artist():
    """The retrieval echo (N1 §4.4): your notes on records by ?name=<artist>,
    exact-match only. Pull-only — surfaced inside the artist door you opened."""
    return jsonify(journal.notes_for_artist(request.args.get("name") or ""))


@bp.route("/api/journal/person")
def api_journal_person():
    """The person-door retrieval echo (N1 §4.4, 3a): your notes that mention a
    credited person by ?name=, each tagged match_kind full/partial. Pull-only,
    fuzzy but catalog-anchored — the client keeps a 'partial' hit only when the
    note's album credits this person (§4.4), so a private name never surfaces."""
    return jsonify(journal.notes_for_person(request.args.get("name") or ""))


@bp.route("/api/journal/note/<int:note_id>/threads")
def api_journal_note_threads(note_id):
    """The in-note word pull (N1 §4.4, 3b): the terms in this note that recur across
    your other notes, busiest first. Pull-only, on-demand — never a standing map."""
    return jsonify(journal.note_threads(note_id))


@bp.route("/api/journal/term")
def api_journal_term():
    """The 3b pull result: your notes that use ?q=<term>, verbatim, newest first.
    An exact term match (via the note tokeniser), surfaced only on your pull."""
    return jsonify(journal.notes_with_term(request.args.get("q") or ""))


@bp.route("/api/album/<uid>/marks")
def api_album_marks(uid):
    """Your manual platform-availability marks for one album (F16), by uid. Pull-
    only: returned when the album's detail view asks, never surfaced unbidden."""
    return jsonify({"marks": journal.get_marks(_canon_uid(uid))})


@bp.route("/api/album/<uid>/marks", methods=["POST"])
def api_album_set_mark(uid):
    """Set/clear one album+service mark (F16), by uid. Body: {service, state}; a
    state of 'unknown' (or empty) clears it. User-entered only — no auto-detection.
    The album snapshot (artist/title + release_id provenance) is resolved through
    the pool/door then albums.db, so an MB-only album can be marked too."""
    cuid = _canon_uid(uid)
    data = request.get_json(silent=True) or {}
    album = _album_for_uid(cuid) or {}
    try:
        marks = journal.set_mark(
            cuid, album, data.get("service"), data.get("state"))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True, "marks": marks})


@bp.route("/api/artist/bio")
@_LIMIT_ART
def api_artist_bio():
    """Optional artist bio (A4) — an outward story thread, pull-only: returned
    only when the user opens the bio door in an album's story view, never auto-
    surfaced. Cached (hits and misses) so the network is asked at most once per
    artist. A bio is a nicety, so this never 500s the UI — a miss/error just
    means no bio shows."""
    name = (request.args.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name required"}), 400
    try:
        return jsonify(bio.for_artist(name))
    except Exception as e:  # noqa: BLE001 - a bio must never break the page
        return jsonify({"artist": name, "status": "error", "error": str(e)})


@bp.route("/api/feedback", methods=["POST"])
@_LIMIT_FEEDBACK
def api_feedback():
    """Capture in-app feedback: a note plus the client's snapshot of the current
    app state, the browser environment, and an optional best-effort screenshot.
    Stored locally (see feedback.py) for later triage into the backlog."""
    data = request.get_json(silent=True) or {}
    try:
        result = feedback.save(
            message=data.get("message"),
            app_state=data.get("app_state"),
            env=data.get("env"),
            screenshot=data.get("screenshot"),
            view_html=data.get("view_html"),
        )
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True, **result})


# A deliberately permissive sanity check — not full RFC 5322. We only want to
# reject obvious junk before storing; the real proof an address works is whether
# the invite the operator sends later actually arrives.
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_MAX_EMAIL = 254
_MAX_ACCESS_NOTE = 1000


@bp.route("/api/access-request", methods=["POST"])
@_LIMIT_ACCESS
def api_access_request():
    """A logged-out guest without an invite asks for one — a door, not a wall
    (onboarding Phase D, locked decision 8). Body: {email, note?}. The request is
    stored server-side via the trusted store path (Postgres in hosted mode, the
    operator reviews + invites by hand); the anon Supabase key never gets an open
    write policy, and the route is rate-limited (config.RATE_LIMIT_ACCESS).

    The response is intentionally uniform — it never reveals whether an email is
    already invited or already requested — so this can't be used to enumerate
    accounts."""
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    if not email or len(email) > _MAX_EMAIL or not _EMAIL_RE.match(email):
        return jsonify({"error": "a valid email address is required"}), 400
    note = (data.get("note") or "").strip()[:_MAX_ACCESS_NOTE] or None
    ua = (request.headers.get("User-Agent") or "").strip()[:500] or None
    try:
        store.get_store().add_access_request(email, note, ua)
    except store.StoreError as e:
        log.warning("access_request_store_failed", extra={
            "event": "access_request_failed", "status": e.status})
        return jsonify({"error": "could not record the request; please try later"}), e.status
    return jsonify({"ok": True})


@bp.route("/api/subjects")
def api_subjects():
    """The subjects emerging from your notes, for the user-opened view (pull).
    Returns the recurring terms plus the note count + threshold so the UI can
    show progress toward emergence when there isn't enough text yet."""
    min_notes = 2
    return jsonify({
        "subjects": journal.subjects(min_notes=min_notes),
        "notes": journal.counts()["notes"],
        "min_notes": min_notes,
    })


@bp.route("/api/connections")
def api_connections():
    """The emergent subjects as a place to wander (C1): clearings (subjects) with
    the notes they came from and trails to subjects they co-occur with. Pull-only
    — returned only when the user opens the Connections view, never pushed."""
    return jsonify(journal.subject_graph(min_notes=2))


@bp.route("/api/journal/export")
def api_journal_export():
    """Download the whole journal as a portable JSON file (D2)."""
    payload = journal.export_data()
    resp = jsonify(payload)
    # The reader's day: a 9pm-ET export shouldn't land in their downloads stamped
    # tomorrow. Cosmetic, but it's their file with their date on it.
    stamp = config.today_local().isoformat()
    resp.headers["Content-Disposition"] = (
        f'attachment; filename="aotd-journal-{stamp}.json"')
    return resp


# --- Choices (G5): recorded choices + opt-in reasons -------------------------
@bp.route("/api/choices", methods=["POST"])
def api_choices_add():
    """Record a choice. Body: {chosen_uid|chosen_id, not_chosen_uid?|not_chosen_id?,
    day?, reasons?, note?}. Identity is the uid (a bare chosen_id folds onto
    'd:<id>'); the chosen / not-chosen albums are resolved through the pool/door
    then albums.db so an MB-only daily-draw album can be recorded too. The choice
    is always saved; reasons/note are optional."""
    data = request.get_json(silent=True) or {}
    ch_uid = _canon_uid(
        data.get("chosen_uid") if data.get("chosen_uid") is not None
        else data.get("chosen_id"))
    if not ch_uid:
        return jsonify({"error": "chosen_uid (or chosen_id) required"}), 400
    chosen = _album_for_uid(ch_uid)
    if not chosen:
        return jsonify({"error": "unknown chosen album"}), 404
    nc_uid = _canon_uid(
        data.get("not_chosen_uid") if data.get("not_chosen_uid") is not None
        else data.get("not_chosen_id"))
    not_chosen = _album_for_uid(nc_uid) if nc_uid else None
    cid = journal.add_choice(
        chosen, not_chosen,
        day_context=(data.get("day") or "").strip() or None,
        reasons=_clean_reasons(data.get("reasons")),
        note=(data.get("note") or "").strip() or None)
    return jsonify({"ok": True, "id": cid})


@bp.route("/api/choices/<int:choice_id>", methods=["PATCH"])
def api_choices_update(choice_id):
    """Update a choice: swap which record was chosen (changed your mind) and/or set
    the reason tags + note. chosen / not_chosen accept a uid (or a legacy id)."""
    data = request.get_json(silent=True) or {}
    kw = {}
    ch_uid = _canon_uid(
        data.get("chosen_uid") if data.get("chosen_uid") is not None
        else data.get("chosen_id"))
    if ch_uid is not None:
        ch = _album_for_uid(ch_uid)
        if not ch:
            return jsonify({"error": "unknown chosen album"}), 404
        kw["chosen"] = ch
    nc_uid = _canon_uid(
        data.get("not_chosen_uid") if data.get("not_chosen_uid") is not None
        else data.get("not_chosen_id"))
    if nc_uid is not None:
        kw["not_chosen"] = _album_for_uid(nc_uid)
    if "reasons" in data:
        kw["reasons"] = _clean_reasons(data.get("reasons"))
    if "note" in data:
        kw["note"] = data.get("note") or ""
    ok = journal.update_choice(choice_id, **kw)
    return jsonify({"ok": bool(ok)})


@bp.route("/api/choices/<int:choice_id>", methods=["DELETE"])
def api_choices_delete(choice_id):
    journal.delete_choice(choice_id)
    return jsonify({"ok": True})


@bp.route("/api/choices")
def api_choices_feed():
    """Choice history (enriched with the current album) + the patterns stats.

    U8: each choice carries its full album dict (cover, streaming/Discogs links,
    country, genres) so the frontend can render it with the same layout as a
    browse-all card — the same threads to pull on the same album. `cover` is kept
    as a top-level field for backward compatibility.
    """
    choices = journal.choices_feed()
    for p in choices:
        # Resolve through the uid (pool/door then albums.db) so an MB-only choice
        # enriches too; fall back to the legacy chosen_id for older rows.
        uid = p.get("chosen_uid") or (
            ("d:" + str(p["chosen_id"])) if p.get("chosen_id") is not None else None)
        album = _album_for_uid(uid) or {}
        p["album"] = album or None
        p["cover"] = album.get("cover")
    return jsonify({"choices": choices, "stats": journal.choices_stats()})


def _clean_reasons(reasons):
    """Normalize an incoming reasons value to a de-duped list of short strings."""
    if not isinstance(reasons, list):
        return []
    out, seen = [], set()
    for r in reasons:
        if not isinstance(r, str):
            continue
        r = r.strip()[:40]
        if r and r not in seen:
            seen.add(r)
            out.append(r)
    return out[:12]


# --- Saved Trails (T1): a named, re-walkable wander -------------------------
@bp.route("/api/trails")
def api_trails_feed():
    """All saved trails, newest first. Pull-only: nothing is surfaced; the
    Connections tab lists them when you go looking."""
    return jsonify({"trails": journal.trails_feed()})


@bp.route("/api/trails", methods=["POST"])
def api_trails_add():
    """Save a wander as a Trail. Body: {name, nodes:[{parent,label,nav}, …]}."""
    data = request.get_json(silent=True) or {}
    try:
        tid = journal.add_trail(data.get("name"),
                                _clean_trail_nodes(data.get("nodes")))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True, "id": tid})


@bp.route("/api/trails/<int:trail_id>", methods=["PATCH"])
def api_trails_rename(trail_id):
    data = request.get_json(silent=True) or {}
    try:
        ok = journal.rename_trail(trail_id, data.get("name"))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": bool(ok)})


@bp.route("/api/trails/<int:trail_id>", methods=["DELETE"])
def api_trails_delete(trail_id):
    journal.delete_trail(trail_id)
    return jsonify({"ok": True})


def _clean_trail_nodes(nodes):
    """Validate/trim an incoming wander tree to the small shape we persist:
    a list of {parent:int, label:str, nav:{...}|None}. Anything malformed is
    dropped rather than trusted."""
    if not isinstance(nodes, list):
        return []
    out = []
    for n in nodes:
        if not isinstance(n, dict):
            continue
        try:
            parent = int(n.get("parent", -1))
        except (TypeError, ValueError):
            parent = -1
        label = str(n.get("label") or "")[:120]
        nav = n.get("nav")
        nav = nav if isinstance(nav, dict) else None
        out.append({"parent": parent, "label": label, "nav": nav})
    return out[:200]


@bp.route("/api/journal/import", methods=["POST"])
def api_journal_import():
    """Import a journal export (D2). Body is the exported JSON; optional
    ?mode=merge|replace (default merge)."""
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "expected a JSON journal export body"}), 400
    mode = "replace" if request.args.get("mode") == "replace" else "merge"
    try:
        result = journal.import_data(data, mode=mode)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True, **result})


@bp.route("/api/journal")
def api_journal_feed():
    """Journal data for the redesigned view: notes grouped into a per-album
    'shelf' (enriched with cover + genres from the album cache) plus a summary —
    counts + the genres you write about, a neutral mirror with no gamification."""
    q = request.args.get("q") or None
    notes = journal.feed(q)["notes"]

    shelf = {}          # uid -> album group with its notes
    genre_albums = {}   # genre -> set of uids (count by album, not note)
    for n in notes:
        # Group by the source-agnostic uid so MB-only notes don't collapse onto a
        # shared NULL release_id; resolve the album through the pool/door then
        # albums.db. release_id stays in the payload as provenance for the client.
        uid = n.get("uid") or _canon_uid(n.get("release_id"))
        g = shelf.get(uid)
        if g is None:
            album = _album_for_uid(uid) or {}
            g = shelf[uid] = {
                "uid": uid,
                "release_id": n.get("release_id")
                if n.get("release_id") is not None else album.get("release_id"),
                "artist": n.get("artist") or album.get("artist"),
                "title": n.get("title") or album.get("title"),
                "released": n.get("released") or album.get("released"),
                "discogs_url": n.get("discogs_url") or album.get("discogs_url"),
                "cover": album.get("cover"),       # may be None -> lazy-loaded
                "genres": album.get("genres"),
                # v8: a typed note (artist/person/track uid) carries its own
                # snapshot; surface it so the Notebook can render + link it.
                "ref": n.get("ref"),
                "notes": [],
                "last_at": n.get("created_at"),
            }
            for genre in _split_genres(album.get("genres")):
                genre_albums.setdefault(genre, set()).add(uid)
        g["notes"].append({
            "id": n["id"], "body": n["body"], "track": n.get("track"),
            "timestamp": n.get("timestamp"), "created_at": n.get("created_at"),
            "updated_at": n.get("updated_at"),
        })
        if (n.get("created_at") or "") > (g["last_at"] or ""):
            g["last_at"] = n["created_at"]

    albums = sorted(shelf.values(), key=lambda a: a["last_at"] or "",
                    reverse=True)
    for a in albums:
        a["note_count"] = len(a["notes"])

    top_genres = sorted(
        ({"genre": k, "count": len(v)} for k, v in genre_albums.items()),
        key=lambda x: (-x["count"], x["genre"]))[:8]

    counts = journal.counts()
    return jsonify({
        "summary": {
            **counts,
            "top_genres": top_genres,
        },
        "albums": albums,
    })


# ===========================================================================
# Hosted sync layer (H1.1): authenticated store/fetch of end-to-end-encrypted
# rows, scoped by the JWT-derived user UUID.
#
# This is the new spine of the beta (BETA_PLAN.md §4). The server only ever sees
# ciphertext: it stores and returns opaque (ciphertext, nonce) blobs and each
# user's wrapped keys, and does no reading of the contents. The analytics that
# used to run over these rows (subjects/connections/search) move to the
# browser over the decrypted-in-memory journal in H1.2; the existing local
# journal routes above stay in place until that client cutover, so the current
# local app and its tests keep working unchanged.
# ===========================================================================

@bp.errorhandler(auth.AuthError)
def _on_auth_error(e):
    # A failed/absent token is a client problem (WARNING, not ERROR). The message
    # is our own (e.g. "missing bearer token") — never the token itself.
    log.warning("auth_error", extra={
        "event": "auth_error", "request_id": getattr(g, "request_id", None),
        "path": request.path, "status": e.status, "error": e.message})
    return jsonify({"error": e.message}), e.status


@bp.errorhandler(store.StoreError)
def _on_store_error(e):
    # 5xx store failures (e.g. Postgres unreachable) are real incidents -> ERROR;
    # 4xx (bad client input normalized to StoreError) stay WARNING.
    level = logging.ERROR if e.status >= 500 else logging.WARNING
    log.log(level, "store_error", extra={
        "event": "store_error", "request_id": getattr(g, "request_id", None),
        "path": request.path, "status": e.status, "error": e.message})
    return jsonify({"error": e.message}), e.status


@bp.app_errorhandler(Exception)
def _on_unexpected_error(e):
    """Catch-all 500: log the full traceback SERVER-SIDE ONLY and return a
    generic JSON error (no stack, no internals to the client). HTTP exceptions
    (404, 405, 429, …) carry their own intended status and are passed through
    untouched so this never turns a 404 into a 500."""
    if isinstance(e, HTTPException):
        return e
    log.error("unhandled_exception", extra={
        "event": "unhandled_exception",
        "request_id": getattr(g, "request_id", None),
        "method": request.method, "path": request.path,
        "error": type(e).__name__,
    }, exc_info=e)
    return jsonify({"error": "internal server error"}), 500


def _on_rate_limited(e):
    """429 handler: keep the app's existing JSON error shape (Flask-Limiter would
    otherwise return its own plain page). Registered in create_app only when the
    limiter library is present. Security headers still attach because this returns
    a normal response that the after_request chain then decorates."""
    log.warning("rate_limited", extra={
        "event": "rate_limited", "request_id": getattr(g, "request_id", None),
        "path": request.path, "status": 429,
        "error": getattr(e, "description", "rate limit exceeded")})
    return jsonify({"error": "rate limit exceeded"}), 429


@bp.route("/healthz")
def healthz():
    """Liveness of each critical dependency; 503 if any is down. Since 2026-07-02
    this IS Render's healthCheckPath (render.yaml): the deploy swap waits until
    catalog + store actually answer, instead of `/` passing the moment gunicorn
    serves static files. Bootstrap caveat lives in render.yaml: a FRESH service
    (unseeded disk) must temporarily health-check `/` until the catalog is rsync'd.
    Never rate-limited (the limiter has no default limits), so the checker can't
    be throttled into a false unhealthy.

    `catalog` = a SELECT 1 against albums.db; `store` = the sync store's ping()
    (for Postgres this also proves the Supabase DB connection). No secrets in the
    payload — only booleans, the backend name, and the app version."""
    checks = {}
    healthy = True

    try:
        db.day_count(1, 1)            # cheap indexed query against albums.db
        checks["catalog"] = True
    except Exception:                 # noqa: BLE001 - report down, don't 500
        checks["catalog"] = False
        healthy = False

    try:
        store.get_store().ping()
        checks["store"] = True
    except Exception:                 # noqa: BLE001
        checks["store"] = False
        healthy = False

    payload = {
        "status": "ok" if healthy else "degraded",
        "checks": checks,
        "auth_enforced": auth.auth_enforced(),
        "backend": "postgres" if config.SUPABASE_DB_URL else "sqlite",
        "version": APP_VERSION,
    }
    return jsonify(payload), (200 if healthy else 503)


def _require_user():
    """Resolve the caller's user UUID (cached on `g` for the request). Raises
    auth.AuthError -> 401 when a token is required but missing/invalid."""
    if getattr(g, "user_id", None) is None:
        g.user_id = auth.user_id_from_headers(request.headers)
    return g.user_id


def _b64e(raw):
    return base64.b64encode(raw or b"").decode("ascii")


def _b64d(value, field):
    """Decode a base64 string from the request body to bytes, or 400."""
    if not isinstance(value, str):
        raise store.StoreError(f"{field} must be a base64 string", status=400)
    try:
        return base64.b64decode(value, validate=True)
    except (ValueError, base64.binascii.Error):
        raise store.StoreError(f"{field} is not valid base64", status=400)


def _row_out(row):
    """Shape a stored row for JSON: bytes -> base64 strings."""
    return {
        "kind": row["kind"], "client_id": row["client_id"],
        "ciphertext": _b64e(row["ciphertext"]),
        "nonce": _b64e(row["nonce"]),
        "updated_at": row["updated_at"], "deleted": row["deleted"],
    }


@bp.route("/api/sync/status")
@_LIMIT_SYNC
def api_sync_status():
    """Whoami + mode probe. Confirms a token resolves to a user UUID and reports
    whether auth/Postgres are enforced. Handy for wiring up the client and for a
    deploy smoke-test."""
    uid = _require_user()
    return jsonify({
        "user_id": uid,
        "auth_enforced": auth.auth_enforced(),
        "backend": "postgres" if config.SUPABASE_DB_URL else "sqlite",
    })


def _require_operator():
    """Authenticate the caller and require they be an operator. The /admin *page*
    is gated by Supabase RLS, but a Flask endpoint reading pool.sqlite isn't, so we
    check config.OPERATOR_IDS here. Empty list (local/dev, auth not enforced) -> any
    authenticated caller passes (the only one is you). Raises AuthError(403)."""
    uid = _require_user()
    if config.OPERATOR_IDS and uid not in config.OPERATOR_IDS:
        raise auth.AuthError("operator only", status=403)
    return uid


# Staleness budgets. A *finished* day ('done') is fine for a while — the next day
# takes hours to resolve — so only flag it after this long. A 'running' heartbeat
# should refresh every ~minute (the crawler pushes every N albums), so a much
# shorter gap means the process died mid-day. (A throttle cooldown reports
# 'throttled' explicitly, independent of age.)
_CRAWL_STALE_SECONDS = 36 * 3600
_CRAWL_RUNNING_STALE_SECONDS = 10 * 60


def _crawl_age_seconds(hb):
    """Age of a heartbeat from its updated_at (UTC 'Z' stamp), or None if absent /
    unparseable."""
    try:
        ts = datetime.strptime(hb["updated_at"], "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - ts).total_seconds()
    except (ValueError, TypeError, KeyError):
        return None


def _crawl_verdict(hb, age):
    """Derive the badge verdict from a heartbeat + its age (see the GET docstring
    for the vocabulary)."""
    state = (hb.get("state") or "").lower()
    if hb.get("aborted") or state == "throttled":
        return "throttled"
    if state == "running":
        if age is not None and age > _CRAWL_RUNNING_STALE_SECONDS:
            return "stale"   # claims to be running but went quiet -> probably died
        return "running"
    # 'done' or an older heartbeat with no state.
    if age is not None and age > _CRAWL_STALE_SECONDS:
        return "stale"
    return "ok"


def _read_pushed_status():
    """The most recent PUSHED heartbeat (config.CRAWL_STATUS_FILE), or None. This is
    the near-real-time channel on the host; it's preferred over the pool.sqlite row,
    which only refreshes with the slow per-day DB rsync."""
    try:
        with open(config.CRAWL_STATUS_FILE, encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(d, dict):
        return None
    d["aborted"] = bool(d.get("aborted"))
    d.setdefault("state", None)
    d.setdefault("total", None)
    return d


def _write_pushed_status(data):
    """Persist a pushed heartbeat atomically (temp + os.replace) so a concurrent
    read never sees a half-written file."""
    path = config.CRAWL_STATUS_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    os.replace(tmp, path)


@bp.route("/api/admin/crawl-status")
def api_admin_crawl_status():
    """Operator-only crawler health for the console: the freshest door heartbeat
    (pushed file preferred, else the pool.sqlite row) + a derived `health` verdict:
      - 'never'     — no heartbeat yet (crawler hasn't run / nothing pushed)
      - 'running'   — a day is in progress (heartbeat carries seen/total/counts)
      - 'throttled' — hit the circuit breaker (upstream rate-limited us)
      - 'stale'     — heartbeat older than its budget (likely wedged / asleep)
      - 'ok'        — last day finished cleanly
    `age_seconds` lets the UI render "N min ago"; `heartbeat` carries the counts."""
    _require_operator()
    try:
        hb = _read_pushed_status() or pooldb.read_crawl_status("door")
    except Exception as e:  # noqa: BLE001 - never let a pool read kill the worker
        log.warning("crawl_status_read_failed", extra={
            "event": "crawl_status_read_failed",
            "request_id": getattr(g, "request_id", None), "error": str(e)})
        return jsonify({"health": "error", "detail": str(e), "heartbeat": None})
    if not hb:
        return jsonify({"health": "never", "heartbeat": None})
    age = _crawl_age_seconds(hb)
    return jsonify({"health": _crawl_verdict(hb, age), "age_seconds": age,
                    "heartbeat": hb})


@bp.route("/api/admin/crawl-status", methods=["PUT", "POST"])
def api_admin_crawl_status_push():
    """Receive a pushed heartbeat from the local crawler (near-real-time health,
    decoupled from the per-day pool.sqlite rsync). Gated by the shared secret
    config.CRAWL_PUSH_TOKEN (sent as X-Crawl-Token) — NOT the operator JWT, since
    the crawler is a script, not a logged-in user. Empty token -> receiver off."""
    token = config.CRAWL_PUSH_TOKEN
    if not token:
        raise auth.AuthError("crawl push disabled", status=403)
    provided = request.headers.get("X-Crawl-Token", "")
    if not hmac.compare_digest(provided, token):
        raise auth.AuthError("bad crawl token", status=403)
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "JSON object required"}), 400
    data.setdefault("id", "door")
    data.setdefault("updated_at",
                    datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
    try:
        _write_pushed_status(data)
    except OSError as e:
        log.warning("crawl_status_write_failed", extra={
            "event": "crawl_status_write_failed",
            "request_id": getattr(g, "request_id", None), "error": str(e)})
        return jsonify({"error": "could not persist status"}), 500
    return jsonify({"ok": True})


# --- H4: the /admin "where should my attention be" panel ---------------------
# One read for the operator's whole triage glance. The availability runway is
# the only expensive piece — a whole-pool aggregate that takes ~4 s on a local
# SSD and well over a minute on Render's network-backed disk — so it must NEVER
# run on the request thread (the first live load of /admin sat on "Loading…"
# for the whole aggregate, 2026-07-03). Instead: the endpoint answers instantly
# from a per-pool-path cache, a MISS kicks a single background thread and
# reports {"state": "computing"}, and an EXPIRED entry is served stale while a
# background refresh runs (stale-while-revalidate) — the operator always gets
# an immediate answer with an honest computed_at.
_ATTENTION_CACHE = {}
_ATTENTION_CACHE_LOCK = threading.Lock()
_ATTENTION_COMPUTING = set()


def _runway_compute(key):
    try:
        data = pooldb.availability_runway()
        with _ATTENTION_CACHE_LOCK:
            _ATTENTION_CACHE[key] = {"at": time.time(), "data": data}
    except Exception as e:  # noqa: BLE001 - a failed refresh keeps the old value
        log.warning("attention_runway_failed", extra={
            "event": "attention_runway_failed", "error": str(e)})
    finally:
        with _ATTENTION_CACHE_LOCK:
            _ATTENTION_COMPUTING.discard(key)


def _runway_cached():
    """The runway snapshot without ever blocking: (data, computed_at_epoch) from
    cache — possibly stale, with the refresh already running — or (None, None)
    while the very first compute is still in flight."""
    key = str(config.POOL_DB_PATH)
    now = time.time()
    with _ATTENTION_CACHE_LOCK:
        hit = _ATTENTION_CACHE.get(key)
        fresh = hit and now - hit["at"] < config.ATTENTION_RUNWAY_TTL
        if not fresh and key not in _ATTENTION_COMPUTING:
            _ATTENTION_COMPUTING.add(key)
            threading.Thread(target=_runway_compute, args=(key,),
                             name="attention-runway", daemon=True).start()
    if hit:
        return hit["data"], hit["at"]
    return None, None


@bp.route("/api/admin/attention")
def api_admin_attention():
    """Operator-only one-glance triage (H4): the machine state the host already
    has — door-crawler heartbeat, availability runway, Spotify stamp pulse,
    retention-sweep recency — plus the human watch-list parsed from BACKLOG.md's
    ⏳ wait/gated markers. Read-only and pull-only; each sub-read is fenced so
    one failure degrades to an `error` field instead of blanking the panel."""
    _require_operator()
    now = datetime.now(timezone.utc)
    out = {"generated_at": now.strftime("%Y-%m-%dT%H:%M:%SZ")}
    try:
        hb = _read_pushed_status() or pooldb.read_crawl_status("door")
        if hb:
            age = _crawl_age_seconds(hb)
            out["crawl"] = {"health": _crawl_verdict(hb, age),
                            "age_seconds": age, "day": hb.get("day")}
        else:
            out["crawl"] = {"health": "never", "age_seconds": None, "day": None}
    except Exception as e:  # noqa: BLE001 - panel reads never take the app down
        out["crawl"] = {"error": str(e)}
    try:
        runway, at = _runway_cached()
        if runway:
            out["availability"] = {**runway, "computed_at": datetime.fromtimestamp(
                at, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
        elif at is None:
            out["availability"] = {"state": "computing"}
        else:
            out["availability"] = {"error": "pool has no availability tables yet"}
    except Exception as e:  # noqa: BLE001
        out["availability"] = {"error": str(e)}
    try:
        out["spotify"] = (pooldb.spotify_stamp_stats()
                          or {"error": "pool has no door_links table yet"})
        # The daily-found trail (owner 2026-07-14): recent per-day counts, so a
        # stalled prewarm reads as a run of found=0 / no recent rows — not a silent
        # drain to 0 within the TTL. Fenced separately so an older pool degrades.
        try:
            out["spotify"]["recent_days"] = pooldb.spotify_log(limit=14)
        except Exception:
            pass
    except Exception as e:  # noqa: BLE001
        out["spotify"] = {"error": str(e)}
    try:
        stamp = json.loads(
            config.RETENTION_STAMP_FILE.read_text(encoding="utf-8"))
        ran = pooldb._parse_ts(stamp.get("ran_at"))
        stamp["age_hours"] = (None if ran is None else
                              round((now - ran).total_seconds() / 3600, 1))
        out["retention"] = stamp
    except FileNotFoundError:
        out["retention"] = {"ran_at": None}
    except Exception as e:  # noqa: BLE001
        out["retention"] = {"error": str(e)}
    try:
        rw = json.loads(config.REFRESH_WATCH_FILE.read_text(encoding="utf-8"))
        checked = pooldb._parse_ts(rw.get("checked_at"))
        rw["checked_age_hours"] = (None if checked is None else
                                   round((now - checked).total_seconds() / 3600, 1))
        out["refresh"] = rw
    except FileNotFoundError:
        out["refresh"] = {"checked_at": None}
    except Exception as e:  # noqa: BLE001
        out["refresh"] = {"error": str(e)}
    try:
        out["watchlist"] = attention.parse_watchlist(
            config.BACKLOG_PATH.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        out["watchlist"] = []
        out["watchlist_error"] = str(e)
    return jsonify(out)


@bp.route("/api/admin/platform-day")
def api_admin_platform_day():
    """Operator-only: how many of TODAY's and TOMORROW's records each listening
    service can actually play. Read-only, no cache — ~115ms per day.

    WHY BOTH DAYS, and why tomorrow is the one to read. Today flatters. Spotify and
    Apple are filled by jobs that work on the CURRENT day, and Apple's links are a
    byproduct of somebody having viewed a record — so today's counts can look healthy
    while the machine behind them is dead. And a person only ever sees today, so by
    the time today reads thin it is already in front of them. Tomorrow is warmed
    overnight and looked at by nobody, which makes it the honest one: a thin tomorrow
    means a job didn't run, and you have a day to fix it. Measured 2026-07-16: today
    Apple 551, tomorrow 26 — the 551 was an artifact of us browsing all day, and the
    26 was the truth.

    A zero here is a real answer, not a gap: db.PLATFORM_ORDER is filled in full."""
    _require_operator()
    now = datetime.now(timezone.utc)
    out = {"generated_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
           "order": list(db.PLATFORM_ORDER), "days": []}
    if not config.POOL_ENABLED:
        out["error"] = "pool serving disabled"
        return jsonify(out)
    today = config.today_local()   # same day the pool serves, so the panel agrees
    for offset, when in ((0, "today"), (1, "tomorrow")):
        d = today + timedelta(days=offset)
        md = f"{d.month:02d}-{d.day:02d}"
        try:
            snap = pooldb.platform_day_counts(d.month, d.day)
            out["days"].append({"day": md, "when": when, **snap})
        except Exception as e:  # noqa: BLE001 - a panel read never takes the app down
            out["days"].append({"day": md, "when": when, "error": str(e)})
    return jsonify(out)


def _container_mem_limit_bytes():
    """Best-effort read of THIS container's RAM ceiling from cgroup, so the /admin
    memory meter tracks the real Render plan (Starter 512 MB, Standard 2 GB, …)
    without a hardcoded number to drift — the same "measure, never remember" rule
    the disk meter already follows via statvfs. cgroup v2 first, then v1; returns
    bytes, or None when there's no finite limit (unlimited, or not on a cgroup host
    like the owner's Mac, where the config fallback stands in)."""
    sane_max = 1 << 40  # 1 TiB — anything larger is the "unlimited" sentinel, not a plan
    for path in ("/sys/fs/cgroup/memory.max",                     # cgroup v2
                 "/sys/fs/cgroup/memory/memory.limit_in_bytes"):  # cgroup v1
        try:
            with open(path) as fh:
                raw = fh.read().strip()
            if raw == "max":
                continue
            val = int(raw)
            if 0 < val < sane_max:
                return val
        except (OSError, ValueError):
            continue
    return None


@bp.route("/api/admin/cost")
def api_admin_cost():
    """Operator-only "what does the hosted app cost me?" for the console
    (INVITE_ROLLOUT_PLAN.md §5). Combines the FIXED monthly costs — plan prices
    from config, which the operator confirms against the real Render/Supabase
    invoices since the server can't read billing — with MEASURED usage: account
    /row/request counts + the store's database size (store.usage_stats()), the
    catalog disk via os.statvfs, and a best-effort worker RSS. Every measured
    metric is guarded on its own so one failure never 500s the panel. The honest
    headline is that the first thing to force a bigger bill is the Render box, not
    Supabase. No secrets in the payload — costs, counts, and byte totals only."""
    _require_operator()
    costs = {
        "render": config.COST_RENDER_MONTHLY,
        "supabase": config.COST_SUPABASE_MONTHLY,
        "domain": config.COST_DOMAIN_MONTHLY,
        "email": config.COST_EMAIL_MONTHLY,
    }
    out = {
        "fixed_monthly": round(sum(costs.values()), 2),
        "costs": costs,
        "ceilings": {
            "render_disk_gb": config.COST_RENDER_DISK_GB,
            "render_ram_mb": config.COST_RENDER_RAM_MB,
            "render_threads": config.COST_RENDER_THREADS,
            "supabase_db_gb": config.COST_SUPABASE_DB_GB,
        },
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    usage = {}
    try:
        usage.update(store.get_store().usage_stats())
    except Exception as e:  # noqa: BLE001 - report, never sink the panel
        usage["store_error"] = str(e)
    # Disk on the catalog/data volume (Render's persistent disk on the host).
    try:
        vfs = os.statvfs(config.DATA_DIR)
        total = vfs.f_blocks * vfs.f_frsize
        usage["disk_total_bytes"] = total
        usage["disk_used_bytes"] = total - vfs.f_bavail * vfs.f_frsize
    except OSError as e:
        usage["disk_error"] = str(e)
    # Best-effort proxy for memory pressure: peak RSS of THIS gunicorn worker.
    # resource is Unix-only (Render + macOS); ru_maxrss is KiB on Linux, bytes on
    # macOS — normalize to bytes so the meter is comparable to the plan RAM.
    try:
        import resource
        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        usage["worker_rss_bytes"] = (
            rss * 1024 if sys.platform.startswith("linux") else rss)
    except Exception:  # noqa: BLE001 - a memory read is never worth a failure
        pass
    # The plan's RAM ceiling, MEASURED from cgroup so the meter's denominator self-
    # corrects on any Render plan (config.COST_RENDER_RAM_MB is only the fallback for
    # non-cgroup hosts). Without this the meter read "/ 512 MB" on a 2 GB Standard box.
    _ram_limit = _container_mem_limit_bytes()
    if _ram_limit:
        usage["render_ram_limit_bytes"] = _ram_limit
    # Live request-concurrency for THIS worker (the box's real ceiling is threads,
    # not a billing meter — INVITE_ROLLOUT_PLAN §2). Cheap read under the gauge
    # lock; `now` includes this in-flight request, so it's always >= 1.
    try:
        with _concurrency_lock:
            usage["concurrency_now"] = _concurrency["now"]
            usage["concurrency_peak"] = _concurrency["peak"]
    except Exception:  # noqa: BLE001 - a gauge read is never worth a failure
        pass
    # Spotify's daily Search budget — the one ceiling that a bigger box can't buy off,
    # and the only one that grows with every person invited. Both spenders, both
    # MEASURED (no configured number to drift): the prewarm's own `attempted` from the
    # Mac-written pool log, and real users' door opens counted on THIS host (opsdb —
    # not pool.sqlite, which the rsync replaces wholesale). Blowing the ceiling 429s
    # the door for everyone at once, so the honest reading is headroom, not usage.
    try:
        burn = opsdb.spotify_burn_today()
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        prewarm = sum(r.get("attempted") or 0 for r in pooldb.spotify_log(50)
                      if (r.get("run_at") or "").startswith(today))
        on_demand = (burn or {}).get("searches")
        spent = (on_demand or 0) + prewarm
        usage["spotify"] = {
            "ceiling": config.SPOTIFY_DAILY_CEILING,
            "on_demand_today": on_demand,          # None = counter unreadable, not zero
            "prewarm_today": prewarm,
            "spent_today": spent,
            "headroom": max(config.SPOTIFY_DAILY_CEILING - spent, 0),
            "detail": burn,
        }
    except Exception as e:  # noqa: BLE001 - report, never sink the panel
        usage["spotify_error"] = str(e)
    out["usage"] = usage
    accounts = usage.get("accounts")
    out["cost_per_account"] = (round(out["fixed_monthly"] / accounts, 2)
                               if accounts else None)
    return jsonify(out)


@bp.route("/api/admin/usage")
def api_admin_usage():
    """Operator-only Usage panel — ANONYMIZED, AGGREGATE signals only. Three sources,
    all metadata: (1) account activity from Supabase auth.users (counts + sign-in
    recency, created_at only — hosted only; SQLite reports available:False), (2) live
    notebook row COUNTS by kind (keeps/notes — the ciphertext is never read), and (3)
    per-day feature counters from opsdb (this host's request path — Today loads, Explore
    searches, door opens). NO user identity and NO notebook content ever appears here:
    the notebook is end-to-end encrypted and the server cannot read it, by design. Every
    source is guarded so one failure never 500s the panel. Skips are deliberately absent
    — they never reach the server (local/ephemeral by design)."""
    _require_operator()
    out = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "features": {}, "content": {}, "accounts": {},
    }
    # (3) Feature counters — sum per key over 7d and 30d windows, plus a per-day series.
    try:
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        cutoff_7d = (datetime.now(timezone.utc) - timedelta(days=6)).strftime("%Y-%m-%d")
        rows = opsdb.usage_recent(30)
        t7, t30, by_day = {}, {}, {}
        for r in rows:
            k, n, d = r["key"], r["n"], r["day"]
            t30[k] = t30.get(k, 0) + n
            if d >= cutoff_7d:
                t7[k] = t7.get(k, 0) + n
            by_day.setdefault(d, {})[k] = n
        out["features"] = {"totals_7d": t7, "totals_30d": t30, "by_day": by_day,
                           "today": today}
    except Exception as e:  # noqa: BLE001 - report, never sink the panel
        out["features_error"] = str(e)
    # (2) Notebook metadata — live keep/note counts (never content).
    try:
        out["content"] = store.get_store().content_stats()
    except Exception as e:  # noqa: BLE001
        out["content_error"] = str(e)
    # (1) Account activity — hosted (Supabase auth) only; SQLite → available:False.
    try:
        out["accounts"] = store.get_store().account_activity()
    except Exception as e:  # noqa: BLE001
        out["accounts_error"] = str(e)
    # Live load — requests in flight on THIS worker right now (+ this process's peak). The
    # closest honest "is anyone here now" signal: Music Forest does not track concurrent
    # PEOPLE (that needs session surveillance), so this is request load, not a headcount.
    try:
        with _concurrency_lock:
            out["live"] = {"in_flight": _concurrency["now"], "peak": _concurrency["peak"]}
    except Exception:  # noqa: BLE001 - a gauge read is never worth a failure
        pass
    return jsonify(out)


@bp.route("/api/admin/catalog-quality")
def api_admin_catalog_quality():
    """Operator-only treemap data (UC1 Phase 1a): one drill level over the resolved
    `entity_quality` view. Pass `?f=` a JSON array of [dim, value] filters already
    drilled into; the server picks the next dimension that still varies (skipping
    constant ones) and returns its blocks with counts — or, at a leaf, up to 500
    album tiles. All aggregation is server-side (the catalog is ~2M rows).

    Degrades gracefully: if the catalog hasn't been resolved (Phase 1a not run, or
    catalog.sqlite not shipped to this host yet), returns `available:false`."""
    _require_operator()
    if not catalogdb.has_quality():
        return jsonify({"available": False,
                        "detail": "catalog.sqlite has no entity_quality yet "
                                  "(run tools/resolve_catalog_fields.py)."})
    filters = []
    raw = request.args.get("f") or "[]"
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            filters = [(str(p[0]), str(p[1])) for p in parsed
                       if isinstance(p, (list, tuple)) and len(p) == 2]
    except (ValueError, TypeError, IndexError):
        filters = []
    try:
        level = catalogdb.quality_drill(filters)
    except Exception as e:  # noqa: BLE001 - never 500 the admin panel on a bad read
        log.warning("catalog_quality_read_failed", extra={
            "event": "catalog_quality_read_failed",
            "request_id": getattr(g, "request_id", None), "error": str(e)})
        return jsonify({"available": False, "detail": str(e)})
    level["available"] = True
    level["filters"] = filters
    return jsonify(level)


# --- UC1 Phase 2 precision gate: sample (read-only) + labels (operator-writable) ---
# The stratified labeling sample is precomputed offline (tools/sample_cluster_precision
# .py) and served read-only; the operator hand-labels each merged cluster
# same|diff|partial from the admin page (desktop OR mobile), and the verdicts persist
# server-side so they sync across devices. The write is atomic (temp file + os.replace),
# so even the 2 gunicorn workers (Standard, since 2026-07-10) can never corrupt the file;
# the process lock still serializes a worker's own threads. The only 2-worker residue is a
# theoretical lost update if two POSTs land at the same instant — impossible for the single
# operator clicking labels one at a time, and self-correcting (the label just wouldn't
# stick, and a re-click fixes it).
_precision_lock = threading.Lock()
_PRECISION_VERDICTS = ("same", "diff", "partial")


def _read_precision_labels():
    try:
        raw = json.loads(config.PRECISION_LABELS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    labels = raw.get("labels", {}) if isinstance(raw, dict) else {}
    return {str(k): v for k, v in labels.items() if v in _PRECISION_VERDICTS}


def _write_precision_labels(labels, sample_at=None):
    path = config.PRECISION_LABELS_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"labels": labels, "sample_generated_at": sample_at,
               "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload), encoding="utf-8")
    os.replace(tmp, path)


@bp.route("/api/admin/precision-sample")
def api_admin_precision_sample():
    """Operator-only: the precomputed Phase-2 labeling sample (clusters + members +
    tracklists). Read-only. Degrades to available:false if the file isn't on this host
    (it's shipped like the other data files, not committed to git)."""
    _require_operator()
    try:
        data = json.loads(config.PRECISION_SAMPLE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return jsonify({"available": False,
                        "detail": "phase2_precision_sample.json is not on this host "
                                  "(rsync it to the data disk)."})
    data["available"] = True
    return jsonify(data)


@bp.route("/api/admin/precision-labels")
def api_admin_precision_labels():
    """Operator-only: all saved cluster verdicts (server-side, synced across devices)."""
    _require_operator()
    return jsonify({"labels": _read_precision_labels()})


@bp.route("/api/admin/precision-labels", methods=["POST"])
def api_admin_precision_labels_set():
    """Operator-only: set or clear ONE cluster's verdict. Body {cluster_id, verdict}
    where verdict is same|diff|partial, or '' / null to clear. Atomic read-modify-write
    under the process lock; returns the running labeled count."""
    _require_operator()
    body = request.get_json(silent=True) or {}
    cid = str(body.get("cluster_id") or "").strip()
    verdict = (body.get("verdict") or "").strip().lower()
    if not cid:
        return jsonify({"error": "cluster_id required"}), 400
    if verdict and verdict not in _PRECISION_VERDICTS:
        return jsonify({"error": "verdict must be same|diff|partial or empty"}), 400
    with _precision_lock:
        labels = _read_precision_labels()
        if verdict:
            labels[cid] = verdict
        else:
            labels.pop(cid, None)
        try:
            _write_precision_labels(labels, sample_at=body.get("sample_generated_at"))
        except OSError as e:
            log.warning("precision_labels_write_failed", extra={
                "event": "precision_labels_write_failed",
                "request_id": getattr(g, "request_id", None), "error": str(e)})
            return jsonify({"error": "could not persist"}), 500
    return jsonify({"ok": True, "count": len(labels)})


@bp.route("/api/sync/keys")
@_LIMIT_SYNC
def api_sync_keys_get():
    """Fetch the caller's wrapped data-encryption keys, or {exists:false} if they
    haven't set a passphrase yet. The material is opaque to the server."""
    uid = _require_user()
    rec = store.get_store().get_keys(uid)
    if not rec:
        return jsonify({"exists": False})
    return jsonify({"exists": True, **rec})


@bp.route("/api/sync/keys", methods=["PUT"])
@_LIMIT_SYNC
def api_sync_keys_put():
    """Store (or re-wrap) the caller's wrapped DEKs. Body: {key_material:{...}}.
    Upsert: first call sets them at signup; a later call replaces them after a
    passphrase change (which only re-wraps the DEK, never re-encrypts rows)."""
    uid = _require_user()
    data = request.get_json(silent=True) or {}
    material = data.get("key_material")
    if not isinstance(material, dict) or not material:
        return jsonify({"error": "key_material object required"}), 400
    rec = store.get_store().put_keys(uid, material)
    return jsonify({"ok": True, **rec})


@bp.route("/api/sync/rows")
@_LIMIT_SYNC
def api_sync_rows_get():
    """Fetch the caller's encrypted rows. Optional ?kind=note|choice|trail|mark to
    scope to one type, and ?since=<iso-timestamp> for a delta pull (rows changed
    after the cursor, tombstones included). Returns a `server_time` the client
    can use as the next `since`."""
    uid = _require_user()
    kind = request.args.get("kind") or None
    since = request.args.get("since") or None
    rows = store.get_store().get_rows(uid, kind=kind, since=since)
    server_time = store._now()
    return jsonify({"rows": [_row_out(r) for r in rows],
                    "count": len(rows), "server_time": server_time})


@bp.route("/api/sync/rows", methods=["POST"])
@_LIMIT_SYNC
def api_sync_rows_post():
    """Upsert a batch of encrypted rows. Body: {rows:[{kind, client_id,
    ciphertext(b64), nonce(b64), deleted?}, ...]}. A row with deleted:true is
    tombstoned (blob cleared) just like the DELETE route; this lets the client
    flush creates, edits and deletes in one request."""
    uid = _require_user()
    data = request.get_json(silent=True) or {}
    raw_rows = data.get("rows")
    if not isinstance(raw_rows, list):
        return jsonify({"error": "rows array required"}), 400
    if len(raw_rows) > 5000:
        return jsonify({"error": "too many rows in one batch (max 5000)"}), 413
    prepared = []
    for r in raw_rows:
        if not isinstance(r, dict):
            return jsonify({"error": "each row must be an object"}), 400
        item = {"kind": r.get("kind"), "client_id": r.get("client_id"),
                "deleted": bool(r.get("deleted"))}
        if not item["deleted"]:
            item["ciphertext"] = _b64d(r.get("ciphertext"), "ciphertext")
            item["nonce"] = _b64d(r.get("nonce"), "nonce")
        prepared.append(item)
    written = store.get_store().upsert_rows(uid, prepared)
    return jsonify({"ok": True, "written": written,
                    "server_time": store._now()})


@bp.route("/api/sync/rows/<kind>/<client_id>", methods=["DELETE"])
@_LIMIT_SYNC
def api_sync_rows_delete(kind, client_id):
    """Tombstone one encrypted row (blob cleared, marked deleted) so other
    devices learn it's gone on their next pull."""
    uid = _require_user()
    deleted = store.get_store().delete_row(uid, kind, client_id)
    return jsonify({"ok": True, "deleted": deleted})


@bp.route("/api/sync/account", methods=["DELETE"])
@_LIMIT_SYNC
def api_sync_account_delete():
    """Self-serve account deletion (GDPR/CCPA erasure).

    Irreversibly deletes the caller's stored data — every encrypted journal row
    and their wrapped keys — scoped to the authenticated user, so a token can
    only ever delete its OWN account. Because the wrapped DEK is the sole key,
    dropping user_keys makes any residual ciphertext permanently undecryptable:
    that erasure is the meaningful part and always runs.

    An explicit confirmation is required in the body ({"confirm": "DELETE"}) so a
    stray client call can't wipe an account. The Supabase Auth identity itself
    (login + email) is additionally removed when config.ACCOUNT_DELETE_AUTH is
    enabled (hosted Postgres); otherwise `auth_user_deleted` comes back false and
    the login removal is left to the operator — the response says which happened
    so the client can tell the user. The deletion is logged (opaque UUID only)."""
    uid = _require_user()
    data = request.get_json(silent=True) or {}
    if data.get("confirm") != "DELETE":
        return jsonify({
            "error": "confirmation required",
            "hint": 'send {"confirm": "DELETE"} to permanently delete your account',
        }), 400
    st = store.get_store()
    erased = st.delete_user(uid)          # app data — always; StoreError -> 5xx
    auth_user_deleted = False
    if config.ACCOUNT_DELETE_AUTH:
        # Best-effort: the app data is already gone, so a failure to remove the
        # login must not turn the whole request into an error.
        try:
            auth_user_deleted = st.delete_auth_user(uid)
        except store.StoreError as e:
            log.warning("account_auth_delete_failed", extra={
                "event": "account_auth_delete_failed", "user_id": uid,
                "status": e.status})
    log.warning("account_deleted", extra={
        "event": "account_deleted", "user_id": uid,
        "backend": "postgres" if config.SUPABASE_DB_URL else "sqlite"})
    return jsonify({"ok": True, "erased": erased,
                    "auth_user_deleted": auth_user_deleted})


# --- Data-retention sweep (Privacy Policy §6) --------------------------------
# The policy states retention limits, so they must run without operator memory:
# a small daemon thread prunes handled/stale access requests (both store
# backends) and old on-disk feedback entries, once at app start and then daily.
# It deliberately does NOT touch hosted Supabase feedback rows — those must go
# bucket-objects-first via tools/prune_feedback.py (service-role key), or the
# readable screenshots would outlive their rows as unlisted orphans.
# Started once per process per (store, feedback dir) target; create_app is
# called freely by tests, so the latch keeps threads bounded. Every part is
# best-effort: a sweep failure is logged, never raised, and never blocks boot.
_RETENTION_STARTED = set()
_RETENTION_LOCK = threading.Lock()


def _retention_sweep_once(st, handled_days, max_days, feedback_days):
    counts = {}
    try:
        counts["access_requests_deleted"] = st.prune_access_requests(
            handled_days, max_days)
    except Exception as e:  # noqa: BLE001 - sweep must never take the app down
        log.warning("retention_sweep_access_failed", extra={
            "event": "retention_sweep_access_failed", "error": str(e)})
    try:
        fb = feedback.prune(feedback_days)
        counts["feedback_deleted"] = fb["deleted"]
    except Exception as e:  # noqa: BLE001
        log.warning("retention_sweep_feedback_failed", extra={
            "event": "retention_sweep_feedback_failed", "error": str(e)})
    if counts:
        log.info("retention_sweep", extra={"event": "retention_sweep", **counts})
    # Stamp the run (H4 attention panel: "is the retention commitment actually
    # running?"). Best-effort — a stamp failure must never hurt the sweep.
    try:
        path = config.RETENTION_STAMP_FILE
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps({
            "ran_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            **counts}), encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        pass


def _start_retention_sweep():
    """Kick the daily retention thread for the current config's targets."""
    if not config.RETENTION_SWEEP:
        return
    key = (config.SUPABASE_DB_URL or str(config.SYNC_DB_PATH),
           str(config.FEEDBACK_DIR))
    with _RETENTION_LOCK:
        if key in _RETENTION_STARTED:
            return
        _RETENTION_STARTED.add(key)
    # Capture the store + windows now so later config overrides (tests build
    # many apps) never repoint a running sweep at somebody else's files.
    st = store.get_store()
    args = (st, config.ACCESS_RETENTION_DAYS, config.ACCESS_RETENTION_MAX_DAYS,
            config.FEEDBACK_RETENTION_DAYS)

    def _loop():
        while True:
            _retention_sweep_once(*args)
            time.sleep(24 * 3600)

    threading.Thread(target=_loop, name="retention-sweep", daemon=True).start()


def create_app(overrides=None):
    """Build a fresh Flask app with all routes registered.

    `overrides` is an optional dict of config attributes to set before the app
    is wired (e.g. ``{"DB_PATH": tmp_db, "PREFETCH_ENABLED": False}``), which is
    what lets a test point the whole app at throwaway databases. Production and
    `python server.py` just call ``create_app()`` with no overrides.
    """
    for key, value in (overrides or {}).items():
        setattr(config, key, value)
    # Configure structured logging from the (possibly overridden) level. Safe to
    # call repeatedly — it never stacks handlers.
    _configure_logging()
    # The sync store is built from config (SYNC_DB_PATH / SUPABASE_DB_URL); drop
    # any cached one so a fresh app picks up (possibly overridden) config.
    store.reset_store()
    # Data-retention sweep (daily, daemon, best-effort). Runs here rather than
    # in main() because gunicorn imports server:app and never calls main().
    _start_retention_sweep()
    application = Flask(__name__, static_folder="static",
                        static_url_path="/static")
    application.register_blueprint(bp)
    # Stamp every request with a start time + id BEFORE anything (incl. the
    # limiter) can short-circuit it, so the completion log always fires.
    application.before_request(_begin_request)
    # Decrement the concurrency gauge on the way out — teardown runs even when a
    # view raised, so a slot is never leaked.
    application.teardown_request(_concurrency_exit)
    # Rate limiting is wired only when the hosted dependency is installed.
    # `limiter` is a shared module-global (the documented app-factory pattern), so
    # once any app calls init_app() it keeps enforcing on later-built apps too;
    # toggling its `enabled` kill-switch per app is what actually turns it off
    # (skipping init_app alone does NOT). This matters for tests, which build many
    # apps in one process with the limiter on for some and off for others.
    if _HAVE_LIMITER:
        limiter.enabled = bool(config.RATE_LIMIT_ENABLED)
        if config.RATE_LIMIT_ENABLED:
            limiter.init_app(application)
            try:
                limiter.reset()   # fresh in-memory counters per app (isolation)
            except Exception:     # noqa: BLE001 - reset is best-effort
                pass
            # Keep the app's JSON error shape on a 429 (Flask-Limiter would
            # otherwise return its own plain page) and ensure the security headers
            # still attach (the after_request chain decorates this response).
            application.register_error_handler(RateLimitExceeded, _on_rate_limited)
            application.register_error_handler(429, _on_rate_limited)
    # after_request runs in REVERSE registration order; register the logger first
    # so it runs LAST and records the final, fully-decorated response.
    application.after_request(_log_request)
    application.after_request(add_cors)
    application.after_request(security_headers)
    return application


# Module-level app for `python server.py`, gunicorn (`server:app`), etc.
app = create_app()


# --- pool warm-up (post-deploy cold read) ----------------------------------
# The daily-Choose data comes from pool.sqlite (~960 MB), larger than the box's RAM
# (512 MB on Starter), so the daily draw is disk-paged. A DEPLOY restarts the
# container, so the FIRST /api/pool/pick after a deploy faults the day's pool pages in
# cold off a network disk — measured ~20 s vs ~0.2 s warm (owner, on-device
# 2026-07-10). This primes today's + tomorrow's AVAILABLE slice into the OS page cache
# on worker boot, through the real serve path (enrich + cluster + availability, which
# also warms catalog.sqlite), so the first user request lands warm. Best-effort +
# daemon + non-blocking; it runs in the request-serving worker (render.yaml runs
# gunicorn WITHOUT --preload, so module import happens per-worker) a moment after boot.
# Off when the pool isn't the source (POOL_ENABLED) or AOTD_WARM_POOL=0. Never raises.
# NOTE: this is a mitigation, not the full fix — the box's RAM < the pool, so other
# days / Browse stay disk-bound; the complete fix is the H5 plan bump (2 GB fits it).
def _warm_pool_slice():
    try:
        time.sleep(2)   # let the worker start serving before we take disk/CPU
        t0 = time.time()
        rows = 0
        base = config.today_local()    # warm the days we actually serve (ET)
        for d in (base, base + timedelta(days=1)):
            try:
                rows += len(pooldb.pool_day(d.month, d.day, available_only=True, limit=None))
            except Exception:   # noqa: BLE001 - one bad day mustn't abort the warm
                pass
        log.info("pool warm-up primed today+tomorrow", extra={
            "event": "pool_warm", "rows": rows, "secs": round(time.time() - t0, 1)})
    except Exception:   # noqa: BLE001 - warm-up is best-effort, never fatal
        pass


def _maybe_warm_pool():
    if "pytest" in sys.modules:                       # never during the test suite
        return
    if not getattr(config, "POOL_ENABLED", False):    # nothing to warm off the pool
        return
    if os.environ.get("AOTD_WARM_POOL", "1") in ("0", "false", "False"):
        return
    threading.Thread(target=_warm_pool_slice, name="pool-warm", daemon=True).start()


_maybe_warm_pool()


def main():
    if not config.DB_PATH.exists():
        raise SystemExit(
            f"Database not found at {config.DB_PATH}.\n"
            "Run download.py then build_db.py first (or ./run.sh).")
    print(f"Album-of-the-Day running at http://{config.HOST}:{config.PORT}")
    # Surface the active hosted-sync backend so "real auth + silent SQLite
    # fallback" can't go unnoticed (see SMOKE_TEST_H1_2.md §0). Auth turns on
    # with SUPABASE_URL, but encrypted rows only reach Supabase when
    # SUPABASE_DB_URL is also set; otherwise they land in local SQLite.
    auth_on = bool(config.SUPABASE_URL and config.SUPABASE_ANON_KEY)
    if config.SUPABASE_DB_URL:
        print("[sync] store backend: postgres (Supabase)")
    elif auth_on:
        print(f"[sync] !! store backend: sqlite ({config.SYNC_DB_PATH}) — "
              "hosted auth is ON but AOTD_SUPABASE_DB_URL is UNSET, so encrypted "
              "rows are NOT reaching Supabase. Export the pooled Postgres "
              "connection string (Project Settings -> Database) to use Supabase.")
    else:
        print(f"[sync] store backend: sqlite ({config.SYNC_DB_PATH}) — "
              "local single-user mode")
    # D5: verify the irreplaceable journal is healthy before we touch it. A
    # failure doesn't block serving (you can still browse albums), but it's
    # shouted loudly so a corrupt journal is noticed before more writes land.
    try:
        ok, problems = journal.integrity_check()
        if not ok:
            print("[journal] !! INTEGRITY CHECK FAILED — your notes/choices DB "
                  "may be corrupt:")
            for p in problems[:10]:
                print(f"[journal]    - {p}")
            print(f"[journal]    A recent backup may be in "
                  f"{config.JOURNAL_BACKUP_DIR}.")
    except Exception as e:  # noqa: BLE001 - a check hiccup must not block serving
        print(f"[journal] integrity check skipped: {e}")
    # D1: snapshot the (irreplaceable) journal on startup, keep the last N.
    try:
        snap = journal.backup()
        if snap:
            print(f"[journal] backed up -> {snap}")
    except Exception as e:  # noqa: BLE001 - a backup hiccup must not block serving
        print(f"[journal] backup skipped: {e}")
    if config.PREFETCH_ENABLED:
        print("[prefetch] background cover prefetch enabled "
              "(set AOTD_PREFETCH=0 to disable)")
    prefetch.start()
    app.run(host=config.HOST, port=config.PORT, debug=False)


if __name__ == "__main__":
    main()
