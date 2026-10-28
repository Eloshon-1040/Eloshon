/**
 * Grocery net quantity from a unit-price reference ("150 g - 11,93 €/kg").
 * The trailing "<price> <currency>/<unit>" is the safety anchor: nutrition
 * tables (no price) must NOT match. Generic — no site names.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weightFromUnitPrice } from '../dom-fallback.mjs';
import { extractProduct } from '../extract.mjs';

test('weightFromUnitPrice: quantity glued to a €/unit reference price', () => {
  assert.equal(weightFromUnitPrice('…150 g - 11,93 EUR/kg…'), '150 g');
  assert.equal(weightFromUnitPrice('<span>1,5 kg — 2,66 € / kg</span>'), '1,5 kg');
  assert.equal(weightFromUnitPrice('75 cl - 5,32 €/l'), '75 cl');
});

test('weightFromUnitPrice: nutrition values (no reference price) are NOT matched', () => {
  assert.equal(weightFromUnitPrice('Protéines 4,0 g · Sel 20 g'), null);
  assert.equal(weightFromUnitPrice('poids introuvable'), null);
  assert.equal(weightFromUnitPrice(''), null);
});

test('extractProduct: net quantity recovered when JSON-LD/spec carry no weight', () => {
  const html = `<html><head>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Lard fumé","sku":"10030593","brand":{"name":"DULANO"},"offers":{"@type":"Offer","price":"1.79","priceCurrency":"EUR"}}</script>
    </head><body><!--[-->150 g - 11,93 EUR/kg<!--]--></body></html>`;
  const p = (extractProduct(html, 'https://x/p/y') || {}).product || {};
  assert.equal(p.weightText, '150 g');
  assert.equal(p.sku, '10030593');
});
