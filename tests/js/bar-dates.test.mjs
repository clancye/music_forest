/*
 * The bottom bar's dates (v353, owner 2026-10-05, docs/mockups/search N1 + S1). One search
 * bar per tab, and it understands dates:
 *   - Notebook: a date-like entry becomes ranges to narrow by (barDateRanges);
 *   - Search: a calendar day becomes "records released then, any year" (barDay).
 * Lifted from the shipped app.js and run against a fixed today (Monday, Oct 5, 2026).
 *
 * Run: node tests/js/bar-dates.test.mjs
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
const fn = (name, args) => lift(new RegExp(`\\nfunction ${name}\\(${args}\\) \\{[\\s\\S]*?\\n\\}`), name);
const code = [
  lift(/\nconst BAR_MONTHS = \[[\s\S]*?\];/, "BAR_MONTHS"),
  lift(/\nconst BAR_MON = [^\n]*/, "BAR_MON"),
  fn("barMonth", "w"), fn("barYmd", "y, m, d"), lift(/\nfunction barDaysIn\(y, m\) [^\n]*/, "barDaysIn"),
  fn("barDayLabel", "ymd"), lift(/\nfunction barMonthLabel\(y, m\) [^\n]*/, "barMonthLabel"),
  fn("barOneDate", "text, years"), fn("barDateRanges", "q, today, years"), fn("barDay", "q"),
  "return { barDateRanges, barDay };",
].join("\n");
// eslint-disable-next-line no-new-func
const { barDateRanges, barDay } = new Function(code)();

let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; } else { failed++; console.error("  ✗ FAIL:", m); } }
const TODAY = new Date(2026, 9, 5);
const Y = [2026, 2025];
const r = (q, ys = Y) => barDateRanges(q, TODAY, ys).map((x) => `${x.label}|${x.from}|${x.to}`);

ok(r("oct").join(";") === "October 2026|2026-10-01|2026-10-31;October 2025|2025-10-01|2025-10-31",
   "a month: one per year your notebook reaches, newest first");
ok(r("oct 5").join(";") === "Oct 5, 2026|2026-10-05|2026-10-05;Oct 5, 2025|2025-10-05|2025-10-05", "month + day");
ok(r("5 Oct").join(";") === r("oct 5").join(";") && r("october 5").join(";") === r("oct 5").join(";"),
   "day-first and full names read the same");
ok(r("10/5").join(";") === r("oct 5").join(";"), "numeric month/day");
ok(r("10/5/25").join(";") === "Oct 5, 2025|2025-10-05|2025-10-05", "a two-digit year picks one");
ok(r("2025").join(";") === "All of 2025|2025-01-01|2025-12-31", "a year");
ok(r("sept 2025").join(";") === "September 2025|2025-09-01|2025-09-30", "month + year");
ok(r("2025-10-05").join(";") === "Oct 5, 2025|2025-10-05|2025-10-05", "an ISO date");
ok(r("today").join(";") === "Today|2026-10-05|2026-10-05", "today");
ok(r("yes").join(";") === "Yesterday|2026-10-04|2026-10-04", "a relative word by its first letters");
ok(r("this week").join(";") === "This week|2026-10-05|2026-10-05", "this week starts on Monday (today)");
ok(r("last week").join(";") === "Last week|2026-09-28|2026-10-04", "last week: Monday to Sunday");
ok(r("last month").join(";") === "Last month|2026-09-01|2026-09-30", "last month");
ok(r("las").length === 3, "\"las\" offers last week, last month and last year");
ok(r("sep 1 - oct 5")[0] === "Sep 1, 2026 – Oct 5, 2026|2026-09-01|2026-10-05", "a span");
ok(r("sep 1 to oct 5")[0] === r("sep 1 - oct 5")[0], "\"to\" works as a dash");
ok(r("dec 20 - jan 5", [2026])[0] === "Dec 20, 2026 – Jan 5, 2027|2026-12-20|2027-01-05",
   "a span across New Year runs forward");
ok(r("feb 30").length === 0 && r("13/5").length === 0, "impossible dates offer nothing");
ok(r("beck").length === 0 && r("de").length === 0 && r("").length === 0, "words aren't dates");
ok(r("may").length === 2, "a month name is a month (the trail stays put underneath)");

ok(barDay("oct 5") === "10-05" && barDay("October 5") === "10-05" && barDay("5 oct") === "10-05",
   "Search: a day by name, either order");
ok(barDay("10/5") === "10-05" && barDay("1-31") === "01-31", "Search: a numeric day");
ok(barDay("feb 29") === "02-29", "Search: Feb 29 is a real day (any year)");
ok(barDay("feb 30") === null && barDay("13/5") === null, "Search: impossible days aren't offered");
ok(barDay("oct") === null && barDay("beck") === null && barDay("2025") === null,
   "Search: a month, a word or a year isn't a day");

console.log(`bar-dates: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
