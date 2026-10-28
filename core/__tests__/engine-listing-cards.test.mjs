/**
 * Cards read from the listing itself (an id and a price, no page of their own) go
 * through the engine without a single request: normalised, deduplicated by id,
 * judged by the eligibility rules, delivered. A fetched page of the same id wins.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScrape, formatReport } from '../engine.mjs';
import { evaluateEligibility } from '../eligibility/index.mjs';
import { toNormalizedProduct } from '../normalize.mjs';

const neverFetch = { userAgent: 'test', stats: { bytes: 0 }, jar: null, async get(url) { throw new Error(`unexpected request: ${url}`); } };
const card = (i, extra = {}) => ({ strategy: 'embedded-state', name: `Chambre · Ville ${i}`, price: 100 + i, currency: 'EUR', sku: `${9000 + i}`, images: [`https://img.stays.test/${i}.jpg`], description: `23–25 oct. · Particulier · ${100 + i} € au total`, rating: 4.7, reviewCount: 12 + i, ...extra });

test('cards without URL: accepted products, no request, dedup by id, report says where they come from', async () => {
  const cards = [card(0), card(1), card(1), card(2, { price: null }), { name: 'sans identifiant', price: 5 }];
  const { products, report } = await runScrape({ store: { slug: '' }, urls: [], cardsWithoutUrl: cards, fetcher: neverFetch, useBrowser: false });
  assert.equal(products.length, 2, 'two distinct priced cards with an id; the duplicate, the unpriced one and the id-less one are not products');
  assert.equal(report.duplicates, 1);
  assert.equal(report.accepted, 2); assert.equal(report.toVerify, 0);
  assert.equal(report.listedOnly, 2);
  assert.equal(report.fetched, 0);
  const p = products[0];
  assert.equal(p.source_url, null); assert.equal(p.source_product_id, '9000');
  assert.equal(p.price, 100); assert.equal(p.raw.currency, 'EUR');
  assert.equal(p.description, '23–25 oct. · Particulier · 100 € au total');
  assert.equal(p.raw.rating, 4.7); assert.equal(p.raw.review_count, 12);
  assert.equal(p.__eligibility.status, 'accepted');
  assert.match(formatReport(report), /from the listing:\s+2 product\(s\)/);
});

test('eligibility: a listing with a name, a price and an id (no URL, no EAN) is accepted; an e-commerce product without a price stays to verify; nothing to identify → excluded', () => {
  const listing = toNormalizedProduct(card(3));
  assert.equal(evaluateEligibility(listing).status, 'accepted');
  const noPrice = toNormalizedProduct({ name: 'Perceuse', sourceUrl: 'https://shop.test/product/perceuse-1', sku: 'PRC1' });
  assert.equal(evaluateEligibility(noPrice).status, 'to_verify');
  assert.equal(evaluateEligibility(noPrice).code, 'to_verify_incomplete');
  assert.equal(evaluateEligibility(toNormalizedProduct({ price: 12 })).status, 'excluded');
});

test('normalisation: a rating stated without any count is kept; a count of 0 means no rating', () => {
  assert.equal(toNormalizedProduct({ name: 'x', price: 1, rating: 4.75 }).raw.rating, 4.75);
  assert.equal(toNormalizedProduct({ name: 'x', price: 1, rating: 4.75, reviewCount: 0 }).raw.rating, null);
  assert.equal(toNormalizedProduct({ name: 'x', price: 1, rating: 4.75, reviewCount: 9 }).raw.review_count, 9);
});
