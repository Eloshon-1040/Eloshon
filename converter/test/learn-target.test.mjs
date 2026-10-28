/**
 * « Apprendre ce format » (unknown file): each proposal says where it lands in the target file. Before, the learn
 * analysis carried no target at all and the screen tested the SOURCE plan's re-pointable rules (none for an unknown
 * file): every proposal — SKU and Title included — said « ce champ n’est pas repris par la cible Shopify ».
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeMapping } from '../app/controller.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSV = fs.readFileSync(path.join(ROOT, 'test/fixtures/supplier_fr.csv'), 'utf8');

test('learn mode knows the target and where SKU and Title land (Shopify and WooCommerce)', async () => {
  const cases = { 'eloshon-to-shopify': { sku: ['Variant SKU'], title: ['Title'] }, 'eloshon-to-woocommerce': { sku: ['SKU'], title: ['Name'] } };
  for (const [direction, want] of Object.entries(cases)) {
    const a = await analyzeMapping(CSV, direction, {}, { semantic: true, decisions: [] });
    assert.ok(a.learn, `${direction}: learn mode`);
    assert.ok(a.learn.targetFormat, `${direction}: target format given`);
    for (const [canon, cols] of Object.entries(want)) assert.deepEqual(a.learn.targetCols[canon], cols, `${direction}: ${canon}`);
    // The proposals of this file include SKU (« Référence ») and Title (« Désignation »).
    const top = (col) => a.learn.semantic.columns.find((c) => c.column === col).candidates[0].canon;
    assert.equal(top('Référence'), 'sku'); assert.equal(top('Désignation'), 'title');
    // A field the target has no column for is still said to be not carried.
    assert.deepEqual(a.learn.targetCols['identifiers.mpn'], [], `${direction}: identifiers.mpn has no column`);
  }
});

test('the step-3 screen says « not carried » from the target columns of each destination', () => {
  const app = fs.readFileSync(path.join(ROOT, 'app/renderer/app.js'), 'utf8');
  assert.match(app, /d\.carried \? `<span class="platcol">/);
  assert.match(app, /t\('s3n_not_carried', \{ tgt: tgtName\(\) \}\)/);
  assert.ok(!/s3_cand_no_rule/.test(app), 'the old rule-based message is gone');
});
