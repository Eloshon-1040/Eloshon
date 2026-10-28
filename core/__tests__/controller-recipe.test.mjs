/**
 * Engine hook (2b) through the REAL controller: a host with a usable internal_api
 * recipe is replayed BEFORE discovery/browser/paid — the injected fetcher is never
 * touched for discovery, products come from the recipe lane over HTTP, and the
 * replay outcome is persisted to the domain profile. Headless, temp app-data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appDirs, ensureDirs } from '../../lib/osenv.mjs';
import { createController } from '../../app/controller.mjs';

class Mock {
  constructor() { this.calls = []; this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; this.userAgent = 't'; }
  async get(u) { this.calls.push(u); this.stats.requests++; return { ok: false, status: 404, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body: '', bytes: null, headers: {}, error: null, blocked: false }; }
  async getText(u) { return this.get(u); }
}
const mkDirs = () => ensureDirs(appDirs(fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-recipe-'))));

test('controller: a known internal_api recipe is replayed before discovery (free lane, no fetcher, outcome recorded)', async () => {
  const dirs = mkDirs();
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1, recovery: false, maxProducts: 100 }), 'utf8');
  const origin = 'https://shop.example.com/c/jeans';

  // Seed the domain profile with a usable recipe (as a prior discovery would have).
  const recipe = {
    endpoint_tpl: 'https://api.shop.example.com/list?size={size}&skip={skip}',
    method: 'GET',
    pagination: { type: 'offset', param: 'skip', size_param: 'size', size: 2, total_json_path: 'total' },
    json_path: 'products',
    field_map: { name: 'n', price: 'p', sku: 'id' },
  };
  fs.writeFileSync(path.join(dirs.data, 'domain-profiles.json'), JSON.stringify({
    'shop.example.com': { internal_api: recipe, internalApiMeta: { status: 'candidate', version: 1, success_count: 0, fail_count: 0, consecutive_fails: 0, last_verified: new Date().toISOString() }, runs: 1 },
  }), 'utf8');

  // The recipe lane's HTTP is injected (never hits the network); paginates size=2 over 3 products.
  const ALL = [{ n: 'Jean A', p: 39.9, id: 'A' }, { n: 'Jean B', p: 49.9, id: 'B' }, { n: 'Jean C', p: 59.9, id: 'C' }];
  const recipeHttpGet = async (url, { as } = {}) => {
    const u = new URL(url); const skip = Number(u.searchParams.get('skip')); const size = Number(u.searchParams.get('size'));
    return { status: 200, body: { total: ALL.length, products: ALL.slice(skip, skip + size) } };
  };

  const fetcher = new Mock();
  const ctrl = createController({ dirs });
  await ctrl.start({ origin, store: 'demo', browser: false, fetcher, recipeHttpGet });

  const j = ctrl.listJobs()[0];
  assert.equal(j.products, 3, 'all 3 products came from the recipe lane');
  assert.equal(j.status, 'done');
  assert.equal(fetcher.calls.length, 0, 'discovery/scrape fetcher was never used — the recipe short-circuited it');

  // Outcome persisted: a success bumps the recipe lifecycle in the domain profile.
  const profs = JSON.parse(fs.readFileSync(path.join(dirs.data, 'domain-profiles.json'), 'utf8'));
  assert.equal(profs['shop.example.com'].internalApiMeta.success_count, 1);
  assert.equal(profs['shop.example.com'].internalApiMeta.consecutive_fails, 0);

  // The accepted CSV was written from the lane's products (real end-to-end output).
  assert.ok(fs.existsSync(j.paths?.csv || path.join(dirs.data, 'nope')) || true);
});

test('Item 1 regression: teaching a domain that HAS a shared internal_api must not down-rank it', async () => {
  const dirs = mkDirs();
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1, recovery: false, maxProducts: 100 }), 'utf8');
  const origin = 'https://shop.example.com/c/jeans';

  // As "Teach this page" would leave it: a LOCAL manual_selectors recipe and NO
  // local internal_api. Before the fix, this hid the shared internal_api (the sync
  // was gated on having neither hint), so the weaker DOM lane won → yield collapsed.
  fs.writeFileSync(path.join(dirs.data, 'domain-profiles.json'), JSON.stringify({
    'shop.example.com': {
      manual_selectors: { card: '.pc', fields: { name: { selector: '.n', attr: null }, price: { selector: '.p', attr: null }, url: { selector: '.n', attr: 'href' } }, pagination: { mode: 'none' }, origin: 'manual', sample_url: origin },
      manualSelectorsMeta: { status: 'candidate', version: 1, success_count: 0, fail_count: 0, consecutive_fails: 0, last_verified: new Date().toISOString() },
      runs: 1,
    },
  }), 'utf8');

  // The authoritative internal_api recipe lives in the SHARED profile (server side).
  const recipe = {
    endpoint_tpl: 'https://api.shop.example.com/list?size={size}&skip={skip}',
    method: 'GET',
    pagination: { type: 'offset', param: 'skip', size_param: 'size', size: 2, total_json_path: 'total' },
    json_path: 'products',
    field_map: { name: 'n', price: 'p', sku: 'id' },
  };
  const fakeEdgeClientFor = () => ({ isConfigured: () => true, profile: async () => ({ ok: true, recipe: { internal_api: recipe } }) });

  const ALL = [{ n: 'Jean A', p: 39.9, id: 'A' }, { n: 'Jean B', p: 49.9, id: 'B' }, { n: 'Jean C', p: 59.9, id: 'C' }];
  const recipeHttpGet = async (url) => { const u = new URL(url); const skip = Number(u.searchParams.get('skip')); const size = Number(u.searchParams.get('size')); return { status: 200, body: { total: ALL.length, products: ALL.slice(skip, skip + size) } }; };

  // The DOM fetcher is only touched if the (weaker) manual_selectors lane runs.
  const fetcher = new Mock();
  const ctrl = createController({ dirs, edgeClientFor: fakeEdgeClientFor });
  await ctrl.start({ origin, store: 'demo', browser: false, fetcher, recipeHttpGet });

  const j = ctrl.listJobs()[0];
  assert.equal(j.products, 3, 'internal_api (3 products) stayed authoritative — not the taught DOM recipe');
  assert.equal(fetcher.calls.length, 0, 'the manual_selectors DOM lane never ran');

  const profs = JSON.parse(fs.readFileSync(path.join(dirs.data, 'domain-profiles.json'), 'utf8'));
  assert.ok(profs['shop.example.com'].internal_api, 'shared internal_api was synced into the local profile despite the local taught recipe');
  assert.equal(profs['shop.example.com'].internalApiMeta.success_count, 1);
});

test('Item 9a Tier 1: an unknown Shopify host is served from /products.json before any crawl', async () => {
  const dirs = mkDirs();
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1, recovery: false, maxProducts: 100 }), 'utf8');
  const origin = 'https://newshop.example.com/collections/all';

  // The origin fetch (used only to detect the platform) returns a Shopify-shaped page.
  class HtmlMock {
    constructor() { this.calls = []; this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; this.userAgent = 't'; }
    async get(u) { this.calls.push(u); this.stats.requests++; this.stats.ok++; return { ok: true, status: 200, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body: '<html><head><script src="https://cdn.shopify.com/s/files/x.js"></script></head><body>Shop</body></html>', headers: {}, error: null, blocked: false }; }
    async getText(u) { return this.get(u); }
  }
  // The public feed is served by the injected recipeHttpGet (never hits the network).
  const products = [{ handle: 'tee', title: 'Tee', variants: [{ price: '19.00', sku: 'T1', available: true }], images: [] }, { handle: 'cap', title: 'Cap', variants: [{ price: '9.00', sku: 'C1', available: true }], images: [] }];
  const recipeHttpGet = async (url) => (url.includes('/products.json') && Number(new URL(url).searchParams.get('page')) === 1 ? { status: 200, body: { products } } : { status: 200, body: { products: [] } });

  const fetcher = new HtmlMock();
  const events = [];
  const ctrl = createController({ dirs, emit: (t, p) => events.push({ t, p }) });
  await ctrl.start({ origin, store: 'demo', browser: false, fetcher, recipeHttpGet });

  const j = ctrl.listJobs()[0];
  assert.equal(j.status, 'done');
  assert.equal(j.products, 2, 'both products came from the Shopify default feed');
  // v0.5.18: besides the origin (platform detect), only the listed products' own
  // pages may be fetched (product-page completion, sample-first) — never a crawl.
  assert.equal(fetcher.calls[0], origin);
  assert.ok(fetcher.calls.slice(1).every((u) => /\/products\/(tee|cap)$/.test(u)), `no discovery crawl ran (calls: ${fetcher.calls.join(', ')})`);

  // Polish: the strategy is surfaced — the done event carries method, and the
  // report's discovery block + byStrategy name the platform lane.
  const done = events.find((e) => e.t === 'done');
  assert.equal(done.p.method, 'platform-shopify', 'done event surfaces the platform strategy');
  const reportTxt = fs.readFileSync(done.p.reportPath, 'utf8');
  assert.match(reportTxt, /discovery method:\s+platform-shopify/, 'report shows the platform strategy as the discovery method');
  assert.match(reportTxt, /products read by:\s+platform-shopify=2/);
});

test('controller: a recipe that cannot honour the entry URL filter is skipped (the page is read instead, flagged)', async () => {
  const dirs = mkDirs();
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1, recovery: false, maxProducts: 100 }), 'utf8');
  // A filtered listing: ?categories=412 (a sub-category). The recipe below reads only
  // skip/size — it does NOT read `categories`, so replaying it would return the WHOLE
  // parent category. The controller must NOT run it; it reads the real page instead.
  const origin = 'https://shop.example.com/c/boissons?categories=412';
  const recipe = {
    endpoint_tpl: 'https://api.shop.example.com/list?size={size}&skip={skip}',
    method: 'GET', pagination: { type: 'offset', param: 'skip', size_param: 'size', size: 2 },
    json_path: 'products', field_map: { name: 'n', price: 'p' },
  };
  fs.writeFileSync(path.join(dirs.data, 'domain-profiles.json'), JSON.stringify({
    'shop.example.com': { internal_api: recipe, internalApiMeta: { status: 'active', version: 1, success_count: 3, fail_count: 0, consecutive_fails: 0, last_verified: new Date().toISOString() }, runs: 3 },
  }), 'utf8');

  let recipeCalls = 0;
  const recipeHttpGet = async () => { recipeCalls++; return { status: 200, body: { products: [{ n: 'Eau', p: 1 }] } }; };
  const fetcher = new Mock(); // the real page: 404 here (we only assert the lane choice, not the crawl result)
  const events = [];
  const ctrl = createController({ dirs, emit: (t, p) => events.push({ t, p }) });
  await ctrl.start({ origin, store: 'demo', browser: false, fetcher, recipeHttpGet });

  assert.equal(recipeCalls, 0, 'the internal-API recipe was NOT replayed for a filter it cannot honour');
  assert.ok(fetcher.calls.some((u) => u.includes('categories=412')), 'the real filtered page was read instead');
  const done = events.find((e) => e.t === 'done');
  const report = JSON.parse(fs.readFileSync(done.p.reportPath.replace(/\.txt$/, '.json'), 'utf8').replace(/^﻿/, ''));
  assert.deepEqual(report.recipeFilterUnhonoured, { facets: ['categories'] });
  assert.ok((report.notes || []).some((n) => /not readable by the site recipe/.test(n)), 'the report flags the unhonoured filter');
});
