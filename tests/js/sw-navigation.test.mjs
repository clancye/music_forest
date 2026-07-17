// Service-worker navigation strategy: the installed PWA must still open from its
// cached shell when the origin answers a navigation with a 5xx — the exact case
// that made the Android PWA render Render's "502 Bad Gateway" page during a
// deploy's instance-swap. A 5xx is a RESOLVED response, not a network rejection,
// so the offline .catch() never sees it; the handler must detect it explicitly.
//
// Runs headless: loads static/sw.js in a mocked SW global scope, captures the
// 'fetch' handler, and drives it with fabricated navigation responses.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const swSrc = readFileSync(join(here, '../../static/sw.js'), 'utf8');

// --- build a fresh mocked SW scope, load sw.js into it, return the fetch handler
function loadSW({ fetchImpl, cachedShell }) {
  const listeners = {};
  const store = new Map();
  if (cachedShell !== undefined) store.set('/', cachedShell);

  const cacheObj = {
    put: async (k, v) => { store.set(typeof k === 'string' ? k : k.url, v); },
    add: async () => {},
    addAll: async () => {},
    keys: async () => [],
  };
  const caches = {
    open: async () => cacheObj,
    match: async (k) => store.get(typeof k === 'string' ? k : (k && k.url)),
    keys: async () => [],
    delete: async () => true,
  };

  const self = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    location: { origin: 'https://musicforest.lol' },
    skipWaiting: () => {},
    clients: { claim: () => {} },
    registration: {},
  };

  const sandbox = { self, caches, fetch: fetchImpl, URL, Response, Request, console };
  vm.runInNewContext(swSrc, sandbox);
  return listeners.fetch;
}

// --- drive a navigation through the handler, return the Response it answers with
async function navigate(handler, { fetchImpl, cachedShell }) {
  const req = { method: 'GET', url: 'https://musicforest.lol/', mode: 'navigate' };
  let answered;
  const event = { request: req, respondWith: (p) => { answered = p; } };
  handler(event);
  return answered ? await answered : undefined;
}

let pass = 0;
async function check(name, fn) { await fn(); pass++; console.log('  ok ' + name); }

// 1) Origin returns 502 during a deploy, shell IS cached -> serve the cached shell.
await check('502 navigation with cached shell -> serves cached shell (not the 502)', async () => {
  const opts = {
    fetchImpl: async () => new Response('Bad Gateway', { status: 502 }),
    cachedShell: new Response('CACHED_SHELL', { status: 200 }),
  };
  const resp = await navigate(loadSW(opts), opts);
  assert.equal(resp.status, 200, 'should not be the 502');
  assert.equal(await resp.text(), 'CACHED_SHELL', 'should be the cached shell body');
});

// 2) 502 but NO cached shell yet (fresh install) -> don't mask the real error.
await check('502 navigation with no cache -> passes the 502 through (fresh install)', async () => {
  const opts = { fetchImpl: async () => new Response('Bad Gateway', { status: 502 }), cachedShell: undefined };
  const resp = await navigate(loadSW(opts), opts);
  assert.equal(resp.status, 502, 'a fresh install with no cache still surfaces the error');
});

// 3) 503 / 504 are covered too (any 5xx is the "still rolling out" window).
for (const code of [500, 503, 504]) {
  await check(`${code} navigation with cached shell -> serves cached shell`, async () => {
    const opts = {
      fetchImpl: async () => new Response('x', { status: code }),
      cachedShell: new Response('CACHED_SHELL', { status: 200 }),
    };
    const resp = await navigate(loadSW(opts), opts);
    assert.equal(await resp.text(), 'CACHED_SHELL');
  });
}

// 4) Healthy origin -> the live 200 document is returned (normal path untouched).
await check('200 navigation -> returns the live document', async () => {
  const opts = {
    fetchImpl: async () => new Response('LIVE_DOC', { status: 200 }),
    cachedShell: new Response('CACHED_SHELL', { status: 200 }),
  };
  const resp = await navigate(loadSW(opts), opts);
  assert.equal(await resp.text(), 'LIVE_DOC', 'a healthy origin still wins');
});

// 5) True offline (network rejects) -> cached shell, unchanged behavior.
await check('offline navigation (fetch rejects) -> serves cached shell', async () => {
  const opts = {
    fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    cachedShell: new Response('CACHED_SHELL', { status: 200 }),
  };
  const resp = await navigate(loadSW(opts), opts);
  assert.equal(await resp.text(), 'CACHED_SHELL');
});

console.log(`\nAll ${pass} service-worker navigation tests passed.`);
