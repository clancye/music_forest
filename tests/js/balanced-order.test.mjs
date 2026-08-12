/*
 * A8 Phase 1: balancedOrder() is the genre-balanced deal that replaced the plain
 * shuffle on Today. Given the day's records (each carrying a server-assigned coarse
 * `bucket`), it groups by bucket and deals one bucket per round, so the front of the
 * deck spans genres instead of leading with a run of the dominant one. app.js is
 * browser code, so — like pick-listen.test.mjs — we lift the two functions verbatim
 * and eval them in isolation, proving the logic exactly as shipped.
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
  lift(/\nfunction balancedOrder\(list\) \{[\s\S]*?\n\}/, "balancedOrder"),
  "return { balancedOrder };",
].join("\n");
// eslint-disable-next-line no-new-func
const { balancedOrder } = new Function(code)();

let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; } else { failed++; console.error("  ✗ FAIL:", m); } }

const rec = (id, bucket) => ({ id, bucket });
const buckets = (list) => list.map((r) => r.bucket);
const distinct = (arr) => [...new Set(arr)];

// A heavily skewed day: electronic dominates, a few rock, a couple jazz — the exact
// shape the balanced draw exists to fix.
const day = [
  ...Array.from({ length: 20 }, (_, i) => rec(`e${i}`, "electronic")),
  ...Array.from({ length: 4 }, (_, i) => rec(`r${i}`, "rock")),
  ...Array.from({ length: 2 }, (_, i) => rec(`j${i}`, "jazz")),
];

// Run many times: the shuffle is random, so invariants must hold on every deal.
for (let trial = 0; trial < 200; trial++) {
  const out = balancedOrder(day);

  // 1. valid permutation — same records, none lost or duplicated
  ok(out.length === day.length, "output length preserved");
  ok(distinct(out.map((r) => r.id)).length === day.length,
     "every record appears exactly once (no dupes/drops)");

  // 2. the FIRST ROUND spans all present buckets — the core guarantee. With 3
  //    distinct buckets, the first 3 records are one of each (no run up front).
  const head = buckets(out.slice(0, 3));
  ok(distinct(head).length === 3,
     `first 3 records span all 3 buckets, got ${JSON.stringify(head)}`);

  // 3. no bucket leads with a run: electronic (20 of 26) must NOT occupy the first
  //    two slots back-to-back (a plain shuffle would do this ~57% of the time).
  ok(!(out[0].bucket === "electronic" && out[1].bucket === "electronic"),
     "no electronic run at the very front");
}

// 4. degrades gracefully: a single-genre day is still a valid (shuffled) permutation
const mono = Array.from({ length: 6 }, (_, i) => rec(`m${i}`, "electronic"));
const monoOut = balancedOrder(mono);
ok(monoOut.length === 6 && distinct(monoOut.map((r) => r.id)).length === 6,
   "single-bucket day: valid permutation");

// 5. records with no bucket field group under "unknown" (genre-blind, not dropped)
const mixed = [rec("a", "rock"), { id: "b" }, { id: "c" }, rec("d", "rock")];
const mixedOut = balancedOrder(mixed);
ok(mixedOut.length === 4, "records missing a bucket are kept (treated as unknown)");

// 6. empty input
ok(balancedOrder([]).length === 0, "empty day -> empty deck");

console.log(`balanced-order: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
