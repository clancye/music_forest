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
  const DEFAULT_IDLE_MS = 15 * 60 * 1000;   // 15 minutes
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
    return (s == null ? "" : String(s)).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
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
    // "What is this?", "Request a record", and "Sign in".
    mountGuestMenu();
    document.dispatchEvent(new CustomEvent("aotd:guest"));
    // U18: the welcome modal no longer auto-opens — the deck itself is the
    // welcome (show, don't tell; the record is the first thing on screen). The
    // full what-it-is/what-it-isn't screen stays one click away behind the ☰
    // menu's "What is this?" door — pull, not push.
  }
  // Leave guest mode once the visitor commits to an account (reached unlock).
  function leaveGuest() {
    window.AOTD_GUEST = false;
    document.body.classList.remove("guest");
    unmountGuestMenu();
  }
  // A guest gets the same ☰ corner menu as a signed-in user (#60: the guest header
  // no longer carries door buttons). It holds the primary "Start a journal →"
  // account CTA, a pull-only "What is this?" (re-opens the welcome), the #61
  // "Request a record" channel, and a "Sign in" door for a returning visitor.
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
        '<button class="acct-whatis" title="What is Music Forest?">What is this?</button>' +
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
      if (window.AOTDOnboarding) window.AOTDOnboarding.show({ first: false });
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
    if (reason === "signin") renderLogin(); else renderFirstTime();
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
    if (rec) renderDeviceUnlock(rec, postUpdate);
    else renderUnlock({ postUpdate });
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

  // U18: this is the RETURNING-user screen — sign-up intent goes to
  // renderFirstTime (the gate fork in showGate), so the password form no longer
  // greets first-timers who can't use it. A cross-link covers whoever lands here
  // by habit anyway; request-access lives on the first-time screen.
  function renderLogin() {
    // Phase D: a guest reaching the gate keeps their picks and reflections —
    // show the live count as reassurance above the sign-in form.
    body().innerHTML = `
      <p class="auth-lead">Welcome back — sign in to your Notebook.</p>
      ${guestKeepLine()}
      <form id="loginForm" class="auth-form">
        <input type="email" id="loginEmail" aria-label="Email address" placeholder="you@example.com" autocomplete="email" required>
        <input type="password" id="loginPass" aria-label="Password" placeholder="Password" autocomplete="current-password" required>
        <button type="submit">Sign in</button>
      </form>
      <div class="auth-or"><span>or</span></div>
      <div class="auth-providers">
        <button type="button" class="oauth-btn ghost" data-provider="google">Continue with Google</button>
      </div>
      <div class="auth-links">
        <button type="button" id="emailLinkInstead" class="linkish">Email me a sign-in link instead</button>
      </div>
      <p id="authStatus" class="auth-status"></p>
      <p class="auth-sub muted">First time here? <button type="button" id="firstTimeHere" class="linkish">Start your Notebook</button> — sign-ups are invite-only. Your account sign-in is separate from the encryption password that unlocks your Notebook.</p>
      ${window.AOTD_GUEST ? '<div class="auth-guest-back"><button type="button" id="guestBack" class="linkish">← Keep looking around</button></div>' : ""}`;
    if (window.AOTD_GUEST) {
      const back = body().querySelector("#guestBack");
      if (back) back.addEventListener("click", closeGate);
    }
    body().querySelector("#firstTimeHere").addEventListener("click", renderFirstTime);
    body().querySelector("#loginForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = body().querySelector("#loginEmail").value.trim();
      const pass = body().querySelector("#loginPass").value;
      if (!email || !pass) return;
      setStatus("Signing in…");
      try {
        const session = await S.signInWithPassword(email, pass);
        await afterSignedIn(session);
      } catch (err) {
        // A network failure is not a credential failure — saying "didn't match"
        // to someone who is offline sends them to reset a fine password.
        if (isNetErr(err)) { setStatus(NET_ERR_MSG, "error"); return; }
        // Don't leak whether the email exists; one message covers both
        // wrong-password and no-password-set-yet (use the link path instead).
        setStatus("That email and password didn't match. If you've never set a "
          + "password, use the sign-in link below.", "error");
      }
    });
    body().querySelector("#emailLinkInstead").addEventListener("click", renderMagicLink);
    body().querySelectorAll(".oauth-btn").forEach((b) =>
      b.addEventListener("click", async () => {
        setStatus("Redirecting…");
        try {
          // Full-page redirect to the provider; the session is picked up by
          // boot() when the browser comes back.
          await S.signInWithOAuth(b.getAttribute("data-provider"));
        } catch (err) {
          setStatus(isNetErr(err) ? NET_ERR_MSG
            : (err.message || "Could not start sign-in."), "error");
        }
      }));
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
      <p id="authStatus" class="auth-status"></p>`;
    const emailEl = body().querySelector("#reqEmail");
    if (prefill) emailEl.value = prefill;
    body().querySelector("#reqBack").addEventListener("click", renderFirstTime);
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
        if (done) done.addEventListener("click", renderFirstTime);
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
  function classifyAuthError(e) {
    const code = ((e && e.code) || "").toString().toLowerCase();
    const desc = ((e && e.description) || "").toString();
    if (/invit/i.test(desc)) return "not-invited";
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
  function renderLinkFailed(kind, detail) {
    const expired = kind === "link-expired";
    body().innerHTML = `
      <p class="auth-lead">${expired ? "That link has expired" : "That link didn't work"}</p>
      <p class="auth-sub">${expired
        ? "Sign-in links are one-time and don't last long. Enter your email and we'll send you a fresh one."
        : "Sign-in didn't finish. Enter your email and we'll send you a fresh link."}</p>
      <form id="expForm" class="auth-form">
        <input type="email" id="expEmail" aria-label="Email address" placeholder="you@example.com" autocomplete="email" required>
        <button type="submit">Email me a new link</button>
      </form>
      ${detail ? `<p class="auth-sub muted">${esc(detail)}</p>` : ""}
      <div class="auth-links"><button type="button" id="expGuest" class="linkish">← Keep looking around</button></div>
      <p id="authStatus" class="auth-status"></p>`;
    body().querySelector("#expForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = body().querySelector("#expEmail").value.trim();
      if (!email) return;
      await sendLinkFlow(email);
    });
    body().querySelector("#expGuest").addEventListener("click", enterGuest);
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

  // One shared send for every screen that emails a sign-in link (the first-time
  // gate and the returning-user fallback), so the confirmation copy and the
  // rejection routing can never drift apart between them.
  //
  // Sign-ups are gated by the Before-User-Created hook (migration 0004): an
  // uninvited email is rejected at send time with the hook's custom "not
  // invited" message. Route that to the same friendly "You're not invited yet"
  // screen the OAuth path uses (smoke test §2 wants the request-access screen,
  // not a raw error); the otp_disabled branch is kept in case shouldCreateUser
  // ever regresses to false. Genuine errors (network, rate-limit, …) stay inline.
  async function sendLinkFlow(email) {
    setStatus("Sending…");
    try {
      await S.sendMagicLink(email);
      body().innerHTML = `
        <p class="auth-lead">Check your email</p>
        <p class="auth-sub">We sent a sign-in link to <b>${esc(email)}</b>. Open it on this device to continue. You can close this tab.</p>
        <p class="auth-sub muted">First sign-in? The link also creates your account — sign-ups stay invite-only.</p>`;
    } catch (err) {
      const code = (err && (err.code || err.name) || "").toString();
      const msg = (err && err.message || "").toString();
      if (code === "otp_disabled"
          || /not allowed for otp|signups?\s+not\s+allowed|not invited/i.test(msg)) {
        renderSignupRejected();
      } else {
        setStatus(isNetErr(err) ? NET_ERR_MSG : (msg || "Could not send the link."), "error");
      }
    }
  }

  // Fallback / bootstrap: the original passwordless flow. For accounts without a
  // password yet, or as a way back in if the password is forgotten (sign in here,
  // then set a new password from the account menu).
  function renderMagicLink() {
    body().innerHTML = `
      <p class="auth-lead">Email me a sign-in link</p>
      <p class="auth-sub">We'll send a one-time link — handy if you haven't set a password yet, or forgot it.</p>
      <form id="linkForm" class="auth-form">
        <input type="email" id="linkEmail" aria-label="Email address" placeholder="you@example.com" autocomplete="email" required>
        <button type="submit">Email me a link</button>
      </form>
      <div class="auth-links"><button type="button" id="backToLogin" class="linkish">Back to password sign-in</button></div>
      <p id="authStatus" class="auth-status"></p>`;
    body().querySelector("#linkForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = body().querySelector("#linkEmail").value.trim();
      if (!email) return;
      await sendLinkFlow(email);
    });
    body().querySelector("#backToLogin").addEventListener("click", renderLogin);
  }

  // U18 — the sign-UP-intent gate. "Start a journal" and the in-context invites
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

  function renderFirstTime() {
    const reasonLine = GATE_REASON_LINES[_gateReason] || "";
    body().innerHTML = `
      <p class="auth-lead">Start your Notebook</p>
      ${reasonLine ? `<p class="auth-sub auth-keep">${reasonLine}</p>` : ""}
      ${guestKeepLine()}
      <ol class="auth-steps">
        <li>Enter your email below.</li>
        <li>We email you a link — it signs you in and creates your account.</li>
        <li>Choose an encryption password only you ever know.</li>
      </ol>
      <form id="firstForm" class="auth-form">
        <input type="email" id="firstEmail" aria-label="Email address" placeholder="you@example.com" autocomplete="email" required>
        <button type="submit">Email me my sign-in link</button>
      </form>
      <p id="authStatus" class="auth-status"></p>
      <p class="auth-sub muted">Invite-only for now — no invite yet? <button type="button" id="firstReq" class="linkish">Request access</button></p>
      <div class="auth-links"><button type="button" id="firstSignin" class="linkish">Already have a Notebook? Sign in</button></div>
      ${window.AOTD_GUEST ? '<div class="auth-guest-back"><button type="button" id="guestBack" class="linkish">← Keep looking around</button></div>' : ""}`;
    body().querySelector("#firstForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = body().querySelector("#firstEmail").value.trim();
      if (!email) return;
      await sendLinkFlow(email);
    });
    body().querySelector("#firstReq").addEventListener("click", renderRequestAccess);
    body().querySelector("#firstSignin").addEventListener("click", renderLogin);
    if (window.AOTD_GUEST) {
      const back = body().querySelector("#guestBack");
      if (back) back.addEventListener("click", closeGate);
    }
  }

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
      <p class="auth-sub">On this device, you can unlock with <b>Face ID, a fingerprint, or your passcode</b> instead of retyping your encryption password. It stays on this device only — your password and recovery code keep working as before.</p>
      <p class="auth-sub muted">Only turn this on if the device is yours and locks itself.</p>
      <button type="button" id="devEnable">Enable quick unlock</button>
      <div class="auth-links"><button type="button" id="devSkip" class="linkish">Not now</button></div>
      <p id="authStatus" class="auth-status"></p>`;
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

  function renderDeviceUnlock(rec, postUpdate) {
    body().innerHTML = `
      <p class="auth-lead">${postUpdate ? "Almost done — unlock to finish updating" : "Unlock your Notebook"}</p>
      ${acctLine()}
      <p class="auth-sub">${postUpdate ? "The app just updated, which re-locked your Notebook (its key is never stored). " : ""}Unlock the same way you unlock this device — Face ID, a fingerprint, or your passcode/PIN.</p>
      <button type="button" id="devUnlock">Unlock with this device</button>
      <div class="auth-links">
        <button type="button" id="devUsePass" class="linkish">Use encryption password instead</button>
        <button type="button" id="devForget" class="linkish">Forget this device</button>
        <button type="button" id="devSignOut" class="linkish">Sign out</button>
      </div>
      <p id="authStatus" class="auth-status"></p>`;
    const attempt = async (opts) => {
      setStatus("Waiting for this device to verify you…");
      try {
        const kek = await AOTDDevice.assert(rec);
        const dek = await C.unlockWithDeviceEntry(rec.deviceEntry, kek);
        if (kek && kek.fill) kek.fill(0);
        await finishUnlock(dek);
      } catch (err) {
        // An AUTO attempt (straight after an update reload) can be refused by the
        // browser for lack of a fresh user gesture — expected; fall back quietly to
        // the one-tap button, no alarming error. A user tap gets the real message.
        if (opts && opts.auto) { setStatus(""); return; }
        setStatus("Couldn't verify on this device. Try again, or use your password.", "error");
      }
    };
    const unlockBtn = body().querySelector("#devUnlock");
    unlockBtn.addEventListener("click", () => attempt());
    // Smooth update (owner 2026-07-07): after an update reload go STRAIGHT to the
    // biometric where the browser allows it (many require a gesture — then the
    // focused button is one tap away). The E2EE key stays memory-only either way.
    try { unlockBtn.focus(); } catch (e) {}
    if (postUpdate) attempt({ auto: true });
    body().querySelector("#devUsePass").addEventListener("click", renderUnlock);
    body().querySelector("#devForget").addEventListener("click", async () => {
      try { await AOTDDevice.clear(_userId); localStorage.removeItem(declineKey()); } catch (e) {}
      renderUnlock();
    });
    body().querySelector("#devSignOut").addEventListener("click", doSignOut);
  }

  function renderSetup() {
    body().innerHTML = `
      <p class="auth-lead">Set your encryption password</p>
      ${acctLine()}
      <p class="auth-sub">This is the first time signing in to this account, so let's set the password that encrypts your Notebook. It encrypts everything in your browser — we never see it, and we can't reset it for you. Choose something strong you'll remember.</p>
      <form id="setupForm" class="auth-form">
        <input type="password" id="pass1" aria-label="Password" placeholder="Password" autocomplete="new-password" required minlength="8">
        <input type="password" id="pass2" aria-label="Confirm password" placeholder="Confirm password" autocomplete="new-password" required minlength="8">
        <button type="submit">Continue</button>
      </form>
      <div class="auth-links"><button type="button" id="setupSignOut" class="linkish">Not you? Sign out</button></div>
      <p id="authStatus" class="auth-status"></p>`;
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
      <p id="authStatus" class="auth-status"></p>`;
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
    const postUpdate = opts && opts.postUpdate;
    body().innerHTML = `
      <p class="auth-lead">${postUpdate ? "Almost done — unlock to finish updating" : "Unlock your Notebook"}</p>
      ${acctLine()}
      <p class="auth-sub">${postUpdate ? "The app just updated, which re-locked your Notebook (its key is never stored). " : ""}Enter your <b>encryption password</b> to decrypt your Notebook for this session. (This is the one we never see — not your account sign-in password.)</p>
      <form id="unlockForm" class="auth-form">
        <input type="password" id="unlockPass" aria-label="Encryption password" placeholder="Encryption password" autocomplete="current-password" required>
        <button type="submit">Unlock</button>
      </form>
      <div class="auth-links">
        <button type="button" id="useRecovery" class="linkish">Use recovery code</button>
        <button type="button" id="forgotPass" class="linkish">Forgot encryption password?</button>
        <button type="button" id="signOutBtn" class="linkish">Sign out</button>
      </div>
      <p id="authStatus" class="auth-status"></p>`;
    try { body().querySelector("#unlockPass").focus(); } catch (e) {}
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
      <p id="authStatus" class="auth-status"></p>`;
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
      <p id="authStatus" class="auth-status"></p>`;
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
    _store = J.createStore({ crypto: C, sync: S });
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

  function lock() {
    stopIdleWatch();
    if (_store) { try { _store.clear(); } catch (e) {} }
    window.AOTDStore = null;
    document.dispatchEvent(new CustomEvent("aotd:locked"));
    hideApp();
    renderUnlock();
    show();
  }

  async function doSignOut() {
    stopIdleWatch();
    if (_store) { try { _store.clear(); } catch (e) {} }
    _store = null; _keyMaterial = null; _email = null; window.AOTDStore = null;
    unmountAccountMenu();
    await S.signOut();
    hideApp();
    renderLogin();
    show();
  }

  // --- idle auto-lock --------------------------------------------------------
  function startIdleWatch() {
    stopIdleWatch();
    const reset = () => {
      clearTimeout(_idleTimer);
      _idleTimer = setTimeout(lock, idleMs());
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
      // Signed-in: unlocking needs the KDF, so bring it up now behind the gate's
      // "Starting up…" (afterSignedIn awaits ensureSodium) while the encrypted
      // rows are fetched.
      show();
      renderLoading("Starting up…");
      await afterSignedIn(session);
    } catch (err) {
      show();
      body().innerHTML = `<p class="auth-lead">Something went wrong</p>
        <p class="auth-sub error">${esc(err.message || String(err))}</p>
        <button type="button" onclick="location.reload()">Reload</button>`;
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

  // --- set/change sign-in password (in-app, while unlocked) -----------------
  // A small dismissible overlay (separate from the auth gate, which hides the
  // app). Sets the Supabase *account* password via S.setLoginPassword — the
  // identity credential, never the encryption passphrase. The bridge between the
  // magic-link world and password sign-in: a link-only account uses this once to
  // adopt a password, and anyone can change theirs here.
  function setLoginPasswordFlow() {
    const ov = document.createElement("div");
    ov.className = "auth-gate";   // reuse the dimmed-overlay styling
    ov.innerHTML = '<div class="auth-card"><div class="auth-brand">Change account password</div>' +
      '<div id="setpwBody">' +
      '<p class="auth-sub">Music Forest keeps <b>two separate passwords</b>' +
      (_email ? ' for <b>' + esc(_email) + '</b>' : '') + ' — this changes only the first:</p>' +
      '<p class="auth-sub"><b>Account password</b> (this one): what you type to <b>sign in</b> to ' +
      'your account — an alternative to the emailed magic link. Our server checks it.</p>' +
      '<p class="auth-sub"><b>Encryption password</b>: what <b>unlocks your Notebook</b> on your ' +
      'device. It never leaves your device, so no one — not even us — can read your entries. It is ' +
      '<b>not</b> changed here.</p>' +
      '<p class="auth-sub">They’re separate on purpose: it’s what lets us sync your Notebook ' +
      'without ever being able to read it. Changing this won’t touch your entries or recovery code.</p>' +
      '<form id="setpwForm" class="auth-form">' +
      '<input type="password" id="setpw1" aria-label="New account password" placeholder="New account password" autocomplete="new-password" required minlength="8">' +
      '<input type="password" id="setpw2" aria-label="Confirm password" placeholder="Confirm password" autocomplete="new-password" required minlength="8">' +
      '<button type="submit">Save password</button>' +
      '</form>' +
      '<div class="auth-links"><button type="button" id="setpwCancel" class="linkish">Cancel</button></div>' +
      '<p id="setpwStatus" class="auth-status"></p>' +
      '</div></div>';
    document.body.appendChild(ov);
    const close = () => { try { ov.remove(); } catch (e) {} };
    const st = (msg, kind) => {
      const el = ov.querySelector("#setpwStatus");
      if (el) { el.textContent = msg || ""; el.className = "auth-status" + (kind ? " " + kind : ""); }
    };
    ov.querySelector("#setpwCancel").addEventListener("click", close);
    ov.querySelector("#setpwForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const p1 = ov.querySelector("#setpw1").value;
      const p2 = ov.querySelector("#setpw2").value;
      if (p1.length < 8) return st("Use at least 8 characters.", "error");
      if (p1 !== p2) return st("The two passwords don't match.", "error");
      st("Saving…");
      try {
        await S.setLoginPassword(p1);
        st("Saved — you can sign in with this password next time.");
        setTimeout(close, 1400);
      } catch (err) {
        st((err && err.message) || "Could not set the password.", "error");
      }
    });
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
        "unlock, otherwise your encryption password.");
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
          "encryption password.");
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
  // Enabling here needs the encryption password again (the live DEK is non-
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
        'secure connection). You\'ll keep using your encryption password here.</p>' +
        '<div class="auth-links"><button type="button" id="devmgrClose" class="linkish">Close</button></div>';
      ov.querySelector("#devmgrClose").addEventListener("click", close);
      return;
    }
    if (enrolled) {
      bodyEl.innerHTML = '<p class="auth-sub">Quick unlock is <b>on</b> for this device. ' +
        'Turning it off means you\'ll enter your encryption password here again.</p>' +
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
    // Supported but not yet enabled: enable it (needs the encryption password).
    bodyEl.innerHTML = '<p class="auth-sub">Enable a one-tap unlock on this device using Face ID, ' +
      'a fingerprint, or your passcode/PIN — whatever you use to unlock the device itself. Enter your ' +
      '<b>encryption password</b> once to set it up — it stays on this device and never reaches the server.</p>' +
      '<form id="devmgrForm" class="auth-form">' +
      '<input type="password" id="devmgrPass" aria-label="Encryption password" placeholder="Encryption password" autocomplete="current-password" required>' +
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
    if (await serverHasNewVersion()) setUpdateGlow(true);
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
        // Re-check immediately when the app comes back to the foreground (but not
        // more than once every 10s) so a deploy that landed while it was hidden
        // is noticed the moment you return.
        if (document.visibilityState === "visible" && Date.now() - last > 10000) {
          check();
        }
      });
    }).catch(() => {});
  }
  // U20 (owner, 2026-07-03): signed in, the "♫ Select platforms" chooser tucks
  // into the ☰ menu — the services are usually set once, so the header stays
  // calm. The guest keeps it front-and-center in the header (it's their one
  // tune-what-you-see control), and the local no-auth build never mounts this
  // menu, so it keeps the header chooser too. We move the SAME #listenPref
  // element (never a copy), so all its wiring — the toggles, the long-press
  // drag order, the tap-outside dismiss — rides along untouched.
  function adoptListenPref(pop) {
    const pref = document.getElementById("listenPref");
    if (!pref || pref.parentNode === pop) return;
    pref.open = false;
    const email = pop.querySelector(".acct-email");
    pop.insertBefore(pref, email ? email.nextSibling : pop.firstChild);
    // U21: the header controls row is now empty — collapse it so it stops adding a
    // gap between the tabs and the Choose prompt.
    const controls = document.querySelector("header .controls");
    if (controls) controls.classList.toggle("is-empty", controls.children.length === 0);
  }
  // On lock/sign-out the menu unmounts — re-home the chooser to its header
  // slot (last in .controls) BEFORE the menu node is removed, or it would be
  // torn down with it.
  function restoreListenPref() {
    const pref = document.getElementById("listenPref");
    if (!pref || !_acctMenu || !_acctMenu.contains(pref)) return;
    pref.open = false;
    const host = document.querySelector("header .controls");
    if (host) { host.appendChild(pref); host.classList.remove("is-empty"); }
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
        '<button class="acct-whatis" title="What is Music Forest? Re-open the welcome.">What is this?</button>' +
        '<button class="acct-settings-toggle" aria-expanded="false" title="Quick unlock, backups, account password, and app updates">Settings<span class="acct-caret">▸</span></button>' +
        '<div class="acct-settings hidden">' +
          '<button class="acct-devtrust" title="Turn one-tap quick unlock (Face ID, fingerprint, or passcode) on or off for this device">Quick unlock</button>' +
          '<button class="acct-update" title="Check for a new version of the app and reload to apply it">Check for updates</button>' +
          '<button class="acct-export" title="Download a plaintext backup of your Notebook (decrypted in your browser)">Export Notebook (backup)</button>' +
          '<button class="acct-import" title="Bring your pre-Supabase Notebook into your encrypted account">Import old Notebook</button>' +
          '<button class="acct-setpw" title="Set or change the password you sign in with — separate from the encryption password that unlocks your Notebook">Change account password</button>' +
          // Delete is the last item, behind a danger divider and its own bordered
          // danger styling so it reads as a deliberate, distinct destructive action.
          '<div class="acct-sep acct-sep-danger"></div>' +
          '<button class="acct-delete" title="Permanently delete your account and all synced Notebook data">Delete account…</button>' +
        '</div>' +
        '<div class="acct-sep"></div>' +
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
    _acctMenu.querySelector(".acct-setpw").addEventListener("click", (e) => {
      e.stopPropagation();
      pop.classList.add("hidden");
      btn.setAttribute("aria-expanded", "false");
      setLoginPasswordFlow();
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
    // Phase F: a pull-only "What is this?" door — re-opens the welcome/ethos for
    // returning or curious hands. Never touches the once-per-device flag.
    _acctMenu.querySelector(".acct-whatis").addEventListener("click", (e) => {
      e.stopPropagation();
      pop.classList.add("hidden");
      btn.setAttribute("aria-expanded", "false");
      if (window.AOTDOnboarding) window.AOTDOnboarding.show({ first: false });
    });
    _acctMenu.querySelector(".acct-signout").addEventListener("click", async () => {
      if (!confirm("Sign out? Your Notebook will lock and you'll return to the login screen.")) return;
      await doSignOut();
    });
    document.addEventListener("click", closeAccountMenu);  // click-away closes it
    adoptListenPref(pop);                    // U20: platforms live here when signed in
    document.body.appendChild(_acctMenu);
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
    restoreListenPref();
    if (_acctMenu) { _acctMenu.remove(); _acctMenu = null; }
  }
  document.addEventListener("aotd:unlocked", () => { if (window.AOTD_HOSTED) mountAccountMenu(); });
  document.addEventListener("aotd:locked", unmountAccountMenu);

  window.AOTDAuth = { boot, lock, signOut: doSignOut, getStore: () => _store,
    showGate, enterGuest };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
