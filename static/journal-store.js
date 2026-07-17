"use strict";
/*
 * journal-store.js — the decrypted-in-memory journal + the read-side analytics
 * that used to run in journal.py (BETA_PLAN.md §4).
 *
 * Under E2EE the server only holds ciphertext, so all of this moves into the
 * browser over the journal decrypted once at unlock and held in memory for the
 * session. Two halves:
 *
 *   1. A tiny store: pull every encrypted row at unlock, decrypt into in-memory
 *      maps (note / choice / trail / mark, keyed by client_id), and encrypt-on-
 *      write each mutation back through the sync layer. The full row — including
 *      release_id and the album snapshot — lives inside the ciphertext.
 *   2. Analytics, ported 1:1 from journal.py: note search/feed, counts, the
 *      emergent `subjects`, the `subject_graph` (Connections), and `choices_stats`.
 *      These are PURE functions over plain arrays, unit-tested headlessly with
 *      no crypto.
 *
 * Mirrors journal.py exactly so views match the pre-rewrite app; the Python
 * routes stay green until each JS replacement is wired and the route retired.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  if (root) root.AOTDJournal = mod;
})(typeof self !== "undefined" ? self : this, function () {

  // The E2EE row kinds. "choice" was "pick" before v7; legacy "pick" server rows
  // are re-keyed onto "choice" at unlock (_migrateChoiceKind), and the server
  // keeps accepting "pick" only so those old rows can be tombstoned.
  const KINDS = ["note", "choice", "trail", "mark"];
  // Matches journal.py's EXPORT_VERSION so a file produced here imports there and
  // vice-versa (BETA_PLAN.md §8). v6 (P3 M2): every row is keyed on a source-
  // agnostic uid ('d:<release_id>' for Discogs, 'm:<album_id>' for MB-only);
  // release_id is denormalized provenance only. v7: `picks`/winner_*/loser_*
  // renamed to `choices`/chosen_*/not_chosen_* (import maps the old names). v8: a
  // note's uid may name a typed entity (art:/per:/trk:) carrying a `ref` snapshot.
  const EXPORT_VERSION = 8;

  // --- universal album identity (P3 M2), mirroring app.js + journal.py --------
  // A row's identity is its uid; a legacy row (release_id only, no uid) folds onto
  // 'd:'+release_id, so old encrypted rows read correctly with NO re-encryption.
  function albumKeyOf(obj) {
    if (!obj) return null;
    if (obj.uid) return obj.uid;
    return (obj.release_id != null) ? "d:" + obj.release_id : null;
  }
  // The chosen record's uid for a choice row (chosen_uid, else 'd:'+chosen_id).
  function choiceKeyOf(p) {
    if (!p) return null;
    if (p.chosen_uid) return p.chosen_uid;
    return (p.chosen_id != null) ? "d:" + p.chosen_id : null;
  }
  // True when a client_id is already a namespaced uid (vs a legacy numeric mark
  // id like "100"), used to decide which mark rows still need re-keying.
  function isUidKey(id) { return typeof id === "string" && id.indexOf(":") >= 0; }
  // The numeric Discogs release_id inside a 'd:<id>' uid, else null.
  function ridFromUid(uid) {
    const s = String(uid == null ? "" : uid);
    if (s.startsWith("d:")) { const t = s.slice(2); if (/^-?\d+$/.test(t)) return parseInt(t, 10); }
    return null;
  }
  // v8: classify a note/mark uid by prefix — 'free' (no uid), 'album' (d:/m:),
  // 'artist' (art:), 'person' (per:), 'track' (trk:), else 'other'. Mirrors
  // journal.py kind_from_uid / app.js kindFromUid. Drives whether a note hydrates
  // its snapshot from the catalog (album) or carries a `ref` (typed).
  function kindFromUid(uid) {
    if (uid == null || uid === "") return "free";
    const s = String(uid);
    if (s.startsWith("d:") || s.startsWith("m:")) return "album";
    if (s.startsWith("art:")) return "artist";
    if (s.startsWith("per:")) return "person";
    if (s.startsWith("trk:")) return "track";
    return "other";
  }

  // --- genre splitting (mirrors genres.py / app.js, R4) ----------------------
  const ATOMIC_GENRES = ["Folk, World, & Country"];
  function splitGenres(s) {
    if (!s) return [];
    ATOMIC_GENRES.forEach((g, i) => { s = s.split(g).join(`@@G${i}@@`); });
    const out = [];
    for (let t of s.split(",")) {
      t = t.trim();
      if (!t) continue;
      const m = t.match(/^@@G(\d+)@@$/);
      out.push(m ? ATOMIC_GENRES[+m[1]] : t);
    }
    return out;
  }

  function nowIso() {
    // Seconds precision, matching journal.py _now() so timestamps look identical.
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  // ===========================================================================
  // Analytics — pure functions, ported from journal.py
  // ===========================================================================

  // journal.py _STOPWORDS, verbatim.
  const STOPWORDS = new Set((`
    a an the and or but if then else so because as of to in on at for with from by
    about into over under again further this that these those here there
    i me my we our us you your he him his she her it its they them their
    is am are was were be been being do does did doing have has had having
    not no nor only own same too very can will just don dont didnt cant
    what which who whom when where why how all any both each few more most other
    some such than that up out off down then once
    song songs album albums track tracks record records note notes listen listened
    listening really got get like one two
  `).trim().split(/\s+/));

  const WORD_RE = /[A-Za-z][A-Za-z'’]+/g;

  /** journal.py _note_terms: distinct uni/bi/trigram terms -> a surface form. */
  function noteTerms(body) {
    let text = (body || "").replace(/\[([^\]]+)\]\([^)]*\)/g, " $1 "); // [label](url)->label
    text = text.replace(/https?:\/\/\S+/g, " ");                       // bare URLs out
    const words = text.match(WORD_RE) || [];
    const lowers = words.map((w) => w.toLowerCase());
    const terms = new Map();
    for (let i = 0; i < words.length; i++) {
      const lw = lowers[i];
      if (lw.length >= 3 && !STOPWORDS.has(lw) && !terms.has(lw)) terms.set(lw, words[i]);
    }
    for (const size of [2, 3]) {
      for (let i = 0; i + size <= words.length; i++) {
        const gram = lowers.slice(i, i + size);
        if (STOPWORDS.has(gram[0]) || STOPWORDS.has(gram[size - 1])) continue;
        const key = gram.join(" ");
        if (!terms.has(key)) terms.set(key, words.slice(i, i + size).join(" "));
      }
    }
    return terms;
  }

  /** journal.py subjects(): terms recurring across >= min_notes notes. */
  function subjects(notes, minNotes = 2, limit = 40) {
    const docCount = new Map();
    const surfaceVotes = new Map();
    for (const n of notes) {
      for (const [lw, surf] of noteTerms(n.body)) {
        docCount.set(lw, (docCount.get(lw) || 0) + 1);
        if (!surfaceVotes.has(lw)) surfaceVotes.set(lw, new Map());
        const v = surfaceVotes.get(lw);
        v.set(surf, (v.get(surf) || 0) + 1);
      }
    }
    const items = [];
    for (const [lw, cnt] of docCount) {
      if (cnt < minNotes) continue;
      const votes = surfaceVotes.get(lw);
      let disp = lw, best = -1;
      for (const [s, c] of votes) if (c > best) { best = c; disp = s; }
      const words = lw.split(" ");
      const multiword = words.length > 1;
      const capitalized = disp[0] === disp[0].toUpperCase() && disp[0] !== disp[0].toLowerCase();
      const score = cnt + (multiword ? 0.3 : 0) + (capitalized ? 0.2 : 0);
      items.push({ term: disp, words, count: cnt, score });
    }
    const contained = (small, big) => {
      const n = small.length;
      for (let i = 0; i + n <= big.length; i++) {
        let eq = true;
        for (let j = 0; j < n; j++) if (big[i + j] !== small[j]) { eq = false; break; }
        if (eq) return true;
      }
      return false;
    };
    const kept = items.filter((it) =>
      !items.some((o) => o.words.length > it.words.length && o.count >= it.count
        && contained(it.words, o.words)));
    kept.sort((a, b) => (b.score - a.score) || (b.count - a.count)
      || a.term.toLowerCase().localeCompare(b.term.toLowerCase()));
    return kept.slice(0, limit).map((it) => ({ term: it.term, count: it.count }));
  }

  /** journal.py subject_graph(): subjects as a place to wander (Connections). */
  function subjectGraph(notes, minNotes = 2, limit = 40) {
    const subs = subjects(notes, minNotes, limit);
    const surface = new Map();   // lower -> display
    const countOf = new Map();
    for (const s of subs) { surface.set(s.term.toLowerCase(), s.term); countOf.set(s.term.toLowerCase(), s.count); }
    const keys = new Set(surface.keys());

    // newest-first, matching the SQL ORDER BY created_at DESC
    const rows = notes.slice().sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    const members = new Map(); for (const k of keys) members.set(k, []);
    const notesById = {};
    const cooc = new Map();  // "lo hi" -> shared count
    for (const r of rows) {
      const present = Array.from(noteTerms(r.body).keys()).filter((k) => keys.has(k)).sort();
      if (!present.length) continue;
      notesById[r.id] = {
        id: r.id, release_id: r.release_id, artist: r.artist, title: r.title,
        body: r.body, track: r.track, timestamp: r.timestamp,
        created_at: r.created_at, updated_at: r.updated_at,
      };
      for (const k of present) members.get(k).push(r.id);
      for (let i = 0; i < present.length; i++)
        for (let j = i + 1; j < present.length; j++) {
          const key = present[i] + " " + present[j];
          cooc.set(key, (cooc.get(key) || 0) + 1);
        }
    }
    const trails = new Map(); for (const k of keys) trails.set(k, []);
    for (const [key, shared] of cooc) {
      const [a, b] = key.split(" ");
      trails.get(a).push([b, shared]); trails.get(b).push([a, shared]);
    }
    const out = subs.map((s) => {
      const lw = s.term.toLowerCase();
      const nb = trails.get(lw).slice().sort((x, y) =>
        (y[1] - x[1]) || ((countOf.get(y[0]) || 0) - (countOf.get(x[0]) || 0)) || x[0].localeCompare(y[0]));
      return {
        term: s.term, count: s.count,
        trails: nb.map(([t, sh]) => ({ term: surface.get(t), shared: sh })),
        note_ids: members.get(lw),
      };
    });
    return { subjects: out, notes: notesById, notes_total: notes.length, min_notes: minNotes };
  }

  /** journal.py choices_stats(): what you choose and why.
   *
   * Iterates choices newest-first (choices_feed order) and counts with insertion-
   * order-stable tie-breaking, so the ranked lists match Python's
   * Counter.most_common() byte-for-byte (ties resolve to first-encountered, NOT
   * alphabetical). `top_decades` keeps journal.py's explicit (count desc, label
   * asc) ordering. */
  function choicesStats(choicesList) {
    const choices = choicesList.slice().sort((a, b) =>
      String(b.chosen_at || "").localeCompare(String(a.chosen_at || "")));
    const artists = new Map(), genres = new Map(), decades = new Map(), reasons = new Map();
    const bump = (m, k) => { if (k) m.set(k, (m.get(k) || 0) + 1); };
    for (const p of choices) {
      bump(artists, p.chosen_artist);
      for (const g of splitGenres(p.chosen_genres)) bump(genres, g);
      const y = p.chosen_year;
      if (y) bump(decades, `${Math.floor(parseInt(y, 10) / 10) * 10}s`);
      for (const r of (p.reasons || [])) bump(reasons, r);
    }
    // Stable sort by count desc only -> insertion order preserved for ties,
    // exactly like Counter.most_common().
    const top = (m, n = 8) => Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, n).map(([label, count]) => ({ label, count }));
    const topDecades = Array.from(decades.entries())
      .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
      .slice(0, 8).map(([label, count]) => ({ label, count }));
    return {
      total: choices.length,
      with_reason: choices.filter((p) => (p.reasons || []).length).length,
      top_artists: top(artists), top_genres: top(genres),
      top_decades: topDecades, reasons: top(reasons, 12),
    };
  }

  /** The searchable label of a typed note's ref (v8) — the entity name
   * (artist/person) or the track title + album context. Mirrors journal.py
   * _ref_search_text exactly (same fields/order/join/lowercasing). */
  function refSearchText(ref) {
    if (!ref || typeof ref !== "object") return "";
    return ["name", "title", "album_artist", "album_title"]
      .map((k) => ref[k]).filter(Boolean).join(" ").toLowerCase();
  }

  /** journal.py feed(): notes for the Journal view, newest first, text-filtered by
   * artist / title / body — and, for a typed note, by its ref label (v8). */
  function feed(notes, query, limit = 2000) {
    const like = query ? query.toLowerCase() : null;
    let out = notes;
    if (like) {
      out = notes.filter((n) =>
        String(n.artist || "").toLowerCase().includes(like) ||
        String(n.title || "").toLowerCase().includes(like) ||
        String(n.body || "").toLowerCase().includes(like) ||
        refSearchText(n.ref).includes(like));
    }
    out = out.slice().sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    return { notes: out.slice(0, limit) };
  }

  function counts(notes) {
    const albums = new Set(), artists = new Set();
    for (const n of notes) {
      const k = albumKeyOf(n);            // count distinct albums by uid
      if (k) albums.add(k);
      if (n.artist) artists.add(n.artist);
    }
    return { notes: notes.length, albums: albums.size, artists: artists.size };
  }

  /**
   * server.api_journal_feed(): notes grouped into a per-album shelf + summary.
   * `albumsById` is a {release_id: album} catalog map the caller fetched from
   * /api/albums (the catalog stays server-side under E2EE); cover/genres/year
   * come from there, while artist/title fall back to the note's own snapshot.
   */
  function journalFeed(notes, albumsById, query) {
    const list = feed(notes, query).notes;
    const shelf = new Map();                 // uid -> group (insertion order)
    const genreAlbums = new Map();           // genre -> Set(uid)
    const get = (rid) => (albumsById && (albumsById[rid] || albumsById[String(rid)])) || {};
    for (const n of list) {
      // Group by the source-agnostic uid so MB-only notes don't collapse onto a
      // shared null release_id; the catalog lookup still uses the numeric id.
      const uid = albumKeyOf(n);
      let g = shelf.get(uid);
      if (!g) {
        const album = get(n.release_id);
        g = {
          uid,
          release_id: n.release_id != null ? n.release_id : album.release_id,
          artist: n.artist || album.artist,
          title: n.title || album.title,
          released: n.released || album.released,
          discogs_url: n.discogs_url || album.discogs_url,
          cover: album.cover != null ? album.cover : null,
          genres: album.genres,
          // v8: a typed note (artist/person/track uid) carries its own snapshot;
          // surface it on the group so the Notebook can render + link it.
          ref: n.ref || null,
          notes: [],
          last_at: n.created_at,
        };
        shelf.set(uid, g);
        for (const genre of splitGenres(album.genres)) {
          if (!genreAlbums.has(genre)) genreAlbums.set(genre, new Set());
          genreAlbums.get(genre).add(uid);
        }
      }
      g.notes.push({
        id: n.id, body: n.body, track: n.track, timestamp: n.timestamp,
        created_at: n.created_at, updated_at: n.updated_at,
      });
      if ((n.created_at || "") > (g.last_at || "")) g.last_at = n.created_at;
    }
    const albums = Array.from(shelf.values())
      .sort((a, b) => String(b.last_at || "").localeCompare(String(a.last_at || "")));
    for (const a of albums) a.note_count = a.notes.length;
    const topGenres = Array.from(genreAlbums.entries())
      .map(([genre, set]) => ({ genre, count: set.size }))
      .sort((a, b) => (b.count - a.count) || a.genre.localeCompare(b.genre))
      .slice(0, 8);
    const c = counts(notes);
    return {
      summary: Object.assign({}, c, {
        top_genres: topGenres,
      }),
      albums,
    };
  }

  // ===========================================================================
  // The in-memory store + encrypt-on-write engine (browser)
  // ===========================================================================
  function createStore({ crypto, sync }) {
    const state = { note: new Map(), choice: new Map(), trail: new Map(), mark: new Map() };
    // client_ids of choice rows still stored on the server under the legacy "pick"
    // kind, queued by loadAll for _migrateChoiceKind to re-key.
    const _legacyChoiceIds = new Set();
    let _dek = null;
    let _cursor = null;  // server_time of the last pull, for delta syncs

    // Write-gate (P4 signed-in reveal). The app now shows Choose the moment the DEK
    // is set — BEFORE loadAll has pulled + decrypted the journal — so a choice or
    // note can arrive during that window. loadAll CLEARS state before repopulating,
    // so an un-gated early write would be wiped by that clear. Every mutation funnels
    // through _putRow/_deleteRow, which await this gate; loadAll closes it at the
    // start of its clear+repopulate and re-opens it the moment state is repopulated
    // (just BEFORE the legacy re-key migrations — which are themselves _putRow calls,
    // so the gate must already be open by then or they'd deadlock). Reads are never
    // gated: they return whatever's currently in memory.
    let _ready = false;
    let _readyWaiters = [];   // [{resolve, reject}] parked until loadAll settles
    let _loadError = null;    // last loadAll failure, so late awaiters reject too
    function _openReady() {
      _ready = true; _loadError = null;
      const w = _readyWaiters; _readyWaiters = [];
      for (const it of w) it.resolve();
    }
    function _failReady(err) {
      _loadError = err || new Error("journal load failed");
      const w = _readyWaiters; _readyWaiters = [];
      for (const it of w) it.reject(_loadError);
    }
    function _awaitReady() {
      if (_ready) return Promise.resolve();
      if (_loadError) return Promise.reject(_loadError);
      return new Promise((resolve, reject) => { _readyWaiters.push({ resolve, reject }); });
    }
    function ready() { return _ready; }
    // A promise that settles when the journal is loaded: resolves once loadAll has
    // repopulated (reads can proceed), rejects if loadAll failed (the caller shows
    // "couldn't load", not an empty journal). Journal reads await this so the P4
    // pre-loadAll window shows the normal loading state, never a false-empty shelf.
    function whenReady() { return _awaitReady(); }

    function setKey(dek) { _dek = dek; }
    function locked() { return !_dek; }
    function clear() {
      for (const k of KINDS) state[k].clear();
      _dek = null; _cursor = null; _ready = false; _loadError = null; _readyWaiters = [];
    }

    const arr = (kind) => Array.from(state[kind].values());
    const notes = () => arr("note");
    const choices = () => arr("choice");
    const trails = () => arr("trail");

    /** Pull every row and decrypt into memory. Call once after unlock. */
    async function loadAll() {
      if (!_dek) throw new Error("journal is locked");
      _ready = false; _loadError = null;   // close the gate: writes wait through the clear
      for (const k of KINDS) state[k].clear();
      let res;
      try {
        res = await sync.getRows({});
      } catch (err) {
        _failReady(err);   // release parked writes/reads with the failure (no hang)
        throw err;
      }
      _cursor = res.server_time || null;
      const rows = (res.rows || []).filter((row) => !row.deleted);
      // Decrypt rows in parallel: each AES-GCM row is independent, so awaiting
      // them one-by-one needlessly serializes the work (and the per-await
      // event-loop hops add up on a phone with a sizeable journal). A row that
      // won't decrypt (wrong key / corruption) is skipped, not fatal. Order is
      // irrelevant — results land in a keyed Map — but we preserve the server's
      // row order anyway by writing them back in sequence.
      const decrypted = await Promise.all(rows.map(async (row) => {
        try {
          const obj = await crypto.decryptRow(_dek, row.kind, row.client_id, row.ciphertext, row.nonce);
          obj._client_id = row.client_id;
          obj.id = row.client_id;            // app uses `id`; client_id is the stable id
          obj._updated_at = row.updated_at;
          return { kind: row.kind, client_id: row.client_id, obj };
        } catch (e) {
          console.warn("skipping undecryptable row", row.kind, row.client_id, e && e.message);
          return null;
        }
      }));
      _legacyChoiceIds.clear();
      for (const d of decrypted) {
        if (!d) continue;
        let { kind, client_id, obj } = d;
        if (kind === "pick") {
          // Legacy (pre-v7) choice row: fold onto the "choice" bucket + new field
          // names, and remember its id so _migrateChoiceKind re-keys its server row.
          kind = "choice";
          _renamePickFieldsInPlace(obj);
          _legacyChoiceIds.add(client_id);
        }
        if (state[kind]) state[kind].set(client_id, obj);
      }
      _openReady();                 // state is repopulated: release any queued writes
                                    // (and let the migrations below, which _putRow, run)
      await _migrateMarksToUid();   // P3 M2: re-key legacy numeric mark rows
      await _migrateChoiceKind();   // v7: re-key legacy "pick"-kind rows to "choice"
      return summary();
    }

    function summary() {
      return { notes: state.note.size, choices: state.choice.size, trails: state.trail.size, marks: state.mark.size };
    }

    // v7: the second client-side kind migration. Before v7 a recorded choice was
    // stored under kind "pick" with winner_*/loser_* fields; loadAll folds those
    // onto the "choice" bucket + chosen_*/not_chosen_* names (read-time) and queues
    // their ids here. Because the row's kind is AAD-bound (crypto.rowAAD), re-keying
    // is decrypt (already done) → _putRow under "choice" → tombstone the old "pick"
    // row. Runs once at unlock; best-effort (a failure retries next unlock). The
    // server keeps accepting "pick" (store.py KINDS) only so the tombstone lands.
    async function _migrateChoiceKind() {
      if (!_dek || !_legacyChoiceIds.size) return;
      for (const clientId of Array.from(_legacyChoiceIds)) {
        const obj = state.choice.get(clientId);
        if (!obj) { _legacyChoiceIds.delete(clientId); continue; }
        const next = Object.assign({}, obj);
        delete next._client_id; delete next.id; delete next._updated_at;
        try {
          await _putRow("choice", clientId, next);   // new choice-kind row
          await _deleteRow("pick", clientId);         // drop the legacy pick row
          _legacyChoiceIds.delete(clientId);
        } catch (e) {
          console.warn("choice kind migration deferred for", clientId, e && e.message);
        }
      }
    }

    // Rename a legacy pick object's winner_*/loser_*/picked_at fields onto the v7
    // chosen_*/not_chosen_*/chosen_at names, in place (keeps _client_id/id/_updated_at).
    function _renamePickFieldsInPlace(o) {
      const map = {
        winner_uid: "chosen_uid", winner_id: "chosen_id",
        winner_artist: "chosen_artist", winner_title: "chosen_title",
        winner_released: "chosen_released", winner_discogs_url: "chosen_discogs_url",
        winner_genres: "chosen_genres", winner_year: "chosen_year",
        loser_uid: "not_chosen_uid", loser_id: "not_chosen_id",
        loser_artist: "not_chosen_artist", loser_title: "not_chosen_title",
        picked_at: "chosen_at",
      };
      for (const [oldK, newK] of Object.entries(map)) {
        if (oldK in o) { if (!(newK in o)) o[newK] = o[oldK]; delete o[oldK]; }
      }
      return o;
    }

    // P3 M2 (the one client-side schema migration): marks used to be stored with
    // client_id = String(release_id); identity is now the uid. Notes/choices carry
    // their identity as a FIELD under a random client_id, so they need no re-key —
    // a read-time fold (albumKeyOf) handles legacy rows. Marks are the exception:
    // the client_id IS the id and the ciphertext is AAD-bound to (kind, client_id),
    // so a legacy mark must be decrypt→re-encrypt→delete-old. Runs once at unlock;
    // idempotent (a uid-keyed row has ':' in its id and is skipped). Best-effort:
    // a failure leaves the row legacy and the next unlock retries.
    async function _migrateMarksToUid() {
      if (!_dek) return;
      const legacy = [];
      for (const [clientId, obj] of state.mark) {
        if (!isUidKey(clientId)) legacy.push([clientId, obj]);
      }
      for (const [oldId, obj] of legacy) {
        const uid = albumKeyOf(obj) || ("d:" + oldId);
        if (uid === oldId) continue;
        const next = Object.assign({}, obj, { uid });
        delete next._client_id; delete next.id; delete next._updated_at;
        try {
          await _putRow("mark", uid, next);   // new uid-keyed row
          await _deleteRow("mark", oldId);    // drop the legacy numeric row
        } catch (e) {
          console.warn("mark uid migration deferred for", oldId, e && e.message);
        }
      }
    }

    async function _putRow(kind, clientId, obj) {
      if (!_dek) throw new Error("journal is locked");
      await _awaitReady();   // don't write into state that loadAll is about to clear
      const { ciphertext, nonce } = await crypto.encryptRow(_dek, kind, clientId, obj);
      await sync.postRows([{ kind, client_id: clientId, ciphertext, nonce }]);
      const stored = Object.assign({}, obj, { _client_id: clientId, id: clientId });
      state[kind].set(clientId, stored);
      return stored;
    }

    async function _deleteRow(kind, clientId) {
      await _awaitReady();   // serialize behind loadAll's clear+repopulate
      await sync.deleteRow(kind, clientId);
      // A legacy "pick"-kind tombstone (from _migrateChoiceKind) has no in-memory
      // bucket — the row lives under "choice" — so guard the state delete.
      if (state[kind]) state[kind].delete(clientId);
    }

    // --- notes ---------------------------------------------------------------
    // `uid` is the source-agnostic entity identity; release_id (from the album
    // snapshot) rides along as Discogs provenance (null for MB-only / typed). v8:
    // a typed note (artist/person/track uid) carries a `ref` — a small snapshot
    // object — so it renders on its own without a catalog row; album/free notes
    // pass ref=null and are unchanged. The row is an opaque E2EE blob, so `ref`
    // needs no store/Supabase schema change.
    async function addNote(uid, album, body, track, timestamp, ref) {
      const now = nowIso();
      const a = album || {};
      const obj = {
        uid, release_id: a.release_id != null ? a.release_id : null,
        artist: a.artist, title: a.title, released: a.released,
        discogs_url: a.discogs_url, track: track || null, timestamp: timestamp || null,
        body, ref: ref || null, created_at: now, updated_at: now,
      };
      return _putRow("note", crypto.newClientId(), obj);
    }
    async function updateNote(clientId, fields) {
      const cur = state.note.get(clientId);
      if (!cur) return false;
      const next = Object.assign({}, cur);
      if (fields.body != null) {
        const b = String(fields.body).trim();
        if (!b) throw new Error("note body cannot be empty");
        next.body = b;
      }
      if (fields.track !== undefined) next.track = (fields.track || "").trim() || null;
      if (fields.timestamp !== undefined) next.timestamp = (fields.timestamp || "").trim() || null;
      next.updated_at = nowIso();
      delete next._client_id; delete next.id; delete next._updated_at;
      return _putRow("note", clientId, next);
    }
    // Delete = tombstone, but stash the object so the undo toast can restore it
    // by re-posting under the SAME client_id (which un-tombstones the row).
    const _deletedNotes = new Map();
    async function deleteNote(clientId) {
      const cur = state.note.get(clientId);
      if (cur) {
        const snap = Object.assign({}, cur);
        delete snap._client_id; delete snap.id; delete snap._updated_at;
        _deletedNotes.set(clientId, snap);
      }
      await _deleteRow("note", clientId);
      return true;
    }
    async function restoreNote(clientId) {
      const snap = _deletedNotes.get(clientId);
      if (!snap) return false;
      await _putRow("note", clientId, snap);
      _deletedNotes.delete(clientId);
      return true;
    }
    // Match on the source-agnostic uid; a legacy note (release_id only, no uid)
    // folds onto 'd:'+release_id via albumKeyOf, so it reads with no re-encryption.
    function forAlbum(uid) {
      const list = notes().filter((n) => albumKeyOf(n) === uid)
        .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
      // N1 §4.1: mirror journal.for_album — the reasons you gave when you chose
      // this record, assembled beside your notes. Only choices that carried a
      // reason (a note or tags); newest first.
      const cs = choices()
        .filter((p) => choiceKeyOf(p) === uid && (p.note || (p.reasons || []).length))
        .sort((a, b) => String(b.chosen_at || "").localeCompare(String(a.chosen_at || "")))
        .map((p) => ({
          id: p.id, note: p.note || null,
          reasons: Array.isArray(p.reasons) ? p.reasons : [],
          not_chosen_artist: p.not_chosen_artist, not_chosen_title: p.not_chosen_title,
          chosen_at: p.chosen_at,
        }));
      return { uid, release_id: ridFromUid(uid), notes: list, choices: cs };
    }

    // N1 §4.4: the retrieval echo — your notes on records by one artist, newest
    // first. EXACT (case-insensitive) match only, mirroring journal.notes_for_artist.
    function notesForArtist(artist) {
      const a = String(artist || "").trim().toLowerCase();
      const list = !a ? [] : notes()
        .filter((n) => String(n.artist || "").trim().toLowerCase() === a)
        .sort((x, y) => String(y.created_at || "").localeCompare(String(x.created_at || "")));
      return { artist, notes: list };
    }

    // N1 §4.4 (3a): your notes that mention a credited person, tagged match_kind
    // 'full'/'partial' — mirrors journal.notes_for_person (catalog-anchored fuzzy).
    // The anchoring (keep a 'partial' only for a credited album) is the client's job
    // in app.js; here we only match. Case/punctuation/accent-insensitive, never
    // semantic.
    function personNorm(s) {
      s = String(s == null ? "" : s).replace(/\s*\(\d+\)\s*$/, "");
      s = s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
      return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    }
    function notesForPerson(name) {
      const tokens = personNorm(name).split(" ").filter((t) => t.length >= 2);
      if (!tokens.length) return { person: name, notes: [] };
      const reEsc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const fullRe = new RegExp("\\b" + tokens.map(reEsc).join("\\s+") + "\\b");
      const partRes = tokens
        .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
        .map((t) => new RegExp("\\b" + reEsc(t) + "\\b"));
      const out = [];
      const sorted = notes().slice().sort((a, b) =>
        String(b.created_at || "").localeCompare(String(a.created_at || "")));
      for (const n of sorted) {
        const body = personNorm(n.body || "");
        if (fullRe.test(body)) out.push(Object.assign({}, n, { match_kind: "full" }));
        else if (partRes.some((rx) => rx.test(body)))
          out.push(Object.assign({}, n, { match_kind: "partial" }));
      }
      return { person: name, notes: out };
    }

    // N1 §4.4 (3b): the in-note word pull — mirrors journal.note_threads /
    // notes_with_term. Recurring-only, on-demand (pull, never a standing map).
    function noteThreads(clientId, minNotes = 2) {
      const cur = state.note.get(clientId);
      if (!cur) return { threads: [] };
      const all = notes();
      const df = new Map();
      for (const n of all)
        for (const lw of noteTerms(n.body || "").keys()) df.set(lw, (df.get(lw) || 0) + 1);
      const kept = [];
      for (const [lw, surf] of noteTerms(cur.body || ""))
        if ((df.get(lw) || 0) >= minNotes) kept.push({ lw, surf, count: df.get(lw) });
      const words = {};
      kept.forEach((k) => { words[k.lw] = k.lw.split(" "); });
      const contained = (small, big) => {
        for (let i = 0; i + small.length <= big.length; i++)
          if (small.every((w, j) => big[i + j] === w)) return true;
        return false;
      };
      const out = kept
        .filter((k) => !kept.some((o) => o.lw !== k.lw
          && words[o.lw].length > words[k.lw].length && o.count >= k.count
          && contained(words[k.lw], words[o.lw])))
        .map((k) => ({ term: k.surf, count: k.count }))
        .sort((a, b) => (b.count - a.count)
          || a.term.toLowerCase().localeCompare(b.term.toLowerCase()));
      return { threads: out };
    }
    function notesWithTerm(term) {
      const key = String(term == null ? "" : term).trim().toLowerCase();
      if (!key) return { term, notes: [] };
      const out = notes().slice()
        .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
        .filter((n) => noteTerms(n.body || "").has(key));
      return { term, notes: out };
    }

    // --- choices -------------------------------------------------------------
    function _choiceSnapshot(album) {
      const a = album || {};
      return {
        uid: albumKeyOf(a), release_id: a.release_id, artist: a.artist,
        title: a.title, released: a.released, discogs_url: a.discogs_url,
        genres: a.genres, year: a.year,
      };
    }
    async function addChoice(chosen, notChosen, day_context, reasons, note) {
      const ch = _choiceSnapshot(chosen), nc = _choiceSnapshot(notChosen);
      const now = nowIso();
      const obj = {
        chosen_uid: ch.uid, chosen_id: ch.release_id, chosen_artist: ch.artist,
        chosen_title: ch.title, chosen_released: ch.released,
        chosen_discogs_url: ch.discogs_url, chosen_genres: ch.genres,
        chosen_year: ch.year,
        not_chosen_uid: nc.uid, not_chosen_id: nc.release_id,
        not_chosen_artist: nc.artist, not_chosen_title: nc.title,
        day_context: day_context || null, reasons: Array.from(reasons || []),
        note: note || null, chosen_at: now, updated_at: now,
      };
      return _putRow("choice", crypto.newClientId(), obj);
    }
    async function updateChoice(clientId, fields) {
      const cur = state.choice.get(clientId);
      if (!cur) return false;
      const next = Object.assign({}, cur);
      if (fields.chosen) Object.assign(next, {
        chosen_uid: albumKeyOf(fields.chosen),
        chosen_id: fields.chosen.release_id, chosen_artist: fields.chosen.artist,
        chosen_title: fields.chosen.title, chosen_released: fields.chosen.released,
        chosen_discogs_url: fields.chosen.discogs_url, chosen_genres: fields.chosen.genres,
        chosen_year: fields.chosen.year,
      });
      if (fields.not_chosen) Object.assign(next, {
        not_chosen_uid: albumKeyOf(fields.not_chosen),
        not_chosen_id: fields.not_chosen.release_id,
        not_chosen_artist: fields.not_chosen.artist,
        not_chosen_title: fields.not_chosen.title,
      });
      if (fields.reasons !== undefined) next.reasons = Array.from(fields.reasons || []);
      if (fields.note !== undefined) next.note = (fields.note || "").trim() || null;
      next.updated_at = nowIso();
      delete next._client_id; delete next.id; delete next._updated_at;
      return _putRow("choice", clientId, next);
    }
    const deleteChoice = (clientId) => _deleteRow("choice", clientId);
    function choicesFeed() {
      return choices().slice().sort((a, b) =>
        String(b.chosen_at || "").localeCompare(String(a.chosen_at || "")));
    }

    // --- trails --------------------------------------------------------------
    async function addTrail(name, nodes) {
      name = (name || "").trim();
      if (!name) throw new Error("a trail needs a name");
      if (!Array.isArray(nodes) || !nodes.length) throw new Error("a trail needs at least one step");
      const now = nowIso();
      return _putRow("trail", crypto.newClientId(),
        { name: name.slice(0, 200), nodes, created_at: now, updated_at: now });
    }
    async function renameTrail(clientId, name) {
      const cur = state.trail.get(clientId);
      if (!cur) return false;
      name = (name || "").trim();
      if (!name) throw new Error("a trail needs a name");
      const next = Object.assign({}, cur, { name: name.slice(0, 200), updated_at: nowIso() });
      delete next._client_id; delete next.id; delete next._updated_at;
      return _putRow("trail", clientId, next);
    }
    const deleteTrail = (clientId) => _deleteRow("trail", clientId);
    function trailsFeed() {
      return trails().slice().sort((a, b) =>
        String(b.created_at || "").localeCompare(String(a.created_at || "")));
    }

    // --- marks (one row per album, keyed by uid, holding {service: state}) ----
    // P3 M2: the row's client_id IS the uid (it used to be String(release_id)).
    // Legacy rows are re-keyed at unlock by _migrateMarksToUid, so by the time
    // these run every mark row is uid-keyed.
    const MARK_SERVICES = new Set(["spotify", "apple", "bandcamp", "youtube", "qobuz", "tidal", "soundcloud"]);
    const MARK_STATES = new Set(["here", "not_here"]);
    function getMarks(uid) {
      const row = state.mark.get(uid);
      return row ? Object.assign({}, row.marks) : {};
    }
    async function setMark(uid, album, service, st) {
      service = (service || "").trim().toLowerCase();
      if (!MARK_SERVICES.has(service)) throw new Error("unknown service: " + service);
      const cur = state.mark.get(uid);
      const marks = cur ? Object.assign({}, cur.marks) : {};
      const clearing = (st == null || st === "" || st === "unknown");
      if (!clearing && !MARK_STATES.has(st)) throw new Error("invalid state: " + st);
      if (clearing) delete marks[service]; else marks[service] = st;
      const a = album || {};
      if (Object.keys(marks).length === 0) {
        await _deleteRow("mark", uid);
        return {};
      }
      const release_id = a.release_id != null ? a.release_id
        : (cur && cur.release_id != null ? cur.release_id : ridFromUid(uid));
      await _putRow("mark", uid, {
        uid, release_id, artist: a.artist, title: a.title, marks, updated_at: nowIso(),
      });
      return Object.assign({}, marks);
    }

    // --- export the decrypted journal to a portable plaintext file (§8) ------
    // The mirror of importExport: serialize the in-memory journal to the same
    // EXPORT_VERSION-5 "journal-export" shape journal.py produces, so it round-
    // trips through importExport here AND journal.import_data on the legacy tool.
    // This is the user-facing backup/portability path — the server only holds
    // ciphertext, so the only place the journal can be exported readably is here,
    // in the browser, after unlock.
    function exportData() {
      if (!_dek) throw new Error("journal is locked");
      // Drop the engine's internal bookkeeping so the file is clean + portable.
      const strip = (o) => {
        const c = Object.assign({}, o);
        delete c._client_id; delete c._updated_at; delete c.id;
        return c;
      };
      // Marks are stored one row per album (holding {service: state}); the export
      // format is one row per (uid, service) — flatten to match journal.py v6.
      const platform_marks = [];
      for (const m of arr("mark")) {
        const marks = (m && m.marks) || {};
        for (const service of Object.keys(marks)) {
          platform_marks.push({
            uid: m.uid || albumKeyOf(m), release_id: m.release_id,
            service, state: marks[service],
            artist: m.artist, title: m.title, updated_at: m.updated_at || null,
          });
        }
      }
      return {
        app: "album-of-the-day",
        kind: "journal-export",
        version: EXPORT_VERSION,
        exported_at: nowIso(),
        notes: notes().map(strip),
        listens: [],   // the encrypted store has no legacy listens; kept for shape
        choices: choices().map(strip),
        trails: trails().map(strip),
        platform_marks,
      };
    }

    // --- one-time import of a plaintext journal export (BETA_PLAN.md §9) ------
    // Encrypt-and-upload a journal export (EXPORT_VERSION 5 from journal.py)
    // produced from the pre-Supabase local journal.db. Preserves the ORIGINAL
    // timestamps, and dedups against what's already in the store (same keys as
    // journal.import_data), so re-running is a no-op. `onProgress(result)` is
    // called after each row so a UI can show a counter.
    async function importExport(payload, onProgress) {
      if (!payload || payload.kind !== "journal-export") {
        throw new Error("not an Album-of-the-Day journal export");
      }
      const r = { notes: 0, notes_skipped: 0, choices: 0, choices_skipped: 0,
        trails: 0, trails_skipped: 0, marks: 0 };
      // Dedup on the source-agnostic uid (a ≤v5 export has no uid, so fold onto
      // 'd:'+release_id — the same keys journal.import_data uses).
      const noteKeys = new Set(notes().map((n) => `${albumKeyOf(n)}|${n.created_at}|${n.body}`));
      const choiceKeys = new Set(choices().map((p) => `${choiceKeyOf(p)}|${p.chosen_at}`));
      const trailKeys = new Set(trails().map((t) => `${t.name}|${t.created_at}`));

      for (const n of (payload.notes || [])) {
        const uid = n.uid || (n.release_id != null ? "d:" + n.release_id : null);
        if (uid == null || !n.body) { r.notes_skipped++; continue; }
        const created = n.created_at || nowIso();
        const key = `${uid}|${created}|${n.body}`;
        if (noteKeys.has(key)) { r.notes_skipped++; continue; }
        await _putRow("note", crypto.newClientId(), {
          uid, release_id: n.release_id != null ? n.release_id : null,
          artist: n.artist, title: n.title,
          released: n.released, discogs_url: n.discogs_url,
          track: n.track || null, timestamp: n.timestamp || null,
          body: n.body, ref: n.ref || null,
          created_at: created, updated_at: n.updated_at || created,
        });
        noteKeys.add(key); r.notes++; if (onProgress) onProgress(r);
      }

      // v7 exports carry `choices` (chosen_*/not_chosen_*/chosen_at); a ≤v6 export
      // carries `picks` (winner_*/loser_*/picked_at), read via the `g` fallback.
      for (const p of (payload.choices || payload.picks || [])) {
        const g = (nw, old) => (p[nw] !== undefined ? p[nw] : p[old]);
        const chId = g("chosen_id", "winner_id");
        const chUid = g("chosen_uid", "winner_uid") || (chId != null ? "d:" + chId : null);
        const at = g("chosen_at", "picked_at");
        if (chUid == null || !at) { r.choices_skipped++; continue; }
        const key = `${chUid}|${at}`;
        if (choiceKeys.has(key)) { r.choices_skipped++; continue; }
        let reasons = p.reasons;
        if (typeof reasons === "string") { try { reasons = JSON.parse(reasons); } catch (e) { reasons = []; } }
        if (!Array.isArray(reasons)) reasons = [];
        const ncId = g("not_chosen_id", "loser_id");
        const ncUid = g("not_chosen_uid", "loser_uid") || (ncId != null ? "d:" + ncId : null);
        await _putRow("choice", crypto.newClientId(), {
          chosen_uid: chUid, chosen_id: chId, chosen_artist: g("chosen_artist", "winner_artist"),
          chosen_title: g("chosen_title", "winner_title"),
          chosen_released: g("chosen_released", "winner_released"),
          chosen_discogs_url: g("chosen_discogs_url", "winner_discogs_url"),
          chosen_genres: g("chosen_genres", "winner_genres"),
          chosen_year: g("chosen_year", "winner_year"),
          not_chosen_uid: ncUid, not_chosen_id: ncId,
          not_chosen_artist: g("not_chosen_artist", "loser_artist"),
          not_chosen_title: g("not_chosen_title", "loser_title"),
          day_context: p.day_context, reasons, note: p.note || null,
          chosen_at: at, updated_at: p.updated_at || at,
        });
        choiceKeys.add(key); r.choices++; if (onProgress) onProgress(r);
      }

      for (const t of (payload.trails || [])) {
        let nodes = t.nodes;
        if (typeof nodes === "string") { try { nodes = JSON.parse(nodes); } catch (e) { nodes = null; } }
        const name = (t.name || "").trim();
        if (!name || !Array.isArray(nodes) || !nodes.length) { r.trails_skipped++; continue; }
        const created = t.created_at || nowIso();
        const key = `${name}|${created}`;
        if (trailKeys.has(key)) { r.trails_skipped++; continue; }
        await _putRow("trail", crypto.newClientId(), {
          name: name.slice(0, 200), nodes, created_at: created,
          updated_at: t.updated_at || created,
        });
        trailKeys.add(key); r.trails++; if (onProgress) onProgress(r);
      }

      // Marks: the export is one row per (uid, service); the store keeps one row
      // per album (keyed by uid) holding {service: state}. A ≤v5 export has no
      // uid, so fold onto 'd:'+release_id. Group, merge with any existing marks,
      // and upsert under the uid client_id.
      const groups = new Map();
      for (const m of (payload.platform_marks || [])) {
        const uid = m.uid || (m.release_id != null ? "d:" + m.release_id : null);
        if (uid == null || !m.service || !m.state) continue;
        if (!groups.has(uid)) {
          const ex = state.mark.get(uid);
          groups.set(uid, {
            uid, release_id: m.release_id != null ? m.release_id : ridFromUid(uid),
            artist: m.artist, title: m.title,
            marks: ex ? Object.assign({}, ex.marks) : {},
          });
        }
        groups.get(uid).marks[m.service] = m.state;
      }
      for (const [uid, g] of groups) {
        await _putRow("mark", uid, {
          uid, release_id: g.release_id, artist: g.artist, title: g.title,
          marks: g.marks, updated_at: nowIso(),
        });
        r.marks++; if (onProgress) onProgress(r);
      }
      return r;
    }

    // --- analytics bound to current state -----------------------------------
    return {
      setKey, locked, ready, whenReady, clear, loadAll, summary,
      notes, choices, trails,
      addNote, updateNote, deleteNote, restoreNote, forAlbum, notesForArtist,
      notesForPerson, noteThreads, notesWithTerm,
      addChoice, updateChoice, deleteChoice, choicesFeed,
      addTrail, renameTrail, deleteTrail, trailsFeed,
      getMarks, setMark, importExport, exportData,
      feed: (q) => feed(notes(), q),
      counts: () => counts(notes()),
      subjects: (min, lim) => subjects(notes(), min, lim),
      subjectGraph: (min, lim) => subjectGraph(notes(), min, lim),
      choicesStats: () => choicesStats(choices()),
      journalFeed: (albumsById, q) => journalFeed(notes(), albumsById, q),
    };
  }

  const mod = {
    KINDS, EXPORT_VERSION, splitGenres, nowIso,
    // uid identity helpers (mirrors app.js / journal.py)
    albumKeyOf, ridFromUid, kindFromUid, refSearchText,
    // pure analytics (for tests + reuse)
    noteTerms, subjects, subjectGraph, choicesStats, feed, counts,
    journalFeed,
    // store factory
    createStore,
  };
  return mod;
});
