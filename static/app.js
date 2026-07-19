"use strict";

// Build tag of the code ACTUALLY RUNNING (mirror of sw.js VERSION). The update
// watcher (auth-ui.js) judges "a newer version is live" against THIS, not the
// service-worker cache name — because the worker can swap its cache to a new build
// in the background while a resumed PWA keeps running old code, which made a stale
// page wrongly report "up to date". BUMP THIS WITH sw.js VERSION on any shell change.
window.__MF_BUILD = "v227";

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
const esc = (s) => (s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Escape a value for use inside a single-quoted CSS url('…') (S6). esc() only
// neutralizes the HTML metacharacters &<>"; inside a style="background-image:
// url('…')" context a stray ' ) \ or newline could still break out of the url()
// and inject extra CSS, so percent-encode those too. Used for every cover we
// drop into a background-image. (Covers are server-built URLs today, so this is
// defense-in-depth, not a known live hole.)
const cssUrl = (s) => esc(s).replace(/['()\\\n\r]/g, (c) =>
  ({ "'": "%27", "(": "%28", ")": "%29", "\\": "%5C",
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
function api(path) {
  const md = mdParam();
  const opts = { headers: { "X-MF-Mode": clientMode() } };
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
// rid -> {artist, title}, so the fix-art modal always knows what it's editing.
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
  // opts.fix === false drops the "Fix art" affordance — e.g. the read-only
  // "other one" thumbnail, which is one clean click target into the full view.
  const fix = opts && opts.fix === false
    ? ""
    : `<button class="fixart" data-rid="${esc(key)}">Fix art</button>`;
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
function isMobileUA() {
  const ua = navigator.userAgent || "";
  // iPhone/iPad/Android, plus iPadOS-on-desktop-UA (reports as Mac + touch).
  return /iPhone|iPad|iPod|Android/i.test(ua) ||
    ((navigator.maxTouchPoints || 0) > 1 && /Macintosh/.test(ua));
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
function appSearchScheme(cls, a) {
  const q = encodeURIComponent(((a.artist || "") + " " + (a.title || "")).trim());
  if (!q) return "";
  if (cls === "sp") return "spotify:search:" + q;             // Spotify app search
  if (cls === "yt") return "youtube://results?search_query=" + q;  // YouTube app search
  return "";
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
    return url.replace(/^https?:\/\//, "music://");
  if (key === "deezer"
      && (m = url.match(/deezer\.com\/(?:[a-z]{2}\/)?(album|track|playlist)\/(\d+)/)))
    return `deezer://www.deezer.com/${m[1]}/${m[2]}`;
  if (key === "tidal"
      && (m = url.match(/tidal\.com\/(?:browse\/)?(album|track|playlist)\/(\d+)/)))
    return `tidal://${m[1]}/${m[2]}`;
  // Plain youtube.com watch links: the main YouTube app's registered scheme.
  // music.youtube.com is handled by the Android intent below (YT Music has no
  // public scheme); on iOS its universal link does the handoff from Safari.
  if (key === "youtube" && !/music\.youtube\.com/.test(url)
      && (m = url.match(/[?&]v=([\w-]+)/)))
    return `vnd.youtube:${m[1]}`;
  return "";
}

// Android-only: a Chrome intent: URL for YouTube Music (no public URI scheme).
// An unresolvable intent (app missing) is a no-op, so wireDeepLinks' timer
// still delivers the web fallback in a separate context.
// Bandcamp was tried here (v68) and deliberately REVERTED: its app-link
// verification doesn't cover the per-artist subdomains our exact album URLs
// live on, so Android refuses the explicit intent and bounces to the Play
// Store listing even with the app installed (owner-observed: "opens up the
// app store… too many steps"). No documented scheme + unverifiable host =
// keeps its plain web link (a Custom Tab overlay; the PWA stays underneath).
function appIntentLink(key, url) {
  if (key !== "youtube") return "";
  const m = url.match(/^https?:\/\/(music\.youtube\.com\/[^#]*)/);
  if (!m) return "";
  return `intent://${m[1]}#Intent;scheme=https;`
    + `package=com.google.android.apps.youtube.music;end`;
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
const CONFIRMED_PLATFORMS = [
  ["spotify", "sp", "Spotify"],
  ["apple", "am", "Apple Music"],
  ["youtube", "yt", "YouTube Music"],
  ["deezer", "dz", "Deezer"],
  ["tidal", "td", "TIDAL"],
  ["amazon", "az", "Amazon Music"],
  ["pandora", "pa", "Pandora"],
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
const FILTERABLE_PLATFORMS = ["spotify", "apple", "youtube", "deezer", "tidal",
  "amazon", "pandora", "bandcamp"];

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
      confirmed link yet — or change your platforms up top.</p>
  </div>`;
}

function setListenPrefNote(keys) {
  const note = document.getElementById("listenPrefNote");
  if (!note) return;
  const fk = FILTERABLE_PLATFORMS.filter((k) => keys.includes(k));
  note.textContent = fk.length
    ? "Showing only albums on " + fk.map((k) => _platLabel[k] || k).join(", ") + "."
    : "Showing every album — choose a service to narrow it down.";
}

// A filter/selection change restacks what surfaces: drop the cached deck so Today
// is redrawn (with a fresh set-aside pile) from the newly-scoped pool, and reload
// the active date view.
function refreshSurfaces() {
  deckState = null;
  const mode = currentMode();
  if (mode === "decide") loadDeck(true);
  else if (mode === "browse" && browseScope === "day") loadBrowse();
}

// --- A8 Phase 2: the opt-in genre filter for Today ---------------------------
// Session-scoped (a transient "today I want jazz", not a durable device pref like
// your platforms), applied CLIENT-SIDE: the day payload already carries each
// record's coarse `bucket` (Phase 1), so filtering + the per-genre counts need no
// round-trip. "unknown" (records with no genre on file, ~30%) is never a chip —
// filtering to a genre honestly hides them (the honesty rule). Dig mode ignores the
// filter, the escape hatch. The chosen set still runs through the balanced deal, so
// "Jazz + Folk" interleaves rather than all-jazz-then-folk.
const genreFilter = new Set();
// FB#57b (Today): the finer typed filters — a term (lowercased) you add with Enter and
// remove with its chip's ✕, matched against each record's genres + styles ("shoegaze",
// "hard bop", "darkwave" — tags too fine to be a bucket). They join the bucket chips as
// first-class filters and OR with them (like the buckets OR with each other), so a
// record shows if it matches ANY selected filter. Dig still ignores everything.
const genreTerms = new Set();
// Buckets the reader has dismissed from the pill row this session (the ✕ on a bucket
// chip). Session-scoped and reversible ("show all genres"); it declutters the generic
// pills for someone who'd rather type. Dismissing a bucket that's actively filtering
// also drops it from the filter, so a hidden pill never keeps filtering invisibly.
const dismissedBuckets = new Set();
// The canonical chip order (matches pooldb._GENRE_BUCKETS); the chooser then shows
// only the buckets actually present today, most-common first.
const GENRE_BUCKET_ORDER = ["electronic", "rock", "hip hop", "pop", "jazz", "folk",
  "funk / soul", "classical", "reggae", "blues", "latin", "world", "stage & screen"];

function applyGenreFilter(list) {
  if (digMode) return list;                             // dig is ALWAYS unfiltered
  if (!genreFilter.size && !genreTerms.size) return list;
  return list.filter((r) => {
    if (genreFilter.size && genreFilter.has(r.bucket)) return true;
    if (genreTerms.size) {
      const hay = ((r.genres || "") + " " + (r.styles || "")).toLowerCase();
      for (const t of genreTerms) if (hay.includes(t)) return true;
    }
    return false;
  });
}
function titleCaseGenre(b) { return b.replace(/\b\w/g, (c) => c.toUpperCase()); }

// Count today's records per bucket, from the full day we already hold — so the chips
// carry real "here's what today is" numbers even while a filter is active.
function dayBucketCounts() {
  const counts = new Map();
  for (const r of (deckState && deckState.all) || []) {
    const b = r.bucket || "unknown";
    counts.set(b, (counts.get(b) || 0) + 1);
  }
  return counts;
}

// FB#57b: how many of today's records a typed term matches (genres + styles) — from the
// full day we hold, so a term chip carries a count like the buckets, and the composer
// can preview it before adding. Not the filtered set: it's "how much of today is this".
function termMatchCount(term) {
  const t = (term || "").trim().toLowerCase();
  if (!t || !deckState || !deckState.all) return 0;
  let n = 0;
  for (const r of deckState.all) {
    if (((r.genres || "") + " " + (r.styles || "")).toLowerCase().includes(t)) n++;
  }
  return n;
}

// FB (2026-07-17): the type-ahead vocabulary — the DISTINCT genre + style tags that
// actually appear in today's records, each with the count the filter would yield if you
// added it (same includes() match termMatchCount uses, so the number shown is the number
// you get). Sourced from today only, so it never suggests a tag that matches nothing —
// the honesty rule, applied to autocomplete. Cached on the deck; a re-derive rebuilds it.
function genreVocab() {
  if (!deckState || !deckState.all) return [];
  if (deckState._vocab) return deckState._vocab;
  const labels = new Map();                        // key(lower) -> first-seen label
  for (const r of deckState.all) {
    for (const part of [r.genres || "", r.styles || ""]) {
      for (const raw of part.split(",")) {
        const label = raw.trim();
        if (label && !labels.has(label.toLowerCase())) labels.set(label.toLowerCase(), label);
      }
    }
  }
  const vocab = [...labels.entries()]
    .map(([key, label]) => ({ key, label, n: termMatchCount(key) }))
    .filter((e) => e.n > 0)
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
  deckState._vocab = vocab;
  return vocab;
}

// The up-to-8 suggestions for a typed query: tags containing it, prefix-matches first,
// then by count. Excludes tags already added as a term (no point re-suggesting them).
function genreSuggestions(q) {
  const s = (q || "").trim().toLowerCase();
  if (!s) return [];
  return genreVocab()
    .filter((e) => e.key.includes(s) && !genreTerms.has(e.key))
    .sort((a, b) => (a.key.startsWith(s) ? 0 : 1) - (b.key.startsWith(s) ? 0 : 1)
      || b.n - a.n || a.label.localeCompare(b.label))
    .slice(0, 8);
}

let suggestActive = -1;                             // highlighted suggestion (keyboard)
function renderGenreSuggest() {
  const box = document.getElementById("genreSuggest");
  const inp = document.getElementById("genreText");
  if (!box || !inp) return;
  const items = genreSuggestions(inp.value);
  suggestActive = -1;
  if (!items.length) { box.hidden = true; box.innerHTML = ""; return; }
  box.innerHTML = items.map((e) =>
    `<button type="button" class="genre-sugg" role="option" data-add="${esc(e.label)}"
       tabindex="-1"><span class="gs-label">${esc(e.label)}</span><span
       class="gs-n">${e.n.toLocaleString()}</span></button>`).join("");
  box.hidden = false;
}
function hideGenreSuggest() {
  const box = document.getElementById("genreSuggest");
  if (box) { box.hidden = true; box.innerHTML = ""; }
  suggestActive = -1;
}
// Move the keyboard highlight through the open suggestion list (wraps at the ends).
function moveGenreSuggest(delta) {
  const box = document.getElementById("genreSuggest");
  if (!box || box.hidden) return;
  const opts = [...box.querySelectorAll(".genre-sugg")];
  if (!opts.length) return;
  suggestActive = (suggestActive + delta + opts.length) % opts.length;
  opts.forEach((o, i) => o.classList.toggle("active", i === suggestActive));
  opts[suggestActive].scrollIntoView({ block: "nearest" });
}

function updateGenreTally() {
  const t = document.getElementById("genreTally");
  if (!t) return;
  const n = genreFilter.size + genreTerms.size;
  t.hidden = n === 0;
  t.textContent = " · " + n;
}

function setGenrePrefNote() {
  const note = document.getElementById("genrePrefNote");
  if (!note) return;
  if (!genreFilter.size && !genreTerms.size) {
    note.classList.remove("on");
    note.textContent = "Pick a genre, or add a style, to narrow today.";
    return;
  }
  // The selected filters are the chips above; the note just carries the live count —
  // the confirmation the user asked for ("786 records match" vs "none").
  const n = (deckState && deckState.all) ? applyGenreFilter(deckState.all).length : 0;
  note.classList.add("on");
  note.textContent = n
    ? `${n.toLocaleString()} record${n === 1 ? "" : "s"} match.`
    : "No records today match — try another, or dig.";
}

// FB#57b: while the input has text, the note previews how many records that term would
// match — so you can decide before adding. An empty box restores the active-filter note.
function updateGenreTypePreview() {
  const inp = document.getElementById("genreText");
  const note = document.getElementById("genrePrefNote");
  if (!inp || !note) return;
  const v = inp.value.trim();
  if (!v) { setGenrePrefNote(); return; }
  const n = termMatchCount(v);
  note.classList.toggle("on", n > 0);
  note.textContent = n
    ? `${n.toLocaleString()} record${n === 1 ? "" : "s"} tagged “${v}” — Enter to add.`
    : `No records today tagged “${v}”.`;
}

// Build the chip row from today's real distribution: only KNOWN buckets present
// today, most-common first, each carrying its count.
function renderGenrePref() {
  const box = document.getElementById("genreChips");
  if (!box) return;
  const counts = dayBucketCounts();
  const present = GENRE_BUCKET_ORDER
    .filter((b) => counts.get(b) && !dismissedBuckets.has(b))
    .sort((a, b) => counts.get(b) - counts.get(a));
  const bucketChips = present.map((b) => {
    const on = genreFilter.has(b);
    const label = titleCaseGenre(b);
    return `<button type="button" class="genre-chip${on ? " on" : ""}" data-genre="${esc(b)}"
       aria-pressed="${on}"><span class="gc-dot" aria-hidden="true"></span>${esc(label)}<span class="gc-n">${counts.get(b).toLocaleString()}</span><span
       class="gc-x gc-dismiss" data-dismiss="${esc(b)}" role="button" tabindex="-1"
       title="Hide ${esc(label)}" aria-label="Hide the ${esc(label)} genre pill">✕</span></button>`;
  }).join("");
  // FB#57b: the typed terms as their own removable chips — the term, its count of
  // today's records (like the buckets), then a ✕. Tapping the chip removes it.
  const termChips = [...genreTerms].map((t) => {
    const n = termMatchCount(t);
    return `<button type="button" class="genre-chip custom on" data-term="${esc(t)}"
       aria-label="Remove the ${esc(t)} filter (${n} records)">${esc(t)}<span
       class="gc-n">${n.toLocaleString()}</span><span class="gc-x" aria-hidden="true">✕</span></button>`;
  }).join("");
  // When some generic pills are hidden, a quiet chip brings them all back — dismissing
  // is session-scoped and reversible, never a one-way trap.
  const restoreChip = dismissedBuckets.size
    ? `<button type="button" class="genre-chip genre-restore" data-restore
         aria-label="Show all genre pills again">+ show all genres</button>`
    : "";
  box.innerHTML = bucketChips + termChips + restoreChip;
  setGenrePrefNote();
  updateGenreTally();
}

// Hide a generic bucket pill for the session; if it was actively filtering, drop it from
// the filter (and re-derive) so a hidden pill never keeps narrowing invisibly.
function dismissBucket(b) {
  dismissedBuckets.add(b);
  if (genreFilter.delete(b)) refilterDeck();
  else renderGenrePref();
}
function restoreBuckets() {
  if (!dismissedBuckets.size) return;
  dismissedBuckets.clear();
  renderGenrePref();
}

// A genre toggle re-derives the visible deck from the full day we already hold — no
// refetch. It's a fresh draw, so it resets to the top with an empty set-aside pile,
// like the platform filter's refreshSurfaces; kept rows persist server-side.
function refilterDeck() {
  if (!deckState || !deckState.all) { loadDeck(true); return; }
  deckState.records = dealOrder(applyGenreFilter(deckState.all));
  deckState.idx = 0;
  deckState.aside = [];
  deckState.kept = new Map();
  updateSetAsideBar();
  renderGenrePref();
  if (deckState.records.length) renderDeck();
  else renderGenreFilteredEmpty();
}

function toggleGenre(b) {
  if (genreFilter.has(b)) genreFilter.delete(b);
  else genreFilter.add(b);
  refilterDeck();
}

// FB#57b: add / remove a typed finer term. Add is idempotent (a repeat is a no-op);
// remove is what the term's chip ✕ calls. Both re-derive the deck.
function addGenreTerm(raw) {
  const t = (raw || "").trim().toLowerCase();
  if (!t || genreTerms.has(t)) return;
  genreTerms.add(t);
  refilterDeck();
}
function removeGenreTerm(t) {
  if (genreTerms.delete((t || "").toLowerCase())) refilterDeck();
}

// A genre filter that empties today (but the day itself holds records) points to
// dig — never a blank wall (the honesty-rule guardrail, like the platform filter).
function renderGenreFilteredEmpty() {
  const wrap = $("#choice");
  if (!wrap) return;
  const parts = [...genreFilter].map(titleCaseGenre);
  for (const t of genreTerms) parts.push(`“${t}”`);
  const picks = parts.join(", ");
  wrap.innerHTML = `<div class="empty">
    <p class="empty-lead">Nothing today in ${esc(picks)}.</p>
    <button class="dig-pill" data-clear-genres><span aria-hidden="true">↺</span> Clear genres</button>
    <p class="empty-sub muted">Today holds records — just not in what you picked. Clear the
      filter, or <button class="linkish" data-goto-explore>explore the whole catalog →</button></p>
  </div>`;
}

function clearGenreFilter() {
  if (!genreFilter.size && !genreTerms.size) return;
  genreFilter.clear();
  genreTerms.clear();
  const inp = document.getElementById("genreText");
  if (inp) inp.value = "";
  hideGenreSuggest();
  refilterDeck();
}

function wireGenrePref() {
  const box = document.getElementById("genrePref");
  const chips = document.getElementById("genreChips");
  if (!box || !chips) return;
  chips.addEventListener("click", (e) => {
    // Like the platform list: a toggle re-renders the chips, detaching the clicked
    // node, so an ancestor click-away closer would read it as "outside". Stop here.
    e.stopPropagation();
    const dismiss = e.target.closest("[data-dismiss]");           // the ✕ hides the pill
    if (dismiss) { dismissBucket(dismiss.dataset.dismiss); return; }
    if (e.target.closest("[data-restore]")) { restoreBuckets(); return; }
    const custom = e.target.closest(".genre-chip.custom[data-term]");
    if (custom) { removeGenreTerm(custom.dataset.term); return; }   // FB#57b: tap to drop
    const chip = e.target.closest("[data-genre]");
    if (chip) toggleGenre(chip.dataset.genre);
  });
  // FB#57b: type a finer term + Enter (or the Add button) to add it as a chip; it then
  // filters like a bucket. FB (2026-07-17): as you type, a dropdown suggests the genres
  // and styles actually present today — pick one instead of guessing the spelling.
  const text = document.getElementById("genreText");
  const addBtn = document.getElementById("genreAdd");
  const suggest = document.getElementById("genreSuggest");
  const addTerm = (val) => {
    if (!text) return;
    addGenreTerm(val);
    text.value = "";
    hideGenreSuggest();
    text.focus();
  };
  const activeSuggLabel = () => {
    if (!suggest || suggest.hidden || suggestActive < 0) return null;
    const opt = suggest.querySelectorAll(".genre-sugg")[suggestActive];
    return opt ? opt.dataset.add : null;
  };
  if (text) {
    let timer = null;
    text.addEventListener("click", (e) => e.stopPropagation());
    text.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); moveGenreSuggest(1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); moveGenreSuggest(-1); return; }
      if (e.key === "Escape" && suggest && !suggest.hidden) {
        e.preventDefault(); e.stopPropagation(); hideGenreSuggest(); return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const sel = activeSuggLabel();
        addTerm(sel != null ? sel : text.value);
      }
    });
    // The dropdown is cheap (cached vocab) so it updates live; the count-note stays
    // debounced. An empty box hides the dropdown and restores the active-filter note.
    text.addEventListener("input", () => {
      renderGenreSuggest();
      clearTimeout(timer);
      timer = setTimeout(updateGenreTypePreview, 150);
    });
    text.addEventListener("blur", () => setTimeout(hideGenreSuggest, 120));  // let a click land
  }
  if (suggest) {
    suggest.addEventListener("click", (e) => {
      e.stopPropagation();
      const opt = e.target.closest(".genre-sugg[data-add]");
      if (opt) addTerm(opt.dataset.add);
    });
    // A mousedown inside the list must not blur-hide it before the click resolves.
    suggest.addEventListener("mousedown", (e) => e.preventDefault());
  }
  if (addBtn) addBtn.addEventListener("click", (e) => { e.stopPropagation(); addTerm(text ? text.value : ""); });
  // Populate the chips whenever the chooser is opened (the day may have changed).
  box.addEventListener("toggle", () => { if (box.open) renderGenrePref(); else hideGenreSuggest(); });
  // Tap outside the open popover to dismiss it (mirrors the platform chooser) —
  // but NOT a tap on the feedback launcher/modal: opening feedback shouldn't
  // collapse the genre filter (FB#57), the same exemption the account menu makes.
  document.addEventListener("pointerdown", (e) => {
    if (box.open && !box.contains(e.target)
        && !(e.target.closest && e.target.closest("#feedbackBtn, #feedbackModal"))) {
      box.open = false;
    }
  });
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
function listenBlockHtml(a, { compact = false } = {}) {
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
    return `<div class="choice-listen"><div class="listen-chips listen-solo">
      <a class="listen-chip primary ${pcls}" href="${esc(purl)}"${
        listenAttrs(pkey, purl)} target="_blank" rel="noopener">${esc(plabel)}</a>
    </div></div>`;
  }
  const primaryBtn = `<a class="listen-primary ${pcls}" href="${esc(purl)}"${
    listenAttrs(pkey, purl)}
    target="_blank" rel="noopener">▶ Listen on ${esc(plabel)}</a>`;
  const chipsHtml = chips.length
    ? `<div class="listen-chips">
        ${chips.map(([key, cls, url, label]) =>
          `<a class="listen-chip ${cls}" href="${esc(url)}"${listenAttrs(key, url)} target="_blank"
            rel="noopener">${esc(label)}</a>`).join("\n        ")}
      </div>`
    : "";
  return `<div class="choice-listen">${primaryBtn}${chipsHtml}${copyAlongsideHtml(a)}</div>`;
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
  const yours = prefs.map((k) => _platLabel[k]).filter(Boolean);
  const found = [elsewhere.primary, ...elsewhere.chips];   // [key, cls, url, label]
  const chips = found.map(([key, cls, url, label]) =>
    `<a class="listen-chip ${cls}" href="${esc(url)}"${listenAttrs(key, url)}
      target="_blank" rel="noopener">${esc(label)}</a>`).join("\n      ");
  // The copy earns its place most here: we've just said it ISN'T on the services you
  // use, so the string to search with is the one thing you actually want.
  return `<div class="choice-listen off-platform">
    <p class="choice-looking muted">Not on ${esc(orList(yours))} — but it's here:</p>
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
function metaSub(a) {
  const sep = ' <span class="dot">·</span> ';
  const parts = [];
  if (a.released) parts.push(esc(a.released));
  if (a.country) parts.push(esc(a.country));
  genresOf(a).forEach((g) => parts.push(catalogThread("genres", g)));
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
// card. The cards carry inner controls (artist link, Fix art, Listen chips), so the
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

// --- TODAY (the keep-model deck) --------------------------------------------
// One record at a time from the day's pool. Keep writes a chosen-only choice row
// (recordChoice(album, null) — not_chosen stays NULL, the "keep" shape the store
// already supports); Set aside stacks the record in a local, per-day, reopenable
// pile. Keeping is ADDITIVE — it never settles the day, so the deck just advances
// and you can keep as many records as you like (tracked in deckState.kept, not a
// single "one choice per day" id).

// The active day's deck, ephemeral and per-day (D2): { key, records, idx, kept,
// aside }. Leaving Today and returning restores your place; a date rollover or a
// filter/dig change (loadDeck(true)) starts fresh. Nothing here is persisted or
// synced — the set-aside pile lives only in this object, only for today.
let deckState = null;
// The album the keep reveal is currently annotating, so the note composer's
// fallback (saveChoiceReason) can re-record it if its POST never landed.
let currentKeepAlbum = null;

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

// A8 Phase 1 — a genre-BALANCED deal, replacing the plain shuffle. The catalog
// skews heavily electronic/rock, so a flat shuffle leads Today with a run of the
// same genre. Instead: group the day by its server-assigned coarse `bucket`,
// shuffle within each bucket, then deal one bucket per round (round order itself
// reshuffled each pass) — so the records you meet up front span many genres and no
// bucket repeats until the others have had a turn. Still "what today gives you":
// nothing is hidden or ranked, every record stays in the deck; it's dealt for
// variety, not curated. "unknown"-genre records are their own bucket, so genre-blind
// albums (~30%, mostly MB) aren't buried. Degrades to a plain shuffle for a
// single-genre day. Read `bucket` off the record (server owns the taxonomy).
function balancedOrder(list) {
  const groups = new Map();
  for (const rec of list) {
    const b = rec.bucket || "unknown";
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b).push(rec);
  }
  let queues = [...groups.values()].map(shuffled);
  const out = [];
  while (queues.length) {
    for (const q of shuffled(queues)) out.push(q.shift());
    queues = queues.filter((q) => q.length);
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
function resumeAt(list) {
  const uid = loadAt();
  if (!uid) return list;
  const i = list.findIndex((r) => albumKey(r) === uid);
  if (i <= 0) return list;                 // absent, or already first
  return [list[i], ...list.slice(0, i), ...list.slice(i + 1)];
}

function deckLoadingHtml() {
  return `<div class="deck-card skeleton" aria-hidden="true">
    <div class="skel-cover skel"></div>
    <div class="meta">
      <div class="skel-line skel"></div>
      <div class="skel-line skel short"></div>
      <div class="skel-line skel shorter"></div>
    </div>
  </div>`;
}

// Fetch the day's records (D1: the whole day's AVAILABLE pool via dayEndpoint →
// /api/pool/day; dig=1 = the full union). force=true drops the cached deck (a
// filter/dig change or an explicit reload); otherwise a same-day return restores
// the deck exactly where you left it, set-aside pile and all.
async function loadDeck(force = false) {
  const key = mdParam();
  if (!force && deckState && deckState.key === key && deckState.all && deckState.all.length) {
    renderGenrePref();
    if (deckState.records.length) renderDeck();
    else renderGenreFilteredEmpty();
    return;
  }
  closeChoiceReveal();
  const wrap = $("#choice");
  if (wrap) wrap.innerHTML = deckLoadingHtml();
  let data;
  try {
    data = await api(dayEndpoint());
  } catch (e) {
    if (wrap) wrap.innerHTML =
      `<div class="empty">Couldn't load today's records — try again.</div>`;
    return;
  }
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
  if (rawCount && !records.length) {
    deckState = { key, all: [], records: [], idx: 0, kept: new Map(), aside: [] };
    renderGenrePref();
    renderDeck();
    return;
  }
  if (!records.length) {
    deckState = null;
    updateSetAsideBar();
    // Under the opt-in filter an empty day means "nothing on your platforms" — never
    // a dead end: point to dig (always unfiltered). Otherwise it's a genuinely thin
    // date; point out to Explore, never a blank wall (VISION guardrail).
    if (wrap) wrap.innerHTML = data.filtered
      ? filteredEmptyHtml("day", "for today")
      : `<div class="empty">No records with a known date today.
         <button class="linkish" data-goto-explore>Explore the catalog →</button></div>`;
    return;
  }
  // kept: Map<album key → choice-row id> — the id lets a keep made from Album details
  // be undone (DELETE the row); size is still the "you kept N" count.
  // Keep the full day (`all`) so the genre filter can re-derive the visible deck
  // without a refetch; `records` is the balanced view of the (optionally) filtered set.
  // resumeAt only on this FRESH-BUILD path: the same-session early return above
  // already has your place, and a filter change (which re-deals via the other
  // dealOrder call site) is a deliberate "show me something else".
  deckState = { key, all: records,
                records: resumeAt(dealOrder(applyGenreFilter(records))),
                idx: 0, kept: new Map(), aside: [] };
  renderGenrePref();
  if (deckState.records.length) renderDeck();
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

// The keep row currently being annotated. One row PER keep (keeping is additive):
// reset to null before each keep so recordChoice POSTs a fresh row, then the note
// composer PATCHes that id. (Kept as the same name recordChoice/saveChoiceReason
// have always used.)
let currentChoiceId = null;
// The in-flight (or last) /api/choices write. The note editor waits on this so
// "Save note" can attach to the id once it lands, instead of silently no-opping
// while the POST is still in flight — or after it failed (2026-07-06: a stale
// Supabase kind-CHECK constraint 500'd every choice write, and both the missing
// row and the dead Save button were that failure, swallowed and invisible).
let recordChoicePromise = null;
// The in-progress "what does this bring back?" text for the open keep reveal.
// Module-level so leaving Today (a tab switch, a wander) and coming back restores
// a half-written note.
let pendingChooseWhy = "";

// Paint the current record — one at a time — with Keep / Set aside and its Listen
// door. At the end of the finite deck, a calm "that's every record for today"
// state that still points somewhere (Notebook, the set-aside pile, dig) — never a
// blank wall (VISION guardrail).
function renderDeck() {
  const wrap = $("#choice");
  if (!wrap || !deckState) return;
  updateSetAsideBar();
  if (deckState.idx >= deckState.records.length) {
    saveAt(null);              // deck's done — there's no record to come back to
    wrap.innerHTML = deckEndHtml();
    return;
  }
  const a = deckState.records[deckState.idx];
  const key = albumKey(a);
  saveAt(key);                 // whatever is on screen IS your place (see AT_KEY)
  a._doorPending = poolOn() && !a._doorFilled;
  // A record is normally kept-then-advanced, so the deck only shows a "kept" state
  // when it was kept from Album details (which stays put): acknowledge it, offer undo
  // and a plain "Next" instead of re-offering Keep / Set aside.
  const isKept = deckState.kept.has(key);
  wrap.innerHTML = `
    <p class="deck-eyebrow">Released on this day in history</p>
    <article class="deck-card" data-uid="${esc(key)}">
      <div class="deck-open open-story" data-rid="${esc(key)}">
        ${cardHit("Album details for", a)}
        <div class="deck-cover">${coverHtml(a)}</div>
        <div class="deck-meta">
          <p class="deck-title">${artistLink(a.artist)} — <b>${esc(a.title)}</b></p>
          <p class="deck-sub">${deckMeta(a)}</p>
        </div>
      </div>
      <div id="deckListen" class="deck-listen">${listenBlockHtml(a, { compact: true })}</div>
      ${isKept ? `<p class="deck-kept-ack">Kept ✓ — in your Notebook</p>` : ``}
      <div class="deck-buttons">
        ${isKept
          ? `<button type="button" id="undoKeepBtn" class="set-aside-btn">Undo keep</button>
             <button type="button" id="deckNextBtn" class="keep-btn">Next →</button>`
          : `<button type="button" id="setAsideBtn" class="set-aside-btn">Skip</button>
             <button type="button" id="keepBtn" class="keep-btn">Keep</button>`}
      </div>
    </article>`;
  observeArt(wrap, { eager: 2 });
  // Fan out the confirmed door (like the keep reveal) and repaint just the listen
  // row when Spotify/YouTube/etc. resolve — never leave the spinner spinning. One
  // button, your #1 confirmed platform (compact): the pool is already filtered to
  // what you can play, so backups + the "Listen on ___" label are just clutter.
  resolveDoor(key).then(() => {
    a._doorPending = false;
    if (deckState && deckState.records[deckState.idx] === a) {
      const el = $("#deckListen");
      if (el) el.innerHTML = listenBlockHtml(albumData[key] || a, { compact: true });
    }
  });
  if (isKept) {
    $("#undoKeepBtn").addEventListener("click", () => unkeepRecord(key));
    $("#deckNextBtn").addEventListener("click", advanceDeck);
  } else {
    $("#keepBtn").addEventListener("click", keepCurrent);
    $("#setAsideBtn").addEventListener("click", setAsideCurrent);
    maybeStartTour();   // the first-run guided tour (once/device)
  }
}

// End of the finite deck — you've seen every record for today. Calm, and always a
// door out: what you kept (Notebook), the pile you set aside, or dig for more.
function deckEndHtml() {
  const aside = (deckState && deckState.aside.length) || 0;
  const kept = (deckState && deckState.kept.size) || 0;
  const keptLine = kept
    ? `<p>You kept ${kept} — <button class="linkish" data-goto-notebook>see them in your Notebook →</button></p>`
    : `<p>You didn't keep any today — that's fine. Nothing has to be kept.</p>`;
  const asideLine = aside
    ? `<p><button class="linkish" data-open-aside>Look again at the ${aside} you skipped →</button></p>`
    : "";
  // A thin platform-filtered day is the #1 way Today dead-ends fast: you filter to
  // a service (Spotify/Apple confirm few records), set the one or two aside, and
  // land here — feeling stuck. Name the filter honestly and offer to clear it,
  // rather than leaving only the generic dig line. (Dig ignores the filter, so the
  // hint only shows when the filter is what thinned the day.)
  const platKeys = filterPlatformKeys();
  const thinFiltered = platKeys.length && deckState && deckState.all.length <= 8;
  const platLine = thinFiltered
    ? `<p class="deck-end-filter">Only <b>${deckState.all.length}</b> of today's records
       ${deckState.all.length === 1 ? "is" : "are"} confirmed on
       ${esc(platKeys.map((k) => _platLabel[k] || k).join(", "))} — that's what made this
       so short. <button class="linkish" data-clear-platforms>See every record today →</button></p>`
    : "";
  const digLine = (poolOn() && !digMode)
    ? `<p class="muted"><button class="linkish" data-dig-escape>Dig deeper — include records with no confirmed way to listen yet →</button></p>`
    : "";
  return `<div class="deck-end">
    <p class="deck-end-lead">That's every record released on ${esc(mdDisplay(mdParam()))}.</p>
    ${keptLine}${asideLine}${platLine}${digLine}
  </div>`;
}

// Advance past the current record (after a keep or a set-aside). One record at a
// time, so this is just "next" — there is no reshuffle (D5).
function advanceDeck() {
  if (!deckState) return;
  deckState.idx++;
  renderDeck();
}

// Write a keep (a chosen-only choice row, not_chosen NULL) and track its id in
// deckState.kept so it can be undone (DELETE the row) and counted. Marks the key
// kept immediately; the real id fills in once the POST lands. Shared by the deck's
// Keep and Album details' Keep.
// A keep goes straight to the network — there's no outbox — so a keep tapped while
// the origin is unreachable used to depend entirely on the reader noticing a 6-second
// toast. Two ways that loses real work: a RELEASE swaps Render's instance and the
// origin 502s for ~27 s (measured 2026-07-18), and a phone drops signal for about as
// long. Worse, markMet() has already run by then, so once the toast fades the record
// won't be dealt again today either — the keep is gone with no second chance.
//
// So retry quietly first, on the failures that PROVE the write never reached the app
// (see `neverReached` in recordChoice — a 500 is excluded, since /api/choices has no
// idempotency key and the row may already exist). These delays cover the measured
// release window, and it stays a rescue, not a sync engine.
const KEEP_RETRY_DELAYS = [3000, 8000, 20000];

// Whether a failed write PROVABLY never reached the app — the only case where
// re-POSTing is safe, because /api/choices has no idempotency key and every POST
// inserts a new row.
//   502/503/504  Render's gateway answering while it swaps instances on a release;
//                the request never got to the app, so a retry can't double-write.
//   500          the app DID process it and may have committed before failing.
//                Retrying that is how you'd get two copies of one keep.
// (A rejected fetch never completed either; recordChoice tags those directly.)
function writeNeverReachedApp(status) {
  return status >= 502 && status <= 504;
}

async function keepWriteWithRetry(a) {
  for (let i = 0; ; i++) {
    try {
      await recordChoice(a, null, { quiet: true });
      return true;
    } catch (e) {
      // The note editor may have landed the row while we were waiting (it re-records
      // when currentChoiceId is null) — then there's nothing left to retry.
      if (currentChoiceId != null) return true;
      if (!e || !e.neverReached || i >= KEEP_RETRY_DELAYS.length) return false;
      await new Promise((r) => setTimeout(r, KEEP_RETRY_DELAYS[i]));
    }
  }
}

async function recordKeep(a, key) {
  key = key || albumKey(a);
  markMet(key);                                               // don't re-serve today
  deckState.kept.set(key, deckState.kept.get(key) || null);   // kept now (count)
  if (!await keepWriteWithRetry(a)) {
    // Out of retries. Hand the record BACK to the day: markMet above would otherwise
    // keep it out of the deck for the rest of today even though nothing was saved,
    // which turns a failed write into a record the reader can never reach again. Now
    // the worst case is meeting it a second time — recoverable, and honest.
    unmarkMet(key);
    if (deckState) deckState.kept.delete(key);
    updateSetAsideBar();
    showToast("Couldn't save that keep — it's back in today's records", "Retry",
      () => recordKeep(a, key));
    return;
  }
  // Sequential keeps only: currentChoiceId is this row's id. Don't clobber an id
  // we already have (a rapid interleave would mis-track, but we never undo those).
  if (deckState && deckState.kept.get(key) == null && currentChoiceId != null) {
    deckState.kept.set(key, currentChoiceId);
  }
}

// Keep → write the row, then advance and open the keep reveal to (optionally) write
// what it brings back. Keeping is additive (D3): the deck never settles. We advance
// BEFORE opening the reveal so dismissing it any way lands on the next record and
// can never double-keep the same one. If the record was already kept from Album
// details, reuse that row (don't double-write) so the note attaches to it.
function keepCurrent() {
  if (!deckState || deckState.idx >= deckState.records.length) return;
  const a = deckState.records[deckState.idx];
  const key = albumKey(a);
  currentKeepAlbum = a;
  pendingChooseWhy = "";
  savedChooseWhy = "";
  if (deckState.kept.has(key)) {
    currentChoiceId = deckState.kept.get(key);   // already kept — annotate that row
  } else {
    currentChoiceId = null;
    recordKeep(a, key);                  // chosen-only: not_chosen stays NULL
    maybeSeedChoiceWander(a);            // the kept album heads the Trail
  }
  advanceDeck();                         // keeping is additive — move on immediately
  renderKeepReveal(a);                   // ...and open the (annotation-only) keep reveal
  openChoiceReveal();
}

// Keep from Album details (request 1): write the keep and track it, but STAY on the
// story — the bar re-renders to a "Kept ✓ / undo" acknowledgment. Re-render the deck
// behind the modal so it reflects the kept state when the story closes.
async function keepFromStory(a) {
  if (!deckState) return;
  const key = albumKey(a);
  if (deckState.kept.has(key)) return;
  currentKeepAlbum = a;
  pendingChooseWhy = "";
  savedChooseWhy = "";
  currentChoiceId = null;
  await recordKeep(a, key);
  maybeSeedChoiceWander(a);
  renderDeck();
}

// Undo a keep — delete its choice row and untrack it. From the deck's kept state or
// Album details' "undo". Optimistic: untrack + repaint first, then DELETE.
async function unkeepRecord(key) {
  if (!deckState) return;
  const id = deckState.kept.get(key);
  deckState.kept.delete(key);
  unmarkMet(key);                        // an undone keep can be met again today
  renderDeck();
  if (id != null) {
    try { await fetch(`/api/choices/${id}`, { method: "DELETE" }); }
    catch (e) { /* best-effort; the row can also be removed from the Notebook */ }
  }
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

// The keep moment: a single opened record with its Listen door and a one-tap "what
// does this bring back?" note (saved to the choice's note, exactly like the old why
// editor via saveChoiceReason). No "other record" — a keep has no not-chosen (D4).
// The deck has already advanced by the time this opens, so this reveal is purely
// annotation: dismissing it any way just returns you to the (next) record.
//   1. Identity: a small art thumb + artist — title + the browse meta line. It is
//      NOT a door into Album details — a nested full modal opened from here looped
//      first-run testers between the reveal and the story (2026-07-15, owner). The
//      artist / genre / label threads in the meta line stay their own pull-doors; the
//      record's full story stays one tap away from the deck card itself.
//   2. Listen (#choiceListen): the compact one-pill row (listening is secondary to
//      the keep you've just made).
//   3. The note: a "✎ Take a note" button opens the composer inline (shares the
//      note-modal chrome), saving to choices.note.
//   4. "Back to today's records" closes the reveal.
function renderKeepReveal(a) {
  const key = albumKey(a);
  a._doorPending = poolOn() && !a._doorFilled;
  $("#pick").innerHTML = `
    <div class="choice-identity">
      <div class="choice-thumb">${coverHtml(a, { fix: false })}</div>
      <div class="choice-id-text">
        <h2 class="choice-chose">You kept…</h2>
        <p class="choice-title">${artistLink(a.artist)} — <b>${esc(a.title)}</b></p>
        <p class="choice-sub">${metaSub(a)}</p>
      </div>
    </div>
    <div id="choiceListen">${listenBlockHtml(a, { compact: true })}</div>
    <div class="why">
      <button type="button" id="chooseWhyToggle" class="why-open-btn">✎ Write a note</button>
      <div id="chooseWhyBox" class="why-box hidden">
        <textarea id="chooseWhyNote" rows="5" aria-label="Your note on this album"></textarea>
        <div class="why-actions">
          <button id="chooseWhySave">Save note</button>
          <span id="chooseWhyStatus" class="muted"></span>
        </div>
      </div>
    </div>
    <div class="keep-done">
      <button type="button" id="keepDone" class="commit-btn">Back to today's records</button>
    </div>`;
  // Eager-load the cover rather than relying on IntersectionObserver, which is
  // unreliable inside a modal that was display:none at observe time.
  observeArt($("#pick"), { eager: 4 });

  // Fan out the confirmed door and repaint just the Listen row once it settles —
  // never leave the spinner spinning.
  resolveDoor(key).then(() => {
    a._doorPending = false;
    const el = $("#choiceListen");
    if (el) el.innerHTML = listenBlockHtml(albumData[key] || a, { compact: true });
  });

  // Restore any in-progress note text and wire the composer, sharing
  // saveChoiceReason / refreshChooseWhyState with the old why editor. The write for
  // a guest rides its keep in the on-device buffer (store-bridge PATCHes it) and
  // arrives at signup; the keep-invitation lives on the save toast, like notes.
  $("#chooseWhyNote").value = pendingChooseWhy;
  $("#chooseWhyNote").addEventListener("input", () => {
    pendingChooseWhy = $("#chooseWhyNote").value;
    $("#chooseWhyStatus").textContent = "";
    refreshChooseWhyState();
  });
  refreshChooseWhyState();
  $("#chooseWhySave").addEventListener("click", saveChoiceReason);

  // Keep the composer collapsed behind its button so keeping never pops the mobile
  // keyboard; revealing it never grabs focus (the keyboard waits for a real tap).
  const whyToggle = $("#chooseWhyToggle");
  const whyBox = $("#chooseWhyBox");
  const openWhy = () => {
    whyBox.classList.remove("hidden");
    whyToggle.classList.add("hidden");
  };
  whyToggle.addEventListener("click", openWhy);
  if (pendingChooseWhy.trim()) openWhy();

  // "Back to today's records" just closes — the deck already advanced on keep.
  $("#keepDone").addEventListener("click", closeChoiceReveal);
}

// Reorder-only pref change: the SET (what surfaces) is unchanged, so we don't
// refetch/re-draw — we just restack the listen order on whatever's on screen: the
// open keep reveal's compact row and/or the deck card's listen block. (A membership
// change goes through refreshSurfaces instead, which redraws from the new pool.)
function repaintChoiceListen() {
  const rv = document.getElementById("choiceListen");
  if (rv && currentKeepAlbum &&
      !$("#choiceRevealModal").classList.contains("hidden")) {
    const k = albumKey(currentKeepAlbum);
    rv.innerHTML = listenBlockHtml(albumData[k] || currentKeepAlbum, { compact: true });
  }
  const dk = document.getElementById("deckListen");
  if (dk && deckState && deckState.idx < deckState.records.length) {
    const a = deckState.records[deckState.idx];
    dk.innerHTML = listenBlockHtml(albumData[albumKey(a)] || a, { compact: true });
  }
}

// E2: the keep reveal is a door (the artist-panel pattern), not a panel below the
// deck. open/close only toggle the overlay — renderKeepReveal already built the
// content and wired it, so re-opening keeps the why-box and its pending text.
function openChoiceReveal() {
  const m = $("#choiceRevealModal");
  if (!m) return;
  m.classList.remove("hidden");
  // Move focus into the door (a11y) but never into the textarea — keeping an album
  // must not pop the mobile keyboard (the same papercut renderKeepReveal guards).
  const close = $("#choiceRevealClose");
  if (close) close.focus({ preventScroll: true });
}
function closeChoiceReveal() {
  const m = $("#choiceRevealModal");
  if (m) m.classList.add("hidden");
}

// Record a keep as a chosen-only choice row (not_chosen null). Kept general — it
// still accepts not_chosen and PATCHes when currentChoiceId is already set, which
// the note composer's re-record fallback relies on.
async function recordChoice(chosen, not_chosen, opts = {}) {
  // Identity travels as uid; chosen_id/not_chosen_id ride along as Discogs provenance
  // (NULL for an MB-only pool album) so the server/store can still snapshot the
  // album and the forest (albums.db) keeps its release_id seeds.
  const body = {
    chosen_uid: albumKey(chosen),
    not_chosen_uid: not_chosen ? albumKey(not_chosen) : null,
    chosen_id: chosen.release_id != null ? chosen.release_id : null,
    not_chosen_id: not_chosen && not_chosen.release_id != null ? not_chosen.release_id : null,
    day: mdParam(),
  };
  // Expose the write as a promise the reason editor can await, and treat a non-2xx
  // response as a failure (a store-bridge/server error resolves with an error body,
  // it doesn't throw — so `r.ok` is the honest signal, not the fetch rejecting).
  recordChoicePromise = (async () => {
    if (currentChoiceId == null) {
      let r;
      try {
        r = await fetch("/api/choices", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (netErr) {
        netErr.neverReached = true;      // the request never completed — safe to re-POST
        throw netErr;
      }
      if (!r.ok) {
        const err = new Error("POST /api/choices → " + r.status);
        err.neverReached = writeNeverReachedApp(r.status);
        throw err;
      }
      const data = await r.json().catch(() => ({}));
      if (data.id == null) throw new Error("POST /api/choices returned no id");
      currentChoiceId = data.id;
    } else {
      const r = await fetch(`/api/choices/${currentChoiceId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chosen_uid: body.chosen_uid, not_chosen_uid: body.not_chosen_uid,
          chosen_id: body.chosen_id, not_chosen_id: body.not_chosen_id,
        }),
      });
      if (!r.ok) throw new Error(`PATCH /api/choices/${currentChoiceId} → ` + r.status);
    }
  })();
  try {
    await recordChoicePromise;
  } catch (e) {
    // A silently-lost keep is worse than a visible error. Surface it and offer a
    // retry; currentChoiceId stays null so the retry re-POSTs a fresh row. (Callers
    // fire-and-forget, so this catch also keeps the rejection from going unhandled;
    // saveChoiceReason awaits `recordChoicePromise` directly to see the failure.)
    // `opts.quiet`: the caller is running its own retry loop (recordKeep) and owns
    // the message, so don't toast once per attempt.
    if (opts.quiet) throw e;
    showToast("Couldn't save your keep — tap to retry", "Retry",
      () => recordChoice(chosen, not_chosen));
  }
}

// U11: the "why" note lingers on screen after saving (unlike the note modal,
// which closes), so "did it actually save?" needs a visible answer beyond a
// status line. We track the on-disk text in `savedChooseWhy`: when the textarea
// matches it the box settles quiet (`.clean`); when it differs the box lights up
// (`.dirty`) to say "you have unsaved changes". The state is the reassurance.
let savedChooseWhy = "";
function refreshChooseWhyState() {
  const why = document.querySelector("#pick .why");
  if (!why) return;
  const cur = ($("#chooseWhyNote").value || "").trim();
  const dirty = cur !== savedChooseWhy;
  why.classList.toggle("dirty", dirty);
  // "clean" = settled-and-saved (only meaningful once something's been saved).
  why.classList.toggle("clean", !dirty && savedChooseWhy !== "");
  const btn = $("#chooseWhySave");
  if (btn) btn.textContent = dirty
    ? (savedChooseWhy ? "Save changes" : "Save note")
    : (savedChooseWhy ? "Saved ✓" : "Save note");
}

async function saveChoiceReason() {
  const note = $("#chooseWhyNote").value.trim();
  const status = $("#chooseWhyStatus");
  status.textContent = "Saving…";
  // The keep's own POST may still be in flight, or may have failed — leaving no id
  // to hang the note on. Wait for the in-flight write, and re-record the kept album
  // if it never landed, rather than silently no-opping (which is exactly how the
  // stale-constraint 500 hid: the box accepted text but Save did nothing, no
  // feedback).
  if (currentChoiceId == null && recordChoicePromise) {
    try { await recordChoicePromise; } catch (e) { /* re-recorded below */ }
  }
  if (currentChoiceId == null && currentKeepAlbum) {
    await recordChoice(currentKeepAlbum, null);
  }
  if (currentChoiceId == null) {
    status.textContent = "Couldn't save — your keep didn't record. Try again.";
    return;
  }
  try {
    const r = await fetch(`/api/choices/${currentChoiceId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note }),
    });
    if (!r.ok) throw new Error("PATCH /api/choices note → " + r.status);
    // F26 follow-up: a guest's why is kept — on this device, riding its pick.
    // Invite once, on the first real save (edits stay quiet).
    const firstKeep = window.AOTD_GUEST && note && !savedChooseWhy;
    savedChooseWhy = note;          // this text is now what's on disk
    pendingChooseWhy = note;        // and the pending (restorable) text matches it
    status.textContent = "Saved ✓";
    refreshChooseWhyState();        // settle the box to its quiet, saved look
    if (firstKeep) {
      showToast("Kept on this device — start your Notebook to keep it for good",
        "Start →", () => { if (window.AOTDAuth) AOTDAuth.showGate("why"); });
    }
  } catch (e) {
    status.textContent = "Couldn't save (is the app running?).";
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
  bar.classList.toggle("hidden", n === 0);
  if (n === 0) closeAsidePile();
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
    list.innerHTML = `<p class="empty">Nothing skipped.</p>`;
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
  return (a.styles || "").split(",").map((t) => t.trim()).filter(Boolean)
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
  grid.innerHTML = `<div class="empty">Searching…</div>`;
  const onlyDay = $("#onlyDay").checked;
  const md = mdParam();
  const params = new URLSearchParams({ q });
  if (onlyDay && md) params.set("date", md);
  const field = $("#fieldFilter").value;
  if (field) params.set("field", field);
  try {
    const data = await (await fetch("/api/search?" + params)).json();
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
  closeStoryModal(); closeArtistPanel(); closeLabelPanel();  // a grid pull leaves any open door
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
  $("#browse").scrollIntoView({ behavior: "smooth", block: "start" });
}

// A3: pull a decade through the whole catalog. The decade isn't an FTS field, so
// this is a queryless browse (/api/browse?decade=) rather than a text search.
function searchDecade(decade, opts = {}) {
  if (!decade) return;
  if (!opts.noPush) {
    return pushAndGo(`the ${decade}`, { t: "decade", decade },
      () => searchDecade(decade, { noPush: true }));
  }
  closeStoryModal(); closeArtistPanel(); closeLabelPanel();  // a grid pull leaves any open door
  decadeBrowse = decade;
  browseScope = "all";
  $("#scope").value = "all";
  $("#onlyDayWrap").classList.remove("hidden");
  $("#onlyDay").checked = false;
  $("#fieldFilter").value = "";
  $("#search").value = "";                // queryless: clear any stale text
  $("#search").placeholder = "Search every album, across all dates…";
  setMode("browse");                      // -> loadBrowse() -> loadDecade()
  $("#browse").scrollIntoView({ behavior: "smooth", block: "start" });
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

async function runExploreSearch(term) {
  const body = $("#forestBody");
  const q = (term || "").trim();
  if (!q) {
    body.innerHTML = `<div class="empty">Search every album or song by artist,
      title, label, or genre.</div>`;
    return;
  }
  body.innerHTML = `<div class="empty">Searching…</div>`;
  try {
    // FB#37: search album titles AND track titles ("golden years" → the song, and
    // its album). Tracks degrade to [] when tracks_fts isn't built — never an error.
    const [albumsR, tracksR] = await Promise.allSettled([
      fetch("/api/search?" + new URLSearchParams({ q })).then((r) => r.json()),
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
    // With no song hits the view is unchanged (album grid only); a song hit adds a
    // compact "Songs" group above, each row a door to that song's album.
    if (!tracks.length) {
      body.innerHTML = albumsGrid;
    } else {
      const songs = `<section class="explore-group"><h3 class="explore-group-h">Songs</h3>
        <div class="song-hit-list">${tracks.map(songHitRow).join("")}</div></section>`;
      const albumsSec = albums.length
        ? `<section class="explore-group"><h3 class="explore-group-h">Albums</h3>${albumsGrid}</section>`
        : "";
      body.innerHTML = songs + albumsSec;
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
  // Remote hotlinked covers (F13): apply them now, with a dead-link fallback.
  root.querySelectorAll(".cover.placeholder[data-cover]").forEach((el) => {
    const url = el.dataset.cover;
    el.removeAttribute("data-cover");
    applyCover(el.dataset.rid, url, el);
  });
  // The rest are genuinely missing — lazy-fetch them on demand.
  const els = Array.from(
    root.querySelectorAll(".cover.placeholder[data-rid]:not([data-cover])"));
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

// The "Fix art" button is the one bit of cover DOM every state needs (loaded
// cover, placeholder, dead-link fallback). Build it in one place (R7).
function fixArtButton(rid) {
  const b = document.createElement("button");
  b.className = "fixart";
  b.dataset.rid = rid;
  b.textContent = "Fix art";
  return b;
}

// Turn a cover element back into a labelled placeholder with a Fix-art nudge —
// used when a remote hotlinked cover (F13) is dead/expired so it degrades
// gracefully instead of showing a broken image. A dead link == no art found.
function markPlaceholder(el, rid) {
  const info = albumIndex[rid] || {};
  el.classList.add("placeholder", "no-art");
  el.style.backgroundImage = "";
  el.style.setProperty("--ph-hue", phHue(rid));
  el.textContent = coverLabel(info);
  el.appendChild(fixArtButton(rid));
}

// #7: flag every placeholder for this release as "no art found" — a small
// caption under the leaf watermark — once a lookup has confirmed none exists.
// CSS draws the label from the .no-art class (::after), so there's no DOM to
// rebuild; applyCover removes the class if art turns up later.
function markNoArt(rid) {
  document.querySelectorAll(`.cover.placeholder[data-rid="${rid}"]`)
    .forEach((el) => el.classList.add("no-art"));
}

function applyCover(rid, cover, only) {
  const targets = only ? [only]
    : document.querySelectorAll(`.cover[data-rid="${rid}"]`);
  const reveal = (el) => {
    el.classList.remove("placeholder", "no-art");
    el.style.backgroundImage = `url('${cssUrl(cover)}')`;
    el.textContent = "";
    el.appendChild(fixArtButton(rid));
    // Remember the resolved cover on the album data so every OTHER surface — the
    // story modal especially — renders the SAME image instead of re-resolving to a
    // different one (feedback #65: deck cover ≠ details cover).
    if (albumData[rid] && albumData[rid].cover !== cover) albumData[rid].cover = cover;
  };
  targets.forEach((el) => {
    // Hotlinked covers can be slow, 404, or expire. Load first, reveal after:
    // stripping the placeholder text before the image arrives left a card with
    // no art AND no words while a dead/slow link dangled (feedback #15).
    if (isRemoteUrl(cover)) {
      const probe = new Image();
      probe.onload = () => reveal(el);
      probe.onerror = () => markPlaceholder(el, rid);
      probe.src = cover;
    } else {
      reveal(el);
    }
  });
}

// --- FIX ARTWORK modal ------------------------------------------------------
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
  $("#noteModal").classList.remove("hidden");
  // Do NOT focus the textarea here — on mobile that pops the keyboard the
  // instant the modal opens (owner, Android Chrome guest v77). The keyboard
  // should wait for a deliberate tap into the field.
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
    fetch("/api/search?" + params).then((r) => r.json()),
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
    items.push({ kind: "person", uid: "per:" + p.person_id, label: p.name,
      ref: { kind: "person", name: p.name, person_id: p.person_id } });
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
    const pid = el.dataset.pid, name = el.dataset.name || "";
    if (!pid) return null;
    return { kind: "person", uid: "per:" + pid, label: name,
      ref: { kind: "person", name, person_id: pid } };
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
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || "failed");
    closeNoteModal();
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
        const url = it.kind === "note" ? `/api/journal/note/${it.id}` : `/api/choices/${it.id}`;
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

// Keep both note surfaces live after a write: reload the Remember shelf when
// it's showing, and refresh the Your notes door when one is open (it's reachable
// from anywhere, so this runs regardless of mode).
async function refreshJournalAndModal() {
  if (currentMode() === "journal") await loadTrail(true);
  if (yourNotesRid != null) fetchYourNotes(yourNotesRid);
}

// --- N3: the field-notebook TRAIL --------------------------------------------
// One reverse-chronological stream of the choices and notes you authored (free +
// record-anchored), grouped by day. Read-time assembly of the two existing feeds
// (/api/journal's grouped notes + /api/choices) — nothing new is stored, and it's
// strictly pull (you open Remember; nothing is surfaced at you).
let _trailLoading = null;
let _trailSeq = 0;                        // stale-response guard for the search box
let _trailNotesById = {};                // id -> {id, body, track, timestamp} for edit-on-tap
async function loadTrail(force = false) {
  if (_trailLoading && !force) return _trailLoading;
  const q = $("#journalSearch").value.trim();
  const seq = ++_trailSeq;
  const p = (async () => {
    try {
      const [journal, choicesResp] = await Promise.all([
        fetch("/api/journal" + (q ? `?q=${encodeURIComponent(q)}` : "")).then((r) => r.json()),
        fetch("/api/choices").then((r) => r.json()),
      ]);
      // A newer search (or reload) started after us — discard this response so a
      // slow fetch can't clobber fresher results (e.g. clearing the box).
      if (seq !== _trailSeq) return;
      const entries = buildTrailEntries(journal, choicesResp, q);
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
      renderTrail(entries);
    } catch (e) {
      if (seq === _trailSeq) {
        $("#trail").innerHTML = `<div class="empty">Couldn't load your notebook just now.</div>`;
      }
    }
  })();
  _trailLoading = p;
  try { return await p; } finally { if (_trailLoading === p) _trailLoading = null; }
}

// Flatten the grouped notes feed + the choices feed into dated entries. A free note
// arrives in the null-uid group (uid/artist/title null) → a free noticing. Notes are
// already server-filtered by ?q=; choices are filtered here by the same query.
function buildTrailEntries(journal, choicesResp, q) {
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
    </div>
  </button>`;
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

function renderTrail(entries) {
  const box = $("#trail");
  if (!box) return;
  _trailNotesById = {};
  if (!entries.length) {
    const q = $("#journalSearch").value.trim();
    box.innerHTML = q
      ? `<div class="empty">Nothing in your notebook matches “${esc(q)}”.</div>`
      : `<div class="empty trail-empty">Your field notebook is empty.<br>
          Write down what you notice, or keep a record — it takes root here.
          <span class="te-empty-hint muted">Tap ✎ Write a note below to start.</span></div>`;
    return;
  }
  let html = "", lastDay = null;
  for (const e of entries) {
    const day = (e.at || "").slice(0, 10);
    if (day !== lastDay) {
      html += `<div class="trail-day">${esc(trailDayLabel(e.at))}</div>`;
      lastDay = day;
    }
    const entryHtml = e.kind === "note" ? trailNoteEntry(e) : trailChoiceEntry(e);
    // #48 (v2): no per-entry ✕ — deletion is via the opened note's Delete button, or
    // long-press → selection mode (multi-delete). The row carries its identity for
    // that mode; the check badge is a sibling of the entry button (a button can't
    // nest a button) and shows only while selecting.
    html += `<div class="trail-row" data-kind="${esc(e.kind)}" data-id="${esc(String(e.id))}">`
      + `${entryHtml}<span class="te-check" aria-hidden="true"></span></div>`;
  }
  box.innerHTML = html;
  observeArt(box);
  if (_trailSelecting) syncTrailSelectionUI();   // keep highlights across a re-render
}

// Tap a note entry → open it to read/edit (free or record-anchored). Tap a choice
// entry → open its chosen record's details (handled by the delegated click below).
function openTrailNote(el) {
  const n = _trailNotesById[el.dataset.noteId];
  if (!n) return;
  openNoteModal(el.dataset.uid || null, n);
}

// --- CONNECTIONS: a place to wander (C1) ------------------------------------
// Not a list of terms but a small wood grown from your own words. Each emergent
// subject is a *clearing* you can step into: it shows the notes it came from and
// the *trails* to other subjects you wrote about in those same notes. You choose
// where to wander; nothing is surfaced unbidden, and the shape is only which of
// your words keep company with which (VISION.md: pull-only, emergent, no imposed
// map). Mostly still — motion happens only as you step between clearings.
let connGraph = null;   // {subjects, notes, notes_total, min_notes}
let connSubj = {};      // term.lower() -> subject node
let connPath = [];      // the clearings walked, in order (the breadcrumb)

async function loadConnections() {
  try {
    connGraph = await (await fetch("/api/connections")).json();
  } catch (e) {
    $("#connPath").innerHTML = "";
    $("#connWander").innerHTML =
      `<div class="empty">Couldn't load your connections.</div>`;
    return;
  }
  connSubj = {};
  (connGraph.subjects || []).forEach((s) => {
    connSubj[s.term.toLowerCase()] = s;
  });
  connPath = [];
  renderConnections();
}

function renderConnections() {
  const subjects = (connGraph && connGraph.subjects) || [];
  if (!subjects.length) {
    $("#connPath").innerHTML = "";
    // The seed of "gamify making data that lets patterns emerge": progress
    // toward a first clearing, never a hook.
    const n = (connGraph && connGraph.notes_total) || 0;
    const msg = n === 0
      ? `No clearings yet. As you write notes, the words and phrases you keep
         returning to take root here — your own wood, not one we planted.`
      : `${n} note${n !== 1 ? "s" : ""} so far. Keep writing — once a thread
         recurs across a few notes, a clearing opens here for it.`;
    $("#connWander").innerHTML = `<div class="empty">${msg}</div>`;
    return;
  }
  renderConnPath();
  if (connPath.length) renderClearing(connPath[connPath.length - 1]);
  else renderConnEntry();
}

function renderConnPath() {
  const el = $("#connPath");
  if (!connPath.length) { el.innerHTML = ""; return; }
  const crumbs = connPath.map((t, i) =>
    `<button class="crumb" data-walk="${i}">${esc(t)}</button>`
  ).join(`<span class="crumb-sep">›</span>`);
  el.innerHTML =
    `<button class="crumb crumb-home" data-walk="-1">the wood</button>` +
    `<span class="crumb-sep">›</span>${crumbs}`;
}

function renderConnEntry() {
  // The edge of the wood: every clearing is a way in, sized by how travelled it
  // is (how many notes it recurs across). You pick where to step; nothing pulls.
  const subjects = connGraph.subjects;
  const max = Math.max.apply(null, subjects.map((s) => s.count).concat(1));
  const ways = subjects.map((s) => {
    const size = (0.85 + 0.7 * (s.count / max)).toFixed(2);
    return `<button class="way-in" data-enter="${esc(s.term)}"
      style="font-size:${size}rem" title="${s.count} note${
        s.count !== 1 ? "s" : ""}">${esc(s.term)}</button>`;
  }).join("");
  $("#connWander").innerHTML =
    `<p class="wander-hint">Step into a clearing to begin wandering.</p>
     <div class="ways-in clearing-in">${ways}</div>`;
}

function renderClearing(term) {
  const node = connSubj[(term || "").toLowerCase()];
  if (!node) { connPath = []; renderConnPath(); renderConnEntry(); return; }
  const notes = (node.note_ids || [])
    .map((id) => connGraph.notes[id]).filter(Boolean);
  const notesHtml = notes.length
    ? notes.map(connNote).join("")
    : `<p class="muted">No notes here now.</p>`;
  const trails = (node.trails || []).map((t) =>
    `<button class="trail" data-enter="${esc(t.term)}">↳ ${esc(t.term)}<span
       class="trail-shared" title="written about together in ${t.shared} note${
       t.shared !== 1 ? "s" : ""}">${t.shared}</span></button>`).join("");
  const trailsHtml = trails
    ? `<div class="trails"><span class="trails-label">trails from here</span>
         <div class="trail-row">${trails}</div></div>`
    : `<p class="muted trails-none">No trails lead on from here yet — wander
         back, or sit a while with these notes.</p>`;
  $("#connWander").innerHTML = `
    <div class="clearing clearing-in">
      <div class="clearing-head">
        <h3>${esc(node.term)}</h3>
        <span class="clearing-count">${node.count} note${
          node.count !== 1 ? "s" : ""}</span>
      </div>
      <div class="clearing-notes">${notesHtml}</div>
      ${trailsHtml}
      <button class="link-quiet conn-tojournal"
        data-conn-journal="${esc(node.term)}">Read these in the Notebook →</button>
    </div>`;
}

function connNote(n) {
  const ctx = [n.artist, n.title].filter(Boolean).join(" — ");
  return `<div class="jitem">
      <div class="jnote">${renderMarkdown(n.body)}${
        n.track ? ` <span class="jtag">track ${esc(n.track)}</span>` : ""}${
        n.timestamp ? ` <span class="jtag">@ ${esc(n.timestamp)}</span>` : ""}</div>
      <div class="jlinks"><span class="jdate">${
        esc((n.created_at || "").slice(0, 10))}</span>${
        ctx ? ` <span class="jctx">${esc(ctx)}</span>` : ""}</div>
    </div>`;
}

function walkInto(term) {
  const last = connPath[connPath.length - 1];
  if (!last || last.toLowerCase() !== term.toLowerCase()) connPath.push(term);
  renderConnPath();
  renderClearing(term);
}

function walkTo(index) {   // breadcrumb: -1 returns to the edge of the wood
  connPath = index < 0 ? [] : connPath.slice(0, index + 1);
  renderConnections();
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

function noteItemHtml(n) {
  return `
    <div class="jitem">
      <div class="jnote">${renderMarkdown(n.body)}${
        n.track ? ` <span class="jtag">track ${esc(n.track)}</span>` : ""}${
        n.timestamp ? ` <span class="jtag">@ ${esc(n.timestamp)}</span>` : ""}</div>
      <div class="jlinks">
        <span class="jdate">${esc((n.created_at || "").slice(0, 10))}${
          n.updated_at && n.updated_at !== n.created_at ? " · edited" : ""}</span>
        <button class="jedit" data-note="${n.id}">edit</button>
        <button class="jdel" data-note="${n.id}">delete</button>
      </div>
      <!-- N1 §4.4 (3b): one quiet pull. Nothing is marked inline; tapping this reveals
           only the words in THIS note that recur across your others, then each word
           pulls your other notes using it — verbatim, on demand, never a standing map. -->
      <button class="note-threads-btn" data-note="${n.id}">↳ threads from this note</button>
      <div class="note-threads" data-note="${n.id}"></div>
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

// N1 §4.4 (3b) — the in-note word pull. The affordance is a constant quiet invitation
// (never marks your words inline); tapping it reveals only the terms in this note that
// recur across your other notes. Tapping a term then pulls those other notes, verbatim.
// All pull, all on-demand — the T3 index used as a lookup you trigger, never a map.
function threadsBox(noteId) {
  return document.querySelector(`.note-threads[data-note="${CSS.escape(String(noteId))}"]`);
}
async function toggleNoteThreads(noteId) {
  const box = threadsBox(noteId);
  if (!box) return;
  if (box.dataset.open === "1") { box.dataset.open = ""; box.innerHTML = ""; return; }
  box.dataset.open = "1";
  box.innerHTML = `<p class="thread-hint muted">Looking for threads…</p>`;
  try {
    const data = await (await fetch(
      `/api/journal/note/${encodeURIComponent(noteId)}/threads`)).json();
    if (box.dataset.open !== "1") return;                // toggled shut under us
    const threads = data.threads || [];
    if (!threads.length) {
      box.innerHTML = `<p class="thread-hint muted">Nothing here recurs across your
        other notes yet — this thread grows as you write.</p>`;
      return;
    }
    box.innerHTML =
      `<p class="thread-hint muted">Threads from this note — pull one to find your
        other notes on it:</p>
       <div class="thread-chips">${threads.map((t) =>
        `<button class="note-thread-chip" data-term="${esc(t.term)}"
          data-note="${esc(String(noteId))}">${esc(t.term)}<span class="thread-n muted">${
          t.count}</span></button>`).join("")}</div>
       <div class="thread-result"></div>`;
  } catch (e) {
    box.innerHTML = `<p class="thread-hint muted">Couldn't load threads.</p>`;
  }
}
async function pullTermNotes(term, fromNoteId) {
  const box = threadsBox(fromNoteId);
  const out = box && box.querySelector(".thread-result");
  if (!out) return;
  out.innerHTML = `<p class="thread-hint muted">Pulling…</p>`;
  try {
    const data = await (await fetch(
      `/api/journal/term?q=${encodeURIComponent(term)}`)).json();
    const others = (data.notes || []).filter((n) => String(n.id) !== String(fromNoteId));
    if (!others.length) {
      out.innerHTML = `<p class="thread-hint muted">Only this note uses
        “${esc(term)}” so far.</p>`;
      return;
    }
    out.innerHTML =
      `<p class="thread-title muted">Other notes where you wrote “${esc(term)}”</p>` +
      others.map((n) => `
        <div class="echo-item">
          <p class="echo-rec">${esc(n.artist || "")}${n.artist && n.title ? " — " : ""}${
            esc(n.title || "")}${n.released
              ? ` <span class="muted">${esc(String(n.released).slice(0, 4))}</span>` : ""}</p>
          <div class="echo-body">${renderMarkdown(n.body)}</div>
          <p class="echo-date muted">${esc((n.created_at || "").slice(0, 10))}</p>
        </div>`).join("") +
      `<p class="echo-foot muted">shown because you pulled this word · your own words ·
        only on this device</p>`;
  } catch (e) {
    out.innerHTML = `<p class="thread-hint muted">Couldn't pull that thread.</p>`;
  }
}

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
  // pencil / a right-click ties a note to the person (v8 per:<pid>). An unlinked
  // name has no stable id, so it stays plain text — no door, no note (v1 scope).
  if (cr.person_id) {
    return `<div class="credit-line note-anchor" data-note-kind="person"
      data-pid="${cr.person_id}" data-name="${esc(cr.name)}">${role}<button
        class="credit-door" data-pid="${cr.person_id}" data-name="${esc(cr.name)}"
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
    const data = await (await fetch(
      `/api/album/${encodeURIComponent(uid)}/tracks`)).json();
    if (storyRid !== uid) return;              // modal moved on under us
    renderStoryTracks(data.tracks || []);
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
  row.scrollIntoView({ block: "center", behavior: "smooth" });
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

// Share a record so someone else can find it on Music Forest (owner ask, 2026-07-17).
// A user-initiated, outward door (VISION P2): you reach for it; the link opens the
// recipient onto this exact album (openAlbumDeepLink reads ?album=<uid> on boot). Native
// share sheet where the platform offers one, else copy the link. No tracking, no
// attribution tag — just a plain link (the "found from ___" playlist idea was declined).
async function shareAlbum(a) {
  if (!a) return;
  const key = albumKey(a);
  if (!key) return;
  const url = location.origin + "/?album=" + encodeURIComponent(key);
  const title = `${a.artist} — ${a.title}`;
  if (navigator.share) {
    try { await navigator.share({ title, text: title + " — on Music Forest", url }); return; }
    catch (e) { if (e && e.name === "AbortError") return; }   // cancelled; don't also copy
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast("Link copied — send it so a friend can find this record");
  } catch (e) {
    showToast("Couldn't copy the link automatically — it's " + url);
  }
}

// A shared link lands as origin/?album=<uid>; on boot, open that record's details over
// the default view (a door — closing returns you to Today/Explore). The URL is cleaned
// first so a refresh doesn't reopen it and the address bar stays tidy.
async function openAlbumDeepLink() {
  let uid;
  try { uid = new URLSearchParams(location.search).get("album"); } catch (e) { return; }
  if (!uid) return;
  try { history.replaceState(history.state, "", location.origin + "/"); } catch (e) { /* ok */ }
  try { await openAlbumByUid(uid); } catch (e) { /* a stale/unknown uid just no-ops */ }
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
  const prov = provenanceHtml(a);
  $("#storyHead").innerHTML =
    `<p class="story-kicker">${stoneGlyph()}Album details</p>
     <div class="story-head-row">
       ${coverHtml(a)}
       <div class="story-head-text">
         <h3>${esc(a.artist)} — ${esc(a.title)}</h3>
         <p class="muted">${esc([a.released, a.country].filter(Boolean).join(" · "))}</p>
         ${listenBlockHtml(a)}
         <button type="button" class="story-share" data-share-album
           aria-label="Share this record so someone can find it on Music Forest"><span
           class="ss-i" aria-hidden="true">↗</span> Share</button>
         ${prov ? `<p class="story-source"><span class="src-label">Album details from</span>${prov}</p>` : ""}
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
  closeArtistPanel(); closeLabelPanel(); closePersonPanel();  // one door at a time
  storyRid = rid;
  // Spinner while the confirmed door resolves (a pool album); fillDoorOnOpen
  // clears it once the door settles, so the listen block lands on either the real
  // button or the honest copy-search — never a premature "no link".
  a._doorPending = poolOn() && !a._doorFilled;
  renderStoryHead(a);
  renderStoryDeckActions(rid);                // request 1: Keep / Set aside when this
                                              // is the current Today record
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

// Request 1: Album details opened for the CURRENT Today record gets Keep / Set aside
// right here. Keep stays put and acknowledges (undoable); Set aside closes and moves
// the deck on. Hidden everywhere else (a browse card, a Notebook entry, a wandered
// album) — those aren't the record you're deciding on today.
function renderStoryDeckActions(rid) {
  const bar = $("#storyDeckActions");
  if (!bar) return;
  const isDeckRecord = currentMode() === "decide" && deckState &&
    deckState.idx < deckState.records.length &&
    albumKey(deckState.records[deckState.idx]) === rid;
  if (!isDeckRecord) { bar.classList.add("hidden"); bar.innerHTML = ""; return; }
  bar.classList.remove("hidden");
  bar.innerHTML = deckState.kept.has(rid)
    ? `<p class="deck-kept-ack">Kept ✓ — in your Notebook
         <button type="button" class="linkish" data-story-unkeep>undo</button></p>`
    : `<div class="deck-buttons">
         <button type="button" class="set-aside-btn" data-story-setaside>Skip</button>
         <button type="button" class="keep-btn" data-story-keep>Keep</button>
       </div>`;
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
  closeStoryModal(); closeLabelPanel(); closePersonPanel();  // one door at a time
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
  $("#artistHead").innerHTML =
    `<h3>${esc(name)}</h3>
     <p class="muted">${n} album${n !== 1 ? "s" : ""} on file${dg}</p>`;
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
    const [echo, tied] = await Promise.all([
      fetch(`/api/journal/artist?name=${encodeURIComponent(name)}`).then((r) => r.json()),
      fetch(`/api/journal/album/${encodeURIComponent("art:" + name)}`).then((r) => r.json()),
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

// --- LABEL PANEL (T2): a label's catalogue as a bounded door -----------------
// A label, like an artist, is a finite surveyable catalogue — so it gets a panel
// (a door you can close to return from) rather than taking over the grid as a
// corridor. Mirrors the artist panel, minus the bio. Exact-match server-side, so
// it only ever shows records actually on that label.
let labelPanelName = null;   // the label currently shown (guards async races)

async function openLabelPanel(name, opts = {}) {
  name = (name || "").trim();
  if (!name) return;
  if (!opts.noPush) {
    return pushAndGo(name, { t: "label", name },
      () => openLabelPanel(name, { noPush: true }));
  }
  closeStoryModal(); closeArtistPanel(); closePersonPanel();  // one door at a time
  labelPanelName = name;
  $("#labelHead").innerHTML =
    `<h3>${esc(name)}</h3><p class="muted">Loading catalog…</p>`;
  $("#labelCatalog").innerHTML = "";
  $("#labelModal").classList.remove("hidden");
  let data;
  try {
    data = await (await fetch(
      `/api/label?name=${encodeURIComponent(name)}`)).json();
  } catch (e) {
    if (labelPanelName === name) $("#labelHead").innerHTML =
      `<h3>${esc(name)}</h3><p class="muted">Couldn't load the catalog.</p>`;
    return;
  }
  if (labelPanelName !== name) return;           // a newer panel opened
  const albums = data.albums || [];
  const n = albums.length;
  const dg = data.discogs_url
    ? ` · <a href="${esc(data.discogs_url)}" target="_blank"
        rel="noopener">Discogs ↗</a>` : "";
  const more = n >= 500 ? " (latest 500)" : "";
  $("#labelHead").innerHTML =
    `<h3>${esc(name)}</h3>
     <p class="muted">${n} album${n !== 1 ? "s" : ""} on this label${more}${dg}</p>`;
  $("#labelCatalog").innerHTML = n
    ? albums.map(browseCard).join("")
    : `<div class="empty">No catalog albums on file for ${esc(name)}.</div>`;
  observeArt($("#labelCatalog"), { eager: 24 });
}

function closeLabelPanel() {
  $("#labelModal").classList.add("hidden");
  labelPanelName = null;
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

async function openPersonPanel(pid, name, opts = {}) {
  pid = parseInt(pid, 10);
  if (!pid || pid < 1) return;
  name = (name || "").trim();
  if (!opts.noPush) {
    return pushAndGo(name || `person #${pid}`, { t: "person", id: pid, name },
      () => openPersonPanel(pid, name, { noPush: true }));
  }
  closeStoryModal(); closeArtistPanel(); closeLabelPanel();  // one door at a time
  personPanelId = pid;
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
    data = await (await fetch(`/api/person?id=${pid}&name=${
      encodeURIComponent(name)}`)).json();
  } catch (e) {
    if (personPanelId === pid) $("#personHead").innerHTML =
      `<h3>${esc(name || `#${pid}`)}</h3>
       <p class="muted">Couldn't load the credits.</p>`;
    return;
  }
  if (personPanelId !== pid) return;             // a newer panel opened
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
       have on file${across}${more}${dg}</p>`;
  $("#personCatalog").innerHTML = albums.length
    ? albums.map(personCard).join("")
    : `<div class="empty">No credits on file for ${esc(personPanelName)}.</div>`;
  observeArt($("#personCatalog"), { eager: 24 });
  fetchPersonWords(pid, personPanelName);   // N1 §4.4 (3a): your words on this person
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
async function fetchPersonWords(pid, name) {
  try {
    // Two pulls: notes that NAME this person (the fuzzy, catalog-anchored echo),
    // and notes tied DIRECTLY to the person entity (v8: uid 'per:<pid>', a stable
    // id — exact, no anchoring needed). The tied notes lead (most direct).
    const [data, tied] = await Promise.all([
      fetch(`/api/journal/person?name=${encodeURIComponent(name)}`).then((r) => r.json()),
      fetch(`/api/journal/album/${encodeURIComponent("per:" + pid)}`).then((r) => r.json()),
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
    await Promise.all(raw
      .filter((n) => n.match_kind === "partial" && n.uid)
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
  try { return JSON.stringify(nav); } catch (e) { return "nav"; }
}

const MODE_LABELS = {
  decide: "Today", forest: "Explore", browse: "Browse",
  journal: "Notebook",   // the tab label; the mode key stays `journal` in code
};

function rootLabel() {
  // What you were doing before you forked — the anchor the breadcrumb pins.
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
    scrollY: window.scrollY || window.pageYOffset || 0,
    modal: labelPanelName ? { t: "label", name: labelPanelName }
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
  closeLabelPanel();
  closePersonPanel();
  closeStoryModal();
  // Open the door first, so returning to an album/artist/label you discovered
  // appears *immediately* — not after the (possibly slow) background grid
  // reloads behind it. The album data is already in memory from this session,
  // so the modal can open before the background catches up.
  const openDoor = () => {
    if (!s.modal) return;
    if (s.modal.t === "artist") openArtistPanel(s.modal.name, { noPush: true });
    else if (s.modal.t === "label") openLabelPanel(s.modal.name, { noPush: true });
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
    if (!already) await loadMode(s.mode);
  }
}

// Perform a door's navigation without recording it (used to re-walk a node whose
// snapshot we don't have — e.g. a freshly-loaded saved Trail).
function applyNav(nav) {
  if (!nav) return;
  if (nav.t === "artist") openArtistPanel(nav.name, { noPush: true });
  else if (nav.t === "label") openLabelPanel(nav.name, { noPush: true });
  else if (nav.t === "person") openPersonPanel(nav.id, nav.name, { noPush: true });
  else if (nav.t === "story") openStoryModal(nav.rid, { noPush: true });
  else if (nav.t === "catalog") searchCatalog(nav.field, nav.term, { noPush: true });
  else if (nav.t === "decade") searchDecade(nav.decade, { noPush: true });
  // A keep-seeded node (H1.B1): the deck is session state we can't replay later, so
  // returning to it just lands back on Today (its snapshot restores the actual deck
  // view when one exists; this is the no-snapshot fallback).
  else if (nav.t === "pick") { showMode("decide"); enterToday(); }
}

// The one helper every pull routes through, so the discipline is automatic and a
// future pull can't forget to be returnable.
function pushAndGo(label, nav, navFn) {
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
  renderBreadcrumb();
  navFn();
}

// H1.B1: a Choose pick seeds a wander so the Trail (⤳) reflects it. Without this
// a pick is neither a wander node nor a session-history entry, so after only
// picking the Trail panel looked empty — which a new user reads as "nothing
// happened." We mirror the pushAndGo root convention: the "Choose" anchor is the
// pinned root and the picked album is the first step off it, so the breadcrumb +
// the wander map show "Choose › <album>", and any door you then pull branches
// from the pick. We never disturb an active wander; re-choosing before you've
// wandered anywhere just re-points the head.
function maybeSeedChoiceWander(a) {
  const title = (a && a.title) ? a.title : "your choice";
  const rid = albumKey(a);
  if (wanderCursor < 0) {
    const root = {
      id: ++_wanderSeq, parent: -1, label: rootLabel(), nav: null, snap: snapshotView(),
    };
    const pick = {
      id: ++_wanderSeq, parent: 0, label: title,
      nav: { t: "pick", rid }, snap: snapshotView(), _choiceSeed: true,
    };
    wanderTree = [root, pick];
    wanderCursor = 1;
    wanderFrontier = 1;
    renderBreadcrumb();
  } else {
    // Re-chosen (switched sides, or a fresh choice). Re-point the existing choice
    // seed to the new album so the Trail's head matches your current pick — even
    // if you'd already pulled a thread *from* the pick (which pushes a wander node,
    // so the tree is longer than 2). We only relabel the seed node in place; we
    // never restructure the tree or move where you're standing, so an active
    // wander branch is left intact.
    const seed = wanderTree.find((n) => n && n._choiceSeed);
    if (seed) {
      seed.label = title;
      seed.nav = { t: "pick", rid };
      // Refresh its snapshot only when you're actually standing on the pick
      // (otherwise leave the ancestor node's saved view untouched).
      if (wanderTree[wanderCursor] === seed) seed.snap = snapshotView();
      renderBreadcrumb();
    }
  }
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
  else { closeArtistPanel(); closeLabelPanel(); closeStoryModal(); applyNav(n.nav); }
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
  const rootMode = ["journal", "forest", "decide"].includes(currentMode());
  if (rootMode || wanderTree.length <= 1) {
    bar.classList.add("hidden"); bar.innerHTML = ""; return;
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
  const backTo = parentIdx != null ? wanderTree[parentIdx] : root;
  const showPill = path.length > 1 && !cur._choiceSeed;
  const pill = showPill
    ? `<button class="wb-back" data-wmap
        title="See the whole wander">← ${esc(shortLabel(backTo, 16))}</button>`
    : "";

  bar.innerHTML =
    `<div class="wb-crumbs">${crumbs}
       <button class="wb-map" data-wmap title="See the whole wander as a map"
         >⤳ trail</button></div>${pill}`;
  // On phones the crumbs are hidden, so a pill-less bar is an invisible strip
  // of padding — flag it so the ≤640px block can drop it entirely.
  bar.classList.toggle("no-pill", !showPill);
  bar.classList.remove("hidden");
}

// --- the wander map (layer 2) + saved Trails (layer 3) ----------------------
function openWanderMap() {
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
  $("#wanderMapModal").classList.remove("hidden");
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

  // Tidy layout: each leaf takes the next slot; each parent is centred over its
  // children. Depth drives the rows. The mycelium grows from the root outward.
  const COLW = 150, ROWH = 84, PILLW = 132, PADX = 22, PADY = 26, R = 22;
  const pos = {};
  let leaf = 0;
  (function layout(i, depth) {
    const ch = kids[i] || [];
    if (!ch.length) { pos[i] = { col: leaf++, depth }; return; }
    ch.forEach((c) => layout(c, depth + 1));
    const cols = ch.map((c) => pos[c].col);
    pos[i] = { col: (Math.min(...cols) + Math.max(...cols)) / 2, depth };
  })(0, 0);

  const maxCol = Math.max(0, leaf - 1);
  const maxDepth = Math.max.apply(null, Object.values(pos).map((p) => p.depth));
  const W = maxCol * COLW + PILLW + PADX * 2;
  const H = maxDepth * ROWH + R * 2 + PADY * 2;
  const cx = (i) => PADX + PILLW / 2 + pos[i].col * COLW;
  const cy = (i) => PADY + R + pos[i].depth * ROWH;
  // Depth of where you're standing, so nodes deeper on the line read as "ahead".
  const cursorDepth = pos[wanderCursor] ? pos[wanderCursor].depth : Infinity;
  const isAhead = (i) => onLine.has(i) && pos[i].depth > cursorDepth;

  // A deterministic wobble so a filament looks grown, not drawn — but is stable
  // across re-renders (seeded by the node id).
  const wob = (s, m) => (((s * 1103515245 + 12345) >> 8) % (2 * m + 1)) - m;

  let hairs = "";   // faint hyphae radiating off each spore — texture only
  let edges = "";   // the real connections (parent → child)

  wanderTree.forEach((n, i) => {
    if (!pos[i]) return;
    const x = cx(i), y = cy(i), lit = onLine.has(i);
    // 3 short decorative filaments per spore.
    for (let k = 0; k < 3; k++) {
      const a = (k * 2.4) + wob(i * 7 + k, 6) / 6;
      const len = 16 + wob(i * 13 + k, 8);
      const ex = x + Math.cos(a) * len, ey = y + Math.sin(a) * len;
      const mx = x + Math.cos(a) * len * 0.5 + wob(i + k, 5);
      const my = y + Math.sin(a) * len * 0.5 + wob(i - k, 5);
      hairs += `<path class="whair${lit ? " lit" : ""}"
        d="M${x},${y} Q${mx},${my} ${ex},${ey}"/>`;
    }
    if (n.parent < 0 || !pos[n.parent]) return;
    const x1 = cx(n.parent), y1 = cy(n.parent), x2 = x, y2 = y;
    const dx = x2 - x1, dy = y2 - y1;
    const litEdge = lit && onLine.has(n.parent);
    const aheadEdge = litEdge && isAhead(i);   // the segment beyond the cursor
    // Two control points, each nudged sideways the opposite way → a gentle bend.
    const c1x = x1 + dx * 0.2 + wob(i * 3, 16), c1y = y1 + dy * 0.45;
    const c2x = x2 - dx * 0.2 - wob(i * 5, 16), c2y = y2 - dy * 0.45;
    edges += `<path class="wedge ${litEdge ? "lit" : "dim"}${aheadEdge ? " ahead" : ""}"
      d="M${x1},${y1} C${c1x},${c1y} ${c2x},${c2y} ${x2},${y2}"/>`;
  });

  // Spores (SVG circles) at exact coords, with a glow when lit / current.
  let spores = "";
  Object.keys(pos).forEach((k) => {
    const i = +k, lit = onLine.has(i), cur = i === wanderCursor, ahead = isAhead(i);
    const r = cur ? 6 : (lit ? 4.5 : 3.5);
    const cls = cur ? "cur" : (lit ? "lit" : "dim");
    spores += `<circle class="wspore ${cls}${ahead ? " ahead" : ""}"
      cx="${cx(i)}" cy="${cy(i)}" r="${r}"/>`;
  });

  // Labels (HTML, below each spore) — the clickable target. Album steps carry
  // a tiny cover for at-a-glance recognition (trailThumbHtml).
  let labels = "";
  Object.keys(pos).forEach((k) => {
    const i = +k, n = wanderTree[i], cur = i === wanderCursor, ahead = isAhead(i);
    const cls = ["wnode", onLine.has(i) ? "lit" : "dim",
      cur ? "cur" : "", ahead ? "ahead" : ""].join(" ").replace(/\s+/g, " ").trim();
    const tip = cur ? "you are here"
      : ahead ? "a step ahead — go forward to here"
      : (n.parent < 0 ? "where you started" : "return here");
    labels += `<button class="${cls}" data-wgoto="${i}" title="${tip}"
      style="left:${cx(i)}px;top:${cy(i)}px">${trailThumbHtml(n.nav)}<span class="wlabel">${
      esc(shortLabel(n, 17))}</span></button>`;
  });

  body.innerHTML =
    `<div class="wtree wmycelium" style="width:${W}px;height:${H}px">
       <svg class="wtree-svg" width="${W}" height="${H}"
         viewBox="0 0 ${W} ${H}" aria-hidden="true">
         <defs>
           <filter id="wglow" x="-60%" y="-60%" width="220%" height="220%">
             <feGaussianBlur stdDeviation="2.4" result="b"/>
             <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
           </filter>
         </defs>
         ${hairs}${edges}${spores}
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
  if (!a || !a.cover) return "";
  return `<img class="wthumb" src="${esc(a.cover)}" alt="" loading="lazy">`;
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
function showMode(mode) {
  if (mode === "choices") mode = "journal";   // legacy: Choices folded into the trail
  // E2: the keep reveal is a fixed overlay, not inside #decide — so a tab switch
  // must close it explicitly. Without this it would float over Explore/Notebook.
  closeChoiceReveal();
  _mode = mode;
  // N3: Explore is its own top tab now, so each tab lights only its own mode.
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.mode === mode));
  $("#decide").classList.toggle("hidden", mode !== "decide");
  $("#forest").classList.toggle("hidden", mode !== "forest");
  $("#browse").classList.toggle("hidden", mode !== "browse");
  $("#journal").classList.toggle("hidden", mode !== "journal");
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
  if (remember) {
    // The album-door wander bar has no place on the Remember/Explore tab-roots.
    $("#wanderBar").classList.add("hidden");
    $("#journalSearch").classList.toggle("hidden", mode !== "journal");
    $("#forestFind").classList.toggle("hidden", mode !== "forest");
  }
}

function loadMode(mode) {
  if (mode === "choices") mode = "journal";   // legacy: Choices folded into the trail
  if (mode === "decide") return enterToday();   // U13: reuse the pending deck
  if (mode === "forest") return loadForest();
  if (mode === "browse") return loadBrowse();
  return loadTrail();                          // N3: Remember = one interleaved trail
}

// Feedback #21 (2026-07-07): a door (or overlay) opened on one tab must not linger
// over another — switching top-level tabs closes them all. Each close fn just hides
// its modal + resets its own state, so calling them when already closed is a no-op.
function closeAllDoors() {
  closeStoryModal(); closeArtistPanel(); closePersonPanel(); closeLabelPanel();
  if (typeof closeYourNotes === "function") closeYourNotes();
  if (typeof closeNoteModal === "function") closeNoteModal();
  if (typeof closeRememberDoor === "function") closeRememberDoor();
  if (typeof closeWanderMap === "function") closeWanderMap();
  closeAsidePile();                // the set-aside pile is a door too (Today only)
  if (_trailSelecting) exitTrailSelection();   // #48 (v2): leave selection on a tab switch
  // Feedback #21 refinement (2026-07-07): an *expanded disclosure* is a door too —
  // "why these two?" / "how, exactly?" / "Select platforms" left open on Choose were
  // still open on the next tab. Collapse them on a tab switch so each view opens tidy.
  document.querySelectorAll(".why-these, .why-these-how, #listenPref")
    .forEach((d) => d.removeAttribute("open"));
}

function setMode(mode) {
  // #58/#59: a guest gets the full nav now — Today, Explore, and a Notebook they
  // can actually use (capped at GUEST_NOTE_CAP notes). No tab is gated; the
  // account invitation is contextual instead (the note cap, the "kept on this
  // device" toasts, and the ☰ menu).
  closeAllDoors();                 // #21: no door lingers across a tab switch
  showMode(mode);                  // (showMode also closes the choice reveal)
  return loadMode(mode);
}

// H1.B2: one delegated handler for the streaming deep links. On a phone, tapping
// a service with a native scheme tries the app first and falls back to the web
// URL if the app doesn't take over within a beat (i.e. isn't installed) — which
// is exactly the plain-web behavior we had before, so nothing regresses. Desktop
// and services without a scheme just follow the normal web link.
function wireDeepLinks() {
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a[data-app],a[data-intent]");
    if (!a || !isMobileUA()) return;
    // Android prefers the intent: form when present (YT Music has no public
    // scheme); iOS ignores it and uses the plain scheme — or, with neither,
    // falls through to the default anchor (new context → universal link).
    const scheme = (/Android/i.test(navigator.userAgent || "")
      && a.getAttribute("data-intent")) || a.getAttribute("data-app");
    const web = a.href;
    if (!scheme) return;
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
      // #5: in a standalone PWA, fall back into a *separate* browser context so
      // the app's own window isn't replaced; in a normal tab keep the old
      // in-place navigation (which just opens a new tab via the anchor anyway).
      if (!settled) {
        if (isStandalone()) window.open(web, "_blank", "noopener");
        else window.location.href = web;
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
function wireListenCount() {
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a[data-listen]");
    if (!a || !navigator.sendBeacon) return;
    try {
      navigator.sendBeacon("/api/usage/listen?svc="
        + encodeURIComponent(a.dataset.listen) + "&tier=" + clientMode());
    } catch (err) { /* a counter never breaks a listen */ }
  });
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
    const href = a.href || "";
    if (!/^https?:\/\//i.test(href)) return;              // only real web links
    if (a.origin === location.origin) return;             // internal stays in-app
    e.preventDefault();
    window.open(href, "_blank", "noopener");
  });
}

// The "♫ Select platforms" chooser is an ORDERED list, not just a set picker: the
// stored array's order is your listen priority (drives the pick's primary "Listen
// on ___" button and the chip order — pickListenPlatforms). Selected platforms sit
// at the top, numbered by priority, and reorder by long-press-drag (wirePrefDrag);
// the rest sit below the divider as off rows you can add. Membership still drives
// both filters exactly as before — only the order is new.
function renderPrefList() {
  const list = document.getElementById("prefList");
  if (!list) return;
  const sel = loadListenPrefs();                                  // selected, in priority order
  const rest = CONFIRMED_PLATFORMS.map(([k]) => k).filter((k) => !sel.includes(k));
  const row = (key, on, idx) => {
    const label = _platLabel[key] || key;
    const cls = _platClass[key] || "";
    // A priority number + a drag glyph make it clear the order is meaningful and
    // draggable; the whole selected row is the drag surface (long-press to lift).
    const rank = on ? `<span class="pref-rank" aria-hidden="true">${idx + 1}</span>` : "";
    const grip = on ? `<span class="pref-grip" aria-hidden="true">⠿</span>` : "";
    return `<div class="pref-row ${cls}${on ? " sel" : ""}" data-key="${esc(key)}"
      role="listitem">
      ${rank}
      <button type="button" class="pref-toggle" data-key="${esc(key)}" role="switch"
        aria-checked="${on ? "true" : "false"}"
        aria-label="${on ? "Remove" : "Add"} ${esc(label)}">
        <span class="pref-dot" aria-hidden="true"></span>
        <span class="pref-name">${esc(label)}</span>
      </button>
      ${grip}
    </div>`;
  };
  list.innerHTML =
    sel.map((k, i) => row(k, true, i)).join("") +
    (rest.length ? `<div class="pref-sep" aria-hidden="true"></div>` +
      rest.map((k) => row(k, false)).join("") : "");
  // The drag hint only earns its line once there's an order to set.
  const drag = document.getElementById("listenPrefDragHint");
  if (drag) drag.classList.toggle("hidden", sel.length < 2);
  setListenPrefNote(sel);
}

// Apply a new pref array everywhere. `membershipChanged` distinguishes a set
// change (add/remove — what surfaces changes, so refetch/redraw the pool) from a
// pure reorder (the same albums surface, only priority changed — just restack the
// listen buttons on screen; never redraw the deck).
function commitListenPrefs(next, membershipChanged) {
  saveListenPrefs(next);
  applyListenPrefStyle(next);
  renderPrefList();
  flashListenReflow();
  if (membershipChanged) refreshSurfaces();
  else repaintChoiceListen();
}

function togglePlatformPref(key) {
  if (!_platClass[key]) return;
  const sel = loadListenPrefs();
  const next = sel.includes(key)
    ? sel.filter((k) => k !== key)   // remove
    : sel.concat(key);               // add to the end of the priority order
  commitListenPrefs(next, true);
}

// Reorder the selected rows to a new key order (from a drag). Ignores anything
// not currently selected, so the set is never changed by a drag.
function reorderPlatformPrefs(keys) {
  const sel = loadListenPrefs();
  const next = keys.filter((k) => sel.includes(k));
  if (next.length !== sel.length) return;             // guard: same members only
  if (next.every((k, i) => k === sel[i])) return;     // no change
  commitListenPrefs(next, false);
}

// Long-press drag reorder for the selected platform rows. Press-and-hold any
// selected row to lift it; the lifted row then *tracks your thumb* (translateY
// follows the pointer 1:1) while the rows it passes slide one slot to open a gap —
// so you see exactly where it will land, instead of neighbours snapping past a
// midpoint. The DOM isn't reordered mid-drag (that would make the lifted row jump);
// we shift with transforms and commit the final index once, on drop. A quick tap
// still toggles (via the click handler); a real drag sets _prefDragged so the
// trailing click is ignored. `.pref-row.sel` carries touch-action:none so the drag
// doesn't fight scroll. HTML5 DnD is avoided on purpose (poor on touch).
let _prefDragged = false;
function wirePrefDrag(list) {
  let mode = null;                     // null | "pending" | "drag"
  let dragEl = null, startY = 0, timer = null;
  let rows = [], fromIndex = 0, toIndex = 0, step = 0;
  const selRows = () => Array.from(list.querySelectorAll(".pref-row.sel"));
  // Slide every non-dragged row that sits between the lifted row's origin and its
  // current target by one step, opening the gap the lifted row will drop into.
  const applyShifts = () => {
    rows.forEach((r, i) => {
      if (r === dragEl) return;
      let sh = 0;
      if (fromIndex < toIndex && i > fromIndex && i <= toIndex) sh = -step;
      else if (fromIndex > toIndex && i < fromIndex && i >= toIndex) sh = step;
      r.style.transform = sh ? `translateY(${sh}px)` : "";
    });
  };
  const begin = () => {
    mode = "drag"; _prefDragged = true;
    rows = selRows();
    fromIndex = rows.indexOf(dragEl);
    toIndex = fromIndex;
    // Row pitch (height + gap) from two adjacent rows, so the shift matches layout.
    step = rows.length > 1
      ? Math.abs(rows[1].offsetTop - rows[0].offsetTop)
      : dragEl.getBoundingClientRect().height;
    dragEl.classList.add("dragging");
    dragEl.style.transition = "none";        // the lifted row must track 1:1, no lag
    document.body.classList.add("pref-dragging");
  };
  const dragTo = (clientY) => {
    const dy = clientY - startY;
    dragEl.style.transform = `translateY(${dy}px) scale(1.03)`;
    const t = Math.min(rows.length - 1,
      Math.max(0, fromIndex + Math.round(dy / (step || 1))));
    if (t !== toIndex) { toIndex = t; applyShifts(); }
  };
  const move = (e) => {
    const y = e.clientY;
    if (mode === "pending") {
      if (Math.abs(y - startY) > 8) { clearTimeout(timer); begin(); }
      else return;
    }
    if (mode === "drag") { e.preventDefault(); dragTo(y); }
  };
  const end = () => {
    clearTimeout(timer);
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", end);
    document.removeEventListener("pointercancel", end);
    document.body.classList.remove("pref-dragging");
    if (mode === "drag" && dragEl) {
      rows.forEach((r) => { r.style.transform = ""; r.style.transition = ""; });
      dragEl.classList.remove("dragging");
      if (toIndex !== fromIndex) {
        const order = rows.map((r) => r.dataset.key);
        const [k] = order.splice(fromIndex, 1);
        order.splice(toIndex, 0, k);
        reorderPlatformPrefs(order);         // commit + re-render (rank numbers update)
      }
    }
    mode = null; dragEl = null; rows = [];
  };
  list.addEventListener("pointerdown", (e) => {
    if (e.button != null && e.button > 0) return;      // primary button / touch only
    const rowEl = e.target.closest(".pref-row.sel");
    if (!rowEl) return;
    mode = "pending"; dragEl = rowEl; startY = e.clientY; _prefDragged = false;
    timer = setTimeout(() => { if (mode === "pending") begin(); }, 220);
    document.addEventListener("pointermove", move, { passive: false });
    document.addEventListener("pointerup", end);
    document.addEventListener("pointercancel", end);
  });
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
      const label = btn.querySelector(".cs-label") || btn;
      if (btn.dataset.copied) return;                 // already flashing
      const prev = label.textContent;
      btn.dataset.copied = "1";
      btn.classList.add("copied");
      label.textContent = "Copied ✓";
      setTimeout(() => {
        label.textContent = prev;
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

function wireListenPref() {
  const box = document.getElementById("listenPref");
  const list = document.getElementById("prefList");
  if (!box || !list) return;
  applyListenPrefStyle(loadListenPrefs());            // apply saved filter on load
  renderPrefList();
  list.addEventListener("click", (e) => {
    // A toggle (or a drag's trailing click) re-renders the list, detaching the
    // clicked node — so to an ancestor click-away closer the click then reads
    // as "outside" (U20: the ☰ menu snapped shut on every platform tap). Stop
    // list clicks here; the chooser's own dismiss is pointerdown-based.
    e.stopPropagation();
    if (_prefDragged) { _prefDragged = false; return; }  // that was a drag, not a tap
    const toggle = e.target.closest(".pref-toggle");
    if (toggle) togglePlatformPref(toggle.dataset.key);
  });
  wirePrefDrag(list);
  // Tap outside the open "♫ Select platforms" popover to dismiss it (feedback: it
  // stayed open until you toggled the summary again) — but exempt the feedback
  // launcher/modal, matching the genre chooser + account menu (FB#57).
  document.addEventListener("pointerdown", (e) => {
    if (box.open && !box.contains(e.target)
        && !(e.target.closest && e.target.closest("#feedbackBtn, #feedbackModal"))) {
      box.open = false;
    }
  });
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
      new URLSearchParams({ q }))).json();
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
    if (!el.contains(document.activeElement)) {
      const target = el.querySelector(".modal-close") || focusables(el)[0];
      if (target) { try { target.focus(); } catch (e) {} }
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
  wireListenPref();
  wireGenrePref();
  wireRememberDoor();
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => {
      // A deliberate top-level move ends the current wander (you've left, not
      // backed out) — the breadcrumb is for pulls, not tab-switching.
      resetWander();
      setMode(t.dataset.mode);
    }));
  // #9/#10: the brand (icon + "Music Forest") is the home affordance — tapping it
  // ends any wander and returns to Choose, like a logo click anywhere on the web.
  const brandHome = $("#brandHome");
  if (brandHome) {
    const goHome = () => { resetWander(); setMode("decide"); };
    brandHome.addEventListener("click", goHome);
    brandHome.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goHome(); }
    });
  }
  wireDeepLinks();
  wireListenCount();               // anonymous listen-tap count (svc + tier only)
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
    runExploreSearch($("#forestSearchInput").value);
  });
  $("#forestSearchInput").addEventListener("input", () => {
    clearTimeout(_exploreDebounce);
    _exploreDebounce = setTimeout(
      () => runExploreSearch($("#forestSearchInput").value), 280);
  });
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
    if (e.target.closest("[data-clear-genres]")) { clearGenreFilter(); return; }
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
    const fix = e.target.closest(".fixart");
    if (fix) { e.stopPropagation(); openArtModal(fix.dataset.rid); return; }
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
      else if (f === "label") openLabelPanel(thread.dataset.term);
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
      // Notes render in the Your notes door (N1 Step 1). Edit opens the composer
      // over it, targeting the open album.
      const n = yourNotesData.find((x) => x.id === +edit.dataset.note);
      if (n && yourNotesRid != null) openNoteModal(yourNotesRid, n);
      return;
    }
    const del = e.target.closest(".jdel");
    if (del) { e.stopPropagation(); deleteNote(del.dataset.note); return; }
    // N1 §4.4 (3b): the quiet in-note word pull. The button reveals this note's
    // recurring terms; a term chip pulls your other notes using it, verbatim.
    const threadsBtn = e.target.closest(".note-threads-btn");
    if (threadsBtn) { e.stopPropagation(); toggleNoteThreads(threadsBtn.dataset.note); return; }
    const threadChip = e.target.closest(".note-thread-chip");
    if (threadChip) {
      e.stopPropagation();
      pullTermNotes(threadChip.dataset.term, threadChip.dataset.note);
      return;
    }
    // T3: the Forest empty-state invitation jumps to Choose.
    const goChoose = e.target.closest("[data-go-choose]");
    if (goChoose) { e.stopPropagation(); resetWander(); setMode("decide"); return; }
    // C1: wandering the wood. Stepping into a clearing (a way-in or a trail),
    // walking the breadcrumb path, or pulling a clearing's notes into the Journal.
    const enter = e.target.closest("[data-enter]");
    if (enter) { e.stopPropagation(); walkInto(enter.dataset.enter); return; }
    const walk = e.target.closest("[data-walk]");
    if (walk) { e.stopPropagation(); walkTo(+walk.dataset.walk); return; }
    const cj = e.target.closest("[data-conn-journal]");
    if (cj) {
      e.stopPropagation();
      setMode("journal");
      $("#journalSearch").value = cj.dataset.connJournal;
      loadTrail(true);
      return;
    }
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
  // The sticky "Take a note" pill opens the free composer (record-optional).
  $("#trailPill").addEventListener("click", () => openNoteModal());
  // Trail entries: a note opens to read/edit; a choice opens its chosen record. In
  // selection mode (long-press), a tap toggles the entry instead of opening it.
  $("#trail").addEventListener("click", (e) => {
    // A long-press just fired — swallow its trailing click so it doesn't also open
    // (or immediately deselect) the entry it selected.
    if (_suppressNextTrailClick) { _suppressNextTrailClick = false; return; }
    const row = e.target.closest(".trail-row");
    if (_trailSelecting) { if (row) toggleTrailSelection(row); return; }
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
    const choiceEl = e.target.closest(".trail-entry.trail-choice");
    if (choiceEl && choiceEl.dataset.uid) openStoryModal(choiceEl.dataset.uid);
  });
  // #48 (v2): long-press an entry to enter selection mode; a bar deletes the batch.
  wireTrailLongPress($("#trail"));
  $("#trailSelectCancel").addEventListener("click", exitTrailSelection);
  $("#trailSelectDelete").addEventListener("click", deleteSelectedTrail);
  // Album details door (U3).
  $("#storyClose").addEventListener("click", closeStoryModal);
  $("#storyModal").addEventListener("click", (e) => {
    if (e.target.id === "storyModal") closeStoryModal();
  });
  // FB#40: take a note on the whole record (the composer, tied to the album).
  $("#storyNoteBtn").addEventListener("click", () => {
    if (storyRid) openNoteModal(storyRid);
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
  // Request 1: the Keep / Set aside / undo bar inside Album details (only present for
  // the current Today record — renderStoryDeckActions gates it).
  $("#storyDeckActions").addEventListener("click", (e) => {
    const rid = storyRid;
    if (!rid || !deckState || deckState.idx >= deckState.records.length) return;
    const a = deckState.records[deckState.idx];
    if (albumKey(a) !== rid) return;
    if (e.target.closest("[data-story-keep]")) {
      keepFromStory(a).then(() => renderStoryDeckActions(rid));
    } else if (e.target.closest("[data-story-setaside]")) {
      closeStoryModal();
      setAsideCurrent();
    } else if (e.target.closest("[data-story-unkeep]")) {
      unkeepRecord(rid).then(() => renderStoryDeckActions(rid));
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
  $("#labelClose").addEventListener("click", closeLabelPanel);
  $("#labelModal").addEventListener("click", (e) => {
    if (e.target.id === "labelModal") closeLabelPanel();
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
    if (wanderCursor > 0) {
      gotoNode(wanderTree[wanderCursor].parent, { fromHistory: true });
    }
  });
  // E2: the pick reveal door — ✕ and an overlay (backdrop) click both close it.
  $("#choiceRevealClose").addEventListener("click", closeChoiceReveal);
  $("#choiceRevealModal").addEventListener("click", (e) => {
    if (e.target.id === "choiceRevealModal") closeChoiceReveal();
  });
  // Esc closes the map; and (E2) the pick reveal, but only when nothing deeper is
  // stacked over it (a story/artist/label/note pulled *from* the reveal owns Esc
  // first — closing those is their ✕). Other modals keep their own affordances.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (_trailSelecting) { exitTrailSelection(); return; }   // #48 (v2): Esc leaves selection
    if (!$("#wanderMapModal").classList.contains("hidden")) { closeWanderMap(); return; }
    const deeperOpen = ["storyModal", "artistModal", "labelModal",
      "personModal", "noteModal"]
      .some((id) => !$("#" + id).classList.contains("hidden"));
    if (!deeperOpen && !$("#choiceRevealModal").classList.contains("hidden")) {
      closeChoiceReveal();
    }
  });
  $("#artClose").addEventListener("click", closeArtModal);
  $("#artModal").addEventListener("click", (e) => {
    if (e.target.id === "artModal") closeArtModal();
  });
  // U19: the footer's "About the data" door — pull-only, ✕ / backdrop close.
  const dataBtn = $("#aboutDataBtn");
  if (dataBtn) {
    dataBtn.addEventListener("click", () =>
      $("#dataModal").classList.remove("hidden"));
    $("#dataClose").addEventListener("click", () =>
      $("#dataModal").classList.add("hidden"));
    $("#dataModal").addEventListener("click", (e) => {
      if (e.target.id === "dataModal") $("#dataModal").classList.add("hidden");
    });
  }
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
  setMode("decide");
  // U25's auto-open of the "What is this?" welcome USED to fire from here. It now
  // hangs off the aotd:guest / aotd:local-mode events at the bottom of this file —
  // see the comment there for why the old timer-based trigger was unwinnable.
}

function maybeWelcomeFirstRun() {
  const ob = window.AOTDOnboarding;
  if (!ob || !ob.shouldShowFirstRun || !ob.shouldShowFirstRun()) return;
  setTimeout(() => {
    if (document.querySelector(".modal:not(.hidden)")) return;   // a flow owns the screen
    // onStart fires when the welcome is dismissed → start the guided tour next, so
    // the two never stack (the deck-render trigger is modal-gated for the same
    // reason). Both paths are idempotent via the once-per-device tour flag.
    ob.maybeShowFirstRun({ onStart: maybeStartTour });
  }, 350);
}

// The first-run guided tour (platforms → set aside → keep → Notebook): once per
// device, deferred + gated on no modal owning the screen (so it never covers the
// welcome / sign-in gate) and on the keep/set-aside pair being present (so the deck
// is up and the tour's middle steps have targets). Also called from the deck render,
// for a device that dismissed the welcome on an earlier visit.
function maybeStartTour() {
  const ob = window.AOTDOnboarding;
  if (!ob || !ob.shouldShowTour || !ob.shouldShowTour()) return;
  setTimeout(() => {
    if (document.querySelector(".modal:not(.hidden)")) return;   // a flow owns the screen
    if (!document.getElementById("keepBtn")
        || !document.getElementById("setAsideBtn")) return;
    ob.maybeStartTour();
  }, 400);
}

// A genuine first login shows the tour even on a device that saw it as a guest:
// signup resets the once-per-device flag (auth-ui.js), and revealApp() only unhides
// the already-rendered deck (no re-render, so the deck's own maybeStartTour won't
// re-fire) — so kick the tour here when the journal unlocks. Guarded by shouldShowTour,
// so a returning unlock (flag still set) is a no-op.
document.addEventListener("aotd:unlocked", () => maybeStartTour());

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
  // Resolve the client feature flags BEFORE init()'s first load (setMode), so the
  // data-access seam choices pool vs legacy endpoints from the start. Boot proceeds
  // even if the fetch fails (clientConfig keeps its legacy defaults).
  await loadClientConfig();
  init();
  // Mark a fresh install as caught up with THIS build, before anyone opens the
  // What's-new door. It has to happen on boot rather than on first open: the
  // mark is what "since you last updated" is measured from, so leaving it unset
  // until someone looks would make every later update read as nothing-new.
  if (window.AOTDWhatsNew) window.AOTDWhatsNew.primeSeen(localStorage, window.__MF_BUILD);
  openAlbumDeepLink();          // a shared ?album=<uid> link opens that record's door
});
