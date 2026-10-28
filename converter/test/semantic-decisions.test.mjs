/**
 * Phase 5.6 — controller-level decision loop (headless): analyzeMapping with a
 * KnowledgeStore applies Learned decisions on re-analysis; confirm / reject /
 * ignore / forget behave as the UI expects. Uses a tmp Learned dir.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeMapping } from '../app/controller.mjs';
import { createJsonKnowledgeStore } from '../core/knowledge-proposal/json-store.mjs';
import { makeDecision } from '../core/knowledge-proposal/semantic.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const csv = ['Handle,Libellé,Fabricant,Variant SKU,Variant Price,Code EAN,Quantité en stock,Colonne mystère',
  't-shirt,T-shirt bio,Eloshon,TS-S,19.90,3701234567890,10,abc',
  't-shirt,,,TS-M,19.90,3701234567906,4,def',
  'mug,Mug émaillé,Lumo,MUG-1,12.00,3701234567913,25,ghi'].join('\n');
const direction = 'shopify-to-woocommerce';

function makeStore() {
  const learnedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-ctl-'));
  return createJsonKnowledgeStore({ referenceDir: path.join(ROOT, 'core', 'knowledge-ref'), learnedDir });
}
const col = (a, name) => a.plan.semantic.columns.find((c) => c.column === name);

test('semantic off: plan unchanged (no semantic key); on: candidates + pre-filled suggestions', async () => {
  const store = makeStore();
  const off = await analyzeMapping(csv, direction);
  assert.equal(off.plan.semantic, undefined);
  const on = await analyzeMapping(csv, direction, {}, { semantic: true, store });
  assert.ok(on.plan.semantic);
  assert.equal(on.detection.knowledgeId, 'shopify.products.csv.v1');
  assert.equal(on.plan.suggestedOverrides.title?.column, 'Libellé');
  assert.equal(on.plan.suggestedOverrides.vendor?.column, 'Fabricant');
  assert.equal(on.plan.ruleByCanon.title, 'title');
  assert.equal(col(on, 'Colonne mystère').status, 'none', 'nothing plausible → none, kept as-is');
});

test('decisions round trip through the store: confirm, reject, ignore, forget', async () => {
  const store = makeStore();
  const fid = 'shopify.products.csv.v1';
  const opts = { semantic: true, store };
  // reject the top candidate of "Quantité en stock"
  const a0 = await analyzeMapping(csv, direction, {}, opts);
  const qty = col(a0, 'Quantité en stock');
  assert.equal(qty.best.canon, 'inventoryQty');
  await store.recordDecision(makeDecision({ formatId: fid, column: 'Quantité en stock', action: 'rejected', canon: 'inventoryQty', scope: { kind: 'format', id: fid } }));
  const a1 = await analyzeMapping(csv, direction, {}, opts);
  assert.ok(!col(a1, 'Quantité en stock').candidates.some((c) => c.canon === 'inventoryQty'), 'rejected candidate gone');
  assert.equal(a1.plan.suggestedOverrides.inventoryQty, undefined, 'and no longer pre-filled');

  // confirm a corrected target for "Code EAN" (say the user maps it to sku)
  await store.recordDecision(makeDecision({ formatId: fid, column: 'Code EAN', action: 'corrected', canon: 'sku', scope: { kind: 'format', id: fid } }));
  const a2 = await analyzeMapping(csv, direction, {}, opts);
  assert.equal(col(a2, 'Code EAN').status, 'decided');
  assert.equal(col(a2, 'Code EAN').best.canon, 'sku');
  assert.equal(col(a2, 'Code EAN').best.confidence, 'user-corrected');

  // ignore "Colonne mystère"
  await store.recordDecision(makeDecision({ formatId: fid, column: 'Colonne mystère', action: 'ignored', scope: { kind: 'format', id: fid } }));
  const a3 = await analyzeMapping(csv, direction, {}, opts);
  assert.equal(col(a3, 'Colonne mystère').status, 'ignored');

  // forget = a later `proposed` resets the column
  await store.recordDecision(makeDecision({ formatId: fid, column: 'Quantité en stock', action: 'proposed', reason: 'forget', scope: { kind: 'format', id: fid } }));
  const a4 = await analyzeMapping(csv, direction, {}, opts);
  assert.equal(col(a4, 'Quantité en stock').best.canon, 'inventoryQty', 'rejection lifted');

  // decisions are per format: another format id sees nothing
  const other = await analyzeMapping(csv, direction, {}, { semantic: true, decisions: await store.listDecisions('woocommerce.products.csv.modern.v1') });
  assert.equal(col(other, 'Code EAN').status, 'auto');
});
