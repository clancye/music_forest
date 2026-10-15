/*
 * "How today works" — the door behind the ⓘ on Today's date (app.js todayWhyLines,
 * 2026-10-15; owner: the app "doesn't exactly make it clear that there are no
 * recommendations/tracking happening"). It's a promise, so its sentences are pinned:
 *   - it names the day and, once the whole day has loaded, its real count (the first card
 *     arrives alone, so a count of 1 is left out rather than shown as "1 of them");
 *   - "somewhere" vs "on the services you listen on" follows whether your own services
 *     narrow the day; dig says it's unfiltered, and that nothing narrows it;
 *   - tomorrow's date rolls over months and years, and Feb 28 → Feb 29.
 *
 * Run: node tests/js/today-why.test.mjs
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "..", "static", "app.js"), "utf8");
const grab = (re, name) => { const m = src.match(re); if (!m) throw new Error("could not find " + name); return m[0]; };
const code = [
  grab(/\nfunction mdDisplay\(md\) \{[\s\S]*?\n\}/, "mdDisplay"),
  grab(/\nfunction nextMd\(md\) \{[\s\S]*?\n\}/, "nextMd"),
  grab(/\nfunction todayWhyLines\(\{ md, n, mine, dig \}\) \{[\s\S]*?\n\}/, "todayWhyLines"),
].join("\n");
// eslint-disable-next-line no-new-func
const { nextMd, todayWhyLines } = new Function(code + "\nreturn { nextMd, todayWhyLines };")();

let passed = 0, failed = 0;
function ok(c, msg) { if (c) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }

let l = todayWhyLines({ md: "10-15", n: 2776, mine: false, dig: false });
ok(l[0] === "These are the records released on October 15, in any year, that can be played somewhere: 2,776 of them today.", "names the day and its count: " + l[0]);
ok(l[2].includes("not an algorithm that knows you") && l[2].endsWith("Tomorrow it's October 16's turn."), "nobody selected them; tomorrow named: " + l[2]);
ok(l[3].startsWith("The only things that narrow them are the ones you set"), "the reader's own narrowing named");

l = todayWhyLines({ md: "10-15", n: 1, mine: false, dig: false });
ok(l[0] === "These are the records released on October 15, in any year, that can be played somewhere.", "no count while only the first card is in: " + l[0]);

l = todayWhyLines({ md: "10-15", n: 840, mine: true, dig: false });
ok(l[0].includes("that can be played on the services you listen on: 840 of them today"), "your services narrow it: " + l[0]);

l = todayWhyLines({ md: "10-15", n: 9100, mine: true, dig: true });
ok(l[0].startsWith("You're digging: these are all the records released on October 15") &&
   l[0].includes("(9,100 of them)") && l[0].includes("haven't found a place to play yet"), "dig is the full union: " + l[0]);
ok(l[3] === "Dig ignores your services and Filter, so nothing narrows it.", "dig is never narrowed (honesty rule)");

ok(nextMd("12-31") === "01-01", "Dec 31 → Jan 1");
ok(nextMd("02-28") === "02-29", "Feb 28 → Feb 29 (Feb 29 is a real on-this-day)");
ok(nextMd("02-29") === "03-01", "Feb 29 → Mar 1");
ok(nextMd("09-30") === "10-01", "Sep 30 → Oct 1");

console.log(`today-why: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
