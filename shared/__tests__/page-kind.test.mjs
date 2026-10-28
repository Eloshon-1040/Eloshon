/**
 * Shared "is this a product page?" rules — every fixture (clear product, clear
 * non-product, ambiguous) gets the expected verdict WITH a readable reason, the
 * rules are config-overridable, and listing tiles are filtered the same way.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyHtmlPage, classifyPage, pageSignals, classifyItem, mergeRules, REJECTED_KINDS, DEFAULT_PAGE_RULES } from '../classify/page-kind.mjs';
import { PRODUCT_FIXTURES, NON_PRODUCT_FIXTURES, AMBIGUOUS_FIXTURES, ALL_FIXTURES } from './fixtures/page-fixtures.mjs';

const verdictOf = (f, rules) => classifyHtmlPage(f.html, { url: f.url, status: f.status, extracted: f.extracted, rules });

for (const f of ALL_FIXTURES) {
  test(`fixture ${f.id} → ${f.expect} (${f.note})`, () => {
    const v = verdictOf(f);
    assert.equal(v.kind, f.expect, JSON.stringify(v));
    if (f.expect !== 'product') {
      assert.ok(v.reasons.length >= 1, 'a non-product / doubtful verdict always says WHY');
      for (const r of v.reasons) assert.ok(typeof r.text === 'string' && r.text.length > 8 && !/undefined/.test(r.text), r.text);
    }
  });
}

test('totals on the fixtures: 0 product rejected, 0 non-product accepted', () => {
  const falseRejects = PRODUCT_FIXTURES.filter((f) => REJECTED_KINDS.includes(verdictOf(f).kind));
  const falseAccepts = NON_PRODUCT_FIXTURES.filter((f) => verdictOf(f).kind === 'product');
  assert.deepEqual(falseRejects.map((f) => f.id), []);
  assert.deepEqual(falseAccepts.map((f) => f.id), []);
  assert.ok(AMBIGUOUS_FIXTURES.every((f) => verdictOf(f).kind === 'uncertain'), 'ambiguous pages are kept but flagged, never silently accepted or dropped');
});

test('reasons name the concrete signal (schema type, soft-404 title, number of product blocks)', () => {
  const byId = Object.fromEntries(ALL_FIXTURES.map((f) => [f.id, verdictOf(f)]));
  assert.match(byId['N1-collection-page'].reasons[0].text, /CollectionPage, pas Product/);
  assert.match(byId['N3-soft-404'].reasons[0].text, /introuvable/);
  assert.match(byId['N2-grid-one-product-schema-per-tile'].reasons[0].text, /plusieurs blocs produit sur la page \(6/);
  assert.match(byId['N6-csr-category-no-price'].reasons[0].text, /aucun signal produit/);
});

test('rules are data: a site whose products live under a "non-product" segment can be allowed from config', () => {
  const f = NON_PRODUCT_FIXTURES.find((x) => x.id === 'N7-legal-page');
  assert.equal(verdictOf(f).kind, 'non_product');
  assert.equal(verdictOf(f, { allowSegments: ['c'] }).kind, 'uncertain', 'without the segment hint it is only doubtful');
  const extra = mergeRules({ nonProductSegments: ['univers'] });
  assert.ok(extra.nonProductSegments.includes('univers') && extra.nonProductSegments.includes('panier'), 'extends, never replaces the defaults');
  assert.equal(mergeRules({ listingPriceMin: 20 }).listingPriceMin, 20);
  assert.equal(mergeRules({ listingPriceMin: -1 }).listingPriceMin, DEFAULT_PAGE_RULES.listingPriceMin);
});

test('a product segment followed by an id wins over a non-product segment (Shopify /collections/x/products/y)', () => {
  const sig = pageSignals('<html><head><title>Bol</title></head><body><h1>Bol</h1></body></html>', { url: 'https://s.test/collections/cuisine/products/bol-gres' });
  assert.equal(sig.productPath, true);
  assert.equal(sig.nonProductSegment, null);
  assert.notEqual(classifyPage(sig, { name: 'Bol', price: null }).kind, 'non_product');
});

test('a single Product schema with a price survives an error-looking headline; a bare "404" in a name does not trigger', () => {
  const html = `<html><head><title>Erreur 404 — T-shirt collector</title><script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'T-shirt Erreur 404', offers: { price: '25' } })}</script></head><body></body></html>`;
  assert.equal(classifyHtmlPage(html, { url: 'https://s.test/p/t-404', status: 200, extracted: { name: 'T-shirt Erreur 404', price: 25 } }).kind, 'product');
});

test('classifyItem: empty / call-to-action tiles are rejected with a reason; real tiles pass', () => {
  assert.equal(classifyItem({ name: 'Chaise', price: 49, url: '/p/1' }).ok, true);
  assert.equal(classifyItem({ url: 'https://s.test/p/2' }).ok, true, 'a url-only tile is kept (its product page may complete it)');
  assert.equal(classifyItem({ sku: 'A1' }).ok, true);
  assert.equal(classifyItem({}).code, 'item_empty');
  assert.equal(classifyItem({ image: '/banner.jpg', strategy: 'dom' }).code, 'item_empty');
  const cta = classifyItem({ name: 'Voir tout', url: '/c/promos' });
  assert.equal(cta.code, 'item_cta_tile');
  assert.match(cta.text, /Voir tout/);
  assert.equal(classifyItem({ name: 'Voir tout', price: 9.99 }).ok, true, 'a tile WITH a price is not judged a CTA');
});
