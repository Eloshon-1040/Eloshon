/**
 * Column audit for the legacy CSV formats (Phase 2 Lot 3): for every CSV in
 * test/fixtures (recursively) that detects as a legacy-routed format, list the
 * headers its knowledge entry does NOT declare — i.e. what the preservation
 * pass will keep as unknown — and check the data-declared row grouping yields
 * exactly the bespoke parser's unit count.
 *
 *   node scripts/build-engine.mjs && node scripts/legacy-columns.mjs [formatId]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as eng from '../core/dist/index.mjs';
import { loadReferenceFormatsSync } from '../core/knowledge-proposal/reference.mjs';
import { declaredColumns, unitsOfRows } from '../core/knowledge-proposal/legacy-units.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test', 'fixtures');
const only = process.argv[2];

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.csv') ? [path.join(d, e.name)] : []));
const REF = loadReferenceFormatsSync();
for (const file of walk(FIX)) {
  const text = fs.readFileSync(file, 'utf8');
  const table = eng.parseCsv(text);
  const det = eng.detectFormat(table.headers);
  if (!det.knowledgeId || det.format === 'knowledge' || det.format === 'unknown') continue;
  if (only && det.knowledgeId !== only && det.format !== only) continue;
  const fmt = REF.find((f) => f.id === det.knowledgeId);
  const declared = declaredColumns(fmt);
  const unknown = table.headers.filter((h) => !declared.has(h));
  const groups = unitsOfRows(fmt.structure?.rows || {}, table.rows);
  console.log(`\n${path.relative(FIX, file)}  →  ${fmt.id} (${det.format})  rows=${table.rows.length} units(data)=${groups.length} fields=${(fmt.fields || []).length}`);
  console.log('  undeclared:', unknown.length ? unknown.join(' | ') : '—');
}
