/**
 * Shared money parser — currency-broad and locale-aware, because the software's
 * users are not only euro/French. One source of truth for every extractor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMoney, parseAmount } from '../extract/money.mjs';

test('locale-aware amounts: both separators → last is the decimal; comma-only stays decimal', () => {
  assert.equal(parseAmount('1.299,00'), 1299);   // EU: dot thousands, comma decimal
  assert.equal(parseAmount('1,299.00'), 1299);   // US: comma thousands, dot decimal
  assert.equal(parseAmount('1 299,00'), 1299);   // space thousands
  assert.equal(parseAmount('19,99'), 19.99);
  assert.equal(parseAmount('19.99'), 19.99);
  assert.equal(parseAmount('0,748'), 0.748, 'European 3-decimal price (Colruyt) preserved');
  assert.equal(parseAmount('1.299'), 1299, 'dot-thousands without decimals');
});

test('currencies beyond euro/dollar are recognised (amount + ISO when unambiguous)', () => {
  assert.deepEqual(parseMoney('129,99 zł'), { price: 129.99, currency: 'PLN' });
  assert.deepEqual(parseMoney('R$ 1.299,90'), { price: 1299.9, currency: 'BRL' });
  assert.deepEqual(parseMoney('CHF 89.90'), { price: 89.9, currency: 'CHF' });
  assert.deepEqual(parseMoney('£49.99'), { price: 49.99, currency: 'GBP' });
  assert.deepEqual(parseMoney('¥1980'), { price: 1980, currency: 'JPY' });
  assert.deepEqual(parseMoney('₺349,90'), { price: 349.9, currency: 'TRY' });
  assert.deepEqual(parseMoney('199 SEK'), { price: 199, currency: 'SEK' });
  // Ambiguous symbol (kr): the amount is still read, currency left null.
  const kr = parseMoney('249 kr');
  assert.equal(kr.price, 249);
});

test('no currency and no number → null; a bare number is not money', () => {
  assert.equal(parseMoney('en stock'), null);
  assert.equal(parseMoney('42'), null, 'a bare number needs a currency to count as money');
});
