// Phase 6.3 — P1 translations / P2 metafield namespace+type / P3 identifiers:
// the canon additions are additive (every serialiser accepts them), consumed
// where a target has a column (Shopify metafield namespaces, BigCommerce GTIN /
// MPN, the single barcode column everywhere through the derivation rule) and
// reported UNIFORMLY where it has none (loss_<target>_translations /
// loss_<target>_identifiers). Round trips are strict on the carried fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as engine from '../core/dist/index.mjs';
import { parseShopifyProducts, serializeShopifyProducts, serializeWooModern, parseWooModern } from '../core/dist/products.mjs';
import { serializeWixProducts } from '../core/dist/wix.mjs';
import { serializeBigCommerceProducts, parseBigCommerceProducts } from '../core/dist/bigcommerce.mjs';
import { parseWithKnowledge, applyCanonDerivations } from '../core/knowledge-proposal/generic-parser.mjs';
import { loadCanonCatalogSync } from '../core/knowledge-proposal/reference.mjs';

const { convert, convertFromCanon, parseCsv, serializeCsv, parseShopifyAdminJson } = engine;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, 'test', 'fixtures', rel), 'utf8');
const catalog = loadCanonCatalogSync();

const variant = (over = {}) => ({
  optionValues: [], sku: 'SKU-63', price: 12.5, compareAtPrice: null, cost: null, barcode: '', grams: 250,
  lengthCm: null, widthCm: null, heightCm: null, requiresShipping: true, taxable: true, inventoryQty: 4, imageSrc: '', ...over,
});
const product = (over = {}) => ({
  handle: 'p-63', title: 'Produit 6.3', bodyHtml: '<p>fr</p>', vendor: 'Acme', productType: '', tags: [], status: 'active',
  categories: [], published: true, options: [], variants: [variant()], images: [], metafields: [], seoTitle: '', seoDescription: '', ...over,
});
const rich = () => product({
  translations: { en: { title: 'Product 6.3', bodyHtml: '<p>en</p>', seoTitle: 'Product 6.3 | Acme', slug: 'product-6-3' }, 'nl-BE': { title: 'Product 6.3 (nl)' } },
  metafields: [
    { key: 'matiere', value: 'coton' },                                                          // no namespace → historical `custom`
    { key: 'condition', value: 'new', namespace: 'mm-google-shopping', type: 'string' },         // app-injected, typed
    { key: 'washing', value: '30°', namespace: 'specs', type: 'single_line_text_field' },
  ],
  variants: [variant({ barcode: '4006381333931', identifiers: { gtin: '04006381333931', ean: '4006381333931', mpn: 'MPN-63', hsCode: '820510', originCountry: 'DE' } })],
});

test('canon shape: a product carrying translations, namespaced/typed metafields and identifiers serialises to every target (additive)', () => {
  const p = rich();
  for (const out of [serializeShopifyProducts([p]), serializeWooModern([p]), serializeWixProducts([p]), serializeBigCommerceProducts([p])]) {
    assert.ok(out.rows.length >= 1);
    const cells = out.rows.flatMap((r) => Object.values(r));
    assert.ok(!cells.some((v) => typeof v === 'string' && (v.includes('Product 6.3 (nl)') || v.includes('nl-BE'))), 'translations never leak into a CSV cell');
  }
});

test('P2 → Shopify target: the metafield column carries the REAL namespace; namespace-less keeps `custom` (byte-identical for pre-6.3 sources)', () => {
  const out = serializeShopifyProducts([rich()]);
  assert.ok(out.headers.includes('matiere (product.metafields.custom.matiere)'));
  assert.ok(out.headers.includes('condition (product.metafields.mm-google-shopping.condition)'));
  assert.ok(out.headers.includes('washing (product.metafields.specs.washing)'));
  assert.equal(out.rows[0]['condition (product.metafields.mm-google-shopping.condition)'], 'new');
  // two metafields with the same key in different namespaces are two columns, not one
  const twin = product({ metafields: [{ key: 'color', value: 'red', namespace: 'custom' }, { key: 'color', value: '#f00', namespace: 'app--123--swatch' }] });
  const o2 = serializeShopifyProducts([twin]);
  assert.equal(o2.rows[0]['color (product.metafields.custom.color)'], 'red');
  assert.equal(o2.rows[0]['color (product.metafields.app--123--swatch.color)'], '#f00');
});

test('P2 round trip: Shopify CSV → canon (namespace read from the header) → Shopify CSV, metafield column identical', () => {
  const src = serializeShopifyProducts([rich()]);
  const parsed = parseShopifyProducts(src.headers, src.rows);
  assert.deepEqual(parsed[0].metafields, [
    { key: 'matiere', value: 'coton', namespace: 'custom' },
    { key: 'condition', value: 'new', namespace: 'mm-google-shopping' },
    { key: 'washing', value: '30°', namespace: 'specs' },
  ], 'type is not in the CSV — namespace and value are');
  const again = serializeShopifyProducts(parsed);
  assert.deepEqual(again.headers.filter((h) => /metafields/.test(h)), src.headers.filter((h) => /metafields/.test(h)));
  // the shipped Shopify CSV fixture keeps producing the same canon (namespace `custom` added, nothing else)
  const fx = parseCsv(read('shopify_products.csv'));
  const fromFixture = parseShopifyProducts(fx.headers, fx.rows).flatMap((p) => p.metafields);
  assert.ok(fromFixture.length > 0 && fromFixture.every((m) => m.namespace === 'custom'));
});

test('P3 → BigCommerce target: GTIN / MPN columns appear only when carried, and read back into identifiers by the BC parser', () => {
  const plain = serializeBigCommerceProducts([product()]);
  assert.ok(!plain.headers.includes('Global Trade Number') && !plain.headers.includes('Manufacturer Part Number'), 'pruned when empty');
  const out = serializeBigCommerceProducts([rich()]);
  assert.equal(out.rows[0]['UPC/EAN'], '4006381333931');
  assert.equal(out.rows[0]['Global Trade Number'], '04006381333931');
  assert.equal(out.rows[0]['Manufacturer Part Number'], 'MPN-63');
  const { products: back } = parseBigCommerceProducts(out.rows);
  assert.deepEqual(back[0].variants[0].identifiers, { gtin: '04006381333931', mpn: 'MPN-63' });
  assert.equal(back[0].variants[0].barcode, '4006381333931');
  // the shipped BC fixture has neither column → no identifiers block on its canon
  const fx = parseCsv(read('bigcommerce_products.csv'));
  for (const p of parseBigCommerceProducts(fx.rows).products) for (const v of p.variants) assert.equal(v.identifiers, undefined);
});

test('P3 derivation (data: canon/fields.v1.json#derivations): barcode ← first of gtin/ean/upc/isbn, never over a native barcode, provenance names the rule', () => {
  assert.deepEqual(catalog.derivations.filter((d) => d.scope === 'product' || d.scope === 'variant').map((d) => [d.scope, d.path, d.from.join('>')]), [['variant', 'barcode', 'identifiers.gtin>identifiers.ean>identifiers.upc>identifiers.isbn']]);
  // a knowledge-driven source that splits its identifiers and has no barcode field
  const fmt = { id: 'x.products.v1', platformHint: 'x', fields: [
    { path: 'name', canon: 'title', transform: 'text', confidence: 'seed' },
    { path: 'ean', canon: 'variants[].identifiers.ean', transform: 'text', confidence: 'seed' },
    { path: 'upc', canon: 'variants[].identifiers.upc', transform: 'text', confidence: 'seed' },
    { path: 'mpn', canon: 'variants[].identifiers.mpn', transform: 'text', confidence: 'seed' },
  ], structure: { variants: { selfWhenNone: true } } };
  const rows = [{ name: 'A', ean: '4006381333931', upc: '036000291452', mpn: 'M1' }, { name: 'B', ean: '', upc: '036000291452', mpn: '' }, { name: 'C', ean: '', upc: '', mpn: 'M3' }];
  const { products } = parseWithKnowledge(fmt, rows, { companions: {}, canon: catalog });
  assert.equal(products[0].variants[0].barcode, '4006381333931', 'ean before upc');
  assert.deepEqual(products[0].variants[0].provenance.barcode, { platform: 'x', sourceField: 'ean', sourceValue: '4006381333931', transform: 'first_non_empty', method: 'structural' });
  assert.equal(products[1].variants[0].barcode, '036000291452', 'falls through to upc');
  assert.equal(products[2].variants[0].barcode, '', 'mpn is not a barcode');
  assert.deepEqual(products[2].variants[0].identifiers, { mpn: 'M3' });
  // without the catalogue: no derivation (pure parser)
  assert.equal(parseWithKnowledge(fmt, rows, { companions: {} }).products[0].variants[0].barcode, '');
  // idempotent and never overwriting
  const p = product({ variants: [variant({ barcode: 'NATIVE', identifiers: { gtin: 'G' } })] });
  applyCanonDerivations([p], catalog); applyCanonDerivations([p], catalog);
  assert.equal(p.variants[0].barcode, 'NATIVE');
  assert.equal(p.variants[0].provenance, undefined, 'nothing derived, nothing traced');
});

test('P3 derivation reaches the legacy CSV paths through the engine: a BigCommerce file with a GTIN but no UPC/EAN still yields a barcode on every target', () => {
  const fx = parseCsv(read('bigcommerce_products.csv'));
  const withGtin = fx.rows.map((r) => ({ ...r, 'Global Trade Number': r.Item === 'Product' ? '04006381333931' : '', 'UPC/EAN': '' }));
  const csv = serializeCsv([...fx.headers, 'Global Trade Number'], withGtin);
  const res = convert(csv, { direction: 'bigcommerce-to-shopify', expectPlatform: 'bigcommerce' });
  assert.equal(res.ok, true);
  assert.ok(res.rows.some((r) => r['Variant Barcodes'] === '04006381333931'), 'derived barcode lands in the Shopify column');
  assert.ok(!res.losses.some((l) => l.code === 'loss_shopify_identifiers'), 'a gtin that BECAME the barcode is not a loss');
});

test('losses are uniform per target: translations (locales) and identifiers the target cannot hold; nothing reported without them', () => {
  const none = (dir) => convertFromCanon([product()], { direction: dir, expectPlatform: 'shopware' }, 'x').losses.filter((l) => /_translations|_identifiers/.test(l.code));
  for (const dir of ['shopware-to-shopify', 'shopware-to-woocommerce', 'shopware-to-wix', 'shopware-to-bigcommerce']) assert.deepEqual(none(dir), [], dir);
  const some = (dir) => convertFromCanon([rich()], { direction: dir, expectPlatform: 'shopware' }, 'x').losses.filter((l) => /_translations|_identifiers/.test(l.code));
  assert.deepEqual(some('shopware-to-shopify'), [{ code: 'loss_shopify_translations', params: { locales: 'en, nl-BE' } }, { code: 'loss_shopify_identifiers', params: { kinds: 'mpn, hsCode, originCountry' } }]);
  assert.deepEqual(some('shopware-to-woocommerce'), [{ code: 'loss_woo_translations', params: { locales: 'en, nl-BE' } }, { code: 'loss_woo_identifiers', params: { kinds: 'mpn, hsCode, originCountry' } }]);
  assert.deepEqual(some('shopware-to-wix'), [{ code: 'loss_wix_translations', params: { locales: 'en, nl-BE' } }, { code: 'loss_wix_identifiers', params: { kinds: 'mpn, hsCode, originCountry' } }]);
  assert.deepEqual(some('shopware-to-bigcommerce'), [{ code: 'loss_bc_translations', params: { locales: 'en, nl-BE' } }, { code: 'loss_bc_identifiers', params: { kinds: 'hsCode, originCountry' } }]);
});

test('WooCommerce round trip: the derived barcode travels through the GTIN column; identifiers beyond it are declared lost, not silently dropped', () => {
  const p = product({ variants: [variant({ identifiers: { ean: '4006381333931', mpn: 'MPN-63' } })] });
  const res = convertFromCanon([p], { direction: 'shopware-to-woocommerce', expectPlatform: 'shopware' }, 'x');
  assert.equal(res.rows[0]['GTIN, UPC, EAN, or ISBN'], '4006381333931');
  assert.deepEqual(res.losses.find((l) => l.code === 'loss_woo_identifiers'), { code: 'loss_woo_identifiers', params: { kinds: 'mpn' } });
  const back = parseWooModern(res.headers, res.rows);
  assert.equal(back[0].variants[0].barcode, '4006381333931');
});

test('Shopify GraphQL (real) → Shopify CSV: app-injected namespaces land in their own metafield columns; → WooCommerce: `Meta:` columns keyed by key', () => {
  const { products } = parseShopifyAdminJson({ products: JSON.parse(read('live/shopify-test/products.json')) });
  const sh = serializeShopifyProducts(products);
  assert.ok(sh.headers.includes('condition (product.metafields.mm-google-shopping.condition)'));
  assert.ok(!sh.headers.some((h) => /global\./.test(h)), 'the SEO pair went to SEO Title / SEO Description, not to metafield columns');
  assert.equal(sh.rows[0]['SEO Title'], 'Ciseaux/sécateur droit en acier inoxydable AC Infinity');
  const woo = convertFromCanon(products, { direction: 'shopify-to-woocommerce', expectPlatform: 'shopify' }, 'shopify.products.admin-graphql.v1');
  assert.ok(woo.headers.includes('Meta: condition'));
  assert.equal(woo.rows[0]['GTIN, UPC, EAN, or ISBN'], '819137021495');
  assert.deepEqual(woo.losses.filter((l) => /_translations|_identifiers/.test(l.code)), []);
});
