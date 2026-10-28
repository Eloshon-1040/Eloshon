/**
 * Browser-first collection discovery: when HTTP finds nothing, the rendered page
 * yields product CARDS by repeated-structure detection (image + price + link),
 * and those feed the SAME pipeline — even when the product URLs match NO URL
 * pattern (PrestaShop `/12-slug.html`, custom slugs). The card's price is parsed;
 * off-site cards are dropped. Offline: mock fetcher + fake browser session.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverProducts } from '../discover.mjs';

class Mock {
  constructor(map) { this.map = map; this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; this.userAgent = 't'; this.jar = null; }
  async get(u) {
    this.stats.requests++;
    const e = this.map[u] || { status: 404 };
    const status = e.status ?? 200; const ok = status >= 200 && status < 300;
    return { ok, status, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body: ok ? (e.body ?? '') : '', bytes: null, headers: {}, error: ok ? null : `HTTP ${status}`, blocked: false };
  }
  async getText(u) { return this.get(u); }
}

// A fake browser session exposing the new collectListing (cards + links + html).
const fakeBrowser = {
  async collectListing() {
    return {
      cards: [
        { url: 'https://shop.test/12-engrais-plagron.html', name: 'Engrais Plagron', priceText: '19,90 €', image: 'https://shop.test/img/a.jpg' },
        { url: 'https://shop.test/13-substrat-coco.html', name: 'Substrat Coco', priceText: '€25', image: 'https://shop.test/img/b.jpg' },
        { url: 'https://facebook.com/shop', name: 'Facebook', priceText: '1 €', image: null }, // off-site → dropped
      ],
      links: [], html: '<html><body></body></html>', blocked: null, error: null,
    };
  },
  async cookies() { return []; },
};

test('browser discovery: repeated-structure cards (non-pattern URLs) feed the pipeline as seeds', async () => {
  const origin = 'https://shop.test/collection';
  // HTTP finds nothing (empty page, no sitemap) → browser fallback runs.
  const fetcher = new Mock({ [origin]: { body: '<html><head><title>Cat</title></head><body>no products here</body></html>' } });
  const { urls, report, seeds } = await discoverProducts(fetcher, origin, {
    maxProducts: 50, getBrowser: async () => fakeBrowser,
  });
  const paths = urls.map((u) => new URL(u).pathname).sort();
  assert.deepEqual(paths, ['/12-engrais-plagron.html', '/13-substrat-coco.html']); // PrestaShop-style, no URL pattern; off-site dropped
  assert.ok(report.method.includes('browser'));
  const a = seeds.get([...seeds.keys()].find((k) => k.includes('12-engrais')));
  assert.equal(a.name, 'Engrais Plagron');
  assert.equal(a.price, 19.9);            // priceText "19,90 €" parsed
  assert.equal(a.currency, 'EUR');
  assert.ok((a.images || [])[0].includes('/img/a.jpg'));
});
