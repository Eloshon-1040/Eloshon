/**
 * Listing extraction (product cards from a listing page) + listing → fiche
 * enrichment. Structured-first (JSON-LD ItemList/Products + embedded-JSON
 * arrays), fed into the SAME pipeline. Offline (pure + mock fetcher).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractListing } from '../listing.mjs';
import { extractProductsFromJsonLd } from '../jsonld.mjs';
import { extractProductsFromEmbeddedJson } from '../html-meta.mjs';
import { runScrape } from '../engine.mjs';

const ld = (o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;

test('extractProductsFromJsonLd: ItemList → one card per item (URL resolved by caller)', () => {
  const html = `<html><head>${ld({ '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: [
    { '@type': 'ListItem', item: { '@type': 'Product', name: 'A', url: '/p/a', offers: { price: '10', priceCurrency: 'EUR' } } },
    { '@type': 'ListItem', item: { '@type': 'Product', name: 'B', url: '/p/b', offers: { price: '20', priceCurrency: 'EUR' } } },
  ] })}</head><body></body></html>`;
  const ps = extractProductsFromJsonLd(html);
  assert.equal(ps.length, 2);
  assert.equal(ps[0].name, 'A'); assert.equal(ps[0].price, 10); assert.equal(ps[0].canonicalUrl, '/p/a');
});

test('extractProductsFromEmbeddedJson: a Next.js product array → cards', () => {
  const html = `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { products: [
    { '@type': 'Product', name: 'X', sku: 'SX', price: 5, url: '/p/x', image: 'ix' },
    { '@type': 'Product', name: 'Y', sku: 'SY', price: 6, url: '/p/y', image: 'iy' },
  ] } } })}</script></body></html>`;
  const ps = extractProductsFromEmbeddedJson(html);
  assert.equal(ps.length, 2);
  assert.deepEqual(ps.map((p) => p.sku).sort(), ['SX', 'SY']);
});

test('extractListing: resolves URLs, dedups, and merges the same product across sources', () => {
  const base = 'https://shop.example/fr/cat';
  const html = `<html><head>${ld({ '@type': 'ItemList', itemListElement: [
    { item: { '@type': 'Product', name: 'Chaise', url: '/fr/p/a', offers: { price: '49', priceCurrency: 'EUR' } } },
  ] })}</head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ products: [
    { '@type': 'Product', name: 'Chaise', url: '/fr/p/a', gtin13: '5410000000017', image: 'https://x/a.jpg' },
  ] })}</script></body></html>`;
  const { cards } = extractListing(html, base);
  assert.equal(cards.length, 1);                        // same URL from 2 sources → merged
  assert.equal(cards[0].sourceUrl, 'https://shop.example/fr/p/a');
  assert.equal(cards[0].price, 49);                     // from JSON-LD
  assert.equal(cards[0].gtin, '5410000000017');         // filled from embedded
  assert.ok(cards[0].images.includes('https://x/a.jpg'));
});

// ── E2E: listing → fiche → enrichment through the real pipeline ──────────────
class Mock {
  constructor(map) { this.map = map; this.calls = []; this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; this.userAgent = 't'; }
  async get(u) {
    this.calls.push(u); this.stats.requests++;
    const e = this.map[u] || { status: 404, body: '' };
    const status = e.status ?? 200; const ok = status >= 200 && status < 300;
    return { ok, status, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body: e.body ?? '', bytes: null, headers: {}, error: null, blocked: false };
  }
  async getText(u) { return this.get(u); }
}

test('E2E: listing cards seed enrichment; fiche completes fields; card-only survives a missing fiche', async () => {
  const origin = 'https://shop.example/fr/cat';
  const listing = `<html><head>${ld({ '@type': 'ItemList', itemListElement: [
    { item: { '@type': 'Product', name: 'Chaise', url: '/fr/p/a', image: 'https://x/a.jpg', offers: { price: '49', priceCurrency: 'EUR' } } },
    { item: { '@type': 'Product', name: 'Tabouret', url: '/fr/p/b', image: 'https://x/b.jpg', offers: { price: '19', priceCurrency: 'EUR' } } },
  ] })}</head><body></body></html>`;
  // Fiche A: adds description + gtin (no image). Fiche B: 404 (missing) → card only.
  const ficheA = `<html><head>${ld({ '@type': 'Product', name: 'Chaise de bureau', description: 'Chaise ergonomique réglable', gtin13: '5410000000017', offers: { price: '49', priceCurrency: 'EUR' } })}</head><body></body></html>`;
  const fetcher = new Mock({
    [origin]: { body: listing },
    'https://shop.example/fr/p/a': { body: ficheA },
    'https://shop.example/fr/p/b': { status: 404 },
  });
  const { products, report } = await runScrape({ store: { slug: 't' }, origin, concurrency: 1, defaultProductType: 'other', lang: 'fr', useBrowser: false, fetcher });

  const a = products.find((p) => /Chaise/.test(p.name));
  const b = products.find((p) => /Tabouret/.test(p.name));
  assert.ok(a, 'product A present');
  assert.equal(a.price, 49);
  assert.match(a.description, /ergonomique/);         // from the fiche
  assert.equal(a.barcode, '5410000000017');              // GTIN from the fiche
  assert.equal(a.image_url, 'https://x/a.jpg');          // filled from the listing card
  assert.ok(b, 'product B present from the card even though its fiche 404d');
  assert.equal(b.price, 19);
  assert.equal(b.image_url, 'https://x/b.jpg');
  assert.ok((report.enriched || 0) >= 1);
});
