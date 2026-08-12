"use strict";
/*
 * strings.js — the canonical catalog of user-facing copy (R8).
 *
 * Goal (from BACKLOG R8): stop scattering the app's voice across app.js,
 * auth-ui.js, index.html, and server.py. This is the single home for the
 * JS-generated user-facing strings, so the tone lives in one place and a future
 * translation pass is tractable. It is deliberately NOT full i18n — no locale
 * detection, no date/number localization, no RTL. Just one keyed catalog.
 *
 * Scope / convention:
 *   - JS-generated copy (empty states, loading/error text, toasts, generated
 *     button labels, the feedback help blurbs) lives HERE, read via AOTDStrings.
 *   - The onboarding/welcome/"What is this?" copy keeps its own keyed catalog in
 *     onboarding.js (shipped earlier, headlessly tested) — that file is the
 *     onboarding voice's single home; this one covers the rest of the app shell.
 *   - Static, structural copy that ships *in the HTML document* (index.html
 *     prompts, modal headings, input placeholders) stays declarative in
 *     index.html — it's already in one file, and injecting it from JS would only
 *     add a flash of empty content and selector risk. New JS copy goes here.
 *
 * Call sites read through a fallback-safe accessor (see `str()` in app.js): every
 * lookup carries the literal as a fallback, so a missing key or an unloaded
 * catalog can never blank the UI — it degrades to the original wording.
 *
 * UMD: exports for node tests AND sets window.AOTDStrings in the browser.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  if (root) root.AOTDStrings = mod;
})(typeof self !== "undefined" ? self : this, function () {
  // The catalog. Grouped by surface; values are plain strings (some carry inline
  // markup where the call site injects via innerHTML — noted per key).
  const S = {
    trail: {
      // Empty Trail map (no wander yet).
      empty: "No trail yet — your path appears here as you wander.",
      exploreCta: "Explore →",
    },
    feedback: {
      // The help blurb above the feedback box. Two truths: shared with the
      // operator when hosted, local-only in the standalone tool. Contains inline
      // <b> — injected via innerHTML at the call site.
      helpHosted:
        "A bug, an idea, a papercut — whatever you noticed. It's <b>shared with " +
        "the people who run Music Forest</b> (not end-to-end encrypted, unlike " +
        "your Notebook), along with a snapshot of what you were looking at, so it " +
        "can be turned into a fix.",
      helpLocal:
        "A bug, an idea, a papercut — whatever you noticed. It's saved <b>on your " +
        "machine only</b>, alongside a snapshot of what you were looking at, so it " +
        "can be turned into a backlog item later.",
    },
  };

  // get("a.b.c") -> string | undefined. Never throws; an unknown path returns
  // undefined so the caller's fallback takes over.
  function get(path) {
    if (!path) return undefined;
    let node = S;
    for (const key of String(path).split(".")) {
      if (node && typeof node === "object" && key in node) node = node[key];
      else return undefined;
    }
    return typeof node === "string" ? node : undefined;
  }

  return { S, get };
});
