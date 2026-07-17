"use strict";
/*
 * store-bridge.js — make the existing app.js run against the E2EE store WITHOUT
 * editing it (BETA_PLAN.md §4: "retire each Python route only once its JS
 * replacement is live").
 *
 * app.js still calls the legacy journal routes (/api/journal*, /api/picks,
 * /api/trails, /api/album/<id>/marks, /api/connections). In hosted
 * mode, once the journal is unlocked, this wrapper around window.fetch fulfils
 * those calls from the decrypted-in-memory AOTDStore instead — encrypting on
 * write, decrypting/aggregating on read — and returns the exact JSON shapes
 * app.js expects. Everything else (catalog, art, choice, search, bios, feedback)
 * falls through to the network unchanged.
 *
 * In single-user local mode (no Supabase) the wrapper is inert and every request
 * goes straight to Flask, so the local app and its pytest suite are untouched.
 *
 * Surrogate ids: rows are keyed by an opaque UUID client_id on the wire, but
 * app.js assumes small INTEGER ids in a few places (e.g. `x.id === +id`). The
 * bridge therefore hands app.js stable per-session integer surrogates and
 * translates them back to client_ids on write.
 */
(function () {
  const origFetch = window.fetch.bind(window);

  // --- universal album identity (P3 M2) --------------------------------------
  // The store keys notes/picks/marks on a source-agnostic uid now. A URL segment
  // or body field may still arrive as a bare numeric release_id (an older client);
  // fold it onto 'd:<id>'. ridFromUid recovers the numeric id for the catalog
  // (/api/albums) snapshot lookup, which stays albums.db-keyed.
  function canonUid(raw) {
    const s = (raw == null ? "" : String(raw)).trim();
    if (!s) return null;
    if (s.indexOf(":") >= 0) return s;
    if (/^-?\d+$/.test(s)) return "d:" + s;
    return s;
  }
  function ridFromUid(uid) {
    const s = String(uid == null ? "" : uid);
    if (s.startsWith("d:")) { const t = s.slice(2); if (/^-?\d+$/.test(t)) return parseInt(t, 10); }
    return null;
  }
  // v8: classify a note uid by prefix (mirrors journal.py / journal-store.js). An
  // album uid ('d:'/'m:') hydrates its snapshot from the catalog; a typed uid
  // ('art:'/'per:'/'trk:') carries a client-provided `ref` instead.
  function kindFromUid(uid) {
    if (uid == null || uid === "") return "free";
    const s = String(uid);
    if (s.startsWith("d:") || s.startsWith("m:")) return "album";
    if (s.startsWith("art:")) return "artist";
    if (s.startsWith("per:")) return "person";
    if (s.startsWith("trk:")) return "track";
    return "other";
  }
  const _isTypedKind = (k) => k === "artist" || k === "person" || k === "track";

  // --- surrogate id map ------------------------------------------------------
  let _seq = 0;
  const c2s = new Map(), s2c = new Map();
  function sid(cid) {
    if (c2s.has(cid)) return c2s.get(cid);
    const id = ++_seq; c2s.set(cid, id); s2c.set(id, cid); return id;
  }
  function cid(s) { return s2c.get(+s) || null; }

  function store() { return window.AOTDStore; }
  function active() { return !!(window.AOTD_HOSTED && store() && !store().locked()); }

  function J(data, status) {
    return new Response(JSON.stringify(data),
      { status: status || 200, headers: { "Content-Type": "application/json" } });
  }
  function readBody(init) {
    if (!init || init.body == null) return {};
    try { return JSON.parse(init.body); } catch (e) { return {}; }
  }

  // Batch catalog lookup via the (server-side, public) /api/albums endpoint.
  // Catalog metadata (title/artist/date/genres/links) is immutable, so cache each
  // hydrated album by id and only ever fetch the ones we haven't seen. Without
  // this, every Notes/Picks render re-hydrated ALL referenced albums (100+ ids on
  // a full journal), and rapid mode-cycling stacked those heavy /api/albums
  // batches on the one worker until it OOM'd (owner stress-test 2026-07-04).
  const _albumCache = new Map();
  async function albumsFor(ids) {
    const uniq = Array.from(new Set(ids.filter((x) => x != null).map(String)));
    if (!uniq.length) return {};
    const out = {};
    const missing = [];
    for (const id of uniq) {
      if (_albumCache.has(id)) out[id] = _albumCache.get(id);
      else missing.push(id);
    }
    if (missing.length) {
      const r = await origFetch(
        "/api/albums?ids=" + encodeURIComponent(missing.join(",")));
      const d = await r.json();
      const got = d.albums || {};
      for (const id of missing) {
        if (got[id]) { _albumCache.set(id, got[id]); out[id] = got[id]; }
      }
    }
    return out;
  }
  async function oneAlbum(id) {
    if (id == null) return null;
    const m = await albumsFor([id]);
    return m[String(id)] || null;
  }

  // --- per-shape surrogate translation --------------------------------------
  const noteOut = (n) => Object.assign({}, n, { id: sid(n.id) });

  // ===========================================================================
  // Route handlers (return a Response, or null to fall through)
  // ===========================================================================
  async function handle(path, method, init) {
    const s = store();

    // --- notes ---
    if (path === "/api/journal/note" && method === "POST") {
      const b = readBody(init);
      // N3b: a note is record-optional. A free noticing has no uid/album; the body
      // is the only requirement. With a uid we snapshot the album from the catalog
      // (an MB-only album has no albums.db row, so it's stored identity-only).
      const rawId = b.uid != null ? b.uid : b.release_id;
      const uid = rawId != null ? canonUid(rawId) : null;
      const body = (b.body || "").trim();
      if (!body) {
        return J({ error: "non-empty body required" }, 400);
      }
      // v8: only an album uid hydrates a catalog snapshot; a typed uid
      // (artist/person/track) carries the client-provided `ref` instead.
      const kind = kindFromUid(uid);
      const rid = kind === "album" ? ridFromUid(uid) : null;
      const catalog = (rid != null ? await oneAlbum(rid) : null) || {};
      // #47: an MB-only album (m: uid, no albums.db row) can't hydrate a catalog
      // snapshot here, so fall back to the name the client captured on screen —
      // otherwise the note persists an empty artist/title and the Notebook shows
      // "a record" (the KEPT-choice path already snapshots its name at keep time).
      const album = (kind === "album")
        ? Object.assign({}, catalog, {
            artist: catalog.artist || b.artist || "",
            title: catalog.title || b.title || "",
          })
        : catalog;
      const ref = _isTypedKind(kind) ? (b.ref || null) : null;
      const stored = await s.addNote(uid, album, body,
        (b.track || "").trim() || null, (b.timestamp || "").trim() || null, ref);
      return J({ ok: true, id: sid(stored.id) });
    }
    let m = path.match(/^\/api\/journal\/note\/([^/]+)$/);
    if (m && method === "PATCH") {
      const b = readBody(init);
      const fields = {};
      if ("body" in b) fields.body = b.body || "";
      if ("track" in b) fields.track = b.track || "";
      if ("timestamp" in b) fields.timestamp = b.timestamp || "";
      try {
        const ok = await s.updateNote(cid(m[1]), fields);
        return J({ ok: !!ok });
      } catch (e) { return J({ error: e.message }, 400); }
    }
    if (m && method === "DELETE") {
      await s.deleteNote(cid(m[1]));
      return J({ ok: true, deleted: true });
    }
    m = path.match(/^\/api\/journal\/note\/([^/]+)\/restore$/);
    if (m && method === "POST") {
      const ok = await s.restoreNote(cid(m[1]));
      return J({ ok: !!ok });
    }
    m = path.match(/^\/api\/journal\/album\/([^/]+)$/);
    if (m && method === "GET") {
      const uid = canonUid(decodeURIComponent(m[1]));
      const data = s.forAlbum(uid);
      return J({ uid: data.uid, release_id: data.release_id,
        notes: data.notes.map(noteOut), choices: data.choices || [] });
    }
    // GET /api/journal is handled before this dispatch (needs catalog prefetch).

    // --- marks ---
    m = path.match(/^\/api\/album\/([^/]+)\/marks$/);
    if (m && method === "GET") {
      return J({ marks: s.getMarks(canonUid(decodeURIComponent(m[1]))) });
    }
    if (m && method === "POST") {
      const uid = canonUid(decodeURIComponent(m[1]));
      const b = readBody(init);
      const rid = ridFromUid(uid);
      const album = (rid != null ? await oneAlbum(rid) : null) || {};
      try {
        const marks = await s.setMark(uid, album, b.service, b.state);
        return J({ ok: true, marks });
      } catch (e) { return J({ error: e.message }, 400); }
    }

    // --- choices ---
    if (path === "/api/choices" && method === "POST") {
      const b = readBody(init);
      const chuid = canonUid(b.chosen_uid != null ? b.chosen_uid : b.chosen_id);
      if (!chuid) return J({ error: "chosen_uid (or chosen_id) required" }, 400);
      const chrid = ridFromUid(chuid);
      const ncuid = canonUid(b.not_chosen_uid != null ? b.not_chosen_uid : b.not_chosen_id);
      const ncrid = ridFromUid(ncuid);
      const map = await albumsFor([chrid, ncrid]);
      let chosen;
      if (chrid != null) {
        chosen = map[String(chrid)];
        if (!chosen) return J({ error: "unknown chosen album" }, 404);
        chosen = Object.assign({}, chosen, { uid: chuid });
      } else {
        chosen = { uid: chuid };          // MB-only: identity-only snapshot
      }
      let notChosen = null;
      if (ncuid) {
        const nc = ncrid != null ? map[String(ncrid)] : null;
        notChosen = nc ? Object.assign({}, nc, { uid: ncuid }) : { uid: ncuid };
      }
      const stored = await s.addChoice(chosen, notChosen,
        (b.day || "").trim() || null, cleanReasons(b.reasons),
        (b.note || "").trim() || null);
      return J({ ok: true, id: sid(stored.id) });
    }
    m = path.match(/^\/api\/choices\/([^/]+)$/);
    if (m && method === "PATCH") {
      const b = readBody(init);
      const fields = {};
      const chuid = canonUid(b.chosen_uid != null ? b.chosen_uid : b.chosen_id);
      if (chuid) {
        const chrid = ridFromUid(chuid);
        const ch = chrid != null ? await oneAlbum(chrid) : null;
        if (chrid != null && !ch) return J({ error: "unknown chosen album" }, 404);
        fields.chosen = Object.assign({}, ch || {}, { uid: chuid });
      }
      const ncuid = canonUid(b.not_chosen_uid != null ? b.not_chosen_uid : b.not_chosen_id);
      if (ncuid) {
        const ncrid = ridFromUid(ncuid);
        const nc = ncrid != null ? await oneAlbum(ncrid) : null;
        fields.not_chosen = Object.assign({}, nc || {}, { uid: ncuid });
      }
      if ("reasons" in b) fields.reasons = cleanReasons(b.reasons);
      if ("note" in b) fields.note = b.note || "";
      const ok = await s.updateChoice(cid(m[1]), fields);
      return J({ ok: !!ok });
    }
    if (m && method === "DELETE") {
      await s.deleteChoice(cid(m[1]));
      return J({ ok: true });
    }
    if (path === "/api/choices" && method === "GET") {
      const choices = s.choicesFeed();
      // Hydrate by uid so MB-only choices (no Discogs release_id) resolve too, and
      // every choice carries its confirmed platforms (Deezer + door) — /api/albums
      // is pool-aware now. Fall back to the bare release_id for pre-uid choices.
      const keyOf = (p) => p.chosen_uid || (p.chosen_id != null ? p.chosen_id : null);
      const map = await albumsFor(choices.map(keyOf));
      const out = choices.map((p) => {
        const album = map[String(keyOf(p))] || null;
        return Object.assign({}, p, { id: sid(p.id), album, cover: album ? album.cover : null });
      });
      return J({ choices: out, stats: s.choicesStats() });
    }

    // --- connections (subject graph) ---
    if (path === "/api/connections" && method === "GET") {
      const g = s.subjectGraph(2);
      const notes = {};
      for (const k of Object.keys(g.notes)) notes[sid(k)] = noteOut(g.notes[k]);
      const subjects = g.subjects.map((sub) =>
        Object.assign({}, sub, { note_ids: sub.note_ids.map((id) => sid(id)) }));
      return J({ subjects, notes, notes_total: g.notes_total, min_notes: g.min_notes });
    }

    // --- trails ---
    if (path === "/api/trails" && method === "GET") {
      return J({ trails: s.trailsFeed().map((t) => Object.assign({}, t, { id: sid(t.id) })) });
    }
    if (path === "/api/trails" && method === "POST") {
      const b = readBody(init);
      try {
        const stored = await s.addTrail(b.name, cleanTrailNodes(b.nodes));
        return J({ ok: true, id: sid(stored.id) });
      } catch (e) { return J({ error: e.message }, 400); }
    }
    m = path.match(/^\/api\/trails\/([^/]+)$/);
    if (m && method === "PATCH") {
      const b = readBody(init);
      try { return J({ ok: !!(await s.renameTrail(cid(m[1]), b.name)) }); }
      catch (e) { return J({ error: e.message }, 400); }
    }
    if (m && method === "DELETE") {
      await s.deleteTrail(cid(m[1]));
      return J({ ok: true });
    }

    return null;
  }

  // Mirror server._clean_reasons / _clean_trail_nodes so stored shapes match.
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
  function cleanTrailNodes(nodes) {
    if (!Array.isArray(nodes)) return [];
    return nodes.slice(0, 200).map((n) => {
      if (!n || typeof n !== "object") return null;
      let parent = parseInt(n.parent, 10); if (!Number.isFinite(parent)) parent = -1;
      const nav = (n.nav && typeof n.nav === "object") ? n.nav : null;
      return { parent, label: String(n.label || "").slice(0, 120), nav };
    }).filter(Boolean);
  }

  // ===========================================================================
  // Guest mode (onboarding Phase A): a logged-out visitor has no key and no store,
  // so their writes must NEVER reach the hosted server's legacy journal.db (the
  // offline single-user tool, not a per-user store — BETA_PLAN §S4). This guard
  // intercepts the same legacy persistence routes app.js calls and answers them
  // locally with benign shapes, so the Choose flow works and nothing leaks.
  //
  // Phase A: choices are ephemeral (a fake id; not stored). Phase B replaces the
  // choices branch below with a localStorage-backed buffer (record/patch/cap), so
  // a guest's choices survive refresh and migrate into the encrypted journal on the
  // first unlock (Phase D). Everything else stays an empty/ok stub — guest mode is
  // choices-only by design (locked decision 6).
  function guestActive() {
    return !!(window.AOTD_HOSTED && window.AOTD_GUEST && !active());
  }
  let _guestSeq = 0;
  // Phase B: the guest choice buffer (localStorage). Created lazily so it picks up
  // window.AOTDGuestBuffer regardless of script order and is only touched in
  // guest mode. A guest's choices live here and never reach the server.
  let _guestBuf = null;
  function guestBuf() {
    if (!_guestBuf && window.AOTDGuestBuffer) _guestBuf = window.AOTDGuestBuffer.create();
    return _guestBuf;
  }
  async function guestHandle(path, method, init) {
    const buf = guestBuf();
    // choices — buffered locally (Phase B). Surrogate integer ids (sid/cid) keep
    // app.js's "POST then PATCH the same choice" flow working unchanged; on the
    // first unlock Phase D replays this buffer into the encrypted journal.
    if (path === "/api/choices" && method === "POST") {
      if (!buf) return J({ ok: true, id: ++_guestSeq });   // buffer unavailable: stay benign
      const b = readBody(init);
      const entry = buf.record({
        chosen_uid: canonUid(b.chosen_uid != null ? b.chosen_uid : b.chosen_id),
        not_chosen_uid: canonUid(b.not_chosen_uid != null ? b.not_chosen_uid : b.not_chosen_id),
        chosen_id: b.chosen_id, not_chosen_id: b.not_chosen_id,
        day: (b.day || "").trim() || null,
        reasons: cleanReasons(b.reasons),
        note: (b.note || "").trim() || null,
      });
      return J({ ok: true, id: sid(entry.client_id) });
    }
    if (path === "/api/choices" && method === "GET") {
      if (!buf) return J({ choices: [], stats: {} });
      const rows = buf.all().slice().reverse();            // newest-first, like choicesFeed
      const map = await albumsFor(rows.map((p) => p.chosen_id));
      const out = rows.map((p) => {
        const album = map[String(p.chosen_id)] || null;
        return Object.assign({}, p, {
          id: sid(p.client_id), album, cover: album ? album.cover : null,
        });
      });
      return J({ choices: out, stats: {} });
    }
    const pm = path.match(/^\/api\/choices\/([^/]+)$/);
    if (pm && method === "PATCH") {
      const b = readBody(init);
      const fields = {};
      if (b.chosen_uid !== undefined) fields.chosen_uid = canonUid(b.chosen_uid);
      if (b.chosen_id !== undefined) fields.chosen_id = b.chosen_id;
      if (b.not_chosen_uid !== undefined) fields.not_chosen_uid = canonUid(b.not_chosen_uid);
      if (b.not_chosen_id !== undefined) fields.not_chosen_id = b.not_chosen_id;
      if ("reasons" in b) fields.reasons = cleanReasons(b.reasons);
      if ("note" in b) fields.note = b.note || "";
      const ok = buf ? buf.patch(cid(pm[1]), fields) : true;
      return J({ ok: !!ok });
    }
    if (pm && method === "DELETE") {
      if (buf) buf.remove(cid(pm[1]));
      return J({ ok: true });
    }
    // notes — written for real into the buffer, migrated into the encrypted
    // journal on the first unlock. The guest Notebook now renders these (#58), so
    // a note is record-optional exactly like the signed-in composer: a free
    // noticing has no uid/album and only the body is required.
    if (path === "/api/journal/note" && method === "POST") {
      if (!buf || !buf.recordNote) return J({ ok: true, id: ++_guestSeq });
      const b = readBody(init);
      const uid = canonUid(b.uid != null ? b.uid : b.release_id);
      const body = (b.body || "").trim();
      if (!body) {
        return J({ error: "non-empty body required" }, 400);
      }
      // v8: a typed uid (artist/person/track) carries a `ref` snapshot the buffer
      // keeps so the note renders once migrated into the encrypted journal.
      const ref = _isTypedKind(kindFromUid(uid)) ? (b.ref || null) : null;
      const entry = buf.recordNote({
        uid, release_id: ridFromUid(uid), body,
        // #47 parity: carry the album's on-screen name so an MB-only note keeps it.
        artist: b.artist, title: b.title,
        track: (b.track || "").trim() || null,
        timestamp: (b.timestamp || "").trim() || null,
        ref,
      });
      if (!entry) return J({ ok: true, id: ++_guestSeq });   // storage blocked: stay benign
      return J({ ok: true, id: sid(entry.client_id) });
    }
    const nm = path.match(/^\/api\/journal\/note\/([^/]+)$/);
    if (nm && method === "PATCH") {
      if (!buf || !buf.patchNote) return J({ ok: true });
      const b = readBody(init);
      const fields = {};
      if ("body" in b) fields.body = b.body;
      if ("track" in b) fields.track = b.track;
      if ("timestamp" in b) fields.timestamp = b.timestamp;
      return J({ ok: !!buf.patchNote(cid(nm[1]), fields) });
    }
    if (nm && method === "DELETE") {
      if (buf && buf.removeNote) buf.removeNote(cid(nm[1]));
      return J({ ok: true, deleted: true });
    }
    // A buffered delete is hard (no tombstones in localStorage) — the Undo
    // toast's restore honestly reports it couldn't.
    if (/^\/api\/journal\/note\/[^/]+\/restore$/.test(path) && method === "POST") {
      return J({ ok: false });
    }
    if (path === "/api/journal" && method === "GET") {
      return J({ summary: { notes: 0, albums: 0, artists: 0 }, albums: [] });
    }
    if (path.startsWith("/api/journal/note")) {
      if (method === "GET") return J({ release_id: null, notes: [] });
      return J({ ok: true, id: ++_guestSeq });
    }
    const am = path.match(/^\/api\/journal\/album\/([^/]+)$/);
    if (am && method === "GET") {
      const uid = canonUid(decodeURIComponent(am[1]));
      const rows = (buf && buf.notesForUid) ? buf.notesForUid(uid) : [];
      return J({ uid, release_id: ridFromUid(uid),
        notes: rows.map((n) => Object.assign({}, n, { id: sid(n.client_id) })) });
    }
    // marks (the pick panel's Listen row asks for these) — none for a guest.
    if (/^\/api\/album\/[^/]+\/marks$/.test(path)) {
      return method === "GET" ? J({ marks: [] }) : J({ ok: true, marks: [] });
    }
    // trails — the in-session wander is client-side; saving needs a journal.
    if (path === "/api/trails" && method === "GET") return J({ trails: [] });
    if (path.startsWith("/api/trails")) return J({ ok: true, id: ++_guestSeq });
    // explore surfaces — not reachable by a guest, but guard them anyway.
    if (path === "/api/connections" && method === "GET") {
      return J({ subjects: [], notes: {}, notes_total: 0, min_notes: 2 });
    }
    return null;   // catalog/art/choice/search/bios/feedback fall through to network
  }

  // --- Phase D: migrate the guest buffer into the encrypted journal ----------
  // Called by auth-ui finishUnlock on the first unlock after a guest session.
  // Hydrates album snapshots by id (albumsFor — the same public /api/albums
  // path the signed-in pick route uses, so a migrated snapshot is exactly as
  // complete as a natively-recorded one) and replays the buffered picks AND
  // taste-door reflections (F26) through store.importExport (idempotent,
  // preserves the original timestamps). The guest buffers clear themselves only
  // on a confirmed write, so a failure never loses a pick or a reflection.
  // Returns the migration tally, or a no-op shape when there's nothing to do.
  async function migrateGuestBuffer() {
    const s = store();
    const buf = guestBuf();
    if (!window.AOTDGuestBuffer || !s || s.locked() || !buf) {
      return { entries: 0, migrated: 0, skipped: 0,
        migrated_notes: 0, skipped_notes: 0, result: null };
    }
    return window.AOTDGuestBuffer.migrateGuest({ buf, store: s, albumsFor });
  }

  // The journal feed needs the catalog for the noted albums; handled here so we
  // can fetch albums before delegating to the pure shelf builder.
  async function handleJournalFeed(url) {
    const s = store();
    const q = new URL(url, location.origin).searchParams.get("q") || null;
    const rids = Array.from(new Set(s.notes().map((n) => n.release_id)));
    const albumsById = await albumsFor(rids);
    const feed = s.journalFeed(albumsById, q);
    feed.albums = feed.albums.map((a) =>
      Object.assign({}, a, { notes: a.notes.map(noteOut) }));
    return J(feed);
  }

  // Guest Notebook feed (#58): a guest has no store, but their buffered notes ARE
  // a real notebook now (the taste-tier). Build the same grouped feed the store
  // path returns, straight from the note buffer, by reusing the pure journalFeed
  // grouper — so the guest Notebook and the signed-in one render identically. The
  // buffer note has no artist/title (they hydrate from the catalog by release_id;
  // MB-only names heal at loadTrail via resolveAlbums, same as signed-in). Note
  // ids ride the sid()/cid() surrogate map so an in-place edit/delete round-trips.
  async function handleGuestJournalFeed(url) {
    const buf = guestBuf();
    const empty = { summary: { notes: 0, albums: 0, artists: 0 }, albums: [] };
    if (!buf || !buf.notesAll || !window.AOTDJournal) return J(empty);
    const q = new URL(url, location.origin).searchParams.get("q") || null;
    const notes = buf.notesAll().map((n) => ({
      id: n.client_id, uid: n.uid, release_id: n.release_id,
      // #47 parity: the captured name is journalFeed's fallback (n.artist || album.artist)
      // when the catalog can't hydrate an MB-only album.
      artist: n.artist || undefined, title: n.title || undefined,
      body: n.body, track: n.track, timestamp: n.timestamp,
      ref: n.ref || null, created_at: n.created_at, updated_at: n.updated_at,
    }));
    const rids = Array.from(new Set(notes.map((n) => n.release_id).filter((x) => x != null)));
    const albumsById = await albumsFor(rids);
    const feed = window.AOTDJournal.journalFeed(notes, albumsById, q);
    feed.albums = feed.albums.map((a) =>
      Object.assign({}, a, { notes: a.notes.map(noteOut) }));
    return J(feed);
  }

  // N1 §4.4: the artist-door echo — your notes on records by ?name=<artist>
  // (exact-match; the store does the filtering). Handled here (not in dispatch)
  // because it reads a query param.
  function handleArtistWords(url) {
    const s = store();
    const name = new URL(url, location.origin).searchParams.get("name") || "";
    const data = s.notesForArtist(name);
    return J({ artist: data.artist, notes: data.notes.map(noteOut) });
  }

  // N1 §4.4 (3a): the person-door echo — fuzzy, catalog-anchored name match. The
  // store tags each hit full/partial; app.js does the credited-album anchoring.
  function handlePersonWords(url) {
    const s = store();
    const name = new URL(url, location.origin).searchParams.get("name") || "";
    const data = s.notesForPerson(name);
    return J({ person: data.person, notes: data.notes.map(noteOut) });
  }

  // N1 §4.4 (3b): the in-note word pull. Threads = terms in a note that recur; a
  // term pull = your other notes using it. The note id on the wire is a surrogate.
  function handleNoteThreads(path) {
    const s = store();
    const m = path.match(/^\/api\/journal\/note\/([^/]+)\/threads$/);
    const clientId = m ? cid(m[1]) : null;
    return J(clientId ? s.noteThreads(clientId) : { threads: [] });
  }
  function handleTermNotes(url) {
    const s = store();
    const term = new URL(url, location.origin).searchParams.get("q") || "";
    const data = s.notesWithTerm(term);
    return J({ term: data.term, notes: data.notes.map(noteOut) });
  }

  // --- the fetch wrapper -----------------------------------------------------
  window.fetch = async function (input, init) {
    try {
      const url = (typeof input === "string") ? input
        : (input && input.url) || "";
      const method = ((init && init.method) ||
        (typeof input === "object" && input.method) || "GET").toUpperCase();
      const path = url.split("?")[0].replace(/^https?:\/\/[^/]+/, "");
      if (active()) {
        // P4 (signed-in reveal): Choose is shown before the journal finishes loading,
        // so a journal READ can arrive while the store is still hydrating. Await the
        // load first — the tab keeps its normal loading state instead of flashing a
        // false-empty shelf; a load failure rejects and surfaces as the 500 below,
        // which the caller renders as "couldn't load" (never a lie that it's empty).
        if (method === "GET" && path.startsWith("/api/journal") &&
            store() && !store().ready()) {
          await store().whenReady();
        }
        if (path === "/api/journal" && method === "GET") return await handleJournalFeed(url);
        if (path === "/api/journal/artist" && method === "GET") return handleArtistWords(url);
        if (path === "/api/journal/person" && method === "GET") return handlePersonWords(url);
        if (path === "/api/journal/term" && method === "GET") return handleTermNotes(url);
        if (/^\/api\/journal\/note\/[^/]+\/threads$/.test(path) && method === "GET")
          return handleNoteThreads(path);
        const resp = await handle(path, method, init);
        if (resp) return resp;
      } else if (guestActive()) {
        // #58: the guest Notebook is real now — its feed builds from the note
        // buffer (needs the query string, so it's special-cased here like the
        // signed-in feed, ahead of the path-only guestHandle dispatch).
        if (path === "/api/journal" && method === "GET") return await handleGuestJournalFeed(url);
        const resp = await guestHandle(path, method, init);
        if (resp) return resp;
      }
    } catch (e) {
      // A bridge failure shouldn't wedge the app; surface it as a 500-shaped JSON
      // so callers' try/catch behaves, and log for the smoke test.
      console.error("store-bridge error", e);
      return J({ error: (e && e.message) || "bridge error" }, 500);
    }
    return origFetch(input, init);
  };

  // migrateGuestPicks stays as an alias: the unified migration is a strict
  // superset (picks + reflections), and an older auth-ui calling the old name
  // must still carry everything across.
  window.AOTDBridge = { _sid: sid, _cid: cid, active,
    migrateGuestBuffer, migrateGuestPicks: migrateGuestBuffer };
})();
