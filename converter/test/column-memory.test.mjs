/**
 * What the user says about a column must serve the NEXT file, not only the same file
 * byte for byte (audit): decisions were keyed to the exact set of columns (a hash), the
 * UI never sent a scope, the dedup key held the clock, and an export with one more
 * column was a stranger that had to be taught again from scratch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeMapping, learnFromAnalysis } from '../app/controller.mjs';
import { createJsonKnowledgeStore } from '../core/knowledge-proposal/json-store.mjs';
import { makeDecision } from '../core/knowledge-proposal/semantic.mjs';
import { parseCsv, proposeFormatId, convert } from '../core/dist/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const direction = 'eloshon-to-shopify';

function makeStore() {
  const learnedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-mem-'));
  return { learnedDir, store: createJsonKnowledgeStore({ referenceDir: path.join(ROOT, 'core', 'knowledge-ref'), learnedDir }) };
}
const idOf = (csv) => proposeFormatId(parseCsv(csv).headers, { provenance: 'unknown', hint: 'csv' });
const column = (a, name) => (a.learn?.semantic ?? a.plan?.semantic).columns.find((c) => c.column === name);

// two different suppliers' files that both call the same column "Désignation interne"
const FILE_A = ['Code;Désignation interne;Prix de vente', 'A1;Chaise en bois naturel;59,90', 'A2;Table en chêne massif;129,00', 'A3;Canapé cuir brun;249,00'].join('\n');
const FILE_B = ['Ref;Marque;désignation_interne;Stock;Prix de vente', 'B1;Ikea;Lampe de bureau;4;19,90', 'B2;Ikea;Tapis laine;9;79,00', 'B3;Ikea;Miroir rond;2;45,00'].join('\n');

test('a decision is remembered per column NAME by default', () => {
  const d = makeDecision({ formatId: 'x', column: 'Prix HT', action: 'corrected', canon: 'price' });
  assert.deepEqual(d.scope, { kind: 'column' });
  const narrow = makeDecision({ formatId: 'x', column: 'Prix HT', action: 'corrected', canon: 'price', scope: { kind: 'format', id: 'x' } });
  assert.deepEqual(narrow.scope, { kind: 'format', id: 'x' });
});

test('what was said about a column in one file is applied to the next file, whatever its other columns', async () => {
  const { store } = makeStore();
  await store.recordDecision(makeDecision({ formatId: idOf(FILE_A), column: 'Désignation interne', action: 'corrected', canon: 'title' }));
  await store.recordDecision(makeDecision({ formatId: idOf(FILE_A), column: 'Code', action: 'ignored' }));

  // file B has a different column set (another hash) and spells the header differently
  assert.notEqual(idOf(FILE_A), idOf(FILE_B));
  const b = await analyzeMapping(FILE_B, direction, {}, { semantic: true, store });
  const c = column(b, 'désignation_interne');
  assert.equal(c.status, 'decided', 'accents, case and "_" do not make it a different column');
  assert.equal(c.best.canon, 'title');
  assert.equal(c.best.confidence, 'user-corrected');
  assert.notEqual(column(b, 'Ref').status, 'ignored', '"Ref" is not "Code"');
});

test('a decision narrowed to one format does not leak to another file', async () => {
  const { store } = makeStore();
  await store.recordDecision(makeDecision({ formatId: idOf(FILE_A), column: 'Désignation interne', action: 'ignored', scope: { kind: 'format', id: idOf(FILE_A) } }));
  const b = await analyzeMapping(FILE_B, direction, {}, { semantic: true, store });
  assert.notEqual(column(b, 'désignation_interne').status, 'ignored');
});

test('forgetting a column lifts the memory for every file', async () => {
  const { store } = makeStore();
  await store.recordDecision(makeDecision({ formatId: idOf(FILE_A), column: 'Désignation interne', action: 'ignored' }));
  assert.equal(column(await analyzeMapping(FILE_B, direction, {}, { semantic: true, store }), 'désignation_interne').status, 'ignored');
  await store.recordDecision(makeDecision({ formatId: idOf(FILE_A), column: 'Désignation interne', action: 'proposed', reason: 'forget' }));
  assert.notEqual(column(await analyzeMapping(FILE_B, direction, {}, { semantic: true, store }), 'désignation_interne').status, 'ignored');
});

test('the same decision twice is stored once (the clock is not part of the key)', async () => {
  const { store, learnedDir } = makeStore();
  const id = idOf(FILE_A);
  const file = path.join(learnedDir, 'learned', '_columns', 'decisions.jsonl');
  await store.recordDecision(makeDecision({ formatId: id, column: 'Désignation interne', action: 'confirmed', canon: 'title' }));
  await new Promise((r) => setTimeout(r, 5));
  await store.recordDecision(makeDecision({ formatId: id, column: 'désignation_interne', action: 'confirmed', canon: 'title' }));
  assert.equal(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 1);
  // changing one's mind IS recorded
  await store.recordDecision(makeDecision({ formatId: id, column: 'Désignation interne', action: 'corrected', canon: 'bodyHtml' }));
  assert.equal(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 2);
});

test('an export with one more column is read by the format already taught, with a notice', async () => {
  const { store } = makeStore();
  const taught = ['Code;Libellé;Prix de vente;Stock;Photo', 'C1;Chaise;59,90;3;https://x/1.jpg', 'C2;Table;129,00;1;https://x/2.jpg', 'C3;Banc;89,50;8;https://x/3.jpg'].join('\n');
  const a = await analyzeMapping(taught, direction, {}, { semantic: true, store });
  await learnFromAnalysis(store, { headers: parseCsv(taught).headers, semantic: a.learn.semantic, hint: 'Fournisseur' });
  const list = await store.listFormats();
  const formats = await Promise.all(list.map((f) => store.getFormat(f.id)));

  // next month's export: same file plus a "Marque" column
  const next = ['Code;Libellé;Prix de vente;Stock;Photo;Marque', 'C1;Chaise;59,90;3;https://x/1.jpg;Ikea', 'C4;Lampe;19,90;6;https://x/4.jpg;Ikea'].join('\n');
  const res = convert(next, { direction, expectPlatform: 'eloshon', knowledge: { formats } });
  assert.equal(res.ok, true);
  assert.equal(res.counts.outputUnits, 2);
  assert.equal(res.rows[0]['Title'], 'Chaise');
  assert.equal(res.rows[1]['Variant Price'], '19.90');
  const notice = res.warnings.find((w) => w.code === 'format_similar');
  assert.ok(notice, 'the user is told the file is not exactly the taught one');
  assert.deepEqual(notice.params, { added: 1, missing: 0 });

  // a file that merely shares a column or two is NOT taken for it
  const stranger = ['Code;Nom;Poids;Couleur;Taille', 'S1;Pull;300;Rouge;M', 'S2;Bonnet;80;Noir;U'].join('\n');
  const other = convert(stranger, { direction, expectPlatform: 'eloshon', knowledge: { formats } });
  assert.ok(!other.warnings.some((w) => w.code === 'format_similar'));
});
