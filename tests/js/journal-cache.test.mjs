/*
 * Headless tests for FB#107 — the encrypted-row cache that makes the signed-in
 * Notebook open instantly and read offline (static/journal-cache.js is the
 * IndexedDB adapter; this exercises how static/journal-store.js USES a cache).
 *
 * IndexedDB doesn't exist in node, so we inject an in-memory fake with the exact
 * AOTDJournalCache contract (getAll/putRows/removeRow/getCursor/setCursor/clearUser).
 * Real crypto.js (scrypt substitute KDF, like store.test) + a fake sync = the real
 * encrypt -> cache -> reload -> decrypt path, no network, no IndexedDB, no WASM.
 *
 * Run: node tests/js/journal-cache.test.mjs
 */
import { createRequire } from "module";
import { scryptSync } from "crypto";
const require = createRequire(import.meta.url);
const C = require("../../static/crypto.js");
const J = require("../../static/journal-store.js");

let passed = 0, failed = 0;
function ok(c, m) { if (c) passed++; else { failed++; console.error("  ✗ FAIL:", m); } }
const tick = () => new Promise((r) => setTimeout(r, 15));  // let a background reconcile settle

C.configure({
  pwhash: async (pw, salt) => new Uint8Array(scryptSync(Buffer.from(pw), Buffer.from(salt), 32, { N: 16384, r: 8, p: 1 })),
});

// In-memory fake of the sync transport. `offline` makes every call throw, like a
// dropped connection. Rows are the ciphertext rows the server would hold.
function fakeSync() {
  const rows = new Map();  // "kind/cid" -> row
  let t = 0;
  const api = {
    offline: false,
    async getRows() {
      if (api.offline) throw new Error("offline");
      return { rows: Array.from(rows.values()), count: rows.size, server_time: String(++t) };
    },
    async postRows(list) {
      if (api.offline) throw new Error("offline");
      for (const r of list) rows.set(r.kind + "/" + r.client_id,
        { kind: r.kind, client_id: r.client_id, ciphertext: r.ciphertext, nonce: r.nonce, deleted: false, updated_at: String(++t) });
      return { ok: true, written: list.length, server_time: String(t) };
    },
    async deleteRow(kind, cid) {
      if (api.offline) throw new Error("offline");
      rows.set(kind + "/" + cid, { kind, client_id: cid, ciphertext: "", nonce: "", deleted: true, updated_at: String(++t) });
      return { ok: true, deleted: true };
    },
    _rows: rows,
  };
  return api;
}

// In-memory fake of AOTDJournalCache (journal-cache.js), per-user keyed.
function fakeCache() {
  const rows = new Map();     // "uid/kind/cid" -> row
  const cursors = new Map();
  const k = (uid, kind, cid) => String(uid) + "/" + kind + "/" + cid;
  return {
    async getAll(uid) {
      const out = [];
      for (const v of rows.values()) if (v.userId === String(uid)) out.push({ ...v });
      return out;
    },
    async putRows(uid, list) {
      for (const r of list) rows.set(k(uid, r.kind, r.client_id), {
        userId: String(uid), kind: r.kind, client_id: r.client_id,
        ciphertext: r.ciphertext, nonce: r.nonce,
        updated_at: r.updated_at != null ? r.updated_at : null,
        deleted: !!r.deleted, pending: !!r.pending,
      });
    },
    async removeRow(uid, kind, cid) { rows.delete(k(uid, kind, cid)); },
    async getCursor(uid) { return cursors.get(String(uid)) || null; },
    async setCursor(uid, c) { cursors.set(String(uid), c || null); },
    async clearUser(uid) {
      for (const key of [...rows.keys()]) if (rows.get(key).userId === String(uid)) rows.delete(key);
      cursors.delete(String(uid));
    },
    async requestPersistence() { return true; },
    async available() { return true; },
    _rows: rows,
  };
}

const ALBUM = { uid: "d:100", release_id: 100, artist: "Alpha", title: "First", released: "1990", discogs_url: "u", genres: "Jazz", year: 1990 };

async function main() {
  console.log("FB#107 journal-cache tests");
  const PASS = "unlock me", code = C.generateRecoveryCode();
  const { dek } = await C.createIdentity(PASS, code);

  // --- A. cold first open populates the cache via write-through -----------------
  const sync = fakeSync();
  const cache = fakeCache();
  const userId = "user-1";
  let changes = 0;
  const store1 = J.createStore({ crypto: C, sync, cache, userId, onChange: () => changes++ });
  store1.setKey(dek);
  await store1.loadAll();                       // cold: no cache -> full pull (empty)
  ok(store1.summary().notes === 0, "A: starts empty");

  await store1.addNote("d:100", ALBUM, "a quiet storm");
  await store1.addNote("d:100", ALBUM, "grief and rain");
  await store1.addChoice(ALBUM, { uid: "d:101", release_id: 101, artist: "Beta", title: "Other" }, "06-20", ["voice"], "loved");

  const cachedNotes = [...cache._rows.values()].filter((r) => r.userId === userId && r.kind === "note");
  ok(cachedNotes.length === 2, "A: both notes written through to the cache");
  ok(cachedNotes.every((r) => r.pending === false), "A: write-through rows are not pending");
  ok(cachedNotes.every((r) => !/storm|grief/.test(r.ciphertext)), "A: cache holds ciphertext, not plaintext");
  ok((await cache.getCursor(userId)) != null, "A: cursor written to cache");

  // --- B. a fresh session reads from the cache while OFFLINE --------------------
  const off = fakeSync(); off.offline = true;   // server unreachable
  const store2 = J.createStore({ crypto: C, sync: off, cache, userId, onChange: () => {} });
  store2.setKey(dek);
  await store2.loadAll();                        // cache-first render; reconcile fails silently
  await tick();
  ok(store2.summary().notes === 2, "B: notebook readable OFFLINE from the cache");
  ok(store2.summary().choices === 1, "B: choices readable offline too");
  ok(store2.ready() === true, "B: store is ready despite the offline reconcile");
  await store2.whenReady();                      // must not hang / reject
  ok(true, "B: whenReady resolves (no false-empty gate)");

  // --- C. background reconcile pulls a change from 'another device' -------------
  //   Another store (no cache) sharing the same server writes a 3rd note; store3
  //   opens cache-first (sees 2) then reconciles in the background (sees 3, onChange).
  const other = J.createStore({ crypto: C, sync });   // no cache: writes only to the shared server
  other.setKey(dek);
  await other.loadAll();
  await other.addNote("d:100", ALBUM, "a third, from elsewhere");

  changes = 0;
  const store3 = J.createStore({ crypto: C, sync, cache, userId, onChange: () => changes++ });
  store3.setKey(dek);
  await store3.loadAll();                         // cache-first: renders the cached 2
  ok(store3.summary().notes === 2, "C: cache-first shows the cached count immediately");
  await tick();                                   // let the background reconcile land
  ok(store3.summary().notes === 3, "C: reconcile brought in the 3rd note");
  ok(changes === 1, "C: onChange fired exactly once (state changed)");

  // A reconcile that changes nothing must NOT fire onChange.
  changes = 0;
  const store4 = J.createStore({ crypto: C, sync, cache, userId, onChange: () => changes++ });
  store4.setKey(dek);
  await store4.loadAll();
  await tick();
  ok(changes === 0, "C: onChange does NOT fire when the reconcile matched the cache");

  // --- D. delete-through removes the cache row ---------------------------------
  const aNote = store4.notes()[0];
  await store4.deleteNote(aNote.id);
  const stillCached = [...cache._rows.values()].some((r) => r.userId === userId && r.kind === "note" && r.client_id === aNote.id);
  ok(!stillCached, "D: deleting a note removes it from the cache");

  // --- E. wipeCache clears everything for the user -----------------------------
  await store4.wipeCache();
  const leftover = [...cache._rows.values()].filter((r) => r.userId === userId);
  ok(leftover.length === 0, "E: wipeCache leaves nothing for the user");
  ok((await cache.getCursor(userId)) == null, "E: wipeCache clears the cursor too");

  // --- G. offline WRITE queues locally and replays on reconnect ----------------
  const gSync = fakeSync(), gCache = fakeCache(), gUser = "user-g";
  const gStore = J.createStore({ crypto: C, sync: gSync, cache: gCache, userId: gUser, onChange: () => {} });
  gStore.setKey(dek);
  await gStore.loadAll();
  gSync.offline = true;                          // the connection drops
  await gStore.addNote("d:100", ALBUM, "written on a train");
  ok(gStore.summary().notes === 1, "G: offline note appears immediately in memory (write didn't throw)");
  const gPending = [...gCache._rows.values()].filter((r) => r.userId === gUser && r.pending && !r.deleted);
  ok(gPending.length === 1, "G: offline note queued as pending in the cache");
  ok([...gSync._rows.values()].length === 0, "G: nothing reached the server while offline");
  gSync.offline = false;                          // reconnect
  await gStore.flush();
  await tick();
  ok([...gSync._rows.values()].filter((r) => r.kind === "note" && !r.deleted).length === 1, "G: reconnect replays the note to the server");
  ok([...gCache._rows.values()].filter((r) => r.userId === gUser && r.pending).length === 0, "G: the replayed note is no longer pending");

  // --- H. an offline write survives a reload (still readable, still pending) ----
  const hSync = fakeSync(), hCache = fakeCache(), hUser = "user-h";
  const h1 = J.createStore({ crypto: C, sync: hSync, cache: hCache, userId: hUser, onChange: () => {} });
  h1.setKey(dek); await h1.loadAll();
  hSync.offline = true;
  await h1.addNote("d:100", ALBUM, "offline then reload");
  const h2 = J.createStore({ crypto: C, sync: hSync, cache: hCache, userId: hUser, onChange: () => {} });  // "reload"
  h2.setKey(dek); await h2.loadAll(); await tick();
  ok(h2.summary().notes === 1, "H: the offline note is still there after a reload");
  hSync.offline = false;
  await h2.flush(); await tick();
  ok([...hSync._rows.values()].filter((r) => r.kind === "note" && !r.deleted).length === 1, "H: it syncs to the server after reconnect");

  // --- I. offline DELETE queues a tombstone and replays ------------------------
  const iSync = fakeSync(), iCache = fakeCache(), iUser = "user-i";
  const iStore = J.createStore({ crypto: C, sync: iSync, cache: iCache, userId: iUser, onChange: () => {} });
  iStore.setKey(dek); await iStore.loadAll();
  const iNote = await iStore.addNote("d:100", ALBUM, "to be deleted offline");   // synced online
  iSync.offline = true;
  await iStore.deleteNote(iNote.id);
  ok(iStore.summary().notes === 0, "I: offline delete removes it from view immediately");
  ok([...iCache._rows.values()].filter((r) => r.userId === iUser && r.pending && r.deleted).length === 1, "I: offline delete queued as a pending tombstone");
  iSync.offline = false;
  await iStore.flush(); await tick();
  ok([...iCache._rows.values()].filter((r) => r.userId === iUser && r.client_id === iNote.id).length === 0, "I: replayed delete clears the cache row");
  ok([...iSync._rows.values()].find((r) => r.client_id === iNote.id).deleted === true, "I: the server row is tombstoned after replay");

  // --- F. no-cache store is unchanged (regression) -----------------------------
  const plainSync = fakeSync();
  const plain = J.createStore({ crypto: C, sync: plainSync });  // no cache/userId
  plain.setKey(dek);
  await plain.loadAll();
  await plain.addNote("d:100", ALBUM, "cacheless note");
  ok(plain.summary().notes === 1, "F: a store with no cache still works as before");

  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
