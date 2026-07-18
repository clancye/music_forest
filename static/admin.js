/*
 * Operator feedback view (H1.4) — static/admin.html.
 *
 * A no-build, operator-only page. You log in with the same magic link as the
 * app; the 0002 migration's admin allow-list lets your session read ALL feedback
 * rows + blobs (everyone else, including ordinary users, can read only their own
 * — RLS does the gating, so this page holds no secret). Screenshots are fetched
 * from the private Storage bucket and shown as object URLs; view.html is offered
 * as a download (NOT rendered inline — it's another user's DOM, so executing it
 * here would be an XSS foot-gun against you).
 *
 * Triage layer (added): mark each report keep/skip and jot a note (saved in this
 * browser's localStorage only — never uploaded, so it stays your private working
 * state), filter by status, and Export the kept ones to `feedback-brief.md`: a
 * Claude-ready brief where each entry is a Problem/Context/Screenshot/Likely-area
 * scaffold. Paste that into a session to go straight to solutions. The export is
 * built entirely client-side; nothing here weakens the read path or RLS gating.
 *
 * This file is intentionally separate from the main app bundle: it's not in the
 * PWA shell and isn't loaded by ordinary users.
 */
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const BUCKET = "feedback";
  let supa = null;
  const objectUrls = [];          // revoke on teardown
  const blobCache = new Map();    // path -> object URL, so redraws don't re-download

  let currentRows = [];           // last loaded feedback rows (for filter/export)
  let emailByUid = {};            // submitter user_id -> email (admin-gated RPC)

  // --- Triage state: local-only, never uploaded. Keyed by feedback row id. ---
  const STORE_KEY = "mf-feedback-triage/v1";
  let triage = loadTriage();
  function loadTriage() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveTriage() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(triage)); } catch (e) {}
  }
  const tKey = (row) => String(row.id);
  const tOf = (row) => triage[tKey(row)] || {};

  // "Cleared" done items: a SEPARATE store from `triage`, deliberately — it survives
  // "Reset triage" (which only clears keep/skip/notes/done), so the owner can forget a
  // handled pile for good without the reset resurrecting it. Keyed by row id → 1.
  const DISMISS_KEY = "mf-feedback-dismissed/v1";
  let dismissed = loadDismissed();
  function loadDismissed() {
    try { return JSON.parse(localStorage.getItem(DISMISS_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveDismissed() {
    try { localStorage.setItem(DISMISS_KEY, JSON.stringify(dismissed)); } catch (e) {}
  }

  // --- Curated codebase pointers (mirrors tools/feedback_review.py). First
  // keyword found wins, so more specific terms go first. Best-effort: gives the
  // next session a starting file, not an authoritative answer. ---
  const POINTER_MAP = [
    [["cover art", "album art", "artwork", "cover", "image", "thumbnail"],
      "fetch_art.py", "cover-art / Apple Music fetch + cache"],
    [["login", "log in", "sign up", "signup", "sign in", "password", "account",
      "session", "token", "auth"],
      "auth.py", "request identity / hosted sync auth"],
    [["encrypt", "decrypt", "unlock", "passphrase", "cipher", "e2e", "end-to-end", "key"],
      "store.py", "hosted sync storage / client-crypto boundary"],
    [["journal", "note", "pick", "shelf", "trail", "listen", "diary"],
      "journal.py", "listening journal + notes"],
    [["genre", "tag"], "genres.py", "genre parsing"],
    [["bio", "artist info", "biography"], "bio.py", "cached artist bios"],
    [["search", "browse", "filter", "query", "sort", "decade", "calendar"],
      "server.py", "browse/search routes + view state"],
    [["feedback"], "feedback.py", "the feedback store itself"],
    [["slow", "timeout", "fetch", "network", "download", "ssrf", "url"],
      "safefetch.py", "outbound fetch guard"],
    [["database", "sqlite", "discogs", "dump"], "build_db.py", "offline album DB build"],
  ];
  function guessPointer(message) {
    const low = (message || "").toLowerCase();
    for (const [kws, file, why] of POINTER_MAP) {
      for (const k of kws) if (low.includes(k)) return { file, why };
    }
    return null;
  }

  function stateSummary(s) {
    if (!s || typeof s !== "object") return "";
    const b = [];
    if (s.mode) b.push("mode=" + s.mode);
    if (s.date) b.push("date=" + s.date);
    if (s.browse && s.browse.query) b.push('query="' + s.browse.query + '"');
    if (s.browse && s.browse.field) b.push("field=" + s.browse.field);
    if (s.open_modal) b.push("modal=" + s.open_modal);
    return b.join(" · ");
  }
  function envSummary(e) {
    if (!e || typeof e !== "object") return "";
    const b = [];
    if (e.url) b.push(e.url);
    if (e.viewport) b.push(e.viewport.w + "×" + e.viewport.h);
    if (e.platform) b.push(e.platform);
    return b.join(" · ");
  }

  function setStatus(t) { $("#status").textContent = t || ""; }
  function showToolbar(show) { $("#toolbar").classList.toggle("hidden", !show); }

  // --- Tabbed navigation + at-a-glance summary --------------------------------
  //   Each loader reports a {label, value, state} into healthState. renderHealth
  //   paints two things: a coloured dot on each tab, and — on the Summary tab — a
  //   status tile per working area
  //   that doubles as a door into that tab. The attention data has no tab of its
  //   own (Option A: Summary *is* the attention view), so it tints the Summary tab
  //   and its chips/watch-list render in the Summary body. Heading to a tab expands
  //   nothing; the active tab lives in the URL hash so refresh/back return you.
  const healthState = {};
  const TABS = ["summary", "feedback", "requests", "backlog", "pool", "crawler", "cost", "usage"];
  // Working areas that get a Summary tile, in reading order. `pool` earns one: its
  // whole reason for existing is that a service quietly reading 12/day went unseen
  // for weeks, so it has to be visible without opening a tab.
  const TILE_ORDER = ["feedback", "requests", "pool", "crawler", "cost"];
  // health key -> the tab whose dot it colours. "attention" (system-health worst)
  // tints the Summary tab; "backlog" tints the Backlog tab. Neither is a tile.
  const DOT_TAB = { feedback: "feedback", requests: "requests", crawler: "crawler",
    cost: "cost", attention: "summary", backlog: "backlog", pool: "pool" };
  function setHealth(key, entry) { healthState[key] = entry; renderHealth(); }
  function clearHealth() {
    for (const k of Object.keys(healthState)) delete healthState[k];
    renderHealth();
  }
  function renderHealth() {
    // Tab dots — one per health key that maps to a tab.
    for (const key of Object.keys(DOT_TAB)) {
      const dot = document.querySelector('.tabdot[data-dotfor="' + DOT_TAB[key] + '"]');
      if (!dot) continue;
      const h = healthState[key];
      dot.className = "tabdot" + (h && h.state ? " " + h.state : "");
    }
    // Summary tiles — a status glance that is also a door into each tab.
    const wrap = $("#summaryTiles");
    if (!wrap) return;
    const keys = TILE_ORDER.filter((k) => healthState[k]);
    wrap.replaceChildren(...keys.map((k) => {
      const h = healthState[k];
      const b = document.createElement("button");
      b.className = "tile";
      b.dataset.goto = k;
      const tk = document.createElement("span"); tk.className = "tk"; tk.textContent = h.label;
      const tv = document.createElement("span"); tv.className = "tv";
      const dot = document.createElement("span"); dot.className = "dot " + (h.state || "");
      const val = document.createElement("span"); val.textContent = h.value;
      tv.append(dot, val);
      b.append(tk, tv);
      return b;
    }));
  }
  // Switch tabs. A tab is a door: we record it in the hash (so refresh + a shared
  // link land on the same place) but never expand anything or scroll the page.
  function showTab(name) {
    if (TABS.indexOf(name) < 0) name = "summary";
    for (const btn of document.querySelectorAll(".tabs [data-tab]"))
      btn.classList.toggle("active", btn.dataset.tab === name);
    for (const p of document.querySelectorAll(".panel"))
      p.hidden = p.dataset.panel !== name;
    try { history.replaceState(null, "", "#" + name); } catch (e) {}
  }
  function currentTab() {
    const h = (location.hash || "").replace(/^#/, "");
    return TABS.indexOf(h) >= 0 ? h : "summary";
  }
  function wireTabs() {
    $(".tabs").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-tab]");
      if (btn) showTab(btn.dataset.tab);
    });
    // Summary tiles are doors into their tab.
    $("#summaryTiles").addEventListener("click", (e) => {
      const tile = e.target.closest("[data-goto]");
      if (tile) showTab(tile.dataset.goto);
    });
  }

  async function boot() {
    let cfg;
    try {
      cfg = await fetch("/api/public-config").then((r) => r.json());
    } catch (e) {
      setStatus("Couldn't load config: " + e.message);
      return;
    }
    if (!cfg || !cfg.configured) {
      setStatus("This build isn't connected to Supabase, so there's no shared " +
        "feedback store. (Local feedback lives on disk under data/feedback/.)");
      return;
    }
    if (typeof supabase === "undefined" || !supabase.createClient) {
      setStatus("supabase-js failed to load (check the CDN <script> + SRI).");
      return;
    }
    let url = String(cfg.supabase_url || "").trim().replace(/^["']|["']$/g, "");
    if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;
    supa = supabase.createClient(url, String(cfg.anon_key || "").trim(), {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });

    // Wait for gotrue to settle (incl. parsing a just-arrived magic-link hash).
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      supa.auth.onAuthStateChange(() => finish());
      setTimeout(finish, 5000);
    });
    // Clean the return URL after gotrue has consumed it: the magic link lands auth
    // params in the hash (#access_token=…), Google OAuth (PKCE) lands ?code=… in the
    // query. By here the session is already established, so strip either.
    const hashAuth = location.hash && /access_token|error/.test(location.hash);
    const codeAuth = location.search && /[?&](code|error)=/.test(location.search);
    if (hashAuth || codeAuth) {
      try { history.replaceState(null, "", location.pathname); } catch (e) {}
    }

    await render();
  }

  async function render() {
    const { data: sess } = await supa.auth.getSession();
    const session = sess ? sess.session : null;
    if (!session) {
      $("#login").classList.remove("hidden");
      $("#signout").classList.add("hidden");
      $("#console").classList.add("hidden");
      showToolbar(false);
      setStatus("");
      currentRows = [];
      $("#list").innerHTML = "";
      if (crawlTimer) { clearInterval(crawlTimer); crawlTimer = null; }
      clearTimeout(attnPollTimer);
      $("#fbHead").classList.add("hidden");
      clearHealth();
      return;
    }
    $("#login").classList.add("hidden");
    $("#signout").classList.remove("hidden");
    $("#console").classList.remove("hidden");
    // Open on Summary (or whatever tab a refresh/shared link points at).
    showTab(currentTab());

    // Attention panel + crawler health + access requests load independently of
    // feedback — an operator may have one and not the others. The attention
    // panel is deliberately NOT awaited: on the host its first answer can wait
    // on a slow pool read, and it must never dam the rest of the console
    // (live /admin sat wholly on "Loading…" behind it, 2026-07-03).
    loadAttention();
    loadCost();
    loadUsage();      // anonymized usage panel (independent; never dams the console)
    // Not awaited, same reasoning as loadAttention: it's two pool reads (~230ms
    // locally, slower on the host) and must never dam the console behind it.
    loadPool();
    await loadCrawlStatus();
    // Auto-refresh the crawler panel so a running day updates without clicking.
    if (crawlTimer) clearInterval(crawlTimer);
    crawlTimer = setInterval(loadCrawlStatus, 20000);
    await loadAccessRequests();

    $("#fbHead").classList.remove("hidden");
    setStatus("Loading feedback…");

    const { data: rows, error } = await supa
      .from("feedback")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) {
      setStatus("Couldn't load feedback: " + (error.message || error));
      return;
    }
    if (!rows || !rows.length) {
      showToolbar(false);
      setStatus("No feedback yet — or this account isn't on the operator " +
        "allow-list (app_admins). Signed in as " + (session.user && session.user.email) + ".");
      currentRows = [];
      $("#list").innerHTML = "";
      setHealth("feedback", { label: "Feedback", value: "none yet", state: "ok" });
      return;
    }
    currentRows = rows;
    // Resolve submitter emails so each card shows who's who. Admin-gated RPC
    // (0007) reads auth.users; best-effort — if it's not applied yet or errors,
    // the cards just fall back to the user_id.
    try {
      const { data: em } = await supa.rpc("admin_feedback_emails");
      emailByUid = Object.fromEntries((em || []).map((e) => [e.user_id, e.email]));
    } catch (e) { emailByUid = {}; }
    setStatus(rows.length + " submission" + (rows.length === 1 ? "" : "s") +
      " · signed in as " + (session.user && session.user.email));
    showToolbar(true);
    await applyAndDraw();
  }

  // Rows that pass the current status filter. "Done" items are archived: they drop
  // out of every view except the explicit "Done" filter (where you can restore
  // them). Archiving is local-only and reversible — the row still lives in Supabase
  // and auto-prunes at the 180-day retention window.
  function visibleRows() {
    const f = $("#filter").value;
    return currentRows.filter((r) => {
      if (dismissed[tKey(r)]) return false;   // cleared for good — never in any view
      const t = tOf(r);
      if (f === "done") return !!t.done;
      if (t.done) return false;
      const st = t.status || "none";
      if (f === "keep") return st === "keep";
      if (f === "skip") return st === "skip";
      if (f === "untriaged") return st === "none";
      return true; // "all" (active, un-archived)
    });
  }

  async function applyAndDraw() {
    await draw(visibleRows());
    updateCounts();
  }

  function updateCounts() {
    let keep = 0, skip = 0, done = 0, active = 0;
    for (const r of currentRows) {
      if (dismissed[tKey(r)]) continue;   // cleared for good — out of every tally
      const t = tOf(r);
      if (t.done) { done++; continue; }   // archived: out of the working tally
      active++;
      if (t.status === "keep") keep++;
      else if (t.status === "skip") skip++;
    }
    const un = active - keep - skip;
    $("#counts").innerHTML =
      "<b>" + keep + "</b> kept · <b>" + skip + "</b> skipped · <b>" + un +
      "</b> untriaged" + (done ? " · <b>" + done + "</b> done" : "");
    setHealth("feedback", {
      label: "Feedback",
      value: un > 0 ? un + " new" : "all triaged",
      state: un > 0 ? "warn" : "ok",
    });
  }

  async function draw(rows) {
    const list = $("#list");
    list.innerHTML = "";
    if (!rows.length) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "Nothing matches this filter.";
      list.appendChild(p);
      return;
    }

    for (const row of rows) {
      const card = document.createElement("div");
      const trow = tOf(row);
      const st = trow.status;
      card.className = "card" + (st === "keep" ? " kept" : st === "skip" ? " skipped" : "")
        + (trow.done ? " done" : "");

      const h = document.createElement("h3");
      const when = row.created_at ? new Date(row.created_at).toLocaleString() : "(no date)";
      const mode = (row.app_state && row.app_state.mode) ? " · " + row.app_state.mode : "";
      h.textContent = when + mode;
      card.appendChild(h);

      const meta = document.createElement("div");
      meta.className = "meta";
      const email = emailByUid[row.user_id];
      meta.textContent = (email || "user " + (row.user_id || "—")) + " · #" + row.id;
      if (email && row.user_id) meta.title = "user_id: " + row.user_id;   // uid on hover
      card.appendChild(meta);

      const msg = document.createElement("div");
      msg.className = "msg";
      msg.textContent = row.message || "";   // textContent: no HTML injection
      card.appendChild(msg);

      const ptr = guessPointer(row.message);
      const pe = document.createElement("div");
      pe.className = "pointer";
      if (ptr) {
        pe.appendChild(document.createTextNode("Likely area: "));
        const b = document.createElement("b");
        b.textContent = ptr.file;
        pe.appendChild(b);
        pe.appendChild(document.createTextNode(" — " + ptr.why));
      } else {
        pe.textContent = "Likely area: (no confident guess)";
      }
      card.appendChild(pe);

      const blobs = document.createElement("div");
      blobs.className = "blobs";
      if (row.screenshot_path) {
        const img = await loadImage(row.screenshot_path);
        if (img) blobs.appendChild(img);
      }
      if (row.view_path) {
        const a = await loadDownload(row.view_path, "view.html");
        if (a) blobs.appendChild(a);
      }
      if (blobs.childNodes.length) card.appendChild(blobs);

      card.appendChild(detailsBlock("app_state", row.app_state));
      card.appendChild(detailsBlock("env", row.env));
      card.appendChild(triageControls(row, card));

      list.appendChild(card);
    }
  }

  // Show the "nothing here" line if a surgical card removal emptied the list, so the
  // owner isn't left staring at a blank panel after triaging the last item.
  function ensureEmptyState() {
    const list = $("#list");
    if (list.querySelector(".card")) return;
    list.innerHTML = "";
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "Nothing matches this filter.";
    list.appendChild(p);
  }

  // A slim, self-dismissing toast with one Undo — shown when a Keep/Skip slips a card
  // out of the working list, so a mis-click is one click to take back.
  let fbToastTimer = null;
  function fbToast(msg, undoFn) {
    let el = document.getElementById("fbToast");
    if (!el) { el = document.createElement("div"); el.id = "fbToast"; document.body.appendChild(el); }
    el.replaceChildren();
    const t = document.createElement("span"); t.textContent = msg;
    const b = document.createElement("button"); b.className = "fb-undo"; b.textContent = "Undo";
    el.append(t, b);
    el.classList.add("show");
    clearTimeout(fbToastTimer);
    const hide = () => el.classList.remove("show");
    fbToastTimer = setTimeout(hide, 6000);
    b.addEventListener("click", () => { clearTimeout(fbToastTimer); hide(); undoFn(); });
  }

  function triageControls(row, card) {
    const wrap = document.createElement("div");
    wrap.className = "triage";
    const st = tOf(row).status || "none";

    const seg = document.createElement("div");
    seg.className = "seg";
    const keepBtn = document.createElement("button");
    keepBtn.textContent = "Keep";
    if (st === "keep") keepBtn.className = "on-keep";
    const skipBtn = document.createElement("button");
    skipBtn.textContent = "Skip";
    if (st === "skip") skipBtn.className = "on-skip";
    keepBtn.addEventListener("click", () => toggleStatus(row, "keep", card));
    skipBtn.addEventListener("click", () => toggleStatus(row, "skip", card));
    seg.appendChild(keepBtn);
    seg.appendChild(skipBtn);
    wrap.appendChild(seg);

    const note = document.createElement("input");
    note.type = "text";
    note.className = "note";
    note.placeholder = "triage note (priority, dupe of…, repro…)";
    note.value = tOf(row).note || "";
    // Typing must NOT redraw (would steal focus); just save + refresh counts.
    note.addEventListener("input", () => setNote(row, note.value));
    wrap.appendChild(note);

    // Done = archive. Once you've acted on a report, mark it done and it leaves the
    // working list (kept locally, reversible via the "Done" filter). This never
    // touches the shared row — deletion is the 180-day retention sweep's job.
    const done = !!tOf(row).done;
    const doneBtn = document.createElement("button");
    doneBtn.className = "done-btn" + (done ? " is-done" : "");
    doneBtn.textContent = done ? "Restore" : "Done";
    doneBtn.title = done
      ? "Bring this back into the working list."
      : "Archive — hide it from the list. Local + reversible; the row still " +
        "auto-prunes at the 180-day retention window.";
    doneBtn.addEventListener("click", () => toggleDone(row));
    wrap.appendChild(doneBtn);

    return wrap;
  }

  function toggleStatus(row, act, card) {
    const key = tKey(row);
    const cur = (triage[key] || {}).status || "none";
    const next = cur === act ? "none" : act;
    triage[key] = Object.assign({}, triage[key], { status: next });
    if (triage[key].status === "none" && !triage[key].note) delete triage[key];
    saveTriage();
    // In the working views (All / Untriaged) a freshly-triaged card no longer belongs,
    // so slip it out instead of leaving it to scroll past — the list shrinks as you go.
    // Undo (toast) takes it back. Bucket views (Kept/Skipped/Done) keep the card so the
    // segmented toggle still reflects the change in place.
    const f = $("#filter").value;
    const leavesView = next !== "none" && (f === "all" || f === "untriaged");
    if (leavesView && card && card.isConnected) {
      card.remove();
      ensureEmptyState();
      updateCounts();
      fbToast((next === "keep" ? "Kept" : "Skipped") + " · #" + row.id, () => {
        triage[key] = Object.assign({}, triage[key], { status: cur });
        if (triage[key].status === "none" && !triage[key].note) delete triage[key];
        saveTriage();
        applyAndDraw();
      });
    } else {
      // Cheap to redraw — blobs are cached — and a redraw keeps the filter honest.
      applyAndDraw();
    }
  }

  function toggleDone(row) {
    const key = tKey(row);
    const cur = !!(triage[key] || {}).done;
    triage[key] = Object.assign({}, triage[key], { done: !cur });
    if (!triage[key].done) delete triage[key].done;
    const t = triage[key];
    // Drop a now-empty entry so localStorage doesn't accumulate cruft.
    if ((!t.status || t.status === "none") && !t.note && !t.done) delete triage[key];
    saveTriage();
    applyAndDraw();
  }

  function setNote(row, value) {
    const key = tKey(row);
    triage[key] = Object.assign({}, triage[key], { note: value });
    if (!value && (!triage[key].status || triage[key].status === "none")
        && !triage[key].done) delete triage[key];
    saveTriage();
    updateCounts();
  }

  async function loadImage(path) {
    const u = await blobUrl(path);
    if (!u) return null;
    const img = document.createElement("img");
    img.src = u;          // blob: URL — CSP img-src allows blob:
    img.alt = "screenshot";
    img.loading = "lazy";
    return img;
  }

  async function loadDownload(path, name) {
    const u = await blobUrl(path);
    if (!u) return null;
    const a = document.createElement("a");
    a.href = u;
    a.download = name;     // download, don't render: avoid executing foreign DOM
    a.textContent = "download " + name;
    return a;
  }

  const blobDataCache = new Map();   // path -> Blob (the raw bytes, for export)

  async function getBlob(path) {
    if (blobDataCache.has(path)) return blobDataCache.get(path);
    const { data, error } = await supa.storage.from(BUCKET).download(path);
    if (error || !data) return null;
    blobDataCache.set(path, data);
    return data;
  }

  async function blobUrl(path) {
    if (blobCache.has(path)) return blobCache.get(path);
    const b = await getBlob(path);
    if (!b) return null;
    const u = URL.createObjectURL(b);
    blobCache.set(path, u);
    objectUrls.push(u);
    return u;
  }

  function detailsBlock(label, obj) {
    const d = document.createElement("details");
    const s = document.createElement("summary");
    s.textContent = label;
    d.appendChild(s);
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(obj || {}, null, 2);
    d.appendChild(pre);
    return d;
  }

  // --- Export: kept rows -> a Claude-ready markdown brief, downloaded locally ---
  function buildBrief() {
    const kept = currentRows.filter((r) => tOf(r).status === "keep" && !tOf(r).done);
    const L = [];
    L.push("# Feedback brief for Claude", "");
    L.push("Generated " + new Date().toISOString() +
      " from the Album-of-the-Day in-app feedback (Supabase `public.feedback`).");
    L.push(kept.length + " kept " + (kept.length === 1 ? "entry" : "entries") +
      " after manual review. Each has a Problem/Context/Screenshot/Likely-area scaffold.");
    L.push("Please fill in **Proposed fix** and **Acceptance** per entry, reading against " +
      "VISION.md and BACKLOG.md, and quote the user's words in any backlog line.", "");
    if (!kept.length) L.push("_(No entries marked keep.)_");
    kept.forEach((r, i) => {
      const t = tOf(r);
      const msg = (r.message || "").trim().replace(/\r?\n/g, "\n  ");
      const p = guessPointer(r.message);
      L.push("---", "", "## " + (i + 1) + ". feedback #" + r.id, "");
      L.push("**Problem (user's words):**", "> " + (msg || "(no message)"), "");
      const ctx = [];
      if (stateSummary(r.app_state)) ctx.push("app_state: " + stateSummary(r.app_state));
      if (envSummary(r.env)) ctx.push("env: " + envSummary(r.env));
      ctx.push("submitted: " + (r.created_at || "?"));
      if (r.user_id) ctx.push("user: " + (emailByUid[r.user_id] || r.user_id));
      L.push("**Context:** " + ctx.join(" | "));
      if (t.note) L.push("**Triage note:** " + t.note);
      if (r.screenshot_path)
        L.push("**Screenshot:** `images/feedback-" + r.id + ".png` (included in this bundle — attach it to the session)");
      if (r.view_path)
        L.push("**DOM snapshot:** `views/feedback-" + r.id + ".html` (included in this bundle)");
      L.push("**Likely area:** " +
        (p ? "`" + p.file + "` — " + p.why : "(no confident guess — locate during the session)"));
      L.push("**Proposed fix:** _(Claude to complete)_");
      L.push("**Acceptance:** _(Claude to complete)_", "");
    });
    return L.join("\n");
  }

  // Gather the brief + each kept entry's screenshot/DOM into one .zip and save
  // it. The screenshots travel as real PNG files so a Claude session can see
  // them; the brief references them by their in-bundle filename.
  async function exportBundle() {
    const kept = currentRows.filter((r) => tOf(r).status === "keep" && !tOf(r).done);
    if (!kept.length) {
      setStatus("Nothing marked keep yet — mark some entries first.");
      return;
    }
    setStatus("Bundling " + kept.length + " kept report" + (kept.length === 1 ? "" : "s") + "…");
    const files = [{ name: "feedback-brief.md", data: new TextEncoder().encode(buildBrief()) }];
    let imgs = 0;
    for (const r of kept) {
      if (r.screenshot_path) {
        const b = await getBlob(r.screenshot_path);
        if (b) { files.push({ name: "images/feedback-" + r.id + ".png", data: new Uint8Array(await b.arrayBuffer()) }); imgs++; }
      }
      if (r.view_path) {
        const b = await getBlob(r.view_path);
        if (b) files.push({ name: "views/feedback-" + r.id + ".html", data: new Uint8Array(await b.arrayBuffer()) });
      }
    }
    downloadBlob("feedback-brief.zip", buildZip(files));
    setStatus("Exported " + kept.length + " kept → feedback-brief.zip (" +
      imgs + " screenshot" + (imgs === 1 ? "" : "s") + ")");
  }

  function downloadBlob(name, blob) {
    const u = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = u; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 1000);
  }

  // --- Minimal ZIP writer: "stored" (no compression), no dependencies. Enough
  // to package a few text + PNG files. Keeps the operator page free of any new
  // third-party/CDN code. ---
  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      let c = (crc ^ bytes[i]) & 0xFF;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function buildZip(files) {
    const enc = new TextEncoder();
    const u16 = (n) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n & 0xFFFF, true); return b; };
    const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
    const chunks = [];
    const central = [];
    let offset = 0;
    const push = (p) => { chunks.push(p); offset += p.length; };

    for (const f of files) {
      const name = enc.encode(f.name);
      const data = f.data;
      const crc = crc32(data);
      const localStart = offset;
      // Local file header (UTF-8 filename flag 0x0800, stored/no compression).
      push(u32(0x04034b50)); push(u16(20)); push(u16(0x0800)); push(u16(0));
      push(u16(0)); push(u16(0)); push(u32(crc));
      push(u32(data.length)); push(u32(data.length));
      push(u16(name.length)); push(u16(0)); push(name); push(data);
      central.push({ name, crc, size: data.length, offset: localStart });
    }
    const cdStart = offset;
    for (const c of central) {
      push(u32(0x02014b50)); push(u16(20)); push(u16(20)); push(u16(0x0800));
      push(u16(0)); push(u16(0)); push(u16(0)); push(u32(c.crc));
      push(u32(c.size)); push(u32(c.size)); push(u16(c.name.length));
      push(u16(0)); push(u16(0)); push(u16(0)); push(u16(0)); push(u32(0));
      push(u32(c.offset)); push(c.name);
    }
    const cdSize = offset - cdStart;
    push(u32(0x06054b50)); push(u16(0)); push(u16(0));
    push(u16(central.length)); push(u16(central.length));
    push(u32(cdSize)); push(u32(cdStart)); push(u16(0));

    return new Blob(chunks, { type: "application/zip" });
  }

  // --- Access requests (Phase D admin view) ---------------------------------
  // Reads over the 0003 "access_requests: admin reads all" RLS policy. Approve /
  // decline are one-click writes over the 0005 admin-gated policies (both gated
  // on is_app_admin(), so only the operator's account can touch the gate — a
  // deliberate walk-back of 0004 §5's copy-the-SQL-only posture, owner-approved
  // 2026-07-02; anon still has no path, and the 0004 auth hook remains the real
  // sign-up enforcement). If 0005 isn't applied (or the account isn't an admin)
  // the write fails with 42501 and each row falls back to offering the exact
  // parameterised SQL to paste into the SQL editor, as before.
  let reqRows = [];

  function escSqlLiteral(s) {
    // Single-quote a value for SQL, doubling embedded quotes. Emails are validated
    // server-side before they ever land in access_requests, but quote defensively.
    return "'" + String(s == null ? "" : s).replace(/'/g, "''") + "'";
  }
  function approveSql(email) {
    const e = escSqlLiteral(email);
    return (
      "with approved as (\n" +
      "  insert into public.invited_emails (email, note, invited_by)\n" +
      "  values (lower(trim(" + e + ")), 'approved from access_requests', 'operator')\n" +
      "  on conflict (email) do nothing\n" +
      "  returning email\n" +
      ")\n" +
      "update public.access_requests\n" +
      "   set status = 'invited', updated_at = now()\n" +
      " where email = lower(trim(" + e + "));"
    );
  }
  function declineSql(email) {
    const e = escSqlLiteral(email);
    return (
      "update public.access_requests\n" +
      "   set status = 'declined', updated_at = now()\n" +
      " where email = lower(trim(" + e + "));"
    );
  }

  async function copyText(text, badgeEl) {
    let okCopy = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        okCopy = true;
      }
    } catch (e) { okCopy = false; }
    if (!okCopy) {
      // Fallback for clipboard-API-less contexts: a transient textarea + execCommand.
      try {
        const ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.focus(); ta.select();
        okCopy = document.execCommand("copy");
        ta.remove();
      } catch (e) { okCopy = false; }
    }
    if (badgeEl) {
      badgeEl.textContent = okCopy ? "SQL copied — paste into the SQL editor" : "Copy failed — select & copy manually";
      setTimeout(() => { badgeEl.textContent = ""; }, 4000);
    }
    return okCopy;
  }

  function normEmail(e) {
    // Mirror the SQL's lower(trim(...)) so the API writes and the 0004 hook's
    // lookup agree on the key.
    return String(e == null ? "" : e).trim().toLowerCase();
  }

  function mailtoLink(email) {
    // Approving only opens the gate — nothing emails the person. This link is
    // the human step: one click drafts the "you're in" note in the operator's
    // own mail client. Rendered for every invited row so it survives redraws.
    const subject = "You're invited to Music Forest";
    const body =
      "Hi — your Music Forest access request is approved.\n\n" +
      "For your first sign-in at https://musicforest.lol, use this email " +
      "address with either \"Continue with Google\" or \"Email me a sign-in " +
      "link\" (the link creates your account). You'll choose your passwords " +
      "once you're in.\n\n" +
      "See you in the forest.";
    const a = document.createElement("a");
    a.className = "mailto";
    a.href = "mailto:" + encodeURIComponent(email) +
      "?subject=" + encodeURIComponent(subject) +
      "&body=" + encodeURIComponent(body);
    a.textContent = "✉ Tell " + email;
    return a;
  }

  function writeFallback(error, feedback, sql) {
    // A 42501 means the 0005 policies aren't applied or this account isn't in
    // app_admins — offer the 0004-era SQL-editor path instead of a dead end.
    feedback.textContent = "";
    const msg = document.createElement("span");
    msg.textContent =
      (error && error.code === "42501"
        ? "Not permitted (migration 0005 applied? account in app_admins?) — "
        : "Write failed (" + ((error && error.message) || error) + ") — ");
    feedback.appendChild(msg);
    const btn = document.createElement("button");
    btn.textContent = "⧉ copy the SQL instead";
    btn.addEventListener("click", () => copyText(sql, feedback));
    feedback.appendChild(btn);
  }

  // Both writes are separate statements (PostgREST has no cross-table
  // transaction): allow-list FIRST, then the request status. A half-failure can
  // only leave an invited email whose request still reads "new" (harmless —
  // re-click), never a request marked invited without its allow-list row.
  //
  // Plain INSERT with 23505-as-success, deliberately NOT upsert: under RLS,
  // INSERT ... ON CONFLICT DO NOTHING also consults SELECT policies (and needs
  // SELECT on the arbiter column), and the allow-list intentionally has neither
  // (proved live 2026-07-02: plain INSERT passed, upsert 42501'd). A duplicate
  // key just means "already invited" — which is success for this button.
  async function approveRequest(r, feedback) {
    const email = normEmail(r.email);
    if (!email) { feedback.textContent = "No email on this request."; return; }
    if (!confirm("Invite " + email + "? They'll be able to create an account.")) return;
    feedback.textContent = "Inviting…";
    const ins = await supa.from("invited_emails").insert(
      { email: email, note: "approved from access_requests", invited_by: "operator" });
    if (ins.error && ins.error.code !== "23505") {
      writeFallback(ins.error, feedback, approveSql(r.email));
      return;
    }
    const upd = await supa.from("access_requests")
      .update({ status: "invited", updated_at: new Date().toISOString() })
      .eq("email", email);
    if (upd.error) { writeFallback(upd.error, feedback, approveSql(r.email)); return; }
    r.status = "invited";
    drawRequests();
  }

  async function declineRequest(r, feedback) {
    const email = normEmail(r.email);
    if (!email) { feedback.textContent = "No email on this request."; return; }
    feedback.textContent = "Declining…";
    const upd = await supa.from("access_requests")
      .update({ status: "declined", updated_at: new Date().toISOString() })
      .eq("email", email);
    if (upd.error) { writeFallback(upd.error, feedback, declineSql(r.email)); return; }
    r.status = "declined";
    drawRequests();
  }

  // --- Door crawler health -------------------------------------------------
  // Reads the heartbeat the local prewarm writes into pool.sqlite (rsynced up),
  // via the operator-gated Flask endpoint. Authed with the Supabase access token
  // (same bearer the sync API expects), NOT through PostgREST — the heartbeat
  // lives in pool.sqlite, not Supabase.
  function relTime(sec) {
    if (sec == null) return "unknown";
    sec = Math.max(0, Math.round(sec));
    if (sec < 90) return sec + "s ago";
    const m = Math.round(sec / 60);
    if (m < 90) return m + " min ago";
    const h = Math.round(m / 60);
    if (h < 36) return h + "h ago";
    return Math.round(h / 24) + "d ago";
  }
  const CRAWL_LABEL = {
    ok: "Healthy", running: "Running", throttled: "Throttled", stale: "Stale",
    never: "No data", error: "Error",
  };
  // Verdicts that want the operator's eyes.
  const CRAWL_ATTENTION = { throttled: true, stale: true, error: true };
  let crawlTimer = null;   // auto-refresh handle (cleared on re-render / signout)

  // --- H4: the "where should my attention be" panel --------------------------
  // One glance: a strip of machine-state chips + the BACKLOG watch-list, all
  // from /api/admin/attention. Rendered with textContent throughout (backlog
  // titles are markdown-derived text — never inject them as HTML).
  async function adminFetch(path) {
    // `supa` is null on a build with no Supabase config (local dev), where this used
    // to throw "Cannot read properties of null" into every panel's error line. Send
    // no Authorization header instead: the server gates all of these on
    // _require_operator() regardless, so a tokenless call can only get through where
    // auth isn't enforced (a local build) and 401s everywhere else.
    let token = null;
    if (supa) {
      const { data: sess } = await supa.auth.getSession();
      token = sess && sess.session && sess.session.access_token;
    }
    return fetch(path, { headers: token ? { Authorization: "Bearer " + token } : {} });
  }

  // --- H4b: the cost panel ("what does this cost me?") -----------------------
  // Fixed costs (config, confirmed against invoices) + live-measured usage from
  // /api/admin/cost. All values are our own numbers, but built with DOM methods
  // to match the file's no-innerHTML-for-data posture. See INVITE_ROLLOUT_PLAN.md.
  const COST_MB = 1024 * 1024, COST_GB = 1024 * 1024 * 1024;
  // Last-seen cost + attention payloads, so the Beta-capacity band (Summary) can be
  // rebuilt whenever either loader lands, in whichever order they finish.
  const capacityData = { cost: null, attn: null };
  function fmtUSD(n) {
    if (n == null) return "—";
    const r = Math.round(n * 100) / 100;
    return "$" + r.toLocaleString(undefined,
      { minimumFractionDigits: r % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }
  function fmtSize(bytes) {
    if (bytes == null) return "—";
    return bytes >= COST_GB ? (bytes / COST_GB).toFixed(1) + " GB"
      : (bytes / COST_MB).toFixed(0) + " MB";
  }
  function costKpi(label, value) {
    const d = document.createElement("div"); d.className = "kpi";
    const k = document.createElement("span"); k.className = "k"; k.textContent = label;
    const v = document.createElement("span"); v.className = "v"; v.textContent = value;
    d.append(k, v);
    return d;
  }
  function costMeter(label, used, cap, valText) {
    const pct = cap ? Math.min(100, (used / cap) * 100) : 0;
    const row = document.createElement("div"); row.className = "meter-row";
    const head = document.createElement("div"); head.className = "meter-head";
    const l = document.createElement("span"); l.textContent = label;
    const mv = document.createElement("span"); mv.className = "mv"; mv.textContent = valText;
    head.append(l, mv);
    const track = document.createElement("div"); track.className = "meter-track";
    const fill = document.createElement("div");
    fill.className = "meter-fill" + (pct >= 80 ? " bad" : pct >= 50 ? " warn" : "");
    // Show a hairline of fill for a tiny-but-nonzero value so "in use" reads.
    fill.style.width = (pct > 0 && pct < 1 ? 1 : Math.round(pct)) + "%";
    track.append(fill);
    row.append(head, track);
    return row;
  }

  // --- Pool: records per listening service, per day --------------------------
  // The metric the panel never had. Two ceilings, from the owner's own words
  // (2026-07-16): "having only 20 or so for one service is really not desired.
  // having hundreds is great."
  const POOL_THIN = 50, POOL_LOW = 200;
  const POOL_LABELS = { spotify: "Spotify", apple: "Apple Music",
    youtube: "YouTube Music", deezer: "Deezer", tidal: "Tidal",
    amazon: "Amazon Music", pandora: "Pandora", bandcamp: "Bandcamp" };
  function poolState(n) { return n < POOL_THIN ? "bad" : n < POOL_LOW ? "warn" : "ok"; }

  // A service meter, deliberately NOT costMeter: there, a full bar is bad; here an
  // EMPTY bar is bad. Same DOM shape, inverted polarity, hence .pool-fill.
  function poolMeter(key, n, total) {
    const pct = total ? Math.min(100, (n / total) * 100) : 0;
    const row = document.createElement("div"); row.className = "meter-row";
    const head = document.createElement("div"); head.className = "meter-head";
    const l = document.createElement("span");
    l.textContent = POOL_LABELS[key] || key;
    const mv = document.createElement("span"); mv.className = "mv";
    mv.textContent = n.toLocaleString() + "  ·  " + Math.round(pct) + "%";
    head.append(l, mv);
    const track = document.createElement("div"); track.className = "meter-track";
    const fill = document.createElement("div");
    fill.className = "pool-fill " + poolState(n);
    // A hairline for a tiny-but-nonzero count, so "12" still reads as present.
    fill.style.width = (pct > 0 && pct < 1 ? 1 : Math.round(pct)) + "%";
    track.append(fill);
    row.append(head, track);
    return row;
  }

  function poolDayCard(d, order, isLead) {
    const card = document.createElement("div");
    card.className = "pool-day" + (isLead ? " lead" : "");
    const head = document.createElement("div"); head.className = "pool-head";
    const when = document.createElement("span");
    when.className = "pool-when"; when.textContent = d.when;
    const date = document.createElement("span");
    date.className = "pool-date"; date.textContent = d.day;
    head.append(when, date);
    if (isLead) {
      const badge = document.createElement("span");
      badge.className = "pool-badge"; badge.textContent = "the honest one";
      head.append(badge);
    }
    card.append(head);
    if (d.error) {
      const p = document.createElement("p");
      p.className = "pool-total"; p.textContent = d.error;
      card.append(p);
      return card;
    }
    const sub = document.createElement("p");
    sub.className = "pool-total";
    sub.textContent = d.total.toLocaleString() + " records listenable";
    card.append(sub);
    for (const k of order) card.append(poolMeter(k, (d.counts || {})[k] || 0, d.total));
    return card;
  }

  async function loadPool() {
    const status = $("#poolStatus"), wrap = $("#poolDays");
    if (!wrap) return;
    status.textContent = "Loading…";
    try {
      const r = await adminFetch("/api/admin/platform-day");
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      status.textContent = "";
      if (data.error) { status.textContent = data.error; wrap.replaceChildren(); return; }
      const order = data.order || Object.keys(POOL_LABELS);
      const days = data.days || [];
      wrap.replaceChildren(...days.map(
        (d) => poolDayCard(d, order, d.when === "tomorrow")));
      // The tile + tab dot report TOMORROW's worst service — today is warmed and
      // browsed, so it can read fine while the job behind it is dead.
      const lead = days.find((d) => d.when === "tomorrow" && !d.error) || days[0];
      if (lead && lead.counts) {
        let worstK = null, worstN = Infinity;
        for (const k of order) {
          const n = lead.counts[k] || 0;
          if (n < worstN) { worstN = n; worstK = k; }
        }
        setHealth("pool", { label: "Pool · thinnest service",
          value: (POOL_LABELS[worstK] || worstK) + " " + worstN.toLocaleString(),
          state: poolState(worstN) });
      }
    } catch (e) {
      status.textContent = "Couldn't load the per-service counts: " + e.message;
      wrap.replaceChildren();
    }
  }

  async function loadCost() {
    const status = $("#costStatus");
    status.textContent = "Loading…";
    let data;
    try {
      const r = await adminFetch("/api/admin/cost");
      if (!r.ok) {
        status.textContent = r.status === 403
          ? "This account isn't on the operator allow-list (AOTD_OPERATOR_IDS)."
          : "Couldn't load the cost panel (" + r.status + ").";
        return;
      }
      data = await r.json();
    } catch (e) {
      status.textContent = "Couldn't reach the cost endpoint.";
      return;
    }
    capacityData.cost = data;
    renderCapacity();
    const u = data.usage || {}, c = data.costs || {}, cap = data.ceilings || {};
    // RAM ceiling: prefer the MEASURED cgroup limit (self-corrects on any plan) and
    // fall back to the configured plan number only when the box couldn't report one.
    const ramBytes = u.render_ram_limit_bytes
      || (cap.render_ram_mb ? cap.render_ram_mb * COST_MB : 0);
    const ramMb = ramBytes ? Math.round(ramBytes / COST_MB) : 0;

    const hero = $("#costHero");
    const big = document.createElement("span"); big.className = "big";
    big.textContent = fmtUSD(data.fixed_monthly);
    const unit = document.createElement("span"); unit.className = "unit"; unit.textContent = "/mo";
    big.append(unit);
    const sub = document.createElement("span"); sub.className = "sub";
    sub.textContent = "flat — and it stays flat until you choose to scale";
    hero.replaceChildren(big, sub);

    const accounts = u.accounts;
    $("#costKpis").replaceChildren(
      costKpi("Fixed monthly", fmtUSD(data.fixed_monthly)),
      costKpi("Active accounts", accounts == null ? "—" : String(accounts)),
      costKpi("Cost / account",
        data.cost_per_account == null ? "—" : fmtUSD(data.cost_per_account)),
      costKpi("Added per user", "~$0"));

    const meters = $("#costMeters");
    const bd = document.createElement("div"); bd.className = "cost-breakdown";
    [["Render — web service", c.render],
     ["Supabase — Pro (backups)", c.supabase],
     ["Domain (annual ÷ 12)", c.domain],
     ["Email hosting (annual ÷ 12)", c.email]].forEach(function (pair) {
      if (!pair[1]) return;
      const row = document.createElement("div"); row.className = "brow";
      const n = document.createElement("span"); n.textContent = pair[0];
      const a = document.createElement("span"); a.className = "amt"; a.textContent = fmtUSD(pair[1]);
      row.append(n, a); bd.append(row);
    });
    const parts = [bd];
    // Spotify leads the meters because it is the ceiling that actually binds now: a
    // shared ~780 Searches/day for the WHOLE app on one client_id, so exhausting it
    // 429s the on-demand door for every user at once (7.3h, on 2026-07-16) — and it's
    // the one limit a bigger Render box cannot buy off. It also grows with every person
    // invited, which none of the other meters do. costMeter's warn/bad thresholds (50/80%)
    // read correctly here: this is a budget to stay UNDER, not capacity to fill.
    if (u.spotify && u.spotify.ceiling) {
      const s = u.spotify;
      // null (not 0) means the counter itself couldn't be read — say so rather than
      // report a reassuring zero.
      const od = s.on_demand_today == null ? "?" : s.on_demand_today;
      parts.push(costMeter(
        "Spotify Searches today (door " + od + " + prewarm " + s.prewarm_today + ")",
        s.spent_today, s.ceiling,
        s.spent_today + " / " + s.ceiling + " · " + s.headroom + " left"));
    } else if (u.spotify_error) {
      const e = document.createElement("div"); e.className = "cost-note";
      e.textContent = "Spotify burn unavailable: " + u.spotify_error;
      parts.push(e);
    }
    if (u.concurrency_now != null && cap.render_threads) {
      parts.push(costMeter("Render requests in flight (this worker · peak "
        + (u.concurrency_peak == null ? "—" : u.concurrency_peak) + ")",
        u.concurrency_now, cap.render_threads,
        u.concurrency_now + " / " + cap.render_threads + " threads"));
    }
    if (u.worker_rss_bytes != null && ramBytes) {
      parts.push(costMeter("Render memory (peak worker RSS)",
        u.worker_rss_bytes, ramBytes,
        Math.round(u.worker_rss_bytes / COST_MB) + " / " + ramMb + " MB"));
    }
    if (u.disk_used_bytes != null && u.disk_total_bytes) {
      parts.push(costMeter("Render disk (catalog volume)",
        u.disk_used_bytes, u.disk_total_bytes,
        fmtSize(u.disk_used_bytes) + " / " + fmtSize(u.disk_total_bytes)));
    }
    if (u.db_bytes != null) {
      const pg = u.backend === "postgres";
      parts.push(costMeter(pg ? "Supabase database" : "Local sync store",
        u.db_bytes, (cap.supabase_db_gb || 0) * COST_GB,
        fmtSize(u.db_bytes) + " / " + (cap.supabase_db_gb || "—") + " GB"));
    }
    const note = document.createElement("div"); note.className = "cost-note";
    note.textContent = "First to bump is SPOTIFY, not the box: its ~780 Searches/day "
      + "is shared by the whole app on one client_id, so running it out 429s the "
      + "on-demand door for everyone at once — and it's the only ceiling here that "
      + "grows with each person invited, and that money can't lift. The prewarm's "
      + "share is capped (tools/prewarm_spotify.sh LIMIT); the rest is real door "
      + "opens. After that it's the Render box, not Supabase — when cold-starts or "
      + "concurrency tighten, more vCPU is a cheap fix. Supabase Pro buys daily "
      + "backups, not capacity — egress and true MAU live in the Supabase dashboard.";
    parts.push(note);
    meters.replaceChildren(...parts);

    const errs = [];
    if (u.store_error) errs.push("store: " + u.store_error);
    if (u.disk_error) errs.push("disk: " + u.disk_error);
    status.textContent = (errs.length ? errs.join(" · ") + " · " : "")
      + "measured as of " + (data.generated_at || "now");

    // Health pill: the tightest resource meter is what will force the next bill.
    let ratio = 0;
    if (u.worker_rss_bytes != null && ramBytes) {
      ratio = Math.max(ratio, u.worker_rss_bytes / ramBytes);
    }
    if (u.disk_used_bytes != null && u.disk_total_bytes) {
      ratio = Math.max(ratio, u.disk_used_bytes / u.disk_total_bytes);
    }
    if (u.db_bytes != null && cap.supabase_db_gb) {
      ratio = Math.max(ratio, u.db_bytes / (cap.supabase_db_gb * COST_GB));
    }
    setHealth("cost", {
      label: "Cost", value: fmtUSD(data.fixed_monthly) + "/mo",
      state: ratio >= 0.85 ? "bad" : ratio >= 0.7 ? "warn" : "ok",
    });
  }

  // --- Usage panel: anonymized, aggregate signals only (no notebook content) ---
  // [counter key, label, one-line plain-English description of what it counts].
  const USAGE_FEATURES = [
    ["today_served", "Today opened",
      "The Today page loaded a day's records (a visit, or a genre re-filter)."],
    ["explore_search", "Explore searches",
      "A search run in the Explore tab."],
    ["door_open", "Records opened to listen",
      "A record's Listen links were fetched — roughly, a record opened for listening."],
  ];
  async function loadUsage() {
    const status = $("#usageStatus");
    let data;
    try {
      const r = await adminFetch("/api/admin/usage");
      if (!r.ok) {
        status.textContent = r.status === 403
          ? "This account isn't on the operator allow-list (AOTD_OPERATOR_IDS)."
          : "Couldn't load usage (" + r.status + ").";
        return;
      }
      data = await r.json();
    } catch (e) {
      status.textContent = "Couldn't reach the usage endpoint.";
      return;
    }
    const acc = data.accounts || {}, feat = data.features || {}, con = data.content || {};
    const hosted = acc.available === true;

    // KPI row. Account tiles read "—" off the hosted deploy (SQLite has no auth.users);
    // notebook counts are available everywhere.
    $("#usageKpis").replaceChildren(
      costKpi("Accounts", hosted ? String(acc.total) : "—"),
      costKpi("Signed in · 7d", hosted ? String(acc.active_7d) : "—"),
      costKpi("New · 7d", hosted ? String(acc.new_7d) : "—"),
      costKpi("Keeps", con.keeps == null ? "—" : String(con.keeps)));

    const body = $("#usageBody");
    const t7 = feat.totals_7d || {};
    const parts = [];

    // Activity over time — the per-day log the counters keep in ops.sqlite (persisted
    // across deploys, never rsync'd over). A trend is legible where an instantaneous
    // number isn't; gaps fill with zero so the timeline is honest. Fills in as the beta
    // runs. This is the "graph over time" — the live gauge below is only a spot check.
    parts.push(sectionLabel("Today opened · per day (last 14 days, UTC)"));
    parts.push(usageTrend(feat.by_day || {}, "today_served", 14));
    parts.push(usageHint("Each bar is one day; hover for its date and count. For live "
      + "traffic OVER TIME — request rate, CPU, memory, properly windowed and graphed — "
      + "Render's own metrics dashboard is the right tool, and better than any number here."));

    // Right now — a spot check of the load this instant. It is INSTANTANEOUS with no
    // window (peak is since this worker restarted), so it flickers; the trend above is the
    // real "over time" view. Music Forest never counts concurrent PEOPLE (session tracking).
    if (data.live) {
      const n = data.live.in_flight;
      const live = document.createElement("p"); live.className = "muted usage-sub";
      live.textContent = "Right now: " + n + (n === 1 ? " request" : " requests")
        + " in flight (spot check, no window) · peak " + data.live.peak + " since restart";
      parts.push(live);
    }

    // Account activity — hosted only. Say so plainly rather than show fake zeros.
    if (hosted) {
      parts.push(sectionLabel("Active accounts"));
      parts.push(usageHint("“Active” = signed in within the window: daily = last "
        + "24h, weekly = 7 days, monthly = 30 days. A signed-in PWA can stay logged in for "
        + "weeks, so this leans low — the truer “using it” number is below."));
      const active = document.createElement("div"); active.className = "cost-kpis";
      active.append(
        costKpi("Signed in · 24h", String(acc.active_1d)),
        costKpi("Signed in · 7d", String(acc.active_7d)),
        costKpi("Signed in · 30d", String(acc.active_30d)));
      parts.push(active);
      if (acc.active_savers_7d != null) {
        const savers = document.createElement("p"); savers.className = "usage-nb";
        savers.textContent = acc.active_savers_7d + " kept or wrote something in the last "
          + "7 days · " + acc.active_savers_30d + " in 30 days";
        parts.push(savers);
        parts.push(usageHint("Distinct accounts that actually touched their notebook — the "
          + "most honest “actively using it” signal (metadata only, never content)."));
      }
      const seen = document.createElement("p"); seen.className = "muted usage-sub";
      seen.textContent = "dormant (no sign-in in 30 days): " + acc.dormant + " of " + acc.total;
      parts.push(seen);
      const hist = acc.signups_by_day || [];
      if (hist.length) {
        parts.push(sectionLabel("Accounts created · last 30 days"));
        parts.push(usageBars(hist.map((h) => [h.day, h.n])));
      }
    } else {
      parts.push(sectionLabel("Accounts"));
      parts.push(usageHint(acc.error
        ? "Account activity unavailable: " + acc.error
        : "Account activity (accounts, sign-ins, signups) reads Supabase auth, so it "
          + "populates on the live site — this local build has no auth to read."));
    }

    // Feature usage — the per-day request counters this host has recorded (last 7 days),
    // each with a plain description so the number is legible.
    parts.push(sectionLabel("Feature usage · last 7 days"));
    const fmax = Math.max(1, ...USAGE_FEATURES.map(([k]) => t7[k] || 0));
    for (const [key, label, desc] of USAGE_FEATURES) {
      const n = t7[key] || 0;
      parts.push(costMeter(label, n, fmax, n.toLocaleString()));
      // Guest/account split rides under Today, the one counter the client tags by tier.
      let d = desc;
      if (key === "today_served" && (t7.today_guest != null || t7.today_account != null)) {
        d += "  ·  " + (t7.today_guest || 0) + " by guests, "
          + (t7.today_account || 0) + " by accounts.";
      }
      parts.push(usageHint(d));
    }
    parts.push(usageHint("Guests are people using Music Forest without an account. We count "
      + "their activity (loads above), but not how many unique guests there are — that would "
      + "need a device fingerprint, which we don't set. A guest becomes an account only when "
      + "they make one."));

    // Notebook (all-time, metadata only). Kept separate from the 7-day counters above
    // so a cumulative total is never mistaken for recent activity.
    parts.push(sectionLabel("In the notebook · all time"));
    const nb = document.createElement("p"); nb.className = "usage-nb";
    nb.textContent = (con.keeps == null ? "—" : con.keeps.toLocaleString()) + " keeps · "
      + (con.notes == null ? "—" : con.notes.toLocaleString()) + " notes written";
    parts.push(nb);

    const foot = document.createElement("p"); foot.className = "muted usage-foot";
    foot.textContent = "Counts only — no identity attached. The notebook is "
      + "end-to-end encrypted, so its contents never appear here. Skips aren't counted: "
      + "they stay on the device and are never sent.";
    parts.push(foot);

    body.replaceChildren(...parts);
    status.textContent = "measured as of " + (data.generated_at || "now");
    const un = feat.features_error || data.features_error;
    if (un) status.textContent = "features unavailable: " + un;
  }
  function sectionLabel(text) {
    const d = document.createElement("div"); d.className = "usage-seclabel";
    d.textContent = text; return d;
  }
  function usageHint(text) {
    const d = document.createElement("p"); d.className = "usage-hint";
    d.textContent = text; return d;
  }
  // A compact vertical bar trend of one counter over the last `days` days (UTC, matching
  // opsdb's day buckets). Generates the full timeline and fills missing days with zero so
  // a quiet day reads as a short bar, not a gap.
  function usageTrend(byDay, key, days) {
    const wrap = document.createElement("div"); wrap.className = "usage-trend";
    const now = new Date();
    const cells = [];
    let max = 1;
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(),
        now.getUTCDate() - i));
      const day = d.toISOString().slice(0, 10);
      const n = (byDay[day] && byDay[day][key]) || 0;
      max = Math.max(max, n);
      cells.push([day, n]);
    }
    for (const [day, n] of cells) {
      const col = document.createElement("div"); col.className = "ut-col";
      col.title = day + ": " + n.toLocaleString();
      const bar = document.createElement("div");
      bar.className = "ut-bar" + (n === 0 ? " zero" : "");
      bar.style.height = (n === 0 ? 2 : Math.max(6, Math.round((n / max) * 100))) + "%";
      col.append(bar);
      wrap.append(col);
    }
    return wrap;
  }
  // A compact bar row for a small [label, value] series (the signups histogram),
  // scaled to the series max. Reuses the meter track/fill look.
  function usageBars(pairs) {
    const wrap = document.createElement("div"); wrap.className = "usage-hist";
    const max = Math.max(1, ...pairs.map((p) => p[1]));
    for (const [label, n] of pairs) {
      const row = document.createElement("div"); row.className = "usage-hrow";
      const l = document.createElement("span"); l.className = "uh-lab"; l.textContent = label;
      const track = document.createElement("div"); track.className = "meter-track";
      const fill = document.createElement("div"); fill.className = "meter-fill";
      fill.style.width = Math.max(2, Math.round((n / max) * 100)) + "%";
      track.append(fill);
      const v = document.createElement("span"); v.className = "uh-n"; v.textContent = n;
      row.append(l, track, v); wrap.append(row);
    }
    return wrap;
  }

  // --- Beta capacity band (Summary) ------------------------------------------
  // The ceilings that actually bite as invites go out (INVITE_ROLLOUT_PLAN §2):
  // the Render box (threads / RAM / disk), the Supabase database, and upstream API
  // health (Apple+Odesli door warming via the crawler, the keyed Spotify quota).
  // Built from the cost + attention payloads the Summary already loads — no extra
  // request. Honest about what the server can't see (Supabase MAU / egress).
  // Warn late, bad later: the catalog disk sits at a normal ~65 % baseline, so a
  // 0.6 warn would keep this band amber forever and train the eye to ignore it. The
  // band should be green when things are genuinely fine and only speak up as a
  // ceiling actually approaches.
  function capState(r) { return r >= 0.9 ? "bad" : r >= 0.75 ? "warn" : "ok"; }
  function capChip(label, state, text) {
    const d = document.createElement("div"); d.className = "cap-chip " + (state || "");
    const k = document.createElement("span"); k.className = "k"; k.textContent = label;
    const v = document.createElement("span"); v.className = "v";
    const dot = document.createElement("span"); dot.className = "dot " + (state || "");
    const t = document.createElement("span"); t.textContent = text;
    v.append(dot, t); d.append(k, v);
    return d;
  }
  function renderCapacity() {
    const box = $("#betaCapacity");
    if (!box) return;
    const cd = capacityData.cost, ad = capacityData.attn;
    if (!cd && !ad) { box.hidden = true; return; }

    const states = [];   // every signal's state → the overall verdict
    const meters = [];
    if (cd) {
      const u = cd.usage || {}, cap = cd.ceilings || {};
      const meter = (label, used, capacity, valText) => {
        if (used == null || !capacity) return;
        states.push(capState(used / capacity));
        meters.push(costMeter(label, used, capacity, valText));
      };
      meter("Render threads (worker)", u.concurrency_now, cap.render_threads,
        (u.concurrency_now == null ? "—" : u.concurrency_now) + " / "
          + (cap.render_threads || "—") + " · peak "
          + (u.concurrency_peak == null ? "—" : u.concurrency_peak));
      const ramBytes = u.render_ram_limit_bytes
        || (cap.render_ram_mb ? cap.render_ram_mb * COST_MB : 0);
      if (u.worker_rss_bytes != null && ramBytes) {
        meter("Render memory", u.worker_rss_bytes, ramBytes,
          Math.round(u.worker_rss_bytes / COST_MB) + " / "
            + Math.round(ramBytes / COST_MB) + " MB");
      }
      if (u.disk_used_bytes != null && u.disk_total_bytes) {
        meter("Render disk", u.disk_used_bytes, u.disk_total_bytes,
          fmtSize(u.disk_used_bytes) + " / " + fmtSize(u.disk_total_bytes));
      }
      if (u.db_bytes != null && cap.supabase_db_gb) {
        meter(u.backend === "postgres" ? "Supabase database" : "Local sync store",
          u.db_bytes, cap.supabase_db_gb * COST_GB,
          fmtSize(u.db_bytes) + " / " + cap.supabase_db_gb + " GB");
      }
    }

    const chips = [];
    if (ad) {
      const cr = ad.crawl || {};
      const crState = cr.error ? "bad"
        : (cr.health === "ok" || cr.health === "running") ? "ok"
          : cr.health === "throttled" || cr.health === "never" ? "warn" : "bad";
      states.push(crState);
      chips.push(capChip("Door warming · Apple + Odesli", crState,
        cr.error ? cr.error
          : (CRAWL_LABEL[cr.health] || cr.health || "?")
            + (cr.day ? " · " + cr.day : "")
            + (cr.age_seconds != null ? " · " + relTime(cr.age_seconds) : "")));
      const sp = ad.spotify || {};
      let spState, spText;
      if (sp.error) { spState = "bad"; spText = sp.error; }
      else {
        const fresh = sp.newest_age_hours != null && sp.newest_age_hours <= 26;
        spState = !sp.stamped ? "warn" : fresh ? "ok" : "bad";
        spText = (sp.newest_age_hours == null ? "no stamp yet"
          : "newest " + sp.newest_age_hours + " h ago")
          + (spState === "bad" ? " — quota block or prewarm asleep?" : "");
      }
      states.push(spState);
      chips.push(capChip("Spotify links · keyed quota", spState, spText));
    }

    const worst = states.indexOf("bad") >= 0 ? "bad"
      : states.indexOf("warn") >= 0 ? "warn" : "ok";
    const verdictText = worst === "bad" ? "a ceiling wants your eyes"
      : worst === "warn" ? "worth a glance" : "healthy — lots of headroom";

    const head = document.createElement("div"); head.className = "cap-head";
    const title = document.createElement("span"); title.className = "cap-title";
    title.textContent = "Beta capacity";
    const verdict = document.createElement("span"); verdict.className = "cap-verdict";
    const vdot = document.createElement("span"); vdot.className = "dot " + worst;
    const vtxt = document.createElement("span"); vtxt.textContent = verdictText;
    verdict.append(vdot, vtxt);
    head.append(title, verdict);

    const sub = document.createElement("p"); sub.className = "cap-sub";
    sub.textContent = (cd ? fmtUSD(cd.fixed_monthly) + "/mo flat · " : "")
      + "first to bump is the Render box, not a billing meter — each beta user adds ~$0.";

    const mwrap = document.createElement("div"); mwrap.className = "cap-meters";
    mwrap.replaceChildren(...meters);
    const cwrap = document.createElement("div"); cwrap.className = "cap-chips";
    cwrap.replaceChildren(...chips);

    const note = document.createElement("p"); note.className = "cap-note";
    note.textContent = "Threads + memory are per gunicorn worker. Two limits the server "
      + "can't see live — Supabase monthly active users + egress — live in the Supabase "
      + "dashboard. Uncached door opens on Render fall back to search links rather than "
      + "erroring, so users never hit the Apple limit directly; the crawler is what keeps "
      + "doors warm.";

    const kids = [head, sub];
    if (meters.length) kids.push(mwrap);
    if (chips.length) kids.push(cwrap);
    kids.push(note);
    box.replaceChildren(...kids);
    box.hidden = false;
  }

  // Plain-language "what is this / why does it matter" for each system-health
  // signal, so a chip you tap explains itself instead of assuming you remember the
  // pipeline. Grounded in the real code (see server /api/admin/attention, pooldb,
  // tools/crawl_doors.sh, the retention sweep) — kept honest, not hand-wavy.
  const ATTN_INFO = {
    runway: {
      what: "How many days ahead the daily pick already has a confirmed-playable " +
        "album — a whole-pool aggregate of Deezer availability plus a resolved " +
        "door, cached on the host so it never blocks this page.",
      why: "It's the buffer in front of today. If the runway runs dry, upcoming " +
        "days fall back to unknown/dig instead of a clean, confirmed-playable pick. " +
        "The door crawler is what keeps extending it.",
    },
    spotify: {
      what: "The Spotify-link pulse across the pool: how many days carry a Spotify " +
        "door and how fresh the newest stamp is. Spotify is the one keyed resolver " +
        "— warmed on demand plus a small bounded prewarm, TTL-cached for Terms " +
        "compliance, never in the forever crawl.",
      why: "A stale newest stamp (older than ~a day) means the prewarm is asleep or " +
        "the API quota is blocked, so new days stop getting Spotify doors. Fresh " +
        "means the keyed path is alive.",
    },
    crawler: {
      what: "The always-on door crawler (tools/crawl_doors.sh, a launchd agent) " +
        "warming the calendar one day at a time forever — resolving availability " +
        "and the door, then rsyncing pool.sqlite up to the host.",
      why: "It's the engine behind the runway and the doors. 'ok'/'running' is " +
        "healthy; 'stale' usually means the Mac slept or the push stopped; " +
        "'throttled' means it backed off and will retry. If it stops, availability " +
        "stops growing and links age out.",
    },
    retention: {
      what: "The daily background sweep that enforces the privacy-policy §6 " +
        "retention windows — deleting aged access requests and on-disk feedback. " +
        "(Hosted Supabase feedback is pruned separately by tools/prune_feedback.py " +
        "on the same 180-day window.)",
      why: "The policy states these limits as commitments, so they must actually " +
        "run, not just be promised. A recent stamp proves the sweep ran; a missing " +
        "or old one means the commitment isn't being kept.",
    },
    refresh: {
      what: "Whether the derived catalog has drifted from the newest upstream " +
        "Discogs dump. A cheap weekly probe (tools/refresh_watch.py) compares the " +
        "on-disk vintage against the newest published dump — gz-size delta and days " +
        "elapsed — and stamps its finding for this panel (DATA_REFRESH §6/§7).",
      why: "A full rebuild is the one operation that can cost the crawler's weeks of " +
        "warmed availability, so it's deliberate, never scheduled. This is the " +
        "reminder to look: green = holding is fine; amber = a newer dump is up and " +
        "it's worth running the §2 drift check before deciding to rebuild.",
    },
  };

  // A system-health chip you can tap to dig into what it is and why it matters.
  // It's a <details>: the summary is the label + live status; the body is the
  // explanation. Pull-open, never auto-expands.
  function attnChip(label, cls, text, key) {
    const d = document.createElement("details");
    d.className = "attn-chip " + cls;
    if (key) d.dataset.k = key;   // stable id so a re-poll can restore open state
    const s = document.createElement("summary");
    const k = document.createElement("span");
    k.className = "k";
    k.textContent = label;
    const v = document.createElement("span");
    v.className = "v";
    v.textContent = text;
    s.append(k, v);
    d.append(s);
    const info = ATTN_INFO[key];
    if (info) {
      const body = document.createElement("div");
      body.className = "attn-explain";
      const w1 = document.createElement("b"); w1.textContent = "What this is";
      const p1 = document.createElement("p"); p1.textContent = info.what;
      const w2 = document.createElement("b"); w2.textContent = "Why it matters";
      const p2 = document.createElement("p"); p2.textContent = info.why;
      body.append(w1, p1, w2, p2);
      d.append(body);
    }
    return d;
  }

  const WATCH_LABEL = { due: "Do now", waiting: "Waiting", gated: "Gated", open: "Open" };
  let attnPollTimer = null;   // re-poll while the host computes the runway
  let attnPollTries = 0;

  function watchRow(it) {
    const row = document.createElement("div");
    row.className = "watch-row";
    const b = document.createElement("span");
    b.className = "badge " + it.state;
    b.textContent = WATCH_LABEL[it.state] || it.state;
    if (it.state === "due" && it.days_until < 0) {
      b.textContent = "Do now · " + (-it.days_until) + "d over";
    } else if (it.state === "waiting" && it.days_until != null) {
      b.textContent = "Waiting · " + it.days_until + "d";
    }
    const id = document.createElement("span");
    id.className = "watch-id";
    id.textContent = (it.id || "—") + (it.priority ? " [P" + it.priority + "]" : "");
    const t = document.createElement("span");
    t.textContent = it.title || "";
    row.append(b, id, t);
    const note = it.state === "due" || it.state === "waiting" ? it.why
      : it.state === "gated" ? it.gated_on : null;
    if (note) {
      const n = document.createElement("span");
      n.className = "watch-note";
      n.textContent = "— " + note;
      row.append(n);
    }
    return row;
  }

  async function loadAttention() {
    clearTimeout(attnPollTimer);   // one poll chain, however this was invoked
    const status = $("#attnStatus");
    status.textContent = "Loading…";
    let data;
    try {
      const r = await adminFetch("/api/admin/attention");
      if (!r.ok) {
        status.textContent = r.status === 403
          ? "This account isn't on the operator allow-list (AOTD_OPERATOR_IDS)."
          : "Couldn't load the attention panel (" + r.status + ").";
        return;
      }
      data = await r.json();
    } catch (e) {
      status.textContent = "Couldn't reach the attention endpoint.";
      return;
    }
    capacityData.attn = data;
    renderCapacity();
    const chips = [];
    const av = data.availability || {};
    if (av.error) {
      chips.push(attnChip("Availability runway", "bad", av.error, "runway"));
    } else if (av.state === "computing") {
      // First hit after a deploy/restart: the whole-pool aggregate is running
      // in the background on the host. Re-poll quietly until it lands.
      chips.push(attnChip("Availability runway", "warn",
        "computing on the host — refreshes itself in a moment", "runway"));
      if (attnPollTries < 10) {
        attnPollTries += 1;
        clearTimeout(attnPollTimer);
        attnPollTimer = setTimeout(loadAttention, 8000);
      }
    } else {
      attnPollTries = 0;
      const days = av.runway_days == null ? 0 : av.runway_days;
      chips.push(attnChip("Availability runway",
        days >= 14 ? "ok" : days >= 3 ? "warn" : "bad",
        days + " days ahead (through " + (av.runway_end || "—") + ") · "
          + av.warm_days + "/" + av.total_days + " days warm", "runway"));
    }
    const sp = data.spotify || {};
    if (sp.error) {
      chips.push(attnChip("Spotify links", "bad", sp.error, "spotify"));
    } else {
      const fresh = sp.newest_age_hours != null && sp.newest_age_hours <= 26;
      const cls = !sp.stamped ? "warn" : fresh ? "ok" : "bad";
      chips.push(attnChip("Spotify links", cls,
        sp.stamped + " stamped · " + sp.stamped_24h + " in 24 h · newest "
          + (sp.newest_age_hours == null ? "never" : sp.newest_age_hours + " h ago")
          + (cls === "bad" ? " — quota block or prewarm asleep?" : ""), "spotify"));
    }
    const cr = data.crawl || {};
    chips.push(attnChip("Door crawler",
      cr.error ? "bad"
        : (cr.health === "ok" || cr.health === "running") ? "ok"
          : cr.health === "never" ? "warn" : "bad",
      cr.error || (CRAWL_LABEL[cr.health] || cr.health || "?")
        + (cr.day ? " · day " + cr.day : "")
        + (cr.age_seconds != null ? " · " + relTime(cr.age_seconds) : ""), "crawler"));
    const rt = data.retention || {};
    chips.push(attnChip("Retention sweep",
      rt.error ? "bad" : rt.ran_at == null ? "warn"
        : rt.age_hours != null && rt.age_hours <= 48 ? "ok" : "bad",
      rt.error || (rt.ran_at == null ? "no stamp yet (pre-H4 build, or sweep off)"
        : "ran " + (rt.age_hours != null ? rt.age_hours + " h ago" : rt.ran_at)),
      "retention"));
    // Refresh-drift reminder: green while holding is fine, amber when a newer dump
    // is up and past threshold (DATA_REFRESH §6/§7). Never bad — a missed weekly
    // probe or a failed network probe is just "warn/check", not a pipeline fault.
    const rw = data.refresh || {};
    const rwChecked = rw.checked_age_hours != null
      ? rw.checked_age_hours + " h ago" : (rw.checked_at || "—");
    if (rw.error) {
      chips.push(attnChip("Refresh drift", "warn", rw.error, "refresh"));
    } else if (rw.checked_at == null) {
      chips.push(attnChip("Refresh drift", "warn",
        "no check yet — run tools/refresh_watch.py", "refresh"));
    } else if (rw.probe_ok === false) {
      chips.push(attnChip("Refresh drift", "warn",
        "probe couldn't reach the dump host · checked " + rwChecked, "refresh"));
    } else {
      const bits = [rw.threshold_crossed ? "worth a look" : "holding"];
      if (rw.current_vintage) bits.push(rw.current_vintage + " vintage");
      if (rw.newer_available && rw.gz_delta_pct != null) {
        bits.push("+" + rw.gz_delta_pct + "% gz");
      }
      if (rw.days_since_vintage != null) bits.push(rw.days_since_vintage + "d old");
      bits.push("checked " + rwChecked);
      chips.push(attnChip("Refresh drift", rw.threshold_crossed ? "warn" : "ok",
        bits.join(" · "), "refresh"));
    }
    // Carry over which chips the operator had expanded — otherwise the computing-
    // runway re-poll (every 8 s) or a manual refresh snaps them all shut.
    const strip = $("#attnStrip");
    const openKeys = new Set(
      Array.from(strip.querySelectorAll(".attn-chip[open]"), (d) => d.dataset.k));
    for (const c of chips) if (openKeys.has(c.dataset.k)) c.open = true;
    strip.replaceChildren(...chips);
    // System-health dot + label = worst of the pipeline signals. Green stays quiet
    // and collapsed ("all green"); a warn/bad signal colours the disclosure dot AND
    // the Summary tab dot (setHealth "attention" → the Summary tab), so you know to
    // look without anything expanding on its own.
    const states = chips.map((c) => (c.className.split(" ")[1] || "ok"));
    const worst = states.indexOf("bad") >= 0 ? "bad"
      : states.indexOf("warn") >= 0 ? "warn" : "ok";
    const nonOk = states.filter((s) => s !== "ok").length;
    const dotEl = $("#attnDot"); if (dotEl) dotEl.className = "dot " + worst;
    const lblEl = $("#sysLabel");
    if (lblEl) lblEl.textContent = nonOk === 0 ? "all green" : nonOk + " to check";
    setHealth("attention", { label: "System", value: nonOk === 0 ? "ok" : "look", state: worst });

    // Backlog (watch-list) lives on its own tab now. Its tab dot goes red only when
    // something is actually due; otherwise it just reports how many are open.
    const wl = data.watchlist || [];
    $("#attnWatch").replaceChildren(...wl.map(watchRow));
    const due = wl.filter((it) => it.state === "due").length;
    status.textContent = data.watchlist_error
      ? "Watch-list unavailable: " + data.watchlist_error
      : wl.length + " open backlog item" + (wl.length === 1 ? "" : "s")
        + " · machine state as of " + (data.generated_at || "now");
    setHealth("backlog", {
      label: "Backlog",
      value: due > 0 ? due + " due" : wl.length + " open",
      state: due > 0 ? "bad" : "ok",
    });
  }

  async function loadCrawlStatus() {
    const badge = $("#crawlBadge");
    const line = $("#crawlStatus");
    badge.className = "badge";
    badge.textContent = "";
    line.textContent = "Loading crawler status…";
    let data;
    try {
      const { data: sess } = await supa.auth.getSession();
      const token = sess && sess.session && sess.session.access_token;
      const r = await fetch("/api/admin/crawl-status", {
        headers: token ? { Authorization: "Bearer " + token } : {},
      });
      if (!r.ok) {
        line.textContent = r.status === 403
          ? "This account isn't on the operator allow-list (AOTD_OPERATOR_IDS)."
          : "Couldn't load crawler status (" + r.status + ").";
        return;
      }
      data = await r.json();
    } catch (e) {
      line.textContent = "Couldn't reach the crawler-status endpoint.";
      return;
    }
    const health = data.health || "never";
    badge.classList.add(health);
    badge.textContent = CRAWL_LABEL[health] || health;
    line.classList.toggle("attention", !!CRAWL_ATTENTION[health]);
    setHealth("crawler", {
      label: "Crawler", value: CRAWL_LABEL[health] || health,
      state: (health === "ok" || health === "running") ? "ok"
        : health === "never" ? "warn" : "bad",
    });
    const hb = data.heartbeat;
    if (!hb) {
      line.textContent = data.detail
        ? "Status read failed: " + data.detail
        : "No heartbeat yet — the crawler hasn't run, or this pool.sqlite " +
          "predates the heartbeat. Start it with tools/crawl_doors.sh.";
      return;
    }
    const verb = health === "running" ? "updated" : "last ran";
    const bits = [verb + " " + relTime(data.age_seconds), "day " + (hb.day || "—")];
    // Progress fraction while a day is in flight.
    if (health === "running" && hb.total) {
      const pct = Math.round((hb.seen / hb.total) * 100);
      bits.push(hb.seen + "/" + hb.total + " (" + pct + "%)");
    }
    bits.push("ok " + hb.ok + " · miss " + hb.miss + " · err " + hb.err);
    if (hb.err > 0 && health !== "throttled") {
      bits.push("⚠ " + hb.err + " error" + (hb.err === 1 ? "" : "s") +
        " (will retry)");
    }
    if (health === "throttled") {
      bits.push("⚠ stopped on a throttle/network abort — retries the same day " +
        "after cooldown");
    } else if (health === "stale") {
      bits.push("⚠ went quiet — the Mac may be asleep, the crawler stopped, or " +
        "the push/rsync isn't running");
    }
    line.textContent = bits.join(" · ");
  }

  async function loadAccessRequests() {
    $("#reqStatus").textContent = "Loading access requests…";
    const { data, error } = await supa
      .from("access_requests")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) {
      reqRows = [];
      $("#reqList").innerHTML = "";
      $("#reqCounts").textContent = "";
      $("#reqStatus").textContent =
        "Couldn't load access requests: " + (error.message || error) +
        " — is the 0003 admin-read policy applied (run 0002 first, then re-run 0003)?";
      return;
    }
    reqRows = data || [];
    $("#reqStatus").textContent = "";
    const newReqs = reqRows.filter((r) => (r.status || "new") === "new").length;
    setHealth("requests", {
      label: "Requests", value: newReqs + " new",
      state: newReqs > 0 ? "warn" : "ok",
    });
    drawRequests();
  }

  function visibleReqRows() {
    const f = $("#reqFilter").value;
    if (f === "all") return reqRows;
    return reqRows.filter((r) => (r.status || "new") === f);
  }

  function drawRequests() {
    const counts = { new: 0, invited: 0, declined: 0 };
    for (const r of reqRows) {
      const s = r.status || "new";
      if (counts[s] != null) counts[s]++;
    }
    $("#reqCounts").innerHTML =
      "<b>" + counts.new + "</b> new · <b>" + counts.invited + "</b> invited · <b>" +
      counts.declined + "</b> declined";

    const list = $("#reqList");
    list.innerHTML = "";
    const rows = visibleReqRows();
    if (!reqRows.length) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "No access requests yet — or this account isn't on the operator allow-list (app_admins).";
      list.appendChild(p);
      return;
    }
    if (!rows.length) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "Nothing matches this filter.";
      list.appendChild(p);
      return;
    }

    for (const r of rows) {
      const card = document.createElement("div");
      card.className = "card req";

      const top = document.createElement("div");
      top.className = "row-top";
      const email = document.createElement("span");
      email.className = "email";
      email.textContent = r.email || "(no email)";   // textContent: no injection
      top.appendChild(email);
      const badge = document.createElement("span");
      const st = r.status || "new";
      badge.className = "badge " + st;
      badge.textContent = st;
      top.appendChild(badge);
      card.appendChild(top);

      const meta = document.createElement("div");
      meta.className = "meta";
      const when = r.created_at ? new Date(r.created_at).toLocaleString() : "(no date)";
      const upd = r.updated_at && r.updated_at !== r.created_at
        ? " · updated " + new Date(r.updated_at).toLocaleString() : "";
      meta.textContent = "requested " + when + upd;
      card.appendChild(meta);

      if (r.note) {
        const note = document.createElement("div");
        note.className = "note";
        note.textContent = r.note;                   // textContent: no injection
        card.appendChild(note);
      }

      if (r.user_agent) {
        const ua = document.createElement("div");
        ua.className = "ua";
        ua.textContent = r.user_agent;
        card.appendChild(ua);
      }

      const actions = document.createElement("div");
      actions.className = "req-actions";
      const feedback = document.createElement("span");
      feedback.className = "copied";

      // Status-shaped actions: new → approve/decline, declined → approve
      // (change of heart), invited → just the mail link (revoking an invite is
      // an allow-list delete — deliberately left to the SQL editor, 0004 §5).
      if (st !== "invited") {
        const approve = document.createElement("button");
        approve.className = "primary";
        approve.textContent = "✓ Approve & invite";
        approve.title = "Adds this email to invited_emails and marks the request invited (one click; migration 0005).";
        approve.addEventListener("click", () => approveRequest(r, feedback));
        actions.appendChild(approve);
      }
      if (st === "new") {
        const decline = document.createElement("button");
        decline.textContent = "Decline";
        decline.title = "Marks the request declined. It ages out of the store on the retention window.";
        decline.addEventListener("click", () => declineRequest(r, feedback));
        actions.appendChild(decline);
      }
      if (st === "invited" && r.email) {
        actions.appendChild(mailtoLink(normEmail(r.email)));
      }

      actions.appendChild(feedback);
      card.appendChild(actions);

      list.appendChild(card);
    }
  }

  function wireRequests() {
    $("#reqFilter").addEventListener("change", () => drawRequests());
    $("#reqRefresh").addEventListener("click", () => loadAccessRequests());
    $("#crawlRefresh").addEventListener("click", () => loadCrawlStatus());
    $("#attnRefresh").addEventListener("click", () => loadAttention());
    $("#poolRefresh").addEventListener("click", () => loadPool());
    $("#backlogRefresh").addEventListener("click", () => loadAttention());
    $("#costRefresh").addEventListener("click", () => loadCost());
    $("#usageRefresh").addEventListener("click", () => loadUsage());
  }

  function wireToolbar() {
    $("#filter").addEventListener("change", () => applyAndDraw());
    // Clear done: forget the items already marked Done, for good — the targeted
    // alternative to "Reset triage" that leaves your keep/skip marks untouched. It
    // moves them to the `dismissed` store so they never resurface as untriaged.
    $("#clearDone").addEventListener("click", () => {
      const keys = currentRows.filter((r) => tOf(r).done && !dismissed[tKey(r)]).map(tKey);
      if (!keys.length) { setStatus("No done items to clear."); return; }
      if (!confirm("Permanently forget " + keys.length + " done item"
          + (keys.length === 1 ? "" : "s") + " in this browser? They won't come back, "
          + "and your keep/skip marks on everything else stay.")) return;
      for (const k of keys) { dismissed[k] = 1; delete triage[k]; }
      saveDismissed(); saveTriage(); applyAndDraw();
      setStatus("Cleared " + keys.length + " done item" + (keys.length === 1 ? "" : "s") + ".");
    });
    $("#reset").addEventListener("click", () => {
      if (confirm("Clear all keep/skip/done marks and notes saved in this browser? "
          + "(Items you already 'cleared' stay cleared.)")) {
        triage = {}; saveTriage(); applyAndDraw();
      }
    });
    $("#export").addEventListener("click", () => { exportBundle(); });
  }

  function wireLogin() {
    // Same-account sign-in as the main site: Google OAuth (a full-page redirect back
    // to /admin, where detectSessionInUrl picks up the ?code=), with the magic link
    // kept as a fallback. The provider must be enabled in Supabase and this page's URL
    // (origin + /admin) allow-listed under Authentication -> URL Configuration.
    const gbtn = $("#googleSignin");
    if (gbtn) gbtn.addEventListener("click", async () => {
      $("#loginStatus").textContent = "Redirecting to Google…";
      try {
        const { error } = await supa.auth.signInWithOAuth({
          provider: "google",
          options: { redirectTo: location.origin + location.pathname },
        });
        if (error) throw error;
        // navigation happens; the page reloads on the provider's redirect back.
      } catch (e) {
        $("#loginStatus").textContent =
          "Couldn't start Google sign-in: " + (e.message || e);
      }
    });
    $("#sendlink").addEventListener("click", async () => {
      const email = ($("#email").value || "").trim();
      if (!email) { $("#loginStatus").textContent = "Enter your email."; return; }
      $("#loginStatus").textContent = "Sending…";
      const redirect = location.origin + location.pathname;
      const { error } = await supa.auth.signInWithOtp({
        email, options: { emailRedirectTo: redirect, shouldCreateUser: false },
      });
      $("#loginStatus").textContent = error
        ? "Couldn't send: " + (error.message || error)
        : "Check your email for the link.";
    });
    $("#signout").addEventListener("click", async () => {
      try { await supa.auth.signOut(); } catch (e) {}
      await render();
    });
  }

  wireLogin();
  wireToolbar();
  wireRequests();
  wireTabs();
  boot();
})();
