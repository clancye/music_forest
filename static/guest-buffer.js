"use strict";
/*
 * guest-buffer.js — a localStorage-backed buffer for a logged-out guest's choices
 * and taste-door reflections (onboarding Phase B; F26).
 *
 * A guest has no encryption key and no AOTDStore, so their writes must NEVER
 * reach the hosted server's legacy journal.db (the offline single-user tool, not
 * a per-user store — BETA_PLAN §S4). They live here, in the browser, until the
 * first unlock, when Phase D migrates them into the encrypted journal and calls
 * clear() / clearNotes().
 *
 * Choices: a small JSON list of
 *   { client_id, chosen_id, not_chosen_id, day, reasons, note, chosen_at, updated_at }
 * capped at CAP entries so it can't grow unbounded. Plaintext, but low-sensitivity
 * ("I chose album X"). (The localStorage KEY string is left as the historical
 * "…picks.v1" so an in-flight guest's buffer isn't orphaned by the v7 rename.)
 *
 * Notes (F26 — the "what's an album you remember?" taste-door; owner amended
 * the choices-only locked decision 6 on 2026-07-03): a parallel list of
 *   { client_id, uid, release_id, track, timestamp, body, ref, created_at, updated_at }
 * under its own key, capped at NOTES_CAP (`ref` is a v8 typed-entity snapshot,
 * null for an album note). A reflection is more personal than a
 * choice, so the cap is smaller and the copy around the door says plainly that it
 * lives on this device until a journal keeps it for good.
 *
 * The core is pure: create() takes an injectable { storage, now, newId } so it
 * unit-tests headlessly with no browser. In the app it defaults to
 * window.localStorage (with an in-memory fallback when storage is unavailable —
 * private mode, quota, disabled cookies — so a guest pick never throws).
 *
 * UMD: exports for node tests AND sets window.AOTDGuestBuffer in the browser.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  if (root) root.AOTDGuestBuffer = mod;
})(typeof self !== "undefined" ? self : this, function () {
  const KEY = "aotd.guest.picks.v1";
  const CAP = 50;
  const NOTES_KEY = "aotd.guest.notes.v1";
  const NOTES_CAP = 20;

  // A Storage-shaped in-memory fallback so the buffer is total: it never throws
  // when the real storage is missing or blocked. Only the one KEY is tracked.
  function memStore() {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => { m.set(k, String(v)); },
      removeItem: (k) => { m.delete(k); },
    };
  }

  function defaultId() {
    try {
      if (typeof crypto !== "undefined" && crypto && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) { /* fall through */ }
    return "gp-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  // Seconds precision, matching journal-store.nowIso() so a migrated pick's
  // picked_at looks identical to a natively-recorded one.
  function defaultNow() { return new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); }

  function cleanReasons(reasons) {
    if (!Array.isArray(reasons)) return [];
    const out = [], seen = new Set();
    for (let r of reasons) {
      if (typeof r !== "string") continue;
      r = r.trim().slice(0, 40);
      if (r && !seen.has(r)) { seen.add(r); out.push(r); }
    }
    return out.slice(0, 12);
  }

  function create(opts) {
    opts = opts || {};
    let storage = opts.storage;
    if (!storage) {
      try { storage = (typeof localStorage !== "undefined" && localStorage) || memStore(); }
      catch (e) { storage = memStore(); }
    }
    const now = opts.now || defaultNow;
    const newId = opts.newId || defaultId;

    function load() {
      try {
        const raw = storage.getItem(KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
      } catch (e) { return []; }   // corrupt JSON -> treat as empty, don't wedge
    }
    function save(list) {
      try { storage.setItem(KEY, JSON.stringify(list)); } catch (e) { /* quota/blocked: best-effort */ }
    }

    // Every buffered choice, oldest-first (insertion order).
    function all() { return load(); }
    function count() { return load().length; }
    function get(clientId) { return load().find((e) => e.client_id === clientId) || null; }

    // Record a new choice. Returns the stored entry (with its client_id). Caps to
    // the newest CAP entries, dropping the oldest — a guest can't grow this
    // unbounded before they ever make an account.
    function record(p) {
      p = p || {};
      const t = now();
      const entry = {
        client_id: newId(),
        chosen_uid: p.chosen_uid != null ? p.chosen_uid
          : (p.chosen_id != null ? "d:" + p.chosen_id : null),
        chosen_id: p.chosen_id != null ? p.chosen_id : null,
        not_chosen_uid: p.not_chosen_uid != null ? p.not_chosen_uid
          : (p.not_chosen_id != null ? "d:" + p.not_chosen_id : null),
        not_chosen_id: p.not_chosen_id != null ? p.not_chosen_id : null,
        day: p.day || null,
        reasons: cleanReasons(p.reasons),
        note: (typeof p.note === "string" && p.note.trim()) ? p.note.trim() : null,
        chosen_at: t,
        updated_at: t,
      };
      const list = load();
      list.push(entry);
      while (list.length > CAP) list.shift();
      save(list);
      return entry;
    }

    // Update an existing choice in place (used when the guest switches sides in the
    // same pairing, or — once allowed — adds a reason/note). Returns true if found.
    function patch(clientId, fields) {
      fields = fields || {};
      const list = load();
      const e = list.find((x) => x.client_id === clientId);
      if (!e) return false;
      if (fields.chosen_uid !== undefined) e.chosen_uid = fields.chosen_uid;
      if (fields.chosen_id !== undefined) e.chosen_id = fields.chosen_id;
      if (fields.not_chosen_uid !== undefined) e.not_chosen_uid = fields.not_chosen_uid;
      if (fields.not_chosen_id !== undefined) e.not_chosen_id = fields.not_chosen_id;
      if (fields.reasons !== undefined) e.reasons = cleanReasons(fields.reasons);
      if (fields.note !== undefined)
        e.note = (typeof fields.note === "string" && fields.note.trim()) ? fields.note.trim() : null;
      e.updated_at = now();
      save(list);
      return true;
    }

    function remove(clientId) {
      const list = load();
      const next = list.filter((e) => e.client_id !== clientId);
      if (next.length === list.length) return false;
      save(next);
      return true;
    }

    // Drop the whole buffer (Phase D calls this after a confirmed migration).
    function clear() { try { storage.removeItem(KEY); } catch (e) { /* ignore */ } }

    // --- notes (F26: the taste-door reflections) -----------------------------
    // Same grammar as picks, own key + smaller cap. Total like everything here:
    // corrupt JSON reads as empty, a blocked write is best-effort.
    function loadNotes() {
      try {
        const raw = storage.getItem(NOTES_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
      } catch (e) { return []; }
    }
    function saveNotes(list) {
      try { storage.setItem(NOTES_KEY, JSON.stringify(list)); } catch (e) { /* best-effort */ }
    }

    function notesAll() { return loadNotes(); }
    function notesCount() { return loadNotes().length; }
    function notesForUid(uid) {
      const u = uid == null ? "" : String(uid);
      return loadNotes().filter((e) => e.uid === u);
    }

    // Record a reflection. Identity mirrors the journal note shape (uid leads,
    // release_id rides along as Discogs provenance for the snapshot hydration at
    // migration). Returns the stored entry, or null when there's nothing to keep
    // (no body / no identity) — the caller stays benign either way.
    function recordNote(n) {
      n = n || {};
      const body = (typeof n.body === "string" && n.body.trim()) ? n.body.trim() : "";
      const uid = n.uid != null && String(n.uid).trim() ? String(n.uid).trim()
        : (n.release_id != null ? "d:" + n.release_id : null);
      // A free noticing (#58 guest Notebook) has no uid — only the body is
      // required, mirroring the signed-in composer. uid stays null.
      if (!body) return null;
      const t = now();
      const entry = {
        client_id: newId(),
        uid,
        release_id: n.release_id != null ? n.release_id : null,
        // #47 parity: capture the album's on-screen name, so an MB-only ('m:') note
        // (no catalog row to hydrate from) doesn't render "a record" in the guest
        // Notebook or migrate nameless. Null for a free noticing / typed note.
        artist: (typeof n.artist === "string" && n.artist.trim()) ? n.artist.trim() : null,
        title: (typeof n.title === "string" && n.title.trim()) ? n.title.trim() : null,
        track: (typeof n.track === "string" && n.track.trim()) ? n.track.trim() : null,
        timestamp: (typeof n.timestamp === "string" && n.timestamp.trim()) ? n.timestamp.trim() : null,
        body,
        // v8: a typed note (artist/person/track uid) carries a small `ref`
        // snapshot so it renders once migrated into the encrypted journal.
        ref: (n.ref && typeof n.ref === "object") ? n.ref : null,
        created_at: t,
        updated_at: t,
      };
      const list = loadNotes();
      list.push(entry);
      while (list.length > NOTES_CAP) list.shift();
      saveNotes(list);
      return entry;
    }

    // Edit a buffered reflection in place (body/track/timestamp only — identity
    // never changes). Returns true if found.
    function patchNote(clientId, fields) {
      fields = fields || {};
      const list = loadNotes();
      const e = list.find((x) => x.client_id === clientId);
      if (!e) return false;
      if (fields.body !== undefined) {
        const b = (typeof fields.body === "string" && fields.body.trim()) ? fields.body.trim() : "";
        if (b) e.body = b;               // a note never patches down to empty
      }
      if (fields.track !== undefined)
        e.track = (typeof fields.track === "string" && fields.track.trim()) ? fields.track.trim() : null;
      if (fields.timestamp !== undefined)
        e.timestamp = (typeof fields.timestamp === "string" && fields.timestamp.trim()) ? fields.timestamp.trim() : null;
      e.updated_at = now();
      saveNotes(list);
      return true;
    }

    function removeNote(clientId) {
      const list = loadNotes();
      const next = list.filter((e) => e.client_id !== clientId);
      if (next.length === list.length) return false;
      saveNotes(next);
      return true;
    }

    function clearNotes() { try { storage.removeItem(NOTES_KEY); } catch (e) { /* ignore */ } }

    return { record, patch, remove, get, all, count, clear,
      recordNote, patchNote, removeNote, notesForUid, notesAll, notesCount,
      clearNotes, KEY, CAP, NOTES_KEY, NOTES_CAP };
  }

  // ===========================================================================
  // Phase D — replay the buffer into the encrypted journal.
  //
  // On the first unlock after a guest session, the buffered choices are folded
  // into AOTDStore. store.addChoice() is the WRONG tool here: it stamps a fresh
  // chosen_at and wants full album objects. Instead we hydrate album snapshots
  // by id and shape the entries into a journal-export-style payload, then hand
  // it to store.importExport(), which already replays choices idempotently
  // (deduped by `${chosen_uid}|${chosen_at}`) and preserves the original
  // timestamps. The buffer is cleared ONLY after importExport resolves, so a
  // failed or partial write never loses a guest's choices (they stay buffered to
  // retry). F26 adds the taste-door reflections alongside: note rows ride the
  // same payload (importExport dedups them by `${uid}|${created_at}|${body}`),
  // so one confirmed import carries the whole guest session across.
  // ===========================================================================

  // Field readers tolerant of a pre-v7 buffered entry (winner_*/loser_*/picked_at
  // from before the choices rename), so an in-flight guest's old rows still replay.
  const chId = (e) => (e.chosen_id != null ? e.chosen_id : e.winner_id);
  const chUid = (e) => (e.chosen_uid != null ? e.chosen_uid : e.winner_uid);
  const ncId = (e) => (e.not_chosen_id != null ? e.not_chosen_id : e.loser_id);
  const ncUid = (e) => (e.not_chosen_uid != null ? e.not_chosen_uid : e.loser_uid);
  const chAt = (e) => (e.chosen_at != null ? e.chosen_at : e.picked_at);

  // Shape one buffered entry + its hydrated album snapshots into a journal-export
  // choice row (the shape store.importExport consumes). Pure; never throws. A
  // missing snapshot still yields a row carrying chosen_id + chosen_at, so an
  // unknown album degrades the snapshot rather than dropping the choice.
  function choiceRow(entry, albumsById) {
    albumsById = albumsById || {};
    const c = albumsById[String(chId(entry))] || {};
    const nc = (ncId(entry) != null && albumsById[String(ncId(entry))]) || {};
    return {
      chosen_uid: chUid(entry)
        || (chId(entry) != null ? "d:" + chId(entry) : null),
      chosen_id: chId(entry) != null ? chId(entry) : null,
      chosen_artist: c.artist, chosen_title: c.title, chosen_released: c.released,
      chosen_discogs_url: c.discogs_url, chosen_genres: c.genres, chosen_year: c.year,
      not_chosen_uid: ncUid(entry)
        || (ncId(entry) != null ? "d:" + ncId(entry) : null),
      not_chosen_id: ncId(entry) != null ? ncId(entry) : null,
      not_chosen_artist: nc.artist, not_chosen_title: nc.title,
      day_context: entry.day || null,
      reasons: Array.isArray(entry.reasons) ? entry.reasons : [],
      note: (typeof entry.note === "string" && entry.note.trim()) ? entry.note.trim() : null,
      chosen_at: chAt(entry),
      updated_at: entry.updated_at || chAt(entry),
    };
  }

  // Build a choices-only journal-export payload from the buffered entries and a
  // {id: album} catalog map. Entries without a chosen id or chosen_at can't form
  // a valid choice (importExport would skip them too) and are dropped here. Pure.
  function buildChoicesExport(entries, albumsById) {
    const choices = (entries || [])
      .filter((e) => e && (chUid(e) != null || chId(e) != null) && chAt(e))
      .map((e) => choiceRow(e, albumsById));
    return {
      app: "album-of-the-day",
      kind: "journal-export",   // importExport validates only this field
      version: 8,               // mirrors journal-store EXPORT_VERSION (informational)
      notes: [], choices, trails: [], platform_marks: [], listens: [],
    };
  }

  // Shape one buffered reflection + its hydrated album snapshot into a
  // journal-export note row. Pure; a missing snapshot degrades to an
  // identity-only note (uid + body + timestamps), never a dropped one.
  function noteRow(entry, albumsById) {
    albumsById = albumsById || {};
    const a = (entry.release_id != null && albumsById[String(entry.release_id)]) || {};
    return {
      uid: entry.uid || (entry.release_id != null ? "d:" + entry.release_id : null),
      release_id: entry.release_id != null ? entry.release_id : null,
      // #47 parity: catalog snapshot leads, the captured name is the MB-only fallback.
      artist: a.artist || entry.artist, title: a.title || entry.title, released: a.released,
      discogs_url: a.discogs_url,
      track: entry.track || null, timestamp: entry.timestamp || null,
      body: entry.body,
      ref: entry.ref || null,   // v8: typed-entity snapshot rides the migration
      created_at: entry.created_at,
      updated_at: entry.updated_at || entry.created_at,
    };
  }

  // The full guest payload: choices + notes in one export. A note needs only a
  // body + created_at to be valid — a free noticing (null uid) is a first-class
  // note (#58), so it migrates too; importExport dedups by `${uid}|${created_at}|${body}`
  // with a null uid just like the store's own free notes. Pure.
  function buildGuestExport(choiceEntries, noteEntries, albumsById) {
    const out = buildChoicesExport(choiceEntries, albumsById);
    out.notes = (noteEntries || [])
      .filter((e) => e && e.body && e.created_at)
      .map((e) => noteRow(e, albumsById));
    return out;
  }

  // Replay a guest's buffered choices into the unlocked store, then clear the
  // buffer — but ONLY after the store confirms the writes, so a failure never
  // loses data. Idempotent: importExport dedups by `${chosen_uid}|${chosen_at}`,
  // so a second run (or a re-run after a crash between import and clear) adds
  // nothing.
  //
  //   buf        — a buffer instance from create()
  //   store      — the unlocked AOTDStore (must expose importExport)
  //   albumsFor  — async (ids[]) => ({ [id]: album }); hydrates snapshots by id
  //
  // Returns { entries, migrated, skipped, result }. A no-op (empty buffer or no
  // store) returns entries: 0 and never touches the buffer.
  async function migrateChoices(opts) {
    opts = opts || {};
    const buf = opts.buf, store = opts.store, albumsFor = opts.albumsFor;
    const none = { entries: 0, migrated: 0, skipped: 0, result: null };
    if (!buf || !store || typeof store.importExport !== "function") return none;
    const entries = buf.all();
    if (!entries.length) return none;

    const ids = [];
    for (const e of entries) {
      if (chId(e) != null) ids.push(chId(e));
      if (ncId(e) != null) ids.push(ncId(e));
    }
    const albumsById = (albumsFor ? await albumsFor(ids) : {}) || {};
    const payload = buildChoicesExport(entries, albumsById);

    // Throws => the buffer is left fully intact for a later retry.
    const result = await store.importExport(payload);
    buf.clear();   // reached only on a confirmed, non-throwing import
    return {
      entries: entries.length,
      migrated: result.choices, skipped: result.choices_skipped, result,
    };
  }

  // F26: replay the WHOLE guest session — choices and taste-door reflections —
  // in one importExport. Same discipline as migrateChoices: idempotent (notes
  // dedup by `${uid}|${created_at}|${body}`, choices by `${chosen_uid}|${chosen_at}`),
  // and each buffer clears ONLY after the store confirms the one shared write.
  async function migrateGuest(opts) {
    opts = opts || {};
    const buf = opts.buf, store = opts.store, albumsFor = opts.albumsFor;
    const none = { entries: 0, migrated: 0, skipped: 0,
      migrated_notes: 0, skipped_notes: 0, result: null };
    if (!buf || !store || typeof store.importExport !== "function") return none;
    const choiceEntries = buf.all();
    const noteEntries = typeof buf.notesAll === "function" ? buf.notesAll() : [];
    if (!choiceEntries.length && !noteEntries.length) return none;

    const ids = [];
    for (const e of choiceEntries) {
      if (chId(e) != null) ids.push(chId(e));
      if (ncId(e) != null) ids.push(ncId(e));
    }
    for (const e of noteEntries) {
      if (e.release_id != null) ids.push(e.release_id);
    }
    const albumsById = (albumsFor ? await albumsFor(ids) : {}) || {};
    const payload = buildGuestExport(choiceEntries, noteEntries, albumsById);

    // Throws => both buffers stay fully intact for a later retry.
    const result = await store.importExport(payload);
    buf.clear();
    if (typeof buf.clearNotes === "function") buf.clearNotes();
    return {
      entries: choiceEntries.length + noteEntries.length,
      migrated: result.choices, skipped: result.choices_skipped,
      migrated_notes: result.notes, skipped_notes: result.notes_skipped,
      result,
    };
  }

  return { create, cleanReasons, buildChoicesExport, buildGuestExport,
    migrateChoices, migrateGuest, KEY, CAP, NOTES_KEY, NOTES_CAP };
});
