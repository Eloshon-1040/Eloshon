/**
 * LISTING cards in embedded JSON (an accommodation, a vehicle, a job…), read by
 * SHAPE — never by a site name:
 *  - the price sits in a display-line object ({ primaryLine:{ price, qualifier } } or
 *    ordered components with a discountedPrice + a qualifier component) and its BASIS
 *    ("au total", "par nuit") travels with it;
 *  - the image is an array of picture objects, the id the entity's (a Relay global id
 *    is decoded), the rating stated as the site writes it or kept in nested stats;
 *  - the rows of a carousel (the same card shape under the same key, section after
 *    section) are ONE grid; a grid WITH prices beats a bigger tile array without.
 * Fixtures are fictitious (no real listing, no host name).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractProductsFromJson, extractEmbeddedProducts } from '../extract/embedded-state.mjs';
import { decodeRelayId, listingExtras } from '../extract/product-shape.mjs';
import { moneyQualifier } from '../extract/money.mjs';

const BASE = 'https://stays.test/';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// A home-page card: price in a display line with an explicit qualifier, lines in a
// structured-content object, the id and the rating stats one level down.
const homeCard = (i) => ({
  __typename: 'StayResult',
  title: `Chambre · Ville ${i}`,
  structuredDisplayPrice: { primaryLine: { accessibilityLabel: `${100 + i} € au total`, price: `${100 + i} €`, qualifier: 'au total' }, loggingMetadata: { loggingCorrelationId: 'x' } },
  structuredContent: { primaryLine: [{ __typename: 'Msg', body: '23–25 oct.' }, { __typename: 'Msg', body: 'Particulier' }] },
  demandListing: { id: b64(`DemandListing:${1000 + i}`), ratingStats: { overallRatingStats: { ratingCount: 10 + i, ratingAverage: 4.5 } } },
  contextualPictures: [{ __typename: 'Pic', id: `${i}`, picture: `https://img.stays.test/${i}.jpg` }],
  listingParamOverrides: { checkin: '2026-10-23', checkout: '2026-10-25' },
});
// A search-page card: ordered price components, a property id, a localized rating with
// its count, a sub-title, and a promo message that must NOT become the description.
const searchCard = (i) => ({
  __typename: 'StayResult',
  avgRatingLocalized: `4,6${i % 10} (${50 + i})`,
  structuredDisplayPrice: { primaryLine: { accessibilityLabel: `${700 + i} € au total`, orderedComponents: [{ discountedPrice: `${700 + i} €` }, { qualifier: 'au total' }] } },
  title: `Hôtel ${i}`,
  subtitle: 'Hôtel · Ville',
  propertyId: `${5000 + i}`,
  paymentMessages: [{ text: '+ 50 € de crédit', type: 'HIGHLIGHT' }],
  contextualPictures: [{ picture: `https://img.stays.test/h${i}.jpg` }],
});
const tile = (i) => ({ title: `Destination ${i}`, picture: { url: `https://img.stays.test/d${i}.jpg` } });

test('three carousel rows of 8 cards = one grid of 24; price, basis, id, image, rating, lines read by shape', () => {
  const page = {
    sections: [
      { kind: 'tiles', items: Array.from({ length: 20 }, (_, i) => tile(i)) },
      { kind: 'row', items: Array.from({ length: 8 }, (_, i) => homeCard(i)) },
      { kind: 'row', items: Array.from({ length: 8 }, (_, i) => homeCard(8 + i)) },
      { kind: 'row', items: Array.from({ length: 8 }, (_, i) => homeCard(16 + i)) },
    ],
  };
  const r = extractProductsFromJson(page, BASE);
  assert.equal(r.cards.length, 24, 'the three rows are read as one grid, the 20 tiles without a price lose');
  const c = r.cards[0];
  assert.equal(c.name, 'Chambre · Ville 0');
  assert.equal(c.price, 100); assert.equal(c.currency, 'EUR');
  assert.equal(c.sku, '1000', 'the Relay global id is decoded to the entity id');
  assert.deepEqual(c.images, ['https://img.stays.test/0.jpg']);
  assert.equal(c.rating, 4.5); assert.equal(c.reviewCount, 10);
  assert.equal(c.description, '23–25 oct. · Particulier · 100 € au total', 'secondary lines + the price with its basis');
  assert.equal(c.sourceUrl, undefined, 'no link on the card: none invented');
});

test('search-style card: ordered price components, property id, localized rating, promo message kept out of the description', () => {
  const r = extractProductsFromJson({ results: Array.from({ length: 18 }, (_, i) => searchCard(i)) }, BASE);
  assert.equal(r.cards.length, 18);
  const c = r.cards[3];
  assert.equal(c.price, 703);
  assert.equal(c.sku, '5003');
  assert.equal(c.rating, 4.63); assert.equal(c.reviewCount, 53);
  assert.equal(c.description, 'Hôtel · Ville · 703 € au total');
  assert.ok(!/crédit/.test(c.description), 'a money message is not a line of the card');
});

test('e-commerce grid is unchanged: its own array wins, a same-shape recommendations array is not merged in', () => {
  const p = (i, pfx) => ({ name: `${pfx} ${i}`, price: 10 + i, url: `/product/${pfx.toLowerCase()}-${i}`, sku: `${pfx}${i}` });
  const page = { products: Array.from({ length: 12 }, (_, i) => p(i, 'Article')), recommendations: Array.from({ length: 6 }, (_, i) => p(i, 'Reco')) };
  const r = extractProductsFromJson(page, 'https://shop.test/c/x');
  assert.equal(r.cards.length, 12);
  assert.ok(r.cards.every((c) => /^Article/.test(c.name)));
  assert.equal(r.cards[0].description, undefined, 'no listing extras on an e-commerce card');
});

test('a smaller grid WITH prices beats a bigger tile array without a price', () => {
  const page = { hubs: Array.from({ length: 30 }, (_, i) => tile(i)), rooms: Array.from({ length: 6 }, (_, i) => homeCard(i)) };
  const r = extractProductsFromJson(page, BASE);
  assert.equal(r.cards.length, 6);
  assert.ok(r.cards.every((c) => c.price != null));
});

test('extractEmbeddedProducts on a page: the carousel rows come out of the inline state, not the destination tiles', () => {
  const state = { sections: [{ items: Array.from({ length: 12 }, (_, i) => tile(i)) }, { items: Array.from({ length: 8 }, (_, i) => homeCard(i)) }, { items: Array.from({ length: 8 }, (_, i) => homeCard(8 + i)) }] };
  const html = `<html><body><script>window.__STATE__ = ${JSON.stringify(state)};</script><div id="root"></div></body></html>`;
  const r = extractEmbeddedProducts(html, BASE);
  assert.equal(r.cards.length, 16);
  assert.equal(r.cards[15].sku, '1015');
});

test('moneyQualifier / decodeRelayId / listingExtras: the small shape helpers', () => {
  assert.equal(moneyQualifier('116 € au total'), 'au total');
  assert.equal(moneyQualifier('45 € par nuit'), 'par nuit');
  assert.equal(moneyQualifier('€45/night'), '/night');
  assert.equal(moneyQualifier('19,99 €'), null, 'nothing after the amount');
  assert.equal(moneyQualifier('19,99 € TTC'), null, 'a tax word is not a price basis');
  assert.equal(moneyQualifier('10 € au lieu de 20 €'), null, 'a second amount follows: not a basis');
  assert.equal(decodeRelayId(b64('DemandListing:46461531')), '46461531');
  assert.equal(decodeRelayId('ABC-123'), 'ABC-123', 'a plain id stays as is');
  const ex = listingExtras({ title: 'x', avgRating: '4,75', structuredDisplayPrice: { primaryLine: { price: '116 €', qualifier: 'au total' } }, structuredContent: { primaryLine: [{ body: '6–8 nov.' }] } });
  assert.equal(ex.rating, 4.75); assert.equal(ex.reviewCount, null);
  assert.equal(ex.priceNote, 'au total'); assert.equal(ex.priceText, '116 € au total');
  assert.equal(ex.description, '6–8 nov.');
});
