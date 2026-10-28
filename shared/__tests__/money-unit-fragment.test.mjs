/**
 * Money: a designated price with THREE decimals, a per-unit price kept apart from the
 * selling price, and euros + cents fragments joined into a decimal. Generic, no site
 * rule. These back the extension/software fix for Colruyt-style prices ("10" + "99"
 * + "/pce", "0,956 €/pce", a sale price shown next to a "€/l" price).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { designatedPrice, splitUnitPrice, joinCents, parseAmount, PER_UNIT_RE } from '../extract/money.mjs';

test('joinCents: euros + a cents fragment → a decimal (2 or 3 digits)', () => {
  assert.equal(joinCents('10', '99'), 10.99);
  assert.equal(joinCents('0', '956'), 0.956);          // three decimals (per-unit price)
  assert.equal(joinCents('29', '20'), 29.2);
  assert.equal(joinCents('1 299', '00'), 1299);   // thousands in the euros part
  assert.equal(joinCents('5', ''), 5);                 // no cents → the euros alone
  assert.equal(joinCents('x', '99'), null);            // no euros → null
});

test('designatedPrice reads up to three decimals and ignores the per-unit price', () => {
  assert.deepEqual(designatedPrice('10,99 €'), { price: 10.99, currency: 'EUR' });
  assert.deepEqual(designatedPrice('0,956 €/pce'), { price: 0.956, currency: 'EUR' });
  assert.deepEqual(designatedPrice('649,99'), { price: 649.99, currency: null });
  assert.deepEqual(designatedPrice('399,-'), { price: 399, currency: null });
  assert.deepEqual(designatedPrice('29€20'), { price: 29.2, currency: 'EUR' });
  // The selling price is the first amount NOT glued to a unit; a later "€/l" is kept out.
  assert.deepEqual(designatedPrice('0,75 € 1,50 €/l'), { price: 0.75, currency: 'EUR' });
});

test('splitUnitPrice separates the selling price from a per-unit price', () => {
  assert.deepEqual(splitUnitPrice('0,75 € 1,50 €/l'), { main: '0,75 €', unit: '1,50 €/l' });
  assert.equal(splitUnitPrice('10,99 €').unit, null);
  // A price glued to its own unit ("/pce") has no SECOND price: the whole text is the sale.
  assert.equal(splitUnitPrice('10,99 €/pce').unit, null);
});

test('per-unit markers are multilingual and only match a real unit', () => {
  for (const s of ['/pce', '/kg', '€/l', 'par litre', 'per stuk', 'au kilo', 'pro Stück']) assert.ok(PER_UNIT_RE.test(s), s);
  assert.ok(!PER_UNIT_RE.test('Perceuse'));             // "per" inside a word is not a unit
  assert.ok(!PER_UNIT_RE.test('Paris'));
  // parseAmount still reads a plain 3-decimal European price (regression guard).
  assert.equal(parseAmount('0,748'), 0.748);
});
