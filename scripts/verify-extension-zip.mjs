/**
 * Verify a packaged extension .zip against the store rules. Fails with a clear
 * FRENCH message on any problem. Read-only: inspects the produced zip.
 *
 * Usage: node scripts/verify-extension-zip.mjs [path-to-zip]
 *        (defaults to the newest zip in dist-extension/)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipRead } from './lib/zip.mjs';
import { runtimeFileNames } from './lib/extension-files.mjs';
import { findReservedNames } from './lib/extension-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const OUT_DIR = path.join(ROOT, 'dist-extension');

const problems = [];
const flag = (m) => problems.push(m);

function pickZip() {
  const arg = process.argv[2];
  if (arg) return path.resolve(ROOT, arg);
  if (!fs.existsSync(OUT_DIR)) { console.error('Aucun dossier dist-extension/. Lancez d\'abord package:extension.'); process.exit(1); }
  const zips = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.zip')).map((f) => ({ f, t: fs.statSync(path.join(OUT_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  if (!zips.length) { console.error('Aucun .zip dans dist-extension/. Lancez d\'abord package:extension.'); process.exit(1); }
  return path.join(OUT_DIR, zips[0].f);
}

const zipPath = pickZip();
const buf = fs.readFileSync(zipPath);
const entries = zipRead(buf);
const byName = new Map(entries.map((e) => [e.name, e]));
const text = (name) => { const e = byName.get(name); return e ? e.data.toString('utf8') : null; };

// 1) manifest.json at ROOT + valid MV3.
const manRaw = text('manifest.json');
if (!manRaw) flag('manifest.json absent de la racine du zip.');
let manifest = null;
if (manRaw) {
  try { manifest = JSON.parse(manRaw); } catch { flag('manifest.json illisible (JSON invalide).'); }
}
if (manifest) {
  if (manifest.manifest_version !== 3) flag('manifest_version doit valoir 3.');
  if (!manifest.name) flag('manifest.name manquant.');
  if (!/^\d+(\.\d+){0,3}$/.test(String(manifest.version || ''))) flag(`version « ${manifest.version} » invalide (1 à 4 entiers).`);
  if ('key' in manifest) flag('Le champ `key` (clé de dev) ne doit pas être dans le paquet du store.');
}

// 2) No secrets / private keys / env / absolute paths.
const SECRET_RE = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /BROWSER_AUTH/i, /\bapi[_-]?key\b\s*[:=]\s*["'][^"']+/i, /\bsk-[A-Za-z0-9]{16,}/, /\bbrd-customer-/i];
const ABS_PATH_RE = [/[A-Za-z]:\\\\?Users\\/, /[A-Za-z]:\\eloshon-scraper/i, /\/Users\/[a-z]/i, /\/home\/[a-z]/i];
for (const e of entries) {
  if (/\.pem$/i.test(e.name)) flag(`Fichier de clé privée interdit dans le zip : ${e.name}`);
  if (/(^|\/)\.env/i.test(e.name)) flag(`Fichier d'environnement interdit dans le zip : ${e.name}`);
  if (/\.(mjs|js|json|html|css)$/i.test(e.name)) {
    const s = e.data.toString('utf8');
    for (const re of SECRET_RE) if (re.test(s)) flag(`Motif de secret détecté dans ${e.name}.`);
    for (const re of ABS_PATH_RE) if (re.test(s)) flag(`Chemin local absolu détecté dans ${e.name}.`);
  }
}

// 3) No remote code / eval.
const REMOTE_RE = [/\beval\s*\(/, /new\s+Function\s*\(/, /import\s*\(\s*["']https?:/i, /<script[^>]+src=["']https?:/i, /fetch\(\s*["']https?:\/\/(?!.*\{)/i];
for (const e of entries) {
  if (!/\.(mjs|js|html)$/i.test(e.name)) continue;
  const s = e.data.toString('utf8');
  if (/\beval\s*\(/.test(s)) flag(`eval() détecté dans ${e.name}.`);
  if (/new\s+Function\s*\(/.test(s)) flag(`new Function détecté dans ${e.name}.`);
  if (/import\s*\(\s*["']https?:/i.test(s)) flag(`import distant détecté dans ${e.name}.`);
  if (/<script[^>]+src=["']https?:/i.test(s)) flag(`<script src distant détecté dans ${e.name}.`);
}

// 4) Every manifest-referenced file exists; no dev/test files present.
if (manifest) {
  const refs = [];
  if (manifest.background && manifest.background.service_worker) refs.push(manifest.background.service_worker);
  if (manifest.action && manifest.action.default_popup) refs.push(manifest.action.default_popup);
  for (const v of Object.values(manifest.icons || {})) refs.push(v);
  if (manifest.default_locale) refs.push(`_locales/${manifest.default_locale}/messages.json`);
  for (const r of refs) if (!byName.has(r)) flag(`Fichier référencé par le manifeste absent du zip : ${r}`);
}
for (const e of entries) {
  if (/(^|\/)__tests__\//.test(e.name) || /\.test\.mjs$/.test(e.name)) flag(`Fichier de test ne devrait pas être empaqueté : ${e.name}`);
  if (/(^|\/)\.keys\//.test(e.name) || e.name === 'extension-id.txt') flag(`Fichier de dev ne devrait pas être empaqueté : ${e.name}`);
}

// 5) Permissions vs the justification checklist.
const checklistPath = path.join(ROOT, 'docs', 'extension-permissions.json');
if (manifest && fs.existsSync(checklistPath)) {
  const cl = JSON.parse(fs.readFileSync(checklistPath, 'utf8'));
  for (const p of (manifest.permissions || [])) if (!cl.permissions || !cl.permissions[p]) flag(`Permission « ${p} » sans justification dans docs/extension-permissions.json.`);
  for (const p of (manifest.optional_host_permissions || [])) if (!cl.optional_host_permissions || !cl.optional_host_permissions[p]) flag(`optional_host_permission « ${p} » sans justification.`);
}

// 6) Reserved-name guard on the source extension folder (same shared function as ext:build).
for (const bad of findReservedNames(EXT)) flag(`Nom réservé par Chrome (préfixe « _ ») dans le dossier de l'extension : ${bad} (seul « _locales » est autorisé).`);

// 7) Folder <-> zip parity: the zip's runtime file set must equal the unpacked one.
try {
  const expected = new Set(runtimeFileNames(EXT));
  const got = new Set(entries.map((e) => e.name));
  for (const n of expected) if (!got.has(n)) flag(`Fichier présent dans le dossier mais absent du zip : ${n}`);
  for (const n of got) if (!expected.has(n)) flag(`Fichier présent dans le zip mais pas dans l'ensemble runtime attendu : ${n}`);
} catch (e) { flag(`Contrôle de parité dossier↔zip impossible : ${String(e && e.message || e)}`); }

// Report.
console.log(`Vérification de ${path.relative(ROOT, zipPath)} (${(buf.length / 1024).toFixed(1)} KiB, ${entries.length} fichiers)`);
if (manifest) {
  console.log(`  permissions: ${(manifest.permissions || []).join(', ') || '(aucune)'}`);
  console.log(`  optional_host_permissions: ${(manifest.optional_host_permissions || []).join(', ') || '(aucune)'}`);
}
console.log('  fichiers:'); for (const e of entries) console.log('    ' + e.name + ` (${e.size} o)`);

if (problems.length) {
  console.error('\n❌ Problèmes détectés :');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('\n✅ Paquet conforme : manifest à la racine, MV3 valide, aucun secret, aucun code distant, fichiers référencés présents.');
