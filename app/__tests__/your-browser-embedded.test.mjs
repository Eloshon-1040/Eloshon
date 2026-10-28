/**
 * "Your browser" tier × the generic embedded-state extractor — the gap that made
 * an UNKNOWN SPA catalogue (no recipe, no Product JSON-LD on the list page) return
 * 0 products. The extension's `auto`/`embedded_state` extractors are rebuilt here
 * EXACTLY as the service worker builds them (from the VENDORED shared copy the
 * extension ships), run through the real DSL interpreter, and the products go
 * through the real controller.ingestExternalProducts. A companion test proves a
 * genuinely empty run yields an evidence-based diagnosis and a plain-French reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { runProgram } from '../../shared/dsl/interpret.mjs';
import { extractEmbeddedProducts } from '../../extension/vendor/shared/extract/embedded-state.mjs';
import { extractDomGrid } from '../../extension/vendor/shared/extract/dom-grid.mjs';
import { productsFromCaptures, replayPaginate, enrichFromCaptures } from '../../extension/vendor/shared/extract/xhr-endpoint.mjs';
import { emptyPageDiagnosis } from '../../extension/vendor/shared/classify/empty-diagnosis.mjs';
import { classifyItem, mergeRules } from '../../extension/vendor/shared/classify/page-kind.mjs';
import { outcomeFor } from '../your-browser/launch.mjs';
import { appDirs, ensureDirs } from '../../lib/osenv.mjs';
import { createController } from '../controller.mjs';

// The service worker's `auto`: in-page JSON-LD / item_selector first (here empty,
// as on a generic SPA), then the generic shared embedded-state grid on outerHTML.
function serviceWorkerAuto(domainBase) {
  const embeddedFrom = (ctx) => extractEmbeddedProducts((ctx && ctx.body) || '', (ctx && ctx.url) || domainBase).cards || [];
  return async (ctx) => {
    const dom = []; // content-script auto returns [] on a generic SPA (no JSON-LD, no item_selector)
    if (dom.length) return dom;
    return embeddedFrom(ctx);
  };
}

const SPA_LISTING = (() => {
  const state = { props: { pageProps: { data: {
    products: [
      { name: 'Baskets Alpha', price: { value: 89.95, currencyIso: 'EUR' }, url: '/fr/baskets-alpha/ABC123.html', code: 'ABC123', images: [{ url: 'https://cdn.test/a.jpg' }] },
      { name: 'Baskets Beta', price: { value: 119.99, currencyIso: 'EUR' }, url: '/fr/baskets-beta/DEF456.html', code: 'DEF456', images: [{ url: 'https://cdn.test/b.jpg' }] },
    ],
    pagination: { currentPage: 0, totalPages: 3, totalResults: 60, pageSize: 24 },
  } } } };
  return `<!doctype html><html><head><title>Baskets Hommes</title></head><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(state)}</script></body></html>`;
})();

// The exact graceful-degradation chain the service worker's `auto` runs, rebuilt
// from the VENDORED shared extractors + a mock driver: in-page → embedded-JSON scan
// → DOM-grid; and if all empty, ONE hydration retry (scroll + re-read).
function autoChain(driver, sleep = async () => {}) {
  const genericFrom = (ctx) => {
    const body = (ctx && ctx.body) || ''; const base = (ctx && ctx.url) || 'https://shop.test/';
    const emb = extractEmbeddedProducts(body, base).cards || []; if (emb.length) return emb;
    return extractDomGrid(body, base).cards || [];
  };
  return async (pageCtx) => {
    const once = async (ctx) => { const inPage = await driver.extractInPage(); if (inPage && inPage.length) return inPage; return genericFrom(ctx); };
    let got = await once(pageCtx);
    if (!got.length) { await driver.scroll(); await sleep(0); const ctx2 = await driver.context(); got = await once(ctx2); }
    got = got || [];
    // XHR capture + replay + price-merge stage (mirrors the service worker).
    if (driver.capturedResponses) {
      const caps = await driver.capturedResponses();
      const base = (pageCtx && pageCtx.url) || 'https://shop.test/';
      const best = productsFromCaptures(caps, base);
      if (best && best.cards.length) {
        const all = await replayPaginate({ capture: best.capture, firstCards: best.cards, firstPagination: best.pagination, baseUrl: base, fetchJson: driver.fetchJson, maxProducts: 500, maxPages: 3 });
        if (all.length > got.length) got = all;
      }
      if (got.some((p) => p && p.price == null)) got = enrichFromCaptures(got, caps, base);
    }
    return got;
  };
}

test('graceful degradation: no embedded JSON → the auto chain falls back to the DOM-grid heuristic', async () => {
  const gridHtml = '<html><body><ul>'
    + [1, 2, 3, 4].map((i) => `<li><a href="/product/item-${i}"><img src="/i/${i}.jpg" alt="Article ${i}"></a><a href="/product/item-${i}">Article ${i}</a><span>${10 + i},99 €</span></li>`).join('')
    + '</ul></body></html>';
  const driver = { extractInPage: async () => [], context: async () => ({ url: 'https://shop.test/c/x', body: gridHtml }), scroll: async () => {} };
  const auto = autoChain(driver);
  const cards = await auto({ url: 'https://shop.test/c/x', body: gridHtml });
  assert.equal(cards.length, 4);
  assert.equal(cards[0].strategy, 'dom-grid');
});

test('hydration retry: a grid that loads only AFTER scroll (client-side XHR) is caught on the second read', async () => {
  const shell = '<html><head><title>Jeans</title></head><body><div id="app"></div></body></html>';
  const hydrated = `<html><body><script>window.__STORE={"products":${JSON.stringify([
    { name: 'Jean 1', sku: 'J1', price: 89.95, url: '/product/j-1' },
    { name: 'Jean 2', sku: 'J2', price: 99.95, url: '/product/j-2' },
  ])}}</script></body></html>`;
  let scrolled = false;
  const driver = {
    extractInPage: async () => [],
    context: async () => ({ url: 'https://shop.test/c/jeans', body: scrolled ? hydrated : shell }),
    scroll: async () => { scrolled = true; },
  };
  const auto = autoChain(driver);
  const cards = await auto({ url: 'https://shop.test/c/jeans', body: shell });
  assert.equal(cards.length, 2, 'the grid hydrated after scroll is extracted on retry');
  assert.equal(cards[0].sku, 'J1');
});

test('XHR capture + replay: a pure client-XHR grid (nothing in the HTML) is extracted from the intercepted API and paginated', async () => {
  const prod = (i) => ({ name: `Ref ${i}`, sku: `R${i}`, price: 10 + i, url: `/product/ref-${i}` });
  const shell = '<html><head><title>Liste</title></head><body><div id="app"></div></body></html>'; // no products in HTML
  // The page fetched its grid from a search API (page 0). fetchJson replays it.
  const captures = [
    { url: 'https://s.test/track', status: 200, body: JSON.stringify({ ok: 1 }) },
    { url: 'https://api.s.test/search?page=0&hitsPerPage=3', method: 'GET', status: 200, body: JSON.stringify({ nbHits: 90, page: 0, hitsPerPage: 3, hits: [prod(1), prod(2), prod(3)] }) },
  ];
  const driver = {
    extractInPage: async () => [],
    context: async () => ({ url: 'https://www.s.test/c/x', body: shell }),
    scroll: async () => {},
    capturedResponses: async () => captures,
    fetchJson: async (url) => { const p = Number(new URL(url).searchParams.get('page')); return { hits: [prod(p * 3 + 1), prod(p * 3 + 2), prod(p * 3 + 3)] }; },
  };
  const cards = await autoChain(driver)({ url: 'https://www.s.test/c/x', body: shell });
  assert.equal(cards.length, 9, 'first page (3) + 2 replayed pages (6) from the intercepted API');
  assert.equal(cards[0].sku, 'R1');
});

test('price split (Leroy Merlin pattern): tiles have no price, a separate pricing XHR fills them by sku', async () => {
  // The grid tiles (name/sku/image, NO price) live in an embedded blob; the prices
  // come from a separate pricing API captured from the network → merged by sku.
  const tiles = [
    { name: 'Grillage A', sku: '92735466', url: '/produits/x/a', image: 'https://m/a.jpg' },
    { name: 'Grillage B', sku: '92735467', url: '/produits/x/b', image: 'https://m/b.jpg' },
  ];
  const listingHtml = `<html><body><script>window.__STATE={"catalog":{"items":${JSON.stringify(tiles)}}}</script></body></html>`;
  const captures = [{ url: 'https://www.leroymerlin.fr/api/pricing', status: 200, body: JSON.stringify({ prices: [
    { productId: '92735466', price: { value: 24.9, currency: 'EUR' } },
    { productId: '92735467', price: { value: 39.9, currency: 'EUR' } },
  ] }) }];
  const driver = { extractInPage: async () => [], context: async () => ({ url: 'https://www.leroymerlin.fr/produits/x/', body: listingHtml }), scroll: async () => {}, capturedResponses: async () => captures };
  const cards = await autoChain(driver)({ url: 'https://www.leroymerlin.fr/produits/x/', body: listingHtml });
  assert.equal(cards.length, 2);
  assert.equal(cards.find((c) => c.sku === '92735466').price, 24.9, 'price filled from the pricing XHR');
  assert.equal(cards.find((c) => c.sku === '92735467').price, 39.9);
});

test('generic SPA listing (no recipe, no Product JSON-LD): the auto path extracts the grid from embedded state', async () => {
  const base = 'https://www.shop.test/fr/baskets-hommes';
  const page = { context: async () => ({ url: base, status: 200, body: SPA_LISTING }), waitFor: async () => true };
  const rules = mergeRules();
  const out = await runProgram(
    { actions: [{ op: 'extract', using: 'auto' }] },
    { page, extractors: { auto: serviceWorkerAuto(base) }, now: () => 0, sleep: async () => {}, classifyItem: (i) => classifyItem(i, rules) },
  );
  assert.equal(out.status, 'done');
  assert.equal(out.products.length, 2);
  const a = out.products.find((p) => p.name === 'Baskets Alpha');
  assert.equal(a.price, 89.95);
  assert.equal(a.sku, 'ABC123');
  assert.equal(a.sourceUrl, 'https://www.shop.test/fr/baskets-alpha/ABC123.html');
  assert.equal(a.strategy, 'embedded-state');

  // → through the app's real ingest: accepted products, method recorded.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elo-ybemb-'));
  const controller = createController({ dirs: ensureDirs(appDirs(dir)) });
  const r = await controller.ingestExternalProducts({ products: out.products, store: 'shop', origin: base, method: 'your-browser', details: { extraction: { method: 'embedded-state', methods: ['embedded-state'], count: 2 } } });
  assert.equal(r.counts.accepted >= 1, true);
  const rep = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'reports', `${r.jobId}.json`), 'utf8'));
  assert.equal(rep.yourBrowser.extraction.method, 'embedded-state');
});

test('challenge screenshots are written to the job folder; report keeps file refs, never raw base64', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elo-ybshot-'));
  const controller = createController({ dirs: ensureDirs(appDirs(dir)) });
  // A 1x1 PNG data URL (what the extension would capture).
  const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const r = await controller.ingestExternalProducts({
    products: [], store: 's', origin: 'https://leroymerlin.fr/c/x', method: 'your-browser',
    outcome: { status: 'stopped:blocked', blocked: { code: 'blocked' }, text: 'bloqué' },
    details: { domain: 'leroymerlin.fr', challengeShots: [{ dataUrl: px, url: 'https://leroymerlin.fr/c/x', at: 123 }] },
  });
  const shotPath = path.join(dir, 'data', 'jobs', r.jobId, 'challenge-01.png');
  assert.ok(fs.existsSync(shotPath), 'screenshot written to the job folder');
  const rep = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'reports', `${r.jobId}.json`), 'utf8'));
  assert.deepEqual(rep.yourBrowser.challengeShots, [{ file: 'challenge-01.png', url: 'https://leroymerlin.fr/c/x', at: 123 }]);
  assert.doesNotMatch(JSON.stringify(rep), /data:image|base64/, 'no raw image data in report.json');
});

test('a genuinely empty run is never a dead end: evidence-based diagnosis + a plain-French reason', () => {
  // A bot-shell / interstitial: tiny body, no data, no prices.
  const shell = '<html><head><title>Un instant…</title></head><body><div id="app"></div></body></html>';
  const diag = emptyPageDiagnosis(shell, { url: 'https://www.shop.test/fr/baskets-hommes', status: 200 });
  assert.equal(diag.reasonCode, 'likely_block');

  // The service worker sets reason = `empty:<code>`; the app turns it into a
  // non-technical French detail for the user (raw evidence stays in report.json).
  const outcome = outcomeFor({ status: 'done', products: [], reason: `empty:${diag.reasonCode}` });
  assert.equal(outcome.status, 'stopped:no_products');
  assert.match(outcome.text, /Aucun produit trouvé sur cette page\. Détail : /);
  assert.match(outcome.text, /site protégé ou session non connectée/);
  assert.doesNotMatch(outcome.text, /empty:|embedded|schema|http/i);
});

test('a page that DID carry product data but yielded nothing is diagnosed as a fixable gap, not a block', () => {
  const grid = JSON.stringify({ products: [{ name: 'A', price: 9.9, url: '/p/a-1' }, { name: 'B', price: 5, url: '/p/b-2' }] });
  const body = `<html><head><title>Liste</title></head><body><script>window.__D=${grid}</script>${'<div>'.repeat(400)}</body></html>`;
  const diag = emptyPageDiagnosis(body, { url: 'https://www.shop.test/fr/liste', status: 200 });
  assert.equal(diag.reasonCode, 'unreadable_data');
  const outcome = outcomeFor({ status: 'done', products: [], reason: `empty:${diag.reasonCode}` });
  assert.match(outcome.text, /leur format n’a pas pu être lu/);
});
