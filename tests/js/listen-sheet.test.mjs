/*
 * More ways to listen (v350, owner 2026-10-05, mockup A): the ⌄ on Today's Listen
 * button and the sheet it opens. Pinned here, lifted from the shipped app.js:
 *   - the Listen row: the ⌄ rides only on Today's button (`more`), stays through the
 *     "✓ in Notebook" state, and a record kept on Today that is on none of your
 *     platforms gets an outlined link to where it IS — never "no confirmed link";
 *   - the tiles: Everything clears the services, a service joins at the end of the
 *     order (your priority) or leaves;
 *   - the note under them says, in plain words, what closing the sheet will do;
 *   - v354: the tiles stand in your order (chosen first, as numbered), a drag moves
 *     one chosen platform to a new place without changing the set, and the sheet
 *     opened from the end of the day (no record) promises nothing about "this one".
 * The DOM side (open/close, the pinned card, Esc) is checked in the browser.
 *
 * Run: node tests/js/listen-sheet.test.mjs
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
  lift(/\nconst CONFIRMED_PLATFORMS = \[[\s\S]*?\n\];/, "CONFIRMED_PLATFORMS"),
  lift(/\nconst _platClass = Object\.fromEntries\([\s\S]*?\)\);/, "_platClass"),
  lift(/\nconst _platLabel = Object\.fromEntries\([\s\S]*?\)\);/, "_platLabel"),
  lift(/\nfunction pickListenPlatforms\(platforms, prefs\) \{[\s\S]*?\n\}/, "pickListenPlatforms"),
  lift(/\nfunction listenBlockHtml\(a, \{ compact = false, more = false \} = \{\}\) \{[\s\S]*?\n\}/, "listenBlockHtml"),
  lift(/\nfunction deckListenRow\(key, cls, url, label, off = false\) \{[\s\S]*?\n\}/, "deckListenRow"),
  lift(/\nfunction toggleListenSel\(sel, key\) \{[\s\S]*?\n\}/, "toggleListenSel"),
  lift(/\nfunction listenTileOrder\(sel\) \{[\s\S]*?\n\}/, "listenTileOrder"),
  lift(/\nfunction moveListenSel\(sel, key, to\) \{[\s\S]*?\n\}/, "moveListenSel"),
  lift(/\nfunction sameMembers\(x, y\) \{[\s\S]*?\n\}/, "sameMembers"),
  lift(/\nfunction platNameList\(keys\) \{[\s\S]*?\n\}/, "platNameList"),
  lift(/\nfunction listenSheetNote\(platforms, start, sel, unchecked = \[\]\) \{[\s\S]*?\n\}/, "listenSheetNote"),
  "return { listenBlockHtml, toggleListenSel, sameMembers, listenSheetNote, listenTileOrder, moveListenSel };",
].join("\n");
let prefs = [];
// eslint-disable-next-line no-new-func
const { listenBlockHtml, toggleListenSel, sameMembers, listenSheetNote, listenTileOrder, moveListenSel } = new Function(
  "loadListenPrefs", "esc", "listenAttrs", "openedToday", "albumKey", "copySearchHtml",
  "offPlatformHtml", "CHEV_SVG", code)(
  () => prefs, (s) => String(s), (k) => ` data-listen="${k}"`, () => false, (a) => a.uid,
  () => "COPY", () => "OFF", "⌄");

let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; } else { failed++; console.error("  ✗ FAIL:", m); } }

const rec = { uid: "d:45044", artist: "Depeche Mode", title: "Speak & Spell",
  platforms: { spotify: "https://s", apple: "https://a", youtube: "https://y", deezer: "https://d" } };

// --- the Listen row (v352: option C — the service in a selector, then a green Listen) ---
prefs = [];
let h = listenBlockHtml(rec, { compact: true, more: true });
ok(h.includes("listen-sel") && h.includes("data-listen-more") && h.includes(">Spotify") &&
   h.includes('class="listen-go sp"') && h.includes('data-listen="spotify"') && h.includes(">Listen</a>"),
   "Today's row: the service in the selector (opens the sheet), a green Listen that goes there");
ok(!h.includes("in Notebook"), "the Notebook mark is no longer in the button");
ok(!listenBlockHtml(rec, { compact: true }).includes("data-listen-more"), "no selector anywhere else");
prefs = ["apple"];
h = listenBlockHtml(rec, { compact: true, more: true });
ok(h.includes(">Apple Music") && h.includes('class="listen-go am"'),
   "it follows your platforms (and carries the class the Apple-art rule looks for)");
prefs = ["bandcamp"];
h = listenBlockHtml(rec, { compact: true, more: true });
ok(h.includes("is-off") && h.includes('data-listen="spotify"') && h.includes(">Spotify") &&
   h.includes("data-listen-more") && !h.includes("COPY"),
   "a kept record on none of your platforms: the selector names where it is, Listen outlined");
ok(listenBlockHtml(rec, { compact: true }) === "COPY", "...but only on Today's row (other compact rows unchanged)");
ok(listenBlockHtml({ ...rec, platforms: {} }, { compact: true, more: true }) === "COPY",
   "no confirmed link at all: the honest copy, no selector");
h = listenBlockHtml({ ...rec, platforms: {}, _doorPending: true }, { compact: true, more: true });
ok(h.includes("Checking availability") && !h.includes("data-listen-more"), "still checking: the spinner, no selector");
prefs = [];

// --- the tiles ---------------------------------------------------------------------
ok(toggleListenSel([], "apple").join() === "apple", "a service joins");
ok(toggleListenSel(["apple"], "spotify").join() === "apple,spotify", "...at the end of the order");
ok(toggleListenSel(["apple", "spotify"], "apple").join() === "spotify", "...or leaves");
ok(toggleListenSel(["apple", "spotify"], "all").length === 0, "Everything clears them");
ok(sameMembers(["a", "b"], ["b", "a"]) && !sameMembers(["a"], ["a", "b"]), "same platforms, any order");

// --- the note ------------------------------------------------------------------------
const P = rec.platforms;
ok(listenSheetNote(P, [], []).text === "Only records you can play there will show." &&
   !listenSheetNote(P, [], []).changed, "untouched: the plain hint");
ok(listenSheetNote(P, [], ["apple"]).text === "Next shows only records on Apple Music. This one stays.",
   "narrowed: what Next will show, and that this one stays");
ok(listenSheetNote(P, ["apple"], []).text === "Next shows every record. This one stays.", "back to Everything");
ok(listenSheetNote(P, [], ["bandcamp"]).text ===
   "This one isn't on Bandcamp, so it stays until you move on. Next shows only records on Bandcamp.",
   "a choice this record isn't on says so");
ok(listenSheetNote(P, ["spotify", "apple"], ["apple", "spotify"]).text === "Apple Music comes first now.",
   "a reorder only changes which service the button names");
ok(listenSheetNote(P, [], ["apple", "youtube", "deezer"]).text.includes("Apple Music, YouTube Music and Deezer"),
   "names read as a sentence");

// --- the order (v354: tiles stand in your order; a drag reorders) -------------------
const ALL = ["spotify", "apple", "youtube", "deezer", "bandcamp"];
ok(listenTileOrder([]).join() === ALL.join(), "nothing chosen: the usual order");
ok(listenTileOrder(["deezer", "apple"]).join() === "deezer,apple,spotify,youtube,bandcamp",
   "chosen first, in your order, then the rest in the usual order");
ok(moveListenSel(["spotify", "apple", "deezer"], "deezer", 0).join() === "deezer,spotify,apple",
   "a drag to the front");
ok(moveListenSel(["spotify", "apple", "deezer"], "spotify", 2).join() === "apple,deezer,spotify",
   "a drag to the back");
ok(moveListenSel(["spotify", "apple", "deezer"], "apple", 1).join() === "spotify,apple,deezer",
   "a drop where it started changes nothing");
ok(moveListenSel(["spotify", "apple"], "spotify", 9).join() === "apple,spotify",
   "a drop past the end lands last");
ok(moveListenSel(["spotify"], "deezer", 0).join() === "spotify", "a platform you haven't chosen can't be moved");
ok(sameMembers(moveListenSel(["a", "b", "c"], "c", 0), ["a", "b", "c"]), "a drag never changes the set");
ok(listenSheetNote(P, ["spotify", "apple"], moveListenSel(["spotify", "apple"], "apple", 0)).text
   === "Apple Music comes first now.", "...so the note says only which comes first");

// --- no record on screen (opened from the end of the day) ---------------------------
ok(listenSheetNote(null, [], []).text === "Only records you can play there will show.", "untouched");
ok(listenSheetNote(null, [], ["apple"]).text === "Only records on Apple Music will show.",
   "narrowed — and no 'this one stays'");
ok(listenSheetNote(null, ["apple"], []).text === "Every record will show.", "back to Everything");
ok(listenSheetNote(null, ["apple", "deezer"], ["deezer", "apple"]).text === "Deezer comes first now.",
   "a reorder");

// --- Spotify couldn't be checked (2026-10-07): unknown, never "not on" ---------------
const noSp = { apple: "https://a", deezer: "https://d" };
ok(listenSheetNote(noSp, [], ["spotify"]).text.startsWith("This one isn't on Spotify"),
   "Spotify answered with no match: it says so");
ok(listenSheetNote(noSp, [], ["spotify"], ["spotify"]).text ===
   "Spotify couldn't be checked for this one just now, so it stays until you move on. Next shows only records on Spotify.",
   "Spotify failed for this one: it says it couldn't check, never 'isn't on'");
ok(listenSheetNote(noSp, [], ["bandcamp"], ["spotify"]).text.startsWith("This one isn't on Bandcamp"),
   "...and only when Spotify is one of the choices");
prefs = ["spotify"];
h = listenBlockHtml({ ...rec, platforms: { apple: "https://a" }, _spUnchecked: true }, { compact: true, more: true });
ok(h.includes("Couldn't check Spotify just now — it's on Apple Music"),
   "a record kept on Today that Spotify failed for: the selector's label says couldn't check");
h = listenBlockHtml({ ...rec, platforms: { apple: "https://a" } }, { compact: true, more: true });
ok(h.includes("Not on your listening platforms — it's on Apple Music"), "...and 'not on' only when Spotify said so");
prefs = [];

console.log(`listen-sheet: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
