"use strict";
/*
 * label-panel.js — the LABEL PANEL (T2) door, extracted verbatim from app.js as
 * the first seam of the app.js modularization (v307 → v308). A record label's
 * catalogue shown as a bounded "door" you can close to return from (VISION:
 * doors, not corridors) — mirrors the artist panel, minus the bio.
 *
 * Plain <script>, loaded AFTER app.js in index.html. `labelPanelName` is now
 * IIFE-private; the door is reached through window.AOTDLabelPanel {open, close,
 * currentName}. Every outward call (pushAndGo, closeStoryModal, closeArtistPanel,
 * closePersonPanel, browseCard, observeArt, shareBtnHtml, esc, $) stays a BARE
 * global resolved at event time — those still live in app.js, which loads first.
 */
(function () {

// --- LABEL PANEL (T2): a label's catalogue as a bounded door -----------------
// A label, like an artist, is a finite surveyable catalogue — so it gets a panel
// (a door you can close to return from) rather than taking over the grid as a
// corridor. Mirrors the artist panel, minus the bio. Exact-match server-side, so
// it only ever shows records actually on that label.
let labelPanelName = null;   // the label currently shown (guards async races)

async function openLabelPanel(name, opts = {}) {
  name = (name || "").trim();
  if (!name) return;
  if (!opts.noPush) {
    return pushAndGo(name, { t: "label", name },
      () => openLabelPanel(name, { noPush: true }));
  }
  closeStoryModal(); closeArtistPanel(); closePersonPanel();  // one door at a time
  labelPanelName = name;
  $("#labelHead").innerHTML =
    `<h3>${esc(name)}</h3><p class="muted">Loading catalog…</p>`;
  $("#labelCatalog").innerHTML = "";
  $("#labelModal").classList.remove("hidden");
  let data;
  try {
    data = await (await fetch(
      `/api/label?name=${encodeURIComponent(name)}`)).json();
  } catch (e) {
    if (labelPanelName === name) $("#labelHead").innerHTML =
      `<h3>${esc(name)}</h3><p class="muted">Couldn't load the catalog.</p>`;
    return;
  }
  if (labelPanelName !== name) return;           // a newer panel opened
  const albums = data.albums || [];
  const n = albums.length;
  const dg = data.discogs_url
    ? ` · <a href="${esc(data.discogs_url)}" target="_blank"
        rel="noopener">Discogs ↗</a>` : "";
  const more = n >= 500 ? " (latest 500)" : "";
  $("#labelHead").innerHTML =
    `<h3>${esc(name)}</h3>
     <p class="muted">${n} album${n !== 1 ? "s" : ""} on this label${more}${dg}</p>
     ${shareBtnHtml("data-share-label", "this label")}`;
  $("#labelCatalog").innerHTML = n
    ? albums.map(browseCard).join("")
    : `<div class="empty">No catalog albums on file for ${esc(name)}.</div>`;
  observeArt($("#labelCatalog"), { eager: 24 });
}

function closeLabelPanel() {
  $("#labelModal").classList.add("hidden");
  labelPanelName = null;
}

// The door's public handle (app.js modularization). `currentName` is a pure read
// accessor so snapshotView and the [data-share-label] handler can see which label
// is open without reaching into this module's private state.
window.AOTDLabelPanel = {
  open: openLabelPanel,
  close: closeLabelPanel,
  currentName: () => labelPanelName,
};

})();
