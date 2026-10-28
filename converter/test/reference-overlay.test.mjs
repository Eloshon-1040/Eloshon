/**
 * Step 3 — re-pointing a column of a REFERENCE format (the Scraper export)
 * through a learned overlay: stored per column on this computer, applied by
 * getFormat() to every conversion path, reversible, Reference never written.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convert } from '../core/dist/index.mjs';
import { createJsonKnowledgeStore } from '../core/knowledge-proposal/json-store.mjs';
import { loadAllFormats } from '../core/knowledge-proposal/reference.mjs';
import { analyzeMapping, columnEditEntries, columnEditChoices } from '../app/controller.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REF = path.join(ROOT, 'core', 'knowledge-ref');
const ID = 'scraper.eloshon-export.v1';
const csv = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'scraper', 'scraper-writer-2026-10.csv'), 'utf8');
const freshStore = () => createJsonKnowledgeStore({ referenceDir: REF, learnedDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kb-overlay-')) });
const toShopify = async (store) => convert(csv, { direction: 'eloshon-to-shopify', entity: 'products', expectPlatform: 'eloshon', knowledge: { formats: await loadAllFormats(store) } });
const trail = (res) => res.rows.find((r) => r['Title'] === 'Chaussure de sport Trail 2');

test('technical_specs → a custom field the user names: description no longer carries it, a metafield column does', async () => {
  const store = freshStore();
  const refBefore = fs.readFileSync(path.join(REF, 'formats', `${ID}.json`), 'utf8');
  const before = await toShopify(store);
  assert.ok(trail(before)['Body (HTML)'].includes('Caractéristiques techniques'), 'default: specs in the description');

  await store.putColumnEdit(ID, 'technical_specs', columnEditEntries('technical_specs', { kind: 'custom', key: 'fiche_technique' }));
  const fmt = await store.getFormat(ID);
  const specs = fmt.fields.filter((f) => f.path === 'technical_specs');
  assert.equal(specs.length, 1);
  assert.equal(specs[0].canon, 'metafields[]'); assert.deepEqual(specs[0].args, { key: 'fiche_technique' });
  assert.equal(fmt.history.at(-1).op, 'correct');
  assert.ok(fmt.fields.some((f) => f.path === 'brand' && f.canon === 'vendor'), 'other columns keep following Reference');

  const after = await toShopify(store);
  assert.equal(after.ok, true);
  const row = trail(after);
  assert.ok(!row['Body (HTML)'].includes('Caractéristiques techniques'), 'specs left the description');
  const col = after.headers.find((h) => /fiche_technique/.test(h));
  assert.ok(col, 'a custom-field column carries the specs');
  assert.ok(row[col].includes('Matière'));
  assert.equal(fs.readFileSync(path.join(REF, 'formats', `${ID}.json`), 'utf8'), refBefore, 'Reference file untouched');

  // Back to the shipped mapping.
  assert.equal(await store.removeColumnEdit(ID, 'technical_specs'), true);
  assert.equal(await store.getColumnEdits(ID), null, 'no edit left → overlay file removed');
  assert.ok(trail(await toShopify(store))['Body (HTML)'].includes('Caractéristiques techniques'));
});

test('a column can be sent to another canon field, or not imported at all', async () => {
  const store = freshStore();
  await store.putColumnEdit(ID, 'net_content', columnEditEntries('net_content', { kind: 'canon', canon: 'productType' }));
  await store.putColumnEdit(ID, 'rating', columnEditEntries('rating', { kind: 'ignore' }));
  const res = await toShopify(store);
  const row = trail(res);
  assert.equal(row['Type'], '450 g');
  assert.ok(!res.headers.some((h) => /rating/.test(h)), 'ignored column is not written');
  assert.ok(!(res.preserved?.fields ?? []).some((f) => f.field === 'rating'), 'an explicit "do not import" is not reported as unknown');
  // a canon choice offered by the UI is always buildable
  for (const c of columnEditChoices()) assert.equal(columnEditEntries('x', { kind: 'canon', canon: c })[0].path, 'x', c);
});

test('edits are refused when they could corrupt knowledge', async () => {
  const store = freshStore();
  await assert.rejects(() => store.putColumnEdit('unknown.csv.abc.v1', 'x', columnEditEntries('x', { kind: 'ignore' })), /not a Reference format/);
  await assert.rejects(() => store.putColumnEdit(ID, 'brand', columnEditEntries('other', { kind: 'ignore' })), /target the column/);
  assert.throws(() => columnEditEntries('brand', { kind: 'custom', key: 'bad key!' }), /letters, digits/);
  assert.throws(() => columnEditEntries('brand', { kind: 'canon', canon: 'options' }), /unsupported/);
});

test('step-3 analysis reports which columns the user changed and counts them as confirmed', async () => {
  const store = freshStore();
  await store.putColumnEdit(ID, 'technical_specs', columnEditEntries('technical_specs', { kind: 'custom', key: 'fiche_technique' }));
  const a = await analyzeMapping(csv, 'eloshon-to-shopify', {}, { store });
  assert.equal(a.detection.knowledgeId, ID);
  assert.deepEqual(a.knowledge.edited, { technical_specs: { kind: 'custom', key: 'fiche_technique' } });
  assert.ok(a.knowledge.editable.includes('technical_specs') && a.knowledge.editable.includes('brand'));
  assert.ok(a.knowledge.choices.includes('vendor') && a.knowledge.choices.includes('specifications'));
  assert.equal(a.summary.manual, 1);
  assert.equal(a.summary.total, a.summary.auto + a.summary.manual + a.summary.ignored + a.summary.unknown);
});
