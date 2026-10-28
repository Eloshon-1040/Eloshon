/**
 * A platform with no serializer must be refused, never answered with another
 * platform's CSV and ok:true (audit: shopify-to-shopware returned a Shopify CSV).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convert } from '../core/dist/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shopifyCsv = fs.readFileSync(path.join(ROOT, 'test/fixtures/shopify_products.csv'), 'utf8');

for (const target of ['shopware', 'prestashop', 'bigbuy', 'eloshon']) {
  test(`shopify → ${target} is refused with an explicit reason`, () => {
    const r = convert(shopifyCsv, { direction: `shopify-to-${target}`, expectPlatform: 'shopify' });
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].code, 'impossible_target_unsupported');
    assert.equal(r.rows.length, 0, 'no CSV may be produced for an unsupported target');
  });
}

test('the four supported targets still convert', () => {
  for (const target of ['woocommerce', 'wix', 'bigcommerce']) {
    const r = convert(shopifyCsv, { direction: `shopify-to-${target}`, expectPlatform: 'shopify' });
    assert.equal(r.ok, true, target);
  }
});
