/*
 * "Locked" must never render as "empty" (FB#92/#104).
 *
 * A reader was asked for their Notebook password instead of quick unlock, typed
 * it, and was told their notebook was empty. It wasn't. Two independent paths
 * produced that lie, and this file pins the half that lives in the store:
 * loadAll SKIPS a row it can't decrypt (right — one bad row must not sink the
 * load) but used to skip it silently, so a journal encrypted under a different
 * key decrypted to zero rows and the Notebook painted its empty-state invitation
 * over a full notebook.
 *
 * The store now counts what it couldn't open, so zero-notes-and-unreadable>0 is
 * distinguishable from a genuinely empty notebook. (The other half — the app
 * reading a failed 500 response as an empty feed — is fixed in app.js's
 * readJournal and checked in the browser.)
 *
 * Run: node tests/js/notebook-unreadable.test.mjs
 */
import { createRequire } from "module";
import { scryptSync } from "crypto";
const require = createRequire(import.meta.url);
const C = require("../../static/crypto.js");
const J = require("../../static/journal-store.js");

let passed = 0, failed = 0;
function ok(c, m) { if (c) passed++; else { failed++; console.error("  ✗ FAIL:", m); } }

C.configure({
  pwhash: async (pw, salt) =>
    new Uint8Array(scryptSync(Buffer.from(pw), Buffer.from(salt), 32, { N: 16384, r: 8, p: 1 })),
});

// A server that just holds rows, like sync.js's transport does.
function fakeSync() {
  const rows = new Map();
  let t = 0;
  return {
    async getRows() { return { rows: Array.from(rows.values()), count: rows.size, server_time: String(++t) }; },
    async postRows(list) {
      for (const r of list) rows.set(r.kind + "/" + r.client_id, {
        kind: r.kind, client_id: r.client_id, ciphertext: r.ciphertext,
        nonce: r.nonce, deleted: false, updated_at: String(++t),
      });
      return { ok: true, written: list.length, server_time: String(t) };
    },
    async deleteRow(kind, cid) {
      rows.set(kind + "/" + cid, { kind, client_id: cid, ciphertext: "", nonce: "", deleted: true, updated_at: String(++t) });
      return { ok: true };
    },
    _rows: rows,
  };
}

async function main() {
  console.log("notebook unreadable-vs-empty tests");
  const sync = fakeSync();
  const PASS = "unlock me", code = C.generateRecoveryCode();
  const keyA = (await C.createIdentity(PASS, code)).dek;
  // A different identity entirely — the shape of the reported failure, where the
  // key that unlocks isn't the key the rows were written under.
  const keyB = (await C.createIdentity("some other password", C.generateRecoveryCode())).dek;

  const albumA = { uid: "d:1", release_id: 1, artist: "Alpha", title: "First" };
  const albumB = { uid: "d:2", release_id: 2, artist: "Beta", title: "Second" };

  // Write a real notebook under key A: two notes and a kept record.
  const a = J.createStore({ crypto: C, sync });
  a.setKey(keyA);
  await a.loadAll();
  await a.addNote("d:1", albumA, "the droning track");
  await a.addNote("d:2", albumB, "fast vocals");
  await a.addChoice(albumA, null, "08-04", [], "kept it");
  ok(a.summary().notes === 2, "two notes written under key A");
  ok(a.unreadable() === 0, "nothing unreadable with the key that wrote them");

  // The reported failure: unlocked with a key that isn't the one that wrote them.
  const b = J.createStore({ crypto: C, sync });
  b.setKey(keyB);
  await b.loadAll();
  ok(b.summary().notes === 0, "wrong key decrypts no notes (skipped, not crashing)");
  ok(b.unreadable() === 3, `all 3 rows counted as unreadable (got ${b.unreadable()})`);
  ok(b.summary().unreadable === 3, "summary() carries the count for the feed");
  // The whole point: these two states are now tellable apart.
  ok(b.summary().notes === 0 && b.summary().unreadable > 0,
    "zero notes + unreadable > 0 = LOCKED, which must not render as empty");

  // A genuinely empty notebook is still genuinely empty — the new signal must not
  // cry wolf at a first-run reader, whose empty state is the right one to show.
  const emptySync = fakeSync();
  const fresh = J.createStore({ crypto: C, sync: emptySync });
  fresh.setKey((await C.createIdentity("first run", C.generateRecoveryCode())).dek);
  await fresh.loadAll();
  ok(fresh.summary().notes === 0 && fresh.summary().unreadable === 0,
    "a first-run notebook is empty with nothing unreadable");

  // Unlocking again with the right key clears the count — the state is per-load,
  // not sticky, so a recovered reader doesn't keep seeing the warning.
  const c = J.createStore({ crypto: C, sync });
  c.setKey(keyA);
  await c.loadAll();
  ok(c.summary().notes === 2 && c.summary().choices === 1, "right key reads the notebook back");
  ok(c.unreadable() === 0, "the count resets on a load that works");

  // clear() (lock / sign-out) forgets it too.
  c.clear();
  ok(c.unreadable() === 0, "locking clears the count");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
