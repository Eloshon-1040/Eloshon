/**
 * Non-regression safety net (ÉTAPE 1). For every case in the matrix, the engine
 * must reproduce the frozen golden output EXACTLY — output CSV (byte-for-byte),
 * redirects CSV, and the behavioural snapshot (counts/errors/losses/warnings/
 * questions). These stay green through every later step; with default mappings,
 * the enriched engine must produce identical files.
 *
 *   node scripts/build-engine.mjs && node --test test/*.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as engine from '../core/dist/index.mjs';
import { loadReferenceFormatsSync } from '../core/knowledge-proposal/reference.mjs';
import { CASES, metaSnapshot, runCase, canonSnapshot } from './cases.mjs';
const { serializeCsv } = engine;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test', 'fixtures');
const GOLD = path.join(ROOT, 'test', 'golden');
const read = (p) => fs.readFileSync(p, 'utf8');

for (const c of CASES) {
  test(`regression: ${c.name}`, () => {
    const { res, canon } = runCase(c, { read: (rel) => read(path.join(FIX, rel)), engine: { ...engine, loadReferenceFormatsSync } });

    const outActual = res.ok ? serializeCsv(res.headers, res.rows) : '';
    assert.equal(outActual, read(path.join(GOLD, `${c.name}.out.csv`)), 'output CSV differs from golden');
    const canonPath = path.join(GOLD, `${c.name}.canon.json`);
    if (fs.existsSync(canonPath)) {
      assert.ok(canon, 'expected a canon snapshot, got none');
      assert.equal(canonSnapshot(canon), read(canonPath), 'parsed canon differs from golden');
    }

    const metaActual = JSON.stringify(metaSnapshot(res), null, 2) + '\n';
    assert.equal(metaActual, read(path.join(GOLD, `${c.name}.meta.json`)), 'result snapshot differs from golden');

    const redirectsPath = path.join(GOLD, `${c.name}.redirects.csv`);
    if (fs.existsSync(redirectsPath)) {
      assert.ok(res.redirects, 'expected redirects, got none');
      assert.equal(serializeCsv(res.redirects.headers, res.redirects.rows), read(redirectsPath), 'redirects CSV differs from golden');
    } else {
      assert.ok(!res.redirects, 'unexpected redirects produced');
    }
  });
}
