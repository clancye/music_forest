/*
 * Write-gate test for the store engine (P4 signed-in reveal).
 *
 * With the signed-in Choose reveal, the app drops the veil the moment the DEK is
 * set — BEFORE loadAll has pulled + decrypted the journal — so a choice/note can
 * arrive while loadAll is still running. loadAll CLEARS state before repopulating,
 * so an un-gated early write would be wiped. This proves the gate: a write issued
 * concurrently with loadAll survives (isn't clobbered by the clear), alongside the
 * rows loadAll pulls from the server.
 *
 * Run: node tests/js/store-ready-gate.test.mjs
 */
import { createRequire } from "module";
import { scryptSync } from "crypto";
const require = createRequire(import.meta.url);
const C = require("../../static/crypto.js");
const J = require("../../static/journal-store.js");

let passed = 0, failed = 0;
function ok(c, m) { if (c) passed++; else { failed++; console.error("  ✗ FAIL:", m); } }

C.configure({
  pwhash: async (pw, salt) => new Uint8Array(scryptSync(Buffer.from(pw), Buffer.from(salt), 32, { N: 16384, r: 8, p: 1 })),
});

function fakeSync() {
  const rows = new Map();
  let t = 0;
  return {
    async getRows() { return { rows: Array.from(rows.values()), count: rows.size, server_time: String(++t) }; },
    async postRows(list) {
      for (const r of list) rows.set(r.kind + "/" + r.client_id,
        { kind: r.kind, client_id: r.client_id, ciphertext: r.ciphertext, nonce: r.nonce, deleted: false, updated_at: String(++t) });
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
  console.log("store write-gate tests");
  const sync = fakeSync();
  const PASS = "unlock me", code = C.generateRecoveryCode();
  const { dek } = await C.createIdentity(PASS, code);
  const album = (uid, title) => ({ uid, release_id: null, artist: "The Hidden Flame", title, released: "2020" });

  // Session 1: seed one note on the "server".
  const s1 = J.createStore({ crypto: C, sync });
  s1.setKey(dek);
  await s1.loadAll();
  ok(s1.ready() === true, "ready() true after loadAll");
  await s1.addNote("m:mb:group", album("m:mb:group", "A Heart Full of Ghosts"), "unspoken whispers is so cool");
  ok(s1.summary().notes === 1, "seeded one note");

  // Session 2: the P4 window — a write issued CONCURRENTLY with loadAll.
  const s2 = J.createStore({ crypto: C, sync });
  s2.setKey(dek);
  ok(s2.ready() === false, "ready() false before loadAll");
  const loading = s2.loadAll();                 // closes the gate + clears synchronously
  ok(s2.ready() === false, "gate closed while loadAll in flight");
  const writing = s2.addNote("m:mb:group", album("m:mb:group", "A Heart Full of Ghosts"),
                             "a second note made before the journal finished loading");
  await Promise.all([loading, writing]);        // both settle; the write waited its turn
  ok(s2.ready() === true, "ready() true after loadAll settles");

  // The concurrent write must NOT have been wiped by loadAll's clear, and the
  // server-loaded note must be present too.
  const bodies = s2.notes().map((n) => n.body).sort();
  ok(s2.summary().notes === 2, `both notes survive (got ${s2.summary().notes})`);
  ok(bodies.some((b) => /second note/.test(b)), "the concurrent write survived");
  ok(bodies.some((b) => /unspoken whispers/.test(b)), "the server-loaded note is present");

  // A fresh reload sees both (the write really persisted to the server).
  const s3 = J.createStore({ crypto: C, sync });
  s3.setKey(dek);
  await s3.loadAll();
  ok(s3.summary().notes === 2, "reload confirms both persisted");

  console.log(`\n${failed === 0 ? "GREEN" : "RED"}  (${passed} passed, ${failed} failed)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
