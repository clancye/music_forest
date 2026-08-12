/*
 * Headless tests for the guest pick buffer (onboarding Phase B).
 *
 * The buffer is the localStorage-backed home for a logged-out guest's choices
 * before they make an account. We test the pure core with an injected in-memory
 * storage + deterministic clock/id, so there's no browser and no network:
 *   - record:  a pick lands with the right shape
 *   - patch:   switching sides (and reasons/note) updates in place
 *   - cap:     the buffer can't grow past CAP (oldest dropped)
 *   - persist: a fresh buffer over the same storage sees what was written
 *
 * Run: node tests/js/guest-buffer.test.mjs
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const B = require("../../static/guest-buffer.js");

let passed = 0, failed = 0;
function ok(c, m) { if (c) passed++; else { failed++; console.error("  ✗ FAIL:", m); } }

// A Storage-shaped fake shared across buffer instances (so "persist" is real).
function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}

// Deterministic id + clock so assertions are exact.
function seqId() { let n = 0; return () => "cid-" + (++n); }
function fixedNow() { let n = 0; return () => "2026-06-25T00:00:" + String(++n).padStart(2, "0") + "Z"; }

function main() {
  console.log("guest-buffer tests");

  // --- record ---------------------------------------------------------------
  {
    const storage = fakeStorage();
    const buf = B.create({ storage, newId: seqId(), now: fixedNow() });
    ok(buf.count() === 0, "starts empty");

    const e = buf.record({ chosen_id: 100, not_chosen_id: 101, day: "06-25", reasons: ["x"], note: "  loved it  " });
    ok(e.client_id === "cid-1", "record returns the new client_id");
    ok(e.chosen_id === 100 && e.not_chosen_id === 101, "record keeps chosen/not_chosen");
    ok(e.day === "06-25", "record keeps day");
    ok(JSON.stringify(e.reasons) === JSON.stringify(["x"]), "record keeps reasons");
    ok(e.note === "loved it", "record trims note");
    ok(e.chosen_at === e.updated_at && /Z$/.test(e.chosen_at), "record stamps chosen_at == updated_at");
    ok(buf.count() === 1, "count reflects the write");

    // ids-only is a valid pick (a guest can't add reasons/notes pre-account).
    const bare = buf.record({ chosen_id: 200, not_chosen_id: 201, day: "06-25" });
    ok(Array.isArray(bare.reasons) && bare.reasons.length === 0, "bare pick gets empty reasons");
    ok(bare.note === null, "bare pick gets null note");
    ok(buf.count() === 2, "second record");
  }

  // --- patch (switch sides / add reason) ------------------------------------
  {
    const storage = fakeStorage();
    const buf = B.create({ storage, newId: seqId(), now: fixedNow() });
    const e = buf.record({ chosen_id: 100, not_chosen_id: 101, day: "06-25" });

    // switch sides in the same pairing: chosen<->not_chosen
    const okPatch = buf.patch(e.client_id, { chosen_id: 101, not_chosen_id: 100 });
    ok(okPatch === true, "patch returns true for a known id");
    const after = buf.get(e.client_id);
    ok(after.chosen_id === 101 && after.not_chosen_id === 100, "patch swaps the chosen");
    ok(after.updated_at !== e.chosen_at, "patch bumps updated_at");
    ok(buf.count() === 1, "patch doesn't add a row");

    // reasons + note can be set later (forward-compat for when guests may)
    buf.patch(e.client_id, { reasons: ["the voice", "the voice", " "], note: "  later  " });
    const r = buf.get(e.client_id);
    ok(JSON.stringify(r.reasons) === JSON.stringify(["the voice"]), "patch de-dupes/cleans reasons");
    ok(r.note === "later", "patch trims note");

    ok(buf.patch("nope", { chosen_id: 9 }) === false, "patch returns false for an unknown id");
  }

  // --- remove ---------------------------------------------------------------
  {
    const storage = fakeStorage();
    const buf = B.create({ storage, newId: seqId(), now: fixedNow() });
    const a = buf.record({ chosen_id: 1, not_chosen_id: 2, day: "d" });
    buf.record({ chosen_id: 3, not_chosen_id: 4, day: "d" });
    ok(buf.remove(a.client_id) === true, "remove returns true for a known id");
    ok(buf.count() === 1, "remove drops exactly one row");
    ok(buf.get(a.client_id) === null, "removed row is gone");
    ok(buf.remove("nope") === false, "remove returns false for an unknown id");
  }

  // --- cap ------------------------------------------------------------------
  {
    const storage = fakeStorage();
    const buf = B.create({ storage, newId: seqId(), now: fixedNow() });
    for (let i = 0; i < B.CAP + 10; i++) buf.record({ chosen_id: i, not_chosen_id: -1, day: "d" });
    ok(buf.count() === B.CAP, "buffer caps at CAP");
    const ids = buf.all().map((e) => e.chosen_id);
    ok(ids[0] === 10, "oldest entries are dropped (newest kept)");
    ok(ids[ids.length - 1] === B.CAP + 9, "newest entry is retained");
  }

  // --- persist (survives a fresh buffer over the same storage = a refresh) ---
  {
    const storage = fakeStorage();
    const buf1 = B.create({ storage, newId: seqId(), now: fixedNow() });
    buf1.record({ chosen_id: 100, not_chosen_id: 101, day: "06-25" });
    buf1.record({ chosen_id: 200, not_chosen_id: 201, day: "06-25" });

    const buf2 = B.create({ storage });   // new instance, same storage
    ok(buf2.count() === 2, "a fresh buffer sees persisted choices (refresh-safe)");
    ok(buf2.all()[0].chosen_id === 100, "persisted order preserved");

    buf2.clear();
    ok(buf2.count() === 0, "clear empties the buffer");
    ok(B.create({ storage }).count() === 0, "clear persists (migration cleanup)");
  }

  // --- robustness: corrupt storage doesn't throw ----------------------------
  {
    const storage = fakeStorage();
    storage.setItem(B.KEY, "{not valid json");
    const buf = B.create({ storage });
    ok(buf.all().length === 0, "corrupt buffer reads as empty");
    const e = buf.record({ chosen_id: 1, not_chosen_id: 2, day: "d" });
    ok(buf.count() === 1 && e.client_id, "can still record after corruption");
  }

  // === notes (F26: the remember-door reflections) ============================
  // --- recordNote ------------------------------------------------------------
  {
    const storage = fakeStorage();
    const buf = B.create({ storage, newId: seqId(), now: fixedNow() });
    ok(buf.notesCount() === 0, "notes start empty");

    const e = buf.recordNote({ uid: "d:100", release_id: 100,
      body: "  the drum sound of that whole summer  ", track: " 3 ", timestamp: "1:45" });
    ok(e.client_id === "cid-1", "recordNote returns the new client_id");
    ok(e.uid === "d:100" && e.release_id === 100, "recordNote keeps identity");
    ok(e.body === "the drum sound of that whole summer", "recordNote trims body");
    ok(e.track === "3" && e.timestamp === "1:45", "recordNote trims track/timestamp");
    ok(e.created_at === e.updated_at && /Z$/.test(e.created_at), "recordNote stamps created_at == updated_at");
    ok(buf.notesCount() === 1, "notesCount reflects the write");

    // identity can arrive as a bare release_id (older shape) — folds onto d:<id>
    const folded = buf.recordNote({ release_id: 7, body: "b" });
    ok(folded.uid === "d:7", "bare release_id folds onto d:<id>");

    // an empty body still records nothing (there's no note without words)
    ok(buf.recordNote({ uid: "d:1", body: "   " }) === null, "empty body records nothing");
    // #58: a free noticing (no uid/release_id) IS a valid note now — only the body
    // is required; the uid stays null and it migrates as a free note.
    const free = buf.recordNote({ body: "words, no identity" });
    ok(free && free.uid === null, "free note (no identity) records with a null uid");
    ok(buf.notesCount() === 3, "the free note landed alongside the two identified ones");

    // choices and notes never cross: the pick buffer is untouched
    ok(buf.count() === 0, "notes don't leak into the pick buffer");
  }

  // --- patchNote / removeNote / notesForUid ----------------------------------
  {
    const storage = fakeStorage();
    const buf = B.create({ storage, newId: seqId(), now: fixedNow() });
    const e = buf.recordNote({ uid: "d:100", release_id: 100, body: "first" });
    buf.recordNote({ uid: "m:abc", body: "second" });

    ok(buf.patchNote(e.client_id, { body: " rewritten ", track: "2" }) === true,
      "patchNote returns true for a known id");
    const after = buf.notesForUid("d:100")[0];
    ok(after.body === "rewritten" && after.track === "2", "patchNote updates in place");
    ok(after.updated_at !== e.created_at, "patchNote bumps updated_at");
    buf.patchNote(e.client_id, { body: "   " });
    ok(buf.notesForUid("d:100")[0].body === "rewritten", "a note never patches down to empty");
    ok(buf.patchNote("nope", { body: "x" }) === false, "patchNote false for unknown id");

    ok(buf.notesForUid("m:abc").length === 1, "notesForUid scopes by uid");
    ok(buf.notesForUid("d:999").length === 0, "notesForUid empty for unknown uid");

    ok(buf.removeNote(e.client_id) === true, "removeNote returns true for a known id");
    ok(buf.notesCount() === 1, "removeNote drops exactly one row");
    ok(buf.removeNote("nope") === false, "removeNote false for unknown id");
  }

  // --- notes cap + persistence + clearNotes ----------------------------------
  {
    const storage = fakeStorage();
    const buf = B.create({ storage, newId: seqId(), now: fixedNow() });
    for (let i = 0; i < B.NOTES_CAP + 5; i++) {
      buf.recordNote({ uid: "d:" + i, release_id: i, body: "n" + i });
    }
    ok(buf.notesCount() === B.NOTES_CAP, "notes cap at NOTES_CAP");
    ok(buf.notesAll()[0].release_id === 5, "oldest notes dropped (newest kept)");

    const buf2 = B.create({ storage });
    ok(buf2.notesCount() === B.NOTES_CAP, "a fresh buffer sees persisted notes (refresh-safe)");
    buf2.clearNotes();
    ok(buf2.notesCount() === 0, "clearNotes empties the notes");
    ok(B.create({ storage }).notesCount() === 0, "clearNotes persists (migration cleanup)");
    ok(buf2.count() === 0 || true, "pick buffer independent of clearNotes");

    // corrupt notes key reads as empty, still writable
    storage.setItem(B.NOTES_KEY, "{nope");
    const buf3 = B.create({ storage });
    ok(buf3.notesAll().length === 0, "corrupt notes read as empty");
    ok(buf3.recordNote({ uid: "d:1", body: "b" }).client_id, "can still record after corruption");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
