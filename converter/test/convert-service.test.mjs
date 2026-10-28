/**
 * Phase 1 step 2 — billing policy (convert-service.mjs): previews are FREE,
 * one credit consume per successful export, fired only after the file is
 * really written. Regression guarded: conv:run used to check+consume around
 * EVERY successful conversion, so a licensed user was billed on each step-3
 * preview, each step transition and each question re-run — several times per
 * file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConvertService, ENFORCE_LIMITS } from '../app/convert-service.mjs';
import { runConversion } from '../app/controller.mjs';

const CSV = [
  'Handle,Title,Variant Price,Variant SKU',
  'chemise,Chemise,89.00,CHM-1',
  'pull,Pull,59.00,PUL-1',
].join('\r\n') + '\r\n';

const INPUT = { csvText: CSV, direction: 'shopify-to-woocommerce', expectPlatform: 'shopify' };

function makeService({ activated = true, allowed = true } = {}) {
  const edgeCalls = [];
  const service = createConvertService({
    getLicense: () => (activated ? { activated: true, key: 'ELO-TEST-TEST-TEST' } : { activated: false, key: '' }),
    callEdge: async (action, body) => { edgeCalls.push({ action, body }); return { ok: true, allowed }; },
    run: runConversion, // the app injects the engine-host worker here
  });
  return { service, edgeCalls };
}

test('licensed: N previews + 1 export + save ⇒ exactly one check and one consume', { skip: !ENFORCE_LIMITS }, async () => {
  const { service, edgeCalls } = makeService();

  // Step-3 preview on every mapping change, entering step 4, a question re-run…
  for (let i = 0; i < 4; i++) {
    const res = await service.run(INPUT);
    assert.equal(res.ok, true);
  }
  assert.deepEqual(edgeCalls, [], 'previews never touch the credit backend');

  // The export run: one check, consume armed but NOT fired yet.
  const exp = await service.run({ ...INPUT, mode: 'export' });
  assert.equal(exp.ok, true);
  assert.deepEqual(edgeCalls.map((c) => c.action), ['converter_check']);

  // The file lands on disk → the single consume fires, with actual units.
  const consumed = await service.consumePending();
  assert.equal(consumed.consumed, true);
  assert.deepEqual(edgeCalls.map((c) => c.action), ['converter_check', 'converter_consume']);
  assert.equal(edgeCalls[1].body.items_count, 2, 'consume carries the real unit count');

  // A stray second save never double-bills.
  const again = await service.consumePending();
  assert.equal(again.consumed, false);
  assert.equal(edgeCalls.length, 2);
});

test('licensed: a cancelled save (no consumePending) bills nothing', { skip: !ENFORCE_LIMITS }, async () => {
  const { service, edgeCalls } = makeService();
  const exp = await service.run({ ...INPUT, mode: 'export' });
  assert.equal(exp.ok, true);
  assert.deepEqual(edgeCalls.map((c) => c.action), ['converter_check'], 'check only — no consume without a written file');
});

test('licensed: an empty balance refuses the export before running the engine', { skip: !ENFORCE_LIMITS }, async () => {
  const { service, edgeCalls } = makeService({ allowed: false });
  const exp = await service.run({ ...INPUT, mode: 'export' });
  assert.equal(exp.ok, false);
  assert.equal(exp.reason, 'no_converter_credits');
  assert.deepEqual(edgeCalls.map((c) => c.action), ['converter_check']);
  const consumed = await service.consumePending();
  assert.equal(consumed.consumed, false, 'a refused export never arms a consume');
});

test('unlicensed: previews and exports never touch the credit backend', async () => {
  const { service, edgeCalls } = makeService({ activated: false });
  const prev = await service.run(INPUT);
  const exp = await service.run({ ...INPUT, mode: 'export' });
  await service.consumePending();
  assert.equal(prev.ok, true);
  assert.equal(exp.ok, true);
  assert.deepEqual(edgeCalls, []);
});

// ── Phase 1 step 3 — the 10-row free cap (owner decision A) ──────────────────
// Unlicensed export = capped output via the engine's existing limitUnits;
// previews always show everything; licensed export is uncapped.
const BIG_CSV = ['Handle,Title,Variant Price,Variant SKU',
  ...Array.from({ length: 15 }, (_, i) => `p${i + 1},Produit ${i + 1},10.00,SKU-${i + 1}`),
].join('\r\n') + '\r\n';
const BIG_INPUT = { csvText: BIG_CSV, direction: 'shopify-to-woocommerce', expectPlatform: 'shopify' };
const dataRows = (csv) => csv.split(/\r\n/).filter((l) => l !== '').length - 1;

test('free cap: an unlicensed export carries at most 10 products', { skip: !ENFORCE_LIMITS }, async () => {
  const { service, edgeCalls } = makeService({ activated: false });
  const exp = await service.run({ ...BIG_INPUT, mode: 'export' });
  assert.equal(exp.ok, true);
  assert.equal(dataRows(exp.outputCsv), 10, 'output file capped to the free limit');
  assert.deepEqual(exp.freeCap, { limit: 10, applied: true });
  assert.equal(exp.counts.outputUnits, 15, 'the preview counts still tell the full story');
  assert.deepEqual(edgeCalls, [], 'free tier has no credit flow');
});

test('free cap: an unlicensed small file is untouched (cap not hit)', { skip: !ENFORCE_LIMITS }, async () => {
  const { service } = makeService({ activated: false });
  const exp = await service.run({ ...INPUT, mode: 'export' });
  assert.equal(exp.ok, true);
  assert.equal(dataRows(exp.outputCsv), 2);
  assert.deepEqual(exp.freeCap, { limit: 10, applied: false });
});

test('free cap: previews are never capped, licensed or not', async () => {
  for (const activated of [false, true]) {
    const { service, edgeCalls } = makeService({ activated });
    const prev = await service.run(BIG_INPUT);
    assert.equal(prev.ok, true);
    assert.equal(dataRows(prev.outputCsv), 15, `preview uncapped (activated=${activated})`);
    assert.equal(prev.freeCap, undefined);
    assert.deepEqual(edgeCalls, [], 'previews never touch the credit backend');
  }
});

test('free cap: a licensed export is uncapped, with the single consume', { skip: !ENFORCE_LIMITS }, async () => {
  const { service, edgeCalls } = makeService();
  const exp = await service.run({ ...BIG_INPUT, mode: 'export' });
  assert.equal(exp.ok, true);
  assert.equal(dataRows(exp.outputCsv), 15, 'licensed export carries everything');
  assert.equal(exp.freeCap, undefined);
  await service.consumePending();
  assert.deepEqual(edgeCalls.map((c) => c.action), ['converter_check', 'converter_consume']);
  assert.equal(edgeCalls[1].body.items_count, 15);
});

test('a failed export conversion arms no consume', { skip: !ENFORCE_LIMITS }, async () => {
  const { service, edgeCalls } = makeService();
  const exp = await service.run({ ...INPUT, mode: 'export', csvText: 'colA,colB\n1,2\n' });
  assert.equal(exp.ok, false);
  const consumed = await service.consumePending();
  assert.equal(consumed.consumed, false);
  assert.deepEqual(edgeCalls.map((c) => c.action), ['converter_check'], 'check happened, consume never armed');
});

// ── No limitation for anyone (owner decision 2026-10-27) ─────────────────────
test('no limits: licensed or not, an export carries every row and never touches the credit backend', { skip: ENFORCE_LIMITS }, async () => {
  for (const activated of [false, true]) {
    const { service, edgeCalls } = makeService({ activated });
    const exp = await service.run({ ...BIG_INPUT, mode: 'export' });
    assert.equal(exp.ok, true);
    assert.equal(dataRows(exp.outputCsv), 15, `all rows exported (activated=${activated})`);
    assert.equal(exp.freeCap, undefined);
    assert.equal((await service.consumePending()).consumed, false);
    assert.deepEqual(edgeCalls, []);
  }
});
