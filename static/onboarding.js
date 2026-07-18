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
    title: "Find music, write notes.",
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
    startFirst: "Start",
    startAgain: "Back to the records",
    // A quiet, pull-only "how it works" door — opens the architecture guide
    // (/architecture, incl. the private notebook + E2EE) in a new tab, so your
    // place on the records is kept. (The old "What's an album you remember?"
    // taste-door was removed here 2026-07-13 — owner's call; the Remember door
    // still lives in the app itself.)
    howItWorks: "How Music Forest works ↗",
    closeTitle: "Close",
    // The first-run guided tour — four gentle cues, in order, each pointing at one
    // control. keep/skip vocab + "private to you" (BRAND); one plain line each,
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
      // Kept the file's existing sign-off shape — blank line, em dash — rather than
      // the inline "-Clancy" he typed; same words, house punctuation.
      { sel: "#feedbackBtn",
        text: "Send me your thoughts. I read everything.\n\n— Clancy" },
    ],
    tourNext: "Next",
    tourDone: "Got it",
    tourSkip: "Skip the tour",
    tourStep: function (i, n) { return i + " / " + n; },
    // Platforms step copy — one for the header chooser (guest), one for the ☰ menu
    // (signed in), picked by the step's resolve() above.
    tourPlatformsHeader: "Set the services you use — then each record's Listen link opens right where you already listen.",
    tourPlatformsMenu: "Open the menu (☰) to choose the services you use — then each record's Listen link opens right where you already listen.",
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
        '<div class="onboard-body">' + parasHtml + '</div>' +
        '<button type="button" class="onboard-start"></button>' +
        '<a class="onboard-howitworks" href="/architecture" target="_blank" ' +
          'rel="noopener">' + copy.howItWorks + '</a>' +
      '</div>';
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
  //                  (so it shows once), button reads "Show me today's records".
  //  - first: false  the "What is this?" door — never touches the flag, button
  //                  reads "Back to the records".
  // onStart fires after the screen is dismissed (any path), e.g. to focus Today.
  function show(opts) {
    opts = opts || {};
    const first = !!opts.first;
    if (first) markSeen();              // once per device, set on show (reload-safe)
    if (!_el) _el = buildEl();
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

  function _tourKey(e) {
    if (e.key !== "Escape") return;
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
      '<button type="button" class="mf-hint-close" aria-label="' + copy.tourSkip + '">✕</button>' +
      '<p class="mf-tour-text"></p>' +
      '<div class="mf-tour-foot">' +
        '<span class="mf-tour-count"></span>' +
        '<button type="button" class="mf-tour-next"></button>' +
      '</div>' +
      '<span class="mf-hint-arrow" aria-hidden="true"></span>';
    document.body.appendChild(el);
    el.querySelector(".mf-hint-close").addEventListener("click", endTour);
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

  return {
    KEY, TOUR_KEY, copy,
    seen, markSeen, reset, shouldShowFirstRun,
    tourSeen, markTourSeen, resetTour, shouldShowTour,
    show, maybeShowFirstRun,
    startTour, endTour, maybeStartTour,
  };
});
