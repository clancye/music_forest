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

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
