/*
 * "Where you were today" (FB 2026-07-18): a reader opened a record, tapped Listen,
 * and came back to a different one — the deck is in-memory, so anything that ends
 * the page re-deals the day at random from idx 0. resumeAt() puts the record you
 * were on back at the FRONT of a freshly dealt deck.
 *
 * The load-bearing property is that it absorbs everything: no entry, a new day, a
 * record since kept/skipped, a corrupt blob, storage that throws — every one of
 * those must fall through to a plain fresh deal, which is the behaviour we already
 * shipped. Losing your place must cost nothing but your place.
 *
 * app.js is browser code, so the functions are lifted verbatim and eval'd in
 * isolation (same trick as balanced-order / deal-order).
 *
 * Run: node tests/js/resume-at.test.mjs
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

// A stand-in localStorage we can break on purpose.
function makeStore() {
  const map = new Map();
  return {
    mode: "ok",                       // "ok" | "throw-set" | "throw-get"
    getItem(k) {
      if (this.mode === "throw-get") throw new Error("SecurityError");
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (this.mode === "throw-set") throw new Error("QuotaExceededError");
      map.set(k, v);
    },
    removeItem(k) { map.delete(k); },
    _raw: map,
  };
}

function build(today) {
  const code = [
    lift(/\nconst AT_KEY = "[^"]+";/, "AT_KEY"),
    lift(/\nfunction loadAt\(\) \{[\s\S]*?\n\}/, "loadAt"),
    lift(/\nfunction saveAt\(uid\) \{[\s\S]*?\n\}/, "saveAt"),
    lift(/\nfunction resumeAt\(list\) \{[\s\S]*?\n\}/, "resumeAt"),
    "function albumKey(a) { return a && (a.uid || null); }",
    `function todayFull() { return TODAY.v; }`,
    "return { loadAt, saveAt, resumeAt, AT_KEY };",
  ].join("\n");
  const TODAY = { v: today };
  // eslint-disable-next-line no-new-func
  return new Function("localStorage", "TODAY", code)(store, TODAY);
}

let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; } else { failed++; console.error("  ✗ FAIL:", m); } }

let store = makeStore();
const rec = (uid) => ({ uid });
const deck = ["a", "b", "c", "d", "e"].map(rec);
const uids = (l) => l.map((r) => r.uid).join(",");

// --- the fix itself -----------------------------------------------------------
let api = build("2026-07-18");
api.saveAt("c");
ok(uids(api.resumeAt(deck)) === "c,a,b,d,e",
   `the remembered record leads, got "${uids(api.resumeAt(deck))}"`);

// It must MOVE the record, not jump the index past a,b — those were never seen,
// and skipping them would quietly cost the reader part of the day.
ok(api.resumeAt(deck).length === deck.length, "no records are dropped");
ok(new Set(api.resumeAt(deck).map((r) => r.uid)).size === deck.length,
   "no records are duplicated");

// The input list is not mutated (deckState.all is shared with the genre filter).
const before = uids(deck);
api.resumeAt(deck);
ok(uids(deck) === before, "the dealt list is not mutated in place");

// Already at the front → unchanged.
api.saveAt("a");
ok(uids(api.resumeAt(deck)) === "a,b,c,d,e", "a record already first is left alone");

// --- everything that must fall through to a fresh deal ------------------------
store = makeStore(); api = build("2026-07-18");
ok(uids(api.resumeAt(deck)) === before, "no stored entry -> untouched");

api.saveAt("c");
api = build("2026-07-19");                        // next day
ok(uids(api.resumeAt(deck)) === before, "a stale day -> untouched");

store = makeStore(); api = build("2026-07-18");
api.saveAt("zzz");                                // kept/skipped, or gone from the pool
ok(uids(api.resumeAt(deck)) === before, "a record no longer in the deck -> untouched");

store = makeStore(); api = build("2026-07-18");
store._raw.set("mf-today-at/v1", "{not json");
ok(uids(api.resumeAt(deck)) === before, "a corrupt entry -> untouched, no throw");

store = makeStore(); api = build("2026-07-18");
store._raw.set("mf-today-at/v1", JSON.stringify({ date: "2026-07-18", uid: 42 }));
ok(uids(api.resumeAt(deck)) === before, "a non-string uid -> untouched");

ok(uids(api.resumeAt([])) === "", "an empty deck -> empty");

// --- storage that refuses to work (private mode, quota, blocked cookies) ------
store = makeStore(); store.mode = "throw-set"; api = build("2026-07-18");
let threw = null;
try { api.saveAt("c"); } catch (e) { threw = e; }
ok(threw === null, "saveAt swallows a storage write failure (private mode / quota)");

store = makeStore(); store.mode = "throw-get"; api = build("2026-07-18");
threw = null;
let out = null;
try { out = api.resumeAt(deck); } catch (e) { threw = e; }
ok(threw === null && uids(out) === before,
   "a storage read failure -> fresh deal, never a thrown deck");

// --- clearing your place ------------------------------------------------------
store = makeStore(); api = build("2026-07-18");
api.saveAt("c");
api.saveAt(null);                                 // the deck ran out
ok(api.loadAt() === null, "saveAt(null) clears the entry (end of deck)");
ok(uids(api.resumeAt(deck)) === before, "...and the next deal is fresh");

// --- what it actually costs ---------------------------------------------------
store = makeStore(); api = build("2026-07-18");
api.saveAt("m:mb:0062b6e9-14b0-4ff0-ad45-211a0450f859");   // a realistic long uid
const bytes = store._raw.get("mf-today-at/v1").length;
ok(bytes < 120,
   `the whole entry stays tiny (${bytes} B) — the alternative was ~57 KB of deal order`);

console.log(`resume-at: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
