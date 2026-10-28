import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { findReservedNames, assertNoReservedNames } from '../../scripts/lib/extension-guard.mjs';

function fixture(build) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elo-guard-'));
  build(dir);
  return dir;
}
const mk = (dir, rel) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); };
const mkdir = (dir, rel) => fs.mkdirSync(path.join(dir, rel), { recursive: true });

test('clean folder with _locales only -> no offenders', () => {
  const dir = fixture((d) => { mk(d, 'manifest.json'); mk(d, '_locales/fr/messages.json'); mk(d, 'background/sw.mjs'); });
  assert.deepEqual(findReservedNames(dir), []);
  assert.doesNotThrow(() => assertNoReservedNames(dir));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('top-level __tests__ directory is flagged', () => {
  const dir = fixture((d) => { mk(d, 'manifest.json'); mkdir(d, '__tests__'); mk(d, '__tests__/x.test.mjs'); });
  const bad = findReservedNames(dir);
  assert.ok(bad.includes('__tests__'), JSON.stringify(bad));
  assert.throws(() => assertNoReservedNames(dir), /réservés|réservé/);
});

test('nested "_"-prefixed file is flagged with its relative path', () => {
  const dir = fixture((d) => { mk(d, 'manifest.json'); mk(d, 'vendor/shared/_private.mjs'); });
  const bad = findReservedNames(dir);
  assert.ok(bad.includes('vendor/shared/_private.mjs'), JSON.stringify(bad));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('_metadata (Chrome-reserved) is flagged; _locales is not', () => {
  const dir = fixture((d) => { mk(d, 'manifest.json'); mkdir(d, '_metadata'); mkdir(d, '_locales/fr'); mk(d, '_locales/fr/messages.json'); });
  const bad = findReservedNames(dir);
  assert.ok(bad.includes('_metadata'));
  assert.ok(!bad.some((b) => b.startsWith('_locales')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('error message is French and lists every offending path', () => {
  const dir = fixture((d) => { mk(d, '__tests__/a.mjs'); mk(d, '_foo/b.mjs'); });
  try { assertNoReservedNames(dir); assert.fail('should have thrown'); }
  catch (e) { assert.match(e.message, /Chrome/); assert.match(e.message, /__tests__/); assert.match(e.message, /_foo/); }
  fs.rmSync(dir, { recursive: true, force: true });
});
