/*
 * A keep must survive a brief outage (2026-07-18).
 *
 * There is no outbox: recordChoice POSTs straight to /api/choices. So a keep tapped
 * while the origin is unreachable used to rest entirely on the reader noticing a
 * 6-second toast — and markMet() had already run, so once it faded the record was
 * out of today's deck with nothing saved. A release 502s for ~27 s (measured), which
 * is squarely inside that window.
 *
 * Two properties are pinned here:
 *   1. RETRY, but only where re-POSTing is provably safe. /api/choices has no
 *      idempotency key, so a 500 (the app saw it, may have committed) must NOT be
 *      retried, while a gateway 502/503/504 and a rejected fetch (never reached the
 *      app) must be.
 *   2. GIVE THE RECORD BACK. When the retries are exhausted, markMet is reverted so
 *      the record returns to today's deck — a second meeting beats a silent hole.
 *
 * The two functions are lifted from app.js and run against fakes (same trick as
 * resume-at / deal-order), with the retry delays stubbed to 0.
 *
 * Run: node tests/js/keep-retry.test.mjs
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

const keepRetryFn = lift(/\nasync function keepWriteWithRetry\(a\) \{[\s\S]*?\n\}/,
                         "keepWriteWithRetry");
const recordKeepFn = lift(/\nasync function recordKeep\(a, key\) \{[\s\S]*?\n\}/,
                          "recordKeep");
const classifyFn = lift(/\nfunction writeNeverReachedApp\(status\) \{[\s\S]*?\n\}/,
                        "writeNeverReachedApp");
// eslint-disable-next-line no-new-func
const writeNeverReachedApp = new Function(
  `${classifyFn}\nreturn writeNeverReachedApp;`)();

// Build an isolated world. `plan` is the sequence of outcomes recordChoice should
// produce: "ok", "netfail", "race" (the note editor lands the row first), or an HTTP
// status number.
//
// currentChoiceId and deckState are declared INSIDE the generated scope, alongside
// the lifted functions, rather than passed in as parameters — a parameter is bound by
// value, so a fake reassigning it would never be seen by the code under test, and the
// race case below would silently pass for the wrong reason.
function build(plan) {
  const calls = { recordChoice: 0, unmarkMet: 0, markMet: 0, toasts: [] };
  const met = new Set();
  const code = `
    let currentChoiceId = null;
    let n = 0;
    const deckState = { kept: new Map() };
    const KEEP_RETRY_DELAYS = [0, 0, 0];
    async function recordChoice() {
      const outcome = plan[Math.min(n, plan.length - 1)];
      n++; calls.recordChoice++;
      if (outcome === "ok") { currentChoiceId = 42; return; }
      if (outcome === "race") {
        currentChoiceId = 99;                     // saveChoiceReason got there first
        const e = new Error("HTTP 502"); e.neverReached = true; throw e;
      }
      if (outcome === "netfail") {
        const e = new Error("network"); e.neverReached = true; throw e;
      }
      const e = new Error("HTTP " + outcome);
      e.neverReached = writeNeverReachedApp(outcome);   // the REAL classifier
      throw e;
    }
    ${keepRetryFn}
    ${recordKeepFn}
    return { keepWriteWithRetry, recordKeep, deckState,
             choiceId: () => currentChoiceId };
  `;
  // eslint-disable-next-line no-new-func
  const api = new Function(
    "plan", "calls", "met", "markMet", "unmarkMet", "updateSetAsideBar",
    "showToast", "albumKey", "writeNeverReachedApp", code
  )(
    plan, calls, met,
    (k) => { calls.markMet++; met.add(k); },
    (k) => { calls.unmarkMet++; met.delete(k); },
    () => {},
    (msg, label, fn) => calls.toasts.push({ msg, label, fn }),
    (x) => x && x.uid,
    writeNeverReachedApp
  );
  return { api, calls, met };
}

let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; } else { failed++; console.error("  ✗ FAIL:", m); } }

const album = { uid: "d:123", artist: "A", title: "T" };

// --- the classifier, tested directly ------------------------------------------
// This is the rule that keeps a retry from creating a SECOND copy of one keep, so
// it's pinned against the real function rather than through a fake that could drift
// (an earlier version of this file recomputed the mapping itself, and a mutation
// that retried 500s passed clean).
for (const s of [502, 503, 504]) {
  ok(writeNeverReachedApp(s) === true, `${s} (gateway, app never saw it) is retryable`);
}
for (const s of [500, 501, 505, 400, 401, 403, 404, 409, 422, 429]) {
  ok(writeNeverReachedApp(s) === false,
     `${s} is NOT retryable — the app may have committed the row`);
}

// --- the happy path is unchanged ---------------------------------------------
{
  const { api, calls, met } = build(["ok"]);
  await api.recordKeep(album, "d:123");
  ok(calls.recordChoice === 1, "a working write POSTs exactly once");
  ok(met.has("d:123"), "the record stays marked met");
  ok(calls.unmarkMet === 0, "nothing is handed back");
  ok(calls.toasts.length === 0, "no toast on success");
}

// --- retries the failures that prove the app never saw the write --------------
{
  const { api, calls, met } = build([502, 502, "ok"]);
  await api.recordKeep(album, "d:123");
  ok(calls.recordChoice === 3, `a gateway 502 is retried until it lands (${calls.recordChoice})`);
  ok(met.has("d:123"), "the keep survived the outage — record stays met");
  ok(calls.toasts.length === 0, "a self-healed keep never bothers the reader");
}
{
  const { api, calls } = build(["netfail", "ok"]);
  await api.recordKeep(album, "d:123");
  ok(calls.recordChoice === 2, "a rejected fetch (never completed) is retried");
}
for (const status of [503, 504]) {
  const { api, calls } = build([status, "ok"]);
  await api.recordKeep(album, "d:123");
  ok(calls.recordChoice === 2, `a gateway ${status} is retried`);
}

// --- but NOT the one that might already have written --------------------------
{
  const { api, calls, met } = build([500, "ok"]);
  await api.recordKeep(album, "d:123");
  ok(calls.recordChoice === 1,
     "a 500 is NOT retried — /api/choices has no idempotency key, so a re-POST could duplicate");
  ok(!met.has("d:123"), "...and the record is handed back instead");
}
for (const status of [400, 404, 409]) {
  const { api, calls } = build([status, "ok"]);
  await api.recordKeep(album, "d:123");
  ok(calls.recordChoice === 1, `a ${status} is not retried either`);
}

// --- giving the record back ---------------------------------------------------
{
  const { api, calls, met } = build([502, 502, 502, 502, 502]);
  api.deckState.kept.set("d:123", null);
  await api.recordKeep(album, "d:123");
  ok(calls.recordChoice === 4,
     `retries are bounded to the delay list + 1 (${calls.recordChoice})`);
  ok(!met.has("d:123"),
     "exhausted retries hand the record BACK to today (markMet reverted)");
  ok(!api.deckState.kept.has("d:123"), "and it no longer counts as kept");
  ok(calls.toasts.length === 1 && /back in today/.test(calls.toasts[0].msg),
     "the reader is told, in terms of what actually happened");
  ok(calls.toasts[0].label === "Retry", "with a way to try again");
}
{
  // The record must be genuinely re-servable, not just un-flagged: the same key
  // going back through markMet has to stick again on a later successful keep.
  const { api, met } = build([502, 502, 502, 502]);
  await api.recordKeep(album, "d:123");
  ok(!met.has("d:123"), "handed back...");
  const second = build(["ok"]);
  await second.api.recordKeep(album, "d:123");
  ok(second.met.has("d:123"), "...and a later keep of the same record still records");
}

// --- the note editor racing the retry -----------------------------------------
{
  // saveChoiceReason re-records when currentChoiceId is null; if it lands mid-retry
  // the loop must stop rather than POST a second row (there's no idempotency key).
  const { api, calls, met } = build(["race"]);
  await api.recordKeep(album, "d:123");
  ok(calls.recordChoice === 1, "the loop stops once the row exists");
  ok(api.choiceId() === 99, "...on the id the note editor created");
  ok(met.has("d:123"), "the record stays met — it really was saved");
  ok(calls.toasts.length === 0, "and the reader isn't told it failed");
}

console.log(`keep-retry: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
