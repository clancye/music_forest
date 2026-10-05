/*
 * The Today deal (owner, 2026-10-04; GENRE_BACKFILL_DESIGN.md "Deal balancing").
 * balancedOrder() deals the day in turns sized to how much of it each tag is, softened
 * (a tag's chance at the next slot is records-left ^ DEAL_SIZE_POWER), and never deals
 * the same tag twice in a row while anything else is left. It replaced the 13-hidden-
 * genre deal, which gave every genre one record per round and so dealt a 0.4%-of-the-day
 * genre ~17x its share. app.js is browser code, so — like pick-listen.test.mjs — we lift
 * the functions verbatim and eval them in isolation, proving the logic exactly as shipped.
 *
 * Run: node tests/js/balanced-order.test.mjs
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
  lift(/\nconst ATOMIC_GENRES = [^\n]*/, "ATOMIC_GENRES"),
  lift(/\nfunction genresOf\(a\) \{[\s\S]*?\n\}/, "genresOf"),
  lift(/\nfunction tagKey\(t\) \{[^\n]*\}/, "tagKey"),
  lift(/\nconst DEAL_SIZE_POWER = [\d.]+;/, "DEAL_SIZE_POWER"),
  lift(/\nfunction dealKey\(rec\) \{[\s\S]*?\n\}/, "dealKey"),
  lift(/\nfunction balancedOrder\(list, rand = Math\.random\) \{[\s\S]*?\n\}/, "balancedOrder"),
  "return { balancedOrder, dealKey, DEAL_SIZE_POWER };",
].join("\n");
// eslint-disable-next-line no-new-func
const { balancedOrder, dealKey, DEAL_SIZE_POWER } = new Function(code)();

let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; } else { failed++; console.error("  ✗ FAIL:", m); } }

// A small seeded generator so the proportion checks are repeatable.
function seeded(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rec = (id, genres, extra = {}) => ({ id, genres, ...extra });
const distinct = (arr) => [...new Set(arr)];
const keys = (list) => list.map(dealKey);

// --- dealKey: a record's own (first) tag, spellings merged ------------------------
ok(DEAL_SIZE_POWER === 0.85, "the owner's strength, 0.85");
ok(dealKey(rec("a", "Hip Hop, Boom Bap")) === "hiphop", "first genre leads");
ok(dealKey(rec("b", "hip-hop")) === dealKey(rec("c", "Hip Hop")),
   "spellings merge (hip-hop = Hip Hop), like the Genre screen");
ok(dealKey({ id: "d", genres: "", styles: "Shoegaze, Dream Pop" }) === "shoegaze",
   "no genre -> first style");
ok(dealKey({ id: "e" }) === "", "no tag at all -> the shared empty key");
ok(dealKey(rec("f", "Folk, World, & Country")) === "folkworldcountry",
   "the atomic Discogs genre stays one tag");

// --- a skewed day ------------------------------------------------------------------
const day = [
  ...Array.from({ length: 600 }, (_, i) => rec(`e${i}`, "Electronic, House")),
  ...Array.from({ length: 300 }, (_, i) => rec(`r${i}`, "rock")),
  ...Array.from({ length: 60 }, (_, i) => rec(`j${i}`, "Jazz")),
  ...Array.from({ length: 40 }, (_, i) => rec(`g${i}`, "reggae")),
];
const rand = seeded(42);
let headE = 0, headG = 0, headN = 0, forcedOnly = true;
for (let trial = 0; trial < 300; trial++) {
  const out = balancedOrder(day, rand);
  if (trial < 20) {
    ok(out.length === day.length, "output length preserved");
    ok(distinct(out.map((r) => r.id)).length === day.length,
       "every record appears exactly once (no dupes/drops)");
  }
  // never the same tag twice in a row while another tag still has records
  const k = keys(out);
  for (let i = 0; i + 1 < k.length; i++) {
    if (k[i] === k[i + 1] && !k.slice(i + 1).every((x) => x === k[i])) {
      forcedOnly = false;
      break;
    }
  }
  const head = out.slice(0, 20);
  headE += head.filter((r) => r.id[0] === "e").length;
  headG += head.filter((r) => r.id[0] === "g").length;
  headN += head.length;
}
ok(forcedOnly, "a tag repeats back-to-back only once nothing else is left");
const shareE = headE / headN, shareG = headG / headN;
// electronic is 60% of this day: lighter at the top, but still the most common
ok(shareE < 0.60 && shareE > 0.35,
   `electronic lighter than its 60% but still present: ${(100 * shareE).toFixed(1)}%`);
// reggae is 4%: a little more room, nowhere near equal turns (which gives 25%)
ok(shareG > 0.04 && shareG < 0.12,
   `reggae lifted a little, not flooded: ${(100 * shareG).toFixed(1)}%`);

// --- edges -----------------------------------------------------------------------
const untagged = Array.from({ length: 8 }, (_, i) => ({ id: `u${i}` }));
const uOut = balancedOrder(untagged);
ok(uOut.length === 8 && distinct(uOut.map((r) => r.id)).length === 8,
   "an all-untagged day is still a valid permutation");
const mono = Array.from({ length: 6 }, (_, i) => rec(`m${i}`, "electronic"));
const monoOut = balancedOrder(mono);
ok(monoOut.length === 6 && distinct(monoOut.map((r) => r.id)).length === 6,
   "single-tag day: valid permutation");
const two = [rec("x1", "rock"), rec("x2", "rock"), rec("y1", "jazz")];
let alt = 0;
for (let t = 0; t < 50; t++) {
  const k = keys(balancedOrder(two));
  if (k[0] !== k[1]) alt++;
}
ok(alt === 50, "rock, jazz, rock — the lone jazz record always breaks the run");
ok(balancedOrder([]).length === 0, "empty day -> empty deck");

console.log(`balanced-order: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
