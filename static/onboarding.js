"use strict";
/*
 * onboarding.js — the pull-only "What is this?" welcome screen.
 *
 * One screen: what Music Forest is, what it deliberately isn't (no recommender,
 * no profiling, no feed), the end-to-end-encrypted note-gathering notebook, and
 * "no account needed yet."
 *
 * U18 (2026-07-02) made this non-auto-opening — the records are the welcome — but
 * U25 (2026-07-12) brought the FIRST-run open back: a real first-timer couldn't tell
 * what the app was, so app.js's maybeWelcomeFirstRun() calls maybeShowFirstRun() once
 * per device on a clean first visit. It's still ALSO a pull-only door behind the
 * guest header's visible "What is this?" button and the ☰ menu's copy of it
 * (show({ first: false })). The once-per-device seen/markSeen flag core is pure +
 * injectable-storage + headlessly tested in tests/js/onboarding.test.mjs.
 *
 * Copy lives here, in one keyed catalog (cross-cutting R8), rather than scattered
 * through auth-ui / app. Only show() touches the DOM.
 *
 * UMD: exports for node tests AND sets window.AOTDOnboarding in the browser.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  if (root) root.AOTDOnboarding = mod;
})(typeof self !== "undefined" ? self : this, function () {
  const KEY = "aotd.welcome.seen.v1";
  // The first-run guided tour (a short ordered sequence of gentle cues), shown
  // once per device — independent of the welcome flag above.
  const TOUR_KEY = "aotd.tour.v1";

  // The whole welcome, in one place — the "What is this?" door's copy.
  // Workshopped with the owner (U18, 2026-07-03): lead with the ritual, skip
  // the mechanics (the day's records are visible right behind this screen),
  // say the E2EE part plainly, end with the no-pressure release valve.
  const copy = {
    brand: "Music Forest",
    // Owner, 2026-08-07: this is the hero of the opener now, and the canonical
    // tagline ("Find music, write notes.") comes off it — *"I know this changes the
    // branding because now this appears nowhere. That is okay."* It matches the line
    // already under the wordmark on Today, so the first thing someone reads is the
    // same promise the app then keeps. BRAND.md §"The tagline & essence" is updated
    // to match: the tagline is now outward-facing ONLY (share/OG meta, the invite
    // email, the architecture guide) and appears nowhere in the app UI. NOTE this
    // title is shared with the ☰ About door, which is intended — "appears nowhere".
    title: "Released on this day in history",
    // Owner-set copy (2026-07-15): what it is (records from this date, randomly one at
    // a time), the act folded together with the E2EE notebook, the listen-honesty note,
    // and the guest valve. Four paras (was five). House-style em dashes; author's words
    // otherwise.
    paras: [
      "Records released on this date, any year, randomly presented one at a time.",
      "Keep the ones that resonate, and write notes in an end-to-end encrypted notebook.",
      "Listen where you already do — Music Forest just points the way.",
      "No account needed to find new music — sign up to save your keeps and notes.",
    ],
    // FB#105 (owner, 2026-08-07): the FIRST-RUN card asks where you listen, instead of
    // explaining the app at a newcomer. "it gets immediately to the point of how
    // someone will use it and offers engagement right away. keep it simple for them
    // and obvious of what is about to happen."
    //
    // The body: the four explanatory paragraphs below belong to the "What is this?"
    // door in ☰ (show({first:false})), which is where someone who wants the
    // explanation goes.
    //
    // ONE line carries the question now — the owner cut "Each record's Listen link
    // opens where you already are." (2026-08-07) as the opener got shorter. The hint
    // below STAYS: it is the only place the card says that choosing narrows what
    // surfaces, and how to not choose. Picking services limits the day to records we
    // can CONFIRM on them, and an unchecked record is unknown, never unavailable
    // (BRAND.md's honesty rule) — so "choose none" has to stay a visible, one-tap
    // path or the card would quietly make everyone's app smaller on day one. Its
    // wording is lifted from the chooser's own hint so the two never disagree.
    pickerLead: "Select your listening platform(s).",
    // Verbatim from .listen-pref-hint in index.html — same promise, same words.
    pickerHint: "Only albums you can play there will surface — choose none to see everything.",
    pickerMenuNote: "You can change this any time in the menu (☰).",
    startFirst: "Start",
    startAgain: "Back to the records",
    // A quiet, pull-only "how it works" door — opens the architecture guide
    // (/architecture, incl. the private notebook + E2EE) in a new tab, so your
    // place on the records is kept. (The old "What's an album you remember?"
    // taste-door was removed here 2026-07-13 — owner's call; the Remember door
    // still lives in the app itself.)
    //
    // OFF THE FIRST-RUN CARD (owner, 2026-08-07). It survives only on this card's
    // `show({first:false})` mode — which NOTHING CURRENTLY CALLS: FB#97 re-pointed
    // the ☰ "About" item at `#dataModal` (app.js `openAboutDoor`), a different
    // modal, and the explain mode was left stranded. So in practice `/architecture`
    // is now linked from nowhere in the app; the route and its SW handling remain.
    // Kept behind the toggle rather than deleted so it returns if that door is ever
    // rewired. If the guide should stay reachable, the honest home is a link inside
    // `#dataModal` in index.html — raised with the owner rather than added here,
    // since the ask was to remove it, not to move it.
    howItWorks: "How Music Forest works ↗",
    closeTitle: "Close",
    // The first-run guided tour — a short sequence of gentle cues, in order, each
    // pointing at one control. keep/skip vocab + "private to you" (BRAND); one plain line each,
    // no pressure; skippable at any step.
    tour: [
      // Platforms: adaptive target. Signed in, the "Where you listen" control is
      // adopted into the ☰ menu (auth-ui.js), so point at the menu button; a guest /
      // local build keeps it in the header, so point at it there. resolve() runs each
      // render, reading where #listenPref currently lives.
      { place: "below", resolve: function () {
          var pref = document.getElementById("listenPref");
          if (pref && pref.closest(".acct-pop")) {
            return { sel: ".acct-btn", text: copy.tourPlatformsMenu };
          }
          return { sel: "#listenPref", text: copy.tourPlatformsHeader };
        } },
      // The two narrowing controls beside platforms (owner 2026-07-26) — grouped here so
      // the three header filters are learned together, before the deck steps.
      { sel: "#genrePref",
        text: "Tap “Genre” to narrow today to the sounds you're after — jazz, electronic, blues — or type any style. Each shows how many of today's records match." },
      { sel: "#datePref",
        text: "“Year” narrows today to a decade, a span of years you type in, or the records released on one specific calendar day." },
      // The album door, and the two things people miss inside it (owner, from a live
      // run-through 2026-07-16): that a note can hang off ONE track, and how to get
      // back out. Both belong in this step rather than steps of their own — the tour
      // hides itself while a modal owns the screen (see the yield in the render
      // below), so it can never cue anything *inside* Album details.
      // The ✎ is nameable on both: it's opacity:0-until-hover on a pointer device,
      // but style.css keeps it at .6 under `@media (hover: none)`, so on the phone
      // it's simply there. ✕ leads because Escape is a desktop-only comfort.
      // "a single song" / "its track", never "any": the pencil is gated on
      // `notable = !!t.pos` (app.js), so a position-less row — a heading, a gap in
      // the data — has none. Rare, but "any" would promise what the tracklist
      // doesn't always keep. Naming the SCOPE (one song) isn't prescribing the
      // content — the app never says what to write (VISION P2 / BRAND).
      // Leads with the act, not the icon: the earlier line read "The ✎ … writes a
      // note", which made the pencil the actor when the person is (BRAND: active,
      // from the user's side). The question shape mirrors the Skip step.
      // Owner's ask + pick, 2026-07-16.
      { sel: ".deck-cover",
        text: "Tap the album to open its details — the story behind it, the tracklist, and the people on it. Want to write about a single song? Tap the ✎ beside its track. ✕ (or Esc) brings you back, right where you left off." },
      { sel: "#deckListen",
        text: "Tap Listen to play the record where you already listen — it opens in a new tab, so you never lose your place here." },
      { sel: "#setAsideBtn",
        text: "Want to see a different one? Skip the current one — it goes to a list you can reopen any time. Nothing's lost." },
      // The delete gesture rides HERE, on Keep, rather than on the Notebook step:
      // "keep" is the word that sounds permanent, so the reassurance belongs in the
      // same breath as the commitment. (Neither step has Notebook rows on screen —
      // the tour runs on Today — so nothing is gained by waiting.) Owner's ask + pick.
      // Right-click leads because this cue is read on both, and it's the gesture a
      // desktop reaches for; press-and-hold is the touch half. Both are real as of
      // 2026-07-16 — right-click did NOTHING until wireTrailLongPress gained a
      // contextmenu handler in the same change. If that is ever removed, this
      // sentence becomes a lie: keep them together.
      { sel: "#keepBtn",
        text: "Keep the ones that stay with you — they go to your Notebook. Right-click (or press and hold) anything there to delete it." },
      { sel: '.tab[data-mode="journal"]',
        text: "Your kept records and everything you write live here, in your Notebook — private to you." },
      // Owner's words, 2026-07-16 (the long version was doing the talking for him).
      // SIGNED WITH A PLAIN HYPHEN, on his instruction 2026-08-08 — reversing the
      // call made here on 2026-07-16, which "corrected" the "-Clancy" he originally
      // typed into an em dash for house punctuation. He wants it as he types it, on
      // both sign-offs (the other is `.about-signoff` in index.html). Don't tidy it
      // back: the punctuation is his, not the style guide's.
      // FB#105: ✎ Feedback moved off the screen into the ☰ menu, so this step follows
      // it. It has to resolve the same way the platforms step does rather than just
      // naming ".acct-btn": a local single-user build mounts no menu at all and keeps
      // the floating chip, and pointing at an element that isn't there would make
      // _hasStep SKIP this step in silence — the tour would simply end one card early
      // and nobody would know the sign-off had gone missing.
      { resolve: function () {
          var btn = document.getElementById("feedbackBtn");
          if (btn && btn.closest(".acct-pop")) {
            return { sel: ".acct-btn", place: "below",
                     text: copy.tourFeedbackMenu };
          }
          return { sel: "#feedbackBtn", text: copy.tourFeedbackChip };
        } },
    ],
    tourNext: "Next",
    tourDone: "Got it",
    tourSkip: "Skip the tour",
    // FB#93: ✕ dismisses the one card now, so its label has to say so — "Skip the
    // tour" moved onto its own button in the foot.
    tourDismissCard: "Dismiss this tip",
    tourStep: function (i, n) { return i + " / " + n; },
    // FB#99 (owner): "what if instead of mandatory instructional cards, it asked if
    // you want a tutorial? if you say yes, it goes through the tutorial. if you say
    // no, it goes to the pancake menu with some kind of obvious reminder of how to
    // access it." The offer is one line and two buttons — a question, not a card
    // sequence that has already started.
    tourOfferText: "Want a quick tour? A few short tips, one at a time.",
    // FB#105: the same question for someone who was already here — but it says what
    // changed BEFORE it asks, so declining still leaves you knowing where things went.
    // Names the two moves a returning reader would otherwise hunt for: the tabs (now a
    // bar at the bottom) and everything that used to float on the screen (now in ☰).
    // CURRENTLY UNUSED (owner, 2026-08-11): the nav-moved offer now uses the bare
    // swapOfferText, matching FB#109 — kept here for a one-line restore if the base grows.
    changeOfferText: "The tabs have moved to the bottom of the screen, and "
      + "“Where you listen” and Feedback are in the menu (☰) now. Want a quick tour "
      + "of what's where?",
    // FB#109 shipped as a BARE tour offer — owner's call, 2026-08-07: "No one is
    // really using this app so let's just say 'Would you like a tour?'"
    //
    // This is a deliberate, reasoned exception to the disclosure-first rule in
    // BRAND.md, not a drafting slip: that rule exists to protect people who already
    // learned the old arrangement, and at this point in the beta that population is
    // small enough that the owner judged the wording not worth its weight. Recorded
    // in BRAND.md's cue table so a later reader doesn't "fix" it back.
    //
    // What that COSTS, so it is not rediscovered by surprise: the Keep/Skip swap
    // (v280) is now announced nowhere except the What's-new panel, which is pull-only.
    // The earlier draft named both sides and both exits precisely because the tour
    // itself never says the sides changed — its Keep and Skip steps introduce each
    // button as if you were meeting it for the first time. That is still true, so
    // someone who accepts this offer learns the new arrangement only incidentally,
    // and someone who declines learns nothing about it at all.
    //
    // If the user base grows before this flag is widely burned, restoring the fuller
    // wording is a one-line change here — the gate, the flag and the placement all
    // already do the right thing.
    swapOfferText: "Would you like a tour of how to use Music Forest?",
    // Plain "Yes"/"No" (owner, 2026-08-08). Shared by BOTH offers — the first-run
    // one and the FB#109 bridge — which is right: they ask the same question.
    tourOfferYes: "Yes",
    tourOfferNo: "No",
    tourOfferLabel: "Take a quick tour?",
    // Shown once, where the tour lives, when someone declines — so "no" isn't the
    // end of it. Anchored to ☰, which is the answer to "where did it go".
    tourDeclinedText: "No problem. It's here under “Take the tour” whenever you want it.",
    // Platforms step copy — one for the header chooser (guest), one for the ☰ menu
    // (signed in), picked by the step's resolve() above.
    tourPlatformsHeader: "Set the services you use — then each record's Listen link opens right where you already listen.",
    tourPlatformsMenu: "Open the menu (☰) to choose the services you use — then each record's Listen link opens right where you already listen.",
    // Owner's words, 2026-07-16, kept verbatim — the long version was doing the
    // talking for him. Two homes since FB#105 (the ☰ menu, or the floating chip on a
    // build with no menu), so the sign-off is split from the "where" sentence rather
    // than duplicated: whichever line runs, his words end it.
    tourFeedbackChip: "Send me your thoughts. I read everything.\n\n- Clancy",
    tourFeedbackMenu: "Send me your thoughts — it's in the menu (☰), under Feedback. I read everything.\n\n- Clancy",
  };

  // A Storage-shaped in-memory fallback so the flag never throws when real
  // storage is missing or blocked (private mode, quota, disabled cookies).
  function memStore() {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => { m.set(k, String(v)); },
      removeItem: (k) => { m.delete(k); },
    };
  }
  function pickStorage(storage) {
    if (storage) return storage;
    try {
      if (typeof localStorage !== "undefined" && localStorage) return localStorage;
    } catch (e) { /* access can throw in some sandboxes */ }
    return memStore();
  }

  // --- once-per-device flags (pure core, headlessly testable) ----------------
  // Generic get/set/clear over an injectable storage, keyed — the welcome flag
  // and the Today hint flag are two independent instances of the same shape.
  function flagGet(storage, key) {
    const s = pickStorage(storage);
    try { return s.getItem(key) === "1"; } catch (e) { return false; }
  }
  function flagSet(storage, key) {
    const s = pickStorage(storage);
    try { s.setItem(key, "1"); } catch (e) { /* best-effort */ }
  }
  function flagClear(storage, key) {
    const s = pickStorage(storage);
    try { s.removeItem(key); } catch (e) { /* best-effort */ }
  }

  // The welcome ("What is this?") first-run flag.
  function seen(storage) { return flagGet(storage, KEY); }
  function markSeen(storage) { flagSet(storage, KEY); }
  function reset(storage) { flagClear(storage, KEY); }
  // The decision the first-run caller makes: show only when never seen.
  function shouldShowFirstRun(storage) { return !seen(storage); }

  // The first-run guided-tour flag (independent of the welcome above).
  function tourSeen(storage) { return flagGet(storage, TOUR_KEY); }
  function markTourSeen(storage) { flagSet(storage, TOUR_KEY); }
  function resetTour(storage) { flagClear(storage, TOUR_KEY); }
  function shouldShowTour(storage) { return !tourSeen(storage); }

  // --- the screen (DOM; not headlessly tested) -------------------------------
  let _el = null;
  let _lastFocus = null;

  function buildEl() {
    const wrap = document.createElement("div");
    wrap.id = "onboardModal";
    wrap.className = "modal onboard-modal hidden";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.setAttribute("aria-label", "Welcome to Music Forest");
    const parasHtml = copy.paras.map((p) => `<p>${p}</p>`).join("");
    wrap.innerHTML =
      '<div class="onboard-card">' +
        '<button type="button" class="modal-close onboard-close" title="' +
          copy.closeTitle + '">✕</button>' +
        '<div class="onboard-brand">' + copy.brand + '</div>' +
        '<h2 class="onboard-title">' + copy.title + '</h2>' +
        // Both bodies are built once and swapped by show(): the picker on a first
        // run, the explanation behind the ☰ "What is this?" door. Building both up
        // front keeps show() to a class toggle and means the picker's chips are
        // wired exactly once.
        '<div class="onboard-body onboard-explain">' + parasHtml + '</div>' +
        '<div class="onboard-body onboard-picker hidden">' +
          '<p class="onboard-picker-lead"></p>' +
          '<div class="onboard-plats" role="group"></div>' +
          '<p class="onboard-picker-hint"></p>' +
          '<p class="onboard-picker-note"></p>' +
        '</div>' +
        '<button type="button" class="onboard-start"></button>' +
        '<a class="onboard-howitworks" href="/architecture" target="_blank" ' +
          'rel="noopener">' + copy.howItWorks + '</a>' +
      '</div>';
    wrap.querySelector(".onboard-picker-lead").textContent = copy.pickerLead;
    wrap.querySelector(".onboard-picker-hint").textContent = copy.pickerHint;
    wrap.querySelector(".onboard-picker-note").textContent = copy.pickerMenuNote;
    document.body.appendChild(wrap);
    // Backdrop click and ✕ both dismiss (a door, never a trap).
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap) close();
    });
    wrap.querySelector(".onboard-close").addEventListener("click", close);
    return wrap;
  }

  let _onStart = null;
  function close() {
    if (!_el) return;
    _el.classList.add("hidden");
    document.removeEventListener("keydown", onKey);
    const cb = _onStart; _onStart = null;
    try { if (_lastFocus && _lastFocus.focus) _lastFocus.focus({ preventScroll: true }); }
    catch (e) {}
    if (typeof cb === "function") { try { cb(); } catch (e) {} }
  }
  function onKey(e) { if (e.key === "Escape") close(); }

  // show({ first, onStart }): render and reveal the welcome.
  //  - first: true   the first-run screen — marks the device as having seen it
  //                  (so it shows once), button reads "Start".
  //  - first: false  the "What is this?" door — never touches the flag, button
  //                  reads "Back to the records".
  // onStart fires after the screen is dismissed (any path), e.g. to focus Today.
  // Draw the platform chips from app.js's AOTDPlatforms (never our own list), and
  // re-draw on each toggle so the on/off state is read back from the real preference
  // rather than tracked here. If the app hasn't exposed the API — a stripped page, a
  // load-order surprise — the picker simply stays empty and the card is still a
  // dismissible welcome, rather than throwing on first run.
  function _renderPlats(box) {
    const P = (typeof window !== "undefined") && window.AOTDPlatforms;
    if (!P || !box) return;
    const on = P.selected();
    box.innerHTML = "";
    P.list().forEach(function (p) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "onboard-plat" + (on.indexOf(p.key) >= 0 ? " on" : "");
      b.textContent = p.label;
      b.setAttribute("aria-pressed", on.indexOf(p.key) >= 0 ? "true" : "false");
      b.addEventListener("click", function () {
        P.toggle(p.key);
        _renderPlats(box);              // re-read, so the chips can't drift from truth
      });
      box.appendChild(b);
    });
  }

  function show(opts) {
    opts = opts || {};
    const first = !!opts.first;
    if (first) markSeen();              // once per device, set on show (reload-safe)
    if (!_el) _el = buildEl();
    // First run asks the question; the ☰ door explains the app (FB#105).
    const picker = _el.querySelector(".onboard-picker");
    const explain = _el.querySelector(".onboard-explain");
    if (picker && explain) {
      picker.classList.toggle("hidden", !first);
      explain.classList.toggle("hidden", first);
      if (first) _renderPlats(picker.querySelector(".onboard-plats"));
    }
    // Off the opener (owner, 2026-08-07), kept on the explain mode. NOTE that mode
    // has no caller today — see the note on copy.howItWorks — so this is a latent
    // door, not a live one.
    const how = _el.querySelector(".onboard-howitworks");
    if (how) how.classList.toggle("hidden", first);
    const startBtn = _el.querySelector(".onboard-start");
    startBtn.textContent = first ? copy.startFirst : copy.startAgain;
    // Re-bind the primary button fresh each show (label/handler can differ).
    startBtn.onclick = close;
    _onStart = typeof opts.onStart === "function" ? opts.onStart : null;
    _lastFocus = (typeof document !== "undefined") ? document.activeElement : null;
    _el.classList.remove("hidden");
    document.addEventListener("keydown", onKey);
    try { startBtn.focus({ preventScroll: true }); } catch (e) {}
    return _el;
  }

  // Convenience for the first-run caller: show only if never seen. Returns
  // whether it showed.
  function maybeShowFirstRun(opts) {
    if (!shouldShowFirstRun()) return false;
    show(Object.assign({}, opts, { first: true }));
    return true;
  }

  // --- the first-run guided tour (a gentle, non-modal, skippable sequence) ----
  // A short ordered walk — platforms → album → skip → keep → Notebook → Feedback — one soft cue
  // at a time, each floated by its target with a pointer and a highlight. Non-modal
  // (no backdrop): the records stay reachable, and ✕ / Esc / "Skip the tour" leave
  // at any step (VISION: pull, not push; a cue, never a corridor). Shown once per
  // device; marked seen on start so a reload never restarts it. A step whose target
  // is missing is skipped, so it degrades gracefully.
  let _tourEl = null, _tourIdx = 0, _tourTarget = null, _tourReflow = null;
  let _tourForceBelow = false;   // a step can pin its cue below the target (place:"below")
  let _tourObserver = null;      // watches for a modal opening, to yield the cue to it
  // FB#93: the tour is PAUSED, not over — ✕ dismissed a card and we're waiting for a
  // screen where the next step's target is actually present. _tourWait is the poll
  // that watches for it; it stops itself once a step renders (or the tour ends).
  let _tourPaused = false, _tourWait = null;

  function _tourKey(e) {
    if (e.key !== "Escape") return;
    // FB#93: while paused there's no cue on screen, so Escape isn't aimed at us.
    if (_tourPaused) return;
    // A door (album details, feedback, the skipped pile) owns Escape — let it close itself
    // and keep the tour on its current step (the cue is hidden behind the door and
    // returns when it closes). We listen in the CAPTURE phase so we see the modal
    // here BEFORE app.js's handler closes it; only end the tour when Escape has no
    // door to dismiss. (Without this, Escaping the album door you opened in the
    // "tap the album" step also disturbed the tour — it looked like it reset.)
    if (document.querySelector('.modal:not(.hidden), [aria-modal="true"]:not(.hidden)')) return;
    endTour();
  }
  function _clearTarget() {
    if (_tourTarget) { _tourTarget.classList.remove("mf-tour-target"); _tourTarget = null; }
  }
  function endTour() {
    if (_tourEl && _tourEl.parentNode) _tourEl.parentNode.removeChild(_tourEl);
    _tourEl = null;
    _clearTarget();
    _tourPaused = false;
    if (_tourWait) { clearInterval(_tourWait); _tourWait = null; }
    try {
      document.removeEventListener("keydown", _tourKey, true);
      if (_tourReflow) {
        window.removeEventListener("resize", _tourReflow);
        window.removeEventListener("scroll", _tourReflow, true);
        document.removeEventListener("toggle", _tourReflow, true);
      }
      if (_tourObserver) { _tourObserver.disconnect(); _tourObserver = null; }
    } catch (e) {}
    _tourReflow = null;
  }

  // FB#93: ✕ on a card. Take THIS card off the screen and stand down — then bring the
  // next one back on its own, once its target is on screen and nothing else is. The
  // tour's listeners and element stay alive throughout; only the bubble is hidden, so
  // resuming is a re-render, not a restart. When there is no next step with a live
  // target, the tour is simply over (nothing left to say).
  function dismissCard() {
    if (!_tourEl) return;
    _tourPaused = true;
    _tourEl.style.display = "none";
    _clearTarget();
    // Nothing further to show? Then this was the last thing the tour had to say.
    let next = _tourIdx + 1;
    if (next >= copy.tour.length) { endTour(); return; }
    if (_tourWait) clearInterval(_tourWait);
    // Bounded: if no later step's screen is reached within ~10 minutes, stop watching
    // rather than polling for the life of the tab. The tour is a first-run courtesy,
    // not something to hold open indefinitely.
    let ticks = 0;
    _tourWait = setInterval(function () {
      if (!_tourEl || !_tourPaused || ++ticks > 860) { endTour(); return; }
      // Never interrupt an open door — the reader is doing something.
      if (document.querySelector('.modal:not(.hidden), [aria-modal="true"]:not(.hidden)')) return;
      // Walk forward to the first remaining step whose target is genuinely on screen.
      let i = _tourIdx + 1;
      while (i < copy.tour.length && !_hasStep(i)) i++;
      if (i >= copy.tour.length) return;      // keep waiting: a later screen may have it
      clearInterval(_tourWait); _tourWait = null;
      _tourPaused = false;
      _tourEl.style.display = "";
      _renderStep(i);
    }, 700);
  }

  // Float the popover just past its target — below if the target sits in the top
  // half of the viewport, else above — clamped on-screen, arrow pointing at it.
  function _placeTour() {
    if (!_tourEl || !_tourTarget) return;
    // The target can be swapped out from under us when the view re-renders mid-tour:
    // tapping Skip/Keep advances the deck and rebuilds its buttons, so the cached
    // #setAsideBtn / #keepBtn detaches. A detached node reports a 0,0 rect, which would
    // park the cue at the very top of the screen. Re-resolve the current step's live
    // element and move the highlight with it (a later reflow catches it if it's briefly
    // absent during the re-render).
    if (!document.contains(_tourTarget)) {
      const s = _stepOf(_tourIdx);
      const live = s && s.sel ? document.querySelector(s.sel) : null;
      if (!live) return;
      _tourTarget.classList.remove("mf-tour-target");
      _tourTarget = live;
      _tourTarget.classList.add("mf-tour-target");
    }
    // Yield while another door owns the screen (album details, feedback, the skipped
    // pile): hide the cue so it never floats over a modal, then resume on close. The
    // cue itself is `.mf-hint` with role=dialog but NO aria-modal, so it's excluded.
    if (document.querySelector('.modal:not(.hidden), [aria-modal="true"]:not(.hidden)')) {
      _tourEl.style.visibility = "hidden";
      return;
    }
    _tourEl.style.visibility = "";
    let r = _tourTarget.getBoundingClientRect();
    // A menu/popover that opens BELOW the target is a floating overlay that doesn't
    // grow the target's own box, so a "below" cue lands right on top of it. Find the
    // open panel and extend the anchor's bottom past it so the cue clears the menu
    // instead of covering the very chooser it points at. Two shapes: a guest's
    // <details> platforms dropdown (its non-summary child), and the signed-in ☰
    // account menu (a sibling .acct-pop next to the .acct-btn the step targets).
    if (_tourForceBelow) {
      let panel = null;
      if (_tourTarget.tagName === "DETAILS" && _tourTarget.open) {
        for (const c of _tourTarget.children) { if (c.tagName !== "SUMMARY") { panel = c; break; } }
      } else if (_tourTarget.parentElement) {
        panel = _tourTarget.parentElement.querySelector(".acct-pop:not(.hidden)");
      }
      const pr = panel && panel.getBoundingClientRect();
      if (pr && pr.height > 0) {
        r = { left: r.left, right: r.right, width: r.width, top: r.top,
              bottom: Math.max(r.bottom, pr.bottom), height: r.height };
      }
    }
    const vw = window.innerWidth, vh = window.innerHeight;
    const pw = _tourEl.offsetWidth, ph = _tourEl.offsetHeight;
    // A "below"-pinned step (e.g. platforms) keeps the cue under its target even as
    // the target grows downward (the dropdown opening), so it never covers the list.
    const below = _tourForceBelow || (r.top + r.height / 2) < vh * 0.5;
    let left = r.left + r.width / 2 - pw / 2;
    left = Math.max(10, Math.min(left, vw - pw - 10));
    let top = below ? r.bottom + 12 : r.top - ph - 12;
    top = Math.max(10, Math.min(top, vh - ph - 10));
    _tourEl.style.left = left + "px";
    _tourEl.style.top = top + "px";
    _tourEl.setAttribute("data-arrow", below ? "up" : "down");
    const arrow = _tourEl.querySelector(".mf-hint-arrow");
    if (arrow) arrow.style.left =
      Math.max(16, Math.min((r.left + r.width / 2) - left, pw - 16)) + "px";
  }

  // Resolve a step to its concrete { sel, text, place } — a step may carry a
  // resolve() that picks its target by current layout (e.g. platforms: header vs ☰).
  function _stepOf(i) {
    const s = copy.tour[i];
    if (s && typeof s.resolve === "function") {
      const r = s.resolve() || {};
      return { sel: r.sel, text: r.text, place: r.place !== undefined ? r.place : s.place };
    }
    return s;
  }
  function _hasStep(i) {
    if (i >= copy.tour.length) return false;
    const s = _stepOf(i);
    if (!s || !s.sel) return false;
    const el = document.querySelector(s.sel);
    if (!el) return false;
    // Genuinely visible — skip a target hidden in a closed menu / display:none / etc.
    // (the guest-hidden FAB and the collapsed ☰ popover both use display:none, which
    // checkVisibility catches by default). NOT opacityProperty: the album identity
    // (.deck-open) fades in via the `pop` animation (opacity 0→1), and a target caught
    // mid-fade must not read as "missing" — that silently skipped the album step, so
    // the cue jumped 1 → 3.
    if (typeof el.checkVisibility === "function"
        && !el.checkVisibility({ visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }
  // When advancing off the platforms step, close the chooser it opened — the guest
  // "Where you listen" <details> or the signed-in ☰ menu. Left open it lingers over
  // the next record and, worse, hides the album so the "tap the album" step gets
  // skipped (_hasStep sees .deck-cover as not visible under the overlay). No-op when
  // nothing is open, so it's safe to call on every advance.
  function _closeTourOverlays() {
    const pref = document.getElementById("listenPref");
    if (pref && pref.tagName === "DETAILS" && pref.open) pref.open = false;
    const pop = document.querySelector(".acct-pop:not(.hidden)");
    if (pop) {
      const btn = pop.parentElement && pop.parentElement.querySelector(".acct-btn");
      if (btn) btn.click();               // toggle the menu shut via the app's handler
      else pop.classList.add("hidden");
    }
  }
  function _renderStep(i) {
    while (i < copy.tour.length && !_hasStep(i)) i++;   // skip a missing target
    if (i >= copy.tour.length) { endTour(); return; }
    _tourIdx = i;
    _clearTarget();
    const step = _stepOf(i);
    _tourForceBelow = step.place === "below";
    _tourTarget = document.querySelector(step.sel);
    _tourTarget.classList.add("mf-tour-target");
    let last = true;                                    // last present step?
    for (let j = i + 1; j < copy.tour.length; j++) { if (_hasStep(j)) { last = false; break; } }
    _tourEl.querySelector(".mf-tour-text").textContent = step.text;
    _tourEl.querySelector(".mf-tour-count").textContent =
      copy.tourStep(i + 1, copy.tour.length);
    const nextBtn = _tourEl.querySelector(".mf-tour-next");
    nextBtn.textContent = last ? copy.tourDone : copy.tourNext;
    nextBtn.onclick = last ? endTour
      : function () { _closeTourOverlays(); _renderStep(_tourIdx + 1); };
    // Don't scroll a fixed element (the Feedback FAB is always in view anyway).
    try {
      if (getComputedStyle(_tourTarget).position !== "fixed") {
        _tourTarget.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    } catch (e) {}
    // place after layout settles (two frames covers the smooth-scroll start)
    requestAnimationFrame(function () { requestAnimationFrame(_placeTour); });
  }

  // startTour(): build the popover and walk from step 0. Marks the device seen.
  function startTour() {
    if (_tourEl) endTour();
    markTourSeen();
    const el = document.createElement("div");
    el.className = "mf-hint mf-tour";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "A quick tour of Music Forest");
    el.innerHTML =
      '<button type="button" class="mf-hint-close" aria-label="' + copy.tourDismissCard + '">✕</button>' +
      '<p class="mf-tour-text"></p>' +
      '<div class="mf-tour-foot">' +
        '<span class="mf-tour-count"></span>' +
        '<button type="button" class="mf-tour-skip">' + copy.tourSkip + '</button>' +
        '<button type="button" class="mf-tour-next"></button>' +
      '</div>' +
      '<span class="mf-hint-arrow" aria-hidden="true"></span>';
    document.body.appendChild(el);
    // FB#93 (owner, watching a friend use it): ✕ used to end the WHOLE tour. A guest
    // hit ✕ to get one card out of the way of the genre filter, and never saw the
    // instructions for the album page or Skip — "it makes me question the behavior of
    // the x button on the instruction cards. I don't think it should terminate the
    // tutorial completely, rather, it should just kill that instruction card and wait
    // until the user is on the screen where the next one would make sense."
    // So: ✕ dismisses the card and pauses; "Skip the tour" is the explicit exit.
    el.querySelector(".mf-hint-close").addEventListener("click", dismissCard);
    el.querySelector(".mf-tour-skip").addEventListener("click", endTour);
    _tourEl = el;
    _tourReflow = function () { requestAnimationFrame(_placeTour); };
    document.addEventListener("keydown", _tourKey, true);   // capture: see a modal before app.js closes it
    window.addEventListener("resize", _tourReflow);
    window.addEventListener("scroll", _tourReflow, true);
    // A <details> `toggle` doesn't bubble, so listen in the CAPTURE phase — opening
    // the platforms dropdown then re-floats the cue below the now-taller control.
    document.addEventListener("toggle", _tourReflow, true);
    // A modal opening/closing toggles its `hidden` class — watch for that so the cue
    // hides behind an opened door (album details, tapped from step 2) and returns after.
    _tourObserver = new MutationObserver(_tourReflow);
    _tourObserver.observe(document.body, { attributes: true, subtree: true, attributeFilter: ["class"] });
    _renderStep(0);
    return el;
  }

  // Start the tour only if never seen. Returns whether it started. The caller
  // ensures no modal owns the screen.
  function maybeStartTour() {
    if (!shouldShowTour()) return false;
    startTour();
    return true;
  }

  // --- FB#99: ask before touring ---------------------------------------------
  // The tour used to begin on its own — the first thing a first-timer met was a card
  // they hadn't asked for, over a screen they hadn't read yet. Now it asks. The offer
  // uses the same anchored-bubble component (so it can't be mistaken for a dialog to
  // be dealt with), sits on the deck, and burns the once-per-device flag on SHOW —
  // whichever way it's answered, and even if it's ignored, nobody is asked twice.
  //
  // "No" is not the end of the tour: the ☰ menu carries "Take the tour", and
  // declining points at it once.
  let _offerEl = null;
  // A selector this offer must sit CLEAR of, or null for the default foot placement.
  // Per-offer on purpose — see _placeOffer.
  let _offerClear = null;
  // The resize handler, kept by reference so it can be removed. It re-places on the
  // NEXT FRAME rather than inline, which is the same shape as showHint's
  // `_hintReflow` — and for the same reason: an offer that measures ANOTHER element
  // (see `_offerClear` below) wants that element's post-reflow box, and a handler
  // running during the resize event can read the box the page is about to leave.
  // The foot placement never needed this because it only reads the dock's height
  // and the live viewport, neither of which is mid-reflow.
  //
  // NOT verified on a live rotate: the pane is hidden in the harness this was built
  // in, where rAF is halted and a CDP viewport change fires no `resize` at all, so
  // the whole path is unobservable there. Load-time placement IS verified at two
  // heights. If a rotation ever leaves this bubble in the wrong place, start here.
  let _offerReflow = null;

  function closeTourOffer() {
    if (_offerEl && _offerEl.parentNode) _offerEl.parentNode.removeChild(_offerEl);
    _offerEl = null;
    _offerClear = null;
    try {
      if (_offerReflow) window.removeEventListener("resize", _offerReflow);
    } catch (e) {}
    _offerReflow = null;
  }
  function _placeOffer() {
    if (!_offerEl) return;
    // Centred at the foot of the screen: it points at nothing in particular (it's
    // about the tour, not a control), and sitting this low keeps it off Keep/Skip —
    // a bubble over the only actions on the page turns a question into an obstacle.
    //
    // The clearance was a flat 56px, sized for the Feedback chip that used to sit in
    // the corner. FB#105 put a tab dock down there instead and the bubble landed 4px
    // over it. MEASURE the bar rather than replacing one guess with another: its
    // height already carries the device's home-indicator inset (--bar-h), so this
    // stays right on a notched phone, and it falls back to the old number if the bar
    // isn't in the document (a local build mid-boot).
    const bar = document.querySelector(".tabs-row");
    const clearance = (bar ? bar.offsetHeight : 56) + 12;
    const vw = window.innerWidth, vh = window.innerHeight;
    const h = _offerEl.offsetHeight;
    _offerEl.style.left = Math.max(10, (vw - _offerEl.offsetWidth) / 2) + "px";
    const foot = Math.max(10, vh - h - clearance);

    // An offer ABOUT a control has to leave that control visible (owner, 2026-08-07,
    // on the FB#109 swap offer). The foot placement above is right for an offer about
    // the tour in general, and the owner has explicitly blessed it sitting over
    // Keep/Skip for the FB#105 nav offer — so this is opt-in per offer, never global.
    //
    // Reading "Skip is on the right now" while the pair is hidden behind the bubble
    // defeats the sentence: the whole point is which side each one is on.
    if (_offerClear) {
      const el = document.querySelector(_offerClear);
      // offsetParent is null for a display:none subtree — don't measure a hidden row.
      if (el && el.offsetParent !== null) {
        const top = el.getBoundingClientRect().top - h - 12;
        // Only if it genuinely fits above. On a short screen the bubble would clamp
        // to the top and cover the record entirely, which is worse than the overlap
        // it was avoiding — so fall back to the foot rather than force it.
        if (top >= 10) { _offerEl.style.top = top + "px"; return; }
      }
    }
    _offerEl.style.top = foot + "px";
  }

  // Build and float one offer bubble. Shared by the first-run offer below and the
  // FB#105 "things moved" offer, so the two are the same object on screen and only
  // their wording, their flag and their "no" differ.
  function _buildOffer(text, onNo, clearSel) {
    _offerClear = clearSel || null;
    const el = document.createElement("div");
    el.className = "mf-hint mf-tour mf-tour-offer";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", copy.tourOfferLabel);
    // ✕ in the corner as well as the "No" button (owner, 2026-08-08). The earlier note
    // here said the offer needed no ✕ because "its two buttons ARE the answer" —
    // true of the wording, but a question parked over the record still reads as
    // something to dismiss, and the ✕ is where a thumb goes first. It runs the SAME
    // handler as "No" rather than a bare close, so declining means one thing
    // however you do it: on the first-run offer that still points at where the tour
    // lives, which a silent close would swallow.
    el.innerHTML =
      '<button type="button" class="mf-hint-close mf-offer-x" aria-label="Dismiss">✕</button>' +
      '<p class="mf-tour-text"></p>' +
      '<div class="mf-tour-foot mf-offer-foot">' +
        '<button type="button" class="mf-tour-skip mf-offer-no"></button>' +
        '<button type="button" class="mf-tour-next mf-offer-yes"></button>' +
      '</div>';
    el.querySelector(".mf-tour-text").textContent = text;
    el.querySelector(".mf-offer-no").textContent = copy.tourOfferNo;
    el.querySelector(".mf-offer-yes").textContent = copy.tourOfferYes;
    document.body.appendChild(el);
    _offerEl = el;
    el.querySelector(".mf-offer-yes").addEventListener("click", function () {
      closeTourOffer();
      startTour();
    });
    el.querySelector(".mf-offer-no").addEventListener("click", onNo);
    el.querySelector(".mf-offer-x").addEventListener("click", onNo);
    _offerReflow = function () { requestAnimationFrame(_placeOffer); };
    window.addEventListener("resize", _offerReflow);
    _placeOffer();
    requestAnimationFrame(_placeOffer);
    return true;
  }

  // FB#105 (owner, 2026-08-07), REPLACING the anchored bridge cue this change was
  // going to ship with: "i feel like it would be better to just give them the option
  // to take the tour." The tour now walks the new layout anyway — it points at the ☰
  // for platforms and feedback, and at the Notebook tab in the dock — so it says more
  // than a bubble could, and it can be declined at zero cost (VISION P3).
  //
  // The wording still NAMES that things moved, which is the part a bare "want a tour?"
  // would drop: BRAND.md's tier-3 rule exists so that what someone already learned
  // still makes sense, and an unexplained offer leaves a returning reader hunting for
  // the tabs. Disclosure first, then the offer.
  //
  // Its own flag, NOT the tour's: a returning reader has had TOUR_KEY set since their
  // first visit, so shouldShowTour() is false for exactly the people this is for.
  // Caller owns eligibility (auth-ui gates it on the build they last ran).
  const CHANGE_OFFER_KEY = "aotd.offer.navmoved.v1";
  // FB#109: the second bridge offer, for the Keep/Skip swap. Its own flag — a reader
  // who met the nav offer must still be able to meet this one, and vice versa.
  const SWAP_OFFER_KEY = "aotd.offer.keepskipswap.v1";

  // `opts` = {key, text}, defaulting to the FB#105 nav-move pair. Two bridge offers
  // now exist, and a reader whose last run predates BOTH is eligible for both — so
  // only one may be on screen, and the other must refuse WITHOUT burning its flag so
  // it can return on a later visit instead of being spent silently.
  //
  // The `.mf-tour` selector below already does that (an offer built by _buildOffer
  // carries that class), so the two-offer case was safe before this was generalised.
  // The explicit `_offerEl` check is belt-and-braces for the one state it can't see:
  // a bubble whose element left the DOM without closeTourOffer() running, which would
  // leave the module thinking it owns an offer that no selector can find.
  function showChangeOffer(storage, opts) {
    const o = opts || {};
    const key = o.key || CHANGE_OFFER_KEY;
    const text = o.text || copy.changeOfferText;
    if (flagGet(storage, key)) return false;
    if (typeof document === "undefined") return false;
    // Never over a door, the first-run card, or a tour already running.
    if (document.querySelector('.modal:not(.hidden), .mf-tour')) return false;
    if (_offerEl) return false;           // one question at a time; the other retries
    flagSet(storage, key);                // asked once, on show — a reload can't re-ask
    return _buildOffer(text, function () { closeTourOffer(); }, o.clearSel);
  }

  // showTourOffer(): ask. Returns whether it asked (false if already seen / no DOM).
  function showTourOffer(storage) {
    if (!shouldShowTour(storage)) return false;
    if (typeof document === "undefined") return false;
    closeTourOffer();
    markTourSeen(storage);            // asked once, on show — a reload can't re-ask
    return _buildOffer(copy.tourOfferText, function () {
      closeTourOffer();
      // Say where it went, once, anchored to the menu that holds it. The ☰ is mounted
      // by auth-ui and may not exist the instant this is clicked, so retry a few
      // times — showHint doesn't burn its flag when the anchor is missing, so a retry
      // costs nothing and a mount-race doesn't silently eat the one chance to say it.
      // (A local single-user build has no ☰ at all; there, nothing is shown, which is
      // the honest outcome — there's no menu to point at.)
      let tries = 0;
      (function tell() {
        const shown = showHint({
          key: "aotd.cue.tourdeclined.v1",
          sel: ".acct-btn",
          place: "below",
          label: copy.tourOfferLabel,
          text: copy.tourDeclinedText,
          storage: storage,
        });
        if (!shown && ++tries < 6) setTimeout(tell, 500);
      })();
    });
  }

  // Start the tour on demand — the ☰ menu's "Take the tour". Always runs (it's an
  // explicit ask), and resets nothing: the once-per-device flag only governs the
  // unprompted offer.
  function startTourOnDemand() {
    closeTourOffer();
    startTour();
  }

  // --- a single bridge cue (BRAND.md §"Announcing a change") -----------------
  // ONE anchored bubble for a change that breaks something already learned — the
  // same `.mf-hint` component the tour uses, so it looks and dismisses identically,
  // but standalone: no step count, no "next", nothing to advance through. Deliberately
  // NOT wired into the tour's step machinery — the tour is a first-run sequence and a
  // bridge cue fires for the opposite audience (people who were here BEFORE), so
  // sharing state would couple two things that must be gated differently.
  //
  // It is disclosure, not a nudge (VISION P4): it explains the screen you are already
  // looking at, then never appears again. Shown at most once per device per `key`, and
  // the flag is set on SHOW (not on dismiss) so a reload can't replay it.
  //
  // Caller owns eligibility. `key` only makes it once-per-device; deciding WHO could
  // have learned the old thing is the caller's job — see auth-ui's use of the
  // What's-new seen build, which classifies a first-ever reader correctly.
  let _hintEl = null, _hintAnchor = null, _hintReflow = null, _hintPlace = null;

  function hintSeen(key, storage) { return flagGet(storage, key); }
  function resetHint(key, storage) { flagClear(storage, key); }

  function closeHint() {
    if (_hintEl && _hintEl.parentNode) _hintEl.parentNode.removeChild(_hintEl);
    _hintEl = null;
    _hintAnchor = null;
    _hintPlace = null;
    try {
      document.removeEventListener("keydown", _hintKey, true);
      if (_hintReflow) {
        window.removeEventListener("resize", _hintReflow);
        window.removeEventListener("scroll", _hintReflow, true);
      }
    } catch (e) {}
    _hintReflow = null;
  }
  function _hintKey(e) { if (e.key === "Escape") closeHint(); }

  // Same geometry as _placeTour: centred on the anchor, flipped to whichever side has
  // room, clamped on-screen, arrow tracking the anchor's centre.
  function _placeHint() {
    if (!_hintEl || !_hintAnchor) return;
    if (!document.contains(_hintAnchor)) { closeHint(); return; }
    const r = _hintAnchor.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const pw = _hintEl.offsetWidth, ph = _hintEl.offsetHeight;
    // Default: whichever side has room. A cue can pin its side (`place`) when the
    // free side holds something the reader needs — on the sign-in card the space
    // below the email field is the submit button, and a bubble that covers the only
    // action turns a one-time note into an obstacle.
    const below = _hintPlace ? (_hintPlace === "below")
                             : (r.top + r.height / 2) < vh * 0.5;
    let left = r.left + r.width / 2 - pw / 2;
    left = Math.max(10, Math.min(left, vw - pw - 10));
    let top = below ? r.bottom + 12 : r.top - ph - 12;
    top = Math.max(10, Math.min(top, vh - ph - 10));
    _hintEl.style.left = left + "px";
    _hintEl.style.top = top + "px";
    _hintEl.setAttribute("data-arrow", below ? "up" : "down");
    const arrow = _hintEl.querySelector(".mf-hint-arrow");
    if (arrow) arrow.style.left =
      Math.max(16, Math.min((r.left + r.width / 2) - left, pw - 16)) + "px";
  }

  // Show the cue anchored to `sel`. Returns whether it showed. No-ops (without
  // burning the flag) when the anchor isn't on screen yet, so a caller can try again
  // on the next render rather than silently spending its one chance.
  function showHint(opts) {
    const o = opts || {};
    if (!o.key || !o.sel || !o.text) return false;
    if (hintSeen(o.key, o.storage)) return false;
    if (typeof document === "undefined") return false;
    const anchor = document.querySelector(o.sel);
    if (!anchor) return false;
    closeHint();
    flagSet(o.storage, o.key);          // on show, so a reload can't replay it
    const el = document.createElement("div");
    // `mf-cue` (vs the tour's `mf-tour`) lifts it above the auth gate and exempts it
    // from the pre-auth visibility hide — a cue may anchor to a control inside the
    // gate while living on <body>. See style.css `body.auth-pending`.
    el.className = "mf-hint mf-cue";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", o.label || "What changed");
    el.innerHTML =
      '<button type="button" class="mf-hint-close" aria-label="Dismiss">✕</button>' +
      '<p class="mf-tour-text"></p>' +
      '<span class="mf-hint-arrow" aria-hidden="true"></span>';
    el.querySelector(".mf-tour-text").textContent = o.text;   // text, never innerHTML
    document.body.appendChild(el);
    el.querySelector(".mf-hint-close").addEventListener("click", closeHint);
    _hintEl = el;
    _hintAnchor = anchor;
    _hintPlace = (o.place === "above" || o.place === "below") ? o.place : null;
    _hintReflow = function () { requestAnimationFrame(_placeHint); };
    document.addEventListener("keydown", _hintKey, true);
    window.addEventListener("resize", _hintReflow);
    window.addEventListener("scroll", _hintReflow, true);
    // Place now, then again after layout. The caller renders the cue's anchor in the
    // same tick (renderSignIn writes the card's innerHTML, then calls us), so a
    // synchronous measure can read a not-yet-laid-out 0,0 rect and clamp the bubble
    // into the top-left corner. The rAF pass re-measures once the card has boxes.
    _placeHint();
    _hintReflow();
    return true;
  }

  return {
    KEY, TOUR_KEY, copy,
    seen, markSeen, reset, shouldShowFirstRun,
    tourSeen, markTourSeen, resetTour, shouldShowTour,
    show, maybeShowFirstRun,
    startTour, endTour, maybeStartTour,
    showTourOffer, closeTourOffer, startTourOnDemand,   // FB#99
    showChangeOffer, CHANGE_OFFER_KEY,                  // FB#105
    SWAP_OFFER_KEY,                                     // FB#109
    showHint, closeHint, hintSeen, resetHint,
  };
});
