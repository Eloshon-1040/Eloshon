/**
 * Standard engine × shared product-page rules — each fixture page is fed to the
 * REAL runScrape (mock fetcher, offline, recovery ON like the app): a
 * non-product page never becomes a product, a doubtful page stays "to verify"
 * with its reason, a real product is untouched, and the report says WHY.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScrape, formatReport } from '../engine.mjs';
import { PRODUCT_FIXTURES, NON_PRODUCT_FIXTURES, AMBIGUOUS_FIXTURES } from '../../shared/__tests__/fixtures/page-fixtures.mjs';

class Mock {
  constructor(map) { this.map = map; this.calls = []; this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; this.userAgent = 't'; }
  async get(u) {
    this.calls.push(u);
    const e = this.map[u] || { status: 404, body: '<html><head><title>Page introuvable</title></head><body></body></html>' };
    const status = e.status ?? 200;
    return { ok: status >= 200 && status < 300, status, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body: e.body ?? '', bytes: null, headers: {}, error: null, blocked: false };
  }
  async getText(u) { return this.get(u); }
}
const run = (f) => runScrape({ urls: [f.url], store: { slug: 't' }, concurrency: 1, lang: 'fr', useBrowser: false, recovery: true, fetcher: new Mock({ [f.url]: { status: f.status, body: f.html } }) });

for (const f of PRODUCT_FIXTURES) {
  test(`engine keeps the product: ${f.id}`, async () => {
    const { products, report } = await run(f);
    assert.equal(products.length, 1, JSON.stringify(report.pageVerdicts || {}));
    assert.notEqual(products[0].__eligibility.code, 'to_verify_page_doubtful');
  });
}

for (const f of NON_PRODUCT_FIXTURES) {
  test(`engine never turns it into a product: ${f.id}`, async () => {
    const { products, report } = await run(f);
    assert.equal(products.length, 0, `kept: ${JSON.stringify(products.map((p) => p.name))}`);
    const rej = report.pageVerdicts && report.pageVerdicts.rejected;
    assert.ok(rej && rej.count >= 1, 'the rejection is recorded');
    const s = rej.samples.find((x) => x.url === f.url);
    assert.ok(s && s.reasons.length && s.reasons.every((t) => t.length > 8), `a reason for ${f.url}: ${JSON.stringify(rej)}`);
  });
}

for (const f of AMBIGUOUS_FIXTURES) {
  test(`engine keeps a doubtful page as "to verify" with its reason: ${f.id}`, async () => {
    const { products, report } = await run(f);
    assert.equal(products.length, 1);
    assert.equal(products[0].__eligibility.status, 'to_verify');
    if (f.extracted.price != null) {
      assert.equal(products[0].__eligibility.code, 'to_verify_page_doubtful', 'a priced doubtful page is NOT accepted');
      assert.ok(products[0].__eligibility.reason.length > 8);
    }
    assert.equal(report.pageVerdicts.doubtful.count, 1);
  });
}

test('job 20260929165036-g8hh3 regression: an expired ad (HTTP 404 on every representation) is not recovered as a product', async () => {
  const f = NON_PRODUCT_FIXTURES.find((x) => x.id === 'N3-soft-404');
  const url = 'https://www.annonces-epsilon.test/v/animaux/m2448051103-couple-reproducteur';
  const fetcher = new Mock({}); // every URL (original + mobile/AMP twins) → 404 with an error page
  fetcher.map = new Proxy({}, { get: () => ({ status: 404, body: f.html }) });
  const { products, report } = await runScrape({ urls: [url], store: { slug: 't' }, concurrency: 1, lang: 'fr', useBrowser: false, recovery: true, fetcher });
  assert.equal(products.length, 0);
  assert.equal(report.recovered || 0, 0, 'the recovery ladder must not adopt a 404 representation');
  assert.equal(report.notAProductPage, 1, 'a dead page is counted as not-a-product, not as a parse error');
  assert.equal(report.parseErrors, 0);
  assert.equal(report.pageVerdicts.rejected.byReason.http_not_found, 1);
});

test('the text report states WHY pages were rejected / doubtful, with examples', async () => {
  const pages = [NON_PRODUCT_FIXTURES[2], NON_PRODUCT_FIXTURES[5], AMBIGUOUS_FIXTURES[2]];
  const map = Object.fromEntries(pages.map((f) => [f.url, { status: f.status, body: f.html }]));
  const { report } = await runScrape({ urls: pages.map((f) => f.url), store: { slug: 't' }, concurrency: 1, lang: 'fr', useBrowser: false, recovery: true, fetcher: new Mock(map) });
  const txt = formatReport(report);
  assert.match(txt, /rejected pages:\s+2 — raisons : .*page d’erreur « introuvable » ×1.*aucun signal produit ×1/);
  assert.match(txt, /doubtful page:\s+1 kept as "to verify" — raisons : preuve produit faible ×1/);
  assert.match(txt, /--- rejected pages \(examples\) ---/);
  assert.match(txt, /m2448051103-couple-reproducteur : page d’erreur « introuvable »/);
});

test('an existing listing reclassification (≥6 product links, no price) now records its reason too', async () => {
  const html = `<html><head><title>Rayon</title></head><body>${Array.from({ length: 8 }, (_, i) => `<a href="/p/item-${i}">Item ${i}</a>`).join('')}</body></html>`;
  const url = 'https://www.boutique-alpha.test/rayon-cuisine';
  const { products, report } = await runScrape({ urls: [url], store: { slug: 't' }, concurrency: 1, lang: 'fr', useBrowser: false, recovery: false, fetcher: new Mock({ [url]: { body: html } }) });
  assert.equal(products.length, 0);
  assert.equal(report.reclassifiedListings, 1);
  assert.equal(report.pageVerdicts.rejected.byReason.listing_links, 1);
});
