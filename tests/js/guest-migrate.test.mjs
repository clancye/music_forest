/*
 * Headless tests for the Phase D guest → encrypted-journal pick migration.
 *
 * The migration replays a logged-out guest's buffered choices into the real
 * AOTDStore on the first unlock. We exercise the actual path the browser runs:
 * the REAL guest buffer (guest-buffer.js, in-memory storage), the REAL store
 * engine (journal-store.js encrypt-on-write, with the scrypt substitute KDF and
 * an in-memory fake sync — exactly like store.test.mjs), and an injected
 * albumsFor that stands in for the public /api/albums catalog lookup.
 *
 * Two properties the plan calls out, plus the supporting shape checks:
 *   - idempotency:    running the migration twice with the same choices adds no
 *                     duplicates (importExport dedups by chosen_id|chosen_at).
 *   - no data loss:   if the store write throws, the buffer is left fully intact
 *                     so the choices can be retried (partial writes don't drop).
 *   - fidelity:       original chosen_at preserved; album snapshots hydrated;
 *                     day -> day_context; buffer cleared only on success.
 *
 * Run: node tests/js/guest-migrate.test.mjs
 */
import { createRequire } from "module";
import { scryptSync } from "crypto";
const require = createRequire(import.meta.url);
const C = require("../../static/crypto.js");
const J = require("../../static/journal-store.js");
const B = require("../../static/guest-buffer.js");

let passed = 0, failed = 0;
function ok(c, m) { if (c) passed++; else { failed++; console.error("  ✗ FAIL:", m); } }

C.configure({
  pwhash: async (pw, salt) =>
    new Uint8Array(scryptSync(Buffer.from(pw), Buffer.from(salt), 32, { N: 16384, r: 8, p: 1 })),
});

// In-memory fake of the sync layer (same contract as sync.js helpers). `failPost`
// lets a test make the Nth postRows throw, to model a mid-migration write failure.
function fakeSync() {
  const rows = new Map();
  let t = 0;
  const self = {
    failPost: 0,          // when > 0, the next `failPost` postRows calls throw
    async getRows() { return { rows: Array.from(rows.values()), count: rows.size, server_time: String(++t) }; },
    async postRows(list) {
      if (self.failPost > 0) { self.failPost--; throw new Error("sync down"); }
      for (const r of list) rows.set(r.kind + "/" + r.client_id,
        { kind: r.kind, client_id: r.client_id, ciphertext: r.ciphertext, nonce: r.nonce, deleted: false, updated_at: String(++t) });
      return { ok: true, written: list.length, server_time: String(t) };
    },
    async deleteRow(kind, cid) {
      rows.set(kind + "/" + cid, { kind, client_id: cid, ciphertext: "", nonce: "", deleted: true, updated_at: String(++t) });
      return { ok: true, deleted: true };
    },
    _rows: rows,
  };
  return self;
}

// A Storage-shaped fake (like guest-buffer.test) so a real buffer persists.
function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}
function seqId() { let n = 0; return () => "cid-" + (++n); }
function fixedNow() { let n = 0; return () => "2026-06-25T00:00:" + String(++n).padStart(2, "0") + "Z"; }

// The catalog the migration hydrates against — stands in for /api/albums.
const CATALOG = {
  100: { release_id: 100, artist: "Alpha", title: "First", released: "1990", discogs_url: "u100", genres: "Jazz", year: 1990 },
  101: { release_id: 101, artist: "Beta", title: "Second", released: "1991", discogs_url: "u101", genres: "Rock", year: 1991 },
  200: { release_id: 200, artist: "Gamma", title: "Third", released: "2000", discogs_url: "u200", genres: "Folk", year: 2000 },
  201: { release_id: 201, artist: "Delta", title: "Fourth", released: "2001", discogs_url: "u201", genres: "Pop", year: 2001 },
};
function makeAlbumsFor() {
  const calls = { n: 0, lastIds: null };
  const fn = async (ids) => {
    calls.n++; calls.lastIds = ids.slice();
    const out = {};
    for (const id of ids) if (CATALOG[id]) out[String(id)] = CATALOG[id];
    return out;
  };
  return { fn, calls };
}

// Seed a fresh buffer (over the given storage) with two choices; deterministic
// ids/timestamps so assertions are exact. Returns the buffer + the entries.
function seedBuffer(storage) {
  const buf = B.create({ storage, newId: seqId(), now: fixedNow() });
  const e1 = buf.record({ chosen_id: 100, not_chosen_id: 101, day: "06-25", reasons: ["the voice"], note: "loved it" });
  const e2 = buf.record({ chosen_id: 200, not_chosen_id: 201, day: "06-25" });
  return { buf, e1, e2 };
}

async function freshStore(sync) {
  const PASS = "unlock me", code = C.generateRecoveryCode();
  const { dek } = await C.createIdentity(PASS, code);
  const store = J.createStore({ crypto: C, sync });
  store.setKey(dek);
  await store.loadAll();
  return store;
}

async function main() {
  console.log("guest-migrate tests");

  // --- buildChoicesExport (pure shaping) --------------------------------------
  {
    const entries = [
      { client_id: "a", chosen_id: 100, not_chosen_id: 101, day: "06-25", reasons: ["x"], note: "n", chosen_at: "2026-06-25T00:00:01Z", updated_at: "2026-06-25T00:00:02Z" },
      { client_id: "b", chosen_id: 999, not_chosen_id: null, day: null, reasons: [], note: null, chosen_at: "2026-06-25T00:00:03Z" },
      { client_id: "c", chosen_id: null, chosen_at: "x" },        // dropped (no chosen)
      { client_id: "d", chosen_id: 200, chosen_at: "" },          // dropped (no chosen_at)
    ];
    const payload = B.buildChoicesExport(entries, CATALOG);
    ok(payload.kind === "journal-export", "payload is a journal-export");
    ok(payload.choices.length === 2, "invalid entries (no chosen / no chosen_at) are dropped");
    const p0 = payload.choices[0];
    ok(p0.chosen_id === 100 && p0.chosen_artist === "Alpha" && p0.chosen_year === 1990, "chosen snapshot hydrated from catalog");
    ok(p0.not_chosen_id === 101 && p0.not_chosen_artist === "Beta", "not_chosen snapshot hydrated from catalog");
    ok(p0.day_context === "06-25", "buffer.day mapped to day_context");
    ok(p0.chosen_at === "2026-06-25T00:00:01Z" && p0.updated_at === "2026-06-25T00:00:02Z", "original timestamps carried through");
    const p1 = payload.choices[1];
    ok(p1.chosen_id === 999 && p1.chosen_artist === undefined, "unknown album degrades snapshot but keeps the pick");
    ok(Array.isArray(payload.notes) && payload.notes.length === 0, "choices-only: no notes/trails/marks");
  }

  // --- happy path: replay, hydrate, preserve, clear -------------------------
  {
    const sync = fakeSync();
    const store = await freshStore(sync);
    const { buf, e1 } = seedBuffer(fakeStorage());
    ok(buf.count() === 2, "buffer seeded with two choices");
    const albums = makeAlbumsFor();

    const res = await B.migrateChoices({ buf, store, albumsFor: albums.fn });
    ok(res.entries === 2 && res.migrated === 2 && res.skipped === 0, "migrate reports 2 choices replayed");
    ok(store.choices().length === 2, "both choices land in the store");
    ok(buf.count() === 0, "buffer cleared after a confirmed migration");
    ok(albums.calls.n === 1, "albums hydrated in a single batch lookup");

    const got = store.choices().find((p) => p.chosen_id === 100);
    ok(got && got.chosen_at === e1.chosen_at, "original chosen_at preserved (not re-stamped)");
    ok(got && got.chosen_artist === "Alpha" && got.chosen_genres === "Jazz", "store pick carries the hydrated snapshot");
    ok(got && got.day_context === "06-25" && got.note === "loved it", "day_context + note preserved");
    ok(store.choicesStats().total === 2, "analytics see the migrated choices");
  }

  // --- idempotency: re-running with the same choices adds no duplicates --------
  {
    const sync = fakeSync();
    const store = await freshStore(sync);
    const storage = fakeStorage();
    const { buf } = seedBuffer(storage);
    const albums = makeAlbumsFor();

    const r1 = await B.migrateChoices({ buf, store, albumsFor: albums.fn });
    ok(r1.migrated === 2 && store.choices().length === 2, "first migration writes both choices");
    ok(buf.count() === 0, "buffer cleared after first migration");

    // Re-seed the SAME choices (same chosen_id + chosen_at) — models a crash after
    // importExport but before clear(), or a stray second run — then migrate again.
    seedBuffer(storage);
    ok(buf.count() === 2, "buffer re-seeded with the same two choices");
    const r2 = await B.migrateChoices({ buf, store, albumsFor: albums.fn });
    ok(r2.migrated === 0 && r2.skipped === 2, "second run: every pick deduped (chosen_id|chosen_at)");
    ok(store.choices().length === 2, "no duplicate choices after re-running migration");
    ok(buf.count() === 0, "buffer cleared again on the (no-op) confirmed run");
  }

  // --- no data loss: a failed write leaves the buffer fully intact ----------
  {
    const sync = fakeSync();
    const store = await freshStore(sync);
    const storage = fakeStorage();
    const { buf } = seedBuffer(storage);
    const albums = makeAlbumsFor();

    sync.failPost = 1;   // the FIRST pick write throws -> importExport rejects
    let threw = false;
    try { await B.migrateChoices({ buf, store, albumsFor: albums.fn }); }
    catch (e) { threw = true; }
    ok(threw, "migrate propagates the store write failure");
    ok(buf.count() === 2, "buffer untouched when the write throws (no data loss)");
    ok(store.choices().length === 0, "nothing committed when the first write fails");

    // Retry once the store is healthy: the buffer still has everything, the
    // replay is idempotent, and the choices land — proving the failure was
    // recoverable, not lossy.
    const r = await B.migrateChoices({ buf, store, albumsFor: albums.fn });
    ok(r.migrated === 2 && store.choices().length === 2, "retry after recovery replays all choices");
    ok(buf.count() === 0, "buffer cleared after the successful retry");
  }

  // --- partial write: buffer survives a mid-batch failure -------------------
  {
    const sync = fakeSync();
    const store = await freshStore(sync);
    const storage = fakeStorage();
    const { buf } = seedBuffer(storage);
    const albums = makeAlbumsFor();

    sync.failPost = 1;            // let pick #1 commit, fail on pick #2's write...
    // ...but the first postRows is consumed by pick #1, so arrange the fail on #2:
    // re-arm so the SECOND post throws (first succeeds).
    sync.failPost = 0;
    let n = 0;
    const realPost = sync.postRows.bind(sync);
    sync.postRows = async (list) => { n++; if (n === 2) throw new Error("sync down mid-batch"); return realPost(list); };

    let threw = false;
    try { await B.migrateChoices({ buf, store, albumsFor: albums.fn }); }
    catch (e) { threw = true; }
    ok(threw, "mid-batch failure propagates");
    ok(buf.count() === 2, "buffer intact after a partial write (both choices still buffered)");
    ok(store.choices().length === 1, "one pick committed before the failure");

    // Recover: retry dedups the already-written pick and adds the rest.
    sync.postRows = realPost;
    const r = await B.migrateChoices({ buf, store, albumsFor: albums.fn });
    ok(store.choices().length === 2, "retry completes without duplicating the committed pick");
    ok(r.skipped === 1 && r.migrated === 1, "retry skips the committed pick, writes the remaining one");
    ok(buf.count() === 0, "buffer cleared after recovery");
  }

  // --- no-op guards ----------------------------------------------------------
  {
    const sync = fakeSync();
    const store = await freshStore(sync);
    const empty = B.create({ storage: fakeStorage() });
    const res = await B.migrateChoices({ buf: empty, store, albumsFor: async () => ({}) });
    ok(res.entries === 0 && res.result === null, "empty buffer is a clean no-op");

    const { buf } = seedBuffer(fakeStorage());
    const res2 = await B.migrateChoices({ buf, store: null, albumsFor: async () => ({}) });
    ok(res2.entries === 0, "no store -> no-op, buffer untouched");
    ok(buf.count() === 2, "buffer preserved when there's no store to migrate into");
  }

  // === migrateGuest (F26: choices + remember-door reflections, one payload) ====
  // --- buildGuestExport (pure shaping) ---------------------------------------
  {
    const choices = [
      { client_id: "a", chosen_id: 100, not_chosen_id: 101, day: "06-25", reasons: [], note: null, chosen_at: "2026-06-25T00:00:01Z" },
    ];
    const notes = [
      { client_id: "n1", uid: "d:200", release_id: 200, track: "3", timestamp: "1:45", body: "that summer", created_at: "2026-06-25T00:00:02Z", updated_at: "2026-06-25T00:00:03Z" },
      { client_id: "n2", uid: "m:abc", release_id: null, body: "mb-only words", created_at: "2026-06-25T00:00:04Z" },
      { client_id: "n3", uid: "d:1", body: "", created_at: "x" },      // dropped (no body)
      { client_id: "n4", body: "a free noticing", created_at: "2026-06-25T00:00:05Z" }, // #58: KEPT — free note (body + created_at, null uid)
    ];
    const payload = B.buildGuestExport(choices, notes, CATALOG);
    ok(payload.kind === "journal-export", "guest payload is a journal-export");
    ok(payload.choices.length === 1 && payload.notes.length === 3, "empty-body note dropped, free noticing kept, choices intact");
    const n0 = payload.notes[0];
    ok(n0.uid === "d:200" && n0.artist === "Gamma" && n0.title === "Third", "note snapshot hydrated from catalog");
    ok(n0.track === "3" && n0.timestamp === "1:45" && n0.body === "that summer", "note fields carried through");
    ok(n0.created_at === "2026-06-25T00:00:02Z" && n0.updated_at === "2026-06-25T00:00:03Z", "note timestamps preserved");
    const n1 = payload.notes[1];
    ok(n1.uid === "m:abc" && n1.artist === undefined && n1.updated_at === n1.created_at,
      "MB-only note degrades to identity-only, updated_at falls back to created_at");
    // #58: a free noticing (no uid) migrates as a null-uid note, not dropped.
    const nFree = payload.notes[2];
    ok(nFree.uid === null && nFree.body === "a free noticing",
      "free noticing migrates with a null uid");
  }

  // --- typed note refs (v8): a non-album reflection carries its snapshot -------
  {
    const artistRef = { kind: "artist", name: "Radiohead", mbid: null };
    const notes = [
      { client_id: "t1", uid: "art:Radiohead", release_id: null, body: "their use of silence",
        ref: artistRef, created_at: "2026-07-12T00:00:01Z" },
    ];
    const payload = B.buildGuestExport([], notes, CATALOG);
    ok(payload.notes.length === 1, "typed note isn't dropped (it has a uid)");
    const t = payload.notes[0];
    ok(t.uid === "art:Radiohead" && t.release_id === null && t.artist === undefined,
      "typed note has no album snapshot");
    ok(JSON.stringify(t.ref) === JSON.stringify(artistRef), "typed note carries its ref through shaping");
  }

  // --- #47 parity: an MB-only note keeps its captured name through migration -----
  // An 'm:' album has no catalog row to hydrate from, so the name the guest saw on
  // screen (captured into the buffer) must survive into the migrated snapshot.
  {
    const notes = [
      { client_id: "mb1", uid: "m:xyz", release_id: null, artist: "Captured Artist",
        title: "Captured Title", body: "mb-only words", created_at: "2026-07-14T00:00:01Z" },
    ];
    const payload = B.buildGuestExport([], notes, CATALOG);   // CATALOG has no m: row
    const r = payload.notes[0];
    ok(r.uid === "m:xyz" && r.artist === "Captured Artist" && r.title === "Captured Title",
      "MB-only note keeps its captured name when the catalog can't hydrate it");
  }

  // recordNote keeps a ref (object only); a non-object ref is dropped to null.
  {
    const storage = fakeStorage();
    const b = B.create({ storage, newId: seqId(), now: fixedNow() });
    const e = b.recordNote({ uid: "per:9", body: "his production", ref: { kind: "person", name: "Nigel", person_id: "9" } });
    ok(e && e.ref && e.ref.name === "Nigel", "recordNote persists a typed ref");
    const e2 = b.recordNote({ uid: "d:1", body: "album", ref: "not-an-object" });
    ok(e2 && e2.ref === null, "a non-object ref is stored as null");
  }

  // --- happy path: both kinds land, both buffers clear -----------------------
  {
    const sync = fakeSync();
    const store = await freshStore(sync);
    const storage = fakeStorage();
    const { buf } = seedBuffer(storage);
    const noted = buf.recordNote({ uid: "d:200", release_id: 200, body: "the drum sound" });
    ok(buf.count() === 2 && buf.notesCount() === 1, "buffer seeded with choices + a reflection");
    const albums = makeAlbumsFor();

    const res = await B.migrateGuest({ buf, store, albumsFor: albums.fn });
    ok(res.entries === 3, "migrate counts choices + notes");
    ok(res.migrated === 2 && res.migrated_notes === 1, "both choices and the reflection replayed");
    ok(store.choices().length === 2 && store.notes().length === 1, "everything lands in the store");
    ok(buf.count() === 0 && buf.notesCount() === 0, "both buffers cleared after the confirmed write");
    ok(albums.calls.n === 1, "one batch hydration covers choices and notes");
    ok(albums.calls.lastIds.includes(200), "note album id included in the hydration batch");

    const got = store.notes()[0];
    ok(got.uid === "d:200" && got.body === "the drum sound", "reflection carries identity + words");
    ok(got.created_at === noted.created_at, "original created_at preserved (not re-stamped)");
    ok(got.artist === "Gamma" && got.title === "Third", "reflection carries the hydrated snapshot");
  }

  // --- idempotency across both kinds -----------------------------------------
  {
    const sync = fakeSync();
    const store = await freshStore(sync);
    const storage = fakeStorage();
    const seedAll = () => {
      const b = B.create({ storage, newId: seqId(), now: fixedNow() });
      b.record({ chosen_id: 100, not_chosen_id: 101, day: "06-25" });
      b.recordNote({ uid: "d:200", release_id: 200, body: "same words" });
      return b;
    };
    const buf1 = seedAll();
    const albums = makeAlbumsFor();
    const r1 = await B.migrateGuest({ buf: buf1, store, albumsFor: albums.fn });
    ok(r1.migrated === 1 && r1.migrated_notes === 1, "first run writes the pick and the note");

    const buf2 = seedAll();   // same deterministic ids/timestamps = same rows
    const r2 = await B.migrateGuest({ buf: buf2, store, albumsFor: albums.fn });
    ok(r2.migrated === 0 && r2.migrated_notes === 0, "second run: everything deduped");
    ok(r2.skipped === 1 && r2.skipped_notes === 1, "second run reports the dedup");
    ok(store.choices().length === 1 && store.notes().length === 1, "no duplicates after re-running");
  }

  // --- no data loss: a failed write leaves BOTH buffers intact ---------------
  {
    const sync = fakeSync();
    const store = await freshStore(sync);
    const storage = fakeStorage();
    const { buf } = seedBuffer(storage);
    buf.recordNote({ uid: "d:200", release_id: 200, body: "words to keep" });
    const albums = makeAlbumsFor();

    sync.failPost = 1;
    let threw = false;
    try { await B.migrateGuest({ buf, store, albumsFor: albums.fn }); }
    catch (e) { threw = true; }
    ok(threw, "migrateGuest propagates the store write failure");
    ok(buf.count() === 2 && buf.notesCount() === 1, "choices AND reflection intact after the failure");

    const r = await B.migrateGuest({ buf, store, albumsFor: albums.fn });
    ok(r.migrated === 2 && r.migrated_notes === 1, "retry replays everything");
    ok(buf.count() === 0 && buf.notesCount() === 0, "buffers cleared after the successful retry");
  }

  // --- notes-only session (a guest who only used the remember door) ----------
  {
    const sync = fakeSync();
    const store = await freshStore(sync);
    const buf = B.create({ storage: fakeStorage(), newId: seqId(), now: fixedNow() });
    buf.recordNote({ uid: "d:100", release_id: 100, body: "only a reflection" });
    const res = await B.migrateGuest({ buf, store, albumsFor: makeAlbumsFor().fn });
    ok(res.entries === 1 && res.migrated_notes === 1 && res.migrated === 0,
      "a notes-only guest session migrates cleanly");
    ok(store.notes().length === 1 && store.choices().length === 0, "just the reflection lands");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
