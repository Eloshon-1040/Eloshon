/**
 * Completing INCOMPLETE products (the Lidl/Colruyt case):
 *  • description gap-fill from the DOM when structured data has none
 *    (Lidl "Productbeschrijving", Colruyt "Description du produit");
 *  • browser escalation to fetch a client-rendered PRICE when the HTTP product
 *    has a name but no price. Opt-in (config.recovery), bounded, gap-fill only.
 * Offline (mock fetcher + injected browser spy).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractProduct } from '../extract.mjs';
import { extractDescriptionFromDom } from '../dom-fallback.mjs';
import { runScrape } from '../engine.mjs';

const ld = (o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;

test('dom description: filled from a "Productbeschrijving" section when JSON-LD desc is empty', () => {
  const html = `<html><head><title>x</title>${ld({ '@type': 'Product', name: 'Tente Tessin 5', offers: { price: '179.99', priceCurrency: 'EUR' }, description: '<p>&nbsp;&nbsp;</p>' })}</head>`
    + '<body><h2>Productbeschrijving</h2><ul><li>Aantal personen: 5</li><li>Materiaal buitendoek: polyester</li><li>Waterkolom: 2000 mm</li></ul><h2>Reviews</h2></body></html>';
  const { product } = extractProduct(html, 'https://x/p/1');
  assert.equal(product.name, 'Tente Tessin 5');
  assert.equal(product.price, 179.99);
  assert.match(product.description, /Aantal personen: 5/);          // filled from the DOM
  assert.match(product.description, /Waterkolom: 2000 mm/);
  assert.doesNotMatch(product.description, /Reviews/);              // stops at the next heading
});

test('dom description: a real structured description is NOT overridden', () => {
  const html = `<html><head>${ld({ '@type': 'Product', name: 'P', offers: { price: '5', priceCurrency: 'EUR' }, description: 'Une vraie description produit détaillée.' })}</head><body><div class="description">autre texte</div></body></html>`;
  const { product } = extractProduct(html, 'https://x/p/2');
  assert.equal(product.description, 'Une vraie description produit détaillée.');
});

test('extractDescriptionFromDom: null when there is no description section', () => {
  assert.equal(extractDescriptionFromDom('<html><body><h1>Titre</h1><p>x</p></body></html>'), null);
});

// ── engine: browser escalation to complete a client-rendered price ───────────
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
const renderSpy = (result) => ({ renders: 0, async render() { this.renders++; return result; }, async close() {} });
const run = (cfg) => runScrape({ store: { slug: 't' }, concurrency: 1, defaultProductType: 'other', lang: 'fr', ...cfg });

test('engine: incomplete HTTP product (name, no price) → browser render completes the price', async () => {
  const url = 'https://www.shop.be/p/1';
  const httpHtml = `<html><head>${ld({ '@type': 'Product', name: 'Bananes', description: 'Origine: Équateur' })}</head><body></body></html>`; // name, NO offers
  const renderedHtml = `<html><head>${ld({ '@type': 'Product', name: 'Bananes', offers: { price: '1.99', priceCurrency: 'EUR' } })}</head><body></body></html>`;
  const fetcher = new Mock({ [url]: { body: httpHtml } });
  const spy = renderSpy({ html: renderedHtml, status: 200, block: null, error: null });
  const { products, report } = await run({ urls: [url], recovery: true, fetcher, browserSession: spy });
  assert.equal(products.length, 1);
  assert.equal(products[0].name, 'Bananes');
  assert.equal(products[0].price, 1.99);        // completed via render
  assert.equal(spy.renders, 1);
  assert.equal(report.detected, 1);
});

test('engine: a COMPLETE HTTP product is not re-rendered', async () => {
  const url = 'https://www.shop.be/p/2';
  const fetcher = new Mock({ [url]: { body: `<html><head>${ld({ '@type': 'Product', name: 'Café', offers: { price: '3.50', priceCurrency: 'EUR' } })}</head><body></body></html>` } });
  const spy = renderSpy({ html: '', status: 200, block: null, error: null });
  const { products } = await run({ urls: [url], recovery: true, fetcher, browserSession: spy });
  assert.equal(products[0].price, 3.5);
  assert.equal(spy.renders, 0);                 // already complete → no escalation
});

test('engine: incomplete completion is OFF when recovery is disabled', async () => {
  const url = 'https://www.shop.be/p/3';
  const fetcher = new Mock({ [url]: { body: `<html><head>${ld({ '@type': 'Product', name: 'Sans prix' })}</head><body></body></html>` } });
  const spy = renderSpy({ html: '', status: 200, block: null, error: null });
  const { products } = await run({ urls: [url], fetcher, browserSession: spy }); // recovery OFF
  assert.equal(spy.renders, 0);                 // no completion render
  assert.equal(products[0].price, null);        // stays incomplete (unchanged behaviour)
});
