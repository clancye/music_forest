// journal-cache.js — FB#107: a per-user IndexedDB cache of ENCRYPTED journal rows,
// so a signed-in Notebook opens instantly and reads offline.
//
// Only CIPHERTEXT is stored here. The DEK stays memory-only (journal-store.js), so
// this cache is inert without the passphrase/biometric — the same trust model
// device-trust.js already accepts for its PRF-wrapped key copy. Rows carry a
// `pending` flag: a local write/delete not yet confirmed by the server (the
// offline-write outbox). The whole thing is wiped on sign-out / Delete account.
//
// Cache unit = the ciphertext row as returned by GET /api/sync/rows:
//   { kind, client_id, ciphertext, nonce, updated_at, deleted, pending }
// kind + client_id + nonce MUST ride with the ciphertext (AES-GCM AAD binds
// "<kind>:<client_id>" — see crypto.js rowAAD).
(function () {
  "use strict";

  const DB_NAME = "aotd-journal-cache";
  const DB_VERSION = 1;
  const ROWS = "rows";   // keyPath [userId, kind, client_id]; index "byUser"
  const META = "meta";   // out-of-line key = userId -> { cursor }

  function openDB() {
    return new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); }
      catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(ROWS)) {
          const s = db.createObjectStore(ROWS, { keyPath: ["userId", "kind", "client_id"] });
          s.createIndex("byUser", "userId", { unique: false });
        }
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // One transaction over `stores`; `fn(tx, box)` issues requests and sets box._result.
  // Resolves on tx.oncomplete (all writes durable), rejects on error/abort.
  async function withTx(stores, mode, fn) {
    const db = await openDB();
    try {
      return await new Promise((resolve, reject) => {
        const t = db.transaction(stores, mode);
        const box = {};
        try { fn(t, box); } catch (e) { reject(e); return; }
        t.oncomplete = () => resolve(box._result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    } finally { db.close(); }
  }

  async function getAll(userId) {
    const uid = String(userId);
    return withTx(ROWS, "readonly", (t, box) => {
      const r = t.objectStore(ROWS).index("byUser").getAll(uid);
      r.onsuccess = () => { box._result = r.result || []; };
    });
  }

  // Upsert ciphertext rows for a user. Each row: {kind, client_id, ciphertext, nonce,
  // updated_at?, deleted?, pending?}. Requests persistent storage on write so the
  // cache isn't evicted under storage pressure (the FB#92/#104 eviction failure mode).
  async function putRows(userId, rows) {
    if (!rows || !rows.length) return;
    const uid = String(userId);
    await withTx(ROWS, "readwrite", (t) => {
      const s = t.objectStore(ROWS);
      for (const row of rows) {
        s.put({
          userId: uid,
          kind: row.kind,
          client_id: row.client_id,
          ciphertext: row.ciphertext,
          nonce: row.nonce,
          updated_at: row.updated_at != null ? row.updated_at : null,
          deleted: !!row.deleted,
          pending: !!row.pending,
        });
      }
    });
    requestPersistence();
  }

  async function removeRow(userId, kind, clientId) {
    const uid = String(userId);
    await withTx(ROWS, "readwrite", (t) => {
      t.objectStore(ROWS).delete([uid, kind, clientId]);
    });
  }

  async function getCursor(userId) {
    const uid = String(userId);
    return withTx(META, "readonly", (t, box) => {
      const r = t.objectStore(META).get(uid);
      r.onsuccess = () => { box._result = (r.result && r.result.cursor) || null; };
    });
  }

  async function setCursor(userId, cursor) {
    const uid = String(userId);
    await withTx(META, "readwrite", (t) => {
      t.objectStore(META).put({ cursor: cursor || null }, uid);
    });
  }

  // Wipe every row + the cursor for one user (sign-out / Delete account).
  async function clearUser(userId) {
    const uid = String(userId);
    await withTx([ROWS, META], "readwrite", (t) => {
      const cur = t.objectStore(ROWS).index("byUser").openCursor(IDBKeyRange.only(uid));
      cur.onsuccess = () => {
        const c = cur.result;
        if (c) { c.delete(); c.continue(); }
      };
      t.objectStore(META).delete(uid);
    });
  }

  async function requestPersistence() {
    try {
      if (!navigator.storage || !navigator.storage.persist) return false;
      if (navigator.storage.persisted && await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    } catch (e) { return false; }
  }

  // Best-effort feature probe: IndexedDB may be absent (rare) or blocked (private
  // mode / storage disabled). The store treats a missing/unavailable cache as
  // "no cache" and behaves exactly as it does today — never an error.
  async function available() {
    try {
      if (typeof indexedDB === "undefined" || !indexedDB) return false;
      const db = await openDB(); db.close(); return true;
    } catch (e) { return false; }
  }

  window.AOTDJournalCache = {
    getAll, putRows, removeRow, getCursor, setCursor, clearUser,
    requestPersistence, available,
  };
})();
