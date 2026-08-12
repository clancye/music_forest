/*
 * Headless tests for auth-ui.js's classifyAuthError (the invite-gate vs
 * expired-link split).
 *
 * WHY THIS EXISTS. A failed magic-link/OAuth return used to render "You're not
 * invited yet" for EVERY error in the URL. An invited beta tester whose one-time
 * link had expired was therefore told they weren't invited, and routed to
 * request-access — a dead end, on a screen the operator never sees (2026-07-16).
 * The fix classifies the error; this pins the classification.
 *
 * The real risk it guards is a CROSS-FILE COUPLING: the client recognises the
 * gate's rejection by its WORDING, but that wording is authored in
 * supabase/migrations/0004_phase_d_invite_gate.sql. Reword the hook and the client
 * silently regresses to blaming the invite list. So this test reads the hook's
 * messages OUT OF THE SQL and asserts the live client classifies them — no
 * hand-copied fixture, which would just re-encode the bug.
 *
 * auth-ui.js is a browser IIFE that boots itself on load (document listeners), so
 * it can't be require()d like onboarding.js. We extract the pure function's source
 * and evaluate it. If someone reformats it past the matcher this test fails loudly
 * rather than silently passing on nothing — checked below.
 *
 * Run: node tests/js/auth-error-classify.test.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let passed = 0, failed = 0;
function ok(c, m) { if (c) passed++; else { failed++; console.error("  ✗ FAIL:", m); } }

function authSrc() {
  return fs.readFileSync(path.join(ROOT, "static/auth-ui.js"), "utf8");
}

function lift(re, what) {
  const m = authSrc().match(re);
  if (!m) throw new Error(
    `could not extract ${what} from static/auth-ui.js — if it was renamed or ` +
    "reformatted, update this test rather than deleting it");
  return m[0];
}

function loadClassifier() {
  const stem = lift(/function isInviteRejection\(text\)\s*\{[\s\S]*?\n  \}/,
                    "isInviteRejection");
  const fn = lift(/function classifyAuthError\(e\)\s*\{[\s\S]*?\n  \}/,
                  "classifyAuthError");
  return new Function(`${stem}\n${fn}\nreturn classifyAuthError;`)();
}

// The SEND path (sendLinkFlow) decides the same thing separately: does this error
// mean "not invited" — and so route to the Request-access screen — or is it a
// genuine error to show inline? It used to test its own regex, which missed BOTH of
// the hook's real messages, so every gate refusal rendered as a raw string with no
// way forward. This lifts the live condition out of sendLinkFlow and runs it, so the
// two paths are pinned to the same evidence.
function loadSendPathTest() {
  const stem = lift(/function isInviteRejection\(text\)\s*\{[\s\S]*?\n  \}/,
                    "isInviteRejection");
  // Anchored on `otp_disabled` only, not on the rest of the condition: a regression
  // that swaps the invite test back out should then RUN and fail on the messages
  // below, naming them — rather than throwing here about an unmatched pattern.
  const cond = lift(/if \(code === "otp_disabled"[\s\S]*?\) \{/,
                    "sendLinkFlow's rejection branch");
  const body = cond.replace(/^if \(/, "return (").replace(/\) \{$/, ");");
  return new Function(
    `${stem}\nreturn function (code, msg) { ${body} };`)();
}

// The hook's rejection messages, read from the migration that authors them.
function hookMessages() {
  const sql = fs.readFileSync(
    path.join(ROOT, "supabase/migrations/0004_phase_d_invite_gate.sql"), "utf8");
  const out = [];
  const re = /'message',\s*'((?:[^']|'')*)'/g;
  let m;
  while ((m = re.exec(sql)) !== null) out.push(m[1].replace(/''/g, "'"));
  return out;
}

function main() {
  console.log("auth error classification tests");
  const classify = loadClassifier();

  // 1. The invite gate's OWN messages must read as not-invited — sourced from the SQL.
  const msgs = hookMessages();
  ok(msgs.length >= 2, `found the hook's messages in 0004 (got ${msgs.length})`);
  for (const msg of msgs) {
    ok(classify({ code: "", description: msg }) === "not-invited",
       `hook message classifies as not-invited: ${JSON.stringify(msg.slice(0, 48))}…`);
  }

  // 2. Supabase's expired one-time link — the 2026-07-16 case. This is the whole
  //    point: it must NOT be "not-invited".
  const expired = { code: "otp_expired",
                    description: "Email link is invalid or has expired" };
  ok(classify(expired) === "link-expired", "otp_expired -> link-expired");
  ok(classify(expired) !== "not-invited", "an expired link never accuses (the bug)");
  ok(classify({ code: "", description: "Email link is invalid or has expired" })
       === "link-expired", "expiry wording alone -> link-expired (no code)");
  ok(classify({ code: "OTP_EXPIRED", description: "" }) === "link-expired",
     "code match is case-insensitive");

  // 3. Anything unrecognised falls through to the neutral screen — never an
  //    accusation, never a silent drop to guest.
  ok(classify({ code: "server_error", description: "upstream exploded" }) === "unknown",
     "unrecognised error -> unknown");
  ok(classify({ code: "", description: "" }) === "unknown", "empty error -> unknown");
  ok(classify(null) === "unknown", "null error -> unknown (no throw)");
  ok(classify(undefined) === "unknown", "undefined error -> unknown (no throw)");

  // 4. The two vocabularies must not overlap: Supabase says "invalid"/"expired",
  //    the hook says "invite". "invalid" must not be mistaken for "invite".
  ok(classify({ code: "", description: "invalid" }) === "link-expired",
     "'invalid' is not read as 'invite'");

  // 5. THE SEND PATH decides the same thing, and used to decide it differently.
  //    sendLinkFlow's own regex tested for "not invited"; the hook actually says
  //    "isn't invited", so it matched NEITHER message and every refusal fell through
  //    to the raw provider string with no Request-access button (2026-07-18).
  const rejects = loadSendPathTest();
  for (const msg of msgs) {
    ok(rejects("", msg) === true,
       `send path routes the hook's message to Request access: ${JSON.stringify(msg.slice(0, 40))}…`);
  }
  ok(rejects("otp_disabled", "") === true, "otp_disabled still routes there");
  ok(rejects("", "Signups not allowed for otp") === true,
     "the legacy shouldCreateUser wording still routes there");

  //    ...and must NOT swallow errors that are the reader's problem to see.
  ok(rejects("", "Email link is invalid or has expired") === false,
     "an expired link is not an invite refusal (the 2026-07-16 bug, on this path)");
  ok(rejects("", "Failed to fetch") === false, "a network error stays inline");
  ok(rejects("", "Email rate limit exceeded") === false, "a rate limit stays inline");
  ok(rejects("", "") === false, "an empty message is not a refusal");

  //    Both paths must agree on every hook message — that agreement IS the fix.
  for (const msg of msgs) {
    ok((classify({ code: "", description: msg }) === "not-invited") === rejects("", msg),
       `both paths agree on: ${JSON.stringify(msg.slice(0, 40))}…`);
  }

  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main();
