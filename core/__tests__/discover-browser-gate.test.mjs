/**
 * Discovery browser-fallback gate (audit fix): the historical browser-discovery
 * fallback used to fire whenever `products.size === 0 && getBrowser`, even when
 * F2 recovery had explicitly concluded `escalate:'none'` (a browser would not
 * help). It is now escalation-aware:
 *   • recovery never ran (no terminal block; historical CSR case) → fallback fires
 *   • recovery → escalate:'browser'                              → fallback fires
 *   • recovery → escalate:'none'                                 → fallback suppressed
 * Legitimate browser paths are preserved; only the useless launch is removed.
 * Offline (mock fetcher + fake browser), no site.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverProducts } from '../discover.mjs';

const CHALLENGE = { status: 403, body: '<html><head><title>Just a moment...</title></head><body>Checking your browser. /cdn-cgi/challenge-platform ray id</body></html>' };
const catalogue = (links) => ({ status: 200, body:
  `<html><head><title>Cat</title></head><body><h1>Catalogue</h1><p>${'produits en stock '.repeat(8)}</p>`
  + links.map((h) => `<a href="${h}">Voir le produit</a>`).join('') + '</body></html>' });

class Mock {
  constructor(map) { this.map = map; this.calls = []; this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; this.userAgent = 't'; }
  async get(u) {
    this.calls.push(u); this.stats.requests++;
    const e = this.map[u] || { status: 404, body: '' };
    const status = e.error ? 0 : (e.status ?? 200);
    const ok = !e.error && status >= 200 && status < 300;
    if (ok) this.stats.ok++; else this.stats.failed++;
    return { ok, status, url: e.finalUrl || u, requestedUrl: u, contentType: 'text/html', kind: 'html', body: e.body ?? '', bytes: null, headers: e.headers || {}, error: e.error ?? null, blocked: false };
  }
  async getText(u) { return this.get(u); }
}
const fakeBrowser = (map) => ({ calls: 0, async collectLinks(u) { this.calls++; return map[u] || { links: [], blocked: null }; } });
const ORIGIN = 'https://www.shop.be/c/cat';
const PRODUCTS = ['https://www.shop.be/product/a', 'https://www.shop.be/product/b'];

test('1. recovery → escalate:\'browser\' → discovery MAY use the browser', async () => {
  // A representation is itself a challenge (browser-recoverable) → escalate:'browser'.
  const f = new Mock({ [ORIGIN]: CHALLENGE, 'https://m.shop.be/c/cat': CHALLENGE, 'https://shop.be/c/cat': { status: 404 } });
  const fb = fakeBrowser({ [ORIGIN]: { links: PRODUCTS, blocked: null } });
  const { urls, report } = await discoverProducts(f, ORIGIN, { recovery: true, getBrowser: async () => fb });
  assert.equal(fb.calls, 1);                 // browser used (legitimate escalation)
  assert.equal(urls.length, 2);
  assert.equal(report.stopped, null);
});

test('2. recovery → escalate:\'none\' → NO useless browser fallback (the fix)', async () => {
  // Every representation is a definitive 404 → no browser-recoverable signal → escalate:'none'.
  const f = new Mock({ [ORIGIN]: CHALLENGE, 'https://m.shop.be/c/cat': { status: 404 }, 'https://shop.be/c/cat': { status: 404 } });
  const fb = fakeBrowser({ [ORIGIN]: { links: PRODUCTS, blocked: null } }); // would yield products IF (wrongly) called
  const { urls, report } = await discoverProducts(f, ORIGIN, { recovery: true, getBrowser: async () => fb });
  assert.equal(fb.calls, 0);                 // browser NOT launched — recovery said it would not help
  assert.equal(urls.length, 0);
  assert.ok(report.stopped && report.stopped.code); // diagnosed + resumable
});

test('3. real JS/CSR case (recovery ON, non-terminal, 0 links) → CSR fallback still works', async () => {
  // 200 catalogue with NO product links (client-rendered) → not terminal → recovery never runs.
  const f = new Mock({ [ORIGIN]: catalogue([]) });
  const fb = fakeBrowser({ [ORIGIN]: { links: PRODUCTS, blocked: null } });
  const { urls, report } = await discoverProducts(f, ORIGIN, { recovery: true, getBrowser: async () => fb });
  assert.equal(fb.calls, 1);                 // historical CSR fallback preserved (recovery never ran → advised)
  assert.equal(urls.length, 2);
  assert.equal(report.method, 'browser');
});

test('4. recovery:false → historical behaviour unchanged (terminal + browser fallback fires)', async () => {
  const f = new Mock({ [ORIGIN]: CHALLENGE });
  const fb = fakeBrowser({ [ORIGIN]: { links: [PRODUCTS[0]], blocked: null } });
  const { urls } = await discoverProducts(f, ORIGIN, { getBrowser: async () => fb }); // recovery OFF (default)
  assert.equal(fb.calls, 1);                 // unchanged: OFF → no escalate signal → fallback fires as before
  assert.equal(urls.length, 1);
});

test('5. normal HTTP discovery success → browser never used', async () => {
  const f = new Mock({ [ORIGIN]: catalogue(PRODUCTS) });
  const fb = fakeBrowser({});
  const { urls } = await discoverProducts(f, ORIGIN, { recovery: true, getBrowser: async () => fb });
  assert.equal(fb.calls, 0);                 // products found over HTTP → no fallback at all
  assert.equal(urls.length, 2);
});

test('6. 4e preferBrowser: a known browser-needing host renders even when HTTP found a FEW products', async () => {
  // HTTP crawl yields 2 products (< sitemapMin=5). Without a profile hint the CSR
  // fallback stays off (HTTP found something); with opts.preferBrowser (learned:
  // this host needed a browser before) it renders and completes the catalogue.
  const f = new Mock({ [ORIGIN]: catalogue(PRODUCTS) });
  const more = ['https://www.shop.be/product/c', 'https://www.shop.be/product/d', 'https://www.shop.be/product/e'];
  const fb1 = fakeBrowser({ [ORIGIN]: { links: more, blocked: null } });
  const r1 = await discoverProducts(f, ORIGIN, { recovery: true, getBrowser: async () => fb1, preferBrowser: true });
  assert.equal(fb1.calls, 1, 'preferBrowser → browser completes the partial HTTP result');
  assert.equal(r1.urls.length, 5);
  assert.equal(r1.report.method, 'crawl+browser');

  const fb0 = fakeBrowser({ [ORIGIN]: { links: more, blocked: null } });
  const r0 = await discoverProducts(f, ORIGIN, { recovery: true, getBrowser: async () => fb0 });
  assert.equal(fb0.calls, 0, 'without the hint, an HTTP result of 2 products (≥ csrFewThreshold) suppresses the fallback');
  assert.equal(r0.urls.length, 2);
});

test('7. 2a first-visit: an UNKNOWN site whose HTTP path yields ~1 product renders and completes', async () => {
  // The archetype-3 case (brico/Lidl): a reachable listing returns a near-empty
  // shell over HTTP (here: 1 product link), no profile hint. Before 2a the CSR
  // fallback only fired on EXACTLY 0, so a first visit got ~1 and stopped. Now it
  // fires on < csrFewThreshold (default 2), renders the grid, and completes.
  const f = new Mock({ [ORIGIN]: catalogue([PRODUCTS[0]]) }); // HTTP yields 1
  const grid = ['https://www.shop.be/product/a', 'https://www.shop.be/product/b', 'https://www.shop.be/product/c'];
  const fb = fakeBrowser({ [ORIGIN]: { links: grid, blocked: null } });
  const { urls, report } = await discoverProducts(f, ORIGIN, { recovery: true, getBrowser: async () => fb });
  assert.equal(fb.calls, 1, 'HTTP found only 1 → CSR render fires on a first visit (no profile needed)');
  assert.equal(urls.length, 3, 'render completes the catalogue (dedup-merged with the 1 HTTP hit)');
  assert.ok(/browser/.test(report.method), `method reflects the render, got ${report.method}`);

  // Guard: honour the threshold — a page that already found 2 is NOT re-rendered.
  const f2 = new Mock({ [ORIGIN]: catalogue(PRODUCTS) }); // HTTP yields 2
  const fb2 = fakeBrowser({ [ORIGIN]: { links: grid, blocked: null } });
  const r2 = await discoverProducts(f2, ORIGIN, { recovery: true, getBrowser: async () => fb2 });
  assert.equal(fb2.calls, 0, 'HTTP found 2 (≥ threshold) → no wasted render');
  assert.equal(r2.urls.length, 2);
});

// ── rendered CARDS: priced-card URL-family consensus (live lidl.be) ─────────
// The structural card detector also fires on unpriced section/service tiles
// (a support-article "card" 403-stopped a live scrape; a pre-hydration render
// showed MORE section tiles than product cards, so a raw majority would vote
// the products out). PRICED cards cast the vote: their dominant URL family is
// kept — image-less members included (lazy-load; 55/64 live lidl cards) — and
// the unpriced strays are dropped and counted.
test('4. unpriced section/service tiles are voted out by priced-card consensus', async () => {
  const entry = 'https://www.shop.example.com/rayon/outillage';
  const gridCard = (i) => `<div class="product-card">
    <a class="p-link" href="/produits/article-${i}-${1000 + i}.html"><img src="/img/${i}.jpg" alt=""></a>
    <span class="p-price">${(i % 9) + 1},99 €</span>
  </div>`;
  const renderedHtml = `<!doctype html><html><body><div class="page">
    <div class="grid">${Array.from({ length: 24 }, (_, i) => gridCard(i)).join('')}</div>
    <aside class="banner"><a href="https://service.shop.example.com/SelfServiceBE/s/article/gratis-verzending">Gratis verzending?</a></aside>
  </div></body></html>`;
  // Most cards image-less (lazy-load, the live lidl.be shape): they MUST survive.
  const cards = Array.from({ length: 24 }, (_, i) => ({
    url: `/produits/article-${i}-${1000 + i}.html`, name: `Article ${i}`, image: i < 4 ? `/img/${i}.jpg` : undefined, priceText: `${(i % 9) + 1},99 €`,
  }));
  cards.push({ url: 'https://service.shop.example.com/SelfServiceBE/s/article/gratis-verzending', name: 'Gratis verzending?' });
  // Pre-hydration shape: unpriced SECTION tiles (with images!) outnumbering none —
  // they must not survive the priced-card vote either.
  for (let i = 0; i < 6; i++) cards.push({ url: `/c/section-${i}/s${9000 + i}`, name: `Section ${i}`, image: `/img/s${i}.jpg` });
  const session = { async collectListing() { return { cards, links: [], pageLinks: [], html: renderedHtml, blocked: null }; } };
  const f = new Mock({ [entry]: { status: 200, body: '<html><body><div id="app"></div></body></html>' } });
  const { urls, report } = await discoverProducts(f, entry, { getBrowser: async () => session });
  assert.equal(urls.length, 24, `24 grid products, got ${urls.length}`);
  assert.ok(urls.every((u) => u.includes('/produits/article-')), 'only grid card URLs kept');
  assert.ok(!urls.some((u) => u.includes('SelfServiceBE')), 'service tile never queued');
  assert.ok((report.scopedOut || 0) >= 1, 'the drop is counted, never silent');
});

// ── section-hub CARDS: /c/…/s<ID> collection tiles are not products (live lidl.be) ──
// The lidl.be section URL /c/fr-BE/aliments-boissons/s10068374 renders a hub with a
// few real /p/ product cards among dozens of /c/…/s<ID> section tiles (incl.
// /abonner "Newsletter", price-like text). classifyUrl types those as collections,
// so they must be dropped from the product set — never scraped as a fiche.
test('5. browser cards that are /c/…/s<ID> section tiles are excluded; /p/ products kept', async () => {
  const entry = 'https://www.lidl.be/c/fr-BE/aliments-boissons/s10068374?offset=36';
  const productCards = [
    { url: '/p/fr-BE/barolo-docg/p10030737', name: 'Barolo DOCG', priceText: '8,99 €', image: '/i/1.jpg' },
    { url: '/p/fr-BE/boisson-energisante/p10012345', name: 'Boisson énergisante', priceText: '0,55 €' },
    { url: '/p/fr-BE/moules-de-zelande/p10067890', name: 'Moules de Zélande Super', priceText: '4,99 €' },
  ];
  const sectionTiles = [
    { url: '/c/fr-BE/abonner/s10008105', name: 'Newsletter', priceText: '60' },  // the polluting service page
    { url: '/c/fr-BE/depliants-et-magazines/s10008101', name: 'Dépliants' },
    { url: '/c/fr-BE/lidl-plus/s10008372', name: 'Lidl Plus' },
    { url: '/c/fr-BE/promotions-cette-semaine/a10082242', name: 'Promotions' },   // campaign collection
  ];
  const session = { async collectListing() { return { cards: [...productCards, ...sectionTiles], links: [], pageLinks: [], html: '', blocked: null }; } };
  const f = new Mock({ [entry]: { status: 200, body: '<html><body><div id="__nuxt"></div></body></html>' } });
  const { urls } = await discoverProducts(f, entry, { getBrowser: async () => session });
  assert.equal(urls.length, 3, `only the 3 /p/ products, got ${urls.length}`);
  assert.ok(urls.every((u) => u.includes('/p/fr-BE/')), 'only product URLs queued');
  assert.ok(!urls.some((u) => /abonner|\/s\d|\/a\d/.test(u)), 'no section/campaign tile queued (Newsletter excluded)');
});
