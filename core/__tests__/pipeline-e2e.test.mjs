/**
 * End-to-end pipeline regression: a source that returns oversized response
 * headers (CDN/WAF such as Akamai) must still yield products + a populated CSV.
 *
 * Reproduces the real empty-CSV cause found on a live run: product pages carried
 * a header block larger than undici's default 16 KiB limit, so every worker
 * fetch threw `UND_ERR_HEADERS_OVERFLOW` → 0 fetched → 0 detected → empty CSV.
 * Runs the WHOLE real pipeline (discovery → fetch → extract → normalize →
 * classify → CSV) through the real Fetcher against a local loopback server, so
 * the fetch-layer fix is exercised for real. Offline, deterministic, no site.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runScrape } from '../engine.mjs';
import { toImportCsv } from '../csv.mjs';
import { Fetcher } from '../http-fetcher.mjs';

const BIG = 'x'.repeat(40 * 1024); // 40 KiB → overflows undici's 16 KiB default
const N = 15;

const productLd = (i) => JSON.stringify({
  '@context': 'https://schema.org', '@type': 'Product',
  name: `Café en grains bio ${i} 1kg`, sku: `SKU-${1000 + i}`,
  gtin13: String(5410000000000 + i), brand: { '@type': 'Brand', name: 'MarqueTest' },
  image: `http://127.0.0.1/img/prod-${i}.jpg`,
  offers: { '@type': 'Offer', price: (3.49 + i).toFixed(2), priceCurrency: 'EUR', availability: 'https://schema.org/InStock' },
});

function makeServer() {
  return http.createServer((req, res) => {
    res.setHeader('X-Akamai-Big', BIG); // heavy header block on EVERY response
    const u = req.url;
    if (u === '/robots.txt' || u.includes('sitemap')) { res.statusCode = 404; return res.end(''); }
    if (u.startsWith('/c/')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const links = Array.from({ length: N }, (_, i) => `<a href="/p/produit-${i}/p10000${i}">Produit ${i}</a>`).join('');
      return res.end(`<html><head><title>Catalogue</title></head><body><h1>Aliments</h1><p>${'nos produits en magasin '.repeat(10)}</p>${links}</body></html>`);
    }
    if (u.startsWith('/p/')) {
      const i = Number((u.match(/\/p10000(\d+)/) || [])[1] || 0);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(`<html><head><title>Produit ${i}</title><script type="application/ld+json">${productLd(i)}</script></head><body><h1>Produit ${i}</h1></body></html>`);
    }
    res.statusCode = 404; res.end('');
  });
}

test('E2E: a heavy-header source yields products + a populated CSV (fetch fix)', async () => {
  const server = makeServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const { products, report } = await runScrape({
      store: { slug: 'test-grocery' }, origin: `http://127.0.0.1:${port}/c/aliments`,
      limit: N, concurrency: 2, defaultProductType: 'other', lang: 'fr', useBrowser: false,
      // Real Fetcher (so the header-overflow fix is exercised) but without the
      // polite per-host delay, to keep the test fast.
      fetcher: new Fetcher({ minDelayMs: 0 }),
    });

    // The fetch layer used to fail here with NETWORK_ERROR on every product page.
    assert.equal(report.networkErrors, 0);
    assert.equal(report.fetched, N);
    assert.equal(report.detected, N);
    assert.equal(report.normalized, N);
    assert.ok(report.accepted >= 1);
    assert.equal(report.status, 'OK');

    // CSV really carries the accepted rows (not just an empty header).
    const accepted = products.filter((p) => p.__eligibility?.status === 'accepted');
    const csv = toImportCsv(accepted, { storeSlug: 'test-grocery' });
    const dataLines = csv.trim().split('\r\n').length - 1;
    assert.equal(dataLines, accepted.length);
    assert.ok(dataLines >= 1);

    // Essential fields actually flow through the whole pipeline.
    const complete = products.filter((p) => p.name && p.price != null && p.source_url && p.image_url && (p.barcode || p.source_product_id));
    assert.equal(complete.length, products.length);
  } finally { await new Promise((r) => server.close(r)); }
});
