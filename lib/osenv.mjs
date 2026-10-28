/**
 * OS abstraction layer — the ONLY place aware of per-platform differences
 * (storage locations, window chrome, shortcut labels). The core engine and the
 * UI stay OS-agnostic. Windows + macOS (and Linux) share everything else.
 *
 * All user data lives under the OS app-data directory (never in the repo or the
 * packaged bundle): pass Electron's app.getPath('userData').
 */
import path from 'node:path';
import fs from 'node:fs';

export const isMac = process.platform === 'darwin';
export const isWin = process.platform === 'win32';
export const isLinux = process.platform === 'linux';

/** Absolute app-data locations derived from Electron's userData dir — the SINGLE
 *  place that names every user-data file. Everything here is under `userData`
 *  (Electron's app-data dir, e.g. %APPDATA%\Eloshon Scraper on Windows), which the
 *  installer never writes to — so an app update or reinstall keeps every setting,
 *  key, job, recipe and the usage history. Guarded by lib/__tests__/user-data-location.
 *  `data` is the engine outputDir → jobstore writes jobs/ csv/ reports/ and the
 *  headful browser profile (.browser-profile) under it. */
export function appDirs(userDataPath) {
  const data = path.join(userDataPath, 'data');
  return {
    userData: userDataPath,
    data,
    jobs: path.join(data, 'jobs'),
    csv: path.join(data, 'csv'),
    reports: path.join(data, 'reports'),
    browserProfile: path.join(data, '.browser-profile'),
    logs: path.join(userDataPath, 'logs'),
    configFile: path.join(userDataPath, 'config.json'),
    configBackup: path.join(userDataPath, 'config.previous.json'),
    profilesFile: path.join(userDataPath, 'sources.json'),
    // Provider admin + metering + learned recipes (same userData root, so an update
    // never wipes them). Call sites read these instead of re-joining paths by hand.
    secretFile: path.join(data, 'providers.secret'),   // opaque encrypted blob (DPAPI/Keychain)
    adminFile: path.join(data, 'admin.json'),
    balancesFile: path.join(userDataPath, 'provider-balances.json'),
    ledgerDir: path.join(userDataPath, 'usage-ledger'),
    domainProfilesFile: path.join(data, 'domain-profiles.json'),
  };
}

/** Every production user-data path under a userData root (for the guarantee test and
 *  the "where does my data live" docs). All are absolute and inside `userDataPath`. */
export function userDataPaths(userDataPath) {
  const d = appDirs(userDataPath);
  return {
    config: d.configFile, configBackup: d.configBackup, sources: d.profilesFile,
    secret: d.secretFile, admin: d.adminFile, balances: d.balancesFile,
    usageLedger: d.ledgerDir, domainProfiles: d.domainProfilesFile,
    jobs: d.jobs, csv: d.csv, reports: d.reports, browserProfile: d.browserProfile, logs: d.logs,
  };
}

export function ensureDirs(dirs) {
  for (const d of [dirs.data, dirs.jobs, dirs.csv, dirs.reports, dirs.logs]) {
    fs.mkdirSync(d, { recursive: true });
  }
  return dirs;
}

/** BrowserWindow chrome options per OS: macOS keeps native traffic lights
 *  (hidden title bar, inset); Windows/Linux are frameless (custom controls). */
export function windowChrome() {
  if (isMac) return { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 14 } };
  return { frame: false };
}

export const modKey = isMac ? '⌘' : 'Ctrl';
