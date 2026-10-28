/**
 * Per-field multi-source FUSION (April Beauty / Hydrozone as the real cases):
 * no single extractor "wins" the whole fiche. A weak structured source (e.g.
 * PrestaShop microdata) provides name+price, and the engine still fills the
 * absent fields — EAN/GTIN, weight/contenance, brand, category — from every
 * other source on the SAME page (embedded JSON, labeled DOM spec tables, and the
 * product name), WITHOUT degrading the fields already correctly extracted.
 * Offline: pure functions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractProduct } from '../extract.mjs';
import { extractSpecsFromDom } from '../dom-fallback.mjs';
import { extractBreadcrumbFromDom } from '../html-meta.mjs';

// ── microdata breadcrumb + product-scope name (PrestaShop/Magento pattern) ────
const CRUMBS = `<div class="breadcrumb" itemscope itemtype="https://schema.org/BreadcrumbList">
  <a class="home" href="/">Home</a>
  <ol>
    <li itemprop="itemListElement" itemscope itemtype="http://schema.org/ListItem"><a href="/74" title="ENGRAIS" itemprop="item"><span itemprop="name">ENGRAIS</span></a><meta itemprop="position" content="1" /></li>
    <li itemprop="itemListElement" itemscope itemtype="http://schema.org/ListItem"><a href="/177" title="Plagron" itemprop="item"><span itemprop="name">Plagron</span></a><meta itemprop="position" content="2" /></li>
  </ol></div>`;

test('breadcrumb: microdata BreadcrumbList parsed in position order', () => {
  assert.deepEqual(extractBreadcrumbFromDom(CRUMBS), ['ENGRAIS', 'Plagron']);
});

test('scope: the product name is NOT the breadcrumb crumb; breadcrumb still captured', () => {
  const html = `<html><body>${CRUMBS}
    <div itemscope itemtype="https://schema.org/Product">
      <h1 itemprop="name">Green Sensation 500ml - PLAGRON</h1>
      <span itemprop="price" content="79.66"></span>
    </div></body></html>`;
  const { product } = extractProduct(html, 'https://shop.test/p/gs');
  assert.equal(product.name, 'Green Sensation 500ml - PLAGRON'); // NOT "ENGRAIS" (the first crumb)
  assert.deepEqual(product.breadcrumb, ['ENGRAIS', 'Plagron']);
  assert.equal(product.weightText, '500 ml');                    // from the (now correct) name
});

// ── the DOM spec extractor in isolation ──────────────────────────────────────
test('specs: PrestaShop "Fiche technique" table → gtin/weight/brand/sku, ignores unrelated rows', () => {
  const html = `<section class="product-features"><h3>Fiche technique</h3><table class="data-sheet">
    <tr><td>Référence</td><td>PGS0500</td></tr>
    <tr><td>EAN13</td><td>5410 0000 000 17</td></tr>
    <tr><td>Marque</td><td>Plagron</td></tr>
    <tr><td>Poids</td><td>1,5 kg</td></tr>
    <tr><td>Utilisation conseillée</td><td>Floraison</td></tr>
    <tr><td>Taille</td><td>M</td></tr>
  </table></section>`;
  const s = extractSpecsFromDom(html);
  assert.equal(s.sku, 'PGS0500');
  assert.equal(s.gtin, '5410000000017');   // spaces stripped, validated as 13 digits
  assert.equal(s.brand, 'Plagron');
  assert.equal(s.weightText, '1,5 kg');
  assert.equal(s.category, undefined);      // "Utilisation conseillée"/"Taille" are not spec labels
});

test('specs: definition-list data sheet (WooCommerce-style) → brand + contenance', () => {
  const html = `<dl class="woocommerce-product-attributes">
    <dt>Marque</dt><dd><a href="/x">Green House</a></dd>
    <dt>Contenance</dt><dd>500 ml</dd>
    <dt>Livraison</dt><dd>24h</dd>
  </dl>`;
  const s = extractSpecsFromDom(html);
  assert.equal(s.brand, 'Green House');
  assert.equal(s.weightText, '500 ml');
  assert.equal(s.sku, undefined);
});

test('specs: a bare reference is never mistaken for an EAN (gtin needs 8-14 digits)', () => {
  const html = `<table><tr><td>Référence</td><td>ABC-123</td></tr><tr><td>Code-barres</td><td>12345</td></tr></table>`;
  const s = extractSpecsFromDom(html);
  assert.equal(s.sku, 'ABC-123');
  assert.equal(s.gtin, undefined);          // "12345" is only 5 digits → rejected
});

// ── fusion through extractProduct ────────────────────────────────────────────
test('fusion: microdata name+price + spec table → EAN/weight/brand filled, name/price/sku intact', () => {
  const html = `<html><body>
    <div itemscope itemtype="https://schema.org/Product">
      <span itemprop="name">Green Sensation</span>
      <span itemprop="sku">PGS0500</span>
      <span itemprop="price" content="79.66"></span>
      <span itemprop="priceCurrency" content="EUR"></span>
    </div>
    <table class="data-sheet">
      <tr><td>EAN</td><td>5410000000017</td></tr>
      <tr><td>Marque</td><td>Plagron</td></tr>
      <tr><td>Contenance</td><td>500 ml</td></tr>
    </table></body></html>`;
  const { product } = extractProduct(html, 'https://shop.test/p/green');
  assert.equal(product.name, 'Green Sensation');   // microdata not degraded
  assert.equal(product.price, 79.66);
  assert.equal(product.sku, 'PGS0500');
  assert.equal(product.gtin, '5410000000017');     // filled from spec table
  assert.equal(product.brand, 'Plagron');          // filled from spec table
  assert.equal(product.weightText, '500 ml');      // filled from spec table
});

test('fusion: microdata + embedded hydration blob → brand/gtin/category/weight filled, price kept', () => {
  const blob = { props: { product: { '@type': 'Product', name: 'X', price: 999, gtin13: '3700000000010',
    brand: { name: 'Acme' }, categories: ['Maison', 'Cuisine'], weight: { value: 1.2, unitText: 'kg' }, image: 'https://x/i.jpg' } } };
  const html = `<html><body>
    <div itemscope itemtype="https://schema.org/Product">
      <span itemprop="name">Produit Réel</span>
      <span itemprop="price" content="24.90"></span>
    </div>
    <script id="__NEXT_DATA__" type="application/json">${JSON.stringify(blob)}</script></body></html>`;
  const { product, strategies } = extractProduct(html, 'https://shop.test/p/x');
  assert.equal(product.name, 'Produit Réel');      // microdata wins the name
  assert.equal(product.price, 24.9);               // NOT overridden by the blob's 999
  assert.equal(product.gtin, '3700000000010');
  assert.equal(product.brand, 'Acme');
  assert.equal(product.category, 'Cuisine');       // last of categories[]
  assert.equal(product.weightText, '1.2 kg');
  assert.ok(product.images.includes('https://x/i.jpg'));
  assert.ok(strategies.includes('generic-embedded-json'));
});

test('fusion: weight derived from the product name when no source has it (unit-anchored)', () => {
  const ld = { '@context': 'https://schema.org', '@type': 'Product', name: 'Sirop de menthe 750 ml',
    offers: { price: '4.20', priceCurrency: 'EUR' } };
  const html = `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body></body></html>`;
  const { product } = extractProduct(html, 'https://shop.test/p/sirop');
  assert.equal(product.weightText, '750 ml');
});

test('fusion: a bare number in the name is NOT taken as weight (no unit)', () => {
  const ld = { '@context': 'https://schema.org', '@type': 'Product', name: "Levi's 501 Original",
    offers: { price: '99', priceCurrency: 'EUR' } };
  const html = `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body></body></html>`;
  const { product } = extractProduct(html, 'https://shop.test/p/501');
  assert.equal(product.weightText, null);
});

test('fusion: image from <img itemprop="image" src> when there is no og:image (PrestaShop)', () => {
  const html = `<html><body>
    <div itemscope itemtype="https://schema.org/Product">
      <span itemprop="name">Produit</span>
      <span itemprop="price" content="9.90"></span>
      <img id="bigpic" itemprop="image" src="https://static.shop/large/p.jpg" alt="Produit">
      <a href="/p/autre"><img itemprop="image" src="https://static.shop/thumb/related.jpg" alt="Autre"></a>
    </div></body></html>`;
  const { product } = extractProduct(html, 'https://shop.test/p/x');
  // The first (main) image; the thumbnail inside a link to ANOTHER product page is that product's, never this gallery's.
  assert.deepEqual(product.images, ['https://static.shop/large/p.jpg']);
});

test('fusion: image from <link rel="image_src"> fallback when no og/twitter/itemprop', () => {
  const html = `<html><head><link rel="image_src" href="https://cdn.shop/hero.jpg">
    <script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'X', offers: { price: 5, priceCurrency: 'EUR' } })}</script></head><body></body></html>`;
  const { product } = extractProduct(html, 'https://shop.test/p/y');
  assert.ok(product.images.includes('https://cdn.shop/hero.jpg'));
});

test('confidence: multi-signal — a rich fiche scores far above a bare one', () => {
  const rich = { '@context': 'https://schema.org', '@type': 'Product', name: 'Chaise', description: 'Chaise ergonomique',
    gtin13: '5410000000017', brand: 'Acme', image: 'https://x/a.jpg', offers: { price: '49', priceCurrency: 'EUR' } };
  const { product: pr } = extractProduct(`<html><head><script type="application/ld+json">${JSON.stringify(rich)}</script></head></html>`, 'https://shop.test/product/chaise');
  assert.ok(pr.confidence >= 0.9, `rich fiche confident, got ${pr.confidence}`);
  // A page with only a <title> → minimal signals → low confidence.
  const { product: pl } = extractProduct('<html><head><title>Just a page</title><meta property="og:title" content="Just a page"></head><body></body></html>', 'https://shop.test/x');
  assert.ok(!pl || pl.confidence <= 0.35, `bare fiche low, got ${pl && pl.confidence}`);
  assert.ok(!pl || pr.confidence > pl.confidence);
});

test('no-degrade: a RICH JSON-LD is not altered by a spec table on the same page', () => {
  const ld = { '@context': 'https://schema.org', '@type': 'Product', name: 'Officiel',
    gtin13: '1111111111116', brand: 'RealBrand', weight: '2 kg', image: 'https://x/o.jpg',
    offers: { price: '10', priceCurrency: 'EUR' } };
  const html = `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head>
    <body><table class="data-sheet"><tr><td>EAN</td><td>9999999999994</td></tr>
    <tr><td>Marque</td><td>WrongBrand</td></tr><tr><td>Poids</td><td>500 g</td></tr></table></body></html>`;
  const { product } = extractProduct(html, 'https://shop.test/p/o');
  assert.equal(product.gtin, '1111111111116');     // JSON-LD wins over the spec table
  assert.equal(product.brand, 'RealBrand');
  assert.equal(product.weightText, '2 kg');
});
