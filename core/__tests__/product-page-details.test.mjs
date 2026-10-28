/**
 * Product-page details, end to end through extractProduct + toNormalizedProduct, on a
 * hand-built page shaped like a large electronics retailer's (fictional data):
 *   - the product is JSON-LD wrapped in a BuyAction (`object` → ProductGroup);
 *   - the page state is a JS literal with `undefined` (not JSON) holding the technical
 *     specs in an Apollo-like store, next to an accessory's specs;
 *   - the model code in the name ("40S5L") is not a quantity.
 * No network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractProduct } from '../extract.mjs';
import { toNormalizedProduct } from '../normalize.mjs';
import { extractProductFromJsonLd } from '../jsonld.mjs';
import { weightFromName } from '../weight.mjs';

const URL_ = 'https://www.shop.test/fr/product/_brand-40s5l-tv-2026-1002.html';
const LD = { '@context': 'https://schema.org/', '@type': 'BuyAction', object: {
  '@type': 'ProductGroup', brand: { '@type': 'Brand', name: 'Marque' }, sku: '1002', gtin13: '5901292530372',
  name: 'Marque 40S5L - Full HD - TV QLED - 40 pouces - 2026', url: URL_,
  description: 'Commande le Marque 40S5L chez Shop.',
  image: ['https://cdn.shop.test/a.png', 'https://cdn.shop.test/b.png'],
  aggregateRating: { '@type': 'AggregateRating', ratingValue: '3.3', ratingCount: '6' },
  review: [{ '@type': 'Review', author: { '@type': 'Person', name: 'Quelqu’un' }, reviewBody: 'ok' }],
  offers: { '@type': 'Offer', priceCurrency: 'EUR', price: 299, availability: 'https://schema.org/InStock' },
  variesBy: ['size'],
  hasVariant: [
    { '@type': 'Product', sku: '1001', gtin13: '5901292530358', size: '50 pouces', image: 'https://cdn.shop.test/50.png', offers: { '@type': 'Offer', url: '/fr/product/_brand-50s5l-1001.html', price: 444, availability: 'https://schema.org/InStock' } },
    { '@type': 'Product', sku: '1002', gtin13: '5901292530372', size: '40 pouces', image: 'https://cdn.shop.test/40.png', offers: { '@type': 'Offer', url: '/fr/product/_brand-40s5l-tv-2026-1002.html', price: 299, availability: 'https://schema.org/InStock' } },
  ],
} };
const BREAD = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
  { '@type': 'ListItem', position: 1, name: 'home', item: 'https://www.shop.test/fr/' },
  { '@type': 'ListItem', position: 2, name: 'TV', item: 'https://www.shop.test/fr/category/tv.html' },
  { '@type': 'ListItem', position: 3, name: 'TV Android', item: 'https://www.shop.test/fr/category/tv-android.html' },
] };
// The store: the page product (1002) and an accessory (7777) — `undefined` makes it JS, not JSON.
const STATE = `{"apollo":{"F:1":{"__typename":"F","name":"Diagonale de l’écran","value":"102 cm / 40 pouces","unit":null,"promo":undefined},`
  + `"F:2":{"__typename":"F","name":"Résolution","value":"Full HD"},"F:3":{"__typename":"F","name":"Poids sans pied","value":"4.60 kg"},`
  + `"F:9":{"__typename":"F","name":"Poids (de chargement) maximal","value":"35 kg"},"F:8":{"__typename":"F","name":"Taille max.","value":"70 pouces"},`
  + `"G:1002":{"__typename":"G","productId":"1002","featureGroups":[{"featureGroupName":"Caractéristiques techniques","features":[{"__ref":"F:1"},{"__ref":"F:2"}]},{"featureGroupName":"Caractéristiques générales","features":[{"__ref":"F:3"},{"__ref":"F:2"}]}]},`
  + `"G:7777":{"__typename":"G","productId":"7777","featureGroups":[{"featureGroupName":"Support","features":[{"__ref":"F:9"},{"__ref":"F:8"}]}]}}}`;
const PAGE = `<!doctype html><html><head><title>Marque 40S5L | Full HD - TV QLED - 40 pouces - 2026 | Shop</title>
<meta property="og:title" content="Marque 40S5L | Full HD - TV QLED - 40 pouces - 2026 | Shop">
<script type="application/ld+json">${JSON.stringify(LD)}</script>
<script type="application/ld+json">${JSON.stringify(BREAD)}</script>
</head><body><h1>Marque 40S5L</h1><script>window.__PRELOADED_STATE__ = ${STATE};</script></body></html>`;

test('JSON-LD: a product wrapped in a BuyAction (object → ProductGroup) is the page product', () => {
  const p = extractProductFromJsonLd(PAGE);
  assert.equal(p.name, 'Marque 40S5L - Full HD - TV QLED - 40 pouces - 2026');
  assert.equal(p.brand, 'Marque'); assert.equal(p.sku, '1002'); assert.equal(p.gtin, '5901292530372');
  assert.equal(p.price, 299); assert.equal(p.images.length, 2);
  // A plain Product beats a ProductGroup when both are on the page.
  const both = `<script type="application/ld+json">${JSON.stringify([{ '@type': 'ProductGroup', name: 'Groupe' }, { '@type': 'Product', name: 'Article', offers: { price: 5 } }])}</script>`;
  assert.equal(extractProductFromJsonLd(both).name, 'Article');
});

test('the product page gives its details: identity, stock, rating, real weight, specs of THIS product, size variants', () => {
  const { product, strategies } = extractProduct(PAGE, URL_);
  assert.ok(strategies.includes('generic-jsonld') && strategies.includes('generic-specs') && strategies.includes('generic-product-group'), strategies.join(','));
  const n = toNormalizedProduct(product);
  assert.equal(n.name, 'Marque 40S5L - Full HD - TV QLED - 40 pouces - 2026', 'the structured name, not the <title> with the shop suffix');
  assert.equal(n.price, 299); assert.equal(n.barcode, '5901292530372');
  assert.equal(n.raw.brand, 'Marque'); assert.equal(n.raw.sku, '1002');
  assert.equal(n.raw.availability, 'InStock'); assert.equal(n.raw.rating, 3.3); assert.equal(n.raw.review_count, 6);
  assert.deepEqual(n.images, ['https://cdn.shop.test/a.png', 'https://cdn.shop.test/b.png'], 'the other sizes\' pictures stay out of the gallery');
  assert.equal(n.source_category, 'TV > TV Android');
  // Weight: the sheet's own mass, not "5 L" read in the model code, never an estimate.
  assert.equal(n.weight_kg, 4.6); assert.equal(n.raw.weight_text, '4.60 kg'); assert.equal(n.raw.weight_estimated, false);
  // Specs: the page product's groups only (the accessory's "35 kg" load is not here).
  assert.deepEqual(n.raw.specs, [
    { group: 'Caractéristiques techniques', name: 'Diagonale de l’écran', value: '102 cm / 40 pouces' },
    { group: 'Caractéristiques techniques', name: 'Résolution', value: 'Full HD' },
    { group: 'Caractéristiques générales', name: 'Poids sans pied', value: '4.60 kg' },
  ]); // the same name + value in two groups is kept once
  // Variants: one per screen size, each with its own EAN, price, stock and absolute link.
  assert.deepEqual(n.variants, [
    { code: '5901292530358', type: 'taille', name: '50 pouces', gtin: '5901292530358', availability: 'InStock', price: 444, url: 'https://www.shop.test/fr/product/_brand-50s5l-1001.html', sku: '1001' },
    { code: '5901292530372', type: 'taille', name: '40 pouces', gtin: '5901292530372', availability: 'InStock', price: 299, url: 'https://www.shop.test/fr/product/_brand-40s5l-tv-2026-1002.html', sku: '1002' },
  ]);
  // No personal data of reviewers.
  assert.ok(!JSON.stringify(n).includes('Quelqu’un'));
});

test('a page without specs carries no raw.specs key (JSON-dropped, like raw.columns)', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'Café moulu 250g', offers: { price: 3.2, priceCurrency: 'EUR' } })}</script>`;
  const { product } = extractProduct(html, 'https://epicerie.test/p/1');
  assert.equal('specs' in product, false);
  assert.equal(toNormalizedProduct(product).raw.specs, undefined);
});

test('weightFromName: a number glued to letters is a model code, not a quantity; multipacks still read', () => {
  assert.equal(weightFromName('TCL 40S5L | Full HD'), null);
  assert.equal(weightFromName('Sony XR-55A80L'), null);
  assert.equal(weightFromName('Biscuits 300g'), '300 g');
  assert.equal(weightFromName('Huile 1L'), '1 L');
  assert.equal(weightFromName('Lessive (2,5 kg)'), '2,5 kg');
  assert.equal(weightFromName('Coca-Cola 4x33cl'), '33 cl');
  assert.equal(weightFromName('Eau 6×1,5L'), '1,5 L');
  assert.equal(weightFromName('Pack 24 x 33cl'), '33 cl');
  // "98X11L" is a model code (98 is no pack count), not 98 × 11 litres.
  assert.equal(weightFromName('TCL 98X11L 98" TV'), null);
});
