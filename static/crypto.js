"use strict";
/*
 * crypto.js — the end-to-end-encryption core (BETA_PLAN.md §3).
 *
 * Envelope key model:
 *   - DEK  : one random 256-bit key that actually encrypts the journal rows
 *            (AES-GCM). Held in memory as a NON-EXTRACTABLE WebCrypto CryptoKey
 *            after unlock; its raw bytes never live in a readable JS string for
 *            longer than the wrap/unwrap step, and are zeroed straight after.
 *   - KEK  : the passphrase, stretched by Argon2id, encrypts a copy of the DEK
 *            -> "wrapped-DEK-A".
 *   - KEK2 : a mandatory recovery code, stretched the same way, encrypts a
 *            SECOND copy of the DEK -> "wrapped-DEK-B".
 * The server stores both wrapped copies (opaque ciphertext) and never sees the
 * DEK, the passphrase, or the recovery code. Either secret unwraps the DEK;
 * losing both loses the data (recovery, not a backdoor). Changing the passphrase
 * just re-wraps the DEK — no bulk re-encrypt.
 *
 * Primitives are vetted only: WebCrypto for AES-GCM + CSPRNG, libsodium's
 * crypto_pwhash (Argon2id, WASM) for the KDF. No hand-rolled crypto.
 *
 * Testability: the Argon2id WASM can't run in the Python sandbox and is awkward
 * headless, so this module is KDF-AGNOSTIC at its core — `configure({pwhash})`
 * injects the key-stretch function. The browser binds it to libsodium via
 * `bindLibsodium(sodium)`; Node tests inject a stand-in KDF and exercise the
 * whole envelope (AES-GCM, DEK gen, wrap/unwrap under BOTH secrets, non-
 * extractable handling) against the real WebCrypto in Node. The Argon2id step
 * itself is covered by the in-browser smoke test.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod; // Node tests
  if (root) root.AOTDCrypto = mod;                                           // browser
})(typeof self !== "undefined" ? self : this, function () {

  // Resolve WebCrypto in both the browser and Node (>=16 exposes globalThis.crypto).
  const webcrypto =
    (typeof globalThis !== "undefined" && globalThis.crypto && globalThis.crypto.subtle)
      ? globalThis.crypto
      : (function () { try { return require("crypto").webcrypto; } catch (e) { return null; } })();
  if (!webcrypto || !webcrypto.subtle) {
    throw new Error("WebCrypto (crypto.subtle) is unavailable in this environment");
  }
  const subtle = webcrypto.subtle;

  // --- defaults --------------------------------------------------------------
  // Argon2id cost. Stored in the key material so unlock re-derives identically
  // and so the cost can be raised for new users without breaking old ones.
  // Memory kept at 64 MiB so a low-end phone won't OOM at unlock; ops=3.
  const DEFAULT_PARAMS = { alg: "argon2id", ops: 3, mem: 64 * 1024 * 1024 };
  const SALT_LEN = 16;   // libsodium crypto_pwhash_SALTBYTES
  const KEY_LEN = 32;    // 256-bit DEK / KEK
  const NONCE_LEN = 12;  // AES-GCM standard nonce
  const MATERIAL_VERSION = 1;

  // KDF injected via configure()/bindLibsodium(). Signature:
  //   pwhash(passwordBytes: Uint8Array, saltBytes: Uint8Array, params) -> Promise<Uint8Array(32)>
  let _pwhash = null;

  // --- small byte helpers ----------------------------------------------------
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function randomBytes(n) {
    const b = new Uint8Array(n);
    webcrypto.getRandomValues(b);
    return b;
  }
  function zero(bytes) { if (bytes) bytes.fill(0); }

  function b64encode(bytes) {
    let bin = "";
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
    if (typeof btoa === "function") return btoa(bin);
    return Buffer.from(arr).toString("base64");
  }
  function b64decode(str) {
    if (typeof atob === "function") {
      const bin = atob(str);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(str, "base64"));
  }

  // --- KDF wiring ------------------------------------------------------------
  function configure(opts) {
    if (opts && typeof opts.pwhash === "function") _pwhash = opts.pwhash;
    return mod;
  }

  /** Bind the production KDF to a ready libsodium-(wrappers-)sumo instance. */
  function bindLibsodium(sodium) {
    if (!sodium || typeof sodium.crypto_pwhash !== "function") {
      throw new Error("libsodium sumo build with crypto_pwhash is required");
    }
    _pwhash = async function (passwordBytes, saltBytes, params) {
      // ARGON2ID13 is libsodium's Argon2id. ops/mem come from the stored params.
      return sodium.crypto_pwhash(
        KEY_LEN, passwordBytes, saltBytes,
        params.ops, params.mem, sodium.crypto_pwhash_ALG_ARGON2ID13);
    };
    return mod;
  }

  async function deriveKEKBytes(secretStr, saltBytes, params) {
    if (!_pwhash) throw new Error("KDF not configured (call bindLibsodium first)");
    const pw = enc.encode(normalizeSecret(secretStr));
    try {
      const out = await _pwhash(pw, saltBytes, params);
      return out instanceof Uint8Array ? out : new Uint8Array(out);
    } finally {
      zero(pw);
    }
  }

  // Passphrases get Unicode-normalized so the same typed characters always
  // stretch to the same key across platforms/keyboards.
  function normalizeSecret(s) {
    return (typeof s === "string" ? s : String(s == null ? "" : s)).normalize("NFKC");
  }

  // --- AES-GCM helpers -------------------------------------------------------
  async function importAesKey(rawBytes, extractable, usages) {
    return subtle.importKey("raw", rawBytes, { name: "AES-GCM" },
      !!extractable, usages || ["encrypt", "decrypt"]);
  }

  async function aesEncrypt(key, plaintextBytes, aadBytes) {
    const nonce = randomBytes(NONCE_LEN);
    const params = { name: "AES-GCM", iv: nonce };
    if (aadBytes) params.additionalData = aadBytes;
    const ct = new Uint8Array(await subtle.encrypt(params, key, plaintextBytes));
    return { ciphertext: ct, nonce };
  }

  async function aesDecrypt(key, ciphertextBytes, nonceBytes, aadBytes) {
    const params = { name: "AES-GCM", iv: nonceBytes };
    if (aadBytes) params.additionalData = aadBytes;
    const pt = await subtle.decrypt(params, key, ciphertextBytes);
    return new Uint8Array(pt);
  }

  // --- recovery code ---------------------------------------------------------
  // Crockford base32 (no I/L/O/U) over 16 random bytes = 128 bits, grouped in
  // 5s for legibility. Shown ONCE at signup behind a save-acknowledgement gate.
  const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

  function generateRecoveryCode() {
    const bytes = randomBytes(16);
    let bits = 0, value = 0, out = "";
    for (let i = 0; i < bytes.length; i++) {
      value = (value << 8) | bytes[i];
      bits += 8;
      while (bits >= 5) {
        out += CROCKFORD[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
    zero(bytes);
    return out.replace(/(.{5})/g, "$1-").replace(/-$/, "");
  }

  // Normalize a typed recovery code: uppercase, strip separators, map the
  // commonly-confused glyphs back (I/L->1, O->0) so transcription slips unlock.
  function normalizeRecoveryCode(code) {
    return (code || "").toUpperCase().replace(/[\s-]+/g, "")
      .replace(/O/g, "0").replace(/[IL]/g, "1");
  }

  // --- wrapped-DEK entries ---------------------------------------------------
  // Wrap raw DEK bytes under a secret -> {salt, ops, mem, alg, ct, nonce} (all
  // binary base64). Each call uses a FRESH salt + nonce.
  async function wrapDEK(dekBytes, secretStr, params) {
    const salt = randomBytes(SALT_LEN);
    const kekBytes = await deriveKEKBytes(secretStr, salt, params);
    try {
      const kek = await importAesKey(kekBytes, false, ["encrypt", "decrypt"]);
      const { ciphertext, nonce } = await aesEncrypt(kek, dekBytes, null);
      return {
        alg: params.alg, ops: params.ops, mem: params.mem,
        salt: b64encode(salt), ct: b64encode(ciphertext), nonce: b64encode(nonce),
      };
    } finally {
      zero(kekBytes);
    }
  }

  // Unwrap raw DEK bytes from an entry using a secret. Throws on a wrong secret
  // (AES-GCM auth failure). Caller MUST zero the returned bytes when done.
  async function unwrapDEKBytes(entry, secretStr) {
    const params = { alg: entry.alg, ops: entry.ops, mem: entry.mem };
    const salt = b64decode(entry.salt);
    const kekBytes = await deriveKEKBytes(secretStr, salt, params);
    try {
      const kek = await importAesKey(kekBytes, false, ["encrypt", "decrypt"]);
      return await aesDecrypt(kek, b64decode(entry.ct), b64decode(entry.nonce), null);
    } finally {
      zero(kekBytes);
    }
  }

  // --- key material (the opaque blob the server stores) ----------------------
  function emptyParams(params) {
    return Object.assign({}, DEFAULT_PARAMS, params || {});
  }

  /**
   * First-run setup: generate a DEK, wrap it under BOTH the passphrase and the
   * recovery code. Returns the JSON-serializable `keyMaterial` to PUT to
   * /api/sync/keys and the in-memory non-extractable `dek` CryptoKey.
   */
  async function createIdentity(passphrase, recoveryCode, params) {
    const p = emptyParams(params);
    const dekBytes = randomBytes(KEY_LEN);
    try {
      const passphraseEntry = await wrapDEK(dekBytes, passphrase, p);
      const recoveryEntry = await wrapDEK(
        dekBytes, normalizeRecoveryCode(recoveryCode), p);
      const dek = await importAesKey(dekBytes, false, ["encrypt", "decrypt"]);
      const keyMaterial = {
        v: MATERIAL_VERSION,
        kdf: p.alg,
        dek_alg: "AES-GCM-256",
        passphrase: passphraseEntry,
        recovery: recoveryEntry,
      };
      return { keyMaterial, dek };
    } finally {
      zero(dekBytes);
    }
  }

  /** Unlock with the passphrase -> non-extractable DEK CryptoKey. */
  async function unlockWithPassphrase(keyMaterial, passphrase) {
    return _unlock(keyMaterial.passphrase, passphrase);
  }

  /** Unlock with the recovery code -> non-extractable DEK CryptoKey. */
  async function unlockWithRecovery(keyMaterial, recoveryCode) {
    return _unlock(keyMaterial.recovery, normalizeRecoveryCode(recoveryCode));
  }

  async function _unlock(entry, secret) {
    if (!entry) throw new Error("no wrapped key for that method");
    const dekBytes = await unwrapDEKBytes(entry, secret);
    try {
      return await importAesKey(dekBytes, false, ["encrypt", "decrypt"]);
    } finally {
      zero(dekBytes);
    }
  }

  /**
   * Change the passphrase (or, via the recovery code, the lost-passphrase reset
   * — task 7): unwrap the DEK from `current` (a {passphrase|recovery, secret}),
   * re-wrap the passphrase copy under `newPassphrase`, KEEP the existing
   * recovery copy. Returns the updated keyMaterial and a fresh DEK CryptoKey.
   * The DEK never changes, so no rows need re-encrypting.
   */
  async function changePassphrase(keyMaterial, current, newPassphrase, params) {
    const entry = current.via === "recovery"
      ? keyMaterial.recovery : keyMaterial.passphrase;
    const secret = current.via === "recovery"
      ? normalizeRecoveryCode(current.secret) : current.secret;
    const dekBytes = await unwrapDEKBytes(entry, secret);
    try {
      const p = emptyParams(params || { ops: keyMaterial.passphrase.ops,
        mem: keyMaterial.passphrase.mem });
      const passphraseEntry = await wrapDEK(dekBytes, newPassphrase, p);
      const updated = Object.assign({}, keyMaterial, {
        v: MATERIAL_VERSION, kdf: p.alg, passphrase: passphraseEntry,
      });
      const dek = await importAesKey(dekBytes, false, ["encrypt", "decrypt"]);
      return { keyMaterial: updated, dek };
    } finally {
      zero(dekBytes);
    }
  }

  // --- device-trust entry (WebAuthn PRF-gated, device-local) -----------------
  // Opt-in "stay unlocked on this device" (BETA_PLAN.md §3a). A third wrapped
  // copy of the DEK, encrypted under a 32-byte key-encryption-key that a platform
  // authenticator's WebAuthn PRF extension only releases AFTER a successful user
  // verification (Face ID / fingerprint / device PIN). Unlike the passphrase and
  // recovery entries this copy is stored DEVICE-LOCALLY (IndexedDB), never on the
  // server, and the KEK is never stored anywhere — it is reproduced solely by the
  // authenticator at unlock time. So the bytes at rest are useless without the
  // device's biometric/PIN, which is exactly the "stolen laptop" protection.
  //
  // The KEK is raw PRF output (already 256 bits of CSPRNG-grade material), so —
  // unlike the human secrets — it needs no Argon2 stretching; it imports directly
  // as the AES-GCM wrapping key.
  async function _wrapDEKRaw(dekBytes, kekBytes) {
    if (!(kekBytes instanceof Uint8Array) || kekBytes.length !== KEY_LEN) {
      throw new Error("device KEK must be 32 raw bytes");
    }
    const kek = await importAesKey(kekBytes, false, ["encrypt", "decrypt"]);
    const { ciphertext, nonce } = await aesEncrypt(kek, dekBytes, null);
    return { dek_alg: "AES-GCM-256", ct: b64encode(ciphertext), nonce: b64encode(nonce) };
  }

  async function _unwrapDEKRaw(entry, kekBytes) {
    if (!(kekBytes instanceof Uint8Array) || kekBytes.length !== KEY_LEN) {
      throw new Error("device KEK must be 32 raw bytes");
    }
    const kek = await importAesKey(kekBytes, false, ["encrypt", "decrypt"]);
    return aesDecrypt(kek, b64decode(entry.ct), b64decode(entry.nonce), null);
  }

  /**
   * Enroll this device: re-derive the DEK from a human secret the user just
   * proved (passphrase or recovery code), then wrap it under the device's PRF
   * KEK. Returns the device entry to persist locally. We go through the human
   * secret because the live DEK is a non-extractable CryptoKey — its raw bytes
   * can't be read back out — so a fresh copy is produced here under the secret
   * the user just supplied.
   */
  async function enrollDeviceEntry(keyMaterial, current, kekBytes) {
    const entry = current.via === "recovery"
      ? keyMaterial.recovery : keyMaterial.passphrase;
    const secret = current.via === "recovery"
      ? normalizeRecoveryCode(current.secret) : current.secret;
    const dekBytes = await unwrapDEKBytes(entry, secret);
    try {
      return await _wrapDEKRaw(dekBytes, kekBytes);
    } finally {
      zero(dekBytes);
    }
  }

  /** Unlock from a device entry using the PRF KEK -> non-extractable DEK. */
  async function unlockWithDeviceEntry(deviceEntry, kekBytes) {
    if (!deviceEntry) throw new Error("no device entry");
    const dekBytes = await _unwrapDEKRaw(deviceEntry, kekBytes);
    try {
      return await importAesKey(dekBytes, false, ["encrypt", "decrypt"]);
    } finally {
      zero(dekBytes);
    }
  }

  // --- row encryption --------------------------------------------------------
  // Bind each row's ciphertext to its (kind, client_id) as Additional
  // Authenticated Data, so a row can't be silently relocated to another id/kind.
  function rowAAD(kind, clientId) {
    return enc.encode(`${kind}:${clientId}`);
  }

  /**
   * Encrypt a journal row object for /api/sync/rows. Returns base64
   * {ciphertext, nonce} exactly as the sync layer expects. The whole row
   * (including release_id + the album snapshot) goes inside the plaintext.
   */
  async function encryptRow(dek, kind, clientId, obj) {
    const plaintext = enc.encode(JSON.stringify(obj));
    const { ciphertext, nonce } = await aesEncrypt(dek, plaintext, rowAAD(kind, clientId));
    zero(plaintext);
    return { ciphertext: b64encode(ciphertext), nonce: b64encode(nonce) };
  }

  /** Decrypt a stored row back to its object. Throws on tamper/wrong key. */
  async function decryptRow(dek, kind, clientId, ciphertextB64, nonceB64) {
    const pt = await aesDecrypt(dek, b64decode(ciphertextB64), b64decode(nonceB64),
      rowAAD(kind, clientId));
    const text = dec.decode(pt);
    zero(pt);
    return JSON.parse(text);
  }

  /** A stable, collision-resistant client_id for a new row. */
  function newClientId() {
    if (webcrypto.randomUUID) return webcrypto.randomUUID();
    const b = randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  const mod = {
    DEFAULT_PARAMS,
    configure, bindLibsodium,
    randomBytes, b64encode, b64decode,
    generateRecoveryCode, normalizeRecoveryCode, normalizeSecret,
    createIdentity, unlockWithPassphrase, unlockWithRecovery, changePassphrase,
    enrollDeviceEntry, unlockWithDeviceEntry,
    encryptRow, decryptRow, newClientId,
    // exposed for tests
    _wrapDEK: wrapDEK, _unwrapDEKBytes: unwrapDEKBytes,
  };
  return mod;
});
