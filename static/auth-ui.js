"use strict";
/*
 * auth-ui.js — the two-step gate in front of the app (BETA_PLAN.md §2, §3, §11).
 *
 * Step 1 (identity): email + password sign-in via Supabase (with a one-time
 *   email link as a fallback for accounts that don't have a password yet).
 * Step 2 (data): a passphrase that unlocks the DEK. First run also forces a
 * recovery code, shown once behind a "save this" gate. After unlock the journal
 * is decrypted into AOTDStore and the app renders from it; an idle timeout
 * auto-locks (DEK dropped) and re-prompts on resume. The recovery code can reset
 * a forgotten passphrase.
 *
 * When /api/public-config says Supabase isn't configured, we're in single-user
 * local mode: no gate, the app runs against the legacy Python routes exactly as
 * before. Key material is NEVER written to localStorage — only the idle-timeout
 * preference is.
 */
(function () {
  const C = window.AOTDCrypto, S = window.AOTDSync, J = window.AOTDJournal;

  const IDLE_KEY = "aotd_idle_ms";
  // Owner's call, 2026-08-04, settled at 6 hours after 15 minutes → 1 hour → off →
  // here. The ask driving it: "the user should just have to type in their password once
  // and then be able to use quick unlock every time after that."
  //
  // Six hours is chosen to sit BEYOND the session, not inside it. The old 15 minutes
  // fired mid-use, while someone was still reading; this can only fire on a page that's
  // been sitting untouched since roughly the last time they were awake for it. So it
  // stops being an interruption and goes back to being what an idle lock is for — a
  // backstop on a forgotten, unattended device.
  //
  // Worth being exact about what an idle lock does and doesn't carry here:
  //   * The DEK is memory-only and ALWAYS has been. It is never written to disk.
  //   * A reload, a new tab, or the browser reclaiming a backgrounded PWA all drop it
  //     and land on the unlock screen — on a phone that's the COMMON case, since the
  //     OS discards background pages routinely. In practice that usually happens long
  //     before six hours elapse, which is precisely why a short timer bought so little
  //     and cost so much.
  //   * Nothing about the server changes either way: it only ever holds ciphertext.
  // The timer is the backstop; "Lock Notebook" in the ☰ menu is the deliberate lock,
  // for the case that actually wants one — handing someone your phone.
  //
  // Per-device override: `aotd_idle_ms` ≥ 60000 sets a different timeout. Anything
  // else — including 0 — falls back to the default below, so THE IDLE LOCK IS ALWAYS
  // ON. (This used to claim an explicit 0 turned the watch off entirely. It never did:
  // the ≥ 60000 guard rejects 0 and returns the default. The claim is deleted rather
  // than implemented — "off" was one of the settings tried on 2026-08-04 and
  // deliberately passed over for six hours, so an off switch is not a gap to fill.
  // Owner's call, 2026-08-06.)
  const DEFAULT_IDLE_MS = 6 * 60 * 60 * 1000;   // 6 hours
  function idleMs() {
    const v = parseInt(localStorage.getItem(IDLE_KEY) || "", 10);
    return Number.isFinite(v) && v >= 60000 ? v : DEFAULT_IDLE_MS;
  }

  let _gate = null;       // overlay element
  let _store = null;
  let _keyMaterial = null;
  let _idleTimer = null;
  let _email = null;      // the signed-in account's email, for context lines
  let _userId = null;     // the signed-in account's UUID (keys device-trust record)
  let _gateReason = null; // why the guest opened the gate (why/note/keep), for copy

  // --- overlay scaffolding ---------------------------------------------------
  function gate() {
    if (_gate) return _gate;
    _gate = document.createElement("div");
    _gate.id = "authGate";
    _gate.className = "auth-gate";
    _gate.innerHTML = '<div class="auth-card"><div class="auth-brand">Music&nbsp;Forest</div>' +
      '<div id="authBody"></div></div>';
    document.body.appendChild(_gate);
    return _gate;
  }
  // The app starts hidden (body.auth-pending, set in markup) so the unlocked
  // page never flashes during the async boot. revealApp() drops that veil once
  // we're either unlocked or in local (no-gate) mode; hideApp() restores it when
  // we lock or sign out so nothing peeks behind the re-shown gate.
  function revealApp() { document.body.classList.remove("auth-pending"); }
  function hideApp() { document.body.classList.add("auth-pending"); }
  function show() { gate().classList.remove("hidden"); }
  function hide() { if (_gate) _gate.classList.add("hidden"); }
  function body() { return gate().querySelector("#authBody"); }
  function esc(s) {
    return (s == null ? "" : String(s)).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function setStatus(msg, kind) {
    const el = gate().querySelector("#authStatus");
    if (el) { el.textContent = msg || ""; el.className = "auth-status" + (kind ? " " + kind : ""); }
  }
  // A fetch that dies on the network (offline, DNS, a CDN hiccup) surfaces as a
  // raw TypeError — "Failed to fetch" (Chrome), "Load failed" (Safari),
  // "NetworkError…" (Firefox) — which is developer-speak at the most delicate
  // moment in the funnel (U18). Name the situation like a person instead.
  const NET_ERR_MSG =
    "Couldn't reach the sign-in service — check your connection and try again.";
  function isNetErr(err) {
    return /failed to fetch|networkerror|load failed|network request failed/i
      .test((err && err.message || "").toString());
  }
  // Small "Signed in as you@example.com" line so the passphrase/unlock screens
  // make clear which account they're acting on (you just signed in above).
  function acctLine() {
    return _email ? `<p class="auth-acct">Signed in as <b>${esc(_email)}</b></p>` : "";
  }

  // --- guest mode (onboarding Phase A) ---------------------------------------
  // "Try before account": a logged-out visitor lands straight on Choose and can
  // pick, with no sign-in. The other doors (Explore/Journal) stay closed until
  // there's an encrypted journal to keep things in; the guest reaches the gate
  // via the in-context invites (the "why" box, the ✎ Note door — wired in app.js)
  // and a persistent "Keep what I find" entry. Picks made as a guest are buffered
  // locally (store-bridge) and never touch the server until migration (Phase D).
  function enterGuest() {
    window.AOTD_GUEST = true;
    document.body.classList.add("guest");
    hide();           // no gate overlay — the app is the first thing you see
    revealApp();      // drop the veil: the app is live immediately
    // #58/#59/#60: a guest gets the full nav (tabs), so the header no longer
    // carries guest-only door buttons — the ☰ menu holds "Start a journal",
    // "About", "Request a record", and "Sign in".
    mountGuestMenu();
    document.dispatchEvent(new CustomEvent("aotd:guest"));
    // U18: the welcome modal no longer auto-opens — the deck itself is the
    // welcome (show, don't tell; the record is the first thing on screen). U25
    // brought back a FIRST-run open (maybeWelcomeFirstRun); after that, the fuller
    // account of what this is lives behind the ☰ menu's "About" door (FB#97) —
    // pull, not push.
  }
  // Leave guest mode once the visitor commits to an account (reached unlock).
  function leaveGuest() {
    window.AOTD_GUEST = false;
    document.body.classList.remove("guest");
    unmountGuestMenu();
  }
  // A guest gets the same ☰ corner menu as a signed-in user (#60: the guest header
  // no longer carries door buttons). It holds the primary "Start a journal →"
  // account CTA, a pull-only "About" door (FB#97), the #61 "Request a record"
  // channel, and a "Sign in" door for a returning visitor.
  let _guestMenu = null;
  function mountGuestMenu() {
    if (_guestMenu) return;
    _guestMenu = document.createElement("div");
    _guestMenu.id = "guestMenu";
    _guestMenu.className = "acct-menu";       // reuse the account-menu styling
    _guestMenu.innerHTML =
      '<button class="acct-btn" aria-haspopup="true" aria-expanded="false" ' +
        'title="Menu" aria-label="Menu">☰</button>' +
      '<div class="acct-pop hidden">' +
        '<button class="acct-start" title="Start your Notebook — sync it, back it up, and keep it for good">Start your Notebook →</button>' +
        // FB#97 (owner): "what is this" is now "About", and it opens the About door
        // — why this exists, how the day is put together, and where every piece of
        // data on screen comes from (which the footer used to carry).
        '<button class="acct-whatis" title="About Music Forest — why it exists, and where the data comes from">About</button>' +
        // FB#99: the tour is offered, not forced — so it needs a permanent home for
        // anyone who said no (or wants it again).
        '<button class="acct-tour" title="Walk through the app, one tip at a time">Take the tour</button>' +
        // Guests run the same shell and get the same updates, so the same door.
        '<button class="acct-whatsnew" title="What has changed since you last updated">What&#39;s new</button>' +
        '<button class="acct-request" title="Can’t find a record? Ask us to add it">Request a record</button>' +
        '<button class="acct-signin" title="Already have a Notebook? Sign in.">Sign in</button>' +
      '</div>';
    const btn = _guestMenu.querySelector(".acct-btn");
    const pop = _guestMenu.querySelector(".acct-pop");
    const close = () => {
      pop.classList.add("hidden");
      btn.setAttribute("aria-expanded", "false");
    };
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = !pop.classList.toggle("hidden");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    });
    _guestMenu.querySelector(".acct-start").addEventListener("click", (e) => {
      e.stopPropagation(); close(); showGate("start");
    });
    _guestMenu.querySelector(".acct-whatis").addEventListener("click", (e) => {
      e.stopPropagation(); close();
      if (window.openAboutDoor) window.openAboutDoor();
    });
    _guestMenu.querySelector(".acct-tour").addEventListener("click", (e) => {
      e.stopPropagation(); close();
      if (window.AOTDOnboarding) window.AOTDOnboarding.startTourOnDemand();
    });
    _guestMenu.querySelector(".acct-whatsnew").addEventListener("click", (e) => {
      e.stopPropagation(); close();
      if (window.AOTDWhatsNew) window.AOTDWhatsNew.show();
    });
    _guestMenu.querySelector(".acct-request").addEventListener("click", (e) => {
      e.stopPropagation(); close();
      if (window.openRecordRequest) window.openRecordRequest("");
    });
    _guestMenu.querySelector(".acct-signin").addEventListener("click", (e) => {
      e.stopPropagation(); close(); showGate("signin");
    });
    document.addEventListener("click", closeGuestMenu);   // click-away closes it
    document.body.appendChild(_guestMenu);
    // FB#105: a guest's platforms chooser lives in here too now, not in the header.
    // After the append, so the pop is in the document when the chooser moves into it.
    adoptListenPref(_guestMenu.querySelector(".acct-pop"));
    adoptFeedbackBtn(_guestMenu.querySelector(".acct-pop"));
    adoptFooter(_guestMenu.querySelector(".acct-pop"));
    // FB#97: one-time note that About the data moved in here. After the mount, so
    // the anchor exists; a beat later so it lands after first paint.
    setTimeout(maybeShowAboutMovedCue, 900);
    // FB#109: the Keep/Skip swap, for someone who was here before it. Ahead of the
    // nav offer below — see its comment for why this one wins when both are due.
    setTimeout(maybeShowKeepSkipSwapOffer, 1200);
    // FB#105: and, for someone who was here before the layout moved, the offer of a
    // tour of it. Later than the cue above so the two can never race onto the screen
    // together — showChangeOffer also refuses while any modal or tour is up.
    setTimeout(maybeShowNavMovedOffer, 1600);
  }
  function closeGuestMenu(e) {
    if (!_guestMenu || (e && _guestMenu.contains(e.target))) return;
    // #24/#26: opening feedback must NOT close the menu (same as the account menu).
    if (e && e.target.closest &&
        e.target.closest("#feedbackBtn, #feedbackModal")) return;
    const pop = _guestMenu.querySelector(".acct-pop");
    const btn = _guestMenu.querySelector(".acct-btn");
    if (pop) pop.classList.add("hidden");
    if (btn) btn.setAttribute("aria-expanded", "false");
  }
  function unmountGuestMenu() {
    document.removeEventListener("click", closeGuestMenu);
    // FB#105: the chooser lives in here now, so re-home it BEFORE the node goes —
    // removing the menu with #listenPref still inside would destroy the element and
    // every listener wireListenPref attached to it, and nothing re-creates them.
    restoreListenPref(_guestMenu);
    restoreFeedbackBtn(_guestMenu);
    restoreFooter(_guestMenu);
    if (_guestMenu) { _guestMenu.remove(); _guestMenu = null; }
  }
  // Phase D: how many picks a guest is about to bring across, for the gate's live
  // "your N picks come with you" reassurance. Reads the same localStorage buffer
  // store-bridge writes to; total (never throws), 0 when there's nothing/no buffer.
  function guestPickCount() {
    try {
      return window.AOTDGuestBuffer ? window.AOTDGuestBuffer.create().count() : 0;
    } catch (e) { return 0; }
  }
  // F26: reflections written through the remember door, same reassurance.
  function guestNoteCount() {
    try {
      const b = window.AOTDGuestBuffer ? window.AOTDGuestBuffer.create() : null;
      return b && b.notesCount ? b.notesCount() : 0;
    } catch (e) { return 0; }
  }
  // The gate's live "comes with you" line, covering kept records and notes:
  // "Your 3 kept records and your 2 notes come with you." Empty string when the
  // guest has written nothing — the line only exists when it's true. (Keep-model
  // vocabulary per BRAND.md: kept records / notes, never picks/choices/reflections.)
  function guestKeepLine() {
    if (!window.AOTD_GUEST) return "";
    const p = guestPickCount(), n = guestNoteCount();
    if (!p && !n) return "";
    const parts = [];
    if (p) parts.push(`<b>${p}</b> kept ${p === 1 ? "record" : "records"}`);
    if (n) parts.push(n === 1 ? "your note" : `your <b>${n}</b> notes`);
    const phrase = parts.join(" and ");
    const verb = (p + n) === 1 ? "comes" : "come";
    return `<p class="auth-sub auth-keep">Your ${p ? phrase : phrase.replace(/^your /, "")} ${verb} with you.</p>`;
  }
  // Open the sign-in/account gate over the guest app. A door, not a wall: when
  // in guest mode the gate shows a "Keep looking around" link back.
  //
  // U18 — the gate forks on intent. Every guest reason ("start" from the header
  // entry, why/note/keep from the in-context invites) is sign-UP intent and gets
  // the first-time screen; only the explicit "signin" door (☰ menu, for someone
  // who already has a journal) leads with the password form. Each screen
  // cross-links the other, so a wrong guess costs one click.
  function showGate(reason) {
    _gateReason = reason || null;
    hideApp();        // veil the guest app behind the gate while deciding
    renderSignIn();   // passwordless: sign-in and sign-up are one action now
    show();
  }
  function closeGate() {   // cancel: back to guest, app intact
    _gateReason = null;
    hide();
    revealApp();
  }

  // --- screens ---------------------------------------------------------------
  function renderLoading(msg) {
    body().innerHTML = `<p class="auth-lead">${esc(msg || "Loading…")}</p>`;
  }

  // Once identity is established (password sign-in, or a magic-link redirect
  // picked up at boot), branch into the data step: first-ever sign-in sets the
  // encryption passphrase, otherwise unlock with it.
  async function afterSignedIn(session) {
    // The KDF must be bound before any unlock/create screen runs a crypto op. On
    // the guest→sign-in path it's usually already warm (kicked off at guest entry);
    // this awaits it either way, and on the signed-in-at-boot path it's the one
    // place the Argon2id WASM is brought up (P4 moved it off the guest critical
    // path). Memoized, so the await is free once bound; a load failure surfaces
    // here and is caught by boot()/the sign-in handler.
    await ensureSodium();
    _email = (session && session.user && session.user.email) || _email;
    _userId = (session && session.user && session.user.id) || _userId;
    setStatus("Signing in…");
    _keyMaterial = (await S.getKeys() || {}).key_material || null;
    if (!_keyMaterial) { renderSetup(); return; }
    // Returning user: if they've turned on biometric unlock for this device,
    // offer that first — a single Face ID / fingerprint tap instead of the
    // passphrase. The passphrase screen is always one click away as a fallback.
    // Smooth update (owner 2026-07-07): a reload triggered by "reload to update"
    // sets this one-shot flag, so the re-unlock screen reads as *finishing the
    // update* (not a fresh sign-in) and, with Quick unlock on, goes straight to the
    // biometric. Read + clear it here so it only colours this one boot.
    let postUpdate = false;
    try {
      postUpdate = sessionStorage.getItem("aotd_post_update") === "1";
      sessionStorage.removeItem("aotd_post_update");
    } catch (e) {}
    const rec = await deviceRecord();
    if (rec) renderDeviceUnlock(rec, { postUpdate });
    else renderUnlock({ postUpdate });
  }

  // FB#108 follow-up (owner, on device 2026-08-06): "if quicklock is enabled, I don't
  // want to see the modal that says 'quick unlock' and then the lock screen pops up. I
  // just want the lock screen to pop up as the very first thing i see when i open the
  // app. no music forest anything, just the native quick unlock."
  //
  // So on a boot where this device is enrolled, raise the native prompt BEFORE anything
  // of ours is on screen — no gate, no wordmark, no "Starting up…". That's possible
  // because the device path is the cheap one: `deviceEntry` holds the DEK wrapped under
  // the WebAuthn PRF key, unwrapped with plain WebCrypto AES-GCM. It needs neither the
  // Argon2id WASM nor the /api/sync/keys round trip — which are exactly the two slow
  // things `afterSignedIn` awaits before it can paint anything. Both are still needed
  // (a later passphrase op, a fallback screen), so they're kicked off in the background
  // rather than dropped.
  //
  // Returns true when the notebook is open and no gate was ever shown. On ANY failure —
  // no enrolment, a cancelled prompt, or a platform that refuses without a gesture (iOS)
  // — it returns false and the caller falls back to the normal, visible path.
  async function tryInstantDeviceUnlock(session) {
    try {
      _email = (session && session.user && session.user.email) || _email;
      _userId = (session && session.user && session.user.id) || _userId;
      const rec = await deviceRecord();
      if (!rec) return false;
      // Warm the things the prompt doesn't need, without making it wait for them.
      ensureSodium().catch(() => {});
      S.getKeys().then((k) => {
        _keyMaterial = (k || {}).key_material || null;
        window.AOTD_KEY_MATERIAL = _keyMaterial;
      }).catch(() => {});
      const kek = await AOTDDevice.assert(rec);
      const dek = await C.unlockWithDeviceEntry(rec.deviceEntry, kek);
      if (kek && kek.fill) kek.fill(0);
      await finishUnlock(dek);
      return true;
    } catch (e) {
      return false;
    }
  }

  // The stored device-trust record for this account on this device, or null
  // (also null when WebAuthn/PRF isn't available — caller falls back to passphrase).
  async function deviceRecord() {
    try {
      if (!window.AOTDDevice || !_userId) return null;
      if (!(await AOTDDevice.supported())) return null;
      return await AOTDDevice.load(_userId);
    } catch (e) { return null; }
  }
  function declineKey() { return "aotd_devtrust_declined:" + (_userId || ""); }

  // The build passwordless sign-in shipped in. A reader whose last run predates it
  // typed a password on this screen and deserves one note about where it went.
  const PASSWORDLESS_BUILD = 245;
  const PASSWORDLESS_CUE_KEY = "aotd.cue.passwordless.v1";

  // Bridge cue (BRAND.md §"Announcing a change"): the password field is gone, which
  // breaks something people already learned, so it ships with a one-time anchored
  // bubble rather than as a silent swap.
  //
  // WHO SEES IT is the whole difficulty, and What's-new already solved it: its seen
  // key holds the build this reader last actually ran. A first-ever reader is primed
  // to the CURRENT build by whatsnew.primeSeen — so `seen >= PASSWORDLESS_BUILD` and
  // they never meet a note about a screen they never saw (BRAND: "a note about it
  // manufactures the confusion it was meant to prevent"). Blocked storage reads null
  // and stays quiet, which is the right failure: a missing cue is a smaller harm than
  // one that fires at everyone forever.
  //
  // Anchored to the email field, not the submit button: the field is where the eye
  // goes looking for the password that used to sit under it.
  function maybeShowPasswordlessCue() {
    try {
      const OB = window.AOTDOnboarding, WN = window.AOTDWhatsNew;
      if (!OB || !OB.showHint || !WN || !WN._readSeen) return;
      const seen = WN._readSeen(localStorage);
      if (seen == null || seen >= PASSWORDLESS_BUILD) return;
      OB.showHint({
        key: PASSWORDLESS_CUE_KEY,
        sel: "#signInContact",
        // Above: below the field is "Email me a code", and a bubble over the only
        // action on the screen makes a one-time note into an obstacle.
        place: "above",
        label: "What changed about signing in",
        text: "No password here any more — enter your email and we'll send you a "
            + "code by email. Your Notebook password hasn't changed; that's still what "
            + "unlocks your notes.",
      });
    } catch (e) { /* a cue must never block sign-in */ }
  }

  // FB#97 moved "About the data" out of the footer and into the ☰ menu as "About".
  // That's a moved surface, not an additive one — someone who used the footer door
  // would find it simply gone — so it ships with a cue (BRAND.md §"Announcing a
  // change"), gated the same way as the one above: only for a reader whose last run
  // predates the build that moved it. Anchored to ☰, which is where it went.
  const ABOUT_MOVE_BUILD = 253;
  const ABOUT_MOVE_CUE_KEY = "aotd.cue.aboutmoved.v1";

  function maybeShowAboutMovedCue() {
    try {
      const OB = window.AOTDOnboarding, WN = window.AOTDWhatsNew;
      if (!OB || !OB.showHint || !WN || !WN._readSeen) return;
      const seen = WN._readSeen(localStorage);
      if (seen == null || seen >= ABOUT_MOVE_BUILD) return;
      // Never over another door, and never over the first-run tour — which points at
      // this very button on its platforms step.
      if (document.querySelector('.modal:not(.hidden), .mf-tour')) return;
      OB.showHint({
        key: ABOUT_MOVE_CUE_KEY,
        sel: ".acct-btn",
        place: "below",
        label: "Where About the data went",
        text: "“About the data” has moved off the bottom of the screen. It's in here "
            + "now, under About — along with why Music Forest exists and how each "
            + "day's records are put together.",
      });
    } catch (e) { /* a cue must never block the app */ }
  }

  // FB#105 moved the primary navigation to a dock at the foot of the screen, and took
  // "Where you listen" and ✎ Feedback off the page into ☰. That is BRAND.md's tier 3
  // — surfaces someone already learned — so it does not ship silent.
  //
  // Owner's call (2026-08-07) on the FORM: an offer of the tour rather than an
  // anchored bubble. "i feel like it would be better to just give them the option to
  // take the tour." The tour walks the new layout itself, so it answers more than a
  // bubble could, and it costs one tap to decline.
  //
  // WORDING — owner's call (2026-08-11): the BARE tour offer, "Would you like a tour of
  // how to use Music Forest?" (copy.swapOfferText), NOT the "the tabs have moved…"
  // disclosure (copy.changeOfferText). Same reasoning as FB#109's bare swap offer: at
  // this beta size the "what moved" wording isn't worth its weight, and the tour walks
  // the new layout anyway. copy.changeOfferText is kept for a one-line restore if the
  // user base grows enough that disclosure-first earns its keep again.
  //
  // WHO SEES IT, the same way as the two cues above: What's-new's seen key holds the
  // build this reader last actually ran. A first-ever reader is primed to the CURRENT
  // build by whatsnew.primeSeen, so `seen >= NAV_MOVE_BUILD` and they never meet a
  // note about a layout they never saw. Blocked storage reads null and stays quiet.
  const NAV_MOVE_BUILD = 277;

  function maybeShowNavMovedOffer() {
    try {
      const OB = window.AOTDOnboarding, WN = window.AOTDWhatsNew;
      if (!OB || !OB.showChangeOffer || !WN || !WN._readSeen) return;
      const seen = WN._readSeen(localStorage);
      if (seen == null || seen >= NAV_MOVE_BUILD) return;
      OB.showChangeOffer(null, { text: OB.copy.swapOfferText });
    } catch (e) { /* an offer must never block the app */ }
  }

  // FB#109. Keep and Skip swapped sides in v280 (owner: skip was a thumb stretch on
  // the right). BRAND.md's tier 3 — but the hardest shape of it. A moved surface is
  // something you go LOOKING for, so a note about it is read before it's needed; a
  // reversed pair is pressed by a thumb that has stopped reading, so the mistake can
  // land before any cue is seen. Nothing shown on screen can fully prevent that. What
  // it can do is make the reversal make sense afterwards and name the way back, which
  // is what the rule is actually for: the cost of a silent change is trust.
  //
  // FORM: an offer of the tour, owner's call (2026-08-07), the same shape as FB#105's.
  // The offer's own text does the disclosing here, and it has to do MORE of it than
  // the nav one did — the tour's Keep and Skip steps introduce each button as if you
  // were meeting it for the first time and never mention that the sides changed, so a
  // reader who accepts would relearn the pair only incidentally, and one who declines
  // would learn nothing at all. See copy.swapOfferText: it names both sides and both
  // exits before it asks anything.
  //
  // WHO SEES IT, as with the three above: What's-new's seen key holds the build this
  // reader last actually ran, and it only advances when someone OPENS that panel, so
  // for nearly everyone it is still the build they arrived on. `seen < 280` is exactly
  // "was here before the swap"; a reader who arrived at v281 was primed to the current
  // build and never learned the old sides, so they are excluded — a note about it
  // would manufacture the confusion it exists to prevent.
  //
  // Ordered BEFORE maybeShowNavMovedOffer (1200ms vs 1600ms) for the reader eligible
  // for both: this one is the mistake in flight, the nav move is five builds old, and
  // the tour teaches the nav move anyway. The other refuses without burning its flag
  // and returns on the next visit.
  const KEEPSKIP_SWAP_BUILD = 280;

  function maybeShowKeepSkipSwapOffer() {
    try {
      const OB = window.AOTDOnboarding, WN = window.AOTDWhatsNew;
      if (!OB || !OB.showChangeOffer || !WN || !WN._readSeen) return;
      const seen = WN._readSeen(localStorage);
      if (seen == null || seen >= KEEPSKIP_SWAP_BUILD) return;
      // clearSel: an offer about Keep and Skip must leave Keep and Skip visible —
      // reading "Skip is on the right now" over a hidden pair defeats the sentence
      // (owner, 2026-08-07). It falls back to the usual foot placement when the row
      // isn't on screen (another tab) or won't fit above it (a short screen).
      OB.showChangeOffer(null, {
        key: OB.SWAP_OFFER_KEY,
        text: OB.copy.swapOfferText,
        clearSel: ".deck-buttons",
      });
    } catch (e) { /* an offer must never block the app */ }
  }

  // The unified passwordless sign-in / sign-up screen (Phase 2, AUTH_REDESIGN_DESIGN.md).
  // One action for both: enter your email, get a one-time code, and you're in — a new
  // invited address is created on first verify. The old split (renderLogin vs
  // renderFirstTime) and the account-password form are gone: with no password there's
  // nothing only a returning user could do. Email is the ONLY code channel — the drafted
  // Email/Text toggle was cut before shipping (owner 2026-08-01); the code itself, not
  // the channel, is what fixed the magic-link-bounces-to-Mail pain on a phone.
  function renderSignIn() {
    const reasonLine = GATE_REASON_LINES[_gateReason] || "";
    body().innerHTML = `
      <p class="auth-lead">Sign in to your Notebook</p>
      ${reasonLine ? `<p class="auth-sub auth-keep">${reasonLine}</p>` : ""}
      ${guestKeepLine()}
      <form id="signInForm" class="auth-form">
        <input type="email" id="signInContact" aria-label="Email address" placeholder="you@example.com" autocomplete="email" required>
        <button type="submit">Email me a code</button>
      </form>
      <div class="auth-or"><span>or</span></div>
      <div class="auth-providers">
        <button type="button" class="oauth-btn ghost" data-provider="google">Continue with Google</button>
      </div>
      <p id="authStatus" class="auth-status" role="status" aria-live="polite"></p>
      <p class="auth-sub muted">Invite-only for now — no invite yet? <button type="button" id="signInReq" class="linkish">Request access</button></p>
      ${window.AOTD_GUEST ? '<div class="auth-guest-back"><button type="button" id="guestBack" class="linkish">← Keep looking around</button></div>' : ""}`;
    body().querySelector("#signInForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const val = body().querySelector("#signInContact").value.trim();
      if (!val) return;
      await sendEmailCodeFlow(val);
    });
    body().querySelector("#signInReq").addEventListener("click", renderRequestAccess);
    maybeShowPasswordlessCue();
    body().querySelectorAll(".oauth-btn").forEach((b) =>
      b.addEventListener("click", async () => {
        setStatus("Redirecting…");
        try {
          // Full-page redirect to the provider; the session is picked up by boot()
          // when the browser comes back.
          await S.signInWithOAuth(b.getAttribute("data-provider"));
        } catch (err) {
          setStatus(isNetErr(err) ? NET_ERR_MSG
            : (err.message || "Could not start sign-in."), "error");
        }
      }));
    if (window.AOTD_GUEST) {
      const back = body().querySelector("#guestBack");
      if (back) back.addEventListener("click", closeGate);
    }
  }

  // Send the email OTP, then go straight to the code step (not "check your email" — the
  // code leads now; the link still works via boot as a fallback). An uninvited address is
  // rejected at send time by the invite hook and routed to request-access; net/rate errors
  // stay inline. Shared by renderSignIn and renderLinkFailed so the routing can't drift.
  async function sendEmailCodeFlow(email) {
    setStatus("Sending…");
    try {
      await S.sendMagicLink(email);
      renderCodeEntry(email);
    } catch (err) {
      const code = (err && (err.code || err.name) || "").toString();
      const msg = (err && err.message || "").toString();
      if (code === "otp_disabled" || isInviteRejection(msg)
          || /not allowed for otp|signups?\s+not\s+allowed/i.test(msg)) {
        renderSignupRejected();
      } else {
        setStatus(isNetErr(err) ? NET_ERR_MSG : (msg || "Could not send the code."), "error");
      }
    }
  }

  // The code step. Verify → session → afterSignedIn (setup or unlock). Resend re-sends;
  // "different email" returns to the form. autocomplete="one-time-code" lets the OS
  // surface the code above the keyboard (it reads emailed codes too, not just SMS).
  //
  // LENGTH IS NOT OURS TO FIX (found on staging 2026-08-01: Supabase was issuing EIGHT
  // digits against a `maxlength="6"` field, which silently truncated the code so verify
  // could never succeed). The digit count is a Supabase project setting, and staging and
  // prod are SEPARATE projects whose settings can drift — so the client accepts whatever
  // arrives (up to CODE_MAX) and the copy never promises a number it doesn't control.
  const CODE_MAX = 10;                 // Supabase's configurable OTP length tops out here
  function renderCodeEntry(contact) {
    body().innerHTML = `
      <p class="auth-lead">Enter your code</p>
      <p class="auth-sub">We emailed a code to <b>${esc(contact)}</b>. Enter it to sign in.</p>
      <form id="codeForm" class="auth-form">
        <input type="text" id="codeInput" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="${CODE_MAX}" aria-label="Sign-in code" placeholder="Your code" required>
        <button type="submit">Verify</button>
      </form>
      <div class="auth-links">
        <button type="button" id="codeResend" class="linkish">Resend code</button>
        <button type="button" id="codeChange" class="linkish">Use a different email</button>
      </div>
      <p id="authStatus" class="auth-status" role="status" aria-live="polite"></p>`;
    try { body().querySelector("#codeInput").focus(); } catch (e) { /* ok */ }
    // Keep only digits as you type. A code copied out of an email often brings a space
    // or a stray newline with it ("123 456"), and Supabase compares the token exactly —
    // so scrubbing here turns a paste that would have failed into one that just works.
    body().querySelector("#codeInput").addEventListener("input", (e) => {
      const el = e.target, cleaned = el.value.replace(/\D+/g, "");
      if (cleaned !== el.value) el.value = cleaned;
    });
    body().querySelector("#codeForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const token = body().querySelector("#codeInput").value.replace(/\D+/g, "");
      if (!token) return;
      setStatus("Verifying…");
      try {
        const session = await S.verifyEmailCode(contact, token);
        await afterSignedIn(session);
      } catch (err) {
        if (isNetErr(err)) { setStatus(NET_ERR_MSG, "error"); return; }
        setStatus("That code didn't work — check it, or resend a new one.", "error");
      }
    });
    body().querySelector("#codeResend").addEventListener("click", () => {
      sendEmailCodeFlow(contact);
    });
    body().querySelector("#codeChange").addEventListener("click", renderSignIn);
  }

  // Phase D — request-access path (locked decision 8). A guest without an invite
  // asks instead of hitting a wall: a small email (+ optional note) form that
  // POSTs to the public, rate-limited /api/access-request. The operator reviews
  // and invites by hand. We never confirm whether an email is already known, so
  // this can't be used to probe who has an account.
  function renderRequestAccess() {
    const prefill = (body().querySelector("#firstEmail")
      || body().querySelector("#loginEmail") || {}).value || "";
    body().innerHTML = `
      <p class="auth-lead">Request an invite</p>
      <p class="auth-sub">Music Forest is invite-only for now. Leave your email — we'll review it and send a sign-in link if you're invited. A short note about what drew you in helps.</p>
      <form id="reqForm" class="auth-form">
        <input type="email" id="reqEmail" aria-label="Email address" placeholder="you@example.com" autocomplete="email" required>
        <textarea id="reqNote" rows="3" maxlength="1000" aria-label="Anything you'd like to add (optional)" placeholder="Anything you'd like to add (optional)"></textarea>
        <button type="submit">Request access</button>
      </form>
      <div class="auth-links"><button type="button" id="reqBack" class="linkish">← Back</button></div>
      <p id="authStatus" class="auth-status" role="status" aria-live="polite"></p>`;
    const emailEl = body().querySelector("#reqEmail");
    if (prefill) emailEl.value = prefill;
    body().querySelector("#reqBack").addEventListener("click", renderSignIn);
    body().querySelector("#reqForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = emailEl.value.trim();
      const note = body().querySelector("#reqNote").value.trim();
      if (!email) return;
      setStatus("Sending…");
      try {
        const r = await fetch("/api/access-request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, note }),
        });
        if (r.status === 429) {
          setStatus("That's a few requests in a short time — please try again a little later.", "error");
          return;
        }
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { setStatus(d.error || "Could not send the request.", "error"); return; }
        body().innerHTML = `
          <p class="auth-lead">Thanks — request received</p>
          <p class="auth-sub">We've noted your interest in <b>${esc(email)}</b>. We review every request; if you're invited, you'll get an email with a sign-in link. There's nothing to do for now — keep looking around.</p>
          <div class="auth-links"><button type="button" id="reqDone" class="linkish">← Back</button></div>`;
        const done = body().querySelector("#reqDone");
        if (done) done.addEventListener("click", renderSignIn);
      } catch (err) {
        setStatus("Could not send the request — check your connection and try again.", "error");
      }
    });
  }

  // A failed auth return is CLASSIFIED, never assumed to be the invite gate. A
  // magic-link/OAuth return can fail for reasons that have nothing to do with the
  // gate — most often Supabase's own one-time-link expiry (error_code=otp_expired,
  // "Email link is invalid or has expired"). The gate's rejection is recognisable:
  // the hook (migration 0004) rejects with its own wording, and BOTH of its messages
  // say "invite" ("Music Forest is invite-only…" / "This email isn't invited…").
  // Supabase's expiry wording says "invalid"/"expired" and never "invite", so the
  // two don't overlap.
  //
  // Everything else must NOT borrow the not-invited screen. Telling an allow-listed
  // person whose link timed out that they aren't invited is false, and it dead-ends
  // them into request-access — a form the operator can only decline as redundant,
  // on a screen the operator never sees. An invited beta tester hit exactly this on
  // 2026-07-16: `type=invite` verify, so the hook had not even run (an emailed invite
  // creates the account at send time), yet the app blamed the invite list.
  // The invite gate's rejection, in EITHER of the hook's two wordings (migration
  // 0004): "Music Forest is invite-only…" and "This email isn't invited…". Matched on
  // the stem "invit" so both land — and so does a reword — while staying clear of
  // Supabase's expiry vocabulary ("invalid" / "expired"), which must never be read as
  // an accusation.
  //
  // ONE predicate, shared by the OAuth-return classifier below and sendLinkFlow's
  // send path. They used to test separately, and the send path's `not invited` missed
  // BOTH real messages ("isn't invited" doesn't contain "not invited"), so every gate
  // refusal there fell through to the raw provider string — no Request-access button,
  // printed under a form still offering a fresh link, in the sage "error" colour. The
  // return path was correct and tested; the send path was neither. Sharing this is
  // what keeps them from drifting apart again.
  function isInviteRejection(text) {
    return /invit/i.test((text == null ? "" : text).toString());
  }

  function classifyAuthError(e) {
    const code = ((e && e.code) || "").toString().toLowerCase();
    const desc = ((e && e.description) || "").toString();
    if (isInviteRejection(desc)) return "not-invited";
    if (code === "otp_expired" || /expired|invalid/i.test(desc)) return "link-expired";
    return "unknown";
  }

  // A one-time link that timed out or was already spent — and, for an unclassifiable
  // error, the same way back in. Says NOTHING about invite status: an emailed invite
  // creates the account at send time, so the account most likely already exists.
  // Offering a resend can't over-promise (BRAND: the front door tells the truth) —
  // sendLinkFlow still routes a genuinely uninvited email to renderSignupRejected.
  // `detail` carries the raw provider wording on the unknown branch only: the cause
  // is already named on the expired branch, and on 2026-07-16 the hash was scrubbed
  // (sync.js) before anyone could read it, which left a screenshot with no diagnosis
  // in it. A muted line means the next screenshot carries its own answer.
  // B33 / feedback #83: a beta tester whose invite link had expired asked the owner
  // for a new one instead of self-serving — the resend was here but didn't read as
  // THE thing to do. So lead with the ACTION ("Get a new sign-in link"), not the
  // problem; the expiry is demoted to the explanatory line beneath. The green submit
  // is already the visual hero; we also land the cursor in the field so the one thing
  // to do is immediate. Still honest per BRAND: says nothing about invite status, and
  // sendLinkFlow still routes a genuinely uninvited email to renderSignupRejected.
  function renderLinkFailed(kind, detail) {
    const expired = kind === "link-expired";
    body().innerHTML = `
      <p class="auth-lead">Get a new sign-in code</p>
      <p class="auth-sub">${expired
        ? "That link was one-time and has expired — sign-in links don't last long. Enter your email below and we'll send a fresh code right away."
        : "Sign-in didn't finish. Enter your email below and we'll send a fresh code right away."}</p>
      <form id="expForm" class="auth-form">
        <input type="email" id="expEmail" aria-label="Email address" placeholder="you@example.com" autocomplete="email" required>
        <button type="submit">Email me a new code</button>
      </form>
      ${detail ? `<p class="auth-sub muted">${esc(detail)}</p>` : ""}
      <div class="auth-links"><button type="button" id="expGuest" class="linkish">← Keep looking around</button></div>
      <p id="authStatus" class="auth-status" role="status" aria-live="polite"></p>`;
    body().querySelector("#expForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = body().querySelector("#expEmail").value.trim();
      if (!email) return;
      await sendEmailCodeFlow(email);
    });
    body().querySelector("#expGuest").addEventListener("click", enterGuest);
    try { body().querySelector("#expEmail").focus(); } catch (e) { /* ok */ }
  }

  // Shown when an OAuth/magic-link return failed because the invite gate (the
  // Before-User-Created hook) rejected an uninvited signup. Without this the user
  // would be dropped silently back into guest mode with no idea why sign-in did
  // nothing. Routes them to request-access, or back to looking around.
  function renderSignupRejected() {
    body().innerHTML = `
      <p class="auth-lead">You're not invited yet</p>
      <p class="auth-sub">Music Forest is invite-only for now, so that sign-in didn't create an account. You can request an invite — we'll review it and email you a sign-in link if you're in.</p>
      <div class="auth-form">
        <button type="button" id="rejReq">Request access</button>
      </div>
      <div class="auth-links"><button type="button" id="rejGuest" class="linkish">← Keep looking around</button></div>`;
    body().querySelector("#rejReq").addEventListener("click", renderRequestAccess);
    body().querySelector("#rejGuest").addEventListener("click", enterGuest);
  }

  // (sendLinkFlow and renderMagicLink removed in Phase 2 — sendEmailCodeFlow +
  // renderCodeEntry above are the single passwordless path; the invite-rejection
  // routing moved into sendEmailCodeFlow unchanged.)

  // The guest-context lines below still key renderSignIn's reason line. "Start a
  // journal" and the in-context invites
  // (why/note/keep) land here instead of the returning-user password form: a
  // first-timer's one working path is the emailed link, so it leads, with the
  // whole process spelled out before anything is asked. Mechanics are unchanged —
  // the same magic-link send as renderMagicLink, and an uninvited email is still
  // rejected at send time and routed to request-access, so nothing over-promises.
  // U18: the gate forks on intent, so the first-time screen names the intent
  // that brought a guest here — tapping Reflect and meeting a generic sign-up
  // screen reads as a wall; naming what they were about to do keeps it a door.
  // "start" (the header CTA) is already explicit intent and needs no echo.
  const GATE_REASON_LINES = {
    // A guest's writing is already written (buffered on-device — a note, a keep's
    // "why") — the gate's job is keeping it for good, not asking first.
    why: "Your why is kept on this device, riding along with the record — they'll arrive together.",
    note: "Your note is kept on this device for now — it'll be the first thing inside.",
    // #58: the durability pay-moment — the taste Notebook filled up (its ~10-note
    // cap). Honest and warm: you're keeping what you wrote, not unlocking a feature.
    "note-cap": "That's the last note this browser holds on its own. A Notebook keeps them synced, backed up, and yours for good.",
    // #58: the guest Notebook's "lives only in this browser" line.
    keep: "Your Notebook lives only in this browser right now — synced and backed up, it's yours for good.",
  };

  // (renderFirstTime removed in Phase 2 — renderSignIn is the one gate screen for both
  // sign-up and sign-in; its reason line uses GATE_REASON_LINES above.)

  // --- device-trust (biometric unlock) screens ------------------------------
  // After a passphrase unlock/setup, offer to enable a one-tap biometric unlock
  // on this device. Strictly opt-in; "Not now" is remembered so we don't nag.
  // The `current` secret is used once, here, to wrap a device-local copy of the
  // DEK (crypto.enrollDeviceEntry) — then it falls out of scope.
  async function maybeOfferDeviceTrust(current, dek) {
    try {
      if (window.AOTDDevice && _userId && await AOTDDevice.supported()
          && !(await AOTDDevice.has(_userId))
          && localStorage.getItem(declineKey()) !== "1") {
        renderDeviceOffer(current, dek);
        return;
      }
    } catch (e) { /* fall through to a normal unlock */ }
    await finishUnlock(dek);
  }

  function renderDeviceOffer(current, dek) {
    body().innerHTML = `
      <p class="auth-lead">Skip the password next time?</p>
      <p class="auth-sub">On this device, you can unlock with <b>Face ID, a fingerprint, or your passcode</b> instead of retyping your Notebook password. It stays on this device only — your password and recovery code keep working as before.</p>
      <p class="auth-sub muted">Only turn this on if the device is yours and locks itself.</p>
      <button type="button" id="devEnable">Enable quick unlock</button>
      <div class="auth-links"><button type="button" id="devSkip" class="linkish">Not now</button></div>
      <p id="authStatus" class="auth-status" role="status" aria-live="polite"></p>`;
    body().querySelector("#devEnable").addEventListener("click", async () => {
      const devEnable = body().querySelector("#devEnable");
      if (devEnable) devEnable.disabled = true;
      setStatus("Follow your device's prompt to confirm it's you…");
      try {
        const reg = await AOTDDevice.register({ userId: _userId, userName: _email || "journal" });
        // The slow part: the one-time key-stretch that secures the device copy of
        // your key (a few seconds — deliberately, so the key is hard to attack).
        // Tell the user why we're pausing and not to close the tab.
        setStatus("Securing your key for this device… this one-time step takes a few seconds — please keep this tab open.");
        const deviceEntry = await C.enrollDeviceEntry(_keyMaterial, current, reg.kekBytes);
        if (reg.kekBytes && reg.kekBytes.fill) reg.kekBytes.fill(0);
        await AOTDDevice.save(_userId, {
          credentialId: reg.credentialId, prfSalt: reg.prfSalt, deviceEntry });
        await finishUnlock(dek);
      } catch (err) {
        if (devEnable) devEnable.disabled = false;
        if (err && err.code === "UNSUPPORTED") {
          setStatus("This device can't do quick unlock — continuing with your password.", "error");
          setTimeout(() => finishUnlock(dek), 1600);
        } else {
          // Cancelled or failed: don't block entry, just don't enable.
          setStatus("Didn't enable quick unlock. You can turn it on later from the account menu.", "error");
          const skip = body().querySelector("#devSkip");
          if (skip) skip.textContent = "Continue";
        }
      }
    });
    body().querySelector("#devSkip").addEventListener("click", () => {
      try { localStorage.setItem(declineKey(), "1"); } catch (e) {}
      finishUnlock(dek);
    });
  }

  // FB#108: the one-shot "next tap raises the prompt" listener, when the browser
  // refused an unprompted attempt. Module-level because the element it hangs on
  // (.auth-card) outlives any single render — see the arming block below.
  let _armedGesture = null;
  function disarmGesture() {
    if (!_armedGesture) return;
    try { _armedGesture.el.removeEventListener("click", _armedGesture.fn, true); } catch (e) {}
    _armedGesture = null;
  }

  // `opts`: {postUpdate} — this render is finishing an update reload, which changes
  // the copy. (It used to be a positional `postUpdate` boolean; FB#108 needed a
  // second flag and two booleans in a row is how call sites get silently swapped.)
  function renderDeviceUnlock(rec, opts) {
    const postUpdate = !!(opts && opts.postUpdate);
    body().innerHTML = `
      <p class="auth-lead">${postUpdate ? "Almost done — unlock to finish updating" : "Unlock your Notebook"}</p>
      ${acctLine()}
      <p class="auth-sub" id="devSub">${postUpdate ? "Updating re-locked your Notebook. " : ""}Unlock the same way you unlock this device — Face ID, a fingerprint, or your passcode/PIN.</p>
      <div class="auth-form">
        <button type="button" id="devUnlock">Unlock with this device</button>
      </div>
      <details class="auth-more" id="devMore">
        <summary>Other options</summary>
        <div class="auth-links">
          <button type="button" id="devUsePass" class="linkish">Use Notebook password instead</button>
          <button type="button" id="devSignOut" class="linkish">Sign out</button>
          <button type="button" id="devForget" class="linkish danger">Forget this device</button>
        </div>
      </details>
      <p id="authStatus" class="auth-status" role="status" aria-live="polite"></p>`;
    // At the unlock gate we're locked = a cost-free moment to pull a pending update in
    // BEFORE you authenticate, so you unlock once straight into the new version. Kicking
    // the check here means a deploy that landed while backgrounded is confirmed during the
    // beat you're at the prompt; if it's already known, this reloads immediately.
    kickUpdateCheck();
    let done = false;                     // one unlock per render, whatever fired it
    const attempt = async (o) => {
      if (done) return true;
      setStatus("Waiting for this device to verify you…");
      try {
        const kek = await AOTDDevice.assert(rec);
        const dek = await C.unlockWithDeviceEntry(rec.deviceEntry, kek);
        if (kek && kek.fill) kek.fill(0);
        done = true;
        await finishUnlock(dek);
        return true;
      } catch (err) {
        // An AUTO attempt can be refused by the browser for lack of a fresh user
        // gesture — expected; fall back quietly, no alarming error. A user-driven
        // attempt gets the real message.
        if (o && o.auto) { setStatus(""); return false; }
        setStatus("Couldn't verify on this device. Try again, or use your password.", "error");
        // ...and put the password where that sentence points. The fallback lives in
        // "Other options" (owner 2026-08-02), which is right for the daily case but
        // would leave this message naming a control that isn't on screen — at the one
        // moment someone is already stuck. Opening on a REAL failure only: the silent
        // auto-attempt above returns before this, so a missing-gesture refusal after an
        // update never springs the panel open on a screen that is about to succeed.
        try { const m = body().querySelector("#devMore"); if (m) m.open = true; } catch (e) {}
        return false;
      }
    };
    const unlockBtn = body().querySelector("#devUnlock");
    unlockBtn.addEventListener("click", () => attempt());
    try { unlockBtn.focus(); } catch (e) {}

    // FB#108 (owner 2026-08-05: "it feels redundant"). If you've already told this
    // device you trust it, being asked to tap a button whose only job is to raise the
    // prompt you were going to answer anyway is a step that buys nothing. So try it
    // ourselves the moment the screen appears — on boot, on an idle re-lock, and after
    // an update (which is all this used to do).
    //
    // But WebAuthn wants transient user activation, and Safari enforces it: on iOS the
    // auto attempt is simply refused. Rather than ship a fix that does nothing there,
    // the refusal ARMS the whole card — the next tap anywhere on it raises the prompt.
    // So iOS goes from "find and hit the button" to "tap the screen", and Chrome and
    // desktop need no tap at all. The button stays put for anyone who reaches for it.
    //
    // AND WE HAVE TO SAY SO (owner, 2026-08-06: "is there a note to the user that they
    // should tap? or are they expected to just know?"). They were expected to just know,
    // which meant they wouldn't: the only thing that LOOKS tappable is the button, so an
    // iPhone reader would go on tapping the button exactly as before and the whole
    // fallback would never fire. An affordance nobody can see isn't one. So the copy
    // changes in the armed state — and only there, because on Chrome the screen unlocks
    // without a tap and an instruction to tap would be a lie.
    (async () => {
      if (await attempt({ auto: true })) return;
      const sub = body().querySelector("#devSub");
      const subWas = sub ? sub.textContent : null;
      if (sub) {
        // Plain, from the reader's side, and it names the act rather than the control
        // (BRAND.md). "anywhere" is true of the card: Other options is a separate
        // control they'd have to open deliberately, and the button does the same thing.
        sub.textContent = (postUpdate ? "Updating re-locked your Notebook. " : "") +
          "Tap anywhere to unlock — with Face ID, a fingerprint, or your passcode/PIN.";
      }
      // The arming is one-shot, so once it fires the line stops being true — put the
      // original wording back before the attempt, or a reader whose biometric failed
      // would be left staring at an instruction that no longer does anything.
      const restoreSub = () => { if (sub && subWas != null) sub.textContent = subWas; };
      // The card OUTLIVES this render — the gate element is built once and only
      // #authBody's innerHTML is swapped — so an armed listener would still be sitting
      // there after renderUnlock() replaced this screen with the passphrase form, and
      // a tap meant for that form would raise a biometric on it. Hence both: disarm any
      // previous arming before adding ours, and have the handler confirm the device
      // screen is still the one on show before it does anything.
      disarmGesture();
      const card = body().closest(".auth-card") || body();
      const onGesture = (ev) => {
        if (done || !body().querySelector("#devUnlock")) { disarmGesture(); return; }
        // Never hijack the escape hatches: "Other options" and everything inside it
        // must stay reachable, especially for someone whose biometric is failing.
        // The unlock button has its own handler — let that one run instead of two.
        if (ev.target.closest("#devMore, .auth-links, #devUnlock")) return;
        disarmGesture();
        restoreSub();
        attempt();
      };
      // Capture phase so a tap on inert copy (the lead, the account line) still counts;
      // the target check above is what keeps the real controls doing their own job.
      card.addEventListener("click", onGesture, true);
      _armedGesture = { el: card, fn: onGesture };
    })();

    body().querySelector("#devUsePass").addEventListener("click", renderUnlock);
    body().querySelector("#devForget").addEventListener("click", async () => {
      try { await AOTDDevice.clear(_userId); localStorage.removeItem(declineKey()); } catch (e) {}
      renderUnlock();
    });
    body().querySelector("#devSignOut").addEventListener("click", doSignOut);
  }

  function renderSetup() {
    body().innerHTML = `
      <p class="auth-lead">Set your Notebook password</p>
      ${acctLine()}
      <p class="auth-sub">This is the first time signing in to this account, so let's set the password that encrypts your Notebook. It encrypts everything in your browser — we never see it, and we can't reset it for you. Choose something strong you'll remember.</p>
      <form id="setupForm" class="auth-form">
        <input type="password" id="pass1" aria-label="Password" placeholder="Password" autocomplete="new-password" required minlength="8">
        <input type="password" id="pass2" aria-label="Confirm password" placeholder="Confirm password" autocomplete="new-password" required minlength="8">
        <button type="submit">Continue</button>
      </form>
      <div class="auth-links"><button type="button" id="setupSignOut" class="linkish">Not you? Sign out</button></div>
      <p id="authStatus" class="auth-status" role="status" aria-live="polite"></p>`;
    body().querySelector("#setupForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const p1 = body().querySelector("#pass1").value;
      const p2 = body().querySelector("#pass2").value;
      if (p1.length < 8) return setStatus("Use at least 8 characters.", "error");
      if (p1 !== p2) return setStatus("The two passwords don't match.", "error");
      renderRecovery(p1);
    });
    body().querySelector("#setupSignOut").addEventListener("click", doSignOut);
  }

  function renderRecovery(passphrase) {
    const code = C.generateRecoveryCode();
    body().innerHTML = `
      <p class="auth-lead">Save your recovery code</p>
      <p class="auth-sub">If you ever forget your password, this is the <b>only</b> way back into your Notebook. Store it somewhere safe and private. It won't be shown again.</p>
      <div class="recovery-code" id="recoveryCode">${esc(code)}</div>
      <div class="recovery-actions">
        <button type="button" id="copyCode" class="ghost">Copy</button>
        <button type="button" id="downloadCode" class="ghost">Download</button>
      </div>
      <label class="auth-ack"><input type="checkbox" id="ackSaved"> I've saved my recovery code somewhere safe</label>
      <button type="button" id="finishSetup" disabled>Start exploring</button>
      <p id="authStatus" class="auth-status" role="status" aria-live="polite"></p>`;
    const ack = body().querySelector("#ackSaved");
    const finish = body().querySelector("#finishSetup");
    ack.addEventListener("change", () => { finish.disabled = !ack.checked; });
    body().querySelector("#copyCode").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(code); setStatus("Copied to clipboard."); }
      catch (e) { setStatus("Copy failed — select the code and copy manually.", "error"); }
    });
    body().querySelector("#downloadCode").addEventListener("click", () => {
      const blob = new Blob([
        "Music Forest — recovery code\n\n" + code +
        "\n\nKeep this private. It can unlock and reset access to your encrypted Notebook.\n"],
        { type: "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      // Feedback #29b: Music Forest branding, not the old "aotd-" prefix.
      a.download = "music-forest-recovery-code.txt";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
    finish.addEventListener("click", async () => {
      finish.disabled = true;
      setStatus("Encrypting…");
      try {
        const { keyMaterial, dek } = await C.createIdentity(passphrase, code);
        await S.putKeys(keyMaterial);
        _keyMaterial = keyMaterial;
        // Fresh account: take them straight into the app to explore. We deliberately
        // do NOT offer quick unlock here — it was a wordy wall right when they expected
        // to start, and going idle on it timed out the passkey prompt. It's offered
        // instead on the next visit's password unlock (renderUnlock), the natural
        // "skip retyping next time?" moment. And reset the once-per-device tour flag so
        // a genuine first login gets the guided cues even on a device that already saw
        // them as a guest (the tour is (re)started on the aotd:unlocked event in app.js).
        try { window.AOTDOnboarding && window.AOTDOnboarding.resetTour && window.AOTDOnboarding.resetTour(); } catch (e) {}
        // ...and SKIP the "What is this?" welcome for a fresh account. Sign-ups are
        // invite-only, so anyone finishing setup arrived from the invite email —
        // which IS the field guide, in full. Meeting a card that re-explains
        // "records released on this date, any year" two minutes after they read
        // exactly that is a wall between them and the records they were promised
        // (owner, 2026-07-16, on the live invite flow). markSeen (not resetTour's
        // opposite) also stops it ambushing them on the next visit.
        // The TOUR still runs — the email explicitly promises it ("a short
        // walk-through points out how everything works"), and unlike the welcome it
        // points at real controls instead of restating the pitch. It fires off the
        // aotd:unlocked event below, which never depended on the welcome's onStart.
        try { window.AOTDOnboarding && window.AOTDOnboarding.markSeen && window.AOTDOnboarding.markSeen(); } catch (e) {}
        await finishUnlock(dek);
      } catch (err) {
        finish.disabled = false;
        setStatus(err.message || "Setup failed.", "error");
      }
    });
  }

  function renderUnlock(opts) {
    // FB#108: leaving the device screen (Use password / Forget this device, or a
    // fresh lock) retires its armed tap. The handler self-checks too, but that would
    // leave it hanging around until someone happened to tap.
    disarmGesture();
    const postUpdate = opts && opts.postUpdate;
    body().innerHTML = `
      <p class="auth-lead">${postUpdate ? "Almost done — unlock to finish updating" : "Unlock your Notebook"}</p>
      ${acctLine()}
      ${postUpdate ? '<p class="auth-sub">Updating re-locked your Notebook — your password is never stored.</p>' : ""}
      <form id="unlockForm" class="auth-form">
        <input type="password" id="unlockPass" aria-label="Notebook password" placeholder="Notebook password" autocomplete="off" required>
        <button type="submit">Unlock</button>
      </form>
      <div class="auth-links">
        <button type="button" id="useRecovery" class="linkish">Use recovery code</button>
        <button type="button" id="forgotPass" class="linkish">Forgot Notebook password?</button>
        <button type="button" id="signOutBtn" class="linkish">Sign out</button>
      </div>
      <p id="authStatus" class="auth-status" role="status" aria-live="polite"></p>`;
    try { body().querySelector("#unlockPass").focus(); } catch (e) {}
    kickUpdateCheck();   // locked at the gate = pull a pending update in first (autoReloadSafe
                         // still holds it back once you've typed part of your password)
    body().querySelector("#unlockForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const pass = body().querySelector("#unlockPass").value;
      setStatus("Unlocking…");
      try {
        const dek = await C.unlockWithPassphrase(_keyMaterial, pass);
        await maybeOfferDeviceTrust({ via: "passphrase", secret: pass }, dek);
      } catch (err) {
        setStatus("That password didn't work.", "error");
      }
    });
    body().querySelector("#useRecovery").addEventListener("click", renderRecoveryUnlock);
    body().querySelector("#forgotPass").addEventListener("click", renderRecoveryReset);
    body().querySelector("#signOutBtn").addEventListener("click", doSignOut);
  }

  function renderRecoveryUnlock() {
    body().innerHTML = `
      <p class="auth-lead">Unlock with your recovery code</p>
      <p class="auth-sub">Enter the recovery code you saved at signup.</p>
      <form id="recForm" class="auth-form">
        <input type="text" id="recCode" aria-label="Recovery code" placeholder="XXXXX-XXXXX-…" autocomplete="off" required>
        <button type="submit">Unlock</button>
      </form>
      <div class="auth-links"><button type="button" id="backToUnlock" class="linkish">Back</button></div>
      <p id="authStatus" class="auth-status" role="status" aria-live="polite"></p>`;
    body().querySelector("#recForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = body().querySelector("#recCode").value;
      setStatus("Unlocking…");
      try {
        const dek = await C.unlockWithRecovery(_keyMaterial, code);
        await finishUnlock(dek);
      } catch (err) {
        setStatus("That recovery code didn't work.", "error");
      }
    });
    body().querySelector("#backToUnlock").addEventListener("click", renderUnlock);
  }

  function renderRecoveryReset() {
    body().innerHTML = `
      <p class="auth-lead">Reset your password</p>
      <p class="auth-sub">Enter your recovery code and choose a new password. Your Notebook is re-keyed in place — nothing needs re-encrypting.</p>
      <form id="resetForm" class="auth-form">
        <input type="text" id="resetCode" aria-label="Recovery code" placeholder="Recovery code" autocomplete="off" required>
        <input type="password" id="resetPass1" aria-label="New password" placeholder="New password" autocomplete="new-password" required minlength="8">
        <input type="password" id="resetPass2" aria-label="Confirm new password" placeholder="Confirm new password" autocomplete="new-password" required minlength="8">
        <button type="submit">Set new password</button>
      </form>
      <div class="auth-links"><button type="button" id="backToUnlock2" class="linkish">Back</button></div>
      <p id="authStatus" class="auth-status" role="status" aria-live="polite"></p>`;
    body().querySelector("#resetForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = body().querySelector("#resetCode").value;
      const p1 = body().querySelector("#resetPass1").value;
      const p2 = body().querySelector("#resetPass2").value;
      if (p1.length < 8) return setStatus("Use at least 8 characters.", "error");
      if (p1 !== p2) return setStatus("The two passwords don't match.", "error");
      setStatus("Resetting…");
      try {
        const { keyMaterial, dek } = await C.changePassphrase(
          _keyMaterial, { via: "recovery", secret: code }, p1);
        await S.putKeys(keyMaterial);
        _keyMaterial = keyMaterial;
        await finishUnlock(dek);
      } catch (err) {
        setStatus("That recovery code didn't work.", "error");
      }
    });
    body().querySelector("#backToUnlock2").addEventListener("click", renderUnlock);
  }

  // --- unlock / lock lifecycle ----------------------------------------------
  async function finishUnlock(dek) {
    _store = J.createStore({
      crypto: C, sync: S,
      // FB#107: the per-user encrypted-row cache (journal-cache.js). Absent → the
      // store behaves exactly as before. onChange fires when a background reconcile
      // brought in changes (e.g. a write from another device) so the Notebook, if
      // it's already on screen, re-renders.
      cache: window.AOTDJournalCache,
      userId: _userId,
      onChange: () => document.dispatchEvent(new CustomEvent("aotd:journal-updated")),
    });
    _store.setKey(dek);
    window.AOTDStore = _store;
    window.AOTD_KEY_MATERIAL = _keyMaterial;
    // Tear down any guest scaffolding now that we're a full user (no-op if the
    // session arrived via a redirect, where guest mode was never entered).
    if (window.AOTD_GUEST) leaveGuest();
    // P4 (signed-in reveal): drop the veil NOW so today's records — already fetched
    // by init()'s /api/pool/day — show immediately, instead of waiting for the whole
    // journal to pull + decrypt (a cold-server round-trip that made first open take
    // ~20s). The Argon2id unlock already happened (we hold the DEK). The journal
    // hydrates in the background (hydrateJournal): the store's write-gate holds any
    // choice/note made meanwhile until loadAll repopulates, and Remember/Explore await
    // the store (store-bridge whenReady) so they show their loading state, never a
    // false-empty shelf.
    hide();
    revealApp();
    startIdleWatch();
    if (window.AOTD_HOSTED) mountAccountMenu();   // header chrome — needs no journal data
    hydrateJournal();
  }

  // Pull + decrypt the journal AFTER the app is already visible (P4). On success fold
  // any buffered guest writes and fire aotd:unlocked so the journal surfaces render.
  // On failure (a cold-server hiccup) loadAll's whenReady rejects, so a Remember/Explore
  // visit shows "couldn't load" (never a false-empty journal) and a page reload retries
  // the whole unlock — strictly better than the old behavior, where a loadAll failure
  // left the ENTIRE app behind the veil. Never blocks Choose.
  let _hydrating = false;
  async function hydrateJournal() {
    if (!_store || _store.ready() || _hydrating) return;
    _hydrating = true;
    try {
      await _store.loadAll();
      // Phase D: fold buffered guest picks + F26 reflections into the now-loaded
      // journal. Buffer-driven (survives an OAuth redirect that dropped AOTD_GUEST)
      // and idempotent (deduped by id), so safe to attempt on every unlock — a no-op
      // when empty, self-healing if a prior attempt was skipped. Best-effort.
      try {
        if (window.AOTDBridge && window.AOTDBridge.migrateGuestBuffer) {
          await window.AOTDBridge.migrateGuestBuffer();
        }
      } catch (e) {
        console.error("guest buffer migration failed; buffer preserved", e);
      }
      document.dispatchEvent(new CustomEvent("aotd:unlocked", { detail: { store: _store } }));
    } catch (err) {
      console.error("journal load failed; Today stays usable, a reload retries", err);
    } finally {
      _hydrating = false;
    }
  }

  // FB#92/#104 (root cause, found 2026-08-04): the idle lock dropped you on the
  // PASSWORD screen even with Quick unlock enabled. Only afterSignedIn — the BOOT
  // path — ever looked for a device-trust record, so a fresh page load offered the
  // biometric and an idle re-lock never did. On a phone the app usually isn't
  // re-booting: the PWA stays alive in the background, you come back after the idle
  // timer has fired (15 minutes at the time; 6 hours since 2026-08-04, which is most
  // of why this stopped being a daily annoyance), and what you meet is the
  // passphrase form. Hence
  // "something is happening that I reopen the app and it prompts me for my notebook
  // password instead of quick unlock."
  //
  // Same branch as afterSignedIn now: offer the device first when it's enrolled, with
  // the passphrase still one tap away under "Other options". Rendering the passphrase
  // form FIRST and swapping it for the device screen (rather than awaiting the
  // IndexedDB read before showing anything) keeps the lock instant — the journal key
  // is already gone from memory by then, so there's no window where a locked notebook
  // looks unlocked.
  //
  // FB#108 note: renderDeviceUnlock now auto-raises the prompt, and that INCLUDES this
  // path. The worry about doing so on an idle re-lock was that a biometric firing the
  // instant you glance back reads as the app grabbing at you rather than you reaching
  // for it. The gesture-armed design settles it: where the browser demands activation
  // (iOS) nothing happens until you touch the screen, and where it doesn't, the prompt
  // is answering the same intent as on boot — you came back to a locked notebook. Esc /
  // cancel still lands on this screen with the passphrase one tap away, so it costs
  // nothing to ignore.
  function lock() {
    stopIdleWatch();
    if (_store) { try { _store.clear(); } catch (e) {} }
    window.AOTDStore = null;
    document.dispatchEvent(new CustomEvent("aotd:locked"));
    hideApp();
    renderUnlock();
    show();
    deviceRecord().then((rec) => {
      // Only if the passphrase screen is still what's up — someone who started typing
      // (or reached for the recovery code) must not have the screen yanked from under
      // them mid-unlock.
      if (rec && body().querySelector("#unlockForm")) renderDeviceUnlock(rec);
    }).catch(() => { /* no device record, or storage blocked: the passphrase stands */ });
  }

  async function doSignOut() {
    stopIdleWatch();
    if (_store) {
      // FB#107: leaving the account wipes the local encrypted cache (Delete account
      // routes through here too). Lock does NOT — see wipeCache in journal-store.js.
      try { await _store.wipeCache(); } catch (e) {}
      try { _store.clear(); } catch (e) {}
    }
    _store = null; _keyMaterial = null; _email = null; window.AOTDStore = null;
    unmountAccountMenu();
    await S.signOut();
    hideApp();
    renderSignIn();
    show();
  }

  // --- idle auto-lock (ALWAYS ON, 6 hours; see DEFAULT_IDLE_MS) ---------------
  // (The heading used to say "off by default". It never was — idleMs() always returns
  // a positive timeout. Corrected 2026-08-06.)
  function startIdleWatch() {
    stopIdleWatch();
    const ms = idleMs();
    // Defensive only: idleMs() cannot currently return a falsy value, so this never
    // fires. Kept so that if a real "off" setting is ever added, it attaches nothing
    // at all — no timer and no mousemove/scroll listeners for the life of the session —
    // rather than a huge timeout that is there and never fires.
    if (!ms) return;
    const reset = () => {
      clearTimeout(_idleTimer);
      _idleTimer = setTimeout(lock, ms);
    };
    startIdleWatch._reset = reset;
    ["mousemove", "keydown", "click", "scroll", "touchstart", "visibilitychange"].forEach((ev) =>
      window.addEventListener(ev, reset, { passive: true }));
    reset();
  }
  function stopIdleWatch() {
    clearTimeout(_idleTimer);
    if (startIdleWatch._reset) {
      ["mousemove", "keydown", "click", "scroll", "touchstart", "visibilitychange"].forEach((ev) =>
        window.removeEventListener(ev, startIdleWatch._reset));
      startIdleWatch._reset = null;
    }
  }

  // --- libsodium (Argon2id KDF), lazy — off the guest critical path (P4) ------
  // The WASM core is a large CDN blob that's costly to fetch+compile on a first
  // visit with no SW cache. A GUEST needs none of it — the crypto only runs at
  // sign-in/unlock — so we no longer await it before revealing Choose. This
  // memoized helper brings it up on first demand (afterSignedIn, and every unlock
  // or create screen sits downstream of that) and is warmed in the background once
  // a guest lands, so a later sign-in doesn't pay the compile at that moment.
  let _sodiumReady = null;
  function ensureSodium() {
    if (_sodiumReady) return _sodiumReady;
    _sodiumReady = (async () => {
      if (typeof sodium === "undefined" || !sodium.ready) {
        throw new Error("libsodium failed to load (check the CDN <script> + SRI)");
      }
      await sodium.ready;
      C.bindLibsodium(sodium);
    })();
    return _sodiumReady;
  }

  // --- boot ------------------------------------------------------------------
  async function boot() {
    try {
      const cfg = await S.initSupabase();
      if (!cfg.configured) {
        window.AOTD_HOSTED = false;   // single-user local mode — no gate
        revealApp();
        document.dispatchEvent(new CustomEvent("aotd:local-mode"));
        return;
      }
      window.AOTD_HOSTED = true;
      // Cold-start warm-up. The API runs on a tier that sleeps when idle, so the
      // first server hit — the /api/sync row pull at unlock — can stall 30–60s
      // while the instance wakes. Fire a throwaway request at the earliest point
      // in boot so the server wakes *while* the Argon2id WASM loads and the user
      // reads/types; by unlock it's already up. Fire-and-forget, no-store so the
      // SW (which hands /healthz off) and the HTTP cache both stay out of it.
      // MUST be a CHEAP endpoint: /healthz (~111 bytes) warms the exact path
      // unlock needs — catalog (day_count) + Postgres store (ping). It replaced
      // /api/today, which builds and ships ALL of today's albums (8+ MB on a busy
      // date) only to be discarded here — pure waste that helped topple the
      // 0.5-vCPU box under an app-open burst (owner, on-device 2026-07-04).
      try { fetch("/healthz", { cache: "no-store" }).catch(() => {}); } catch (e) {}
      const session = cfg.session || await S.currentSession();
      // Onboarding Phase A: no session → enter guest mode (try before account),
      // not the login wall. renderLogin stays reachable via the guest entry / the
      // in-context invites (showGate). A refresh has no session, so it re-enters
      // guest — no forced login.
      // Exception: if this is an OAuth/magic-link *return* that failed, don't
      // silently drop to guest — explain it. Which explanation depends on WHY it
      // failed (classifyAuthError): only the invite gate's own rejection may claim
      // "not invited"; an expired link gets a resend, never an accusation.
      if (!session) {
        if (cfg.authError) {
          show();
          const kind = classifyAuthError(cfg.authError);
          if (kind === "not-invited") renderSignupRejected();
          else renderLinkFailed(kind, kind === "unknown"
            ? (cfg.authError.description || cfg.authError.code || "") : "");
          return;
        }
        // P4: a guest needs neither the sign-in flow past here NOR the Argon2id
        // WASM to see today's records — the crypto only runs at sign-in/unlock. Reveal
        // Today immediately (enterGuest drops the veil) and warm the KDF in the
        // background so a later sign-in doesn't pay the fetch+compile at that
        // moment. No "Starting up…" gate, no WASM wait on the guest critical path.
        enterGuest();
        ensureSodium().catch(() => {});
        // Deep-link: the field guide's "Enter Music Forest" (/?start) opens the sign-in
        // flow right away instead of dropping an invited person onto the guest page —
        // they arrive wanting to sign in, not browse. Still a door: dismissible back to
        // guest ("Keep looking around"). Strip the param so a refresh doesn't re-force it.
        try {
          if (new URLSearchParams(location.search).has("start")) {
            showGate("start");
            history.replaceState({}, "", location.pathname);
          }
        } catch (e) {}
        return;
      }
      // FB#108: with Quick unlock on, go straight to the native prompt — nothing of
      // ours renders first. Only if that doesn't land do we show the gate at all.
      if (await tryInstantDeviceUnlock(session)) return;
      // Signed-in: unlocking needs the KDF, so bring it up now behind the gate's
      // "Starting up…" (afterSignedIn awaits ensureSodium) while the encrypted
      // rows are fetched.
      show();
      renderLoading("Starting up…");
      await afterSignedIn(session);
    } catch (err) {
      show();
      // A deploy swaps Render's instance and the origin 502s for ~27s (B30) — that's
      // "restarting," not "broken." Show a calm updating state for a gateway 5xx or a
      // bare network drop (a fetch TypeError has no .status); anything else is a real
      // fault and keeps the honest message + code.
      const code = err && err.status;
      const transient = code === 502 || code === 503 || code === 504 ||
        (err instanceof TypeError);
      body().innerHTML = transient
        ? `<p class="auth-lead">Just a moment</p>
           <p class="auth-sub">Music Forest is restarting — this usually takes a few
             seconds. Reload to try again.</p>
           <button type="button">Reload</button>`
        : `<p class="auth-lead">Something went wrong</p>
           <p class="auth-sub error">${esc(err.message || String(err))}</p>
           <button type="button">Reload</button>`;
      // addEventListener, not an inline onclick: script-src has no 'unsafe-inline', so
      // the old onclick="location.reload()" was silently dead under the enforced CSP —
      // a broken Reload on the very screen that most needs it.
      const rb = body().querySelector("button");
      if (rb) rb.addEventListener("click", () => location.reload());
    }
  }

  // --- journal export (backup / portability, BETA_PLAN §8) ------------------
  // Build the plaintext export from the decrypted in-memory journal and download
  // it. The server only holds ciphertext, so this is the one place a readable
  // backup can be produced — entirely in the browser, after unlock.
  function exportJournal(triggerEl) {
    const store = window.AOTDStore;
    if (!store || store.locked()) { alert("Unlock your Notebook first."); return; }
    const orig = triggerEl ? triggerEl.textContent : null;
    try {
      const data = store.exportData();
      const counts = (data.notes.length) + (data.choices.length) +
        (data.trails.length) + (data.platform_marks.length);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      // Feedback #29b: Music Forest branding, not the old "aotd-" prefix.
      a.download = "music-forest-notebook-" + new Date().toISOString().slice(0, 10) + ".json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      // Feedback #29a: the in-button "✓ Exported" went unnoticed on mobile. A toast is
      // the app's standard, more visible confirmation; the button text stays as a
      // secondary cue.
      if (window.showToast) window.showToast("✓ Notebook exported (" + counts + " rows)");
      if (triggerEl) {
        triggerEl.textContent = "✓ Exported (" + counts + " rows)";
        setTimeout(() => { triggerEl.textContent = orig; }, 2500);
      }
    } catch (e) {
      alert("Export failed: " + (e && e.message || e));
      if (triggerEl) triggerEl.textContent = orig;
    }
  }

  // --- delete account (irreversible, GDPR/CCPA erasure) ---------------------
  // The user-facing side of DELETE /api/sync/account. Warns hard, nudges an
  // export first (the only readable backup lives here in the browser), requires
  // the user to type DELETE, then erases the account server-side and tears down
  // every device-local trace (device-trust record, decline marker, the in-memory
  // journal) before returning to the login screen. The server independently
  // demands the same {confirm:"DELETE"} guard, so a stray call can't wipe an
  // account.
  async function deleteAccountFlow(triggerEl) {
    if (!confirm(
        "Delete your account?\n\n" +
        "This permanently erases your encrypted Notebook — every note, keep, " +
        "trail, and mark — and cannot be undone. If you want to keep a copy, " +
        "cancel and use “Export Notebook (backup)” first.")) return;
    const typed = prompt(
      "This cannot be undone. Type DELETE to permanently erase your account:");
    if (!typed || typed.trim().toUpperCase() !== "DELETE") {
      if (typed !== null) alert("Account not deleted — the confirmation didn’t match.");
      return;
    }
    const orig = triggerEl ? triggerEl.textContent : null;
    if (triggerEl) { triggerEl.disabled = true; triggerEl.textContent = "Deleting…"; }
    try {
      const res = await S.deleteAccount();
      // Wipe device-local traces of this account before signing out.
      try { if (window.AOTDDevice && _userId) await AOTDDevice.clear(_userId); } catch (e) {}
      try { localStorage.removeItem(declineKey()); } catch (e) {}
      const pending = res && res.auth_user_deleted === false;
      await doSignOut();   // clears the in-memory journal, signs out, unmounts the menu
      alert("Your account has been deleted." + (pending
        ? "\n\nYour Notebook data is erased. Your sign-in record will be removed shortly."
        : ""));
    } catch (e) {
      if (triggerEl) { triggerEl.disabled = false; triggerEl.textContent = orig; }
      alert("Delete failed: " + ((e && e.message) || e) + "\n\nYour account was NOT deleted.");
    }
  }


  // --- check for app updates from the account menu --------------------------
  // The PWA caches its own code (service worker), and the running page keeps that
  // code until a reload — so there's no "pull to refresh" (a reload also drops the
  // in-memory key, by design: BETA_PLAN §3). This lets the user pull an update on
  // demand: ask the service worker to re-check, and only offer a reload when a new
  // version actually installed — so you never reload (and re-unlock) for nothing.
  //
  // Note on the reload: it keeps you signed in (the account session persists) but
  // re-locks the journal, since the key lives only in memory. With Quick unlock on
  // that's a single Face ID / fingerprint tap; otherwise it's the encryption
  // password. We never persist the key to skip this — that would defeat
  // encryption-at-rest.

  // Apply a pending update by reloading — but only once the NEW worker actually
  // controls this page. sw.js serves shell assets cache-first, so a bare
  // location.reload() fired while the OLD worker still controls hands back the
  // stale cached app.js: you get the new index.html but old code, and have to
  // update a second time (owner, on-device 2026-07-04: "I had to update the app
  // twice ... the first reload left me on v85"). Waiting for controllerchange
  // guarantees the new cache is in charge before we navigate.
  function applyUpdateAndReload() {
    // Mark this as an update reload (one-shot, non-sensitive) so the re-unlock
    // screen frames it as *finishing the update* and jumps to Quick unlock.
    try { sessionStorage.setItem("aotd_post_update", "1"); } catch (e) {}
    if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) {
      location.reload();
      return;
    }
    let done = false;
    const go = () => { if (!done) { done = true; location.reload(); } };
    navigator.serviceWorker.getRegistration().then((reg) => {
      const pending = reg && (reg.waiting || reg.installing);
      if (!pending) { go(); return; }   // the new worker already controls — safe now
      navigator.serviceWorker.addEventListener("controllerchange", go);
      // sw.js auto-skipWaits + claims, but nudge a still-waiting worker along and
      // fall back to a plain reload if control never changes hands.
      try { pending.postMessage({ type: "SKIP_WAITING" }); } catch (e) {}
      setTimeout(go, 4000);
    }).catch(go);
  }

  async function checkForUpdatesFlow(triggerEl) {
    if (!triggerEl) return;
    const orig = triggerEl.dataset.orig || triggerEl.textContent;
    triggerEl.dataset.orig = orig;
    const reset = (txt, hold) => {
      triggerEl.textContent = txt;
      triggerEl.disabled = false;
      if (hold) setTimeout(() => { triggerEl.textContent = orig; }, hold);
    };
    // If an update is already known to be ready (glow on — set here or by the
    // passive watcher), this button's job is to APPLY it (reload), not re-check.
    // Re-checking finds "nothing newer" — the new worker already activated via
    // skipWaiting — and wrongly reports "up to date", then reverts to "Update
    // ready": the cycle the user hit, where the update never actually landed.
    if (_updateReady) {
      // Final guard against the deploy's instance-swap window: confirm the host is
      // answering before we reload, so a reload can't land on a 502.
      triggerEl.disabled = true;
      triggerEl.textContent = "Checking host…";
      const live = await fetchServerVersion();
      if (live == null) { reset("Still rolling out — try again shortly", 3500); return; }
      reset(orig);
      var ok = confirm(
        "Reload now to use the new version?\n\n" +
        "You'll stay signed in; your Notebook just re-locks — one tap with Quick " +
        "unlock, otherwise your Notebook password.");
      if (ok) applyUpdateAndReload();
      return;
    }
    if (!("serviceWorker" in navigator)) {
      reset("Updates not supported here", 2500);
      return;
    }
    triggerEl.disabled = true;
    triggerEl.textContent = "Checking…";
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) { reset("Updates unavailable", 2500); return; }

      // A new worker may already be installed and waiting from an earlier check.
      // Otherwise, watch for one arriving during this update() call. We require an
      // existing controller so a first-ever install isn't mistaken for an update.
      const controlled = !!navigator.serviceWorker.controller;
      const updateReady = new Promise((resolve) => {
        if (reg.waiting && controlled) { resolve(true); return; }
        const onFound = () => {
          const w = reg.installing;
          if (!w) return;
          w.addEventListener("statechange", () => {
            // sw.js calls skipWaiting(), so a new worker goes installed →
            // activating → activated; "installed" with a live controller is the
            // earliest reliable "a newer version is here" signal.
            if ((w.state === "installed" || w.state === "activated") && controlled) {
              resolve(true);
            }
          });
        };
        reg.addEventListener("updatefound", onFound, { once: true });
        setTimeout(() => resolve(!!reg.waiting && controlled), 7000);  // safety net
      });

      await reg.update();              // ask the browser to re-check now
      const swReady = await updateReady;
      // The SW seeing new bytes isn't enough — on Render that can be mid-deploy.
      // Only call it ready when the host itself confirms a *different, live*
      // version (deploy finished); a 502/timeout means "still rolling out".
      const serverNew = await serverHasNewVersion();

      if (serverNew) {
        setUpdateGlow(true);
        triggerEl.textContent = "Update ready";
        const ok = confirm(
          "A new version of Music Forest is ready.\n\n" +
          "Reload now to use it? You'll stay signed in, but your Notebook will " +
          "re-lock — a single tap if Quick unlock is on, otherwise your " +
          "Notebook password.");
        if (ok) { applyUpdateAndReload(); return; }
        reset("Update ready — reload when you like", 3000);
      } else if (swReady) {
        // A new build exists but the host isn't serving it everywhere yet.
        reset("New version is still rolling out — try again shortly", 3500);
      } else {
        reset("✓ You're up to date", 2500);
      }
    } catch (e) {
      reset("Check failed — try again", 2500);
    }
  }

  // --- manage device-trust (biometric unlock) from the account menu --------
  // Shows current state for THIS device and lets the user turn it on or off.
  // Enabling here needs the Notebook password again (the live DEK is non-
  // extractable, so a fresh device copy is wrapped from the password); turning it
  // off just clears the local record.
  async function deviceTrustFlow() {
    const ov = document.createElement("div");
    ov.className = "auth-gate";
    ov.innerHTML = '<div class="auth-card"><div class="auth-brand">Quick unlock</div>' +
      '<div id="devmgrBody"><p class="auth-sub">Checking this device…</p></div></div>';
    document.body.appendChild(ov);
    const close = () => { try { ov.remove(); } catch (e) {} };
    const bodyEl = ov.querySelector("#devmgrBody");
    const st = (msg, kind) => {
      const el = ov.querySelector("#devmgrStatus");
      if (el) { el.textContent = msg || ""; el.className = "auth-status" + (kind ? " " + kind : ""); }
    };
    const supported = window.AOTDDevice && await AOTDDevice.supported();
    const enrolled = supported && _userId && await AOTDDevice.has(_userId);

    if (!supported) {
      bodyEl.innerHTML = '<p class="auth-sub">This browser or device can\'t do quick unlock ' +
        '(it needs a device lock like Face ID, Touch ID, Windows Hello, or a passcode/PIN, over a ' +
        'secure connection). You\'ll keep using your Notebook password here.</p>' +
        '<div class="auth-links"><button type="button" id="devmgrClose" class="linkish">Close</button></div>';
      ov.querySelector("#devmgrClose").addEventListener("click", close);
      return;
    }
    if (enrolled) {
      bodyEl.innerHTML = '<p class="auth-sub">Quick unlock is <b>on</b> for this device. ' +
        'Turning it off means you\'ll enter your Notebook password here again.</p>' +
        '<button type="button" id="devmgrOff">Turn off on this device</button>' +
        '<div class="auth-links"><button type="button" id="devmgrClose" class="linkish">Close</button></div>' +
        '<p id="devmgrStatus" class="auth-status"></p>';
      ov.querySelector("#devmgrOff").addEventListener("click", async () => {
        try {
          await AOTDDevice.clear(_userId);
          try { localStorage.removeItem(declineKey()); } catch (e) {}
          st("Turned off. This device will ask for your password next time.");
          setTimeout(close, 1400);
        } catch (err) { st("Couldn't turn it off.", "error"); }
      });
      ov.querySelector("#devmgrClose").addEventListener("click", close);
      return;
    }
    // Supported but not yet enabled: enable it (needs the Notebook password).
    bodyEl.innerHTML = '<p class="auth-sub">Enable a one-tap unlock on this device using Face ID, ' +
      'a fingerprint, or your passcode/PIN — whatever you use to unlock the device itself. Enter your ' +
      '<b>Notebook password</b> once to set it up — it stays on this device and never reaches the server.</p>' +
      '<form id="devmgrForm" class="auth-form">' +
      '<input type="password" id="devmgrPass" aria-label="Notebook password" placeholder="Notebook password" autocomplete="off" required>' +
      '<button type="submit">Enable quick unlock</button></form>' +
      '<div class="auth-links"><button type="button" id="devmgrClose" class="linkish">Cancel</button></div>' +
      '<p id="devmgrStatus" class="auth-status"></p>';
    ov.querySelector("#devmgrClose").addEventListener("click", close);
    ov.querySelector("#devmgrForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const pass = ov.querySelector("#devmgrPass").value;
      if (!pass) return;
      st("Checking your password…");
      try {
        // Verify the password unwraps the DEK before prompting for biometrics.
        const dek = await C.unlockWithPassphrase(_keyMaterial, pass);
        void dek;  // discard; we only needed to confirm the secret is correct
        st("Follow your device's prompt to confirm it's you…");
        const reg = await AOTDDevice.register({ userId: _userId, userName: _email || "journal" });
        st("Securing your key for this device… this one-time step takes a few seconds — please keep this open.");
        const deviceEntry = await C.enrollDeviceEntry(
          _keyMaterial, { via: "passphrase", secret: pass }, reg.kekBytes);
        if (reg.kekBytes && reg.kekBytes.fill) reg.kekBytes.fill(0);
        await AOTDDevice.save(_userId, {
          credentialId: reg.credentialId, prfSalt: reg.prfSalt, deviceEntry });
        try { localStorage.removeItem(declineKey()); } catch (e) {}
        st("Enabled. Next time, just use Face ID / fingerprint on this device.");
        setTimeout(close, 1600);
      } catch (err) {
        if (err && err.code === "UNSUPPORTED") st("This device can't do quick unlock.", "error");
        else st("That didn't work — check your password and try again.", "error");
      }
    });
  }

  // --- in-app account menu --------------------------------------------------
  // A small account button pinned to the top-right corner. Clicking it opens a
  // little menu showing the signed-in email + Sign out. Hosted mode only;
  // mounted once unlocked, removed on lock/sign-out. CSS hides it whenever a
  // modal ("hover page") is open, so it never sits over an album door or its ✕.
  let _acctMenu = null;
  // Whether a newer app version is sitting ready (installed but not yet running,
  // since applying it needs a reload). When true the ☰ button glows faintly — an
  // ambient, ignorable "there's an update when you want it" cue, not a nag: it
  // doesn't pop, badge a count, or block anything, and it clears only when you
  // reload to apply it (pull, not push).
  let _updateReady = false;
  function setUpdateGlow(on) {
    _updateReady = on;
    if (!_acctMenu) return;
    // #24/#26: one update treatment, not three. The ☰ carries a small flat dot
    // (a quiet "something's waiting", no bloom), and a single "Update ready — reload"
    // row appears at the top of the open menu. The Settings toggle and the in-Settings
    // "Check for updates" no longer light up — the top row is the whole signal.
    const b = _acctMenu.querySelector(".acct-btn");
    if (b) {
      b.classList.toggle("has-update", on);
      b.title = on ? "Account — an update is ready (open to reload)" : "Account";
    }
    const row = _acctMenu.querySelector(".acct-update-ready");
    if (row) row.classList.toggle("hidden", !on);
  }
  // --- deploy-aware version gate (so we never offer a reload into a 502) -------
  // The service worker fires "a newer worker is here" the instant the host serves
  // changed bytes — which on Render can be *mid-deploy*, while the old instance is
  // still being swapped out. Reloading then lands on a 502. So an SW signal is
  // only a hint; before we light the glow or reload, we confirm against the host
  // that a new version is actually, fully live by comparing the version this shell
  // booted with to GET /version. A 502/network error means "still deploying" and
  // is treated as not-ready, never as an update.
  let _runningVersion = null;          // the version of the code now running
  // The active shell's cache is named `forest-shell-<VERSION>` (see sw.js), so the
  // running version is readable without trusting the network (which may already be
  // serving the *new* build while this page still runs the old cached one).
  async function runningShellVersion() {
    try {
      if (!("caches" in window)) return null;
      const keys = await caches.keys();
      const k = keys.find((n) => n.indexOf("forest-shell-") === 0);
      return k ? k.slice("forest-shell-".length) : null;
    } catch (e) { return null; }
  }
  // The version the host is serving right now — or null if it's unreachable
  // (mid-deploy 502, offline). Network-only; /version is sent `no-store`.
  async function fetchServerVersion() {
    try {
      const r = await fetch("/version", { cache: "no-store" });
      if (!r.ok) return null;          // 502/503 while Render swaps instances
      const j = await r.json();
      return (j && j.version) || null;
    } catch (e) { return null; }
  }
  // True only when the host is reachable AND serving a version different from the
  // one this shell booted with — i.e. a new deploy has fully rolled out and a
  // reload is safe. Conservative: any uncertainty returns false.
  async function serverHasNewVersion() {
    const running = _runningVersion || (await runningShellVersion());
    if (running == null) return false;                // can't tell — don't cry wolf
    // A resumed PWA can have its shell cache silently swapped to a newer build by
    // the worker while THIS page keeps running the old code. That's stale even if
    // the host matches the cache — detect it directly against the running code, so
    // a stale page can never mask itself as "up to date".
    const cache = await runningShellVersion();
    if (cache && cache !== running) return true;
    const server = await fetchServerVersion();
    if (server == null) return false;                 // host not ready
    return server !== running;
  }
  async function confirmThenGlow() {
    if (await serverHasNewVersion()) { setUpdateGlow(true); maybeAutoApplyUpdate(); }
  }

  // Auto-apply an update at a COST-FREE moment (owner ask 2026-08-11): when you return
  // to the app and a new version is already confirmed live, reload to it silently — but
  // ONLY if nothing is lost by doing so. A reload re-locks the Notebook (the key is
  // memory-only) and drops any open draft, so we hold back unless the Notebook is locked
  // (or you're a guest) AND no note is being written AND no other text field has unsaved
  // input. Otherwise the quiet ☰ dot still lets you choose. This is the "it just updated"
  // feel of a native app without the interruption — matched to what's actually safe here.
  function autoReloadSafe() {
    try {
      const store = window.AOTDStore;
      // Unlocked Notebook → a reload would re-lock it (a surprise Face ID / password).
      if (store && typeof store.locked === "function" && !store.locked()) return false;
    } catch (e) { return false; }
    // A note being written is the main draft — leave an open composer alone.
    const nm = document.getElementById("noteModal");
    if (nm && !nm.classList.contains("hidden")) return false;
    // Any focused text field with content the reload would drop (feedback, search…).
    const ae = document.activeElement;
    if (ae && (ae.tagName === "TEXTAREA" ||
        (ae.tagName === "INPUT" &&
         /^(text|search|email|password|url|number|tel)$/i.test(ae.type || "text"))) &&
        (ae.value || "").trim()) return false;
    return true;
  }
  let _autoApplying = false;
  let _autoArmUntil = 0;   // return-to-foreground arms auto-apply briefly (browsable-locked case)
  let _swReg = null;       // the SW registration, so the unlock gate can kick a fresh check

  // On a Quick-unlock device, opening the app goes STRAIGHT to the unlock gate — there's
  // no browsable-while-locked screen for the return-window path to act on. But the unlock
  // gate is itself a safe, cost-free moment: the Notebook is locked (nothing to re-lock or
  // lose) and you haven't authenticated yet. Detect it from the DOM and treat it as a
  // valid moment to silently reload to a ready update — you then unlock ONCE, straight into
  // the new version (whose "finish updating" unlock copy explains the reload).
  function atLockGate() {
    try {
      if (!_gate || _gate.classList.contains("hidden")) return false;
      const b = _gate.querySelector("#authBody");
      return !!(b && (b.querySelector("#devUnlock") || b.querySelector("#unlockForm")));
    } catch (e) { return false; }
  }
  // Kick a fresh update check — called when the unlock gate appears, so a deploy that
  // landed while the app was backgrounded is confirmed within the beat you're at the
  // prompt (confirmThenGlow sets _updateReady and re-attempts the apply).
  function kickUpdateCheck() {
    try { if (_swReg) _swReg.update(); } catch (e) {}
    confirmThenGlow();
  }
  function maybeAutoApplyUpdate() {
    if (_autoApplying || !_updateReady) return;
    const store = window.AOTDStore;
    const locked = !store || typeof store.locked !== "function" || store.locked();
    const gateWindow = atLockGate() && locked;             // at the unlock prompt (Quick-unlock devices)
    const returnWindow = document.visibilityState === "visible" && Date.now() <= _autoArmUntil;
    if (!gateWindow && !returnWindow) return;              // window = browsable-while-locked case
    if (!autoReloadSafe()) return;
    _autoApplying = true;
    // One-shot flag so the reloaded page can show a single calm "Updated" toast (the gate
    // path also gets the unlock screen's "finish updating" copy).
    try { sessionStorage.setItem("aotd_auto_update", "1"); } catch (e) {}
    applyUpdateAndReload();
  }

  // Passive watch: notice when the service worker fetches a newer version (and
  // re-check when the app regains focus), so the glow can appear on its own — you
  // don't have to open the menu and hit "Check for updates" to find out.
  function initUpdateWatch() {
    if (!("serviceWorker" in navigator)) return;
    // The running version is the build tag baked into the code executing NOW
    // (app.js sets window.__MF_BUILD), so it can't be swapped out from under us by
    // a background cache update the way the SW cache name can. Fall back to the
    // cache name only if the constant isn't present (older shell).
    _runningVersion = (typeof window !== "undefined" && window.__MF_BUILD) || null;
    if (!_runningVersion) {
      runningShellVersion().then((v) => { if (v) _runningVersion = v; });
    }
    const controlled = () => !!navigator.serviceWorker.controller;
    // A new worker taking control (skipWaiting + clients.claim) is the most
    // reliable "an update is ready to apply" signal. Guard the first-ever control
    // event (initial install on a fresh PWA) so we only glow for real updates.
    let hadController = controlled();
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      // A new worker took control — but only glow once the host confirms the new
      // version is fully live, so we never point the user at a reload that 502s.
      if (hadController) confirmThenGlow();
      hadController = true;
    });
    const watch = (w) => {
      if (!w) return;
      w.addEventListener("statechange", () => {
        if ((w.state === "installed" || w.state === "activated") && controlled()) {
          confirmThenGlow();
        }
      });
    };
    navigator.serviceWorker.ready.then((reg) => {
      if (!reg) return;
      _swReg = reg;   // so the unlock gate can kick a fresh check on demand
      if (reg.waiting && controlled()) confirmThenGlow();
      if (reg.installing) watch(reg.installing);
      reg.addEventListener("updatefound", () => watch(reg.installing));
      // Each poll asks the SW to re-check bytes AND asks the host directly whether
      // a new version is live — the latter is what actually gates the glow, so a
      // finished deploy lights up on its own and a half-rolled-out one stays dark.
      const check = () => {
        last = Date.now();
        try { reg.update(); } catch (e) {}
        confirmThenGlow();
      };
      let last = 0;
      check();                                   // one check now
      // #3: poll for a newer worker on a fixed cadence while the app is open, so
      // a fresh deploy lights the glow on its own within ~30s — without the user
      // having to background/foreground the tab or hit "Check for updates". The
      // browser already de-dupes update() calls, and the SW only swaps when the
      // bytes actually change, so this is cheap. (Background tabs get throttled by
      // the browser anyway; the visibility handler below covers the wake-up.)
      setInterval(() => { if (document.visibilityState === "visible") check(); }, 30000);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") return;
        // Returning to the app ARMS a silent auto-apply for a short window. If an
        // update is already confirmed, the immediate attempt below applies it; if it's
        // still being confirmed, confirmThenGlow() re-attempts the moment it resolves —
        // so async readiness within the window isn't missed (the race the first cut
        // hit). autoReloadSafe() is re-checked at apply time, so unlocking or starting
        // a note meanwhile is respected. Never fires without a recent return, so it
        // won't reload out from under active use.
        _autoArmUntil = Date.now() + 20000;
        // Re-check immediately when the app comes back to the foreground (but not more
        // than once every 10s) so a deploy that landed while it was hidden is noticed.
        if (Date.now() - last > 10000) check();
        maybeAutoApplyUpdate();   // apply now if an update was already confirmed while hidden
      });
    }).catch(() => {});
  }
  // U20 (owner, 2026-07-03): signed in, the "♫ Select platforms" chooser tucks
  // into the ☰ menu — the services are usually set once, so the header stays calm.
  //
  // FB#105 (2026-08-07): the GUEST menu adopts it too, so ☰ is the one permanent
  // home on every hosted path. Two reasons it stopped making sense to keep a guest's
  // copy in the header. It was the last thing in that row once "By genre" / "By year"
  // moved under the record, and one lonely pill was costing the header 40px that the
  // record wanted. And it is no longer the first thing a guest meets: the first-run
  // card now asks where you listen outright, so the header pill was a second front
  // door to a question already answered.
  //
  // The local no-auth build mounts neither menu, so there it stays in the header —
  // which is also why `.controls` and restoreListenPref below still exist.
  //
  // We move the SAME #listenPref element (never a copy), so all its wiring — the
  // toggles, the long-press drag order, the tap-outside dismiss — rides along
  // untouched.
  function adoptListenPref(pop) {
    const pref = document.getElementById("listenPref");
    if (!pref || pref.parentNode === pop) return;
    pref.open = false;
    // Under the menu's lead row when there is one. A guest's lead is the
    // "Start your Notebook →" CTA, and a settings control must not displace it; the
    // account menu has no lead row, so the chooser stays top, where it has been since
    // U20. (This used to anchor off `.acct-email`, which stopped existing when the
    // address moved inline onto the Sign out row — the lookup had been returning null
    // and silently falling through to firstChild ever since.)
    const lead = pop.querySelector(".acct-start");
    pop.insertBefore(pref, lead ? lead.nextSibling : pop.firstChild);
    // U21: the header controls row is now empty — collapse it so it stops adding a
    // gap between the tabs and the Choose prompt.
    const controls = document.querySelector("header .controls");
    if (controls) controls.classList.toggle("is-empty", controls.children.length === 0);
  }
  // On lock/sign-out (or leaving guest mode) a menu unmounts — re-home the chooser to
  // its header slot (last in .controls) BEFORE the menu node is removed, or it would
  // be torn down with it, taking every listener wireListenPref attached.
  //
  // Takes the menu being torn down, and does nothing unless THAT menu is the one
  // holding the chooser. Both menus can adopt it now, and a guest signing in hands it
  // from one to the other — if this checked "is it in either menu?" it would depend on
  // whether unmountGuestMenu happened to run before mountAccountMenu, and in the order
  // that actually fires (aotd:unlocked mounts the account menu first) it would have
  // pulled the chooser straight back out of the menu that just adopted it.
  function restoreListenPref(menu) {
    const pref = document.getElementById("listenPref");
    if (!pref || !menu || !menu.contains(pref)) return;
    pref.open = false;
    const host = document.querySelector("header .controls");
    if (host) { host.appendChild(pref); host.classList.remove("is-empty"); }
  }

  // FB#105 (owner): "retire it into the pancake menu." The floating ✎ Feedback chip
  // was the fourth thing living at the foot of the screen, and the dock made that one
  // too many.
  //
  // Moved, not rebuilt — the SAME #feedbackBtn element, like the platforms chooser
  // above. That matters for three things that all keep working untouched: app.js's
  // `$("#feedbackBtn").addEventListener` wiring, cloneView()'s exclusion of it from
  // the bug-report snapshot, and the click-away exemptions in both menus (which now
  // resolve trivially, since the button is inside the menu it must not close).
  //
  // KNOWN COST, worth stating plainly: the chip sat at z-index 82, deliberately above
  // open panels (z 50-80), so you could report from INSIDE an album/artist panel —
  // exactly when you most want to. The menu is z-index 45, under modals, and raising
  // it is not a fix: ☰ is top-right, which is where a dialog's own ✕ lives, and the
  // chip was bottom-left precisely to avoid that collision. So feedback is now sent
  // from the app surface rather than from within an open door. Everything else about
  // the flow, including the snapshot, is unchanged.
  //
  // A guest gets it for the first time here: they never had the chip
  // (`body.guest .feedback-fab` hid it), so this is a door opening, not one moving.
  function adoptFeedbackBtn(pop) {
    const btn = document.getElementById("feedbackBtn");
    if (!btn || btn.parentNode === pop) return;
    // Above the way out — sign out / sign in / lock are the last thing in either
    // menu, and a "tell me what you think" row belongs with the app, not the exit.
    const exit = pop.querySelector(".acct-lock, .acct-signout, .acct-signin");
    pop.insertBefore(btn, exit || null);
  }
  // Same teardown discipline as the chooser: the button is a real element with a real
  // listener, so it has to leave the menu before the menu leaves the document.
  function restoreFeedbackBtn(menu) {
    const btn = document.getElementById("feedbackBtn");
    if (!btn || !menu || !menu.contains(btn)) return;
    document.body.appendChild(btn);
  }

  // FB#105 follow-up (owner, on staging 2026-08-07): "can we retire the
  // privacy/terms/version to the pancake menu?" The colophon was the last block
  // standing between the record and the dock, and it is reference material — you go
  // looking for it, you don't read it daily.
  //
  // Moved, not rebuilt, for the same reason as the two above: app.js writes the build
  // string into #buildTag on boot, and a copy would go stale the moment the real one
  // changed. Privacy and Terms stay one tap away rather than leaving the app — they
  // are legal links and have to remain reachable, which ☰ satisfies. Last in the pop,
  // under the exit, because that is where a colophon belongs.
  function adoptFooter(pop) {
    const foot = document.querySelector("body > footer");
    if (!foot || foot.parentNode === pop) return;
    pop.appendChild(foot);
  }
  function restoreFooter(menu) {
    const foot = menu && menu.querySelector("footer");
    if (!foot) return;
    document.body.appendChild(foot);
  }
  function mountAccountMenu() {
    if (_acctMenu) return;
    _acctMenu = document.createElement("div");
    _acctMenu.id = "acctMenu";
    _acctMenu.className = "acct-menu";
    _acctMenu.innerHTML =
      '<button class="acct-btn" aria-haspopup="true" aria-expanded="false" ' +
        'title="Account" aria-label="Account menu">☰</button>' +
      '<div class="acct-pop hidden">' +
        // #24/#26: a calm top level — a waiting update surfaces as ONE row here
        // (no longer the ☰ + Settings toggle + Update button all lit at once); the
        // rarer tools tuck behind a single "Settings" disclosure. Labels carry the
        // menu (no emoji); the email rides the Sign out row instead of a header.
        '<button class="acct-update-ready hidden" title="A new version is ready — reload to update">' +
          'Update ready<span class="acct-reload">reload →</span></button>' +
        // Sits directly under the update row so it's to hand at the one moment it's
        // wanted — you just updated and something looks different. Pull-only: no
        // badge, no unread count, never opens itself (VISION P4).
        '<button class="acct-whatsnew" title="What has changed since you last updated">What&#39;s new</button>' +
        // FB#97 (owner): renamed from "What is this?" and re-pointed at the About
        // door (it used to re-open the first-run welcome).
        '<button class="acct-whatis" title="About Music Forest — why it exists, and where the data comes from">About</button>' +
        '<button class="acct-tour" title="Walk through the app, one tip at a time">Take the tour</button>' +
        // Operator-only (admin-in-pwa-tab): hidden until AOTDOperator.gate() confirms
        // /api/admin/whoami. A reader never has this in a revealed state.
        '<button class="acct-console hidden" title="Operator tools — usage, pool, feedback, cost">Operator console</button>' +
        '<button class="acct-settings-toggle" aria-expanded="false" title="Quick unlock, backups, and app updates">Settings<span class="acct-caret">▸</span></button>' +
        '<div class="acct-settings hidden">' +
          '<button class="acct-devtrust" title="Turn one-tap quick unlock (Face ID, fingerprint, or passcode) on or off for this device">Quick unlock</button>' +
          '<button class="acct-update" title="Check for a new version of the app and reload to apply it">Check for updates</button>' +
          '<button class="acct-export" title="Download a plaintext backup of your Notebook (decrypted in your browser)">Export Notebook (backup)</button>' +
          '<button class="acct-import" title="Bring your pre-Supabase Notebook into your encrypted account">Import old Notebook</button>' +
          // Delete is the last item, behind a danger divider and its own bordered
          // danger styling so it reads as a deliberate, distinct destructive action.
          '<div class="acct-sep acct-sep-danger"></div>' +
          '<button class="acct-delete" title="Permanently delete your account and all synced Notebook data">Delete account…</button>' +
        '</div>' +
        '<div class="acct-sep"></div>' +
        // The deliberate lock, alongside the idle timer's backstop (2026-08-04). With
        // the timeout out at 6 hours, the timer can't answer "I'm handing someone my
        // phone right now" — this can. Top level, paired with Sign out: they're the two
        // ways to put the notebook away, and this is the light one, dropping the key
        // from memory WITHOUT ending the session, so coming back is one biometric tap.
        // Buried under Settings it would be useless for the case it exists for.
        '<button class="acct-lock" title="Re-lock your Notebook now — you stay signed in">Lock Notebook</button>' +
        '<button class="acct-signout">Sign out' +
          (_email ? '<span class="acct-email-inline">(' + esc(_email) + ')</span>' : '') +
        '</button>' +
      '</div>';
    const btn = _acctMenu.querySelector(".acct-btn");
    const pop = _acctMenu.querySelector(".acct-pop");
    const settingsToggle = _acctMenu.querySelector(".acct-settings-toggle");
    const settingsGroup = _acctMenu.querySelector(".acct-settings");
    const revealSettings = (on) => {
      settingsGroup.classList.toggle("hidden", !on);
      settingsToggle.setAttribute("aria-expanded", on ? "true" : "false");
    };
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = !pop.classList.toggle("hidden");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    });
    // #24/#26: the one update signal — the top row reloads into the new version
    // (checkForUpdatesFlow reloads when _updateReady). Keeps the menu open on tap.
    _acctMenu.querySelector(".acct-update-ready").addEventListener("click", (e) => {
      e.stopPropagation();
      checkForUpdatesFlow(_acctMenu.querySelector(".acct-update-ready"));
    });
    settingsToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      revealSettings(settingsGroup.classList.contains("hidden"));
    });
    _acctMenu.querySelector(".acct-export").addEventListener("click", (e) => {
      e.stopPropagation();
      pop.classList.add("hidden");
      btn.setAttribute("aria-expanded", "false");
      exportJournal(_acctMenu.querySelector(".acct-export"));
    });
    _acctMenu.querySelector(".acct-import").addEventListener("click", (e) => {
      e.stopPropagation();
      pop.classList.add("hidden");
      btn.setAttribute("aria-expanded", "false");
      if (window.AOTDImport && AOTDImport.run) {
        AOTDImport.run(_acctMenu.querySelector(".acct-import"));
      }
    });
    _acctMenu.querySelector(".acct-devtrust").addEventListener("click", (e) => {
      e.stopPropagation();
      pop.classList.add("hidden");
      btn.setAttribute("aria-expanded", "false");
      deviceTrustFlow();
    });
    _acctMenu.querySelector(".acct-update").addEventListener("click", (e) => {
      e.stopPropagation();
      // Keep the menu open: the button reports status inline ("Checking…" →
      // "Up to date" / "Update ready") so the result is visible where it was clicked.
      checkForUpdatesFlow(_acctMenu.querySelector(".acct-update"));
    });
    _acctMenu.querySelector(".acct-delete").addEventListener("click", (e) => {
      e.stopPropagation();
      // Keep the menu open behind the native confirm/prompt; the flow tears the
      // menu down itself on success (via doSignOut).
      deleteAccountFlow(_acctMenu.querySelector(".acct-delete"));
    });
    _acctMenu.querySelector(".acct-whatsnew").addEventListener("click", (e) => {
      e.stopPropagation();
      pop.classList.add("hidden");
      btn.setAttribute("aria-expanded", "false");
      if (window.AOTDWhatsNew) window.AOTDWhatsNew.show();
    });
    // FB#97: the pull-only About door. (Phase F pointed this at the first-run
    // welcome; About is the fuller page — the welcome is still what a first-timer
    // meets, and the tour can be restarted from there.)
    _acctMenu.querySelector(".acct-whatis").addEventListener("click", (e) => {
      e.stopPropagation();
      pop.classList.add("hidden");
      btn.setAttribute("aria-expanded", "false");
      if (window.openAboutDoor) window.openAboutDoor();
    });
    _acctMenu.querySelector(".acct-tour").addEventListener("click", (e) => {
      e.stopPropagation();
      pop.classList.add("hidden");
      btn.setAttribute("aria-expanded", "false");
      if (window.AOTDOnboarding) window.AOTDOnboarding.startTourOnDemand();
    });
    _acctMenu.querySelector(".acct-lock").addEventListener("click", (e) => {
      e.stopPropagation();
      pop.classList.add("hidden");
      btn.setAttribute("aria-expanded", "false");
      lock();
    });
    _acctMenu.querySelector(".acct-console").addEventListener("click", (e) => {
      e.stopPropagation();
      pop.classList.add("hidden");
      btn.setAttribute("aria-expanded", "false");
      if (window.AOTDOperator) AOTDOperator.open();
    });
    _acctMenu.querySelector(".acct-signout").addEventListener("click", async () => {
      if (!confirm("Sign out? Your Notebook will lock and you'll return to the login screen.")) return;
      await doSignOut();
    });
    document.addEventListener("click", closeAccountMenu);  // click-away closes it
    adoptListenPref(pop);                    // U20: platforms live here when signed in
    adoptFeedbackBtn(pop);                   // FB#105: and so does Send feedback
    adoptFooter(pop);                        // FB#105: Privacy · Terms · build, too
    document.body.appendChild(_acctMenu);
    setTimeout(maybeShowAboutMovedCue, 900);        // FB#97: see the guest menu's copy
    setTimeout(maybeShowKeepSkipSwapOffer, 1200);   // FB#109: likewise
    setTimeout(maybeShowNavMovedOffer, 1600);       // FB#105: likewise
    // Reveal the operator-console item iff the server says this account is an operator.
    if (window.AOTDOperator) AOTDOperator.gate(_acctMenu);
    if (_updateReady) setUpdateGlow(true);   // carry a pre-mount detection through
    initUpdateWatch();
  }
  function closeAccountMenu(e) {
    if (!_acctMenu || (e && _acctMenu.contains(e.target))) return;
    // #24/#26: opening feedback must NOT close the menu — you tap Feedback
    // precisely to report on (and snapshot) the open menu.
    if (e && e.target.closest &&
        e.target.closest("#feedbackBtn, #feedbackModal")) return;
    const pop = _acctMenu.querySelector(".acct-pop");
    const btn = _acctMenu.querySelector(".acct-btn");
    if (pop) pop.classList.add("hidden");
    if (btn) btn.setAttribute("aria-expanded", "false");
  }
  function unmountAccountMenu() {
    document.removeEventListener("click", closeAccountMenu);
    restoreListenPref(_acctMenu);
    restoreFeedbackBtn(_acctMenu);
    restoreFooter(_acctMenu);
    if (_acctMenu) { _acctMenu.remove(); _acctMenu = null; }
  }
  document.addEventListener("aotd:unlocked", () => { if (window.AOTD_HOSTED) mountAccountMenu(); });
  document.addEventListener("aotd:locked", unmountAccountMenu);

  // FB#107: re-run the journal load after a failed one. This has to live here
  // because a failed loadAll leaves the store's error latched — whenReady() then
  // rejects instantly for the life of the session, so the Notebook's "try again"
  // was re-hitting an already-rejected promise and could never succeed no matter how
  // many times it was pressed. Only another loadAll clears it, and hydrateJournal is
  // the one path that runs one. Resolves to whether the journal is now readable.
  async function retryJournal() {
    if (!_store || _store.locked()) return false;
    await hydrateJournal();
    return _store.ready();
  }

  window.AOTDAuth = { boot, lock, signOut: doSignOut, getStore: () => _store,
    showGate, enterGuest, retryJournal };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
