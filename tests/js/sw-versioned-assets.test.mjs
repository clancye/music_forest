// Versioned shell assets: a new build's page must never run an older build's
// cached script. Before v334 the SW served navigations network-first (fresh
// index.html) but /static/app.js cache-first under the PREVIOUS VERSION's cache,
// so the first open after a deploy ran old app.js against new markup — and when a
// build removed an element the old script wired at startup, init() threw and
// Today came up blank (prod, v332).
//
// The fix: the server stamps every same-origin script/stylesheet URL in the page
// with `?v=<build>` (server.py _stamp_assets; pinned in tests/test_versioned_assets.py)
// and sw.js precaches those exact URLs. Cache Storage matches on the full URL,
// query included, so a new page's `?v=<new>` misses every older generation's
// entries and goes to the network for the matching file.
//
// Runs headless like sw-navigation.test.mjs, but with a multi-generation cache
// mock that matches the way the real one does (full URL, all caches searched).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const swSrc = readFileSync(join(here, '../../static/sw.js'), 'utf8');
const indexSrc = readFileSync(join(here, '../../static/index.html'), 'utf8');
const VERSION = swSrc.match(/const VERSION = '([^']+)'/)[1];
const ORIGIN = 'https://musicforest.lol';
const abs = (u) => new URL(u, ORIGIN).href;

// A Request stand-in that resolves relative URLs like a SW scope does.
class SWRequest {
  constructor(url, init = {}) { this.url = abs(url); this.method = init.method || 'GET'; this.mode = init.mode || 'no-cors'; }
}

// caches: one Map per named generation; match() searches them all by exact URL.
function makeCaches(seed = {}) {
  const gens = new Map(Object.entries(seed).map(([n, m]) => [n, new Map(Object.entries(m).map(([k, v]) => [abs(k), v]))]));
  const keyOf = (k) => abs(typeof k === 'string' ? k : k.url);
  const open = async (name) => {
    if (!gens.has(name)) gens.set(name, new Map());
    const g = gens.get(name);
    return {
      put: async (k, v) => { g.set(keyOf(k), v); },
      add: async (k) => { g.set(keyOf(k), new Response('NET ' + keyOf(k))); },
    };
  };
  const match = async (k) => {
    for (const g of gens.values()) { const hit = g.get(keyOf(k)); if (hit) return hit.clone(); }
    return undefined;
  };
  return { gens, api: { open, match, keys: async () => [...gens.keys()], delete: async (n) => gens.delete(n) } };
}

function loadSW(caches, fetchImpl) {
  const listeners = {};
  const self = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    location: { origin: ORIGIN },
    skipWaiting: () => {}, clients: { claim: () => {} }, registration: {},
  };
  vm.runInNewContext(swSrc, { self, caches, fetch: fetchImpl, URL, Response, Request: SWRequest, console });
  return listeners;
}

async function runInstall(listeners) {
  let p;
  listeners.install({ waitUntil: (x) => { p = x; } });
  await p;
}

async function get(listeners, url) {
  let answered;
  listeners.fetch({ request: new SWRequest(url), respondWith: (p) => { answered = p; } });
  assert.ok(answered, `the SW should answer ${url}`);
  return (await answered).text();
}

// The same-origin scripts + stylesheets the page names (what the server stamps).
const pageAssets = [...indexSrc.matchAll(/(?:src|href)="(\/static\/[^"?#]+\.(?:js|css))"/g)].map((m) => m[1]);

let pass = 0;
async function check(name, fn) { await fn(); pass++; console.log('  ok ' + name); }

await check('the page names same-origin scripts and a stylesheet (sanity)', async () => {
  assert.ok(pageAssets.includes('/static/app.js'));
  assert.ok(pageAssets.includes('/static/style.css'));
});

await check('install precaches every page script/stylesheet at exactly ?v=VERSION', async () => {
  const { gens, api } = makeCaches();
  await runInstall(loadSW(api, async () => { throw new Error('no network in install mock'); }));
  const keys = [...gens.get(`forest-shell-${VERSION}`).keys()];
  for (const a of pageAssets) {
    assert.ok(keys.includes(abs(`${a}?v=${VERSION}`)), `precache is missing ${a}?v=${VERSION}`);
    assert.ok(!keys.includes(abs(a)), `${a} must not be precached unversioned (a page never asks for it)`);
  }
});

await check("a new page's ?v=<new> misses an older generation's cached script -> network", async () => {
  // The previous build's cache, both shapes it could hold: pre-v334 unversioned
  // and a later build's own stamp.
  const { api } = makeCaches({
    'forest-shell-vOLD': {
      '/static/app.js': new Response('OLD_APP'),
      '/static/app.js?v=vOLD': new Response('OLD_APP'),
    },
  });
  let netHits = 0;
  const L = loadSW(api, async (req) => { netHits++; return new Response('NEW_APP'); });
  assert.equal(await get(L, `/static/app.js?v=${VERSION}`), 'NEW_APP');
  assert.equal(netHits, 1, 'the matching script came from the network, not the old cache');
});

await check('once installed, the stamped assets serve from cache (offline shell holds)', async () => {
  const { api } = makeCaches();
  const L = loadSW(api, async () => { throw new TypeError('offline'); });
  await runInstall(L);
  for (const a of pageAssets) {
    assert.equal(await get(L, `${a}?v=${VERSION}`), 'NET ' + abs(`${a}?v=${VERSION}`));
  }
});

console.log(`sw-versioned-assets: ${pass} checks passed`);
