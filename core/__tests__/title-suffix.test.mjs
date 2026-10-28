/**
 * stripSiteSuffix / titleOf: the last-resort <title> name must not carry the site
 * name. Measured on books.toscrape ("<Book> | Books to Scrape - Sandbox"). Strong
 * separators only — a real name with " - " must survive.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripSiteSuffix, titleOf } from '../html-meta.mjs';

test('strips a site suffix after a strong separator', () => {
  assert.equal(stripSiteSuffix('The Coming Woman | Books to Scrape - Sandbox'), 'The Coming Woman');
  assert.equal(stripSiteSuffix('Chaise design – Meuble.be'), 'Chaise design');
  assert.equal(stripSiteSuffix('Widget :: MyStore'), 'Widget');
  assert.equal(stripSiteSuffix('Produit › Boutique'), 'Produit');
});

test('keeps a real name that contains a plain hyphen', () => {
  assert.equal(stripSiteSuffix('Colnago V4 - état neuf - juin 2025'), 'Colnago V4 - état neuf - juin 2025');
  assert.equal(stripSiteSuffix('Vélo de ville'), 'Vélo de ville');
});

test('only the last strong-separator segment is removed', () => {
  assert.equal(stripSiteSuffix('Sofa | Salon | ShopName'), 'Sofa | Salon');
});

test('titleOf applies the strip', () => {
  assert.equal(titleOf('<html><head><title>Book Name | Books to Scrape - Sandbox</title></head></html>'), 'Book Name');
});
