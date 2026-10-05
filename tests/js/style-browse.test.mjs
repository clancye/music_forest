/*
 * The Genre screen (owner 2026-09-24; flat since v332, 2026-10-04). The honesty-critical
 * promise: the count a row shows is EXACTLY the number of records ticking it yields —
 * so a tick is an exact tag match ("house" is not also "tech house"), and styleIndex()
 * and applyGenreFilter() read one tag definition (recordTags → recordTagKeys).
 *
 * v332 pins, on top of that: there are NO genre groups — a broad genre like "rock" is a
 * row like any other, and nothing is filed under "World" or "Other"; spellings that
 * differ only in spaces / hyphens / punctuation MERGE into one row that matches either,
 * labelled with the commonest spelling; A–Z and rarest-first orders; the rarity bands;
 * untagged records are counted; dig still ignores everything.
 *
 * Run: node tests/js/style-browse.test.mjs
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
  "let digMode = false; let deckState = null;",
  "const genreTags = new Set();",
  lift(/\nconst ATOMIC_GENRES = [^\n]*/, "ATOMIC_GENRES"),
  lift(/\nfunction genresOf\(a\) \{[\s\S]*?\n\}/, "genresOf"),
  lift(/\nconst _recordTagCache = new WeakMap\(\);\nfunction recordTags\(r\) \{[\s\S]*?\n\}/, "recordTags"),
  lift(/\nfunction tagKey\(t\) \{[^\n]*\}/, "tagKey"),
  lift(/\nconst _recordTagKeyCache = new WeakMap\(\);\nfunction recordTagKeys\(r\) \{[\s\S]*?\n\}/, "recordTagKeys"),
  lift(/\nfunction applyGenreFilter\(list\) \{[\s\S]*?\n\}/, "applyGenreFilter"),
  lift(/\nfunction styleIndex\(\) \{[\s\S]*?\n\}/, "styleIndex"),
  lift(/\nfunction sbBand\(n\) \{[\s\S]*?\n\}/, "sbBand"),
  lift(/\nfunction sbLetter\(label\) \{[\s\S]*?\n\}/, "sbLetter"),
  lift(/\nfunction sbOrderedTags\(idx, order, q\) \{[\s\S]*?\n\}/, "sbOrderedTags"),
  "return { applyGenreFilter, styleIndex, sbBand, sbLetter, sbOrderedTags, tagKey, genreTags,",
  "  setDay:(all)=>{deckState={all}}, setDig:(v)=>{digMode=v} };",
].join("\n");
// eslint-disable-next-line no-new-func
const api = new Function(code)();
const { applyGenreFilter, styleIndex, sbBand, sbLetter, sbOrderedTags, tagKey, genreTags,
  setDay, setDig } = api;

let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; } else { failed++; console.error("  ✗ FAIL:", m); } }

const day = [
  { id: 1, genres: "Electronic", styles: "House, Deep House" },
  { id: 2, genres: "Electronic", styles: "Tech House" },
  { id: 3, genres: "electronic, house, techno", styles: "" },  // MB-shaped
  { id: 4, genres: "Jazz, Rock", styles: "Hard Bop, Fusion" },
  { id: 5, genres: "Rock", styles: "Post Rock, Prog Rock" },
  { id: 6, genres: "post-rock, rock", styles: "" },            // MB spelling
  { id: 7, genres: "Folk, World, & Country", styles: "Celtic" },
  { id: 8, genres: "experimental", styles: "" },
  { id: 9, genres: "", styles: "" },
];
setDay(day);
const idx = styleIndex();
const ids = (l) => l.map((r) => r.id).join(",");
const row = (label) => idx.tags.find((t) => t.label === label);

// Every row's count equals the records a lone tick of it yields.
let allMatch = true;
for (const t of idx.tags) {
  genreTags.clear(); genreTags.add(t.key);
  if (applyGenreFilter(day).length !== t.n) { allMatch = false; console.error("   mismatch:", t.label, t.n); }
}
genreTags.clear();
ok(allMatch, "every row's count == the records ticking it yields");

// Exact, not substring: house is house, never tech/deep house.
ok(row("house").n === 2, "house counts rec 1 (style) + rec 3 (MB tag), not tech/deep house");
genreTags.add(tagKey("house"));
ok(ids(applyGenreFilter(day)) === "1,3", "ticking house yields exactly records 1 and 3");
genreTags.clear();

// Merging: "post rock" (Discogs) and "post-rock" (MB) are one row matching both records.
ok(tagKey("Post Rock") === tagKey("post-rock") && tagKey("post-rock") === tagKey("postrock"),
   "spellings differing only in spaces / hyphens share a key");
const pr = idx.tags.filter((t) => t.key === tagKey("post rock"));
ok(pr.length === 1 && pr[0].n === 2 && pr[0].spellings.length === 2, "post rock / post-rock merge into one row of 2");
genreTags.add(tagKey("post-rock"));
ok(ids(applyGenreFilter(day)) === "5,6", "ticking the merged row matches either spelling");
genreTags.clear();
ok(tagKey("hip hop") !== tagKey("hip hop soul"), "different tags stay different");

// No groups: broad genres are plain rows; nothing is filed under World / Other.
ok(row("rock") && row("rock").n === 3, "rock is a row of its own (records tagged rock)");
ok(row("electronic") && row("folk, world, & country"), "genres appear as rows, as the source writes them");
ok(!idx.tags.some((t) => t.label === "world" || t.label === "other styles"), "no invented World / Other rows");
ok(row("experimental") && row("experimental").n === 1, "a genre-unknown record's tag is still a row");

// Untagged records are counted for the honesty note.
ok(idx.untagged === 1 && idx.total === 9, "one record carries no tags at all");

// Orders.
const az = sbOrderedTags(idx, "az", "").map((t) => t.label);
ok(az.every((l, i) => i === 0 || az[i - 1].localeCompare(l) <= 0), "A–Z is alphabetical");
const rare = sbOrderedTags(idx, "rare", "");
ok(rare.every((t, i) => i === 0 || rare[i - 1].n <= t.n), "rarest first runs from the fewest records up");
ok(rare[rare.length - 1].label === "rock" || rare[rare.length - 1].label === "electronic",
   "the biggest tags sink to the bottom");
ok(sbOrderedTags(idx, "az", "rock").every((t) => t.spellings.some((s) => s.includes("rock"))),
   "search filters on every spelling");
ok(sbBand(1) === "Only 1 record today" && sbBand(2) === "2 records" && sbBand(4) === "3–5 records"
   && sbBand(20) === "6–20 records" && sbBand(100) === "21–100 records" && sbBand(101) === "More than 100",
   "rarity bands");
ok(sbLetter("rock") === "R" && sbLetter("électro") === "E" && sbLetter("80s") === "#", "letter sections");

// Dig ignores the filter.
genreTags.add(tagKey("celtic"));
setDig(true);
ok(applyGenreFilter(day).length === day.length, "dig mode ignores the tag filter");
setDig(false);
ok(ids(applyGenreFilter(day)) === "7", "the filter re-applies when dig is off");
genreTags.clear();

// B2: MusicBrainz community tags (`tags`) are rows too — moods, scenes, places — and a
// tick on one yields exactly the records carrying it (owner: cities are a rough place
// filter for now).
const tagged = [
  { id: 21, genres: "rock", styles: "", tags: "doom, berlin" },
  { id: 22, genres: "Electronic", styles: "Techno", tags: "berlin" },
  { id: 23, genres: "jazz", styles: "" },
];
setDay(tagged);
const tidx = styleIndex();
const trow = (label) => tidx.tags.find((t) => t.label === label);
ok(trow("berlin") && trow("berlin").n === 2, "a city tag is a row counting both records");
ok(trow("doom") && trow("doom").n === 1, "a mood/style tag is a row");
genreTags.add(tagKey("berlin"));
ok(ids(applyGenreFilter(tagged)) === "21,22", "ticking berlin yields exactly those records");
genreTags.clear();
setDay(day);

console.log(`style-browse: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
