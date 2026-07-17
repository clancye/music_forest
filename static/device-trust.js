"use strict";
/*
 * device-trust.js — opt-in "stay unlocked on this device" via WebAuthn PRF.
 *
 * The point (BETA_PLAN.md §3a): let a user skip the encryption passphrase on a
 * device they trust, WITHOUT the usual cost of persisting a usable key. The DEK
 * is wrapped (in crypto.js) under a 32-byte key-encryption-key that comes from
 * the WebAuthn **PRF extension** (a.k.a. hmac-secret) of a *platform*
 * authenticator. That KEK only materializes after the device verifies the user
 * (Face ID / fingerprint / PIN); it is never stored. What we persist locally is
 * only: the credential id, a random PRF salt, and the PRF-wrapped DEK — all
 * useless without the authenticator. So a stolen/borrowed device still can't
 * open the journal, while an everyday reload is a single biometric tap.
 *
 * This module is two halves:
 *   - WebAuthn: supported(), register(), assert() — turn a biometric into KEK
 *     bytes, or report cleanly that this browser/device can't do PRF.
 *   - IndexedDB: save/load/clear the per-user device record (credentialId,
 *     prfSalt, deviceEntry), keyed by the Supabase user UUID.
 *
 * Nothing here ever touches the server, the passphrase, or the recovery code.
 * If anything is unsupported it returns a falsy/UNSUPPORTED result and the
 * caller falls back to the passphrase — device-trust is strictly additive.
 */
(function () {
  // A fixed application label baked into the PRF salt so our evaluations are
  // namespaced and never collide with another site's use of the same credential.
  const PRF_LABEL = "aotd-device-trust-v1";
  const DB_NAME = "aotd-device-trust";
  const DB_VERSION = 1;
  const STORE = "devices";
  const KEY_LEN = 32;

  // --- small byte helpers (self-contained; no dependency on crypto.js) -------
  function u8(buf) { return buf instanceof Uint8Array ? buf : new Uint8Array(buf); }
  function b64encode(bytes) {
    let bin = "";
    const a = u8(bytes);
    for (let i = 0; i < a.length; i++) bin += String.fromCharCode(a[i]);
    return btoa(bin);
  }
  function b64decode(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function randomBytes(n) {
    const b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return b;
  }
  // Stable per-account WebAuthn user.id: hash the UUID string to 32 bytes so the
  // credential is bound to the account without putting the raw UUID in the
  // authenticator's user handle.
  async function userHandle(userId) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(userId)));
    return u8(digest);
  }
  // The PRF salt persisted per device. Random per enrollment so two devices for
  // the same account derive independent KEKs.
  function prfSaltBytes(saltB64) {
    // Namespace the stored random salt under our label, matching at assert time.
    const label = new TextEncoder().encode(PRF_LABEL);
    const rnd = b64decode(saltB64);
    const out = new Uint8Array(label.length + rnd.length);
    out.set(label, 0); out.set(rnd, label.length);
    return out;
  }

  // --- capability detection --------------------------------------------------
  // True only when this is a secure context with a *platform* authenticator
  // available. PRF support itself can't be probed without a credential, so the
  // definitive PRF check happens in register() (and we surface UNSUPPORTED there).
  async function supported() {
    try {
      if (typeof PublicKeyCredential === "undefined") return false;
      if (typeof window !== "undefined" && window.isSecureContext === false) return false;
      if (!navigator.credentials || !navigator.credentials.create) return false;
      if (PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) {
        return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
      }
      return false;
    } catch (e) { return false; }
  }

  function rpId() {
    // Use the registrable host. localhost / 127.0.0.1 are valid RP IDs for dev.
    return (typeof location !== "undefined" && location.hostname) || "localhost";
  }

  class UnsupportedError extends Error {
    constructor(msg) { super(msg || "device biometric unlock isn't available here"); this.code = "UNSUPPORTED"; }
  }

  // --- register: create a platform credential + obtain the PRF KEK -----------
  // Returns { credentialId (b64), prfSalt (b64), kekBytes (Uint8Array 32) }.
  // Two user-verification taps: one to create the credential, one to evaluate
  // PRF (the most browser-compatible sequence). Throws UnsupportedError if the
  // authenticator/browser doesn't do PRF, so the caller can fall back cleanly.
  async function register(opts) {
    const userId = opts.userId;
    const userName = opts.userName || "journal";
    const rpName = opts.rpName || "Music Forest";
    const handle = await userHandle(userId);

    const created = await navigator.credentials.create({
      publicKey: {
        challenge: randomBytes(32),
        rp: { id: rpId(), name: rpName },
        user: { id: handle, name: userName, displayName: userName },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },    // ES256
          { type: "public-key", alg: -257 },  // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          // We always pass allowCredentials at assert time, so the credential
          // need not be discoverable — "preferred" avoids needless enrolment
          // failures on authenticators with limited resident-key slots.
          residentKey: "preferred",
          userVerification: "required",
        },
        timeout: 60000,
        extensions: { prf: {} },
      },
    });
    if (!created) throw new UnsupportedError();
    const ext = created.getClientExtensionResults ? created.getClientExtensionResults() : {};
    if (!ext.prf || ext.prf.enabled !== true) {
      // Credential made but the authenticator won't do PRF — useless to us.
      throw new UnsupportedError("this device's authenticator doesn't support PRF");
    }
    const credentialId = b64encode(created.rawId);
    const saltB64 = b64encode(randomBytes(32));
    const kekBytes = await evaluatePRF(credentialId, saltB64);
    return { credentialId, prfSalt: saltB64, kekBytes };
  }

  // --- assert: re-derive the PRF KEK for an existing credential --------------
  // One user-verification tap. Returns Uint8Array(32). Throws on cancel/failure.
  async function assert(record) {
    return evaluatePRF(record.credentialId, record.prfSalt);
  }

  async function evaluatePRF(credentialId, saltB64) {
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        rpId: rpId(),
        allowCredentials: [{ type: "public-key", id: b64decode(credentialId) }],
        userVerification: "required",
        timeout: 60000,
        extensions: { prf: { eval: { first: prfSaltBytes(saltB64) } } },
      },
    });
    if (!assertion) throw new UnsupportedError();
    const ext = assertion.getClientExtensionResults ? assertion.getClientExtensionResults() : {};
    const first = ext.prf && ext.prf.results && ext.prf.results.first;
    if (!first) throw new UnsupportedError("no PRF output returned");
    const kek = u8(first);
    if (kek.length < KEY_LEN) throw new Error("PRF output too short");
    // PRF output may be >32 bytes on some authenticators; take the first 32.
    return kek.length === KEY_LEN ? kek : kek.slice(0, KEY_LEN);
  }

  // --- IndexedDB (per-user device record) ------------------------------------
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idb(mode, fn) {
    const db = await openDB();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        const out = fn(store);
        tx.oncomplete = () => resolve(out._result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  }
  // record = { credentialId, prfSalt, deviceEntry }  (no key material — all wrapped)
  async function save(userId, record) {
    return idb("readwrite", (store) => {
      const r = store.put(record, String(userId));
      const box = {}; r.onsuccess = () => { box._result = true; };
      return box;
    });
  }
  async function load(userId) {
    return idb("readonly", (store) => {
      const r = store.get(String(userId));
      const box = {}; r.onsuccess = () => { box._result = r.result || null; };
      return box;
    });
  }
  async function clear(userId) {
    return idb("readwrite", (store) => {
      const r = store.delete(String(userId));
      const box = {}; r.onsuccess = () => { box._result = true; };
      return box;
    });
  }
  async function has(userId) { return !!(await load(userId)); }

  window.AOTDDevice = {
    supported, register, assert, save, load, clear, has,
    UnsupportedError,
  };
})();
