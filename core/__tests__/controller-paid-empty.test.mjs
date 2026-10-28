/**
 * A paid route whose page came back WITHOUT any product is `empty` in the ledger
 * (billed, not a success), the chain moves on, and the admin view says so; the job's
 * own product limit (the form's maximum) is written in the report when it cuts a
 * page. Through the REAL controller, offline: the global fetch is replaced.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appDirs, ensureDirs } from '../../lib/osenv.mjs';
import { createController } from '../../app/controller.mjs';
import { createLedger, OUTCOMES } from '../metering/ledger.mjs';
import { createMeter } from '../metering/meter.mjs';
import { queryLedger, summarizeLedger } from '../metering/reader.mjs';
import { ProviderRuntime } from '../providers/runtime.mjs';
import { isConfigured } from '../providers/registry.mjs';
import { reportView } from '../../app/admin/usage-ipc.mjs';
import { OUTCOME_LABEL, OUTCOME_TONE, paidForNothing, passeParLine } from '../../app/renderer/admin-usage-ui.js';
import { outcomeLabel } from '../../scripts/ops-last-scraps.mjs';

const ORIGIN = 'https://www.shop.test/c/shoes';
const FC_KEY = 'fc-TESTKEY0123456789abcdef';
const BD_KEY = 'BDTESTKEY-0123456789';
const ALL_OPTED = { firecrawl: { apiKey: FC_KEY, domains: ['shop.test'] }, brightData: { apiKey: BD_KEY, domains: ['shop.test'] } };
const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

class Blocked {
  constructor() { this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; this.userAgent = 't'; }
  async get(u) { this.stats.requests++; return { ok: false, status: 403, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body: '<html><title>Access Denied</title></html>', bytes: 40, headers: {}, error: null, blocked: true }; }
  async getText(u) { return this.get(u); }
}
const grid = (n) => `<!doctype html><html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { products: Array.from({ length: n }, (_, i) => ({ name: `Runner ${i + 1}`, price: 50 + i, url: `https://www.shop.test/p/runner-${i + 1}`, image: `https://cdn.shop.test/${i + 1}.jpg`, sku: `R${i + 1}` })) } } })}</script></body></html>`;
const EMPTY_PAGE = '<!doctype html><html><head><title>Shoes</title></head><body><div id="root"><p>Chargement…</p></div></body></html>';
const json = (status, body) => ({ status, ok: status < 400, json: async () => body, text: async () => JSON.stringify(body) });

function fakeFetch({ firecrawlHtml, unlockerHtml }) {
  const prev = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://api.firecrawl.dev/v2/scrape')) return json(200, { success: true, data: { html: firecrawlHtml, markdown: '', metadata: { creditsUsed: 1 } } });
    if (u.startsWith('https://api.brightdata.com/request')) return { status: 200, ok: true, text: async () => unlockerHtml, json: async () => ({}) };
    return { status: 404, ok: false, json: async () => ({}), text: async () => '' };
  };
  return { restore: () => { globalThis.fetch = prev; } };
}

function setup(config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-empty-'));
  made.push(root);
  const dirs = ensureDirs(appDirs(root));
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1, recovery: false, maxProducts: 20, ...ALL_OPTED, ...config }, null, 2));
  const resolveIo = () => ({ secure: {}, config: JSON.parse(fs.readFileSync(dirs.configFile, 'utf8')), env: {} });
  const runtime = new ProviderRuntime({}, { isConfigured: (id) => isConfigured(id, resolveIo()) });
  const ledgerDir = path.join(root, 'usage-ledger');
  const meter = createMeter({ ledger: createLedger({ dir: ledgerDir, secrets: () => [FC_KEY, BD_KEY] }), runtime, readConfig: () => resolveIo().config });
  const events = [];
  const ctrl = createController({ dirs, emit: (t, p) => events.push({ t, p }), providerRuntime: runtime, meter });
  const run = () => ctrl.start({ origin: ORIGIN, store: 'demo', browser: false, fetcher: new Blocked() });
  const lines = async () => (await queryLedger(ledgerDir, { provider: ['firecrawl', 'webunlocker', 'scrapingbrowser'] }, { limit: 100 })).rows.reverse();
  const report = () => { const id = events.find((e) => e.t === 'done').p.jobId; return JSON.parse(fs.readFileSync(path.join(dirs.data, 'reports', `${id}.json`), 'utf8').replace(/^﻿/, '')); };
  return { dirs, ledgerDir, run, lines, events, report, done: () => events.find((e) => e.t === 'done').p };
}

test('a page received without any product is `empty` (billed, not a success); the chain goes on to the next route', async () => {
  const f = fakeFetch({ firecrawlHtml: EMPTY_PAGE, unlockerHtml: grid(3) });
  try {
    const s = setup();
    await s.run();
    const ls = await s.lines();
    const b = Object.fromEntries(ls.map((l) => [l.provider, l]));
    assert.equal(b.firecrawl.outcome, 'empty'); assert.equal(b.firecrawl.attempted, true); assert.equal(b.firecrawl.products, 0); assert.equal(b.firecrawl.credits, 1);
    assert.equal(b.webunlocker.outcome, 'success'); assert.equal(b.webunlocker.products, 3);
    const rep = s.report();
    assert.deepEqual(rep.unlockChain.map((c) => [c.provider, c.outcome, c.products]), [['firecrawl', 'empty', 0], ['web-unlocker', 'success', 3]]);
    assert.equal(reportView(rep).unlockChain[0].outcome, 'empty');
    assert.equal(s.done().counts.accepted, 3);
    // Every reader knows the value: the ledger vocabulary, the admin labels, the ops script.
    assert.ok(OUTCOMES.includes('empty'));
    assert.equal(OUTCOME_LABEL.empty, 'Page reçue, aucun produit'); assert.equal(OUTCOME_TONE.empty, 'warn');
    assert.equal(OUTCOME_LABEL.success, 'Produits trouvés');
    assert.equal(paidForNothing(b.firecrawl), true); assert.equal(paidForNothing(b.webunlocker), false);
    assert.equal(outcomeLabel(b.firecrawl), 'page reçue, aucun produit');
    const pp = passeParLine(ls, { unlocked: true });
    assert.match(pp.text, /Firecrawl \(page reçue, aucun produit\) → Bright Data Web Unlocker/);
    const sum = await summarizeLedger(s.ledgerDir);
    assert.equal(sum.periods.month.byProvider.firecrawl.empty, 1, 'the aggregate counts the empty page');
    assert.equal(sum.periods.month.byProvider.firecrawl.calls, 1, 'and still counts the call (it was billed)');
    assert.equal(sum.lastError.firecrawl, undefined, 'an empty page is not an error of the provider');
  } finally { f.restore(); }
});

test('the form\'s product limit cuts a page: kept count recorded, the page\'s real count in the report', async () => {
  const f = fakeFetch({ firecrawlHtml: grid(8), unlockerHtml: grid(8) });
  try {
    const s = setup({ maxProducts: 2 });
    await s.run();
    const rep = s.report();
    assert.deepEqual(rep.productLimit, { max: 2, read: 8, kept: 2 });
    assert.equal(s.done().counts.accepted, 2);
    const ls = await s.lines();
    assert.equal(ls.find((l) => l.provider === 'firecrawl').products, 2, 'the ledger keeps what the job kept');
    assert.ok(rep.notes.some((n) => /product limit reached \(2/.test(n)));
  } finally { f.restore(); }
});
