"use strict";
/*
 * sync.js — auth session + the authenticated transport to the H1.1 sync layer.
 *
 * Two jobs (BETA_PLAN.md §2, §4):
 *   1. Identity. Wrap supabase-js: sign in with email+password
 *      (signInWithPassword), or fall back to a one-time link (signInWithOtp) for
 *      accounts without a password yet; hold the session JWT, refresh it, sign
 *      out. setLoginPassword lets a signed-in user set/change that password.
 *   2. Transport. Attach `Authorization: Bearer <jwt>` to every /api/sync/* call
 *      and expose typed helpers over the H1.1 routes: status, keys (GET/PUT),
 *      rows (GET with ?since= delta + ?kind=, POST batch upsert/tombstone,
 *      DELETE one).
 *
 * The transport core is decoupled from supabase-js so it's testable headlessly:
 * `configure({ fetch, getToken })` injects a fetch + token source. The browser
 * wires those to window.fetch and the live Supabase session; a Node test wires a
 * mock fetch and asserts the bearer header is attached.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  if (root) root.AOTDSync = mod;
})(typeof self !== "undefined" ? self : this, function () {

  let _fetch = (typeof fetch !== "undefined") ? fetch.bind(globalThis) : null;
  let _getToken = () => _token;     // default token source: the module holder
  let _token = null;                // current session JWT (or null = local mode)
  let _supabase = null;             // supabase-js client (browser only)
  let _config = null;               // {configured, supabase_url, anon_key}

  function configure(opts) {
    if (!opts) return mod;
    if (typeof opts.fetch === "function") _fetch = opts.fetch;
    if (typeof opts.getToken === "function") _getToken = opts.getToken;
    return mod;
  }
  function setToken(jwt) { _token = jwt || null; return mod; }
  function getToken() { return _getToken(); }

  // --- low-level authed request ---------------------------------------------
  async function request(path, { method = "GET", body = null } = {}) {
    if (!_fetch) throw new Error("no fetch available");
    const headers = {};
    const token = _getToken();
    // Attach identity whenever we have it. In single-user local mode there is no
    // token and the server bypasses auth — so a missing header is fine there.
    if (token) headers["Authorization"] = "Bearer " + token;
    if (body != null) headers["Content-Type"] = "application/json";
    const resp = await _fetch(path, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await resp.json(); } catch (e) { data = null; }
    if (!resp.ok) {
      const msg = (data && data.error) || `${resp.status} ${resp.statusText || ""}`.trim();
      const err = new Error(msg);
      err.status = resp.status;
      err.data = data;
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

  // Primary sign-in: email + password. Returns the session on success (and keeps
  // our bearer token in lockstep), or throws on bad credentials. Supabase issues
  // the same session JWT whether you arrived by password or magic link, so the
  // server-side verification (auth.py) and the whole sync transport are unchanged.
  async function signInWithPassword(email, password) {
    if (!_supabase) throw new Error("supabase not initialized");
    const { data, error } = await _supabase.auth.signInWithPassword({
      email: (email || "").trim(),
      password: password || "",
    });
    if (error) throw error;
    const session = data ? data.session : null;
    setToken(session ? session.access_token : null);
    return session;
  }

  // Set (or change) the account's sign-in password for the *current* session.
  // Accounts created via magic link start with no password; this is how a
  // signed-in user adopts one. This is the Supabase *identity* password — wholly
  // separate from the client-side encryption passphrase, which the server never
  // sees and this call never touches.
  async function setLoginPassword(password) {
    if (!_supabase) throw new Error("supabase not initialized");
    const { error } = await _supabase.auth.updateUser({ password: password || "" });
    if (error) throw error;
    return true;
  }

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

  // Email a one-time sign-in link. Three jobs: an account with no password yet,
  // the way back in when the sign-in password is forgotten, and — since
  // 2026-07-02 — the FIRST sign-in for an invited address on any mail provider
  // (shouldCreateUser:true, so the link also creates the account). Invite-only
  // is still enforced: the Before-User-Created hook (migration 0004) rejects an
  // un-allow-listed email at send time with its "not invited" message, which
  // auth-ui routes to the friendly request-access screen. The old `false`
  // predated the hook and blocked invited first-timers before the allow-list
  // was ever consulted (found in H2 live QA).
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
    initSupabase, signInWithPassword, signInWithOAuth, setLoginPassword,
    sendMagicLink, currentSession, signOut, isConfigured, getSupabase,
  };
  return mod;
});
