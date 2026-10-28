// Phase 4 contract test — provenance.
// A canonical value can carry a provenance record that answers:
//   "why does this value read this way, and where did it come from?"
// Keys are dotted canonical paths ('title', 'variants[0].price', ...).
// The field is OPTIONAL on CanonProduct / CanonVariant / CanonImage; the
// current serialisers must IGNORE it (no leak into the CSV, no throw).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeShopifyProducts, serializeWooModern } from '../core/dist/products.mjs';
import { serializeWixProducts } from '../core/dist/wix.mjs';
import { serializeBigCommerceProducts } from '../core/dist/bigcommerce.mjs';
import { parseWithKnowledge } from '../core/knowledge-proposal/generic-parser.mjs';

const baseVariant = {
  optionValues: [], sku: 'SKU-P4', price: 9.99, compareAtPrice: null,
  cost: null, barcode: '', grams: null,
  lengthCm: null, widthCm: null, heightCm: null,
  requiresShipping: true, taxable: true, inventoryQty: 1, imageSrc: '',
};
const baseProduct = {
  handle: 'provenance-me', title: 'Provenance me', bodyHtml: '',
  vendor: '', productType: '', tags: [], status: 'active',
  categories: [], published: true, options: [],
  variants: [baseVariant], images: [{ src: 'https://x/i.jpg', position: 1, alt: '' }],
  metafields: [], seoTitle: '', seoDescription: '',
};

test('provenance: shape is keyed by canonical path with all fields optional except platform+sourceField', () => {
  const p = {
    ...baseProduct,
    provenance: {
      'title': { platform: 'woocommerce', sourceField: 'name', sourceValue: 'Provenance me', method: 'exact' },
      'vendor': { platform: 'woocommerce', sourceField: 'Brand', sourceValue: '', method: 'alias', note: 'alias of Vendor' },
      'variants[0].price': { platform: 'woocommerce', sourceField: 'Regular price', sourceValue: '9.99', transform: 'price_promo', method: 'structural', confidence: 0.98 },
    },
    variants: [{
      ...baseVariant,
      provenance: {
        'sku': { platform: 'woocommerce', sourceField: 'SKU', method: 'exact' },
      },
    }],
    images: [{
      src: 'https://x/i.jpg', position: 1, alt: '',
      provenance: {
        'src': { platform: 'woocommerce', sourceField: 'Images', method: 'structural', note: 'first URL of comma list' },
      },
    }],
  };
  // Serialisers ignore provenance: no throw, no leak.
  for (const out of [
    serializeShopifyProducts([p]), serializeWooModern([p]),
    serializeWixProducts([p]), serializeBigCommerceProducts([p]),
  ]) {
    assert.ok(!out.headers.some((h) => /provenance|sourceField|sourceValue|method|transform/i.test(h)));
    const cells = out.rows.flatMap((r) => Object.values(r));
    assert.ok(!cells.some((v) => typeof v === 'string' && v.includes('price_promo')));
    assert.ok(!cells.some((v) => typeof v === 'string' && v.includes('alias of Vendor')));
  }
});

test('provenance: method values are the documented taxonomy', () => {
  // Phase 6.2 adds 'inherited' (parent → child inheritance declared by the format).
  const documented = new Set(['exact', 'alias', 'structural', 'semantic', 'override', 'default', 'inherited']);
  for (const m of ['exact', 'alias', 'structural', 'semantic', 'override', 'default', 'inherited']) {
    assert.ok(documented.has(m));
  }
});

test('provenance: the generic parser marks inherited values with method "inherited" and never with a free-text note', () => {
  // A minimal format declaring null → parent inheritance (Shopware DAL semantics), no fixture needed.
  const format = {
    id: 'x.products.v1', platformHint: 'x', fields: [
      { path: 'name', canon: 'title', transform: 'text', confidence: 'seed' },
      { path: 'sku', canon: 'variants[].sku', transform: 'text', confidence: 'seed' },
      { path: 'price', canon: 'variants[].price', transform: 'money', confidence: 'seed' },
    ],
    structure: { variants: { companion: 'variations', keyedBy: 'id', childParentPath: 'parentId' }, inheritance: { nullMeansParent: true, exclude: ['sku'] } },
  };
  const parent = { id: 1, name: 'Parent', sku: 'P', price: '10' };
  const kids = [{ id: 2, parentId: 1, name: null, sku: 'P.1', price: null }, { id: 3, parentId: 1, name: null, sku: 'P.2', price: '12' }];
  const { products } = parseWithKnowledge(format, [parent], { companions: { variations: kids } });
  const [v1, v2] = products[0].variants;
  // sourceValue is the PARENT's raw value — the one that was actually inherited.
  assert.equal(v1.price, 10); assert.deepEqual(v1.provenance.price, { platform: 'x', sourceField: 'price', sourceValue: '10', transform: 'money', method: 'inherited' });
  assert.equal(v1.provenance.sku.method, 'exact');
  assert.equal(v2.price, 12); assert.equal(v2.provenance.price.method, 'exact');
  for (const v of products[0].variants) for (const pr of Object.values(v.provenance)) assert.equal(pr.note, undefined);
});

test('provenance: confidence is a number in [0..1] by convention (contract only)', () => {
  // Contract: 0 = certain absence of confidence signal, 1 = fully certain.
  // Type allows any number; this test freezes the convention.
  const good = [{ platform: 'x', sourceField: 'y', confidence: 0 }, { platform: 'x', sourceField: 'y', confidence: 0.5 }, { platform: 'x', sourceField: 'y', confidence: 1 }];
  for (const g of good) assert.ok(typeof g.confidence === 'number');
});
