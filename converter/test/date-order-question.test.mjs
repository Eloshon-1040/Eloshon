/**
 * Phase 1 step 4 — the ambiguous date-order question must be answerable.
 * Regression guarded: the engine raised { kind: 'date_format' } for a
 * MM/DD-vs-DD/MM order file, but the app's questions UI only handled
 * weight_unit — S.answers.dateOrder was read, never set, so the question
 * fired with no way to answer it. This test locks the controller wiring the
 * dialog uses: the question appears without an answer, and the dateOrder
 * answer resolves it and steers the parsed dates.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runConversion } from '../app/controller.mjs';

const FIX = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'test', 'fixtures');
const csv = fs.readFileSync(path.join(FIX, 'woo_orders_ambiguous.csv'), 'utf8');
const INPUT = { csvText: csv, direction: 'woocommerce-to-shopify', expectPlatform: 'woocommerce' };

test('ambiguous order dates raise the date_format question', () => {
  const res = runConversion(INPUT);
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  const q = res.questions.find((x) => x.kind === 'date_format');
  assert.ok(q, 'the engine asks when the order is genuinely undecidable');
  assert.equal(q.code, 'date_ambiguous');
  assert.deepEqual(q.options, ['MDY', 'DMY']);
});

test('the dateOrder answer resolves the question and steers the dates', () => {
  // "03/04/2026" — Day/Month reads 3 April, Month/Day reads March 4.
  const dmy = runConversion({ ...INPUT, dateOrder: 'DMY' });
  assert.equal(dmy.ok, true);
  assert.equal(dmy.questions.some((x) => x.kind === 'date_format'), false, 'answered — the question does not fire again');
  assert.ok(dmy.outputCsv.includes('2026-04-03'), 'DMY: 03/04 is the 3rd of April');

  const mdy = runConversion({ ...INPUT, dateOrder: 'MDY' });
  assert.equal(mdy.questions.some((x) => x.kind === 'date_format'), false);
  assert.ok(mdy.outputCsv.includes('2026-03-04'), 'MDY: 03/04 is March 4th');
});
