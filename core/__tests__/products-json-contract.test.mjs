/**
 * Phase 0 — products.json contract lock.
 *
 * products.json is the RICH Scraper → Converter handoff (the CSV stays the
 * lossy human/Luna surface). This suite freezes the contract documented in
 * converter/docs/phase0-products-json-contract.md:
 *   1. a scrape producing N images yields N images, absolutized, with
 *      image_url staying the legacy first-image cell (CSV byte-compatible);
 *   2. every documented first-class field and every documented raw{} field is
 *      present — by EXACT key-set equality, so adding/removing/renaming a
 *      field fails here before it silently changes the contract;
 *   3. both generations validate: 21-col (color + variants) and 19-col
 *      (color/variants null);
 *   4. the CSV surface: the 21 historical columns unchanged, plus one trailing
 *      weight_estimated marker; one image URL in the image_url cell;
 *   5. the committed example fixture re-validates, so the doc's example and
 *      the code cannot drift apart.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { toNormalizedProduct } from '../normalize.mjs';
import { toImportCsv, COLUMNS } from '../csv.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

/** The closed first-class surface of a NormalizedProduct (types.mjs). */
const FIRST_CLASS_KEYS = [
  'store_slug', 'source_url', 'source_product_id', 'source_category', 'product_type',
  'name', 'description',
  'storage_info', 'is_alcoholic', 'price', 'weight_kg', 'barcode', 'hs_code',
  'images', 'image_url', 'category_slug', 'color', 'variants', 'raw',
].sort();

/** The closed raw{} surface (rich fields with no CSV column). */
const RAW_KEYS = [
  'brand', 'currency', 'list_price', 'availability', 'rating', 'review_count',
  'weight_text', 'weight_estimated', 'volume_l', 'pack_count', 'breadcrumb',
  'sku', 'reference', 'mpn', 'gtin', 'extractor', 'confidence', 'columns', 'specs', 'technical_specs',
].sort();

/** raw{} keys that are undefined (hence JSON-dropped) on lanes that do not set
 *  strategy/confidence: recipe replay via mapItem, extension ingest, card
 *  seeds. The ON-DISK raw set is RAW_KEYS minus these on such lanes. */
// raw.reference: only when the page gives an article code that is not a SKU (shared/extract/sku.mjs).
const RAW_OPTIONAL_ON_DISK = ['extractor', 'confidence', 'columns', 'specs', 'technical_specs', 'reference'];

const assertContractShape = (np, label) => {
  assert.deepEqual(Object.keys(np).sort(), FIRST_CLASS_KEYS,
    `${label}: first-class key set drifted from the documented contract`);
  assert.deepEqual(Object.keys(np.raw).sort(), RAW_KEYS,
    `${label}: raw{} key set drifted from the documented contract`);
};

/** 21-col generation: color + variants + several images, mixed relative/absolute. */
const rich21 = () => toNormalizedProduct({
  name: 'Filtre à particules 315 mm',
  description: '<p>Filtre <b>efficace</b></p>',
  price: 72.9,
  listPrice: 99.9,
  currency: 'EUR',
  availability: 'InStock',
  gtin: '4006381333931',
  sku: 'SKU-315',
  mpn: 'MPN-315',
  brand: 'Winflex',
  images: ['/img/a.jpg', 'https://cdn.example/b.jpg', 'img/c.png'],
  category: null,
  breadcrumb: ['Maison', 'Ventilation'],
  weightText: '500 g',
  sourceUrl: 'https://shop.example/p/filtre-315',
  canonicalUrl: null,
  strategy: 'generic-jsonld',
  confidence: 0.9,
  color: 'Bleu',
  variants: [{ code: 'V1', type: 'couleur', name: 'Bleu' }],
}, { storeSlug: 'demo', lang: 'fr' });

/** 19-col generation: no color, no variants, a single image. */
const plain19 = () => toNormalizedProduct({
  name: 'Pepersalami Halal',
  description: 'Marhaba Pepersalami Halal',
  price: 3.49,
  images: ['https://static.example/std/salami.jpg'],
  breadcrumb: [],
  sourceUrl: 'https://www.colruyt.example/nl/producten/19164',
  strategy: 'internal_api',
  confidence: 0.8,
}, { storeSlug: 'COL', lang: 'fr' });

test('contract: N images in → N images out, absolutized, image_url = first', () => {
  const np = rich21();
  assert.equal(np.images.length, 3, '3 scraped images must yield 3 retained images');
  assert.deepEqual(np.images, [
    'https://shop.example/img/a.jpg',
    'https://cdn.example/b.jpg',
    'https://shop.example/p/img/c.png',
  ]);
  for (const u of np.images) assert.match(u, /^https?:\/\//, 'every retained image is absolute');
  assert.equal(np.image_url, np.images[0], 'image_url stays the first image (CSV cell unchanged)');
});

test('contract: no images → empty list, null image_url', () => {
  const np = toNormalizedProduct({ name: 'Sans image', price: 1, sourceUrl: 'https://x.example/p/1' });
  assert.deepEqual(np.images, []);
  assert.equal(np.image_url, null);
});

test('contract: every documented rich field is present and where the doc says (21-col gen)', () => {
  const np = rich21();
  assertContractShape(np, '21-col');
  // first-class values
  assert.equal(np.color, 'Bleu');
  assert.deepEqual(np.variants, [{ code: 'V1', type: 'couleur', name: 'Bleu' }]);
  assert.equal(np.barcode, '4006381333931');
  assert.equal(np.weight_kg, 0.5);
  assert.equal(np.source_url, 'https://shop.example/p/filtre-315');
  // raw{} values (no CSV column — JSON-only payload for Phase 2)
  assert.equal(np.raw.brand, 'Winflex');
  assert.equal(np.raw.currency, 'EUR');
  assert.equal(np.raw.list_price, 99.9);
  assert.equal(np.raw.availability, 'InStock');
  assert.equal(np.raw.sku, 'SKU-315');
  assert.equal(np.raw.mpn, 'MPN-315');
  assert.equal(np.raw.gtin, '4006381333931');
  assert.deepEqual(np.raw.breadcrumb, ['Maison', 'Ventilation']);
  assert.equal(np.raw.extractor, 'generic-jsonld');
  assert.equal(np.raw.confidence, 0.9);
});

test('contract: the 19-col generation carries the SAME shape (color/variants null)', () => {
  const np = plain19();
  assertContractShape(np, '19-col');
  assert.equal(np.color, null);
  assert.equal(np.variants, null);
  assert.deepEqual(np.images, ['https://static.example/std/salami.jpg']);
  assert.equal(np.image_url, np.images[0]);
});

test('contract: the CSV surface is the 18 historical columns (no second language), in order, plus trailing columns; one image in the cell', () => {
  assert.equal(COLUMNS.length, 25, 'the CSV is the 18 historical columns (a single language: the one of the pasted URL) + weight_estimated + the 6 columns of 2026-10-24');
  assert.deepEqual(COLUMNS.slice(0, 18), [
    'slug', 'name', 'description',
    'price', 'category_slug', 'barcode', 'hs_code', 'weight_kg', 'image_url',
    'store_slug', 'source_url', 'source_product_id', 'source_category',
    'product_type', 'storage_info', 'is_alcoholic', 'color', 'variants',
  ], 'the 18 historical columns keep their names and order (the importer reads them by name)');
  assert.equal(COLUMNS[18], 'weight_estimated', 'the trailing estimate marker (2026-10-20)');
  assert.deepEqual(COLUMNS.slice(19), ['brand', 'availability', 'rating', 'review_count', 'net_content', 'technical_specs'], 'the product-page data of the results panel (2026-10-24), all trailing');
  assert.ok(!COLUMNS.includes('images'), 'the full image list is JSON-only, never a CSV column');
  const np = rich21();
  const csv = toImportCsv([np]);
  const [header, row] = csv.replace(/^﻿/, '').split('\r\n');
  assert.equal(header, COLUMNS.join(','));
  assert.ok(row.includes('https://shop.example/img/a.jpg'), 'first image is the CSV cell');
  assert.ok(!csv.includes('cdn.example/b.jpg'), 'extra images never leak into the CSV');
});

test('contract: a strategy-less lane (recipe/extension) serializes without extractor/confidence', () => {
  // mapItem-shaped raw: internal_api recipe replay and extension ingest never
  // set strategy/confidence. The keys exist in memory (undefined) and DROP
  // from JSON — the on-disk contract for those lanes.
  const np = toNormalizedProduct({
    name: 'Lidl recipe item', price: 2.19,
    images: ['https://img.example/x.jpg'], sourceUrl: 'https://www.lidl.example/p/42',
  }, { storeSlug: 'lidl' });
  assert.deepEqual(Object.keys(np.raw).sort(), RAW_KEYS, 'in-memory raw keeps the full key set');
  const disk = JSON.parse(JSON.stringify(np));
  assert.deepEqual(Object.keys(disk.raw).sort(),
    RAW_KEYS.filter((k) => !RAW_OPTIONAL_ON_DISK.includes(k)),
    'on-disk raw = full set minus the undefined-dropped extractor/confidence');
});

test('contract: the committed example fixture matches the same key sets', () => {
  const fixture = JSON.parse(readFileSync(
    path.join(HERE, 'fixtures', 'products-json-contract.example.json'), 'utf8'));
  assert.ok(Array.isArray(fixture) && fixture.length >= 2, 'example holds both generations');
  // Serialized NORMALIZE-level form: JSON.stringify drops `is_alcoholic`
  // while it is undefined. (Real job files additionally carry __eligibility,
  // attached by the engine/controller after normalization — the example is
  // the normalize-level contract, which is what the Converter will parse.)
  const serializedKeys = FIRST_CLASS_KEYS.filter((k) => k !== 'is_alcoholic');
  for (const np of fixture) {
    assert.deepEqual(Object.keys(np).sort(), serializedKeys,
      'example fixture: serialized first-class key set drifted');
    // raw.columns exists only on rows accepted from the extension panel; raw.specs only
    // when the product page states technical specifications.
    assert.deepEqual(Object.keys(np.raw).sort(), RAW_KEYS.filter((k) => k !== 'columns' && k !== 'specs' && k !== 'technical_specs' && k !== 'reference'),
      'example fixture: raw{} key set drifted (both examples set strategy+confidence)');
  }
});
