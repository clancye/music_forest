/* UC1 Phase 2 precision gate — operator labeling console (admin sub-page).
 *
 * Fetches the precomputed sample (/api/admin/precision-sample) and the operator's
 * saved verdicts (/api/admin/precision-labels), renders one card per merged cluster
 * with both members + a side-by-side tracklist compare, and POSTs each same|diff|
 * partial verdict back so it syncs across devices (label on desktop, finish on mobile).
 * Reuses the admin Supabase session for the operator bearer token (external script:
 * the admin CSP forbids inline JS). All logic here; markup + styles in the .html. */
(function(){
  "use strict";
  var token = null;
  var DATA = null, CL = [], POP = {}, totalPop = 0;
  var labels = {}, filter = "all", cur = 0;
  var chipNodes = {};

  var el = function(id){ return document.getElementById(id); };
  var esc = function(s){ return (s==null?"":String(s)).replace(/[&<>"]/g,function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]; }); };
  var meta = function(m){ return [m.date||"—", (m.tracks!=null?m.tracks+" trk":"? trk"), m.label||"—"]; };

  // ---- tracklist comparison (all data local — no external requests) ----
  var ntitle = function(s){ return (s||"").toLowerCase().replace(/[^\p{L}\p{N}]+/gu,""); };
  function trackDiff(members){
    var sets = members.map(function(m){ return new Set((m.tracklist||[]).map(function(t){ return ntitle(t.t); }).filter(Boolean)); });
    if(sets.some(function(s){ return s.size===0; })) return null;
    var shared = new Set([...sets[0]].filter(function(x){ return sets.every(function(s){ return s.has(x); }); }));
    var uniq = sets.map(function(s){ return [...s].filter(function(x){ return !shared.has(x); }).length; });
    return { shared: shared, sharedCount: shared.size, uniq: uniq };
  }
  var SRC = function(m){ return m.source==="discogs" ? "Discogs" : "MB"; };
  function tracklistHTML(c){
    var d = trackDiff(c.members), sum;
    if(!d){ sum = '<span class="dim">tracklist not available on one side — use the source links</span>'; }
    else {
      var parts = ['<b class="sh">'+d.sharedCount+'</b> shared'];
      c.members.forEach(function(m,i){ if(d.uniq[i]>0) parts.push('<b class="uq">'+d.uniq[i]+'</b> only on '+SRC(m)); });
      sum = '<span class="tl-sum'+(d.sharedCount===0?' none':'')+'">'+parts.join(' · ')+'</span>';
    }
    var cols = c.members.map(function(m){
      var rows = (m.tracklist||[]).map(function(t,i){
        var uq = d && !d.shared.has(ntitle(t.t));
        return '<li class="'+(uq?'uniq':'')+'"><span class="tn">'+(i+1)+'</span><span class="tt">'+(esc(t.t)||"—")+'</span>'+(t.d?'<span class="td">'+esc(t.d)+'</span>':'')+'</li>';
      }).join("") || '<li class="dim">no tracklist stored</li>';
      return '<div class="tl-col"><div class="tl-head"><span class="src '+(m.source==="discogs"?"dg":"mb")+'">'+(m.source==="discogs"?"DG":"MB")+'</span>'+(m.tracklist||[]).length+' tracks</div><ol class="tl-list">'+rows+'</ol></div>';
    }).join("");
    return '<div class="tl-wrap"><button class="tl-btn" type="button" aria-expanded="false">Compare tracklists <span class="chev">⌄</span> <kbd>X</kbd></button>'+sum+
      '<div class="tl-panel" hidden><div class="tl-cols">'+cols+'</div></div></div>';
  }

  function wilson(k,n){ if(!n) return [0,0,0]; var z=1.96,p=k/n,d=1+z*z/n;
    var c=(p+z*z/(2*n))/d, h=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d;
    return [p, Math.max(0,c-h), Math.min(1,c+h)]; }
  var pct = function(x){ return (x*100).toFixed(1)+"%"; };

  // ---- render ----
  function memberHTML(m){
    var sc = m.scored_title ? '<div class="m-scored"><span>scored as </span>'+esc(m.scored_title)+'</div>' : '';
    var t = esc(m.title)||"—";
    var src = m.source==="discogs"?"Discogs":"MusicBrainz";
    var title = m.url
      ? '<a class="m-title" href="'+esc(m.url)+'" target="_blank" rel="noopener noreferrer" title="Open on '+src+'"><span class="t">'+t+'</span><span class="ext">↗</span></a>'
      : '<div class="m-title">'+t+'</div>';
    var open = m.url ? '<div class="m-open"><a href="'+esc(m.url)+'" target="_blank" rel="noopener noreferrer">investigate on '+src+' ↗</a></div>' : '';
    return '<div class="member"><div class="m-artist"><span class="src '+(m.source==="discogs"?"dg":"mb")+'">'+(m.source==="discogs"?"DG":"MB")+'</span>'+(esc(m.artist)||"—")+'</div>'+
      title+sc+
      '<div class="m-meta">'+meta(m).map(esc).join('<span style="opacity:.4">·</span> ')+'</div>'+open+'</div>';
  }
  function cardHTML(c){
    var v = labels[c.cluster_id]||"";
    var conf = c.min_confidence!=null?c.min_confidence.toFixed(4):"—";
    return '<article class="card" data-cid="'+c.cluster_id+'" data-v="'+v+'" data-stratum="'+c.stratum+'">'+
      '<div class="card-head"><span class="tag '+(c.size>2?"warn":"")+'">size '+c.size+'</span>'+
      '<span class="conf">min conf <b>'+conf+'</b></span>'+
      '<span class="idx">'+c.cluster_id.slice(0,10)+'</span></div>'+
      '<div class="members">'+c.members.map(memberHTML).join("")+'</div>'+
      tracklistHTML(c)+
      '<div class="verdicts">'+
      '<button class="v-btn same" data-v="same">Same album <kbd>S</kbd></button>'+
      '<button class="v-btn partial" data-v="partial">Partial <kbd>P</kbd></button>'+
      '<button class="v-btn diff" data-v="diff">Different <kbd>D</kbd></button>'+
      '</div></article>';
  }
  function visible(){ return CL.filter(function(c){
    var v = labels[c.cluster_id]||"";
    if(filter==="all") return true;
    if(filter==="unlabeled") return !v;
    if(["2","3","4+"].indexOf(filter)>=0) return c.stratum===filter;
    return v===filter; }); }
  function render(){
    var vis = visible();
    el("list").innerHTML = vis.map(cardHTML).join("");
    el("empty").hidden = vis.length>0;
    if(cur>=vis.length) cur = Math.max(0,vis.length-1);
    markCurrent();
  }
  function cards(){ return [].slice.call(document.querySelectorAll(".card")); }
  function markCurrent(){ cards().forEach(function(n,k){ n.classList.toggle("cur",k===cur); }); }

  // ---- stats ----
  function stats(){
    var by = {}; ["2","3","4+"].forEach(function(s){ by[s]={same:0,diff:0,partial:0}; });
    var same=0,diff=0,partial=0;
    CL.forEach(function(c){ var v=labels[c.cluster_id]; if(!v) return;
      by[c.stratum][v]++; if(v==="same")same++; else if(v==="diff")diff++; else partial++; });
    var n = same+diff+partial, w = wilson(same,n), p=w[0],lo=w[1],hi=w[2];
    var wn=0,wd=0;
    ["2","3","4+"].forEach(function(s){ var b=by[s], m=b.same+b.diff+b.partial;
      if(m){ wn += (b.same/m)*POP[s]; wd += POP[s]; } });
    el("s-prec").textContent = n? pct(p):"–";
    el("ci").textContent = n? "95% CI ["+pct(lo)+", "+pct(hi)+"]":"";
    el("s-prec-sub").textContent = wd? "weighted "+pct(wn/wd)+" · "+totalPop.toLocaleString()+" clusters":"weighted –";
    el("s-same").textContent = same;
    el("s-bad").textContent = diff+partial;
    el("s-bad-sub").textContent = diff+" different · "+partial+" partial";
    el("s-done").textContent = n+" / "+CL.length;
    var pc = function(x){ return (n? (x/CL.length*100):0)+"%"; };
    el("bar-same").style.width=pc(same); el("bar-part").style.width=pc(partial); el("bar-diff").style.width=pc(diff);
    Object.keys(chipNodes).forEach(function(key){
      var cnt = key==="all"?CL.length
        : key==="unlabeled"?CL.filter(function(c){ return !labels[c.cluster_id]; }).length
        : ["2","3","4+"].indexOf(key)>=0?CL.filter(function(c){ return c.stratum===key; }).length
        : CL.filter(function(c){ return labels[c.cluster_id]===key; }).length;
      chipNodes[key].querySelector(".n").textContent = cnt;
    });
    if(DATA) el("foot-meta").textContent = "seed "+DATA.seed+" · "+DATA.generated_at;
  }

  // ---- labeling (server-synced) ----
  function setSync(state,text){ var s=el("sync"); s.hidden=false;
    s.className="sync"+(state?" "+state:""); el("sync-text").textContent=text; }
  function setLabel(cid,v,advance){
    if(v) labels[cid]=v; else delete labels[cid];
    var node = document.querySelector('.card[data-cid="'+cid+'"]');
    if(node){ node.dataset.v = v||""; node.classList.add("unsynced"); }
    stats();
    if(filter==="unlabeled" && v){ render(); stats(); }
    else if(advance) moveNextUnlabeled();
    setSync("saving","saving…");
    var body = JSON.stringify({ cluster_id: cid, verdict: v||"", sample_generated_at: DATA && DATA.generated_at });
    authedFetch("/api/admin/precision-labels", { method:"POST", body: body }).then(function(r){
      if(!r.ok) throw new Error("http "+r.status);
      var live = document.querySelector('.card[data-cid="'+cid+'"]');
      if(live) live.classList.remove("unsynced");
      setSync("","synced");
    }).catch(function(){
      var live = document.querySelector('.card[data-cid="'+cid+'"]');
      if(live) live.classList.add("unsynced");
      setSync("err","not saved — retry");
    });
  }

  // ---- navigation ----
  function focusCur(scroll){ var c=cards()[cur]; if(c){ markCurrent();
    if(scroll) c.scrollIntoView({block:"center",behavior:"smooth"}); } }
  function move(d){ var n=cards().length; if(!n)return; cur=(cur+d+n)%n; focusCur(true); }
  function moveNextUnlabeled(){ var cs=cards(), k;
    for(k=cur+1;k<cs.length;k++){ if(!labels[cs[k].dataset.cid]){cur=k;focusCur(true);return;} }
    for(k=0;k<cs.length;k++){ if(!labels[cs[k].dataset.cid]){cur=k;focusCur(true);return;} }
    focusCur(true); }

  // ---- events ----
  el("list").addEventListener("click", function(e){
    var btn=e.target.closest(".v-btn"), card=e.target.closest(".card"), tl=e.target.closest(".tl-btn");
    if(card){ cur=cards().indexOf(card); markCurrent(); }
    if(tl){ var panel=tl.parentElement.querySelector(".tl-panel");
      var show=panel.hasAttribute("hidden"); panel.toggleAttribute("hidden",!show);
      tl.setAttribute("aria-expanded",show?"true":"false"); return; }
    if(btn && card){ var cid=card.dataset.cid, nv = labels[cid]===btn.dataset.v ? "" : btn.dataset.v;
      setLabel(cid,nv,!!nv); }
  });
  document.addEventListener("keydown", function(e){
    if(e.target.tagName==="TEXTAREA" || !CL.length) return;
    var k=e.key.toLowerCase();
    if(k==="j"||e.key==="ArrowDown"){e.preventDefault();move(1);}
    else if(k==="k"||e.key==="ArrowUp"){e.preventDefault();move(-1);}
    else if(k==="enter"){e.preventDefault();moveNextUnlabeled();}
    else if("sdp".indexOf(k)>=0){ var c=cards()[cur]; if(c){e.preventDefault();
      var map={s:"same",d:"diff",p:"partial"}, nv=labels[c.dataset.cid]===map[k]?"":map[k];
      setLabel(c.dataset.cid,nv,!!nv);} }
    else if(k==="u"){ var cu=cards()[cur]; if(cu){e.preventDefault();setLabel(cu.dataset.cid,"",false);} }
    else if(k==="x"){ var cx=cards()[cur]; if(cx){e.preventDefault(); var b=cx.querySelector(".tl-btn"); if(b)b.click();} }
  });
  el("btn-jump").onclick = moveNextUnlabeled;

  function buildFilters(){
    var FILTERS=[["all","All"],["unlabeled","Unlabeled"],["same","Same"],["partial","Partial"],["diff","Different"],["2","size 2"],["3","size 3"],["4+","size 4+"]];
    el("filters").innerHTML = FILTERS.map(function(f){ return '<button class="chip" data-f="'+f[0]+'" aria-pressed="'+(f[0]==="all")+'">'+f[1]+' <span class="n"></span></button>'; }).join("");
    [].slice.call(el("filters").querySelectorAll(".chip")).forEach(function(ch){ chipNodes[ch.dataset.f]=ch;
      ch.onclick=function(){ filter=ch.dataset.f; cur=0;
        [].slice.call(el("filters").querySelectorAll(".chip")).forEach(function(c){ c.setAttribute("aria-pressed",c===ch); });
        render(); stats(); }; });
  }

  // ---- export ----
  var dlg = el("export-dlg");
  el("btn-export").onclick = function(){ el("export-text").value = JSON.stringify({labels:labels},null,1);
    el("export-cmd").textContent = "python tools/sample_cluster_precision.py score \\\n  --sample data/phase2_precision_sample.json --labels labels.json";
    dlg.showModal(); };
  el("btn-close").onclick = function(){ dlg.close(); };
  el("btn-copy").onclick = function(){ navigator.clipboard.writeText(el("export-text").value).then(function(){
    el("btn-copy").textContent="Copied ✓"; setTimeout(function(){ el("btn-copy").textContent="Copy JSON"; },1200);
  }).catch(function(){ el("export-text").select(); }); };
  el("btn-download").onclick = function(){ var b=new Blob([el("export-text").value],{type:"application/json"});
    var a=document.createElement("a"); a.href=URL.createObjectURL(b); a.download="labels.json"; a.click(); };

  // ---- auth + boot ----
  function authedFetch(url,opts){
    opts = opts||{}; opts.headers = Object.assign({}, opts.headers||{}, token?{Authorization:"Bearer "+token}:{});
    if(opts.body) opts.headers["Content-Type"]="application/json";
    return fetch(url,opts);
  }
  async function initAuth(){
    try{
      var cfg = await fetch("/api/public-config").then(function(r){ return r.json(); });
      if(window.supabase && cfg && cfg.supabase_url){
        var supa = supabase.createClient(String(cfg.supabase_url).trim(),
          String(cfg.anon_key||"").trim(), { auth:{ persistSession:true } });
        var s = await supa.auth.getSession();
        token = s && s.data && s.data.session ? s.data.session.access_token : null;
      }
    }catch(e){ /* local dev: auth not enforced, endpoint accepts anyway */ }
  }
  function gate(html){ el("gate").innerHTML = html; el("gate").hidden = false; }
  async function boot(){
    await initAuth();
    var res;
    try{ res = await authedFetch("/api/admin/precision-sample"); }
    catch(e){ gate("Couldn’t reach the server. Check your connection and reload."); return; }
    if(res.status===401 || res.status===403){
      gate('This tool is operator-only. Open <a href="/admin">/admin</a>, sign in as the operator, then reload this page.');
      return;
    }
    var data;
    try{ data = await res.json(); }catch(e){ gate("The server returned an unexpected response."); return; }
    if(!data.available){
      gate("The labeling sample isn’t on this host yet.<br><br><code>"+esc(data.detail||"")+"</code><br><br>Ship <code>data/phase2_precision_sample.json</code> to the data disk, then reload.");
      return;
    }
    DATA = data; CL = DATA.clusters||[]; POP = DATA.population||{};
    totalPop = Object.keys(POP).reduce(function(a,k){ return a+POP[k]; },0);
    try{ var lj = await authedFetch("/api/admin/precision-labels").then(function(r){ return r.json(); });
      labels = lj.labels||{}; }catch(e){ labels = {}; }
    el("gate").hidden = true;
    setSync("","synced");
    buildFilters();
    el("h-count").textContent = "· "+CL.length+" sampled of "+totalPop.toLocaleString();
    render(); stats(); moveNextUnlabeled();
  }
  boot();
})();
