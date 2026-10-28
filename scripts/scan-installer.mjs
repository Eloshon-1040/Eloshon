/**
 * Scan the built Windows app bundle to prove NO keys ship in the installer
 * (requirement J): no .env file, no admin passphrase file, an EMPTY provider
 * secret store, and no provider key NAME paired with a real value.
 *
 * Uses @electron/asar to inspect EACH bundled file individually (no cross-file
 * false positives). Read-only. Prints .exe path/size/version + PASS/FAIL.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as asar from '@electron/asar';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const problems = [];
const flag = (m) => problems.push(m);

let exe = null;
try { exe = fs.readdirSync(DIST).find((f) => f.endsWith('.exe') && f.includes(version)); } catch { /* */ }
if (exe) {
  const st = fs.statSync(path.join(DIST, exe));
  console.log(`Installateur : ${path.join('dist', exe)}`);
  console.log(`  taille  : ${(st.size / (1024 * 1024)).toFixed(1)} Mo`);
  console.log(`  version : ${version}`);
} else { console.log(`(pas de .exe pour ${version} dans dist/)`); }

const asarPath = path.join(DIST, 'win-unpacked', 'resources', 'app.asar');
if (!fs.existsSync(asarPath)) { console.log('(app.asar introuvable — build non terminé ?)'); process.exit(exe ? 0 : 1); }

// listPackage returns OS-style paths (backslashes on Windows). Normalise to the
// forward-slash, no-leading-separator form extractFile expects.
const norm = (e) => e.replace(/\\/g, '/').replace(/^\/+/, '');
const entries = asar.listPackage(asarPath).map(norm);
const files = entries.filter((e) => e && !e.endsWith('/'));

// 1) Forbidden files must be absent from the bundle.
const FORBIDDEN_FILE = [/(^|\/)\.env(\.[^/]*)?$/i, /(^|\/)admin\.json$/i, /(^|\/)providers\.secret$/i, /(^|\/)pairing\.secret$/i, /\.pem$/i];
for (const n of files) for (const re of FORBIDDEN_FILE) if (re.test(n)) flag(`Fichier interdit dans le bundle : ${n}`);

// 2) Per-file content scan for a key NAME paired with a real VALUE (excludes the
//    template `${…}` and the doc placeholder `<…>`).
const ASSIGN = [
  /BRIGHT-?DATA-?API-?KEY\s*[=:]\s*["']?(?![$<])[A-Za-z0-9][A-Za-z0-9_\-]{7,}/,
  /BROWSER_AUTH\s*[=:]\s*["']?brd-customer-(?![$<])[a-z0-9]/i,
  /FIRECRAWL-?API-?KEY\s*[=:]\s*["']?(?![$<])fc-?[A-Za-z0-9]/i,
  /ZYTE_API_KEY\s*[=:]\s*["']?(?![$<])[A-Za-z0-9]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
const TEXT = /\.(mjs|cjs|js|json|txt|md|html|css|map)$/i;
let scanned = 0;
for (const n of files) {
  if (!TEXT.test(n)) continue;
  let content; try { content = asar.extractFile(asarPath, n).toString('utf8'); } catch { continue; }
  scanned++;
  for (const re of ASSIGN) { const m = content.match(re); if (m) flag(`Clé=valeur potentielle dans ${n} : « ${m[0].slice(0, 22)}… »`); }
}

// 3) Also scan the asarUnpack tree on disk (core/unlock/**, etc.) — same rules.
const unpackedDir = path.join(DIST, 'win-unpacked', 'resources', 'app.asar.unpacked');
let unpackedScanned = 0;
if (fs.existsSync(unpackedDir)) {
  (function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      const rel = path.relative(path.join(DIST, 'win-unpacked', 'resources'), abs).replace(/\\/g, '/');
      for (const re of FORBIDDEN_FILE) if (re.test(rel)) flag(`Fichier interdit (unpacked) : ${rel}`);
      if (ent.isDirectory()) { walk(abs); continue; }
      if (!TEXT.test(ent.name)) continue;
      let content; try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      unpackedScanned++;
      for (const re of ASSIGN) { const m = content.match(re); if (m) flag(`Clé=valeur potentielle (unpacked) dans ${rel} : « ${m[0].slice(0, 22)}… »`); }
    }
  })(unpackedDir);
}

console.log(`  fichiers bundle : ${files.length} (scannés texte : ${scanned} + unpacked : ${unpackedScanned})`);
const hasStore = files.some((n) => /providers\.secret/.test(n));
console.log('  store de fournisseurs : ' + (hasStore ? 'PRÉSENT (anormal)' : 'vide (aucun providers.secret) ✓'));

if (problems.length) { console.error('\n❌ Fuite potentielle :'); for (const p of problems) console.error('  - ' + p); process.exit(1); }
console.log('\n✅ Aucun secret, aucune phrase secrète, store vide : l\'installateur ne contient aucune clé.');
