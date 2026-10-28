/**
 * URL context (classification + country/language + host normalization) and the
 * HONEST probe verdict. The probe must work FROM the provided URL and never
 * report a bare "none-found" for a site that actually refused access (blocked)
 * or needs a browser. Offline: pure functions + a mock fetcher.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUrl, detectLocale, normalizeHost, sameSite } from '../url-context.mjs';
import { probeSource } from '../probe.mjs';

// ── classifyUrl ──────────────────────────────────────────────────────────────
test('classifyUrl: product / collection / search / home / unknown', () => {
  assert.equal(classifyUrl('https://www.levi.com/BE/fr_BE/vetements/homme/jeans/501/p/005010101').type, 'product');
  assert.equal(classifyUrl('https://www.levi.com/BE/fr_BE/vetements/homme/jeans/c/levi_clothing_men_jeans').type, 'collection');
  assert.equal(classifyUrl('https://shop.example/search?q=jeans').type, 'search');
  assert.equal(classifyUrl('https://shop.example/recherche/jeans').type, 'search');
  assert.equal(classifyUrl('https://www.levi.com/BE/fr_BE/').type, 'home');
  assert.equal(classifyUrl('https://shop.example/').type, 'home');
  assert.equal(classifyUrl('https://shop.example/some/deep/thing').type, 'unknown');
});

test('classifyUrl: nested category trail under a plural listing root is a collection, not a fiche', () => {
  // colruyt.be shape — the whole category tree lives under /fr/produits/…
  assert.equal(classifyUrl('https://www.colruyt.be/fr/produits/toutes-les-categories/boissons').type, 'collection');
  assert.equal(classifyUrl('https://www.colruyt.be/fr/produits/toutes-les-categories/boissons/lait-boissons-lactee').type, 'collection');
  // A quantity word in a category name is not a product id.
  assert.equal(classifyUrl('https://www.colruyt.be/fr/produits/toutes-les-categories/boissons/bieres/bieres-75cl-emballages-cadeaux').type, 'collection');
  // A category-INDEX slug directly under the root is the catalogue, not a fiche.
  assert.equal(classifyUrl('https://www.colruyt.be/fr/produits/toutes-les-categories').type, 'collection');
  assert.equal(classifyUrl('https://shop.example/products/all-categories').type, 'collection');
  // ONE segment under the plural root stays a product (Shopify /products/<slug>)…
  assert.equal(classifyUrl('https://shop.example/products/blue-shirt').type, 'product');
  assert.equal(classifyUrl('https://shop.example/collections/men/products/blue-shirt').type, 'product');
  // …and an id-carrying terminal slug keeps the product verdict even when nested.
  assert.equal(classifyUrl('https://shop.example/produits/cuisine/robot-mixeur-rx500').type, 'product');
});

test('classifyUrl (colruyt live shapes): real category is a collection, numeric fiche is a product', () => {
  // Item 2 regression: the smoke panel used /fr/produits/boissons, which Colruyt
  // itself 404s as a non-existent fiche. The REAL category the panel now targets
  // is a nested trail → collection, so the recipe/collection lane takes over
  // instead of the single-fiche "direct-product" path.
  assert.equal(classifyUrl('https://www.colruyt.be/fr/produits/toutes-les-categories/boissons/eau').type, 'collection');
  // A real Colruyt product fiche is /fr/produits/<numeric id> → product (correct).
  assert.equal(classifyUrl('https://www.colruyt.be/fr/produits/5125').type, 'product');
  // The catalogue root (bare listing root, possibly with a page query) is a
  // collection so discovery crawls it into sub-categories, never a fiche.
  assert.equal(classifyUrl('https://www.colruyt.be/fr/produits?page=1').type, 'collection');
  assert.equal(classifyUrl('https://www.colruyt.be/fr/produits').type, 'collection');
});

// ── detectLocale ─────────────────────────────────────────────────────────────
test('detectLocale: reads country + language from common URL shapes', () => {
  assert.deepEqual(detectLocale('https://www.levi.com/BE/fr_BE/x'), { country: 'BE', language: 'fr', source: 'URL country+language segment' });
  assert.deepEqual(detectLocale('https://www.levi.com/FR/fr_FR/x'), { country: 'FR', language: 'fr', source: 'URL country+language segment' });
  assert.deepEqual(detectLocale('https://shop.example/fr-be/x'), { country: 'BE', language: 'fr', source: 'URL language-country segment' });
  assert.equal(detectLocale('https://shop.example/fr/x').language, 'fr');   // bare language segment
  assert.equal(detectLocale('https://be.shop.example/x').country, 'BE');    // country sub-domain
  assert.equal(detectLocale('https://shop.example/x?country=BE&lang=nl').country, 'BE');
  assert.deepEqual(detectLocale('https://shop.example/products/thing'), { country: null, language: null, source: null });
});

test('normalizeHost / sameSite: www and apex are the same site', () => {
  assert.equal(normalizeHost('https://www.levi.com/x'), 'levi.com');
  assert.equal(normalizeHost('https://levi.com/x'), 'levi.com');
  assert.ok(sameSite('https://www.levi.com/a', 'https://levi.com/b'));
  assert.ok(!sameSite('https://levi.com', 'https://example.com'));
});

// ── mock fetcher (mirrors the real contract: non-2xx → error:`HTTP n`) ────────
class Mock {
  constructor(map) { this.map = map; this.userAgent = 't'; this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; }
  async get(url) {
    this.stats.requests++;
    const e = this.map[url] || { status: 404 };
    const status = e.status ?? 200; const ok = status >= 200 && status < 300;
    if (ok) this.stats.ok++; else { this.stats.failed++; if (status === 403 || status === 429 || status === 503) this.stats.blocked++; }
    return { ok, status, url, requestedUrl: url, contentType: e.ct || 'text/html', kind: 'html', body: ok ? (e.body ?? '') : '', bytes: null, headers: {}, error: ok ? null : `HTTP ${status}`, blocked: !ok };
  }
  async getText(url) { return this.get(url); }
}
const ld = (o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;

test('probe: a 403 everywhere → diagnosis "blocked" (never none-found)', async () => {
  const url = 'https://shop.test/BE/fr_BE/cat/c/jeans';
  const f = new Mock({ [url]: { status: 403 } }); // robots, entry, sitemaps all 403/404
  const p = await probeSource(url, { fetcher: f });
  assert.equal(p.diagnosis, 'blocked');
  assert.equal(p.url_type, 'collection');
  assert.equal(p.locale.country, 'BE'); assert.equal(p.locale.language, 'fr');
  assert.equal(p.action, 'browser-or-feed');
});

test('probe: a product URL that extracts → diagnosis "ok", sample is the URL itself', async () => {
  const url = 'https://shop.test/fr/product/chaise';
  const body = `<html><head>${ld({ '@context': 'https://schema.org', '@type': 'Product', name: 'Chaise', sku: 'C1', image: 'https://x/a.jpg', offers: { price: '49', priceCurrency: 'EUR' } })}</head><body></body></html>`;
  const f = new Mock({ 'https://shop.test/robots.txt': { status: 404 }, [url]: { body } });
  const p = await probeSource(url, { fetcher: f });
  assert.equal(p.diagnosis, 'ok');
  assert.equal(p.url_type, 'product');
  assert.equal(p.sample_url, url);        // used the provided URL, not a sitemap sample
  assert.equal(p.product_data, 'detected');
});

test('probe: an empty CSR shell (no data, JS required) → diagnosis "needs-browser"', async () => {
  const url = 'https://shop.test/fr/collection';
  const f = new Mock({ 'https://shop.test/robots.txt': { status: 404 }, [url]: { body: '<html><head><title>Shop</title></head><body><div id="app"></div></body></html>' } });
  const p = await probeSource(url, { fetcher: f });
  assert.equal(p.diagnosis, 'needs-browser');
  assert.equal(p.action, 'browser');
});

// ── contextLocaleFor (browser context locale from the target URL) ────────────
test('contextLocaleFor: the render speaks the URL locale, fallback only when the URL is silent', async () => {
  const { contextLocaleFor } = await import('../browser.mjs');
  assert.equal(contextLocaleFor('https://www.lidl.be/c/asc/nl-BE/campagne/a10103434'), 'nl-BE');
  assert.equal(contextLocaleFor('https://www.lidl.de/c/de-DE/werkzeug/a123'), 'de-DE');
  assert.equal(contextLocaleFor('https://www.levi.com/US/en_US/clothing/men'), 'en-US');
  assert.equal(contextLocaleFor('https://www.colruyt.be/fr/produits/toutes-les-categories/boissons'), 'fr-BE'); // /fr/ + ccTLD
  assert.equal(contextLocaleFor('https://shop.example/some/page'), null); // nothing in the URL → caller falls back
});
