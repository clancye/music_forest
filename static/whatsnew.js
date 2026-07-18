/*
 * What's new — the changes since a reader last updated, in three tiers.
 *
 * WHY. "Shelve" became "Skip" with no notice and a beta tester asked where it had
 * gone (2026-07-17). The standing rule out of that (CLAUDE.md, BRAND.md §"Announcing
 * a change") is that a change breaking what someone already learned ships with a
 * one-time cue. This is the other half: a place you can OPEN to see everything that
 * has changed since your last update, rather than a cue firing at you.
 *
 * Pull, not push (VISION P4). It never opens itself, never badges, never counts
 * unread. You go looking; it answers and stays quiet.
 *
 * TIERS. Ordered by how much a reader actually feels the change:
 *   3  things you'll notice        — behaviour you'd meet in ordinary use
 *   2  new things you can do       — a capability that wasn't there before
 *   1  under the hood              — fixes and speed you'd never see
 * These are DELIBERATELY not the same question as the cue rule's three tiers, even
 * though they share the shape. The cue rule asks "does this need announcing?" (only
 * a rename/move/gesture does). This asks "how much will you feel it?" — so a bug fix
 * a reader would notice belongs at the top here while still needing no cue. Don't
 * conflate them: a tier-3 entry here is not automatically a cue.
 *
 * The entries are CURATED, never generated from CHANGELOG.md — that file is written
 * for whoever maintains this and is full of file paths and measurements. One plain
 * line per change, in the app's own voice (BRAND.md).
 *
 * UMD: exports for node tests AND sets window.AOTDWhatsNew in the browser.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  if (root) root.AOTDWhatsNew = mod;
})(typeof self !== "undefined" ? self : this, function () {
  // The build a reader has already caught up on. Numeric (224), not "v224", so the
  // comparison can't turn into a string sort where "v99" beats "v224".
  const SEEN_KEY = "mf-whatsnew-seen/v1";

  const TIERS = [
    { n: 3, label: "Things you'll notice" },
    { n: 2, label: "New things you can do" },
    { n: 1, label: "Under the hood" },
  ];

  // Newest first. `v` is the shell build the change shipped in (static/sw.js VERSION).
  // Keep each line to one plain sentence — this is read by someone who just wanted to
  // know why a button moved, not a release engineer.
  const ENTRIES = [
    { v: 225, tier: 2, text: "This panel — open the menu any time to see what has changed since you last updated." },
    { v: 224, tier: 1, text: "A sign-in link that can't be used now offers a way forward instead of an error." },
    { v: 223, tier: 1, text: "Keeping a record now survives a brief connection drop instead of quietly failing." },
    { v: 222, tier: 3, text: "Today holds your place when you come back from listening, instead of moving to another record." },
    { v: 221, tier: 2, text: "A record you share now shows its cover and title in the message, instead of the app icon." },
    { v: 220, tier: 3, text: "Box sets and compilations say what they are, and come up later in the day than single albums." },
    { v: 219, tier: 2, text: "Explore can find records it used to miss — close to half the catalogue was invisible to search." },
    { v: 219, tier: 1, text: "Searching is faster, especially for a short word or an artist whose name starts with “A”." },
    // `bridge: true` marks the ONE kind of entry allowed to say a retired word.
    // BRAND.md's Don't-say table bans "shelve" as the daily act, but a rename note
    // can't do its job without naming what it replaced — so the exception is named
    // in the data rather than left to a reader's judgement, and the vocabulary test
    // checks every OTHER entry strictly. The second sentence is the caveat: someone
    // who arrived after the rename never met the old word, and a note implying they
    // missed something would manufacture the confusion this exists to prevent.
    { v: 214, tier: 3, bridge: true,
      text: "The button that sets a record aside is called Skip — it was briefly called Shelve. Same thing, clearer name. If you joined recently it has always been Skip, and nothing has changed for you." },
  ];

  function buildNumber(build) {
    const m = /(\d+)/.exec(String(build == null ? "" : build));
    return m ? parseInt(m[1], 10) : 0;
  }

  function readSeen(storage) {
    try {
      const v = storage.getItem(SEEN_KEY);
      return v == null ? null : (parseInt(v, 10) || 0);
    } catch (e) { return null; }        // private mode / blocked storage
  }

  function writeSeen(storage, build) {
    try { storage.setItem(SEEN_KEY, String(buildNumber(build))); } catch (e) { /* fine */ }
  }

  /* On a first-ever run there is no "last update" to measure from, so mark the
     current build seen WITHOUT showing anything. Otherwise someone who just
     installed would open What's new and meet a list of changes to an app they have
     never used — history presented as news. After this, a delta is a real delta. */
  function primeSeen(storage, build) {
    if (readSeen(storage) == null) writeSeen(storage, build);
  }

  /* Split the entries around what this reader has already caught up on. `fresh` is
     what changed since they last updated; `earlier` is the rest, so the panel is
     never empty and "comprehensive" stays true. */
  function partition(build, seen, entries) {
    const list = entries || ENTRIES;
    const now = buildNumber(build);
    const mark = seen == null ? now : seen;
    const fresh = [], earlier = [];
    for (const e of list) {
      // An entry from a build NEWER than the one actually running hasn't shipped to
      // this reader yet (they're mid-update, or on an older shell) — hold it back
      // rather than announce something they can't find.
      if (e.v > now) continue;
      (e.v > mark ? fresh : earlier).push(e);
    }
    return { fresh, earlier };
  }

  /* Group a flat list into tier order, dropping tiers with nothing in them. */
  function byTier(list) {
    return TIERS
      .map((t) => ({ label: t.label, items: list.filter((e) => e.tier === t.n) }))
      .filter((g) => g.items.length);
  }

  // --- the panel -------------------------------------------------------------
  let _el = null;

  function close() {
    if (_el) { _el.remove(); _el = null; }
    document.removeEventListener("keydown", onKey);
  }
  function onKey(e) { if (e.key === "Escape") close(); }

  function section(title, groups, emptyText) {
    const wrap = document.createElement("div");
    wrap.className = "wn-section";
    const h = document.createElement("p");
    h.className = "wn-section-title";
    h.textContent = title;
    wrap.appendChild(h);
    if (!groups.length) {
      const p = document.createElement("p");
      p.className = "wn-empty";
      p.textContent = emptyText;
      wrap.appendChild(p);
      return wrap;
    }
    for (const g of groups) {
      const gt = document.createElement("p");
      gt.className = "wn-tier";
      gt.textContent = g.label;
      wrap.appendChild(gt);
      const ul = document.createElement("ul");
      ul.className = "wn-list";
      for (const item of g.items) {
        const li = document.createElement("li");
        li.textContent = item.text;
        ul.appendChild(li);
      }
      wrap.appendChild(ul);
    }
    return wrap;
  }

  /* Open the panel. `build` is the running shell (window.__MF_BUILD). Reading it
     marks everything up to this build as caught up — the act of looking IS the
     acknowledgement, so there's nothing to dismiss. */
  function show(opts) {
    const o = opts || {};
    const storage = o.storage || window.localStorage;
    const build = o.build || (typeof window !== "undefined" ? window.__MF_BUILD : "");
    close();
    const seen = readSeen(storage);
    const { fresh, earlier } = partition(build, seen, o.entries);

    _el = document.createElement("div");
    _el.className = "wn-backdrop";
    _el.innerHTML =
      '<div class="wn-card" role="dialog" aria-modal="true" aria-label="What&#39;s new">' +
        '<button class="wn-close" aria-label="Close">✕</button>' +
        '<p class="wn-kicker">What&#39;s new</p>' +
      '</div>';
    const card = _el.querySelector(".wn-card");
    card.appendChild(section(
      fresh.length ? "Since you last updated" : "You're up to date",
      byTier(fresh),
      "Nothing new since you last looked."));
    if (earlier.length) {
      card.appendChild(section("Earlier", byTier(earlier), ""));
    }
    _el.querySelector(".wn-close").addEventListener("click", close);
    _el.addEventListener("click", (e) => { if (e.target === _el) close(); });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(_el);
    writeSeen(storage, build);
    return { fresh: fresh.length, earlier: earlier.length };
  }

  return {
    show, close, primeSeen,
    // exposed for tests
    _partition: partition, _byTier: byTier, _buildNumber: buildNumber,
    _readSeen: readSeen, _writeSeen: writeSeen,
    ENTRIES, TIERS, SEEN_KEY,
  };
});
