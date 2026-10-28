/**
 * The Wix output follows the CURRENT Wix import template (Catalog V3, 97 columns,
 * `handle` + upper-case `fieldType`), taken from the Wix import page. The older
 * `handleId` template is still READ (parseWixProducts) but no longer written.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../core/dist/index.mjs';
import { serializeWixProducts } from '../core/dist/wix.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const official = parseCsv(fs.readFileSync(path.join(ROOT, 'test/fixtures/templates/wix/Wix_Store_Products_Template.csv'), 'utf8'));

const variant = (o) => ({
  optionValues: [], sku: '', price: 20, compareAtPrice: null, cost: null, barcode: '', grams: null,
  lengthCm: null, widthCm: null, heightCm: null, requiresShipping: true, taxable: true, inventoryQty: null, imageSrc: '', ...o,
});
const product = (o) => ({
  handle: 'sac', title: 'Sac', bodyHtml: '<p>Sac</p>', vendor: 'Marque', productType: '', tags: [], status: 'active',
  categories: [], published: true, options: [], variants: [variant({})], images: [], metafields: [], seoTitle: '', seoDescription: '', ...o,
});

test('output headers are exactly the official V3 template columns, in order', () => {
  const { headers } = serializeWixProducts([product({})]);
  assert.equal(headers.length, 97);
  assert.deepEqual(headers, official.headers);
});

test('variable product: PRODUCT row without price, one VARIANT row each, then MEDIA rows', () => {
  const p = product({
    options: [{ name: 'Couleur', values: ['Noir', 'Rouge'] }, { name: 'Taille', values: ['S', 'M'] }],
    categories: ['Sacs > Cuir', 'Nouveautés'],
    metafields: [{ key: 'wix_ribbon', value: 'Promo' }],
    variants: [
      variant({ sku: 'N-S', optionValues: ['Noir', 'S'], price: 59, compareAtPrice: 79, cost: 30, barcode: '5412345678900', grams: 800, inventoryQty: 12, lengthCm: 30, widthCm: 20, heightCm: 10 }),
      variant({ sku: 'R-M', optionValues: ['Rouge', 'M'], price: 59, inventoryQty: null }),
    ],
    images: [{ src: 'https://cdn.example.com/a.jpg', position: 1, alt: 'Vue A' }, { src: 'https://cdn.example.com/b.jpg', position: 2, alt: '' }],
  });
  const { rows } = serializeWixProducts([p]);
  assert.deepEqual(rows.map((r) => r.fieldType), ['PRODUCT', 'VARIANT', 'VARIANT', 'MEDIA', 'MEDIA']);
  assert.ok(rows.every((r) => r.handle === 'sac'));

  const [prod, v1, v2, m1, m2] = rows;
  assert.equal(prod.price, '', 'price lives on the variants');
  assert.equal(prod.categorySlugs, 'cuir;nouveautes');
  assert.equal(prod.primaryCategorySlug, 'cuir');
  assert.equal(prod.ribbon, 'Promo');
  assert.equal(prod.productOptionName1, 'Couleur');
  assert.equal(prod.productOptionType1, 'TEXT_CHOICES');
  assert.equal(prod.productOptionChoices1, 'Noir;Rouge');
  assert.equal(prod.productOptionChoices2, 'S;M');

  assert.equal(v1.price, '59.00');
  assert.equal(v1.strikethroughPrice, '79.00', 'compare-at price is the crossed-out price, no discount arithmetic');
  assert.equal(v1.cost, '30.00');
  assert.equal(v1.barcode, '5412345678900');
  assert.equal(v1.weight, '0.8');
  assert.deepEqual([v1.packageLength, v1.packageWidth, v1.packageHeight, v1.packageUnit], ['30', '20', '10', 'cm']);
  assert.equal(v1.inventory, '12');
  assert.equal(v1.productOptionChoices1, 'Noir', 'a variant row carries its single value');
  assert.equal(v1.productOptionChoices2, 'S');
  assert.equal(v2.inventory, 'IN_STOCK', 'untracked stock');
  assert.equal(v2.strikethroughPrice, '');

  assert.equal(m1.media, 'https://cdn.example.com/a.jpg');
  assert.equal(m1.mediaAltText, 'Vue A');
  assert.equal(m2.media, 'https://cdn.example.com/b.jpg');
});

test('simple product: price, stock and SKU sit on the PRODUCT row, no options written', () => {
  const p = product({ options: [{ name: 'Title', values: ['Default'] }], variants: [variant({ sku: 'S1', price: 10, inventoryQty: 3 })] });
  const { rows } = serializeWixProducts([p]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fieldType, 'PRODUCT');
  assert.equal(rows[0].price, '10.00');
  assert.equal(rows[0].sku, 'S1');
  assert.equal(rows[0].inventory, '3');
  assert.equal(rows[0].productOptionName1, '');
});

test('a ";" inside an option value cannot break the choice list', () => {
  const p = product({
    options: [{ name: 'Format', values: ['A;B', 'C'] }],
    variants: [variant({ optionValues: ['A;B'] }), variant({ optionValues: ['C'] })],
  });
  const { rows } = serializeWixProducts([p]);
  assert.equal(rows[0].productOptionChoices1, 'A,B;C');
  assert.equal(rows[1].productOptionChoices1, 'A,B');
});

// ── Reading the V3 template (a Wix export is V3 now) ─────────────────────────
import { convert, serializeCsv } from '../core/dist/index.mjs';
import { parseWixProducts } from '../core/dist/wix.mjs';

const officialText = fs.readFileSync(path.join(ROOT, 'test/fixtures/templates/wix/Wix_Store_Products_Template.csv'), 'utf8');

test('the official V3 template is read: variants with their options, images from MEDIA rows, ribbon, modifiers', () => {
  const products = parseWixProducts(official.rows);
  assert.deepEqual(products.map((p) => p.handle), ['Product_1', 'Product_2', 'Product_3']);
  const [tote, earrings, cap] = products;
  assert.equal(tote.variants.length, 6);
  assert.deepEqual(tote.options.map((o) => o.name), ['Color', 'Size']);
  assert.deepEqual(tote.options[0].values, ['purple', 'white'], 'the swatch hex is not part of the label');
  assert.deepEqual(tote.variants[0].optionValues, ['white', 'Small']);
  assert.equal(tote.variants[0].price, 20);
  assert.equal(tote.variants[0].compareAtPrice, 25);
  assert.equal(tote.variants[0].inventoryQty, null, 'IN_STOCK carries no count');
  assert.equal(tote.variants[1].inventoryQty, 12);
  assert.equal(tote.images.length, 3);
  assert.equal(tote.images[0].alt, 'Purple tote bag');
  assert.deepEqual(tote.categories, ['bags', 'best-seller']);
  assert.ok(tote.metafields.some((m) => m.key === 'wix_ribbon' && m.value === 'Best Seller'));
  assert.ok(tote.metafields.some((m) => m.key === 'swatch_color'));
  assert.equal(earrings.variants.length, 1);
  assert.equal(earrings.variants[0].price, 269);
  assert.ok(earrings.metafields.some((m) => m.key === 'wix_custom_text'), 'the gift-card modifier is kept');
  assert.equal(cap.variants[0].compareAtPrice, 129);
  assert.equal(cap.variants[0].price, 68);
});

test('a V3 file converts through the engine: detected as Wix, 3 products → Shopify', () => {
  const r = convert(officialText, { direction: 'wix-to-shopify', expectPlatform: 'wix' });
  assert.equal(r.ok, true);
  assert.equal(r.sourceFormat, 'wix_products');
  assert.equal(r.counts.inputUnits, 3);
  assert.equal(r.counts.failedUnits, 0);
  assert.equal(r.rows.filter((x) => x['Variant SKU']).length, 8, '6 + 1 + 1 variants');
});

test('round trip Shopify → Wix V3 → engine: nothing is lost on the way', () => {
  const shopify = fs.readFileSync(path.join(ROOT, 'test/fixtures/shopify_products.csv'), 'utf8');
  const toWix = convert(shopify, { direction: 'shopify-to-wix', expectPlatform: 'shopify' });
  assert.equal(toWix.ok, true);
  const back = convert(serializeCsv(toWix.headers, toWix.rows), { direction: 'wix-to-shopify', expectPlatform: 'wix' });
  assert.equal(back.ok, true);
  assert.equal(back.counts.outputUnits, toWix.counts.outputUnits);
  const wixSkus = toWix.rows.filter((x) => x.sku).map((x) => x.sku).sort();
  const backSkus = back.rows.map((x) => x['Variant SKU']).filter(Boolean).sort();
  assert.deepEqual(backSkus, wixSkus);
});
