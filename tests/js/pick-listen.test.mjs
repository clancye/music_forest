/*
 * Pick-simplify: pickListenPlatforms() is the pure priority-selection function
 * behind the pick page's primary "Listen on ___" button + secondary chips. Given
 * an album's confirmed `platforms` map and the user's ordered pref array, it
 * returns { primary, chips } in priority order. app.js is browser code (touches
 * `document`/`window` at load), so — like css-escape.test.mjs — we lift the
 * function and its platform tables verbatim from the source and eval them in
 * isolation, proving the logic exactly as shipped.
 *
 * Run: node tests/js/pick-listen.test.mjs
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
  lift(/const CONFIRMED_PLATFORMS = \[[\s\S]*?\];/, "CONFIRMED_PLATFORMS"),
  lift(/const _platClass = Object\.fromEntries\([\s\S]*?\);/, "_platClass"),
  lift(/const _platLabel = Object\.fromEntries\([\s\S]*?\);/, "_platLabel"),
  lift(/\nfunction pickListenPlatforms\(platforms, prefs\) \{[\s\S]*?\n\}/, "pickListenPlatforms"),
  "return { pickListenPlatforms, CONFIRMED_PLATFORMS };",
].join("\n");
// eslint-disable-next-line no-new-func
const { pickListenPlatforms, CONFIRMED_PLATFORMS } = new Function(code)();

let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; } else { failed++; console.error("  ✗ FAIL:", m); } }
const keys = (list) => list.map((t) => t[0]);

// A fully-confirmed album, links keyed by platform name (every CONFIRMED_PLATFORMS
// entry, so the no-pref canonical-order check exercises the whole set).
const all = {
  spotify: "https://sp", apple: "https://am", youtube: "https://yt",
  deezer: "https://dz", tidal: "https://td", amazon: "https://az",
  pandora: "https://pa", bandcamp: "https://bc",
};

// 1) No pref → canonical CONFIRMED_PLATFORMS order among confirmed platforms.
{
  const { primary, chips } = pickListenPlatforms(all, []);
  const canon = CONFIRMED_PLATFORMS.map(([k]) => k);
  ok(primary[0] === canon[0], "no-pref primary is the first canonical platform");
  ok(JSON.stringify([primary[0], ...keys(chips)]) === JSON.stringify(canon),
     "no-pref order follows CONFIRMED_PLATFORMS");
  ok(primary[2] === all[primary[0]], "primary carries the exact confirmed url");
}

// 2) Pref order drives the primary + chip order (priority, not canonical).
{
  const { primary, chips } = pickListenPlatforms(all, ["deezer", "spotify", "apple"]);
  ok(primary[0] === "deezer", "priority #1 (deezer) becomes the primary");
  ok(JSON.stringify(keys(chips)) === JSON.stringify(["spotify", "apple"]),
     "chips follow the remaining priority order");
}

// 3) With a pref set, platforms NOT in the set never show (matches the filter),
//    even when the album is confirmed on them.
{
  const { primary, chips } = pickListenPlatforms(all, ["youtube", "tidal"]);
  ok(primary[0] === "youtube", "primary is the top preferred platform");
  ok(JSON.stringify(keys(chips)) === JSON.stringify(["tidal"]),
     "only preferred platforms appear; spotify/apple/deezer excluded");
}

// 4) The first *confirmed* platform in priority order wins — a preferred but
//    unconfirmed platform is skipped, not shown as a dead button.
{
  const partial = { apple: "https://am", deezer: "https://dz" };
  const { primary, chips } = pickListenPlatforms(partial, ["spotify", "apple", "deezer"]);
  ok(primary[0] === "apple", "unconfirmed spotify is skipped; apple is primary");
  ok(JSON.stringify(keys(chips)) === JSON.stringify(["deezer"]), "deezer trails as a chip");
}

// 5) Nothing confirmed (or nothing preferred-and-confirmed) → no primary.
{
  ok(pickListenPlatforms({}, ["spotify"]).primary === null, "no confirmed links → null primary");
  ok(pickListenPlatforms({ spotify: "x" }, ["deezer"]).primary === null,
     "confirmed platform outside the pref set → null primary");
  ok(pickListenPlatforms(null, []).primary === null, "null platforms map is safe");
}

// 6) An unknown key in the pref array is ignored (loadListenPrefs already filters,
//    but the selector must not crash or emit a classless button).
{
  const { primary } = pickListenPlatforms(all, ["bogus", "spotify"]);
  ok(primary[0] === "spotify", "unknown pref key skipped, next valid one used");
}

console.log(`pick-listen: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
