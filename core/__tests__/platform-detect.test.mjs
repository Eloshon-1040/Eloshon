/**
 * Item B — WooCommerce detection must be robust so a WooCommerce host (frenchtoday.com)
 * routes to the Store-API lane instead of falling to the generic DOM card detector
 * (which produced concatenated names / crossed-out prices / placeholder images).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform } from '../platform.mjs';

test('detectPlatform: WooCommerce via generator meta / wp-json / body class / assets', () => {
  assert.equal(detectPlatform('<meta name="generator" content="WooCommerce 8.6.1">'), 'woocommerce');
  assert.equal(detectPlatform('<link href="https://x/wp-json/wc/store/v1/products">'), 'woocommerce');
  assert.equal(detectPlatform('<body class="home woocommerce-no-js">'), 'woocommerce');
  assert.equal(detectPlatform('<script src="/wp-content/plugins/woocommerce/assets/x.js">'), 'woocommerce');
});
test('detectPlatform: Shopify only on unambiguous signals', () => {
  assert.equal(detectPlatform('<script src="https://cdn.shopify.com/s/x.js">'), 'shopify');
  assert.equal(detectPlatform('<link href="https://shop.myshopify.com">'), 'shopify');
  assert.equal(detectPlatform('<script>window.Shopify={};</script>'), 'shopify');
  assert.equal(detectPlatform('<html><body><h1>Hello</h1></body></html>'), null);
});
test('Part 0: a WooCommerce page merely MENTIONING shopify is not misclassified as Shopify', () => {
  // adoboloco.com / frenchtoday.com are WooCommerce; a "shopify" word (payment
  // gateway, blog) must not win over the WooCommerce markers.
  const woo = '<meta name="generator" content="WooCommerce 8.6"><p>cheaper than Shopify</p><a href="/shop/x">x</a>';
  assert.equal(detectPlatform(woo), 'woocommerce');
  assert.equal(detectPlatform('<html><body>We compared "shopify" vs woo</body></html>'), null, 'bare word alone → not Shopify');
});
