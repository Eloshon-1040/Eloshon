/**
 * Increment 8 — the report records which extraction strategy produced each
 * product (jsonld / embedded / dom / meta / shopify …), so an operator can see
 * where coverage comes from and the new extractors are observable. Offline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScrape } from '../engine.mjs';

const ld = (o) => `<html><head><script type="application/ld+json">${JSON.stringify(o)}</script></head><body></body></html>`;
const jsonldPage = () => ld({ '@type': 'Product', name: 'JL', offers: { price: '10', priceCurrency: 'EUR' } });
const embeddedPage = () => `<html><head><title>x</title></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ product: { '@type': 'Product', name: 'EM', price: 20, sku: 'S', image: 'i' } })}</script></body></html>`;
const domPage = () => '<html><head><title>x</title></head><body><h1>DM</h1><span class="price">30,00 €</span></body></html>';

class Mock {
  constructor(map) { this.map = map; this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; this.userAgent = 't'; }
  async get(u) {
    this.stats.requests++;
    const body = this.map[u] || '';
    return { ok: true, status: 200, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body, bytes: null, headers: {}, error: null, blocked: false };
  }
  async getText(u) { return this.get(u); }
}

test('report.byStrategy attributes each product to its extraction strategy', async () => {
  const urls = ['https://s/p/jl', 'https://s/p/em', 'https://s/p/dm'];
  const fetcher = new Mock({
    'https://s/p/jl': jsonldPage(),
    'https://s/p/em': embeddedPage(),
    'https://s/p/dm': domPage(),
  });
  const { report } = await runScrape({ store: { slug: 't' }, urls, concurrency: 1, defaultProductType: 'other', lang: 'fr', useBrowser: false, fetcher });
  assert.equal(report.detected, 3);
  assert.equal(report.byStrategy['generic-jsonld'], 1);
  assert.equal(report.byStrategy['generic-embedded-json'], 1);
  assert.equal(report.byStrategy['generic-dom'], 1);
});
