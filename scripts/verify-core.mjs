/**
 * Step 2 check: the standalone core runs end-to-end with the GENERIC eligibility
 * layer and ZERO Luna dependency — no network, no Supabase, no repo paths.
 */
import assert from 'node:assert/strict';
import { evaluateEligibility } from '../core/eligibility/index.mjs';
import { runScrape, formatReport } from '../core/engine.mjs';

// 1) Generic eligibility policy (business-agnostic).
assert.equal(evaluateEligibility({ name: 'Widget', price: 9.99, source_product_id: 'X' }).status, 'accepted');
assert.equal(evaluateEligibility({ name: 'Widget', price: null, source_url: 'u' }).status, 'to_verify');
assert.equal(evaluateEligibility({}).status, 'excluded');
console.log('✓ eligibility: accepted / to_verify / excluded');

// 2) End-to-end engine run with an injected fetcher (no real HTTP).
const html = `<html><head><script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org', '@type': 'Product', name: 'Test Widget',
  sku: 'SKU-123', image: 'https://x/y.jpg',
  offers: { '@type': 'Offer', price: '9.99', priceCurrency: 'EUR', availability: 'https://schema.org/InStock' },
})}</script></head><body>ok</body></html>`;

const fakeFetcher = {
  userAgent: 'Eloshon-Scraper/1.0',
  stats: { requests: 1 },
  async get(url) { return { ok: true, status: 200, url, requestedUrl: url, body: html, error: null, headers: {}, kind: 'html' }; },
};

const { products, report } = await runScrape({
  store: { slug: 'demo-source' },
  urls: ['https://example.com/p/1'],
  fetcher: fakeFetcher,
  useBrowser: false,
  concurrency: 1,
  lang: 'fr',
});

assert.equal(products.length, 1, 'one product extracted');
assert.equal(products[0].name, 'Test Widget');
assert.equal(products[0].__eligibility.status, 'accepted');
assert.equal(report.accepted, 1);
console.log('✓ engine run: 1 product detected → accepted (generic profile)');
console.log('\n' + formatReport(report) + '\n');
console.log('CORE OK — standalone, no Luna dependency.');
