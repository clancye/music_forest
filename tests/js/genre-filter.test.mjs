/*
 * A8 Phase 2: the opt-in genre filter is applied client-side. applyGenreFilter()
 * is the honesty-critical core — it must (a) be inert when nothing's ticked, (b)
 * keep only records carrying a ticked tag, which HIDES records with no tags on file
 * (we won't claim a genre we don't have), and (c) yield entirely in dig mode (the
 * always-unfiltered escape hatch). Since v335 the ticked Genre-screen tags
 * (genreTags) are the ONLY genre input: the hidden-bucket set (genreFilter) is gone,
 * and a leftover `bucket` field on a record is never read. Around it: the deck filter
 * still composes tags AND era AND year span, the Genre pill's tally counts tags, the
 * filtered-empty state names what was ticked as the Genre screen labels it (v336:
 * "post-rock", not its merged key "postrock"), and Clear filters empties both facets.
 * We lift the shipped functions from app.js and run them in isolation.
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
  "let digMode = false; let refilters = 0; let deckState = null;",
  "const els = {}; const document = { getElementById: (id) => els[id] || null };",
  "const choice = { innerHTML: '' }; const $ = (sel) => (sel === '#choice' ? choice : null);",
  "function refilterDeck() { refilters++; }",
  lift(/\nconst esc = [\s\S]*?\);\n/, "esc"),
  lift(/\nconst genreTags = new Set\(\);/, "genreTags"),
  lift(/\nconst deckEras = new Set\(\);/, "deckEras"),
  lift(/\nlet deckYearFrom = null, deckYearTo = null;/, "deckYearFrom/To"),
  lift(/\nconst ATOMIC_GENRES = [^\n]*/, "ATOMIC_GENRES"),
  lift(/\nfunction genresOf\(a\) \{[\s\S]*?\n\}/, "genresOf"),
  lift(/\nfunction decadeOf\(a\) \{[\s\S]*?\n\}/, "decadeOf"),
  lift(/\nconst _recordTagCache = new WeakMap\(\);\nfunction recordTags\(r\) \{[\s\S]*?\n\}/, "recordTags"),
  lift(/\nfunction tagKey\(t\) \{[^\n]*\}/, "tagKey"),
  lift(/\nconst _recordTagKeyCache = new WeakMap\(\);\nfunction recordTagKeys\(r\) \{[\s\S]*?\n\}/, "recordTagKeys"),
  lift(/\nfunction styleIndex\(\) \{[\s\S]*?\n\}/, "styleIndex"),
  lift(/\nfunction tagLabel\(k\) \{[\s\S]*?\n\}/, "tagLabel"),
  lift(/\nfunction applyGenreFilter\(list\) \{[\s\S]*?\n\}/, "applyGenreFilter"),
  lift(/\nfunction applyDeckFilters\(list\) \{[\s\S]*?\n\}/, "applyDeckFilters"),
  lift(/\nfunction updateGenreTally\(\) \{[\s\S]*?\n\}/, "updateGenreTally"),
  lift(/\nfunction renderGenreFilteredEmpty\(\) \{[\s\S]*?\n\}/, "renderGenreFilteredEmpty"),
  lift(/\nfunction clearGenreFilter\(\) \{[\s\S]*?\n\}/, "clearGenreFilter"),
  "return { applyGenreFilter, applyDeckFilters, updateGenreTally, renderGenreFilteredEmpty,",
  "  clearGenreFilter, tagKey, genreTags, deckEras, els, choice,",
  "  setDay:(all)=>{deckState={all}},",
  "  setDig:(v)=>{digMode=v}, setYears:(a,b)=>{deckYearFrom=a; deckYearTo=b},",
  "  refilters:()=>refilters };",
].join("\n");
// eslint-disable-next-line no-new-func
const api = new Function(code)();
const { applyGenreFilter, applyDeckFilters, updateGenreTally, renderGenreFilteredEmpty,
  clearGenreFilter, tagKey, genreTags, deckEras, els, choice, setDay, setDig, setYears,
  refilters } = api;

let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; } else { failed++; console.error("  ✗ FAIL:", m); } }

// `bucket` is a leftover of the retired hidden genres: no client code may read it.
const day = [
  { id: "a", year: 1959, genres: "Jazz", styles: "Hard Bop", bucket: "jazz" },
  { id: "b", year: 1971, genres: "Rock", styles: "Prog Rock" },
  { id: "c", year: 1964, genres: "jazz", styles: "" },                 // MB-shaped
  { id: "d", year: 1975, genres: "", styles: "", bucket: "jazz" },     // no tags on file
  { id: "e", year: 1994, genres: "Electronic", styles: "Techno" },
  { id: "f", year: 1996, genres: "post-rock", styles: "" },          // MB spelling
];
setDay(day);
const ids = (list) => list.map((r) => r.id).join(",");
const tick = (...ts) => { genreTags.clear(); for (const t of ts) genreTags.add(tagKey(t)); };

// (a) nothing ticked -> inert, returns the whole day (identity)
tick();
ok(applyGenreFilter(day) === day, "empty filter returns the whole day untouched");

// (b) ticking a tag keeps only records carrying it — and HIDES the untagged record,
// even though its leftover `bucket` says jazz
tick("jazz");
ok(ids(applyGenreFilter(day)) === "a,c", "ticking jazz keeps only records tagged jazz");
ok(!ids(applyGenreFilter(day)).includes("d"),
   "a record with no tags is hidden under a filter, whatever its old bucket (honesty rule)");

// multi-select is a union
tick("jazz", "techno");
ok(ids(applyGenreFilter(day)) === "a,c,e", "multi-select filters to the union of ticks");

// (c) dig mode ignores the filter entirely (the escape hatch)
setDig(true);
ok(applyGenreFilter(day).length === day.length, "dig mode yields the whole day regardless of ticks");
setDig(false);
ok(applyGenreFilter(day).length === 3, "filter re-applies when dig is off");

// The deck filter composes: tags AND era AND year span, each OR within itself.
tick("jazz"); deckEras.add("1950s");
ok(ids(applyDeckFilters(day)) === "a", "jazz AND the 1950s");
tick(); deckEras.clear(); setYears(1960, 1980);
ok(ids(applyDeckFilters(day)) === "b,c,d", "a year span alone narrows by year");
tick("rock"); setYears(1960, 1980);
ok(ids(applyDeckFilters(day)) === "b", "rock AND 1960–1980");
setDig(true);
ok(applyDeckFilters(day).length === day.length, "dig ignores tags, eras and the year span");
setDig(false); setYears(null, null); tick();

// The Genre pill's tally counts the ticked tags; the Year pill's counts eras + a span.
els.genreTally = { hidden: false, textContent: "" };
els.dateTally = { hidden: false, textContent: "" };
updateGenreTally();
ok(els.genreTally.hidden && els.dateTally.hidden, "no ticks, no eras -> both tallies hidden");
tick("jazz", "rock"); deckEras.add("1970s"); setYears(1960, null);
updateGenreTally();
ok(!els.genreTally.hidden && els.genreTally.textContent === " · 2", "Genre tally counts ticked tags");
ok(!els.dateTally.hidden && els.dateTally.textContent === " · 2", "Year tally counts eras + the span");
setYears(null, null);

// The filtered-empty state names what was ticked, tags then eras.
renderGenreFilteredEmpty();
ok(choice.innerHTML.includes("Nothing today in jazz, rock, 1970s."), "empty state names the ticks");
ok(choice.innerHTML.includes("data-clear-genres"), "empty state offers Clear filters");

// ...by the label the Genre screen shows, not the merged key the filter holds: ticking
// the post-rock row stores "postrock", and the empty state must still say "post-rock".
// A tick today no longer carries falls back to its key rather than vanishing.
tick("post-rock", "dream pop");
ok([...genreTags].join() === "postrock,dreampop", "the filter holds merged keys");
renderGenreFilteredEmpty();
ok(choice.innerHTML.includes("Nothing today in post-rock, dreampop, 1970s."),
   "empty state shows the row's label, and the key for a tag absent today");

// Clear filters empties both facets and re-derives the deck once; a no-op when clear.
const before = refilters();
clearGenreFilter();
ok(!genreTags.size && !deckEras.size, "Clear filters empties tags and eras");
ok(refilters() === before + 1, "Clear filters re-derives the deck");
clearGenreFilter();
ok(refilters() === before + 1, "Clear filters with nothing set does nothing");

console.log(`genre-filter: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
