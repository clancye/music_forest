/*
 * End-to-end test for the store engine in journal-store.js (encrypt-on-write /
 * decrypt-on-read) plus the journalFeed read shape.
 *
 * Uses the REAL crypto.js (with the scrypt substitute KDF, like crypto.test) and
 * an in-memory fake of the sync layer, so it exercises the actual encrypt ->
 * store -> reload -> decrypt path that the browser runs, without a network or
 * the Argon2id WASM.
 *
 * Run: node tests/js/store.test.mjs
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

// In-memory fake of the sync layer (same contract as sync.js helpers).
function fakeSync() {
  const rows = new Map();   // "kind/cid" -> stored row
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
      return { ok: true, deleted: true };
    },
    _rows: rows,
  };
}

async function main() {
  console.log("journal-store engine tests");
  const sync = fakeSync();
  const PASS = "unlock me", code = C.generateRecoveryCode();
  const { dek } = await C.createIdentity(PASS, code);

  const store = J.createStore({ crypto: C, sync });
  store.setKey(dek);
  await store.loadAll();
  ok(store.summary().notes === 0, "starts empty");

  // Writes (encrypted to the fake sync).
  const album = { uid: "d:100", release_id: 100, artist: "Alpha", title: "First", released: "1990", discogs_url: "u", genres: "Jazz", year: 1990 };
  const n1 = await store.addNote("d:100", album, "a quiet **storm**, grief and rain", "Track 1", "1:23");
  await store.addNote("d:100", album, "more grief, the storm again");
  await store.addChoice(album, { uid: "d:101", release_id: 101, artist: "Beta", title: "Other" }, "06-20", ["the voice"], "loved it");
  await store.addTrail("my walk", [{ parent: -1, label: "start", nav: null }]);
  await store.setMark("d:100", album, "spotify", "here");

  ok(store.summary().notes === 2, "two notes written");
  ok(store.getMarks("d:100").spotify === "here", "mark stored + readable");

  // Ciphertext only on the wire — the fake sync never holds plaintext.
  const anyRow = Array.from(sync._rows.values()).find((r) => r.kind === "note");
  ok(!/grief|storm/.test(anyRow.ciphertext), "row body is ciphertext, not plaintext");

  // Reload in a fresh store + freshly unlocked DEK == a new session.
  const dek2 = await C.unlockWithPassphrase((await C.createIdentity(PASS, code)).keyMaterial, PASS); // unrelated key
  // ^ a DIFFERENT identity's key must NOT decrypt our rows:
  const store2 = J.createStore({ crypto: C, sync });
  store2.setKey(dek2);
  await store2.loadAll();
  ok(store2.summary().notes === 0, "rows from another key don't decrypt (skipped, not crashing)");

  // Correct key reloads everything.
  const store3 = J.createStore({ crypto: C, sync });
  store3.setKey(dek);
  await store3.loadAll();
  ok(store3.summary().notes === 2 && store3.summary().choices === 1 && store3.summary().trails === 1, "reload decrypts all rows with the right key");
  ok(store3.getMarks("d:100").spotify === "here", "marks survive reload");

  // Analytics over the reloaded journal.
  const subs = store3.subjects(2);
  ok(subs.some((x) => x.term.toLowerCase() === "grief"), "subjects finds the recurring term 'grief'");
  ok(store3.choicesStats().total === 1, "choicesStats counts the choice");
  // N1 §4.1 (hosted parity): forAlbum folds the choice-reason in beside the notes.
  const fa = store3.forAlbum("d:100");
  ok(fa.notes.length === 2 && fa.choices.length === 1
    && fa.choices[0].note === "loved it" && fa.choices[0].reasons[0] === "the voice",
    "forAlbum returns notes + the reasoned choice for the album");

  // journalFeed shelf + summary (catalog injected). The summary is a neutral
  // mirror now — counts + the genres you write about; milestone badges + explorer
  // coverage (G3/G4) were removed as gamification and must not reappear.
  const feed = store3.journalFeed({ "100": album });
  ok(feed.albums.length === 1 && feed.albums[0].note_count === 2, "journalFeed groups notes into one album shelf");
  ok(feed.summary.notes === 2 && Array.isArray(feed.summary.top_genres), "journalFeed summary: counts + genre mirror");
  ok(!("badges" in feed.summary) && !("genres_covered" in feed.summary) && !("decades" in feed.summary), "no gamification fields in summary");
  ok(typeof J.milestones === "undefined", "milestones() removed from the store engine");

  // delete + restore round-trip (undo toast path).
  const beforeId = store3.notes()[0].id;
  await store3.deleteNote(beforeId);
  ok(store3.summary().notes === 1, "note deleted (tombstoned)");
  await store3.restoreNote(beforeId);
  ok(store3.summary().notes === 2, "note restored under same id");

  // edit a note.
  await store3.updateNote(beforeId, { body: "edited body" });
  ok(store3.notes().find((n) => n.id === beforeId).body === "edited body", "note edited in place");

  // a fresh reload still sees the edit + restore (persisted as ciphertext).
  const store4 = J.createStore({ crypto: C, sync });
  store4.setKey(dek);
  await store4.loadAll();
  ok(store4.summary().notes === 2, "edits/restores persist across reload");

  // --- one-time import of a plaintext journal export (BETA_PLAN.md §9) -------
  const sync5 = fakeSync();
  const store5 = J.createStore({ crypto: C, sync: sync5 });
  store5.setKey(dek);
  await store5.loadAll();
  const exportPayload = {
    app: "album-of-the-day", kind: "journal-export", version: 5,
    notes: [
      { release_id: 100, artist: "Alpha", title: "First", body: "old note one",
        created_at: "2025-01-01T10:00:00", updated_at: "2025-01-02T10:00:00", track: "T", timestamp: "1:00" },
      { release_id: 101, artist: "Beta", title: "Second", body: "old note two",
        created_at: "2025-01-03T10:00:00" },
      { release_id: null, body: "broken", created_at: "2025-01-04" },   // skipped (no rid)
    ],
    choices: [
      { chosen_id: 100, chosen_artist: "Alpha", chosen_title: "First", chosen_genres: "Jazz",
        chosen_year: 1990, reasons: ["the voice"], note: "loved", chosen_at: "2025-01-01T09:00:00" },
    ],
    trails: [{ name: "old walk", nodes: [{ parent: -1, label: "start", nav: null }], created_at: "2025-01-01T08:00:00" }],
    platform_marks: [
      { release_id: 100, service: "spotify", state: "here", artist: "Alpha", title: "First", updated_at: "2025-01-01" },
      { release_id: 100, service: "bandcamp", state: "not_here", artist: "Alpha", title: "First", updated_at: "2025-01-01" },
    ],
    listens: [],
  };
  const res = await store5.importExport(exportPayload);
  ok(res.notes === 2 && res.notes_skipped === 1, "import: 2 notes added, 1 skipped (null release_id)");
  ok(res.choices === 1 && res.trails === 1 && res.marks === 1, "import: pick + trail + grouped marks");
  ok(store5.notes().find((n) => n.body === "old note one").created_at === "2025-01-01T10:00:00",
    "import preserves original created_at");
  ok(store5.getMarks("d:100").spotify === "here" && store5.getMarks("d:100").bandcamp === "not_here",
    "import groups multiple marks under one album row");

  // Re-import is idempotent (dedup).
  const res2 = await store5.importExport(exportPayload);
  ok(res2.notes === 0 && res2.notes_skipped === 3 && res2.choices === 0 && res2.trails === 0,
    "re-import dedups (nothing added; 2 existing notes + 1 invalid all skipped)");

  // Imported rows are real ciphertext that reload/decrypt with the key.
  const store6 = J.createStore({ crypto: C, sync: sync5 });
  store6.setKey(dek);
  await store6.loadAll();
  ok(store6.notes().length === 2 && store6.choices().length === 1, "imported rows persist + decrypt on reload");
  ok(store6.choicesStats().total === 1 && store6.subjects(1).length >= 0, "analytics run over imported data");

  // --- export (backup / portability, BETA_PLAN.md §8) -----------------------
  const dump = store6.exportData();
  ok(dump.kind === "journal-export" && dump.version === J.EXPORT_VERSION, "export has the journal-export header + version");
  ok(dump.notes.length === 2 && dump.choices.length === 1 && dump.trails.length === 1, "export carries notes/choices/trails");
  // Marks: stored one-row-per-release {service:state} -> exported one-row-per-service.
  ok(dump.platform_marks.length === 2, "export flattens marks to one row per (release, service)");
  ok(dump.platform_marks.some((m) => m.release_id === 100 && m.service === "spotify" && m.state === "here"),
    "export carries the spotify mark flattened");
  // The engine's internal bookkeeping is stripped from the portable file.
  ok(!("_client_id" in dump.notes[0]) && !("id" in dump.notes[0]) && !("_updated_at" in dump.notes[0]),
    "export strips internal fields (_client_id/id/_updated_at)");

  // Round-trip: the exported file imports back into a fresh store with equal counts.
  const sync7 = fakeSync();
  const store7 = J.createStore({ crypto: C, sync: sync7 });
  store7.setKey(dek);
  await store7.loadAll();
  const back = await store7.importExport(dump);
  ok(back.notes === 2 && back.choices === 1 && back.trails === 1 && back.marks === 1,
    "round-trip: export -> import restores every row");
  ok(store7.getMarks("d:100").spotify === "here" && store7.getMarks("d:100").bandcamp === "not_here",
    "round-trip restores grouped marks");
  ok(store7.notes().find((n) => n.body === "old note one").created_at === "2025-01-01T10:00:00",
    "round-trip preserves original timestamps");

  // locked store refuses to export.
  store7.clear();
  let threw = false;
  try { store7.exportData(); } catch (e) { threw = true; }
  ok(threw, "exportData throws when locked");

  // --- typed note refs (v8, Phase 0) ----------------------------------------
  // A note may tie to a non-album entity (artist/person/track). Those have no
  // catalog row, so the note carries a `ref` snapshot through the encrypted store.
  ok(J.kindFromUid("d:1") === "album" && J.kindFromUid("art:X") === "artist"
    && J.kindFromUid("per:9") === "person" && J.kindFromUid("trk:d:1#2") === "track"
    && J.kindFromUid(null) === "free", "kindFromUid classifies by prefix");

  const syncT = fakeSync();
  const storeT = J.createStore({ crypto: C, sync: syncT });
  storeT.setKey(dek);
  await storeT.loadAll();
  const artistRef = { kind: "artist", name: "Radiohead", mbid: null };
  const trackRef = { kind: "track", title: "Idioteque", pos: "8",
    album_uid: "d:100", album_artist: "Radiohead", album_title: "Kid A" };
  // typed notes pass NO album dict (there's no catalog row) — only uid + ref.
  await storeT.addNote("art:Radiohead", null, "the way they use silence", null, null, artistRef);
  await storeT.addNote("trk:d:100#8", null, "that stutter-cut vocal", null, null, trackRef);
  // an album note still passes ref=undefined and stays ref:null.
  await storeT.addNote("d:100", album, "album note");
  const artNote = storeT.forAlbum("art:Radiohead").notes[0];
  ok(artNote && JSON.stringify(artNote.ref) === JSON.stringify(artistRef)
    && artNote.release_id === null, "typed artist note stores its ref, no release_id");
  ok(storeT.forAlbum("d:100").notes[0].ref == null, "album note carries no ref");
  // the ref survives ciphertext round-trip on reload.
  const storeT2 = J.createStore({ crypto: C, sync: syncT });
  storeT2.setKey(dek);
  await storeT2.loadAll();
  ok(JSON.stringify(storeT2.forAlbum("trk:d:100#8").notes[0].ref) === JSON.stringify(trackRef),
    "typed track ref survives reload/decrypt");
  // export/import carries the ref (v8).
  const dumpT = storeT2.exportData();
  ok(dumpT.version === 8, "export is v8");
  const syncT3 = fakeSync();
  const storeT3 = J.createStore({ crypto: C, sync: syncT3 });
  storeT3.setKey(dek);
  await storeT3.loadAll();
  await storeT3.importExport(dumpT);
  ok(JSON.stringify(storeT3.forAlbum("art:Radiohead").notes[0].ref) === JSON.stringify(artistRef),
    "import round-trips the typed ref");

  // feed() ref-label search (v8): a typed note has null artist/title, so the
  // Notebook search must find it by its ref label — mirrors journal.py _note_matches.
  const typedFeed = [
    { id: 1, uid: "per:9", ref: { kind: "person", name: "Nigel Godrich" }, body: "prod", created_at: "2026-01-01" },
    { id: 2, uid: "trk:d:1#8", ref: { kind: "track", title: "Idioteque", album_artist: "Radiohead", album_title: "Kid A" }, body: "cut", created_at: "2026-01-02" },
  ];
  ok(J.feed(typedFeed, "nigel").notes.length === 1, "feed finds a person note by ref name");
  ok(J.feed(typedFeed, "idioteque").notes.length === 1, "feed finds a track note by ref title");
  ok(J.feed(typedFeed, "kid a").notes.length === 1, "feed finds a track note by ref album");
  ok(J.feed(typedFeed, "person").notes.length === 0, "feed doesn't match ref JSON keys");
  ok(J.refSearchText({ name: "Björk" }) === "björk", "refSearchText lowercases the label");
  ok(J.refSearchText(null) === "", "refSearchText tolerates a null ref");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
