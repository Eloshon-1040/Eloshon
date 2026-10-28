/**
 * Phase 1 step 1 — the step-4 export gate must see the SAME detection surface
 * as the earlier wizard steps: Reference ⊕ Learned ⊕ json-shape. Regression
 * guarded here: a user-taught Learned format and a Shopware/PrestaShop/REST
 * JSON drop both converted fine in step 3 but analyzeProblems re-detected with
 * Reference CSV formats only → ok:false, canExport:false → the step-4
 * "Continue" button refused exactly the flagship input paths.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  convert, parseCsv, analyzeProblems, semanticAnalyze, learnFormat, proposeFormatId,
} from '../core/dist/index.mjs';
import { analyzeIssues } from '../app/controller.mjs';
import { loadReferenceFormatsSync } from '../core/knowledge-proposal/reference.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// An unknown supplier CSV taught in step 3 — the same pipeline the app's
// kb:learn IPC uses (semantic report → learnFormat → Learned strata).
const supplierCsv = ['Référence;Désignation;Prix de vente;Code EAN;Stock disponible',
  'F-001;Table basse chêne;129,90;3701234567890;12',
  'F-002;Chaise scandinave;59,00;3701234567906;0'].join('\n');

function learnSupplierFormat() {
  const table = parseCsv(supplierCsv);
  const id = proposeFormatId(table.headers, { provenance: 'unknown', hint: 'csv' });
  const report = semanticAnalyze(table.headers, table.rows, 'products', { formatId: id, decisions: [] });
  return learnFormat({ headers: table.headers, report, id, hint: 'Fournisseur X', provenance: 'unknown', platform: 'eloshon', by: 'user' });
}

test('step-4 gate: a learned format that converts in step 3 may export in step 4', () => {
  const learned = learnSupplierFormat();
  const formats = [...loadReferenceFormatsSync(), learned];

  // Step 3 works (the file converts through the Learned snapshot)…
  const conv = convert(supplierCsv, { direction: 'eloshon-to-shopify', expectPlatform: 'eloshon', knowledge: { formats } });
  assert.equal(conv.ok, true, JSON.stringify(conv.errors));

  // …so step 4 (same snapshot) must never re-detect it as unknown.
  const gate = analyzeProblems(supplierCsv, { direction: 'eloshon-to-shopify', formats });
  assert.equal(gate.ok, true, 'the gate recognises the learned format');
  assert.equal(gate.canExport, true, 'no phantom blocker on a learned format');
  assert.equal(gate.sourceFormat, 'knowledge');

  // The controller surface the app calls forwards the snapshot unchanged.
  const viaController = analyzeIssues(supplierCsv, 'eloshon-to-shopify', { formats });
  assert.equal(viaController.canExport, true);

  // Without the snapshot the format is genuinely unknown — detection is not
  // weakened, it is widened to what the user actually taught.
  const withoutSnapshot = analyzeProblems(supplierCsv, { direction: 'eloshon-to-shopify' });
  assert.equal(withoutSnapshot.ok, false);
  assert.equal(withoutSnapshot.canExport, false);
});

test('step-4 gate: a JSON drop (WooCommerce REST dump) may export in step 4', () => {
  const json = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'live', 'woocommerce-test', 'products.json'), 'utf8');

  // Step 3 works (tryJsonConvert routes it through the knowledge parser)…
  const conv = convert(json, { direction: 'woocommerce-to-shopify', expectPlatform: 'woocommerce' });
  assert.equal(conv.ok, true, JSON.stringify(conv.errors));

  // …so the gate (reference json-shape signatures) must let it through too.
  const gate = analyzeProblems(json, { direction: 'woocommerce-to-shopify' });
  assert.equal(gate.ok, true, 'the gate recognises the JSON drop');
  assert.equal(gate.canExport, true, 'no phantom blocker on a JSON drop');
  assert.equal(gate.entity, 'products');
});

test('step-4 gate: genuinely unknown files are still refused', () => {
  const unknownCsv = 'colA,colB\n1,2\n';
  const csvGate = analyzeProblems(unknownCsv, { direction: 'shopify-to-woocommerce' });
  assert.equal(csvGate.ok, false);
  assert.equal(csvGate.canExport, false);

  const unknownJson = '[{"zzz": 1, "yyy": "x"}]';
  const jsonGate = analyzeProblems(unknownJson, { direction: 'shopify-to-woocommerce' });
  assert.equal(jsonGate.ok, false);
  assert.equal(jsonGate.canExport, false);
});
