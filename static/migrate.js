"use strict";
/*
 * migrate.js — one-time import of your pre-Supabase journal (BETA_PLAN.md §9).
 *
 * Reads a plaintext journal export (produced by tools/export_local_journal.py),
 * then encrypts every note/pick/trail/mark with your key and uploads it via the
 * store. Dedups, so re-running is safe. Hosted mode only.
 *
 * The trigger lives in the account (☰) menu — see auth-ui.js — rather than as a
 * floating button (it used to overlap the feedback FAB). This module just
 * exposes window.AOTDImport.run(triggerEl); the menu calls it and passes its own
 * button so progress text can show in place.
 */
(function () {
  // Run the import. `triggerEl` (optional) is the element that launched it; if
  // given, its label reflects progress/result. Returns a promise.
  function run(triggerEl) {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/json,.json";
      input.addEventListener("change", async () => {
        const file = input.files && input.files[0];
        if (!file) { resolve(false); return; }
        let payload;
        try {
          payload = JSON.parse(await file.text());
        } catch (e) {
          alert("That file isn't valid JSON. Use the file from tools/export_local_journal.py.");
          resolve(false); return;
        }
        if (!payload || payload.kind !== "journal-export") {
          alert("That doesn't look like an Album-of-the-Day journal export.");
          resolve(false); return;
        }
        const n = (payload.notes || []).length, p = (payload.picks || []).length,
          t = (payload.trails || []).length, m = (payload.platform_marks || []).length;
        if (!confirm(`Import ${n} notes, ${p} picks, ${t} trails, and ${m} platform marks ` +
          `into your encrypted account? Already-present rows are skipped.`)) { resolve(false); return; }

        const store = window.AOTDStore;
        if (!store || store.locked()) { alert("Unlock your journal first."); resolve(false); return; }
        const orig = triggerEl ? triggerEl.textContent : null;
        const setLabel = (txt) => { if (triggerEl) triggerEl.textContent = txt; };
        if (triggerEl) triggerEl.disabled = true;
        try {
          const r = await store.importExport(payload, (res) => {
            setLabel(`Importing… ${res.notes + res.picks + res.trails + res.marks}`);
          });
          setLabel("✓ Imported — reloading…");
          alert(
            `Imported into your encrypted account:\n` +
            `• ${r.notes} notes (${r.notes_skipped} already there)\n` +
            `• ${r.picks} picks (${r.picks_skipped} already there)\n` +
            `• ${r.trails} trails (${r.trails_skipped} already there)\n` +
            `• ${r.marks} albums' platform marks\n\n` +
            `Reloading so everything shows up. You can now delete the plaintext export file.`);
          location.reload();
          resolve(true);
        } catch (e) {
          if (triggerEl) { triggerEl.disabled = false; setLabel(orig); }
          alert("Import failed: " + (e && e.message || e) +
            "\n(Your existing data is unaffected; you can try again.)");
          console.error("journal import failed", e);
          resolve(false);
        }
      });
      input.click();
    });
  }

  window.AOTDImport = { run };
})();
