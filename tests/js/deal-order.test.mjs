/*
 * B25: box sets and Various-Artists comps arrived on Today looking exactly like a
 * 40-minute album (feedback #64/#65 — a 102-track Proper Records set). Two changes
 * answer that, and both are tested here by lifting the shipped functions verbatim
 * out of app.js and eval'ing them in isolation (same trick as balanced-order.test.mjs):
 *
 *   dealOrder() — deals compilations LATER, never removes them.
 *   deckMeta()  — states "compilation" / "N tracks", but only when they'd surprise you.
 *
 * Run: node tests/js/deal-order.test.mjs
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
  lift(/\nfunction shuffled\(list\) \{[\s\S]*?\n\}/, "shuffled"),
  lift(/\nfunction balancedOrder\(list\) \{[\s\S]*?\n\}/, "balancedOrder"),
  lift(/\nconst COMP_DEAL_RATE = [\d.]+;/, "COMP_DEAL_RATE"),
  lift(/\nfunction dealOrder\(list\) \{[\s\S]*?\n\}/, "dealOrder"),
  lift(/\nconst LONG_RECORD_TRACKS = \d+;/, "LONG_RECORD_TRACKS"),
  lift(/\nfunction deckMeta\(a\) \{[\s\S]*?\n\}/, "deckMeta"),
  // deckMeta's collaborators, stubbed to the shape it consumes.
  "function esc(s) { return (s ?? '').replace(/[<>&\"]/g, (c) => '&#' + c.charCodeAt(0) + ';'); }",
  "function genresOf(a) { return (a.genres || '').split(',').map(s=>s.trim()).filter(Boolean); }",
  "function catalogThread(field, term) { return `<thread>${term}</thread>`; }",
  "return { dealOrder, deckMeta, COMP_DEAL_RATE, LONG_RECORD_TRACKS };",
].join("\n");
// eslint-disable-next-line no-new-func
const { dealOrder, deckMeta, LONG_RECORD_TRACKS } = new Function(code)();

let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; } else { failed++; console.error("  ✗ FAIL:", m); } }

const distinct = (arr) => [...new Set(arr)];
const plain = (a) => deckMeta(a).replace(/<[^>]+>/g, "");

// --- dealOrder: reorder, never remove ---------------------------------------
// A day shaped like a real one: ~11% compilations sitting INSIDE well-populated
// buckets. That shape matters. dealOrder runs on top of balancedOrder, which deals
// one bucket per round so a rare genre isn't buried — so if a genre exists ONLY as
// compilations, balance legitimately pulls one to the very front (better a jazz
// compilation than no jazz at all). Measured on the real 07-14 pool, where genres
// are mixed, the deal takes compilations from 10.7% of the day to 4.1% of the first
// ten records. This fixture reproduces that ordinary case; the genre-scarcity
// interaction is its own case below.
const day = [
  ...Array.from({ length: 60 }, (_, i) => ({ id: `a${i}`, bucket: "electronic" })),
  ...Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, bucket: "rock" })),
  ...Array.from({ length: 6 }, (_, i) =>
    ({ id: `c${i}`, bucket: "electronic", is_compilation: true })),
  ...Array.from({ length: 4 }, (_, i) =>
    ({ id: `k${i}`, bucket: "rock", is_compilation: true })),
];

let compsUpFront = 0, slots = 0, everRodeEarly = false;
for (let trial = 0; trial < 300; trial++) {
  const out = dealOrder(day);
  // 1. THE load-bearing guarantee: nothing is removed from the deck. "Deprioritize"
  //    must never become "hide" — every compilation stays reachable by keeping going.
  ok(out.length === day.length, "output length preserved (nothing dropped)");
  ok(distinct(out.map((r) => r.id)).length === day.length,
     "every record appears exactly once");
  const head = out.slice(0, 10);
  compsUpFront += head.filter((r) => r.is_compilation).length;
  slots += head.length;
  if (head.some((r) => r.is_compilation)) everRodeEarly = true;
}
const dayShare = 100 * 10 / day.length;              // 10 of 90 = 11.1%
const dealtShare = 100 * compsUpFront / slots;
// 2. fewer up front than the day holds — the point of the change
ok(dealtShare < dayShare * 0.75,
   `compilations up front (${dealtShare.toFixed(1)}%) well under the day's ` +
   `${dayShare.toFixed(1)}%`);
// 3. ...but NOT zero. "Fewer, not none" — the day is still what the day holds, and a
//    hard back-of-deck would make it "never" on any real-sized day.
ok(everRodeEarly,
   "some compilations still ride in normal rotation across 300 deals");

// 4. a day of nothing but compilations still deals every record (no empty deck)
const allComps = Array.from({ length: 8 },
  (_, i) => ({ id: `x${i}`, bucket: "jazz", is_compilation: true }));
ok(dealOrder(allComps).length === 8, "all-compilation day still deals every record");

// 4b. KNOWN LIMIT, measured and accepted. The hold-back runs BEFORE balancedOrder,
//     so a genre present only as a compilation gets buried with it (~3 deals in 4)
//     rather than being surfaced to keep the genre represented. Genre balance loses
//     to the hold-back here; this pins that so the behaviour is a decision, not a
//     surprise. It is not a real-world problem: across five real days (1,514–13,071
//     records, 2026-07-18) not ONE of the 14 buckets was all-compilations, because a
//     day holds thousands of records. If that ever changes, exempt a compilation
//     that is the only record in its bucket.
const scarce = [
  ...Array.from({ length: 40 }, (_, i) => ({ id: `e${i}`, bucket: "electronic" })),
  { id: "onlyjazz", bucket: "jazz", is_compilation: true },
];
let jazzSeenEarly = 0;
for (let t = 0; t < 200; t++) {
  if (dealOrder(scarce).slice(0, 3).some((r) => r.id === "onlyjazz")) jazzSeenEarly++;
}
ok(jazzSeenEarly > 10 && jazzSeenEarly < 90,
   `a lone-genre compilation is usually held back, sometimes not ` +
   `(${jazzSeenEarly}/200 early; expected roughly COMP_DEAL_RATE)`);

// 5. a record with no verdict is never held back
const noFlag = [{ id: "n1", bucket: "rock" }, { id: "n2", bucket: "rock" }];
ok(dealOrder(noFlag).length === 2, "records with no is_compilation flag are kept");
ok(dealOrder([]).length === 0, "empty day -> empty deck");

// --- deckMeta: speak up only when it matters ---------------------------------
// 6. the spare deck STAYS spare for an ordinary record (owner's 2026-07-12 call)
ok(plain({ year: 2016, n_tracks: 9, genres: "shoegaze" }) === "2016 · shoegaze",
   `ordinary record unchanged, got "${plain({ year: 2016, n_tracks: 9, genres: "shoegaze" })}"`);

// 7. a box set states both facts
const box = { year: 2003, n_tracks: 102, is_compilation: true, genres: "soul" };
ok(plain(box) === "2003 · compilation · 102 tracks · soul",
   `box set states both facts, got "${plain(box)}"`);

// 8. a short compilation says "compilation" but not a track count
const shortComp = { year: 2003, n_tracks: 13, is_compilation: true, genres: "latin" };
ok(plain(shortComp) === "2003 · compilation · latin",
   `short compilation omits the count, got "${plain(shortComp)}"`);

// 9. a long record that ISN'T a compilation states only its length
const longSolo = { year: 2007, n_tracks: 82, genres: "jazz" };
ok(plain(longSolo) === "2007 · 82 tracks · jazz",
   `long non-compilation states only length, got "${plain(longSolo)}"`);

// 10. REGRESSION (found in browser verification 2026-07-18): n_tracks arrives as a
//     JSON *number*, and esc() calls .replace — passing it raw threw a TypeError and
//     took the whole card render down with it. Must not throw.
let threw = null;
try { plain({ year: 2007, n_tracks: 82, genres: "jazz" }); } catch (e) { threw = e; }
ok(threw === null, `numeric n_tracks must not throw in esc(), got ${threw}`);

// 11. unknown length says NOTHING — never "0 tracks" (honesty rule)
ok(plain({ year: 1999, genres: "rock" }) === "1999 · rock",
   "unknown track count is silent, not zero");
ok(!plain({ year: 1999, n_tracks: 0, genres: "rock" }).includes("0 tracks"),
   "a 0 count is never rendered");

// 12. the threshold is a boundary, not a vibe
ok(plain({ year: 2000, n_tracks: LONG_RECORD_TRACKS }).includes("tracks"),
   "at the threshold, the length is stated");
ok(!plain({ year: 2000, n_tracks: LONG_RECORD_TRACKS - 1 }).includes("tracks"),
   "just under the threshold, it stays quiet");

console.log(`deal-order: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
