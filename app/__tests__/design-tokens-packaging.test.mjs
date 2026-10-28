/**
 * Design tokens and fonts have one source: shared/design/ (.interface-design/system.md). The Scraper renderer loads
 * them directly (../../shared/design/ from app/renderer/), which works only while the installer ships shared/**.
 * The extension must NOT receive them: scripts/build-extension.mjs copies only *.mjs into extension/vendor/shared/.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('shared/design/ holds the base, both app files and the bundled fonts with their licences', () => {
  for (const f of ['tokens.base.css', 'tokens.converter.css', 'tokens.scraper.css',
    'fonts/inter-latin-wght-normal.woff2', 'fonts/inter-latin-ext-wght-normal.woff2',
    'fonts/jetbrains-mono-latin-wght-normal.woff2', 'fonts/jetbrains-mono-latin-ext-wght-normal.woff2',
    'fonts/OFL-Inter.txt', 'fonts/OFL-JetBrainsMono.txt']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'shared/design', f)), `missing shared/design/${f}`);
  }
});

test('the Scraper installer ships shared/** (so the renderer can link shared/design/ directly)', () => {
  const files = pkg.build.files;
  assert.ok(files.includes('shared/**/*'), 'build.files must include shared/**/*');
  assert.ok(!files.some((f) => f.startsWith('!shared/') && !f.includes('__tests__')), 'nothing in shared/ may be excluded except tests');
});

test('the extension never receives the design files', () => {
  const vendor = path.join(ROOT, 'extension/vendor/shared/design');
  assert.ok(!fs.existsSync(vendor), 'extension/vendor/shared/design must not exist (build-extension copies *.mjs only)');
});
