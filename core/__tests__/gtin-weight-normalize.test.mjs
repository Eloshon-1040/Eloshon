/**
 * Two data-quality fixes surfaced by a live lidl.be CSV export:
 *
 *  1. Multi-variant products expose GTIN as an ARRAY in JSON-LD
 *     (`"gtin13":["4023122153986","4023122153993"]`). String(array) joined them
 *     with a comma and a later digits() collapsed that into one 26-digit
 *     non-code, leaking into source_product_id (barcode came out empty). Now the
 *     first VALID EAN is chosen, at the extractor AND the normalize chokepoint.
 *
 *  2. A capacity/rating in a product NAME ("Elektrische lier, 600 kg" — a
 *     winch's pull rating) was taken as the item's own weight. weightFromName is
 *     now conservative: it drops a mass that is implausibly large for a
 *     title-stated self-weight, or that sits next to a load/capacity keyword.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstGtin, extractProductFromJsonLd } from '../jsonld.mjs';
import { extractProduct } from '../extract.mjs';
import { toNormalizedProduct } from '../normalize.mjs';

// ── firstGtin ────────────────────────────────────────────────────────────────
test('firstGtin: array / joined string → first valid EAN; single & non-standard preserved', () => {
  assert.equal(firstGtin(['4023122153986', '4023122153993']), '4023122153986');
  assert.equal(firstGtin('4023122153986,4023122153993'), '4023122153986');
  assert.equal(firstGtin('4015671017086'), '4015671017086');           // single EAN untouched
  assert.equal(firstGtin(['bad', '4005029121879']), '4005029121879');  // skips the non-EAN token
  assert.equal(firstGtin('ABC-123'), 'ABC');                           // no EAN length → first token kept
  assert.equal(firstGtin(null), null);
});

// ── JSON-LD extractor no longer concatenates ────────────────────────────────
test('pickGtin: a JSON-LD gtin13 ARRAY yields one clean EAN, not a concatenation', () => {
  const html = `<html><body><script type="application/ld+json">${JSON.stringify({
    '@type': 'Product', name: 'Wandtank SLIM 300 l',
    gtin13: ['4023122153986', '4023122153993'],
    offers: { '@type': 'Offer', price: '179.99', priceCurrency: 'EUR' },
  })}</script></body></html>`;
  const p = extractProductFromJsonLd(html);
  assert.equal(p.gtin, '4023122153986');
});

// ── normalize chokepoint: barcode + source_product_id sanitised ──────────────
test('toNormalizedProduct: a mashed multi-EAN gtin becomes one clean barcode + id', () => {
  // The exact shape the live CSV leaked (row 4): comma-joined pair.
  const np = toNormalizedProduct({ name: 'Wandtank', price: 179.99, gtin: '4023122153986,4023122153993' });
  assert.equal(np.barcode, '4023122153986');
  assert.equal(np.source_product_id, '4023122153986');
});

test('toNormalizedProduct: a single valid EAN is unchanged', () => {
  const np = toNormalizedProduct({ name: 'Lier', price: 149.99, gtin: '4015671017086' });
  assert.equal(np.barcode, '4015671017086');
  assert.equal(np.source_product_id, '4015671017086');
});

// ── weightFromName: capacity/rating in a title is not a weight ───────────────
const ficheNoWeight = (name) => `<html><body><script type="application/ld+json">${JSON.stringify({
  '@type': 'Product', name, offers: { '@type': 'Offer', price: '149.99', priceCurrency: 'EUR' },
})}</script></body></html>`;

test('weightFromName: a winch load rating in the name is NOT taken as weight', () => {
  const { product } = extractProduct(ficheNoWeight('Elektrische lier, 600 kg'), 'https://x/p/1');
  assert.equal(product.weightText, null);            // 600 kg is a capacity, not a self-weight
  const np = toNormalizedProduct(product);
  assert.equal(np.weight_kg, null);
});

test('weightFromName: a capacity keyword near the number drops it', () => {
  const { product } = extractProduct(ficheNoWeight('Étagère charge max 30 kg'), 'https://x/p/2');
  assert.equal(product.weightText, null);
});

test('weightFromName: a plausible small self-weight in the name still passes', () => {
  const { product } = extractProduct(ficheNoWeight('Farine de blé 1,5 kg'), 'https://x/p/3');
  assert.equal(product.weightText, '1,5 kg');
  const np = toNormalizedProduct(product);
  assert.equal(np.weight_kg, 1.5);
});
