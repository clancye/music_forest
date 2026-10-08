"use strict";

// Build tag of the code ACTUALLY RUNNING (mirror of sw.js VERSION). The update
// watcher (auth-ui.js) judges "a newer version is live" against THIS, not the
// service-worker cache name — because the worker can swap its cache to a new build
// in the background while a resumed PWA keeps running old code, which made a stale
// page wrongly report "up to date". BUMP THIS WITH sw.js VERSION on any shell change.
window.__MF_BUILD = "v358";

// --- tiny helpers -----------------------------------------------------------
const $ = (sel) => document.querySelector(sel);

// R8: read a user-facing string from the central catalog (static/strings.js),
// falling back to the literal passed here. The fallback is deliberate: a missing
// key or an unloaded catalog degrades to the original wording instead of blanking
// the UI, so wiring a call site through the catalog can never regress its copy.
function str(path, fallback) {
  try {
    const v = (typeof AOTDStrings !== "undefined") ? AOTDStrings.get(path) : undefined;
    return v == null ? fallback : v;
  } catch (e) { return fallback; }
}
const esc = (s) => (s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Escape a value for use inside a single-quoted CSS url('…') (S6), used for
// every cover we drop into style="background-image:url('…')". A single pass
// handles both layers: HTML-escape &<>" for the surrounding attribute, and
// percent-encode the CSS-breakout chars ' ( ) \ and newlines (a stray one could
// close the url() and inject CSS). Note ' -> %27, NOT the HTML entity &#39;: CSS
// does not decode entities, so only percent-encoding neutralizes the quote here.
// (Covers are server-built URLs today, so this is defense-in-depth.)
const cssUrl = (s) => (s ?? "").replace(/[&<>"'()\\\n\r]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
     "'": "%27", "(": "%28", ")": "%29", "\\": "%5C",
     "\n": "%0A", "\r": "%0D" }[c]));

// Render a note's markdown body to a SAFE subset of HTML. The cardinal rule:
// escape everything first, so no user-supplied markup can survive — we only ever
// ADD our own tags afterward. Links are restricted to http/https. Supported:
// **bold**, _italic_, `code`, [text](url), bare URLs.
function renderMarkdown(src) {
  let s = esc(src || "");
  s = s.replace(/`([^`]+)`/g, (m, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^_\w])_([^_]+)_(?!\w)/g, "$1<em>$2</em>");
  // [text](http(s)://url) — url was escaped, so " can't break the attribute.
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (m, text, url) =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`);
  // bare URLs (only when preceded by start/whitespace, so we don't touch hrefs)
  s = s.replace(/(^|\s)(https?:\/\/[^\s<]+)/g,
    (m, pre, url) =>
      `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  return s;
}

// --- toast (D3 undo) --------------------------------------------------------
let _toastTimer = null;
function showToast(message, actionLabel, actionFn, timeout = 6000) {
  const el = $("#toast");
  if (!el) return;
  el.innerHTML = "";
  // ACC1 C [4.1.3]: un-hide FIRST, so the role="status" region is in the a11y tree
  // when we insert the message text below — a display:none live region can't announce.
  el.classList.remove("hidden");
  const span = document.createElement("span");
  span.textContent = message;
  el.appendChild(span);
  if (actionLabel && actionFn) {
    const b = document.createElement("button");
    b.className = "toast-action";
    b.textContent = actionLabel;
    b.addEventListener("click", () => { hideToast(); actionFn(); });
    el.appendChild(b);
  }
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(hideToast, timeout);
}
function hideToast() { const el = $("#toast"); if (el) el.classList.add("hidden"); }

function mdParam() {
  // The daily pick is year-independent — always today's month + day (owner
  // 2026-07-05: no date control on Choose, nothing to choose). Kept as a function
  // so every caller that appends ?date=MM-DD stays unchanged.
  return todayMD();
}

function todayMD() {
  // Local MM-DD for "are we on today?" checks (the date picker defaults here).
  const n = new Date();
  return `${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

function mdDisplay(md) {
  // "07-03" -> "July 3" for prose like the subtitle. A bare MM-DD reads as
  // DD-MM in much of the world (U18: "07-03" greeted first-timers as a riddle).
  const [m, d] = String(md || "").split("-").map(Number);
  const names = ["January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December"];
  if (!m || !d || !names[m - 1]) return md;
  return `${names[m - 1]} ${d}`;
}

// A coarse, NON-identifying tier flag sent on catalog reads, so the operator's Usage
// panel can tell guest activity from account activity. It is NOT a user id and carries
// nothing about who you are — just which tier this session is in (local single-user,
// hosted guest, or hosted account). The server only ever counts it.
function clientMode() {
  if (!window.AOTD_HOSTED) return "local";
  return window.AOTD_GUEST ? "guest" : "account";
}
// Searches carry the same coarse tier flag, so the Log can split them (2026-10-07).
const SEARCH_OPTS = () => ({ headers: { "X-MF-Mode": clientMode() } });
function api(path, extra) {
  const md = mdParam();
  const opts = { headers: Object.assign({ "X-MF-Mode": clientMode() }, extra || {}) };
  if (!md) return fetch(path, opts).then((r) => r.json());
  // Append the date param without clobbering any query string the caller already
  // put on the path (e.g. the pool seam's "/api/pool/pick?n=2").
  const sep = path.includes("?") ? "&" : "?";
  return fetch(path + sep + "date=" + md, opts).then((r) => r.json());
}

// --- client feature flags (P3 data-access seam) -----------------------------
// One boot fetch of /api/config decides whether the daily surfaces draw from the
// unified pool (/api/pool/*) or the legacy catalog endpoints (/api/choice|day).
// Defaults to legacy, and a failed/absent fetch stays legacy, so the cutover is
// dark until the host sets AOTD_USE_POOL. The bigger uid re-key + door fill + dig
// toggle ride on top of this in a later step; this is just the endpoint switch.
const clientConfig = { pool_enabled: false };

// Dig mode (P3): the day view with the availability gate OFF — the full union for
// the day, including albums with no confirmed stream yet. Only meaningful when the
// pool is serving; the toggle is hidden otherwise.
let digMode = false;

async function loadClientConfig() {
  try {
    const c = await (await fetch("/api/config")).json();
    if (c && typeof c === "object") Object.assign(clientConfig, c);
  } catch (e) {
    // Stay on the legacy endpoints — failing safe to the path that always works.
  }
}

function poolOn() {
  return !!clientConfig.pool_enabled;
}

// The seam: the one place that maps the daily surface to its endpoint. With the
// flag off this is exactly the legacy path, so nothing changes until the flip. The
// Today deck reads the whole day via dayEndpoint (D1) — the two-record /api/pool/pick
// draw is gone with the keep model.
function dayEndpoint() {
  if (!poolOn()) return "/api/day";
  if (digMode) return "/api/pool/day?dig=1";             // dig is ALWAYS unfiltered
  const keys = filterPlatformKeys();
  return keys.length ? "/api/pool/day?platforms=" + keys.join(",") : "/api/pool/day";
}

// The dig toggle lives on Choose, so it shows whenever the pool is serving; legacy
// mode never sees it (the legacy /api/choice has no full-union mode).
function updateDigVisibility() {
  const wrap = $("#digWrap");
  if (!wrap) return;
  wrap.classList.toggle("hidden", !poolOn());
}

// --- card rendering ---------------------------------------------------------
// rid -> {artist, title}, so the Fix artwork door always knows what it's editing.
const albumIndex = {};
// rid -> the full album object last rendered, so the story door (U3) can show
// an album's threads without re-fetching it.
const albumData = {};

function isRemoteUrl(u) {
  return /^https?:\/\//i.test(u || "");
}

// A stable hue (0–359) derived from the release id, so each coverless album
// gets its own tint via the --ph-hue custom property the placeholder CSS reads.
// Deterministic: the same album always lands on the same colour.
function phHue(rid) {
  const s = String(rid == null ? "" : rid);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

// --- universal album identity (P3 M2) ---------------------------------------
// Album identity is the source-agnostic uid: 'd:<release_id>' for a Discogs
// album, 'm:<album_id>' for an MB-only one. A legacy albums.db row (no uid) folds
// onto the same namespace via 'd:'+release_id, so the whole app keys on one thing
// whether the row came from the pool or the catalog. release_id is provenance.
function albumKey(a) {
  if (!a) return null;
  if (a.uid) return a.uid;
  return a.release_id != null ? "d:" + a.release_id : null;
}

// The numeric Discogs release_id inside a 'd:<id>' uid, else null (an 'm:' uid has
// no albums.db release). Used wherever a server route still needs the numeric id
// (art fetch/set, tracklists, the /api/albums catalog join-back).
function ridFromUid(uid) {
  const s = String(uid == null ? "" : uid);
  if (s.startsWith("d:")) {
    const t = s.slice(2);
    if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  }
  return null;
}

// v8: classify a note target by its uid prefix — 'free' (no uid), 'album' (d:/m:),
// 'artist' (art:), 'person' (per:), 'track' (trk:), else 'other'. Mirrors
// journal.py kind_from_uid / journal-store.js kindFromUid. A typed target carries a
// `ref` snapshot on save (there's no catalog row to hydrate it from later).
function kindFromUid(uid) {
  if (uid == null || uid === "") return "free";
  const s = String(uid);
  if (s.startsWith("d:") || s.startsWith("m:")) return "album";
  if (s.startsWith("art:")) return "artist";
  if (s.startsWith("per:")) return "person";
  if (s.startsWith("trk:")) return "track";
  return "other";
}

// Remember an album's names without ever clobbering known ones with empties —
// a journal row that lost its artist/title snapshot (feedback #15: an MB-only
// note rendered a fully blank shelf card) must not erase names another card in
// the same view already taught us. Returns the best names we have.
function rememberNames(key, artist, title) {
  const cur = albumIndex[key] || {};
  albumIndex[key] = {
    artist: artist || cur.artist || "",
    title: title || cur.title || "",
  };
  return albumIndex[key];
}

// The text a coverless card carries. Never empty: a card with no art and no
// words is a hole in the shelf (feedback #15) — own the unknown out loud.
function coverLabel(names) {
  return (names.artist || names.title)
    ? `${names.artist} — ${names.title}` : "Unknown album";
}

// The ONE place that resolves album identity from the server catalog. Given uids,
// batch-fetch /api/albums and cache each hit — the full album in albumData, the name
// in the clobber-safe albumIndex (rememberNames). Every surface that can hold a STALE
// or nameless journal snapshot (the story door on open, the Notes shelf, …) heals
// through this, so "re-resolve a fold-orphaned / MB-only album (B22)" lives once
// instead of being re-invented per surface. Returns the {uid: album} map the server
// sent (empty on offline/failure — callers keep whatever fallback they already had).
async function resolveAlbums(uids) {
  const ids = [...new Set(uids.filter(Boolean))];
  if (!ids.length) return {};
  let got = {};
  try {
    const data = await (await fetch(
      "/api/albums?ids=" + encodeURIComponent(ids.join(",")))).json();
    got = data.albums || {};
  } catch (e) { return {}; }             // offline: caller keeps its fallback
  for (const [uid, a] of Object.entries(got)) {
    if (!a) continue;
    albumData[uid] = a;
    rememberNames(uid, a.artist, a.title);
  }
  return got;
}

function coverHtml(a, opts) {
  const key = albumKey(a);
  const names = rememberNames(key, a.artist, a.title);
  albumData[key] = a;
  // FB#98 (owner): "I don't like the fix art button. let's remove that from
  // everywhere." It sat on every cover in the app — a maintenance control in the
  // reader's way, on the one image the record is meant to be met through. The
  // capability itself is intact (the Fix artwork door, /api/art/*); it's just no
  // longer wearing a button on every album. See openArtModal for how to reach it.
  // `opts.fix` is now vestigial and ignored — kept off the signature's callers so
  // this stays a one-line change if the button ever comes back.
  const fix = "";
  // Local cached file (served by us) — always available, render inline.
  if (a.cover && !isRemoteUrl(a.cover)) {
    return `<div class="cover" data-rid="${esc(key)}"
      style="background-image:url('${cssUrl(a.cover)}')">${fix}</div>`;
  }
  // Remote hotlink (F13 hotlink mode): start as a placeholder carrying the URL;
  // a post-render pass loads it and falls back gracefully if the link is dead.
  if (a.cover) {
    return `<div class="cover placeholder" data-rid="${esc(key)}"
      style="--ph-hue:${phHue(key)}"
      data-cover="${esc(a.cover)}">${esc(coverLabel(names))}${fix}</div>`;
  }
  return `<div class="cover placeholder" data-rid="${esc(key)}"
    style="--ph-hue:${phHue(key)}">${esc(coverLabel(names))}${fix}</div>`;
}

// A1: the artist name is a button that jumps to an artist-scoped catalog
// search (Browse · All dates · field=Artist). Rendered everywhere a card shows
// an artist so "more from this artist" is always one click away.
function artistLink(name) {
  return `<button class="artist-link" data-artist="${esc(name)}"
    title="See more from ${esc(name)}">${esc(name)}</button>`;
}

// FB#46/#63: split a compound headline credit into its individual artists, so each
// (a composer, a performer) becomes its own pullable thread. MB-only classical
// albums carry no structured credits and no artist array — the names live ONLY in
// this flat string ("Beethoven, Schubert; Wiener Philharmoniker, Karl Böhm") — so a
// careful split is the only way to surface them. Guardrails against over-splitting a
// single band name: semicolons + feat/with introduce distinct acts and always split;
// a comma splits too UNLESS the segment reads as one band ("&", "+", or " and " almost
// always joins a single act — "Earth, Wind & Fire", "Crosby, Stills, Nash & Young").
function splitArtistCredit(str) {
  const s = (str || "").trim();
  if (!s) return [];
  const groups = s.split(/;|\s+(?:feat\.?|featuring|ft\.?|with)\s+/i);
  const out = [];
  for (let g of groups) {
    g = g.trim();
    if (!g) continue;
    if (/[&+]|\sand\s/i.test(g)) { out.push(g); continue; }   // one act, keep whole
    for (const part of g.split(",")) {
      const p = part.trim();
      if (p) out.push(p);
    }
  }
  const seen = new Set(), uniq = [];
  for (const a of out) {
    const k = a.toLowerCase();
    if (!seen.has(k)) { seen.add(k); uniq.push(a); }
  }
  return uniq.slice(0, 6);
}

// H1.B2 — native streaming deep links (mobile only).
// A phone is where "the link opened the website, not the app" stings. We only
// have reliable, documented *search* URI schemes for a couple of services; for
// those we emit a deep link the click handler tries first, with the web URL as a
// graceful fallback when the app isn't installed (see wireDeepLinks).
// Coarse platform bucket from a UA string + touch-point count — one place, so the
// listen-tap logic and isMobileUA can't drift. iPadOS reports a Mac UA, so a "Mac"
// with multiple touch points is really an iPad (treat as iOS); a Mac with none is a
// real desktop. Pure (args, not globals) so it's unit-testable.
function uaPlatform(ua, touchPoints) {
  ua = ua || "";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  if (/Macintosh|Mac OS X/i.test(ua))
    return (touchPoints || 0) > 1 ? "ios" : "mac-desktop";
  return "other";
}
function isMobileUA() {
  const p = uaPlatform(navigator.userAgent, navigator.maxTouchPoints || 0);
  return p === "ios" || p === "android";
}
// B34: a real desktop Mac. The Apple Music app SHIPS with macOS, so its music://
// scheme is guaranteed to resolve there — the one desktop platform where a Listen
// tap can safely open a native app instead of the web player.
function isMacDesktop() {
  return uaPlatform(navigator.userAgent, navigator.maxTouchPoints || 0) === "mac-desktop";
}
// #5: are we running as an installed PWA (no browser chrome, a single window)?
// In that mode a normal link — even target=_blank — replaces the app's only
// window, so a Listen link lands you on YouTube/Bandcamp with no way back. We
// detect it so external links can be opened in a separate browser context
// instead, keeping the app one app-switch away. (display-mode for Android/desktop
// installs; navigator.standalone for iOS home-screen apps.)
function isStandalone() {
  return (window.matchMedia &&
          window.matchMedia("(display-mode: standalone)").matches) ||
         window.navigator.standalone === true;
}

// FB#13: native-app handoff for the EXACT confirmed links ("opening the YouTube
// link opens YouTube inside this app… I could switch back and keep using it").
// Derive a per-platform app scheme from the exact web URL; wireDeepLinks tries
// it first and falls back to the web link when the app isn't installed, so a
// wrong/dud scheme can never be worse than today's behavior. Only documented,
// stable schemes — a platform we can't map just keeps its plain web link.
function appDeepLink(key, url) {
  let m;
  if (key === "spotify"
      && (m = url.match(/open\.spotify\.com\/(album|track|playlist)\/([A-Za-z0-9]+)/)))
    return `spotify:${m[1]}:${m[2]}`;
  if (key === "apple" && /^https?:\/\/(geo\.)?music\.apple\.com\//.test(url))
    // Drop a `geo.` prefix too: Music.app opens music://music.apple.com/… but not
    // the geo. redirector host.
    return url.replace(/^https?:\/\/(geo\.)?/, "music://");
  if (key === "deezer"
      && (m = url.match(/deezer\.com\/(?:[a-z]{2}\/)?(album|track|playlist)\/(\d+)/)))
    return `deezer://www.deezer.com/${m[1]}/${m[2]}`;
  // (Tidal's app-scheme handler was removed 2026-08-27 with the platform itself.)
  // Plain youtube.com watch links: the main YouTube app's registered scheme.
  // music.youtube.com is handled by the Android intent below (YT Music has no
  // public scheme); on iOS its universal link does the handoff from Safari.
  if (key === "youtube" && !/music\.youtube\.com/.test(url)
      && (m = url.match(/[?&]v=([\w-]+)/)))
    return `vnd.youtube:${m[1]}`;
  return "";
}

// Android-only: a Chrome intent: URL that opens a specific app by package.
//  • YouTube Music has no public URI scheme, so the intent is its only handoff;
//    an unresolvable intent (app missing) is a no-op, so wireDeepLinks' timer
//    still delivers the web fallback in a separate context.
//  • Apple (B34): music:// is an iOS/macOS scheme and doesn't resolve on Android,
//    so without this Apple falls through to the web preview page on a Pixel etc.
//    The intent opens the Apple Music app to the exact album; its host is always
//    music.apple.com (a single verified intent-filter host), and a
//    browser_fallback_url sends the app-less straight to the web player instead of
//    erroring or Play-Store-bouncing.
// Bandcamp was tried here (v68) and deliberately REVERTED: its app-link
// verification doesn't cover the per-artist subdomains our exact album URLs
// live on, so Android refuses the explicit intent and bounces to the Play
// Store listing even with the app installed (owner-observed: "opens up the
// app store… too many steps"). No documented scheme + unverifiable host =
// keeps its plain web link (a Custom Tab overlay; the PWA stays underneath).
function appIntentLink(key, url) {
  if (key === "youtube") {
    const m = url.match(/^https?:\/\/(music\.youtube\.com\/[^#]*)/);
    if (!m) return "";
    return `intent://${m[1]}#Intent;scheme=https;`
      + `package=com.google.android.apps.youtube.music;end`;
  }
  if (key === "apple") {
    const m = url.match(/^https?:\/\/(?:geo\.)?(music\.apple\.com\/[^#]*)/);
    if (!m) return "";
    return `intent://${m[1]}#Intent;scheme=https;`
      + `package=com.apple.android.music;`
      + `S.browser_fallback_url=${encodeURIComponent(url)};end`;
  }
  return "";
}

// The data-* attributes wireDeepLinks reads, for one confirmed link — plus
// data-listen, the service key wireListenCount's anonymous tap counter reads.
function listenAttrs(key, url) {
  const app = appDeepLink(key, url || "");
  const intent = appIntentLink(key, url || "");
  return ` data-listen="${esc(key)}"`
    + (app ? ` data-app="${esc(app)}"` : "")
    + (intent ? ` data-intent="${esc(intent)}"` : "");
}

// The CONFIRMED Listen door (P3): big-four streaming platforms only (owner's
// call), in a fixed render order, each mapped to its existing CSS class code
// (sp/am/yt/dz). STRICT confirmed-only — every link is exact, a place the album
// is GUARANTEED listenable, so there are no blind searches and no "not here"
// guessing (that's why the marks UI is retired). Deezer + the exact Apple link
// are known when a card first renders; Spotify / YouTube Music are filled by the
// lazy door (fillDoorOnOpen) when you open the album.
// Tidal / Amazon Music / Pandora were removed 2026-08-27: they only ever came from the
// Odesli (song.link) fan-out, whose keyless API was permanently retired 2026-08-19, so
// they can no longer be refreshed or honestly confirmed. Mirrors db.PLATFORM_ORDER /
// reqparams._FILTER_PLATFORM_KEYS / poolshape._ODESLI_EXTRA_KEYS on the server.
const CONFIRMED_PLATFORMS = [
  ["spotify", "sp", "Spotify"],
  ["apple", "am", "Apple Music"],
  ["youtube", "yt", "YouTube Music"],
  ["deezer", "dz", "Deezer"],
  ["bandcamp", "bc", "Bandcamp"],
];

// --- preferred listening platforms (a strict show-only filter) ---------------
// VISION: the user names the services they actually use, and the Listen door
// shows ONLY those — every album still surfaces (this never touches the pool or
// the daily pick), but the door is filtered to your platforms. Stored locally (a
// device UI preference, like a theme — never the journal's E2EE data). Applied
// via one injected <style>, so it re-filters every rendered AND future door
// instantly, with no re-render.
const LISTEN_PREF_KEY = "mf-listen-platforms/v1";
const _platClass = Object.fromEntries(
  CONFIRMED_PLATFORMS.map(([key, cls]) => [key, cls]));
const _platLabel = Object.fromEntries(
  CONFIRMED_PLATFORMS.map(([key, , label]) => [key, label]));

function loadListenPrefs() {
  try {
    const v = JSON.parse(localStorage.getItem(LISTEN_PREF_KEY));
    return Array.isArray(v) ? v.filter((k) => _platClass[k]) : [];
  } catch (e) { return []; }
}
function saveListenPrefs(keys) {
  try { localStorage.setItem(LISTEN_PREF_KEY, JSON.stringify(keys)); } catch (e) {}
}
function applyListenPrefStyle(keys) {
  let el = document.getElementById("listenPrefStyle");
  if (!el) {
    el = document.createElement("style");
    el.id = "listenPrefStyle";
    document.head.appendChild(el);
  }
  // STRICT: when you've named your services, the Listen door shows ONLY those —
  // every other confirmed platform's button is hidden, and a door that holds NONE
  // of your platforms is hidden whole (via :has) rather than opening onto nothing.
  // No prefs -> no rules, i.e. the door shows every confirmed platform (default).
  if (!keys.length) { el.textContent = ""; return; }
  const show = keys.map((k) => `.links a.${_platClass[k]}`).join(",\n") +
    " { display: block }";
  const hideEmptyDoor = ".listen" +
    keys.map((k) => `:not(:has(.links a.${_platClass[k]}))`).join("") +
    " { display: none }";
  el.textContent = ".links a { display: none }\n" + show + "\n" + hideEmptyDoor;
  recheckAppleArt(document);
}

// Visual confirmation that toggling your platforms reworked THIS page: a short
// highlight ripples across every Listen row on screen (so the change is felt even
// on collapsed doors), and the panel says what the door now shows.
function flashListenReflow() {
  document.querySelectorAll(".listen-row").forEach((el) => {
    el.classList.remove("pref-reflash");
    void el.offsetWidth;                 // restart the animation from 0
    el.classList.add("pref-reflash");
    setTimeout(() => el.classList.remove("pref-reflash"), 700);
  });
}
// --- surface-only-my-platforms filter ---------------------------------------
// Picking the services you use does two things at once: it filters the Listen door
// to those services AND surfaces only albums confirmed on them (the pick + browse).
// Pick nothing -> everything surfaces (default, so the broadened catalogue is never
// silently narrowed). Dig mode always ignores it (the escape hatch). Stored locally
// like a theme — a device UI pref, not the journal's E2EE data.
// The platforms we can CONFIRM for the CURRENT day's pool (exact links exist):
// Spotify, Apple, YouTube, Deezer. Spotify is warmed only for today + tomorrow (the
// on-demand door + the bounded prewarm, F22), so its filter is fully meaningful for
// the current day and "unknown" for distant days — same honesty as the others (dig
// always full, filtered-empty points to dig). Qobuz stays out (no source yet).
const FILTERABLE_PLATFORMS = ["spotify", "apple", "youtube", "deezer", "bandcamp"];

// The confirmable platforms currently selected — the exact filter set sent to the
// server. Empty => the filter is inert and everything surfaces.
function filterPlatformKeys() {
  const sel = new Set(loadListenPrefs());
  return FILTERABLE_PLATFORMS.filter((k) => sel.has(k));
}

// Priority-aware platform selection for the PICK page (Direction B). Pure: given
// the album's confirmed `platforms` map and the user's ordered pref array, return
// {primary, chips} as [key, cls, url, label] tuples in priority order. The first
// confirmed platform in priority order is the solid "Listen on ___" button; the
// rest become secondary chips. Honesty rule: only platforms with an exact
// confirmed link for THIS album ever appear — never a blind search.
//   - With a pref set, only the chosen platforms show (matches the pool/door
//     filter) and their stored order is the priority.
//   - With no pref, every confirmed platform shows in the canonical order, so a
//     first-run user still gets one clear primary button.
function pickListenPlatforms(platforms, prefs) {
  platforms = platforms || {};
  const order = (prefs && prefs.length)
    ? prefs
    : CONFIRMED_PLATFORMS.map(([k]) => k);
  const list = order
    .filter((k) => _platClass[k] && platforms[k])
    .map((k) => [k, _platClass[k], platforms[k], _platLabel[k]]);
  return { primary: list[0] || null, chips: list.slice(1) };
}

// The filtered-empty escape hatch, shared by Choose + Browse (feedback #5/#7): a
// clear dig pill (dig is ALWAYS unfiltered) instead of a bare hyperlink, plus the
// Spotify freshness caveat when Spotify is one of your filters — which is what
// makes an empty *distant* day make sense rather than look broken.
function filteredEmptyHtml(scope, where) {
  const spNote = filterPlatformKeys().includes("spotify")
    ? " Spotify is only checked for today and tomorrow, so distant days can look empty."
    : "";
  return `<div class="empty">
    <p class="empty-lead">Nothing on your platforms ${where}.${spNote}</p>
    <button class="dig-pill" data-dig-escape>
      <span aria-hidden="true">↓</span> Dig the whole ${esc(scope)}</button>
    <p class="empty-sub muted">Dig mode shows everything, including albums with no
      confirmed link yet — or change your platforms beside Listen on Today.</p>
  </div>`;
}

// A filter/selection change restacks what surfaces: drop the cached deck so Today
// is redrawn (with a fresh set-aside pile) from the newly-scoped pool, and reload
// the active date view.
function refreshSurfaces() {
  deckState = null;
  _openWhy = "platforms";              // the Log counts this open as a platform change
  const mode = currentMode();
  if (mode === "decide") loadDeck(true);
  else if (mode === "browse" && browseScope === "day") loadBrowse();
}

// --- A8 Phase 2: the opt-in genre filter for Today ---------------------------
// Session-scoped (a transient "today I want jazz", not a durable device pref like
// your platforms), applied CLIENT-SIDE: the day payload already carries each
// record's own tags, so filtering + the per-tag counts need no round-trip. A record
// with no tags on file can't match a tick, so a tag filter honestly hides it (the
// honesty rule) — the Genre screen says how many today carry none. Dig mode ignores
// the filter, the escape hatch. The ticked set still runs through the balanced deal, so
// "jazz + folk" interleaves rather than all-jazz-then-folk.
// (Until v336 a second set here filtered by the 13 hidden genre buckets; nothing on
// screen had set it since v332, and the buckets were retired 2026-10-04.)
//
// Owner 2026-09-24: the tags ticked on the Genre screen (#styleBrowse), held as merged
// tag KEYS (tagKey — "post rock" and "post-rock" are one key, v332). An EXACT match on a
// record's own tags, not a substring — so the count a row shows is exactly what ticking
// it yields ("house" is house, not also every tech house and deep house). Dig ignores it.
const genreTags = new Set();
// F31 (Today): the era facet — decades ("1980s") the reader has selected. It's a
// SECOND dimension that composes with the genres above: a record must match a chosen
// genre AND a chosen era (each dimension OR within itself). Filters the day we already
// hold — no refetch, no streaming query — so it's as cheap as the genre filter. Empty
// = every era; dig ignores it like everything else.
const deckEras = new Set();
// Owner 2026-07-26: the "By date" year span — a start/stop year that composes (AND) with
// the decade chips, the precise complement to the decade shortcuts. null = that end unbounded.
let deckYearFrom = null, deckYearTo = null;

function applyGenreFilter(list) {
  if (digMode) return list;                             // dig is ALWAYS unfiltered
  if (!genreTags.size) return list;
  return list.filter((r) => {
    const keys = recordTagKeys(r);         // merged spellings (v332)
    for (const k of genreTags) if (keys.has(k)) return true;
    return false;
  });
}

// A record's own tags — its genres (atomic-comma aware, via genresOf), its styles, and
// its MusicBrainz community tags (`tags`: moods, scenes, places — B2, owner 2026-10-04)
// — lowercased, as a Set. The one definition both the browse list's counts and the
// exact-tag filter read, so they can't disagree. Cached per record object.
const _recordTagCache = new WeakMap();
function recordTags(r) {
  let tags = _recordTagCache.get(r);
  if (!tags) {
    tags = new Set(genresOf(r).map((g) => g.toLowerCase()));
    for (const s of `${r.styles || ""},${r.tags || ""}`.split(",")) {
      const k = s.trim().toLowerCase();
      if (k) tags.add(k);
    }
    _recordTagCache.set(r, tags);
  }
  return tags;
}
// F31: the full deck filter — genres AND era, composed. The two dimensions AND together
// (a record must pass both); each is OR within itself. Dig ignores both. This is what
// the deal + the live count read, so the era facet narrows Today exactly like genres.
// The YEAR side of Filter on its own — decades (OR'd) AND a span — so each side of the
// screen can count under the other (owner 2026-10-05: "if 'acoustic' is selected, the
// 'years' filter should then show how many acoustic records are available"). The Tags
// tab counts under applyYearFilters; the decade chips count under the tags and the
// span (decades: false — a decade's own siblings don't narrow it). Dig ignores both.
function applyYearFilters(list, { decades = true } = {}) {
  if (digMode) return list;                             // dig is ALWAYS unfiltered
  let out = list;
  if (decades && deckEras.size) out = out.filter((r) => deckEras.has(decadeOf(r)));
  if (deckYearFrom != null) out = out.filter((r) => r.year && r.year >= deckYearFrom);
  if (deckYearTo != null) out = out.filter((r) => r.year && r.year <= deckYearTo);
  return out;
}

function applyDeckFilters(list) {
  return applyYearFilters(applyGenreFilter(list));
}

// How many filters are set: the one Filter pill counts both tabs (2026-10-04: Genre and
// Year became one button), and each tab on the Filter screen counts its own. A year
// span counts as one, however many years it covers.
function updateGenreTally() {
  const gn = genreTags.size;
  const dn = deckEras.size + ((deckYearFrom != null || deckYearTo != null) ? 1 : 0);
  const set = (id, n) => {
    const el = document.getElementById(id);
    if (el) { el.hidden = n === 0; el.textContent = " · " + n; }
  };
  set("filterTally", gn + dn);
  set("sbTagsN", gn);
  set("sbYearN", dn);
}

// The Year panel's note carries the live combined count (genre AND date compose), so
// it confirms what Today holds now ("786 records match" vs "none"). The Genre screen
// shows the same number on its Show button (renderStyleBrowseTray).
function setGenrePrefNote() {
  const active = !!(genreTags.size || deckEras.size
    || deckYearFrom != null || deckYearTo != null);
  const n = (active && deckState && deckState.all) ? applyDeckFilters(deckState.all).length : 0;
  const matchTxt = n
    ? `${n.toLocaleString()} record${n === 1 ? "" : "s"} match.`
    : "No records today match — try another, or dig.";
  const setNote = (id, emptyMsg) => {
    const note = document.getElementById(id);
    if (!note) return;
    note.classList.toggle("on", active);
    note.textContent = active ? matchTxt : emptyMsg;
  };
  setNote("datePrefNote", "Pick a decade or set a year span to narrow today.");
}

// Re-sync everything that reads the filter state: the Year tab's decade chips and note,
// the tallies, and the Filter screen's tray (what's set + "Show N records"). (Until v328
// this also drew the Genre popover's chip row.)
function renderGenrePref() {
  renderEraChips();
  setGenrePrefNote();
  updateGenreTally();
  renderStyleBrowseTray();
}

// --- The Genre screen (owner 2026-09-24; flat since v332) ----------------------
// A full-screen list of every tag on today's records, so you can scroll what's here
// instead of guessing a name to type. Built from the day we already hold (no
// round-trip), cached on the deck.
//
// v332 (owner 2026-10-04): FLAT, no genre groups. The grouped version (v327–v331) sat
// every style under one of our 13 coarse buckets, which forced the music into boxes we
// invented — "World" caught only a few keyword hits and "Other styles" was just where
// the matcher gave up ("I'm nervous about the classification of world and other"). Now
// each tag is exactly what the records carry, genres included ("rock" is a row like
// "shoegaze"), A to Z with a letter rail, or rarest first grouped by how rare.
//
// Honesty: every count is the number of records today carrying that tag — exactly what
// a tick yields — and a tag only appears if a record today carries it. Spellings that
// differ only in spaces / hyphens / punctuation ("post rock" / "post-rock", the two
// catalogs' habits) MERGE into one row that matches either.
function tagKey(t) { return String(t || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""); }

// A record's tag KEYS (merged spellings), cached beside recordTags.
const _recordTagKeyCache = new WeakMap();
function recordTagKeys(r) {
  let keys = _recordTagKeyCache.get(r);
  if (!keys) {
    keys = new Set();
    for (const t of recordTags(r)) { const k = tagKey(t); if (k) keys.add(k); }
    _recordTagKeyCache.set(r, keys);
  }
  return keys;
}

// Every tag on today's records, with how many records carry it UNDER THE YEAR FILTERS
// (2026-10-05) — so with the 1970s picked, "acoustic" counts 1970s acoustic records,
// which is exactly what ticking it yields. Labels and spellings come from the whole
// day, so a tag the year filter empties keeps its name (n: 0; sbOrderedTags lists it
// only while it's ticked, so it can always be unticked). Cached per year-filter state.
function styleIndex() {
  if (!deckState || !deckState.all) return null;
  const sig = `${digMode}|${[...deckEras].sort().join()}|${deckYearFrom}|${deckYearTo}`;
  if (deckState._styles && deckState._stylesSig === sig) return deckState._styles;
  const spellings = new Map();              // key -> Map(spelling -> records), whole day
  for (const r of deckState.all) {
    for (const t of recordTags(r)) {
      const k = tagKey(t);
      if (!k) continue;
      if (!spellings.has(k)) spellings.set(k, new Map());
      const sp = spellings.get(k);
      sp.set(t, (sp.get(t) || 0) + 1);
    }
  }
  const scope = applyYearFilters(deckState.all);
  const count = new Map();                  // key -> records in scope carrying it
  let untagged = 0;
  for (const r of scope) {
    const keys = recordTagKeys(r);
    if (!keys.size) { untagged++; continue; }
    for (const k of keys) count.set(k, (count.get(k) || 0) + 1);
  }
  // A merged row is labelled with its most common spelling (ties: alphabetical).
  const tags = [...spellings.keys()].map((k) => {
    const sp = [...spellings.get(k).entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return { key: k, label: sp[0][0], n: count.get(k) || 0, spellings: sp.map((x) => x[0]) };
  });
  deckState._styles = { tags, count, untagged, total: scope.length };
  deckState._stylesSig = sig;
  return deckState._styles;
}

// A ticked tag KEY ("postrock") as its row reads on the Genre screen ("post-rock"), so
// every place that names a tick — the tray, the filtered-empty state — says what the
// reader ticked. Falls back to the key if today no longer carries the tag.
function tagLabel(k) {
  const idx = styleIndex();
  const t = idx && idx.tags.find((x) => x.key === k);
  return t ? t.label : k;
}

// The list's order, remembered on this device (a per-viewer convenience).
const SB_ORDER_KEY = "mf-genre-order/v1";
function sbOrder() {
  try { return localStorage.getItem(SB_ORDER_KEY) === "rare" ? "rare" : "az"; } catch (e) { return "az"; }
}
function setSbOrder(o) { try { localStorage.setItem(SB_ORDER_KEY, o); } catch (e) { /* session only */ } }

const SB_BIG = 100;                         // a tag on this many records reads as broad (bold)
function sbLetter(label) {
  const c = label.normalize("NFD").charAt(0).toUpperCase();
  return /[A-Z]/.test(c) ? c : "#";
}
function sbBand(n) {
  if (n === 1) return "Only 1 record today";
  if (n === 2) return "2 records";
  if (n <= 5) return "3–5 records";
  if (n <= 20) return "6–20 records";
  if (n <= 100) return "21–100 records";
  return "More than 100";
}

// The rows in display order: A–Z by label, or rarest first (then A–Z within a count).
function sbOrderedTags(idx, order, q) {
  // A tag the year filters leave empty is hidden — unless it's ticked, so it can be
  // unticked (it shows its 0, honestly).
  let tags = idx.tags.filter((t) => t.n > 0 || genreTags.has(t.key));
  if (q) tags = tags.filter((t) => t.spellings.some((sp) => sp.includes(q)));
  return tags.slice().sort(order === "rare"
    ? (a, b) => a.n - b.n || a.label.localeCompare(b.label)
    : (a, b) => a.label.localeCompare(b.label));
}

function renderStyleBrowse() {
  const list = document.getElementById("sbList");
  const letters = document.getElementById("sbLetters");
  const inp = document.getElementById("sbSearch");
  const idx = styleIndex();
  if (!list || !idx) return;
  const order = sbOrder();
  const q = inp ? inp.value.trim().toLowerCase() : "";
  const rows = sbOrderedTags(idx, order, q);
  const present = new Set();
  let html = "", cur = null;
  for (const t of rows) {
    const sec = order === "rare" ? sbBand(t.n) : sbLetter(t.label);
    if (sec !== cur) {
      if (cur !== null) html += `</section>`;
      html += `<section class="sb-group" data-sec="${esc(sec)}"><h4>${esc(sec)}</h4>`;
      cur = sec; present.add(sec);
    }
    const on = genreTags.has(t.key);
    // A merged row says which spellings it covers, so the merge is never invisible.
    const also = t.spellings.length > 1
      ? ` <span class="sb-also">also “${esc(t.spellings.slice(1).join("”, “"))}”</span>` : "";
    html += `<button type="button" class="sb-row${on ? " on" : ""}${t.n >= SB_BIG ? " big" : ""}"
      data-sb-tag="${esc(t.key)}" aria-pressed="${on}"><span class="sb-name">${esc(t.label)}${also}</span><span
      class="sb-n">${t.n.toLocaleString()}</span><span class="sb-tick" aria-hidden="true">✓</span></button>`;
  }
  if (cur !== null) html += `</section>`;
  if (!rows.length) {
    html = `<p class="sb-empty muted">Nothing today is tagged “${esc(q)}”. Dig goes through
      every record, or <button type="button" class="linkish" data-goto-explore>explore the
      whole catalog →</button></p>`;
  } else if (idx.untagged) {
    html += `<p class="sb-honest muted">${idx.untagged.toLocaleString()} of today's
      ${idx.total.toLocaleString()} records carry no genre or style tags, so nothing here can
      reach them — dig shows everything.</p>`;
  }
  list.innerHTML = html;
  // The letter rail is A–Z's; rarest first has six bands and its sticky headers.
  if (letters) {
    letters.hidden = order !== "az";
    letters.innerHTML = order !== "az" ? "" : "#ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((L) =>
      `<button type="button" data-sb-letter="${L}"${present.has(L) ? "" : " disabled"}
        aria-label="Jump to ${L === "#" ? "numbers and symbols" : L}">${L}</button>`).join("");
  }
  const sort = document.getElementById("sbSort");
  if (sort) {
    sort.textContent = order === "rare" ? "Rarest first" : "A–Z";
    sort.setAttribute("aria-label", `Order: ${order === "rare" ? "rarest first" : "A to Z"}. Tap to switch.`);
  }
  renderGenrePref();
  renderSbTab();
}

// The Filter screen's two tabs (2026-10-04). Tags shows the list, its find box and its
// sort; Year shows the decade chips, the span and the day door. The tab you were on is
// kept for the session, so someone who filters by year comes back to Year.
let _sbTab = "tags";
function renderSbTab() {
  const tags = _sbTab !== "year";
  for (const b of document.querySelectorAll("[data-sb-tab]")) {
    const on = b.dataset.sbTab === _sbTab;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on));
  }
  const show = (id, v) => { const el = document.getElementById(id); if (el) el.hidden = !v; };
  show("sbPaneTags", tags);
  show("sbPaneYear", !tags);
  show("sbSearch", tags);
  const sort = document.getElementById("sbSort");
  if (sort) sort.classList.toggle("is-off", !tags);
}

// The tray under both tabs: everything that's set (tags, decades, a year span — tap one
// to drop it) and the live count of what Today now holds, the same composed filter the
// deck deals from.
function yearSpanLabel() {
  return `${deckYearFrom != null ? deckYearFrom : "…"}–${deckYearTo != null ? deckYearTo : "…"}`;
}
function renderStyleBrowseTray() {
  const picked = document.getElementById("sbPicked");
  const go = document.getElementById("sbGo");
  const chip = (attr, label) =>
    `<button type="button" class="genre-chip custom on" ${attr}
      aria-label="Remove ${esc(label)}">${esc(label)}<span class="gc-x" aria-hidden="true">✕</span></button>`;
  const chips = [...genreTags].map((k) => chip(`data-sb-untag="${esc(k)}"`, tagLabel(k)));
  for (const d of [...deckEras].sort()) chips.push(chip(`data-sb-unera="${esc(d)}"`, d));
  if (deckYearFrom != null || deckYearTo != null) chips.push(chip("data-sb-unspan", yearSpanLabel()));
  if (picked) { picked.innerHTML = chips.join(""); picked.hidden = !chips.length; }
  if (!go) return;
  const active = genreTags.size || deckEras.size
    || deckYearFrom != null || deckYearTo != null;
  const n = active && deckState && deckState.all ? applyDeckFilters(deckState.all).length : 0;
  go.textContent = !active ? "Back to today"
    : n ? `Show ${n.toLocaleString()} record${n === 1 ? "" : "s"}`
    : "Nothing matches — back to today";
}

// A tick re-derives the deck behind the sheet (a fresh draw) and redraws the list in
// place, holding the reader's scroll position.
function sbApply(fn) {
  fn();
  refilterDeck();
  const list = document.getElementById("sbList");
  const y = list ? list.scrollTop : 0;
  renderStyleBrowse();
  if (list) list.scrollTop = y;
}

// The phone's back gesture closes the Genre screen, like any other step (owner,
// 2026-10-04: "when i swipe back on mobile from the genre page it closes the app").
// The screen isn't a wander step, so it used to add nothing to the history and back
// left the app. Opening now pushes one history step; the popstate handler closes the
// screen on it (styleBrowsePopstate); closing from the screen's own Back / Show /
// Escape takes the step back off, so it never lingers as a dead back-press.
let _sbHistoryStep = false;   // our step is on top of the history
let _sbSkipPop = false;       // the next popstate is our own history.back(), not the reader's
function openStyleBrowse() {
  const sheet = document.getElementById("styleBrowse");
  if (!sheet || !styleIndex()) return;
  const inp = document.getElementById("sbSearch");
  if (inp) inp.value = "";
  renderStyleBrowse();
  sheet.classList.remove("hidden");
  const list = document.getElementById("sbList");
  if (list) list.scrollTop = 0;
  if (!_sbHistoryStep) {
    try { history.pushState({ aotdSheet: "genre" }, ""); _sbHistoryStep = true; } catch (e) { /* ok */ }
  }
}
// Back, Escape (which clicks Back) and the tray's Show button all land on Today; the
// ticks already applied live, so closing never has anything to commit.
function closeStyleBrowse() {
  const sheet = document.getElementById("styleBrowse");
  if (sheet) sheet.classList.add("hidden");
  if (_sbHistoryStep) {
    _sbHistoryStep = false;
    _sbSkipPop = true;
    try { history.back(); } catch (e) { _sbSkipPop = false; }
  }
}
// The popstate side: true when this pop belonged to the Genre screen (the system back
// closed it, or it's the echo of closeStyleBrowse's own history.back()), so the wander
// handler stays out of it.
function styleBrowsePopstate() {
  if (_sbSkipPop) { _sbSkipPop = false; return true; }
  const sheet = document.getElementById("styleBrowse");
  if (sheet && !sheet.classList.contains("hidden")) {
    _sbHistoryStep = false;
    sheet.classList.add("hidden");
    return true;
  }
  return false;
}

function wireStyleBrowse() {
  const sheet = document.getElementById("styleBrowse");
  const open = document.getElementById("filterOpen");
  if (!sheet || !open) return;
  open.addEventListener("click", openStyleBrowse);
  document.getElementById("sbBack").addEventListener("click", closeStyleBrowse);
  document.getElementById("sbGo").addEventListener("click", closeStyleBrowse);
  for (const b of document.querySelectorAll("[data-sb-tab]")) {
    b.addEventListener("click", () => { _sbTab = b.dataset.sbTab; renderSbTab(); });
  }
  const list = document.getElementById("sbList");
  document.getElementById("sbSort").addEventListener("click", () => {
    setSbOrder(sbOrder() === "rare" ? "az" : "rare");
    renderStyleBrowse();
    list.scrollTop = 0;
  });
  const inp = document.getElementById("sbSearch");
  let timer = null;
  inp.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => { renderStyleBrowse(); list.scrollTop = 0; }, 120);
  });
  list.addEventListener("click", (e) => {
    const row = e.target.closest("[data-sb-tag]");
    if (row) {
      const k = row.dataset.sbTag;
      sbApply(() => { if (!genreTags.delete(k)) genreTags.add(k); });
      return;
    }
    if (e.target.closest("[data-goto-explore]")) closeStyleBrowse();
  });
  // The letter rail behaves like a phone's contacts index. The WHOLE rail is the target:
  // a press lands on the nearest available letter, and dragging scrubs through them.
  // (The letters are ~14px tall; with only the glyphs tappable, a finger often fell in
  // the gap between two and nothing happened.) Jumps are instant — a smooth scroll
  // across ~600 rows took well over a second to arrive, which reads as broken.
  const letters = document.getElementById("sbLetters");
  const jumpTo = (L) => {
    const sec = list.querySelector(`.sb-group[data-sec="${L}"]`);
    if (sec) list.scrollTop = sec.offsetTop;
  };
  const jumpAtY = (y) => {
    let best = null, bestD = Infinity;
    for (const b of letters.querySelectorAll("button:not(:disabled)")) {
      const r = b.getBoundingClientRect();
      const d = y < r.top ? r.top - y : (y > r.bottom ? y - r.bottom : 0);
      if (d < bestD) { bestD = d; best = b; }
    }
    if (best) jumpTo(best.dataset.sbLetter);
  };
  let scrubbing = false;
  letters.addEventListener("pointerdown", (e) => {
    e.preventDefault();                   // no focus ring / text selection on a tap
    scrubbing = true;
    try { letters.setPointerCapture(e.pointerId); } catch (err) { /* older engines */ }
    jumpAtY(e.clientY);
  });
  letters.addEventListener("pointermove", (e) => { if (scrubbing) jumpAtY(e.clientY); });
  const stopScrub = () => { scrubbing = false; };
  letters.addEventListener("pointerup", stopScrub);
  letters.addEventListener("pointercancel", stopScrub);
  // Keyboard: Enter / Space on a focused letter arrives as a click with no pointer.
  letters.addEventListener("click", (e) => {
    if (e.detail !== 0) return;           // a pointer press was already handled above
    const b = e.target.closest("[data-sb-letter]");
    if (b && !b.disabled) jumpTo(b.dataset.sbLetter);
  });
  document.getElementById("sbPicked").addEventListener("click", (e) => {
    const tag = e.target.closest("[data-sb-untag]");
    if (tag) { sbApply(() => genreTags.delete(tag.dataset.sbUntag)); return; }
    const era = e.target.closest("[data-sb-unera]");
    if (era) { sbApply(() => deckEras.delete(era.dataset.sbUnera)); return; }
    if (e.target.closest("[data-sb-unspan]")) sbApply(resetYearSpan);
  });
}

// F31: today's records by decade, from the full day we hold — so the era chips carry
// real counts even while a filter is active (like the genre chips).
// Each decade counts under the ticked TAGS and the year SPAN (2026-10-05) — not under
// the other decades, which it would join, not narrow. `present` is every decade on the
// whole day, so a chip the tags empty can still be shown (at 0) while it's selected.
function eraCounts() {
  const counts = new Map(), present = new Set();
  const all = (deckState && deckState.all) || [];
  for (const r of all) { const d = decadeOf(r); if (d) present.add(d); }
  for (const r of applyYearFilters(applyGenreFilter(all), { decades: false })) {
    const d = decadeOf(r);
    if (d) counts.set(d, (counts.get(d) || 0) + 1);
  }
  counts.present = present;
  return counts;
}

// The decade chips present on this day, chronological, each with its count. The whole
// row hides when a day carries no year data (nothing to pick) — an honest empty, not a
// dead control. A previously-selected era no longer present (a new day) is dropped.
function renderEraChips() {
  const box = document.getElementById("eraChips");
  const row = document.getElementById("eraRow");
  if (!box) return;
  const counts = eraCounts();
  // A selected decade the whole day lacks (a new day) is dropped; one the TAGS empty is
  // kept and shown at 0, so a tick elsewhere never silently unpicks it.
  for (const d of [...deckEras]) if (!counts.present.has(d)) deckEras.delete(d);
  const shown = [...counts.present].filter((d) => counts.has(d) || deckEras.has(d)).sort();
  if (row) row.hidden = shown.length === 0;
  box.innerHTML = shown.map((d) => {
    const on = deckEras.has(d);
    return `<button type="button" class="genre-chip era-chip${on ? " on" : ""}" data-era="${esc(d)}"
       aria-pressed="${on}">${esc(d)}<span class="gc-n">${(counts.get(d) || 0).toLocaleString()}</span></button>`;
  }).join("");
}

// Toggle a decade and re-derive the deck — a fresh draw from the top, exactly like a
// genre toggle (refilterDeck resets idx / set-aside; kept rows persist server-side).
function toggleEra(d) {
  if (deckEras.has(d)) deckEras.delete(d);
  else deckEras.add(d);
  refilterDeck();
  refreshFilterScreen();
}

// A year change re-counts the Tags tab; redraw it in place if the screen is open.
function refreshFilterScreen() {
  const sheet = document.getElementById("styleBrowse");
  if (!sheet || sheet.classList.contains("hidden")) return;
  const list = document.getElementById("sbList");
  const y = list ? list.scrollTop : 0;
  renderStyleBrowse();
  if (list) list.scrollTop = y;
}

// A genre toggle re-derives the visible deck from the full day we already hold — no
// refetch. It's a fresh draw, so it resets to the top with an empty set-aside pile,
// like the platform filter's refreshSurfaces; kept rows persist server-side.
function refilterDeck() {
  if (!deckState || !deckState.all) { loadDeck(true); return; }
  deckState.records = dealOrder(applyDeckFilters(deckState.all));
  deckState.idx = 0;
  deckState.aside = [];
  deckState.noted = new Set();
  updateSetAsideBar();
  renderGenrePref();
  if (deckState.records.length) renderDeck();
  else renderGenreFilteredEmpty();
}

// A genre filter that empties today (but the day itself holds records) points to
// dig — never a blank wall (the honesty-rule guardrail, like the platform filter).
function renderGenreFilteredEmpty() {
  if (_firstRun) return;                 // the first-run picker owns #choice
  const wrap = $("#choice");
  if (!wrap) return;
  const parts = [...[...genreTags].map(tagLabel), ...deckEras];
  if (deckYearFrom != null || deckYearTo != null) parts.push(yearSpanLabel());
  const picks = parts.join(", ");
  // Filters first, and only filters (owner 2026-10-05): what's picked, and the two ways
  // to change it. Nothing else competes with that.
  wrap.innerHTML = filterSuggestionHtml(`Nothing today in ${esc(picks)}.`);
}

// "Clear filters" clears everything Filter holds — tags, decades and a year span (the
// span used to survive it, back when it lived in a separate Year popover).
function clearGenreFilter() {
  if (!genreTags.size && !deckEras.size && deckYearFrom == null && deckYearTo == null) return;
  genreTags.clear();
  deckEras.clear();
  resetYearSpan();
  refilterDeck();
}

// Empty the year span (its two boxes too) without re-deriving the deck — callers do that.
function resetYearSpan() {
  for (const id of ["yearFrom", "yearTo"]) {
    const el = document.getElementById(id);
    if (el) el.value = "";
  }
  deckYearFrom = null;
  deckYearTo = null;
  const yc = document.getElementById("yearRangeClear");
  if (yc) yc.classList.add("hidden");
}

// A dismissible popover's tap-outside closer, shared by the platform chooser and the
// two Today filters. It also SWALLOWS the click that follows.
//
// Owner, on the iOS Simulator 2026-08-07: "I clicked the genre tab, then clicked on the
// album behind it and the album details popped up." Both closers listened on
// `pointerdown` and set `open = false`, which dismissed the panel — and then the
// browser delivered the matching `click` to whatever was now under the finger, so one
// tap both closed the filter and pulled a door. The first tap after opening a panel
// should only ever put the panel away.
//
// pointerdown is still the right moment to CLOSE (it feels immediate, and it beats the
// click that would otherwise reach the page), so the fix is to consume the click rather
// than move the close.
//
// NO TIMER. The first version disarmed the swallow after 400ms, which passed in Chrome
// and failed on a real iPhone: a tap holds the finger down longer than that, so the
// window had already closed by the time the click arrived and the door opened anyway.
// Worse, the Chrome test agreed with the bug — it synthesised pointerdown and click 60ms
// apart, which is faster than any human tap. Timing is the wrong thing to key on.
//
// Instead the arm is cleared by the NEXT pointerdown, which is the only event that can
// mean "a new gesture has started". A click belonging to this gesture is always the next
// click, however long the finger rests; and a gesture that never produces one — a scroll,
// a long-press, a pointercancel — is disarmed by whatever gesture follows it, so a stale
// arm can never eat an unrelated tap. The flag is per-box, so two panels can't clear
// each other's state.
function closePopoverOnOutsideTap(box) {
  let armed = false;
  document.addEventListener("pointerdown", (e) => {
    armed = false;                       // a new gesture always disarms first
    if (!box.open || box.contains(e.target)) return;
    // Opening feedback must not collapse the filter (FB#57) — the same exemption the
    // account menu makes.
    if (e.target.closest && e.target.closest("#feedbackBtn, #feedbackModal")) return;
    box.open = false;
    armed = true;
  });
  document.addEventListener("click", (e) => {
    if (!armed) return;
    armed = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}

function wireGenrePref() {
  // FB#105 follow-up (owner): each filter panel gets a ✕. Tap-outside and Escape
  // already closed them; this is about "offering multiple options to close", since
  // neither of those announces itself. One delegated handler on the row, so another
  // popover filter would work for free. (Only Year is a popover since v328 — Genre
  // opens its own screen, wired in wireStyleBrowse.)
  // stopPropagation because the row's own tap-outside closer would otherwise see this
  // click, and the <details> would fight itself over which one closed it.
  const row = document.querySelector(".narrow-today");
  if (row) {
    row.addEventListener("click", (e) => {
      const x = e.target.closest("[data-pref-close]");
      if (!x) return;
      e.stopPropagation();
      const panel = x.closest("details");
      if (panel) panel.open = false;
    });
  }
  // F31: the era chips are their own toggle group; same fresh-draw as a genre tick.
  const eras = document.getElementById("eraChips");
  if (eras) eras.addEventListener("click", (e) => {
    e.stopPropagation();
    const chip = e.target.closest("[data-era]");
    if (chip) toggleEra(chip.dataset.era);
  });
  // Owner 2026-07-26: the year span composes (AND) with the decades. Read on `change`
  // (blur / Enter) so we re-derive once the number is settled, not per keystroke.
  const yFrom = document.getElementById("yearFrom");
  const yTo = document.getElementById("yearTo");
  const yClear = document.getElementById("yearRangeClear");
  const readYears = () => {
    const parse = (el) => { const v = parseInt(el && el.value, 10); return Number.isFinite(v) ? v : null; };
    deckYearFrom = parse(yFrom);
    deckYearTo = parse(yTo);
    if (yClear) yClear.classList.toggle("hidden", deckYearFrom == null && deckYearTo == null);
    refilterDeck();
    refreshFilterScreen();
  };
  if (yFrom) yFrom.addEventListener("change", readYears);
  if (yTo) yTo.addEventListener("change", readYears);
  if (yClear) yClear.addEventListener("click", (e) => {
    e.stopPropagation();
    resetYearSpan();
    refilterDeck();
    refreshFilterScreen();
  });
  // (2026-10-04: these controls moved from the Year popover into the Filter screen's Year
  // tab. The popover's open-refresh and tap-outside closer went with it: opening the
  // screen redraws the chips — renderStyleBrowse → renderGenrePref.)
}

// Source-aware provenance (P3): the exact Discogs release or MusicBrainz
// release-group this date/row came from, keyed off the uid prefix server-side.
// Falls back to the legacy discogs_url for any caller that predates source_url.
// Extracted so the browse-card door and the Go deeper head can share one thread.
function provenanceHtml(a) {
  const srcUrl = a.source_url || a.discogs_url;
  const srcLabel = a.source_label || (a.discogs_url ? "Discogs" : "");
  if (!srcUrl || !srcLabel) return "";
  return `<a class="dg provenance" href="${esc(srcUrl)}" target="_blank"
     rel="noopener" title="Open this album's ${esc(srcLabel)} catalog page — where its details come from">${esc(srcLabel)} ↗</a>`;
}

// FB#105: the source page as a thread chip, for the Threads to pull row. Same link
// and same claim as provenanceHtml (which the browse cards still use); the difference
// is that here it wears the shape of the other doors instead of a labelled line.
function provenanceThreadHtml(a) {
  const srcUrl = a.source_url || a.discogs_url;
  const srcLabel = a.source_label || (a.discogs_url ? "Discogs" : "");
  if (!srcUrl || !srcLabel) return "";
  // Owner, on-device: a bare "Discogs ↗" chip "should be more descriptive i.e. 'album
  // details on Discogs'." A one-word chip among genre and style chips read as another
  // tag to pull, not as the door out to where these details came from. Say the whole
  // thing — it's the only chip in the row that leaves the app, so it can afford the
  // width.
  return `<a class="nc-chip story-thread thread-source" href="${esc(srcUrl)}"
     target="_blank" rel="noopener"
     title="Open this album's page on ${esc(srcLabel)} — where these details come from"
     >Album details on ${esc(srcLabel)} <span class="ts-out" aria-hidden="true">↗</span></a>`;
}

function linksHtml(a) {
  // Progressive disclosure (VISION.md): the confirmed services hide behind one
  // quiet "Listen" door so a card isn't a wall of buttons (U5). The provenance
  // (Discogs / MusicBrainz) stays a small always-visible thread beside it.
  //
  // The door reads the server's `platforms` map (exact, confirmed-listenable
  // links only) — never the legacy blind-search *_url fields. It's hidden
  // entirely when nothing is confirmed; an album with no confirmed platform is
  // only ever surfaced in dig mode, where an empty door is expected.
  const platforms = a.platforms || {};
  const services = CONFIRMED_PLATFORMS
    .filter(([key]) => platforms[key])
    .map(([key, cls, label]) => [key, cls, platforms[key], label]);
  const listen = services.length
    ? `<details class="listen">
      <summary>♫ Listen</summary>
      <div class="links">
        ${services.map(([key, cls, url, label]) =>
          `<a class="${cls}" href="${esc(url)}"${listenAttrs(key, url)} target="_blank" rel="noopener">${label}</a>`
        ).join("\n        ")}
      </div>
    </details>`
    : "";
  return `<div class="listen-row">
    ${listen}
    ${provenanceHtml(a)}
  </div>`;
}

// The prioritised listen block: one solid primary button naming your #1 confirmed
// platform, then the rest as secondary chips — priority order from your platform
// prefs (pickListenPlatforms). Used on the pick (Direction B) AND the Go deeper /
// story head (F#10: an opened album leads with listening everywhere, not just the
// daily pick), replacing the collapsed "Listen" door there — one tap, not
// tap-to-open-then-tap. Honest states (spinner / copy-search) handled inline.
function listenBlockHtml(a, { compact = false, more = false } = {}) {
  const prefs = loadListenPrefs();
  const { primary, chips } = pickListenPlatforms(a.platforms, prefs);

  if (!primary) {
    // Honest states, never a fabricated "search on Spotify" button:
    //  - while the door is still resolving (a pool album): a spinner.
    //  - resolved, but confirmed only on services you've filtered OUT: name where
    //    it IS and hand over those exact links (offPlatformHtml). "No link on YOUR
    //    platforms" was quietly hiding real confirmed links on services you didn't
    //    select — the door found them, so we say so. Album-details only (`!compact`);
    //    the keep reveal stays a calm one-liner.
    //  - resolved with nothing confirmed anywhere: hand over a copyable
    //    "artist — title" string to paste wherever you listen (copySearchHtml).
    //    unknown ≠ unavailable — we just don't claim a link we can't stand behind.
    if (a._doorPending) {
      return `<div class="choice-listen"><p class="choice-looking">
        <span class="spin" aria-hidden="true"></span> Checking availability…</p></div>`;
    }
    const elsewhere = pickListenPlatforms(a.platforms, []);   // every confirmed link
    if (!compact && prefs.length && elsewhere.primary) {
      return offPlatformHtml(prefs, elsewhere, a);
    }
    // v350: the record kept on Today after you changed platforms from its own card can
    // be on none of them. It still has exact links, so it never says "no confirmed
    // link": the selector names where it IS and Listen goes there, outlined rather than
    // green (green is your service), with the selector still there to change your mind.
    if (compact && more && prefs.length && elsewhere.primary) {
      const [okey, ocls, ourl, olabel] = elsewhere.primary;
      return deckListenRow(okey, ocls, ourl, olabel,
        a._spUnchecked && prefs.includes("spotify") ? "unchecked" : true);
    }
    return copySearchHtml(a);
  }
  const [pkey, pcls, purl, plabel] = primary;
  // N3a follow-up (owner 2026-07-12): on the keep reveal, listening is secondary to
  // the keep you've just made, so it's a COMPACT one-row of platform-name pills —
  // the top one green (your #1), up to two quiet backups — never the big "Listen on
  // ___" button. The album-details door keeps the full button.
  if (compact) {
    // Just the top confirmed platform (owner 2026-07-12): a shown link is a
    // guaranteed, exact deep link, and this is already your #1-preferred platform,
    // so backups only ever meant "a different service you might prefer" — dropped.
    // Content-sized + left (`listen-solo`), so a single green pill never grows into
    // a full-width primary button.
    // v9: once you've opened this record today, the chip says it's in your Notebook —
    // inside the button, so the confirmation never moves the rows below it.
    const tag = openedToday(albumKey(a))
      ? `<span class="opened-tag">✓ in Notebook</span>` : "";
    if (more) return deckListenRow(pkey, pcls, purl, plabel);
    return `<div class="choice-listen"><div class="listen-chips listen-solo">
      <a class="listen-chip primary ${pcls}" href="${esc(purl)}"${
        listenAttrs(pkey, purl)} target="_blank" rel="noopener">${esc(plabel)}${tag}</a>
    </div></div>`;
  }
  const primaryBtn = `<a class="listen-primary ${pcls}" href="${esc(purl)}"${
    listenAttrs(pkey, purl)}
    target="_blank" rel="noopener">▶ Listen on ${esc(plabel)}</a>`;
  // FB#105 (owner): "There should be an 'other platforms' door instead of showing
  // them all at once." Five or six service chips under the primary button was a wall
  // that pushed Keep and Write a note off the first screen. One door now — but the
  // COUNT rides on the summary, because those chips are confirmed exact links and
  // silently hiding them would quietly weaken the claim the honesty rule rests on.
  // You can still see there are five; you just don't have to look at five.
  const chipsHtml = chips.length
    ? `<details class="listen-more">
        <summary>Other ways to listen<span class="lm-count">${chips.length}</span></summary>
        <div class="listen-chips">
          ${chips.map(([key, cls, url, label]) =>
            `<a class="listen-chip ${cls}" href="${esc(url)}"${listenAttrs(key, url)} target="_blank"
              rel="noopener">${esc(label)}</a>`).join("\n          ")}
        </div>
      </details>`
    : "";
  // The Copy row is gone from here (FB#105): the identity block above IS the copy
  // control now, so this no longer emits copyAlongsideHtml. The function stays — the
  // no-confirmed-link fallback (copySearchHtml) is a different, still-needed thing.
  return `<div class="choice-listen">${primaryBtn}${chipsHtml}</div>`;
}

// --- MORE WAYS TO LISTEN (v350, owner 2026-10-05, mockup A) --------------------
// The ⌄ on Today's Listen button opens a sheet with two things: ALSO ON, this record's
// other confirmed links (exact, like every Listen link — a tap opens it there and
// leaves an "Opened in ___" entry; nothing else changes), and YOUR LISTENING
// PLATFORMS, the same choices as the first screen, Everything included. (A third
// place, ☰ › Select listening platforms, was retired in v354 — owner 2026-10-05.)
// The difference from that ☰ panel was when it landed: it saved and re-dealt on every
// tap, so the record on screen could vanish (a corridor). Here nothing moves until the
// sheet closes, and then the record you're on STAYS (pinned, even if it isn't on your
// new platforms) while the rest of the day reloads behind it; your choice applies
// from Next. The order — tap order, or a drag (v354) — sets which service the button
// names.
const CHEV_SVG = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>`;
let _ls = null;        // { uid, start, sel } while the sheet is open
// Is Spotify failing today (the day's own response says so — pooldoor.spotify_trouble)?
// Then a reader who listens there is told, quietly, where it shows (2026-10-07).
let _spotifyTrouble = false;
function spotifyTroubleLead() {
  return _spotifyTrouble && filterPlatformKeys().includes("spotify")
    ? "Spotify isn't answering today, so today's records couldn't be checked there." : "";
}
let _pinNext = null;   // { key, rec, aside, noted }: the record kept on Today (see loadDeck)

// Today's Listen row — every place that draws or repaints it goes here.
function deckListenHtml(a) {
  return listenBlockHtml(a, { compact: true, more: true });
}
// v352 (owner, mockups round 3 → C): the row is two halves with one job each. On the
// left, WHERE you listen — the service, a quiet selector that opens More ways to listen;
// on the right, the green ▶ Listen, which goes there. The selector is as wide as its
// name (YouTube Music, the longest, still leaves Listen 131px of the 306 on an iPhone
// mini with iOS's wider text), so the dividing line moves a little from record to
// record. Listen is the real link: data-listen (the tap count + "Opened in ___"), the
// app deep link, and the service class the Apple-art rule looks for (a.am).
// "✓ in Notebook" left the button for the line under the title (deckOpenedHtml).
function deckListenRow(key, cls, url, label, off = false) {
  return `<div class="choice-listen"><div class="listen-sel${off ? " is-off" : ""}">
      <button type="button" class="listen-svc" data-listen-more aria-haspopup="dialog"
        aria-label="${off === "unchecked" ? `Couldn't check Spotify just now — it's on ${esc(label)}`
          : off ? `Not on your listening platforms — it's on ${esc(label)}` : `Where you listen: ${esc(label)}`}. More ways to listen"
        >${esc(label)}${CHEV_SVG}</button>
      <a class="listen-go ${cls}" href="${esc(url)}"${listenAttrs(key, url)} target="_blank"
        rel="noopener" aria-label="Listen on ${esc(label)}">Listen</a>
    </div></div>`;
}
// The "✓ in Notebook" mark on the line under the title: today, once you've opened it.
function deckOpenedHtml(uid) {
  return openedToday(uid) ? `<span class="dot">·</span><span class="ds-opened">✓ in Notebook</span>` : "";
}
// Toggle one tile. Everything clears the services; a service is added at the end of
// the order (your priority) or taken out.
function toggleListenSel(sel, key) {
  if (key === "all") return [];
  return sel.includes(key) ? sel.filter((k) => k !== key) : sel.concat(key);
}
// v354 (owner 2026-10-05: "click and drag or press/hold and reorder the options …
// to choose priorities"): the tiles stand in your order — your platforms first, as
// numbered, then the rest in the usual order (Everything is always last). So a tap
// moves a tile to where its number says, and dragging one changes the number.
function listenTileOrder(sel) {
  return sel.concat(CONFIRMED_PLATFORMS.map(([k]) => k).filter((k) => !sel.includes(k)));
}
// A drag: one of your platforms to a new place in the order. Only chosen ones move,
// and the set never changes.
function moveListenSel(sel, key, to) {
  const from = sel.indexOf(key);
  if (from < 0) return sel;
  const next = sel.slice();
  next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, key);
  return next;
}
function sameMembers(x, y) {
  return x.length === y.length && x.every((k) => y.includes(k));
}
function platNameList(keys) {
  const n = keys.map((k) => _platLabel[k] || k);
  return n.length < 3 ? n.join(" and ") : n.slice(0, -1).join(", ") + " and " + n[n.length - 1];
}
// The line under the tiles: what closing the sheet will do, in plain words. With no
// record on screen (`platforms` null — opened from the end of the day), there is no
// "this one" to keep.
function listenSheetNote(platforms, start, sel, unchecked = []) {
  if (sel.join() === start.join()) return { changed: false, text: "Only records you can play there will show." };
  if (sameMembers(sel, start)) return { changed: true, text: `${_platLabel[sel[0]]} comes first now.` };
  if (!platforms) {
    return { changed: true, text: sel.length ? `Only records on ${platNameList(sel)} will show.`
      : "Every record will show." };
  }
  if (!sel.length) return { changed: true, text: "Next shows every record. This one stays." };
  const list = platNameList(sel);
  if (!pickListenPlatforms(platforms, sel).primary) {
    // Spotify failed for this one: unknown, not a "no" (2026-10-07).
    if (unchecked.some((k) => sel.includes(k)))
      return { changed: true, text: `Spotify couldn't be checked for this one just now, so it stays until you move on. Next shows only records on ${list}.` };
    return { changed: true, text: `This one isn't on ${list}, so it stays until you move on. Next shows only records on ${list}.` };
  }
  return { changed: true, text: `Next shows only records on ${list}. This one stays.` };
}
function coarsePointer() {
  try { return window.matchMedia("(pointer: coarse)").matches; } catch (e) { return false; }
}
function listenSheetHtml(a, ls) {
  const platforms = a ? (a.platforms || {}) : null;
  let also = "";
  if (a) {
    const onButton = pickListenPlatforms(platforms, ls.start).primary
      || pickListenPlatforms(platforms, []).primary;
    const chips = CONFIRMED_PLATFORMS
      .filter(([k]) => platforms[k] && !(onButton && onButton[0] === k))
      .map(([k, cls, label]) => `<a class="listen-chip ${cls}" href="${esc(platforms[k])}"${
        listenAttrs(k, platforms[k])} target="_blank" rel="noopener">${esc(label)}</a>`);
    also = `<p class="lsh-label">Also on</p>
    ${chips.length ? `<div class="listen-chips lsh-also">${chips.join("")}</div>`
      : `<p class="lsh-none">Not confirmed anywhere else yet.</p>`}`;
  }
  const many = ls.sel.length > 1;
  const tiles = listenTileOrder(ls.sel).map((k) => {
    const label = _platLabel[k] || k;
    const on = ls.sel.includes(k);
    const n = ls.sel.indexOf(k) + 1;
    // Several chosen: each carries its place in the order, and can be dragged.
    const quiet = k === "spotify" && _spotifyTrouble;      // "not answering" (2026-10-07)
    return `<button type="button" class="lsh-tile${on && many ? " is-movable" : ""}${quiet ? " is-quiet" : ""}" data-ls-plat="${k}"
      aria-pressed="${on}"${on ? ` data-mark="${many ? n : "✓"}"` : ""}${
      on && many ? ` aria-label="${esc(label)}${quiet ? ", not answering" : ""}, ${n} of ${ls.sel.length}"` : ""}>${esc(label)}${
      quiet ? '<small class="lsh-quiet">not answering</small>' : ""}</button>`;
  }).join("") + `<button type="button" class="lsh-tile" data-ls-plat="all" aria-pressed="${!ls.sel.length}"${
    ls.sel.length ? "" : ' data-mark="✓"'}>Everything</button>`;
  const note = listenSheetNote(platforms, ls.start, ls.sel, a && a._spUnchecked ? ["spotify"] : []);
  if (!note.changed && _spotifyTrouble && ls.sel.includes("spotify"))
    note.text = "Spotify isn't answering today, so fewer records than usual can be confirmed there. Everything shows them all.";
  const order = many
    ? `<p class="lsh-order">${coarsePointer() ? "Hold one and drag it" : "Drag one"} to choose which comes first.</p>`
    : "";
  return `${also}
    <p class="lsh-label">Your listening platforms</p>
    <div class="lsh-tiles" role="group" aria-label="Your listening platforms">${tiles}</div>
    ${order}
    <p class="lsh-hint${note.changed ? " is-changed" : ""}" aria-live="polite">${esc(note.text)}</p>
    <button type="button" class="lsh-done" data-ls-done>Done</button>`;
}
// Opens on Today's record — or, from the end of the day ("Change listening
// platforms"), with no record at all: then it's just your platforms.
function openListenSheet() {
  const sheet = $("#listenSheet");
  if (!sheet || !deckState) return;
  const a = deckState.idx < deckState.records.length ? deckState.records[deckState.idx] : null;
  const start = loadListenPrefs();
  _ls = { uid: a ? albumKey(a) : null, start, sel: start.slice() };
  if (a) sheet.dataset.uid = _ls.uid;       // so its links leave an "Opened in ___" entry
  else delete sheet.dataset.uid;
  $("#lsTitle").innerHTML = a ? `${esc(a.artist)} — <b>${esc(a.title)}</b>` : "Where you listen";
  renderListenSheet();
  sheet.classList.remove("hidden");
}
// Redraw the sheet. A tile that changes place (a tap, a drop) glides there from where
// it was rather than jumping, so you can see where your choice went.
function renderListenSheet() {
  const body = $("#lsBody");
  if (!body || !_ls) return;
  const was = {};
  body.querySelectorAll(".lsh-tile").forEach((t) => { was[t.dataset.lsPlat] = t.getBoundingClientRect(); });
  const a = _ls.uid ? (albumData[_ls.uid] || (deckState && deckState.records[deckState.idx]) || {}) : null;
  body.innerHTML = listenSheetHtml(a, _ls);
  if (reducedMotion()) return;
  const moved = [];
  body.querySelectorAll(".lsh-tile").forEach((t) => {
    const r0 = was[t.dataset.lsPlat];
    if (!r0) return;
    const r1 = t.getBoundingClientRect();
    const dx = r0.left - r1.left, dy = r0.top - r1.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    t.style.transition = "none";
    t.style.transform = `translate(${dx}px, ${dy}px)`;
    moved.push(t);
  });
  if (!moved.length) return;
  void body.offsetWidth;                    // lock the start positions in
  for (const t of moved) {
    t.style.transition = "transform .24s cubic-bezier(.2, .9, .3, 1)";
    t.style.transform = "";
    setTimeout(() => { t.style.transition = ""; }, 280);
  }
}
// Every way out (Done, ✕, Esc, a tap above the sheet) applies what the tiles show.
function closeListenSheet() {
  const sheet = $("#listenSheet");
  if (sheet) sheet.classList.add("hidden");
  const ls = _ls;
  _ls = null;
  if (!ls || ls.sel.join() === ls.start.join()) return;
  const membership = !sameMembers(ls.sel, ls.start);
  if (membership && ls.uid && deckState && deckState.idx < deckState.records.length) {
    const rec = deckState.records[deckState.idx];
    if (albumKey(rec) === ls.uid)
      _pinNext = { key: deckState.key, rec, aside: deckState.aside, noted: deckState.noted };
  }
  // Dig deeper ignores your platforms, so naming some ends it — otherwise the note's
  // promise ("Next shows only records on …") wouldn't be kept.
  if (membership && ls.sel.length) digMode = false;
  commitListenPrefs(ls.sel, membership);
  // The selector that opened the sheet was redrawn with the row, so the dialog stack has
  // nothing to hand focus back to (it would stay on a tile in the hidden sheet).
  // Put it on the new one, as the stack does for every other dialog.
  const m = document.querySelector("#deckListen [data-listen-more]");
  if (m) m.focus({ preventScroll: true });
}

// Drag a numbered tile to a new place in the order: press and hold it (touch), or
// press and move (a mouse, or a finger that moves before the hold). The lifted tile
// follows the pointer; the others slide to open the slot it will land in, and every
// number shows what it will be. Nothing is committed until the drop, and even then
// only to the sheet — closing it applies, like a tap. A click that trails a drop is
// swallowed (_lsDropAt): it would land on whatever tile now sits under the pointer,
// or on the backdrop if the drop was outside the sheet, and toggle or close it.
// (The same grammar as the old ☰ chooser's list, wirePrefDrag, retired in v354 —
// in two dimensions now, because the tiles are a grid.)
let _lsDropAt = 0;
function wireListenTileDrag(sheet) {
  let mode = null;                     // null | "pending" | "drag"
  let el = null, x0 = 0, y0 = 0, timer = null, pid = null;
  let tiles = [], slots = [], from = 0, to = 0;
  const centre = (r) => [r.left + r.width / 2, r.top + r.height / 2];
  const placeOf = (i) => {             // where tile i will sit if the drop happens now
    if (i === from) return to;
    if (from < to && i > from && i <= to) return i - 1;
    if (from > to && i < from && i >= to) return i + 1;
    return i;
  };
  const shift = () => {
    tiles.forEach((t, i) => {
      const p = placeOf(i);
      t.dataset.mark = String(p + 1);
      if (t === el) return;
      const dx = slots[p].left - slots[i].left, dy = slots[p].top - slots[i].top;
      t.style.transform = dx || dy ? `translate(${dx}px, ${dy}px)` : "";
    });
  };
  const begin = () => {
    mode = "drag";
    tiles = Array.from(sheet.querySelectorAll(".lsh-tile.is-movable"));
    slots = tiles.map((t) => t.getBoundingClientRect());
    from = to = tiles.indexOf(el);
    el.classList.add("dragging");
    el.closest(".lsh-tiles").classList.add("is-sorting");
  };
  const dragTo = (x, y) => {
    const dx = x - x0, dy = y - y0;
    el.style.transform = `translate(${dx}px, ${dy}px) scale(1.04)`;
    const [cx, cy] = centre(slots[from]);
    const px = cx + dx, py = cy + dy;
    let best = to, bestD = Infinity;
    slots.forEach((r, i) => {
      const [sx, sy] = centre(r);
      const d = (sx - px) ** 2 + (sy - py) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best !== to) { to = best; shift(); }
  };
  const move = (e) => {
    if (e.pointerId !== pid) return;
    if (mode === "pending") {
      if (Math.hypot(e.clientX - x0, e.clientY - y0) > 6) { clearTimeout(timer); begin(); }
      else return;
    }
    if (mode === "drag") { e.preventDefault(); dragTo(e.clientX, e.clientY); }
  };
  const end = (e) => {
    if (e && e.pointerId !== pid) return;
    clearTimeout(timer);
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", end);
    document.removeEventListener("pointercancel", end);
    if (mode === "drag" && el && _ls) {
      const key = el.dataset.lsPlat;
      el.classList.remove("dragging");
      const grid = el.closest(".lsh-tiles");
      if (grid) grid.classList.remove("is-sorting");
      if (to !== from) _ls.sel = moveListenSel(_ls.sel, key, to);
      renderListenSheet();             // glides the lifted tile home from where it was let go
      const again = sheet.querySelector(`[data-ls-plat="${key}"]`);
      if (again) again.focus({ preventScroll: true });
      _lsDropAt = Date.now();
    }
    mode = null; el = null; tiles = []; pid = null;
  };
  sheet.addEventListener("pointerdown", (e) => {
    if (e.button != null && e.button > 0) return;      // primary button / touch only
    const t = e.target.closest(".lsh-tile.is-movable");
    if (!t || mode) return;
    mode = "pending"; el = t; x0 = e.clientX; y0 = e.clientY; pid = e.pointerId;
    // A finger lifts it by holding still; a mouse only by moving (a slow click is a click).
    if (e.pointerType !== "mouse") timer = setTimeout(() => { if (mode === "pending") begin(); }, 260);
    document.addEventListener("pointermove", move, { passive: false });
    document.addEventListener("pointerup", end);
    document.addEventListener("pointercancel", end);
  });
  // A held tile mustn't open the callout menu or select its name.
  sheet.addEventListener("contextmenu", (e) => {
    if (e.target.closest && e.target.closest(".lsh-tile.is-movable")) e.preventDefault();
  });
}

function wireListenSheet() {
  const sheet = $("#listenSheet");
  if (!sheet) return;
  document.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest("[data-listen-more]")) openListenSheet();
  });
  sheet.addEventListener("click", (e) => {
    if (Date.now() - _lsDropAt < 400) return;          // the click that trails a drop
    if (e.target === sheet || e.target.closest("[data-ls-done]")) { closeListenSheet(); return; }
    const t = e.target.closest("[data-ls-plat]");
    if (t && _ls) {
      _ls.sel = toggleListenSel(_ls.sel, t.dataset.lsPlat);
      renderListenSheet();
      const again = sheet.querySelector(`[data-ls-plat="${t.dataset.lsPlat}"]`);
      if (again) again.focus({ preventScroll: true });   // keep a keyboard user's place
    }
  });
  $("#lsClose").addEventListener("click", closeListenSheet);
  wireListenTileDrag(sheet);
}

// Honest fallback for an album we can't confirm a link for (owner's call, F#10):
// no blind "search on <service>" button — instead a one-tap copy of the
// "artist — title" string so you can paste it into whatever app/browser you like.
// (The old "Spotify is only checked for today and tomorrow" clause predated the
// F22 on-demand door — opening an album now checks Spotify for ANY day, so the
// clause misexplained a same-day empty state; owner hit exactly that 2026-07-03.
// The day-wide FILTER's caveat in filteredEmptyHtml stays — that path really
// does see only prewarmed stamps.)
function copySearchHtml(a) {
  const q = `${a.artist || ""} ${a.title || ""}`.trim();
  return `<div class="choice-listen no-confirm">
    <p class="choice-looking muted">No confirmed link on file for this one — search it where you listen:</p>
    <button class="copy-search" data-q="${esc(q)}">
      <i class="csi" aria-hidden="true">⧉</i>
      <span class="cs-label">Copy “${esc(a.artist)} — ${esc(a.title)}” to search</span>
    </button>
  </div>`;
}

// The same copy, riding ALONGSIDE real links (owner's ask 2026-07-16) — so Album
// details always offers it, not only when we've nothing to link. A confirmed link
// isn't always a USEFUL one: it may be on a service you don't use, and Qobuz isn't
// supported at all (deliberate — see the field guide), so handing over the exact
// "artist — title" beats retyping it off the screen.
// QUIET, not green: `.copy-search` is green-filled because as the no-link FALLBACK
// copying *is* how you listen. Here a real Listen button already owns that job, and
// green is reserved for Listen — so this takes the outlined treatment `.bio-copy`
// already established for the same reason. Reuses `.copy-search`, so the delegated
// wireCopySearch handler (+ its "Copied ✓" flash and legacy fallback) covers it with
// no new wiring.
// Album-details only: the keep reveal stays a calm one-liner about the keep you just
// made (N3a), and a second button there would talk over it.
function copyAlongsideHtml(a) {
  const q = `${a.artist || ""} ${a.title || ""}`.trim();
  if (!q) return "";
  return `<button class="copy-search listen-copy" data-q="${esc(q)}">
    <i class="csi" aria-hidden="true">⧉</i>
    <span class="cs-label">Copy “${esc(a.artist)} — ${esc(a.title)}”</span>
  </button>`;
}

// Honest "it's confirmed, just not on the services you chose" state: the door DID
// resolve links, but your platform filter hid them. Rather than a bare "no link on
// your platforms," name the services you filtered out and hand over the exact
// confirmed links there — a definite verdict, and never a link we can't stand behind
// (these come from the same confirmed `platforms` map, just off your prefs). Only the
// album-details door shows this; the keep reveal stays minimal.
function offPlatformHtml(prefs, elsewhere, a) {
  // A Spotify lookup that failed is unknown, not a "no" (2026-10-07, the honesty rule).
  const unchecked = a && a._spUnchecked && prefs.includes("spotify");
  const yours = prefs.filter((k) => !(unchecked && k === "spotify"))
    .map((k) => _platLabel[k]).filter(Boolean);
  const lead = !unchecked ? `Not on ${esc(orList(yours))} — but it's here:`
    : yours.length ? `Couldn't check Spotify just now, and it's not on ${esc(orList(yours))} — it's here:`
    : "Couldn't check Spotify just now — it's here:";
  const found = [elsewhere.primary, ...elsewhere.chips];   // [key, cls, url, label]
  const chips = found.map(([key, cls, url, label]) =>
    `<a class="listen-chip ${cls}" href="${esc(url)}"${listenAttrs(key, url)}
      target="_blank" rel="noopener">${esc(label)}</a>`).join("\n      ");
  // The copy earns its place most here: we've just said it ISN'T on the services you
  // use, so the string to search with is the one thing you actually want.
  return `<div class="choice-listen off-platform">
    <p class="choice-looking muted">${lead}</p>
    <div class="listen-chips">
      ${chips}
    </div>
    ${copyAlongsideHtml(a)}
  </div>`;
}

// "a", "a or b", "a, b, or c" — for naming the services a record ISN'T on.
function orList(items) {
  if (items.length <= 1) return items[0] || "";
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}

function actionsHtml(a, { notes = true } = {}) {
  // N1 Step 1 — two doors, named by whose words they hold. "Your notes" is the
  // inward door (yours: what you've written here + the composer); "Album details"
  // is the outward one (the record's own story — threads, the room, other
  // releases, the bio). Both pull-only, opened on demand (VISION: story over
  // metadata, pull not push). The stone glyph is flavour; the word carries it.
  // N3a follow-up (owner 2026-07-12): the Choose *inspect* reveal drops "Your
  // notes" — you're deciding, not journaling, and haven't chosen this record yet
  // (`notes: false`). "Album details" stays: learning more is what inspect is for.
  const key = albumKey(a);
  const notesBtn = notes ? `<button class="jbtn note-btn" data-rid="${esc(key)}"
      title="Your notes on this record — and add one">✎ Your notes</button>` : "";
  return `<div class="jactions${notes ? "" : " jactions-one"}">
    ${notesBtn}
    <button class="jbtn story-btn" data-rid="${esc(key)}"
      title="Album details — threads to pull, the room, other releases, the bio">${stoneGlyph()}Album details</button>
  </div>`;
}

// A small shaded pebble — highlight, shaded underside, a crack, a ground shadow.
// The mark of the "why": wherever it sits, you can lift it to see the reasoning
// and story beneath. Fixed stone colours (not theme tokens) so it always reads
// as a real stone on any surface.
function stoneGlyph() {
  return `<svg class="stone" width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"
    style="vertical-align:-3px;margin-right:5px"><ellipse cx="12" cy="19.4" rx="7.4" ry="1.5" fill="#000" opacity=".18"/><path d="M3.5 14.5C2.8 10.5 6.5 6.8 11 6.4 16 6 20.2 8.8 20.6 12.8 21 16.2 17 18.6 12.3 18.9 7.6 19.2 4.3 18 3.5 14.5Z" fill="#9b9281"/><path d="M20.6 12.8C21 16.2 17 18.6 12.3 18.9 10 19 8 18.7 6.4 17.8 9 18 13 17.8 16 16.4 18.6 15.2 20 13.8 20.6 12.8Z" fill="#6f6657"/><ellipse cx="9.4" cy="10.4" rx="3.7" ry="2.1" fill="#c6bda9" opacity=".85"/><path d="M9.8 13.4C12 13 14 13.2 16 14" fill="none" stroke="#6f6657" stroke-width=".9" stroke-linecap="round" opacity=".7"/></svg>`;
}

// A3: a small inline pull-thread, styled like the artist link — looks like text,
// reveals itself on hover. Genre/label reuse the `.story-thread` handler (catalog
// FTS pull); the decade gets its own `.pull-decade` handler (queryless browse).
function catalogThread(field, term) {
  return `<button class="pull-link story-thread" data-field="${esc(field)}"
    data-term="${esc(term)}" title="Pull this thread through the catalog">${
    esc(term)}</button>`;
}
function decadeThread(decade) {
  return `<button class="pull-link pull-decade" data-decade="${esc(decade)}"
    title="Browse the ${esc(decade)} across the catalog">${esc(decade)}</button>`;
}

// The metadata line is a row of doors to pull (A3). Released date + country stay
// plain (provenance); each genre, the label, and the decade are pull-threads.
//
// FB#105 follow-up (owner, on an iPhone 13 mini): "far too many genres/styles
// displayed. We should limit this." This listed every tag a record carried, and
// MusicBrainz records can carry dozens — one card ran to ~50, a paragraph of chips
// that buried the Listen and Album details buttons below the fold and made the card
// unreadable as a card. The deck has capped its own line at 3 since 2026-07-12 for
// the same reason; this is the catalog row, where genres are the threads you actually
// pull, so it gets more than the deck but not everything. The rest aren't lost —
// Album details still lists the record in full.
const MAX_CARD_GENRES = 6;

function metaSub(a) {
  const sep = ' <span class="dot">·</span> ';
  const parts = [];
  if (a.released) parts.push(esc(a.released));
  if (a.country) parts.push(esc(a.country));
  genresOf(a).slice(0, MAX_CARD_GENRES)
    .forEach((g) => parts.push(catalogThread("genres", g)));
  if (a.label) parts.push(catalogThread("label", a.label));
  const dec = decadeOf(a);
  if (dec) parts.push(decadeThread(dec));
  return parts.join(sep);
}

// Deliberately spare meta for the Today deck (owner 2026-07-12): just the year (the
// month/day is implicit — it's on-this-day) and at most three genres. No full date,
// no country, no label, no decade — the deck is for noticing one record, not
// scanning a catalog row. Genres stay pull-threads.
//
// B25 adds exactly two facts, and ONLY when they'd otherwise surprise you: that the
// record is a compilation, and that it's long. Feedback #64 met a 102-track box set
// rendered identically to a 40-minute album — the defect was silence, not the record.
// ~97% of records say neither thing, so the spare deck stays spare and speaks up
// where it has something to warn you about. Both are exact, counted facts (the
// entity's type; the tracklist we actually hold), never a guess — an unknown length
// says nothing rather than "0 tracks" (honesty rule).
const LONG_RECORD_TRACKS = 25;    // a double LP is ~20-24; past this it's a set

function deckMeta(a) {
  const sep = ' <span class="dot">·</span> ';
  const parts = [];
  const yr = a.year || (a.released ? String(a.released).slice(0, 4) : "");
  if (/^\d{4}$/.test(String(yr))) parts.push(esc(String(yr)));
  // Plain text, not a pull-link: these are facts about the record, not threads to
  // follow. The sub line is already muted, and the genres beside them are buttons,
  // so they read as quiet by contrast — no new styling needed.
  if (a.is_compilation) parts.push("compilation");
  // esc() expects a string (it calls .replace), and n_tracks arrives as a JSON
  // number — String() first or this throws and takes the whole card render with it.
  if (a.n_tracks >= LONG_RECORD_TRACKS) {
    parts.push(`${esc(String(a.n_tracks))} tracks`);
  }
  genresOf(a).slice(0, 3).forEach((g) => parts.push(catalogThread("genres", g)));
  return parts.join(sep);
}

function metaHtml(a) {
  return `<div class="meta">
    <div class="artist">${artistLink(a.artist)}</div>
    <div class="title">${esc(a.title)}</div>
    <div class="sub">${metaSub(a)}</div>
    ${linksHtml(a)}
    ${actionsHtml(a)}
  </div>`;
}

// ACC1 Theme A: a keyboard- and screen-reader-operable hit area for a clickable
// card. The cards carry inner controls (artist link, Listen chips), so the
// card itself can't be role="button" without nesting focusable elements (the
// anti-pattern). Instead we lay a real, stretched <button> over the card for its
// PRIMARY action: its click bubbles to the card's existing click handler, and the
// inner controls sit above it (CSS z-index) and keep their own clicks. One accessible
// name, no nesting, mouse behavior unchanged. `verb` is "Choose" or "Open".
function cardHit(verb, a) {
  const name = [a.artist, a.title].filter(Boolean).join(" — ");
  return `<button type="button" class="card-hit" aria-label="${esc(verb + " " + name)}"></button>`;
}

function browseCard(a) {
  // U6: the whole card opens the Threads/story view (its inner links/buttons
  // still win their own clicks — see the delegated handler). The card-hit button
  // (ACC1) makes that primary "open" reachable by keyboard + screen readers.
  return `<div class="card" data-rid="${esc(albumKey(a))}">${cardHit("Open", a)}${coverHtml(a)}${metaHtml(a)}</div>`;
}

// --- TODAY (the deck) -------------------------------------------------------
// One record at a time from the day's pool. "✎ Write a note" opens the ordinary
// note composer (Keep retired at v329 — writing is the act); Skip stacks the record
// in a local, per-day, reopenable pile.

// The active day's deck, ephemeral and per-day (D2): { key, records, idx, noted,
// aside }. Leaving Today and returning restores your place; a date rollover or a
// filter/dig change (loadDeck(true)) starts fresh. Nothing here is persisted or
// synced — the set-aside pile lives only in this object, only for today.
let deckState = null;

// A one-time client shuffle so the day doesn't always lead with the same
// catalog-ordered record — the draw stays "pure chance" (VISION), just finite now.
function shuffled(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// The deal (owner, 2026-10-04; GENRE_BACKFILL_DESIGN.md "Deal balancing"). Today is
// dealt in turns sized to how much of the day each tag is, softened: a tag's chance at
// the next slot is (records it has left)^0.85, so the day's big sounds still show up
// but a little lighter, and a tag that's 0.4% of the day isn't dealt 17x its share.
// (That was the old deal: 13 hidden genres, one record each per round, which put
// reggae, funk and celtic all over the top of Today. Retired with those genres.)
// Plus one rule: never the same tag twice in a row while anything else is left — that
// is what breaks up runs; sizing turns alone doesn't. Measured over 12 days (35,011
// records): no genre dealt more than ~2x its share, electronic and rock ~0.9x, the
// longest one-genre run ~1.7. Nothing is hidden or ranked — every record stays in the
// deck. A record's tag here is its FIRST tag (merged spellings via tagKey), the one
// the record leads with; records with no tag yet share "" and may sit together.
// Re-measure with tools/measure_deal.py when the day's tags change a lot.
const DEAL_SIZE_POWER = 0.85;
function dealKey(rec) {
  const first = genresOf(rec)[0] || (rec.styles || "").split(",")[0] || "";
  return tagKey(first);
}
function balancedOrder(list, rand = Math.random) {
  const groups = new Map();
  for (const rec of list) {
    const k = dealKey(rec);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(rec);
  }
  const live = [...groups.entries()].map(([k, recs]) => {
    const q = shuffled(recs);
    return { k, q, w: Math.pow(q.length, DEAL_SIZE_POWER) };
  });
  let total = live.reduce((t, g) => t + g.w, 0);
  const out = [];
  let last = null;
  while (live.length) {
    const blocked = last && last.k !== "" && last.q.length && live.length > 1 ? last : null;
    let x = rand() * (total - (blocked ? blocked.w : 0));
    let g = live[live.length - 1] === blocked ? live[live.length - 2] : live[live.length - 1];
    for (const cand of live) {
      if (cand === blocked) continue;
      if (x < cand.w) { g = cand; break; }
      x -= cand.w;
    }
    out.push(g.q.pop());
    total -= g.w;
    if (g.q.length) {
      g.w = Math.pow(g.q.length, DEAL_SIZE_POWER);
      total += g.w;
    } else {
      live.splice(live.indexOf(g), 1);
    }
    last = g;
  }
  return out;
}

// B25 — deal compilations and box sets LATER, not never. Feedback #64/#65: a
// 102-track Proper Records box set ("Slim Gaillard — Laughing in Rhythm") and a
// generic Various-Artists comp both arrived looking exactly like a 40-minute album.
// They're ~7% of a day's available pool (measured 2026-07-18), so they're not
// flooding Today — but meeting one is a poorer version of the daily act, since
// there's no single record to sit with.
//
// Same discipline as balancedOrder above: this REORDERS the deal, it never removes.
// Every compilation stays in the deck and stays reachable by keeping going; a share
// of them (see the rate) still rides in normal rotation, so this reads as "fewer,"
// not "none" — the day is still what the day holds. `is_compilation` is the
// server's flag (pooldb._is_compilation owns the taxonomy; the client never
// re-derives it), and a record with no verdict is simply not held back.
//
// Set the rate to 1 to turn this off entirely.
const COMP_DEAL_RATE = 0.25;      // ~1 in 4 compilations stays in normal rotation

function dealOrder(list) {
  const front = [], back = [];
  for (const rec of list) {
    if (rec.is_compilation && Math.random() >= COMP_DEAL_RATE) back.push(rec);
    else front.push(rec);
  }
  // Each tier is genre-balanced in its own right, so holding some records back
  // can't skew the variety of what you meet first.
  return back.length ? [...balancedOrder(front), ...balancedOrder(back)]
                     : balancedOrder(front);
}

// --- "Already met today" set (D6) --------------------------------------------
// A record you kept or shelved today should not be served to you again the same
// day — not even after a reload, which drops the in-memory deck and would otherwise
// re-shuffle the whole day from the top. We remember the keys you've acted on in a
// single localStorage entry scoped to today's date; a new day resets it. This is
// local, per-day, and never synced or sent anywhere (VISION: pull, not push — it's
// your own state on your own machine, not a profile).
const MET_KEY = "mf-today-met/v1";
function todayFull() {
  const n = new Date();
  return `${n.getFullYear()}-${todayMD()}`;
}
function loadMet() {
  try {
    const o = JSON.parse(localStorage.getItem(MET_KEY));
    if (o && o.date === todayFull() && Array.isArray(o.keys)) return new Set(o.keys);
  } catch (e) { /* corrupt or absent → empty */ }
  return new Set();
}
function saveMet(set) {
  try {
    localStorage.setItem(MET_KEY,
      JSON.stringify({ date: todayFull(), keys: [...set] }));
  } catch (e) { /* private mode / quota — a repeat is better than a thrown deck */ }
}
function markMet(key) {
  if (!key) return;
  const s = loadMet(); s.add(key); saveMet(s);
}
function unmarkMet(key) {           // undoing a keep makes the record servable again
  if (!key) return;
  const s = loadMet();
  if (s.delete(key)) saveMet(s);
}

// --- "Where you were today" (FB 2026-07-18) ----------------------------------
// A reader opened a record, tapped Listen, and came back to a DIFFERENT record —
// "I wanted to save one after listening to a couple songs, but the next album had
// surfaced and I couldn't go back." Nothing advanced the deck: `deckState` is
// in-memory only, so anything that ends the page (iOS discarding a backgrounded
// tab, or the Listen fallback navigating the tab to the streaming site) rebuilds
// it — and `loadDeck` re-deals the day at random from idx 0. The odds of landing
// back on the record you were reading are about 1 in 2,000.
//
// So remember WHICH record you're on. Just the uid + the date: ~60 bytes, versus
// ~57 KB (417 KB on Jan 1) to store the whole deal order — and localStorage is a
// shared budget with the E2EE notebook, which is the irreplaceable thing here.
//
// Local, per-day, never synced (VISION: your own state on your own machine, not a
// profile), and self-expiring on the date like MET_KEY above. It must also cost
// NOTHING when it's gone — cleared site data, private mode, Safari's ~7-day
// eviction — so every failure path falls through to a fresh deal, which is exactly
// today's behaviour.
const AT_KEY = "mf-today-at/v1";
function loadAt() {
  try {
    const o = JSON.parse(localStorage.getItem(AT_KEY));
    if (o && o.date === todayFull() && typeof o.uid === "string") return o.uid;
  } catch (e) { /* corrupt or absent → no resume */ }
  return null;
}
function saveAt(uid) {
  try {
    if (uid) localStorage.setItem(AT_KEY, JSON.stringify({ date: todayFull(), uid }));
    else localStorage.removeItem(AT_KEY);
  } catch (e) { /* private mode / quota — losing your place beats a thrown deck */ }
}

// Put the record you were last on back at the front of a freshly dealt deck. NOT a
// jump to its old index: the records before it were never seen, so skipping them
// would quietly cost you part of the day. Everything else keeps its dealt order
// behind it.
//
// Returns the list untouched whenever the remembered record isn't available — no
// entry, a new day, or it's since been kept/skipped (it's filtered out of `records`
// before this runs) or dropped out of the pool. Deliberately absorbing: a resume
// that can't be honoured is a fresh deal, never an error.
// READY FIRST (owner 2026-10-05: "select the fastest one we can find whenever the app
// first opens … regardless of whether they are a guest or not"). The first card of a
// fresh visit is a record whose cover and Listen links are ALREADY in the day's list —
// resolveDoor's own test — so the card is complete the moment the day lands, with no
// links lookup behind a spinner. It's the first such record within the deal's opening
// stretch, so the deal's balance barely moves; a day without one is left as dealt.
function doorNeeded(a) {
  const have = a.platforms || {};
  return !(a.cover && have.spotify && have.youtube);
}
function readyFirst(list, look = 40) {
  const i = list.slice(0, look).findIndex((r) => !doorNeeded(r) && deckCoverShows(r));
  if (i <= 0) return list;
  return [list[i], ...list.slice(0, i), ...list.slice(i + 1)];
}

function resumeAt(list) {
  const uid = loadAt();
  if (!uid) return list;
  const i = list.findIndex((r) => albumKey(r) === uid);
  if (i <= 0) return list;                 // absent, or already first
  return [list[i], ...list.slice(0, i), ...list.slice(i + 1)];
}

// THE FIRST CARD (v348, owner 2026-10-05). The day's full list is ~600 KB behind ~1.1 s
// of server time, and the first card used to wait for all of it. /api/pool/first
// answers with a few ready records from a set the server keeps warm (your saved place
// first, when you have one), so the card can be drawn while the day is still on its
// way. That card is PROVISIONAL, a one-record deck, until the day lands; then the same
// record leads the full deal (pinned, not redrawn under you), and a Next or a note on
// it in between carries over. The server only offers candidates: what you've already
// met today never leaves your device, so the pick is made here.
let _fastFirst = null;   // { seq } of the load whose provisional card is showing
function firstCardEndpoint(at) {
  const u = new URL(dayEndpoint(), location.origin);
  u.pathname = "/api/pool/first";
  if (at) u.searchParams.set("uid", at);
  return u.pathname + u.search;
}
function pickFirstCard(albums, at, met) {
  const list = (albums || []).filter((r) => r && !met.has(albumKey(r)));
  if (at && list.length && albumKey(list[0]) === at) return list[0];   // your place
  return list.find((r) => !doorNeeded(r) && deckCoverShows(r)) || null;
}
// Warm the next card's cover now, quietly, so Next lands as fast as the first did.
function warmUpNext() {
  const upNext = deckState && deckState.records[deckState.idx + 1];
  if (upNext && isRemoteUrl(upNext.cover) && deckCoverShows(upNext)) {
    const warm = new Image();
    warm.fetchPriority = "low";
    warm.src = caaThumb(upNext.cover);
  }
}
function pinFirst(list, rec) {
  const k = albumKey(rec);
  return [rec, ...list.filter((r) => albumKey(r) !== k)];
}
async function fastFirstCard(seq, key) {
  if (!poolOn() || digMode || _firstRun || filtersActive()) return;
  let data;
  try { data = await api(firstCardEndpoint(loadAt())); } catch (e) { return; }
  // Only for this same load, while the day is still on its way.
  if (seq !== _deckSeq || !_deckLoading || _firstRun) return;
  noteCachedCovers(data && data.albums);
  const rec = pickFirstCard(data && data.albums, loadAt(), loadMet());
  if (!rec) return;
  _fastFirst = { seq };
  deckState = { key, all: [rec], records: [rec], idx: 0, noted: new Set(), aside: [],
                provisional: true };
  renderDeck();
}

// Owner, on device 2026-10-03: the loading card was laid out differently from the
// loaded one — no Listen button, no button row — so the Genre / Year / Skipped row sat
// high and then dropped when the record arrived. So the placeholder is now built from
// the SAME elements as renderDeck's card (deck-cover, deck-meta, deck-listen's chip,
// deck-buttons' two buttons), shimmering in place of their content. Every height and
// margin is inherited from the real rule rather than restated here, which is the only
// way they can't drift apart again. Keep the two in step if the card's shape changes.
// A fresh deal: back to your place if you have one today (resumeAt), else ready first.
function dealFresh(dealt) {
  const at = loadAt();
  return at && dealt.some((r) => albumKey(r) === at) ? resumeAt(dealt) : readyFirst(dealt);
}

function deckLoadingHtml() {
  return `<article class="deck-card skeleton" aria-hidden="true">
    <div class="deck-cover"><div class="cover skel"></div></div>
    <div class="deck-meta">
      <p class="deck-title"><span class="skel skel-text" style="width:78%">&nbsp;</span></p>
      <p class="deck-sub"><span class="skel skel-text" style="width:40%">&nbsp;</span></p>
    </div>
    <div class="deck-listen"><div class="choice-listen"><div class="listen-chips listen-solo">
      <span class="listen-chip primary skel skel-fill">&nbsp;</span></div></div></div>
    <div class="deck-buttons">
      <span class="note-btn skel skel-fill">&nbsp;</span>
      <span class="set-aside-btn skel skel-fill">&nbsp;</span>
    </div>
  </article>`;
}

// Fetch the day's records (D1: the whole day's AVAILABLE pool via dayEndpoint →
// /api/pool/day; dig=1 = the full union). force=true drops the cached deck (a
// filter/dig change or an explicit reload); otherwise a same-day return restores
// the deck exactly where you left it, set-aside pile and all.
// The day is the core surface, so a transient miss — an offline blip, or the ~27s
// 502 while Render swaps instances on a deploy (B30) — shouldn't drop you to an empty
// state on the very first failure. Retry a few times with a short backoff behind the
// skeleton before giving up. A read with no side effects, so a retry is always safe.
const DAY_RETRY_DELAYS = [1200, 3500];   // after attempt 1, then attempt 2 (≈4.7s total)
// What kind of open this day fetch is, for the operator's Log (2026-10-07, owner: "keep
// track of all of this so we can understand where the data comes from … unique opens
// versus the same user opens"). One coarse word, never an identity: "first" — this
// device's first fetch of its own local day (the only date kept is the device's, in its
// own storage, so the count of firsts is how many devices opened the app, with nothing
// sent that could tell them apart); "platforms" — a change of listening platforms
// re-dealt the day; "reload"; or "again" — any other open later the same day.
const OPEN_DAY_KEY = "mf-open-day";
let _openWhy = null;          // set by refreshSurfaces for a platform change
let _openedThisPage = false;  // a page's first day fetch can be a reload
function openKind() {
  const why = _openWhy; _openWhy = null;
  const firstFetch = !_openedThisPage; _openedThisPage = true;
  let last = null;
  try { last = localStorage.getItem(OPEN_DAY_KEY); } catch (e) { /* storage blocked */ }
  if (last !== todayFull()) {
    try { localStorage.setItem(OPEN_DAY_KEY, todayFull()); } catch (e) { /* counts as first again */ }
    return "first";
  }
  if (why) return why;
  let nav = "";
  try { nav = (performance.getEntriesByType("navigation")[0] || {}).type || ""; } catch (e) { /* old browser */ }
  return firstFetch && nav === "reload" ? "reload" : "again";
}
async function loadDayWithRetry() {
  let lastErr;
  const kind = openKind();            // once per load: a retry is the same open
  for (let i = 0; i <= DAY_RETRY_DELAYS.length; i++) {
    try { return await api(dayEndpoint(), { "X-MF-Open": kind }); }
    catch (e) {
      lastErr = e;
      if (i < DAY_RETRY_DELAYS.length)
        await new Promise((r) => setTimeout(r, DAY_RETRY_DELAYS[i]));
    }
  }
  throw lastErr;
}

// Two loads can overlap — a platform change while the day is still arriving, or Start
// on the first-run picker with services chosen while the unfiltered day is still in
// flight. The NEWEST load wins: an older one that lands later is dropped, where before
// whichever finished last overwrote the deck. _deckLoading says one is in flight.
let _deckSeq = 0;
let _deckLoading = false;

async function loadDeck(force = false) {
  const key = mdParam();
  if (_mode === "decide") setSubtitleFor("decide", key);   // the masthead names this day
  if (!force && deckState && deckState.key === key && deckState.all && deckState.all.length) {
    renderGenrePref();
    if (deckState.records.length) renderDeck();
    else renderGenreFilteredEmpty();
    return;
  }
  // FIRST RUN: the picker owns #choice until Start. The day still loads behind it, so
  // Start can deal at once, but nothing here may paint over it — and every write
  // re-checks, because a load begun under the picker can land after Start.
  const paint = (html) => {
    const w = $("#choice");
    if (!w || _firstRun) return null;
    w.innerHTML = html;
    return w;
  };
  // v350: platforms changed from the record's own card (the listen sheet) — that record
  // stays on screen as a provisional one-record deck (the first card's machinery), its
  // button repainted for your new platforms, and leads the new deal; nothing blanks.
  const pin = _pinNext && _pinNext.key === key ? _pinNext : null;
  _pinNext = null;
  if (!pin) paint(deckLoadingHtml());
  const seq = ++_deckSeq;
  _deckLoading = true;
  if (pin) {
    _fastFirst = { seq };
    deckState = { key, all: [pin.rec], records: [pin.rec], idx: 0,
                  noted: pin.noted || new Set(), aside: pin.aside || [], provisional: true };
    repaintChoiceListen();
    updateSetAsideBar();
  } else {
    fastFirstCard(seq, key);                      // the first card, ahead of the day
  }
  let data;
  try {
    data = await loadDayWithRetry();
  } catch (e) {
    if (seq !== _deckSeq) return;                 // a newer load owns the deck now
    _deckLoading = false;
    // A provisional first card stays up (you may be reading it); the retry waits
    // behind it, where the rest of the day would have been.
    if (deckState && deckState.provisional && _fastFirst && _fastFirst.seq === seq) {
      deckState.loadFailed = true;
      if (deckState.idx >= deckState.records.length) renderDeck();
      return;
    }
    // Out of retries — likely a deploy's 502 window outlasting them. Offer a real
    // tappable retry (wired with addEventListener; the CSP forbids inline handlers)
    // rather than a dead "try again" sentence.
    const w = paint(`<div class="empty">Couldn't load today's records.
          <button type="button" class="linklike" id="deckRetry">Try again</button></div>`);
    const rb = w && w.querySelector("#deckRetry");
    if (rb) rb.addEventListener("click", () => loadDeck(true));
    return;
  }
  if (seq !== _deckSeq) return;                   // superseded while it was in flight
  _deckLoading = false;
  _spotifyTrouble = !!data.spotify_trouble;
  noteDayLinks(data.albums);
  noteCachedCovers(data.albums);
  // The provisional first card this load drew, if any: `cur` is it while it's still on
  // screen (undefined once you've moved past it with Next or a note).
  const prov = (deckState && deckState.provisional && _fastFirst && _fastFirst.seq === seq)
    ? deckState : null;
  const cur = prov ? prov.records[prov.idx] : undefined;
  // Dedup defensively by album key (the server already collapses clustered dups, but
  // never show the same record twice within one response), then drop records you've
  // already met today so a reload doesn't re-serve what you kept or shelved (D6).
  const met = loadMet();
  const seen = new Set();
  const raw = (data.albums || []).filter((r) => {
    const k = albumKey(r);
    if (k && seen.has(k)) return false;
    if (k) seen.add(k);
    return true;
  });
  const rawCount = raw.length;
  const records = raw.filter((r) => !met.has(albumKey(r)));
  // Everything today was already met (not a thin date): show the calm end-of-day
  // state, not the "no records with a known date" empty. deckState.all is empty, so
  // renderDeck falls straight through to deckEndHtml.
  if (rawCount && !records.length && !cur) {
    deckState = { key, all: [], records: [], idx: 0, noted: new Set(), aside: [] };
    renderGenrePref();
    renderDeck();
    return;
  }
  if (!records.length && !cur) {
    deckState = null;
    updateSetAsideBar();
    // Under the opt-in filter an empty day means "nothing on your platforms" — never
    // a dead end: point to dig (always unfiltered). Otherwise it's a genuinely thin
    // date; point out to Explore, never a blank wall (VISION guardrail).
    paint(data.filtered
      ? platformSuggestionHtml(spotifyTroubleLead() || "Nothing today on your listening platforms.")
      : `<div class="deck-end"><p class="deck-end-lead">We don't have any records from ${
          esc(mdDisplay(key))} in our database.</p></div>`);
    return;
  }
  // Keep the full day (`all`) so the genre filter can re-derive the visible deck
  // without a refetch; `records` is the balanced view of the (optionally) filtered set.
  // resumeAt only on this FRESH-BUILD path: the same-session early return above
  // already has your place, and a filter change (which re-deals via the other
  // dealOrder call site) is a deliberate "show me something else".
  // The first card already drawn leads the deal (the same object, so nothing on it is
  // redrawn); once you've moved past it, the deal starts ready-first as usual.
  const dealt = dealOrder(applyDeckFilters(records));
  deckState = { key, all: records,
                records: cur ? pinFirst(dealt, cur) : prov ? readyFirst(dealt) : dealFresh(dealt),
                idx: 0, noted: prov ? prov.noted : new Set(), aside: prov ? prov.aside : [] };
  renderGenrePref();
  const onScreen = cur && $("#choice .deck-card[data-uid]");
  if (onScreen && onScreen.dataset.uid === albumKey(cur)) { updateSetAsideBar(); warmUpNext(); }
  else if (deckState.records.length) renderDeck();
  else renderGenreFilteredEmpty();
}

// Entering Today (init, a tab click, a wander return) reuses the pending deck —
// your place is exactly where you left it. A fresh load only happens when there's
// no deck for today yet.
function enterToday() {
  if (deckState && deckState.key === mdParam() && deckState.records.length) {
    renderDeck();
    return Promise.resolve();
  }
  return loadDeck();
}

// Paint the current record — one at a time — with Keep / Set aside and its Listen
// door. At the end of the finite deck, a calm "that's every record for today"
// state that still points somewhere (Notebook, the set-aside pile, dig) — never a
// blank wall (VISION guardrail).
function renderDeck() {
  if (_firstRun) { renderFirstRun(); return; }
  const wrap = $("#choice");
  if (!wrap || !deckState) return;
  updateSetAsideBar();
  if (deckState.idx >= deckState.records.length) {
    // A provisional first card was all we had: the rest of the day is still coming.
    if (deckState.provisional) {
      wrap.innerHTML = deckState.loadFailed ? `<div class="empty">Couldn't load today's records.
          <button type="button" class="linkish" id="deckRetry">Try again</button></div>`
        : deckLoadingHtml();
      const rb = wrap.querySelector("#deckRetry");
      if (rb) rb.addEventListener("click", () => loadDeck(true));
      return;
    }
    saveAt(null);              // deck's done — there's no record to come back to
    wrap.innerHTML = deckEndHtml();
    return;
  }
  const a = deckState.records[deckState.idx];
  const key = albumKey(a);
  saveAt(key);                 // whatever is on screen IS your place (see AT_KEY)
  a._doorPending = poolOn() && !a._doorFilled;
  // FB#101 (owner): the eyebrow moved UP into the header line, where the tagline
  // used to sit — so the day is framed once, at the top of the page, instead of
  // twice within a screen of itself. See setSubtitleFor.
  wrap.innerHTML = `
    <article class="deck-card" data-uid="${esc(key)}">
      <div class="deck-open open-story" data-rid="${esc(key)}">
        ${cardHit("Album details for", a)}
        <div class="deck-cover">${coverHtml(a)}</div>
        <div class="deck-meta">
          <p class="deck-title">${artistLink(a.artist)} — <b>${esc(a.title)}</b></p>
          <p class="deck-sub"><span class="ds-facts">${deckMeta(a)}</span><span id="deckOpened"
            class="ds-mark">${deckOpenedHtml(key)}</span></p>
        </div>
      </div>
      <div id="deckListen" class="deck-listen">${deckListenHtml(a)}</div>
      <!-- v329 (owner 2026-10-03): Keep is retired. Writing a note is how a record
           becomes yours, and tapping Listen leaves an "opened" entry on its own, so
           the pair is Write a note + Next (Skip until v331). Write a note sits where
           Keep was, so a thumb that still reaches for Keep lands on writing, not on
           moving past the record. -->
      <div class="deck-buttons">
        <button type="button" id="noteBtn" class="note-btn">✎ Write a note</button>
        <button type="button" id="setAsideBtn" class="set-aside-btn">Next</button>
      </div>
    </article>`;
  observeArt(wrap, { eager: 2 });
  warmUpNext();
  // Fan out the confirmed door (like the keep reveal) and repaint just the listen
  // row when Spotify/YouTube/etc. resolve — never leave the spinner spinning. One
  // button, your #1 confirmed platform (compact): the pool is already filtered to
  // what you can play, so backups + the "Listen on ___" label are just clutter.
  resolveDoor(key).then(() => {
    a._doorPending = false;
    if (deckState && deckState.records[deckState.idx] === a) {
      const el = $("#deckListen");
      if (el) el.innerHTML = deckListenHtml(albumData[key] || a);
      recheckAppleArt($("#choice"));
    }
  });
  // The composer is the one choke point for writing (guest cap included); saving a
  // note on today's record moves the deck on — see afterNoteSaved.
  $("#noteBtn").addEventListener("click", () => {
    rememberNames(key, a.artist, a.title);   // saveNote snapshots the name from here
    openNoteModal(key);
  });
  $("#setAsideBtn").addEventListener("click", setAsideCurrent);
}

// End of the finite deck — you've seen every record for today. Calm, and always a
// door out: what you wrote about (Notebook), the pile you set aside, or dig for more.
// (v329: counted notes, not keeps — Keep is retired.)
// OUT OF RECORDS (owner 2026-10-05). "The first check should be for filters and a
// suggestion to change filters should be the only thing seen. Then if truly no filters
// are selected, the message should just read 'We don't have any more records from
// Month Day in our database'" — keeping only the dig-deeper line under it. The "you
// didn't write about any" and "look again at the ones you've seen" lines are gone.
// Filters, in order: Filter's tags / years, then your listening platforms. Dig mode
// ignores every filter, so in dig there is only ever the plain message.
function filterSuggestionHtml(lead) {
  return `<div class="deck-end deck-end-filtered">
    <p class="deck-end-lead">${lead}</p>
    <div class="deck-end-actions">
      <button type="button" class="dig-pill" data-change-filters>Change filters</button>
      <button type="button" class="linkish" data-clear-genres>Clear filters</button>
    </div></div>`;
}
function platformSuggestionHtml(lead) {
  return `<div class="deck-end deck-end-filtered">
    <p class="deck-end-lead">${lead}</p>
    <div class="deck-end-actions">
      <button type="button" class="dig-pill" data-change-platforms>Change listening platforms</button>
      <button type="button" class="linkish" data-clear-platforms>See every record</button>
    </div></div>`;
}
function filtersActive() {
  return !digMode && !!(genreTags.size || deckEras.size || deckYearFrom != null || deckYearTo != null);
}
function deckEndHtml() {
  if (filtersActive()) return filterSuggestionHtml("No more records today match your filters.");
  if (!digMode && filterPlatformKeys().length)
    return platformSuggestionHtml(spotifyTroubleLead() || "No more records today on your listening platforms.");
  const digLine = (poolOn() && !digMode)
    ? `<p class="muted"><button class="linkish" data-dig-escape>Dig deeper — include records with no confirmed way to listen yet →</button></p>`
    : "";
  return `<div class="deck-end">
    <p class="deck-end-lead">We don't have any more records from ${esc(mdDisplay(mdParam()))} in our database.</p>
    ${digLine}
  </div>`;
}

// Advance past the current record (after a keep or a set-aside). One record at a
// time, so this is just "next" — there is no reshuffle (D5).
function advanceDeck() {
  if (!deckState) return;
  deckState.idx++;
  renderDeck();
}

// B35: did this failure mean "you're signed out" rather than "the save broke"?
// A 401 is the whole answer — store-bridge now returns one for a sync 401 that
// even a token refresh couldn't rescue (instead of flattening it into a 500), and
// a direct-to-server 401 means the same thing. Deliberately NOT keyed on the
// body's `session_expired` flag: the status is what both paths agree on, and it
// needs no parsing of a response that may already have been read.
function sessionExpiredFrom(resp) {
  return !!(resp && resp.status === 401);
}

// Plain words for it, from the reader's side, no jargon (BRAND.md). A failed NOTE
// has the reader's own words sitting in the box, and a reload would throw them away
// to fix a sign-in — so this never offers one. (We can't stash the draft either:
// notes are E2EE, and parking plaintext in localStorage to survive a reload would
// break that promise for the sake of convenience.)
const SESSION_EXPIRED_NOTE_MSG =
  "Your sign-in expired. Your note is still here — copy it, then reload to sign back in.";

// Every record you have EVER kept: uid -> choice id, from /api/choices/kept (FB#87 —
// "it seems silly to add it twice"). Keep retired at v329, so this only ever names
// records kept before then — Album details still says "Kept ✓" for them. Loaded once,
// lazily, the first time a door opens. null until it lands; a door that opens first
// shows what this session knows and corrects itself when the answer arrives.
let keptIndex = null;
let keptIndexPromise = null;

function loadKeptIndex() {
  if (keptIndexPromise) return keptIndexPromise;
  keptIndexPromise = fetch("/api/choices/kept")
    .then((r) => (r.ok ? r.json() : { kept: {} }))
    .then((d) => { keptIndex = new Map(Object.entries(d.kept || {})); return keptIndex; })
    // Best-effort: a failed lookup must never block the door. An empty index just means
    // no "Kept ✓" line, which is an omission, not a broken bar.
    .catch(() => { keptIndex = new Map(); return keptIndex; });
  return keptIndexPromise;
}

function isKeptRecord(key) {
  return !!(keptIndex && keptIndex.has(key));
}

// Set aside → stack the record in the local, per-day pile (D2) and move on. A door,
// not a discard: it's reopenable from the pile and brings you back in place.
function setAsideCurrent() {
  if (!deckState || deckState.idx >= deckState.records.length) return;
  const a = deckState.records[deckState.idx];
  const key = albumKey(a);
  markMet(key);                          // shelved counts as met — no re-serve on reload
  if (!deckState.aside.some((x) => albumKey(x) === key)) deckState.aside.push(a);
  advanceDeck();
}

// Reorder-only pref change: the SET (what surfaces) is unchanged, so we don't
// refetch/re-draw — we just restack the listen order on the deck card's listen
// block. (A membership change goes through refreshSurfaces instead, which redraws
// from the new pool.)
function repaintChoiceListen() {
  const dk = document.getElementById("deckListen");
  if (dk && deckState && deckState.idx < deckState.records.length) {
    const a = deckState.records[deckState.idx];
    dk.innerHTML = deckListenHtml(albumData[albumKey(a)] || a);
    recheckAppleArt($("#choice"));
  }
}

// --- SET-ASIDE PILE (D2) ----------------------------------------------------
// The records you skipped today, stacked in a reopenable pile. Local, per-day and
// ephemeral (never persisted or synced) — it lives only in deckState.aside and
// clears when the deck resets (a new day, or a filter/dig reload). It's a *door*,
// not a discard: pull it open and bring any record back in place (VISION: pull-only,
// returnable at zero cost).
function updateSetAsideBar() {
  const bar = $("#setAsideBar");
  if (!bar) return;
  const n = (deckState && deckState.aside.length) || 0;
  const count = $("#setAsideCount");
  if (count) count.textContent = String(n);
  // FB#105 follow-up (owner): "have the skipped pill be a constant pill with a count of
  // 0, 1, etc. so that the first 'skip' press doesn't create a button and change the
  // layout." It used to appear on the first skip, which reflowed the row under the
  // record at the exact moment your thumb was still moving — the worst possible time
  // for the layout to shift. It's always in the row now, reading 0 until there's
  // something in the pile. `is-empty` greys it and takes it out of the tab order; it
  // stays a real, labelled control rather than becoming a ghost.
  bar.classList.remove("hidden");
  bar.classList.toggle("is-empty", n === 0);
  bar.setAttribute("aria-disabled", n === 0 ? "true" : "false");
  if (n === 0) { bar.removeAttribute("tabindex"); closeAsidePile(); }
  else bar.setAttribute("tabindex", "0");
}

function openAsidePile() {
  const sheet = $("#setAsideSheet");
  if (!sheet || !deckState || !deckState.aside.length) return;
  renderAsideList();
  sheet.classList.remove("hidden");
  const close = $("#setAsideClose");
  if (close) close.focus({ preventScroll: true });
}

function closeAsidePile() {
  const sheet = $("#setAsideSheet");
  if (sheet) sheet.classList.add("hidden");
}

function renderAsideList() {
  const list = $("#setAsideList");
  if (!list || !deckState) return;
  if (!deckState.aside.length) {
    list.innerHTML = `<p class="empty">Nothing here yet.</p>`;
    return;
  }
  list.innerHTML = deckState.aside.map((a) => {
    const key = albumKey(a);
    const sub = esc([a.released, ...genresOf(a)].filter(Boolean).join(" · "));
    return `<div class="sas-item" data-uid="${esc(key)}">
      <div class="sas-thumb">${coverHtml(a, { fix: false })}</div>
      <div class="sas-body">
        <p class="sas-title">${esc(a.artist)} — <b>${esc(a.title)}</b></p>
        <p class="sas-sub muted">${sub}</p>
      </div>
      <button type="button" class="sas-bring" data-bring="${esc(key)}">Bring back</button>
    </div>`;
  }).join("");
  observeArt(list, { eager: 8 });
}

// Bring a set-aside record back into the deck as the current card — a door that
// returns you to it in place; the record you were on shifts to next (or, at the end
// of the deck, it becomes the last card so you land right on it).
function bringBack(uid) {
  if (!deckState) return;
  const i = deckState.aside.findIndex((x) => albumKey(x) === uid);
  if (i < 0) return;
  const [a] = deckState.aside.splice(i, 1);
  const at = Math.min(deckState.idx, deckState.records.length);
  deckState.records.splice(at, 0, a);
  deckState.idx = at;
  closeAsidePile();
  renderDeck();
}

// --- BROWSE MODE ------------------------------------------------------------
let browseAll = [];
let browseScope = "day";             // "day" = selected date · "all" = catalog
let _searchDebounce = null;
const selectedGenres = new Set();   // empty = all genres

function decadeOf(a) {
  return a.year ? `${Math.floor(a.year / 10) * 10}s` : null;
}

// Discogs genres are comma-joined, but one official genre — "Folk, World, &
// Country" — contains commas itself. It's the ONLY one that does, so we protect
// that exact phrase before splitting so it stays a single category.
// NOTE: this mirrors genres.py (ATOMIC_GENRES / split_genres) on the backend —
// keep the two in sync if Discogs ever adds another comma-containing genre.
const ATOMIC_GENRES = ["Folk, World, & Country"];

function genresOf(a) {
  let s = a.genres || "";
  ATOMIC_GENRES.forEach((g, i) => { s = s.split(g).join(`@@G${i}@@`); });
  return s.split(",").map((t) => t.trim()).filter(Boolean)
    .map((t) => {
      const m = /^@@G(\d+)@@$/.exec(t);
      return m ? ATOMIC_GENRES[+m[1]] : t;
    });
}

// FB#57b: the record's finer Discogs *styles* ("Art Rock", "IDM", "Thrash") — the
// tags beyond the coarse genre. Plain comma-split (no atomic-comma phrase like the
// genres have). Deduped against the genres so a style never just echoes a coarse tag.
function stylesOf(a) {
  const genres = new Set(genresOf(a).map((g) => g.toLowerCase()));
  const seen = new Set();
  // B2: MusicBrainz community tags ride after the record's own styles (the server has
  // already dropped any that just respell a genre or style it carries).
  return `${a.styles || ""},${a.tags || ""}`.split(",").map((t) => t.trim()).filter(Boolean)
    .filter((t) => {
      const k = t.toLowerCase();
      if (genres.has(k) || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

// Build the genre chips + decade dropdown from whatever's actually on this day.
function populateFilters() {
  const genres = new Set();
  const decades = new Set();
  for (const a of browseAll) {
    genresOf(a).forEach((g) => genres.add(g));
    const d = decadeOf(a);
    if (d) decades.add(d);
  }
  // Drop any previously-selected genres that aren't present on this day.
  for (const g of [...selectedGenres]) if (!genres.has(g)) selectedGenres.delete(g);

  const COMBINED_TIP = "This is a single combined genre defined by Discogs — " +
    "not a grouping we chose.";
  $("#genreChips").innerHTML = Array.from(genres)
    .sort((x, y) => x.localeCompare(y))
    .map((g) => {
      const tip = ATOMIC_GENRES.includes(g) ? ` title="${esc(COMBINED_TIP)}"` : "";
      return `<button class="chip${selectedGenres.has(g) ? " active" : ""}"
        data-genre="${esc(g)}"${tip}>${esc(g)}</button>`;
    })
    .join("");

  fillSelect("#decadeFilter", "All decades",
    Array.from(decades).sort().reverse());
}

function fillSelect(sel, allLabel, values) {
  const el = $(sel);
  const prev = el.value;                      // keep selection if still valid
  el.innerHTML = `<option value="">${allLabel}</option>` +
    values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
  el.value = values.includes(prev) ? prev : "";
}

// `applyText` is false in all-dates mode, where the search box text was already
// applied server-side by the full-text query (so we don't re-filter by it).
function applyBrowseFilters(applyText = true) {
  const q = $("#search").value.toLowerCase().trim();
  const field = $("#fieldFilter").value;
  const decade = $("#decadeFilter").value;
  const sort = $("#sort").value;
  let list = browseAll.filter((a) => {
    if (applyText && q) {
      let haystack;
      if (field === "artist") haystack = (a.artist || "").toLowerCase();
      else if (field === "title") haystack = (a.title || "").toLowerCase();
      else if (field === "label") haystack = (a.label || "").toLowerCase();
      else if (field === "genres") haystack = (a.genres || "").toLowerCase();
      else haystack = (a.artist + " " + a.title + " " + (a.genres || "") +
        " " + (a.styles || "")).toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    // Genre: match if the album has ANY of the selected genres (OR).
    if (selectedGenres.size &&
        !genresOf(a).some((g) => selectedGenres.has(g))) return false;
    if (decade && decadeOf(a) !== decade) return false;
    return true;
  });
  list.sort((x, y) => {
    if (sort === "artist") return (x.artist || "").localeCompare(y.artist || "");
    if (sort === "year-asc") return (x.year || 0) - (y.year || 0);
    return (y.year || 0) - (x.year || 0); // newest first
  });
  // Some calendar days have thousands of releases; cap the DOM for snappiness
  // and let the search box narrow things down.
  const CAP = 500;
  const shown = list.slice(0, CAP);
  $("#grid").innerHTML = shown.length
    ? shown.map(browseCard).join("")
    : `<div class="empty">No matches.</div>`;
  $("#count").textContent = list.length > CAP
    ? `showing first ${CAP} of ${list.length} — narrow with the filters`
    : `${list.length} of ${browseAll.length} shown`;
  observeArt($("#grid"));
}

// A3: when a decade door is the active all-dates view, browse it instead of
// running a text search. Cleared the moment any text/field search takes over.
let decadeBrowse = null;

async function loadBrowse() {
  if (browseScope === "all") {
    return decadeBrowse ? loadDecade(decadeBrowse) : runSearch();
  }
  const data = await api(dayEndpoint());
  browseAll = data.albums || [];
  if (!browseAll.length) {
    const md = `${String(data.month).padStart(2,"0")}-${String(data.day).padStart(2,"0")}`;
    $("#grid").innerHTML = data.filtered
      ? filteredEmptyHtml("day", `for ${esc(md)}`)
      : `<div class="empty">No albums with a known date on ${esc(md)}.</div>`;
    $("#count").textContent = "";
    return;
  }
  populateFilters();
  applyBrowseFilters();
}

// All-dates mode: full-text search the whole catalog on the server. A text
// search always supersedes a decade door.
async function runSearch() {
  decadeBrowse = null;
  const q = $("#search").value.trim();
  const grid = $("#grid");
  if (!q) {
    browseAll = [];
    populateFilters();
    grid.innerHTML = `<div class="empty">Type to search every album — across all
      release dates.</div>`;
    $("#count").textContent = "";
    return;
  }
  // FB#105 follow-up (owner): "a long-ish searching page that doesn't give much
  // information about what it is doing." Name the scope, because the scope IS the
  // reason it takes a moment — a thread pull searches the entire catalog across every
  // release date, not the day you're standing on.
  grid.innerHTML = `<div class="empty">Searching every album, across all release
    dates…</div>`;
  const onlyDay = $("#onlyDay").checked;
  const md = mdParam();
  const params = new URLSearchParams({ q });
  if (onlyDay && md) params.set("date", md);
  const field = $("#fieldFilter").value;
  if (field) params.set("field", field);
  try {
    const r = await fetch("/api/search?" + params, SEARCH_OPTS());
    // A failed search must not read as an empty one. Without this, a 5xx with a JSON
    // body parses cleanly and renders "0 matches" — the app confidently telling you
    // the catalog holds nothing, which is the same false-empty shape as FB#92/#104.
    if (!r.ok) throw new Error("search HTTP " + r.status);
    const data = await r.json();
    // Latest-wins: don't let a slower earlier query overwrite the newest results.
    if ($("#search").value.trim() !== q) return;
    browseAll = data.albums || [];
    populateFilters();
    applyBrowseFilters(false);            // text already applied server-side
    const n = browseAll.length;
    const where = onlyDay && md ? ` on ${md}` : " across all dates";
    $("#count").textContent = n >= 500
      ? `first 500 matches${where} — refine your terms`
      : `${n} match${n !== 1 ? "es" : ""}${where}`;
  } catch (e) {
    grid.innerHTML = `<div class="empty">Search failed (is the app still
      running?).</div>`;
  }
}

// A1: jump to an artist-scoped, all-dates catalog search from any card.
// Set the scope/field/term FIRST, then switch tabs: setMode("browse") calls
// loadBrowse(), which — now that browseScope is "all" — runs the artist search
// itself. (Switching first would fire a stray "this day" load that resolves
// late and re-filters the grid down to just the card you clicked from.)
// A2: the artist link now opens the artist panel (its richer home) rather than
// dumping an artist-scoped search into the Browse grid.
function searchArtist(name) {
  openArtistPanel(name);
}

// Pull one thread through the whole catalog: set scope/field/term FIRST, then
// switch tabs (see the A1 note above for why order matters). `field` is one of
// the FTS columns; anything else searches all fields.
function searchCatalog(field, term, opts = {}) {
  if (!term) return;
  // T1: a catalog pull is a door — snapshot where we are so we can return.
  if (!opts.noPush) {
    return pushAndGo(term, { t: "catalog", field, term },
      () => searchCatalog(field, term, { noPush: true }));
  }
  closeStoryModal(); closeArtistPanel(); AOTDLabelPanel.close();  // a grid pull leaves any open door
  decadeBrowse = null;                    // a text pull supersedes a decade door
  browseScope = "all";
  $("#scope").value = "all";
  $("#onlyDayWrap").classList.remove("hidden");
  $("#onlyDay").checked = false;          // search the whole catalog
  $("#fieldFilter").value =
    ["artist", "title", "label", "genres"].includes(field) ? field : "";
  $("#search").placeholder = "Search every album, across all dates…";
  $("#search").value = term;
  setMode("browse");                      // -> loadBrowse() -> runSearch()
  $("#browse").scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
}

// A3: pull a decade through the whole catalog. The decade isn't an FTS field, so
// this is a queryless browse (/api/browse?decade=) rather than a text search.
function searchDecade(decade, opts = {}) {
  if (!decade) return;
  if (!opts.noPush) {
    return pushAndGo(`the ${decade}`, { t: "decade", decade },
      () => searchDecade(decade, { noPush: true }));
  }
  closeStoryModal(); closeArtistPanel(); AOTDLabelPanel.close();  // a grid pull leaves any open door
  decadeBrowse = decade;
  browseScope = "all";
  $("#scope").value = "all";
  $("#onlyDayWrap").classList.remove("hidden");
  $("#onlyDay").checked = false;
  $("#fieldFilter").value = "";
  $("#search").value = "";                // queryless: clear any stale text
  $("#search").placeholder = "Search every album, across all dates…";
  setMode("browse");                      // -> loadBrowse() -> loadDecade()
  $("#browse").scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
}

async function loadDecade(decade) {
  const grid = $("#grid");
  grid.innerHTML = `<div class="empty">Loading the ${esc(decade)}…</div>`;
  try {
    const data = await (await fetch(
      "/api/browse?decade=" + encodeURIComponent(decade))).json();
    browseAll = data.albums || [];
    populateFilters();
    applyBrowseFilters(false);            // no text query to apply
    const n = browseAll.length;
    $("#count").textContent = n >= 500
      ? `first 500 from the ${decade} — narrow with the filters`
      : `${n} from the ${decade}`;
  } catch (e) {
    grid.innerHTML =
      `<div class="empty">Couldn't load the ${esc(decade)}.</div>`;
  }
}

// --- FOREST (T3) ------------------------------------------------------------
// The new home for wandering: no genre tabs, no top-down search. The albums you
// see branch off the ones you've already explored (picked or noted); you reach
// others only by following a thread out (a label / genre / artist pull, all
// returnable via the wander stack). When you've explored nothing yet, the wood
// is empty by design and we gently point you to Choose — it grows as you go.
// U21 (owner 2026-07-05): "Explore" is now just a search over the whole catalog —
// no wood, no seeds, no threads to pull. (Those relatedness threads already live
// on the Choices page, where they read clearer.) The search box is #forestSearchInput
// in the shared remember head; results paint into #forestBody as browse cards.
let _exploreDebounce = null;

// #61: "some kind of channel for people to add things they can't find." The
// lowest-friction, zero-abuse-surface version — open the visitor's own mail
// client, prefilled (they review and send). No backend, no stored request; a
// door, not a corridor. Reachable from a filtered-empty Explore and the ☰ menu.
// Upgrade to a triaged record_requests queue only if volume ever warrants it
// (PAID_ACCOUNTS_DESIGN §2A / the workshop build plan).
function openRecordRequest(query) {
  const q = (query || "").trim();
  const body = q
    ? `I couldn't find this in Music Forest:\n\n${q}\n\n`
      + `(Anything else that helps — artist, year, label — is welcome.)`
    : `A record I couldn't find in Music Forest:\n\n`
      + `(Artist — Title, and anything else that helps.)`;
  const href = "mailto:info@musicforest.lol?subject=" + encodeURIComponent("Record request")
    + "&body=" + encodeURIComponent(body);
  location.href = href;
}

// F33: Explore's exact-day searcher — reach any calendar day (a birthday) and see the
// records released THEN, any year. Reads the cached pool (poolOn ? /api/pool/day :
// /api/day) with ?date=MM-DD — the same source as Today's deck — so no live
// Spotify/Apple query fires for a cold day; each record resolves its links lazily only
// when opened. Text search and day browse both paint #forestBody and are mutually
// exclusive: picking a day clears the text box, typing text exits the day.
let exploreDay = null;   // "MM-DD" while showing a specific day, else null
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];
function formatMD(mmdd) {
  const [m, d] = (mmdd || "").split("-").map(Number);
  return (MONTH_NAMES[m - 1] || "") + " " + (d || "");
}
function dayBrowseEndpoint(mmdd) {
  const base = poolOn() ? "/api/pool/day" : "/api/day";
  return base + "?date=" + encodeURIComponent(mmdd);
}

async function runExploreDay(mmdd) {
  const body = $("#forestBody");
  if (!body || !mmdd) return;
  exploreDay = mmdd;
  const inp = document.getElementById("forestSearchInput");
  if (inp) { inp.value = ""; refreshSearchClear(inp); }   // day + text are mutually exclusive
  renderBarChips();
  const pretty = formatMD(mmdd);
  body.innerHTML = `<div class="empty">Looking for records from ${esc(pretty)}…</div>`;
  let data;
  try {
    data = await (await fetch(dayBrowseEndpoint(mmdd))).json();
  } catch (e) {
    if (exploreDay === mmdd) body.innerHTML =
      `<div class="empty">Couldn't load that day (is the app still running?).</div>`;
    return;
  }
  if (exploreDay !== mmdd) return;                  // a newer pick / a text search took over
  const albums = data.albums || [];
  noteCachedCovers(albums);
  if (!albums.length) {
    body.innerHTML = `<div class="empty">No records on file released on
      ${esc(pretty)}, any year.</div>`;
    return;
  }
  const CAP = 500;
  const shown = albums.slice(0, CAP);
  const capNote = albums.length > CAP
    ? `<p class="filter-note">Showing ${CAP} of ${albums.length} — a busy day in history.</p>` : "";
  body.innerHTML = `<section class="explore-group">
    <h3 class="explore-group-h">Released on ${esc(pretty)} · any year</h3>
    ${capNote}<div class="grid">${shown.map(browseCard).join("")}</div></section>`;
  observeArt(body);
}

// Leave day mode. silent=true when a text search is about to repaint #forestBody itself
// (runExploreSearch); otherwise restore the current text-search / prompt view.
function exitExploreDay(silent) {
  if (!exploreDay) return;
  exploreDay = null;
  renderBarChips();
  if (!silent) {
    const inp = document.getElementById("forestSearchInput");
    runExploreSearch(inp ? inp.value : "");
  }
}

// Filter's "See a specific day →": go to Search and open its bar for a day. Since v353
// the bar understands days ("oct 5", "10/5"), so the old month/day row is gone; the
// placeholder says what to type until the bar is left.
function gotoSpecificDay() {
  setMode("forest");
  const inp = document.getElementById("forestSearchInput");
  if (!inp) return;
  const was = inp.placeholder;
  inp.placeholder = "Type a day, like oct 5…";
  inp.addEventListener("blur", () => { inp.placeholder = was; }, { once: true });
  try { inp.focus(); } catch (e) { /* focus is enough */ }
}

function loadForest() {
  // Entering Explore paints whatever the search box currently holds — usually
  // empty, so a prompt. Kept named loadForest (and mode "forest") so all the
  // existing wiring — the Explore pill, showMode, the wander-root check — is
  // untouched; only what it renders changed.
  runExploreSearch($("#forestSearchInput").value);
  return Promise.resolve();
}

// FB#37: a track-level result row. Clicking it opens the song's album (a door), and
// the matched track flashes so you land on the exact song you searched for.
function songHitRow(t) {
  const sub = [t.album_artist, t.album_title].filter(Boolean).join(" — ");
  return `<button type="button" class="song-hit" data-song-uid="${esc(t.album_uid)}"
      data-song-pos="${esc(t.pos || "")}">
    <span class="song-hit-title">${esc(t.title || "")}</span>
    ${sub ? `<span class="song-hit-sub">${esc(sub)}</span>` : ""}
  </button>`;
}

// F34 (feedback #79): the artists that surface FIRST in Explore. Derived from the album
// hits — every artist shown definitely has records — kept to those whose NAME matches
// the query (so a title/label search doesn't dredge up unrelated artists), most records
// first, capped to a surveyable few (a door, not a corridor).
function artistsFromHits(albums, q) {
  const ql = (q || "").toLowerCase();
  const counts = new Map();
  for (const a of albums) {
    const name = (a.artist || "").trim();
    if (!name || !name.toLowerCase().includes(ql)) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    .slice(0, 8)
    .map(([name, n]) => ({ name, n }));
}

function artistHitRow(a) {
  return `<button type="button" class="artist-hit" data-artist="${esc(a.name)}"
      title="See more from ${esc(a.name)}">
    <span class="artist-hit-name">${esc(a.name)}</span>
    <span class="artist-hit-sub">${a.n} record${a.n !== 1 ? "s" : ""}</span>
  </button>`;
}

async function runExploreSearch(term) {
  const body = $("#forestBody");
  const q = (term || "").trim();
  if (barDay(q)) return;                    // a day: the bar offers it (renderBarSugg)
  if (q) exitExploreDay(true);              // a text search supersedes the day browse
  if (!q) {
    if (exploreDay) return;                 // day mode with an empty box: keep the day view
    body.innerHTML = `<div class="empty">Search every album or song by artist,
      title, label, or genre.</div>`;
    return;
  }
  body.innerHTML = `<div class="empty">Searching…</div>`;
  try {
    // FB#37: search album titles AND track titles ("golden years" → the song, and
    // its album). Tracks degrade to [] when tracks_fts isn't built — never an error.
    const [albumsR, tracksR] = await Promise.allSettled([
      fetch("/api/search?" + new URLSearchParams({ q }), SEARCH_OPTS()).then((r) => r.json()),
      fetch("/api/track/search?" + new URLSearchParams({ q, limit: 8 })).then((r) => r.json()),
    ]);
    // Latest-wins: a slower earlier/broader query must not clobber the newest one
    // (typing "the diary" then "…j dilla" would otherwise flash J Dilla, then let
    // the stale "the diary" response overwrite it). Same guard as rememberDoorSearch.
    if ($("#forestSearchInput").value.trim() !== q) return;
    const albums = (albumsR.value && albumsR.value.albums) || [];
    const tracks = (tracksR.value && tracksR.value.tracks) || [];
    if (!albums.length && !tracks.length) {
      // #61: a filtered-empty search is the honest, pull-only home for the
      // "can't find it" request — a door off the dead end, never a nag.
      body.innerHTML = `<div class="empty">No albums or songs match “${esc(q)}”.
        <button type="button" class="linkish request-record" data-request-record
          title="Tell us about a record that's missing">Can’t find it? Ask us to add it →</button></div>`;
      return;
    }
    const capped = albums.length >= 500
      ? `<p class="filter-note">First 500 matches — add another word to narrow it.</p>`
      : "";
    const albumsGrid = `${capped}<div class="grid">${albums.map(browseCard).join("")}</div>`;
    // F34: order the results Artists -> Songs -> Albums. With no artist-name match and
    // no song hits the view stays the bare album grid (unchanged); any grouped hit turns
    // on the labelled sections. Each artist row opens that artist's catalogue.
    const artists = artistsFromHits(albums, q);
    if (!artists.length && !tracks.length) {
      body.innerHTML = albumsGrid;
    } else {
      const artistsSec = artists.length
        ? `<section class="explore-group"><h3 class="explore-group-h">Artists</h3>
           <div class="artist-hit-list">${artists.map(artistHitRow).join("")}</div></section>`
        : "";
      const songsSec = tracks.length
        ? `<section class="explore-group"><h3 class="explore-group-h">Songs</h3>
           <div class="song-hit-list">${tracks.map(songHitRow).join("")}</div></section>`
        : "";
      const albumsSec = albums.length
        ? `<section class="explore-group"><h3 class="explore-group-h">Albums</h3>${albumsGrid}</section>`
        : "";
      body.innerHTML = artistsSec + songsSec + albumsSec;
    }
    observeArt(body);
  } catch (e) {
    body.innerHTML = `<div class="empty">Search failed (is the app still
      running?).</div>`;
  }
}

// --- LAZY ARTWORK -----------------------------------------------------------
// Covers are fetched on demand, only for cards actually scrolled into view, in
// small batches. This is what keeps days with thousands of albums usable.
const _artQueue = new Set();
let _artTimer = null;

const artObserver = ("IntersectionObserver" in window)
  ? new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting && e.target.dataset.rid) {
          _artQueue.add(e.target.dataset.rid);
          artObserver.unobserve(e.target);
        }
      }
      scheduleArtFlush();
    }, { rootMargin: "300px" })
  : null;

// `opts.eager` (a number) fetches that many covers immediately rather than
// waiting for them to scroll into view. Used inside modals (e.g. the artist
// panel) where the cards live in their own scroll container and viewport-based
// lazy-loading can miss the initially-visible covers; cached covers come back
// instantly, so a bounded eager batch fills the panel without hammering the
// network for a huge catalog. The remainder still loads lazily on scroll.
function observeArt(scope, opts = {}) {
  const root = scope || document;
  // The genuinely missing covers, found BEFORE the hotlinked ones below start loading.
  // Those stay .placeholder until their image arrives, so asking afterwards swept them
  // in too, and /api/art/ensure answered with the catalog's own cover, which can be a
  // different image: a Today card's Cover Art Archive cover was swapped for Apple's a
  // moment later (and, with v348's Apple rule, wiped). An Apple cover held back by that
  // rule isn't missing either.
  const els = Array.from(root.querySelectorAll(
    ".cover.placeholder[data-rid]:not([data-cover]):not([data-apple-art])"));
  // Remote hotlinked covers (F13): apply them now, with a dead-link fallback.
  root.querySelectorAll(".cover.placeholder[data-cover]").forEach((el) => {
    const url = el.dataset.cover;
    el.removeAttribute("data-cover");
    applyCover(el.dataset.rid, url, el);
  });
  // The rest are genuinely missing — lazy-fetch them on demand.
  let rest = els;
  if (opts.eager) {
    rest = els.slice(opts.eager);
    els.slice(0, opts.eager).forEach((el) => _artQueue.add(el.dataset.rid));
    scheduleArtFlush();
  }
  if (artObserver) {
    rest.forEach((el) => artObserver.observe(el));
  } else if (!opts.eager) {
    // No IntersectionObserver: just fetch the first handful.
    rest.slice(0, 24).forEach((el) => _artQueue.add(el.dataset.rid));
    scheduleArtFlush();
  }
}

function scheduleArtFlush() {
  if (_artTimer || _artQueue.size === 0) return;
  _artTimer = setTimeout(() => { _artTimer = null; flushArt(); }, 150);
}

async function flushArt() {
  const uids = Array.from(_artQueue).slice(0, 8);
  uids.forEach((u) => _artQueue.delete(u));
  // /api/art/ensure is albums.db-backed, so only Discogs ('d:') albums are
  // fetched here, keyed by their numeric release_id. MB-only ('m:') covers come
  // from the lazy door on open, so they're left as placeholders here.
  const ridByUid = new Map();
  uids.forEach((u) => { const rid = ridFromUid(u); if (rid != null) ridByUid.set(u, rid); });
  if (ridByUid.size) {
    try {
      const r = await fetch("/api/art/ensure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ release_ids: Array.from(ridByUid.values()) }),
      });
      const map = await r.json();
      ridByUid.forEach((rid, uid) => {
        const cover = map[String(rid)];
        if (cover) applyCover(uid, cover);     // DOM is keyed by uid (data-rid)
        // #7: the lookup ran and came back empty — this art genuinely can't be
        // found, so label the placeholder rather than leaving it ambiguous with
        // a still-loading one. (A network error below leaves it unmarked so a
        // later retry can still resolve it.)
        else markNoArt(uid);
      });
    } catch (e) { /* offline / network hiccup: leave placeholders, no "no art" label */ }
  }
  if (_artQueue.size) scheduleArtFlush();
}

// Turn a cover element back into a labelled placeholder — used when a remote
// hotlinked cover (F13) is dead/expired so it degrades gracefully instead of
// showing a broken image. A dead link == no art found. (FB#98 retired the
// Fix-art nudge that used to be appended here.)
function markPlaceholder(el, rid) {
  const info = albumIndex[rid] || {};
  el.classList.add("placeholder", "no-art");
  el.style.backgroundImage = "";
  el.style.setProperty("--ph-hue", phHue(rid));
  el.textContent = coverLabel(info);
}

// #7: flag every placeholder for this release as "no art found" — a small
// caption under the leaf watermark — once a lookup has confirmed none exists.
// CSS draws the label from the .no-art class (::after), so there's no DOM to
// rebuild; applyCover removes the class if art turns up later.
function markNoArt(rid) {
  document.querySelectorAll(`.cover.placeholder[data-rid="${rid}"]`)
    .forEach((el) => el.classList.add("no-art"));
}

// SPEED (owner 2026-10-05: "the load time on that first album is really important …
// right now it takes about 5-10 seconds and we lose people in that time"). Measured on
// October 5's records: Cover Art Archive's `/front` is the ORIGINAL upload — 0.4 to
// 24 MB (one took 64 s) for a 306px square, and the card waited for all of it. CAA
// serves sized thumbnails at the same address + `-250` / `-500` (~50–125 KB, ~1–1.5 s,
// most of it the archive's two redirects). Ask for those; a cover CAA hasn't sized
// (it answers 500 for a few) falls back to the original, and only then to the
// placeholder. Anything that isn't a CAA front passes through untouched.
//
// COVER CACHE (v347, covercache.py): the host keeps its own copy of the 500px thumbnail
// for today's and tomorrow's records, and the day's list marks those `cover_cached`.
// caaThumb() asks our server for them — one same-origin GET instead of the archive's
// two redirects — and applyCover() falls back to the archive if our copy has gone.
const CAA_FRONT = /^(https?:\/\/coverartarchive\.org\/(release|release-group)\/([0-9a-f-]{36})\/front)(?:-\d+)?$/i;
const _cachedCovers = new Set();   // "<kind>/<mbid>" the server said it holds
function noteCachedCovers(list) {
  (list || []).forEach((a) => {
    const m = a && a.cover_cached && CAA_FRONT.exec(a.cover || "");
    if (m) _cachedCovers.add(`${m[2]}/${m[3]}`.toLowerCase());
  });
}
function caaSized(url, size = 500) {
  const m = CAA_FRONT.exec(url || "");
  return m ? `${m[1]}-${size}` : url;
}
function caaThumb(url, size = 500) {
  const m = CAA_FRONT.exec(url || "");
  if (!m) return url;
  const key = `${m[2]}/${m[3]}`.toLowerCase();
  return size === 500 && _cachedCovers.has(key) ? `/covers/${key}-500.jpg` : `${m[1]}-${size}`;
}

// APPLE ARTWORK (v348, owner 2026-10-05: option A). Apple allows its artwork only to
// promote what's in its store, beside an Apple Music link. So an Apple cover shows only
// where that record's Apple Music link is on screen in the same card: the Today card
// when its Listen button is Apple Music, Album details when Apple Music is its Listen
// button (or "Other ways to listen" is open), a Search card once its ♫ Listen is open.
// Everywhere else (the Notebook, Seen, the trail, a card whose button names another
// service) the card keeps its placeholder. Measured that day: ~10% of a crawled day's
// records have only Apple art, every one with an Apple link, and with "Everything" the
// Today card's button is Apple Music for 91–100% of them. The share card never uses it.
const APPLE_ART = /^https?:\/\/(?:[a-z0-9-]+\.)*(?:mzstatic|apple)\.com\//i;
function isAppleArt(url) {
  return APPLE_ART.test(url || "");
}
// The card a cover shares with its Listen links.
const ART_SCOPE = ".deck-card, .story-head-row, .card";
function appleLinkShown(el) {
  const scope = el && el.closest ? el.closest(ART_SCOPE) : null;
  if (!scope) return false;
  return Array.from(scope.querySelectorAll("a.am")).some((l) =>
    !l.closest("details:not([open])") && getComputedStyle(l).display !== "none");
}
// Back to the card's own placeholder (the label it was drawn with), not "no art found":
// the art exists, it just isn't ours to show here.
function hideAppleArt(el, rid) {
  if (el.classList.contains("placeholder")) return;
  el.classList.add("placeholder");
  el.style.backgroundImage = "";
  el.style.setProperty("--ph-hue", phHue(rid));
  el.textContent = coverLabel(albumIndex[rid] || {});
}
// A card's links changed (the door filled in, a fold opened, your platforms changed):
// show or hide its Apple cover to match.
function recheckAppleArt(root) {
  if (!root || !root.querySelectorAll) return;
  root.querySelectorAll(".cover[data-apple-art]").forEach((el) => {
    const showing = !el.classList.contains("placeholder");
    if (appleLinkShown(el)) { if (!showing) applyCover(el.dataset.rid, el.dataset.appleArt, el); }
    else if (showing) hideAppleArt(el, el.dataset.rid);
  });
}
// The Today card shows its cover only when it isn't Apple's, or its one Listen button is
// Apple Music — what readyFirst() and the first card need to know before drawing it.
function deckCoverShows(a) {
  if (!a || !a.cover) return false;
  if (!isAppleArt(a.cover)) return true;
  const p = pickListenPlatforms(a.platforms, loadListenPrefs()).primary;
  return !!(p && p[0] === "apple");
}
document.addEventListener("toggle", (e) => {
  const d = e.target;
  if (d && d.tagName === "DETAILS") recheckAppleArt(d.closest(ART_SCOPE));
}, true);

function applyCover(rid, cover, only) {
  const targets = only ? [only]
    : document.querySelectorAll(`.cover[data-rid="${rid}"]`);
  const reveal = (el, src) => {
    if (el.dataset.appleArt && !appleLinkShown(el)) { hideAppleArt(el, rid); return; }
    el.classList.remove("placeholder", "no-art");
    el.style.backgroundImage = `url('${cssUrl(src)}')`;
    el.textContent = "";
    // Remember the resolved cover on the album data so every OTHER surface — the
    // story modal especially — renders the SAME image instead of re-resolving to a
    // different one (feedback #65: deck cover ≠ details cover). Our cached copy is
    // remembered as the archive's address: it's the same image, and /covers/ only
    // lives for a day or two, so it must never reach a note or the Notebook.
    const keep = src.startsWith("/covers/") ? caaSized(cover) : src;
    if (albumData[rid] && albumData[rid].cover !== keep) albumData[rid].cover = keep;
  };
  targets.forEach((el) => {
    if (isAppleArt(cover)) {
      el.dataset.appleArt = cover;
      if (!appleLinkShown(el)) { hideAppleArt(el, rid); return; }
    }
    // Hotlinked covers can be slow, 404, or expire. Load first, reveal after:
    // stripping the placeholder text before the image arrives left a card with
    // no art AND no words while a dead/slow link dangled (feedback #15).
    if (isRemoteUrl(cover)) {
      // The record on Today's card is the one someone is waiting on: fetch it first.
      const urgent = !!(el.closest && el.closest(".deck-cover"));
      const load = (src, onFail) => {
        const probe = new Image();
        if (urgent) probe.fetchPriority = "high";
        probe.onload = () => reveal(el, src);
        probe.onerror = onFail;
        probe.src = src;
      };
      // Our copy, then the archive's thumbnail, then its original, then the placeholder.
      const tries = [...new Set([caaThumb(cover), caaSized(cover), cover])];
      const next = (i) => (i < tries.length
        ? load(tries[i], () => next(i + 1)) : markPlaceholder(el, rid));
      next(0);
    } else {
      reveal(el, cover);
    }
  });
}

// --- FIX ARTWORK modal ------------------------------------------------------
// FB#98 removed the per-cover "Fix art" button, so this door has no affordance in
// the app any more — deliberately: fixing a wrong cover is maintenance, not part of
// meeting a record. The capability is intact and operator-reachable from the
// console: `openArtModal("d:1234")` with the album's uid (the same uid a card
// carries in data-rid). /api/art/* is unchanged.
let artTarget = null; // { uid }

function openArtModal(rid) {
  const info = albumIndex[rid] || { artist: "", title: "" };
  artTarget = { uid: rid };
  $("#artFor").textContent = `${info.artist} — ${info.title}`;
  $("#artTerm").value = `${info.artist} ${info.title}`.trim();
  $("#artUrl").value = "";
  $("#artResults").innerHTML = "";
  $("#artStatus").textContent = "";
  $("#artModal").classList.remove("hidden");
  searchArt();
}

function closeArtModal() {
  $("#artModal").classList.add("hidden");
  artTarget = null;
}

async function searchArt() {
  const term = $("#artTerm").value.trim();
  if (!term) return;
  $("#artStatus").textContent = "Searching…";
  $("#artResults").innerHTML = "";
  try {
    const r = await fetch(`/api/art/search?term=${encodeURIComponent(term)}`);
    const data = await r.json();
    const cands = data.candidates || [];
    if (!cands.length) {
      $("#artStatus").textContent = data.error
        ? `Search failed: ${data.error}` : "No matches — try a different term or paste a URL.";
      return;
    }
    $("#artStatus").textContent = "Click a cover to apply it.";
    $("#artResults").innerHTML = cands.map((c) =>
      `<div class="opt" data-art="${esc(c.artwork_url)}"
        data-apple="${esc(c.apple_music_url || "")}"
        title="${esc((c.artist || "") + " — " + (c.name || ""))}">
        <img src="${esc(c.artwork_url)}" alt="">
      </div>`).join("");
    $("#artResults").querySelectorAll(".opt").forEach((el) =>
      el.addEventListener("click", () =>
        applyArt(el.dataset.art, el.dataset.apple || null)));
  } catch (e) {
    $("#artStatus").textContent = "Search failed (network?). You can paste a URL instead.";
  }
}

async function applyArt(artworkUrl, appleUrl) {
  if (!artTarget || !artworkUrl) return;
  const uid = artTarget.uid;
  const rid = ridFromUid(uid);
  $("#artStatus").textContent = "Applying…";
  try {
    if (rid != null) {
      // Discogs album: persist into albums.db's art cache.
      const r = await fetch("/api/art/set", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          release_id: rid,
          artwork_url: artworkUrl,
          apple_music_url: appleUrl,
        }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || "failed");
      applyCover(uid, data.cover);   // DOM keyed by uid (with dead-link fallback)
    } else {
      // MB-only album: no albums.db row to persist into (the door is the art
      // source). Reflect the chosen cover in the view + cache so it sticks for
      // the session.
      applyCover(uid, artworkUrl);
      if (albumData[uid]) {
        albumData[uid].cover = artworkUrl;
        if (appleUrl) albumData[uid].apple_music_url = appleUrl;
      }
    }
    closeArtModal();
  } catch (e) {
    $("#artStatus").textContent = `Could not apply: ${e.message}`;
  }
}

// --- JOURNAL: notes (add/edit modal) ----------------------------------------
let noteTarget = null;
// v8: the typed-entity snapshot for a non-album target (artist/person/track), sent
// with the note so it renders without a catalog row. null for an album/free note.
// Phase 2's typed attach sets this; the album attach + free note clear it.
let noteTargetRef = null;
let noteEditId = null;   // null = adding a new note; an id = editing that note
let noteFreeMode = false; // N3b: opened as a free note (record-optional, attach offered)
// Long-press (the touch equivalent of right-click) on an Album-details note-anchor.
// `_lpFired` guards the click that trails a long-press so it doesn't re-open.
let _lpTimer = null, _lpAnchor = null, _lpX = 0, _lpY = 0, _lpFired = false;

// `rid` (a uid) ties the note to a record; pass null/undefined for a FREE note
// (N3b — record-optional, opened from "Take a note"), which offers an optional
// "＋ Tie it to a record" search. `note` (optional) puts the modal in edit mode
// (D4), prefilled from that note.
// #58: a guest's Notebook is a real taste, capped at GUEST_NOTE_CAP written notes
// (keeping records is never capped — VISION P3, we don't ration keeping). The cap
// is a SOFT product limit, not a security boundary: the value that's actually
// gated is durability (sync/backup/export), which lives on the server and is
// genuinely un-gameable. Editing an existing note is always allowed.
const GUEST_NOTE_CAP = 10;
function guestAtNoteCap() {
  if (!window.AOTD_GUEST) return false;
  try {
    const b = window.AOTDGuestBuffer ? window.AOTDGuestBuffer.create() : null;
    return !!(b && b.notesCount && b.notesCount() >= GUEST_NOTE_CAP);
  } catch (e) { return false; }
}

async function openNoteModal(rid, note = null) {
  // #58: a capped guest starting a NEW note meets the durability pay-moment (an
  // invitation, dismissable at zero cost) instead of an empty composer. This is
  // the single choke point for every "write a note" entry (trail pill, story
  // door, ✎ Your notes, the empty-state hint), so the cap holds everywhere.
  if (window.AOTD_GUEST && !note && guestAtNoteCap()) {
    if (window.AOTDAuth && AOTDAuth.showGate) AOTDAuth.showGate("note-cap");
    return;
  }
  noteTarget = rid || null;               // a uid string (d:/m:/art:/per:/trk:) or null
  // A typed note (artist/person/track) carries its snapshot in `ref`; editing one
  // keeps that ref so the "tied to" line renders (album/free notes have none).
  noteTargetRef = (note && note.ref) ? note.ref : null;
  const kind = kindFromUid(noteTarget);
  noteEditId = note ? note.id : null;
  const editing = !!note;
  // Offer the attach control only for a brand-new free note (not while editing).
  noteFreeMode = (rid == null && !editing);
  const hasRecord = rid != null;
  $("#noteModalTitle").textContent = editing ? "Edit note" : "Add a note";
  $("#noteSave").textContent = editing ? "Save changes" : "Save note";
  // #48 (v2): the single-note Delete lives in the editor — shown only when editing an
  // existing note (a brand-new one has nothing to delete yet).
  $("#noteDelete").classList.toggle("hidden", !editing);
  $("#noteFor").classList.toggle("hidden", !hasRecord);
  $("#noteFor").innerHTML = hasRecord ? noteForLabel(noteTarget, kind, noteTargetRef) : "";
  $("#noteBody").value = editing ? (note.body || "") : "";
  $("#noteTrack").value = editing ? (note.track || "") : "";
  $("#noteTime").value = editing ? (note.timestamp || "") : "";
  $("#noteStatus").textContent = "";
  // Attach control shows only for a brand-new free note (record-optional). The
  // track/time "pin to a moment" aside is retired (FB#43) — track + timestamp
  // ride the hidden inputs, prefilled above so an edit never loses them.
  $("#noteAttach").classList.toggle("hidden", !noteFreeMode);
  resetNoteAttach();
  renderNoteTrackPills();                 // FB#106a: the open album's songs, one tap away
  $("#noteModal").classList.remove("hidden");
  // Do NOT focus the textarea here — on mobile that pops the keyboard the
  // instant the modal opens (owner, Android Chrome guest v77). The keyboard
  // should wait for a deliberate tap into the field.
}

let _noteTrackItems = [];   // FB#106a: the open album's songs, as composer pills

// --- FB#106a: pick a song from inside the composer --------------------------
// "when i tap 'write a note' on an album page, i am frustrated that i can't select a
// track if i want to." The per-track ✎ already existed, but only back on the details
// page — so the actual listening loop (hear a song, come back to the app, tap Write a
// note) dead-ended at album-level. The album's own tracks ride in the composer now.
//
// FB#106c (2026-08-06) changed where the songs come from. They used to be read off the
// OPEN Album-details tracklist (`#storyTracks`), which tied the pills to what happened
// to be PAINTED rather than to the record the note is about — so the keep reveal, which
// shows a record and a composer but no tracklist, silently offered none. Owner, from
// that very screen: "I want to be able to tag a specific song here."
//
// The source is now the record itself: `noteContextAlbumUid()` → `ensureAlbumTracks()`,
// one uid-keyed cache shared with the door (so the pills and the per-track ✎ still
// cannot disagree, and whichever opens first warms the other). Any surface that
// composes a note about a record gets pills, with no tracklist rendered first.
// A track with no sleeve position has no stable uid (`notable = !!t.pos` in
// renderStoryTracks), so it never becomes a pill.
//
// Which album the composer is "on": the record itself for an album note, or the parent
// album for a track note (so re-opening a song note still offers its siblings).
function noteContextAlbumUid() {
  const kind = kindFromUid(noteTarget);
  if (kind === "album") return noteTarget;
  if (kind === "track") return (noteTargetRef && noteTargetRef.album_uid) || null;
  return null;
}

// FB#106c: one tracklist cache, keyed by album uid, shared by the Album-details door
// and the composer's pills — so the two can never disagree about a record's songs, and
// whichever opens first warms the other.
const _albumTracks = {};        // uid -> [{pos,title,dur}] once known (may be [])
const _albumTracksPending = {}; // uid -> in-flight promise, so a double-open fetches once

async function ensureAlbumTracks(uid) {
  if (!uid) return [];
  if (_albumTracks[uid]) return _albumTracks[uid];
  if (_albumTracksPending[uid]) return _albumTracksPending[uid];
  const p = (async () => {
    try {
      const d = await (await fetch(
        `/api/album/${encodeURIComponent(uid)}/tracks`)).json();
      _albumTracks[uid] = d.tracks || [];
    } catch (e) {
      // Offline or a catalog hiccup: remember an empty list rather than retrying on
      // every keystroke. A reload re-asks. (An album with no tracklist on file is a
      // legitimate empty too — MB-only records have none — and both mean "no pills",
      // never a wrong pill.)
      _albumTracks[uid] = [];
    } finally { delete _albumTracksPending[uid]; }
    return _albumTracks[uid];
  })();
  _albumTracksPending[uid] = p;
  return p;
}

// The pill item for one track of a given album. Mirrors noteItemFromAnchor's track
// branch exactly — same uid shape, same `ref` snapshot — but takes the album as an
// argument instead of reading the open door's `storyRid`, which is the whole point:
// the pills belong to the record the note is ABOUT, not to whatever is on screen.
function noteTrackItemFor(albumUid, t) {
  if (!albumUid || !t || !t.pos) return null;   // no sleeve position → no stable uid
  const a = noteAlbumSnapshot(albumUid);
  const title = t.title || "";
  const sub = [a.artist, a.title].filter(Boolean).join(" — ");
  return { kind: "track", uid: `trk:${albumUid}#${t.pos}`, label: title, meta: sub,
    ref: { kind: "track", title, pos: t.pos, album_uid: albumUid,
           album_artist: a.artist || "", album_title: a.title || "" } };
}

// Whatever we know about this record right now: the door's cache first, then the
// name cache.
function noteAlbumSnapshot(uid) {
  return albumData[uid]
    || albumIndex[uid]
    || {};
}

function noteTrackItems() {
  const albumUid = noteContextAlbumUid();
  if (!albumUid) return [];
  const tracks = _albumTracks[albumUid];
  if (!tracks) return [];        // not fetched yet — renderNoteTrackPills kicks it off
  return tracks.map((t) => noteTrackItemFor(albumUid, t)).filter(Boolean);
}

function renderNoteTrackPills() {
  const wrap = $("#noteTracks"), box = $("#noteTrackPills");
  if (!wrap || !box) return;
  const ctxUid = noteContextAlbumUid();
  // Lazy on purpose: the fetch happens the first time a composer is open on a record
  // we don't know the songs for, so keeping a record without writing costs nothing.
  // Once the answer is cached (even as an empty list) this never re-asks, so the
  // re-render below can't loop.
  if (ctxUid && !_albumTracks[ctxUid]) {
    ensureAlbumTracks(ctxUid).then(() => {
      // Only paint if the composer is still on the same record — you may have
      // re-pointed it, or closed it, while the request was out.
      if (noteContextAlbumUid() === ctxUid) renderNoteTrackPills();
    });
  }
  const items = noteTrackItems();
  if (!items.length) {
    wrap.classList.add("hidden");
    box.innerHTML = "";
    _noteTrackItems = [];
    return;
  }
  _noteTrackItems = items;
  const current = kindFromUid(noteTarget) === "track" ? noteTarget : null;
  box.innerHTML = items.map((it, i) => {
    const on = it.uid === current;
    return `<button type="button" class="nt-pill${on ? " on" : ""}" data-nt="${i}"
       aria-pressed="${on ? "true" : "false"}"
       title="${on ? "Tie this note to the record instead" : `Tie this note to “${esc(it.label)}”`}"
       >${esc(it.label)}</button>`;
  }).join("");
  wrap.classList.remove("hidden");
  // Owner, on-device: "the vertical spacing between things changes when a song is
  // selected versus an album. i think it is because the artwork disappears. the screen
  // shouldn't change except that the song pill is now selected/highlighted." Exactly
  // right — picking a song re-rendered the record line from the album's cover-thumb
  // block into a plain "Tied to <song>" string, so the line collapsed and everything
  // below jumped up.
  //
  // While the pills are on screen the record line stays THE RECORD, and the lit pill
  // is what says which song. Nothing reflows, and you keep sight of the album you're
  // writing about instead of trading it for the song's name. (The pill is also the
  // untie — tap the lit one to come back to the record — so no separate control is
  // lost.) Away from Album details there are no pills, and the line goes back to
  // naming whatever the note is tied to.
  const albumUid = noteContextAlbumUid();
  if (albumUid) {
    $("#noteFor").classList.remove("hidden");
    $("#noteFor").innerHTML = noteForLabel(albumUid, "album", null);
  }
}

// Tap a pill: tie the note to that song. Tap the lit one again: back to the record.
// Nothing is written either way — this only moves what the note will attach to when
// you save, so it stays as reversible as the rest of the composer.
function toggleNoteTrack(idx) {
  const it = _noteTrackItems[Number(idx)];
  if (!it) return;
  const albumUid = (it.ref && it.ref.album_uid) || null;
  if (noteTarget === it.uid) {            // tapping the lit pill returns to the record
    if (!albumUid) return;
    noteTarget = albumUid;
    noteTargetRef = null;
  } else {
    noteTarget = it.uid;
    noteTargetRef = it.ref || null;
  }
  // Set the target here rather than through applyNoteAttach: that also rewrites the
  // record line into "Tied to <song>", which is the reflow the owner caught. The one
  // repaint below draws both the lit pill and the (unchanged) record line, so the
  // modal's geometry is identical either way.
  renderNoteTrackPills();
}

// N3b — the optional "tie it to a record" search inside the free-note composer.
// Pure pull: you reach for it and name the record yourself; nothing is attached
// unless you pick a result. Reuses /api/search + the rem-row result rows.
let _noteAttachTimer = null;
function resetNoteAttach() {
  const search = $("#noteAttachSearch"), open = $("#noteAttachOpen");
  if (search) search.classList.add("hidden");
  if (open) open.classList.remove("hidden");
  const inp = $("#noteAttachInput"); if (inp) inp.value = "";
  const res = $("#noteAttachResults"); if (res) res.innerHTML = "";
}
function openNoteAttachSearch() {
  $("#noteAttachOpen").classList.add("hidden");
  $("#noteAttachSearch").classList.remove("hidden");
  $("#noteAttachInput").focus();
}
// v8: a note can tie to an album, a track, a person on the credits, or an artist.
// The plain word by kind (mirrors kindFromUid), used in the attach results and the
// Notebook. FB#43 (2026-07-13): the emoji kind-glyphs are retired — a word, not a ♪.
// #50: "credit" (not "person") — reads as "someone in the credits/room," distinct from
// "artist" (the headline act) so the two kinds stop looking redundant.
const KIND_WORD = { album: "record", track: "song", person: "credit", artist: "artist" };
// The picked results, keyed by index — a result carries an object `ref`, so it
// rides a client map rather than being stuffed into a data-attribute.
let _noteAttachItems = [];

// What a note is tied to, as a display label for #noteFor (edit/context view — no
// untie affordance; the composer's attach adds that). An album shows artist —
// title from the cover index; a typed entity shows its kind glyph + `ref` label.
function noteForLabel(uid, kind, ref) {
  // FB#43: just the name — no kind glyph, no album subtitle, no kind chip.
  if (kind === "album") {
    const info = albumIndex[uid] || { artist: "", title: "" };
    const name = `${info.artist || ""} — ${info.title || ""}`.replace(/^ — | — $/g, "")
      || "this record";
    // #52: the record line is a door to Album details — a small clickable cover +
    // the linked title, both opening the same details view (wired in the #noteFor
    // click delegate). Cover fills from albumData if resolved, else a name placeholder.
    const alb = albumData[uid] || {};
    const art = coverHtml({ uid, artist: info.artist, title: info.title,
      cover: alb.cover, release_id: alb.release_id }, { fix: false });
    return `<button type="button" class="note-for-album" data-album-uid="${esc(uid)}"`
      + ` title="Open album details">`
      + `<span class="nfa-art">${art}</span>`
      + `<span class="nfa-name">${esc(name)}</span></button>`;
  }
  const r = ref || {};
  if (kind === "track") return `<b>${esc(r.title || "song")}</b>`;
  return `<b>${esc(r.name || "")}</b>`;
}

// Fan out across the four kinds in parallel. Albums come from /api/search; the
// artists are DERIVED from those album hits (no endpoint — the names already on
// the results); people + tracks have their own FTS endpoints (Phase 1). Each arm
// degrades on its own (allSettled), so a missing tracks_fts or a slow arm never
// blanks the others. Pure pull: nothing attaches until you pick a row.
async function noteAttachSearch(q) {
  const box = $("#noteAttachResults");
  if (!box) return;
  if (!q) { box.innerHTML = ""; _noteAttachItems = []; return; }
  const params = new URLSearchParams({ q });
  const [albumsR, peopleR, tracksR] = await Promise.allSettled([
    fetch("/api/search?" + params, SEARCH_OPTS()).then((r) => r.json()),
    fetch("/api/person/search?" + params).then((r) => r.json()),
    fetch("/api/track/search?" + params).then((r) => r.json()),
  ]);
  if ($("#noteAttachInput").value.trim() !== q) return;   // stale response

  const items = [];
  const albums = (albumsR.value && albumsR.value.albums) || [];
  for (const a of albums.slice(0, 5)) {
    const key = albumKey(a);
    if (!albumData[key]) albumData[key] = a;
    rememberNames(key, a.artist, a.title);
    const year = a.year || String(a.released || "").slice(0, 4);
    items.push({ kind: "album", uid: key, ref: null,
      label: `${a.artist || ""} — ${a.title || ""}`.replace(/^ — | — $/g, ""),
      meta: year ? String(year) : "" });
  }
  // Artists: distinct names off the album hits (dedup case-insensitively, cap 4).
  const seen = new Set();
  for (const a of albums) {
    const name = (a.artist || "").trim();
    const k = name.toLowerCase();
    if (!name || seen.has(k)) continue;
    seen.add(k);
    items.push({ kind: "artist", uid: "art:" + name, label: name,
      ref: { kind: "artist", name, mbid: null } });
    if (seen.size >= 4) break;
  }
  for (const p of ((peopleR.value && peopleR.value.persons) || []).slice(0, 4)) {
    // #50: don't also list a "credit" row for someone already shown as the headline
    // artist — same human, two rows reads as the redundancy the feedback flagged. The
    // artist row (the act) wins; credits-only people (producers, players…) still show.
    if (seen.has((p.name || "").trim().toLowerCase())) continue;
    // N4a: the server hands back a ready `uid` — 'per:<pid>' for a Discogs (or
    // crosswalked) person, 'per:mbid:<uuid>' for an MB-only one. Fall back to the
    // old mint only for a pre-N4a server.
    items.push({ kind: "person", uid: p.uid || ("per:" + p.person_id), label: p.name,
      ref: { kind: "person", name: p.name, person_id: p.person_id || null,
             mbid: p.mbid || null } });
  }
  for (const t of ((tracksR.value && tracksR.value.tracks) || []).slice(0, 5)) {
    if (!t.album_uid || !t.pos) continue;
    const sub = [t.album_artist, t.album_title].filter(Boolean).join(" — ");
    items.push({ kind: "track", uid: `trk:${t.album_uid}#${t.pos}`, label: t.title,
      meta: sub,
      ref: { kind: "track", title: t.title, pos: t.pos, album_uid: t.album_uid,
             album_artist: t.album_artist, album_title: t.album_title } });
  }

  _noteAttachItems = items;
  if (!items.length) {
    box.innerHTML = `<p class="muted">Nothing on file under that — try another
      spelling, or leave the note untied.</p>`;
    return;
  }
  box.innerHTML = items.map((it, i) => {
    const meta = it.meta
      ? `<span class="rem-year">${esc(String(it.meta))}</span>` : "";
    // FB#43: a plain kind word, not an emoji glyph.
    return `<button type="button" class="rem-row" data-attach-idx="${i}">
      <span class="rem-kind ${it.kind}">${esc(KIND_WORD[it.kind] || "")}</span>
      <span class="rem-name">${esc(it.label)}</span>
      ${meta}
    </button>`;
  }).join("");
}

// Attach the picked entity to the note being composed. Album → hydrated from the
// catalog server-side (ref stays null); a typed entity carries its `ref` snapshot
// (Phase 0), which saveNote sends so the note renders on its own.
function attachEntityToNote(idx) {
  const it = _noteAttachItems[Number(idx)];
  if (!it) return;
  applyNoteAttach(it);
}
// Tie the open composer to an entity item ({kind, uid, label, ref, meta}). Shared
// by the attach search (above) and the direct pencil / gesture in Album details
// (openNoteForAnchor) — both land on the same tied-to state + untie affordance.
function applyNoteAttach(it) {
  noteTarget = it.uid;
  noteTargetRef = it.ref || null;
  // FB#43: just the name — no kind glyph, no trailing album title.
  $("#noteFor").classList.remove("hidden");
  $("#noteFor").innerHTML = `Tied to <b>${esc(it.label)}</b> ` +
    `<button type="button" id="noteUntie" class="linkish">untie</button>`;
  $("#noteAttach").classList.add("hidden");
}

// The pencil that reveals on a noteable row/chip in Album details (a track, a linked
// credit, the artist thread). It carries no data of its own — its `.note-anchor`
// parent does — so the click delegate reads the anchor, not the pencil.
function notePen(label) {
  return `<button class="note-pen" type="button"
    aria-label="Write down what you notice about ${esc(label || "this")}"
    title="Write down what you notice">✎</button>`;
}

// Build the typed note item (the same shape the attach search yields) from a
// `.note-anchor` in Album details. A track's album fields come from the open story
// (storyRid + its album row); a person from the credit's pid/name; the artist from
// the thread's name. Returns null when the anchor lacks a stable id (e.g. a track
// with no position, an unlinked credit), so the affordance simply no-ops.
function noteItemFromAnchor(el) {
  const kind = el.dataset.noteKind;
  if (kind === "track") {
    const pos = el.dataset.pos, title = el.dataset.title || "";
    if (!storyRid || !pos) return null;
    const a = albumData[storyRid] || {};
    const sub = [a.artist, a.title].filter(Boolean).join(" — ");
    return { kind: "track", uid: `trk:${storyRid}#${pos}`, label: title, meta: sub,
      ref: { kind: "track", title, pos, album_uid: storyRid,
             album_artist: a.artist || "", album_title: a.title || "" } };
  }
  if (kind === "person") {
    const doorId = el.dataset.pid, name = el.dataset.name || "";
    if (!doorId) return null;
    // N4a: doorId is a Discogs person_id or 'mbid:<uuid>'; uid is 'per:'+doorId.
    const isMb = String(doorId).indexOf("mbid:") === 0;
    return { kind: "person", uid: "per:" + doorId, label: name,
      ref: { kind: "person", name, person_id: isMb ? null : doorId,
             mbid: isMb ? doorId.slice(5) : null } };
  }
  if (kind === "artist") {
    const name = el.dataset.name || "";
    if (!name) return null;
    return { kind: "artist", uid: "art:" + name, label: name,
      ref: { kind: "artist", name, mbid: null } };
  }
  return null;
}
// Open the composer already tied to a noteable entity — reached from its pencil or a
// right-click / long-press. A fresh free-note open (synchronous; no album tracklist
// to await), then attach. Pull, not push: nothing is written until you type + keep.
function openNoteForAnchor(el) {
  const it = noteItemFromAnchor(el);
  if (!it) return;
  openNoteModal();
  applyNoteAttach(it);
}

function untieRecordFromNote() {
  noteTarget = null;
  noteTargetRef = null;
  $("#noteFor").classList.add("hidden");
  $("#noteFor").innerHTML = "";
  $("#noteAttach").classList.remove("hidden");
  resetNoteAttach();
}

function closeNoteModal() {
  $("#noteModal").classList.add("hidden");
  noteTarget = null; noteTargetRef = null; noteEditId = null;
}

async function saveNote() {
  // N3b: a free note has no target — only the body is required.
  const body = $("#noteBody").value.trim();
  if (!body) { $("#noteStatus").textContent = "Write something first."; return; }
  // FB#43: the track/time UI is retired; these hidden inputs only carry an
  // existing note's values through an edit (empty for a new note).
  const track = $("#noteTrack").value.trim();
  const timestamp = $("#noteTime").value.trim();
  $("#noteStatus").textContent = "Saving…";
  // Editing patches the existing note; otherwise we create a new one (D4).
  const editing = noteEditId != null;
  const url = editing ? `/api/journal/note/${noteEditId}` : "/api/journal/note";
  const payload = editing
    ? { body, track, timestamp }
    // Identity is the uid (null for a free note); release_id rides along as Discogs
    // provenance (null for MB-only / free) so the store-bridge can fetch the snapshot.
    // v8: a typed target (artist/person/track) also carries a `ref` snapshot, since
    // there's no catalog row to hydrate it from — null for an album/free note.
    : { uid: noteTarget || null,
        release_id: noteTarget ? ridFromUid(noteTarget) : null,
        ref: noteTargetRef || null,
        // #47: carry the album's on-screen name. An MB-only ('m:') album has no
        // /api/albums row to hydrate from, so without this the note stores an empty
        // snapshot and the Notebook renders "a record". albumIndex is the same
        // clobber-safe name cache noteForLabel reads for the "tied to" line.
        ...(kindFromUid(noteTarget) === "album"
          ? { artist: (albumIndex[noteTarget] || {}).artist || "",
              title: (albumIndex[noteTarget] || {}).title || "" }
          : {}),
        body, track, timestamp };
  try {
    const r = await fetch(url, {
      method: editing ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    // B35: this is the path that showed a reader `invalid token; signature has
    // expired` — a raw JWT error where a person needed plain words. The composer
    // stays OPEN with their text untouched, and we deliberately offer NO reload
    // button here: the fix for a dead session is a reload, and a reload would
    // discard the note they are looking at. Their words outrank the tidier flow.
    if (sessionExpiredFrom(r)) {
      $("#noteStatus").textContent = SESSION_EXPIRED_NOTE_MSG;
      return;
    }
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || "failed");
    const savedFor = noteTarget;        // closeNoteModal clears it
    closeNoteModal();
    if (!editing) afterNoteSaved(savedFor);
    refreshJournalAndModal();           // reloads the shelf + the open story door
    // F26: a guest's reflection is kept — but only on this device (the buffer).
    // Say so plainly, and hold the door to making it permanent. A toast after
    // a deliberate save is feedback on their own act, not a push.
    if (window.AOTD_GUEST && !editing) {
      showToast("Kept on this device — start your Notebook to keep it for good",
        "Start →", () => { if (window.AOTDAuth) AOTDAuth.showGate("note"); });
    }
  } catch (e) { $("#noteStatus").textContent = `Could not save: ${e.message}`; }
}

// v329: writing a note took over the job Keep did. A NEW note on the record Today is
// showing — written from the card's ✎ button, from Album details, from anywhere — means
// you've made that record yours, so the deck moves on, exactly as a keep did: it isn't
// re-served today (markMet), the end-of-day line counts it, and the card behind an open
// Album details advances so closing it lands on the next record. Editing a note, or a
// note about any other record, leaves the deck where it is.
function afterNoteSaved(uid) {
  if (!uid || !deckState || deckState.idx >= deckState.records.length) return;
  if (albumKey(deckState.records[deckState.idx]) !== uid) return;
  markMet(uid);
  (deckState.noted || (deckState.noted = new Set())).add(uid);
  advanceDeck();
  if (storyRid === uid) renderStoryDeckActions(uid);
}

// Soft-delete (D3): the note vanishes immediately but is recoverable from the
// "Undo" toast, which POSTs the restore endpoint.
async function deleteNote(id) {
  try { await fetch(`/api/journal/note/${id}`, { method: "DELETE" }); }
  catch (e) { /* offline: nothing to undo */ return; }
  refreshJournalAndModal();
  showToast("Note deleted", "Undo", () => restoreNote(id));
}

async function restoreNote(id) {
  try { await fetch(`/api/journal/note/${id}/restore`, { method: "POST" }); }
  catch (e) { /* offline */ }
  refreshJournalAndModal();
}

// #48 (v2): Notebook multi-select. Long-press an entry to enter selection mode, tap to
// toggle, then delete the batch from a bar. Selection is keyed by "kind:id" so it
// survives a re-render (syncTrailSelectionUI re-applies the highlights). Single-note
// deletion lives in the note editor (deleteNote, with Undo); this batch path confirms
// once (kept records have no restore) and reloads.
let _trailSelecting = false;
let _suppressNextTrailClick = false;
const _trailSelected = new Set();          // "note:45" / "choice:12"

function _rowKey(row) { return `${row.dataset.kind}:${row.dataset.id}`; }

function enterTrailSelection(row) {
  _trailSelecting = true;
  const t = $("#trail"); if (t) t.classList.add("selecting");
  _trailSelected.clear();
  if (row) _trailSelected.add(_rowKey(row));
  syncTrailSelectionUI();
}
function exitTrailSelection() {
  _trailSelecting = false;
  _trailSelected.clear();
  const t = $("#trail"); if (t) t.classList.remove("selecting");
  syncTrailSelectionUI();
}
function toggleTrailSelection(row) {
  const k = _rowKey(row);
  if (_trailSelected.has(k)) _trailSelected.delete(k); else _trailSelected.add(k);
  if (!_trailSelected.size) { exitTrailSelection(); return; }   // last one off → leave mode
  syncTrailSelectionUI();
}
function syncTrailSelectionUI() {
  document.querySelectorAll("#trail .trail-row").forEach((row) =>
    row.classList.toggle("selected", _trailSelected.has(_rowKey(row))));
  const bar = $("#trailSelectBar");
  if (bar) bar.classList.toggle("hidden", !_trailSelecting);
  const c = $("#trailSelectCount"); if (c) c.textContent = String(_trailSelected.size);
  const d = $("#trailSelectDelete"); if (d) d.disabled = !_trailSelected.size;
}
async function deleteSelectedTrail() {
  const items = [..._trailSelected].map((k) => {
    const i = k.indexOf(":"); return { kind: k.slice(0, i), id: k.slice(i + 1) };
  });
  if (!items.length) return;
  const n = items.length;
  if (!confirm(`Delete ${n} ${n === 1 ? "entry" : "entries"} from your notebook? This can't be undone.`)) return;
  // Optimistic: drop the selected rows from view NOW so browsing continues — the
  // deletes run in the background. (Awaiting the whole batch first left the rows
  // sitting there, still selected, for seconds on a big selection.) Prune any day
  // header the removal orphaned, and show the empty state if nothing's left.
  document.querySelectorAll("#trail .trail-row.selected").forEach((row) => row.remove());
  pruneEmptyTrailDays();
  exitTrailSelection();
  if (!document.querySelector("#trail .trail-row")) renderTrail([]);
  // Fire the deletes in the background. Reconcile from the store only if one fails,
  // which honestly restores whatever didn't delete (rather than lying about it).
  (async () => {
    let anyFailed = false;
    for (const it of items) {
      try {
        // Each kind deletes through its own route — an opened row sent to
        // /api/choices would delete a kept record with the same id, or nothing.
        const url = it.kind === "note" ? `/api/journal/note/${it.id}`
          : it.kind === "opened" ? `/api/opened/${it.id}` : `/api/choices/${it.id}`;
        const r = await fetch(url, { method: "DELETE" });
        if (!r.ok) anyFailed = true;
      } catch (e) { anyFailed = true; }
    }
    if (anyFailed && currentMode() === "journal") loadTrail(true);
  })();
}
// Remove a day header the optimistic delete left with no entries under it (its next
// sibling is another day header, or it's now the last thing in the trail).
function pruneEmptyTrailDays() {
  document.querySelectorAll("#trail .trail-day").forEach((day) => {
    const next = day.nextElementSibling;
    if (!next || next.classList.contains("trail-day")) day.remove();
  });
}
// Long-press → enter selection mode. A pointer held ~450ms without moving selects the
// pressed row; a scroll or early release cancels. Suppress the trailing click so the
// press doesn't also open the entry (auto-clears in case no click follows on touch).
function wireTrailLongPress(el) {
  if (!el) return;
  let timer = null, startX = 0, startY = 0;
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
  el.addEventListener("pointerdown", (e) => {
    if (_trailSelecting) return;                    // in selection mode a tap toggles
    const row = e.target.closest(".trail-row");
    if (!row) return;
    startX = e.clientX; startY = e.clientY;
    clear();
    timer = setTimeout(() => {
      timer = null;
      _suppressNextTrailClick = true;
      setTimeout(() => { _suppressNextTrailClick = false; }, 500);
      enterTrailSelection(row);
    }, 450);
  });
  el.addEventListener("pointermove", (e) => {
    if (timer && (Math.abs(e.clientX - startX) > 10 || Math.abs(e.clientY - startY) > 10)) clear();
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach((ev) => el.addEventListener(ev, clear));
  // Right-click → the same selection mode (owner's ask 2026-07-16). The long-press
  // above is the only way in, which on a POINTER device means holding the left button
  // ~450ms — a touch gesture nobody guesses on a desktop, so delete was effectively
  // undiscoverable there. Right-click is the gesture people actually reach for, and
  // Album details already binds it (#storyModal → openNoteForAnchor), so this matches
  // an established pattern rather than inventing one.
  // Note the press-timer above starts on ANY button's pointerdown but is cleared by
  // pointerup, so a normal right-click released well inside 450ms never reached it —
  // verified 2026-07-16: a real right-click did nothing at all.
  // preventDefault suppresses the browser menu, as the modal's handler does; without
  // it the OS menu would cover the selection bar it just opened.
  el.addEventListener("contextmenu", (e) => {
    const row = e.target.closest(".trail-row");
    if (!row) return;
    e.preventDefault();
    clear();                       // the pointerdown timer is racing this — drop it
    if (_trailSelecting) return;   // already selecting: leave the batch alone
    _suppressNextTrailClick = true;
    setTimeout(() => { _suppressNextTrailClick = false; }, 500);
    enterTrailSelection(row);
  });
}

// Keep every note surface live after a write: reload the Remember shelf when it's
// showing, refresh the Your notes door when one is open (it's reachable from
// anywhere, so this runs regardless of mode), and re-read the open record's own
// notes (FB#89) — writing from Album details must land in the section you're looking
// at, not only in the Notebook you'd have to go to.
async function refreshJournalAndModal() {
  if (currentMode() === "journal") await loadTrail(true);
  if (yourNotesRid != null) fetchYourNotes(yourNotesRid);
  if (storyRid != null && !$("#storyModal").classList.contains("hidden")) {
    fetchStoryNotes(storyRid);
  }
}

// --- N3: the field-notebook TRAIL --------------------------------------------
// One reverse-chronological stream of the choices and notes you authored (free +
// record-anchored), grouped by day. Read-time assembly of the two existing feeds
// (/api/journal's grouped notes + /api/choices) — nothing new is stored, and it's
// strictly pull (you open Remember; nothing is surfaced at you).
let _trailLoading = null;
let _trailSeq = 0;                        // stale-response guard for the search box
let _trailNotesById = {};                // id -> {id, body, track, timestamp} for edit-on-tap
let _trailUnreadable = 0;                // rows the last load couldn't decrypt (FB#92/#104)
// FB#92/#104: a journal read that FAILED must never be read as a journal that's
// EMPTY. The store-bridge answers a failed read with a 500-shaped JSON body
// ({error: …}), which parses perfectly happily — so `.then(r => r.json())` swallowed
// the failure, buildTrailEntries saw no notes, and the notebook painted "Your field
// notebook is empty." at a reader whose notebook was full. (Both files carried a
// comment claiming this couldn't happen; the status was simply never inspected.)
// Every journal read goes through here now: a non-ok status throws, so the caller's
// catch shows "couldn't load" — the honesty rule, applied to the one surface where a
// lie is unbearable.
async function readJournal(url) {
  const r = await fetch(url);
  if (!r.ok) {
    let detail = "";
    try { detail = (await r.json()).error || ""; } catch (e) {}
    throw new Error(`journal read failed (${r.status})${detail ? ": " + detail : ""}`);
  }
  return r.json();
}

// FB#95: our own clear control on a search field, replacing the browser's native
// one (suppressed in CSS). Wraps the input in a positioned slot and hangs a ✕ in
// it, shown only when there's something to clear. Built here rather than in the
// markup so every search field gets the identical control and a new one can't
// forget it. Fires `input` after clearing, which is the event each field's own
// handler already listens on (the trail's debounce, Explore's search) — so the
// results refresh exactly as if you'd deleted the text yourself.
function wireSearchClear(input) {
  if (!input || input._clearWired) return;
  input._clearWired = true;
  const slot = document.createElement("span");
  slot.className = "search-slot";
  input.parentNode.insertBefore(slot, input);
  slot.appendChild(input);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "search-clear";
  btn.setAttribute("aria-label", "Clear the search");
  btn.setAttribute("title", "Clear");
  btn.textContent = "✕";
  slot.appendChild(btn);
  const sync = () => slot.classList.toggle("has-text", !!input.value);
  input.addEventListener("input", sync);
  btn.addEventListener("click", () => {
    input.value = "";
    sync();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    try { input.focus(); } catch (e) {}
  });
  sync();
}

// FB#94: when code (not typing) changes a search field's value, the ✕ has to catch
// up — restoring a term on the way back from a wander otherwise leaves a filled box
// with no way to clear it. Kept beside wireSearchClear so the `.has-text` contract
// lives in one place.
function refreshSearchClear(input) {
  const slot = input && input.closest && input.closest(".search-slot");
  if (slot) slot.classList.toggle("has-text", !!input.value);
}

async function loadTrail(force = false) {
  if (_trailLoading && !force) return _trailLoading;
  // v353: a date-like entry in the bar ("oct", "last week") is offered as a range, not
  // searched as words — the trail stays put under the suggestions until one is picked.
  const typed = $("#journalSearch").value.trim();
  const q = nbDateLike(typed) ? "" : typed;
  const seq = ++_trailSeq;
  // FB#107: never show a blank shelf on the first cold paint. On the very first open
  // (a fresh update, no notebook rendered yet) the /api/journal read hangs on the
  // store's whenReady gate while loadAll pulls + decrypts — during which #trail was
  // literally empty, reading as "your notebook is empty." Paint a loading state
  // instead. Skip it on a search refinement or a re-render (#trail already has content
  // then), so it never flashes on a keystroke. Once the encrypted cache is warm the
  // store is ready instantly and this window closes on its own.
  const trailEl = $("#trail");
  if (trailEl && !q && !trailEl.querySelector(".trail-entry, .empty")) {
    trailEl.innerHTML = `<div class="empty">Opening your notebook…</div>`;
  }
  const p = (async () => {
    try {
      const [journal, choicesResp, openedResp] = await Promise.all([
        readJournal("/api/journal" + (q ? `?q=${encodeURIComponent(q)}` : "")),
        readJournal("/api/choices"),
        // v9: opened entries. Unlike notes, a failed read here degrades to "none
        // shown" rather than "couldn't load": an open is a trace of a tap, not
        // writing, so it must never be the reason the notebook won't open.
        readJournal("/api/opened").catch(() => ({ opened: [] })),
      ]);
      // A newer search (or reload) started after us — discard this response so a
      // slow fetch can't clobber fresher results (e.g. clearing the box).
      if (seq !== _trailSeq) return;
      _trailUnreadable = +journal.unreadable || 0;
      const all = buildTrailEntries(journal, choicesResp, q, openedResp);
      if (!q) _trailDays = all.map((e) => localDayOf(e.at)).filter(Boolean);   // for the counts
      const entries = trailInDateRange(all, nbDateRange());
      // Resolve albums the trail needs but the feed didn't hydrate (it only hydrates
      // by numeric release_id): a track note's album cover (FB#56), and an album note
      // whose stored snapshot has no name — MB-only ('m:') albums have a null
      // release_id, so the feed leaves them blank and the entry reads "a record"
      // (FB#47). resolveAlbums goes by uid (handles MB-only), which also HEALS notes
      // written before the write-time snapshot fix landed.
      const needAlbums = new Set();
      for (const e of entries) {
        if (e.kind !== "note") continue;
        const k = kindFromUid(e.uid);
        if (k === "track" && e.ref && e.ref.album_uid) needAlbums.add(e.ref.album_uid);
        else if (k === "album" && e.uid && !(e.artist && e.title)) needAlbums.add(e.uid);
      }
      if (needAlbums.size) await resolveAlbums([...needAlbums]);
      if (seq !== _trailSeq) return;                 // resolve is async — re-check
      stopTrailRetry();          // FB#107: it worked — cancel any pending backoff
      renderTrail(entries);
    } catch (e) {
      if (seq === _trailSeq) renderTrailUnreadable(e);
    }
  })();
  _trailLoading = p;
  try { return await p; } finally { if (_trailLoading === p) _trailLoading = null; }
}

// Flatten the grouped notes feed + the choices feed into dated entries. A free note
// arrives in the null-uid group (uid/artist/title null) → a free noticing. Notes are
// already server-filtered by ?q=; choices are filtered here by the same query.
// v9: opened entries join too. An open of a record you also WROTE about that same local
// day doesn't get a row of its own — it rides on that note as an "Opened in ___" line,
// so the day reads as one thing you did, not two. Same-day duplicates (a tap on two
// devices) fold to the earliest. Filtered by ?q= on the client, like choices.
// FILTER BY DATE (owner 2026-10-05): the notebook's From / To pickers. Either end may be
// open; a reversed pair is read the right way round rather than matching nothing.
// Dates compare as YYYY-MM-DD strings in the reader's own day (localDayOf), the same
// day the trail's headings show.
function nbDateRange() {
  const f = ($("#nbFrom") || {}).value || "", t = ($("#nbTo") || {}).value || "";
  return f && t && f > t ? { from: t, to: f } : { from: f, to: t };
}
function trailInDateRange(entries, range) {
  if (!range.from && !range.to) return entries;
  return entries.filter((e) => {
    const d = localDayOf(e.at);
    return d && (!range.from || d >= range.from) && (!range.to || d <= range.to);
  });
}
function nbDateLabel(ymd) {
  const [y, m, d] = String(ymd).split("-").map(Number);
  return y ? new Date(y, m - 1, d).toLocaleDateString(undefined,
    { month: "short", day: "numeric", year: "numeric" }) : "";
}

// --- THE BOTTOM BAR: dates in the search (v353, owner 2026-10-05, mockups N1 + S1) ----
// One bar per tab, at the foot (index.html #bottomBar). It understands dates:
//   * Notebook — a date-like entry is offered as ranges, with how many of your entries
//     each holds (only ranges that hold something): "oct" → October 2026 / October 2025,
//     "oct 5", "10/5", "5 oct", "2025", "today", "last week", "this month", a range like
//     "sep 1 - oct 5", or just "dates" for "Pick dates…" (the old From/To). A picked
//     range is a chip in the bar; words typed beside it search within it.
//   * Search — a day ("oct 5", "10/5") is offered as the records released then, any
//     year (runExploreDay, F33's day search, which used to hide behind Filter).
// The parsers are pure (tests/js/bar-dates.test.mjs); the state is _nbRange + the
// hidden #nbFrom/#nbTo that nbDateRange() already reads, and exploreDay.
let _nbRange = null;       // { label, from, to } — the Notebook's picked range
let _trailDays = [];       // the local day of every entry in the last unfiltered read
let _barPicking = false;   // the Notebook's "Pick dates…" row is open
const BAR_MONTHS = ["january", "february", "march", "april", "may", "june", "july",
  "august", "september", "october", "november", "december"];
const BAR_MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const BAR_CAL = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>`;
function barMonth(w) {
  w = String(w || "").toLowerCase().replace(/\.$/, "");
  return w.length >= 3 ? BAR_MONTHS.findIndex((m) => m.startsWith(w)) : -1;
}
function barYmd(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function barDaysIn(y, m) { return new Date(y, m + 1, 0).getDate(); }
function barDayLabel(ymd) {
  const [y, m, d] = String(ymd).split("-").map(Number);
  return `${BAR_MON[m - 1]} ${d}, ${y}`;
}
function barMonthLabel(y, m) { return `${BAR_MONTHS[m][0].toUpperCase()}${BAR_MONTHS[m].slice(1)} ${y}`; }
// One date expression → candidate ranges, one per year to consider (newest first).
function barOneDate(text, years) {
  const t = String(text || "").trim().toLowerCase();
  const out = [];
  let m;
  if ((m = t.match(/^((?:19|20)\d\d)$/))) {
    out.push({ label: `All of ${m[1]}`, from: `${m[1]}-01-01`, to: `${m[1]}-12-31` });
  } else if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    const mi = +m[2] - 1, d = +m[3];
    if (mi >= 0 && mi < 12 && d >= 1 && d <= barDaysIn(+m[1], mi)) {
      const ymd = barYmd(+m[1], mi, d);
      out.push({ label: barDayLabel(ymd), from: ymd, to: ymd });
    }
  } else if ((m = t.match(/^([a-z]+)\.?(?:\s+(\d{1,2}))?(?:,?\s+((?:19|20)\d\d))?$/))
             || (m = t.match(/^(\d{1,2})\s+([a-z]+)\.?(?:,?\s+((?:19|20)\d\d))?$/))) {
    const dayFirst = /^\d/.test(t);
    const mi = barMonth(dayFirst ? m[2] : m[1]);
    const d = dayFirst ? m[1] : m[2];
    if (mi >= 0) {
      for (const y of (m[3] ? [+m[3]] : years)) {
        if (d) {
          if (+d >= 1 && +d <= barDaysIn(y, mi)) {
            const ymd = barYmd(y, mi, +d);
            out.push({ label: barDayLabel(ymd), from: ymd, to: ymd });
          }
        } else {
          out.push({ label: barMonthLabel(y, mi), from: barYmd(y, mi, 1), to: barYmd(y, mi, barDaysIn(y, mi)) });
        }
      }
    }
  } else if ((m = t.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/))) {
    const mi = +m[1] - 1, d = +m[2];
    const ys = m[3] ? [m[3].length === 2 ? 2000 + +m[3] : +m[3]] : years;
    for (const y of ys) {
      if (mi >= 0 && mi < 12 && d >= 1 && d <= barDaysIn(y, mi)) {
        const ymd = barYmd(y, mi, d);
        out.push({ label: barDayLabel(ymd), from: ymd, to: ymd });
      }
    }
  }
  return out;
}
// The Notebook's reading of the bar: relative words, one date, or "A - B" / "A to B".
function barDateRanges(q, today, years) {
  const t = String(q || "").trim().toLowerCase();
  if (!t) return [];
  const T = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const add = (n) => { const x = new Date(T); x.setDate(x.getDate() + n); return x; };
  const iso = (d) => barYmd(d.getFullYear(), d.getMonth(), d.getDate());
  const mon = (T.getDay() + 6) % 7;                       // days since Monday
  const ty = T.getFullYear(), tm = T.getMonth();
  const lm = tm === 0 ? 11 : tm - 1, lmy = tm === 0 ? ty - 1 : ty;
  const rel = [
    ["today", "Today", iso(T), iso(T)],
    ["yesterday", "Yesterday", iso(add(-1)), iso(add(-1))],
    ["this week", "This week", iso(add(-mon)), iso(T)],
    ["last week", "Last week", iso(add(-mon - 7)), iso(add(-mon - 1))],
    ["this month", "This month", barYmd(ty, tm, 1), iso(T)],
    ["last month", "Last month", barYmd(lmy, lm, 1), barYmd(lmy, lm, barDaysIn(lmy, lm))],
    ["this year", "This year", `${ty}-01-01`, iso(T)],
    ["last year", "Last year", `${ty - 1}-01-01`, `${ty - 1}-12-31`],
  ];
  if (t.length >= 3) {
    const hits = rel.filter(([w]) => w.startsWith(t));
    if (hits.length) return hits.map(([, label, from, to]) => ({ label, from, to }));
  }
  const span = t.match(/^(.+?)\s*(?:-|–|—|\bto\b|\buntil\b)\s*(.+)$/);
  if (span && !/^\d{4}-\d{1,2}-\d{1,2}$/.test(t) && !/^\d{1,2}-\d{1,2}(?:-\d{2,4})?$/.test(t)) {
    const out = [];
    for (const y of years) {
      const a = barOneDate(span[1], [y])[0];
      let b = barOneDate(span[2], [y])[0];
      if (a && b && b.to < a.from) b = barOneDate(span[2], [y + 1])[0];   // dec 1 - jan 5
      if (a && b) out.push({ label: `${a.label} – ${b.label}`, from: a.from, to: b.to });
    }
    if (out.length) return out;
  }
  return barOneDate(t, years);
}
// Search's reading: a calendar day, any year → "MM-DD", else null.
function barDay(q) {
  const t = String(q || "").trim().toLowerCase();
  let m = t.match(/^([a-z]+)\.?\s+(\d{1,2})$/) || t.match(/^(\d{1,2})\s+([a-z]+)\.?$/);
  if (m) {
    const dayFirst = /^\d/.test(t);
    const mi = barMonth(dayFirst ? m[2] : m[1]), d = +(dayFirst ? m[1] : m[2]);
    if (mi >= 0 && d >= 1 && d <= barDaysIn(2024, mi)) return barYmd(2024, mi, d).slice(5);
    return null;
  }
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})$/);
  if (m && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= barDaysIn(2024, +m[1] - 1))
    return barYmd(2024, +m[1] - 1, +m[2]).slice(5);
  return null;
}
// Years a Notebook date could mean: the ones your entries reach, newest first, always
// with this year.
function barYears() {
  const ys = new Set(_trailDays.map((d) => +d.slice(0, 4)));
  ys.add(new Date().getFullYear());
  return [...ys].sort((a, b) => b - a);
}
function nbDateLike(q) {
  const t = String(q || "").trim().toLowerCase();
  return /^dates?$/.test(t) || barDateRanges(t, new Date(), barYears()).length > 0;
}
function barCount(r) { return _trailDays.filter((d) => d >= r.from && d <= r.to).length; }
function barInput() { return _mode === "forest" ? $("#forestSearchInput") : $("#journalSearch"); }

function setNbRange(r) {
  _nbRange = r;
  const f = $("#nbFrom"), t = $("#nbTo");
  if (f) f.value = r ? r.from : "";
  if (t) t.value = r ? r.to : "";
  renderBarChips();
  loadTrail(true);
}
function renderBarChips() {
  const chip = (label, which, what) => `<span class="bar-chip-label">${esc(label)}</span><button
    type="button" class="bar-chip-x" data-chip-clear="${which}" aria-label="Clear ${what}">✕</button>`;
  const nb = $("#nbDateChip"), dc = $("#dayChip");
  if (nb) {
    nb.classList.toggle("hidden", !(_mode === "journal" && _nbRange));
    nb.innerHTML = _nbRange ? chip(_nbRange.label, "nb", "the dates") : "";
  }
  if (dc) {
    const [mm, dd] = (exploreDay || "").split("-").map(Number);
    dc.classList.toggle("hidden", !(_mode === "forest" && exploreDay));
    dc.innerHTML = exploreDay ? chip(`${BAR_MON[mm - 1]} ${dd}`, "day", "the day") : "";
  }
  const js = $("#journalSearch");
  if (js) js.placeholder = _nbRange ? "Find words…" : "Find in your notebook…";
}
function hideBarSugg() {
  const box = $("#barSugg");
  if (box) { box.classList.add("hidden"); box.innerHTML = ""; }
  _barPicking = false;
}
// What the bar offers for what's typed (or nothing). Rows carry their pick in data-*.
function renderBarSugg() {
  const box = $("#barSugg"), inp = barInput();
  if (!box || !inp || document.activeElement !== inp && !box.contains(document.activeElement)) {
    if (box && !_barPicking) hideBarSugg();
    return;
  }
  const q = inp.value.trim();
  let html = "";
  if (_mode === "forest") {
    const md = barDay(q);
    if (md && md !== exploreDay) {
      html = `<p class="bs-lab">A day</p><button type="button" class="bs-row is-first" data-bs-day="${md}"
        >${BAR_CAL}Records released on ${esc(formatMD(md))}<span class="bs-n">any year</span></button>`;
    }
  } else if (_mode === "journal" && (nbDateLike(q) || _barPicking)) {
    const ranges = /^dates?$/i.test(q) ? [] : barDateRanges(q, new Date(), barYears())
      .map((r) => ({ ...r, n: barCount(r) }));
    const hits = ranges.filter((r) => r.n > 0);
    html = `<p class="bs-lab">Narrow by date</p>`
      + hits.map((r, i) => `<button type="button" class="bs-row${i ? "" : " is-first"}" data-bs-from="${r.from}"
          data-bs-to="${r.to}" data-bs-label="${esc(r.label)}">${BAR_CAL}${esc(r.label)}<span class="bs-n">${
          r.n} ${r.n === 1 ? "entry" : "entries"}</span></button>`).join("")
      + (ranges.length && !hits.length
        ? `<p class="bs-none">Nothing in your notebook from ${esc(ranges[0].label)}.</p>` : "")
      + (_barPicking
        ? `<div class="bs-pickrow"><input type="date" id="bsFrom" aria-label="From date"
            value="${esc((_nbRange && _nbRange.from) || "")}"><span aria-hidden="true">–</span><input
            type="date" id="bsTo" aria-label="To date" value="${esc((_nbRange && _nbRange.to) || "")}"
            ><button type="button" data-bs-apply>Done</button></div>`
        : `<button type="button" class="bs-row${hits.length ? "" : " is-first"}" data-bs-pick>${BAR_CAL}Pick dates…</button>`);
  }
  box.innerHTML = html;
  box.classList.toggle("hidden", !html);
}
// Enter / the keyboard's search key: take the first offer, if there is one.
function pickFirstBarSugg() {
  const first = $("#barSugg:not(.hidden) .bs-row.is-first");
  if (!first) return false;
  first.click();
  return true;
}
function wireBottomBar() {
  const box = $("#barSugg");
  const js = $("#journalSearch"), fs = $("#forestSearchInput");
  if (!box || !js || !fs) return;
  [js, fs].forEach((inp) => {
    inp.addEventListener("input", renderBarSugg);
    inp.addEventListener("focus", renderBarSugg);
    inp.addEventListener("blur", () => setTimeout(() => {
      if (!box.contains(document.activeElement) && !_barPicking) hideBarSugg();
    }, 120));
  });
  js.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && pickFirstBarSugg()) e.preventDefault();
  });
  [js, fs].forEach((inp) => inp.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !box.classList.contains("hidden")) { e.stopPropagation(); hideBarSugg(); }
  }));
  // A press on an offer must not take the focus (the keyboard would drop) — except in
  // the date fields, which need it.
  box.addEventListener("pointerdown", (e) => {
    if (!e.target.closest("input")) e.preventDefault();
  });
  box.addEventListener("click", (e) => {
    const day = e.target.closest("[data-bs-day]");
    if (day) { hideBarSugg(); runExploreDay(day.dataset.bsDay); return; }
    const r = e.target.closest("[data-bs-from]");
    if (r) {
      js.value = ""; refreshSearchClear(js); hideBarSugg();
      setNbRange({ label: r.dataset.bsLabel, from: r.dataset.bsFrom, to: r.dataset.bsTo });
      return;
    }
    if (e.target.closest("[data-bs-pick]")) { _barPicking = true; renderBarSugg(); return; }
    if (e.target.closest("[data-bs-apply]")) {
      let f = ($("#bsFrom") || {}).value || "", t = ($("#bsTo") || {}).value || "";
      if (f && t && f > t) [f, t] = [t, f];
      js.value = ""; refreshSearchClear(js); hideBarSugg();
      if (!f && !t) { setNbRange(null); return; }
      const label = f && t ? (f === t ? barDayLabel(f) : `${barDayLabel(f)} – ${barDayLabel(t)}`)
        : f ? `From ${barDayLabel(f)}` : `Until ${barDayLabel(t)}`;
      setNbRange({ label, from: f || "0000-01-01", to: t || "9999-12-31" });
    }
  });
  // A chip's ✕: the Notebook's range, or Search's day.
  $("#bottomBar").addEventListener("click", (e) => {
    const x = e.target.closest("[data-chip-clear]");
    if (!x) return;
    if (x.dataset.chipClear === "nb") setNbRange(null);
    else exitExploreDay(false);
    const inp = barInput();
    if (inp) { try { inp.focus(); } catch (err) {} }
  });
  wireKeyboardLift();
}
// The keyboard: iOS shrinks the VISUAL viewport and leaves fixed elements where they
// were, so a bar at the foot would sit behind it. Measure the keyboard from the visual
// viewport and let the bar ride on it (--kb, body.kb-open; CSS hides the dock it covers).
function wireKeyboardLift() {
  const vv = window.visualViewport;
  if (!vv) return;
  const update = () => {
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    document.documentElement.style.setProperty("--kb", kb + "px");
    document.body.classList.toggle("kb-open", kb > 80);
  };
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  update();
}

function localDayOf(iso) {
  const d = new Date(iso || "");
  if (isNaN(d)) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function buildTrailEntries(journal, choicesResp, q, openedResp) {
  const entries = [];
  for (const g of (journal.albums || [])) {
    for (const n of (g.notes || [])) {
      entries.push({
        kind: "note", at: n.created_at || "", id: n.id,
        uid: g.uid || null, artist: g.artist || "", title: g.title || "",
        cover: g.cover, release_id: g.release_id, ref: g.ref || null,
        body: n.body || "", track: n.track, timestamp: n.timestamp,
      });
    }
  }
  const ql = (q || "").toLowerCase();
  for (const c of (choicesResp.choices || [])) {
    if (ql) {
      const hay = [c.chosen_artist, c.chosen_title, c.not_chosen_artist,
        c.not_chosen_title, c.note].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(ql)) continue;
    }
    entries.push({ kind: "choice", at: c.chosen_at || "", id: c.id, choice: c });
  }
  const noteByDay = new Map();          // "uid|local day" -> the first note entry
  for (const e of entries) {
    if (e.kind !== "note" || !e.uid) continue;
    const k = e.uid + "|" + localDayOf(e.at);
    if (!noteByDay.has(k)) noteByDay.set(k, e);
  }
  const seenOpen = new Set();
  const opened = ((openedResp && openedResp.opened) || []).slice()
    .sort((a, b) => String(a.opened_at || "").localeCompare(String(b.opened_at || "")));
  for (const o of opened) {               // oldest first, so the earliest wins a fold
    const k = o.uid + "|" + o.day;
    if (!o.uid || seenOpen.has(k)) continue;
    seenOpen.add(k);
    const note = noteByDay.get(k);
    if (note) { note.openedIn = o.service; continue; }
    if (ql && ![o.artist, o.title].filter(Boolean).join(" ").toLowerCase().includes(ql)) continue;
    entries.push({ kind: "opened", at: o.opened_at || "", id: o.id, uid: o.uid,
      artist: o.artist || "", title: o.title || "", cover: o.cover || null,
      service: o.service, day: o.day });
  }
  // Newest first; the day stamp is a plain string so a lexical sort is chronological.
  entries.sort((a, b) => (b.at || "").localeCompare(a.at || ""));
  return entries;
}

const _TRAIL_MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
function trailDayLabel(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  return m ? `${_TRAIL_MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}` : "";
}

function trailNoteEntry(e) {
  _trailNotesById[String(e.id)] = {
    id: e.id, body: e.body, track: e.track, timestamp: e.timestamp,
    uid: e.uid || null, ref: e.ref || null,
  };
  // v8: a note ties to a record, a track, a person, or an artist (or nothing — a
  // free noticing). The thumb + head follow the kind: a record keeps its cover; a
  // typed entity wears its kind glyph + the label from its `ref` snapshot.
  const kind = kindFromUid(e.uid);
  const ref = e.ref || {};
  let thumb, head;
  if (kind === "free") {
    thumb = `<div class="te-thumb free" aria-hidden="true">✎</div>`;
    head = `<span class="te-chip free">a noticing</span>`;
  } else if (kind === "album") {
    // FB#47: an MB-only album note stores no name (the feed hydrates by release_id,
    // null for m: albums), so fall back to the uid-resolved catalog name
    // (resolveAlbums ran in loadTrail; albumIndex is its clobber-safe cache) rather
    // than collapse to "a record". Heals notes written before the write-time fix.
    const nm = (e.artist || e.title)
      ? { artist: e.artist, title: e.title }
      : (albumIndex[e.uid] || { artist: "", title: "" });
    thumb = `<div class="te-thumb">${coverHtml({ artist: nm.artist, title: nm.title,
      cover: e.cover, uid: e.uid, release_id: e.release_id }, { fix: false })}</div>`;
    head = trailTitleHead(nm.artist, nm.title);   // B23 guard (empty artist/title)
  } else if (kind === "track") {
    // FB#56: a track note shows its album's cover — a song is still about a record
    // you can see. The album is resolved by ref.album_uid in loadTrail (covers the
    // MB-only case too), so albumData carries the cover URL here; fall back to the
    // plain kind word (FB#43) only when there's no album to show.
    const sub = [ref.album_artist, ref.album_title].filter(Boolean).join(" — ");
    const alb = (ref.album_uid && albumData[ref.album_uid]) || {};
    thumb = ref.album_uid
      ? `<div class="te-thumb">${coverHtml({ uid: ref.album_uid,
          artist: ref.album_artist, title: ref.album_title,
          cover: alb.cover, release_id: alb.release_id }, { fix: false })}</div>`
      : `<div class="te-thumb kind track" aria-hidden="true">${esc(KIND_WORD.track)}</div>`;
    head = `<span class="te-title">${esc(ref.title || e.title || "song")}</span>`
      + (sub ? ` <span class="te-sep">—</span> <span class="te-album">${esc(sub)}</span>` : "");
  } else {                                   // artist / person
    const name = ref.name || e.artist || e.title
      || (kind === "person" ? "someone" : "an artist");
    thumb = `<div class="te-thumb kind ${esc(kind)}" aria-hidden="true">${esc(KIND_WORD[kind] || "")}</div>`;
    head = `<span class="te-album">${esc(name)}</span>`;
  }
  const track = e.track
    ? `<div class="te-track">♪ ${esc(e.track)}${e.timestamp ? ` · ${esc(e.timestamp)}` : ""}</div>`
    : "";
  // #53: the cover + title open Album details (a door); the rest of the entry opens
  // the note to edit. `albumUid` is the record that door opens — the note's own uid
  // for an album note, the track's album for a track note, empty for a free/typed
  // note (which has no record, so no details door and no `te-openable` affordance).
  const albumUid = kind === "album" ? (e.uid || "")
    : (kind === "track" ? (ref.album_uid || "") : "");
  const openable = albumUid ? " te-openable" : "";
  return `<button type="button" class="trail-entry note${openable}" data-note-id="${esc(String(e.id))}"
      data-uid="${esc(e.uid || "")}" data-album-uid="${esc(albumUid)}" title="Open this note">
    ${thumb}
    <div class="te-body">
      <div class="te-head">${head}</div>
      <div class="te-note">${renderMarkdown(e.body)}</div>
      ${track}
      ${e.openedIn ? `<div class="te-opened">Opened in ${esc(_platLabel[e.openedIn] || e.openedIn)}</div>` : ""}
    </div>
  </button>`;
}

// v9: an opened record — quieter than a note (smaller cover, one muted line), since
// it's a trace of reaching for a record, not something you wrote. Tapping it opens
// Album details, like a kept record; long-press removes it like anything else here.
function trailOpenedEntry(e) {
  const label = _platLabel[e.service] || e.service || "";
  return `<button type="button" class="trail-entry trail-opened" data-uid="${esc(e.uid || "")}"
      title="Open ${esc([e.artist, e.title].filter(Boolean).join(" — "))}">
    <div class="te-thumb">${coverHtml({ uid: e.uid, artist: e.artist, title: e.title,
      cover: e.cover }, { fix: false })}</div>
    <div class="te-body">
      <div class="te-head">${trailTitleHead(e.artist, e.title)}</div>
      <div class="te-opened">Opened in ${esc(label)}</div>
    </div>
  </button>`;
}

// v9: "Show opened" — whether opened entries are drawn. Remembered on this device
// (owner's call), and only a convenience, so storage failing just means "shown".
const SHOW_OPENED_KEY = "mf-notebook-show-opened/v1";
function showOpened() {
  // Owner, 2026-10-05: on by default, and the switch lives in ☰ › Settings — which only
  // an account's menu has. So a guest always sees them; an "off" saved before the pill
  // went can't strand a guest with no way back.
  if (window.AOTD_GUEST) return true;
  try { return localStorage.getItem(SHOW_OPENED_KEY) !== "0"; } catch (e) { return true; }
}
// ☰ › Settings drives the switch (auth-ui.js); it lives there, the state lives here.
window.AOTDShowOpened = {
  get: () => showOpened(),
  set: (on) => { setShowOpened(!!on); if (currentMode() === "journal") loadTrail(true); },
};
function setShowOpened(on) {
  try { localStorage.setItem(SHOW_OPENED_KEY, on ? "1" : "0"); } catch (e) { /* session only */ }
}

// B23 guard: a robust "artist — title" head. The em-dash separator shows ONLY when
// BOTH sides are present, so a record missing one — e.g. a hosted choice whose
// chosen_artist didn't denormalize — never renders a stray leading "— title" that
// reads as a broken indent. Shared by the choice + album-note trail entries.
function trailTitleHead(artist, title) {
  const a = (artist || "").trim(), t = (title || "").trim();
  if (a && t) return `<span class="te-album">${esc(a)}</span> <span class="te-sep">—</span> <span class="te-title">${esc(t)}</span>`;
  if (t) return `<span class="te-title">${esc(t)}</span>`;
  if (a) return `<span class="te-album">${esc(a)}</span>`;
  return `<span class="te-title">a record</span>`;
}

function trailChoiceEntry(e) {
  const c = e.choice;
  // Prefer the server-attached full album (has cover), else the choice's own
  // denormalized snapshot (chosen_* columns) if the album's left the catalog.
  const a = (c.album && (c.album.uid || c.album.release_id != null)) ? c.album : {
    uid: c.chosen_uid || (c.chosen_id != null ? "d:" + c.chosen_id : null),
    release_id: c.chosen_id, artist: c.chosen_artist, title: c.chosen_title,
    released: c.chosen_released, genres: c.chosen_genres, cover: c.cover,
  };
  // Every choice row reads as "kept" — the keep model is the one act now. A legacy
  // two-record row (owner 2026-07-12: unify the labels) still carries its not-chosen
  // record as a quiet "over X" footnote (D4 history), but the chip no longer says
  // "chose" — keeping the chosen record is what happened either way.
  const over = c.not_chosen_title
    ? `<div class="te-over">over ${esc([c.not_chosen_artist, c.not_chosen_title].filter(Boolean).join(" — "))}</div>`
    : "";
  const why = c.note ? `<div class="te-note">${renderMarkdown(c.note)}</div>` : "";
  const tags = (c.reasons || []).length
    ? `<div class="te-tags">${(c.reasons || []).map((r) =>
        `<span class="te-tag">${esc(r)}</span>`).join("")}</div>`
    : "";
  // Prefer the denormalized chosen_* snapshot, but fall back to the attached
  // album's own artist/title when it didn't denormalize (the same hosted-choice
  // gap noted at trailTitleHead) — the cover renders from `a`, so the name
  // should too, instead of collapsing to a bare "a record".
  const headArtist = c.chosen_artist || a.artist, headTitle = c.chosen_title || a.title;
  return `<button type="button" class="trail-entry trail-choice" data-uid="${esc(a.uid || "")}"
      title="Open ${esc([headArtist, headTitle].filter(Boolean).join(" — "))}">
    <div class="te-thumb">${coverHtml(a, { fix: false })}</div>
    <div class="te-body">
      <div class="te-head">
        ${trailTitleHead(headArtist, headTitle)}
        <span class="te-chip kept">kept</span>
      </div>
      ${over}${why}${tags}
    </div>
  </button>`;
}

// FB#92/#104: the notebook couldn't be read. Say that, and give the one action that
// helps — never the empty state, which reads as "your writing is gone."
//
// FB#107 (owner, during a Render deploy): "the error message could be more clear
// rather than a seemingly-infinite 'try again' button." It was worse than unclear —
// the button could not work. A failed loadAll latches the store's error, so every
// later journal read rejects instantly; retrying the FEED just re-hit that. Retrying
// now re-runs the load itself (AOTDAuth.retryJournal), and does it on a backoff
// without being asked, because a deploy resolves itself in a minute or two.
//
// It also answers the question the state raises. A signed-in notebook is held
// encrypted on the server and decrypted into memory at unlock — it is never written
// to this device — so there is genuinely nothing local to fall back to. Saying that
// plainly beats implying the app has mislaid something.
let _trailRetryTimer = null, _trailRetryStep = 0;
const TRAIL_RETRY_DELAYS = [3000, 6000, 12000, 20000, 30000];

function stopTrailRetry() {
  if (_trailRetryTimer) { clearTimeout(_trailRetryTimer); _trailRetryTimer = null; }
  _trailRetryStep = 0;
}

async function retryTrailNow() {
  stopTrailRetry();
  const box = $("#trail");
  if (box) box.innerHTML = `<div class="empty">Opening your notebook…</div>`;
  try {
    if (window.AOTDAuth && AOTDAuth.retryJournal) await AOTDAuth.retryJournal();
  } catch (e) { /* the reload below reports whatever state we're in */ }
  return loadTrail(true);
}

function renderTrailUnreadable(err) {
  const box = $("#trail");
  if (!box) return;
  console.error("notebook read failed", err);
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  const lead = offline
    ? "You're offline, so your notebook can't be opened yet."
    : "Music Forest can't be reached right now — it may be updating.";
  const why = offline
    ? "Your notes are encrypted on the server, not stored on this device, so opening them needs a connection."
    : "Nothing is lost. Your notes are encrypted on the server and this device just couldn't fetch them.";
  const more = _trailRetryStep < TRAIL_RETRY_DELAYS.length;
  box.innerHTML = `<div class="empty trail-unreadable">
      <b>${esc(lead)}</b><br>${esc(why)}
      <div class="trail-retry-row">
        <button type="button" id="trailRetry" class="ghost">Try now</button>
        ${more ? `<span class="trail-retry-note muted">Trying again on its own…</span>`
               : `<span class="trail-retry-note muted">Still no luck — reopening the app will try again.</span>`}
      </div>
    </div>`;
  const retry = $("#trailRetry");
  if (retry) retry.addEventListener("click", () => { _trailRetryStep = 0; retryTrailNow(); });
  // Back off rather than hammer a server that's mid-deploy, and stop after the last
  // step instead of retrying forever behind a message that says it's still trying.
  if (more && currentMode() === "journal") {
    const wait = TRAIL_RETRY_DELAYS[_trailRetryStep++];
    _trailRetryTimer = setTimeout(() => {
      _trailRetryTimer = null;
      if (currentMode() === "journal") retryTrailNow();
    }, wait);
  }
}

function renderTrail(entries) {
  const box = $("#trail");
  if (!box) return;
  _trailNotesById = {};
  if (!entries.length) {
    const q = $("#journalSearch").value.trim();
    // FB#92/#104: rows came back that this key couldn't open. That is a locked
    // notebook, not an empty one — the difference matters more here than anywhere
    // else in the app, so name it and point at the recovery code.
    if (!q && _trailUnreadable > 0) {
      const n = _trailUnreadable;
      box.innerHTML = `<div class="empty trail-unreadable">
          <b>Your notebook is here, but this password can't open it.</b><br>
          ${n} ${n === 1 ? "entry" : "entries"} came back encrypted under a different
          key. Nothing is lost. Sign out and unlock again with your recovery code, or
          the password you used when you wrote them.
        </div>`;
      return;
    }
    const r = nbDateRange();
    const span = r.from && r.to ? `between ${nbDateLabel(r.from)} and ${nbDateLabel(r.to)}`
      : r.from ? `since ${nbDateLabel(r.from)}` : r.to ? `up to ${nbDateLabel(r.to)}` : "";
    box.innerHTML = q || span
      ? `<div class="empty">Nothing in your notebook${
          q ? ` matches “${esc(q)}”` : ""}${span ? ` ${span}` : ""}.</div>`
      : `<div class="empty trail-empty">Your field notebook is empty.<br>
          Write down what you notice — it takes root here. Records you open with
          Listen show up here too.
          <span class="te-empty-hint muted">Tap + below to start.</span></div>`;
    return;
  }
  // FB#94: are we looking at matches rather than the whole notebook? Read from the
  // box (not the entries) so an empty-but-active search is still "searching".
  const searching = !!($("#journalSearch") && $("#journalSearch").value.trim());
  // v9: opened records can be hidden — since 2026-10-05 from ☰ › Settings, not a pill.
  const hideOpened = !showOpened();
  // A hidden open still counts toward its day's "N opened hidden" line, so nothing
  // seems to vanish — the count is written once each day's entries are done.
  let html = "", lastDay = null, hiddenInDay = 0;
  const flushHidden = () => {
    if (hiddenInDay) html += `<p class="trail-hidden-opened">${hiddenInDay} opened record${
      hiddenInDay === 1 ? "" : "s"} hidden</p>`;
    hiddenInDay = 0;
  };
  for (const e of entries) {
    const day = (e.at || "").slice(0, 10);
    if (day !== lastDay) {
      flushHidden();
      // FB#91: the machine-readable day rides along so the date rail can group by
      // month without re-parsing the localized label it shows a person.
      // FB#94: while a search is filtering the trail, the day is a DOOR — tap it to
      // step into that day in the full notebook and come back to this search. In the
      // unfiltered trail there is nowhere to step to (you are already there), so it
      // stays the plain label it has always been rather than a control that does
      // nothing.
      html += searching
        ? `<button type="button" class="trail-day is-door" data-day="${esc(day)}"
             title="Go to this day in your notebook">${esc(trailDayLabel(e.at))}</button>`
        : `<div class="trail-day" data-day="${esc(day)}">${esc(trailDayLabel(e.at))}</div>`;
      lastDay = day;
    }
    if (e.kind === "opened" && hideOpened) { hiddenInDay++; continue; }
    const entryHtml = e.kind === "note" ? trailNoteEntry(e)
      : e.kind === "opened" ? trailOpenedEntry(e) : trailChoiceEntry(e);
    // #48 (v2): no per-entry ✕ — deletion is via the opened note's Delete button, or
    // long-press → selection mode (multi-delete). The row carries its identity for
    // that mode; the check badge is a sibling of the entry button (a button can't
    // nest a button) and shows only while selecting.
    html += `<div class="trail-row" data-kind="${esc(e.kind)}" data-id="${esc(String(e.id))}">`
      + `${entryHtml}<span class="te-check" aria-hidden="true"></span></div>`;
  }
  flushHidden();
  box.innerHTML = html;
  observeArt(box);
  if (_trailSelecting) syncTrailSelectionUI();   // keep highlights across a re-render
  syncDateRail();
}

/* --- FB#94: a search result is a door back into the notebook ---------------
 * Owner, in-app feedback 2026-08-03: "it would be nice to be able to tap on the day
 * and have it bring me there to that point in my notes, and also to be able to
 * return back to this search window with the same term typed in. kind of like a
 * tangent in the search experience, but always able to return to the original
 * search."
 *
 * That is the app's own wander grammar, so it is built on the wander engine rather
 * than a bespoke back button: stepping into a day is a PULL (pushAndGo), and the
 * node it pushes carries a snapshot whose `jquery` is the term you searched. Coming
 * back — by the breadcrumb, the wander map, or the system Back button — restores the
 * term, re-runs it, and puts you back where you were in the matches, because all
 * three already route through restoreView. It is a door: your place is preserved,
 * going deeper is deliberate, and coming back is free (VISION P5).
 */
async function goToJournalDay(day, opts) {
  opts = opts || {};
  if (!day) return;
  if (currentMode() !== "journal") showMode("journal");
  const box = $("#journalSearch");
  // Step OUT of the filtered view: the day you tapped is a day in the whole
  // notebook, not a day in the matches, and landing in a still-filtered trail would
  // show you a day with most of itself missing.
  if (box && box.value) {
    box.value = "";
    refreshSearchClear(box);
    await loadTrail(true);
  } else if (!$("#trail") || !$("#trail").querySelector(".trail-day")) {
    await loadTrail(true);
  }
  // Let the trail paint before measuring where the day landed.
  await new Promise((r) => requestAnimationFrame(() => r()));
  const target = $("#trail") &&
    $("#trail").querySelector('.trail-day[data-day="' + (window.CSS && CSS.escape ? CSS.escape(day) : day) + '"]');
  if (!target) return;
  const y = target.getBoundingClientRect().top + window.scrollY - 72;
  window.scrollTo({ top: Math.max(0, y), behavior: reducedMotion() ? "auto" : "smooth" });
  // "briefly lit" — a short, quiet acknowledgement that this is the day you asked
  // for, then it settles back into the page. Not a persistent highlight: the day is
  // where you are now, not something selected.
  target.classList.remove("lit");
  void target.offsetWidth;                 // restart the animation on a re-tap
  target.classList.add("lit");
  setTimeout(() => target.classList.remove("lit"), 2000);
}

/* --- FB#91: the date rail (Variant B, "the thumb") -------------------------
 * Owner, in-app feedback 2026-08-03: "it would be cool to have a sliding thing on
 * the right that is based on date. let's mock it up" — mocked up three ways, and he
 * chose this one from the pictures on 2026-08-05.
 *
 * Nearly nothing at rest: a hairline that fades in while you scroll and out when you
 * stop. Take hold of it and the rail wakes — a notch per month, and a label naming
 * the month under your thumb.
 *
 * THE LOAD-BEARING DECISION: the track maps to TIME, one equal band per month, NOT
 * to scroll height. A scroll-proportional thumb would leak how much you wrote — a
 * month with forty notes would eat most of the track and a month with two would be a
 * sliver, which is a density heatmap drawn by the scrollbar instead of by us, and
 * `VISION.md` P4 rules that out (a notebook that scores you is one you start
 * performing for). Equal bands make the drag deliberately non-linear against the
 * content, and that is correct: it is a *date* scrubber. It also means the rail says
 * only WHERE IN TIME you are, never how much is there.
 */
let _railMonths = [];          // [{key:"2026-08", label:"August 2026", el:<first .trail-day>}]
let _railDragging = false;
let _railIdleTimer = null;
// While a keyboard jump is gliding to its target, the scroll handler would keep
// re-deriving the thumb from the CURRENT position and walk it through every month
// the animation passes over — so the label flickers and settles on whatever month
// the last scroll event happened to land in. We know the target already; ignore
// scroll-derived updates until the glide is done.
let _railSeekUntil = 0;

const _RAIL_MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

function reducedMotion() {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
  catch (e) { return false; }
}

function ensureDateRail() {
  let rail = $("#dateRail");
  if (rail) return rail;
  rail = document.createElement("div");
  rail.id = "dateRail";
  rail.className = "date-rail hidden";
  // A real slider, not decoration: arrow keys step a month, so this is reachable
  // without a pointer (ACC1). aria-valuetext carries the month NAME — a bare index
  // would be read out as a meaningless number.
  rail.setAttribute("role", "slider");
  rail.setAttribute("tabindex", "0");
  rail.setAttribute("aria-label", "Jump to a month in your notebook");
  rail.innerHTML =
    '<div class="dr-track"></div>' +
    '<div class="dr-notches"></div>' +
    '<div class="dr-thumb"></div>' +
    '<div class="dr-label" aria-hidden="true"></div>';
  document.body.appendChild(rail);
  wireDateRail(rail);
  return rail;
}

// --- rail position, as a CONTINUOUS coordinate ------------------------------
// `pos` runs 0..n across the whole rail: its whole part is the month, its
// fraction is how far through that month you are. Owner, on device 2026-08-06:
// "it feels like i am hitting page up and page down when i scroll. i want it to
// feel like i am smoothly panning through a page." Right — the first cut snapped
// to one stop per month, so a three-month notebook had exactly three positions
// and every drag was a jump.
//
// Interpolating INSIDE a band fixes that without giving up the thing the equal
// bands are for: each month still owns an identical share of the TRACK, so where
// the thumb sits still means "when," never "how much." Only the scrolling within
// a band follows the content, which is what panning is.
function railTargetY(i) {
  const m = _railMonths[i];
  if (!m || !m.el) return 0;
  return Math.max(0, m.el.getBoundingClientRect().top + window.scrollY - 72);
}
function railMaxScroll() {
  return Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
}
// Where month i's span ends in scroll space — the next month's anchor, or the
// bottom of the page for the last (oldest) one.
function railSpanEnd(i) {
  return (i + 1 < _railMonths.length) ? railTargetY(i + 1) : railMaxScroll();
}

// Current scroll → continuous rail position. The inverse of railScrollToPos, so
// the thumb tracks ordinary finger-scrolling at the same rate it drives it.
function railPosFromScroll() {
  const n = _railMonths.length;
  if (!n) return 0;
  const y = window.scrollY || window.pageYOffset || 0;
  let i = 0;
  for (let k = 0; k < n; k++) { if (railTargetY(k) <= y) i = k; else break; }
  const a = railTargetY(i), b = railSpanEnd(i);
  const t = b > a ? Math.max(0, Math.min(1, (y - a) / (b - a))) : 0;
  return i + t;
}

function railScrollToPos(pos, instant) {
  const n = _railMonths.length;
  if (!n) return;
  const i = Math.max(0, Math.min(n - 1, Math.floor(pos)));
  const t = Math.max(0, Math.min(1, pos - i));
  const a = railTargetY(i), b = railSpanEnd(i);
  const y = a + (b - a) * t;
  const smooth = !instant && !reducedMotion();
  if (smooth) _railSeekUntil = Date.now() + 1200;
  window.scrollTo({ top: Math.max(0, y), behavior: smooth ? "smooth" : "auto" });
}

function railGeometry(rail) {
  const r = rail.getBoundingClientRect();
  return { top: r.top, height: r.height };
}

function positionRailThumb(rail, pos) {
  const n = _railMonths.length;
  if (!n) return;
  const thumb = rail.querySelector(".dr-thumb");
  const label = rail.querySelector(".dr-label");
  const frac = Math.max(0, Math.min(1, pos / n));
  thumb.style.top = (frac * 100).toFixed(2) + "%";
  label.style.top = (frac * 100).toFixed(2) + "%";
  const idx = Math.max(0, Math.min(n - 1, Math.floor(pos)));
  const m = _railMonths[idx];
  if (m) {
    label.innerHTML = '<span class="m">' + esc(m.month) + '</span>' +
      '<span class="y">' + esc(m.year) + "</span>";
    rail.setAttribute("aria-valuenow", String(n - 1 - idx));   // ascending = older→newer
    rail.setAttribute("aria-valuetext", m.label);
  }
}

function showRailBriefly(rail) {
  if (_railDragging) return;
  rail.classList.add("awake");
  clearTimeout(_railIdleTimer);
  _railIdleTimer = setTimeout(() => {
    if (!_railDragging) rail.classList.remove("awake");
  }, 1400);
}

function wireDateRail(rail) {
  const posFromPointer = (clientY) => {
    const g = railGeometry(rail);
    if (g.height <= 0) return 0;
    const n = _railMonths.length;
    return Math.max(0, Math.min(n, ((clientY - g.top) / g.height) * n));
  };
  const move = (clientY) => {
    const pos = posFromPointer(clientY);
    positionRailThumb(rail, pos);
    railScrollToPos(pos, true);          // instant: the page tracks your thumb
  };
  // THE GRAB HANDLE IS THE THUMB, NOT THE COLUMN. The first cut listened on the
  // whole 44px rail with `touch-action: none`, which is pinned to the right edge —
  // exactly where a right-handed thumb swipes to scroll. So an ordinary scroll
  // gesture near that edge got swallowed and turned into month-to-month jumps: the
  // "page up / page down" the owner hit on his phone. It never showed up on the Mac,
  // where scrolling is a wheel and the pointer is nowhere near the edge.
  //
  // Now the rail itself is inert (pointer-events: none) and only the thumb takes a
  // pointer, with a generous invisible hit box around it for the 44px target. Every
  // other touch — including a swipe straight down the right edge — passes through to
  // the page untouched. It also means the trail no longer has to reserve a gutter.
  const thumb = rail.querySelector(".dr-thumb");
  thumb.addEventListener("pointerdown", (e) => {
    if (!_railMonths.length) return;
    _railDragging = true;
    rail.classList.add("awake", "live");
    try { thumb.setPointerCapture(e.pointerId); } catch (err) {}
    // Deliberately do NOT jump to the press point: you grabbed the thumb where it
    // already is, so the page shouldn't lurch before you've moved. Panning starts
    // from here, on the first move.
    e.preventDefault();
    e.stopPropagation();
  });
  thumb.addEventListener("pointermove", (e) => {
    if (!_railDragging) return;
    move(e.clientY);
    e.preventDefault();
  });
  const end = () => {
    if (!_railDragging) return;
    _railDragging = false;
    rail.classList.remove("live");
    showRailBriefly(rail);
  };
  thumb.addEventListener("pointerup", end);
  thumb.addEventListener("pointercancel", end);
  rail.addEventListener("keydown", (e) => {
    if (!_railMonths.length) return;
    // Down/right = further back in time (the trail is newest-first), matching the
    // direction the thumb travels.
    const step = (e.key === "ArrowDown" || e.key === "ArrowRight") ? 1
      : (e.key === "ArrowUp" || e.key === "ArrowLeft") ? -1
      : (e.key === "Home") ? -_railMonths.length
      : (e.key === "End") ? _railMonths.length : 0;
    if (!step) return;
    e.preventDefault();
    // Keyboard steps stay WHOLE months — a key press is a discrete act, and gliding
    // to the start of a month is the useful thing it can do.
    const cur = Math.floor(railPosFromScroll());
    const idx = Math.max(0, Math.min(_railMonths.length - 1, cur + step));
    rail.classList.add("awake", "live");
    positionRailThumb(rail, idx);
    railScrollToPos(idx);
    showRailBriefly(rail);
  });
  rail.addEventListener("blur", () => rail.classList.remove("live"));
}

// Rebuild from what the trail is actually showing, and decide whether the rail earns
// its place at all. Called after every renderTrail.
function syncDateRail() {
  const rail = ensureDateRail();
  const box = $("#trail");
  const searching = !!($("#journalSearch") && $("#journalSearch").value.trim());
  // Hidden unless it's genuinely useful:
  //  * only on the Notebook (Explore has no dated trail),
  //  * never while a search filters the stream — the trail is MATCHES then, and a
  //    date rail over it would be scrubbing something it isn't describing,
  //  * not on a notebook that fits on a screen or two, where flicking is easier,
  //  * and never for a single month, which is a rail with one stop.
  if (!box || currentMode() !== "journal" || searching) {
    rail.classList.add("hidden");
    _railMonths = [];
    return;
  }
  const days = [...box.querySelectorAll(".trail-day[data-day]")];
  const months = [];
  for (const el of days) {
    const key = (el.dataset.day || "").slice(0, 7);
    if (!key || months.some((m) => m.key === key)) continue;
    const mi = parseInt(key.slice(5, 7), 10) - 1;
    months.push({
      key, el,
      month: _RAIL_MONTHS[mi] || "",
      year: key.slice(0, 4),
      label: (_RAIL_MONTHS[mi] || "") + " " + key.slice(0, 4),
    });
  }
  const tallEnough =
    document.documentElement.scrollHeight > window.innerHeight * 1.5;
  if (months.length < 2 || !tallEnough) {
    rail.classList.add("hidden");
    _railMonths = [];
    return;
  }
  _railMonths = months;
  rail.setAttribute("aria-valuemin", "0");
  rail.setAttribute("aria-valuemax", String(months.length - 1));
  // One notch per month, evenly spaced — same size whatever that month holds.
  rail.querySelector(".dr-notches").innerHTML = months.map((m, i) =>
    '<span class="dr-notch" style="top:' +
    (((i + 0.5) / months.length) * 100).toFixed(2) + '%"></span>').join("");
  rail.classList.remove("hidden");
  positionRailThumb(rail, railPosFromScroll());
}

// The thumb follows ordinary scrolling too, so it always says where you are.
function onScrollSyncRail() {
  const rail = $("#dateRail");
  if (!rail || rail.classList.contains("hidden") || _railDragging) return;
  if (Date.now() < _railSeekUntil) { showRailBriefly(rail); return; }
  positionRailThumb(rail, railPosFromScroll());
  showRailBriefly(rail);
}

// Tap a note entry → open it to read/edit (free or record-anchored). Tap a choice
// entry → open its chosen record's details (handled by the delegated click below).
function openTrailNote(el) {
  const n = _trailNotesById[el.dataset.noteId];
  if (!n) return;
  openNoteModal(el.dataset.uid || null, n);
}

// --- STORY DOOR (U3): threads to pull + your own notes ----------------------
// Principle 1 (VISION.md): story over metadata. A card is a minimal surface;
// this is the door behind it, opened only when you reach for it. Outward threads
// (artist / label / genre) are catalog pulls; the inward thread is your own
// notes, loaded lazily. Nothing here is auto-expanded or surfaced unbidden.
let storyRid = null;
// FB#37: {uid, pos} of an Explore song hit to flash once its album's tracklist paints.
let _songHitFlash = null;

function threadBtn(field, term, label) {
  return `<button class="nc-chip story-thread" data-field="${esc(field)}"
    data-term="${esc(term)}" title="Pull this thread through the catalog"
    >${esc(label)}</button>`;
}

// --- YOUR NOTES door (N1 Step 1): the inward door — your words for one album ---
// Split out of the story door so "Album details" holds the record's own words and
// this holds yours. Opened from a card's "✎ Your notes", a Remember shelf card, or
// the Remember door. A plain modal (open → read/write → close), not a wander door.
let yourNotesRid = null;
let yourNotesData = [];   // the open album's notes, for the delegated edit button
// One-shot: glow the notes when you arrive from a Remember note card, so your own
// words are the first thing you notice.
let _yourNotesArrived = false;

function renderYourNotes(notes, choices) {
  yourNotesData = notes || [];
  const arrived = _yourNotesArrived;       // consume the one-shot flag
  _yourNotesArrived = false;
  const el = $("#yourNotes");
  if (!el) return;
  // One body of writing per record (N1 §4.1): your notes + the reasons you gave
  // when you chose it, merged newest-first and labeled by occasion. A choice
  // reason is read-only here — it belongs to its choice (edit from the Choices tab).
  const items = [
    ...(notes || []).map((n) => ({ k: "note", t: n.created_at, v: n })),
    ...(choices || []).map((c) => ({ k: "choice", t: c.chosen_at, v: c })),
  ].sort((a, b) => String(b.t || "").localeCompare(String(a.t || "")));
  if (!items.length) {
    el.innerHTML = `<p class="muted">No notes yet — this is where your own
      thread starts. Add one and it becomes yours.</p>`;
    return;
  }
  el.innerHTML = items.map((it) =>
    it.k === "note" ? noteItemHtml(it.v) : choiceReasonHtml(it.v)).join("");
  if (arrived) {
    const sec = el.closest(".story-section");
    if (sec) { sec.classList.remove("note-arrived"); void sec.offsetWidth; sec.classList.add("note-arrived"); }
  }
}

// --- FB#89: your notes, inside the record ------------------------------------
// The same body of writing the Your notes door shows, rendered into Album details so
// you meet your own words on the record they're about. Reuses noteItemHtml /
// choiceReasonHtml verbatim — one way of drawing a note, so edit, delete and the
// in-note word pull behave identically wherever it appears.
//
// Deliberately silent when you've written nothing: a record you're meeting for the
// first time shows no empty "no notes yet" scaffold (that prompt belongs in the door
// you opened ON PURPOSE to write, not on a record you're still deciding about).
let _storyNotesData = [];

function renderStoryNotes(uid, notes, choices) {
  const sec = $("#storyNotesSec"), box = $("#storyNotes");
  if (!sec || !box) return;
  _storyNotesData = notes || [];
  const items = [
    ...(notes || []).map((n) => ({ k: "note", t: n.created_at, v: n })),
    ...(choices || []).map((c) => ({ k: "choice", t: c.chosen_at, v: c })),
  ].sort((a, b) => String(b.t || "").localeCompare(String(a.t || "")));
  const det = $("#storyNotesBox"), count = $("#storyNotesCount");
  if (!items.length) {
    sec.classList.add("hidden");
    sec.dataset.notesFor = "";
    box.innerHTML = "";
    if (det) det.open = false;
    return;
  }
  sec.dataset.notesFor = uid;          // the edit delegate reads the record from here
  box.innerHTML = items.map((it) =>
    it.k === "note" ? noteItemHtml(it.v) : choiceReasonHtml(it.v)).join("");
  if (count) count.textContent = String(items.length);
  sec.classList.remove("hidden");
}

// Pull this record's notes when its door opens. Silent on failure — an unreachable
// journal must not put an error inside Album details, which is about the record, not
// about your writing; the Notebook is where a load failure is worth reporting (FB#107).
async function fetchStoryNotes(uid) {
  const sec = $("#storyNotesSec"), det = $("#storyNotesBox");
  // A DIFFERENT record starts collapsed and blank; a refresh of the SAME record keeps
  // both what's on screen and whether you had it open. This runs on every write too
  // (refreshJournalAndModal), so closing or blanking unconditionally would slam the
  // list shut — and flash it — every time you saved an edit from inside it.
  const changed = !sec || sec.dataset.notesFor !== uid;
  if (changed) {
    if (sec) { sec.classList.add("hidden"); sec.dataset.notesFor = ""; }
    if (det) det.open = false;
    _storyNotesData = [];
  }
  if (!uid) return;
  try {
    const data = await readJournal(`/api/journal/album/${encodeURIComponent(uid)}`);
    if (storyRid === uid) renderStoryNotes(uid, data.notes || [], data.choices || []);
  } catch (e) { /* the section simply stays hidden */ }
}

function noteItemHtml(n) {
  // FB#89: a note tied to a SONG says which song. Without this, an album note and a
  // song note on the same record are indistinguishable in the list — which matters now
  // that a record's section carries both (and matters more since FB#106a made tagging
  // a song a one-tap thing). The name comes from the v8 `ref` snapshot, not the legacy
  // free-text `track` field, which typed notes never set; both are rendered, since an
  // older note may still carry the free-text one.
  const songTag = (n.ref && n.ref.kind === "track" && n.ref.title)
    ? ` <span class="jtag jtag-song">♪ ${esc(n.ref.title)}</span>` : "";
  return `
    <div class="jitem">
      <div class="jnote">${renderMarkdown(n.body)}${songTag}${
        n.track ? ` <span class="jtag">track ${esc(n.track)}</span>` : ""}${
        n.timestamp ? ` <span class="jtag">@ ${esc(n.timestamp)}</span>` : ""}</div>
      <div class="jlinks">
        <span class="jdate">${esc((n.created_at || "").slice(0, 10))}${
          n.updated_at && n.updated_at !== n.created_at ? " · edited" : ""}</span>
        <button class="jedit" data-note="${n.id}">edit</button>
        <button class="jdel" data-note="${n.id}">delete</button>
      </div>
      <!-- N1 §4.4 (3b)'s "threads from this note" is GONE (owner, 2026-08-06:
           "there should be NO mention of any threads in the notes. this is
           unacceptable"). It mined the words you wrote, ranked the ones recurring
           across your other notes, and handed them back as links — which is what
           VISION.md P2 forbids in as many words: what you write is "not mined, not
           tagged, not built into a picture of you." The record's OWN story stays a
           thread you can pull; your writing is not raw material. -->
    </div>`;
}

// A choice-reason folded into your words for this record (N1 §4.1). Read-only here
// — it belongs to its choice; edit it from the Choices tab.
function choiceReasonHtml(c) {
  const other = [c.not_chosen_artist, c.not_chosen_title].filter(Boolean).join(" — ");
  const tags = (c.reasons || []).map((r) => `<span class="rchip">${esc(r)}</span>`).join("");
  const body = c.note ? renderMarkdown(c.note) : "";
  return `
    <div class="jitem jitem-choice">
      <div class="jnote">${body}${tags ? `<span class="choice-reasons">${tags}</span>` : ""}</div>
      <div class="jlinks">
        <span class="jtag jtag-occasion">↳ chosen${other ? " over " + esc(other) : ""}</span>
        <span class="jdate">${esc((c.chosen_at || "").slice(0, 10))}</span>
      </div>
    </div>`;
}

// The in-note word pull (threadsBox / toggleNoteThreads / pullTermNotes) was deleted
// here on 2026-08-06 — see noteItemHtml above. Its server routes and store functions
// went with it, so nothing is left that reads your notes to build links between them.

async function fetchYourNotes(rid) {
  try {
    const data = await (await fetch(
      `/api/journal/album/${encodeURIComponent(rid)}`)).json();
    if (yourNotesRid === rid) renderYourNotes(data.notes || [], data.choices || []);
  } catch (e) {
    if (yourNotesRid === rid) $("#yourNotes").innerHTML =
      `<p class="muted">Couldn't load your notes.</p>`;
  }
}

// Open the Your notes door for an album (by uid). `opts.compose` pops the composer
// straight away — the Remember-door "write about this" path.
function openYourNotes(rid, opts = {}) {
  const info = albumIndex[rid] || {};
  const names = rememberNames(rid, info.artist, info.title);
  yourNotesRid = rid;
  $("#yourNotesHead").innerHTML =
    `<p class="story-kicker">${stoneGlyph()}Your notes</p>
     <h3>${esc(names.artist || "")}${names.artist && names.title ? " — " : ""}<b>${esc(names.title || "")}</b></h3>
     <button class="pull-link ynotes-details" data-rid="${esc(rid)}"
       title="The record's own story — threads, the room, the bio">Album details →</button>`;
  $("#yourNotes").innerHTML = `<p class="muted">Loading your notes…</p>`;
  $("#yourNotesModal").classList.remove("hidden");
  fetchYourNotes(rid);
  if (opts.compose) openNoteModal(rid);
}

function closeYourNotes() {
  $("#yourNotesModal").classList.add("hidden");
  yourNotesRid = null;
}

// --- THE ROOM (F27/F28): release-level personnel inside Go deeper ------------
// A record is a room full of people, and you can follow any one of them
// outward. For a Discogs album: everyone the sleeve names, in sleeve order,
// each role QUOTED as printed — never a normalized vocabulary, never "she is
// a bassist" (VISION P2). For an MB-only album (F28): the credits as
// MusicBrainz lists them — typed relations, not sleeve quotes — and the hint
// line says so (the source label is the honesty rule applied to vocabulary).
// A credit with a stable Discogs id is a door (the person panel below; MB
// credits arrive crosswalked via Wikidata); an unlinked credit is plain text,
// never a door. Fetched when the door opens; the section stays hidden when
// nothing is on file — a catalog predating either ingest — because that's
// *unknown*, not "nobody was in the room".
let storyRoomData = [];         // the open album's credits (for "show all N")
const ROOM_PREVIEW = 12;        // rooms are mostly 1–5 people; 40+ is rare

function creditLine(cr) {
  const role = cr.role ? `<span class="credit-role">${esc(cr.role)}</span> — ` : "";
  // A linked credit is a door (→ that person's records) AND a note-anchor: its
  // pencil / a right-click ties a note to the person. `data-pid` carries the DOOR ID
  // — a Discogs person_id, or (N4a) 'mbid:<uuid>' for an MB-only person the crosswalk
  // doesn't reach. Either way the note uid is 'per:'+doorId. A credit with neither id
  // has no stable identity, so it stays plain text — no door, no note.
  const doorId = cr.person_id ? String(cr.person_id)
    : (cr.mbid ? "mbid:" + cr.mbid : null);
  if (doorId) {
    return `<div class="credit-line note-anchor" data-note-kind="person"
      data-pid="${esc(doorId)}" data-name="${esc(cr.name)}">${role}<button
        class="credit-door" data-pid="${esc(doorId)}" data-name="${esc(cr.name)}"
        title="Every record we have ${esc(cr.name)} credited on">${esc(cr.name)}</button>${
      notePen(cr.name)}</div>`;
  }
  return `<div class="credit-line">${role}<span class="credit-name">${esc(cr.name)}</span></div>`;
}

function renderStoryRoom(credits, showAll) {
  const sec = $("#storyRoomSec");
  if (!credits.length) { sec.classList.add("hidden"); return; }
  // The whole room shows by default; only a genuinely big room truncates (and
  // never by just a person or two — that'd hide less than the button costs).
  const whole = showAll || credits.length <= ROOM_PREVIEW + 3;
  const shown = whole ? credits : credits.slice(0, ROOM_PREVIEW);
  $("#storyRoom").innerHTML = shown.map(creditLine).join("") + (whole ? "" :
    `<button class="ghost room-all">Show all ${credits.length} people</button>`);
  sec.classList.remove("hidden");
}

async function fetchStoryRoom(uid) {
  try {
    const data = await (await fetch(
      `/api/album/${encodeURIComponent(uid)}/credits`)).json();
    if (storyRid !== uid) return;           // modal moved on under us
    storyRoomData = data.credits || [];
    // F28: name the vocabulary's source honestly — sleeve quotes vs
    // MusicBrainz's typed relations are different claims about the record.
    $("#storyRoomHint").textContent = data.source === "musicbrainz"
      ? "The credits as MusicBrainz lists them. A linked name is a door — "
        + "follow anyone outward."
      : "The credits as the sleeve lists them. A linked name is a door — "
        + "follow anyone outward.";
    renderStoryRoom(storyRoomData);
    promoteComposerThreads(storyRoomData);   // FB#46: composer(s) up into the threads
  } catch (e) { /* offline: the room simply stays hidden */ }
}

// FB#46: a composer deserves top billing. When the credits name one (or a couple),
// promote them out of "the room" into THREADS TO PULL as their own person-door +
// note-anchor — precise (a person_id door, role-aware), not a guess at splitting the
// compound headline credit. Fires only when a linked composer credit exists, so an
// ordinary album (no composer role) is untouched.
const _COMPOSER_ROLE = /compos|written|writer|songwrit/i;
function promoteComposerThreads(credits) {
  const box = $("#storyThreads");
  if (!box) return;
  const seen = new Set();
  const composers = [];
  for (const cr of credits || []) {
    if (!cr.person_id || !_COMPOSER_ROLE.test(cr.role || "")) continue;
    const key = String(cr.person_id);
    if (seen.has(key)) continue;
    seen.add(key);
    composers.push(cr);
    if (composers.length >= 3) break;          // a few leads, never a wall of names
  }
  if (!composers.length) return;
  const chips = composers.map((cr) =>
    `<span class="note-anchor thread-anchor" data-note-kind="person"
       data-pid="${esc(cr.person_id)}" data-name="${esc(cr.name)}"><button
       class="nc-chip story-thread pull-composer" data-pid="${esc(cr.person_id)}"
       data-name="${esc(cr.name)}"
       title="Every record we have ${esc(cr.name)} credited on"
       >More from ${esc(cr.name)}</button>${notePen(cr.name)}</span>`).join("");
  box.insertAdjacentHTML("afterbegin", chips);   // composer leads the threads
}

// Feedback #23 (2026-07-07): the tracklist in the story door. Fetched on open from
// the existing /tracks endpoint (Discogs-ingested); hidden when there's none on file
// (an MB-only album has no Discogs id, so no tracks yet — the section just stays out).
async function fetchStoryTracks(uid) {
  try {
    // FB#106c: through the shared cache, so opening the door also warms the composer's
    // pills (and a composer that already asked doesn't make the door ask again).
    const tracks = await ensureAlbumTracks(uid);
    if (storyRid !== uid) return;              // modal moved on under us
    renderStoryTracks(tracks || []);
  } catch (e) { /* offline: the tracklist stays hidden */ }
}

function renderStoryTracks(tracks) {
  const sec = $("#storyTracksSec");
  if (!tracks.length) { sec.classList.add("hidden"); return; }
  // Positions ride from the sleeve (A1, B2, 3…), so show them verbatim rather than
  // auto-number — a vinyl side is not "track 1".
  // A track is a note-anchor only when it has a position — that's what makes a
  // stable trk:<album_uid>#<pos> uid; a track with no pos renders plain (no pencil).
  $("#storyTracks").innerHTML = tracks.map((t) => {
    const notable = !!t.pos;
    const anchor = notable
      ? ` note-anchor" data-note-kind="track" data-pos="${esc(t.pos)}" data-title="${esc(t.title || "")}`
      : "";
    return `
    <div class="track-row${anchor}">
      ${t.pos ? `<span class="track-pos muted">${esc(t.pos)}</span>` : ""}
      <span class="track-title">${esc(t.title || "")}</span>
      ${t.dur ? `<span class="track-dur muted">${esc(t.dur)}</span>` : ""}
      ${notable ? notePen(t.title || "this song") : ""}
    </div>`;
  }).join("");
  sec.classList.remove("hidden");
  flashSongHitTrack();
}

// FB#37: when Album details opened from an Explore song hit, scroll the matched
// track into view and glow it briefly, so you land on the exact song you searched.
function flashSongHitTrack() {
  if (!_songHitFlash || _songHitFlash.uid !== storyRid) return;
  const pos = _songHitFlash.pos;
  _songHitFlash = null;
  const row = [...$("#storyTracks").querySelectorAll(".track-row")]
    .find((r) => r.dataset.pos === pos);
  if (!row) return;
  row.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
  row.classList.add("song-flash");
  setTimeout(() => row.classList.remove("song-flash"), 1600);
}

// --- OTHER RELEASES (F27-1b): the album's pressings as a lineage door --------
// One door, two story threads: the pressings themselves (each sleeve carries
// its own room — the reason an album's credits can differ pressing to
// pressing), and the label column reading as the licensing/territory lineage
// (A7: ABC → MCA → Geffen is a story you can see). Collapsed by default
// (progressive disclosure: the count is the door, the list is behind it);
// hidden entirely when this pressing is the only one on file. Bounded by what
// we ingested — "on file", never a completeness claim.
let storyPressData = [];        // the open album's pressings (for expand)

function pressingRow(p) {
  const meta = [p.released, p.country, p.label, p.formats]
    .filter(Boolean).map(esc).join(" · ");
  const room = p.room ? ` <span class="press-room">· room of ${p.room}</span>` : "";
  if (p.current) {
    return `<div class="press-row current">${meta}${room}
      <span class="press-here">— this one</span></div>`;
  }
  return `<button class="press-row" data-press-rid="${p.release_id}"
    title="Open this pressing — its own sleeve, its own room">${meta}${room}</button>`;
}

function renderStoryPressings(pressings, expanded) {
  const sec = $("#storyPressSec");
  const others = pressings.filter((p) => !p.current).length;
  if (others < 1) { sec.classList.add("hidden"); return; }
  if (!expanded) {
    const years = pressings.map((p) => p.year).filter(Boolean);
    const span = years.length
      ? `, ${Math.min(...years)}–${Math.max(...years)}` : "";
    $("#storyPressings").innerHTML =
      `<button class="ghost press-open">${others} other release${
        others !== 1 ? "s" : ""} on file${span} ▸</button>`;
  } else {
    $("#storyPressings").innerHTML = pressings.map(pressingRow).join("");
  }
  sec.classList.remove("hidden");
}

async function fetchStoryPressings(uid) {
  try {
    const data = await (await fetch(
      `/api/album/${encodeURIComponent(uid)}/pressings`)).json();
    if (storyRid !== uid) return;           // modal moved on under us
    storyPressData = data.pressings || [];
    renderStoryPressings(storyPressData, false);
  } catch (e) { /* offline: the door simply stays hidden */ }
}

// Open any album by uid, teaching albumData first if this session hasn't seen
// it (a non-canonical pressing has no card anywhere — the lineage door is how
// it's reached at all).
async function openAlbumByUid(uid) {
  // Re-resolve when the album is missing OR cached as a NAME-LESS snapshot — a
  // journal row can arrive with a lost artist/title (feedback #15), and a fold-
  // orphaned uid (B22) only gains its name/cover from the server's /api/albums
  // resolver (shared resolveAlbums). Without this the story door reads the stale
  // nameless cache and shows "Unknown album" even though /api/albums resolves it.
  const cached = albumData[uid];
  if (!cached || (!cached.artist && !cached.title)) {
    const got = await resolveAlbums([uid]);  // caches into albumData/albumIndex on hit
    if (!got[uid] && !cached) return;        // nothing resolved and nothing to fall back on
  }
  openStoryModal(uid);
}

// Share something so someone else can find it on Music Forest (owner ask, 2026-07-17;
// broadened to any entity for feedback #80: "share anyone — designer, composer, etc.").
// A user-initiated, outward door (VISION P2): you reach for it; the link opens the
// recipient onto this exact record / artist / person / label (openDeepLink reads the
// param on boot). Native share sheet where the platform offers one, else copy the link.
// No tracking, no attribution tag — just a plain link.
async function shareLink(url, title, copiedMsg) {
  if (navigator.share) {
    try { await navigator.share({ title, text: title + " — on Music Forest", url }); return; }
    catch (e) { if (e && e.name === "AbortError") return; }   // cancelled; don't also copy
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast(copiedMsg);
  } catch (e) {
    showToast("Couldn't copy the link automatically — it's " + url);
  }
}
async function shareAlbum(a) {
  if (!a) return;
  const key = albumKey(a);
  if (!key) return;
  await shareLink(location.origin + "/?album=" + encodeURIComponent(key),
    `${a.artist} — ${a.title}`,
    "Link copied — send it so a friend can find this record");
}
async function shareArtist(name) {
  name = (name || "").trim();
  if (!name) return;
  await shareLink(location.origin + "/?artist=" + encodeURIComponent(name),
    name, "Link copied — send it so a friend can find this artist");
}
async function shareLabel(name) {
  name = (name || "").trim();
  if (!name) return;
  await shareLink(location.origin + "/?label=" + encodeURIComponent(name),
    name, "Link copied — send it so a friend can find this label");
}
async function sharePerson(pid, name) {
  if (pid == null || pid === "") return;
  // The person door needs the id (identity) AND the name (display before the fetch
  // resolves it) — mirrors openPersonPanel(pid, name).
  const q = "person=" + encodeURIComponent(pid) +
    (name ? "&name=" + encodeURIComponent(name) : "");
  await shareLink(location.origin + "/?" + q, name || "This credit",
    "Link copied — send it so a friend can find them");
}

// The Share button for an entity door head — mirrors the record's story-share button
// (reuses .story-share), so every door shares the same way.
function shareBtnHtml(attr, what) {
  return `<button type="button" class="story-share" ${attr}
     aria-label="Share ${what} so someone can find them on Music Forest"><span
     class="ss-i" aria-hidden="true">↗</span> Share</button>`;
}

// FB#96 ("how can we test for various devices?"): the notch/island insets come from
// env(safe-area-inset-*), which is 0 on every desktop browser — so a layout that
// breaks under a tall Dynamic Island looks perfect on the machine we build on, and
// the only way to find out was a friend's phone. `?insets=top,right,bottom,left`
// (px) overrides the four vars for one session, so device emulation at 402×874 can
// be given an iPhone's real reserved space and the safe-area code paths are
// actually exercised. Read once at boot; nothing persists.
//
// Measured values worth reusing (CSS px, portrait, standalone):
//   iPhone 17 / 16 Pro   ?insets=62,0,34,0
//   iPhone SE (no notch) ?insets=20,0,0,0
//   Pixel 8              ?insets=48,0,24,0
function applyInsetOverride() {
  let raw;
  try { raw = new URLSearchParams(location.search).get("insets"); } catch (e) { return; }
  if (!raw) return;
  const n = raw.split(",").map((v) => parseFloat(v.trim()));
  if (!n.length || n.some((v) => !isFinite(v) || v < 0)) return;
  const [top = 0, right = 0, bottom = 0, left = 0] = n;
  const r = document.documentElement.style;
  r.setProperty("--safe-top", top + "px");
  r.setProperty("--safe-right", right + "px");
  r.setProperty("--safe-bottom", bottom + "px");
  r.setProperty("--safe-left", left + "px");
  console.info(`safe-area override: ${top}/${right}/${bottom}/${left}px`);
}

// FB#97: the About door (why this exists · how the day is put together · where the
// data comes from). Opened from the ☰ menu's "About" in both the guest and signed-in
// menus, so auth-ui reaches for these rather than poking at classList itself.
function openAboutDoor() { $("#dataModal").classList.remove("hidden"); }
function closeAboutDoor() { $("#dataModal").classList.add("hidden"); }

// A shared link lands as origin/?album|artist|person|label=…; on boot, open that
// entity's door over the default view (a door — closing returns you to Today/Explore).
// The URL is cleaned first so a refresh doesn't reopen it and the address bar stays tidy.
async function openDeepLink() {
  let p;
  try { p = new URLSearchParams(location.search); } catch (e) { return; }
  const album = p.get("album"), artist = p.get("artist"),
        person = p.get("person"), label = p.get("label");
  if (!album && !artist && !person && !label) return;
  try { history.replaceState(history.state, "", location.origin + "/"); } catch (e) { /* ok */ }
  try {
    if (album) await openAlbumByUid(album);
    else if (artist) openArtistPanel(artist);
    else if (person) openPersonPanel(person, p.get("name") || "");
    else if (label) AOTDLabelPanel.open(label);
  } catch (e) { /* a stale/unknown target just no-ops */ }
}

// When we have no bio to show, the door shouldn't dead-end (owner, 2026-07-03):
// hand over the artist's name as a one-tap copy so you can paste it into a
// search engine and keep pulling the thread yourself. Reuses the .copy-search
// component (wired globally by wireCopySearch).
function noBioHtml(name) {
  return `<p class="muted">No short bio on file for ${esc(name)}.</p>
    <button class="copy-search bio-copy" data-q="${esc(name)}">
      <i class="csi" aria-hidden="true">⧉</i>
      <span class="cs-label">Copy “${esc(name)}” to search the web</span>
    </button>`;
}

// A4: an optional artist bio — an outward story thread, kept behind its own
// door so the story view stays a minimal surface (Principle 1: story as threads
// to pull, never a wall of text). Nothing is fetched until you open it.
function resetStoryBio() {
  $("#storyBio").innerHTML =
    `<button class="ghost story-bio-open">Read a short bio ▸</button>`;
}

async function loadStoryBio() {
  const rid = storyRid;
  const a = albumData[rid];
  if (!a) return;
  const wrap = $("#storyBio");
  wrap.innerHTML = `<p class="muted">Looking for a bio…</p>`;
  try {
    const data = await (await fetch(
      `/api/artist/bio?name=${encodeURIComponent(a.artist)}`)).json();
    if (storyRid !== rid) return;            // modal moved on under us
    if (data.status === "ok" && data.extract) {
      wrap.innerHTML =
        `<p class="bio-extract">${esc(data.extract)}</p>
         <p class="bio-cite muted">Summary from <a href="${esc(data.url)}"
           target="_blank" rel="noopener">Wikipedia</a> · CC BY-SA</p>`;
    } else {
      wrap.innerHTML = noBioHtml(a.artist);
    }
  } catch (e) {
    if (storyRid === rid) wrap.innerHTML =
      `<p class="muted">Couldn't load a bio just now.</p>`;
  }
}

// B16/B17: lead the album's detail view with its cover and the same ♫ Listen
// door (+ Discogs) as the card it opened from. Factored out so the lazy door can
// re-render the head (cover + Listen row) once it resolves an MB-only album.
function renderStoryHead(a) {
  // F#10: an opened album leads with listening here too — the same prioritised
  // listen block as the pick (primary "Listen on ___" + chips, or the honest
  // spinner / copy-search states), not a collapsed door. Source (provenance) sits
  // just beneath as a quiet thread — this is where it lives now that the pick
  // folded it into Go deeper.
  // FB#105 (owner, on-device 2026-08-04): "Keep/Skip/Write a note are kind of
  // buried." They were — 7th and 8th in reading order, behind a wall of links to
  // other companies. The head was ordered by what we HAVE rather than what you'd DO.
  // Three changes, all here:
  //   1. The identity block IS the copy control now ("the copy button could be
  //      replaced by a rectangle around the album/artist/date title with a copy
  //      symbol in it? since that info is already on the page"), so the separate
  //      Copy row is gone rather than merely moved.
  //   2. Everything past your top platform folds behind one door (listenBlockHtml),
  //      carrying its count so the confirmed links are still declared — the honesty
  //      rule survives the tidy-up.
  //   3. Share and the provenance line leave the head entirely: Share drops below
  //      the acts, and "Album details from Discogs" becomes a thread (it was always
  //      a door out, wearing an explanatory label that read as neither).
  // Net: the acts move from 7th/8th to 3rd/4th, and the head loses two rows.
  const copyQ = `${a.artist || ""} ${a.title || ""}`.trim();
  const meta = esc([a.released, a.country].filter(Boolean).join(" · "));
  const ident =
    `<h3>${esc(a.artist)} — ${esc(a.title)}</h3>
     <!-- FB#98 (owner): "the date can be bigger". The release date is the whole
          premise of the app — this record came out on this day — and it was set
          in the same faint 13px as a caption. Its own class now, sized up. -->
     <p class="story-date">${meta}</p>`;
  // The whole identity becomes one copy target when there's something to copy;
  // otherwise it stays plain text rather than offering a button that copies "".
  const identBlock = copyQ
    ? `<button type="button" class="story-ident copy-search" data-q="${esc(copyQ)}"
         title="Copy “${esc(a.artist)} — ${esc(a.title)}”"
         aria-label="Copy ${esc(a.artist)} — ${esc(a.title)} to paste elsewhere"
       >${ident}<span class="si-copy" aria-hidden="true">⧉</span></button>`
    : `<div class="story-ident">${ident}</div>`;
  $("#storyHead").innerHTML =
    `<p class="story-kicker">${stoneGlyph()}Album details</p>
     <div class="story-head-row">
       ${coverHtml(a)}
       <div class="story-head-text">
         ${identBlock}
         ${listenBlockHtml(a)}
       </div>
     </div>`;
  observeArt($("#storyHead"), { eager: 1 });
}

function openStoryModal(rid, opts = {}) {
  const a = albumData[rid];
  if (!a) return;
  if (!opts.noPush) {
    return pushAndGo(`“${a.title}”`, { t: "story", rid: rid },
      () => openStoryModal(rid, { noPush: true }));
  }
  closeArtistPanel(); AOTDLabelPanel.close(); closePersonPanel();  // one door at a time
  storyRid = rid;
  // Spinner while the confirmed door resolves (a pool album); fillDoorOnOpen
  // clears it once the door settles, so the listen block lands on either the real
  // button or the honest copy-search — never a premature "no link".
  a._doorPending = poolOn() && !a._doorFilled;
  renderStoryHead(a);
  renderStoryDeckActions(rid);                // request 1: Keep / Set aside when this
                                              // is the current Today record
  fetchStoryNotes(rid);                       // FB#89: your own words on this record
  fillDoorOnOpen(rid);                        // P3: lazily resolve MB-only art+links
  // Outward threads: the artist, the label, each genre, and the decade — doors
  // to wander (A3 adds label/genre/decade alongside the original artist pull).
  // The artist thread is a door (→ their catalog) AND a note-anchor (v8 art:<name>);
  // the label / genre / decade threads are catalog filters, not someone in the room,
  // so they carry no pencil (v1 scope).
  // FB#63: one thread per artist in the credit (splitArtistCredit collapses to a
  // single name for an ordinary album, so this only fans out a compound credit like
  // "Beethoven, Schubert; Wiener Philharmoniker, Karl Böhm"). Each is a door (→ their
  // catalog) AND a note-anchor (v8 art:<name>).
  const artistThreads = splitArtistCredit(a.artist).map((name) =>
    `<span class="note-anchor thread-anchor" data-note-kind="artist"
        data-name="${esc(name)}">${
        threadBtn("artist", name, `More from ${name}`)}${notePen(name)}</span>`);
  const threads = artistThreads.length ? artistThreads : [];
  if (a.label) threads.push(threadBtn("label", a.label, a.label));
  genresOf(a).forEach((g) => threads.push(threadBtn("genres", g, g)));
  const dec = decadeOf(a);
  if (dec) threads.push(`<button class="nc-chip pull-decade"
    data-decade="${esc(dec)}" title="Browse the ${esc(dec)} across the catalog"
    >${esc(dec)}</button>`);
  // FB#57b: the finer *styles* beyond the coarse genres — a "dig deeper" set of
  // threads (dashed chips), each pulling other records tagged that exact style
  // (field=styles, now an allowed FTS scope). Only shown when the record has any.
  stylesOf(a).slice(0, 8).forEach((st) => threads.push(
    `<button class="nc-chip story-thread pull-style" data-field="styles"
      data-term="${esc(st)}" title="Dig deeper — other records tagged ${esc(st)}"
      >${esc(st)}</button>`));
  // FB#105 (owner): "the album details from [Discogs] is a bit awkward too with the
  // text, it isn't clear what it does." It was doing two jobs badly in one line — an
  // honesty claim about where the data came from, and a door out to the source page —
  // and read as neither. It IS a door, so it joins the doors: last in the row, marked
  // as outward (↗), with the explanation carried by its title rather than by a label
  // sitting in the head. The provenance claim survives; it just stops interrupting.
  const src = provenanceThreadHtml(a);
  if (src) threads.push(src);
  $("#storyThreads").innerHTML = threads.join("");
  resetStoryBio();                           // collapsed door; fetched on demand
  // F27: reset the room so a previous album's people never flash here, then
  // fetch this release's credits (the section reappears only if any exist).
  storyRoomData = [];
  $("#storyRoomSec").classList.add("hidden");
  $("#storyRoom").innerHTML = "";
  // F27-1b: same reset-then-fetch for the pressings lineage door.
  storyPressData = [];
  $("#storyPressSec").classList.add("hidden");
  $("#storyPressings").innerHTML = "";
  // Feedback #23: same reset-then-fetch for the tracklist (hidden until it arrives).
  $("#storyTracksSec").classList.add("hidden");
  $("#storyTracks").innerHTML = "";
  $("#storyModal").classList.remove("hidden");
  fetchStoryRoom(storyRid);
  fetchStoryPressings(storyRid);
  fetchStoryTracks(storyRid);
  // Notes live in their own door now (openYourNotes) — the story door is
  // outward-only (N1 Step 1).
}

function closeStoryModal() {
  $("#storyModal").classList.add("hidden");
  storyRid = null;
}

// The acts row inside Album details. v329 (owner 2026-10-03): Keep is retired, so
// every record gets ✎ Write a note — saving one on today's record moves the deck on
// (afterNoteSaved), the way Keep did. **Skip stays deck-only** (FB#87): skipping is how
// you move past a record the day dealt you, so it's meaningless on one you went looking
// for, and the Skipped list is today's. A record kept before v329 still says so, in
// the past tense and with no undo — those keeps are history in your Notebook now.
function renderStoryDeckActions(rid) {
  const bar = $("#storyDeckActions");
  if (!bar) return;
  if (!rid) { bar.classList.add("hidden"); bar.innerHTML = ""; return; }
  const isDeckRecord = currentMode() === "decide" && deckState &&
    deckState.idx < deckState.records.length &&
    albumKey(deckState.records[deckState.idx]) === rid;
  bar.classList.remove("hidden");
  bar.innerHTML = (isKeptRecord(rid)
      ? `<p class="deck-kept-ack">Kept ✓ — in your Notebook</p>` : ``)
    + `<div class="deck-buttons">
         <button type="button" class="note-btn" data-story-note>✎ Write a note</button>
         ${isDeckRecord
           ? `<button type="button" class="set-aside-btn" data-story-setaside>Next</button>`
           : ``}
       </div>`;
  // First door of the session: the durable answer isn't loaded yet. Fetch it and
  // repaint if it turns out you kept this one already — the bar corrects itself
  // rather than inviting a duplicate.
  if (keptIndex === null) {
    loadKeptIndex().then(() => { if (storyRid === rid) renderStoryDeckActions(rid); });
  }
}

// --- the lazy door (P3 M2) --------------------------------------------------
// When an album is OPENED, resolve its real cover + exact per-platform links via
// /api/pool/door (iTunes + Odesli, cached server-side). This is what fills an
// MB-only album's art and turns its blind-search Listen links into exact ones; a
// Discogs album already carries art + the exact Apple link from the catalog join,
// so the door is only fetched when something's actually missing. On-demand and
// per-album (iTunes self-throttles), and cached client-side per uid so a reopen
// is instant.
const _doorByUid = new Map();   // uid -> resolved door payload

// Fetch + merge the lazy door onto albumData[uid] (real cover + the confirmed
// exact Spotify/Apple/YouTube fan-out). On-demand and per-album (iTunes/Odesli
// self-throttle), cached client-side per uid so a reopen is instant. Returns true
// when it merged new data, so the caller can re-render whatever surface is showing
// (the story head, the pick reveal, …). Surface-agnostic by design.
async function resolveDoor(uid) {
  if (!poolOn() || !uid) return false;        // the door is a pool-serving feature
  const a = albumData[uid];
  if (!a || a._doorFilled) return false;
  const have = a.platforms || {};
  const needsLinks = !have.spotify || !have.youtube;
  if (a.cover && !needsLinks) return false;
  let door = _doorByUid.get(uid);
  try {
    if (!door) {
      door = await (await fetch(
        "/api/pool/door?uid=" + encodeURIComponent(uid))).json();
      if (door && door.status === "ok") _doorByUid.set(uid, door);
    }
  } catch (e) { return false; }               // offline: the album still opens
  if (!door || door.status !== "ok") return false;
  // The confirmed `platforms` map is the source of truth the door renders; the
  // legacy *_url fields are kept in sync only for non-door readers.
  // Only BACKFILL a missing cover — never override the one the deck already resolved,
  // or the details modal would show a different image than the card it opened from
  // (feedback #65). Where the deck had no art, the door's cover fills the gap.
  if (door.cover && !a.cover) a.cover = door.cover;
  a.platforms = Object.assign({}, a.platforms, door.platforms || {});
  if (door.apple_music_url) a.apple_music_url = door.apple_music_url;
  if (door.spotify_url) a.spotify_url = door.spotify_url;
  if (door.youtube_url) a.youtube_url = door.youtube_url;
  // 2026-10-07: did Spotify actually answer for this record? "unchecked" means the
  // lookup failed or is paused — then the app says it couldn't check, never "not on".
  a._spUnchecked = door.spotify_status === "unchecked";
  a._doorFilled = true;
  albumData[uid] = a;
  return true;
}

async function fillDoorOnOpen(uid) {
  // Re-paint the open story head once the door settles — always, not only when it
  // filled something: the listen block's spinner must resolve to the real button
  // or the honest copy-search even for a catalog album the pool can't confirm.
  await resolveDoor(uid);
  const a = albumData[uid];
  if (a) a._doorPending = false;
  if (a && storyRid === uid) renderStoryHead(a);
}

// --- PLATFORM MARKS (F16): retired UI -----------------------------------------
// The here/not-here marks existed because every Listen link used to be a blind
// search — you only learned a record wasn't on a service by clicking through. The
// confirmed door makes every surfaced link exact, so "not here" no longer has a
// meaning, and the toggle UI is retired (owner's call). The persisted data is
// NOT touched: journal.platform_marks, the /api/album/<uid>/marks routes, and the
// export/import path all stay intact, so nothing a user recorded is lost and the
// UI can be revived or repurposed later without a migration.

// --- ARTIST PANEL (A2): an artist's catalog by date + a bio door -------------
// The richer home for the artist thread (VISION.md: story over metadata). Opened
// on demand only — from the artist link on a card, or the "More from…" thread in
// the story door. Nothing is auto-surfaced; the catalog and bio are pull-only.
let artistPanelName = null;   // the artist currently shown (guards async races)

function resetArtistBio() {
  $("#artistBio").innerHTML =
    `<button class="ghost artist-bio-open">Read a short bio ▸</button>`;
}

// A4's bio, reused for the panel. Keyed by the panel's artist name (not an album
// id), and guarded so a slow fetch can't land in a panel that moved on.
async function loadArtistBio() {
  const name = artistPanelName;
  if (!name) return;
  const wrap = $("#artistBio");
  wrap.innerHTML = `<p class="muted">Looking for a bio…</p>`;
  try {
    const data = await (await fetch(
      `/api/artist/bio?name=${encodeURIComponent(name)}`)).json();
    if (artistPanelName !== name) return;        // panel moved on under us
    if (data.status === "ok" && data.extract) {
      wrap.innerHTML =
        `<p class="bio-extract">${esc(data.extract)}</p>
         <p class="bio-cite muted">Summary from <a href="${esc(data.url)}"
           target="_blank" rel="noopener">Wikipedia</a> · CC BY-SA</p>`;
    } else {
      wrap.innerHTML = noBioHtml(name);
    }
  } catch (e) {
    if (artistPanelName === name) wrap.innerHTML =
      `<p class="muted">Couldn't load a bio just now.</p>`;
  }
}

async function openArtistPanel(name, opts = {}) {
  name = (name || "").trim();
  if (!name) return;
  if (!opts.noPush) {
    return pushAndGo(name, { t: "artist", name },
      () => openArtistPanel(name, { noPush: true }));
  }
  closeStoryModal(); AOTDLabelPanel.close(); closePersonPanel();  // one door at a time
  artistPanelName = name;
  $("#artistHead").innerHTML =
    `<h3>${esc(name)}</h3><p class="muted">Loading catalog…</p>`;
  resetArtistBio();
  $("#artistWordsSec").classList.add("hidden");   // N1 §4.4: echo, filled below
  $("#artistWords").innerHTML = "";
  $("#artistCatalog").innerHTML = "";
  $("#artistModal").classList.remove("hidden");
  fetchArtistWords(name);                          // your words on this artist
  let data;
  try {
    data = await (await fetch(
      `/api/artist?name=${encodeURIComponent(name)}`)).json();
  } catch (e) {
    if (artistPanelName === name) $("#artistHead").innerHTML =
      `<h3>${esc(name)}</h3><p class="muted">Couldn't load the catalog.</p>`;
    return;
  }
  if (artistPanelName !== name) return;          // a newer panel opened
  const albums = data.albums || [];
  const n = albums.length;
  const dg = data.discogs_url
    ? ` · <a href="${esc(data.discogs_url)}" target="_blank"
        rel="noopener">Discogs ↗</a>` : "";
  // B2 (owner, 2026-10-04): MusicBrainz's genres for the ARTIST appear here and only
  // here — plain text, not doors or filters, since an artist's range isn't any one
  // album's. The server sends none when the name is ambiguous.
  const ag = (data.artist_genres || []).filter(Boolean);
  const agLine = ag.length
    ? `<p class="muted artist-genres">Genres on MusicBrainz: ${ag.map(esc).join(" · ")}</p>`
    : "";
  $("#artistHead").innerHTML =
    `<h3>${esc(name)}</h3>
     <p class="muted">${n} album${n !== 1 ? "s" : ""} on file${dg}</p>
     ${agLine}
     ${shareBtnHtml("data-share-artist", "this artist")}`;
  $("#artistCatalog").innerHTML = n
    ? albums.map(browseCard).join("")
    : `<div class="empty">No catalog albums on file for ${esc(name)}.</div>`;
  // Eager-load the first screenful so the panel fills on open (lazy-loading is
  // unreliable inside a modal's own scroll container); the rest stay lazy.
  observeArt($("#artistCatalog"), { eager: 24 });
}

function closeArtistPanel() {
  $("#artistModal").classList.add("hidden");
  artistPanelName = null;
}

// N1 §4.4 — the retrieval echo. Your own verbatim words on this artist, surfaced
// only inside the artist door you opened (pull, never push), exact-match only.
// Silent when you haven't written about them: the section stays hidden.
async function fetchArtistWords(name) {
  try {
    // Two pulls, merged: notes on RECORDS by this artist (the body-match echo),
    // and notes tied DIRECTLY to the artist entity (v8: uid 'art:<name>'). The
    // tied notes are the most direct "your words on them", so they lead.
    // readJournal (FB#92/#104): a failed read throws instead of parsing as "no
    // words" — the section then stays hidden rather than claiming you never wrote
    // about them.
    const [echo, tied] = await Promise.all([
      readJournal(`/api/journal/artist?name=${encodeURIComponent(name)}`),
      readJournal(`/api/journal/album/${encodeURIComponent("art:" + name)}`),
    ]);
    if (artistPanelName !== name) return;          // panel moved on under us
    const tiedNotes = (tied.notes || []).map((n) => ({ ...n, _tied: true }));
    renderArtistWords(name, [...tiedNotes, ...(echo.notes || [])]);
  } catch (e) { /* silent — the echo just stays hidden */ }
}

function renderArtistWords(name, notes) {
  if (artistPanelName !== name) return;            // panel moved on under us
  const sec = $("#artistWordsSec");
  if (!notes.length) { sec.classList.add("hidden"); return; }
  $("#artistWordsHead").textContent = `Your words on ${name}`;
  // A tied note (art:<name>) is about the artist themselves — no record to name;
  // an echo note names the record it's on.
  $("#artistWords").innerHTML = notes.map((n) => `
    <div class="echo-item">
      <p class="echo-rec">${n._tied
        ? `<span class="echo-tied">✎ tied to this artist</span>`
        : `${esc(n.title || "")}${n.released ? ` <span class="muted">${esc(String(n.released).slice(0, 4))}</span>` : ""}`}</p>
      <div class="echo-body">${renderMarkdown(n.body)}</div>
      <p class="echo-date muted">${esc((n.created_at || "").slice(0, 10))}</p>
    </div>`).join("");
  $("#artistWordsFoot").textContent =
    `${notes.length} note${notes.length !== 1 ? "s" : ""} · shown because you ` +
    `opened this artist · your own words · only on this device`;
  sec.classList.remove("hidden");
}

// --- PERSONNEL PANEL (F27): the person's door, the mirror of the room --------
// Pick anyone from a sleeve's credits and see every record we have them
// credited on — deduped to master (a credit on any pressing counts), newest
// first like the artist/label panels, each record quoting the role as credited
// THERE. Keyed on the stable Discogs person id (identity); the name is display
// only. Bounded and honest: the head carries the true count *on file* — never a
// completeness claim — and the grid a newest-500 survey, so a prolific
// mastering engineer stays a window onto the craft, never an endless corridor.
let personPanelId = null;     // the person currently shown (guards async races)
let personPanelName = "";     // their display name (for snapshots/labels)

function personCard(a) {
  const role = a.credit_roles
    ? `<p class="person-role muted">${esc(a.credit_roles)}</p>` : "";
  return `<div class="person-hit">${browseCard(a)}${role}</div>`;
}

async function openPersonPanel(rawId, name, opts = {}) {
  // N4a: `rawId` is a Discogs integer person_id OR an 'mbid:<uuid>' door id for an
  // MB-only person. Normalize to a string doorId (the /api/person?id= value and the
  // nav/share key) plus a numeric `pid` (null for MB-only, used only to anchor the
  // fuzzy name-echo to a credit).
  const idStr = String(rawId == null ? "" : rawId).trim();
  let doorId, pid = null;
  if (idStr.indexOf("mbid:") === 0) {
    if (!idStr.slice(5)) return;
    doorId = idStr;                              // 'mbid:<uuid>'
  } else {
    pid = parseInt(idStr, 10);
    if (!pid || pid < 1) return;
    doorId = String(pid);                        // '<person_id>'
  }
  const uid = "per:" + doorId;
  name = (name || "").trim();
  if (!opts.noPush) {
    return pushAndGo(name || (pid ? `person #${pid}` : "artist"),
      { t: "person", id: doorId, name },
      () => openPersonPanel(doorId, name, { noPush: true }));
  }
  closeStoryModal(); closeArtistPanel(); AOTDLabelPanel.close();  // one door at a time
  personPanelId = doorId;
  personPanelName = name;
  $("#personHead").innerHTML =
    `<h3>${esc(name || "…")}</h3>
     <p class="muted">Looking through the credits…</p>`;
  $("#personCatalog").innerHTML = "";
  $("#personWordsSec").classList.add("hidden");   // N1 §4.4 (3a): echo, filled below
  $("#personWords").innerHTML = "";
  $("#personModal").classList.remove("hidden");
  let data;
  try {
    data = await (await fetch(`/api/person?id=${encodeURIComponent(doorId)}&name=${
      encodeURIComponent(name)}`)).json();
  } catch (e) {
    if (personPanelId === doorId) $("#personHead").innerHTML =
      `<h3>${esc(name || "this person")}</h3>
       <p class="muted">Couldn't load the credits.</p>`;
    return;
  }
  if (personPanelId !== doorId) return;          // a newer panel opened
  const albums = data.albums || [];
  const total = data.count || 0;
  personPanelName = data.name || name;
  // F27-p2: outward doors from the Wikidata crosswalk — quiet links, pull-only.
  // The merged-duplicate note is honesty about an external identity claim: when
  // Wikidata says two Discogs entries are one person, the count spans both and
  // we say so rather than merging silently.
  const out = [];
  if (data.discogs_url) out.push(`<a href="${esc(data.discogs_url)}"
    target="_blank" rel="noopener">Discogs ↗</a>`);
  if (data.wikipedia_url) out.push(`<a href="${esc(data.wikipedia_url)}"
    target="_blank" rel="noopener">Wikipedia ↗</a>`);
  if (data.musicbrainz_url) out.push(`<a href="${esc(data.musicbrainz_url)}"
    target="_blank" rel="noopener">MusicBrainz ↗</a>`);
  const dg = out.length ? " · " + out.join(" · ") : "";
  const across = (data.merged_ids || 1) > 1
    ? `, across ${data.merged_ids} Discogs entries (per Wikidata)` : "";
  const more = total > albums.length
    ? ` (showing the newest ${albums.length})` : "";
  $("#personHead").innerHTML =
    `<h3>${esc(personPanelName)}</h3>
     <p class="muted">Credited on ${total} record${total !== 1 ? "s" : ""} we
       have on file${across}${more}${dg}</p>
     ${shareBtnHtml("data-share-person", "this person")}`;
  $("#personCatalog").innerHTML = albums.length
    ? albums.map(personCard).join("")
    : `<div class="empty">No credits on file for ${esc(personPanelName)}.</div>`;
  observeArt($("#personCatalog"), { eager: 24 });
  fetchPersonWords(uid, pid, personPanelName);   // N1 §4.4 (3a): your words on this person
}

function closePersonPanel() {
  $("#personModal").classList.add("hidden");
  personPanelId = null;
  personPanelName = "";
}

// N1 §4.4 (3a) — the person-door retrieval echo. Your own verbatim words that name
// this credited person, surfaced only inside the door you opened (pull, never push).
// Fuzzy but catalog-anchored: every full-name match shows; a partial (a single name
// token) shows ONLY when the note's album credits this person (`creditedIds`) — so a
// private name in a note about an unrelated record is never surfaced. Silent when
// you haven't named them. Mirrors the artist echo (1c), one door over.
async function fetchPersonWords(uid, pid, name) {
  try {
    // Two pulls: notes that NAME this person (the fuzzy, catalog-anchored echo),
    // and notes tied DIRECTLY to the person entity (v8: the uid 'per:<pid>' or
    // 'per:mbid:<uuid>', a stable id — exact, no anchoring needed). Tied notes lead.
    const [data, tied] = await Promise.all([
      readJournal(`/api/journal/person?name=${encodeURIComponent(name)}`),
      readJournal(`/api/journal/album/${encodeURIComponent(uid)}`),
    ]);
    if (personPanelName !== name) return;                // panel moved on under us
    const tiedNotes = (tied.notes || []).map((n) => ({ ...n, _tied: true }));
    const raw = data.notes || [];
    // Anchor each fuzzy 'partial' hit to THIS person's credits: keep it only if the
    // note's album actually credits them (§4.4). One credit lookup per partial note
    // (partials are rare) — exact, and reliable even for a prolific engineer whose
    // panel survey is capped at the newest 500. A 'full' name match needs no anchor;
    // a private name on an unrelated record is never confirmed, so never surfaces.
    const okPartial = new Set();
    // The partial anchor needs a numeric person_id to compare against a credit. An
    // MB-only person (pid null) has none, so we skip anchoring — only 'full' name
    // matches + tied notes surface. (Guarding on `pid != null` also prevents a false
    // `null === null` match against any un-crosswalked credit on the note's album.)
    await Promise.all((pid == null ? [] : raw
      .filter((n) => n.match_kind === "partial" && n.uid))
      .map(async (n) => {
        try {
          const cr = await (await fetch(
            `/api/album/${encodeURIComponent(n.uid)}/credits`)).json();
          if ((cr.credits || []).some((c) => c.person_id === pid)) okPartial.add(n.id);
        } catch (e) { /* no credits: leave it unanchored, i.e. dropped */ }
      }));
    if (personPanelName !== name) return;                // re-check after the awaits
    const notes = raw.filter((n) => n.match_kind === "full" || okPartial.has(n.id));
    renderPersonWords(name, [...tiedNotes, ...notes]);
  } catch (e) { /* silent — the echo just stays hidden */ }
}

function renderPersonWords(name, notes) {
  if (personPanelName !== name) return;
  const sec = $("#personWordsSec");
  if (!notes.length) { sec.classList.add("hidden"); return; }
  $("#personWordsHead").textContent = `Your words on ${name}`;
  // A tied note (per:<pid>) is about the person themselves; an echo hit names the
  // record it's on (the person spans records, unlike the artist echo).
  $("#personWords").innerHTML = notes.map((n) => `
    <div class="echo-item">
      <p class="echo-rec">${n._tied
        ? `<span class="echo-tied">☺ tied to this person</span>`
        : `${esc(n.artist || "")}${n.artist && n.title ? " — " : ""}${esc(n.title || "")}${
          n.released ? ` <span class="muted">${esc(String(n.released).slice(0, 4))}</span>` : ""}`}</p>
      <div class="echo-body">${renderMarkdown(n.body)}</div>
      <p class="echo-date muted">${esc((n.created_at || "").slice(0, 10))}</p>
    </div>`).join("");
  $("#personWordsFoot").textContent =
    `${notes.length} note${notes.length !== 1 ? "s" : ""} · shown because you ` +
    `opened this person · your own words · only on this device`;
  sec.classList.remove("hidden");
}

// --- SEND FEEDBACK: capture current state, store locally --------------------
// A pull action: you choose to report something. We snapshot what you were
// looking at (UI state + environment + a best-effort image of the view) so a
// person or an AI can later read it and draft a backlog item. Everything stays
// on the machine (POSTed to /api/feedback, written under data/feedback/).

function openModalId() {
  const m = Array.from(document.querySelectorAll(".modal")).find(
    (x) => !x.classList.contains("hidden") && x.id !== "feedbackModal");
  return m ? m.id : null;
}

function gatherAppState() {
  return {
    mode: currentMode(),
    date: mdParam(),
    browse: {
      scope: browseScope,
      field: $("#fieldFilter").value || null,
      query: $("#search").value || "",
      only_this_day: $("#onlyDay").checked,
      decade: $("#decadeFilter").value || null,
      sort: $("#sort").value,
      selected_genres: [...selectedGenres],
      count_label: $("#count").textContent || "",
    },
    journal: {
      query: $("#journalSearch").value || "",
    },
    open_modal: openModalId(),
    story_rid: storyRid,
  };
}

function gatherEnv() {
  return {
    user_agent: navigator.userAgent,
    language: navigator.language,
    platform: navigator.platform,
    url: location.href,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    screen: { w: screen.width, h: screen.height, dpr: window.devicePixelRatio },
    captured_at: new Date().toISOString(),
  };
}

// Collect our own (same-origin) stylesheet rules so a detached snapshot still
// looks right. Cross-origin sheets throw on .cssRules — skip them.
function inlineCss() {
  let css = "";
  for (const sheet of document.styleSheets) {
    try { for (const rule of sheet.cssRules) css += rule.cssText + "\n"; }
    catch (e) { /* cross-origin sheet: skip */ }
  }
  return css;
}

// A clone of the visible view (everything in <body> except scripts and the
// feedback dialog itself), in the XHTML namespace so it can go inside an SVG
// <foreignObject> or a standalone HTML file.
function cloneView() {
  const wrap = document.createElement("div");
  wrap.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  for (const child of document.body.children) {
    if (child.id === "feedbackModal" || child.id === "feedbackBtn" ||
        child.tagName === "SCRIPT") continue;
    wrap.appendChild(child.cloneNode(true));
  }
  return wrap;
}

// A self-contained HTML snapshot of the view — reliable and directly readable
// (text an AI can inspect; opens in a browser too).
function captureViewHtml() {
  try {
    return `<!doctype html><html><head><meta charset="utf-8">` +
      `<style>${inlineCss()}</style></head><body>${cloneView().innerHTML}` +
      `</body></html>`;
  } catch (e) { return null; }
}

// Best-effort PNG via SVG <foreignObject>. Dependency-free, so it stays offline,
// but the browser blocks external images in an <img>-rendered SVG (covers come
// out blank) and very complex DOM can fail to render — in which case we just
// return null and rely on the HTML snapshot. Never throws into the caller.
async function captureScreenshot() {
  try {
    const w = Math.min(window.innerWidth, 1600);
    const h = Math.min(window.innerHeight, 2400);
    const xml = new XMLSerializer().serializeToString(cloneView());
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
      `<foreignObject x="0" y="0" width="${w}" height="${h}">` +
      `<style>${inlineCss()}</style>${xml}</foreignObject></svg>`;
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error("svg render failed"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = getComputedStyle(document.body).backgroundColor || "#111";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL("image/png");   // throws if the canvas is tainted
  } catch (e) {
    return null;                            // best-effort: HTML snapshot remains
  }
}

// Are we the hosted, logged-in app (feedback goes to Supabase, readably) or the
// local single-user tool (feedback stays on disk)? Drives both the copy and the
// submit path below.
function feedbackIsHosted() {
  return !!(window.AOTDSync && AOTDSync.isConfigured && AOTDSync.isConfigured());
}

function openFeedbackModal() {
  $("#feedbackBody").value = "";
  $("#feedbackStatus").textContent = "";
  // Feedback #25 (2026-07-07): the snapshot is opt-IN. This used to force it on
  // every open (overriding the unchecked HTML default), so removing `checked` from
  // the markup never took — reset it to false here so the box starts empty.
  $("#feedbackShot").checked = false;
  // Kept deliberately spare (owner 2026-07-15): the "where it goes / not E2EE"
  // disclosure lives in /privacy, and the snapshot is disclosed by its own opt-in
  // checkbox — so the prompt is just the one thing that helps a report land.
  const help = $("#feedbackHelp");
  if (help) help.textContent = str("feedback.help", "The more detail the better.");
  $("#feedbackModal").classList.remove("hidden");
  // Don't auto-focus the textarea: on mobile that yanks the keyboard up the
  // moment the dialog opens, covering the very view you came to report on. Let
  // the keyboard appear only when you actually tap the box.
}

function closeFeedbackModal() {
  $("#feedbackModal").classList.remove("peeking");   // #8: never close mid-peek
  $("#feedbackModal").classList.add("hidden");
}

async function submitFeedback() {
  const message = $("#feedbackBody").value.trim();
  const status = $("#feedbackStatus");
  if (!message) { status.textContent = "Write a little something first."; return; }
  // Snapshot state up front, before any await.
  const app_state = gatherAppState();
  const env = gatherEnv();
  let screenshot = null, view_html = null;
  if ($("#feedbackShot").checked) {
    status.textContent = "Capturing the view…";
    view_html = captureViewHtml();
    screenshot = await captureScreenshot();
  }
  status.textContent = feedbackIsHosted() ? "Sending…" : "Saving…";
  try {
    if (feedbackIsHosted()) {
      // Hosted: write straight to Supabase over our session (blobs -> Storage,
      // metadata -> the readable feedback table). Not E2EE, by design (§1).
      const supa = AOTDSync.getSupabase && AOTDSync.getSupabase();
      const session = await AOTDSync.currentSession();
      const userId = session && session.user && session.user.id;
      if (!supa || !userId) throw new Error("please sign in first");
      await FeedbackSync.submit({
        supa, userId, message, app_state, env,
        screenshotDataURL: screenshot, viewHtml: view_html,
      });
      status.textContent = "Thanks — sent ✓";
    } else {
      // Local single-user tool: keep writing the on-disk store.
      const r = await fetch("/api/feedback", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, app_state, env, screenshot, view_html }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || "failed");
      status.textContent = "Thanks — saved on your machine ✓";
    }
    $("#feedbackBody").value = "";
    setTimeout(closeFeedbackModal, 1000);
  } catch (e) {
    status.textContent = `Couldn't send: ${e.message}`;
  }
}

// --- mode switching + boot --------------------------------------------------
// The authoritative current mode, set by showMode. It used to be inferred from
// the highlighted tab, but modes without their own tab broke the inference:
// Browse (pull-only since T3) read back as "decide" — so a snapshot taken *in*
// browse restored to Choose — and Explore, now a Journal pill that keeps the
// Journal tab lit, would read back as "journal".
let _mode = "decide";
function currentMode() { return _mode; }

// --- WANDER TRAILS (T1): doors, not corridors -------------------------------
// The direct expression of VISION.md Principle 5. Every pull is a *door* you can
// close to return from, never a corridor that replaces your context and chains
// on without end. Three layers share one snapshot/restore engine:
//   1. a return stack (this) — every pull snapshots the view it leaves and can
//      restore it exactly, with a pinned-root breadcrumb;
//   2. a wander map (renderWanderMap) — the whole session as a tree;
//   3. saved Trails (server) — name a wander and keep it.
// A *map, never a scoreboard*: no visit counts, no "how deep can you go".
//
// `wanderTree` holds every node pulled this session, including branches you
// backed out of (each node remembers its parent, so the shape is a tree). The
// "return stack" is just the path from the root to the cursor.
let wanderTree = [];      // [{id, parent, label, nav, snap}]
let wanderCursor = -1;    // index of the node we're standing in; -1 = no wander
// The *tip* of the line you're on — the furthest point you'd walked before
// stepping back. Stays put when you only step back along the same line (so the
// map keeps showing the later steps, with the cursor marking where you are);
// jumps to a new node when you branch off onto a different line. -1 = no wander.
let wanderFrontier = -1;
let _wanderSeq = 0;

// T6: a session-long, append-only log of every door pulled — distinct from the
// active return-stack above. A tab switch resets the wander (you've left), but
// this record survives, so a path you followed earlier (e.g. the album you hit
// ♫ Listen on, then wandered off from) is always retraceable through the Trail
// entry. In-memory for the session; a page reload is a fresh session.
let sessionHistory = [];  // [{label, nav, at}] in the order pulled
let _historyByKey = {};   // navKey -> the most recent entry (for replay)

// A stable identity for a door, so the history list can collapse repeat visits
// to the same place to a single (most-recent) entry.
function navKey(nav) {
  if (!nav) return "none";
  if (nav.t === "story") return "story:" + nav.rid;
  if (nav.t === "artist") return "artist:" + (nav.name || "");
  if (nav.t === "label") return "label:" + (nav.name || "");
  if (nav.t === "person") return "person:" + (nav.id || "");
  if (nav.t === "catalog") return "catalog:" + (nav.field || "") + ":" + (nav.term || "");
  if (nav.t === "decade") return "decade:" + (nav.decade || "");
  if (nav.t === "journalday") return "journalday:" + (nav.day || "");
  try { return JSON.stringify(nav); } catch (e) { return "nav"; }
}

const MODE_LABELS = {
  decide: "Today", forest: "Search", browse: "Browse",
  journal: "Notebook",   // the tab label; the mode key stays `journal` in code
};

function rootLabel() {
  // What you were doing before you forked — the anchor the breadcrumb pins.
  // FB#94: forking out of a notebook search, "Notebook" is true but useless — it's
  // where you already are. Name the SEARCH instead, so the way back says what it
  // goes back to ("← “rain”") rather than the surface it happens to live on.
  if (currentMode() === "journal") {
    const q = ($("#journalSearch") && $("#journalSearch").value.trim()) || "";
    if (q) return "“" + q + "”";
  }
  return MODE_LABELS[currentMode()] || "Start";
}

// A restorable snapshot of the *current* view: the grid's full filter state +
// scroll, plus which wander-modal (if any) is open over it.
function snapshotView() {
  return {
    mode: currentMode(),
    scope: browseScope,
    decade: decadeBrowse,
    query: $("#search").value || "",
    field: $("#fieldFilter").value || "",
    onlyDay: $("#onlyDay").checked,
    sort: $("#sort").value,
    genres: [...selectedGenres],
    // FB#94: the Notebook's own search box. `query` above is the browse grid's —
    // the two are different fields, and without this a snapshot taken while you
    // were reading search results restored the results' *scroll* but not the term
    // that produced them, which is the half that makes the return worth having.
    jquery: ($("#journalSearch") && $("#journalSearch").value) || "",
    scrollY: window.scrollY || window.pageYOffset || 0,
    modal: AOTDLabelPanel.currentName() ? { t: "label", name: AOTDLabelPanel.currentName() }
         : artistPanelName ? { t: "artist", name: artistPanelName }
         : personPanelId ? { t: "person", id: personPanelId, name: personPanelName }
         : (storyRid != null ? { t: "story", rid: storyRid } : null),
  };
}

// Rebuild a view from a snapshot. The fiddly part is the grid: re-apply every
// filter, reload, then restore scroll once the cards are back (covers are
// fixed-aspect CSS backgrounds, so loading them doesn't shift layout — one
// scrollTo after render is enough).
async function restoreView(s) {
  if (!s) return;
  closeArtistPanel();
  AOTDLabelPanel.close();
  closePersonPanel();
  closeStoryModal();
  // Open the door first, so returning to an album/artist/label you discovered
  // appears *immediately* — not after the (possibly slow) background grid
  // reloads behind it. The album data is already in memory from this session,
  // so the modal can open before the background catches up.
  const openDoor = () => {
    if (!s.modal) return;
    if (s.modal.t === "artist") openArtistPanel(s.modal.name, { noPush: true });
    else if (s.modal.t === "label") AOTDLabelPanel.open(s.modal.name, { noPush: true });
    else if (s.modal.t === "person") openPersonPanel(s.modal.id, s.modal.name, { noPush: true });
    else if (s.modal.t === "story") openStoryModal(s.modal.rid, { noPush: true });
  };
  if (s.mode === "browse") {
    browseScope = s.scope;
    decadeBrowse = s.decade;
    $("#scope").value = s.scope;
    $("#fieldFilter").value = s.field;
    $("#onlyDay").checked = s.onlyDay;
    $("#sort").value = s.sort;
    $("#search").value = s.query;
    selectedGenres.clear();
    s.genres.forEach((g) => selectedGenres.add(g));
    $("#onlyDayWrap").classList.toggle("hidden", s.scope !== "all");
    $("#search").placeholder = s.scope === "all"
      ? "Search every album, across all dates…"
      : "Filter by artist, title, style…";
    showMode("browse");
    openDoor();
    await loadBrowse();
    if (s.scrollY) requestAnimationFrame(() => window.scrollTo(0, s.scrollY));
  } else {
    // The non-grid modes (Forest, Choices, Journal, Choose) carry no per-view
    // filter state in the snapshot, so if we're already on that mode there's
    // nothing to rebuild — just open the door (instant, no flash). Only reload
    // the background when we're actually switching into a different mode.
    const already = currentMode() === s.mode;
    showMode(s.mode);
    openDoor();
    // FB#94: the Notebook is the exception to "already on this mode → nothing to
    // rebuild". Its search box IS its view state, and coming back from a day you
    // stepped into means coming back to the term AND the matches it produced. So
    // put the query back and re-run the trail whenever it differs from what's on
    // screen, then restore scroll once the matches have rendered.
    if (s.mode === "journal" && $("#journalSearch")) {
      const box = $("#journalSearch");
      const want = s.jquery || "";
      if (box.value !== want) {
        box.value = want;
        refreshSearchClear(box);
        await loadTrail(true);
      } else if (!already) {
        await loadMode(s.mode);
      }
      if (s.scrollY) requestAnimationFrame(() => window.scrollTo(0, s.scrollY));
      return;
    }
    if (!already) await loadMode(s.mode);
  }
}

// Perform a door's navigation without recording it (used to re-walk a node whose
// snapshot we don't have — e.g. a freshly-loaded saved Trail).
function applyNav(nav) {
  if (!nav) return;
  if (nav.t === "artist") openArtistPanel(nav.name, { noPush: true });
  else if (nav.t === "label") AOTDLabelPanel.open(nav.name, { noPush: true });
  else if (nav.t === "person") openPersonPanel(nav.id, nav.name, { noPush: true });
  else if (nav.t === "story") openStoryModal(nav.rid, { noPush: true });
  else if (nav.t === "catalog") searchCatalog(nav.field, nav.term, { noPush: true });
  else if (nav.t === "decade") searchDecade(nav.decade, { noPush: true });
  else if (nav.t === "journalday") goToJournalDay(nav.day, { noPush: true });
  // A keep-seeded node (H1.B1, from before Keep retired at v329 — a restored trail can
  // still hold one): the deck is session state we can't replay later, so returning
  // to it just lands back on Today (its snapshot restores the actual deck
  // view when one exists; this is the no-snapshot fallback).
  else if (nav.t === "pick") { showMode("decide"); enterToday(); }
}

// The one helper every pull routes through, so the discipline is automatic and a
// future pull can't forget to be returnable.
function pushAndGo(label, nav, navFn) {
  // FB#103 ("why is it showing the album twice?"): re-pulling the door you are
  // ALREADY standing in is not a step — it's the same place. Pushing it anyway put
  // two identical nodes back-to-back in the map (the reader's snapshot had the same
  // album, same cover, at depths 1 and 2), which reads as a wander that went
  // somewhere when it didn't, and costs a second tap to walk back out of. Re-run the
  // nav so the door still opens; just don't grow the trail with a step in place.
  if (wanderCursor >= 0 && nav && wanderTree[wanderCursor] &&
      navKey(wanderTree[wanderCursor].nav) === navKey(nav)) {
    navFn();
    return;
  }
  if (wanderCursor < 0) {
    // First fork of this session: capture the pre-fork view as the pinned root.
    wanderTree = [{
      id: ++_wanderSeq, parent: -1, label: rootLabel(), nav: null,
      snap: snapshotView(),
    }];
    wanderCursor = 0;
  } else {
    // Freeze the view we're leaving so returning lands exactly where we were.
    wanderTree[wanderCursor].snap = snapshotView();
  }
  const node = {
    id: ++_wanderSeq, parent: wanderCursor, label: label || "step",
    nav: nav || null, snap: null,
  };
  wanderTree.push(node);
  wanderCursor = wanderTree.length - 1;
  wanderFrontier = wanderCursor;          // a new pull extends the line's tip
  // T6: log this pull to the session-long record (only real doors, not the
  // pinned root, which has no nav).
  if (nav) sessionHistory.push({ label: label || "step", nav, at: Date.now() });
  try { history.pushState({ aotdWander: node.id }, ""); } catch (e) { /* ok */ }
  navFn();
  // AFTER the nav, not before. renderBreadcrumb() decides whether to show the bar from
  // the mode it finds, and navFn() is what changes the mode — so rendering first asked
  // the question against the screen we were LEAVING, and a pull from Today (a root
  // mode, where the bar is deliberately suppressed) painted no bar at all. The trail
  // existed with nothing on screen to walk back through it; it reappeared only when
  // some later interaction happened to re-render. Found 2026-08-07 while restoring a
  // wander across a reload, which lands in exactly the same spot.
  renderBreadcrumb();
}

// The path from the root to any node (array of node indices, [0] = root).
function pathToNode(i) {
  const out = [];
  while (i >= 0) { out.unshift(i); i = wanderTree[i].parent; }
  return out;
}

// The path from the root to the cursor (where you're standing).
function wanderPath() {
  return pathToNode(wanderCursor);
}

function shortLabel(node, max = 22) {
  const s = node.label || "step";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// Move to an existing node: freeze where we are, then restore the target. Used
// by the breadcrumb, the map, the system back button (popstate), and trail
// replay. `fromHistory` skips pushing a new history entry (back already moved).
function gotoNode(i, opts = {}) {
  if (i == null || i < 0 || i >= wanderTree.length) return;
  if (wanderCursor >= 0 && wanderTree[wanderCursor]) {
    wanderTree[wanderCursor].snap = snapshotView();
  }
  wanderCursor = i;
  // Keep the line's tip if you've only stepped *back* along it (i is on the path
  // to the current frontier) — so the map still shows the later steps ahead of
  // you. If you've jumped onto a different branch, that branch is the new line.
  if (wanderFrontier < 0 || !pathToNode(wanderFrontier).includes(i)) {
    wanderFrontier = i;
  }
  closeWanderMap();
  const n = wanderTree[i];
  if (n.snap) restoreView(n.snap);
  else { closeArtistPanel(); AOTDLabelPanel.close(); closeStoryModal(); applyNav(n.nav); }
  if (!opts.fromHistory) {
    try { history.pushState({ aotdWander: n.id }, ""); } catch (e) { /* ok */ }
  }
  renderBreadcrumb();
}

// Leave the wander entirely (a deliberate top-level move, e.g. a tab click).
function resetWander() {
  wanderTree = [];
  wanderCursor = -1;
  wanderFrontier = -1;
  renderBreadcrumb();
}

// --- surviving a reload (owner, 2026-08-07) ---------------------------------
// "updating the app brought me to the today page when I was deep in a trail —
// it should just return me to wherever i was."
//
// Taking an update is a `location.reload()`, and the wander lived only in memory, so
// every step of it evaporated and boot's `setMode("decide")` landed you on Today. The
// deck already remembered WHICH RECORD you were on across a reload (AT_KEY above);
// nothing remembered which DOOR you were standing in.
//
// SESSION storage, deliberately, on both counts. A trail is explicitly a session thing
// — the map calls it "the doors you pulled this session" — so it should survive a
// reload and *not* come back tomorrow as a stale place you don't remember going. And
// localStorage is a shared budget with the E2EE notebook, which is the irreplaceable
// thing here; a trail is not worth a byte of it.
//
// Only the SERIALIZABLE half is kept: id, parent, label and the `nav` descriptor.
// `snap` is a frozen view — scroll offsets and rendered DOM state — which a reload
// invalidates anyway, so restoring re-walks the node through applyNav() instead. That
// is the same path a loaded saved Trail already uses, so nothing new has to be right.
const WANDER_KEY = "mf-wander/v1";

// Snapshotted at PARSE time, before anything runs. boot's `setMode("decide")` renders
// the breadcrumb, which calls saveWander() — and with an empty tree that DELETES the
// key. Reading it later would therefore be racing our own boot for the thing we are
// trying to restore. Read it once, up front, and let the rest of boot do as it likes.
const _wanderSaved = (() => {
  try { return JSON.parse(sessionStorage.getItem(WANDER_KEY)); } catch (e) { return null; }
})();

function saveWander() {
  try {
    if (wanderCursor < 0 || wanderTree.length <= 1) {
      sessionStorage.removeItem(WANDER_KEY);
      return;
    }
    sessionStorage.setItem(WANDER_KEY, JSON.stringify({
      cursor: wanderCursor, frontier: wanderFrontier, seq: _wanderSeq,
      tree: wanderTree.map((n) => ({ id: n.id, parent: n.parent, label: n.label, nav: n.nav })),
    }));
  } catch (e) { /* private mode / quota — losing your place beats a thrown deck */ }
}

// Put the reader back where they were. Returns whether it restored anything, so the
// caller can leave its own default (Today) alone when there is nothing to resume.
// Absorbing at every step: a trail that can't be re-walked is not an error, it's just
// a fresh start on Today — the same shape as resumeAt() above.
function restoreWander() {
  const o = _wanderSaved;
  if (!o || !Array.isArray(o.tree) || o.tree.length <= 1) return false;
  if (!(o.cursor >= 0 && o.cursor < o.tree.length)) return false;
  const cur = o.tree[o.cursor];
  // The pinned root has no nav by design; standing on it IS standing on Today, so
  // there is nothing to re-walk and the normal boot is already correct.
  if (!cur || !cur.nav) return false;
  wanderTree = o.tree.map((n) => ({ id: n.id, parent: n.parent, label: n.label, nav: n.nav, snap: null }));
  wanderCursor = o.cursor;
  wanderFrontier = (o.frontier >= 0 && o.frontier < wanderTree.length) ? o.frontier : o.cursor;
  _wanderSeq = Math.max(_wanderSeq, o.seq || 0);
  try { applyNav(cur.nav); } catch (e) { resetWander(); return false; }
  // AFTER the nav, not before: applyNav switches modes, and renderBreadcrumb decides
  // whether to show anything from the mode it finds. Rendering first put the reader
  // back inside a restored door with no pill to walk out of — the trail was there and
  // unreachable, which is worse than not restoring it at all.
  renderBreadcrumb();
  return true;
}

// --- breadcrumb: always pin the root, collapse the middle -------------------
function renderBreadcrumb() {
  const bar = $("#wanderBar");
  if (!bar) return;
  // The wander back-pill belongs to the album-door wander, not the tab-roots.
  // Doors are modals over the page, so the bar is only ever *visible* on a bare
  // root — and there it's a confusing duplicate. Suppress it on Remember (Notes /
  // Choices / Explore) AND on Choose (feedback #19, 2026-07-07: a stale "← <album>"
  // pill lingered under the Choose tabs after closing a door). Keep it only for the
  // pulled browse/detail views; the ⤳ Trail control still opens the map anywhere.
  // FB#94 exception: a day stepped into FROM a notebook search is a real step taken
  // *on this surface*, not a stale pill left over from a door you closed — and it is
  // the only way back to the search you came from, so suppressing it would strand
  // the reader in the full trail with their term gone. Show the bar when the node
  // we're standing on is that step.
  const cur0 = wanderCursor >= 0 ? wanderTree[wanderCursor] : null;
  const inJournalStep = !!(cur0 && cur0.nav && cur0.nav.t === "journalday");
  const rootMode = ["journal", "forest", "decide"].includes(currentMode()) && !inJournalStep;
  if (rootMode || wanderTree.length <= 1) {
    bar.classList.add("hidden"); bar.innerHTML = ""; saveWander(); return;
  }
  const path = wanderPath();
  const root = wanderTree[path[0]];
  const cur = wanderTree[path[path.length - 1]];
  const parentIdx = path.length >= 2 ? path[path.length - 2] : null;

  // Desktop crumbs: root › … › parent › current. Depth never costs legibility —
  // the root is always pinned, the middle collapses to "…". (When you've walked
  // all the way back to the root, just the pinned root shows — no duplicate.)
  const sep = `<span class="crumb-sep">›</span>`;
  let crumbs =
    `<button class="crumb crumb-home" data-wgoto="${path[0]}"
       title="Back to where you started">${esc(shortLabel(root))}</button>`;
  if (path.length > 1) {
    if (path.length > 3) {
      crumbs += sep + `<button class="crumb crumb-more" data-wmap
        title="See the whole wander">…</button>`;
    }
    if (parentIdx != null && parentIdx !== path[0]) {
      crumbs += sep + `<button class="crumb" data-wgoto="${parentIdx}"
        >${esc(shortLabel(wanderTree[parentIdx]))}</button>`;
    }
    crumbs += sep + `<span class="crumb crumb-cur">${esc(shortLabel(cur))}</span>`;
  }

  // Mobile back-pill: one 44px control that opens the full trail (system back /
  // edge-swipe does the actual popping). Names the parent so the thumb knows
  // where it returns to. At the ROOT there is nowhere back to go — a pill
  // reading "← Today" while standing on Today is a duplicate button (owner,
  // on-device 2026-07-03: "the choose button appears twice"); the floating
  // ⤳ Trail control still opens the map from there. The keep SEED is the same
  // duplicate in disguise: standing on your kept album you're still *on* the Today
  // screen (the reveal is a door over the deck), so "← Today" points at the
  // very screen you're looking at (owner, incognito Android 2026-07-03: "the
  // choose button still shows in the guest view"). Only a real step away —
  // a pulled door, an artist, a label — earns the pill.
  const showPill = path.length > 1 && !cur._choiceSeed;
  // FB#105 follow-up (owner, on an iPhone 13 mini): the pill read `← "culmination"` —
  // the parent's label and nothing else — and it "is unclear what this pill does."
  // It was misleading twice over: it named a destination, but `data-wmap` opens the
  // whole trail map rather than returning to that one node, so the label promised
  // something the tap didn't do. It says what tapping DOES now — owner's words,
  // "Retrace your steps". An earlier pass used "⤳ Trail", the surface name from
  // BRAND.md's table, but a noun names the place without promising the act, and not
  // knowing the act was the entire complaint. A verb phrase answers it in the label.
  // This also retired `backTo`, which existed only to label the pill and went dead the
  // moment the label stopped naming a single destination.
  const pill = showPill
    ? `<button class="wb-back" data-wmap
        title="See everywhere you've been this session, and go back to any of it"
        >⤳ Retrace your steps</button>`
    : "";

  bar.innerHTML =
    `<div class="wb-crumbs">${crumbs}
       <button class="wb-map" data-wmap title="See the whole wander as a map"
         >⤳ trail</button></div>${pill}`;
  // On phones the crumbs are hidden, so a pill-less bar is an invisible strip
  // of padding — flag it so the ≤640px block can drop it entirely.
  bar.classList.toggle("no-pill", !showPill);
  bar.classList.remove("hidden");
  saveWander();      // every mutation of the stack ends here, so this is the one hook
}

// --- the wander map (layer 2) + saved Trails (layer 3) ----------------------
function openWanderMap() {
  // UN-HIDE FIRST, then render. renderWanderMap measures `body.clientWidth` to lay
  // the text column out against the real panel width, and a display:none subtree
  // measures 0 — the same trap that stopped the covers fetching until v287. Nothing
  // paints between this and the innerHTML writes below, so there is no flash of the
  // previous trail.
  $("#wanderMapModal").classList.remove("hidden");
  // T4: reachable from any context (the header "⤳ Trail" button), so it must
  // open even with no active wander — you still get to your *saved* trails.
  const hasWander = wanderTree.length > 1;
  if (hasWander) {
    renderWanderMap();
  } else {
    // #6: an empty Trail still needs one real door out, but the long explainer
    // was verbose — trim to a single line + a button straight into Explore.
    // Guest: the forest is grown from a journal a guest doesn't have yet, so
    // their door goes back to the records instead of bouncing into the account
    // gate (owner, 2026-07-02: "it should just go back to choose").
    const guest = !!window.AOTD_GUEST;
    $("#wanderMapBody").innerHTML =
      `<div class="trail-empty">
        <p class="muted">${str("trail.empty", "No trail yet — your path appears here as you wander.")}</p>
        <div class="trail-empty-actions">
          <button id="trailGoForest" class="ghost">${guest
            ? str("trail.chooseCta", "Back to the records →")
            : str("trail.exploreCta", "Explore →")}</button>
        </div>
      </div>`;
    const go = $("#trailGoForest");
    if (go) go.addEventListener("click", () => {
      closeWanderMap();
      resetWander();
      setMode(guest ? "decide" : "forest");
    });
  }
  renderSessionHistory();   // T6: everything pulled this session, wander or not
}

function closeWanderMap() {
  const m = $("#wanderMapModal");
  if (m) m.classList.add("hidden");
}

// Render the whole session as a small **mycelial network**: nodes are spores
// where filaments meet, joined by thin organic threads that wander rather than
// run straight (the "wood grown from your own words" grammar, the layer under
// it). The thread you're on glows; the branches you backed out of fade into the
// dark. Mostly still (a soft settle-in, honored off for reduced motion). The
// filaments + spores are SVG; the legible labels are HTML on top.
function renderWanderMap() {
  const body = $("#wanderMapBody");
  if (!wanderTree.length) { body.innerHTML = `<p class="muted">No wander yet.</p>`; return; }

  // The lit "line" is the whole path to the trail's *tip* (frontier), not just
  // to the cursor — so after stepping back, the later steps still show as part
  // of the trail. The cursor marks where you're standing on that line; steps
  // beyond it read as "ahead" (retraceable forward).
  const frontier = wanderFrontier >= 0 ? wanderFrontier : wanderCursor;
  const onLine = new Set(pathToNode(frontier));
  const kids = {};
  wanderTree.forEach((n, i) => {
    if (n.parent >= 0) (kids[n.parent] = kids[n.parent] || []).push(i);
  });

  // LEFT RAIL, TEXT RIGHT (owner, 2026-08-07: "when the text lands directly over the
  // green node circles it is hard to read — can the trail line/circles be left
  // justified with the text on the right side?"). The old layout put each node's
  // label centred ON its own point, so every label crossed the vine and its circle.
  //
  // The rail carries the structure now, so nothing needs horizontal space:
  // ONE NODE PER ROW, in depth-first order, with a branch stepping onto its own
  // rail (the `git log --graph` shape). That replaces the previous "siblings sit
  // side by side" layout, which is why this is a change to the recursion and not
  // just to CSS — with the text column owning the width, two siblings on one row
  // would collide. It also removes horizontal scrolling entirely: the tree is
  // always one column wide, however branchy the trail.
  const RAILW = 16, ROWH = 52, PADX = 22, PADY = 22, GUTTER = 14;
  const railOf = {}, rowOf = {}, depthOf = {};
  const order = [];
  let nextRail = 0;
  (function layout(i, rail, depth) {
    railOf[i] = rail;
    rowOf[i] = order.length;
    depthOf[i] = depth;      // still the TREE depth, which is what "ahead" means
    order.push(i);
    // THE LIVE CHILD GOES FIRST, then the abandoned ones in the order they were
    // made. With one node per row, a depth-first walk puts a child directly under
    // its parent only if it is visited first — so visiting in creation order can
    // strand the branch you are actually standing on below an abandoned subtree,
    // with a long connector running past rows it has nothing to do with. Ordering
    // by the lit line keeps the trail you came to retrace as one unbroken run, and
    // leaves the long connector on the branch you already walked away from.
    const ch = (kids[i] || []).slice().sort((a, b) =>
      (onLine.has(b) ? 1 : 0) - (onLine.has(a) ? 1 : 0));
    // The first child continues its parent's rail; each further child opens a new
    // one, so a fork is visible as a second line rather than as a sideways jump.
    ch.forEach((c, k) => layout(c, k === 0 ? rail : ++nextRail, depth + 1));
  })(0, 0, 0);

  const maxRail = nextRail;
  // Measure the space we actually have rather than computing a width from the
  // content: the text column should fill the panel, and a measured width is what
  // guarantees no horizontal scroll. openWanderMap un-hides the modal BEFORE
  // calling us precisely so this reads a real number (a display:none subtree
  // measures 0, the same trap that deferred the cover fetches).
  const avail = Math.max(240, body.clientWidth || 320);
  const W = avail;
  const H = (order.length - 1) * ROWH + PADY * 2;
  const cx = (i) => PADX + railOf[i] * RAILW;          // the rail, hard left
  const cy = (i) => PADY + rowOf[i] * ROWH;
  const textX = PADX + (maxRail + 1) * RAILW + GUTTER;  // clear of the widest rail
  // Depth of where you're standing, so nodes deeper on the line read as "ahead".
  const cursorDepth = depthOf[wanderCursor] === undefined ? Infinity : depthOf[wanderCursor];
  const isAhead = (i) => onLine.has(i) && depthOf[i] > cursorDepth;

  // A deterministic wobble so a filament looks grown, not drawn — but is stable
  // across re-renders (seeded by the node id).
  const wob = (s, m) => (((s * 1103515245 + 12345) >> 8) % (2 * m + 1)) - m;

  // The decorative filaments are gone (owner's call, same pass). They radiated up
  // to ~24px in every direction from each spore, which in a left rail sprays them
  // straight through the text column. The wobble on the edges below is what keeps
  // the rail feeling grown rather than drawn.
  let edges = "";   // the real connections (parent → child)

  wanderTree.forEach((n, i) => {
    if (railOf[i] === undefined) return;
    if (n.parent < 0 || railOf[n.parent] === undefined) return;
    const x1 = cx(n.parent), y1 = cy(n.parent), x2 = cx(i), y2 = cy(i);
    const dy = y2 - y1;
    const litEdge = onLine.has(i) && onLine.has(n.parent);
    const aheadEdge = litEdge && isAhead(i);   // the segment beyond the cursor
    // Wobble sideways only — a vertical rail bends left/right as it descends. The
    // amplitude is small (±5px) because the rail lane is only RAILW wide now; the
    // old ±16 was sized for a 150px column and would cross neighbouring rails.
    const c1x = x1 + wob(i * 3, 5), c1y = y1 + dy * 0.45;
    const c2x = x2 - wob(i * 5, 5), c2y = y2 - dy * 0.45;
    edges += `<path class="wedge ${litEdge ? "lit" : "dim"}${aheadEdge ? " ahead" : ""}"
      d="M${x1},${y1} C${c1x},${c1y} ${c2x},${c2y} ${x2},${y2}"/>`;
  });

  // Spores (SVG circles) on the rail, with a glow when lit / current.
  let spores = "";
  order.forEach((i) => {
    const lit = onLine.has(i), cur = i === wanderCursor, ahead = isAhead(i);
    const r = cur ? 6 : (lit ? 4.5 : 3.5);
    const cls = cur ? "cur" : (lit ? "lit" : "dim");
    spores += `<circle class="wspore ${cls}${ahead ? " ahead" : ""}"
      cx="${cx(i)}" cy="${cy(i)}" r="${r}"/>`;
  });

  // Labels (HTML, to the RIGHT of the rail) — the clickable target, and the whole
  // point of the change: a label no longer sits over the line or its circle. Album
  // steps carry a tiny cover for at-a-glance recognition (trailThumbHtml), now
  // inline before the text rather than stacked above it.
  let labels = "";
  order.forEach((i) => {
    const n = wanderTree[i], cur = i === wanderCursor, ahead = isAhead(i);
    const cls = ["wnode", onLine.has(i) ? "lit" : "dim",
      cur ? "cur" : "", ahead ? "ahead" : ""].join(" ").replace(/\s+/g, " ").trim();
    const tip = cur ? "you are here"
      : ahead ? "a step ahead — go forward to here"
      : (n.parent < 0 ? "where you started" : "return here");
    labels += `<button class="${cls}" data-wgoto="${i}" title="${tip}"
      style="left:${textX}px;top:${cy(i)}px;width:${Math.max(80, W - textX - PADX)}px">${
      trailThumbHtml(n.nav)}<span class="wlabel">${
      esc(shortLabel(n, 34))}</span></button>`;
  });

  body.innerHTML =
    `<div class="wtree wmycelium wtree-rail" style="width:${W}px;height:${H}px">
       <svg class="wtree-svg" width="${W}" height="${H}"
         viewBox="0 0 ${W} ${H}" aria-hidden="true">
         <defs>
           <filter id="wglow" x="-60%" y="-60%" width="220%" height="220%">
             <feGaussianBlur stdDeviation="2.4" result="b"/>
             <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
           </filter>
         </defs>
         ${edges}${spores}
       </svg>
       ${labels}
     </div>`;
}

// A tiny cover beside an album step on the trail (map pills + session history)
// — recognition at a glance, not decoration. Only for story doors whose album
// (and art) this session already holds in albumData; anything else renders
// nothing, and the trail never fires a fetch of its own.
function trailThumbHtml(nav) {
  if (!nav || nav.t !== "story") return "";
  const a = albumData[nav.rid];
  if (!a || !a.cover || isAppleArt(a.cover)) return "";   // no Apple link on the trail
  // Owner's trail-map notes, 2026-08-07: covers arrive slowly here even for
  // albums seen minutes ago.
  // NOT a cache-key problem — the trail and the deck read the same
  // albumData[rid].cover string, so the bytes are already in the HTTP cache. It
  // was `loading="lazy"`, and openWanderMap builds this markup BEFORE it takes
  // .hidden off the modal: a lazy <img> inserted into a display:none subtree
  // issues no request at all, so the fetch could not even begin until the modal
  // was shown and laid out, and then ran at low priority. (The retired keep reveal
  // hit the same trap and worked around it with observeArt({eager}), which these
  // <img>s never touch.)
  // Eager is right here regardless of the ordering: a trail is bounded by how
  // far you have wandered, and these are 30-40px thumbs of images the session
  // has already downloaded.
  return `<img class="wthumb" src="${esc(caaThumb(a.cover, 250))}" alt="">`;
}

// T6: the session-long history list. Most-recent first, collapsed so each
// distinct door shows once. Tapping one walks back to it (returnable, since it
// re-enters through pushAndGo).
const HISTORY_VIA = {
  story: "Album", artist: "Artist", label: "Label",
  catalog: "Search", decade: "Decade",
};
function renderSessionHistory() {
  const wrap = $("#sessionHistoryList");
  const section = $("#sessionHistorySection");
  if (!wrap) return;
  _historyByKey = {};
  const items = [];
  for (let i = sessionHistory.length - 1; i >= 0; i--) {
    const e = sessionHistory[i];
    const k = navKey(e.nav);
    if (_historyByKey[k]) continue;     // keep only the most recent visit
    _historyByKey[k] = e;
    items.push({ key: k, entry: e });
  }
  if (!items.length) {
    if (section) section.classList.add("hidden");
    wrap.innerHTML = "";
    return;
  }
  if (section) section.classList.remove("hidden");
  wrap.innerHTML = items.map(({ key, entry }) => {
    const via = HISTORY_VIA[entry.nav && entry.nav.t] || "Door";
    return `<div class="history-row">
       <button class="link-quiet history-step" data-histkey="${esc(key)}"
         title="Walk back to this">${trailThumbHtml(entry.nav)}${esc(entry.label)}</button>
       <span class="muted history-via">${esc(via)}</span>
     </div>`;
  }).join("");
}

// Walk back to a logged door. Re-enters through pushAndGo so it joins the active
// wander and stays returnable (and is itself re-logged as the latest visit).
function replayHistory(key) {
  const entry = _historyByKey[key];
  if (!entry || !entry.nav) return;
  closeWanderMap();
  pushAndGo(entry.label, entry.nav, () => applyNav(entry.nav));
}

// Saved Trails (name a wander, re-walk it later) parked for now (owner
// 2026-07-04: "feels archaic from earlier revs"). loadTrails / saveTrail /
// openTrail / deleteTrail and the /api/trails endpoints are intact in git —
// re-add here to revive. What remains is the live session wander
// (renderSessionHistory), which is the pull-back mechanic, not a saved feature.

// Split in two (T1): showMode just swaps the visible section; loadMode runs the
// section's data loader and returns its promise. setMode does both (the normal
// path), but the wander restore needs to show a mode and then *await* its load
// so it can restore scroll only once the grid is back.
// FB#100/#101 (owner). "Find music, write notes." held the header on every surface —
// and after a while of real use, "my eyes just pan right over it and I don't register
// it anymore. it kind of takes up space." So the line stops being a fixed tagline and
// starts doing work: on Today it says what you're looking at (the eyebrow that used to
// sit above the deck, moved up so the day is framed once, not twice), and on Notebook
// and Explore it says nothing at all — those surfaces name themselves in the tab
// that's lit. The tagline itself isn't retired, it moved: it still opens the first-run
// welcome and leads the About door. (BRAND.md's tagline section records the new home.)
//
// 2026-10-04 (owner): the line names the DAY now — "Released on October 4" — and is the
// whole masthead's text: the wordmark went, leaving the mark in a circle beside this
// line (see the BRAND note in index.html). It's the DECK's day, not the clock's: a deck
// left open past midnight still shows yesterday's records until it reloads, and the
// line has to describe what's on the screen. loadDeck passes the day it's loading.
function subtitleText(mode, md) {
  if (mode !== "decide") return "";
  return `Released on ${mdDisplay(md || (deckState && deckState.key) || mdParam())}`;
}

function setSubtitleFor(mode, md) {
  const el = $("#subtitle");
  if (!el) return;
  const text = subtitleText(mode, md);
  // FB#105 (2026-08-07): this line collapses on Notebook and Explore. The tabs sit in
  // a fixed dock at the foot, so nothing up here can shift them.
  el.textContent = text;
  el.classList.toggle("hidden", !text);
}

// --- The dock: one gliding indicator, a swipe between tabs, a ready search box ---
// Owner, 2026-10-04: "swipe to the left and right on mobile to navigate between the
// tabs. It should slide and snap and be a fun user experience."
// v354: the ☰ is the fourth tab when a menu is mounted (auth-ui), so the order is
// read from the dock rather than fixed: every tab that isn't hidden, left to right.
function tabOrder() {
  return Array.from(document.querySelectorAll(".tabs .tab"))
    .filter((t) => !t.classList.contains("hidden")).map((t) => t.dataset.mode);
}

// The dock's sage bar: ONE element sliding to the lit tab, so a tap glides it and a
// swipe can drag it part-way. Hidden on a surface with no tab. The tabs aren't all one
// width since v354 (the ☰ is narrow), so the bar is placed from the tabs' own boxes —
// a fractional `pos` (mid-swipe) blends the two neighbours' left edge and width, and
// the bar narrows as it glides onto the ☰.
let _tabPos = 0;
function placeTabIndicator(pos) {
  const tabs = document.querySelector(".tabs");
  if (!tabs) return;
  tabs.classList.toggle("no-ind", pos < 0);
  if (pos < 0) return;
  _tabPos = pos;
  const els = Array.from(tabs.querySelectorAll(".tab")).filter((t) => !t.classList.contains("hidden"));
  if (!els.length) return;
  const i = Math.max(0, Math.min(els.length - 1, Math.floor(pos)));
  const j = Math.min(els.length - 1, i + 1);
  const f = Math.max(0, Math.min(1, pos - i));
  const a = els[i], b = els[j];
  tabs.style.setProperty("--ind-x", (a.offsetLeft + (b.offsetLeft - a.offsetLeft) * f) + "px");
  tabs.style.setProperty("--ind-w", (a.offsetWidth + (b.offsetWidth - a.offsetWidth) * f) + "px");
}
// The boxes change when the ☰ tab appears or goes, and when the window turns.
function wireTabIndicator() {
  if (typeof ResizeObserver !== "function") return;
  const ro = new ResizeObserver(() => {
    if (!document.querySelector(".tabs.is-dragging")) placeTabIndicator(_tabPos);
  });
  document.querySelectorAll(".tabs .tab").forEach((t) => ro.observe(t));
}

// (v342 focused Notebook's and Search's box on arrival; the owner turned it off the
// next day — the keyboard took half the screen every time.)

// Where a released swipe goes: "commit" to the neighbour, or "back" to where it was.
// Past ~28% of the width, or a flick (≥0.45 px/ms, same way, past 24px), commits — if
// there IS a neighbour that way. Pure, so the test can pin the feel.
function swipeOutcome(dx, vx, width, hasTarget) {
  if (!hasTarget || !dx) return "back";
  const far = Math.abs(dx) > width * 0.28;
  const flick = Math.abs(vx) >= 0.45 && Math.sign(vx) === Math.sign(dx) && Math.abs(dx) > 24;
  return far || flick ? "commit" : "back";
}

let _swipeBusy = false;          // a settle animation is running
// What slides: the surface and the masthead row above it (the day, or the search
// box), so the whole page moves as one. The ☰ and the dock stay put.
function swipeEls() {
  return [$("#main"), document.querySelector("header .brand")].filter(Boolean);
}
function setSwipeX(x, ms, ease) {
  const W = window.innerWidth || 1;
  const fade = Math.min(0.4, Math.abs(x) / W * 0.6);
  for (const el of swipeEls()) {
    el.style.transition = ms ? `transform ${ms}ms ${ease}, opacity ${ms}ms ${ease}` : "none";
    el.style.transform = x ? `translate3d(${x}px, 0, 0)` : "";
    el.style.opacity = x ? String(1 - fade) : "";
  }
}
// Hand the page back exactly as it was: a transform left on #main would re-anchor every
// position:fixed child inside it.
function clearSwipeX() {
  for (const el of swipeEls()) {
    el.style.transition = ""; el.style.transform = ""; el.style.opacity = "";
    el.style.willChange = "";
  }
}
// The neighbour's NAME rides in with the drag ("Notebook" from the right as Today
// slides left), so the space the page uncovers says where letting go will take you.
// It reaches full strength exactly at the commit distance — a visible "now".
let _swipePeek = null;
function showSwipePeek(dx, label) {
  if (!_swipePeek) {
    _swipePeek = document.createElement("div");
    _swipePeek.className = "swipe-peek";
    _swipePeek.setAttribute("aria-hidden", "true");
    document.body.appendChild(_swipePeek);
  }
  const W = window.innerWidth || 1;
  if (!label || !dx) { _swipePeek.style.opacity = "0"; return; }
  _swipePeek.textContent = label;
  _swipePeek.classList.toggle("from-left", dx > 0);
  _swipePeek.style.transform = `translate3d(${dx}px, -50%, 0)`;
  _swipePeek.style.opacity = String(Math.min(1, Math.abs(dx) / (W * 0.28)));
}
function hideSwipePeek() { if (_swipePeek) _swipePeek.style.opacity = "0"; }

function settleSwipe(x, ms, ease, done) {
  _swipeBusy = true;
  setSwipeX(x, ms, ease);
  let finished = false;
  const fin = () => {
    if (finished) return;
    finished = true;
    clearSwipeX();
    _swipeBusy = false;
    if (done) done();
  };
  setTimeout(fin, ms + 60);     // transitionend can be skipped (a hidden tab, a cut)
}

function wireTabSwipe() {
  if (!("ontouchstart" in window)) return;          // phones and tablets only
  // Things with their own gesture, or nothing to do with tabs.
  // (The floating Feedback chip only: in the hosted build it's a row on the menu page,
  // and a swipe that starts on it is a swipe like any other.)
  const SKIP = "input, textarea, select, [contenteditable], .date-rail, "
    + ".tabs-row, .mf-hint, body > #feedbackBtn, [data-noswipe]";
  const EDGE = 24;      // the system's own edge swipes (back / forward) start here
  const blocked = (target) => {
    if (document.querySelector(".modal:not(.hidden), .set-aside-sheet:not(.hidden)")) return true;
    if (target.closest && target.closest(SKIP)) return true;
    // A row that scrolls sideways keeps its own swipe.
    for (let el = target; el && el !== document.body; el = el.parentElement) {
      if (el.scrollWidth > el.clientWidth + 1) {
        const ox = getComputedStyle(el).overflowX;
        if (ox === "auto" || ox === "scroll") return true;
      }
    }
    return false;
  };
  const reduce = () => reducedMotion();
  let g = null;         // the gesture in progress
  document.addEventListener("touchstart", (e) => {
    g = null;
    if (_swipeBusy || e.touches.length !== 1) return;
    const order = tabOrder();
    const idx = order.indexOf(currentMode());
    const t = e.touches[0];
    const W = window.innerWidth;
    if (idx < 0 || t.clientX < EDGE || t.clientX > W - EDGE || blocked(e.target)) return;
    g = { x0: t.clientX, y0: t.clientY, idx, order, lock: null, dx: 0,
          lastX: t.clientX, lastT: e.timeStamp, vx: 0 };
  }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    if (!g) return;
    const t = e.touches[0];
    const dx = t.clientX - g.x0, dy = t.clientY - g.y0;
    if (!g.lock) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (Math.abs(dx) <= Math.abs(dy) * 1.2) { g = null; return; }   // a scroll: not ours
      g.lock = "x";
      for (const el of swipeEls()) el.style.willChange = "transform, opacity";
      document.querySelector(".tabs")?.classList.add("is-dragging");
    }
    if (e.cancelable) e.preventDefault();          // ours now: no scroll under the finger
    const dt = e.timeStamp - g.lastT;
    if (dt > 0) g.vx = 0.7 * ((t.clientX - g.lastX) / dt) + 0.3 * g.vx;
    g.lastX = t.clientX; g.lastT = e.timeStamp;
    const W = window.innerWidth || 1;
    const nextMode = g.order[g.idx + (dx < 0 ? 1 : -1)];
    const hasTarget = !!nextMode;
    g.dx = hasTarget ? dx : dx * 0.22;             // rubber band past either end
    setSwipeX(g.dx, 0);
    const next = hasTarget && document.querySelector(`.tab[data-mode="${nextMode}"]`);
    // The ☰ tab's name is "Menu" (data-label); the glyph alone would ride in as "☰".
    showSwipePeek(g.dx, next ? (next.dataset.label || next.textContent.trim()) : "");
    placeTabIndicator(Math.max(0, Math.min(g.order.length - 1, g.idx - g.dx / W)));
  }, { passive: false });
  const release = (cancelled) => {
    const st = g; g = null;
    if (!st || st.lock !== "x") return;
    document.querySelector(".tabs")?.classList.remove("is-dragging");
    hideSwipePeek();
    const W = window.innerWidth || 1;
    const dir = st.dx < 0 ? 1 : -1;
    const target = st.order[st.idx + dir];
    const outcome = cancelled ? "back" : swipeOutcome(st.dx, st.vx, W, !!target);
    if (outcome === "back") {
      placeTabIndicator(st.idx);
      if (reduce()) { clearSwipeX(); return; }
      settleSwipe(0, 380, "cubic-bezier(.2, 1.3, .4, 1)");   // a little spring home
      return;
    }
    // Commit: switch, then slide the new surface in from where the old one was headed —
    // it starts one screen beyond the finger and settles with a small overshoot.
    resetWander();
    setMode(target);
    if (reduce()) { clearSwipeX(); return; }
    setSwipeX(st.dx + dir * W, 0);
    void document.body.offsetWidth;                // lock that start position in
    settleSwipe(0, 340, "cubic-bezier(.18, 1.12, .32, 1)");
  };
  document.addEventListener("touchend", () => release(false), { passive: true });
  document.addEventListener("touchcancel", () => release(true), { passive: true });
}

function showMode(mode) {
  if (mode === "choices") mode = "journal";   // legacy: Choices folded into the trail
  _mode = mode;
  // N3: Explore is its own top tab now, so each tab lights only its own mode.
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.mode === mode));
  placeTabIndicator(tabOrder().indexOf(mode));
  $("#decide").classList.toggle("hidden", mode !== "decide");
  $("#forest").classList.toggle("hidden", mode !== "forest");
  $("#browse").classList.toggle("hidden", mode !== "browse");
  $("#journal").classList.toggle("hidden", mode !== "journal");
  $("#menu").classList.toggle("hidden", mode !== "menu");
  // v354: the menu page has no masthead row and no bottom bar (CSS keys off is-menu).
  document.body.classList.toggle("is-menu", mode === "menu");
  // Remember (the trail) + Explore still share one control head — the search slot
  // swaps by mode so the cluster never rearranges (owner 2026-07-04). Remember has
  // no sub-tabs any more; Explore is the catalog search.
  const remember = mode === "journal" || mode === "forest";
  $("#rememberHead").classList.toggle("hidden", !remember);
  // Remember surface collapses the brand to the icon and drops the platforms
  // chooser (owner feedback 2026-07-04); CSS keys off body.is-remember.
  document.body.classList.toggle("is-remember", remember);
  // A8: the genre filter acts on the Today deck, so it shows only on Today
  // (CSS keys off body.is-decide).
  document.body.classList.toggle("is-decide", mode === "decide");
  setSubtitleFor(mode);
  if (remember) {
    // The album-door wander bar has no place on the Remember/Explore tab-roots.
    $("#wanderBar").classList.add("hidden");
    $("#journalSearch").classList.toggle("hidden", mode !== "journal");
    $("#forestFind").classList.toggle("hidden", mode !== "forest");
  }
  // v353: the bottom bar's + is the Notebook's (a new note); the chips follow the tab.
  $("#nbPlus").classList.toggle("hidden", mode !== "journal");
  hideBarSugg();
  renderBarChips();
}

function loadMode(mode) {
  if (mode === "choices") mode = "journal";   // legacy: Choices folded into the trail
  if (mode === "decide") return enterToday();   // U13: reuse the pending deck
  if (mode === "forest") return loadForest();
  if (mode === "browse") return loadBrowse();
  if (mode === "menu") return Promise.resolve();   // v354: auth-ui fills it on mount
  return loadTrail();                          // N3: Remember = one interleaved trail
}

// Feedback #21 (2026-07-07): a door (or overlay) opened on one tab must not linger
// over another — switching top-level tabs closes them all. Each close fn just hides
// its modal + resets its own state, so calling them when already closed is a no-op.
function closeAllDoors() {
  closeStoryModal(); closeArtistPanel(); closePersonPanel(); AOTDLabelPanel.close();
  if (typeof closeYourNotes === "function") closeYourNotes();
  if (typeof closeNoteModal === "function") closeNoteModal();
  if (typeof closeRememberDoor === "function") closeRememberDoor();
  if (typeof closeWanderMap === "function") closeWanderMap();
  closeAsidePile();                // the set-aside pile is a door too (Today only)
  if (_trailSelecting) exitTrailSelection();   // #48 (v2): leave selection on a tab switch
  // (Feedback #21's refinement also collapsed the header's open disclosures here; the
  // last of them, the platforms chooser, was retired in v354.)
  closeStyleBrowse();              // the Filter screen is a door too (v328)
}

// v354: auth-ui shows and hides the Menu tab as a menu mounts and goes, and has to be
// able to step off the menu page when it goes (and re-light the bar when it comes).
window.AOTDTabs = {
  current: () => currentMode(),
  setMode: (mode) => { resetWander(); return setMode(mode); },   // resolves once it's drawn
  relight: () => placeTabIndicator(tabOrder().indexOf(currentMode())),
};

function setMode(mode) {
  // #58/#59: a guest gets the full nav now — Today, Explore, and a Notebook they
  // can actually use (capped at GUEST_NOTE_CAP notes). No tab is gated; the
  // account invitation is contextual instead (the note cap, the "kept on this
  // device" toasts, and the ☰ menu).
  closeAllDoors();                 // #21: no door lingers across a tab switch
  showMode(mode);                  // (showMode also closes the choice reveal)
  // FB#91: the date rail belongs to the Notebook only. Retire it on the way out
  // rather than waiting for the next renderTrail, which may never come if the
  // reader stays on Today.
  syncDateRail();
  return loadMode(mode);
}

// B34/H1.B2: what a Listen tap should do, given the platform key, whether a native
// scheme exists for it, and the device bucket. Pure → unit-tested.
//  • "mac-app" — desktop macOS + Apple: open the always-present Music app via its
//    music:// scheme, no fallback timer. Chrome's "Open Music?" prompt keeps the
//    page put (the app opens beside it), so a timer would only double-open the web
//    player. Apple ONLY: Music.app ships with every Mac; no other desktop app is
//    guaranteed installed, so the rest keep their honest web link on desktop.
//  • "mobile" — phone with a native scheme: try it, fall back to the web link.
//  • "web" — let the anchor's own link run. Two cases land here: everything with
//    no better path (unchanged), and — deliberately — iOS Apple, where we WANT the
//    genuine anchor tap to fire so iOS routes the Apple Music Universal Link
//    (https://music.apple.com/…) to the app. That's more reliable than the music://
//    custom scheme and degrades to the web player, with no error alert, when the
//    app is absent (B34). wireExternalLinksStandalone has the matching exception so
//    an installed PWA doesn't swallow the hand-off.
function listenTapMode(key, hasScheme, platform) {
  if (platform === "mac-desktop")
    return (key === "apple" && hasScheme) ? "mac-app" : "web";
  if (platform === "ios")
    return key === "apple" ? "web" : (hasScheme ? "mobile" : "web");
  if (platform === "android")
    return hasScheme ? "mobile" : "web";
  return "web";
}

// H1.B2: one delegated handler for the streaming deep links. On a phone, tapping
// a service with a native scheme tries the app first and falls back to the web
// URL if the app doesn't take over within a beat (i.e. isn't installed) — which
// is exactly the plain-web behavior we had before, so nothing regresses. On a
// desktop Mac, Apple opens the native Music app (B34); every other desktop case
// and any service without a scheme just follows the normal web link.
function wireDeepLinks() {
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a[data-app],a[data-intent]");
    if (!a) return;
    const key = a.getAttribute("data-listen") || "";
    const web = a.href;
    // Android prefers the intent: form when present (YT Music has no public
    // scheme); iOS ignores it and uses the plain scheme — or, with neither,
    // falls through to the default anchor (new context → universal link).
    const scheme = (/Android/i.test(navigator.userAgent || "")
      && a.getAttribute("data-intent")) || a.getAttribute("data-app");
    const platform = uaPlatform(navigator.userAgent, navigator.maxTouchPoints || 0);
    const mode = listenTapMode(key, !!scheme, platform);
    if (mode === "web") return;

    if (mode === "mac-app") {
      // Desktop macOS + Apple: hand straight to the native Music app. The page
      // stays put (the external-protocol prompt doesn't navigate it), so Music
      // Forest is untouched and no fallback is needed — Music.app is always
      // installed on macOS, so the scheme always resolves.
      e.preventDefault();
      window.location.href = a.getAttribute("data-app");
      return;
    }

    // mode === "mobile":
    e.preventDefault();
    let settled = false;
    const cleanup = () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onLeave);
    };
    const onLeave = () => { settled = true; clearTimeout(timer); cleanup(); };
    const onHide = () => { if (document.hidden) onLeave(); };
    // If the app opens, the page is backgrounded (visibility/pagehide) and we
    // cancel the fallback. If not, open the website like before.
    const timer = setTimeout(() => {
      cleanup();
      if (settled) return;
      // The app didn't take over (it isn't installed) — open the web link WITHOUT
      // destroying the app's state (B29).
      //  • Standalone PWA: no tab to lose, so open a separate browser context;
      //    never navigate the app's only window.
      //  • Normal tab: try a real new tab first (keeps Music Forest exactly where
      //    it was). This window.open fires ~1.4 s after the tap, so the gesture may
      //    have expired and iOS may block the popup — in which case fall back to
      //    the in-place nav we've always done (survivable: back button + resume-at,
      //    B28). So this is strictly no worse than before, and better when allowed.
      if (isStandalone()) {
        window.open(web, "_blank", "noopener");
      } else {
        const w = window.open(web, "_blank");
        if (w) { try { w.opener = null; } catch (err) { /* older engines */ } }
        else { window.location.href = web; }
      }
    }, 1400);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onLeave, { once: true });
    window.location.href = scheme;   // attempt the native app
  });
}

// The listen-tap beacon: ONE anonymous count when an outward door is actually
// walked through (owner ask 2026-07-19) — the door-resolution counter fires on
// show, so it can't say this. sendBeacon so the count survives the navigation it
// rides on and never delays it. Counts only: the service key + the coarse tier
// (same posture as clientMode()'s header) — no album, no URL, no identity, so
// the server can never say who listened to what.
// Where a tapped link came from, for the Log (2026-10-07): "warm" — today's record, and
// the link came with the day (pre-warmed); "new" — today's record, link looked up when it
// was opened (the door); "other" — a record from another date (Search, the Notebook, an
// artist page). One coarse word; no album, no person.
const _dayLinks = new Map();          // uid -> Set of platform keys the day's list carried
function noteDayLinks(albums) {
  _dayLinks.clear();
  for (const r of albums || []) {
    const k = albumKey(r);
    if (k) _dayLinks.set(k, new Set(Object.keys(r.platforms || {})));
  }
}
function listenSource(anchor) {
  const uid = uidForListen(anchor);
  const warm = uid && _dayLinks.get(uid);
  if (!warm) return "other";
  return warm.has(anchor.dataset.listen) ? "warm" : "new";
}
function wireListenCount() {
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a[data-listen]");
    if (!a || !navigator.sendBeacon) return;
    try {
      navigator.sendBeacon("/api/usage/listen?svc="
        + encodeURIComponent(a.dataset.listen) + "&tier=" + clientMode()
        + "&src=" + listenSource(a));
    } catch (err) { /* a counter never breaks a listen */ }
  });
}

// --- Opened (v9, owner 2026-10-03) ---------------------------------------------
// Keep was retired: writing a note is how a record becomes yours, and tapping Listen
// leaves a quiet "Opened in Spotify" entry in the Notebook on its own. It records the
// TAP — never "listened", which the app can't know (the honesty rule). One entry per
// record per local day, whichever service and however many taps. Unlike the anonymous
// count above, this is the reader's OWN history: it goes to their journal (encrypted
// for an account, on-device for a guest, journal.db for the local build), never to us.
const _openedToday = new Set();      // uids opened on _openedDay
let _openedDay = null;
function openedToday(uid) {
  const day = todayFull();
  if (_openedDay !== day) { _openedToday.clear(); _openedDay = day; }
  return !!uid && _openedToday.has(uid);
}

// The record a Listen anchor belongs to: today's card, an Explore/browse card, or the
// record Album details is showing. null when it can't be told (then nothing is written).
function uidForListen(anchor) {
  if (anchor.closest("#storyHead") && storyRid) return storyRid;
  const host = anchor.closest(".deck-card[data-uid], .card[data-rid], #listenSheet[data-uid]");
  return host ? (host.dataset.uid || host.dataset.rid || null) : null;
}

// Keep today's "✓ in Notebook" mark (under the title since v352) telling the truth.
function repaintDeckListen() {
  const el = document.getElementById("deckOpened");
  if (!el || !deckState || deckState.idx >= deckState.records.length) return;
  el.innerHTML = deckOpenedHtml(albumKey(deckState.records[deckState.idx]));
}

async function recordOpened(uid, service) {
  if (!uid || openedToday(uid)) return;     // already in today's Notebook
  _openedToday.add(uid);
  repaintDeckListen();
  const a = albumData[uid] || albumIndex[uid] || {};
  let ok = false;
  try {
    const r = await fetch("/api/opened", {
      method: "POST", keepalive: true,      // the tap is usually leaving the page
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid, service, day: todayFull(),
        artist: a.artist || "", title: a.title || "" }),
    });
    ok = r.ok && !!(await r.json()).ok;
  } catch (e) { /* offline: an account's store keeps the row pending and replays it */ }
  if (!ok) { _openedToday.delete(uid); repaintDeckListen(); }   // the tag never lies
}

function wireOpenedTap() {
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a[data-listen]");
    if (!a) return;
    const uid = uidForListen(a);
    if (uid) recordOpened(uid, a.dataset.listen);
  });
}

// Re-learn which records were opened today from the journal itself — at boot, on
// unlock (an account's store is empty until then) and after a sync brings in a tap
// from another device — so the tag survives a reload and agrees across devices.
async function loadOpenedToday() {
  try {
    const r = await fetch("/api/opened");
    if (!r.ok) return;
    const d = await r.json();
    const day = todayFull();
    openedToday(null);                      // roll the day over if it changed
    for (const o of (d.opened || [])) if (o.day === day && o.uid) _openedToday.add(o.uid);
    repaintDeckListen();
  } catch (e) { /* the tag is a courtesy; the Notebook is the record */ }
}

// #5: keep external links from swallowing the installed app. In a standalone PWA
// there are no tabs, so any cross-origin link replaces the app's only window —
// the "I opened a Listen link and couldn't get back" papercut. Reroute those to
// a separate browser context so the app stays exactly where it was. Gated to
// standalone + plain left-clicks; in a normal browser tab this does nothing, so
// the native new-tab behavior is untouched. Runs after wireDeepLinks, so a
// data-app deep link (which calls preventDefault) is left alone.
function wireExternalLinksStandalone() {
  if (!isStandalone()) return;
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented) return;                       // deep-link took it
    if (e.button !== 0 || e.metaKey || e.ctrlKey ||
        e.shiftKey || e.altKey) return;
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    // B34: on iOS, let an Apple Music Universal Link navigate natively so the OS
    // can hand off to the Music app — window.open would open the web player inside
    // the PWA's webview instead. If the app is absent it opens the web player in
    // place, survivable via the back gesture + resume-at (B28).
    if (a.getAttribute("data-listen") === "apple" &&
        uaPlatform(navigator.userAgent, navigator.maxTouchPoints || 0) === "ios") return;
    const href = a.href || "";
    if (!/^https?:\/\//i.test(href)) return;              // only real web links
    if (a.origin === location.origin) return;             // internal stays in-app
    e.preventDefault();
    window.open(href, "_blank", "noopener");
  });
}

// Apply a new pref array everywhere. `membershipChanged` distinguishes a set
// change (add/remove — what surfaces changes, so refetch/redraw the pool) from a
// pure reorder (the same albums surface, only priority changed — just restack the
// listen buttons on screen; never redraw the deck).
function commitListenPrefs(next, membershipChanged) {
  saveListenPrefs(next);
  applyListenPrefStyle(next);
  flashListenReflow();
  if (membershipChanged) refreshSurfaces();
  else repaintChoiceListen();
}

// FB#105: the first-run welcome asks where you listen, and onboarding.js needs the
// platform list, the current selection, and a way to toggle one. It gets them through
// here rather than keeping its own copy: CONFIRMED_PLATFORMS, the storage key and the
// commit path (which re-applies the door filter and refetches the pool) all stay owned
// by this file, so the welcome can't drift out of step with More ways to listen — they
// are two views of one preference.
window.AOTDPlatforms = {
  list: () => CONFIRMED_PLATFORMS.map(([key, , label]) => ({ key, label })),
  selected: () => loadListenPrefs(),
  toggle: (key) => togglePlatformPref(key),
};

function togglePlatformPref(key) {
  if (!_platClass[key]) return;
  const sel = loadListenPrefs();
  const next = sel.includes(key)
    ? sel.filter((k) => k !== key)   // remove
    : sel.concat(key);               // add to the end of the priority order
  commitListenPrefs(next, true);
}

// Copy an "artist title" search string to the clipboard (F#10) — the honest
// alternative to a blind "search on <service>" button for albums we can't confirm
// a link for. One delegated handler covers every .copy-search button (pick +
// story head). Falls back to a hidden-textarea execCommand copy where the async
// Clipboard API isn't available (older WebViews / insecure contexts).
function wireCopySearch() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest && e.target.closest(".copy-search");
    if (!btn) return;
    const q = btn.dataset.q || "";
    const done = () => {
      if (btn.dataset.copied) return;                 // already flashing
      btn.dataset.copied = "1";
      btn.classList.add("copied");
      // The confirmation swaps the text of a dedicated `.cs-label` span. A copy
      // control WITHOUT one flashes the class only — it used to fall back to the
      // button itself, which meant writing "Copied ✓" over the element's entire
      // innerHTML. Harmless when the button was just text; destructive for the
      // FB#105 identity block, whose "label" is the record's heading, date and
      // glyph — that swap would have flattened the title and never restored the
      // markup. Structure decides, so a future copy control can't hit this either.
      const label = btn.querySelector(".cs-label");
      const prev = label ? label.textContent : null;
      if (label) label.textContent = "Copied ✓";
      setTimeout(() => {
        if (label) label.textContent = prev;
        btn.classList.remove("copied");
        delete btn.dataset.copied;
      }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(q).then(done).catch(() => legacyCopy(q, done));
    } else {
      legacyCopy(q, done);
    }
  });
}
function legacyCopy(text, done) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    done();
  } catch (e) { /* clipboard blocked: leave the string visible to copy by hand */ }
}

// --- F26: the remember door --------------------------------------------------
// "What's an album you remember?" — one search box with note-intent, the same
// door for both hands: the guest's first taste of the journal (their reflection
// is real — buffered on-device by store-bridge, carried through signup), and
// the signed-in "write about any album" path on the Remember tab. Pure pull:
// you reach for it and name the record yourself. Choosing a result opens the
// album's own story view (a Trail-recorded door) with the reflect window
// already up over it.
let _remTimer = null;
const REMEMBER_HINT =
  `<p class="muted">Search every album on file — any date, any year.</p>`;

function openRememberDoor() {
  const inp = $("#rememberSearch");
  if (!inp) return;
  inp.value = "";
  $("#rememberResults").innerHTML = REMEMBER_HINT;
  $("#rememberModal").classList.remove("hidden");
  inp.focus();
}

function closeRememberDoor() {
  const m = $("#rememberModal");
  if (m) m.classList.add("hidden");
}

async function rememberDoorSearch(q) {
  const box = $("#rememberResults");
  if (!box) return;
  if (!q) { box.innerHTML = REMEMBER_HINT; return; }
  try {
    const data = await (await fetch("/api/search?" +
      new URLSearchParams({ q }), SEARCH_OPTS())).json();
    if ($("#rememberSearch").value.trim() !== q) return;   // stale response
    const albums = (data.albums || []).slice(0, 12);
    if (!albums.length) {
      // Honesty rule: un-crawled is UNKNOWN — "we may not have it", never
      // "it doesn't exist".
      box.innerHTML = `<p class="muted">Nothing on file under that — try
        another spelling, or just the artist. (We may simply not have this
        one yet.)</p>`;
      return;
    }
    box.innerHTML = albums.map((a) => {
      const key = albumKey(a);
      // Teach the shared indexes so the story view + note modal open fully
      // even for an album no card has rendered this session.
      if (!albumData[key]) albumData[key] = a;
      rememberNames(key, a.artist, a.title);
      const year = a.year || String(a.released || "").slice(0, 4);
      return `<button type="button" class="rem-row" data-rid="${esc(key)}">
        <span class="rem-name">${esc(a.artist)} — ${esc(a.title)}</span>
        ${year ? `<span class="rem-year">${esc(String(year))}</span>` : ""}
      </button>`;
    }).join("");
  } catch (e) {
    box.innerHTML = `<p class="muted">Search isn’t reachable right now — try
      again in a moment.</p>`;
  }
}

function wireRememberDoor() {
  const inp = $("#rememberSearch");
  if (!inp) return;
  inp.addEventListener("input", () => {
    clearTimeout(_remTimer);
    const q = inp.value.trim();
    _remTimer = setTimeout(() => rememberDoorSearch(q), 250);
  });
  $("#rememberClose").addEventListener("click", closeRememberDoor);
  $("#rememberModal").addEventListener("click", (e) => {
    if (e.target.id === "rememberModal") closeRememberDoor();
  });
  // The welcome screen (onboarding.js) offers the same door.
  window.AOTDRememberDoor = { open: openRememberDoor };
}

// ACC1 Theme B: shared accessible-dialog behavior for the app's 13 modals. Each
// modal just toggles its `hidden` class; rather than edit every open/close, one
// MutationObserver per `.modal` layers on the dialog pattern the interactive demo
// showed: on open, remember the opener + name the dialog (role/aria-modal/
// aria-labelledby) + move focus in; while open, Tab is trapped within the topmost
// dialog and Esc closes it through its own ✕ (so the real cleanup runs); on close,
// focus returns to the opener (or to the parent dialog if one is still open).
// Additive — no open/close function changes. The auth gate (`.auth-gate`, not a
// `.modal`) self-manages its focus, so this leaves it alone.
function wireDialogA11y() {
  const stack = [];                 // [{el, trigger}] — nested dialogs; last is topmost
  let lastOutside = null;           // last focus OUTSIDE any dialog = the opener
  document.addEventListener("focusin", (e) => {
    if (e.target && e.target.closest && !e.target.closest(".modal")) lastOutside = e.target;
  });
  const SEL = 'a[href], button:not([disabled]), input:not([disabled]), ' +
    'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const focusables = (el) => Array.from(el.querySelectorAll(SEL))
    .filter((n) => n.getClientRects().length > 0);
  function nameDialog(el) {
    if (!el.getAttribute("role")) el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    if (!el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby")) {
      const h = el.querySelector("h1, h2, h3, h4");
      if (h) {
        if (!h.id) h.id = "dlg-h-" + Math.random().toString(36).slice(2, 8);
        el.setAttribute("aria-labelledby", h.id);
      }
    }
  }
  function onOpen(el) {
    if (stack.some((s) => s.el === el)) return;
    nameDialog(el);
    // The opener = whatever holds focus right now (this runs before we move focus
    // in). If the modal already focused something inside itself, fall back to the
    // last-tracked focus outside any dialog. Reading activeElement directly (not only
    // the focusin-tracked value) makes restore work even where focusin doesn't fire.
    const active = document.activeElement;
    const trigger = (active && !el.contains(active) && active !== document.body)
      ? active : lastOutside;
    stack.push({ el, trigger });
    // Respect a modal that already placed focus inside itself (e.g. a text field);
    // only pull focus in when it is still outside the dialog.
    //
    // Focus the DIALOG, not its ✕ (owner, on-device: "the X is huge in the upper
    // right hand corner and is highlighted for some reason"). Focusing the close
    // button moved the ring onto a control nobody chose — and on a phone that ring is
    // the first time the 44px touch box becomes visible, so a correct target looked
    // like a rendering bug. Focusing the dialog container is the standard pattern and
    // does the same work: the dialog is announced, Escape closes it, and the first Tab
    // still lands on the first control inside. tabindex=-1 makes it programmatically
    // focusable without adding it to the tab order; the outline is suppressed in CSS
    // because a container isn't a control the user navigated to.
    if (!el.contains(document.activeElement)) {
      const box = el.matches(".modal-box, .onboard-card, .auth-card")
        ? el : el.querySelector(".modal-box, .onboard-card, .auth-card");
      const target = box || focusables(el)[0];
      if (target) {
        try {
          if (target === box && !target.hasAttribute("tabindex")) target.tabIndex = -1;
          target.focus({ preventScroll: true });
        } catch (e) {}
      }
    }
  }
  function onClose(el) {
    const i = stack.findIndex((s) => s.el === el);
    if (i === -1) return;
    const { trigger } = stack.splice(i, 1)[0];
    if (stack.length) {                          // a parent dialog is still open
      const f = focusables(stack[stack.length - 1].el)[0];
      if (f) { try { f.focus(); } catch (e) {} }
    } else if (trigger && document.contains(trigger)) {
      try { trigger.focus(); } catch (e) {}
    }
  }
  // One capture-phase key handler: Esc closes the topmost dialog (superseding the
  // older ad-hoc Esc logic while any dialog is open — stack order handles nesting),
  // Tab stays trapped inside it.
  document.addEventListener("keydown", (e) => {
    if (!stack.length) return;
    const top = stack[stack.length - 1].el;
    if (e.key === "Escape") {
      const close = top.querySelector(".modal-close");
      // stopImmediatePropagation (not just stopPropagation): an Escape that closes a
      // modal is *consumed*, so no other document-level Escape handler also fires on
      // it — notably the first-run tour's, which would otherwise end/disturb the tour
      // when you Escape the album door it told you to open. (Only reached when a modal
      // is on the stack; a bare Escape falls through so the tour can still dismiss.)
      if (close) { e.preventDefault(); e.stopImmediatePropagation(); close.click(); }
      return;
    }
    if (e.key === "Tab") {
      const f = focusables(top);
      if (!f.length) { e.preventDefault(); return; }
      e.preventDefault();
      const i = f.indexOf(document.activeElement);
      const next = e.shiftKey
        ? (i <= 0 ? f[f.length - 1] : f[i - 1])
        : (i === -1 || i === f.length - 1 ? f[0] : f[i + 1]);
      next.focus();
    }
  }, true);
  // Watch every static modal for a hidden -> visible (or back) transition.
  document.querySelectorAll(".modal").forEach((el) => {
    let wasHidden = el.classList.contains("hidden");
    new MutationObserver(() => {
      const isHidden = el.classList.contains("hidden");
      if (isHidden === wasHidden) return;
      wasHidden = isHidden;
      if (!isHidden) onOpen(el); else onClose(el);
    }).observe(el, { attributes: true, attributeFilter: ["class"] });
  });
}

function init() {
  wireDialogA11y();
  applyListenPrefStyle(loadListenPrefs());            // apply the saved door filter on load
  wireGenrePref();
  wireStyleBrowse();
  wireFirstRun();
  wireTabSwipe();
  wireTabIndicator();
  wireRememberDoor();
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => {
      // A deliberate top-level move ends the current wander (you've left, not
      // backed out) — the breadcrumb is for pulls, not tab-switching.
      resetWander();
      setMode(t.dataset.mode);
    }));
  // (#9/#10's logo-tap back to Today went with the logo, 2026-10-04: the masthead is the
  // day alone now, and the dock's Today tab is the way back from anywhere.)
  wireDeepLinks();
  // FB#91: the date rail follows ordinary scrolling (so the thumb always says where
  // you are) and re-measures when the viewport changes, since whether it shows at
  // all depends on the notebook being taller than ~1.5 screens.
  window.addEventListener("scroll", onScrollSyncRail, { passive: true });
  window.addEventListener("resize", syncDateRail, { passive: true });
  wireListenCount();               // anonymous listen-tap count (svc + tier only)
  wireOpenedTap();                 // v9: the reader's own "opened" Notebook entry
  wireListenSheet();               // v350: the ⌄ on Today's Listen button
  loadOpenedToday();
  wireExternalLinksStandalone();   // #5: keep the installed app from being replaced
  wireCopySearch();                // copy an "artist — title" search string (F#10)
  // Tiny build readout in the footer so "which version am I on?" is answerable at
  // a glance (feedback #11). Tracks window.__MF_BUILD, bumped with the SW shell.
  const buildTag = document.getElementById("buildTag");
  if (buildTag) buildTag.textContent = window.__MF_BUILD || "";
  // U24: the always-present floating Trail button is gone; the wander map opens from
  // the wander breadcrumb (data-wmap) while you're actively wandering.
  // Explore search: a full-width input matching the journal search (same slot,
  // same look). Submit (Enter) pulls the term through the catalog as an
  // all-fields door, returnable via the wander stack.
  // Explore search: live as you type (debounced) plus an explicit submit. Both
  // render full-catalog results in place (#forestBody) via runExploreSearch —
  // no jump to Browse, no wander door to manage (U21).
  $("#forestFind").addEventListener("submit", (e) => {
    e.preventDefault();
    clearTimeout(_exploreDebounce);
    if (pickFirstBarSugg()) return;          // Enter on a day picks it
    runExploreSearch($("#forestSearchInput").value);
  });
  $("#forestSearchInput").addEventListener("input", () => {
    clearTimeout(_exploreDebounce);
    _exploreDebounce = setTimeout(
      () => runExploreSearch($("#forestSearchInput").value), 280);
  });
  // F33's exact-day searcher lives in the bottom bar since v353: a typed day ("oct 5",
  // "10/5") is offered as "Records released on October 5" (renderBarSugg), its chip's ✕
  // returns to text search. Filter's "See a specific day →" focuses the bar.
  const dayBtn = document.getElementById("specificDayBtn");
  if (dayBtn) dayBtn.addEventListener("click", gotoSpecificDay);
  // Today's set-aside pile (D2): the bottom bar pulls the pile open; ✕ / backdrop
  // close it. The list's "Bring back" buttons + the deck's end-state links are
  // handled by the delegated click below.
  const asideBar = $("#setAsideBar");
  if (asideBar) {
    asideBar.addEventListener("click", openAsidePile);
    asideBar.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openAsidePile(); }
    });
  }
  $("#setAsideClose").addEventListener("click", closeAsidePile);
  $("#setAsideSheet").addEventListener("click", (e) => {
    if (e.target.id === "setAsideSheet") closeAsidePile();
  });
  // Delegated Today actions: bring a set-aside record back; the deck end-state's
  // jumps (Notebook, open the pile, Explore). Dig-deeper rides the shared
  // [data-dig-escape] handler below.
  document.addEventListener("click", (e) => {
    const bring = e.target.closest("[data-bring]");
    if (bring) { bringBack(bring.dataset.bring); return; }
    if (e.target.closest("[data-open-aside]")) { openAsidePile(); return; }
    if (e.target.closest("[data-goto-notebook]")) { setMode("journal"); return; }
    if (e.target.closest("[data-goto-explore]")) { setMode("forest"); return; }
    if (e.target.closest("[data-share-album]")) { shareAlbum(albumData[storyRid]); return; }
    // #80: share anyone — the artist / person / label doors, each keyed by the panel
    // vars the door already tracks (mirrors data-share-album reading storyRid).
    if (e.target.closest("[data-share-artist]")) { shareArtist(artistPanelName); return; }
    if (e.target.closest("[data-share-label]")) { shareLabel(AOTDLabelPanel.currentName()); return; }
    if (e.target.closest("[data-share-person]")) { sharePerson(personPanelId, personPanelName); return; }
    if (e.target.closest("[data-clear-genres]")) { clearGenreFilter(); return; }
    if (e.target.closest("[data-change-filters]")) { openStyleBrowse(); return; }
    // v354: the platforms live in More ways to listen only (the ☰ chooser is gone).
    if (e.target.closest("[data-change-platforms]")) { openListenSheet(); return; }
    // Deck-end thin-filter hint: clear the platform filter → the full day redraws.
    if (e.target.closest("[data-clear-platforms]")) { commitListenPrefs([], true); return; }
  });
  // Search box: filter the loaded day live, or (in all-dates mode) debounce a
  // full-catalog search on the server.
  $("#search").addEventListener("input", () => {
    if (browseScope === "day") { applyBrowseFilters(); return; }
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(runSearch, 280);
  });
  $("#scope").addEventListener("change", () => {
    decadeBrowse = null;                  // manual scope change leaves the door
    browseScope = $("#scope").value;
    $("#onlyDayWrap").classList.toggle("hidden", browseScope !== "all");
    updateDigVisibility();
    $("#search").placeholder = browseScope === "all"
      ? "Search every album, across all dates…"
      : "Filter by artist, title, style…";
    loadBrowse();
  });
  $("#onlyDay").addEventListener("change", () => {
    if (browseScope === "all") runSearch();
  });
  // Dig deeper (Today): redraw the deck from the full union (availability gate off)
  // vs the listenable pool. Forces a fresh deck from the newly-scoped pool.
  const digToggle = $("#digToggle");
  if (digToggle) digToggle.addEventListener("change", () => {
    digMode = digToggle.checked;
    loadDeck(true);
  });
  updateDigVisibility();
  // The filtered empty-state's "Dig deeper" escape hatch: flip dig on (which is
  // always unfiltered) and reload whichever surface the button is sitting in.
  document.addEventListener("click", (e) => {
    if (!e.target.closest("[data-dig-escape]")) return;
    digMode = true;
    if (digToggle) digToggle.checked = true;
    if (currentMode() === "browse") loadBrowse();
    else loadDeck(true);
  });
  $("#fieldFilter").addEventListener("change", () => {
    if (browseScope === "all") runSearch();
    else applyBrowseFilters();
  });
  // Sort/decade re-apply locally; in all-dates mode don't re-filter by text.
  $("#sort").addEventListener("change", () => applyBrowseFilters(browseScope === "day"));
  $("#decadeFilter").addEventListener("change", () => applyBrowseFilters(browseScope === "day"));
  // Genre chips: toggle selection (multi-select, OR semantics).
  $("#genreChips").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    const g = chip.dataset.genre;
    if (selectedGenres.has(g)) selectedGenres.delete(g);
    else selectedGenres.add(g);
    chip.classList.toggle("active");
    applyBrowseFilters();
  });

  // Delegated handlers for per-card buttons (fix art, log listen, add note),
  // journal deletes — one listener covers everything.
  document.addEventListener("click", (e) => {
    // Album details: the pencil on a track / linked credit / artist thread ties a
    // note straight to that entity. It's a sibling of the door button (never nested),
    // so this fires first and stops the door's own click from following.
    const pen = e.target.closest(".note-pen");
    if (pen) {
      e.stopPropagation();
      if (_lpFired) { _lpFired = false; return; }   // a long-press already opened it
      const anchor = pen.closest(".note-anchor");
      if (anchor) openNoteForAnchor(anchor);
      return;
    }
    // F34: an Explore "Artists" hit opens that artist's catalogue door.
    const artistHit = e.target.closest(".artist-hit");
    if (artistHit) { e.stopPropagation(); openArtistPanel(artistHit.dataset.artist); return; }
    // FB#37: an Explore "Songs" hit is a door to that song's album — open it and
    // flag the matched track to flash when the tracklist renders.
    const songHit = e.target.closest(".song-hit");
    if (songHit) {
      e.stopPropagation();
      _songHitFlash = { uid: songHit.dataset.songUid, pos: songHit.dataset.songPos };
      openAlbumByUid(songHit.dataset.songUid);
      return;
    }
    // T1 wander: breadcrumb / map navigation.
    const wmap = e.target.closest("[data-wmap]");
    if (wmap) { e.stopPropagation(); openWanderMap(); return; }
    const wgoto = e.target.closest("[data-wgoto]");
    if (wgoto) { e.stopPropagation(); gotoNode(+wgoto.dataset.wgoto); return; }
    const hstep = e.target.closest(".history-step");
    if (hstep) { e.stopPropagation(); replayHistory(hstep.dataset.histkey); return; }
    const artist = e.target.closest(".artist-link");
    if (artist) { e.stopPropagation(); searchArtist(artist.dataset.artist); return; }
    const note = e.target.closest(".note-btn");
    if (note) {
      e.stopPropagation();
      // N1 Step 1: "✎ Your notes" opens the inward door (your words for this
      // album + the composer), not a bare composer. Guests write for real
      // (buffered on-device, migrates at signup); the keep-invitation lives on
      // the save toast.
      openYourNotes(note.dataset.rid);
      return;
    }
    // #61: the "can't find it" door (filtered-empty Explore, ☰ menu) → the
    // record-request mail draft, seeded with the current Explore query.
    const reqRec = e.target.closest("[data-request-record]");
    if (reqRec) {
      e.stopPropagation();
      openRecordRequest((($("#forestSearchInput") || {}).value) || "");
      return;
    }
    // #58: the guest Notebook's "lives only in this browser" line → the account
    // gate (the durability pay-moment; a guest's notes come with them at signup).
    const gkeep = e.target.closest("[data-guest-keep]");
    if (gkeep) {
      e.stopPropagation();
      if (window.AOTDAuth && AOTDAuth.showGate) AOTDAuth.showGate("keep");
      return;
    }
    // F26: any [data-remember-door] control — the guest Choose line, the
    // Remember tab's ✎ door, the notes empty state, the welcome screen —
    // opens the remember door.
    const rem = e.target.closest("[data-remember-door]");
    if (rem) { e.stopPropagation(); openRememberDoor(); return; }
    // A result row (N1 Step 1): the album's Your notes door opens with the
    // composer already up — you found the record you remember; now write about it.
    const remRow = e.target.closest(".rem-row");
    if (remRow) {
      e.stopPropagation();
      const rid = remRow.dataset.rid;
      closeRememberDoor();
      openYourNotes(rid, { compose: true });
      return;
    }
    // U3 / N1 Step 1: open the Album details door (the record's own story), or
    // pull one of its threads through the catalog. `.ynotes-details` is the same
    // door reached from inside the Your notes door.
    const story = e.target.closest(".story-btn, .ynotes-details");
    if (story) { e.stopPropagation(); closeYourNotes(); openAlbumByUid(story.dataset.rid); return; }
    // FB#46: a promoted composer thread opens that person's door (it wears
    // .story-thread for the chip look, so catch it BEFORE the field-based routing).
    const composer = e.target.closest(".pull-composer");
    if (composer) {
      e.stopPropagation();
      openPersonPanel(composer.dataset.pid, composer.dataset.name);
      return;
    }
    const thread = e.target.closest(".story-thread");
    if (thread) {
      e.stopPropagation();
      // A2 / T2: the artist and label threads each open their own bounded panel
      // (a finite, surveyable catalogue → a door); genre and the "chosen over"
      // title stay catalog pulls. T1: pulls record themselves on the return
      // stack and close any open door, so returning re-opens it — don't pre-close.
      const f = thread.dataset.field;
      if (f === "artist") openArtistPanel(thread.dataset.term);
      else if (f === "label") AOTDLabelPanel.open(thread.dataset.term);
      else searchCatalog(f, thread.dataset.term);
      return;
    }
    // A3: the decade door — a queryless catalog browse, not an FTS pull.
    const decThread = e.target.closest(".pull-decade");
    if (decThread) {
      e.stopPropagation();
      searchDecade(decThread.dataset.decade);
      return;
    }
    // F27: a linked credit in the room opens that person's door; "show all N"
    // expands a big room in place (a pull, not a jump).
    const credit = e.target.closest(".credit-door");
    if (credit) {
      e.stopPropagation();
      openPersonPanel(credit.dataset.pid, credit.dataset.name);
      return;
    }
    const roomAll = e.target.closest(".room-all");
    if (roomAll) {
      e.stopPropagation();
      renderStoryRoom(storyRoomData, true);
      return;
    }
    // F27-1b: expand the pressings lineage in place; a pressing row opens
    // that release's own story view (its own sleeve, its own room).
    const pressOpen = e.target.closest(".press-open");
    if (pressOpen) {
      e.stopPropagation();
      renderStoryPressings(storyPressData, true);
      return;
    }
    const pressRow = e.target.closest(".press-row[data-press-rid]");
    if (pressRow) {
      e.stopPropagation();
      openAlbumByUid("d:" + pressRow.dataset.pressRid);
      return;
    }
    // A4: open the artist-bio door (stays inside the story modal — a pull, not
    // a jump). Fetched only on this click; nothing is surfaced unbidden.
    const bioOpen = e.target.closest(".story-bio-open");
    if (bioOpen) { e.stopPropagation(); loadStoryBio(); return; }
    const artistBioOpen = e.target.closest(".artist-bio-open");
    if (artistBioOpen) { e.stopPropagation(); loadArtistBio(); return; }
    const edit = e.target.closest(".jedit");
    if (edit) {
      e.stopPropagation();
      // Notes render in TWO places now: the Your notes door (N1 Step 1) and, since
      // FB#89, a section inside Album details. The note object and the record to
      // compose against both come from the DOM the note is sitting in — a
      // `[data-notes-for]` container names its album — falling back to the Your-notes
      // door's own state. Reading the surface rather than a single global is what
      // lets one delegate serve both without either knowing about the other.
      const host = edit.closest("[data-notes-for]");
      const rid = (host && host.dataset.notesFor) || yourNotesRid;
      const pool = (host && _storyNotesData.length ? _storyNotesData : yourNotesData) || [];
      const n = pool.find((x) => x.id === +edit.dataset.note)
             || yourNotesData.find((x) => x.id === +edit.dataset.note);
      if (n && rid != null) openNoteModal(rid, n);
      return;
    }
    const del = e.target.closest(".jdel");
    if (del) { e.stopPropagation(); deleteNote(del.dataset.note); return; }
    // T3: the Forest empty-state invitation jumps to Choose.
    const goChoose = e.target.closest("[data-go-choose]");
    if (goChoose) { e.stopPropagation(); resetWander(); setMode("decide"); return; }
    // Clicking a connection is a *pull*: it searches your journal for that
    // thread. Nothing is ever surfaced unbidden (VISION.md).
    const nc = e.target.closest(".nc-chip[data-nc-value]");
    if (nc) {
      e.stopPropagation();
      closeStoryModal();
      setMode("journal");
      $("#journalSearch").value = nc.dataset.ncValue;
      loadTrail(true);
      return;
    }
    // A note card in the Remember view opens its Your notes door (N1 Step 1) — your
    // words for that album, with the composer to add more and an "Album details"
    // link out to wander its threads. The notes glow on arrival so you see your own
    // words land.
    const scard = e.target.closest(".shelf-card");
    if (scard) {
      if (e.target.closest("a, button:not(.card-hit), summary")) return;   // inner links keep theirs
      _yourNotesArrived = true;
      openYourNotes(scard.dataset.shelfRid);
      return;
    }
    // The Today deck card's identity (cover + meta) and the keep reveal's identity
    // are each a door into Album details — clicking anywhere on them opens the
    // record's story, so no separate "Album details" button is needed. Inner
    // controls (artist link, genre threads, Fix art, the .card-hit overlay) keep
    // their own clicks; only the .card-hit or empty space opens the story.
    const opener = e.target.closest(".open-story[data-rid]");
    if (opener) {
      if (e.target.closest("a, button:not(.card-hit), summary")) return;
      openStoryModal(opener.dataset.rid);
      return;
    }
    // U6: clicking anywhere else on a browse card opens its Threads/story view;
    // inner links/buttons (Listen, Discogs, Fix art, …) already returned above and
    // keep their own behavior. The Trail records the step, so closing returns you
    // right here.
    const card = e.target.closest(".card[data-rid]");
    if (card) {
      if (e.target.closest("a, button:not(.card-hit), summary")) return;
      openStoryModal(card.dataset.rid);
    }
  });
  // Note modal wiring.
  $("#noteClose").addEventListener("click", closeNoteModal);
  $("#noteModal").addEventListener("click", (e) => {
    if (e.target.id === "noteModal") closeNoteModal();
  });
  $("#noteSave").addEventListener("click", saveNote);
  // #48 (v2): delete the open note from the editor. deleteNote soft-deletes with an
  // Undo toast, so no extra confirm here — close the editor and let Undo be the safety.
  $("#noteDelete").addEventListener("click", () => {
    const id = noteEditId;
    if (id == null) return;
    closeNoteModal();
    deleteNote(id);
  });
  $("#noteBody").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveNote();
  });
  // FB#106a: the album's songs as composer pills. stopPropagation for the same reason
  // the attach rows do it — a document-level handler shouldn't get a look at a tap
  // that only re-points what this note ties to.
  $("#noteTrackPills").addEventListener("click", (e) => {
    const pill = e.target.closest(".nt-pill[data-nt]");
    if (pill) { e.stopPropagation(); toggleNoteTrack(pill.dataset.nt); }
  });
  // N3b: the free-note "＋ Tie it to a record" search.
  $("#noteAttachOpen").addEventListener("click", openNoteAttachSearch);
  $("#noteAttachInput").addEventListener("input", () => {
    clearTimeout(_noteAttachTimer);
    const q = $("#noteAttachInput").value.trim();
    _noteAttachTimer = setTimeout(() => noteAttachSearch(q), 250);
  });
  $("#noteAttachResults").addEventListener("click", (e) => {
    const row = e.target.closest(".rem-row[data-attach-idx]");
    // Stop here: these composer rows share the `.rem-row` class with the Remember
    // door's result rows, which a document-level handler treats as "open Your
    // notes for this album." Without this, that handler fires on the bubble and
    // overrides the attach we just made.
    if (row) { e.stopPropagation(); attachEntityToNote(row.dataset.attachIdx); }
  });
  $("#noteFor").addEventListener("click", (e) => {
    if (e.target.closest("#noteUntie")) { untieRecordFromNote(); return; }
    // #52: the cover/title opens Album details. The note modal (z 60) sits above the
    // story modal (z 50), so close the editor first, then open details as a door over
    // the trail (closing the backdrop already discards an unsaved edit, so this is no
    // more lossy than dismissing the modal).
    const alb = e.target.closest(".note-for-album");
    if (alb && alb.dataset.albumUid) { closeNoteModal(); openAlbumByUid(alb.dataset.albumUid); }
  });
  // N3: one search box scopes the whole trail (notes server-side via ?q=, choices
  // client-side); a debounce keeps it from refetching on every keystroke.
  let _trailSearchTimer = null;
  $("#journalSearch").addEventListener("input", () => {
    clearTimeout(_trailSearchTimer);
    _trailSearchTimer = setTimeout(() => loadTrail(true), 200);
  });
  // FB#95: "the x button in the search bar is too small and off brand" — that ✕ was
  // the browser's own input[type=search] control, drawn by the platform in the
  // platform's grey at the platform's size. Take it over on the three real search
  // fields so clearing looks like the rest of the app and is a proper tap target.
  ["#journalSearch", "#forestSearchInput", "#search"].forEach((sel) => wireSearchClear($(sel)));
  // v353: the bottom bar's + opens the free composer (record-optional) — the job of the
  // ✎ Write a note pill it replaced.
  $("#nbPlus").addEventListener("click", () => openNoteModal());
  wireBottomBar();
  // Trail entries: a note opens to read/edit; a choice opens its chosen record. In
  // selection mode (long-press), a tap toggles the entry instead of opening it.
  $("#trail").addEventListener("click", (e) => {
    // A long-press just fired — swallow its trailing click so it doesn't also open
    // (or immediately deselect) the entry it selected.
    if (_suppressNextTrailClick) { _suppressNextTrailClick = false; return; }
    const row = e.target.closest(".trail-row");
    if (_trailSelecting) { if (row) toggleTrailSelection(row); return; }
    // FB#94: a day header in search results is a door into that day. Route it
    // through pushAndGo so it's returnable by the breadcrumb, the wander map and
    // the system Back button alike — the engine already gives all three.
    const dayEl = e.target.closest(".trail-day.is-door");
    if (dayEl && dayEl.dataset.day) {
      const day = dayEl.dataset.day;
      pushAndGo(trailDayLabel(day), { t: "journalday", day },
        () => { goToJournalDay(day); });
      return;
    }
    const noteEl = e.target.closest(".trail-entry.note");
    if (noteEl) {
      // #53: the cover + title are a door to Album details; the note body opens the
      // editor. Only album/track notes carry data-album-uid (free/typed notes fall
      // straight through to the editor).
      const albumUid = noteEl.dataset.albumUid;
      if (albumUid && e.target.closest(".te-thumb, .te-head")) {
        openAlbumByUid(albumUid); return;
      }
      openTrailNote(noteEl); return;
    }
    const choiceEl = e.target.closest(".trail-entry.trail-choice, .trail-entry.trail-opened");
    if (choiceEl && choiceEl.dataset.uid) openStoryModal(choiceEl.dataset.uid);
  });
  // FILTER BY DATE: since v353 the bottom bar sets the range (setNbRange); #nbFrom/#nbTo
  // are its hidden state, read by nbDateRange().
  // #48 (v2): long-press an entry to enter selection mode; a bar deletes the batch.
  wireTrailLongPress($("#trail"));
  $("#trailSelectCancel").addEventListener("click", exitTrailSelection);
  $("#trailSelectDelete").addEventListener("click", deleteSelectedTrail);
  // FB#89: collapsing the notes from deep inside the list removes ~700px from ABOVE
  // the viewport, so the scroll position that was showing note #5 now points past the
  // whole section — you collapse it and the thing you collapsed leaves the screen,
  // with no way back to it without scrolling up hunting. Pull the summary back to the
  // top of the modal's visible area whenever a close leaves it above the fold. Only on
  // close, and only when it actually went out of view, so a normal collapse near the
  // top doesn't move the page under you.
  const storyNotesBox = $("#storyNotesBox");
  if (storyNotesBox) storyNotesBox.addEventListener("toggle", () => {
    if (storyNotesBox.open) return;
    const box = storyNotesBox.closest(".modal-box");
    const sum = storyNotesBox.querySelector("summary");
    if (!box || !sum) return;
    const pad = parseFloat(getComputedStyle(box).paddingTop) || 0;
    const delta = sum.getBoundingClientRect().top - (box.getBoundingClientRect().top + pad);
    if (delta < 0) box.scrollTop += delta;
  });
  // Album details door (U3).
  $("#storyClose").addEventListener("click", closeStoryModal);
  $("#storyModal").addEventListener("click", (e) => {
    if (e.target.id === "storyModal") closeStoryModal();
  });
  // FB#41: lock the page behind any open modal. A modal shows/hides by toggling
  // `.hidden`, so we watch every modal's class and reflect "any open" onto <body>
  // (CSS: body.modal-open { overflow:hidden }). Covers all modals with no per-open
  // bookkeeping, so a new modal can never forget to lock.
  const refreshModalScrollLock = () =>
    document.body.classList.toggle("modal-open",
      !!document.querySelector(".modal:not(.hidden)"));
  const scrollLockMO = new MutationObserver(refreshModalScrollLock);
  document.querySelectorAll(".modal").forEach((m) =>
    scrollLockMO.observe(m, { attributes: true, attributeFilter: ["class"] }));
  refreshModalScrollLock();
  // The "gesture": right-click (desktop) or long-press (touch) on a note-anchor —
  // a track, a linked credit, the artist thread — ties a note straight to it, the
  // accelerator alongside the hover pencil. Delegated on the modal so it survives
  // each re-render of the room / tracklist.
  $("#storyModal").addEventListener("contextmenu", (e) => {
    const anchor = e.target.closest(".note-anchor");
    if (!anchor) return;
    e.preventDefault();
    openNoteForAnchor(anchor);
  });
  const cancelLongPress = () => {
    if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; }
    _lpAnchor = null;
  };
  $("#storyModal").addEventListener("touchstart", (e) => {
    _lpFired = false;
    const anchor = e.target.closest(".note-anchor");
    if (!anchor || e.touches.length !== 1) return;
    _lpAnchor = anchor;
    _lpX = e.touches[0].clientX; _lpY = e.touches[0].clientY;
    _lpTimer = setTimeout(() => {
      _lpTimer = null;
      if (_lpAnchor) { _lpFired = true; openNoteForAnchor(_lpAnchor); }
    }, 500);
  }, { passive: true });
  $("#storyModal").addEventListener("touchmove", (e) => {
    if (!_lpTimer) return;
    if (Math.abs(e.touches[0].clientX - _lpX) > 10 ||
        Math.abs(e.touches[0].clientY - _lpY) > 10) cancelLongPress();
  }, { passive: true });
  $("#storyModal").addEventListener("touchend", cancelLongPress);
  $("#storyModal").addEventListener("touchcancel", cancelLongPress);
  // The acts row inside Album details: ✎ Write a note on every record, Skip only on
  // today's (renderStoryDeckActions). Keep + its undo were retired at v329.
  $("#storyDeckActions").addEventListener("click", (e) => {
    const rid = storyRid;
    if (!rid) return;
    // The album on screen — from the deck when this IS today's record, otherwise from
    // albumData, which is what the story modal itself renders from (FB#87).
    const deckRec = deckState && deckState.idx < deckState.records.length
      ? deckState.records[deckState.idx] : null;
    const isDeckRecord = deckRec && albumKey(deckRec) === rid;
    const a = isDeckRecord ? deckRec : albumData[rid];
    if (!a) return;
    if (e.target.closest("[data-story-note]")) {
      rememberNames(rid, a.artist, a.title);   // saveNote snapshots the name from here
      openNoteModal(rid);
    } else if (e.target.closest("[data-story-setaside]")) {
      if (!isDeckRecord) return;         // Skip only ever applies to today's record
      closeStoryModal();
      setAsideCurrent();
    }
  });
  // Your notes door (N1 Step 1).
  $("#yourNotesClose").addEventListener("click", closeYourNotes);
  $("#yourNotesModal").addEventListener("click", (e) => {
    if (e.target.id === "yourNotesModal") closeYourNotes();
  });
  $("#yourNotesAdd").addEventListener("click", () => {
    if (yourNotesRid != null) openNoteModal(yourNotesRid);
  });
  // Artist panel (A2).
  $("#artistClose").addEventListener("click", closeArtistPanel);
  $("#artistModal").addEventListener("click", (e) => {
    if (e.target.id === "artistModal") closeArtistPanel();
  });
  $("#labelClose").addEventListener("click", () => AOTDLabelPanel.close());
  $("#labelModal").addEventListener("click", (e) => {
    if (e.target.id === "labelModal") AOTDLabelPanel.close();
  });
  // Personnel panel (F27).
  $("#personClose").addEventListener("click", closePersonPanel);
  $("#personModal").addEventListener("click", (e) => {
    if (e.target.id === "personModal") closePersonPanel();
  });
  // Wander map (T1).
  $("#wanderMapClose").addEventListener("click", closeWanderMap);
  $("#wanderMapModal").addEventListener("click", (e) => {
    if (e.target.id === "wanderMapModal") closeWanderMap();
  });
  // Mobile / desktop: the system back button (and edge-swipe) pops one fork of
  // the wander rather than ejecting you from the app — the stack owns back-
  // navigation until it's empty (then back behaves normally).
  window.addEventListener("popstate", () => {
    if (styleBrowsePopstate()) return;      // back closes the Genre screen first
    if (wanderCursor > 0) {
      gotoNode(wanderTree[wanderCursor].parent, { fromHistory: true });
    }
  });
  // Esc closes the map. Other modals keep their own affordances.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (_trailSelecting) { exitTrailSelection(); return; }   // #48 (v2): Esc leaves selection
    if (!$("#wanderMapModal").classList.contains("hidden")) { closeWanderMap(); return; }
  });
  $("#artClose").addEventListener("click", closeArtModal);
  $("#artModal").addEventListener("click", (e) => {
    if (e.target.id === "artModal") closeArtModal();
  });
  // FB#97: the About door — pull-only, ✕ / backdrop close. It used to hang off a
  // footer button ("About the data"); the footer is legal + version now, and the ☰
  // menu's "About" opens it (auth-ui calls openAboutDoor). Wiring lives here so
  // both the guest and signed-in menus reach one implementation.
  $("#dataClose").addEventListener("click", closeAboutDoor);
  $("#dataModal").addEventListener("click", (e) => {
    if (e.target.id === "dataModal") closeAboutDoor();
  });
  // Send-feedback modal.
  $("#feedbackBtn").addEventListener("click", openFeedbackModal);
  $("#feedbackClose").addEventListener("click", closeFeedbackModal);
  $("#feedbackModal").addEventListener("click", (e) => {
    if (e.target.id === "feedbackModal") closeFeedbackModal();
  });
  $("#feedbackSave").addEventListener("click", submitFeedback);
  $("#feedbackBody").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitFeedback();
  });
  // #8: hold "Peek" to temporarily get the feedback panel (and the phone
  // keyboard) out of the way, so you can see the very thing you're writing about
  // behind it. Press and hold reveals; release restores. Blurring the textarea
  // on press dismisses the on-screen keyboard for the duration of the peek.
  const fbPeek = $("#feedbackPeek");
  if (fbPeek) {
    const startPeek = (e) => {
      if (e) e.preventDefault();           // don't focus the button / scroll
      $("#feedbackBody").blur();
      $("#feedbackModal").classList.add("peeking");
    };
    const endPeek = () => $("#feedbackModal").classList.remove("peeking");
    fbPeek.addEventListener("pointerdown", startPeek);
    fbPeek.addEventListener("pointerup", endPeek);
    fbPeek.addEventListener("pointerleave", endPeek);
    fbPeek.addEventListener("pointercancel", endPeek);
    // Keyboard parity: Space/Enter hold-to-peek (keydown reveals, keyup hides).
    fbPeek.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); startPeek(); }
    });
    fbPeek.addEventListener("keyup", (e) => {
      if (e.key === "Enter" || e.key === " ") endPeek();
    });
  }
  $("#artSearchBtn").addEventListener("click", searchArt);
  $("#artTerm").addEventListener("keydown", (e) => { if (e.key === "Enter") searchArt(); });
  $("#artUrlBtn").addEventListener("click", () => {
    const u = $("#artUrl").value.trim();
    if (u) applyArt(u, null);
  });

  // U9: the app always opens on Today — the daily deck is the front door and the
  // lowest-friction way in. (We no longer restore the last-used tab.)
  //
  // ...unless this load is a RELOAD in the middle of a wander (owner, 2026-08-07:
  // "updating the app brought me to the today page when i was deep in a trail — it
  // should just return me to wherever i was"). Taking an update is a location.reload(),
  // and landing on Today threw away however many doors deep you were. Today still
  // renders first, so the deck is dealt and ready behind whatever door reopens — and
  // if the trail can't be re-walked, restoreWander() leaves this exactly as it was.
  // Nothing here changes for a genuinely new session: sessionStorage is empty then.
  setMode("decide");
  restoreWander();
  // U25's auto-open of the "What is this?" welcome USED to fire from here. It now
  // hangs off the aotd:guest / aotd:local-mode events at the bottom of this file —
  // see the comment there for why the old timer-based trigger was unwinnable.
}

// FIRST RUN (owner 2026-10-04, docs/mockups/welcome round 2 — "S5"). There is no
// welcome card any more: a new guest's Today IS the welcome. Where the cover goes, the
// services you can listen on plus "Everything"; where Listen goes, Start — live once
// one of the six is chosen. Start saves the choice (tap order = which service Listen
// tries first) and the first record lands in the same square.
//
// "Everything" keeps the honest path the old card protected ("choose none to see
// everything"): a service narrows the day to records we can CONFIRM there, so the
// widest day has to stay one tap away. It's exclusive with the services — choosing it
// clears them, choosing a service clears it.
//
// No tour offer follows (owner: "drop the tour bubble"); the tour is ☰ › "How to use".
// Both once-per-device flags are burned on SHOW, as the card did: a reload mid-choice
// lands on the whole day, never on the picker again.
let _firstRun = false;      // the picker is standing in for today's first record
let _firstRunSel = [];      // service keys in tap order, or [FIRST_RUN_ALL]
const FIRST_RUN_ALL = "all";

// The next selection after tapping `key`: toggles it, keeps tap order, and makes
// Everything exclusive with the services. Pure, so the test can pin it.
function firstRunToggle(sel, key) {
  if (sel.includes(key)) return sel.filter((k) => k !== key);
  if (key === FIRST_RUN_ALL) return [FIRST_RUN_ALL];
  return sel.filter((k) => k !== FIRST_RUN_ALL).concat(key);
}

function firstRunHtml() {
  const opts = CONFIRMED_PLATFORMS.map(([key, , label]) => [key, label])
    .concat([[FIRST_RUN_ALL, "Everything"]]);
  const tiles = opts.map(([key, label]) => {
    const on = _firstRunSel.includes(key);
    const sub = key === FIRST_RUN_ALL ? `<small>no filter</small>` : "";
    return `<button type="button" class="fr-opt${on ? " on" : ""}" data-fr="${esc(key)}"
      aria-pressed="${on}">${esc(label)}${sub}</button>`;
  }).join("");
  // The question (owner, 2026-10-05: "add 'Where do you listen?' to the opening page so
  // users have a nudge about what to do") sits where the eye lands first, above the
  // square, in the record title's serif.
  return `<article class="deck-card first-run">
    <p class="fr-ask" id="frAsk">Where do you listen?</p>
    <div class="fr-opts" role="group" aria-labelledby="frAsk"
      aria-describedby="frHint">${tiles}</div>
    <p class="sr-only" id="frHint">Choose one or more, or Everything, then Start.</p>
    <div class="deck-listen"><button type="button" class="listen-primary fr-start"
      id="frStart"${_firstRunSel.length ? "" : " disabled"}>Start</button></div>
  </article>`;
}

function renderFirstRun() {
  const wrap = $("#choice");
  if (wrap) wrap.innerHTML = firstRunHtml();
}

function enterFirstRun() {
  const ob = window.AOTDOnboarding;
  try {
    if (ob && ob.markSeen) ob.markSeen();
    if (ob && ob.markTourSeen) ob.markTourSeen();
  } catch (e) { /* a first run must never block the app */ }
  _firstRun = true;
  _firstRunSel = loadListenPrefs();
  document.body.classList.add("is-first-run");
  renderFirstRun();
}

function finishFirstRun() {
  if (!_firstRun || !_firstRunSel.length) return;
  _firstRun = false;
  document.body.classList.remove("is-first-run");
  const next = _firstRunSel.filter((k) => k !== FIRST_RUN_ALL);
  if (next.join() !== loadListenPrefs().join()) {
    commitListenPrefs(next, true);       // saves, filters the door, re-deals for them
    return;
  }
  if (deckState) {
    if (deckState.records.length) renderDeck();
    else renderGenreFilteredEmpty();
  } else if (_deckLoading) {
    const w = $("#choice");              // the load under the picker will deal
    if (w) w.innerHTML = deckLoadingHtml();
    fastFirstCard(_deckSeq, mdParam());  // ...and its first card can come ahead of it
  } else {
    loadDeck(true);
  }
}

function wireFirstRun() {
  const wrap = $("#choice");
  if (!wrap) return;
  wrap.addEventListener("click", (e) => {
    if (!_firstRun) return;
    const opt = e.target.closest("[data-fr]");
    if (opt) {
      _firstRunSel = firstRunToggle(_firstRunSel, opt.dataset.fr);
      renderFirstRun();
      const again = wrap.querySelector(`[data-fr="${opt.dataset.fr}"]`);
      if (again) again.focus({ preventScroll: true });   // keep a keyboard user's place
      return;
    }
    if (e.target.closest("#frStart")) finishFirstRun();
  });
}

function maybeWelcomeFirstRun() {
  const ob = window.AOTDOnboarding;
  if (!ob || !ob.shouldShowFirstRun || !ob.shouldShowFirstRun()) return;
  if (_firstRun) return;
  enterFirstRun();
}

// The guided tour is never offered any more (owner, 2026-10-05: "Skip the bubble for
// tour and everything. Just have it as an option in the pancake menu called 'How to
// use'"). Not after the first run, not on a new account's first unlock — the ☰ item
// starts it on demand (AOTDOnboarding.startTourOnDemand).
document.addEventListener("aotd:unlocked", () => { loadOpenedToday(); });
// FB#107: a background reconcile brought in changes (e.g. a write from another
// device) after the Notebook already rendered from the local cache — re-render it,
// but only if it's the view on screen (a no-op cost otherwise).
document.addEventListener("aotd:journal-updated", () => {
  loadOpenedToday();
  if (currentMode() === "journal") loadTrail(true);
});
// FB#107: reconnecting flushes the offline-write outbox — replay any notes written
// while offline, then reconcile. The store no-ops if it isn't unlocked/ready.
window.addEventListener("online", () => {
  const s = window.AOTDStore;
  if (s && typeof s.flush === "function") s.flush();
});

// U25's "What is this?" welcome, re-triggered (owner, 2026-07-16). It is a GUEST's
// door and only a guest's — the one question it answers ("what IS this?") is one an
// invited person already had answered, at length, by the invite email they just came
// from.
//
// It used to fire from init() behind a 350ms timer that checked whether a modal was
// open yet, as a proxy for "has the sign-in gate appeared?". That race was
// unwinnable: auth-ui's boot() awaits initSupabase() — a NETWORK call — before it
// shows anything, so on most magic-link visits 350ms elapses with no modal on
// screen. The welcome opened underneath, the gate stacked over it, and finishing
// setup revealed a card re-explaining the email. Marking it seen at signup didn't
// help either: by then the card was already open.
//
// So drive it off the events auth-ui fires once it KNOWS the auth state, and the
// guess disappears — a guest (or a local single-user build, which has no gate at
// all) gets the card; anyone arriving with a session never does. Still once per
// device, still deferred + modal-gated inside maybeWelcomeFirstRun.
document.addEventListener("aotd:guest", () => maybeWelcomeFirstRun());
document.addEventListener("aotd:local-mode", () => maybeWelcomeFirstRun());

document.addEventListener("DOMContentLoaded", async () => {
  applyInsetOverride();         // FB#96: ?insets=… fakes a device's reserved edges
  // Resolve the client feature flags BEFORE init()'s first load (setMode), so the
  // data-access seam choices pool vs legacy endpoints from the start. Boot proceeds
  // even if the fetch fails (clientConfig keeps its legacy defaults).
  await loadClientConfig();
  init();
  // If the last load was a silent auto-update (applied on return-to-foreground while the
  // Notebook was locked and nothing was being written), say so quietly — a reload with no
  // explanation reads as a glitch. One calm toast, then forget it.
  try {
    if (sessionStorage.getItem("aotd_auto_update") === "1") {
      sessionStorage.removeItem("aotd_auto_update");
      showToast("Updated to the latest version");
    }
  } catch (e) {}
  // Mark a fresh install as caught up with THIS build, before anyone opens the
  // What's-new door. It has to happen on boot rather than on first open: the
  // mark is what "since you last updated" is measured from, so leaving it unset
  // until someone looks would make every later update read as nothing-new.
  if (window.AOTDWhatsNew) window.AOTDWhatsNew.primeSeen(localStorage, window.__MF_BUILD);
  openDeepLink();               // a shared ?album|artist|person|label link opens its door
  maybeOpenAdminConsole();      // /admin on desktop IS the operator console — open it here
});

// The operator console is the single admin surface: the ☰ menu opens it in-app, and
// hitting /admin opens the same overlay on desktop. Operator-gated — a signed-out or
// non-operator visitor just lands in the app. Auth can resolve a beat after boot, so we
// check whoami now and once more shortly after (catches a late-restored Supabase session).
function maybeOpenAdminConsole() {
  if (location.pathname !== "/admin" || !window.AOTDOperator) return;
  var tries = 0;
  var attempt = function () {
    var whoami = (window.AOTDSync && AOTDSync.request)
      ? AOTDSync.request("/api/admin/whoami")
      : fetch("/api/admin/whoami").then(function (r) { return r.json(); });
    whoami.then(function (w) {
      if (w && w.operator) AOTDOperator.open();
      else if (++tries < 3) setTimeout(attempt, 1200);
    }).catch(function () { if (++tries < 3) setTimeout(attempt, 1200); });
  };
  attempt();
}
