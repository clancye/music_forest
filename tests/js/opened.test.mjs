/*
 * Opened (v9, owner 2026-10-03): a Listen tap leaves an "opened" Notebook entry.
 * Keep was retired the same day. This pins the two client-side homes of an open:
 *
 *   1. the ENCRYPTED store (journal-store.js) — one per record per local day, a
 *      double tap shares one write, rows survive an encrypt -> reload -> decrypt,
 *      delete and export/import round-trip, and the row id is random (a derived one
 *      would tell the server which record you opened, since ids are stored in the clear);
 *   2. the GUEST buffer (guest-buffer.js) — same one-per-day rule, kept outside the
 *      note cap, and carried into an account by buildGuestExport.
 *
 * Uses the real crypto.js with the scrypt KDF substitute, like store.test.mjs.
 *
 * Run: node tests/js/opened.test.mjs
 */
import { createRequire } from "module";
import { scryptSync } from "crypto";
const require = createRequire(import.meta.url);
const C = require("../../static/crypto.js");
const J = require("../../static/journal-store.js");
const G = require("../../static/guest-buffer.js");

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
      return { ok: true, deleted: true };
    },
    _rows: rows,
  };
}

const DAY = "2026-10-03";

async function storeTests() {
  console.log("opened: encrypted store");
  ok(J.KINDS.includes("opened"), "opened is a store kind");
  ok(J.EXPORT_VERSION === 9, "export version is 9");
  const sync = fakeSync();
  const { dek } = await C.createIdentity("unlock me", C.generateRecoveryCode());
  const s = J.createStore({ crypto: C, sync });
  s.setKey(dek);
  await s.loadAll();

  const a = await s.addOpened({ uid: "d:100", service: "Spotify", day: DAY, artist: "Alpha", title: "First" });
  ok(a && a.service === "spotify" && a.day === DAY, "records the tap, service normalised");
  ok(!a.id.includes("d:100") && !a.id.includes(DAY), "the row id reveals neither the record nor the day");
  const again = await s.addOpened({ uid: "d:100", service: "apple", day: DAY });
  ok(again.id === a.id && s.openedFeed().length === 1, "a second tap that day (any service) adds nothing");

  // Double tap: both calls start before either row reaches state.
  const [x, y] = await Promise.all([
    s.addOpened({ uid: "m:abc", service: "deezer", day: DAY }),
    s.addOpened({ uid: "m:abc", service: "deezer", day: DAY }),
  ]);
  ok(x.id === y.id && s.openedFeed().filter((o) => o.uid === "m:abc").length === 1,
     "a double tap shares one write");

  ok(await s.addOpened({ uid: "d:100", service: "napster", day: DAY }) === null, "unknown service refused");
  ok(await s.addOpened({ uid: "d:100", service: "spotify", day: "10/03" }) === null, "malformed day refused");
  ok(await s.addOpened({ service: "spotify", day: DAY }) === null, "no record refused");
  ok(s.summary().opened === 2, "summary counts opened rows");

  const onWire = [...sync._rows.values()].filter((r) => r.kind === "opened");
  ok(onWire.length === 2 && onWire.every((r) => typeof r.ciphertext === "string" && !r.ciphertext.includes("Alpha")),
     "opened rows go to the server encrypted");

  // Reload from the server: decrypts back.
  const s2 = J.createStore({ crypto: C, sync });
  s2.setKey(dek);
  await s2.loadAll();
  ok(s2.openedFeed().length === 2 && s2.openedFeed().some((o) => o.artist === "Alpha"),
     "opened rows survive encrypt -> reload -> decrypt");

  // Export / import into a fresh store.
  const dump = s2.exportData();
  ok(Array.isArray(dump.opened) && dump.opened.length === 2, "export carries opened");
  const s3 = J.createStore({ crypto: C, sync: fakeSync() });
  s3.setKey(dek);
  await s3.loadAll();
  const r = await s3.importExport(dump);
  ok(r.opened === 2 && s3.openedFeed().length === 2, "import restores opened");
  const r2 = await s3.importExport(dump);
  ok(r2.opened === 0 && r2.opened_skipped === 2, "re-import is a no-op");

  await s2.deleteOpened(a.id);
  ok(s2.openedFeed().length === 1, "delete removes one");
}

function guestTests() {
  console.log("opened: guest buffer");
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const buf = G.create({ storage });
  const e = buf.recordOpened({ uid: "d:100", service: "spotify", day: DAY, artist: "Alpha" });
  ok(e && e.uid === "d:100", "records a tap");
  ok(buf.recordOpened({ uid: "d:100", service: "apple", day: DAY }).client_id === e.client_id,
     "one per record per day");
  ok(buf.recordOpened({ uid: "d:100", service: "bogus", day: DAY }) === null, "unknown service refused");
  ok(buf.openedAll().length === 1, "one row stored");
  ok(buf.notesCount() === 0, "an open never counts toward the note cap");

  const payload = G.buildGuestExport([], [], {}, buf.openedAll());
  ok(payload.opened && payload.opened.length === 1 && payload.opened[0].service === "spotify",
     "buildGuestExport carries opens into the account");
  ok(!("opened" in G.buildGuestExport([], [], {}, [])), "no opens → no opened key (pre-v9 payload shape)");

  ok(buf.removeOpened(e.client_id) === true && buf.openedAll().length === 0, "remove");
}

(async () => {
  await storeTests();
  guestTests();
  console.log(`opened: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
