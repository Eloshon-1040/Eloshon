/**
 * Package the extension into a clean, store-ready .zip with manifest.json at the
 * archive ROOT. Includes only runtime files; excludes tests, docs, keys, the
 * extension-id file, dev scripts and anything not referenced by the manifest or
 * imported by the code. The dev-only `key` is stripped (the store assigns the ID).
 * The native host is NOT included (it ships with the desktop installer).
 *
 * Version gate: fails if manifest.version is unchanged since the last packaged
 * version (tracked in dist-extension/.last-version — no secret).
 *
 * Output: dist-extension/eloshon-scraper-extension-<version>.zip (git-ignored).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { zipCreate } from './lib/zip.mjs';
import { collectRuntimeEntries } from './lib/extension-files.mjs';
import { assertNoReservedNames } from './lib/extension-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const OUT_DIR = path.join(ROOT, 'dist-extension');

function fail(msg) { console.error(`package:extension — ${msg}`); process.exit(1); }

// 1) Refresh the vendored shared snapshot so the package ships current code.
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-extension.mjs')], { stdio: 'inherit' });

// 1b) Reserved-name guard: refuse to package a folder Chrome could not load.
try { assertNoReservedNames(EXT); } catch (e) { fail(String(e && e.message || e)); }

// 2) Load + validate the manifest; strip the dev `key`.
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const version = String(manifest.version || '');
if (!/^\d+(\.\d+){0,3}$/.test(version)) fail(`version « ${version} » invalide (1 à 4 entiers séparés par des points).`);
const hadKey = 'key' in manifest;

// 3) Version gate.
fs.mkdirSync(OUT_DIR, { recursive: true });
const lastFile = path.join(OUT_DIR, '.last-version');
const last = fs.existsSync(lastFile) ? fs.readFileSync(lastFile, 'utf8').trim() : '';
if (last && last === version) fail(`la version (${version}) n'a pas changé depuis le dernier paquet. Incrémentez manifest.version avant d'empaqueter.`);

// 4) Collect runtime files (shared collector — single source of truth with the
// verifier's parity check). manifest.json is first, dev `key` already stripped.
const entries = collectRuntimeEntries(EXT, { stripKey: true }).map(({ name, data }) => ({ name, data }));

// 5) Write the zip.
const zip = zipCreate(entries);
const zipName = `eloshon-scraper-extension-${version}.zip`;
const zipPath = path.join(OUT_DIR, zipName);
fs.writeFileSync(zipPath, zip);
fs.writeFileSync(lastFile, version + '\n');

// 6) Report.
console.log(`\npackage:extension — wrote ${path.relative(ROOT, zipPath)} (${(zip.length / 1024).toFixed(1)} KiB, ${entries.length} files)`);
console.log('files:');
for (const e of entries) console.log('  ' + e.name);
console.log('\nNotes:');
console.log(hadKey ? '  - dev `key` field STRIPPED from packaged manifest (the Web Store assigns its own ID).' : '  - no `key` field present.');
console.log('  - native host NOT included (it ships with the desktop installer).');
console.log('  - after publication, update the native host manifest allowed_origins with the store-assigned extension ID (unless a fixed ID is chosen in the dashboard).');
console.log(`\nNow verify:  node scripts/verify-extension-zip.mjs ${path.relative(ROOT, zipPath)}`);
