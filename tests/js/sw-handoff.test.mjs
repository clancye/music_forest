// Service-worker hand-off list: paths the SW must NEVER intercept, because a
// cached answer is worse than a live failure. /version is the update gate —
// auth-ui compares it to the running build to decide "the deploy is fully
// live, reload is safe"; when the runtime cache answered it with the previous
// build's body, every update check read "server == running" and reported
// "still rolling out" forever (owner's phone, v82 → v83, 2026-07-04). Same
// stickiness class as the pre-v73 /admin bug. Note Cache Storage ignores the
// client fetch's `cache: "no-store"` — that option only bypasses the HTTP
// cache — so the hand-off must live here in the SW, not in the caller.
//
// Runs headless like sw-navigation.test.mjs: loads static/sw.js in a mocked
// SW scope, captures the 'fetch' handler, and checks which requests it claims.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const swSrc = readFileSync(join(here, '../../static/sw.js'), 'utf8');

function loadSW() {
  const listeners = {};
  const store = new Map();
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
  const sandbox = {
    self, caches, fetch: async () => new Response('LIVE', { status: 200 }),
    URL, Response, Request, console,
  };
  vm.runInNewContext(swSrc, sandbox);
  return { handler: listeners.fetch, store };
}

// True when the handler claimed the request (called respondWith).
function intercepts(handler, url, { method = 'GET', mode = 'no-cors' } = {}) {
  let claimed = false;
  handler({
    request: { method, url, mode },
    respondWith: () => { claimed = true; },
  });
  return claimed;
}

let pass = 0;
async function check(name, fn) { await fn(); pass++; console.log('  ok ' + name); }

const HANDS_OFF = [
  'https://musicforest.lol/version',
  'https://musicforest.lol/healthz',
  'https://musicforest.lol/api/pool/day',
  'https://musicforest.lol/admin',
  'https://musicforest.lol/static/admin.js',
  'https://cdn.jsdelivr.net/npm/some-lib.js',
];
for (const url of HANDS_OFF) {
  await check(`hands off ${new URL(url).host === 'musicforest.lol' ? new URL(url).pathname : url}`, async () => {
    const { handler } = loadSW();
    assert.equal(intercepts(handler, url), false, `${url} must go straight to the network`);
  });
}

await check('still intercepts shell assets (cache-first path intact)', async () => {
  const { handler } = loadSW();
  assert.equal(intercepts(handler, 'https://musicforest.lol/static/style.css'), true);
});

await check('never touches non-GETs', async () => {
  const { handler } = loadSW();
  assert.equal(
    intercepts(handler, 'https://musicforest.lol/static/style.css', { method: 'POST' }),
    false);
});

console.log(`\nAll ${pass} service-worker hand-off tests passed.`);
