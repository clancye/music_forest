/*
 * Headless tests for static/crypto.js — the E2EE envelope core.
 *
 * The Argon2id WASM (libsodium) can't run in the Python sandbox and is awkward
 * to vendor offline, so these tests inject a SUBSTITUTE KDF (Node's scrypt) and
 * exercise everything else against the REAL WebCrypto in Node: the AES-GCM row
 * round-trip, wrap/unwrap under BOTH the passphrase and the recovery code,
 * wrong-secret rejection, non-extractable DEK handling, AAD binding, and the
 * passphrase-change / recovery-reset re-wrap. The Argon2id step itself is
 * covered by the in-browser smoke test (SMOKE_TEST_H1_2.md).
 *
 * Run: node tests/js/crypto.test.mjs
 */
import { createRequire } from "module";
import { scryptSync } from "crypto";
const require = createRequire(import.meta.url);
const AOTDCrypto = require("../../static/crypto.js");

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error("  ✗ FAIL:", msg); }
}
async function throws(fn, msg) {
  try { await fn(); failed++; console.error("  ✗ FAIL (expected throw):", msg); }
  catch (e) { passed++; }
}

// Substitute KDF: deterministic, salt-dependent, fast. Stands in for Argon2id
// purely to derive 32 KEK bytes from (secret, salt); the envelope logic under
// test is identical regardless of which KDF produced those bytes.
AOTDCrypto.configure({
  pwhash: async (passwordBytes, saltBytes, params) =>
    new Uint8Array(scryptSync(Buffer.from(passwordBytes), Buffer.from(saltBytes), 32, { N: 16384, r: 8, p: 1 })),
});

const PASS = "correct horse battery staple";
const params = { alg: "argon2id", ops: 3, mem: 64 * 1024 * 1024 };

async function main() {
  console.log("crypto.js envelope tests");

  // 1. createIdentity yields material with both wrapped copies + a CryptoKey.
  const rec = AOTDCrypto.generateRecoveryCode();
  ok(/^[0-9A-Z]{5}(-[0-9A-Z]{1,5})+$/.test(rec), "recovery code is grouped Crockford base32");
  const { keyMaterial, dek } = await AOTDCrypto.createIdentity(PASS, rec, params);
  ok(keyMaterial.passphrase && keyMaterial.passphrase.ct, "passphrase-wrapped DEK present");
  ok(keyMaterial.recovery && keyMaterial.recovery.ct, "recovery-wrapped DEK present");
  ok(keyMaterial.passphrase.salt !== keyMaterial.recovery.salt, "the two wraps use different salts");
  ok(dek.extractable === false, "in-memory DEK CryptoKey is non-extractable");
  ok(dek.type === "secret", "DEK is a secret key");

  // 2. Non-extractable: raw bytes can't be exported.
  await throws(() => crypto.subtle.exportKey("raw", dek), "exportKey on non-extractable DEK must reject");

  // 3. Row round-trip with the live DEK.
  const row = { release_id: 123, artist: "Nina Simone", title: "Pastel Blues",
    body: "**wow** — _the voice_", track: "Sinnerman", ts: "2026-06-20" };
  const blob = await AOTDCrypto.encryptRow(dek, "note", "cid-1", row);
  ok(typeof blob.ciphertext === "string" && typeof blob.nonce === "string", "encryptRow returns base64 strings");
  const back = await AOTDCrypto.decryptRow(dek, "note", "cid-1", blob.ciphertext, blob.nonce);
  ok(JSON.stringify(back) === JSON.stringify(row), "row decrypts back identically");

  // 4. Two encryptions of the same row differ (fresh nonce).
  const blob2 = await AOTDCrypto.encryptRow(dek, "note", "cid-1", row);
  ok(blob.ciphertext !== blob2.ciphertext, "fresh nonce -> different ciphertext each time");

  // 5. AAD binding: decrypting under a different (kind, client_id) must fail.
  await throws(() => AOTDCrypto.decryptRow(dek, "note", "cid-OTHER", blob.ciphertext, blob.nonce),
    "AAD mismatch (wrong client_id) must reject");
  await throws(() => AOTDCrypto.decryptRow(dek, "pick", "cid-1", blob.ciphertext, blob.nonce),
    "AAD mismatch (wrong kind) must reject");

  // 6. Unlock with the passphrase reproduces a working DEK.
  const dekP = await AOTDCrypto.unlockWithPassphrase(keyMaterial, PASS);
  ok(dekP.extractable === false, "passphrase-unlocked DEK is non-extractable");
  const backP = await AOTDCrypto.decryptRow(dekP, "note", "cid-1", blob.ciphertext, blob.nonce);
  ok(JSON.stringify(backP) === JSON.stringify(row), "passphrase-unlocked DEK decrypts the row");

  // 7. Unlock with the recovery code reproduces the SAME DEK (both wrap one key).
  const dekR = await AOTDCrypto.unlockWithRecovery(keyMaterial, rec);
  const backR = await AOTDCrypto.decryptRow(dekR, "note", "cid-1", blob.ciphertext, blob.nonce);
  ok(JSON.stringify(backR) === JSON.stringify(row), "recovery-unlocked DEK decrypts the row");

  // 7b. Recovery code is whitespace/case/glyph tolerant.
  const messy = (" " + rec.toLowerCase().replace(/-/g, "  ") + " ");
  const dekR2 = await AOTDCrypto.unlockWithRecovery(keyMaterial, messy);
  ok(!!(await AOTDCrypto.decryptRow(dekR2, "note", "cid-1", blob.ciphertext, blob.nonce)),
    "recovery code unlock tolerates spacing/case");

  // 8. Wrong secrets are rejected.
  await throws(() => AOTDCrypto.unlockWithPassphrase(keyMaterial, "wrong pass"), "wrong passphrase rejected");
  await throws(() => AOTDCrypto.unlockWithRecovery(keyMaterial, "00000-00000-00000-00000-00000"),
    "wrong recovery code rejected");

  // 9. Passphrase change re-wraps under a new passphrase, keeps recovery, same DEK.
  const NEWPASS = "a brand new passphrase";
  const changed = await AOTDCrypto.changePassphrase(keyMaterial, { via: "passphrase", secret: PASS }, NEWPASS, params);
  ok(changed.keyMaterial.passphrase.ct !== keyMaterial.passphrase.ct, "passphrase wrap changed");
  ok(changed.keyMaterial.recovery.ct === keyMaterial.recovery.ct, "recovery wrap unchanged on passphrase change");
  await throws(() => AOTDCrypto.unlockWithPassphrase(changed.keyMaterial, PASS), "old passphrase no longer unlocks");
  const dekN = await AOTDCrypto.unlockWithPassphrase(changed.keyMaterial, NEWPASS);
  const backN = await AOTDCrypto.decryptRow(dekN, "note", "cid-1", blob.ciphertext, blob.nonce);
  ok(JSON.stringify(backN) === JSON.stringify(row), "new passphrase unlocks the SAME DEK (no re-encrypt needed)");

  // 10. Lost-passphrase recovery reset: set a new passphrase via the recovery code.
  const RESETPASS = "reset via recovery code";
  const reset = await AOTDCrypto.changePassphrase(keyMaterial, { via: "recovery", secret: rec }, RESETPASS, params);
  const dekReset = await AOTDCrypto.unlockWithPassphrase(reset.keyMaterial, RESETPASS);
  const backReset = await AOTDCrypto.decryptRow(dekReset, "note", "cid-1", blob.ciphertext, blob.nonce);
  ok(JSON.stringify(backReset) === JSON.stringify(row), "recovery-reset passphrase unlocks the original DEK");

  // 11. Tamper detection: flip a ciphertext byte -> auth failure.
  const tampered = AOTDCrypto.b64decode(blob.ciphertext);
  tampered[0] ^= 0xff;
  await throws(() => AOTDCrypto.decryptRow(dek, "note", "cid-1", AOTDCrypto.b64encode(tampered), blob.nonce),
    "tampered ciphertext rejected (GCM auth)");

  // 12. Device-trust entry: a raw-KEK (WebAuthn PRF stand-in) wrap of the DEK.
  //     The KEK here mimics the 32-byte PRF output the authenticator returns.
  const prfKek = new Uint8Array(crypto.getRandomValues(new Uint8Array(32)));
  const deviceEntry = await AOTDCrypto.enrollDeviceEntry(
    keyMaterial, { via: "passphrase", secret: PASS }, prfKek);
  ok(deviceEntry && deviceEntry.ct && deviceEntry.nonce, "enrollDeviceEntry yields a wrapped entry");
  ok(!deviceEntry.salt, "device entry has no KDF salt (raw KEK, no Argon2 stretch)");
  const dekDev = await AOTDCrypto.unlockWithDeviceEntry(deviceEntry, prfKek);
  ok(dekDev.extractable === false, "device-unlocked DEK is non-extractable");
  const backDev = await AOTDCrypto.decryptRow(dekDev, "note", "cid-1", blob.ciphertext, blob.nonce);
  ok(JSON.stringify(backDev) === JSON.stringify(row), "device-unlocked DEK decrypts the SAME row");

  // 12b. Enrolling via the recovery code wraps the same DEK.
  const deviceEntryR = await AOTDCrypto.enrollDeviceEntry(
    keyMaterial, { via: "recovery", secret: rec }, prfKek);
  const dekDevR = await AOTDCrypto.unlockWithDeviceEntry(deviceEntryR, prfKek);
  ok(!!(await AOTDCrypto.decryptRow(dekDevR, "note", "cid-1", blob.ciphertext, blob.nonce)),
    "device entry enrolled via recovery code unlocks the same DEK");

  // 12c. A wrong PRF KEK (no/forged biometric) must fail to unwrap.
  const wrongKek = new Uint8Array(32); wrongKek[0] = 1;
  await throws(() => AOTDCrypto.unlockWithDeviceEntry(deviceEntry, wrongKek),
    "wrong device KEK rejected (GCM auth)");
  // 12d. A malformed KEK length is rejected outright.
  await throws(() => AOTDCrypto.unlockWithDeviceEntry(deviceEntry, new Uint8Array(16)),
    "device KEK must be exactly 32 bytes");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
