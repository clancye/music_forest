/* Music Forest service worker — app-shell cache for the installable PWA.
 *
 * Deliberately conservative so it can never interfere with the E2EE / auth path:
 *
 *   - Same-origin shell assets  -> cache-first (instant repeat loads, offline shell).
 *   - /api/*                    -> NOT intercepted: always live network (auth, sync,
 *                                  feedback, ciphertext are never cached/served stale).
 *   - Cross-origin (jsDelivr CDN scripts, Supabase, mzstatic/Apple art)
 *                               -> NOT intercepted: requests pass straight to the
 *                                  network so SRI validation, the magic-link auth
 *                                  round-trip, and hotlinked art are untouched.
 *   - Navigations               -> network-first, falling back to the cached shell
 *                                  (offline shows the lock screen; data still needs net).
 *
 * Updates: bump VERSION on every deploy. The new worker installs, takes over on the
 * next load (skipWaiting + clients.claim), and `activate` deletes the old cache.
 * No user-facing "refresh?" prompt by design — see H1.3 decision 1.
 */
const VERSION = 'v226';
const CACHE = `forest-shell-${VERSION}`;

// The same-origin app shell. Cross-origin CDN scripts are intentionally absent:
// the browser fetches + SRI-validates them, and opaque cross-origin responses
// must not be cached here.
const SHELL = [
  '/',
  '/static/style.css',
  '/static/crypto.js',
  '/static/sync.js',
  '/static/feedback-sync.js',
  '/static/journal-store.js',
  '/static/strings.js',
  '/static/app.js',
  '/static/onboarding.js',
  '/static/whatsnew.js',
  '/static/guest-buffer.js',
  '/static/store-bridge.js',
  '/static/device-trust.js',
  '/static/auth-ui.js',
  '/static/migrate.js',
  '/static/sw-register.js',
  '/static/manifest.webmanifest',
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png',
  '/static/icons/maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // Best-effort: a single 404 (e.g. a renamed asset) must not abort the whole
      // install, or the SW would never take over. Cache each entry independently.
      Promise.all(SHELL.map((url) =>
        cache.add(new Request(url, { cache: 'reload' })).catch(() => null)
      ))
    ).then(() => self.skipWaiting())
  );
});

// The page (auth-ui applyUpdateAndReload) can nudge a still-waiting worker to take
// over so the reload lands on the new shell in ONE go, not two. Auto-skipWaiting in
// install already covers the common case; this is the belt-and-suspenders path.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('forest-shell-') && k !== CACHE)
            .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only ever touch GETs.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Cross-origin (jsDelivr, Supabase, mzstatic/Apple) -> hands off entirely.
  if (url.origin !== self.location.origin) return;

  // The operator console -> hands off entirely. Admin assets are outside the
  // SHELL precache by design, but the runtime cache below still made them
  // sticky until the next VERSION bump (live /admin ran a stale admin.js,
  // 2026-07-03). Operator tooling wants network-fresh always, and offline
  // support is meaningless for it.
  if (url.pathname === '/admin' || url.pathname.startsWith('/static/admin.')) return;

  // Standalone docs (/architecture -> the arch guide; /privacy + /terms -> the legal
  // pages; /welcome -> the beta onboarding guide) -> hand off entirely. Each is a
  // self-contained document opened outside the app shell; the navigate branch below
  // caches any ok document under the SHELL key '/', so without this bypass, opening one
  // would overwrite the cached app shell. Offline support is moot for these reference docs.
  if (url.pathname === '/architecture'
      || url.pathname === '/privacy' || url.pathname === '/terms'
      || url.pathname === '/welcome') return;

  // Live API surface (auth / sync / feedback / catalog) -> never cached.
  if (url.pathname.startsWith('/api/')) return;

  // Deploy-state probes -> hands off entirely. /version is the update gate:
  // auth-ui compares it against the running build to decide "a new version is
  // fully live, reload is safe". The runtime cache below was answering it with
  // the PREVIOUS build's body (Cache Storage ignores the fetch's no-store,
  // which only bypasses the HTTP cache), so the updater concluded "still
  // rolling out" forever — the same stickiness class as the pre-v73 /admin
  // bug. These must always be the live host's answer or a real failure.
  if (url.pathname === '/version' || url.pathname === '/healthz') return;

  // Navigations -> network-first, fall back to the cached shell when the live
  // document isn't usable — whether the network rejects (offline) OR the origin
  // answers with a server error.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          // A 502/503/504 during Render's instance-swap (deploy) is a RESOLVED
          // response, not a network rejection, so the offline .catch() below never
          // sees it. Without this the installed PWA would render the gateway's 502
          // page even though a good shell is cached. Treat any 5xx like an outage:
          // serve the cached shell so the app still opens (its /api/* calls retry
          // live and fill in once the host is back). Fresh installs with no cache
          // yet still get the real response so a genuine error isn't masked.
          if (resp && resp.status >= 500) {
            return caches.match('/').then((hit) => hit || resp);
          }
          // Keep the cached document fresh for offline use.
          if (resp && resp.ok && resp.type === 'basic') {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put('/', copy)).catch(() => {});
          }
          return resp;
        })
        .catch(() => caches.match('/').then((hit) => hit || caches.match(req)))
    );
    return;
  }

  // Same-origin static assets -> cache-first, with best-effort runtime caching.
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((resp) => {
        if (resp && resp.ok && resp.type === 'basic') {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return resp;
      });
    })
  );
});
