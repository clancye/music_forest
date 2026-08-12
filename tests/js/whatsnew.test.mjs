/*
 * whatsnew.js — what changed since you last updated, in three tiers.
 *
 * The load-bearing behaviour is the PARTITION: what counts as "since you last
 * updated". Get it wrong in one direction and a reader is told about changes to an
 * app they've never run; wrong in the other and a rename they're staring at isn't
 * listed. Both make the panel worse than not having one, so this pins the edges:
 * a first-ever run, an entry from a build that hasn't reached this reader, blocked
 * storage, and a version compare that must be numeric ("v99" is older than "v224").
 *
 * Run: node tests/js/whatsnew.test.mjs
 */
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const WN = require(join(here, "..", "..", "static", "whatsnew.js"));

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", label); }
}
function eq(got, want, label) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { passed++; } else { failed++; console.error(`  ✗ ${label}: got ${g}, want ${w}`); }
}

function store(initial) {
  const m = new Map(initial ? Object.entries(initial) : []);
  return {
    mode: "ok",
    getItem(k) { if (this.mode === "throw") throw new Error("blocked"); return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { if (this.mode === "throw") throw new Error("blocked"); m.set(k, v); },
    _raw: m,
  };
}

const E = [
  { v: 225, tier: 2, text: "new thing" },
  { v: 224, tier: 1, text: "quiet fix" },
  { v: 222, tier: 3, text: "you'll notice this" },
  { v: 219, tier: 3, text: "older notice" },
];
const texts = (l) => l.map((e) => e.text);

// --- version numbers ---------------------------------------------------------
eq(WN._buildNumber("v224"), 224, "parses a vNNN build");
eq(WN._buildNumber(224), 224, "accepts a bare number");
eq(WN._buildNumber(""), 0, "empty build → 0");
eq(WN._buildNumber(null), 0, "null build → 0");
ok(WN._buildNumber("v224") > WN._buildNumber("v99"),
   "compares NUMERICALLY — a string sort would put v99 after v224");

// --- the partition -----------------------------------------------------------
let p = WN._partition("v225", 222, E);
eq(texts(p.fresh), ["new thing", "quiet fix"], "fresh = builds newer than seen");
eq(texts(p.earlier), ["you'll notice this", "older notice"], "earlier = the rest");

p = WN._partition("v225", 225, E);
eq(texts(p.fresh), [], "already caught up → nothing fresh");
eq(p.earlier.length, 4, "...but the history is still all there (never an empty panel)");

// An entry for a build this reader isn't running yet must not be announced — they'd
// go looking for something that isn't in their shell.
p = WN._partition("v222", 219, E);
eq(texts(p.fresh), ["you'll notice this"], "entries above the running build are held back");
ok(!texts(p.earlier).includes("new thing"), "...and don't leak into earlier either");

// First-ever run: no seen value. Nothing is "new" — history isn't news to someone
// who just arrived.
p = WN._partition("v225", null, E);
eq(texts(p.fresh), [], "no seen value → nothing presented as new");
eq(p.earlier.length, 4, "...everything reads as earlier");

eq(WN._partition("v225", 0, []).fresh, [], "an empty entry list is fine");

// --- tier grouping -----------------------------------------------------------
const groups = WN._byTier(E);
eq(groups.map((g) => g.label),
   ["Things you'll notice", "New things you can do", "Under the hood"],
   "tiers render most-felt first");
eq(groups[0].items.length, 2, "tier 3 collects both notice-level entries");
eq(WN._byTier([{ v: 1, tier: 1, text: "x" }]).map((g) => g.label),
   ["Under the hood"], "a tier with nothing in it is dropped, not shown empty");
eq(WN._byTier([]), [], "no entries → no groups");

// --- seen tracking -----------------------------------------------------------
let s = store();
eq(WN._readSeen(s), null, "unset reads as null, not 0 (0 would mean 'seen nothing')");
WN._writeSeen(s, "v225");
eq(WN._readSeen(s), 225, "round-trips the build number");
eq(s._raw.get(WN.SEEN_KEY), "225", "stored as a plain number, not 'v225'");

s = store();
WN.primeSeen(s, "v225");
eq(WN._readSeen(s), 225, "primeSeen marks a fresh install caught up");
WN.primeSeen(s, "v999");
eq(WN._readSeen(s), 225, "...and never moves an existing mark forward");

// Blocked storage (private mode, cookies off) must degrade, not throw: the panel
// still opens, it just can't remember you looked.
s = store(); s.mode = "throw";
let threw = null;
try { WN._writeSeen(s, "v225"); } catch (e) { threw = e; }
ok(threw === null, "a blocked write is swallowed");
try { eq(WN._readSeen(s), null, "a blocked read → null"); } catch (e) { failed++; console.error("  ✗ blocked read threw"); }
try { WN.primeSeen(s, "v225"); passed++; } catch (e) { failed++; console.error("  ✗ primeSeen threw on blocked storage"); }

// --- the shipped entries are well-formed -------------------------------------
const labels = WN.TIERS.map((t) => t.n);
ok(WN.ENTRIES.length > 0, "ships with entries");
ok(WN.ENTRIES.every((e) => labels.includes(e.tier)), "every entry has a known tier");
ok(WN.ENTRIES.every((e) => typeof e.text === "string" && e.text.length > 10),
   "every entry has real copy");
ok(WN.ENTRIES.every((e) => Number.isInteger(e.v) && e.v > 0),
   "every entry carries an integer build");
const vs = WN.ENTRIES.map((e) => e.v);
eq(vs, [...vs].sort((a, b) => b - a), "entries are newest-first");
// BRAND: the retired daily-act words must never reach user-facing copy — with ONE
// bounded exception, a rename note, which can't work without naming what it
// replaced. That exception is declared per-entry (`bridge: true`) so it's auditable
// rather than a judgement call, and every other entry is still checked strictly.
const banned = /\bshelve|\bshelved|\bset aside|\bpick\b|\bduel\b|\bwinner\b/i;
ok(!WN.ENTRIES.filter((e) => !e.bridge).some((e) => banned.test(e.text)),
   "no retired vocabulary in the shipped copy");
const bridges = WN.ENTRIES.filter((e) => e.bridge);
ok(bridges.length <= 1,
   "at most one bridge entry — BRAND says keep naming the old word to the one note");
ok(bridges.every((e) => /\bSkip\b/.test(e.text)),
   "a bridge entry names the CURRENT word, not just the retired one");

// --- the regression that primeSeen exists for ---------------------------------
// Without a mark set on BOOT, `seen` stays null until someone first opens the
// panel — and partition() with a null mark treats the running build as already
// caught up. So an install that never opened it would, after updating, still be
// told nothing is new. Priming on boot is what makes the next update a real delta.
s = store();
let p2 = WN._partition("v225", WN._readSeen(s), E);
eq(p2.fresh.length, 0, "unprimed at v225: nothing fresh (correct — they just arrived)");
WN.primeSeen(s, "v225");                       // what boot does
p2 = WN._partition("v226", WN._readSeen(s), [{ v: 226, tier: 3, text: "after update" }]);
eq(texts(p2.fresh), ["after update"],
   "primed at v225, then updated to v226: the new change IS fresh");

const unprimed = store();
p2 = WN._partition("v226", WN._readSeen(unprimed), [{ v: 226, tier: 3, text: "after update" }]);
eq(p2.fresh.length, 0,
   "NOT primed: the same update reads as nothing-new — the bug primeSeen prevents");

console.log(`whatsnew: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
