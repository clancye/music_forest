/*
 * admin.js humanDuration() — renders the invite→account accept latency ("3h 12m").
 *
 * Worth its own test because the input is seconds straight out of Postgres
 * (EXTRACT(EPOCH ...), so a Decimal that psycopg may hand over as a float or a
 * string) and the output is read as a fact about real people. The rounding
 * matters at the boundaries: 59.6s must not render "0m", and 24h must roll to
 * "1d" rather than "24h".
 *
 * admin.js is a browser IIFE, so the function is lifted verbatim and eval'd
 * (same approach as resume-at / deal-order).
 *
 * Run: node tests/js/human-duration.test.mjs
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "..", "static", "admin.js"), "utf8");

const m = src.match(/\n  function humanDuration\(secs\) \{[\s\S]*?\n  \}/);
if (!m) throw new Error("could not find humanDuration in admin.js");
// eslint-disable-next-line no-new-func
const humanDuration = new Function(m[0] + "\nreturn humanDuration;")();

let passed = 0, failed = 0;
function eq(got, want, label) {
  if (got === want) { passed++; } else {
    failed++; console.error(`  ✗ ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

eq(humanDuration(0), "0s", "zero");
eq(humanDuration(45), "45s", "seconds");
eq(humanDuration(59.6), "1m", "rounds up across the minute boundary, never '0m'");
eq(humanDuration(60), "1m", "one minute");
eq(humanDuration(90), "1m", "90s reads as 1m (two units max)");
eq(humanDuration(3599), "59m", "just under an hour");
eq(humanDuration(3600), "1h", "exactly an hour drops the empty minutes");
eq(humanDuration(3600 * 3 + 60 * 12), "3h 12m", "hours and minutes");
eq(humanDuration(86400 - 1), "23h 59m", "just under a day");
eq(humanDuration(86400), "1d", "exactly a day rolls over, not '24h'");
eq(humanDuration(86400 * 4 + 3600 * 2), "4d 2h", "days and hours");
eq(humanDuration(86400 * 4), "4d", "whole days drop the empty hours");

// Postgres hands EXTRACT(EPOCH ...) back as a Decimal; psycopg may surface it as a
// float or a string. Neither may render as NaN in the operator's face.
eq(humanDuration("3600"), "1h", "a numeric string still renders");
eq(humanDuration(3600.4), "1h", "a float still renders");
eq(humanDuration(null), "0s", "null degrades rather than NaN");
eq(humanDuration(undefined), "0s", "undefined degrades");
eq(humanDuration(NaN), "0s", "NaN degrades");
eq(humanDuration(-5), "0s", "a negative clamps (clock skew), never '-5s'");

console.log(`human-duration: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
