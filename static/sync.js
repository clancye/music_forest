"use strict";
/*
 * sync.js — auth session + the authenticated transport to the H1.1 sync layer.
 *
 * Two jobs (BETA_PLAN.md §2, §4):
 *   1. Identity. Wrap supabase-js: passwordless sign-in by a one-time numeric code
 *      emailed to you (sendMagicLink + verifyEmailCode), or OAuth; hold the session
 *      JWT, refresh it, sign out. Email is the only code channel — SMS was cut before
 *      shipping (see the note above signInWithOAuth). There is no account password.
 *   2. Transport. Attach `Authorization: Bearer <jwt>` to every /api/sync/* call
 *      and expose typed helpers over the H1.1 routes: status, keys (GET/PUT),
 *      rows (GET with ?since= delta + ?kind=, POST batch upsert/tombstone,
 *      DELETE one).
 *
 * The transport core is decoupled from supabase-js so it's testable headlessly:
 * `configure({ fetch, getToken, refresh })` injects a fetch, a token source, and a
 * way to mint a fresh token after a 401. The browser wires those to window.fetch
 * and the live Supabase session; a Node test wires mocks and asserts the bearer
 * header is attached and that an expired token is refreshed and replayed (B35).
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  if (root) root.AOTDSync = mod;
})(typeof self !== "undefined" ? self : this, function () {

  let _fetch = (typeof fetch !== "undefined") ? fetch.bind(globalThis) : null;
  let _getToken = null;             // injected token source (tests/headless), if any
  let _refresh = null;              // injected "get me a new token" (tests/headless)
  let _token = null;                // last known session JWT (or null = local mode)
  let _supabase = null;             // supabase-js client (browser only)
  let _config = null;               // {configured, supabase_url, anon_key}

  function configure(opts) {
    if (!opts) return mod;
    if (typeof opts.fetch === "function") _fetch = opts.fetch;
    if (typeof opts.getToken === "function") _getToken = opts.getToken;
    if (typeof opts.refresh === "function") _refresh = opts.refresh;
    return mod;
  }
  function setToken(jwt) { _token = jwt || null; return mod; }
  function getToken() { return _getToken ? _getToken() : _token; }

  // B35: the bearer token used to be a SNAPSHOT — `_token`, written only by boot
  // and by onAuthStateChange — and request() sent whatever it happened to hold. A
  // Supabase access token lives ~1 hour and gotrue's autoRefresh only ticks while
  // the tab is alive and foregrounded, so an installed PWA that sat in the
  // background came back presenting a dead token. Every write then failed with
  // `invalid token: signature has expired` while reads kept working from
  // store-bridge's memory, so the app looked healthy right up until you tried to
  // save (owner, staging 2026-08-05: a keep and a note, both refused).
  //
  // So ask for the token at the MOMENT OF USE. auth.getSession() hands back the
  // current session and refreshes it when the access token has expired, which
  // turns "whenever the timer last ran" into "now". An injected getToken (the
  // headless test seam) still wins, and with no supabase client at all we fall
  // back to the holder — single-user local mode has no token and needs none.
  async function bearer() {
    if (_getToken) return await _getToken();
    if (_supabase && _supabase.auth) {
      try {
        const { data } = await _supabase.auth.getSession();
        const t = data && data.session ? data.session.access_token : null;
        if (t) { _token = t; return t; }
      } catch (e) {
        // Offline, or gotrue is unhappy: fall through to the last token we held.
        // It may be stale, but a possibly-valid token beats sending none at all —
        // and a 401 is now recoverable below rather than terminal.
      }
    }
    return _token;
  }

  // One refresh attempt, shared by every 401 retry. Returns the new access token,
  // or null when the session is genuinely gone (a revoked or expired REFRESH
  // token, which no amount of retrying can rescue — that has to reach sign-in).
  //
  // SINGLE-FLIGHT on purpose. Writes arrive in bursts — unlock fires getRows while
  // the keep queue flushes postRows — so an expired token means several requests
  // 401 within milliseconds. Supabase ROTATES the refresh token on use, so letting
  // each of them refresh independently races: the first rotation invalidates the
  // token the others are still holding, and a recoverable expiry turns into a real
  // sign-out. One refresh, everyone waits for it, everyone replays with its result.
  let _refreshing = null;
  function refreshToken() {
    if (_refreshing) return _refreshing;
    const attempt = (async () => {
      try {
        if (_refresh) {
          const t = await _refresh();
          _token = t || null;
          return t || null;
        }
        if (!_supabase || !_supabase.auth || !_supabase.auth.refreshSession) return null;
        const { data, error } = await _supabase.auth.refreshSession();
        if (error) return null;
        const t = data && data.session ? data.session.access_token : null;
        _token = t || null;
        return t || null;
      } catch (e) {
        return null;
      }
    })();
    _refreshing = attempt;
    // Release the slot once this attempt settles, so a LATER expiry refreshes again
    // instead of being answered forever by this run's result. It has to be a `.then`
    // on the settled promise rather than a `finally` INSIDE the async body: when the
    // body completes without ever suspending (an injected refresh with no await, or
    // the no-client early return), that inner finally would run before the
    // `_refreshing = attempt` line above and the assignment would then re-stick a
    // resolved promise permanently — every later 401 reusing one stale answer and
    // never refreshing again. The identity check keeps a slow attempt from clearing
    // a newer one that replaced it.
    const release = () => { if (_refreshing === attempt) _refreshing = null; };
    attempt.then(release, release);
    return attempt;
  }

  // --- low-level authed request ---------------------------------------------
  async function request(path, { method = "GET", body = null } = {}) {
    if (!_fetch) throw new Error("no fetch available");
    const send = async (token) => {
      const headers = {};
      // Attach identity whenever we have it. In single-user local mode there is no
      // token and the server bypasses auth — so a missing header is fine there.
      if (token) headers["Authorization"] = "Bearer " + token;
      if (body != null) headers["Content-Type"] = "application/json";
      return await _fetch(path, {
        method,
        headers,
        body: body == null ? undefined : JSON.stringify(body),
      });
    };
    let resp = await send(await bearer());
    // B35 (the second half): a token can die between the check above and the
    // server reading it, so a 401 still needs its own way out. Refresh once and
    // replay. Replaying is safe on THIS transport specifically: every /api/sync
    // write is idempotent — rows upsert on (user_id, kind, client_id), key/row
    // deletes are no-ops the second time — unlike /api/choices, which has no
    // idempotency key (see writeNeverReachedApp in app.js). Once only: if the
    // fresh token is refused too, the session is gone, not slow.
    if (resp.status === 401) {
      const fresh = await refreshToken();
      if (fresh) resp = await send(fresh);
    }
    let data = null;
    try { data = await resp.json(); } catch (e) { data = null; }
    if (!resp.ok) {
      const msg = (data && data.error) || `${resp.status} ${resp.statusText || ""}`.trim();
      const err = new Error(msg);
      err.status = resp.status;
      err.data = data;
      // Tag the one failure the caller can explain to a person: we are signed out,
      // and no retry will help. Callers say "your session expired" instead of a
      // bare "couldn't save", which is what made this look like lost work.
      if (resp.status === 401) err.sessionExpired = true;
      throw err;
    }
    return data;
  }

  // --- sync-layer helpers ----------------------------------------------------
  const status = () => request("/api/sync/status");

  async function getKeys() {
    const r = await request("/api/sync/keys");
    return (r && r.exists) ? r : null;   // {exists, key_material, created_at, updated_at} | null
  }
  const putKeys = (keyMaterial) =>
    request("/api/sync/keys", { method: "PUT", body: { key_material: keyMaterial } });

  function getRows({ kind = null, since = null } = {}) {
    const qs = [];
    if (kind) qs.push("kind=" + encodeURIComponent(kind));
    if (since) qs.push("since=" + encodeURIComponent(since));
    const q = qs.length ? "?" + qs.join("&") : "";
    return request("/api/sync/rows" + q);   // {rows, count, server_time}
  }
  const postRows = (rows) =>
    request("/api/sync/rows", { method: "POST", body: { rows } });  // {ok, written, server_time}
  const deleteRow = (kind, clientId) =>
    request(`/api/sync/rows/${encodeURIComponent(kind)}/${encodeURIComponent(clientId)}`,
      { method: "DELETE" });
  // Irreversible account deletion: erase this account's synced data (encrypted
  // rows + wrapped keys) and, when the server is configured for it, the login
  // itself. The server demands the explicit {confirm:"DELETE"} guard. Returns
  // {ok, erased:{rows,keys}, auth_user_deleted}.
  const deleteAccount = () =>
    request("/api/sync/account", { method: "DELETE", body: { confirm: "DELETE" } });

  const publicConfig = () => request("/api/public-config");

  // --- supabase / magic-link auth (browser) ----------------------------------
  /**
   * Load /api/public-config and, if configured, build the supabase-js client and
   * pick up any session (incl. one just arrived in the magic-link redirect URL).
   * Returns {configured, session}. When not configured we stay in single-user
   * local mode and the caller skips the whole login + unlock flow.
   */
  async function initSupabase() {
    _config = await publicConfig();
    if (!_config || !_config.configured) return { configured: false, session: null };
    if (typeof supabase === "undefined" || !supabase.createClient) {
      throw new Error("supabase-js failed to load (check the CDN <script> + SRI)");
    }
    // Normalize the project URL: trim stray whitespace/quotes and add the scheme
    // if it's missing, so AOTD_SUPABASE_URL="myproj.supabase.co" works too.
    let url = String(_config.supabase_url || "").trim().replace(/^["']|["']$/g, "");
    if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;
    try { new URL(url); }
    catch (e) {
      throw new Error("AOTD_SUPABASE_URL is not a valid URL: " + JSON.stringify(_config.supabase_url) +
        " — expected something like https://<project>.supabase.co");
    }
    const anonKey = String(_config.anon_key || "").trim();
    if (!anonKey) throw new Error("AOTD_SUPABASE_ANON_KEY is empty");
    // The anon key is sent as an HTTP header (apikey / Authorization), so any
    // non-ASCII character (a "smart quote", curly apostrophe, or hidden Unicode
    // space slipped in by copy-paste) makes fetch throw an opaque
    // "non ISO-8859-1 code point" error. Catch it here and name the culprit.
    const badIdx = anonKey.search(/[^A-Za-z0-9._-]/);
    if (badIdx !== -1) {
      const cp = anonKey.codePointAt(badIdx).toString(16).toUpperCase().padStart(4, "0");
      throw new Error(
        `AOTD_SUPABASE_ANON_KEY has an unexpected character ${JSON.stringify(anonKey[badIdx])} ` +
        `(U+${cp}) at position ${badIdx} — a Supabase anon key is a plain token of ` +
        `A–Z, a–z, 0–9, '.', '-', '_'. This is usually a smart quote or hidden space ` +
        `from copy-paste; re-copy the key as plain text and re-export it.`);
    }
    _supabase = supabase.createClient(url, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    // `detectSessionInUrl` parses the magic-link hash asynchronously after
    // createClient returns. Reading getSession() synchronously here races that
    // parse and can resolve to null before the session lands — which dropped the
    // bearer token on first boot and left the #access_token in the URL. So we
    // wait for gotrue to settle the initial state first. gotrue v2 emits an
    // auth-state event (INITIAL_SESSION, or SIGNED_IN once a URL session is
    // detected) when startup — including URL detection — is done; the first such
    // event is our "detection finished" signal.
    let _resolveFirstEvent;
    const firstAuthEvent = new Promise((resolve) => { _resolveFirstEvent = resolve; });
    // Keep our bearer token in lockstep with the session, and unblock boot on
    // the first event.
    _supabase.auth.onAuthStateChange((_event, session) => {
      setToken(session ? session.access_token : null);
      if (_resolveFirstEvent) { _resolveFirstEvent(); _resolveFirstEvent = null; }
    });
    // Only gate on detection when there's actually a token/error in the URL to
    // pick up; otherwise (normal load) don't add latency. Cap the wait so a
    // missed event can never hang the app.
    const urlHasAuth = typeof location !== "undefined" && location.hash &&
      /access_token|error|[?&]code=/.test(location.hash + location.search);
    // Always wait for gotrue's first auth-state event (INITIAL_SESSION) before
    // reading getSession() — not only on a magic-link return. On a plain reload the
    // synchronous read can beat gotrue's async restore-from-storage and resolve to
    // null, dropping a signed-in user to the GUEST page with no warning (owner,
    // on-device 2026-07-04: "the update logged me straight out"). The event fires
    // ~immediately on a normal load; the timeout only guards a missed event.
    await Promise.race([
      firstAuthEvent,
      new Promise((resolve) => setTimeout(resolve, urlHasAuth ? 5000 : 3000)),
    ]);
    const { data } = await _supabase.auth.getSession();
    const session = data ? data.session : null;
    setToken(session ? session.access_token : null);
    // An OAuth/magic-link return that did NOT produce a session carries an error
    // in the URL (e.g. the invite-gate Before-User-Created hook rejected an
    // uninvited signup). Capture it *before* we scrub the hash so boot() can show
    // a helpful "not invited yet" screen instead of silently dropping to guest.
    const authError = session ? null : readAuthErrorFromUrl();
    // Clean the magic-link / error hash out of the URL bar once consumed.
    if (typeof location !== "undefined" && location.hash && /access_token|error/.test(location.hash)) {
      try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
    }
    return { configured: true, session, authError };
  }

  // Pull an OAuth error out of the post-redirect URL. Supabase puts it in the
  // hash (implicit) or the query (PKCE): error / error_code / error_description.
  // Returns { code, description } or null.
  function readAuthErrorFromUrl() {
    if (typeof location === "undefined") return null;
    try {
      for (const raw of [(location.hash || "").replace(/^#/, ""),
                         (location.search || "").replace(/^\?/, "")]) {
        if (!raw) continue;
        const p = new URLSearchParams(raw);
        const code = p.get("error_code") || p.get("error");
        const description = p.get("error_description");
        if (code || description) {
          return { code: code || "", description: description || "" };
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  // Finish an EMAIL sign-in by verifying the one-time code from the OTP email
  // (sendMagicLink below sends it). The code path replaces the magic-link redirect
  // on a phone, where bouncing out to Mail loses the tab; the email still carries a
  // link too, so clicking it (boot's URL handler) remains a fallback. Supabase issues
  // the same session JWT however you arrived, so auth.py and the sync transport are
  // unchanged.
  async function verifyEmailCode(email, token) {
    if (!_supabase) throw new Error("supabase not initialized");
    const { data, error } = await _supabase.auth.verifyOtp({
      email: (email || "").trim(), token: (token || "").trim(), type: "email",
    });
    if (error) throw error;
    const session = data ? data.session : null;
    setToken(session ? session.access_token : null);
    return session;
  }

  // NO SMS CHANNEL, deliberately (owner 2026-08-01). An earlier draft of this phase
  // added phone OTP alongside email. It was cut before shipping: the pain it was meant
  // to fix — a magic LINK bouncing out to Mail and losing the tab on a phone — is
  // already fixed by the email CODE above, at no cost. SMS would have added a 10DLC
  // registration + a standing monthly campaign fee to deliver a few dollars of texts a
  // year, and holding a number in the clear would have forced "only your email" to
  // widen across /privacy, /terms and VISION.md. Sign-in is identity only and the
  // server reads a JWT it never inspects the origin of (AUTH_REDESIGN_DESIGN.md §2), so
  // phone remains a drop-in with ZERO server change if a real reason ever appears.

  // Sign in with a third-party identity (Google, GitHub, …) so a user can reuse
  // an account they already have instead of creating a new one. This kicks off a
  // full-page redirect to the provider; on return, initSupabase()/boot() pick up
  // the session from the `?code=` the same way the email link does. Like every
  // other path this only establishes *identity* — the encryption passphrase still
  // unlocks the data, and the server still only ever sees ciphertext. Provider
  // must be enabled in the Supabase dashboard with its client id/secret + this
  // app's redirect URL allow-listed.
  async function signInWithOAuth(provider) {
    if (!_supabase) throw new Error("supabase not initialized");
    const redirect = (typeof location !== "undefined")
      ? location.origin + location.pathname : undefined;
    const { error } = await _supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: redirect },
    });
    if (error) throw error;
    return true;   // navigation happens; the page reloads on the provider's redirect
  }

  // Email a one-time sign-in OTP. The email carries BOTH a code and a link;
  // the passwordless flow leads with the code (verifyEmailCode) — clicking the link
  // still works via boot's URL handler as a fallback. shouldCreateUser:true so the
  // FIRST sign-in for an invited address also creates the account. Invite-only stays
  // enforced: the Before-User-Created hook (migration 0004) rejects an un-allow-listed
  // email at send time with its "not invited" message, which auth-ui routes to the
  // friendly request-access screen. (Name kept for continuity; it now backs code entry.)
  async function sendMagicLink(email) {
    if (!_supabase) throw new Error("supabase not initialized");
    const redirect = (typeof location !== "undefined")
      ? location.origin + location.pathname : undefined;
    const { error } = await _supabase.auth.signInWithOtp({
      email: (email || "").trim(),
      options: { emailRedirectTo: redirect, shouldCreateUser: true },
    });
    if (error) throw error;
    return true;
  }

  async function currentSession() {
    if (!_supabase) return null;
    const { data } = await _supabase.auth.getSession();
    return data ? data.session : null;
  }

  async function signOut() {
    if (_supabase) { try { await _supabase.auth.signOut(); } catch (e) {} }
    setToken(null);
  }

  function isConfigured() { return !!(_config && _config.configured); }

  // The built supabase-js client, or null in local/single-user mode. Exposed so
  // the readable feedback path (feedback-sync.js) can write straight to Supabase
  // Storage + the feedback table over the same session — the journal sync stays
  // on /api/sync/*, but feedback is the one deliberately-readable exception
  // (BETA_PLAN.md §1) and uses the RLS-guarded PostgREST/Storage path directly.
  function getSupabase() { return _supabase; }

  const mod = {
    configure, setToken, getToken,
    request,
    status, getKeys, putKeys, getRows, postRows, deleteRow, deleteAccount,
    publicConfig,
    initSupabase, signInWithOAuth,
    sendMagicLink, verifyEmailCode,
    currentSession, signOut, isConfigured, getSupabase,
  };
  return mod;
});
