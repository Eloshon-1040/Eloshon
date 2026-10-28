// Phase 5.3 — FormatRecognizer tests.
// (1) Parity: every checked-in fixture must detect as the format the golden
//     suite was frozen with — asserted against an INDEPENDENT table, not
//     against the function itself.
// (2) Every Reference entry validates against the KB schema.
// (3) Recognizer semantics: anyOf gating, specificity ranking, partial
//     verdicts, Learned overlay, structural hash.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { makeValidator } from '../validator.mjs';
import { createJsonKnowledgeStore } from '../json-store.mjs';
import { loadReferenceFormatsSync, REFERENCE_DIR } from '../reference.mjs';
import { recognize, matchSignature, structuralHash, toLegacyDetection, createFormatRecognizer, isDetected } from '../recognizer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..', '..');
const FIX = path.join(ROOT, 'test', 'fixtures');
const { parseCsv } = await import(path.join(ROOT, 'core', 'dist', 'csv.mjs').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
const { detectFormat } = await import(path.join(ROOT, 'core', 'dist', 'detect.mjs').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));

const schema = JSON.parse(await fs.readFile(path.join(here, '..', 'schema.json'), 'utf8'));
const validateFormat = makeValidator(schema, 'formatKnowledge');
const REF = loadReferenceFormatsSync();

// Frozen expectation: fixture file → legacy format id (what the goldens were
// generated with, pre-Phase-5). If this table and detectFormat disagree, the
// data-driven detection changed behaviour.
const EXPECTED = {
  'bigbuy_presta.csv': ['bigbuy_presta', 'bigbuy', 'products', 'bigbuy.presta-import.v1'],
  'bigbuy_standard.csv': ['bigbuy_standard', 'bigbuy', 'products', 'bigbuy.standard.v1'],
  'bigcommerce_customers.csv': ['bigcommerce_customers', 'bigcommerce', 'customers', 'bigcommerce.customers.csv.v1'],
  'bigcommerce_orders.csv': ['bigcommerce_orders', 'bigcommerce', 'orders', 'bigcommerce.orders.csv.v1'],
  'bigcommerce_products.csv': ['bigcommerce_products', 'bigcommerce', 'products', 'bigcommerce.products.csv.v1'],
  'presta_categories.csv': ['presta_categories', 'bigbuy', 'products', 'bigbuy.presta-categories.v1'],
  'shopify_customers.csv': ['shopify_customers', 'shopify', 'customers', 'shopify.customers.csv.v1'],
  'shopify_orders.csv': ['shopify_orders', 'shopify', 'orders', 'shopify.orders.csv.v1'],
  'shopify_products.csv': ['shopify_products', 'shopify', 'products', 'shopify.products.csv.v1'],
  'wix_products.csv': ['wix_products', 'wix', 'products', 'wix.products.csv.v1'],
  'woo_customers.csv': ['woo_customers', 'woocommerce', 'customers', 'woocommerce.customers.csv.v1'],
  'woo_orders.csv': ['woo_orders', 'woocommerce', 'orders', 'woocommerce.orders.csv.v1'],
  // Phase 1 step 4: same header set as woo_orders.csv, dates genuinely MM/DD-vs-DD/MM
  // ambiguous — feeds the date-order question tests.
  'woo_orders_ambiguous.csv': ['woo_orders', 'woocommerce', 'orders', 'woocommerce.orders.csv.v1'],
  'woo_products_legacy.csv': ['woo_products_legacy', 'woocommerce', 'products', 'woocommerce.products.csv.legacy.v1'],
  'woo_products_modern.csv': ['woo_products_modern', 'woocommerce', 'products', 'woocommerce.products.csv.modern.v1'],
  // Phase 5.8: an unknown supplier file (taught through the Learned strata in its own tests) — unknown to Reference
  'supplier_fr.csv': ['unknown', null, null, null],
};

test('reference strata: 14 legacy-routed CSV entries + WC REST + Shopware API + Shopify GraphQL + Scraper export (CSV + products.json) + 10 orders/customers API entries (7.6) + PrestaShop products, all schema-valid, unique ids, every entry routable', () => {
  assert.equal(REF.length, 33); // + extension.panel-csv.fr.v1 (the extension panel's CSV, 2026-10-28)
  const ids = new Set(), legacy = new Set();
  for (const f of REF) {
    const r = validateFormat(f);
    assert.equal(r.ok, true, `${f.id}: ` + r.errors.map((e) => e.path + ' ' + e.msg).join('; '));
    assert.ok(!ids.has(f.id), 'duplicate id ' + f.id); ids.add(f.id);
    assert.ok(f.legacy || f.routing || f.medium === 'json-api', 'entry must route somewhere: ' + f.id);
    if (f.legacy) { assert.ok(!legacy.has(f.legacy.formatId), 'duplicate legacy id ' + f.id); legacy.add(f.legacy.formatId); }
  }
  assert.equal(legacy.size, 14);
  assert.ok(REF.find((f) => f.id === 'scraper.eloshon-export.v1').routing);
});

test('parity: every fixture detects as the format the goldens were frozen with', () => {
  const files = fsSync.readdirSync(FIX).filter((n) => n.endsWith('.csv'));
  assert.deepEqual(files.sort(), Object.keys(EXPECTED).sort(), 'fixture set drifted — update EXPECTED');
  for (const name of files) {
    const [format, platform, entity, knowledgeId] = EXPECTED[name];
    const headers = parseCsv(fsSync.readFileSync(path.join(FIX, name), 'utf8')).headers;
    const det = detectFormat(headers);
    assert.deepEqual({ format: det.format, platform: det.platform, entity: det.entity, knowledgeId: det.knowledgeId },
      { format, platform, entity, knowledgeId }, name);
    // exactly ONE format is detected per known fixture — no ambiguity hidden by ranking
    const detected = recognize({ kind: 'csv-header-set', columns: headers }, REF).filter((m) => isDetected(m.kind));
    assert.equal(detected.length, format === 'unknown' ? 0 : 1, `${name}: ${detected.map((m) => m.formatId).join(', ')}`);
  }
});

test('unknown header sets are unknown (no false positive)', () => {
  for (const cols of [[], ['foo', 'bar'], ['Handle'], ['Type', 'Regular price'], ['Email'], ['ID', 'NAME']]) {
    assert.equal(detectFormat(cols).format, 'unknown', JSON.stringify(cols));
  }
});

test('csv-header-set: anyOf gates, hints only raise coverage', () => {
  const sig = { kind: 'csv-header-set', required: ['a', 'b'], anyOf: ['x', 'y'], hints: ['h1', 'h2'] };
  const none = matchSignature(sig, { kind: 'csv-header-set', columns: ['a', 'b', 'z'] });
  assert.ok(!isDetected(none.kind), 'anyOf missing must not detect');
  const ok = matchSignature(sig, { kind: 'csv-header-set', columns: ['a', 'b', 'y', 'z'] });
  assert.equal(ok.kind, 'superset');
  const better = matchSignature(sig, { kind: 'csv-header-set', columns: ['a', 'b', 'y', 'h1', 'h2', 'z'] });
  assert.equal(better.kind, 'superset');
  assert.ok(better.coverage > ok.coverage, 'hints raise coverage');
  assert.equal(better.score, ok.score + 2, 'hints raise specificity');
  const exact = matchSignature(sig, { kind: 'csv-header-set', columns: ['A ', 'b', 'x', 'h1', 'h2'] });
  assert.equal(exact.kind, 'exact', 'case/whitespace-insensitive, no extras');
  assert.equal(exact.coverage, 1);
});

test('csv-header-set: partial / subset verdicts when required columns are missing', () => {
  const sig = { kind: 'csv-header-set', required: ['a', 'b', 'c', 'd'] };
  assert.equal(matchSignature(sig, { kind: 'csv-header-set', columns: ['a', 'b'] }).kind, 'subset');
  assert.equal(matchSignature(sig, { kind: 'csv-header-set', columns: ['a', 'b', 'zz'] }).kind, 'partial');
  assert.equal(matchSignature(sig, { kind: 'csv-header-set', columns: ['a', 'zz'] }).kind, 'none');
});

test('ranking: a more specific signature beats a less specific one, regardless of array order', () => {
  const generic = { id: 'g', signatures: [{ kind: 'csv-header-set', required: ['sku', 'price'] }] };
  const specific = { id: 's', signatures: [{ kind: 'csv-header-set', required: ['sku', 'price', 'store_uid'] }] };
  const input = { kind: 'csv-header-set', columns: ['sku', 'price', 'store_uid', 'name'] };
  assert.equal(recognize(input, [generic, specific])[0].formatId, 's');
  assert.equal(recognize(input, [specific, generic])[0].formatId, 's');
  // ties resolve by id — deterministic
  const g2 = { id: 'a', signatures: generic.signatures };
  assert.equal(recognize({ kind: 'csv-header-set', columns: ['sku', 'price'] }, [generic, g2])[0].formatId, 'a');
});

test('structural hash: order- and case-insensitive, 6 hex chars, distinct sets differ', () => {
  const h1 = structuralHash(['Name', 'Price', 'SKU']);
  assert.match(h1, /^[0-9a-f]{6}$/);
  assert.equal(h1, structuralHash(['sku', 'name ', 'PRICE']));
  assert.notEqual(h1, structuralHash(['Name', 'Price']));
  const fmt = { id: 'scraper.demo.' + h1 + '.v1', signatures: [{ kind: 'structural-hash', hash: h1 }] };
  const m = recognize({ kind: 'csv-header-set', columns: ['SKU', 'Name', 'Price'] }, [fmt]);
  assert.equal(m[0]?.kind, 'exact');
  assert.equal(recognize({ kind: 'csv-header-set', columns: ['SKU', 'Name'] }, [fmt]).length, 0);
});

test('toLegacyDetection: only DETECTED formats with a legacy block route; partial never does', () => {
  const partialOnly = recognize({ kind: 'csv-header-set', columns: ['Handle', 'zzz'] }, REF);
  assert.ok(partialOnly.length > 0 && !isDetected(partialOnly[0].kind));
  assert.equal(toLegacyDetection(partialOnly, REF).format, 'unknown');
});

test('async recognizer: Learned format overlays Reference and is recognised; Reference stays untouched', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-rec-'));
  const learnedDir = path.join(base, 'learned');
  await fs.mkdir(path.join(learnedDir, 'formats'), { recursive: true });
  const cols = ['ref', 'libelle', 'prix_ttc', 'ean', 'categorie'];
  const hash = structuralHash(cols);
  const learned = {
    schemaVersion: 1, id: `scraper.demo.${hash}.v1`, displayName: 'Demo scraper output', provenance: 'scraper-generated', medium: 'csv',
    entity: 'products', signatures: [{ kind: 'structural-hash', hash, columnsPreview: cols }], fields: [],
    history: [{ at: '2026-09-21T00:00:00.000Z', op: 'seed', from: 'user:test', origin: 'learned' }],
  };
  assert.equal(validateFormat(learned).ok, true);
  await fs.writeFile(path.join(learnedDir, 'formats', `${learned.id}.json`), JSON.stringify(learned));
  const store = createJsonKnowledgeStore({ referenceDir: REFERENCE_DIR, learnedDir });
  const rec = createFormatRecognizer(store);

  const m = await rec.recognizeHeaders(cols);
  assert.equal(m[0].formatId, learned.id);
  assert.equal(m[0].kind, 'exact');
  // no legacy block → the legacy engine still says unknown (no parser yet)
  assert.equal((await rec.detect(cols)).format, 'unknown');
  // Reference detection unaffected
  const shopify = parseCsv(fsSync.readFileSync(path.join(FIX, 'shopify_products.csv'), 'utf8')).headers;
  assert.equal((await rec.detect(shopify)).format, 'shopify_products');
  assert.equal(await store.origin(learned.id), 'learned');
  assert.equal((await store.listFormats()).length, 34);
});
