/**
 * Self-register the native messaging host for the RUNNING app — so an end user just
 * runs the installer and the extension connects, with NO PowerShell, NO admin, and
 * NO system Node:
 *   • the launcher runs the host through the app's OWN Electron binary as Node
 *     (ELECTRON_RUN_AS_NODE), so the user needs nothing installed;
 *   • the HKCU registry keys are written with reg.exe (a plain Windows command, not
 *     PowerShell), under the current user only (never HKLM, never admin);
 *   • the manifest always points at the app that is running right now, so switching
 *     between the installed app and a dev run never leaves a stale registration.
 *
 * Idempotent (writes only on change) and best-effort (any failure is logged, never
 * fatal). PURE except for the injected fs/execFile, so it is unit-tested.
 */
import path from 'node:path';

export const HOST_NAME = 'com.eloshon.scraper.host';
// The stable dev/unpacked extension ID. The Web-Store ID is ADDED (not replaced) via
// config.yourBrowser.extensionIds once published, so both keep working.
export const DEFAULT_EXTENSION_IDS = ['acpkobbipplbgncgjkabebhmpojlndge'];

// HKCU native-messaging-host base keys per Chromium browser.
export const BROWSER_BASES = {
  chrome: 'Software\\Google\\Chrome\\NativeMessagingHosts',
  edge: 'Software\\Microsoft\\Edge\\NativeMessagingHosts',
  brave: 'Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts',
};

/** The native-host manifest object (Chrome native messaging schema). */
export function hostManifest(launcherPath, extensionIds) {
  const ids = [...new Set((extensionIds && extensionIds.length ? extensionIds : DEFAULT_EXTENSION_IDS).filter(Boolean))];
  return {
    name: HOST_NAME,
    description: 'Eloshon Scraper native messaging host (relay to the desktop app).',
    path: launcherPath,
    type: 'stdio',
    allowed_origins: ids.map((id) => `chrome-extension://${id}/`),
  };
}

/** Windows launcher: run host.mjs via the app's Electron AS Node (no system Node). */
export function launcherScript(execPath, hostMjsPath) {
  return `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${execPath}" "${hostMjsPath}" %*\r\n`;
}

/** `reg add` argv (no PowerShell) to point a browser's host key at the manifest. */
export function regAddArgs(base, manifestPath) {
  return ['add', `HKCU\\${base}\\${HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'];
}
export function regDeleteArgs(base) {
  return ['delete', `HKCU\\${base}\\${HOST_NAME}`, '/f'];
}

/** Resolve the on-disk host.mjs (must be UNPACKED so the browser can launch it). */
export function resolveHostMjs({ isPackaged, resourcesPath, repoRoot }) {
  return isPackaged
    ? path.join(resourcesPath, 'app.asar.unpacked', 'native-host', 'host.mjs')
    : path.join(repoRoot, 'native-host', 'host.mjs');
}

const readSafe = (fs, p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

/**
 * Ensure the host is registered for this app. Injected io:
 *   { platform, dataDir, hostMjsPath, execPath, extensionIds?, fs, execFile, log? }
 * @returns {Promise<{ok:boolean, manifestPath?:string, launcher?:string, reason?:string, registered?:string[]}>}
 */
export async function ensureNativeHostRegistered(io) {
  const { platform, dataDir, hostMjsPath, execPath, extensionIds, fs, execFile, log = () => {} } = io;
  if (platform !== 'win32') return { ok: false, reason: 'unsupported_platform' };
  if (!dataDir || !hostMjsPath || !execPath || !fs || !execFile) return { ok: false, reason: 'missing_io' };
  try {
    const dir = path.join(dataDir, 'native-host');
    fs.mkdirSync(dir, { recursive: true });
    const launcher = path.join(dir, 'host.bat');
    const manifestPath = path.join(dir, `${HOST_NAME}.json`);
    const wantBat = launcherScript(execPath, hostMjsPath);
    const wantManifest = JSON.stringify(hostManifest(launcher, extensionIds), null, 2) + '\n';
    if (readSafe(fs, launcher) !== wantBat) fs.writeFileSync(launcher, wantBat);
    if (readSafe(fs, manifestPath) !== wantManifest) fs.writeFileSync(manifestPath, wantManifest);
    const registered = [];
    for (const [browser, base] of Object.entries(BROWSER_BASES)) {
      const ok = await new Promise((resolve) => {
        try { execFile('reg', regAddArgs(base, manifestPath), (err) => resolve(!err)); }
        catch { resolve(false); }
      });
      if (ok) registered.push(browser);
    }
    log(`hôte natif enregistré (${registered.join(', ') || 'aucun navigateur'})`);
    return { ok: registered.length > 0, manifestPath, launcher, registered };
  } catch (e) {
    log(`enregistrement de l'hôte natif ignoré (${(e && e.code) || 'erreur'})`);
    return { ok: false, reason: 'error' };
  }
}
