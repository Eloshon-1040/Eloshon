/**
 * Job 20260929222644-dm2zb regression: the extension's internal_api extractor
 * used to return `r.products || []` and DROP the lane's error, so a failed recipe
 * ended "done, 0 products, no reason". laneProducts() must surface it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { laneProducts } from '../../extension/background/program.mjs';
import { runProgram } from '../../shared/dsl/interpret.mjs';

const recipe = { vars: { placeId: {}, categoryId: {} } };

test('lane error + no product → throws with the lane reason (no silent "done")', () => {
  const diag = {};
  assert.throws(() => laneProducts({ ok: false, products: [], vars: { placeId: '604' }, error: 'var categoryId: not found on https://x.test/fr/produits' }, recipe, diag), /categoryId: not found/);
  assert.deepEqual(diag.varsResolved, ['placeId']);
  assert.deepEqual(diag.varsMissing, ['categoryId']);
  assert.match(diag.laneError, /categoryId/);
});

test('diag carries NAMES only, never a var value', () => {
  const diag = {};
  laneProducts({ ok: true, products: [{ name: 'A' }], vars: { placeId: 'SECRET-604', categoryId: '379' } }, recipe, diag);
  assert.ok(!JSON.stringify(diag).includes('SECRET-604'));
  assert.ok(!JSON.stringify(diag).includes('379'));
});

test('partial products + an error → products kept, error remembered', () => {
  const diag = {};
  const out = laneProducts({ ok: true, products: [{ name: 'A' }, { name: 'B' }], vars: {}, error: 'HTTP 456' }, recipe, diag);
  assert.equal(out.length, 2);
  assert.equal(diag.laneError, 'HTTP 456');
});

test('ok:false without an error message and no product still fails loudly', () => {
  assert.throws(() => laneProducts({ ok: false, products: [] }, recipe, {}), /aucun résultat/);
});

test('through the interpreter: a failing internal_api lane ends the job in ERROR with the reason', async () => {
  const page = { context: async () => ({ url: 'https://x.test/fr/produits', status: 200, body: '' }), waitFor: async () => true };
  const extractors = { internal_api: async () => laneProducts({ ok: false, products: [], vars: {}, error: 'var categoryId: not found on https://x.test/fr/produits' }, recipe, {}) };
  const out = await runProgram({ actions: [{ op: 'extract', using: 'internal_api' }] }, { page, extractors, now: () => 0, sleep: async () => {} });
  assert.equal(out.status, 'error');
  assert.match(out.reason, /categoryId: not found/);
});
