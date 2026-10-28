/**
 * Increment 4 — generic DOM/text fallback for detail pages with NO structured
 * data. Conservative + low-confidence, last resort only. Pure, offline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractProduct } from '../extract.mjs';
import { extractFromDom } from '../dom-fallback.mjs';

const bare = (body) => `<html><head><title>Boutique</title></head><body>${body}</body></html>`;

test('dom: h1 + price-class element → name + price + currency (no structured data)', () => {
  const html = bare('<h1>Marteau de charpentier 500g</h1><div class="product-price"><span>€</span> 24,90</div>');
  const { product, strategies, needsBrowser } = extractProduct(html, 'https://diy/p/1');
  assert.equal(product.name, 'Marteau de charpentier 500g'); // h1 beats <title>
  assert.equal(product.price, 24.9);
  assert.equal(product.currency, 'EUR');
  assert.ok(strategies.includes('generic-dom'));
  assert.equal(needsBrowser, false);
});

test('dom: data-price attribute is used', () => {
  const html = bare('<h1>Vis inox 4x40 (x100)</h1><button data-product-price="8.75" data-currency="EUR">Ajouter</button>');
  const { product } = extractProduct(html, 'https://diy/p/2');
  assert.equal(product.price, 8.75);
  assert.equal(product.currency, 'EUR');
});

test('dom: EU thousand format parsed correctly', () => {
  assert.equal(extractFromDom('<h1>X</h1><span class="price">1.299,00 €</span>').price, 1299);
  assert.equal(extractFromDom('<h1>X</h1><span class="price">1 299,00 €</span>').price, 1299);
});

test('dom: NOT used when structured data already yields a usable product', () => {
  const ld = { '@context': 'https://schema.org', '@type': 'Product', name: 'Officiel', offers: { price: '5.00', priceCurrency: 'EUR' } };
  const html = `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body><h1>Autre</h1><span class="price">999,99 €</span></body></html>`;
  const { product, strategies } = extractProduct(html, 'https://x/p/3');
  assert.equal(product.name, 'Officiel');
  assert.equal(product.price, 5);
  assert.ok(!strategies.includes('generic-dom'));
});

test('dom: listing-like page (many price cells) is not mistaken for a product', () => {
  const cards = Array.from({ length: 12 }, (_, i) => `<div class="price">${i + 1},99 €</div>`).join('');
  assert.equal(extractFromDom(`<h1>Catégorie</h1>${cards}`), null);
});

test('dom: a bare number outside any price element is never taken as a price', () => {
  const html = bare('<h1>Guide</h1><p>Livraison en 4,99 jours ouvrés</p><p>Voir 12 avis</p>');
  assert.equal(extractFromDom(html), null);     // no currency-qualified price in a price element
  const { product } = extractProduct(html, 'https://x/p/4');
  assert.equal(product.price, null);            // no false price invented
  assert.equal(product.name, 'Boutique');       // falls back to <title> (dom is price-gated → no h1 name)
});

test('dom: returns null when no price signal at all', () => {
  assert.equal(extractFromDom('<html><body><h1>Juste un titre</h1></body></html>'), null);
});
