/**
 * Host runtime config — where the per-install pairing secret and the app IPC
 * endpoint live. Both are in the USER PROFILE, never in the repo. The secret is
 * created by the desktop app on first run; the host only reads it and presents it
 * to the app on the pipe so a rogue local process can't drive the app.
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

/** The app-data directory for Eloshon on this OS. */
export function appDataDir() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'EloshonScraper');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'EloshonScraper');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'eloshon-scraper');
}

/** The named-pipe / unix-socket path the running app listens on. */
export function appEndpoint() {
  if (process.platform === 'win32') return '\\\\.\\pipe\\eloshon-scraper-host';
  return path.join(appDataDir(), 'host.sock');
}

/** Read the pairing secret (or null if the app has not created it yet). Never logged. */
export function readPairingSecret() {
  try {
    const f = process.env.ELOSHON_PAIRING_FILE || path.join(appDataDir(), 'pairing.secret');
    const s = fs.readFileSync(f, 'utf8').trim();
    return s || null;
  } catch { return null; }
}
