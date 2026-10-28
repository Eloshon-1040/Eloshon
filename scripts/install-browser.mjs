/**
 * Installs the Chromium build INTO the project (.playwright-browsers) so it is
 * deterministic, path-independent and ready to be bundled by electron-builder
 * (extraResources → resources/ms-playwright). Cross-platform (Win/mac/Linux).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(ROOT, '.playwright-browsers');
const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: dir };

console.log('Installing Chromium into', dir);
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const r = spawnSync(npx, ['playwright', 'install', 'chromium'], { stdio: 'inherit', env, shell: process.platform === 'win32' });
process.exit(r.status ?? 1);
