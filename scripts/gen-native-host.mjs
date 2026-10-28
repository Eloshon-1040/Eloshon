/**
 * Generate the native messaging host manifest + Windows launcher, locked to the
 * stable extension ID. Writes ONLY under native-host/. Does NOT touch the
 * registry — it prints the exact commands for you to review and run yourself.
 *
 * Usage: node scripts/gen-native-host.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HOST_DIR = path.join(ROOT, 'native-host');
const HOST_NAME = 'com.eloshon.scraper.host';

function readExtensionId() {
  const f = path.join(ROOT, 'extension', 'extension-id.txt');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  console.error('extension-id.txt missing — run `npm run ext:key` first.');
  process.exit(1);
}

const extId = readExtensionId();
const manifestPath = path.join(HOST_DIR, `${HOST_NAME}.json`);
const batPath = path.join(HOST_DIR, 'host.bat');
const hostScript = path.join(HOST_DIR, 'host.mjs');

// Windows launcher: run the host with the system node.
fs.writeFileSync(batPath, `@echo off\r\nnode "%~dp0host.mjs" %*\r\n`);

// The host manifest. `path` points at the launcher (Windows) / host.mjs elsewhere.
const manifest = {
  name: HOST_NAME,
  description: 'Eloshon Scraper native messaging host (relay to the desktop app).',
  path: process.platform === 'win32' ? batPath : hostScript,
  type: 'stdio',
  allowed_origins: [`chrome-extension://${extId}/`],
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

console.log('Native host manifest written:');
console.log('  ' + manifestPath);
console.log('  allowed_origins -> chrome-extension://' + extId + '/');
console.log('');
console.log('Registry keys to register the host (HKCU — review before running):');
console.log('  Chrome: HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\' + HOST_NAME);
console.log('  Edge  : HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\' + HOST_NAME);
console.log('  (value = the manifest path above)');
