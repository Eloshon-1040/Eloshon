import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPath, fillTemplate, fillFromItem, headerValue, redactValues, mapItem } from '../extract/field-map.mjs';

test('getPath reads nested dot paths', () => {
  assert.equal(getPath({ price: { basicPrice: 3.5 } }, 'price.basicPrice'), 3.5);
  assert.equal(getPath({ a: null }, 'a.b'), undefined);
  assert.equal(getPath({}, ''), undefined);
});

test('fillTemplate fills known vars url-encoded, leaves unknown tokens', () => {
  assert.equal(fillTemplate('/api?size={size}&q={q}', { size: 22, q: 'a b' }), '/api?size=22&q=a%20b');
  assert.equal(fillTemplate('/x/{missing}', {}), '/x/{missing}');
});

test('fillFromItem drops the whole value on an unresolved token', () => {
  assert.equal(fillFromItem('https://x/{id}', { id: 'A9' }), 'https://x/A9');
  assert.equal(fillFromItem('https://x/{id}', {}), null);
  assert.equal(fillFromItem('https://x/{obj}', { obj: {} }), null);
});

test('headerValue is case-insensitive', () => {
  assert.equal(headerValue({ 'x-cg-apikey': 'K' }, 'X-CG-APIKey'), 'K');
  assert.equal(headerValue({}, 'X'), undefined);
});

test('redactValues masks secrets >= 4 chars, ignores short/blank', () => {
  assert.equal(redactValues('key=SECRETVAL end', ['SECRETVAL']), 'key=*** end');
  assert.equal(redactValues('ab', ['ab']), 'ab'); // too short to redact
});

test('mapItem maps dot-paths + template url, bridges url->sourceUrl and image->images', () => {
  const p = mapItem(
    { LongName: 'Lait', price: { basicPrice: 1.29 }, commercialArticleNumber: 'C1', fullImage: 'https://img/1.jpg' },
    { name: 'LongName', price: 'price.basicPrice', sku: 'commercialArticleNumber', image: 'fullImage', url: { template: 'https://x/{commercialArticleNumber}' } },
  );
  assert.equal(p.name, 'Lait');
  assert.equal(p.price, 1.29);
  assert.equal(p.sku, 'C1');
  assert.equal(p.url, 'https://x/C1');
  assert.equal(p.sourceUrl, 'https://x/C1');
  assert.equal(p.canonicalUrl, 'https://x/C1');
  assert.deepEqual(p.images, ['https://img/1.jpg']);
  assert.equal(p.image, undefined);
});

test('mapItem leaves a relative url untouched (no base to resolve here)', () => {
  const p = mapItem({ u: '/p/1' }, { url: 'u' });
  assert.equal(p.url, '/p/1');
  assert.equal(p.sourceUrl, undefined);
});

test('mapItem coerces a formatted TEXT price to a number (DOM recipe: "72,90 €", "1.299,00")', () => {
  // A dom recipe maps the visible price text; eligibility needs a real number
  // (Number("72,90 €") is NaN). The mapper parses it and recovers the currency.
  const a = mapItem({ n: 'Extracteur', pr: '72,90 €' }, { name: 'n', price: 'pr' }, { strategy: 'dom' });
  assert.equal(a.price, 72.9);
  assert.equal(a.currency, 'EUR');
  const b = mapItem({ n: 'X', pr: '1.299,00' }, { name: 'n', price: 'pr' }, { strategy: 'dom' });
  assert.equal(b.price, 1299);
  // an already-numeric price passes through untouched
  const c = mapItem({ n: 'Y', pr: 49.9 }, { name: 'n', price: 'pr' });
  assert.equal(c.price, 49.9);
});
