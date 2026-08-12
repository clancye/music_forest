/*
 * Headless tests for static/sync.js — the authenticated transport.
 *
 * supabase-js itself is browser-only (covered by the in-browser smoke test);
 * here we inject a MOCK fetch + token source and assert the transport contract:
 * the bearer header is attached to /api/sync/* calls, request bodies/paths are
 * shaped right, and non-2xx responses surface as errors.
 *
 * Run: node tests/js/sync.test.mjs
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const AOTDSync = require("../../static/sync.js");

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) passed++; else { failed++; console.error("  ✗ FAIL:", msg); } }
async function throws(fn, msg) {
  try { await fn(); failed++; console.error("  ✗ FAIL (expected throw):", msg); }
  catch (e) { passed++; }
}

const calls = [];
function mockFetch(ok = true, payload = {}, statusCode = 200) {
  return async (url, opts = {}) => {
    calls.push({ url, opts });
    return {
      ok, status: statusCode, statusText: ok ? "OK" : "Error",
      json: async () => payload,
    };
  };
}

async function main() {
  console.log("sync.js transport tests");

  // Bearer attached when a token is present.
  AOTDSync.configure({ fetch: mockFetch(true, { user_id: "u1", auth_enforced: true }), getToken: () => "JWT-123" });
  await AOTDSync.status();
  let last = calls[calls.length - 1];
  ok(last.url === "/api/sync/status", "status hits /api/sync/status");
  ok(last.opts.headers["Authorization"] === "Bearer JWT-123", "bearer header attached when token present");

  // No bearer header in local mode (no token).
  calls.length = 0;
  AOTDSync.configure({ getToken: () => null });
  await AOTDSync.status();
  last = calls[calls.length - 1];
  ok(!("Authorization" in last.opts.headers), "no bearer header in single-user local mode");

  // putKeys shape + content-type.
  calls.length = 0;
  AOTDSync.configure({ fetch: mockFetch(true, { ok: true }), getToken: () => "T" });
  await AOTDSync.putKeys({ v: 1, passphrase: { ct: "x" } });
  last = calls[calls.length - 1];
  ok(last.url === "/api/sync/keys" && last.opts.method === "PUT", "putKeys PUTs /api/sync/keys");
  ok(last.opts.headers["Content-Type"] === "application/json", "JSON content-type on body");
  ok(JSON.parse(last.opts.body).key_material.v === 1, "key_material wrapped in body");

  // getKeys returns null when not yet set.
  AOTDSync.configure({ fetch: mockFetch(true, { exists: false }), getToken: () => "T" });
  ok((await AOTDSync.getKeys()) === null, "getKeys -> null when exists:false");
  AOTDSync.configure({ fetch: mockFetch(true, { exists: true, key_material: { v: 1 } }), getToken: () => "T" });
  ok((await AOTDSync.getKeys()).key_material.v === 1, "getKeys -> record when exists:true");

  // getRows builds the delta query string.
  calls.length = 0;
  AOTDSync.configure({ fetch: mockFetch(true, { rows: [], count: 0, server_time: "t" }), getToken: () => "T" });
  await AOTDSync.getRows({ kind: "note", since: "2026-01-01T00:00:00Z" });
  last = calls[calls.length - 1];
  ok(last.url.includes("kind=note") && last.url.includes("since="), "getRows encodes ?kind= and ?since=");

  // postRows + deleteRow paths.
  calls.length = 0;
  await AOTDSync.postRows([{ kind: "note", client_id: "c1", ciphertext: "a", nonce: "b" }]);
  last = calls[calls.length - 1];
  ok(last.url === "/api/sync/rows" && last.opts.method === "POST", "postRows POSTs /api/sync/rows");
  ok(JSON.parse(last.opts.body).rows.length === 1, "postRows wraps rows array");
  await AOTDSync.deleteRow("pick", "c2");
  last = calls[calls.length - 1];
  ok(last.url === "/api/sync/rows/pick/c2" && last.opts.method === "DELETE", "deleteRow DELETEs the row path");

  // deleteAccount DELETEs /api/sync/account with the explicit confirm guard.
  calls.length = 0;
  AOTDSync.configure({ fetch: mockFetch(true, { ok: true, erased: { rows: 0, keys: 0 }, auth_user_deleted: false }), getToken: () => "T" });
  await AOTDSync.deleteAccount();
  last = calls[calls.length - 1];
  ok(last.url === "/api/sync/account" && last.opts.method === "DELETE", "deleteAccount DELETEs /api/sync/account");
  ok(JSON.parse(last.opts.body).confirm === "DELETE", "deleteAccount sends the {confirm:'DELETE'} guard");

  // Errors surface with status.
  AOTDSync.configure({ fetch: mockFetch(false, { error: "missing bearer token" }, 401), getToken: () => null });
  await throws(() => AOTDSync.status(), "non-2xx surfaces as an error");

  // --- B35: an expired token is fetched fresh, refreshed on 401, and replayed ---

  // The token is read at the MOMENT OF USE, not captured once. This is the whole
  // bug: a snapshot taken at boot is stale an hour later, and every write fails.
  calls.length = 0;
  let issued = "TOK-1";
  AOTDSync.configure({ fetch: mockFetch(true, { ok: true }), getToken: () => issued });
  await AOTDSync.status();
  issued = "TOK-2";                       // the session rolled over between calls
  await AOTDSync.status();
  ok(calls[0].opts.headers["Authorization"] === "Bearer TOK-1" &&
     calls[1].opts.headers["Authorization"] === "Bearer TOK-2",
     "token is read per request, not snapshotted");

  // A 401 refreshes once and replays — and the replay carries the NEW token.
  calls.length = 0;
  let refreshes = 0;
  let serverToken = "GOOD";               // what the mock server will accept
  const authedFetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    const sent = (opts.headers || {})["Authorization"];
    if (sent !== "Bearer " + serverToken) {
      return { ok: false, status: 401, statusText: "Unauthorized",
               json: async () => ({ error: "invalid token: signature has expired" }) };
    }
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ ok: true, written: 1 }) };
  };
  AOTDSync.configure({
    fetch: authedFetch,
    getToken: () => "EXPIRED",
    refresh: async () => { refreshes++; return serverToken; },
  });
  const wrote = await AOTDSync.postRows([{ kind: "note", client_id: "c1", ciphertext: "a", nonce: "b" }]);
  ok(refreshes === 1, "a 401 triggers exactly one refresh");
  ok(calls.length === 2, "the request is replayed once after the refresh");
  ok(calls[1].opts.headers["Authorization"] === "Bearer GOOD", "the replay carries the refreshed token");
  ok(wrote && wrote.ok === true, "the write succeeds after the refresh — no error reaches the caller");

  // A dead REFRESH token can't be rescued: no endless retrying, and the error is
  // tagged so the UI can say "your sign-in expired" instead of "couldn't save".
  calls.length = 0;
  refreshes = 0;
  AOTDSync.configure({
    fetch: authedFetch,
    getToken: () => "EXPIRED",
    refresh: async () => { refreshes++; return null; },   // session genuinely gone
  });
  let caught = null;
  try { await AOTDSync.postRows([{ kind: "note", client_id: "c2", ciphertext: "a", nonce: "b" }]); }
  catch (e) { caught = e; }
  ok(caught !== null, "an unrescuable 401 still throws");
  ok(caught && caught.status === 401, "the error keeps its 401 status");
  ok(caught && caught.sessionExpired === true, "the error is tagged sessionExpired");
  ok(refreshes === 1 && calls.length === 1, "no replay when the refresh fails — one attempt, not a loop");

  // Concurrent 401s share ONE refresh. Supabase rotates the refresh token on use,
  // so parallel refreshes would invalidate each other and turn a recoverable
  // expiry into a real sign-out.
  calls.length = 0;
  refreshes = 0;
  serverToken = "ROTATED";
  AOTDSync.configure({
    fetch: authedFetch,
    getToken: () => "EXPIRED",
    refresh: async () => {
      refreshes++;
      await new Promise((r) => setTimeout(r, 5));   // a real refresh is a round-trip
      return serverToken;
    },
  });
  const burst = await Promise.all([
    AOTDSync.postRows([{ kind: "note", client_id: "b1", ciphertext: "a", nonce: "b" }]),
    AOTDSync.postRows([{ kind: "note", client_id: "b2", ciphertext: "a", nonce: "b" }]),
    AOTDSync.getRows({ kind: "note" }),
  ]);
  ok(refreshes === 1, "three simultaneous 401s trigger exactly one refresh");
  ok(burst.every((r) => r && r.ok === true), "all three requests succeed on the shared refresh");

  // The single-flight slot must RELEASE. A later, unrelated expiry has to refresh
  // again — if the slot stuck, every future 401 would be answered by this run's
  // stale result and nothing would ever refresh a second time. (It stuck once:
  // a `finally` inside the async body ran before the slot was assigned whenever
  // the refresh completed without suspending, which re-stuck a resolved promise.)
  calls.length = 0;
  refreshes = 0;
  serverToken = "FIRST";
  AOTDSync.configure({
    fetch: authedFetch,
    getToken: () => "EXPIRED",
    refresh: async () => { refreshes++; return serverToken; },   // no await: settles synchronously
  });
  await AOTDSync.postRows([{ kind: "note", client_id: "s1", ciphertext: "a", nonce: "b" }]);
  ok(refreshes === 1, "first expiry refreshes");
  serverToken = "SECOND";                 // the session rolled over again, later
  const second = await AOTDSync.postRows([{ kind: "note", client_id: "s2", ciphertext: "a", nonce: "b" }]);
  ok(refreshes === 2, "a later expiry refreshes AGAIN — the single-flight slot released");
  ok(second && second.ok === true, "the later write succeeds on its own refresh");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
