/*
 * Readable feedback -> Supabase (H1.4).
 *
 * "Send feedback" is the ONE thing a user consensually shares so the operator
 * can triage bugs, so unlike the journal it is NOT end-to-end encrypted
 * (BETA_PLAN.md §1). In the hosted app the browser writes it straight to
 * Supabase over its existing session:
 *
 *   1. screenshot.png + view.html -> the private `feedback` Storage bucket at
 *      `<uid>/<entry-id>/...` (RLS: a user may only write under their own uid
 *      folder; 0001 migration).
 *   2. a metadata row -> the readable `public.feedback` table, carrying the two
 *      object paths (RLS: insert own; 0001 migration).
 *
 * The big blobs (an 8 MB PNG, a few MB of serialized DOM) go browser -> Storage
 * directly, never through Flask. The operator reads everything back via the
 * admin allow-list policy (0002 migration) — see static/admin.html.
 *
 * Local single-user mode (no Supabase) does NOT use this module; app.js falls
 * back to POSTing /api/feedback, which writes the on-disk store (feedback.py).
 *
 * Loaded as a plain <script> (no build step); attaches window.FeedbackSync and
 * also exports for Node so the headless test can check the payload shaping.
 */
(function (root, factory) {
  const mod = factory();
  root.FeedbackSync = mod;
  if (typeof module !== "undefined" && module.exports) module.exports = mod; // Node tests
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const BUCKET = "feedback";
  const MAX_MESSAGE = 8000;           // mirror feedback.py's cap

  // An entry id shaped like feedback.py's: "<utc-stamp>-<rand>", so the on-disk
  // store and the Supabase store read the same way.
  function entryId(now) {
    now = now || new Date();
    const p = (n) => String(n).padStart(2, "0");
    const stamp =
      now.getUTCFullYear() + "-" + p(now.getUTCMonth() + 1) + "-" +
      p(now.getUTCDate()) + "T" + p(now.getUTCHours()) + p(now.getUTCMinutes()) + "Z";
    const rand = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
    return stamp + "-" + rand;
  }

  // Decode a `data:<mime>;base64,<...>` URL to a Blob, or null if it isn't one.
  // Used for the screenshot the UI captured as a PNG data URL.
  function dataUrlToBlob(dataUrl) {
    if (typeof dataUrl !== "string") return null;
    const m = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
    if (!m) return null;
    const mime = m[1];
    let bin;
    try { bin = atob(m[2].replace(/\s+/g, "")); } catch (e) { return null; }
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  /**
   * Upload any blobs, then insert the feedback row. Returns {id, screenshot_path,
   * view_path}. Throws on any failure (the caller shows the message).
   *
   * @param {object}  o
   * @param {object}  o.supa               supabase-js client (AOTDSync.getSupabase())
   * @param {string}  o.userId             the signed-in user's uuid
   * @param {string}  o.message            the note (required, capped)
   * @param {object}  [o.app_state]        UI snapshot, stored verbatim
   * @param {object}  [o.env]              browser env, stored verbatim
   * @param {string}  [o.screenshotDataURL] PNG data URL, optional
   * @param {string}  [o.viewHtml]         serialized-DOM snapshot, optional
   */
  async function submit(o) {
    o = o || {};
    const supa = o.supa;
    const userId = o.userId;
    if (!supa) throw new Error("not connected to Supabase");
    if (!userId) throw new Error("please sign in first");
    let message = (o.message || "").trim();
    if (!message) throw new Error("feedback message is required");
    message = message.slice(0, MAX_MESSAGE);

    const id = entryId();
    const base = userId + "/" + id;
    let screenshot_path = null;
    let view_path = null;

    const png = dataUrlToBlob(o.screenshotDataURL);
    if (png) {
      const path = base + "/screenshot.png";
      const { error } = await supa.storage.from(BUCKET).upload(path, png, {
        contentType: "image/png", upsert: false,
      });
      if (error) throw new Error("screenshot upload failed: " + (error.message || error));
      screenshot_path = path;
    }

    if (typeof o.viewHtml === "string" && o.viewHtml.length) {
      const path = base + "/view.html";
      const blob = new Blob([o.viewHtml], { type: "text/html" });
      const { error } = await supa.storage.from(BUCKET).upload(path, blob, {
        contentType: "text/html; charset=utf-8", upsert: false,
      });
      if (error) throw new Error("view snapshot upload failed: " + (error.message || error));
      view_path = path;
    }

    const row = {
      user_id: userId,
      message: message,
      app_state: (o.app_state && typeof o.app_state === "object") ? o.app_state : {},
      env: (o.env && typeof o.env === "object") ? o.env : {},
      screenshot_path: screenshot_path,
      view_path: view_path,
    };
    const { error } = await supa.from("feedback").insert(row);
    if (error) throw new Error("saving feedback failed: " + (error.message || error));

    return { id, screenshot_path, view_path };
  }

  return { submit, entryId, dataUrlToBlob, BUCKET, MAX_MESSAGE };
});
