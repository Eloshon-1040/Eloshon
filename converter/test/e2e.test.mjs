/**
 * End-to-end (ÉTAPE 6), headless: the whole chain the brief asks for — one file
 * per source platform, at least one modified mapping, a template saved then
 * reapplied, a correction, an ignored problem, and a successful export to disk.
 * Runs the app controller + template store + engine directly (no Electron).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeMapping, analyzeIssues, runConversion } from '../app/controller.mjs';
import { createTemplateStore } from '../app/templates.mjs';

const FIX = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'test', 'fixtures');
const read = (n) => fs.readFileSync(path.join(FIX, n), 'utf8');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'elo-e2e-'));

test('e2e Shopify: modified mapping + template save/reapply + correction + ignore + export', async () => {
  const csv = read('shopify_products.csv');
  const direction = 'shopify-to-woocommerce', expectPlatform = 'shopify';

  // (1) analyze
  const a = await analyzeMapping(csv, direction);
  assert.equal(a.hasPlan, true);
  assert.equal(a.detection.format, 'shopify_products');

  // (2) modified mapping — exclude tags → the Woo "Tags" column is emptied
  const overrides = { tags: { column: null } };
  const base = runConversion({ csvText: csv, direction, expectPlatform });
  const mapped = runConversion({ csvText: csv, direction, expectPlatform, overrides });
  assert.ok(base.outputCsv.includes('femme, lin'), 'base carries tags');
  assert.ok(!mapped.outputCsv.includes('femme, lin'), 'excluded tags gone');

  // (3) template — save the override, reapply to the same headers
  const store = createTemplateStore(path.join(tmp(), 'templates.json'));
  const headers = csv.split(/\r\n|\n/)[0].split(',');
  const tpl = store.create({ name: 'E2E Mode', direction, sourceFormat: a.detection.format, targetFormat: a.targetFormat, entity: 'products', overrides, headers });
  const applied = store.applyTo(tpl.id, headers);
  assert.deepEqual(applied.overrides, overrides);
  assert.deepEqual(applied.missingColumns, []);

  // (4) correction — fix the blocking no-title product, export unblocks
  const iss1 = analyzeIssues(csv, direction, { overrides });
  const noTitle = iss1.problems.find((p) => p.code === 'no_title');
  assert.ok(noTitle, 'a blocking no_title exists');
  assert.equal(iss1.canExport, false);
  const corrections = { [noTitle.line]: { title: 'Produit corrigé' } };
  const iss2 = analyzeIssues(csv, direction, { overrides, corrections });
  assert.equal(iss2.problems.some((p) => p.code === 'no_title'), false, 'no_title fixed');
  assert.equal(iss2.canExport, true, 'export now allowed');

  // (5) ignore — a remaining warning drops out of the active list
  const warn = iss2.problems.find((p) => p.severity === 'warning' && p.ignorable);
  if (warn) {
    const iss3 = analyzeIssues(csv, direction, { overrides, corrections, ignored: [warn.id] });
    assert.equal(iss3.problems.some((p) => p.id === warn.id), false);
    assert.equal(iss3.ignored.some((p) => p.id === warn.id), true);
  }

  // (6) export — the corrected value is written, file lands on disk
  const out = runConversion({ csvText: csv, direction, expectPlatform, overrides, corrections });
  assert.ok(out.ok);
  assert.ok(out.outputCsv.includes('Produit corrigé'), 'correction is in the exported file');
  const dir = tmp();
  const outFile = path.join(dir, 'export.csv');
  fs.writeFileSync(outFile, out.outputCsv);
  assert.ok(fs.existsSync(outFile) && fs.statSync(outFile).size > 0);
});

// One file per remaining source platform: a modified mapping that changes the
// output, plus a successful export to disk.
const CASES = [
  { name: 'WooCommerce', fixture: 'woo_products_modern.csv', direction: 'woocommerce-to-shopify', expectPlatform: 'woocommerce', field: 'tags', marker: 'hiver' },
  { name: 'Wix', fixture: 'wix_products.csv', direction: 'wix-to-shopify', expectPlatform: 'wix', field: 'vendor', marker: 'Maroquinerie' },
  { name: 'BigCommerce', fixture: 'bigcommerce_products.csv', direction: 'bigcommerce-to-shopify', expectPlatform: 'bigcommerce', field: 'cost', marker: '90.00' },
];
for (const c of CASES) {
  test(`e2e ${c.name}: modified mapping changes output + export to disk`, async () => {
    const csv = read(c.fixture);
    const a = await analyzeMapping(csv, c.direction);
    assert.equal(a.hasPlan, true);
    const base = runConversion({ csvText: csv, direction: c.direction, expectPlatform: c.expectPlatform });
    const mapped = runConversion({ csvText: csv, direction: c.direction, expectPlatform: c.expectPlatform, overrides: { [c.field]: { column: null } } });
    assert.ok(base.ok && mapped.ok);
    assert.ok(base.outputCsv.includes(c.marker), `base carries ${c.field}`);
    assert.ok(!mapped.outputCsv.includes(c.marker), `excluded ${c.field} gone from output`);
    const outFile = path.join(tmp(), 'export.csv');
    fs.writeFileSync(outFile, mapped.outputCsv);
    assert.ok(fs.existsSync(outFile) && fs.statSync(outFile).size > 0);
  });
}
