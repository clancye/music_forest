/*
 * The phone's back gesture on the Genre screen (owner, 2026-10-04: "when i swipe back
 * on mobile from the genre page it closes the app instead of just going back one
 * step"). Opening the screen pushes one history step; a system back closes the screen
 * and goes nowhere else; closing it from its own Back / Show takes the step back off,
 * so no dead back-press lingers and the wander's back handling is never triggered by
 * the Genre screen. The functions are lifted verbatim from app.js and run against a
 * fake history whose back() fires popstate later, like a real browser's does.
 *
 * Run: node tests/js/style-browse-back.test.mjs
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

// A browser history: a stack of states. back() pops and delivers popstate on flush(),
// asynchronously, as browsers do.
function makeHistory() {
  const stack = [{ base: true }];
  const queued = [];
  return {
    stack, queued,
    pushState(state) { stack.push(state); },
    back() { queued.push(() => { if (stack.length > 1) stack.pop(); }); },
  };
}
function makeEl() {
  const cls = new Set(["hidden"]);
  return { value: "", scrollTop: 0,
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c),
      contains: (c) => cls.has(c) } };
}

const code = [
  lift(/\nlet _sbHistoryStep = false;[^\n]*\nlet _sbSkipPop = false;[^\n]*/, "flags"),
  lift(/\nfunction openStyleBrowse\(\) \{[\s\S]*?\n\}/, "openStyleBrowse"),
  lift(/\nfunction closeStyleBrowse\(\) \{[\s\S]*?\n\}/, "closeStyleBrowse"),
  lift(/\nfunction styleBrowsePopstate\(\) \{[\s\S]*?\n\}/, "styleBrowsePopstate"),
  "return { openStyleBrowse, closeStyleBrowse, styleBrowsePopstate };",
].join("\n");

function setup() {
  const history = makeHistory();
  const els = { styleBrowse: makeEl(), sbSearch: makeEl(), sbList: makeEl() };
  const document = { getElementById: (id) => els[id] || null };
  // eslint-disable-next-line no-new-func
  const api = new Function("history", "document", "styleIndex", "renderStyleBrowse", code)(
    history, document, () => ({ tags: [] }), () => {});
  let wanderPops = 0;
  // The app's one popstate listener: Genre screen first, then the wander.
  const onPop = () => { if (!api.styleBrowsePopstate()) wanderPops++; };
  const userBack = () => { history.stack.pop(); onPop(); };     // the system gesture
  const flush = () => { while (history.queued.length) { history.queued.shift()(); onPop(); } };
  const open = () => !els.styleBrowse.classList.contains("hidden");
  return { api, history, open, userBack, flush, wanderPops: () => wanderPops };
}

let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; } else { failed++; console.error("  ✗ FAIL:", m); } }

// 1. Opening adds exactly one step.
{
  const t = setup();
  t.api.openStyleBrowse();
  ok(t.open(), "the Genre screen opens");
  ok(t.history.stack.length === 2 && t.history.stack[1].aotdSheet === "genre",
     "opening pushes one history step");
}

// 2. The system back closes the screen and goes no further — the app stays open.
{
  const t = setup();
  t.api.openStyleBrowse();
  t.userBack();
  ok(!t.open(), "system back closes the Genre screen");
  ok(t.history.stack.length === 1, "and leaves the history where it was before");
  ok(t.wanderPops() === 0, "the wander's back handling is not triggered");
}

// 3. Closing from the screen's own Back / Show takes the step off, silently.
{
  const t = setup();
  t.api.openStyleBrowse();
  t.api.closeStyleBrowse();
  ok(!t.open(), "the screen's Back closes it at once");
  t.flush();
  ok(t.history.stack.length === 1, "its history step is taken back off");
  ok(t.wanderPops() === 0, "that echo pop is not mistaken for a reader's back");
}

// 4. Open, close, open again: a fresh step each time, never two at once.
{
  const t = setup();
  t.api.openStyleBrowse(); t.api.closeStyleBrowse(); t.flush();
  t.api.openStyleBrowse();
  ok(t.history.stack.length === 2, "re-opening pushes one step again");
  t.userBack();
  ok(!t.open() && t.history.stack.length === 1, "and back closes it again");
}

// 5. With the screen closed, back belongs to the wander as before.
{
  const t = setup();
  t.history.pushState({ aotdWander: 2 });
  t.userBack();
  ok(t.wanderPops() === 1, "back with no Genre screen open still walks the wander");
}

console.log(`style-browse-back: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
