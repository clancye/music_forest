/*
 * Safe auto-update (owner ask 2026-08-11): on return-to-foreground, a ready update
 * applies itself silently — but ONLY when nothing is lost. The whole value is the
 * SAFETY gate `autoReloadSafe()`: it must refuse to reload whenever a reload would
 * cost something (an unlocked Notebook re-locks; an open note draft is dropped; a
 * focused text field with content is lost). This test lifts that function from
 * auth-ui.js and drives it against fake window/document states.
 *
 * Run: node tests/js/auto-update.test.mjs
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "..", "static", "auth-ui.js"), "utf8");

const m = src.match(/\n  function autoReloadSafe\(\) \{[\s\S]*?\n  \}/);
if (!m) throw new Error("could not find autoReloadSafe in auth-ui.js");
// Inject window/document so the lifted function's bare globals resolve to our fakes.
const makeSafe = new Function("window", "document", m[0] + "\n  return autoReloadSafe;");

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) passed++; else { failed++; console.error("  ✗ FAIL:", msg); } }

// A document whose noteModal is hidden/shown and whose activeElement we control.
function doc({ noteHidden = true, active = null } = {}) {
  return {
    getElementById: (id) => id === "noteModal"
      ? { classList: { contains: (c) => c === "hidden" ? noteHidden : false } }
      : null,
    activeElement: active,
  };
}
const store = (locked) => ({ AOTDStore: { locked: () => locked } });
const guest = { AOTDStore: null };
const run = (win, d) => makeSafe(win, d)();

// --- the SAFE cases: reload costs nothing ----------------------------------
ok(run(guest, doc()) === true, "guest, no draft → safe");
ok(run(store(true), doc()) === true, "Notebook LOCKED, no draft → safe");
ok(run(store(true), doc({ active: { tagName: "INPUT", type: "text", value: "   " } })) === true,
   "focused input with only whitespace → safe (trimmed)");
ok(run(store(true), doc({ active: { tagName: "DIV" } })) === true,
   "focused non-text element → safe");

// --- the UNSAFE cases: something would be lost ------------------------------
ok(run(store(false), doc()) === false,
   "Notebook UNLOCKED → unsafe (reload would re-lock it)");
ok(run(store(true), doc({ noteHidden: false })) === false,
   "note composer OPEN → unsafe (would drop the draft)");
ok(run(store(true), doc({ active: { tagName: "TEXTAREA", value: "half a thought" } })) === false,
   "focused textarea with text → unsafe");
ok(run(store(true), doc({ active: { tagName: "INPUT", type: "search", value: "miles" } })) === false,
   "focused search input with text → unsafe");
ok(run(guest, doc({ noteHidden: false })) === false,
   "guest mid-note (composer open) → unsafe");

// A store whose locked() throws must fail CLOSED (never reload on uncertainty).
ok(run({ AOTDStore: { locked: () => { throw new Error("boom"); } } }, doc()) === false,
   "store.locked() throwing → unsafe (fail closed)");

console.log(`auto-update: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
