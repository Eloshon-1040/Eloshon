/**
 * schema.org microdata read by scope: a product page that also shows related
 * products as microdata tiles is still a product page, and a listing whose tiles
 * are microdata Products gives its cards (name, url, image, price from the offer).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { microdataItems, mainMicrodataProduct, microdataProducts, listingMicrodata } from '../extract/microdata.mjs';
import { classifyHtmlPage } from '../classify/page-kind.mjs';
import { extractListing } from '../../core/listing.mjs';

const tile = (i, price) => `
  <li class="ajax_block_product"><div itemscope itemtype="https://schema.org/Product">
    <a class="product_img_link" href="https://shop.test/engrais/${100 + i}-produit-${i}.html" itemprop="url"><img src="https://static.shop.test/${i}-home_default/p${i}.jpg" itemprop="image" /></a>
    <div class="content_price" itemprop="offers" itemscope itemtype="https://schema.org/Offer"><span class="price">${price}€</span>
      <meta itemprop="price" content="${price}"><meta itemprop="priceCurrency" content="EUR"><link itemprop="availability" href="https://schema.org/InStock" /></div>
    <h2 itemprop="name"><a href="https://shop.test/engrais/${100 + i}-produit-${i}.html" itemprop="url"> Produit ${i} &amp; co </a></h2>
  </div></li>`;

const productPage = `<html><head><title>Green 500ml</title></head><body>
  <div class="breadcrumb" itemscope itemtype="https://schema.org/BreadcrumbList"><span itemprop="itemListElement" itemscope itemtype="http://schema.org/ListItem"><span itemprop="name">Engrais</span></span></div>
  <div itemscope itemtype="https://schema.org/Product"><div id="product_details">
    <img id="bigpic" itemprop="image" src="https://static.shop.test/9-large_default/green.jpg">
    <h1 itemprop="name">Green 500ml - PLAGRON</h1>
    <span itemprop="sku">PGS0500</span>
    <div itemprop="offers" itemscope itemtype="https://schema.org/Offer"><span itemprop="price" content="79.66">79,66 €</span><meta itemprop="priceCurrency" content="EUR"></div>
    <button class="add-to-cart">Ajouter au panier</button>
  </div>
  <section class="accessories"><ul>${[1, 2, 3, 4, 5].map((i) => tile(i, 10 + i)).join('')}</ul></section>
  </div></body></html>`;

const listingPage = `<html><head><title>Engrais</title></head><body><h1>Engrais</h1><ul class="product_list">${[1, 2, 3, 4].map((i) => tile(i, 20 + i)).join('')}</ul></body></html>`;

test('items keep their nesting: offers belong to their product, the breadcrumb to itself', () => {
  const { items } = microdataItems(listingPage);
  const products = items.filter((x) => x.type === 'Product');
  assert.equal(products.length, 4);
  const offer = items.find((x) => x.type === 'Offer');
  assert.equal(items[offer.parent].type, 'Product');
  assert.equal(offer.prop, 'offers');
  assert.equal(products[0].props.name[0], 'Produit 1 & co');
});

test('a product page with related microdata tiles: its <h1> is in a Product → a product page', () => {
  assert.equal(mainMicrodataProduct(productPage), true);
  const v = classifyHtmlPage(productPage, { url: 'https://shop.test/engrais/9-green.html', extracted: { name: 'Green 500ml - PLAGRON', price: 79.66, sku: 'PGS0500' } });
  assert.equal(v.kind, 'product', JSON.stringify(v.reasons));
  assert.deepEqual(listingMicrodata(productPage, 'https://shop.test/engrais/9-green.html'), [], 'related tiles are not listing cards');
});

test('a listing of microdata tiles stays a listing and gives its cards', () => {
  assert.equal(mainMicrodataProduct(listingPage), false);
  const v = classifyHtmlPage(listingPage, { url: 'https://shop.test/12-engrais', extracted: { name: 'Engrais', price: 21 } });
  assert.equal(v.kind, 'listing');
  const cards = microdataProducts(listingPage, 'https://shop.test/12-engrais');
  assert.equal(cards.length, 4);
  assert.deepEqual(cards[1], {
    strategy: 'listing-microdata', name: 'Produit 2 & co',
    sourceUrl: 'https://shop.test/engrais/102-produit-2.html', canonicalUrl: 'https://shop.test/engrais/102-produit-2.html',
    images: ['https://static.shop.test/2-home_default/p2.jpg'], price: 22, currency: 'EUR', availability: 'InStock',
  });
  const L = extractListing(listingPage, 'https://shop.test/12-engrais');
  assert.equal(L.cards.length, 4);
  assert.ok(L.cards.every((c) => c.strategy === 'listing-microdata' && c.price > 20));
});

test('a product nested in another product (accessory, variant) is not a separate card', () => {
  const html = `<div itemscope itemtype="https://schema.org/Product"><span itemprop="name">A</span><a itemprop="url" href="/a.html"></a>
    <div itemprop="isAccessoryOrSparePartFor" itemscope itemtype="https://schema.org/Product"><span itemprop="name">Inner</span></div></div>
    <div itemscope itemtype="https://schema.org/Product"><span itemprop="name">B</span><a itemprop="url" href="/b.html"></a></div>`;
  const cards = microdataProducts(html, 'https://shop.test/');
  assert.deepEqual(cards.map((c) => c.name), ['A', 'B']);
});
