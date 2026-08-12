/*
 * A8 Phase 2: the opt-in genre filter is applied client-side. applyGenreFilter()
 * is the honesty-critical core — it must (a) be inert when nothing's picked, (b)
 * keep only records whose `bucket` is picked, which HIDES genre-unknown records
 * (we won't claim a genre we don't have), and (c) yield entirely in dig mode (the
 * always-unfiltered escape hatch). We lift it (and titleCaseGenre) from app.js and
 * run them in isolation, proving the shipped logic.
 *
 * Run: node tests/js/genre-filter.test.mjs
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
  // genreTerms (FB#57b type-in filter) is referenced by applyGenreFilter now, so
  // the stub must define it too — empty here, since these cases exercise buckets.
  "let digMode = false; const genreFilter = new Set(); const genreTerms = new Set();",
  lift(/\nfunction applyGenreFilter\(list\) \{[\s\S]*?\n\}/, "applyGenreFilter"),
  lift(/\nfunction titleCaseGenre\(b\) \{[^\n]*\}/, "titleCaseGenre"),
  "return { applyGenreFilter, titleCaseGenre, genreFilter, genreTerms, setDig:(v)=>{digMode=v} };",
].join("\n");
// eslint-disable-next-line no-new-func
const api = new Function(code)();
const { applyGenreFilter, titleCaseGenre, genreFilter, setDig } = api;

let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; } else { failed++; console.error("  ✗ FAIL:", m); } }

const day = [
  { id: "a", bucket: "jazz" }, { id: "b", bucket: "rock" },
  { id: "c", bucket: "jazz" }, { id: "d", bucket: "unknown" },
  { id: "e", bucket: "electronic" },
];
const ids = (list) => list.map((r) => r.id);

// (a) no picks -> inert, returns the whole day (identity)
genreFilter.clear();
ok(applyGenreFilter(day).length === 5, "empty filter returns the whole day");

// (b) picking a genre keeps only that bucket — and HIDES the unknown record
genreFilter.clear(); genreFilter.add("jazz");
ok(JSON.stringify(ids(applyGenreFilter(day))) === JSON.stringify(["a", "c"]),
   "filter to jazz keeps only jazz");
ok(!ids(applyGenreFilter(day)).includes("d"),
   "genre-unknown record is hidden under a filter (honesty rule)");

// multi-select is a union
genreFilter.clear(); genreFilter.add("jazz"); genreFilter.add("electronic");
ok(JSON.stringify(ids(applyGenreFilter(day))) === JSON.stringify(["a", "c", "e"]),
   "multi-select filters to the union of picks");

// (c) dig mode ignores the filter entirely (the escape hatch)
setDig(true);
ok(applyGenreFilter(day).length === 5, "dig mode yields the whole day regardless of picks");
setDig(false);
ok(applyGenreFilter(day).length === 3, "filter re-applies when dig is off");

// titleCaseGenre: the internal bucket keys -> display labels
ok(titleCaseGenre("hip hop") === "Hip Hop", "hip hop -> Hip Hop");
ok(titleCaseGenre("funk / soul") === "Funk / Soul", "funk / soul -> Funk / Soul");
ok(titleCaseGenre("electronic") === "Electronic", "electronic -> Electronic");

console.log(`genre-filter: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
