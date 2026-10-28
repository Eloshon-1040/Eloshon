/**
 * Caps: "per job" versus "per month" — through the REAL controller, offline.
 *
 * The per-job counters start from zero at every job (they used to grow for the
 * whole life of the config, so a per-job cap behaved like a month cap). The month
 * counters keep growing: they are the ledger's totals, fed by every billable call
 * and raised to the ledger at startup (`meter.reconcile`), so an app restart — even
 * one that loses config.json — never resets the month.
 *
 * Every provider call is faked (the global fetch is replaced); nothing leaves the
 * process.
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

/** The free lanes always hit a 403, so every job reaches the paid escalation. */
class Blocked {
  constructor() { this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; this.userAgent = 't'; }
  async get(u) { this.stats.requests++; return { ok: false, status: 403, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body: '<html><title>Access Denied</title></html>', bytes: 40, headers: {}, error: null, blocked: true }; }
  async getText(u) { return this.get(u); }
}
const NEXT = `<!doctype html><html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { products: [
  { name: 'Runner One', price: 59.9, url: 'https://www.shop.test/p/runner-one', image: 'https://cdn.shop.test/1.jpg', sku: 'R1' },
  { name: 'Runner Two', price: 64.9, url: 'https://www.shop.test/p/runner-two', image: 'https://cdn.shop.test/2.jpg', sku: 'R2' },
] } } })}</script></body></html>`;

function fakeFetch() {
  const calls = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url); calls.push(u);
    if (u.startsWith('https://api.firecrawl.dev/v2/scrape')) return { status: 200, ok: true, json: async () => ({ success: true, data: { html: NEXT, markdown: '', metadata: { creditsUsed: 1 } } }), text: async () => '' };
    return { status: 404, ok: false, json: async () => ({}), text: async () => '' };
  };
  return { paidCalls: () => calls.filter((c) => /firecrawl\.dev/.test(c)).length, restore: () => { globalThis.fetch = prev; } };
}

/** One "app process": a runtime built from the persisted providers state + a meter on the shared ledger folder. */
function appProcess(root, dirs, persistedState, { caps } = {}) {
  const resolveIo = () => ({ secure: {}, config: JSON.parse(fs.readFileSync(dirs.configFile, 'utf8')), env: {} });
  const runtime = new ProviderRuntime(persistedState, { isConfigured: (id) => isConfigured(id, resolveIo()) });
  if (caps) for (const [id, c] of Object.entries(caps)) runtime.setCap(id, c);
  const saved = { state: null, writes: 0 };
  const persist = () => { saved.state = JSON.parse(JSON.stringify(runtime.state)); saved.writes += 1; };
  const ledgerDir = path.join(root, 'usage-ledger');
  const meter = createMeter({ ledger: createLedger({ dir: ledgerDir, secrets: () => [FC_KEY] }), runtime, persist, readConfig: () => resolveIo().config });
  const ctrl = createController({ dirs, emit: () => {}, providerRuntime: runtime, meter, persistProviders: persist });
  const run = () => ctrl.start({ origin: ORIGIN, store: 'demo', browser: false, fetcher: new Blocked() });
  const fcLines = async () => (await queryLedger(ledgerDir, { provider: 'firecrawl' }, { limit: 100 })).rows.reverse();
  return { runtime, meter, ctrl, run, fcLines, saved };
}

function freshFolder() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-caps-'));
  made.push(root);
  const dirs = ensureDirs(appDirs(root));
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1, recovery: false, maxProducts: 20, firecrawl: { apiKey: FC_KEY, domains: ['shop.test'] } }, null, 2));
  return { root, dirs };
}

test('per job: two successive jobs each start from zero on the per-job cap; the month counter keeps counting', async () => {
  const f = fakeFetch();
  try {
    const { root, dirs } = freshFolder();
    const p = appProcess(root, dirs, {}, { caps: { firecrawl: { maxCallsPerJob: 1, maxCallsPerMonth: 100 } } });
    await p.run();
    assert.equal(f.paidCalls(), 1);
    assert.equal(p.runtime.usageFor('firecrawl').callsThisJob, 1);
    await p.run();
    assert.equal(f.paidCalls(), 2, 'the second job was not blocked by the first job\'s call');
    const u = p.runtime.usageFor('firecrawl');
    assert.equal(u.callsThisJob, 1, 'the per-job counter counts this job only');
    assert.equal(u.callsThisMonth, 2, 'the month counter counts both jobs');
    const ls = await p.fcLines();
    assert.deepEqual(ls.map((l) => l.outcome), ['success', 'success']);
    assert.ok(p.saved.writes >= 2 && p.saved.state.usage.firecrawl.callsThisMonth === 2, 'the providers state is persisted at job start and after each call');
  } finally { f.restore(); }
});

test('per month: the month cap blocks when the total reaches it, before the request is sent (blocked_by_cap)', async () => {
  const f = fakeFetch();
  try {
    const { root, dirs } = freshFolder();
    const p = appProcess(root, dirs, {}, { caps: { firecrawl: { maxCallsPerJob: 1, maxCallsPerMonth: 2 } } });
    await p.run(); await p.run();
    assert.equal(f.paidCalls(), 2);
    await p.run();
    assert.equal(f.paidCalls(), 2, 'third job: no request left the app');
    const ls = await p.fcLines();
    assert.equal(ls.length, 3);
    assert.equal(ls[2].outcome, 'blocked_by_cap'); assert.equal(ls[2].reason, 'cap_reached'); assert.equal(ls[2].attempted, false);
  } finally { f.restore(); }
});

test('restart: a new process reads the persisted month total, and even a lost config.json is raised back from the ledger', async () => {
  const f = fakeFetch();
  try {
    const { root, dirs } = freshFolder();
    const caps = { firecrawl: { maxCallsPerJob: 5, maxCallsPerMonth: 2 } };
    const p1 = appProcess(root, dirs, {}, { caps });
    await p1.run(); await p1.run();
    assert.equal(f.paidCalls(), 2);
    // Restart 1: the persisted providers block (config.json) carries the month total.
    const p2 = appProcess(root, dirs, p1.saved.state, { caps });
    await p2.meter.reconcile();
    assert.equal(p2.runtime.usageFor('firecrawl').callsThisMonth, 2, 'the month survives the restart');
    await p2.run();
    assert.equal(f.paidCalls(), 2, 'still blocked after the restart');
    assert.equal((await p2.fcLines()).at(-1).outcome, 'blocked_by_cap');
    // Restart 2: config.json lost (empty state) — the ledger is the source of truth.
    const p3 = appProcess(root, dirs, {}, { caps });
    assert.equal(p3.runtime.usageFor('firecrawl').callsThisMonth, 0, 'before reconcile the cache is empty');
    await p3.meter.reconcile();
    assert.equal(p3.runtime.usageFor('firecrawl').callsThisMonth, 2, 'raised to the ledger total');
    await p3.run();
    assert.equal(f.paidCalls(), 2, 'blocked: the month cap holds without config.json');
    assert.equal((await p3.fcLines()).at(-1).outcome, 'blocked_by_cap');
  } finally { f.restore(); }
});
