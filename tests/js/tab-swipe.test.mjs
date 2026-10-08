/*
 * Swiping between the tabs (owner 2026-10-04: "slide and snap and be a fun user
 * experience"). swipeOutcome() decides, when the finger lifts, whether the page
 * snaps on to the neighbouring tab or springs back. Its promises:
 *   - a long drag (past ~28% of the width) commits;
 *   - a quick flick commits even when short — if it's moving the same way and has
 *     travelled past 24px (so a jittery tap never changes tabs);
 *   - with no tab that way (past Today, past Explore) it ALWAYS springs back;
 *   - a flick back against the drag cancels it.
 * We lift the shipped function from app.js and run it in isolation.
 *
 * Run: node tests/js/tab-swipe.test.mjs
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "..", "static", "app.js"), "utf8");
const m = src.match(/\nfunction swipeOutcome\(dx, vx, width, hasTarget\) \{[\s\S]*?\n\}/);
if (!m) throw new Error("could not find swipeOutcome in app.js");
// eslint-disable-next-line no-new-func
const swipeOutcome = new Function(m[0] + "\nreturn swipeOutcome;")();

let passed = 0, failed = 0;
function ok(c, msg) { if (c) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
const W = 375;   // an iPhone mini

ok(swipeOutcome(-120, -0.1, W, true) === "commit", "a long slow drag left commits");
ok(swipeOutcome(140, 0.05, W, true) === "commit", "a long slow drag right commits");
ok(swipeOutcome(-60, -0.1, W, true) === "back", "a short slow drag springs back");
ok(swipeOutcome(-50, -0.8, W, true) === "commit", "a short quick flick commits");
ok(swipeOutcome(-18, -1.2, W, true) === "back", "a flick under 24px is a tap, not a swipe");
ok(swipeOutcome(-80, 0.6, W, true) === "back", "flicking back against the drag cancels it");
ok(swipeOutcome(-300, -2, W, false) === "back", "past the last tab it always springs back");
ok(swipeOutcome(0, 0, W, true) === "back", "no movement, no change");

console.log(`tab-swipe: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
