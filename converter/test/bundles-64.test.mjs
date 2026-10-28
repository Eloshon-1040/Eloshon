// Phase 6.4 — bundle / pack unification (6.1 D2): ONE canon representation —
// kind: 'bundle' + CanonVariant.components[] — for Shopify's per-variant
// productVariantComponents and PrestaShop's product-level pack items, built by
// ONE generic transform (bundle_components) driven by args. No CSV target can
// create a composition: every target reports loss_<target>_bundles and exports
// the bundle product as a normal product.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as engine from '../core/dist/index.mjs';
import { serializeShopifyProducts, serializeWooModern } from '../core/dist/products.mjs';
import { serializeWixProducts } from '../core/dist/wix.mjs';
import { serializeBigCommerceProducts } from '../core/dist/bigcommerce.mjs';
import { parseWithKnowledge } from '../core/knowledge-proposal/generic-parser.mjs';
import { loadReferenceFormatsSync, loadCanonCatalogSync } from '../core/knowledge-proposal/reference.mjs';
import { TRANSFORMS } from '../core/knowledge-proposal/transforms.mjs';

const { convertFromCanon, parseShopifyAdminJson } = engine;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const live = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/live/shopify-test/products.json'), 'utf8'));
const SHOPIFY = loadReferenceFormatsSync().find((f) => f.id === 'shopify.products.admin-graphql.v1');
const canon = loadCanonCatalogSync();

// A Shopify bundle in the EXACT response shape of the fixture query: the
// Qnubu product turned into a 2-variant "duo" whose variants are composed of
// two Qnubu bag variants each (the dev store has no bundle — D2's Shopify form
// comes from the schema: ProductVariantComponent { id, productVariant, quantity }).
function shopifyBundle() {
  const src = live[1];
  const comp = (i, quantity) => ({ id: `gid://shopify/ProductVariantComponent/${i}`, quantity, productVariant: { id: src.variants.nodes[i].id, sku: src.variants.nodes[i].sku, product: { id: src.id, handle: src.handle } } });
  const p = JSON.parse(JSON.stringify(src));
  p.id = 'gid://shopify/Product/9999'; p.legacyResourceId = '9999'; p.handle = 'qnubu-duo'; p.title = 'Qnubu - Duo'; p.hasVariantsThatRequiresComponents = true;
  p.options = [{ id: 'gid://shopify/ProductOption/1', name: 'Format', position: 1, values: ['Petit', 'Grand'], optionValues: [{ id: 'gid://shopify/ProductOptionValue/1', name: 'Petit', hasVariants: true }, { id: 'gid://shopify/ProductOptionValue/2', name: 'Grand', hasVariants: true }] }];
  const v = (i, title, sku, price, comps) => ({ ...JSON.parse(JSON.stringify(src.variants.nodes[0])), id: `gid://shopify/ProductVariant/99${i}`, legacyResourceId: `99${i}`, title, sku, price, position: i + 1, requiresComponents: true, selectedOptions: [{ name: 'Format', value: title, optionValue: { id: `gid://shopify/ProductOptionValue/${i + 1}`, name: title } }], productVariantComponents: { nodes: comps } });
  p.variants = { nodes: [v(0, 'Petit', 'QNUBU-DUO-S', '16.00', [comp(0, 1), comp(1, 1)]), v(1, 'Grand', 'QNUBU-DUO-L', '24.00', [comp(7, 2), comp(8, 1)])] };
  return p;
}

test('Shopify: hasVariantsThatRequiresComponents → kind bundle; productVariantComponents → variants[].components (sku ref, product handle), nothing unknown', () => {
  const { products, report } = parseWithKnowledge(SHOPIFY, [shopifyBundle()], { companions: {}, canon });
  assert.deepEqual(report.unknownKeys, []);
  const p = products[0];
  assert.equal(p.kind, 'bundle');
  assert.equal(p.provenance.kind.sourceField, 'hasVariantsThatRequiresComponents');
  assert.deepEqual(p.variants[0].components, [
    { ref: 'Qnubu-Sacs-à-Presse-1', refKind: 'sku', quantity: 1, productRef: 'qnubu-sac-a-presse-de-11x11cm-10pcs', productRefKind: 'handle' },
    { ref: 'Qnubu-Sacs-à-Presse-2', refKind: 'sku', quantity: 1, productRef: 'qnubu-sac-a-presse-de-11x11cm-10pcs', productRefKind: 'handle' },
  ]);
  assert.deepEqual(p.variants[1].components.map((c) => [c.ref, c.quantity]), [['Qnubu-Sacs-à-Presse-8', 2], ['Qnubu-Sacs-à-Presse-9', 1]]);
  assert.equal(p.variants[0].provenance.components.transform, 'bundle_components');
  assert.equal(p.variants[0].sourceExtension.shopify.components.length, 2, 'raw rows kept');
  assert.equal(p.variants[0].sourceExtension.shopify.requiresComponents, true);
  // the real store: no bundle anywhere → kind never 'bundle', no components block
  const real = parseShopifyAdminJson({ products: live }).products;
  for (const q of real) { assert.notEqual(q.kind, 'bundle'); for (const v of q.variants) { assert.equal(v.components, undefined); assert.ok(!('components' in v.sourceExtension.shopify)); } }
});

test('a component variant without a SKU falls back to its GID (refKind sourceId); quantity defaults to 1; a bundle variant without components is kept as a plain variant', () => {
  const p = shopifyBundle();
  p.variants.nodes[0].productVariantComponents.nodes[0].productVariant.sku = '';
  p.variants.nodes[0].productVariantComponents.nodes[1].quantity = null;
  p.variants.nodes[1].productVariantComponents.nodes = [];
  const [c] = parseWithKnowledge(SHOPIFY, [p], { companions: {}, canon }).products;
  assert.deepEqual(c.variants[0].components[0], { ref: 'gid://shopify/ProductVariant/53132760613197', refKind: 'sourceId', quantity: 1, productRef: 'qnubu-sac-a-presse-de-11x11cm-10pcs', productRefKind: 'handle' });
  assert.equal(c.variants[0].components[1].quantity, 1);
  assert.equal(c.variants[1].components, undefined);
  assert.equal(c.kind, 'bundle', 'the product-level flag still says bundle');
});

test('PrestaShop pack (associations.product_bundle: id / id_product_attribute / quantity) → the SAME canon through the same transform, args only', () => {
  // The Webservice shape (PrestaShop 8/9): the pack is a product-level list of
  // product items, optionally pinned to a combination (id_product_attribute, 0 = none).
  const pack = { id: 19, product_type: 'pack', name: 'Pack Mug + Poster', associations: { product_bundle: [{ id: 6, id_product_attribute: 0, quantity: 1 }, { id: 3, id_product_attribute: 13, quantity: 2 }] } };
  const fmt = { id: 'presta.products.webservice.v0', platformHint: 'presta', fields: [
    { path: 'name', canon: 'title', transform: 'text', confidence: 'seed' },
    { path: 'product_type', canon: 'kind', transform: 'enum_map', args: { map: { pack: 'bundle', standard: 'simple', combinations: 'variable', virtual: 'digital' } }, confidence: 'seed' },
    { path: 'associations.product_bundle', canon: 'variants[].components', transform: 'bundle_components', args: { refs: [{ path: 'id_product_attribute', kind: 'sourceId' }, { path: 'id', kind: 'sourceId' }], emptyValues: [0, '0'], productRef: 'id', productRefKind: 'sourceId', quantity: 'quantity' }, confidence: 'seed', consumes: ['associations'] },
    { path: 'id', canon: 'identity.sourceId', transform: 'string_id', confidence: 'seed' },
  ], structure: { variants: { selfWhenNone: true } } };
  const { products, report } = parseWithKnowledge(fmt, [pack], { companions: {}, canon });
  assert.deepEqual(report.unknownKeys, []);
  const p = products[0];
  assert.equal(p.kind, 'bundle');
  assert.equal(p.variants.length, 1, 'a pack has no combinations: its items sit on the single variant');
  assert.deepEqual(p.variants[0].components, [
    { ref: '6', refKind: 'sourceId', quantity: 1, productRef: '6', productRefKind: 'sourceId' },
    { ref: '13', refKind: 'sourceId', quantity: 2, productRef: '3', productRefKind: 'sourceId' },
  ]);
});

test('transform contract: nothing → undefined, non-array → undefined, title picked when asked', () => {
  const t = TRANSFORMS.bundle_components;
  assert.equal(t([], { args: {} }), undefined);
  assert.equal(t(null, { args: {} }), undefined);
  assert.equal(t('x', { args: {} }), undefined);
  assert.deepEqual(t([{ id: 4, quantity: '3', name: 'Mug' }], { args: { refs: [{ path: 'id', kind: 'sourceId' }], title: 'name' } }), [{ ref: '4', refKind: 'sourceId', quantity: 3, title: 'Mug' }]);
  assert.deepEqual(t([{ id: 0 }], { args: { refs: [{ path: 'id', kind: 'sourceId' }] } }), undefined, 'an empty-valued ref is not a component');
});

test('targets: the bundle product exports as a normal product on all four; the composition is a uniform loss with the handles; serialisers never leak components', () => {
  const { products } = parseWithKnowledge(SHOPIFY, [shopifyBundle(), live[0]], { companions: {}, canon });
  for (const out of [serializeShopifyProducts(products), serializeWooModern(products), serializeWixProducts(products), serializeBigCommerceProducts(products)]) {
    const cells = out.rows.flatMap((r) => Object.values(r));
    assert.ok(!cells.some((v) => typeof v === 'string' && v.includes('Qnubu-Sacs-à-Presse-8')), 'component refs never leak into a cell');
    assert.ok(!out.headers.some((h) => /component|bundle/i.test(h)));
  }
  const expected = { 'shopify-to-woocommerce': 'loss_woo_bundles', 'shopify-to-wix': 'loss_wix_bundles', 'shopify-to-bigcommerce': 'loss_bc_bundles' };
  for (const [direction, code] of Object.entries(expected)) {
    const res = convertFromCanon(products, { direction, expectPlatform: 'shopify' }, 'x');
    assert.equal(res.ok, true);
    assert.equal(res.counts.outputUnits, 2, 'the bundle IS exported (as a product)');
    assert.deepEqual(res.losses.find((l) => l.code === code), { code, params: { count: 1, handles: 'qnubu-duo' } }, direction);
  }
  const sh = convertFromCanon(products, { direction: 'shopware-to-shopify', expectPlatform: 'shopware' }, 'x');
  assert.deepEqual(sh.losses.find((l) => l.code === 'loss_shopify_bundles'), { code: 'loss_shopify_bundles', params: { count: 1, handles: 'qnubu-duo' } });
  // the WooCommerce row of the bundle is a plain 'variable' product (its own SKUs / prices), not a grouped product
  const woo = convertFromCanon(products, { direction: 'shopify-to-woocommerce', expectPlatform: 'shopify' }, 'x');
  // (its parent SKU is generated from the title since 27/10/2026 — the handle is no longer written as a SKU)
  assert.equal(woo.rows.find((r) => r.Name === 'Qnubu - Duo').Type, 'variable');
  assert.equal(woo.rows.find((r) => r.Name === 'Qnubu - Duo').SKU, 'QNUBU-DUO');
  // no bundle → no loss
  assert.ok(!convertFromCanon([products[1]], { direction: 'shopify-to-woocommerce', expectPlatform: 'shopify' }, 'x').losses.some((l) => /_bundles$/.test(l.code)));
});
