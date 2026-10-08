/*
 * The kind of open a day fetch reports (app.js openKind, 2026-10-07) — the operator Log's
 * "First open of the day / Opened again / Reloaded / Changed platforms". Pinned:
 *   - a device's first fetch of its own day is "first" (that's the device count), and the
 *     only thing kept is the date, in its own storage;
 *   - a platform change says so, unless it IS the day's first fetch;
 *   - a page's first fetch after a reload is "reload"; any other is "again";
 *   - storage that throws never breaks it (it just counts as first again).
 *
 * Run: node tests/js/open-kind.test.mjs
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "..", "static", "app.js"), "utf8");
const m = src.match(/\nconst OPEN_DAY_KEY = [\s\S]*?\nfunction openKind\(\) \{[\s\S]*?\n\}/);
if (!m) throw new Error("could not find openKind in app.js");

let passed = 0, failed = 0;
function ok(c, msg) { if (c) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }

function make({ today = "2026-10-07", nav = "navigate", store = {}, throws = false } = {}) {
  const localStorage = {
    getItem: (k) => { if (throws) throw new Error("blocked"); return k in store ? store[k] : null; },
    setItem: (k, v) => { if (throws) throw new Error("blocked"); store[k] = v; },
  };
  const performance = { getEntriesByType: () => [{ type: nav }] };
  // eslint-disable-next-line no-new-func
  const api = new Function("localStorage", "performance", "todayFull",
    m[0] + "\nreturn { openKind, setWhy: (w) => { _openWhy = w; } };")(localStorage, performance, () => today);
  return { api, store };
}

let t = make();
ok(t.api.openKind() === "first", "a device's first open of the day is 'first'");
ok(t.store["mf-open-day"] === "2026-10-07", "...and the only thing kept is the date");
ok(t.api.openKind() === "again", "the next fetch on the page is 'again'");
t.api.setWhy("platforms");
ok(t.api.openKind() === "platforms", "a platform change says so");
ok(t.api.openKind() === "again", "...once");

t = make({ nav: "reload", store: { "mf-open-day": "2026-10-07" } });
ok(t.api.openKind() === "reload", "a reloaded page's first fetch (not the day's first) is 'reload'");
ok(t.api.openKind() === "again", "...and its later fetches are 'again'");

t = make({ store: { "mf-open-day": "2026-10-06" } });
t.api.setWhy("platforms");
ok(t.api.openKind() === "first", "a new day wins over a platform change — the device count stays exact");

t = make({ nav: "navigate", store: { "mf-open-day": "2026-10-07" } });
ok(t.api.openKind() === "again", "relaunching later the same day is 'again'");

t = make({ throws: true });
ok(t.api.openKind() === "first", "blocked storage never throws (it counts as a first open)");

console.log(`open-kind: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
