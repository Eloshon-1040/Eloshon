/**
 * Headless check of the app controller + billing policy: analyze() detection
 * and suggestions, previews full and free, the unlicensed EXPORT capped to the
 * free limit, the licensed export full with exactly one check + one consume.
 * No Electron. (Phase 1: the freemium rule lives in app/convert-service.mjs —
 * runConversion is the pure engine runner and caps only via limitUnits.)
 */
import assert from 'node:assert/strict';
import { serializeCsv } from '../core/dist/index.mjs';
import { analyze, runConversion } from '../app/controller.mjs';
import { createConvertService, ENFORCE_LIMITS } from '../app/convert-service.mjs';
import { DEFAULT_FREE_LIMIT } from '../core/directions.mjs';

const HEADERS = ['Handle', 'Title', 'Body (HTML)', 'Vendor', 'Type', 'Tags', 'Published', 'Variant SKU', 'Variant Price', 'Variant Inventory Qty', 'Image Src'];
const N = 25;
const rows = Array.from({ length: N }, (_, i) => Object.fromEntries(HEADERS.map((h, j) =>
  [h, ['prod-' + (i + 1), 'Product ' + (i + 1), '<p>d</p>', 'Acme', 'Widget', 'a', 'TRUE', 'SKU' + (i + 1), (9 + i).toFixed(2), '5', 'https://x/' + (i + 1) + '.jpg'][j]])));
const csv = serializeCsv(HEADERS, rows);
const INPUT = { csvText: csv, direction: 'shopify-to-woocommerce', expectPlatform: 'shopify' };
const outRows = (r) => r.outputCsv.trim().split(/\r?\n/).length - 1; // minus header

// analyze
const a = analyze(csv);
assert.equal(a.detection.format, 'shopify_products');
assert.equal(a.rowCount, N);
assert.ok(a.suggestions.some((d) => d.direction === 'shopify-to-woocommerce'), 'suggests Shopify→Woo');
console.log(`✓ analyze: detected ${a.detection.format}, ${a.rowCount} rows, ${a.suggestions.length} suggested directions`);

function service(activated) {
  const edgeCalls = [];
  const s = createConvertService({
    getLicense: () => (activated ? { activated: true, key: 'ELO-TEST-TEST-TEST' } : { activated: false, key: '' }),
    callEdge: async (action, body) => { edgeCalls.push({ action, body }); return { ok: true, allowed: true }; },
    run: runConversion,
  });
  return { s, edgeCalls };
}

// No limitation for anyone (owner decision 2026-10-27): every export is full, zero credit calls.
if (!ENFORCE_LIMITS) {
  for (const act of [false, true]) {
    const { s: sv, edgeCalls } = service(act);
    const exp = await sv.run({ ...INPUT, mode: 'export' });
    assert.equal(outRows(exp), N, 'export holds every row');
    assert.equal(exp.freeCap, undefined);
    await sv.consumePending();
    assert.equal(edgeCalls.length, 0, 'no credit calls');
  }
  console.log(`✓ no limits: export = ${N} rows for licensed and unlicensed, zero credit calls`);
} else {
// unlicensed: preview full and free; EXPORT capped to the free limit
{
  const { s, edgeCalls } = service(false);
  const preview = await s.run(INPUT);
  assert.equal(outRows(preview), N, 'preview shows everything');
  const exp = await s.run({ ...INPUT, mode: 'export' });
  assert.equal(exp.ok, true);
  assert.deepEqual(exp.freeCap, { limit: DEFAULT_FREE_LIMIT, applied: true }, 'free export is capped');
  assert.equal(outRows(exp), DEFAULT_FREE_LIMIT, `free output CSV holds exactly ${DEFAULT_FREE_LIMIT} units`);
  assert.equal(exp.counts.inputUnits, N, 'counts still report the full input');
  await s.consumePending();
  assert.equal(edgeCalls.length, 0, 'free tier never touches the credit backend');
  console.log(`✓ free: preview ${N} rows, export capped to ${outRows(exp)} (of ${N}), zero credit calls`);
}

// licensed: previews free, export full, exactly one check + one consume
{
  const { s, edgeCalls } = service(true);
  await s.run(INPUT); await s.run(INPUT);
  assert.equal(edgeCalls.length, 0, 'previews are free for licensed users too');
  const exp = await s.run({ ...INPUT, mode: 'export' });
  assert.equal(outRows(exp), N, 'licensed output CSV holds all units');
  assert.equal(exp.freeCap, undefined, 'licensed run not capped');
  await s.consumePending();
  assert.deepEqual(edgeCalls.map((c) => c.action), ['converter_check', 'converter_consume'], 'one check, one consume');
  assert.equal(edgeCalls[1].body.items_count, N);
  console.log(`✓ licensed: export = ${N} rows (full), one check + one consume of ${N} units`);
}

}

console.log(`\nCONVERTER CONTROLLER OK — analyze + freemium policy (free ${DEFAULT_FREE_LIMIT} / licensed full, previews free).`);
