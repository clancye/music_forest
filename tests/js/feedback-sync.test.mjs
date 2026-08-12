/*
 * Headless tests for static/feedback-sync.js — the readable feedback writer.
 *
 * supabase-js is browser/network-only, so we inject a MOCK client and assert the
 * contract: blobs land in the `feedback` bucket under `<uid>/<id>/...`, the
 * metadata row carries those paths + verbatim app_state/env, the message is
 * required + capped, and a non-PNG screenshot is dropped (no blob, null path).
 *
 * Run: node tests/js/feedback-sync.test.mjs   (Node >=18 for global Blob/atob)
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const FeedbackSync = require("../../static/feedback-sync.js");

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) passed++; else { failed++; console.error("  ✗ FAIL:", msg); } }
async function throws(fn, msg) {
  try { await fn(); failed++; console.error("  ✗ FAIL (expected throw):", msg); }
  catch (e) { passed++; }
}

// A 1x1 transparent PNG as a data URL (valid magic bytes), same as the py test.
const PNG_1x1 =
  "data:image/png;base64," +
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk" +
  "+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// Mock supabase client recording every upload + insert.
function mockSupa() {
  const uploads = [];
  const inserts = [];
  return {
    uploads, inserts,
    storage: {
      from(bucket) {
        return {
          async upload(path, blob, opts) {
            uploads.push({ bucket, path, type: blob && blob.type, opts });
            return { data: { path }, error: null };
          },
        };
      },
    },
    from(table) {
      return {
        async insert(row) {
          inserts.push({ table, row });
          return { data: [row], error: null };
        },
      };
    },
  };
}

async function main() {
  console.log("feedback-sync.js tests");

  // Full submit with screenshot + view.html.
  let supa = mockSupa();
  const res = await FeedbackSync.submit({
    supa, userId: "user-123", message: "cover art is wrong",
    app_state: { mode: "browse", date: "2026-03-10" }, env: { user_agent: "node" },
    screenshotDataURL: PNG_1x1, viewHtml: "<!doctype html><body>hi</body>",
  });

  ok(supa.uploads.length === 2, "two blobs uploaded (screenshot + view)");
  const shot = supa.uploads.find((u) => u.path.endsWith("/screenshot.png"));
  const view = supa.uploads.find((u) => u.path.endsWith("/view.html"));
  ok(shot && shot.bucket === "feedback", "screenshot goes to the feedback bucket");
  ok(shot && shot.path.startsWith("user-123/"), "blob path is scoped under the uid folder");
  ok(shot && shot.path === "user-123/" + res.id + "/screenshot.png", "screenshot path uses the entry id");
  ok(view && view.path === "user-123/" + res.id + "/view.html", "view path uses the entry id");
  ok(shot && shot.type === "image/png", "screenshot uploaded as image/png");

  ok(supa.inserts.length === 1, "one feedback row inserted");
  const row = supa.inserts[0].row;
  ok(supa.inserts[0].table === "feedback", "inserts into the feedback table");
  ok(row.user_id === "user-123", "row carries the user id");
  ok(row.message === "cover art is wrong", "row carries the message");
  ok(row.app_state.mode === "browse", "app_state passed through verbatim");
  ok(row.env.user_agent === "node", "env passed through verbatim");
  ok(row.screenshot_path === shot.path, "row links the screenshot path");
  ok(row.view_path === view.path, "row links the view path");

  // No-snapshot submit: no blobs, null paths.
  supa = mockSupa();
  await FeedbackSync.submit({ supa, userId: "u", message: "just a note" });
  ok(supa.uploads.length === 0, "no blobs when none provided");
  ok(supa.inserts[0].row.screenshot_path === null, "screenshot_path null when absent");
  ok(supa.inserts[0].row.view_path === null, "view_path null when absent");

  // A non-PNG / malformed screenshot is dropped, not fatal.
  supa = mockSupa();
  await FeedbackSync.submit({ supa, userId: "u", message: "bad shot",
    screenshotDataURL: "data:image/png;base64,not valid!!" });
  ok(supa.uploads.length === 0, "malformed screenshot dropped");
  ok(supa.inserts[0].row.screenshot_path === null, "no screenshot path for a dropped shot");

  // Empty message rejected.
  await throws(() => FeedbackSync.submit({ supa: mockSupa(), userId: "u", message: "   " }),
    "empty message rejected");
  // Missing session rejected.
  await throws(() => FeedbackSync.submit({ supa: mockSupa(), userId: "", message: "hi" }),
    "missing user id rejected");
  // Missing client rejected.
  await throws(() => FeedbackSync.submit({ supa: null, userId: "u", message: "hi" }),
    "missing supabase client rejected");

  // Message capped at MAX_MESSAGE.
  supa = mockSupa();
  const long = "x".repeat(FeedbackSync.MAX_MESSAGE + 500);
  await FeedbackSync.submit({ supa, userId: "u", message: long });
  ok(supa.inserts[0].row.message.length === FeedbackSync.MAX_MESSAGE, "message capped at MAX_MESSAGE");

  // entryId shape: <utc-stamp>-<rand>.
  ok(/^\d{4}-\d{2}-\d{2}T\d{4}Z-[0-9a-f]{4}$/.test(FeedbackSync.entryId()), "entryId is well-shaped");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
