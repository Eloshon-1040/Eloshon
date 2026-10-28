/**
 * P0 / B7 — the HTTP used by recipe replays and platform feeds (defaultHttpGet) has a
 * deadline over the whole exchange, sends the app's User-Agent, keeps the per-host
 * spacing and retries a 429 / 5xx; the recipe server client (edge) has a deadline.
 * Before: bare fetch — no timeout, Node's default UA, no spacing, no retry.
 * Fake fetch implementations only: no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultHttpGet } from '../../shared/internal-api.mjs';
import { createEdgeClient } from '../edge-client.mjs';
import { HostPacer } from '../../shared/net/deadline.mjs';
import { appDirs, ensureDirs } from '../../lib/osenv.mjs';
import { createController } from '../../app/controller.mjs';

const T = { timeout: 10000 };
const json = (status, body, headers = {}) => ({ status, ok: status < 400, headers: new Headers(headers), json: async () => body, text: async () => JSON.stringify(body) });
const hanging = () => ({ status: 200, ok: true, headers: new Headers(), json: () => new Promise(() => {}), text: () => new Promise(() => {}) });

test('defaultHttpGet: a stalled body ends as a timeout', T, async () => {
  const get = defaultHttpGet(async () => hanging(), { timeoutMs: 300 });
  const t0 = Date.now();
  const r = await get('https://api.shop.test/list');
  assert.equal(r.status, 0); assert.equal(r.error, 'timeout'); assert.equal(r.body, null);
  assert.ok(Date.now() - t0 < 2000);
});

test('defaultHttpGet: sends the configured User-Agent unless the recipe sets one', T, async () => {
  const seen = [];
  const get = defaultHttpGet(async (u, o) => { seen.push(o.headers); return json(200, { ok: 1 }); }, { userAgent: 'EloshonTest/1.0' });
  await get('https://api.shop.test/a');
  await get('https://api.shop.test/b', { headers: { 'User-Agent': 'Recipe/2' } });
  assert.equal(seen[0]['User-Agent'], 'EloshonTest/1.0');
  assert.equal(seen[1]['User-Agent'], 'Recipe/2');
});

test('defaultHttpGet: 503 then 200 is retried; 429 waits its Retry-After; spacing is kept', T, async () => {
  const waits = []; const sleepImpl = async (ms) => { waits.push(ms); };
  let n = 0;
  // A fixed clock: on the real one the next reserve() runs a millisecond after pushBack() and waits 1999 ms.
  const get = defaultHttpGet(async () => { n += 1; return n === 1 ? json(503, {}) : n === 2 ? json(429, {}, { 'retry-after': '2' }) : json(200, { ok: true }); }, { retries: 2, sleepImpl, pacer: new HostPacer({ minDelayMs: 0, now: () => 0 }) });
  const r = await get('https://api.shop.test/list');
  assert.equal(r.status, 200); assert.deepEqual(r.body, { ok: true });
  assert.equal(n, 3);
  assert.ok(waits.includes(2000), `waits: ${waits.join(', ')}`);
  // Shared pacer: two calls to the same host are spaced.
  let t = 0; const pacer = new HostPacer({ minDelayMs: 500, now: () => t });
  const spaced = []; const get2 = defaultHttpGet(async () => json(200, {}), { pacer, sleepImpl: async (ms) => { spaced.push(ms); } });
  await Promise.all([get2('https://api.shop.test/1'), get2('https://api.shop.test/2')]);
  assert.deepEqual(spaced, [500]);
});

test('defaultHttpGet: a 429 asking for too long is returned at once', T, async () => {
  const get = defaultHttpGet(async () => json(429, {}, { 'retry-after': '600' }), { retries: 2, sleepImpl: async () => { throw new Error('no wait expected'); } });
  const r = await get('https://api.shop.test/list');
  assert.equal(r.status, 429);
});

test('edge client: a recipe-server answer that never ends is bounded', T, async () => {
  const edge = createEdgeClient({ baseUrl: 'https://edge.test', anonKey: 'anon', license: 'lic', fetchImpl: async () => hanging(), timeoutMs: 300 });
  const t0 = Date.now();
  const r = await edge.profile('shop.test');
  assert.equal(r.ok, false); assert.equal(r.reason, 'timeout');
  assert.ok(Date.now() - t0 < 2000);
});

test('controller: the recipe lane sends the run User-Agent, and a stalled API ends the lane within the configured timeout', T, async () => {
  const dirs = ensureDirs(appDirs(fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-b7-'))));
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1, recovery: false, maxProducts: 10, timeoutMs: 400, retries: 0 }), 'utf8');
  const recipe = { endpoint_tpl: 'https://api.shop.test/list?size={size}&skip={skip}', method: 'GET', pagination: { type: 'offset', param: 'skip', size_param: 'size', size: 2, total_json_path: 'total' }, json_path: 'products', field_map: { name: 'n', price: 'p', sku: 'id' } };
  fs.writeFileSync(path.join(dirs.data, 'domain-profiles.json'), JSON.stringify({ 'shop.test': { internal_api: recipe, internalApiMeta: { status: 'candidate', version: 1, success_count: 0, fail_count: 0, consecutive_fails: 0, last_verified: new Date().toISOString() }, runs: 1 } }));
  const seen = []; const prev = globalThis.fetch;
  globalThis.fetch = async (u, o = {}) => { seen.push({ u: String(u), ua: o.headers && (o.headers['User-Agent'] || o.headers['user-agent']) }); return String(u).startsWith('https://api.shop.test/') ? hanging() : json(404, {}); };
  class Mock { constructor() { this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; this.userAgent = 'EloshonRun/9'; } async get(u) { return { ok: false, status: 404, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body: '', headers: {}, error: null, blocked: false }; } async getText(u) { return this.get(u); } }
  try {
    const t0 = Date.now();
    const ctrl = createController({ dirs });
    await ctrl.start({ origin: 'https://www.shop.test/c/jeans', store: 'demo', browser: false, fetcher: new Mock() });
    const api = seen.filter((s) => s.u.startsWith('https://api.shop.test/'));
    assert.ok(api.length >= 1, 'the recipe API was called');
    assert.ok(api.every((s) => s.ua === 'EloshonRun/9'), `user agents: ${api.map((s) => s.ua).join(', ')}`);
    assert.ok(Date.now() - t0 < 8000, 'the run ended instead of waiting for the stalled API');
  } finally { globalThis.fetch = prev; }
});
