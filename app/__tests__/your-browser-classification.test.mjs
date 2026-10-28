/**
 * "Your browser" tier × shared product-page rules — offline. The extension's
 * hooks are built EXACTLY as the service worker builds them, from the VENDORED
 * copy the extension ships (extension/vendor/shared, rebuilt by `pretest`), and
 * run through the real DSL interpreter; results go through the real
 * controller.ingestExternalProducts. A cross-engine test proves both engines
 * reach the same verdict on every fixture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { runProgram } from '../../shared/dsl/interpret.mjs';
import * as SharedRules from '../../shared/classify/page-kind.mjs';
import * as VendoredRules from '../../extension/vendor/shared/classify/page-kind.mjs';
import { runScrape } from '../../core/engine.mjs';
import { appDirs, ensureDirs } from '../../lib/osenv.mjs';
import { createController } from '../controller.mjs';
import { PRODUCT_FIXTURES, NON_PRODUCT_FIXTURES, AMBIGUOUS_FIXTURES, ALL_FIXTURES } from '../../shared/__tests__/fixtures/page-fixtures.mjs';

// Same wiring as extension/background/service-worker.mjs (runJobOnTab env).
function extensionHooks(pageRulesOverrides) {
  const pageRules = VendoredRules.mergeRules(pageRulesOverrides);
  return {
    classifyItem: (item) => VendoredRules.classifyItem(item, pageRules),
    classifyPage: (pageCtx, extracted) => VendoredRules.classifyHtmlPage(pageCtx && pageCtx.body, { url: pageCtx && pageCtx.url, status: pageCtx && pageCtx.status, extracted, rules: pageRules }),
  };
}
const outcomeClass = (kind) => (SharedRules.REJECTED_KINDS.includes(kind) ? 'rejected' : kind === 'uncertain' ? 'doubtful' : 'product');

test('the extension ships the SAME rules as the app (vendored copy is byte-identical)', () => {
  const a = fs.readFileSync(new URL('../../shared/classify/page-kind.mjs', import.meta.url), 'utf8');
  const b = fs.readFileSync(new URL('../../extension/vendor/shared/classify/page-kind.mjs', import.meta.url), 'utf8');
  assert.equal(a, b);
});

class Mock {
  constructor(map) { this.map = map; this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; this.userAgent = 't'; }
  async get(u) {
    const e = this.map[u] || { status: 404, body: '' };
    const status = e.status ?? 200;
    return { ok: status >= 200 && status < 300, status, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body: e.body ?? '', bytes: null, headers: {}, error: null, blocked: false };
  }
  async getText(u) { return this.get(u); }
}

test('both engines reach the same verdict on every fixture (product / rejected / doubtful)', async () => {
  const hooks = extensionHooks();
  const rows = [];
  for (const f of ALL_FIXTURES) {
    const ext = outcomeClass(hooks.classifyPage({ url: f.url, status: f.status, body: f.html }, f.extracted).kind);
    const { products } = await runScrape({ urls: [f.url], store: { slug: 't' }, concurrency: 1, lang: 'fr', useBrowser: false, recovery: true, fetcher: new Mock({ [f.url]: { status: f.status, body: f.html } }) });
    const std = !products.length ? 'rejected' : products[0].__eligibility.code === 'to_verify_page_doubtful' || (products[0].__eligibility.status === 'to_verify' && f.expect === 'uncertain') ? 'doubtful' : 'product';
    rows.push({ id: f.id, ext, std });
  }
  const diverging = rows.filter((r) => r.ext !== r.std);
  assert.deepEqual(diverging, [], JSON.stringify(rows));
});

/** A mock tab: the listing page, then each product page the program visits. */
function mockPage(listingItems, pagesByUrl) {
  const listing = { url: 'https://www.boutique-alpha.test/c/rayon', status: 200, body: '<html><head><title>Rayon</title></head><body></body></html>', __items: listingItems };
  let current = listing;
  return {
    page: { context: async () => current, goto: async (u) => { current = pagesByUrl[u] || { url: u, status: 404, body: '' }; return current; }, waitFor: async () => true },
    extractors: {
      // Listing → the tiles; product page → what a JSON-LD/DOM extractor would read on it.
      auto: async (ctx) => (ctx.__items ? ctx.__items : (ctx.__extracted ? [ctx.__extracted] : [])),
    },
  };
}

test('extension path: tiles filtered, product pages judged before merging, doubtful flagged, dead/category links dropped', async () => {
  const fx = Object.fromEntries(ALL_FIXTURES.map((f) => [f.id, f]));
  const P1 = fx['P1-jsonld-product']; const N3 = fx['N3-soft-404']; const N1 = fx['N1-collection-page']; const A2 = fx['A2-dom-fiche-with-carousel'];
  const asCtx = (f) => ({ url: f.url, status: f.status, body: f.html, __extracted: f.extracted });
  const tiles = [
    { name: 'Chaise Oslo chêne', url: P1.url },                 // real product → merged with its page
    { url: N3.url },                                            // expired ad → page says "not found" → dropped
    { name: 'Chaises', url: N1.url, price: 10.99 },             // category tile → its page is a listing → dropped
    { name: 'Table basse noyer', url: A2.url },                 // doubtful page → kept, flagged
    { name: 'Voir tout', url: 'https://www.boutique-alpha.test/c/promos' }, // CTA tile → rejected at listing time
    { image: 'https://www.boutique-alpha.test/banner.jpg' },    // empty tile → rejected
  ];
  const m = mockPage(tiles, { [P1.url]: asCtx(P1), [N3.url]: asCtx(N3), [N1.url]: asCtx(N1), [A2.url]: asCtx(A2) });
  const out = await runProgram({ actions: [{ op: 'extract', using: 'auto' }, { op: 'followLinks', extract: { using: 'auto' } }] }, {
    page: m.page, extractors: m.extractors, limits: { maxDetailPages: 10 }, now: () => 0, sleep: async () => {}, ...extensionHooks(),
  });
  assert.equal(out.status, 'done');
  const names = out.products.map((p) => p.name);
  assert.deepEqual(names.sort(), ['Chaise Oslo chêne', 'Table basse noyer']);
  const oslo = out.products.find((p) => p.name === 'Chaise Oslo chêne');
  assert.equal(oslo.price, 89, 'a real product page fills the tile');
  assert.equal(oslo._doubtful, undefined);
  const table = out.products.find((p) => p.name === 'Table basse noyer');
  assert.ok(Array.isArray(table._doubtful) && /prix sur la page/.test(table._doubtful[0]));
  const rej = out.pageVerdicts.rejected;
  assert.equal(rej.count, 4);
  assert.deepEqual(Object.keys(rej.byReason).sort(), ['item_cta_tile', 'item_empty', 'listing_schema', 'soft_404']);
  assert.equal(out.pageVerdicts.doubtful.count, 1);

  // → the app's ingest: doubtful stays "to verify" with its reason; the report says why.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'elo-ybcls-'));
  const controller = createController({ dirs: ensureDirs(appDirs(base)) });
  const r = await controller.ingestExternalProducts({ products: out.products, store: 'alpha', origin: 'https://www.boutique-alpha.test/c/rayon', details: { pageVerdicts: out.pageVerdicts } });
  const prods = controller.jobProducts(r.jobId);
  const t = prods.find((p) => p.name === 'Table basse noyer');
  assert.equal(t.status, 'to_verify');
  assert.match(t.reason, /prix sur la page/);
  assert.equal(prods.find((p) => /Oslo/.test(p.name)).status, 'accepted');
  const txt = controller.jobReport(r.jobId).text;
  assert.match(txt, /rejected pages:\s+4 — raisons : /);
  assert.match(txt, /page d’erreur « introuvable »/);
  assert.match(txt, /vignette d’appel à l’action \(« Voir tout »\)/);
  assert.match(txt, /doubtful page:\s+1 kept as "to verify"/);
});

test('ingest is defensive on its own: a tile with no name, url or id is rejected with a reason, never imported', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'elo-ybcls2-'));
  const controller = createController({ dirs: ensureDirs(appDirs(base)) });
  const r = await controller.ingestExternalProducts({ products: [{ name: 'Lampe', price: 30, sku: 'L1' }, { strategy: 'dom' }, { name: 'Découvrir la collection', url: 'https://x.test/c/new' }], store: 's' });
  assert.equal(r.counts.detected, 1);
  const rep = JSON.parse(fs.readFileSync(path.join(base, 'data', 'reports', `${r.jobId}.json`), 'utf8'));
  assert.deepEqual(Object.keys(rep.pageVerdicts.rejected.byReason).sort(), ['item_cta_tile', 'item_empty']);
  assert.equal(rep.duplicates, 0, 'a rejected tile is not miscounted as a duplicate');
});

test('config pageRules reach the extension job (same overrides as the standard engine)', async () => {
  const { buildLaunch } = await import('../your-browser/launch.mjs');
  const cfg = { pageRules: { allowSegments: ['c'] }, yourBrowser: { perDomain: { 'boutique-alpha.test': { enabled: true } } } };
  const b = buildLaunch({ startUrl: 'https://boutique-alpha.test/c/rayon' }, { config: cfg, svc: { started: true, connected: true }, jobId: 'j' });
  assert.deepEqual(b.spec.page_rules, { allowSegments: ['c'] });
  const f = NON_PRODUCT_FIXTURES.find((x) => x.id === 'N7-legal-page');
  assert.equal(extensionHooks(b.spec.page_rules).classifyPage({ url: f.url, status: 200, body: f.html }, f.extracted).kind, 'uncertain');
  assert.ok(PRODUCT_FIXTURES.length && AMBIGUOUS_FIXTURES.length);
});
