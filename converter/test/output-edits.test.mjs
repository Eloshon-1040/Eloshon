/**
 * Mapping a column to "Catégories" gave an empty Shopify "Product Category" (the writer
 * dropped categories), and the user could not touch the output file itself. Now: the
 * category is written (with the taxonomy caveat declared), the destination list says which
 * output column each choice lands in, and the OUTPUT file can be edited with the same
 * formulas as the input.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runConversion, targetColumnsOf, columnEditChoices } from '../app/controller.mjs';
import { parseCsv } from '../core/dist/index.mjs';
import { serializeShopifyProducts } from '../core/dist/products.mjs';

const WOO = ['Type,SKU,Name,Regular price,Categories,Stock', 'simple,A1,Chaise,59.90,"Maison > Salon, Promo",3', 'simple,B1,Table,129.00,Maison,1'].join('\n');

test('Shopify writes the first category into "Product Category" and declares the taxonomy caveat', () => {
  const p = { handle: 'h', title: 'T', bodyHtml: '', vendor: '', productType: '', tags: [], status: 'active', categories: ['Maison > Salon', 'Promo'], published: true, options: [], variants: [{ optionValues: [], sku: 'S', price: 1, compareAtPrice: null, cost: null, barcode: '', grams: null, lengthCm: null, widthCm: null, heightCm: null, requiresShipping: true, taxable: true, inventoryQty: null, imageSrc: '' }], images: [], metafields: [], seoTitle: '', seoDescription: '' };
  assert.equal(serializeShopifyProducts([p]).rows[0]['Product Category'], 'Maison > Salon');
  const r = runConversion({ csvText: WOO, direction: 'woocommerce-to-shopify', expectPlatform: 'woocommerce' });
  assert.equal(r.ok, true);
  const rows = parseCsv(r.outputCsv).rows;
  assert.deepEqual(rows.map((x) => x['Product Category']), ['Maison > Salon', 'Maison']);
  const loss = r.losses.find((l) => l.code === 'loss_shopify_category_taxonomy');
  assert.deepEqual(loss.params, { count: 2, extra: 1 });
});

test('the destination list tells where each field lands in the chosen target file', () => {
  const shopify = targetColumnsOf('shopify_products');
  // Categories also land in Tags (the default « catégories en tags », for automated collections).
  assert.deepEqual(shopify.categories, ['Product Category', 'Tags']);
  assert.deepEqual(shopify.productType, ['Type']);
  assert.deepEqual(shopify.tags, ['Tags']);
  assert.deepEqual(shopify.lengthCm, [], 'a field the target does not write says so (empty list)');
  // Since 2cb5e73 Shopify receives the source address as a metafield (read from the serialiser, not a hand table).
  assert.deepEqual(shopify.sourceUrl, ['source_url (product.metafields.eloshon.source_url)']);
  assert.ok(columnEditChoices().every((c) => c in shopify));
  assert.deepEqual(targetColumnsOf('woo_products_modern').categories, ['Categories']);
});

test('output edits: rename an output column, fill and replace text in what the target receives', () => {
  const r = runConversion({
    csvText: WOO, direction: 'woocommerce-to-shopify', expectPlatform: 'woocommerce',
    outEdits: [
      { id: '1', op: 'set', column: 'Type', args: { text: 'Alcool' } },
      { id: '2', op: 'replace', column: 'Title', args: { find: 'Chaise', with: 'Chaise bois' } },
      { id: '3', op: 'rename_column', column: 'Product Category', args: { to: 'Product Category (perso)' } },
      { id: '4', op: 'add_column', column: '*', args: { to: 'Note', text: 'import 1' } },
    ],
  });
  assert.equal(r.ok, true);
  const t = parseCsv(r.outputCsv);
  assert.ok(t.headers.includes('Product Category (perso)') && !t.headers.includes('Product Category'));
  assert.deepEqual(t.rows.map((x) => [x.Type, x.Title, x.Note]), [['Alcool', 'Chaise bois', 'import 1'], ['Alcool', 'Table', 'import 1']]);
  assert.deepEqual(r.outEditsReport.map((x) => x.error), [undefined, undefined, undefined, undefined]);
  // counts are about the conversion, not about the edits
  assert.equal(r.counts.outputUnits, 2);
});

test('without output edits the result is exactly the plain conversion', () => {
  const a = runConversion({ csvText: WOO, direction: 'woocommerce-to-shopify', expectPlatform: 'woocommerce' });
  const b = runConversion({ csvText: WOO, direction: 'woocommerce-to-shopify', expectPlatform: 'woocommerce', outEdits: [] });
  assert.equal(a.outputCsv, b.outputCsv);
  assert.equal(a.outEditsReport, undefined);
});

test('Shopify collections: each category level can be written as a tag (no collection column exists)', () => {
  const plain = runConversion({ csvText: WOO, direction: 'woocommerce-to-shopify', expectPlatform: 'woocommerce' });
  assert.deepEqual(parseCsv(plain.outputCsv).rows.map((x) => x.Tags), ['', ''], 'off by default in the engine');
  const r = runConversion({ csvText: WOO, direction: 'woocommerce-to-shopify', expectPlatform: 'woocommerce', categoriesAsTags: true });
  assert.deepEqual(parseCsv(r.outputCsv).rows.map((x) => x.Tags), ['Maison, Maison > Salon, Promo', 'Maison']);
  const woo = runConversion({ csvText: WOO, direction: 'woocommerce-to-woocommerce', expectPlatform: 'woocommerce', categoriesAsTags: true });
  assert.equal(woo.ok === false || !/Maison > Salon, Promo.*Maison > Salon/.test(woo.outputCsv), true, 'only Shopify is affected');
});
