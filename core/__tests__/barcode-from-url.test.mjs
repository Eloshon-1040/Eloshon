/**
 * Item 5 — recover an EAN embedded in the product URL slug when normal extraction
 * found no barcode (real case: microfluo.net
 * /vents-vk-125-355mh-4823016208033.html). A barcode is NEVER invented: the
 * recovered digit run is used ONLY when it passes the GS1 check digit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidGtin } from '../jsonld.mjs';
import { toNormalizedProduct } from '../normalize.mjs';

test('isValidGtin: GS1 check digit across lengths', () => {
  assert.equal(isValidGtin('4823016208033'), true);   // microfluo EAN-13
  assert.equal(isValidGtin('4823016208034'), false);  // wrong check digit
  assert.equal(isValidGtin('96385074'), true);         // valid EAN-8
  assert.equal(isValidGtin('123456789012'), true);     // valid 12-digit UPC-A (check digit 2)
  assert.equal(isValidGtin('123456789013'), false);    // same data, wrong check digit
  assert.equal(isValidGtin('355'), false);             // too short
  assert.equal(isValidGtin('12345678901'), false);     // 11 digits — not a GTIN length
  assert.equal(isValidGtin(''), false);
});

const bc = (url, extra = {}) => toNormalizedProduct({ name: 'Ventilateur VK 125', price: 89, sourceUrl: url, canonicalUrl: url, ...extra }).barcode;

test('barcode recovered from a slug-embedded EAN-13 when no GTIN was extracted', () => {
  assert.equal(bc('https://www.microfluo.net/vents-vk-125-355mh-4823016208033.html'), '4823016208033');
});

test('a trailing number that is NOT a valid EAN is ignored (never invented)', () => {
  assert.equal(bc('https://shop.example.com/lampe-led-4823016208034.html'), null); // 13 digits, bad checksum
  assert.equal(bc('https://shop.example.com/produit/widget-98765.html'), null);    // short id, not a GTIN length
  assert.equal(bc('https://shop.example.com/categorie/2024-selection'), null);     // year, not an EAN
});

test('an extracted GTIN still wins over the URL, and its own value is used', () => {
  // raw.gtin present → used directly; URL fallback not consulted.
  assert.equal(bc('https://www.microfluo.net/vents-vk-125-355mh-4823016208033.html', { gtin: '5410228142720' }), '5410228142720');
});
