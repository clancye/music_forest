/*
 * KDF invariant lock for static/crypto.js — protects disaster recovery.
 *
 * The recovery drill (tools/restore_drill.mjs) can only decrypt a user's
 * irreplaceable backup if the KEK it derives is bit-identical to the one the
 * browser derived when wrapping the DEK. Today those run DIFFERENT libsodium
 * versions (the drill vendors 0.8.4 via npm; the browser loads 0.7.15 from the
 * CDN), and that's only safe because crypto.js derives the key from values that
 * do NOT depend on the library version:
 *
 *   - the algorithm is pinned explicitly to crypto_pwhash_ALG_ARGON2ID13
 *     (Argon2id v1.3), never the library's ALG_DEFAULT, and
 *   - the cost params (ops/mem) + salt come from the stored envelope, never a
 *     per-version default.
 *
 * If a future refactor switched to ALG_DEFAULT or hardcoded/changed the cost
 * params, the KEK could silently diverge and recovery would fail — discovered
 * only during a real data-loss event. This test locks the invariant: bind a FAKE
 * libsodium whose crypto_pwhash records its arguments, run a real wrap, and
 * assert the KDF was called with the ARGON2ID13 constant, a 32-byte key, and
 * exactly the caller's ops/mem.
 *
 * Run: node tests/js/crypto-kdf.test.mjs
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const AOTDCrypto = require("../../static/crypto.js");

let passed = 0, failed = 0;
const ok = (cond, msg) => cond ? passed++ : (failed++, console.error("  ✗ FAIL:", msg));

// A stand-in libsodium: crypto_pwhash records how it was called and returns a
// dummy KEK. The ARGON2ID13 constant gets a sentinel value; ALG_DEFAULT gets a
// DIFFERENT one so that reaching for the default (a real regression) is caught.
const ARGON2ID13 = 111;
const calls = [];
const fakeSodium = {
  crypto_pwhash_SALTBYTES: 16,
  crypto_pwhash_ALG_ARGON2ID13: ARGON2ID13,
  crypto_pwhash_ALG_DEFAULT: 999,
  crypto_pwhash(keyLen, pw, salt, ops, mem, alg) {
    calls.push({ keyLen, ops, mem, alg });
    return new Uint8Array(keyLen);
  },
};

AOTDCrypto.bindLibsodium(fakeSodium);

const PARAMS = { alg: "argon2id", ops: 3, mem: 64 * 1024 * 1024 };

(async () => {
  // createIdentity wraps the DEK under BOTH the passphrase and the recovery code,
  // so it drives the KDF at least twice — every call must hold the invariant.
  await AOTDCrypto.createIdentity("a-passphrase", "SOME-RECOVERY-CODE", PARAMS);

  ok(calls.length >= 1, "the KDF (crypto_pwhash) was actually invoked");
  for (const c of calls) {
    ok(c.alg === ARGON2ID13,
      `KDF must pin ALG_ARGON2ID13 (got ${c.alg}) — never the library default`);
    ok(c.keyLen === 32, `KDF key length must be 32 (got ${c.keyLen})`);
    ok(c.ops === PARAMS.ops, `KDF ops must come from the stored params (got ${c.ops})`);
    ok(c.mem === PARAMS.mem, `KDF mem must come from the stored params (got ${c.mem})`);
  }

  console.log(`crypto-kdf: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
