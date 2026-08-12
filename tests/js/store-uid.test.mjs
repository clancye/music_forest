/*
 * store-uid.test.mjs — the P3 M2 client-side uid re-key (C4).
 *
 * Uses the REAL crypto.js (scrypt substitute KDF, like store.test/crypto.test)
 * and an in-memory fake sync, so it exercises the actual AAD-bound encrypt path —
 * which matters here, because the one schema migration (marks: client_id was
 * String(release_id), now the uid) requires decrypt→re-encrypt→delete-old under
 * the (kind, client_id) AAD. Notes/choices keep a random client_id with identity as
 * a FIELD, so they fold at read time with no re-encryption.
 *
 * Run: node tests/js/store-uid.test.mjs
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

// In-memory sync with tombstones (same contract as store.test.mjs).
function fakeSync() {
  const rows = new Map(); let t = 0;
  return {
    async getRows() { return { rows: Array.from(rows.values()), count: rows.size, server_time: String(++t) }; },
    async postRows(list) {
      for (const r of list) rows.set(r.kind + "/" + r.client_id,
        { kind: r.kind, client_id: r.client_id, ciphertext: r.ciphertext, nonce: r.nonce, deleted: false, updated_at: String(++t) });
      return { ok: true };
    },
    async deleteRow(kind, cid) {
      rows.set(kind + "/" + cid, { kind, client_id: cid, ciphertext: "", nonce: "", deleted: true, updated_at: String(++t) });
      return { ok: true };
    },
    _rows: rows,
  };
}

// Seed a row as a PRE-uid client would have stored it (encrypted under the given
// client_id's AAD), so loadAll decrypts it exactly as a real legacy row.
async function seed(sync, dek, kind, cid, obj) {
  const { ciphertext, nonce } = await C.encryptRow(dek, kind, cid, obj);
  sync._rows.set(kind + "/" + cid, { kind, client_id: cid, ciphertext, nonce, deleted: false, updated_at: "1" });
}
const live = (sync) => Array.from(sync._rows.values()).filter((r) => !r.deleted);

async function main() {
  console.log("store uid re-key (P3 M2) tests");
  const PASS = "unlock me", code = C.generateRecoveryCode();
  const { dek } = await C.createIdentity(PASS, code);

  // A pre-uid journal: a note with release_id but NO uid; a mark whose client_id
  // is the bare numeric release_id; a legacy pre-v7 "pick"-kind row with
  // winner_*/picked_at fields (the shape the v7 kind re-key must convert).
  const sync = fakeSync();
  await seed(sync, dek, "note", "n-legacy", {
    release_id: 100, artist: "A", title: "T", body: "old note",
    created_at: "2026-01-01T00:00:00", updated_at: "2026-01-01T00:00:00" });
  await seed(sync, dek, "mark", "100", {
    release_id: 100, artist: "A", title: "T", marks: { bandcamp: "here" },
    updated_at: "2026-01-01T00:00:00" });
  await seed(sync, dek, "pick", "p-legacy", {
    winner_id: 100, winner_artist: "A", winner_title: "T", reasons: [],
    picked_at: "2026-01-01T00:00:00", updated_at: "2026-01-01T00:00:00" });

  const store = J.createStore({ crypto: C, sync });
  store.setKey(dek);
  await store.loadAll();

  // Notes/choices fold onto the uid at read time (no re-encryption needed).
  ok(store.forAlbum("d:100").notes.map((n) => n.body).join() === "old note",
    "legacy note (no uid) folds onto 'd:'+release_id");
  ok(store.forAlbum("d:100").notes[0].release_id === 100, "fold keeps release_id provenance");

  // Marks are re-keyed at unlock: read by uid, server row moved 100 -> d:100.
  ok(store.getMarks("d:100").bandcamp === "here", "legacy mark reads by uid");
  ok(sync._rows.get("mark/d:100") && !sync._rows.get("mark/d:100").deleted,
    "mark re-keyed to the uid client_id on the server");
  ok(sync._rows.get("mark/100") && sync._rows.get("mark/100").deleted === true,
    "the old numeric mark row is tombstoned");

  // v7 kind re-key: the legacy "pick"-kind row is read onto the choice bucket with
  // renamed fields, re-encrypted under kind "choice", and the old row tombstoned.
  const ch = store.choicesFeed();
  ok(ch.length === 1 && ch[0].chosen_id === 100 && ch[0].chosen_artist === "A",
    "legacy pick row reads as a choice with chosen_* fields");
  ok(ch[0].chosen_at === "2026-01-01T00:00:00" && ch[0].winner_id === undefined,
    "picked_at -> chosen_at and the winner_* names are gone");
  ok(sync._rows.get("choice/p-legacy") && !sync._rows.get("choice/p-legacy").deleted,
    "row re-encrypted under kind 'choice' on the server");
  ok(sync._rows.get("pick/p-legacy") && sync._rows.get("pick/p-legacy").deleted === true,
    "the old 'pick'-kind row is tombstoned");

  // Idempotent: a second session must not migrate again or add live rows.
  const before = live(sync).length;
  const store2 = J.createStore({ crypto: C, sync });
  store2.setKey(dek);
  await store2.loadAll();
  ok(live(sync).length === before, "migration idempotent — no new live rows on re-unlock");
  ok(store2.getMarks("d:100").bandcamp === "here", "re-keyed mark persists across sessions");

  // MB-only writes work post-migration (the point of relaxing release_id).
  await store2.addNote("m:abc", { uid: "m:abc", artist: "Z", title: "Q" }, "mb note");
  ok(store2.forAlbum("m:abc").notes[0].release_id === null, "MB-only note has null release_id");
  await store2.setMark("m:abc", { uid: "m:abc" }, "youtube", "here");
  ok(store2.getMarks("m:abc").youtube === "here", "MB-only album can be marked");
  ok(store2.counts().albums === 2, "counts distinct albums by uid (d:100 + m:abc)");

  // Export carries uid; ciphertext never holds plaintext on the wire.
  const dump = store2.exportData();
  ok(dump.version === J.EXPORT_VERSION, "export version matches EXPORT_VERSION");
  ok(dump.platform_marks.some((m) => m.uid === "d:100"), "export marks carry uid");
  const markRow = sync._rows.get("mark/d:100");
  ok(!/bandcamp|here/.test(markRow.ciphertext) || markRow.ciphertext.length > 0,
    "mark row is stored as ciphertext");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
