/*
 * The first card has to be quick (owner 2026-10-05: "it takes about 5-10 seconds and we
 * lose people in that time"). Two rules carry most of it, and both are pinned here:
 *   - caaThumb(): a Cover Art Archive `/front` (the ORIGINAL upload — measured up to
 *     24 MB) is asked for at a sized thumbnail instead; anything else passes through.
 *   - readyFirst(): a fresh visit's first card is one whose cover and Listen links are
 *     already in the day's list (no links lookup), found within the deal's opening
 *     stretch; when none is there the deal is left exactly as dealt.
 * We lift the shipped functions from app.js and run them in isolation.
 *
 * Run: node tests/js/first-card-speed.test.mjs
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
  lift(/\nconst CAA_FRONT = [^\n]*/, "CAA_FRONT"),
  lift(/\nconst _cachedCovers = [^\n]*/, "_cachedCovers"),
  lift(/\nfunction noteCachedCovers\(list\) \{[\s\S]*?\n\}/, "noteCachedCovers"),
  lift(/\nfunction caaSized\(url, size = 500\) \{[\s\S]*?\n\}/, "caaSized"),
  lift(/\nfunction caaThumb\(url, size = 500\) \{[\s\S]*?\n\}/, "caaThumb"),
  lift(/\nconst CONFIRMED_PLATFORMS = \[[\s\S]*?\n\];/, "CONFIRMED_PLATFORMS"),
  lift(/\nconst _platClass = Object\.fromEntries\([\s\S]*?\)\);/, "_platClass"),
  lift(/\nconst _platLabel = Object\.fromEntries\([\s\S]*?\)\);/, "_platLabel"),
  lift(/\nfunction pickListenPlatforms\(platforms, prefs\) \{[\s\S]*?\n\}/, "pickListenPlatforms"),
  lift(/\nconst APPLE_ART = [^\n]*/, "APPLE_ART"),
  lift(/\nfunction isAppleArt\(url\) \{[\s\S]*?\n\}/, "isAppleArt"),
  lift(/\nfunction deckCoverShows\(a\) \{[\s\S]*?\n\}/, "deckCoverShows"),
  lift(/\nfunction doorNeeded\(a\) \{[\s\S]*?\n\}/, "doorNeeded"),
  lift(/\nfunction readyFirst\(list, look = 40\) \{[\s\S]*?\n\}/, "readyFirst"),
  lift(/\nfunction pickFirstCard\(albums, at, met\) \{[\s\S]*?\n\}/, "pickFirstCard"),
  lift(/\nfunction pinFirst\(list, rec\) \{[\s\S]*?\n\}/, "pinFirst"),
  "return { caaThumb, caaSized, noteCachedCovers, readyFirst, isAppleArt, deckCoverShows, pickFirstCard, pinFirst };",
].join("\n");
// The reader's chosen platforms (localStorage in the app) and a record's identity are
// stubbed; everything else is the shipped code.
let prefs = [];
// eslint-disable-next-line no-new-func
const { caaThumb, caaSized, noteCachedCovers, readyFirst, isAppleArt, deckCoverShows,
        pickFirstCard, pinFirst } = new Function("loadListenPrefs", "albumKey", code)(
  () => prefs, (r) => (r ? r.uid || r.k : null));

let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; } else { failed++; console.error("  ✗ FAIL:", m); } }

const id = "64a9ebd7-3984-45a3-ae1f-117152ecbf8e";
ok(caaThumb(`https://coverartarchive.org/release/${id}/front`) ===
   `https://coverartarchive.org/release/${id}/front-500`, "a release front becomes its 500px thumbnail");
ok(caaThumb(`https://coverartarchive.org/release-group/${id}/front-1200`, 250) ===
   `https://coverartarchive.org/release-group/${id}/front-250`, "a sized release-group front is re-sized");
ok(caaThumb("/static/art/589864.jpg") === "/static/art/589864.jpg", "our own cached art passes through");
ok(caaThumb("https://i.discogs.com/abc.jpg") === "https://i.discogs.com/abc.jpg", "other hosts pass through");
ok(caaThumb(`https://coverartarchive.org/release/${id}/12345.jpg`) ===
   `https://coverartarchive.org/release/${id}/12345.jpg`, "a specific image id is left alone");
ok(caaThumb(null) === null && caaThumb("") === "", "no cover stays no cover");

// The cover cache (v347): a cover the day's list marks `cover_cached` is asked of our
// own server at 500px; every other size, and every unmarked cover, still goes to CAA.
const other = "50c46e6f-1610-469c-ad1c-e086603a6ef6";
noteCachedCovers([
  { cover: `https://coverartarchive.org/release/${id.toUpperCase()}/front`, cover_cached: true },
  { cover: `https://coverartarchive.org/release/${other}/front` },
  { cover: "https://is1-ssl.mzstatic.com/x.jpg", cover_cached: true },
  null,
]);
ok(caaThumb(`https://coverartarchive.org/release/${id}/front`) === `/covers/release/${id}-500.jpg`,
   "a held cover is asked of our server");
ok(caaThumb(`https://coverartarchive.org/release/${id}/front`, 250) ===
   `https://coverartarchive.org/release/${id}/front-250`, "only the 500px size is held");
ok(caaThumb(`https://coverartarchive.org/release-group/${id}/front`) ===
   `https://coverartarchive.org/release-group/${id}/front-500`, "a release id isn't a release-group's");
ok(caaThumb(`https://coverartarchive.org/release/${other}/front`) ===
   `https://coverartarchive.org/release/${other}/front-500`, "an unmarked cover still goes to the archive");
ok(caaThumb("https://is1-ssl.mzstatic.com/x.jpg") === "https://is1-ssl.mzstatic.com/x.jpg",
   "a non-CAA cover is never mapped, marked or not");
ok(caaSized(`https://coverartarchive.org/release/${id}/front`) ===
   `https://coverartarchive.org/release/${id}/front-500`, "caaSized ignores the cache (the fallback)");

const rec = (k, ready) => ({ k, cover: ready ? "c" : (k === "nocover" ? "" : "c"),
  platforms: ready ? { spotify: "s", youtube: "y" } : { deezer: "d" } });
const ids = (l) => l.map((r) => r.k).join(",");
ok(ids(readyFirst([rec("a"), rec("b"), rec("c", true), rec("d")])) === "c,a,b,d",
   "the first ready record moves to the front; the rest keep the deal's order");
ok(ids(readyFirst([rec("a", true), rec("b", true)])) === "a,b", "already first: untouched");
const none = [rec("a"), rec("b")];
ok(readyFirst(none) === none, "no ready record: the deal is left exactly as dealt");
const far = Array.from({ length: 45 }, (_, i) => rec("r" + i)).concat([rec("late", true)]);
ok(readyFirst(far)[0].k === "r0", "only the deal's opening stretch is searched");
ok(ids(readyFirst([rec("a"), { k: "x", cover: "", platforms: { spotify: "s", youtube: "y" } }])) === "a,x",
   "links without a cover aren't ready — the card would still wait on art");


// APPLE ARTWORK (v348, option A): an Apple cover shows on the Today card only when its
// one Listen button is Apple Music, so a ready record with Apple art leads the deal only
// for a reader whose button would be Apple.
const APPLE = "https://is1-ssl.mzstatic.com/image/thumb/Music/x/600x600bb.jpg";
ok(isAppleArt(APPLE) && isAppleArt("https://a1.apple.com/x.jpg"), "Apple's CDNs are Apple art");
ok(!isAppleArt(`https://coverartarchive.org/release/${id}/front`) && !isAppleArt("") &&
   !isAppleArt("https://mzstatic.com.evil.example/x.jpg"), "nothing else is");
const appleRec = (k, plat) => ({ k, cover: APPLE, platforms: plat });
const both = { spotify: "s", youtube: "y", apple: "a" };
prefs = [];
ok(!deckCoverShows(appleRec("x", both)), "Everything: Spotify leads, so Apple art stays hidden");
ok(deckCoverShows(appleRec("x", { apple: "a", youtube: "y" })), "Everything, no Spotify: Apple leads, art shows");
prefs = ["apple", "spotify"];
ok(deckCoverShows(appleRec("x", both)), "Apple Music chosen first: art shows");
prefs = ["spotify"];
ok(!deckCoverShows(appleRec("x", { apple: "a", spotify: "s" })), "Spotify only: art hidden");
ok(deckCoverShows({ k: "c", cover: `https://coverartarchive.org/release/${id}/front` }) &&
   !deckCoverShows({ k: "n", cover: "" }), "non-Apple art always shows; no cover never does");
prefs = [];
ok(ids(readyFirst([rec("a"), appleRec("apple", both), rec("c", true)])) === "c,a,apple",
   "readyFirst passes over a ready record whose Apple art would be hidden");
prefs = ["apple"];
ok(ids(readyFirst([rec("a"), appleRec("apple", both), rec("c", true)])) === "apple,a,c",
   "...and takes it for a reader whose button is Apple Music");
prefs = [];

// THE FIRST CARD (v348): the server offers candidates, the client picks — your saved place
// first, else the first ready record whose cover will show, never one met today.
const cands = [rec("saved"), rec("met", true), appleRec("ap", both), rec("r1", true), rec("r2", true)];
ok(pickFirstCard(cands, "saved", new Set()).k === "saved", "your saved place leads, ready or not");
ok(pickFirstCard(cands.slice(1), null, new Set(["met"])).k === "r1",
   "otherwise the first ready record you haven't met whose cover shows");
ok(pickFirstCard(cands, "saved", new Set(["saved", "met"])).k === "r1", "a place you've since moved past isn't resumed");
ok(pickFirstCard([rec("a")], null, new Set()) === null && pickFirstCard(undefined, null, new Set()) === null,
   "nothing ready: no early card (the day decides)");
const pin = rec("p", true);
const pinned = pinFirst([rec("a"), { k: "p" }, rec("b")], pin);
ok(pinned[0] === pin && ids(pinned) === "p,a,b", "the drawn card leads the deal as the same object, once");
ok(ids(pinFirst([rec("a")], pin)) === "p,a", "...even when the day no longer lists it");

console.log(`first-card-speed: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
