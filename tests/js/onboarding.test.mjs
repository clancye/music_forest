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
    ok(Array.isArray(t) && t.length === 9, "the tour has nine steps");
    ok(typeof t[0].resolve === "function", "step 1 (platforms) resolves its target (header chip vs ☰ menu)");
    ok(typeof O.copy.tourPlatformsHeader === "string" && typeof O.copy.tourPlatformsMenu === "string",
      "platforms step has both header and ☰-menu copy");
    ok(t[1].sel === "#genrePref", "step 2 points at By genre");
    ok(t[2].sel === "#datePref", "step 3 points at By year");
    ok(/deck-cover/.test(t[3].sel), "step 4 points at the album (tap for details)");
    ok(t[4].sel === "#deckListen", "step 5 points at Listen (the #deckListen element)");
    ok(t[5].sel === "#setAsideBtn", "step 6 points at Skip (the #setAsideBtn element)");
    ok(t[6].sel === "#keepBtn", "step 7 points at Keep");
    ok(/journal/.test(t[7].sel), "step 8 points at the Notebook tab");
    // FB#105: Feedback moved into the ☰ menu, so this step resolves its target the
    // same way the platforms step does — the menu where the button is adopted, or the
    // floating chip on a build that mounts no menu. It MUST stay resolvable: _hasStep
    // skips a step whose target is missing, so a hard-coded selector pointing at the
    // wrong home would delete the owner's sign-off card in silence.
    ok(typeof t[8].resolve === "function", "step 9 (feedback) resolves its target (☰ menu vs floating chip)");
    ok(typeof O.copy.tourFeedbackMenu === "string" && typeof O.copy.tourFeedbackChip === "string",
      "feedback step has both ☰-menu and floating-chip copy");
    ok(/Clancy/.test(O.copy.tourFeedbackMenu) && /Clancy/.test(O.copy.tourFeedbackChip),
      "both feedback lines keep the owner's sign-off");
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

  // --- FB#99/#93: the tour is offered, and ✕ is not the exit ----------------
  // Two separate complaints, two separate invariants:
  //   #99 — the tour must ASK first, and taking the offer's "no" must not lose it
  //         (the ☰ carries "Take the tour", and declining says so once).
  //   #93 — ✕ on a card must dismiss THAT CARD, not the whole tour; leaving is an
  //         explicit "Skip the tour". The DOM behaviour is verified in the browser;
  //         what's pinned here is that the two controls are distinct pieces of copy
  //         and the API a caller needs actually exists. Without this, a refactor that
  //         re-pointed ✕ at endTour would look fine and silently restore the bug.
  {
    ok(typeof O.showTourOffer === "function", "the offer is exported (FB#99)");
    ok(typeof O.startTourOnDemand === "function",
      "the ☰ can start the tour on demand — 'no' isn't the end of it");
    ok(typeof O.closeTourOffer === "function", "the offer can be dismissed programmatically");
    ok(typeof O.copy.tourOfferText === "string" && /tour/i.test(O.copy.tourOfferText),
      "the offer asks about the tour in words");
    ok(typeof O.copy.tourOfferYes === "string" && typeof O.copy.tourOfferNo === "string",
      "the offer has both answers");
    ok(typeof O.copy.tourDeclinedText === "string" && /take the tour/i.test(O.copy.tourDeclinedText),
      "declining points at the menu item by its exact label");
    ok(typeof O.copy.tourDismissCard === "string",
      "✕ has its own label (FB#93) — it dismisses a card");
    ok(O.copy.tourDismissCard !== O.copy.tourSkip,
      "dismiss-this-card and skip-the-tour are NOT the same control");
    ok(!/skip/i.test(O.copy.tourDismissCard),
      "✕'s label never says 'skip' — that word belongs to the exit");
  }

  // --- FB#109: the returning-reader tour offer -------------------------------
  // Shipped as a BARE tour offer by owner's decision (2026-08-07): "No one is really
  // using this app so let's just say 'Would you like a tour?'" — a deliberate,
  // recorded exception to BRAND.md's disclosure-first rule, taken because the
  // population that could be confused is currently tiny.
  //
  // So this pins the MECHANISM (its own flag, its own audience) and NOT the wording,
  // which is the owner's to set. Deliberately no assertion that the copy names Keep,
  // Skip or the swap: an earlier revision asserted exactly that, and a test that
  // outlives the decision it encodes turns a considered product call into a build
  // failure. What it does keep is that the offer still ASKS ABOUT A TOUR — that is
  // what the "Yes" button goes on to start, so copy that asked about anything
  // else would be a broken promise rather than a style choice.
  // (The show path needs a DOM; it's verified in the browser.)
  {
    ok(typeof O.SWAP_OFFER_KEY === "string" && O.SWAP_OFFER_KEY.length > 0,
      "the offer has a flag key");
    ok(O.SWAP_OFFER_KEY !== O.CHANGE_OFFER_KEY,
      "its flag is its OWN — the FB#105 offer's key is already burned for this audience");

    const t = O.copy.swapOfferText;
    ok(typeof t === "string" && t.trim().length > 0, "the offer has copy");
    ok(/tour/i.test(t), "it asks about the tour — which is what 'Yes' starts");
    ok(/\?/.test(t), "it is a question, not a statement to be dealt with");
  }

  // The offer burns the once-per-device tour flag when it's shown, so nobody is
  // asked twice — including someone who ignores it entirely.
  {
    const s = fakeStorage();
    ok(O.shouldShowTour(s) === true, "fresh device is eligible for the offer");
    O.markTourSeen(s);   // what showTourOffer does on show (its DOM path needs a browser)
    ok(O.shouldShowTour(s) === false, "after being asked once, the offer doesn't return");
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

  // --- the bridge cue's once-per-device flag (BRAND.md "Announcing a change") ---
  // The DOM half (anchoring, placement, the auth-gate stacking exemption) is browser
  // work and was verified in-browser; what's testable here is the part that decides
  // whether a reader is ever told: the keyed flag, and that it is spent on SHOW so a
  // reload can't replay the cue.
  {
    const s = fakeStorage();
    const K = "aotd.cue.test.v1";
    ok(O.hintSeen(K, s) === false, "a fresh device hasn't seen this cue");
    ok(typeof O.showHint === "function", "showHint is exported");
    ok(typeof O.closeHint === "function", "closeHint is exported");

    // showHint needs a DOM; headlessly it must decline rather than throw, and must
    // NOT burn the flag — a cue that can't render yet keeps its one chance.
    const shown = O.showHint({ key: K, sel: "#nope", text: "x", storage: s });
    ok(shown === false, "showHint declines with no DOM instead of throwing");
    ok(O.hintSeen(K, s) === false,
      "...and does NOT spend the flag, so the cue still fires on a later render");

    // Once marked, it stays marked — this is what makes the cue once-per-device.
    O.showHint({ key: K, sel: "#nope", text: "x", storage: s });
    ok(O.hintSeen(K, s) === false, "still unspent after a second failed attempt");
    s.setItem(K, "1");
    ok(O.hintSeen(K, s) === true, "a set flag reads as seen");
    O.resetHint(K, s);
    ok(O.hintSeen(K, s) === false, "resetHint re-arms it (for QA / a re-announce)");
  }

  // Two cues must not share a flag — each `key` is independent, so shipping a second
  // bridge cue later can't be silently suppressed by the first one having fired.
  {
    const s = fakeStorage();
    s.setItem("aotd.cue.one.v1", "1");
    ok(O.hintSeen("aotd.cue.one.v1", s) === true, "cue one: seen");
    ok(O.hintSeen("aotd.cue.two.v1", s) === false, "cue two: independent, still unseen");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
