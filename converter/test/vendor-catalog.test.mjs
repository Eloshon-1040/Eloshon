/**
 * Phase 2 Lot 2 — the vendored @eloshon/catalog runtime (core/vendor/
 * eloshon-catalog, see its README) must stay byte-identical to the catalog it
 * was copied from. Skipped — with the reason — on a machine without the
 * sibling catalog checkout; the copy itself is what ships either way.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'core', 'vendor', 'eloshon-catalog');
const CATALOG = path.resolve(ROOT, '..', '..', 'eloshon-catalog');
const FILES = ['index.mjs', 'src/catalog-io.mjs', 'src/edits.mjs'];

test('vendored catalog runtime is byte-identical to @eloshon/catalog', { skip: !fs.existsSync(CATALOG) && 'sibling catalog checkout not present' }, () => {
  // content, not line endings: the catalog checkout may be CRLF (core.autocrlf)
  const text = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  for (const f of FILES) {
    assert.equal(text(path.join(VENDOR, f)), text(path.join(CATALOG, f)), `${f} drifted from the catalog — re-copy it (core/vendor/eloshon-catalog/README.md)`);
  }
});

test('the installer ships the vendored runtime', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('core/vendor/**/*'), 'package.json build.files must include core/vendor/**/*');
});
