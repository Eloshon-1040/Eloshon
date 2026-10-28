/**
 * Freezes the REFERENCE outputs (test/golden/*) by running the CURRENT engine
 * over each fixture in the case matrix. Run this ONCE against the unmodified
 * engine (and later only when a change is INTENDED — then eyeball the git diff of
 * test/golden before committing). The regression test compares against these.
 *
 *   node scripts/build-engine.mjs && node scripts/gen-golden.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as engine from '../core/dist/index.mjs';
import { loadReferenceFormatsSync } from '../core/knowledge-proposal/reference.mjs';
import { CASES, metaSnapshot, runCase, canonSnapshot } from '../test/cases.mjs';
const { serializeCsv } = engine;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test', 'fixtures');
const GOLD = path.join(ROOT, 'test', 'golden');
fs.mkdirSync(GOLD, { recursive: true });

const read = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');

for (const c of CASES) {
  const { res, canon } = runCase(c, { read, engine: { ...engine, loadReferenceFormatsSync } });

  fs.writeFileSync(path.join(GOLD, `${c.name}.out.csv`), res.ok ? serializeCsv(res.headers, res.rows) : '');
  if (canon) fs.writeFileSync(path.join(GOLD, `${c.name}.canon.json`), canonSnapshot(canon));
  if (res.redirects) fs.writeFileSync(path.join(GOLD, `${c.name}.redirects.csv`), serializeCsv(res.redirects.headers, res.redirects.rows));
  fs.writeFileSync(path.join(GOLD, `${c.name}.meta.json`), JSON.stringify(metaSnapshot(res), null, 2) + '\n');
  console.log('  golden', c.name, `ok=${res.ok} rows=${res.rows.length}${res.redirects ? ` redirects=${res.redirects.rows.length}` : ''}`);
}
console.log('golden outputs written to', GOLD, `(${CASES.length} cases)`);
