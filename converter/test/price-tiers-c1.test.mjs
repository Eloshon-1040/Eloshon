// Phase 6 (C1) — quantity / rule price tiers: one canon form (variants[].priceTiers)
// built by one generic transform (price_tiers) for the three native forms —
// Shopware product_price (observed, real fixture), PrestaShop specific_price
// (observed rows, real fixture, through the transform), BigCommerce
// bulk_pricing_rules / price-list tiers (the field is native on every real
// product but empty on the trial store — item shape from the reference, hence
// the `inferred` confidence in the future entry). Every CSV target reports a
// uniform loss_<target>_price_tiers and keeps the variant's single price.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as engine from '../core/dist/index.mjs';
import { TRANSFORMS } from '../core/knowledge-proposal/transforms.mjs';
import { parseWithKnowledge } from '../core/knowledge-proposal/generic-parser.mjs';
import { loadReferenceFormatsSync, loadCanonCatalogSync } from '../core/knowledge-proposal/reference.mjs';

const { convertFromCanon, parseShopwareAdminJson } = engine;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const J = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/live', rel), 'utf8'));
const tiers = TRANSFORMS.price_tiers;

test('Shopware (real): product_price rows → variants[].priceTiers with absolute gross prices, rule and currency scope; the single price stays the base', () => {
  const { products } = parseShopwareAdminJson({ products: J('shopware-test/products.json'), variations: J('shopware-test/variations.json') });
  const p = products.find((x) => x.handle === 'SWDEMO10002');
  const v = p.variants[0];
  assert.equal(v.price, 950);
  assert.deepEqual(v.priceTiers, [
    { minQuantity: 12, price: 750, scope: { ruleRef: '28caae75a5624f0d985abd0eb32aa160', currency: 'b7d2554b0ce847cd82f3ac9bd1c0dfca' } },
    { minQuantity: 1, maxQuantity: 11, price: 800, scope: { ruleRef: '28caae75a5624f0d985abd0eb32aa160', currency: 'b7d2554b0ce847cd82f3ac9bd1c0dfca' } },
  ]);
  assert.equal(v.provenance.priceTiers.transform, 'price_tiers');
  assert.equal(p.sourceExtension.shopware.prices.length, 2, 'raw matrix kept (product scope)');
  for (const q of products.filter((x) => x.handle !== 'SWDEMO10002')) for (const x of q.variants) assert.equal(x.priceTiers, undefined, 'no tiers → no key');
  // real fixture with the same entry (products-i18n) — no prices on that family
  const i18n = parseShopwareAdminJson({ products: J('shopware-test/products-i18n.json'), variations: J('shopware-test/variations-i18n.json') });
  for (const x of i18n.products[0].variants) assert.equal(x.priceTiers, undefined);
});

test('PrestaShop (real rows): specific_prices → reduction tiers; the from_quantity=1 unscoped rows are the ordinary promo, not tiers', () => {
  const rows = J('prestashop-test/specific_prices.json').filter((r) => String(r.id_product) === '1');
  assert.equal(rows.length, 2, 'fixture: the −20 % promo row and the seeded 10+ tier');
  const args = {
    min: 'from_quantity', price: 'price', emptyValues: [0, '0', -1, '-1', '-1.000000', '', null],
    reduction: { type: 'reduction_type', value: 'reduction', taxIncluded: 'reduction_tax', typeMap: { amount: 'amount', percentage: 'percentage' } },
    scope: { customerGroupRef: 'id_group', customerRef: 'id_customer', currency: 'id_currency', country: 'id_country', storeRef: 'id_shop', ruleRef: 'id_specific_price_rule' },
    period: { from: 'from', to: 'to' },
  };
  const out = tiers(rows, { args });
  assert.deepEqual(out, [{ minQuantity: 10, reduction: { type: 'percentage', value: 0.15, taxIncluded: true }, scope: { storeRef: '1' } }]);
  // a group-scoped row with from_quantity 1 IS a tier (customer-group price); a fixed-price row carries `price`
  const scoped = tiers([{ ...rows[0], id_group: 3, from_quantity: 1 }, { ...rows[0], price: '19.900000', reduction: '0.000000', from_quantity: 5 }], { args });
  assert.deepEqual(scoped, [
    { minQuantity: 1, reduction: { type: 'percentage', value: 0.2, taxIncluded: true }, scope: { customerGroupRef: '3' } },
    { minQuantity: 5, price: 19.9 },
  ]);
  // period rows: zero dates ignored, real dates carried
  const dated = tiers([{ ...rows[1], from: '2026-11-20 00:00:00', to: '2026-11-30 23:59:59' }], { args: { ...args, period: { from: 'from', to: 'to', assumeUtc: true } } });
  assert.deepEqual(dated[0].period, { from: '2026-11-20T00:00:00.000Z', to: '2026-11-30T23:59:59.000Z' });
});

test('BigCommerce (native field, empty on the real store; item shape from the reference): bulk_pricing_rules type price / percent / fixed → the same canon', () => {
  const real = J('bigcommerce-test/products.json');
  assert.ok(real.every((p) => Array.isArray(p.bulk_pricing_rules)), 'the field is native on every real product');
  assert.ok(real.every((p) => p.bulk_pricing_rules.length === 0), 'no rule on the trial store (read-only token: nothing seeded)');
  const args = { min: 'quantity_min', max: 'quantity_max', typed: { type: 'type', amount: 'amount', map: { price: 'price', percent: 'percentage', fixed: 'amount' } } };
  const out = tiers([
    { id: 1, quantity_min: 10, quantity_max: 49, type: 'percent', amount: 10 },
    { id: 2, quantity_min: 50, quantity_max: 0, type: 'price', amount: 39.9 },
    { id: 3, quantity_min: 100, quantity_max: 0, type: 'fixed', amount: 5 },
  ], { args });
  assert.deepEqual(out, [
    { minQuantity: 10, maxQuantity: 49, reduction: { type: 'percentage', value: 10 } },
    { minQuantity: 50, price: 39.9 },
    { minQuantity: 100, reduction: { type: 'amount', value: 5 } },
  ]);
  assert.equal(tiers([], { args }), undefined);
});

test('targets: the variant keeps its single price everywhere; tiers are a uniform loss with count / products / handles; nothing without tiers', () => {
  const { products } = parseShopwareAdminJson({ products: J('shopware-test/products.json'), variations: J('shopware-test/variations.json') });
  const expected = { 'shopware-to-shopify': 'loss_shopify_price_tiers', 'shopware-to-woocommerce': 'loss_woo_price_tiers', 'shopware-to-wix': 'loss_wix_price_tiers', 'shopware-to-bigcommerce': 'loss_bc_price_tiers' };
  for (const [direction, code] of Object.entries(expected)) {
    const res = convertFromCanon(products, { direction, expectPlatform: 'shopware' }, 'x');
    assert.deepEqual(res.losses.find((l) => l.code === code), { code, params: { count: 2, products: 1, handles: 'SWDEMO10002' } }, direction);
    const cells = res.rows.flatMap((r) => Object.values(r));
    assert.ok(!cells.some((c) => c === '750' || c === '800' || c === '750.00' || c === '800.00'), 'tier prices never leak into a cell');
  }
  const none = convertFromCanon(products.filter((p) => p.handle !== 'SWDEMO10002'), { direction: 'shopware-to-woocommerce', expectPlatform: 'shopware' }, 'x');
  assert.ok(!none.losses.some((l) => /_price_tiers$/.test(l.code)));
});

test('transform contract: nothing / non-array → undefined; a row that changes nothing is not a tier; min below 1 is clamped', () => {
  assert.equal(tiers(undefined, { args: {} }), undefined);
  assert.equal(tiers([{ quantityStart: 5 }], { args: {} }), undefined, 'no price, no reduction');
  assert.deepEqual(tiers([{ quantityStart: 0, price: { 0: { gross: 9 } } }], { args: { price: 'price.0.gross', requireTierOrScope: false } }), [{ minQuantity: 1, price: 9 }]);
});
