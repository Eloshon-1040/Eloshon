// Phase 2 contract test — the extended canonical IR must stay ADDITIVE:
//   • an object built with ONLY the legacy required fields is still a valid
//     CanonProduct / CanonVariant / CanonImage (nothing was made required);
//   • every new field is OPTIONAL and can be present or absent without any
//     parser/serialiser blowing up;
//   • the existing parsers keep producing objects that satisfy the type (no
//     regression), and the existing serialisers still accept the extended shape.
//
// Runtime types are stripped at build (TS→ESM), so this test asserts SHAPE and
// BEHAVIOUR: legacy objects flow end-to-end unchanged, and objects carrying the
// new optional fields are accepted (and simply ignored by today's serialisers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWooModern, parseShopifyProducts,
  serializeShopifyProducts, serializeWooModern,
} from '../core/dist/products.mjs';

// A minimal legacy CanonProduct (all Phase 2 additions absent). Feeding it to
// the current serialisers must succeed without touching any new field.
const legacyProduct = {
  handle: 'legacy-handle',
  title: 'Legacy product',
  bodyHtml: '<p>desc</p>',
  vendor: 'Acme',
  productType: '',
  tags: ['a', 'b'],
  status: 'active',
  categories: [],
  published: true,
  options: [],
  variants: [{
    optionValues: [], sku: 'SKU-1', price: 10, compareAtPrice: null,
    cost: null, barcode: '', grams: null,
    lengthCm: null, widthCm: null, heightCm: null,
    requiresShipping: true, taxable: true, inventoryQty: 3, imageSrc: '',
  }],
  images: [{ src: 'https://x/y.jpg', position: 1, alt: '' }],
  metafields: [],
  seoTitle: '', seoDescription: '',
};

test('canon: legacy-only product still serialises to Shopify + Woo', () => {
  const s = serializeShopifyProducts([legacyProduct]);
  assert.ok(s.headers.length > 0);
  assert.equal(s.rows.length, 1);
  assert.equal(s.rows[0]['Variant SKU'], 'SKU-1');
  const w = serializeWooModern([legacyProduct]);
  assert.equal(w.rows.length, 1);
  // For a non-variable product the parent SKU is the variant SKU (see
  // products.ts::serializeWooModern → parentSku). Only when that is empty does
  // it fall back to the handle.
  assert.equal(w.rows[0]['SKU'], 'SKU-1');
});

test('canon: product carrying every Phase 2 optional field still serialises', () => {
  const rich = {
    ...legacyProduct,
    handle: 'rich-handle',
    identity: { slug: 'rich-slug', sourceId: 'wc-42', timestamps: { created: '2026-01-01T00:00:00Z', modified: '2026-02-01T00:00:00Z' } },
    kind: 'digital',
    visibility: { featured: true, catalogVisibility: 'catalog' },
    merchandising: { upsells: ['SKU-2'], crossSells: ['SKU-3'], related: [], groupedChildren: [], menuOrder: 5 },
    notes: { purchase: 'Thanks!' },
    external: { url: 'https://partner/x', buttonText: 'Buy' },
    digital: { downloads: [{ name: 'guide.pdf', file: 'https://x/g.pdf', sha256: 'abc' }], downloadLimit: 3, downloadExpiry: '2027-01-01T00:00:00Z' },
    attributesRich: [{ name: 'Material', values: ['Cotton'], position: 0, visible: true, forVariation: false }],
    defaultOptionValues: { Size: 'M' },
    sourceExtension: { woocommerce: { total_sales: 42 } },
    variants: [{
      ...legacyProduct.variants[0],
      stockPolicy: { manageStock: true, backorders: 'notify', soldIndividually: false },
      taxClass: 'reduced-rate', shippingClass: 'bulky',
      salePeriod: { from: '2026-12-01T00:00:00Z', to: '2026-12-31T23:59:59Z' },
      images: [{ src: 'https://x/v.jpg', position: 1, alt: '', id: 'v1', width: 800, height: 600 }],
    }],
    images: [{ ...legacyProduct.images[0], id: 'img-1', width: 1200, height: 800 }],
  };
  // Should NOT throw; current serialisers ignore the extra fields.
  const s = serializeShopifyProducts([rich]);
  assert.equal(s.rows[0]['Variant SKU'], 'SKU-1');
  const w = serializeWooModern([rich]);
  assert.equal(w.rows[0]['Name'], 'Legacy product');
});

test('canon: parsers still produce objects readable by every serialiser (no new required field)', () => {
  const shopifyCsv = 'Handle,Title,Variant Price\nh1,T1,9.99\n';
  // parseCsv is used inside convert(); here we synthesise the minimal call.
  const products = parseShopifyProducts(['Handle', 'Title', 'Variant Price'], [{ Handle: 'h1', Title: 'T1', 'Variant Price': '9.99' }]);
  assert.equal(products.length, 1);
  // Feed back into every serialiser.
  serializeShopifyProducts(products);
  serializeWooModern(products);
  void shopifyCsv;
  const wooRows = [
    { ID: '1', Type: 'simple', SKU: 'S1', Name: 'W1', Published: '1', 'Regular price': '5' },
  ];
  const wp = parseWooModern(['ID', 'Type', 'SKU', 'Name', 'Published', 'Regular price'], wooRows);
  assert.equal(wp.length, 1);
  serializeShopifyProducts(wp);
  serializeWooModern(wp);
});
