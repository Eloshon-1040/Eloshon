/**
 * Through the REAL controller (temp app-data, map-backed fake fetcher, injected
 * fake browser — no network): after the listing and its product pages, the stock
 * per size and the reviews the product pages load with their own requests are
 * learned on ONE page and asked for every product; products without a breadcrumb
 * get the listing page's category trail. products.json + report + done event.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appDirs, ensureDirs } from '../../lib/osenv.mjs';
import { createController } from '../../app/controller.mjs';

const ORIGIN = 'https://www.shop.test/de/w/sale';
const card = (code, name, price) => `<div class="pc"><a class="t" href="/de/t/${name.toLowerCase().replace(/\s+/g, '-')}-Gk1x/${code}">${name}</a><span class="pr">${price},00 €</span></div>`;
const listing = `<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home' }, { '@type': 'ListItem', position: 2, name: 'Kinder' }, { '@type': 'ListItem', position: 3, name: 'Sale' }] })}</script></head><body>${[card('AA1000-001', 'Runner Alpha', 90), card('BB2000-001', 'Trail Beta', 110)].join('')}</body></html>`;
const gt = (code, i) => `5400000${code.replace(/\D/g, '').slice(0, 4)}${i}0`;
const fiche = (code, sizes) => `<html><body><script id="__STATE__" type="application/json">${JSON.stringify({ product: { colorways: [{ styleColor: code, colorDescription: 'Schwarz', prices: { currentPrice: 80, initialPrice: 100, currency: 'EUR' }, description: 'Eine echte, ausreichend lange Produktbeschreibung.', sizes: sizes.map((s, i) => ({ label: s, gtin: gt(code, i) })), images: [`https://cdn.shop.test/${code}-1.jpg`] }], selected: code } })}</script></body></html>`;
const stockUrl = (code) => `https://api.shop.test/available?filter=styleColor(${code})`;
const reviewsUrl = (model) => `https://reviews.shop.test/summary/${model}/de_DE`;

class MapFetcher {
  constructor(map) { this.map = map; this.calls = []; this.headers = {}; this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; this.userAgent = 't'; }
  async get(u, o = {}) { this.calls.push(u); if (o.headers) this.headers[u] = o.headers; const body = this.map[u]; if (body == null) return { ok: false, status: 404, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body: '', bytes: null, headers: {}, error: 'HTTP 404', blocked: false }; return { ok: true, status: 200, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body: typeof body === 'string' ? body : JSON.stringify(body), bytes: null, headers: {}, error: null, blocked: false }; }
  async getText(u) { return this.get(u); }
}

test('stock per size + reviews (learned on one product page) and the listing\'s category trail reach products.json', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-stock-'));
  const dirs = ensureDirs(appDirs(root));
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1, recovery: false, maxProducts: 10 }));
  const recipe = { card: '.pc', fields: { name: { selector: '.t', attr: null }, price: { selector: '.pr', attr: null }, url: { selector: '.t', attr: 'href' } }, pagination: { mode: 'none' } };
  fs.writeFileSync(path.join(dirs.data, 'domain-profiles.json'), JSON.stringify({ 'shop.test': { manual_selectors: recipe, manualSelectorsMeta: { status: 'candidate', version: 1, success_count: 1, fail_count: 0, consecutive_fails: 0, last_verified: new Date().toISOString() }, runs: 1 } }));
  const A = 'https://www.shop.test/de/t/runner-alpha-Gk1x/AA1000-001';
  const B = 'https://www.shop.test/de/t/trail-beta-Gk1x/BB2000-001';
  const fetcher = new MapFetcher({
    [ORIGIN]: listing,
    [A]: fiche('AA1000-001', ['38', '39', '40']),
    [B]: fiche('BB2000-001', ['M', 'L']),
    [stockUrl('BB2000-001')]: { objects: [{ gtin: gt('BB2000-001', 0), available: false, level: 'OOS' }, { gtin: gt('BB2000-001', 1), available: false, level: 'OOS' }] },
    [reviewsUrl('BB2000')]: { rating: 0, directReviewsCount: 0 },
  });
  // The fake browser renders product A and reports the requests that page made itself.
  let rendered = null;
  const browserSession = {
    captureJson: async (u) => { rendered = u; return { captures: [
      { url: stockUrl('AA1000-001'), headers: { 'x-caller-id': 'web' }, json: { objects: [0, 1, 2].map((i) => ({ gtin: gt('AA1000-001', i), available: i !== 2, level: i === 2 ? 'OOS' : 'LOW' })) }, bytes: 500 },
      { url: reviewsUrl('AA1000'), headers: {}, json: { rating: 4.4, directReviewsCount: 18 }, bytes: 300 },
    ], error: null }; },
    collectListing: async () => ({ recipeCardsHtml: [] }), render: async () => ({ html: null }), close: async () => {},
  };
  fetcher.map[stockUrl('AA1000-001')] = { objects: [0, 1, 2].map((i) => ({ gtin: gt('AA1000-001', i), available: i !== 2, level: i === 2 ? 'OOS' : 'LOW' })) };
  fetcher.map[reviewsUrl('AA1000')] = { rating: 4.4, directReviewsCount: 18 };
  const events = [];
  const ctrl = createController({ dirs, emit: (t, p) => events.push({ t, p }) });
  await ctrl.start({ origin: ORIGIN, store: 'demo', browser: true, fetcher, browserSession });
  const done = events.find((e) => e.t === 'done').p;
  assert.equal(rendered, A, 'one product page with sized codes rendered to learn');
  const prods = JSON.parse(fs.readFileSync(path.join(dirs.jobs, done.jobId, 'products.json'), 'utf8'));
  const a = prods.find((p) => p.source_url.endsWith('AA1000-001'));
  const b = prods.find((p) => p.source_url.endsWith('BB2000-001'));
  assert.deepEqual(a.variants.map((v) => [v.name, v.availability, v.stock_level]), [['38', 'InStock', 'low'], ['39', 'InStock', 'low'], ['40', 'OutOfStock', 'none']]);
  assert.equal(a.raw.availability, 'InStock');
  assert.equal(b.raw.availability, 'OutOfStock');
  assert.equal(a.raw.rating, 4.4); assert.equal(a.raw.review_count, 18);
  assert.equal(b.raw.rating, null); assert.equal(b.raw.review_count, 0);
  assert.deepEqual(a.raw.breadcrumb, ['Kinder', 'Sale']);
  assert.match(a.source_category, /^Kinder > Sale/);
  assert.deepEqual(fetcher.headers[stockUrl('BB2000-001')], { 'x-caller-id': 'web' }, 'the learned header is sent');
  assert.equal(done.sideData.availabilityRows, 2); assert.equal(done.sideData.ratingRows, 2);
  assert.equal(done.categoryTrail.products, 2);
  const txt = fs.readFileSync(done.reportPath, 'utf8');
  assert.match(txt, /stock & reviews: +learned on one product page/);
  assert.match(txt, /category trail: +"Kinder > Sale" \(jsonld\) given to 2 product\(s\)/);
});

test('browser fallback OFF: nothing is learned, the listing trail still applies', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-stock2-'));
  const dirs = ensureDirs(appDirs(root));
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1, recovery: false, maxProducts: 10, detailPages: { enabled: false } }));
  const recipe = { card: '.pc', fields: { name: { selector: '.t', attr: null }, price: { selector: '.pr', attr: null }, url: { selector: '.t', attr: 'href' } }, pagination: { mode: 'none' } };
  fs.writeFileSync(path.join(dirs.data, 'domain-profiles.json'), JSON.stringify({ 'shop.test': { manual_selectors: recipe, manualSelectorsMeta: { status: 'candidate', version: 1, success_count: 1, fail_count: 0, consecutive_fails: 0, last_verified: new Date().toISOString() }, runs: 1 } }));
  let rendered = false;
  const browserSession = { captureJson: async () => { rendered = true; return { captures: [] }; }, render: async () => ({ html: null }), close: async () => {} };
  const events = [];
  const ctrl = createController({ dirs, emit: (t, p) => events.push({ t, p }) });
  await ctrl.start({ origin: ORIGIN, store: 'demo', browser: false, fetcher: new MapFetcher({ [ORIGIN]: listing }), browserSession });
  const done = events.find((e) => e.t === 'done').p;
  assert.equal(rendered, false);
  assert.equal(done.sideData, null);
  assert.equal(done.categoryTrail.products, 2);
});
