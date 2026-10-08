/*
 * The first-run picker (v341, owner 2026-10-04 — docs/mockups/welcome round 2, "S5"):
 * a new guest's Today stands the services where the cover goes, plus "Everything", and
 * Start wakes once one is chosen. firstRunToggle() is the selection rule, and two of
 * its promises carry weight:
 *   - TAP ORDER is kept, because it becomes the saved platform order — the service
 *     Listen tries first is the one you tapped first.
 *   - "Everything" is EXCLUSIVE with the services. It is the honest path the old
 *     welcome card protected ("choose none to see everything"): a service narrows the
 *     day to records we can confirm there, so Everything must never sit alongside one.
 * We lift the shipped function from app.js and run it in isolation.
 *
 * Run: node tests/js/first-run.test.mjs
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
  lift(/\nconst FIRST_RUN_ALL = [^\n]*/, "FIRST_RUN_ALL"),
  lift(/\nfunction firstRunToggle\(sel, key\) \{[\s\S]*?\n\}/, "firstRunToggle"),
  "return { firstRunToggle, ALL: FIRST_RUN_ALL };",
].join("\n");
// eslint-disable-next-line no-new-func
const { firstRunToggle: t, ALL } = new Function(code)();

let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; } else { failed++; console.error("  ✗ FAIL:", m); } }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

ok(same(t([], "deezer"), ["deezer"]), "a tap on nothing chooses that service");
ok(same(t(["deezer"], "spotify"), ["deezer", "spotify"]), "tap order is kept (Deezer first, then Spotify)");
ok(same(t(["deezer", "spotify"], "deezer"), ["spotify"]), "a second tap un-chooses it; the rest keep their order");
ok(same(t(["deezer", "spotify"], ALL), [ALL]), "Everything clears the services");
ok(same(t([ALL], "apple"), ["apple"]), "a service clears Everything");
ok(same(t([ALL], ALL), []), "tapping Everything again leaves nothing chosen (Start sleeps)");
ok(!t(["spotify", "apple"], "bandcamp").includes(ALL), "Everything never rides along with a service");

console.log(`first-run: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
