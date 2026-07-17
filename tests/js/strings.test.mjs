/*
 * Headless tests for the central user-facing strings catalog (R8).
 *
 * The catalog (static/strings.js) is a pure module — no DOM, no browser — so its
 * shape and the get("a.b.c") accessor are fully testable here. The call sites in
 * app.js read through a fallback-safe `str()` (the literal is always passed as a
 * fallback), so these tests guard the catalog contract, not the rendering.
 *
 * Run: node tests/js/strings.test.mjs
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const Strings = require("../../static/strings.js");

let passed = 0, failed = 0;
function ok(c, m) { if (c) passed++; else { failed++; console.error("  ✗ FAIL:", m); } }

// Every key a call site looks up. If app.js gains a new str("x.y", …) site, add
// its path here so the catalog can't silently drift (a missing key falls back to
// the literal at runtime, but we still want it present in the one home).
const EXPECTED_KEYS = [
  "trail.empty",
  "trail.exploreCta",
  "feedback.helpHosted",
  "feedback.helpLocal",
];

function main() {
  console.log("strings catalog tests");

  // 1. Module shape.
  ok(Strings && typeof Strings.get === "function", "exports get()");
  ok(Strings && typeof Strings.S === "object", "exports the S catalog object");

  // 2. Every expected key resolves to a non-empty string.
  for (const key of EXPECTED_KEYS) {
    const v = Strings.get(key);
    ok(typeof v === "string" && v.length > 0, `get("${key}") is a non-empty string`);
  }

  // 3. The accessor degrades safely on bad / unknown paths (callers rely on this
  //    returning undefined so their literal fallback takes over).
  ok(Strings.get("nope.not.here") === undefined, "unknown path -> undefined");
  ok(Strings.get("forest") === undefined, "non-leaf path -> undefined (not the object)");
  ok(Strings.get("") === undefined, "empty path -> undefined");
  ok(Strings.get(null) === undefined, "null path -> undefined");
  ok(Strings.get(undefined) === undefined, "undefined path -> undefined");

  // 4. A known value matches exactly (catches accidental edits to the voice).
  ok(Strings.get("trail.exploreCta") === "Explore →", "trail.exploreCta wording");

  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main();
