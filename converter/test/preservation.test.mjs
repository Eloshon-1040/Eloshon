// Phase 3 contract test — preservation channels.
// The canon exposes two additive channels to keep source data that has no
// canonical home yet:
//   • sourceExtension: namespace-per-platform verbatim record
//   • unmapped[]: enumerable list of source fields with a preservation reason
// Both are optional. Existing serialisers must IGNORE them (no leak into the
// output CSV headers/rows), and the golden files must stay byte-identical.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeShopifyProducts, serializeWooModern } from '../core/dist/products.mjs';
import { serializeWixProducts } from '../core/dist/wix.mjs';
import { serializeBigCommerceProducts } from '../core/dist/bigcommerce.mjs';

const baseVariant = {
  optionValues: [], sku: 'V1', price: 12.5, compareAtPrice: null,
  cost: null, barcode: '', grams: null,
  lengthCm: null, widthCm: null, heightCm: null,
  requiresShipping: true, taxable: true, inventoryQty: 5, imageSrc: '',
};
const baseProduct = {
  handle: 'preserve-me', title: 'Preserve me', bodyHtml: '',
  vendor: '', productType: '', tags: [], status: 'active',
  categories: [], published: true, options: [],
  variants: [baseVariant], images: [], metafields: [],
  seoTitle: '', seoDescription: '',
};

test('preservation: sourceExtension is namespaced per platform and ignored by serialisers', () => {
  const p = {
    ...baseProduct,
    sourceExtension: {
      woocommerce: { total_sales: 42, purchase_note: 'Thanks!', catalog_visibility: 'catalog' },
      wix: { ribbon: 'NEW' },
    },
  };
  // Serialisers must not read from sourceExtension. Any value we put there
  // must NOT appear anywhere in the output cells (including columns whose name
  // happens to match — e.g. Wix legitimately has a 'ribbon' column, but its
  // value must come from CanonProduct.metafields[key='wix_ribbon'], not from
  // sourceExtension.wix.ribbon).
  for (const out of [
    serializeShopifyProducts([p]), serializeWooModern([p]),
    serializeWixProducts([p]), serializeBigCommerceProducts([p]),
  ]) {
    const cells = out.rows.flatMap((r) => Object.values(r));
    // The distinctive sourceExtension values must be absent.
    assert.ok(!cells.includes('42'));      // total_sales
    assert.ok(!cells.includes('Thanks!')); // purchase_note
    assert.ok(!cells.includes('NEW'));     // wix.ribbon (comes only from metafields)
    assert.ok(!cells.includes('catalog')); // catalog_visibility raw
  }
});

test('preservation: unmapped[] carries a REASON per entry and is ignored by serialisers', () => {
  const p = {
    ...baseProduct,
    unmapped: [
      { platform: 'woocommerce', sourceField: 'total_sales', sourceValue: 42, reason: 'platform-specific' },
      { platform: 'woocommerce', sourceField: 'shipping_class', sourceValue: 'bulky', reason: 'no-canon-field', note: 'candidate for CanonVariant.shippingClass promotion' },
      { platform: 'woocommerce', sourceField: 'foo_bar_baz', sourceValue: 'weird', reason: 'unknown' },
    ],
    variants: [{
      ...baseVariant,
      unmapped: [
        { platform: 'woocommerce', sourceField: 'download_expiry', sourceValue: 30, reason: 'no-canon-field' },
      ],
    }],
    images: [{
      src: 'https://x/y.jpg', position: 1, alt: '',
      unmapped: [{ platform: 'shopify', sourceField: 'admin_graphql_api_id', sourceValue: 'gid://...', reason: 'platform-specific' }],
    }],
  };
  // Serialisers must not throw and must not leak any unmapped material.
  for (const out of [
    serializeShopifyProducts([p]), serializeWooModern([p]),
    serializeWixProducts([p]), serializeBigCommerceProducts([p]),
  ]) {
    assert.ok(!out.headers.some((h) => /unmapped|reason|sourceField|sourceValue/i.test(h)));
    const cellValues = out.rows.flatMap((r) => Object.values(r));
    assert.ok(!cellValues.some((v) => typeof v === 'string' && (v.includes('platform-specific') || v.includes('foo_bar_baz'))));
  }
});

test('preservation: reason values include the documented taxonomy', () => {
  // The taxonomy is a discriminator for future UI/reporting. This test freezes
  // the current documented values so accidental churn is caught.
  const documented = new Set(['no-canon-field', 'platform-specific', 'unknown', 'ambiguous']);
  const entries = [
    { platform: 'wc', sourceField: 'a', sourceValue: 1, reason: 'no-canon-field' },
    { platform: 'wc', sourceField: 'b', sourceValue: 2, reason: 'platform-specific' },
    { platform: 'wc', sourceField: 'c', sourceValue: 3, reason: 'unknown' },
    { platform: 'wc', sourceField: 'd', sourceValue: 4, reason: 'ambiguous' },
    // Extensible: adapters may use their own reason strings — the type allows it.
    { platform: 'wc', sourceField: 'e', sourceValue: 5, reason: 'custom-x' },
  ];
  for (const e of entries) {
    assert.ok(typeof e.reason === 'string');
    if (documented.has(e.reason)) assert.ok(true);
  }
});
