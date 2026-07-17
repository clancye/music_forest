"""
Central configuration for Album-of-the-Day.

Everything is driven by environment variables with sensible defaults, so the
same code runs locally today and can be deployed/shared later without edits.
Override any value by exporting the matching env var before running.
"""
import os
from pathlib import Path

# --- Paths ------------------------------------------------------------------
# Project root = folder this file lives in.
ROOT = Path(__file__).resolve().parent

# Where large data lives. Keep dumps + db out of the code dir if you like by
# exporting AOTD_DATA_DIR=/some/big/disk.
DATA_DIR = Path(os.environ.get("AOTD_DATA_DIR", ROOT / "data"))

# The downloaded Discogs dump (.xml.gz) lands here.
DUMP_DIR = Path(os.environ.get("AOTD_DUMP_DIR", DATA_DIR / "dumps"))

# The SQLite database we build from the dump. This is a regenerable cache and
# is DELETED + rebuilt by build_db.py on every dump refresh.
DB_PATH = Path(os.environ.get("AOTD_DB_PATH", DATA_DIR / "albums.db"))

# Full-text search index over the catalog (artist/title/genres/styles), built
# alongside albums.db. A separate, contentless FTS5 file keyed by release_id, so
# it can be rebuilt (or shipped) independently of the big album DB. Regenerable.
SEARCH_DB_PATH = Path(os.environ.get("AOTD_SEARCH_DB", DATA_DIR / "search.db"))

# --- P3 unified daily-pick pool (additive, flag-gated) ----------------------
# The deduped both-arms pool (tools/build_pool_db.py) + its Deezer availability
# table (tools/precompute_availability.py): a read-only SQLite on the same catalog
# disk as albums.db, rsync'd up like the rest of the catalog. POOL_ENABLED gates
# the additive /api/pool/* endpoints ONLY — the existing serving path is untouched
# whether it's on or off, so this is safe to ship dark and flip per-environment.
POOL_DB_PATH = Path(os.environ.get("AOTD_POOL_DB", DATA_DIR / "pool.sqlite"))
POOL_ENABLED = os.environ.get("AOTD_USE_POOL", "") not in ("", "0", "false", "False")

# ops.sqlite — counters this HOST owns and writes (opsdb.py). Deliberately NOT a table
# in pool.sqlite: rsync_pool.sh replaces that file WHOLESALE several times a day, which
# would silently reset anything the server wrote. Same disk, never in the rsync.
OPS_DB_PATH = Path(os.environ.get("AOTD_OPS_DB", DATA_DIR / "ops.sqlite"))

# UC1 Phase 0 — the source-neutral catalog entity layer (UNIFIED_CATALOG_DESIGN.md,
# Appendix A). Stable ULID `alb_id`s + an `entity_members` index over the pool, built
# additively by tools/build_catalog_entities.py and read via catalogdb.py. Carried
# FORWARD across rebuilds (like pool warmth), never rebuilt from scratch. CATALOG_ENABLED
# gates the (Phase-0: unused-by-serving) read layer — safe to ship dark.
CATALOG_DB_PATH = Path(os.environ.get("AOTD_CATALOG_DB", DATA_DIR / "catalog.sqlite"))
CATALOG_ENABLED = os.environ.get("AOTD_USE_CATALOG", "") not in ("", "0", "false", "False")

# UC1 Phase 2 serve-flip: collapse the daily draw across a merged cross-source cluster
# (a Discogs + MB entry for the SAME album) to ONE record. A SEPARATE dark flag from
# CATALOG_ENABLED (which is already live for the field union) so the de-dup ships shadow
# and flips only after prod verification. Needs CATALOG_ENABLED + a clustered catalog.
CLUSTER_DEDUP_ENABLED = os.environ.get("AOTD_CLUSTER_DEDUP", "") not in (
    "", "0", "false", "False")

# L3 — the published Privacy Policy + Terms pages (static/privacy.html,
# static/terms.html; routes /privacy + /terms). Now LIVE (owner-authored, filled,
# placeholders resolved, self-published for the invite beta — attorney review +
# LLC are proceeding in parallel, and the [LEGAL ENTITY] name swaps in cleanly
# once the LLC exists). Default ON so the footer link is never broken; set
# AOTD_PUBLISH_LEGAL=0 as a kill-switch to 404 both routes. See NEXT_SESSION_LEGAL.md §4.
LEGAL_PAGES_ENABLED = os.environ.get("AOTD_PUBLISH_LEGAL", "1") not in (
    "0", "false", "False")

# UC1 Phase 2 precision gate (operator tooling). The stratified labeling SAMPLE is
# precomputed by tools/sample_cluster_precision.py and read-only served to the admin
# labeling page; the LABELS the operator assigns are stored server-side (a small JSON
# file on the writable data disk) so they sync across devices (label on desktop, finish
# on mobile). Both absent on a host => the page degrades to "sample not shipped here".
PRECISION_SAMPLE_FILE = Path(os.environ.get(
    "AOTD_PRECISION_SAMPLE", DATA_DIR / "phase2_precision_sample.json"))
PRECISION_LABELS_FILE = Path(os.environ.get(
    "AOTD_PRECISION_LABELS", DATA_DIR / "phase2_precision_labels.json"))

# Confirmed Bandcamp links harvested from the MusicBrainz release dump's
# url-relationships (F20). A static side table {mbid -> album-exact bandcamp url,
# type}, built by tools/build_mb_bandcamp.py and reached via a pool row's
# mb_release_ids. Absent/never-built => no bandcamp links surface (unknown, never
# an error). Rides to Render alongside pool.sqlite (same vintage).
BANDCAMP_DB_PATH = Path(os.environ.get("AOTD_BANDCAMP_DB", DATA_DIR / "mb_bandcamp.sqlite"))

# The LAZY door (pooldb.door_links) resolves an opened MB-only album's cover +
# per-platform links via iTunes then Odesli. It is USER-FACING and ON the request
# path, so it must bound its own time — unlike the patient bulk coverage_study
# profile (timeout=15, tries=5, backoff=3.0), which can afford minutes. These cap
# each door HTTP call so a slow/blocked/throttled upstream (Render's shared egress
# IP draws iTunes 403s and Odesli's ~10 req/min cap) returns an 'err' in seconds
# instead of stalling for minutes past gunicorn's worker timeout. An 'err' is NOT
# cached, so the next open retries — a fast err is the correct, graceful outcome
# (the album just stays coverless with search links). Door-only: the bulk study
# path keeps coverage_study._get's defaults, untouched.
#   tries=1 => one attempt, no retry-backoff loop (a 403/timeout fails fast).
DOOR_HTTP_TIMEOUT = float(os.environ.get("AOTD_DOOR_TIMEOUT", "4"))
DOOR_HTTP_TRIES = int(os.environ.get("AOTD_DOOR_TRIES", "1"))
DOOR_HTTP_BACKOFF = float(os.environ.get("AOTD_DOOR_BACKOFF", "0"))

# How long a door's on-demand Spotify link stays cached before it is considered
# STALE — re-resolved on the next open, or deleted by the eviction sweep / read
# rule. This is the "rolling window" that keeps the Spotify link a TEMPORARY
# performance cache (Spotify Developer Terms v10 §IV.3.b) rather than a permanent
# index (§IV.3.a.i forbids indefinite storage). It also makes termination cleanup
# automatic: once the owner's app/Premium lapses and spotify_album() no-ops, no
# link is refreshed, so within TTL days the whole Spotify cache drains itself
# (§IX.8.7's delete-on-termination, self-enforcing). Default 2 days = today +
# tomorrow, matching the nightly prewarm horizon.
SPOTIFY_CACHE_TTL_DAYS = int(os.environ.get("AOTD_SPOTIFY_TTL_DAYS", "2"))

# The whole app's Spotify Search budget for one day — MEASURED 2026-07-16, not a
# documented figure (dev mode publishes none). Prod uses ONE client_id, so blowing it
# 429s the on-demand door for EVERY user at once; that day it cost a 7.3h ban. Two
# spenders share it: the bounded prewarm (tools/prewarm_spotify.sh LIMIT) and real
# users' door opens (counted per-host in opsdb.spotify_burn). /admin shows both against
# this number. It is a ceiling to stay UNDER, never a target.
SPOTIFY_DAILY_CEILING = int(os.environ.get("AOTD_SPOTIFY_CEILING", "780"))

# Your listening journal + notes. This is the one piece of irreplaceable,
# user-authored data, so it lives in its OWN file that build_db.py never
# touches — a dump rebuild can't wipe it.
JOURNAL_DB_PATH = Path(os.environ.get("AOTD_JOURNAL_DB", DATA_DIR / "journal.db"))

# Rotating backups of the journal (D1). The journal is the only irreplaceable,
# user-authored data, so we snapshot it (hot-safe `VACUUM INTO`) on startup and
# keep the last N copies here. Set AOTD_JOURNAL_BACKUPS=0 to disable.
JOURNAL_BACKUP_DIR = Path(os.environ.get(
    "AOTD_JOURNAL_BACKUP_DIR", DATA_DIR / "backups"))
JOURNAL_BACKUP_KEEP = int(os.environ.get("AOTD_JOURNAL_BACKUPS", "7"))

# Downloaded/cached cover images live under static/ so the server can serve
# them directly and the app works fully offline once cached.
ART_DIR = Path(os.environ.get("AOTD_ART_DIR", ROOT / "static" / "art"))

# In-app feedback (the "Send feedback" button). Each submission writes a
# self-describing entry here — a note plus a snapshot of the app's current
# state, the browser environment, and a best-effort screenshot — so it can be
# read later (by a person or an AI) and triaged into the backlog. Lives under
# data/ so it's local-only, gitignored, and never touched by a dump rebuild.
FEEDBACK_DIR = Path(os.environ.get("AOTD_FEEDBACK_DIR", DATA_DIR / "feedback"))

# --- Hosted, end-to-end-encrypted sync (H1.1) -------------------------------
# The beta keeps each user's journal as end-to-end-encrypted blobs in Supabase
# Postgres; Flask is only an authenticated sync layer over them (see BETA_PLAN.md
# §3–4). None of the values below are needed to run the app locally — when they
# are unset the app behaves exactly as the single-user local tool it has always
# been (see auth.py: identity falls back to LOCAL_USER_ID and JWT checks are
# skipped). They switch the hosted behaviour on only once they are present.

# Supabase tokens can be verified two ways (see auth.py), and the verifier picks
# by the token's `alg`, so BOTH can be configured during a migration:
#
#   * Asymmetric signing keys (RECOMMENDED) — ES256/RS256, verified against the
#     project's public JWKS discovery endpoint. The private key can't be
#     extracted from Supabase, so nobody (not even the operator) can mint a token
#     to impersonate a user. This is Supabase's current best practice.
#   * Legacy JWT secret — the single shared HS256 secret (Auth → JWT Keys →
#     "Legacy JWT secret"). Still works (and is the simplest to start with), but
#     Supabase marks it "no longer recommended". Kept as a transition fallback.
#
# When NEITHER is set, auth is bypassed for local/dev/test use (single local
# user). When EITHER is set, every /api/sync/* call must carry a valid
# `Authorization: Bearer <supabase-jwt>`.
SUPABASE_JWT_SECRET = os.environ.get("AOTD_SUPABASE_JWT_SECRET", "")
# JWKS discovery endpoint for asymmetric verification. Defaults to the standard
# Supabase path derived from SUPABASE_URL (set below), or override explicitly.
SUPABASE_JWKS_URL = os.environ.get("AOTD_SUPABASE_JWKS_URL", "")
# Expected `aud`/`iss` claims. Supabase issues `aud=authenticated` and
# `iss=<project-url>/auth/v1`. Audience is checked; issuer only if provided.
JWT_AUDIENCE = os.environ.get("AOTD_JWT_AUDIENCE", "authenticated")
JWT_ISSUER = os.environ.get("AOTD_JWT_ISSUER", "")  # "" = don't check issuer

# Operator (admin) Supabase user UUIDs, comma-separated, for server-side gating of
# the operator-only JSON endpoints (e.g. /api/admin/crawl-status). The /admin
# *page* is still gated by Supabase RLS (app_admins), but Flask endpoints that read
# pool.sqlite aren't behind RLS, so they check this list. When EMPTY (local/dev,
# where auth isn't enforced and the only caller is you), any authenticated request
# passes — so a single-user local box needs no setup. Set it on the host.
OPERATOR_IDS = frozenset(
    s.strip() for s in os.environ.get("AOTD_OPERATOR_IDS", "").split(",")
    if s.strip())

# Crawler health PUSH (near-real-time, decoupled from the per-day pool.sqlite
# rsync). The local crawler POSTs progress to /api/admin/crawl-status; the server
# accepts the write only when this shared secret matches the pushed X-Crawl-Token
# header, and caches the payload to CRAWL_STATUS_FILE (a tiny JSON on the data
# disk, shared across gunicorn workers). EMPTY -> pushes are refused (the receiver
# is off); set the same value here and on the crawler to enable it.
CRAWL_PUSH_TOKEN = os.environ.get("AOTD_CRAWL_PUSH_TOKEN", "")
CRAWL_STATUS_FILE = Path(os.environ.get(
    "AOTD_CRAWL_STATUS_FILE", DATA_DIR / "crawl_status.json"))

# H4 — the /admin "where should my attention be" panel. BACKLOG.md ships with
# the deploy (it's in git), so the watch-list reads it straight from the repo
# root; the retention sweep stamps its last run here so the panel can show the
# privacy-policy commitment is actually running. Both overridable for tests.
BACKLOG_PATH = Path(os.environ.get("AOTD_BACKLOG_PATH", ROOT / "BACKLOG.md"))
RETENTION_STAMP_FILE = Path(os.environ.get(
    "AOTD_RETENTION_STAMP_FILE", DATA_DIR / "retention_sweep.json"))
# Refresh-watch (DATA_REFRESH §6/§7): a cheap weekly probe (tools/refresh_watch.py,
# a launchd agent) records whether the derived catalog has drifted from the newest
# upstream dump; the attention panel reads this stamp and nudges the operator when
# it's worth re-checking. "Worth a look" = a newer dump is published AND either its
# gz grew past DELTA_PCT or MAX_DAYS have elapsed since the on-disk vintage (§6's
# "quarterly, or when the drift check crosses threshold"). All overridable for tests.
REFRESH_WATCH_FILE = Path(os.environ.get(
    "AOTD_REFRESH_WATCH_FILE", DATA_DIR / "refresh_watch.json"))
REFRESH_WATCH_DELTA_PCT = float(os.environ.get("AOTD_REFRESH_WATCH_DELTA_PCT", "1.5"))
REFRESH_WATCH_MAX_DAYS = int(os.environ.get("AOTD_REFRESH_WATCH_MAX_DAYS", "90"))
# The availability-runway aggregate walks the whole ~2M-row pool (~seconds), so
# the attention endpoint caches it this long (seconds).
ATTENTION_RUNWAY_TTL = int(os.environ.get("AOTD_ATTENTION_RUNWAY_TTL", "900"))

# --- Operator cost dashboard (H4b) ------------------------------------------
# The /admin "what does this cost me?" panel (GET /api/admin/cost) answers the
# question an invite rollout needs: the flat monthly nut and how much headroom is
# left before the next bill changes. See INVITE_ROLLOUT_PLAN.md.
#
# Fixed costs are the PLAN PRICES you confirm against the real Render/Supabase
# invoices — the server can't read billing, so these are config, not measured.
# Env-overridable so a price change is one var, not a code edit; set any to 0 to
# drop that line. Defaults are the real invoices reconciled 2026-07-07: Render
# $11.75/mo, Supabase Pro $37.19/mo. Domain + email hosting are billed ANNUALLY
# ($1.54/yr and $36/yr), amortized here to a monthly run-rate (÷12) so the panel's
# "/mo" figure is a true nut. Total ≈ $52/mo.
COST_RENDER_MONTHLY = float(os.environ.get("AOTD_COST_RENDER", "11.75"))
COST_SUPABASE_MONTHLY = float(os.environ.get("AOTD_COST_SUPABASE", "37.19"))
COST_DOMAIN_MONTHLY = float(os.environ.get("AOTD_COST_DOMAIN", "0.13"))
COST_EMAIL_MONTHLY = float(os.environ.get("AOTD_COST_EMAIL", "3.00"))
# Plan ceilings for the headroom meters — the caps that would force a bigger
# bill. Defaults: Render Starter's 20 GB disk (render.yaml) + 512 MB RAM, and
# Supabase Pro's 8 GB database. Override when you change plans.
COST_RENDER_DISK_GB = float(os.environ.get("AOTD_COST_RENDER_DISK_GB", "20"))
COST_RENDER_RAM_MB = float(os.environ.get("AOTD_COST_RENDER_RAM_MB", "512"))
COST_SUPABASE_DB_GB = float(os.environ.get("AOTD_COST_SUPABASE_DB_GB", "8"))
# The box's real ceiling isn't a billing meter — it's the gunicorn worker's
# threads (INVITE_ROLLOUT_PLAN §2, "what breaks first"). The live in-flight gauge
# in /api/admin/cost meters against this. Starter runs one worker × 8 threads.
COST_RENDER_THREADS = int(os.environ.get("AOTD_COST_RENDER_THREADS", "8"))

# Direct Postgres connection string for the hosted store (Supabase → Project
# Settings → Database → Connection string, the pooled/`postgres` role). When SET,
# the sync layer talks to Postgres (psycopg); when UNSET it uses a local SQLite
# file (SYNC_DB_PATH) so dev + the test suite need no database.
SUPABASE_DB_URL = os.environ.get("AOTD_SUPABASE_DB_URL", "")

# Local SQLite backing file for the sync layer when SUPABASE_DB_URL is unset.
# Lives under data/ (gitignored, untouched by a catalog rebuild). This is NOT
# your existing journal.db — it is the encrypted-row store the new sync layer
# reads/writes; the legacy journal.db keeps powering the current local app until
# the client-side crypto lands (H1.2).
SYNC_DB_PATH = Path(os.environ.get("AOTD_SYNC_DB", DATA_DIR / "sync.db"))

# The single user every request is attributed to when auth is bypassed (no JWT
# secret configured). A fixed UUID so local rows have a stable owner.
LOCAL_USER_ID = os.environ.get(
    "AOTD_LOCAL_USER_ID", "00000000-0000-0000-0000-000000000000")

# --- Self-serve account deletion (GDPR/CCPA erasure) ------------------------
# DELETE /api/sync/account ALWAYS erases the caller's app data — every encrypted
# journal row + their wrapped keys — and because the wrapped DEK is the only key,
# that makes any residue permanently undecryptable. Removing the Supabase Auth
# identity itself (the auth.users row + email) is gated here because it deletes
# from Supabase's OWN auth schema via the trusted Postgres role: turn it on only
# once you've confirmed that role may touch auth.users in your project. When OFF
# (default), the login/email is left for the operator to remove and the endpoint
# says so in its response, so nothing surprising happens by default.
ACCOUNT_DELETE_AUTH = os.environ.get("AOTD_ACCOUNT_DELETE_AUTH", "0") == "1"

# --- Data retention (privacy policy §6 — stated limits must equal real code) --
# Auto-prune windows, in days, for the two operator-readable stores. The Privacy
# Policy states these as commitments, so they run automatically (a daily
# background sweep in the server, see server._retention_sweep) rather than
# relying on operator memory. A value of 0 disables that individual rule.
#
#   ACCESS_RETENTION_DAYS     : handled (invited/declined) access requests are
#                               deleted this long after the decision.
#   ACCESS_RETENTION_MAX_DAYS : ANY access request (even one still marked 'new')
#                               is deleted this long after its last activity —
#                               an unactioned ask should not live forever.
#   FEEDBACK_RETENTION_DAYS   : feedback entries are deleted this long after
#                               submission. The sweep covers the on-disk store
#                               (data/feedback/, local mode + the hosted /api/
#                               feedback fallback). Hosted Supabase feedback
#                               (public.feedback rows + the private Storage
#                               bucket) needs the service-role key, so it is
#                               pruned by tools/prune_feedback.py instead —
#                               bucket objects first, then rows, same window.
#   RETENTION_SWEEP           : master gate for the in-server background sweep.
ACCESS_RETENTION_DAYS = int(os.environ.get("AOTD_ACCESS_RETENTION_DAYS", "180"))
ACCESS_RETENTION_MAX_DAYS = int(
    os.environ.get("AOTD_ACCESS_RETENTION_MAX_DAYS", "365"))
FEEDBACK_RETENTION_DAYS = int(
    os.environ.get("AOTD_FEEDBACK_RETENTION_DAYS", "180"))
RETENTION_SWEEP = os.environ.get("AOTD_RETENTION_SWEEP", "1") == "1"

# Frontend-facing Supabase values (used by the H1.2 client; carried here so all
# AOTD_* secrets live in one place). The anon key is public by design.
SUPABASE_URL = os.environ.get("AOTD_SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.environ.get("AOTD_SUPABASE_ANON_KEY", "")

# If the JWKS URL wasn't given explicitly, derive the standard Supabase endpoint
# from the project URL, so setting AOTD_SUPABASE_URL is enough to enable
# asymmetric (ES256/RS256) token verification.
if not SUPABASE_JWKS_URL and SUPABASE_URL:
    SUPABASE_JWKS_URL = SUPABASE_URL.rstrip("/") + "/auth/v1/.well-known/jwks.json"


# --- Discogs dump source ----------------------------------------------------
# Public S3 bucket that backs https://data.discogs.com/ (CC0 licensed data).
DISCOGS_BUCKET = os.environ.get(
    "AOTD_DISCOGS_BUCKET",
    "https://discogs-data-dumps.s3.us-west-2.amazonaws.com",
)

# --- Server -----------------------------------------------------------------
HOST = os.environ.get("AOTD_HOST", "127.0.0.1")
PORT = int(os.environ.get("AOTD_PORT", "8000"))

# Allow cross-origin requests (useful if you later host the UI separately).
CORS_ALLOW_ORIGIN = os.environ.get("AOTD_CORS_ORIGIN", "")  # "" = disabled

# --- Logging + observability (H1.5 part 2) ----------------------------------
# The only logging used to be print() calls in server.main(), which gunicorn
# never calls, so the hosted app logged almost nothing. server.py now configures
# the stdlib logging module with a JSON formatter at app creation and emits one
# structured request-completion line per call; gunicorn's stdout flows to the
# Render logs. The line carries method/path/status/latency + an opaque request id
# and the resolved user_id (also an opaque UUID) — and NEVER the Authorization
# header, request/response bodies, the raw query string, or any secret.
LOG_LEVEL = os.environ.get("AOTD_LOG_LEVEL", "INFO")

# --- Rate limiting (H1.5 part 2) --------------------------------------------
# Coarse abuse caps on the public, unauthenticated endpoints, keyed on the real
# client IP (Render forwards it in X-Forwarded-For). Implemented with
# Flask-Limiter + in-memory storage, which is a hosted-only dependency
# (requirements-hosted.txt) imported lazily the way psycopg is: when the library
# isn't installed — local dev and the default test suite — no limiting is wired
# and the app behaves exactly as before. With 2 gunicorn workers the in-memory
# counters are per-worker (~2x the nominal cap); that's fine for coarse caps (we
# deliberately don't add Redis). Limits are strings in Flask-Limiter's syntax and
# are read per-request, so they can be overridden by env (or by a test).
#
# Default OFF, enabled explicitly in the hosted env (render.yaml sets
# AOTD_RATE_LIMIT=1). Keeping it off by default means simply having Flask-Limiter
# installed locally (e.g. to run the limiter tests) never silently changes how the
# rest of the suite behaves — the limiter tests opt in by overriding this flag.
RATE_LIMIT_ENABLED = os.environ.get("AOTD_RATE_LIMIT", "0") == "1"
# Strictest: outbound-triggering routes (iTunes/SSRF-guarded art + Wikipedia bio).
RATE_LIMIT_ART = os.environ.get("AOTD_RATELIMIT_ART", "20 per minute")
# Moderate: read-only catalog/search routes.
RATE_LIMIT_CATALOG = os.environ.get("AOTD_RATELIMIT_CATALOG", "120 per minute")
# The /api/feedback local fallback (in prod feedback goes browser->Supabase).
RATE_LIMIT_FEEDBACK = os.environ.get("AOTD_RATELIMIT_FEEDBACK", "10 per hour")
# Authenticated /api/sync/*: generous per-user/-IP cap rather than exempt.
RATE_LIMIT_SYNC = os.environ.get("AOTD_RATELIMIT_SYNC", "600 per minute")
# The public, unauthenticated /api/access-request (a guest asking for an invite).
# Strict: it's an open write path, and a real person asks once, not in bursts.
RATE_LIMIT_ACCESS = os.environ.get("AOTD_RATELIMIT_ACCESS", "5 per hour")

# --- Security headers (H1.3 hardening) --------------------------------------
# The app sends a strict Content-Security-Policy + related headers on every
# response (see server.security_headers). Set AOTD_CSP_REPORT_ONLY=1 to send the
# policy as Content-Security-Policy-Report-Only instead of enforcing it — useful
# for a first in-browser pass where violations are logged to the console but
# nothing is blocked. Default (0) enforces.
CSP_REPORT_ONLY = os.environ.get("AOTD_CSP_REPORT_ONLY", "0") == "1"

# --- Artwork fetching -------------------------------------------------------
# iTunes Search API: free, no key, ~20 requests/min soft limit. We stay polite.
ITUNES_ENDPOINT = "https://itunes.apple.com/search"
ITUNES_COUNTRY = os.environ.get("AOTD_ITUNES_COUNTRY", "US")
# Seconds to sleep between artwork API calls in the *bulk* fetcher (respects
# rate limits). On-demand fetches while browsing are spread out by the user, so
# they don't sleep.
ART_REQUEST_DELAY = float(os.environ.get("AOTD_ART_DELAY", "1.5"))
# Cache the image *bytes* locally (F13). Discogs data is CC0 and an image *URL*
# is just a link, but re-hosting the downloaded bytes from a public host is a
# licensing problem. So this is a flag, not a hard rule:
#   1 (default) -> download + cache covers under static/art/. Fully offline,
#                  fastest; right for the local build.
#   0           -> hotlink mode: never download bytes; store only the metadata
#                  (artwork_url + apple_music_url, both just links) and let the
#                  browser load the remote cover directly. Use for a public host.
# In hotlink mode the server never fetches a user-supplied image either, which
# also sidesteps the "Fix art" SSRF risk.
CACHE_ART_BYTES = os.environ.get("AOTD_CACHE_ART_BYTES", "1") == "1"
# --- Art download hardening (S1: SSRF guard) --------------------------------
# Every cover download (automatic *and* the user-supplied "Fix art" URL) is
# fetched through fetch_art._safe_get_image, which only allows these hosts, only
# over HTTPS, rejects any URL that resolves to a private/loopback/link-local IP,
# re-validates every redirect hop, and caps the response size + content-type to
# real images. Tune the allowlist if you add another art source.
#   AOTD_ART_ALLOWED_HOSTS : comma-separated host suffixes (default below)
#   AOTD_ART_MAX_BYTES     : hard cap on a downloaded image (default 10 MiB)
#   AOTD_ART_MAX_REDIRECTS : redirect hops to follow, each re-validated
ART_ALLOWED_HOSTS = tuple(
    h.strip().lower()
    for h in os.environ.get(
        "AOTD_ART_ALLOWED_HOSTS",
        # Apple/iTunes artwork CDNs, the Cover Art Archive, and the Internet
        # Archive storage nodes that CAA redirects to.
        "mzstatic.com,apple.com,coverartarchive.org,archive.org",
    ).split(",")
    if h.strip()
)
ART_MAX_BYTES = int(os.environ.get("AOTD_ART_MAX_BYTES", str(10 * 1024 * 1024)))
ART_MAX_REDIRECTS = int(os.environ.get("AOTD_ART_MAX_REDIRECTS", "4"))
# Decompression-bomb / junk guard (S5). The size cap above bounds the bytes on
# the wire, but a tiny file can still decode to enormous pixel dimensions, so a
# cover is also rejected if it exceeds these caps before being cached to disk.
# The check reads only the image header via Pillow when it is installed; when it
# isn't (Pillow is an optional dependency) the magic-byte + size guards still
# apply and only this dimension check is skipped. Headroom is generous so legit
# high-res covers (a few thousand px) pasted via "Fix art" are never rejected.
#   AOTD_ART_MAX_PIXELS    : cap on width*height (default 40 megapixels)
#   AOTD_ART_MAX_DIMENSION : cap on either side in px (default 10000)
ART_MAX_PIXELS = int(os.environ.get("AOTD_ART_MAX_PIXELS", str(40 * 1000 * 1000)))
ART_MAX_DIMENSION = int(os.environ.get("AOTD_ART_MAX_DIMENSION", "10000"))

# --- Artist bios (A4) -------------------------------------------------------
# Optional, no-key artist blurbs shown only when the user opens the bio door in
# an album's story view (pull-only, never auto-surfaced). Sourced from the
# Wikipedia REST summary and cached — hits AND misses — in their own small
# SQLite file so the network is asked at most once per artist and a catalog
# rebuild never touches it. Fetched through safefetch (the shared SSRF guard).
BIO_DB_PATH = Path(os.environ.get("AOTD_BIO_DB", DATA_DIR / "bio.db"))
BIO_ALLOWED_HOSTS = tuple(
    h.strip().lower()
    for h in os.environ.get(
        "AOTD_BIO_ALLOWED_HOSTS",
        "wikipedia.org,wikimedia.org,musicbrainz.org",
    ).split(",")
    if h.strip()
)
BIO_MAX_BYTES = int(os.environ.get("AOTD_BIO_MAX_BYTES", str(1 * 1024 * 1024)))
BIO_MAX_REDIRECTS = int(os.environ.get("AOTD_BIO_MAX_REDIRECTS", "4"))

# MusicBrainz / Cover Art Archive fallback.
MUSICBRAINZ_ENDPOINT = "https://musicbrainz.org/ws/2/release-group"
USER_AGENT = os.environ.get(
    "AOTD_USER_AGENT",
    "AlbumOfTheDay/1.0 (personal use)",
)


# --- Background artwork prefetch (F3) ---------------------------------------
# When the server is running, fill covers for the days you'll view in the
# background so browsing is instant. Scope is today (+ a few days ahead),
# never the whole catalog.
PREFETCH_ENABLED = os.environ.get("AOTD_PREFETCH", "1") == "1"
# How many days *after* today to also pre-cache (0 = today only).
PREFETCH_DAYS_AHEAD = int(os.environ.get("AOTD_PREFETCH_DAYS", "0"))
# Seconds between prefetch lookups (throttle to stay friendly with iTunes).
PREFETCH_DELAY = float(os.environ.get("AOTD_PREFETCH_DELAY", "0.8"))


def ensure_dirs():
    """Create all working directories if missing."""
    for d in (DATA_DIR, DUMP_DIR, ART_DIR):
        Path(d).mkdir(parents=True, exist_ok=True)


def feedback_dir():
    """The feedback store, read fresh from the (possibly test-overridden)
    FEEDBACK_DIR each call so it always reflects the current config."""
    return Path(FEEDBACK_DIR)
