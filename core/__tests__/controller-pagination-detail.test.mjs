/**
 * Chantiers 1 + 2 through the REAL controller (temp app-data, a map-backed fake
 * fetcher — no network): a learned manual_selectors recipe is replayed, its
 * listing is followed page by page (rel=next), each model's product page is
 * visited once and completes its colourway rows (option A), the working
 * pagination mechanism is remembered in the recipe, and the report / done event
 * say what happened. The usage ledger stays a single free 'local' line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appDirs, ensureDirs } from '../../lib/osenv.mjs';
import { createController } from '../../app/controller.mjs';
import { createLedger } from '../metering/ledger.mjs';
import { createMeter } from '../metering/meter.mjs';
import { queryLedger } from '../metering/reader.mjs';

const ORIGIN = 'https://www.shop.test/c/shoes';
const card = (code, name, price) => `<div class="pc"><a class="t" href="/t/${name.toLowerCase().replace(/\s+/g, '-')}/${code}">${name}</a><span class="pr">${price},00 €</span><img src="/thumb/${code}.png"></div>`;
const listing = (cards, next) => `<html><head>${next ? `<link rel="next" href="${next}">` : ''}</head><body>${cards.join('')}</body></html>`;
const fiche = (selected, cws) => `<html><head><meta name="description" content="à retrouver sur la boutique"></head><body><script id="__STATE__" type="application/json">${JSON.stringify({ product: { colorways: cws.map(([code, colour, sizes]) => ({ styleColor: code, colorDescription: colour, prices: { currentPrice: 90, initialPrice: 120, currency: 'EUR' }, description: 'Une description réelle et assez longue du modèle.', brand: 'Marque Test', sizes: sizes.map((s, i) => ({ label: s, gtin: `54000000${code.replace(/\D/g, '').slice(-3)}${i}0` })), images: [`https://cdn.shop.test/images/${code}-1.jpg`, `https://cdn.shop.test/images/${code}-2.jpg`] })), selected } })}</script></body></html>`;

class MapFetcher {
  constructor(map) { this.map = map; this.calls = []; this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; this.userAgent = 't'; }
  async get(u) { this.calls.push(u); this.stats.requests++; const body = this.map[u]; if (body == null) { this.stats.failed++; return { ok: false, status: 404, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body: '', bytes: null, headers: {}, error: 'HTTP 404', blocked: false }; } this.stats.ok++; this.stats.bytes += body.length; return { ok: true, status: 200, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body, bytes: null, headers: {}, error: null, blocked: false }; }
  async getText(u) { return this.get(u); }
}

test('recipe replay: rel=next pages followed, one product page per model completes every colourway row, memo stored, report + done event', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-pgdt-'));
  const dirs = ensureDirs(appDirs(root));
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1, recovery: false, maxProducts: 30 }));
  const recipe = { card: '.pc', fields: { name: { selector: '.t', attr: null }, price: { selector: '.pr', attr: null }, image: { selector: 'img', attr: 'src' }, url: { selector: '.t', attr: 'href' } }, pagination: { mode: 'none', max_pages: null }, origin: 'auto-discovery' };
  fs.writeFileSync(path.join(dirs.data, 'domain-profiles.json'), JSON.stringify({ 'shop.test': { manual_selectors: recipe, manualSelectorsMeta: { status: 'candidate', version: 1, success_count: 1, fail_count: 0, consecutive_fails: 0, last_verified: new Date().toISOString() }, runs: 1 } }));
  const P2 = `${ORIGIN}?page=2`;
  const map = {
    [ORIGIN]: listing([card('AA1000-001', 'Runner Alpha', 90), card('AA1000-002', 'Runner Alpha', 90), card('BB2000-001', 'Trail Beta', 110)], P2),
    [P2]: listing([card('AA1000-003', 'Runner Alpha', 90), card('CC3000-001', 'Court Gamma', 70)]),
    'https://www.shop.test/t/runner-alpha/AA1000-001': fiche('AA1000-001', [['AA1000-001', 'Noir', ['40', '41']], ['AA1000-002', 'Blanc', ['40']], ['AA1000-003', 'Rouge', ['42', '43', '44']]]),
    'https://www.shop.test/t/trail-beta/BB2000-001': fiche('BB2000-001', [['BB2000-001', 'Vert', ['39', '40']]]),
    // Court Gamma's page is gone (404): its row must stay exactly as listed.
  };
  const fetcher = new MapFetcher(map);
  const ledgerDir = path.join(root, 'usage-ledger');
  const events = [];
  const ctrl = createController({ dirs, emit: (t, p) => events.push({ t, p }), meter: createMeter({ ledger: createLedger({ dir: ledgerDir }) }) });
  await ctrl.start({ origin: ORIGIN, store: 'demo', browser: false, fetcher });

  const done = events.find((e) => e.t === 'done').p;
  assert.equal(done.status, 'done');
  assert.equal(done.counts.detected, 5, 'both listing pages read');
  // Pagination
  assert.equal(done.pagination.mechanism, 'rel-next');
  assert.equal(done.pagination.pages, 2);
  assert.equal(done.pagination.stoppedBy, 'no_next');
  // Product pages: model Alpha visited ONCE for its 3 rows; Gamma failed (404).
  const ficheCalls = fetcher.calls.filter((u) => u.includes('/t/'));
  assert.deepEqual(ficheCalls, ['https://www.shop.test/t/runner-alpha/AA1000-001', 'https://www.shop.test/t/trail-beta/BB2000-001', 'https://www.shop.test/t/court-gamma/CC3000-001']);
  assert.equal(done.detailPages.completed, 4); assert.equal(done.detailPages.failed, 1);
  assert.deepEqual(done.detailPages.reasons, { http_404: 1 });
  // Option A rows
  const prods = ctrl.jobProducts(done.jobId);
  const byUrl = Object.fromEntries(prods.map((p) => [p.source_url, p]));
  const red = JSON.parse(fs.readFileSync(path.join(dirs.jobs, done.jobId, 'products.json'), 'utf8')).find((p) => p.source_url.endsWith('AA1000-003'));
  assert.equal(red.color, 'Rouge');
  assert.deepEqual(red.variants.map((v) => v.name), ['42', '43', '44']);
  assert.ok(red.variants.every((v) => /^\d{13}$/.test(v.gtin)));
  assert.equal(red.images[0], 'https://cdn.shop.test/images/AA1000-003-1.jpg');
  assert.equal(red.raw.list_price, 120); assert.equal(red.raw.brand, 'Marque Test');
  assert.equal(red.description, 'Une description réelle et assez longue du modèle.');
  const gamma = JSON.parse(fs.readFileSync(path.join(dirs.jobs, done.jobId, 'products.json'), 'utf8')).find((p) => p.source_url.endsWith('CC3000-001'));
  assert.equal(gamma.color, null); assert.equal(gamma.variants, null); assert.equal(gamma.description, null, 'nothing invented for a failed page');
  assert.ok(byUrl['https://www.shop.test/t/runner-alpha/AA1000-001']);
  // Memo stored in the recipe (backward compatible extension of pagination.mode)
  const prof = JSON.parse(fs.readFileSync(path.join(dirs.data, 'domain-profiles.json'), 'utf8'))['shop.test'];
  assert.equal(prof.manual_selectors.pagination.mode, 'rel-next');
  assert.ok(prof.manual_selectors.pagination.detected_at);
  assert.equal(prof.manual_selectors.card, '.pc', 'the rest of the recipe is unchanged');
  // Report (json + txt)
  const rep = JSON.parse(fs.readFileSync(done.reportPath.replace(/\.txt$/, '.json'), 'utf8'));
  assert.equal(rep.pagination.mechanism, 'rel-next'); assert.equal(rep.detailPages.visited, 3);
  const txt = fs.readFileSync(done.reportPath, 'utf8');
  assert.match(txt, /pagination: +rel-next — 2 page\(s\)/);
  assert.match(txt, /product pages: +4 completed, 0 unchanged, 1 failed/);
  // Ledger: one free 'local' line, no paid route.
  const lines = (await queryLedger(ledgerDir, {})).rows;
  assert.equal(lines.length, 1); assert.equal(lines[0].provider, 'local'); assert.equal(lines[0].costUsd, 0);
});

test('detail pages can be switched off in config.json (detailPages.enabled=false): no product page visited', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-pgdt2-'));
  const dirs = ensureDirs(appDirs(root));
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1, recovery: false, maxProducts: 30, detailPages: { enabled: false } }));
  const recipe = { card: '.pc', fields: { name: { selector: '.t', attr: null }, price: { selector: '.pr', attr: null }, url: { selector: '.t', attr: 'href' } }, pagination: { mode: 'none' } };
  fs.writeFileSync(path.join(dirs.data, 'domain-profiles.json'), JSON.stringify({ 'shop.test': { manual_selectors: recipe, manualSelectorsMeta: { status: 'candidate', version: 1, success_count: 1, fail_count: 0, consecutive_fails: 0, last_verified: new Date().toISOString() }, runs: 1 } }));
  const fetcher = new MapFetcher({ [ORIGIN]: listing([card('AA1000-001', 'Runner Alpha', 90), card('BB2000-001', 'Trail Beta', 110), card('CC3000-001', 'Court Gamma', 70)]) });
  const events = [];
  const ctrl = createController({ dirs, emit: (t, p) => events.push({ t, p }) });
  await ctrl.start({ origin: ORIGIN, store: 'demo', browser: false, fetcher });
  assert.equal(fetcher.calls.filter((u) => u.includes('/t/')).length, 0);
  const done = events.find((e) => e.t === 'done').p;
  assert.equal(done.detailPages, null);
  assert.equal(done.pagination.mechanism, 'none');
});

class ApiFetcher extends MapFetcher {
  constructor(map, api) { super(map); this.api = api; }
  async get(u, o = {}) {
    if (this.api[u] !== undefined || /\/listing\/v1/.test(u)) {
      this.calls.push(u);
      const a = this.api[u] || { status: 404, json: { errors: [{ code: 310 }] } };
      // Like the real Fetcher: a 404 is flagged `blocked` but NOT terminal (dead URL, not a source block).
      return { ok: a.status < 400, status: a.status, url: u, requestedUrl: u, contentType: 'application/json', kind: 'json', body: JSON.stringify(a.json), bytes: null, headers: {}, error: a.status < 400 ? null : `HTTP ${a.status}`, blocked: a.status >= 400, block: { code: a.status === 404 ? 'NOT_FOUND' : 'BLOCKED', terminal: false } };
    }
    return super.get(u, o);
  }
}
const apiListing = (cards, next, total) => `<html><head><link href="https://api.shop.test" rel="dns-prefetch"></head><body>${cards.join('')}<script id="__STATE__" type="application/json">${JSON.stringify({ wall: { pageData: { next, prev: '', totalPages: 3, totalResources: total } } })}</script></body></html>`;
const apiSetup = (api, cfg = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-pgapi-'));
  const dirs = ensureDirs(appDirs(root));
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1, recovery: false, maxProducts: 30, detailPages: { enabled: false }, ...cfg }));
  const recipe = { card: '.pc', fields: { name: { selector: '.t', attr: null }, price: { selector: '.pr', attr: null }, url: { selector: '.t', attr: 'href' } }, pagination: { mode: 'none' } };
  fs.writeFileSync(path.join(dirs.data, 'domain-profiles.json'), JSON.stringify({ 'shop.test': { manual_selectors: recipe, manualSelectorsMeta: { status: 'candidate', version: 1, success_count: 1, fail_count: 0, consecutive_fails: 0, last_verified: new Date().toISOString() }, runs: 1 } }));
  const fetcher = new ApiFetcher({ [ORIGIN]: apiListing([card('AA1000-001', 'Runner Alpha', 90), card('BB2000-001', 'Trail Beta', 110)], '/listing/v1?anchor=2&count=2', 120) }, api);
  const events = [];
  const ctrl = createController({ dirs, emit: (t, p) => events.push({ t, p }) });
  return { dirs, fetcher, events, run: () => ctrl.start({ origin: ORIGIN, store: 'demo', browser: false, fetcher }) };
};

test('API pagination: a 404 on the page origin does not stop the attempt on the API host the page declares; a refusal is reported with its status and code', async () => {
  const s = apiSetup({ 'https://api.shop.test/listing/v1?anchor=2&count=2': { status: 400, json: { errors: [{ code: 'CALLER_ID_HEADER_NOT_PRESENT', message: 'Request header must be present' }] } } });
  await s.run();
  const api = s.fetcher.calls.filter((u) => u.includes('/listing/v1'));
  assert.deepEqual(api, ['https://www.shop.test/listing/v1?anchor=2&count=2', 'https://api.shop.test/listing/v1?anchor=2&count=2']);
  const done = s.events.find((e) => e.t === 'done').p;
  assert.equal(done.pagination.stoppedBy, 'api_refused');
  assert.deepEqual(done.pagination.detail, { status: 400, error: 'CALLER_ID_HEADER_NOT_PRESENT' });
  assert.equal(done.pagination.totalAnnounced, 120);
  assert.ok(done.pagination.warnings.includes('total_not_reached') && done.pagination.warnings.includes('scroll_not_followable'));
  assert.equal(done.counts.detected, 2, 'nothing invented beyond the first page');
});

test('API pagination: when the declared API host answers, the list is followed and the host is remembered in the recipe', async () => {
  const page = (ids, next) => ({ status: 200, json: { data: { products: ids.map((i) => ({ name: `Item ${i}`, price: 10 + i, url: `https://www.shop.test/t/item/${i}` })), pages: { next, totalResources: 6 } } } });
  const s = apiSetup({
    'https://api.shop.test/listing/v1?anchor=2&count=2': page([3, 4], '/listing/v1?anchor=4&count=2'),
    'https://api.shop.test/listing/v1?anchor=4&count=2': page([5, 6], '/listing/v1?anchor=6&count=2'),
  }, {});
  // The listing here announces 120; the API corrects nothing — stop on the user cap or the end of the chain.
  await s.run();
  const done = s.events.find((e) => e.t === 'done').p;
  assert.equal(done.pagination.mechanism, 'api-next');
  assert.equal(done.counts.detected, 6);
  assert.equal(done.pagination.pages, 3);
  const prof = JSON.parse(fs.readFileSync(path.join(s.dirs.data, 'domain-profiles.json'), 'utf8'))['shop.test'];
  assert.equal(prof.manual_selectors.pagination.mode, 'api-next');
  assert.equal(prof.manual_selectors.pagination.api_host, 'https://api.shop.test');
});

test('scroll-only list: when the HTTP pagination cannot follow, the LOCAL browser scrolls the page and the same recipe reads every card (up to the product cap)', async () => {
  const s = apiSetup({ 'https://api.shop.test/listing/v1?anchor=2&count=2': { status: 400, json: { errors: [{ code: 'CALLER_ID_HEADER_NOT_PRESENT' }] } } }, { maxProducts: 10 });
  const seenOpts = [];
  const cardsHtml = Array.from({ length: 14 }, (_, i) => card(`ZZ${String(1000 + i)}-001`, `Model ${i}`, 50 + i));
  // The first two scroll cards are the page-1 products again (deduplicated).
  cardsHtml.unshift(card('AA1000-001', 'Runner Alpha', 90), card('BB2000-001', 'Trail Beta', 110));
  const browserSession = {
    collectListing: async (url, opts) => { seenOpts.push({ url, ...opts }); return { recipeCardsHtml: cardsHtml, blocked: null, cards: [], links: [] }; },
    render: async () => ({ html: null }), close: async () => {},
  };
  const events = [];
  const root = s.dirs;
  const ctrl = createController({ dirs: root, emit: (t, p) => events.push({ t, p }) });
  await ctrl.start({ origin: ORIGIN, store: 'demo', browser: true, fetcher: s.fetcher, browserSession });
  const done = events.find((e) => e.t === 'done').p;
  assert.equal(seenOpts.length, 1);
  assert.equal(seenOpts[0].recipeCard, '.pc'); assert.equal(seenOpts[0].stopAt, 10); assert.equal(seenOpts[0].recipeUrlSelector, '.t');
  assert.equal(done.counts.detected, 10, 'filled up to the user cap, page-1 products not duplicated');
  assert.equal(done.pagination.mechanism, 'browser-scroll');
  assert.equal(done.pagination.stoppedBy, 'max_products');
  assert.deepEqual(done.pagination.warnings, []);
  assert.equal(done.pagination.browserScroll.added, 8);
  const txt = fs.readFileSync(done.reportPath, 'utf8');
  assert.match(txt, /browser scroll: +16 card\(s\) seen, 8 added/);
});

test('scroll-only list with the browser fallback OFF: nothing more is loaded, the limit is reported', async () => {
  const s = apiSetup({ 'https://api.shop.test/listing/v1?anchor=2&count=2': { status: 400, json: { errors: [{ code: 'X' }] } } });
  let called = 0;
  const browserSession = { collectListing: async () => { called++; return { recipeCardsHtml: [] }; }, render: async () => ({ html: null }), close: async () => {} };
  const events = [];
  const ctrl = createController({ dirs: s.dirs, emit: (t, p) => events.push({ t, p }) });
  await ctrl.start({ origin: ORIGIN, store: 'demo', browser: false, fetcher: s.fetcher, browserSession });
  const done = events.find((e) => e.t === 'done').p;
  assert.equal(called, 0);
  assert.equal(done.counts.detected, 2);
  assert.ok(done.pagination.warnings.includes('scroll_not_followable'));
});

test('scroll, then the site API: the request headers the page itself sent let the HTTP pagination continue after what the browser loaded', async () => {
  const s = apiSetup({ 'https://api.shop.test/listing/v1?anchor=2&count=2': { status: 400, json: { errors: [{ code: 'CALLER_ID_HEADER_NOT_PRESENT' }] } } }, { maxProducts: 10 });
  const prod = (i) => ({ name: `Api Model ${i}`, url: `/t/api-model-${i}/ZZ${9000 + i}-001`, price: 40 + i, currency: 'EUR' });
  const page = (anchor) => ({ products: [prod(anchor), prod(anchor + 1)], pages: { next: `/listing/v1?anchor=${anchor + 2}&count=2`, totalResources: 120 } });
  const sent = [];
  const orig = s.fetcher.get.bind(s.fetcher);
  s.fetcher.get = async (u, o = {}) => {
    const m = u.match(/^https:\/\/api\.shop\.test\/listing\/v1\?anchor=(\d+)&count=2$/);
    if (m && Number(m[1]) >= 6) {
      sent.push(o.headers || null);
      const ok = !!(o.headers && o.headers['x-caller-id'] === 'web-1');
      return { ok, status: ok ? 200 : 400, url: u, requestedUrl: u, contentType: 'application/json', kind: 'json', body: JSON.stringify(ok ? page(Number(m[1])) : { errors: [{ code: 'X' }] }), bytes: null, headers: {}, error: ok ? null : 'HTTP 400', blocked: !ok, block: { code: 'BLOCKED', terminal: false } };
    }
    return orig(u, o);
  };
  let opts = null;
  const scrolled = [card('CC3000-001', 'Court Gamma', 70), card('DD4000-001', 'Delta Run', 75), card('EE5000-001', 'Echo Walk', 80), card('FF6000-001', 'Fox Trail', 85)];
  const browserSession = {
    collectListing: async (url, o) => { opts = o; return { recipeCardsHtml: scrolled, blocked: null, error: null, cards: [], links: [], apiCapture: { headers: { 'x-caller-id': 'web-1', accept: 'application/json' }, lastUrl: 'https://api.shop.test/listing/v1?anchor=4&count=2', lastJson: page(4), requests: 2 } }; },
    render: async () => ({ html: null }), close: async () => {},
  };
  const events = [];
  const ctrl = createController({ dirs: s.dirs, emit: (t, p) => events.push({ t, p }) });
  await ctrl.start({ origin: ORIGIN, store: 'demo', browser: true, fetcher: s.fetcher, browserSession });
  const done = events.find((e) => e.t === 'done').p;
  assert.deepEqual(opts.captureApi, { pathname: '/listing/v1' }, 'the browser watches the request the HTTP pagination could not complete');
  assert.equal(done.counts.detected, 10);
  assert.equal(done.pagination.browserScroll.added, 4);
  assert.equal(done.pagination.apiAfterScroll.added, 4);
  assert.equal(done.pagination.apiAfterScroll.pages, 2);
  assert.equal(done.pagination.apiAfterScroll.headersLearned, 2);
  assert.equal(done.pagination.stoppedBy, 'max_products');
  assert.deepEqual(done.pagination.warnings, []);
  assert.ok(sent.length >= 2 && sent.every((h) => h && h['x-caller-id'] === 'web-1'), 'every continued API request carries the learned header');
  const prods = JSON.parse(fs.readFileSync(path.join(s.dirs.jobs, done.jobId, 'products.json'), 'utf8'));
  assert.ok(prods.some((p) => p.source_url === 'https://www.shop.test/t/api-model-9/ZZ9009-001'));
  assert.match(fs.readFileSync(done.reportPath, 'utf8'), /then site API: +2 page\(s\), 4 added \(2 request header\(s\) seen in the page\)/);
});

test('a learned recipe that no longer reads names / prices (the page changed) is not trusted: one failure counted, other methods used', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-broken-'));
  const dirs = ensureDirs(appDirs(root));
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1, recovery: false, maxProducts: 10, detailPages: { enabled: false } }));
  // Recipe learned on an older build: its name/price classes are gone now.
  const recipe = { card: '.pc', fields: { name: { selector: '.old-name', attr: null }, price: { selector: '.old-price', attr: null }, url: { selector: 'a', attr: 'href' } }, pagination: { mode: 'none' } };
  fs.writeFileSync(path.join(dirs.data, 'domain-profiles.json'), JSON.stringify({ 'shop.test': { manual_selectors: recipe, manualSelectorsMeta: { status: 'candidate', version: 1, success_count: 1, fail_count: 0, consecutive_fails: 0, last_verified: new Date().toISOString() }, runs: 1 } }));
  const ld = (name, price, code) => `<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name, sku: code, image: `https://cdn.shop.test/${code}.jpg`, offers: { '@type': 'Offer', price, priceCurrency: 'EUR' } })}</script></head><body><h1>${name}</h1></body></html>`;
  const map = {
    [ORIGIN]: `<html><body>${[1, 2, 3].map((i) => `<div class="pc"><a class="n-${i}x7k2q" href="/product/model-${i}">Model ${i}</a><span class="p-${i}x7k2q">${20 + i},00 €</span></div>`).join('')}</body></html>`,
    'https://www.shop.test/product/model-1': ld('Model 1', 21, 'M1'),
    'https://www.shop.test/product/model-2': ld('Model 2', 22, 'M2'),
    'https://www.shop.test/product/model-3': ld('Model 3', 23, 'M3'),
  };
  const fetcher = new MapFetcher(map);
  const events = [];
  const ctrl = createController({ dirs, emit: (t, p) => events.push({ t, p }) });
  await ctrl.start({ origin: ORIGIN, store: 'demo', browser: false, fetcher });
  const done = events.find((e) => e.t === 'done').p;
  const prods = JSON.parse(fs.readFileSync(path.join(dirs.jobs, done.jobId, 'products.json'), 'utf8'));
  assert.ok(prods.length >= 3, `products found by the other methods (${prods.length})`);
  assert.ok(prods.every((p) => p.name && p.price > 0), 'named and priced');
  const rep = JSON.parse(fs.readFileSync(done.reportPath.replace(/\.txt$/, '.json'), 'utf8'));
  assert.equal(rep.selectorRecipe && rep.selectorRecipe.skipped, true);
  assert.equal(rep.selectorRecipe.emptyNameRatio, 1);
  const prof = JSON.parse(fs.readFileSync(path.join(dirs.data, 'domain-profiles.json'), 'utf8'))['shop.test'];
  assert.ok(prof.manualSelectorsMeta.consecutive_fails >= 1 || prof.manual_selectors.card !== '.pc', 'the broken recipe got a failure (or was replaced by a fresh one)');
  assert.match(fs.readFileSync(done.reportPath, 'utf8'), /Learned selectors: not used/);
});
