/**
 * Build step: snapshot the portable `shared/` modules into
 * `extension/vendor/shared/` so the extension ships EXACTLY the code the app runs
 * (one source of truth) while staying self-contained — Chrome Web Store forbids
 * loading code from outside the package, and an extension cannot import `../shared`.
 *
 * The vendor copy is git-ignored and regenerated here, so it can never drift into
 * a stale committed bundle: run this before loading unpacked or packaging.
 *
 * Copies only *.mjs, excludes __tests__, and fails loudly if `shared/` is missing
 * (never silently produces an empty vendor dir).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoReservedNames } from './lib/extension-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'shared');
const DEST = path.join(ROOT, 'extension', 'vendor', 'shared');

function fail(msg) { console.error(`build-extension: ${msg}`); process.exit(1); }

if (!fs.existsSync(SRC)) fail(`source shared/ not found at ${SRC}`);

let copied = 0;
function walk(srcDir, destDir) {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const s = path.join(srcDir, entry.name);
    const d = path.join(destDir, entry.name);
    if (entry.isDirectory()) { walk(s, d); continue; }
    if (!entry.name.endsWith('.mjs')) continue;
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(s, d);
    copied += 1;
  }
}

// Clean the destination so a removed shared file never lingers in vendor.
fs.rmSync(DEST, { recursive: true, force: true });
walk(SRC, DEST);

if (copied === 0) fail('copied 0 modules — refusing to produce an empty vendor snapshot');
console.log(`build-extension: copied ${copied} shared modules -> extension/vendor/shared/`);

// Reserved-name guard: fail the build if the extension folder contains any path
// Chrome would refuse to load (a name starting with "_", except _locales).
try {
  assertNoReservedNames(path.join(ROOT, 'extension'));
  console.log('build-extension: reserved-name guard OK (no "_"-prefixed paths except _locales)');
} catch (e) { fail(String(e && e.message || e)); }
