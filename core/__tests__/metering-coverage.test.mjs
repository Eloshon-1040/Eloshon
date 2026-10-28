/**
 * Coverage of the usage ledger THROUGH THE REAL CONTROLLER (Points 1.3 and 2.4).
 * Every provider call is faked: the global fetch is replaced for the duration of
 * each test and records every request, the Scraping Browser connect and the edge
 * (cascade) client are injected. No test can reach a real, billed service.
 *
 * Pins: a site that is not opted in NEVER reaches a paid route (and the refusal is
 * written as blocked_no_optin); opt-in, test mode, caps and quota each produce the
 * expected line; the cascade writes its credits and every upstream attempt; the
 * extension and the free lanes write theirs; no secret lands in the ledger.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appDirs, ensureDirs } from '../../lib/osenv.mjs';
import { createController } from '../../app/controller.mjs';
import { createLedger, ledgerFiles } from '../metering/ledger.mjs';
import { createMeter } from '../metering/meter.mjs';
import { jobEvents, queryLedger } from '../metering/reader.mjs';
import { ProviderRuntime } from '../providers/runtime.mjs';
import { isConfigured } from '../providers/registry.mjs';
import { createAnthropicAsker } from '../../app/ai/provider.mjs';

const ORIGIN = 'https://www.shop.test/c/shoes';
const FC_KEY = 'fc-TESTKEY0123456789abcdef';
const BD_KEY = 'BDTESTKEY-0123456789';
const SB_AUTH = 'brd-customer-TCID-zone-mcp_browser:S3CRETPW';

class Blocked {
  constructor() { this.calls = []; this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; this.userAgent = 't'; }
  async get(u) { this.calls.push(u); this.stats.requests++; return { ok: false, status: 403, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body: '<html><title>Access Denied</title></html>', bytes: 40, headers: {}, error: null, blocked: true }; }
  async getText(u) { return this.get(u); }
}

const NEXT = `<!doctype html><html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { products: [
  { name: 'Runner One', price: 59.9, url: 'https://www.shop.test/p/runner-one', image: 'https://cdn.shop.test/1.jpg', sku: 'R1' },
  { name: 'Runner Two', price: 64.9, url: 'https://www.shop.test/p/runner-two', image: 'https://cdn.shop.test/2.jpg', sku: 'R2' },
  { name: 'Runner Three', price: 69.9, url: 'https://www.shop.test/p/runner-three', image: 'https://cdn.shop.test/3.jpg', sku: 'R3' },
] } } })}</script></body></html>`;

/** Replace the global fetch: provider hosts get a scripted reply, everything else 404. */
function fakeFetch(script = {}) {
  const calls = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url); calls.push(u);
    const json = (status, body) => ({ status, ok: status < 400, json: async () => body, text: async () => JSON.stringify(body) });
    if (u.startsWith('https://api.firecrawl.dev/v2/scrape')) return script.firecrawl ? script.firecrawl(opts) : json(200, { success: true, data: { html: NEXT, markdown: '', metadata: { creditsUsed: 1 } } });
    if (u.startsWith('https://api.brightdata.com/request')) return script.unlocker ? script.unlocker(opts) : { status: 200, ok: true, text: async () => NEXT, json: async () => ({}) };
    return { status: 404, ok: false, json: async () => ({}), text: async () => '' };
  };
  return { calls, providerCalls: () => calls.filter((c) => /firecrawl\.dev|brightdata\.com/.test(c)), restore: () => { globalThis.fetch = prev; } };
}

function setup({ config = {}, caps = null, edgeClientFor, sbConnect } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-cov-'));
  const dirs = ensureDirs(appDirs(root));
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1, recovery: false, maxProducts: 20, ...config }, null, 2));
  const resolveIo = () => ({ secure: {}, config: JSON.parse(fs.readFileSync(dirs.configFile, 'utf8')), env: {} });
  const runtime = new ProviderRuntime({}, { isConfigured: (id) => isConfigured(id, resolveIo()) });
  if (caps) for (const [id, c] of Object.entries(caps)) runtime.setCap(id, c);
  const ledgerDir = path.join(root, 'usage-ledger');
  const meter = createMeter({ ledger: createLedger({ dir: ledgerDir, secrets: () => [FC_KEY, BD_KEY, SB_AUTH, 'S3CRETPW'] }), runtime, readConfig: () => resolveIo().config });
  const events = [];
  const ctrl = createController({ dirs, emit: (t, p) => events.push({ t, p }), providerRuntime: runtime, meter, edgeClientFor });
  const run = (extra = {}) => ctrl.start({ origin: ORIGIN, store: 'demo', browser: false, fetcher: new Blocked(), scrapingBrowserConnect: sbConnect, ...extra });
  const lines = async () => (await queryLedger(ledgerDir, {}, { limit: 1000 })).rows.reverse();
  return { root, dirs, ctrl, run, runtime, ledgerDir, lines, events };
}

const KEYS = { firecrawl: { apiKey: FC_KEY }, brightData: { apiKey: BD_KEY, browserAuth: SB_AUTH } };
const ledgerText = (dir) => ledgerFiles(dir).map((f) => fs.readFileSync(f, 'utf8')).join('');

test('opt-in: a site NOT opted in never reaches a paid route — each refusal is recorded as blocked_no_optin', async () => {
  const f = fakeFetch();
  try {
    const s = setup({ config: KEYS });
    await s.run();
    assert.equal(f.providerCalls().length, 0, 'no paid request left the app');
    const ls = await s.lines();
    const blocked = ls.filter((l) => l.outcome === 'blocked_no_optin').map((l) => l.provider).sort();
    assert.deepEqual(blocked, ['firecrawl', 'scrapingbrowser', 'webunlocker']);
    assert.ok(ls.every((l) => l.attempted === false || l.provider === 'local'));
    const local = ls.find((l) => l.provider === 'local');
    assert.equal(local.outcome, 'failed');
    assert.equal(local.products, 0);
    assert.equal(s.runtime.usageFor('firecrawl').callsThisMonth, 0);
  } finally { f.restore(); }
});

test('opt-in: an opted-in site calls Firecrawl ONCE; the line has credits, products, bytes; caps counted; chain ordered', async () => {
  const f = fakeFetch();
  try {
    const s = setup({ config: { ...KEYS, firecrawl: { ...KEYS.firecrawl, domains: ['shop.test'] } } });
    await s.run();
    assert.equal(f.providerCalls().length, 1);
    const ls = await s.lines();
    const fc = ls.find((l) => l.provider === 'firecrawl' && l.attempted);
    assert.equal(fc.outcome, 'success');
    assert.equal(fc.credits, 1);
    assert.equal(fc.route, 'escalation');
    assert.ok(fc.products >= 3);
    assert.ok(fc.bytes > 0);
    assert.equal(fc.channel, 'direct');
    assert.equal(fc.testMode, false);
    assert.equal(s.runtime.usageFor('firecrawl').callsThisMonth, 1);
    const wu = ls.find((l) => l.provider === 'webunlocker');
    assert.equal(wu.outcome, 'blocked_no_optin');
    const chain = await jobEvents(s.ledgerDir, fc.jobId);
    assert.equal(chain[0].provider, 'local', 'free lanes first in the chain');
    assert.ok(chain.some((l) => l.provider === 'firecrawl' && l.outcome === 'success'));
  } finally { f.restore(); }
});

test('test mode: allows a NOT-opted-in site for this launch only, flags every line, writes nothing to config.json', async () => {
  const f = fakeFetch();
  try {
    const s = setup({ config: KEYS });
    const before = fs.readFileSync(s.dirs.configFile, 'utf8');
    await s.run({ testMode: { firecrawl: true } });
    assert.equal(f.providerCalls().length, 1);
    const ls = await s.lines();
    assert.ok(ls.length >= 2);
    assert.ok(ls.every((l) => l.testMode === true), 'every line of the job carries testMode');
    const fc = ls.find((l) => l.provider === 'firecrawl' && l.attempted);
    assert.equal(fc.reason, 'test_mode');
    const after = JSON.parse(fs.readFileSync(s.dirs.configFile, 'utf8'));
    assert.equal(after.firecrawl.domains, undefined, 'the opt-in list was not touched');
    assert.equal(JSON.parse(before).firecrawl.domains, undefined);
    // a resume is a new launch: no test mode carried over
    const jobId = fc.jobId;
    const meta = JSON.parse(fs.readFileSync(path.join(s.dirs.jobs, jobId, 'job.json'), 'utf8')).meta;
    assert.deepEqual(meta.testMode, { firecrawl: true, webUnlocker: false, scrapingBrowser: false }, 'kept in the job history');
  } finally { f.restore(); }
});

test('caps: a reached cap blocks the call before it is sent — recorded as blocked_by_cap', async () => {
  const f = fakeFetch();
  try {
    const s = setup({ config: { firecrawl: { apiKey: FC_KEY, domains: ['shop.test'] } }, caps: { firecrawl: { maxCallsPerMonth: 0 } } });
    await s.run();
    assert.equal(f.providerCalls().length, 0);
    const fc = (await s.lines()).find((l) => l.provider === 'firecrawl');
    assert.equal(fc.outcome, 'blocked_by_cap');
    assert.equal(fc.reason, 'cap_reached');
    assert.equal(fc.attempted, false);
  } finally { f.restore(); }
});

test('quota: a provider answering "insufficient credits" (402) is recorded as quota_exhausted and still counted', async () => {
  const f = fakeFetch({ firecrawl: () => ({ status: 402, ok: false, json: async () => ({ success: false, error: 'Insufficient credits to perform this request.' }) }) });
  try {
    const s = setup({ config: { firecrawl: { apiKey: FC_KEY, domains: ['shop.test'] } } });
    await s.run();
    const fc = (await s.lines()).find((l) => l.provider === 'firecrawl');
    assert.equal(fc.outcome, 'quota_exhausted');
    assert.equal(fc.reason, 'no_credits'); // v2 lane: a 402 stops the lane with a named reason
    assert.equal(s.runtime.usageFor('firecrawl').callsThisMonth, 1, 'the request was sent');
  } finally { f.restore(); }
});

test('web unlocker: opted-in call → success line; a failure keeps only a status class', async () => {
  const f = fakeFetch({ unlocker: () => ({ status: 500, ok: false, text: async () => `upstream error with token ${BD_KEY}`, json: async () => ({}) }) });
  try {
    const s = setup({ config: { brightData: { apiKey: BD_KEY, domains: ['shop.test'] } } });
    await s.run();
    const wu = (await s.lines()).find((l) => l.provider === 'webunlocker');
    assert.equal(wu.outcome, 'failed');
    assert.equal(wu.reason, 'http_500');
    assert.equal(ledgerText(s.ledgerDir).includes(BD_KEY), false);
  } finally { f.restore(); }
});

test('scraping browser: opted-in render through a fake CDP → line with bytes + duration; credentials never in the ledger', async () => {
  const f = fakeFetch();
  let connects = 0;
  const sbConnect = async () => {
    connects += 1;
    const cdpL = {};
    const cdp = { on: (e, cb) => { (cdpL[e] = cdpL[e] || []).push(cb); }, send: async () => ({}) };
    const page = { route: async () => {}, goto: async () => { for (const cb of (cdpL['Network.loadingFinished'] || [])) cb({ encodedDataLength: 50000 }); return { status: () => 200 }; }, content: async () => NEXT, waitForSelector: async () => {}, setDefaultNavigationTimeout: () => {} };
    const ctx = { on: () => {}, newPage: async () => page, newCDPSession: async () => cdp };
    return { contexts: () => [ctx], close: async () => {} };
  };
  try {
    const s = setup({ config: { brightData: { browserAuth: SB_AUTH, scrapingBrowserDomains: ['shop.test'] } }, sbConnect });
    await s.run();
    assert.equal(connects, 1);
    const sb = (await s.lines()).find((l) => l.provider === 'scrapingbrowser' && l.attempted);
    assert.equal(sb.outcome, 'success');
    assert.equal(sb.bytes, 50000);
    assert.ok(Number.isFinite(sb.durationMs));
    assert.ok(sb.costUsd > 0, 'priced with the existing 8 $/GB default');
    const txt = ledgerText(s.ledgerDir);
    for (const secret of ['S3CRETPW', 'TCID', SB_AUTH]) assert.equal(txt.includes(secret), false);
  } finally { f.restore(); }
});

test('cascade: one credits line + one line per upstream attempt; provider error bodies never stored', async () => {
  const f = fakeFetch();
  try {
    const edge = {
      isConfigured: () => true,
      unlock: async () => ({ ok: true, status: 200, html: NEXT, htmlBytes: NEXT.length, provider: 'scrapfly', mode: 'asp', key: 'scrapfly_asp', eloshon_credits: 9, provider_units: 30,
        attempts: [{ key: 'firecrawl_normal', provider: 'firecrawl', mode: 'normal', status: 403, ok: false, ms: 900, error: `Access denied body ${FC_KEY}` }, { key: 'scrapfly_asp', provider: 'scrapfly', mode: 'asp', status: 200, ok: true, ms: 4000, error: null }] }),
      feedback: async () => ({ ok: true }), profile: async () => ({ ok: false }), accountStatus: async () => ({ ok: false }), estimate: async () => ({ ok: false }),
    };
    const s = setup({ edgeClientFor: () => edge });
    await s.ctrl.cascadeUnlock({ url: ORIGIN });
    const ls = await s.lines();
    const c = ls.find((l) => l.provider === 'cascade');
    assert.equal(c.outcome, 'success'); assert.equal(c.credits, 9); assert.equal(c.units, 30); assert.equal(c.upstream, 'scrapfly:asp'); assert.equal(c.channel, 'server');
    const fc = ls.find((l) => l.provider === 'firecrawl');
    assert.equal(fc.outcome, 'failed'); assert.equal(fc.reason, 'http_403'); assert.equal(fc.channel, 'server');
    assert.equal(ls.find((l) => l.provider === 'scrapfly').outcome, 'success');
    assert.equal(ledgerText(s.ledgerDir).includes('Access denied body'), false);
    assert.equal(s.runtime.usageFor('firecrawl').callsThisMonth, 0, 'server-side calls never count against the local caps');
  } finally { f.restore(); }
});

test('cascade: monthly quota exhausted → quota_exhausted line, 0 credits', async () => {
  const edge = { isConfigured: () => true, unlock: async () => ({ ok: false, status: 402, reason: 'quota_exceeded', quota: { used: 1000, quota: 1000 } }), feedback: async () => ({}), profile: async () => ({}), accountStatus: async () => ({ ok: false }) };
  const s = setup({ edgeClientFor: () => edge });
  await s.ctrl.cascadeUnlock({ url: ORIGIN });
  const c = (await s.lines()).find((l) => l.provider === 'cascade');
  assert.equal(c.outcome, 'quota_exhausted');
  assert.equal(c.credits, 0);
});

test('extension: a run in the user\'s browser writes one free line with its job id and product count', async () => {
  const s = setup();
  const r = await s.ctrl.ingestExternalProducts({ products: [{ name: 'A', price: 1, url: 'https://www.shop.test/p/a' }, { name: 'B', price: 2, url: 'https://www.shop.test/p/b' }], origin: ORIGIN, durationMs: 1200, details: { domain: 'shop.test' } });
  const ext = (await s.lines()).find((l) => l.provider === 'extension');
  assert.equal(ext.jobId, r.jobId);
  assert.equal(ext.outcome, 'success');
  assert.equal(ext.products, 2);
  assert.equal(ext.costUsd, 0);
  assert.equal(ext.channel, 'local');
});

test('free lanes: a successful local run writes one "local" line (products, bytes, duration) and no paid line', async () => {
  const f = fakeFetch();
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: 'Widget', sku: 'W1', offers: { '@type': 'Offer', price: '7.50', priceCurrency: 'EUR' } })}</script></head><body>ok</body></html>`;
  class OK { constructor() { this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; this.userAgent = 't'; } async get(u) { this.stats.bytes += html.length; return { ok: true, status: 200, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body: html, bytes: html.length, headers: {}, error: null, blocked: false }; } async getText(u) { return this.get(u); } }
  try {
    const s = setup({ config: KEYS });
    await s.ctrl.start({ urls: ['https://www.shop.test/p/widget'], store: 'demo', browser: false, fetcher: new OK() });
    const ls = await s.lines();
    assert.equal(ls.length, 1);
    assert.equal(ls[0].provider, 'local'); assert.equal(ls[0].outcome, 'success'); assert.ok(ls[0].products >= 1); assert.ok(ls[0].bytes > 0);
    assert.equal(f.providerCalls().length, 0);
  } finally { f.restore(); }
});

test('anthropic: the asker reports model + tokens + status to the ledger hook, never the prompt or the reply', async () => {
  const seen = [];
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'SECRET-REPLY {"arrayPath":null}' }], usage: { input_tokens: 812, output_tokens: 34 } }) });
  const ask = createAnthropicAsker({ apiKey: 'sk-ant-test', model: 'claude-haiku-4-5-20251001', fetchImpl, onCall: (i) => seen.push(i) });
  await ask('SECRET-PROMPT page structure');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].tokensIn, 812); assert.equal(seen[0].tokensOut, 34); assert.equal(seen[0].ok, true); assert.equal(seen[0].model, 'claude-haiku-4-5-20251001');
  assert.equal(JSON.stringify(seen).includes('SECRET'), false);
  const bad = createAnthropicAsker({ apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: { type: 'authentication_error', message: 'invalid x-api-key' } }) }), onCall: (i) => seen.push(i) });
  await assert.rejects(bad('p'), /ai_http_401/);
  assert.equal(seen[1].ok, false); assert.equal(seen[1].reason, 'ai_http_401:authentication_error');
});

test('bootstrap: the Scraping Browser header bootstrap (Colruyt pattern) writes a "bootstrap" line and counts against the caps', async () => {
  const KEY = 'TESTKEY-abc123XYZ';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-cov-bs-'));
  const dirs = ensureDirs(appDirs(root));
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1, recovery: false, maxProducts: 50, brightData: { browserAuth: SB_AUTH, scrapingBrowserBootstrap: { 'shop.test': { requestUrlPattern: '^https://api[.]shop[.]test/', headers: ['X-Api-Key'] } } } }));
  const recipe = { endpoint_tpl: 'https://api.shop.test/search?size={size}&skip={skip}', headers: { 'X-Api-Key': { from: 'https://www.shop.test/', pattern: 'X-Api-Key:\\s*([A-Za-z0-9-]+)' } }, pagination: { type: 'offset', param: 'skip', size_param: 'size', size: 5, total_json_path: 'total' }, json_path: 'items', field_map: { name: 'n', price: 'p', sku: 'id', url: { template: 'https://www.shop.test/p/{id}' } } };
  fs.writeFileSync(path.join(dirs.data, 'domain-profiles.json'), JSON.stringify({ 'shop.test': { internal_api: recipe, internalApiMeta: { status: 'candidate', version: 1, success_count: 0, fail_count: 0, consecutive_fails: 0, last_verified: new Date().toISOString() }, runs: 1 } }));
  const recipeHttpGet = async (url, { headers = {} } = {}) => {
    if (url === 'https://www.shop.test/') return { status: 456, body: '' };
    const k = Object.entries(headers).find(([h]) => h.toLowerCase() === 'x-api-key');
    if (!k || k[1] !== KEY) return { status: 401, body: {} };
    return { status: 200, body: { total: 2, items: [{ n: 'Tee', p: 9, id: 't1' }, { n: 'Cap', p: 7, id: 'c1' }] } };
  };
  const connect = async () => {
    const L = {}, cdpL = {};
    const cdp = { on: (e, cb) => { (cdpL[e] = cdpL[e] || []).push(cb); }, send: async () => ({}) };
    const page = { route: async () => {}, goto: async () => { for (const cb of (cdpL['Network.loadingFinished'] || [])) cb({ encodedDataLength: 120000 }); const api = { url: () => 'https://api.shop.test/search?size=5&skip=0', method: () => 'GET', resourceType: () => 'fetch', headers: () => ({ 'x-api-key': KEY }) }; for (const cb of (L.request || [])) await cb(api); return { status: () => 200 }; }, content: async () => '<html></html>', waitForSelector: async () => {} };
    const ctx = { on: (e, cb) => { (L[e] = L[e] || []).push(cb); }, newPage: async () => page, newCDPSession: async () => cdp, cookies: async () => [] };
    return { contexts: () => [ctx], close: async () => {} };
  };
  const resolveIo = () => ({ secure: {}, config: JSON.parse(fs.readFileSync(dirs.configFile, 'utf8')), env: {} });
  const runtime = new ProviderRuntime({}, { isConfigured: (id) => isConfigured(id, resolveIo()) });
  const ledgerDir = path.join(root, 'usage-ledger');
  const meter = createMeter({ ledger: createLedger({ dir: ledgerDir, secrets: () => [SB_AUTH, KEY] }), runtime });
  const ctrl = createController({ dirs, emit: () => {}, providerRuntime: runtime, meter });
  await ctrl.start({ origin: ORIGIN, store: 'demo', browser: false, fetcher: new Blocked(), recipeHttpGet, scrapingBrowserConnect: connect });
  const ls = (await queryLedger(ledgerDir, {}, { limit: 100 })).rows;
  const bs = ls.find((l) => l.route === 'bootstrap');
  assert.ok(bs, 'bootstrap line written');
  assert.equal(bs.provider, 'scrapingbrowser'); assert.equal(bs.outcome, 'success'); assert.equal(bs.bytes, 120000);
  assert.equal(runtime.usageFor('brightData.scrapingBrowser').callsThisMonth, 1, 'the bootstrap session now counts against the Scraping Browser caps');
  const local = ls.find((l) => l.provider === 'local');
  assert.equal(local.products, 2, 'products came from the (free) recipe replay');
  const txt = ledgerFiles(ledgerDir).map((f) => fs.readFileSync(f, 'utf8')).join('');
  assert.equal(txt.includes(KEY), false, 'captured header value never in the ledger');
});

test('bootstrap: the admin kill switch also stops the bootstrap session (recorded, not sent)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-cov-bs2-'));
  const dirs = ensureDirs(appDirs(root));
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1, recovery: false, brightData: { browserAuth: SB_AUTH, scrapingBrowserBootstrap: { 'shop.test': { requestUrlPattern: '^https://api[.]shop[.]test/', headers: ['X-Api-Key'] } } } }));
  fs.writeFileSync(path.join(dirs.data, 'domain-profiles.json'), JSON.stringify({ 'shop.test': { internal_api: { endpoint_tpl: 'https://api.shop.test/s?skip={skip}', headers: { 'X-Api-Key': { from: 'https://www.shop.test/', pattern: 'K:(\\w+)' } }, pagination: { type: 'offset', param: 'skip', size: 5 }, json_path: 'items', field_map: { name: 'n' } }, internalApiMeta: { status: 'candidate', version: 1, success_count: 0, fail_count: 0, consecutive_fails: 0, last_verified: new Date().toISOString() }, runs: 1 } }));
  const resolveIo = () => ({ secure: {}, config: JSON.parse(fs.readFileSync(dirs.configFile, 'utf8')), env: {} });
  const runtime = new ProviderRuntime({ killSwitch: true }, { isConfigured: (id) => isConfigured(id, resolveIo()) });
  const ledgerDir = path.join(root, 'usage-ledger');
  let connects = 0;
  const ctrl = createController({ dirs, emit: () => {}, providerRuntime: runtime, meter: createMeter({ ledger: createLedger({ dir: ledgerDir }), runtime }) });
  await ctrl.start({ origin: ORIGIN, store: 'demo', browser: false, fetcher: new Blocked(), recipeHttpGet: async () => ({ status: 456, body: '' }), scrapingBrowserConnect: async () => { connects++; throw new Error('must not connect'); } });
  assert.equal(connects, 0);
  const bs = (await queryLedger(ledgerDir, { provider: 'scrapingbrowser' })).rows.find((l) => l.route === 'bootstrap');
  assert.equal(bs.outcome, 'skipped'); assert.equal(bs.reason, 'kill_switch'); assert.equal(bs.attempted, false);
});
