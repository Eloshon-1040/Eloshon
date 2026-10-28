/**
 * Stock, reviews and category trail, read by shape (no site rule):
 *  - availability per product code from the two measured answer shapes (flat
 *    {gtin, available, level} and nested {gtin, availability:{isAvailable, ship}}),
 *    tolerant of leading zeros; product state from its sizes; schema.org terms;
 *  - rating + review count from a reviews summary (0 reviews → no rating);
 *  - the category trail of a listing page (JSON-LD / microdata / nav / title).
 * Offline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { normAvailability, normLevel, availabilityByCode, signalFor, productAvailability, ratingFromJson } from '../extract/stock.mjs';
import { trailFromDocument } from '../extract/listing-trail.mjs';

test('normAvailability → schema.org terms; levels apart', () => {
  assert.equal(normAvailability('https://schema.org/InStock'), 'InStock');
  assert.equal(normAvailability('OUT_OF_STOCK'), 'OutOfStock');
  assert.equal(normAvailability('oos'), 'OutOfStock');
  assert.equal(normAvailability(true), 'InStock');
  assert.equal(normAvailability('PreOrder'), 'PreOrder');
  assert.equal(normAvailability('ACTIVE'), null, 'a lifecycle status is not a stock state');
  assert.equal(normLevel('LOW'), 'low');
  assert.equal(normLevel('OOS'), 'none');
});

test('availabilityByCode: flat and nested answer shapes; leading zeros tolerated', () => {
  const flat = { objects: [{ gtin: '00198730966311', styleColor: 'X-011', level: 'HIGH', available: true }, { gtin: '00198730984315', level: 'OOS', available: false }] };
  const nested = { sizes: [{ label: 'XS', gtin: '00198726388462', productCode: 'X-077', availability: { isAvailable: true, ship: 'LOW' } }, { label: 'S', gtin: '00198488994604', availability: { isAvailable: false } }] };
  const a = availabilityByCode(flat);
  assert.deepEqual(a.get('00198730966311'), { availability: 'InStock', level: 'high' });
  assert.deepEqual(a.get('00198730984315'), { availability: 'OutOfStock', level: 'none' });
  assert.deepEqual(signalFor(a, '198730966311'), { availability: 'InStock', level: 'high' }, 'EAN-13 vs GTIN-14');
  const b = availabilityByCode(nested);
  assert.deepEqual(b.get('00198726388462'), { availability: 'InStock', level: 'low' });
  assert.equal(b.get('00198488994604').availability, 'OutOfStock');
  // quantity and words, and a size status that is not a stock
  const c = availabilityByCode({ variants: [{ sku: 'A1', quantity: 0 }, { sku: 'A2', stockStatus: 'in_stock' }, { sku: 'A3', status: 'ACTIVE' }] });
  assert.equal(c.get('A1').availability, 'OutOfStock'); assert.equal(c.get('A2').availability, 'InStock'); assert.equal(c.has('A3'), false);
});

test('productAvailability from sizes', () => {
  assert.equal(productAvailability([{ availability: 'OutOfStock' }, { availability: 'InStock' }]), 'InStock');
  assert.equal(productAvailability([{ availability: 'OutOfStock' }, { availability: 'OutOfStock' }]), 'OutOfStock');
  assert.equal(productAvailability([{ availability: 'PreOrder' }, { availability: 'OutOfStock' }]), 'PreOrder');
  assert.equal(productAvailability([{}]), null);
});

test('ratingFromJson: summary shapes; 0 reviews → no rating; unrelated JSON → null', () => {
  assert.deepEqual(ratingFromJson({ catItem: { sku: 'X' }, rating: 4.36, directReviewsCount: 28 }), { rating: 4.36, count: 28 });
  assert.deepEqual(ratingFromJson({ catItem: { sku: 'X' }, rating: 0.0, directReviewsCount: 0 }), { rating: null, count: 0 });
  assert.deepEqual(ratingFromJson({ results: [{ ProductStatistics: { ReviewStatistics: { AverageOverallRating: 4.5, TotalReviewCount: 120 } } }] }), { rating: 4.5, count: 120 });
  assert.equal(ratingFromJson({ labels: { rating: 'Note', reviews: 'Avis' } }), null);
});

const doc = (html) => parseHTML(`<html><body>${html}</body></html>`).document;

test('listing trail: JSON-LD BreadcrumbList (Home dropped), microdata, nav, title — never the home page title', () => {
  const ld = `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home', item: 'https://shop.test/' }, { '@type': 'ListItem', position: 2, name: 'Homme', item: 'https://shop.test/homme' }, { '@type': 'ListItem', position: 3, name: 'Chaussures' }] })}</script><h1>Chaussures</h1>`;
  assert.deepEqual(trailFromDocument(doc(ld), 'https://shop.test/be/fr/homme/chaussures'), { trail: ['Homme', 'Chaussures'], source: 'jsonld' });
  const micro = '<ol itemscope itemtype="https://schema.org/BreadcrumbList"><li itemprop="itemListElement"><span itemprop="name">Accueil</span></li><li itemprop="itemListElement"><span itemprop="name">Femme</span></li></ol>';
  assert.deepEqual(trailFromDocument(doc(micro), 'https://shop.test/femme'), { trail: ['Femme'], source: 'microdata' });
  const nav = '<nav aria-label="Breadcrumb"><ol><li><a href="/">Shop</a></li><li><a href="/kids">Kids</a></li><li>Hoodies</li></ol></nav>';
  assert.deepEqual(trailFromDocument(doc(nav), 'https://www.shop.test/kids/hoodies'), { trail: ['Kids', 'Hoodies'], source: 'nav' }, 'the site\'s own name is dropped');
  assert.deepEqual(trailFromDocument(doc('<h1>Nike Sale</h1>'), 'https://www.nike.test/de/w/sale-3yaep'), { trail: ['Nike Sale'], source: 'title' });
  assert.deepEqual(trailFromDocument(doc('<h1>Welcome to our shop</h1>'), 'https://shop.test/fr/'), { trail: [], source: null }, 'home page: no title trail');
});
