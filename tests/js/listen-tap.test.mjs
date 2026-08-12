/*
 * B34: the Listen-tap deep-link decision. Three pure functions drive it —
 * uaPlatform (device bucket), listenTapMode (what a tap should do), and
 * appDeepLink (the web→scheme transform). app.js is browser code (touches
 * document/window at load), so — like pick-listen.test.mjs — we lift the
 * functions verbatim from source and eval them in isolation, proving the exact
 * shipped logic without a browser.
 *
 * Covers the desktop-macOS Apple fix (opens the native Music app) plus the
 * guardrails that keep every other case on its honest web link.
 *
 * Run: node tests/js/listen-tap.test.mjs
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "..", "static", "app.js"), "utf8");

function lift(re, what) {
  const m = src.match(re);
  if (!m) throw new Error(`could not find ${what} in app.js`);
  return m[0];
}
const code = [
  lift(/\nfunction uaPlatform\(ua, touchPoints\) \{[\s\S]*?\n\}/, "uaPlatform"),
  lift(/\nfunction listenTapMode\(key, hasScheme, platform\) \{[\s\S]*?\n\}/, "listenTapMode"),
  lift(/\nfunction appDeepLink\(key, url\) \{[\s\S]*?\n\}/, "appDeepLink"),
  lift(/\nfunction appIntentLink\(key, url\) \{[\s\S]*?\n\}/, "appIntentLink"),
  "return { uaPlatform, listenTapMode, appDeepLink, appIntentLink };",
].join("\n");
// eslint-disable-next-line no-new-func
const { uaPlatform, listenTapMode, appDeepLink, appIntentLink } = new Function(code)();

let passed = 0, failed = 0;
function eq(got, want, m) {
  if (got === want) { passed++; }
  else { failed++; console.error(`  ✗ FAIL: ${m}\n      got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

// Real UA strings.
const UA = {
  macChrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  iPhone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  iPadOS: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15", // iPadOS masquerades as Mac
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36",
  win: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
};

// --- uaPlatform: device buckets --------------------------------------------
eq(uaPlatform(UA.macChrome, 0), "mac-desktop", "Mac Chrome, no touch → mac-desktop");
eq(uaPlatform(UA.macSafari, 0), "mac-desktop", "Mac Safari, no touch → mac-desktop");
eq(uaPlatform(UA.iPadOS, 5), "ios", "iPadOS (Mac UA + touch) → ios");
eq(uaPlatform(UA.iPhone, 5), "ios", "iPhone → ios");
eq(uaPlatform(UA.android, 5), "android", "Android → android");
eq(uaPlatform(UA.win, 0), "other", "Windows → other");
eq(uaPlatform("", 0), "other", "empty UA → other");

// --- listenTapMode: the decision -------------------------------------------
// The fix: desktop Mac + Apple opens the native app.
eq(listenTapMode("apple", true, "mac-desktop"), "mac-app", "Apple on desktop Mac → mac-app");
// Guardrails: no OTHER platform gets the desktop-app path (their apps aren't
// guaranteed installed, so blindly opening a scheme would dead-end).
eq(listenTapMode("spotify", true, "mac-desktop"), "web", "Spotify on desktop Mac → web (no guaranteed app)");
eq(listenTapMode("deezer", true, "mac-desktop"), "web", "Deezer on desktop Mac → web");
eq(listenTapMode("youtube", true, "mac-desktop"), "web", "YouTube on desktop Mac → web");
// Apple with no scheme built (shouldn't happen, but never crash into a scheme).
eq(listenTapMode("apple", false, "mac-desktop"), "web", "Apple, no scheme → web");
// iOS Apple → "web" on purpose: let the anchor tap fire so iOS routes the Apple
// Music Universal Link to the app (more reliable than music://). The music://
// scheme may still be present as data-app, but the decision ignores it on iOS.
eq(listenTapMode("apple", true, "ios"), "web", "Apple on iOS → web (Universal Link hand-off)");
eq(listenTapMode("apple", false, "ios"), "web", "Apple on iOS, no scheme → web");
// Other iOS/Android services keep the try-scheme-then-fallback dance.
eq(listenTapMode("spotify", true, "ios"), "mobile", "Spotify on iOS → mobile");
eq(listenTapMode("spotify", true, "android"), "mobile", "Spotify on Android → mobile");
eq(listenTapMode("apple", true, "android"), "mobile", "Apple on Android → mobile (scheme, unchanged)");
eq(listenTapMode("spotify", false, "ios"), "web", "no scheme on iOS → web");
eq(listenTapMode("bandcamp", false, "ios"), "web", "iOS, no scheme (Bandcamp) → web");
// Non-Mac desktop: always the honest web link.
eq(listenTapMode("apple", true, "other"), "web", "Apple on Windows/other → web");
eq(listenTapMode("spotify", true, "other"), "web", "Spotify on Windows/other → web");

// --- appDeepLink: the web→scheme transform ---------------------------------
eq(appDeepLink("apple", "https://music.apple.com/us/album/abbey-road/1441164426"),
   "music://music.apple.com/us/album/abbey-road/1441164426", "apple https → music://");
eq(appDeepLink("apple", "http://music.apple.com/us/album/x/1"),
   "music://music.apple.com/us/album/x/1", "apple http → music://");
// A geo. redirector host must be stripped — Music.app opens music.apple.com, not geo.
eq(appDeepLink("apple", "https://geo.music.apple.com/us/album/x/1"),
   "music://music.apple.com/us/album/x/1", "apple geo. host stripped");
eq(appDeepLink("apple", "https://example.com/not-apple"), "", "non-apple host → no scheme");
eq(appDeepLink("spotify", "https://open.spotify.com/album/abc123"),
   "spotify:album:abc123", "spotify → spotify: uri (unchanged)");

// --- appIntentLink: Android explicit-package intents -----------------------
// Apple: music:// is iOS/macOS only, so Android reaches the app via an intent.
const appleIntent = appIntentLink("apple", "https://music.apple.com/us/album/abbey-road/1441164426");
eq(appleIntent.startsWith("intent://music.apple.com/us/album/abbey-road/1441164426#Intent;"), true,
   "apple intent targets the exact album");
eq(/;package=com\.apple\.android\.music;/.test(appleIntent), true, "apple intent names the Apple Music package");
eq(/S\.browser_fallback_url=https%3A%2F%2Fmusic\.apple\.com/.test(appleIntent), true,
   "apple intent carries an encoded web fallback (no Play-Store bounce / no error)");
eq(appleIntent.endsWith(";end"), true, "apple intent is well-formed (ends ;end)");
eq(appIntentLink("apple", "https://geo.music.apple.com/us/album/x/1").startsWith("intent://music.apple.com/"),
   true, "apple intent strips the geo. redirector host");
eq(appIntentLink("spotify", "https://open.spotify.com/album/abc"), "",
   "spotify has no intent (its spotify: scheme is reliable)");
eq(appIntentLink("youtube", "https://music.youtube.com/watch?v=abc")
     .includes("package=com.google.android.apps.youtube.music"),
   true, "youtube music intent unchanged");

console.log(`listen-tap: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
