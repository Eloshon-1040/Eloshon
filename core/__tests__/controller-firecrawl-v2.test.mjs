/**
 * Firecrawl lane on API v2, through the REAL controller, offline: the escalation sends
 * the v2 body with `maxAge` (config.firecrawl.maxAgeMs, 1 h by default), writes the
 * credits and the cache state Firecrawl reports into the ledger line, asks for a fresh
 * page (maxAge 0) after a Firecrawl page gave no product, and stops the lane on a 402
 * with a named reason. The global fetch is replaced: no request leaves the process.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appDirs, ensureDirs } from '../../lib/osenv.mjs';
import { createController } from '../../app/controller.mjs';
import { createLedger } from '../metering/ledger.mjs';
import { createMeter } from '../metering/meter.mjs';
import { queryLedger } from '../metering/reader.mjs';
import { ProviderRuntime } from '../providers/runtime.mjs';
import { isConfigured } from '../providers/registry.mjs';

const ORIGIN = 'https://www.shop.test/c/shoes';
const FC_KEY = 'fc-TESTKEY0123456789abcdef';
const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

class Blocked {
  constructor() { this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; this.userAgent = 't'; }
  async get(u) { this.stats.requests++; return { ok: false, status: 403, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body: '<html><title>Access Denied</title></html>', bytes: 40, headers: {}, error: null, blocked: true }; }
  async getText(u) { return this.get(u); }
}
const NEXT = `<!doctype html><html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { products: [
  { name: 'Runner One', price: 59.9, url: 'https://www.shop.test/p/runner-one', image: 'https://cdn.shop.test/1.jpg', sku: 'R1' },
  { name: 'Runner Two', price: 64.9, url: 'https://www.shop.test/p/runner-two', image: 'https://cdn.shop.test/2.jpg', sku: 'R2' },
  { name: 'Runner Three', price: 69.9, url: 'https://www.shop.test/p/runner-three', image: 'https://cdn.shop.test/3.jpg', sku: 'R3' },
] } } })}</script></body></html>`;
const SHELL = `<!doctype html><html><body><div id="root"></div>${'<p>loading</p>'.repeat(20)}</body></html>`;
const json = (status, body) => ({ status, ok: status < 400, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });

function fakeFetch(reply) {
  const bodies = []; const other = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u === 'https://api.firecrawl.dev/v2/scrape') { bodies.push(JSON.parse(opts.body)); return reply(bodies.length); }
    other.push(u);
    return { status: 404, ok: false, headers: new Headers(), json: async () => ({}), text: async () => '' };
  };
  return { bodies, other, restore: () => { globalThis.fetch = prev; } };
}

function setup(config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-fcv2-'));
  made.push(root);
  const dirs = ensureDirs(appDirs(root));
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1, recovery: false, maxProducts: 20, firecrawl: { apiKey: FC_KEY, domains: ['shop.test'], ...config } }, null, 2));
  const resolveIo = () => ({ secure: {}, config: JSON.parse(fs.readFileSync(dirs.configFile, 'utf8')), env: {} });
  const runtime = new ProviderRuntime({}, { isConfigured: (id) => isConfigured(id, resolveIo()) });
  const ledgerDir = path.join(root, 'usage-ledger');
  const meter = createMeter({ ledger: createLedger({ dir: ledgerDir, secrets: () => [FC_KEY] }), runtime, readConfig: () => resolveIo().config });
  const events = [];
  const ctrl = createController({ dirs, emit: (t, p) => events.push({ t, p }), providerRuntime: runtime, meter });
  const run = () => { events.length = 0; return ctrl.start({ origin: ORIGIN, store: 'demo', browser: false, fetcher: new Blocked() }); };
  const fcLines = async () => (await queryLedger(ledgerDir, { provider: ['firecrawl'] }, { limit: 100 })).rows.reverse();
  const profile = () => { try { return JSON.parse(fs.readFileSync(path.join(dirs.data, 'domain-profiles.json'), 'utf8'))['shop.test']; } catch { return null; } };
  return { run, runtime, fcLines, profile, events, done: () => events.find((e) => e.t === 'done').p };
}

test('v2 body from the controller: maxAge 1 h by default, full page, raw HTML; credits + cache state in the ledger', async () => {
  const f = fakeFetch(() => json(200, { success: true, data: { rawHtml: NEXT, markdown: '', metadata: { statusCode: 200, creditsUsed: 1, cacheState: 'hit', cachedAt: '2026-10-20T08:00:00.000Z' } } }));
  try {
    const s = setup();
    await s.run();
    assert.equal(f.bodies.length, 1);
    const b = f.bodies[0];
    assert.equal(b.url, ORIGIN); assert.equal(b.maxAge, 3600000); assert.equal(b.onlyMainContent, false);
    assert.deepEqual(b.formats, ['rawHtml', 'markdown']);
    assert.ok(b.timeout > 1000 && b.timeout <= 120000, 'server timeout inside the route budget');
    const [line] = await s.fcLines();
    assert.equal(line.outcome, 'success'); assert.ok(line.products >= 3);
    assert.equal(line.credits, 1, 'credits reported by the API');
    assert.equal(line.cacheState, 'hit', 'the ledger says the page came from Firecrawl\'s cache');
    assert.ok(s.done().counts.detected >= 3);
    assert.equal(s.profile().unlockCacheBypass, false);
    assert.deepEqual(f.other.filter((u) => !u.startsWith('https://www.shop.test')), [], 'no other external request');
  } finally { f.restore(); }
});

test('config.firecrawl.maxAgeMs is sent as is (0 = always a fresh page)', async () => {
  const f = fakeFetch(() => json(200, { success: true, data: { rawHtml: NEXT, metadata: { creditsUsed: 1 } } }));
  try {
    const s = setup({ maxAgeMs: 0 });
    await s.run();
    assert.equal(f.bodies[0].maxAge, 0);
    const [line] = await s.fcLines();
    assert.equal(line.cacheState, null, 'no cache state reported → null');
  } finally { f.restore(); }
});

test('a Firecrawl page with no product → the next run asks for a fresh page; a page with products lifts it', async () => {
  let page = SHELL;
  const f = fakeFetch(() => json(200, { success: true, data: { rawHtml: page, metadata: { creditsUsed: 1, cacheState: 'miss' } } }));
  try {
    const s = setup();
    await s.run();
    let [line] = await s.fcLines();
    assert.equal(line.outcome, 'empty'); assert.equal(line.cacheState, 'miss');
    assert.equal(s.profile().unlockCacheBypass, true);
    page = NEXT;
    await s.run();
    assert.equal(f.bodies[1].maxAge, 0, 'second run: Firecrawl must not hand back the same empty copy');
    assert.equal(s.profile().unlockCacheBypass, false, 'products found → the cache may serve this host again');
    await s.run();
    assert.equal(f.bodies[2].maxAge, 3600000);
  } finally { f.restore(); }
});

test('402 from v2: one request, quota_exhausted + no_credits in the ledger, counted against the caps', async () => {
  const f = fakeFetch(() => json(402, { success: false, error: 'Payment required to access this resource.', code: 'insufficient_credits' }));
  try {
    const s = setup();
    await s.run();
    assert.equal(f.bodies.length, 1, 'never retried');
    const [line] = await s.fcLines();
    assert.equal(line.outcome, 'quota_exhausted'); assert.equal(line.reason, 'no_credits'); assert.equal(line.attempted, true);
    assert.equal(s.runtime.usageFor('firecrawl').callsThisMonth, 1);
    assert.equal(JSON.stringify(line).includes(FC_KEY), false);
  } finally { f.restore(); }
});
