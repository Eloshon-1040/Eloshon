/**
 * Generate (once) the stable DEV signing key for the unpacked extension and
 * derive the manifest `key` field + the resulting extension ID.
 *
 * WHY: Chrome/Edge derive an unpacked extension's ID from its public key. Without
 * a pinned `key`, the ID changes with the folder path — which breaks Native
 * Messaging (its manifest's `allowed_origins` locks to one extension ID) and any
 * dev pairing. Pinning the PUBLIC key in manifest.json gives a stable ID on both
 * browsers and every machine.
 *
 * SECURITY: the PRIVATE key (.pem) is written to extension/.keys/ which is
 * git-ignored and is NEVER committed, printed, packaged or logged. Only the
 * PUBLIC key and the derived ID are emitted. The Chrome Web Store assigns its own
 * ID at publication; the dev `key` is stripped from the packaged zip (see the
 * packaging script) unless a fixed-ID option is chosen in the dashboard.
 *
 * Usage:
 *   node scripts/gen-extension-key.mjs           # create if missing, print key + id
 *   node scripts/gen-extension-key.mjs --write   # also write `key` into extension/manifest.json
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const KEY_DIR = path.join(ROOT, 'extension', '.keys');
const PEM = path.join(KEY_DIR, 'dev.pem');
const MANIFEST = path.join(ROOT, 'extension', 'manifest.json');

function ensureKey() {
  if (fs.existsSync(PEM)) return fs.readFileSync(PEM, 'utf8');
  fs.mkdirSync(KEY_DIR, { recursive: true });
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  fs.writeFileSync(PEM, pem, { mode: 0o600 });
  return pem;
}

/** Derive the base64 SPKI public key (the manifest `key`) and the extension ID. */
function derive(pem) {
  const pub = crypto.createPublicKey(pem);
  const der = pub.export({ type: 'spki', format: 'der' });
  const keyB64 = der.toString('base64');
  const hash = crypto.createHash('sha256').update(der).digest();
  // Chrome maps the first 16 bytes' hex nibbles 0-f -> a-p.
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (hash[i] >> 4));
    id += String.fromCharCode(97 + (hash[i] & 0x0f));
  }
  return { keyB64, id };
}

const pem = ensureKey();
const { keyB64, id } = derive(pem);

console.log('Extension dev key ready.');
console.log('  private key : extension/.keys/dev.pem  (git-ignored, never commit)');
console.log('  extension ID:', id);
console.log('  manifest key:', keyB64.slice(0, 32) + '…(' + keyB64.length + ' chars)');

if (process.argv.includes('--write')) {
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  m.key = keyB64;
  fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + '\n');
  console.log('  wrote `key` into extension/manifest.json');
}

// Emit the ID to a tiny file the native-host installer reads (no secret).
fs.mkdirSync(path.join(ROOT, 'extension'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'extension', 'extension-id.txt'), id + '\n');
