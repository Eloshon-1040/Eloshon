// Phase 5 (28/10/2026) — the Scraper's « cases personnalisées » (its own columns « Taille », « Sous-titre »… and, on a
// target with no Type column, the product type) are never lost: each one is placed per platform where the user chose
// once at step 3 (core/src/custom-fields.ts), else where it is kept by default; the choice is remembered per platform
// (config.json) and in the mapping template. Before: a products.json `raw.columns.taille` was dropped on every target.
// Verified 28/10 in the official docs: WooCommerce's « Type » takes simple / variable / grouped / external only (a free
// type goes to Categories, Tags or an attribute); Wix's V3 product CSV has no type column and no info-section column.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convert } from '../core/dist/index.mjs';
import { sanitizeCustomTargets } from '../app/custom-targets.mjs';
import { createTemplateStore } from '../app/templates.mjs';

const np = (id) => ({
  name: `Samba ${id}`, source_product_id: `S-${id}`, source_url: `https://shop.test/p/${id}`, image_url: 'https://img.test/a.jpg', images: ['https://img.test/a.jpg'],
  store_slug: 'shop', hs_code: null, price: 100, description: 'Une chaussure.', product_type: 'Chaussures hommes', source_category: 'Chaussures',
  raw: { brand: 'Adidas', columns: { taille: '40 | 41 | 42', sous_titre: 'Femmes Originals' } }, variants: [],
});
const FILE = JSON.stringify([np('A'), np('B')]);
const run = (tgt, customTargets) => { const r = convert(FILE, { direction: `eloshon-to-${tgt}`, expectPlatform: 'eloshon', ...(customTargets ? { customTargets } : {}) }); assert.equal(r.ok, true, JSON.stringify(r.errors)); return r; };
const cols = (r, value) => [...new Set(r.rows.flatMap((row) => Object.entries(row).filter(([, v]) => String(v).includes(value)).map(([k]) => k)))];

test('nothing of the Scraper\'s own columns is lost by default, on any platform', () => {
  const shop = run('shopify');
  assert.deepEqual(cols(shop, '40 | 41 | 42'), ['taille (product.metafields.custom.taille)']);
  assert.deepEqual(cols(shop, 'Femmes Originals'), ['sous_titre (product.metafields.custom.sous_titre)']);
  assert.deepEqual(cols(shop, 'Chaussures hommes'), ['Type'], 'Shopify keeps its own Type column');
  const woo = run('woocommerce');
  assert.deepEqual(cols(woo, '40 | 41 | 42'), ['Attribute 1 value(s)']); assert.deepEqual(cols(woo, 'Chaussures hommes'), ['Attribute 3 value(s)']);
  assert.ok(woo.rows.some((r) => r['Attribute 3 name'] === 'Type'), 'WooCommerce has no free product type: an attribute « Type »');
  const wix = run('wix');
  assert.deepEqual(cols(wix, 'Femmes Originals'), ['plainDescription']);
  assert.ok(wix.rows.some((r) => /chaussures-hommes/.test(r.categorySlugs || '')), 'Wix has no type column: a category');
  const bc = run('bigcommerce');
  assert.deepEqual(cols(bc, 'Chaussures hommes'), ['Description']);
  assert.deepEqual(run('wix').customFields.map((f) => [f.key, f.target, f.chosen, f.products]), [['taille', 'description', false, 2], ['sous_titre', 'description', false, 2], ['__product_type', 'category', false, 2]]);
});

test('the place chosen per platform is used; a place the platform does not offer is not', () => {
  const choices = { shopify: { taille: 'tags' }, woocommerce: { sous_titre: 'meta', __product_type: 'category' }, wix: { taille: 'ignore', __product_type: 'ribbon', sous_titre: 'metafield' } };
  const shop = run('shopify', choices);
  assert.deepEqual(cols(shop, '40 | 41 | 42'), ['Tags']);
  const woo = run('woocommerce', choices);
  assert.deepEqual(cols(woo, 'Femmes Originals'), ['Meta: sous_titre']); assert.deepEqual(cols(woo, 'Chaussures hommes'), ['Categories']);
  const wix = run('wix', choices);
  assert.deepEqual(cols(wix, '40 | 41 | 42'), [], 'ignored: the user chose it, and it is listed with that choice');
  assert.deepEqual(cols(wix, 'Chaussures hommes'), ['ribbon']);
  assert.deepEqual(cols(wix, 'Femmes Originals'), ['plainDescription'], 'Wix has no metafield: the default place');
  assert.deepEqual(wix.customFields.map((f) => [f.key, f.target, f.chosen]), [['taille', 'ignore', true], ['sous_titre', 'description', false], ['__product_type', 'ribbon', true]]);
  // Step 3 marks the default place on every row, chosen or not, and lists the places in one order on every row.
  assert.deepEqual(wix.customFields.map((f) => [f.key, f.fallback]), [['taille', 'description'], ['sous_titre', 'description'], ['__product_type', 'category']]);
  for (const r of [shop, woo, wix]) {
    const [first, ...rest] = r.customFields;
    for (const f of rest) assert.deepEqual(f.choices.filter((c) => first.choices.includes(c)), first.choices.filter((c) => f.choices.includes(c)), `${f.key}: same order as ${first.key}`);
  }
});

test('the remembered places are validated, and travel in the mapping template', () => {
  assert.deepEqual(sanitizeCustomTargets({ shopify: { taille: 'tags', 'Bad Key': 'tags', x: 'nowhere' }, magento: { a: 'tags' }, wix: 'no' }), { shopify: { taille: 'tags' } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elo-ct-'));
  const store = createTemplateStore(path.join(dir, 'templates.json'));
  const tpl = store.create({ name: 'Adidas → Wix', direction: 'eloshon-to-wix', sourceFormat: 'scraper.products-json.v2', targetFormat: 'wix_products', entity: 'products', headers: ['name'], customTargets: { wix: { __product_type: 'ribbon', taille: 'evil' } } });
  assert.deepEqual(tpl.customTargets, { wix: { __product_type: 'ribbon' } });
  assert.deepEqual(store.applyTo(tpl.id, ['name']).customTargets, { wix: { __product_type: 'ribbon' } });
});
