/**
 * R2 fixes — card detection decoupled from images (a link+price product with no
 * usable image still makes a card), Pass B scoped to a LEARNED container, and a
 * learned consent selector clicked before collection. Offline: _cardsInPage runs
 * against a linkedom DOM; collectListing runs on a fake page whose evaluate()
 * executes the real in-page functions on that same DOM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { BrowserSession, _cardsInPage } from '../browser.mjs';

const PAGE_URL = 'https://shop.test/collection';

/** Run a fn against a linkedom DOM with the page globals _cardsInPage expects. */
function withDom(html, pageUrl, imgSize, fn) {
  const { document, window } = parseHTML(html);
  window.scrollTo = () => {};
  for (const img of document.querySelectorAll('img')) img.getBoundingClientRect = () => ({ width: imgSize, height: imgSize });
  const g = globalThis;
  const prev = { document: g.document, location: g.location, window: g.window };
  g.document = document; g.location = new URL(pageUrl); g.window = window;
  try { return fn(document); } finally { g.document = prev.document; g.location = prev.location; g.window = prev.window; }
}

const runCards = (html, opts, { imgSize = 200 } = {}) => withDom(html, PAGE_URL, imgSize, () => _cardsInPage(opts));

const NO_IMAGE_HTML = `<html><body><main>
  <div class="product-card">
    <h3>Chaise en chêne</h3>
    <a href="/products/chaise-chene-12345">Voir</a>
    <span class="price">€ 49,95</span>
  </div>
</main></body></html>`;

const IMAGE_CARD_HTML = `<html><body><main>
  <div class="card">
    <a href="/products/table-basse-23456"><img src="/img/t.jpg" alt="Table basse scandinave"></a>
    <div class="title">Table basse</div>
    <span>€ 89,00</span>
  </div>
</main></body></html>`;

// Pass A yields item-11111 (link+price card); its URL signature lets Pass B
// harvest the nav twin (outside) and the bare grid anchor (inside).
const GRID_HTML = `<html><body>
<nav><a href="/products/promo-99999">Promo hiver</a></nav>
<section id="grid">
  <div class="product-card"><h3>Produit un</h3><a href="/products/item-11111">Voir</a><span>€ 10,00</span></div>
  <a href="/products/item-22222">Produit deux</a>
</section>
</body></html>`;

test('link+price card WITHOUT an image is detected (image: null)', () => {
  const cards = runCards(NO_IMAGE_HTML);
  assert.equal(cards.length, 1);
  assert.ok(cards[0].url.endsWith('/products/chaise-chene-12345'));
  assert.equal(cards[0].name, 'Chaise en chêne');
  assert.equal(cards[0].priceText, '€ 49,95');
  assert.equal(cards[0].image, null);
});

test('classic image card is still detected, with its image', () => {
  const cards = runCards(IMAGE_CARD_HTML);
  assert.equal(cards.length, 1);
  assert.ok(cards[0].url.endsWith('/products/table-basse-23456'));
  assert.equal(cards[0].name, 'Table basse');
  assert.equal(cards[0].image, 'https://shop.test/img/t.jpg');
});

test('no duplicate when both passes find the same card element', () => {
  // The image card also holds a price, so the price pass revisits it: one card,
  // and the image-anchored version (with the image) wins.
  const cards = runCards(IMAGE_CARD_HTML);
  assert.equal(cards.length, 1);
  assert.ok(cards[0].image);
});

test('tiny/lazy image (under the 60px gate) no longer loses the product', () => {
  const cards = runCards(IMAGE_CARD_HTML, undefined, { imgSize: 0 }); // lazy image measured 0x0
  assert.equal(cards.length, 1);
  assert.ok(cards[0].url.endsWith('/products/table-basse-23456'));
  assert.equal(cards[0].image, null); // no sized image to trust — card survives without it
});

test('Pass B unscoped without a learned container (nav twin harvested)', () => {
  const urls = runCards(GRID_HTML).map((c) => new URL(c.url).pathname).sort();
  assert.deepEqual(urls, ['/products/item-11111', '/products/item-22222', '/products/promo-99999']);
});

test('Pass B restricted to the learned container when it matches', () => {
  const urls = runCards(GRID_HTML, { learnedContainer: '#grid' }).map((c) => new URL(c.url).pathname).sort();
  assert.deepEqual(urls, ['/products/item-11111', '/products/item-22222']); // nav twin excluded
});

test('learned container that matches nothing leaves Pass B unchanged', () => {
  const urls = runCards(GRID_HTML, { learnedContainer: '#missing' }).map((c) => new URL(c.url).pathname).sort();
  assert.deepEqual(urls, ['/products/item-11111', '/products/item-22222', '/products/promo-99999']);
});

/** Fake Playwright page over a linkedom DOM: evaluate() runs the real in-page
 *  functions; route/click calls are recorded for assertions. */
function makeFakePage(html, pageUrl) {
  const { document, window } = parseHTML(html);
  window.scrollTo = () => {};
  const state = { clicks: [], routes: [] };
  const run = (fn, arg) => {
    const g = globalThis;
    const prev = { document: g.document, location: g.location, window: g.window };
    g.document = document; g.location = new URL(pageUrl); g.window = window;
    try { return fn(arg); } finally { g.document = prev.document; g.location = prev.location; g.window = prev.window; }
  };
  return {
    state,
    url: () => pageUrl,
    async route(_pattern, handler) { state.routes.push(handler); },
    async goto() {},
    async waitForLoadState() {},
    async waitForSelector() {},
    async waitForTimeout() {},
    async waitForFunction() { throw new Error('timeout'); },
    async evaluate(fn, arg) { return run(fn, arg); },
    frames() { return []; },
    async click(sel) { state.clicks.push(sel); },
    async content() { return document.toString(); },
    async close() {},
  };
}

function sessionWith(page) {
  const s = new BrowserSession({});
  s._ctx = { newPage: async () => page }; // _ensure() short-circuits — no playwright
  return s;
}

/** Drive a recorded route handler with one request of the given resourceType. */
function fireRoute(handler, type) {
  const calls = { aborted: false, continued: false };
  handler({
    request: () => ({ resourceType: () => type }),
    abort: () => { calls.aborted = true; return Promise.resolve(); },
    continue: () => { calls.continued = true; return Promise.resolve(); },
  });
  return calls;
}

test('collectListing lets images through; fiche render still blocks them', async () => {
  const listingPage = makeFakePage(GRID_HTML, PAGE_URL);
  const r = await sessionWith(listingPage).collectListing(PAGE_URL, { maxScrolls: 0 });
  assert.equal(r.error, null);
  assert.equal(listingPage.state.routes.length, 1);
  assert.equal(fireRoute(listingPage.state.routes[0], 'image').continued, true);  // real sizes for the card gate
  assert.equal(fireRoute(listingPage.state.routes[0], 'media').aborted, true);
  assert.equal(fireRoute(listingPage.state.routes[0], 'font').aborted, true);
  assert.equal(fireRoute(listingPage.state.routes[0], 'document').continued, true);

  const fichePage = makeFakePage('<html><body><h1>Fiche</h1></body></html>', 'https://shop.test/products/item-11111');
  const rr = await sessionWith(fichePage).render('https://shop.test/products/item-11111', {});
  assert.equal(rr.error, null);
  assert.equal(fichePage.state.routes.length, 1);
  assert.equal(fireRoute(fichePage.state.routes[0], 'image').aborted, true);
  assert.equal(fireRoute(fichePage.state.routes[0], 'document').continued, true);
});

test('collectListing passes the learned container through to the card detector', async () => {
  const scoped = await sessionWith(makeFakePage(GRID_HTML, PAGE_URL))
    .collectListing(PAGE_URL, { maxScrolls: 0, learnedContainer: '#grid' });
  assert.deepEqual(scoped.cards.map((c) => new URL(c.url).pathname).sort(), ['/products/item-11111', '/products/item-22222']);

  const unscoped = await sessionWith(makeFakePage(GRID_HTML, PAGE_URL))
    .collectListing(PAGE_URL, { maxScrolls: 0 });
  assert.deepEqual(unscoped.cards.map((c) => new URL(c.url).pathname).sort(), ['/products/item-11111', '/products/item-22222', '/products/promo-99999']);
});

test('learned consent selector is clicked (best-effort) before collection', async () => {
  const page = makeFakePage(GRID_HTML, PAGE_URL);
  await sessionWith(page).collectListing(PAGE_URL, { maxScrolls: 0, consentSelector: '#accept-cookies' });
  assert.ok(page.state.clicks.includes('#accept-cookies'));

  const page2 = makeFakePage(GRID_HTML, PAGE_URL);
  await sessionWith(page2).collectListing(PAGE_URL, { maxScrolls: 0 });
  assert.equal(page2.state.clicks.length, 0); // no learned selector -> no click
});
