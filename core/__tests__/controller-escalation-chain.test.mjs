/**
 * Chantier B2 — paid escalation as a CHAIN, through the REAL controller, offline: when
 * the first allowed paid route fails (block, error, empty, silence), the next allowed
 * route is tried, in the configured order, up to `escalation.maxRoutesPerPage`; every
 * attempt and every refusal is a ledger line (schema v1 unchanged); opt-in, caps, the
 * kill switch and the per-site switch hold for each route; the route that worked is
 * remembered for the host; the admin job view shows the chain. Every provider call is
 * faked (the global fetch is replaced, the Scraping Browser connect is injected).
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
import { reportView } from '../../app/admin/usage-ipc.mjs';

const ORIGIN = 'https://www.shop.test/c/shoes';
const FC_KEY = 'fc-TESTKEY0123456789abcdef';
const BD_KEY = 'BDTESTKEY-0123456789';
const SB_AUTH = 'brd-customer-TCID-zone-mcp_browser:S3CRETPW';
const ALL_OPTED = { firecrawl: { apiKey: FC_KEY, domains: ['shop.test'] }, brightData: { apiKey: BD_KEY, browserAuth: SB_AUTH, domains: ['shop.test'], scrapingBrowserDomains: ['shop.test'] } };
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
const json = (status, body) => ({ status, ok: status < 400, json: async () => body, text: async () => JSON.stringify(body) });
const FC_OK = () => json(200, { success: true, data: { html: NEXT, markdown: '', metadata: { creditsUsed: 1 } } });
// A failure Firecrawl does not ask to retry (a 5xx is retried within the route budget).
const FC_FAIL = () => json(403, { success: false, error: 'upstream' });
const WU_OK = () => ({ status: 200, ok: true, text: async () => NEXT, json: async () => ({}) });
const WU_FAIL = () => ({ status: 500, ok: false, text: async () => 'upstream error', json: async () => ({}) });

/** Replace the global fetch: provider hosts get the scripted reply, everything else 404. */
function fakeFetch({ firecrawl = FC_OK, unlocker = WU_OK } = {}) {
  const calls = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url); calls.push(u);
    if (u.startsWith('https://api.firecrawl.dev/v2/scrape')) return firecrawl(opts);
    if (u.startsWith('https://api.brightdata.com/request')) return unlocker(opts);
    return { status: 404, ok: false, json: async () => ({}), text: async () => '' };
  };
  return { calls, fc: () => calls.filter((c) => c.includes('firecrawl.dev')).length, wu: () => calls.filter((c) => c.includes('brightdata.com')).length, restore: () => { globalThis.fetch = prev; } };
}
/** A fake Scraping Browser: `ok` → renders NEXT; else the connect fails. */
const sbConnectOf = (ok, counter) => async () => {
  counter.n += 1;
  if (!ok) throw new Error('connect refused');
  const cdpL = {};
  const cdp = { on: (e, cb) => { (cdpL[e] = cdpL[e] || []).push(cb); }, send: async () => ({}) };
  const page = { route: async () => {}, goto: async () => { for (const cb of (cdpL['Network.loadingFinished'] || [])) cb({ encodedDataLength: 50000 }); return { status: () => 200 }; }, content: async () => NEXT, waitForSelector: async () => {}, setDefaultNavigationTimeout: () => {} };
  const ctx = { on: () => {}, newPage: async () => page, newCDPSession: async () => cdp };
  return { contexts: () => [ctx], close: async () => {} };
};

function setup({ config = {}, caps = null, runtimeState = {}, sbOk = false, profile = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-chain-'));
  made.push(root);
  const dirs = ensureDirs(appDirs(root));
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1, recovery: false, maxProducts: 20, ...config }, null, 2));
  if (profile) fs.writeFileSync(path.join(dirs.data, 'domain-profiles.json'), JSON.stringify({ 'shop.test': profile }));
  const resolveIo = () => ({ secure: {}, config: JSON.parse(fs.readFileSync(dirs.configFile, 'utf8')), env: {} });
  const runtime = new ProviderRuntime(runtimeState, { isConfigured: (id) => isConfigured(id, resolveIo()) });
  if (caps) for (const [id, c] of Object.entries(caps)) runtime.setCap(id, c);
  const ledgerDir = path.join(root, 'usage-ledger');
  const meter = createMeter({ ledger: createLedger({ dir: ledgerDir, secrets: () => [FC_KEY, BD_KEY, SB_AUTH, 'S3CRETPW'] }), runtime, readConfig: () => resolveIo().config });
  const events = [];
  const sbCount = { n: 0 };
  const ctrl = createController({ dirs, emit: (t, p) => events.push({ t, p }), providerRuntime: runtime, meter });
  const run = (extra = {}) => ctrl.start({ origin: ORIGIN, store: 'demo', browser: false, fetcher: new Blocked(), scrapingBrowserConnect: sbConnectOf(sbOk, sbCount), ...extra });
  const lines = async () => (await queryLedger(ledgerDir, { provider: ['firecrawl', 'webunlocker', 'scrapingbrowser'] }, { limit: 100 })).rows.reverse();
  const report = () => { const id = events.find((e) => e.t === 'done').p.jobId; return JSON.parse(fs.readFileSync(path.join(dirs.data, 'reports', `${id}.json`), 'utf8').replace(/^﻿/, '')); };
  const profileOf = () => { try { return JSON.parse(fs.readFileSync(path.join(dirs.data, 'domain-profiles.json'), 'utf8'))['shop.test']; } catch { return null; } };
  return { dirs, ctrl, run, runtime, lines, events, report, sbCount, profileOf, done: () => events.find((e) => e.t === 'done').p };
}
const byProvider = (ls) => Object.fromEntries(ls.map((l) => [l.provider, l]));

test('first route fails, second succeeds: two attempts in the ledger, products from the second, third route "priority"', async () => {
  const f = fakeFetch({ firecrawl: FC_FAIL, unlocker: WU_OK });
  try {
    const s = setup({ config: ALL_OPTED });
    await s.run();
    assert.equal(f.fc(), 1); assert.equal(f.wu(), 1); assert.equal(s.sbCount.n, 0);
    const b = byProvider(await s.lines());
    assert.equal(b.firecrawl.outcome, 'failed'); assert.equal(b.firecrawl.reason, 'http_403'); assert.equal(b.firecrawl.attempted, true);
    assert.equal(b.webunlocker.outcome, 'success'); assert.equal(b.webunlocker.attempted, true); assert.ok(b.webunlocker.products >= 3);
    assert.equal(b.scrapingbrowser.outcome, 'skipped'); assert.equal(b.scrapingbrowser.reason, 'priority'); assert.equal(b.scrapingbrowser.attempted, false);
    assert.equal(s.done().status, 'done'); assert.ok(s.done().counts.detected >= 3);
    const rep = s.report();
    assert.deepEqual(rep.unlockChain.map((c) => [c.provider, c.attempted, c.outcome]), [['firecrawl', true, 'failed'], ['web-unlocker', true, 'success']]);
    assert.equal(rep.unlock.provider, 'web-unlocker'); assert.equal(rep.unlock.ok, true, 'report.unlock = the route that delivered');
    assert.deepEqual(reportView(rep).unlockChain.map((c) => c.provider), ['firecrawl', 'web-unlocker'], 'the admin job view carries the chain');
    assert.equal(s.runtime.usageFor('firecrawl').callsThisMonth, 1); assert.equal(s.runtime.usageFor('brightData.webUnlocker').callsThisMonth, 1, 'both attempts count against their caps');
    const p = s.profileOf();
    assert.equal(p.unlockRoute, 'web-unlocker'); assert.equal(p.needsUnlock, true); // `method` is the discovery method, rewritten at the end of every job (unchanged)
  } finally { f.restore(); }
});

test('every route fails: three attempts, three lines, no product, the run ends blocked', async () => {
  const f = fakeFetch({ firecrawl: FC_FAIL, unlocker: WU_FAIL });
  try {
    const s = setup({ config: ALL_OPTED, sbOk: false });
    await s.run();
    assert.equal(f.fc(), 1); assert.equal(f.wu(), 1); assert.equal(s.sbCount.n, 1);
    const ls = await s.lines();
    assert.deepEqual(ls.map((l) => [l.provider, l.attempted, l.outcome]), [['firecrawl', true, 'failed'], ['webunlocker', true, 'failed'], ['scrapingbrowser', true, 'failed']]);
    assert.equal(s.done().counts.detected, 0); assert.match(s.done().status, /^stopped:/);
    assert.equal(s.report().unlockChain.length, 3);
    assert.equal(s.profileOf() && s.profileOf().unlockRoute, undefined, 'nothing worked: no route remembered');
  } finally { f.restore(); }
});

test('cap reached on the first route: blocked_by_cap (not sent), the next route is tried; a cap reached BY the first attempt blocks the next', async () => {
  const f = fakeFetch({ firecrawl: FC_OK, unlocker: WU_OK });
  try {
    const s = setup({ config: ALL_OPTED, caps: { firecrawl: { maxCallsPerMonth: 0 } } });
    await s.run();
    assert.equal(f.fc(), 0); assert.equal(f.wu(), 1);
    const b = byProvider(await s.lines());
    assert.equal(b.firecrawl.outcome, 'blocked_by_cap'); assert.equal(b.firecrawl.attempted, false);
    assert.equal(b.webunlocker.outcome, 'success');
    assert.deepEqual(s.report().unlockChain.map((c) => [c.provider, c.outcome]), [['firecrawl', 'blocked_by_cap'], ['web-unlocker', 'success']]);
  } finally { f.restore(); }
  // Month cap of 1 call shared by… no: each provider has its own cap. The per-job cap
  // re-check: Firecrawl fails and the Web Unlocker's cap is already full → blocked_by_cap.
  const g = fakeFetch({ firecrawl: FC_FAIL, unlocker: WU_OK });
  try {
    const s = setup({ config: ALL_OPTED, caps: { 'brightData.webUnlocker': { maxCallsPerMonth: 0 } }, sbOk: true });
    await s.run();
    assert.equal(g.fc(), 1); assert.equal(g.wu(), 0); assert.equal(s.sbCount.n, 1);
    const b = byProvider(await s.lines());
    assert.equal(b.webunlocker.outcome, 'blocked_by_cap'); assert.equal(b.scrapingbrowser.outcome, 'success');
  } finally { g.restore(); }
});

test('opt-in absent: a route not opted in is never tried (blocked_no_optin), even after a failure of the first', async () => {
  const f = fakeFetch({ firecrawl: FC_FAIL, unlocker: WU_OK });
  try {
    const s = setup({ config: { firecrawl: { apiKey: FC_KEY, domains: ['shop.test'] }, brightData: { apiKey: BD_KEY, browserAuth: SB_AUTH } } });
    await s.run();
    assert.equal(f.fc(), 1); assert.equal(f.wu(), 0); assert.equal(s.sbCount.n, 0);
    const b = byProvider(await s.lines());
    assert.equal(b.webunlocker.outcome, 'blocked_no_optin'); assert.equal(b.scrapingbrowser.outcome, 'blocked_no_optin');
    assert.equal(s.done().counts.detected, 0);
  } finally { f.restore(); }
});

test('"Tout désactiver" (kill switch): no route is tried, each is recorded skipped with kill_switch', async () => {
  const f = fakeFetch();
  try {
    const s = setup({ config: ALL_OPTED, runtimeState: { killSwitch: true } });
    await s.run();
    assert.equal(f.fc(), 0); assert.equal(f.wu(), 0); assert.equal(s.sbCount.n, 0);
    const ls = await s.lines();
    assert.equal(ls.length, 3);
    assert.ok(ls.every((l) => l.outcome === 'skipped' && l.reason === 'kill_switch' && l.attempted === false));
  } finally { f.restore(); }
});

test('limit of routes per page: escalation.maxRoutesPerPage=1 → one attempt, the others skipped with max_routes', async () => {
  const f = fakeFetch({ firecrawl: FC_FAIL, unlocker: WU_OK });
  try {
    const s = setup({ config: { ...ALL_OPTED, escalation: { maxRoutesPerPage: 1 } } });
    await s.run();
    assert.equal(f.fc(), 1); assert.equal(f.wu(), 0); assert.equal(s.sbCount.n, 0);
    const b = byProvider(await s.lines());
    assert.equal(b.firecrawl.outcome, 'failed');
    assert.equal(b.webunlocker.outcome, 'skipped'); assert.equal(b.webunlocker.reason, 'max_routes');
    assert.equal(b.scrapingbrowser.outcome, 'skipped'); assert.equal(b.scrapingbrowser.reason, 'max_routes');
    assert.equal(s.done().counts.detected, 0);
  } finally { f.restore(); }
});

test('memory: the route that worked last time for the host is tried first', async () => {
  const f = fakeFetch({ firecrawl: FC_OK, unlocker: WU_OK });
  try {
    const s = setup({ config: ALL_OPTED, profile: { unlockRoute: 'web-unlocker', needsUnlock: true, runs: 1 } });
    await s.run();
    assert.equal(f.wu(), 1); assert.equal(f.fc(), 0, 'Firecrawl was not needed: the remembered Web Unlocker went first and delivered');
    const b = byProvider(await s.lines());
    assert.equal(b.webunlocker.outcome, 'success'); assert.equal(b.firecrawl.reason, 'priority');
    assert.deepEqual(s.report().unlockChain.map((c) => c.provider), ['web-unlocker']);
  } finally { f.restore(); }
});

test('time budget per route: a silent route is recorded as timeout and the chain moves on', async () => {
  let release = null;
  const hang = () => new Promise((r) => { release = r; }); // Firecrawl never answers
  const f = fakeFetch({ firecrawl: hang, unlocker: WU_OK });
  try {
    const s = setup({ config: { ...ALL_OPTED, escalation: { routeTimeoutMs: 1000 } } });
    const t0 = Date.now();
    await s.run();
    assert.ok(Date.now() - t0 < 10000, 'the run did not wait for the silent route');
    const b = byProvider(await s.lines());
    assert.equal(b.firecrawl.outcome, 'timeout'); assert.equal(b.firecrawl.reason, 'timeout'); assert.equal(b.firecrawl.attempted, true, 'the request left: it counts');
    assert.equal(b.webunlocker.outcome, 'success');
    assert.equal(s.report().unlockChain[0].timedOut, true);
    assert.ok(s.done().counts.detected >= 3);
  } finally { if (release) release(FC_OK()); f.restore(); }
});

test('the ledger lines keep the v1 shape (+ cacheState, v0.5.37) and never carry a credential', async () => {
  const f = fakeFetch({ firecrawl: () => json(403, { error: `denied ${FC_KEY}` }), unlocker: WU_OK });
  try {
    const s = setup({ config: ALL_OPTED });
    await s.run();
    const ls = await s.lines();
    for (const l of ls) assert.deepEqual(Object.keys(l), ['v', 'ts', 'jobId', 'domain', 'url', 'provider', 'route', 'channel', 'outcome', 'attempted', 'reason', 'products', 'bytes', 'durationMs', 'credits', 'units', 'upstream', 'model', 'tokensIn', 'tokensOut', 'costUsd', 'costBasis', 'testMode', 'appVersion', 'cacheState']);
    assert.equal(JSON.stringify(ls).includes(FC_KEY), false); assert.equal(JSON.stringify(ls).includes('S3CRETPW'), false);
  } finally { f.restore(); }
});
