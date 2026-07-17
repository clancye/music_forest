(function () {
  "use strict";
  var CVAR = { strong:"--q-strong", teal:"--q-teal", amber:"--q-amber2", orange:"--q-orange",
    red:"--q-red", slate:"--q-slate", violet:"--q-violet" };
  function cvar(k){ return getComputedStyle(document.documentElement).getPropertyValue(CVAR[k]||"--q-slate").trim(); }

  // Display config: server owns the dimension order + which one splits next; the
  // page owns labels + colours. Values match the server's entity_quality strings.
  var DIMS = {
    date_agreement: { label:"Release-date agreement", blurb:"Do the sources agree on the original date?",
      values:{ agree:{l:"Dates agree",c:"strong",note:"Sources land on the same original date."},
        sameyear:{l:"Same year, off day",c:"amber",note:"Same year, different day — a DQ2-class wobble."},
        diffyear:{l:"Different year",c:"red",note:"Sources disagree on the year — the DQ-class tail."},
        single:{l:"Single source",c:"slate",note:"Only one source dates it — nothing to cross-check."} } },
    sources: { label:"Contributing sources", blurb:"Which catalogs fold into this album.",
      values:{ both:{l:"Discogs + MusicBrainz",c:"strong",note:"Both major catalogs corroborate it."},
        mb:{l:"MusicBrainz only",c:"violet",note:"Present only in MusicBrainz."},
        discogs:{l:"Discogs only",c:"teal",note:"Present only in Discogs."},
        bandcamp:{l:"+ Bandcamp",c:"amber",note:"A third source corroborates."} } },
    releases: { label:"Releases / pressings", blurb:"How many source releases collapse into this album.",
      values:{ "1":{l:"1 release",c:"slate",note:"A single pressing."}, "2-5":{l:"2–5",c:"teal",note:"A handful."},
        "6-20":{l:"6–20",c:"strong",note:"Well-repressed."}, "21+":{l:"21+",c:"violet",note:"Heavily repressed."} } },
    name_agreement: { label:"Artist-name agreement", blurb:"Do the sources spell the artist the same way?",
      values:{ consistent:{l:"Consistent",c:"strong",note:"Every source spells the artist the same."},
        minor:{l:"Minor variants",c:"amber",note:"Punctuation / accents / spacing differ."},
        conflict:{l:"Conflicting",c:"red",note:"Genuinely different names — possible mis-merge."} } },
    confidence: { label:"Match confidence", blurb:"How corroborated the album is.",
      values:{ high:{l:"High",c:"strong",note:"UPC/high-tier corroborated across sources."},
        review:{l:"Needs review",c:"amber",note:"Gray-zone match."},
        single:{l:"Single source",c:"slate",note:"No cross-source corroboration."},
        conflict:{l:"Conflicting",c:"red",note:"Sources disagree on identity."} } }
  };
  function vdisp(dim, v){ return (DIMS[dim] && DIMS[dim].values[v]) || {l:v, c:"slate", note:""}; }

  var stage = document.getElementById("ccStage"), tip = document.getElementById("ccTip");
  var path = [];              // [[dimKey, value], ...]
  var lastBlocks = [], focusIdx = 0, token = null, seq = 0;
  function fmt(n){ return (n||0).toLocaleString(); }

  function authFetch(url){
    var h = token ? { Authorization: "Bearer " + token } : {};
    return fetch(url, { headers: h }).then(function(r){ return r.json(); });
  }
  async function initAuth(){
    try {
      var cfg = await fetch("/api/public-config").then(function(r){ return r.json(); });
      if (window.supabase && cfg && cfg.supabase_url) {
        var supa = supabase.createClient(String(cfg.supabase_url).trim(),
          String(cfg.anon_key || "").trim(), { auth: { persistSession: true } });
        var s = await supa.auth.getSession();
        token = s && s.data && s.data.session ? s.data.session.access_token : null;
      }
    } catch (e) { /* local dev: auth not enforced, endpoint accepts anyway */ }
  }

  async function render(){
    if (stage.clientWidth < 1 || stage.clientHeight < 1) return;   // wait for layout
    var mySeq = ++seq;
    var level;
    try { level = await authFetch("/api/admin/catalog-quality?f=" + encodeURIComponent(JSON.stringify(path))); }
    catch (e) { if (mySeq === seq) msg("Couldn’t reach the catalog endpoint."); return; }
    if (mySeq !== seq) return;                                     // a newer drill won — don't clobber
    renderCrumbs();
    if (!level || !level.available) {
      msg(level && level.detail ? esc(level.detail)
        : "No resolved catalog on this host yet. Run <code>tools/resolve_catalog_fields.py</code>, or sign in as an operator.");
      document.getElementById("ccSplit").textContent = "";
      document.getElementById("ccCount").textContent = "";
      document.getElementById("ccLegend").innerHTML = "";
      return;
    }
    if (level.leaf) { renderLeaf(level); renderContext(level, null); renderLegend(null); return; }
    renderBlocks(level); renderContext(level, level.dim); renderLegend(level);
  }

  function msg(html){ stage.innerHTML = '<div class="cc-msg">' + html + '</div>'; lastBlocks = []; }

  function renderBlocks(level){
    stage.innerHTML = ""; lastBlocks = [];
    var W = stage.clientWidth, H = stage.clientHeight;
    var rects = squarify(level.blocks.map(function(b){ return { value:b.value, count:b.count }; }), {x:0,y:0,w:W,h:H});
    var map = document.createElement("div"); map.className = "cc-map";
    rects.forEach(function(r, i){
      var b = r.ref, d = vdisp(level.dim, b.value), col = cvar(d.c);
      var el = document.createElement("button");
      el.type = "button"; el.className = "cc-block";
      if (r.w < 96 || r.h < 54) el.classList.add("is-tiny");
      el.style.left = r.x+"px"; el.style.top = r.y+"px"; el.style.width = (r.w-3)+"px"; el.style.height = (r.h-3)+"px";
      el.style.background = col;
      var pct = Math.round(b.count / level.total * 100);
      el.innerHTML = '<span class="bl-label">'+esc(d.l)+'</span><span class="bl-count">'+fmt(b.count)+
        '</span><span class="bl-pct">'+pct+'% of view</span><span class="bl-drill">drill ↳</span>';
      el.setAttribute("aria-label", d.l+", "+fmt(b.count)+" albums, "+pct+" percent. "+d.note+" Activate to drill in.");
      el.dataset.cx = r.x + r.w/2; el.dataset.cy = r.y + r.h/2;
      el.addEventListener("click", function(){ drill(level.dim, b.value); });
      el.addEventListener("mouseenter", function(e){ showTip(e, level.dim, b, level.total); });
      el.addEventListener("mousemove", moveTip);
      el.addEventListener("mouseleave", hideTip);
      el.addEventListener("focus", function(){ focusIdx = i; var rc = el.getBoundingClientRect(); showTipAt(rc.left+12, rc.top+12, level.dim, b, level.total); });
      el.addEventListener("blur", hideTip);
      map.appendChild(el); lastBlocks.push(el);
    });
    stage.appendChild(map);
    focusIdx = Math.min(focusIdx, lastBlocks.length - 1);
  }

  function renderLeaf(level){
    var leaf = document.createElement("div"); leaf.className = "cc-leaf";
    var head = '<div class="cc-leaf-head">';
    path.forEach(function(p){ var d = vdisp(p[0], p[1]);
      head += '<span class="cc-leg-item"><span class="swatch" style="background:'+cvar(d.c)+'"></span>'+
        esc(DIMS[p[0]] ? DIMS[p[0]].label : p[0])+': <b style="margin-left:2px">'+esc(d.l)+'</b></span>'; });
    head += '</div>';
    var tiles = '<div class="cc-tiles">' + (level.items||[]).map(function(it){
      return '<div class="cc-tile"><span class="t-artist">'+esc(it.artist||"—")+
        '</span><span class="t-title">'+esc(it.title||"")+'</span></div>'; }).join("") + '</div>';
    var more = level.more > 0
      ? '<div class="cc-more"><b>+'+fmt(level.more)+'</b> more — these '+fmt(level.total)+
        ' are identical on every tracked dimension, so there’s nothing left to split them by.</div>' : '';
    stage.innerHTML = ""; leaf.innerHTML = head + tiles + more; stage.appendChild(leaf); lastBlocks = [];
  }

  function renderContext(level, dim){
    var el = document.getElementById("ccSplit");
    if (dim) el.innerHTML = 'Splitting by <b>'+esc(DIMS[dim].label)+'</b> — <span class="hint">'+esc(DIMS[dim].blurb)+'</span>';
    else el.innerHTML = '<b>Leaf.</b> <span class="hint">Every album here is identical on all tracked dimensions.</span>';
    document.getElementById("ccCount").innerHTML = '<b>'+fmt(level.total)+'</b> albums in view';
  }

  function renderLegend(level){
    var el = document.getElementById("ccLegend");
    if (!level || !level.dim) { el.innerHTML = ""; return; }
    var html = '<span class="lg-title">'+esc(DIMS[level.dim].label)+'</span>';
    level.blocks.forEach(function(b){ var d = vdisp(level.dim, b.value);
      html += '<span class="cc-leg-item"><span class="sw" style="background:'+cvar(d.c)+'"></span>'+esc(d.l)+' <span class="n">'+fmt(b.count)+'</span></span>'; });
    el.innerHTML = html;
  }

  function renderCrumbs(){
    var el = document.getElementById("ccCrumbs");
    var html = '<button class="cc-crumb cc-crumb--root" data-i="-1" type="button">Root</button>';
    path.forEach(function(p, i){ var d = vdisp(p[0], p[1]);
      html += '<span class="cc-sep">›</span><button class="cc-crumb" data-i="'+i+'" type="button">'+
        '<span class="dot" style="background:'+cvar(d.c)+'"></span><span class="k">'+esc(DIMS[p[0]] ? DIMS[p[0]].label : p[0])+'</span> '+esc(d.l)+'</button>'; });
    el.innerHTML = html;
    Array.prototype.forEach.call(el.querySelectorAll(".cc-crumb"), function(btn){
      btn.addEventListener("click", function(){ var i = +btn.dataset.i; path = i < 0 ? [] : path.slice(0, i+1); focusIdx = 0; render(); }); });
  }

  function drill(dim, v){ path.push([dim, v]); focusIdx = 0; render().then(function(){ if (lastBlocks[0]) lastBlocks[0].focus(); }); }

  function tipHTML(dim, b, total){
    var d = vdisp(dim, b.value), pct = Math.round(b.count/total*100);
    var p = path.map(function(x){ return (DIMS[x[0]] ? DIMS[x[0]].label : x[0]) + ": " + vdisp(x[0], x[1]).l; }).join(" · ") || "all albums";
    return '<div class="tp-head"><span class="tp-sw" style="background:'+cvar(d.c)+'"></span><span class="tp-label">'+esc(d.l)+
      '</span><span class="tp-count">'+fmt(b.count)+' · '+pct+'%</span></div><div class="tp-blurb">'+esc(d.note)+
      '</div><div class="tp-blurb" style="margin-top:6px;border-top:1px solid var(--line);padding-top:6px">In view: '+esc(p)+'</div>';
  }
  function showTip(e, dim, b, total){ tip.innerHTML = tipHTML(dim, b, total); tip.classList.add("on"); moveTip(e); }
  function showTipAt(x, y, dim, b, total){ tip.innerHTML = tipHTML(dim, b, total); tip.classList.add("on"); place(x, y); }
  function moveTip(e){ place(e.clientX+14, e.clientY+16); }
  function place(x, y){ var w = tip.offsetWidth, h = tip.offsetHeight; tip.style.left = Math.min(x, innerWidth-w-8)+"px"; tip.style.top = Math.min(y, innerHeight-h-8)+"px"; }
  function hideTip(){ tip.classList.remove("on"); }
  function esc(s){ return String(s == null ? "" : s).replace(/[&<>"]/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]; }); }

  function squarify(data, rect){
    var items = data.map(function(d){ return { ref:d, area:d.count }; });
    var total = 0; items.forEach(function(i){ total += i.area; });
    if (total <= 0) return [];
    var f = (rect.w*rect.h)/total; items.forEach(function(i){ i.area *= f; });
    items.sort(function(a,b){ return b.area-a.area; });
    var out = [], free = {x:rect.x,y:rect.y,w:rect.w,h:rect.h}, row = [], rem = items.slice();
    function sum(r){ var s=0; r.forEach(function(x){ s+=x.area; }); return s; }
    function worst(r, len){ if(!r.length) return Infinity; var s=sum(r), mx=-Infinity, mn=Infinity; r.forEach(function(x){ if(x.area>mx)mx=x.area; if(x.area<mn)mn=x.area; }); return Math.max((len*len*mx)/(s*s),(s*s)/(len*len*mn)); }
    function layout(r){ var s=sum(r); if(free.w>=free.h){ var cw=s/free.h, y=free.y; r.forEach(function(x){ var hh=x.area/cw; out.push({ref:x.ref,x:free.x,y:y,w:cw,h:hh}); y+=hh; }); free={x:free.x+cw,y:free.y,w:free.w-cw,h:free.h}; } else { var rh=s/free.w, x2=free.x; r.forEach(function(x){ var ww=x.area/rh; out.push({ref:x.ref,x:x2,y:free.y,w:ww,h:rh}); x2+=ww; }); free={x:free.x,y:free.y+rh,w:free.w,h:free.h-rh}; } }
    while (rem.length){ var len=Math.min(free.w,free.h); if(!row.length || worst(row,len) >= worst(row.concat([rem[0]]),len)){ row.push(rem.shift()); } else { layout(row); row=[]; } }
    if (row.length) layout(row);
    return out;
  }

  document.getElementById("ccReset").addEventListener("click", function(){ path = []; focusIdx = 0; render(); });
  document.getElementById("ccTheme").addEventListener("click", function(){
    var root = document.documentElement, cur = root.getAttribute("data-theme");
    if (!cur) cur = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    root.setAttribute("data-theme", cur === "dark" ? "light" : "dark"); render();
  });
  document.addEventListener("keydown", function(e){
    if (e.key === "Escape" || e.key === "Backspace") { if (path.length){ e.preventDefault(); path.pop(); focusIdx = 0; render().then(function(){ if (lastBlocks[0]) lastBlocks[0].focus(); }); } return; }
    if (!lastBlocks.length) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (lastBlocks[focusIdx]) lastBlocks[focusIdx].click(); return; }
    var dirs = { ArrowLeft:[-1,0], ArrowRight:[1,0], ArrowUp:[0,-1], ArrowDown:[0,1] };
    if (dirs[e.key]) { e.preventDefault(); moveFocus(dirs[e.key]); }
  });
  function moveFocus(d){
    var cur = lastBlocks[focusIdx]; if (!cur){ if(lastBlocks[0]) lastBlocks[0].focus(); return; }
    var cx = +cur.dataset.cx, cy = +cur.dataset.cy, best = -1, bs = Infinity;
    lastBlocks.forEach(function(b, i){ if (i === focusIdx) return; var dx = +b.dataset.cx-cx, dy = +b.dataset.cy-cy, along = dx*d[0]+dy*d[1]; if (along <= 0) return; var perp = Math.abs(dx*d[1]-dy*d[0]), sc = along+perp*2; if (sc < bs){ bs = sc; best = i; } });
    if (best >= 0){ focusIdx = best; lastBlocks[best].focus(); }
  }

  var rt; function scheduleRender(){ clearTimeout(rt); rt = setTimeout(render, 60); }
  if (window.ResizeObserver) new ResizeObserver(scheduleRender).observe(stage);
  window.addEventListener("resize", scheduleRender);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
  initAuth().then(function(){ requestAnimationFrame(render); });
})();
