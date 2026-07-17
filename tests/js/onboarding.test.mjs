/*
 * Headless tests for the onboarding welcome flag (Phase C / F).
 *
 * The welcome screen is shown once per device, gated by a localStorage flag. We
 * test the pure core (seen / markSeen / reset / shouldShowFirstRun) against an
 * injected in-memory storage — no browser, no DOM. The screen rendering itself
 * (show / maybeShowFirstRun's DOM path) is covered by the manual QA checklist.
 *
 * Run: node tests/js/onboarding.test.mjs
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const O = require("../../static/onboarding.js");

let passed = 0, failed = 0;
function ok(c, m) { if (c) passed++; else { failed++; console.error("  ✗ FAIL:", m); } }

// A Storage-shaped fake shared across calls (so "persist" is real).
function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}

function main() {
  console.log("onboarding tests");

  // --- fresh device: never seen, should show -------------------------------
  {
    const s = fakeStorage();
    ok(O.seen(s) === false, "a fresh device hasn't seen the welcome");
    ok(O.shouldShowFirstRun(s) === true, "fresh device should show the first-run welcome");
  }

  // --- markSeen flips it, persists, and stops the first-run show ------------
  {
    const s = fakeStorage();
    O.markSeen(s);
    ok(O.seen(s) === true, "markSeen records the device as having seen it");
    ok(O.shouldShowFirstRun(s) === false, "a seen device skips the first-run welcome");
    // persists across a fresh read of the same storage (= a reload)
    ok(s.getItem(O.KEY) === "1", "the flag is persisted under the published KEY");
  }

  // --- reset clears it (re-test / 'show me again') --------------------------
  {
    const s = fakeStorage();
    O.markSeen(s);
    O.reset(s);
    ok(O.seen(s) === false, "reset clears the seen flag");
    ok(O.shouldShowFirstRun(s) === true, "after reset, the first-run welcome shows again");
  }

  // --- the first-run guided-tour flag: independent, once per device --------
  {
    const s = fakeStorage();
    ok(O.tourSeen(s) === false, "a fresh device hasn't seen the tour");
    ok(O.shouldShowTour(s) === true, "fresh device should show the first-run tour");
    O.markTourSeen(s);
    ok(O.tourSeen(s) === true, "markTourSeen records the device as having seen the tour");
    ok(O.shouldShowTour(s) === false, "a seen device skips the tour");
    ok(s.getItem(O.TOUR_KEY) === "1", "the tour flag persists under TOUR_KEY");
    // independence: the tour flag must NOT be the welcome flag
    ok(O.seen(s) === false, "seeing the tour does not mark the welcome as seen");
    ok(O.TOUR_KEY !== O.KEY, "the tour and welcome flags use distinct keys");
    O.resetTour(s);
    ok(O.shouldShowTour(s) === true, "resetTour makes the tour eligible again");
  }

  // --- the tour steps, in the owner's order --------------------------------
  {
    const t = O.copy.tour;
    ok(Array.isArray(t) && t.length === 7, "the tour has seven steps");
    ok(typeof t[0].resolve === "function", "step 1 (platforms) resolves its target (header chip vs ☰ menu)");
    ok(typeof O.copy.tourPlatformsHeader === "string" && typeof O.copy.tourPlatformsMenu === "string",
      "platforms step has both header and ☰-menu copy");
    ok(/deck-cover/.test(t[1].sel), "step 2 points at the album (tap for details)");
    ok(t[2].sel === "#deckListen", "step 3 points at Listen (the #deckListen element)");
    ok(t[3].sel === "#setAsideBtn", "step 4 points at Shelve (the #setAsideBtn element)");
    ok(t[4].sel === "#keepBtn", "step 5 points at Keep");
    ok(/journal/.test(t[5].sel), "step 6 points at the Notebook tab");
    ok(/feedbackBtn/.test(t[6].sel), "step 7 points at the Feedback button");
    ok(t.every((st) => typeof st.resolve === "function" || (typeof st.text === "string" && st.text.length > 0)),
      "every tour step carries copy (static text or a resolver)");
  }

  // --- robustness: a throwing storage never bubbles up ----------------------
  {
    const boom = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    };
    ok(O.seen(boom) === false, "seen() swallows storage errors (returns false)");
    let threw = false;
    try { O.markSeen(boom); O.reset(boom); } catch (e) { threw = true; }
    ok(threw === false, "markSeen/reset never throw on a blocked storage");
  }

  // --- the copy catalog is present (R8: one keyed place for the strings) ----
  {
    ok(typeof O.copy.title === "string" && O.copy.title.length > 0, "copy has a title");
    ok(Array.isArray(O.copy.paras) && O.copy.paras.length >= 3, "copy has the concept paragraphs");
    ok(typeof O.copy.startFirst === "string" && typeof O.copy.startAgain === "string",
      "copy has both primary-button labels");
    ok(typeof O.copy.tourNext === "string" && typeof O.copy.tourDone === "string",
      "copy has the tour next / done labels");
  }

  // --- the fresh-account signup combination (auth-ui.js renderSetup) ---------
  // An invited person arrives from the invite email — which IS the whole field
  // guide — so signup does BOTH: markSeen (skip the "What is this?" card, which
  // would just re-explain what they read two minutes ago) and resetTour (still
  // give them the walk-through the email promises, even on a device that saw the
  // cues as a guest). The two flags are independent; this pins that, because
  // getting it wrong is silent — either a redundant wall or a lost tour.
  {
    const s = fakeStorage();
    O.markSeen(s);
    O.resetTour(s);
    ok(O.shouldShowFirstRun(s) === false,
      "signup: the welcome card is skipped (the email already said all of it)");
    ok(O.shouldShowTour(s) === true,
      "signup: the guided tour still runs (the email promises it)");
  }

  // A device that saw the tour as a guest, then signs up: still gets the tour,
  // still no welcome card.
  {
    const s = fakeStorage();
    O.markTourSeen(s);
    O.markSeen(s);
    ok(O.shouldShowTour(s) === false, "guest who saw the tour: flag set");
    O.resetTour(s);
    ok(O.shouldShowTour(s) === true,
      "...but signup re-arms the tour for a genuine first login");
    ok(O.shouldShowFirstRun(s) === false,
      "...and the welcome card stays skipped");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
