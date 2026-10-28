/**
 * Admin subsystem factory (MAIN process). Wires the secure store (Electron
 * safeStorage + userData blob), the admin session (admin.json), the provider
 * runtime (config.json `providers` block) and the admin-gated IPC — so main.mjs
 * only needs a couple of lines. Additive: when the panel is never used, no
 * provider block is written and existing behaviour is unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import { AdminSession } from './session.mjs';
import { SecureStore } from './secure-store.mjs';
import { ProviderRuntime } from '../../core/providers/runtime.mjs';
import { isConfigured } from '../../core/providers/registry.mjs';
import { registerAdminIpc } from './ipc.mjs';
import { updateConfig } from './config-store.mjs';

/**
 * @param {{ dirs, ipcMain, dialog, getWindow?, log?, getMeter?:()=>object|null,
 *   readJobReport?:(jobId:string)=>object|null, knownDomains?:()=>string[] }} io
 */
export function createAdminSubsystem({ dirs, ipcMain, dialog, getWindow, log = () => {}, getMeter = null, readJobReport = null, knownDomains = null }) {
  const dataDir = dirs.data || path.dirname(dirs.configFile);
  // Canonical userData paths (lib/osenv.appDirs); the fallbacks keep a hand-built
  // `dirs` working. All three live under userData, safe across an app update.
  const adminFile = dirs.adminFile || path.join(dataDir, 'admin.json');
  const secretFile = dirs.secretFile || path.join(dataDir, 'providers.secret'); // opaque encrypted blob
  const balancesFile = dirs.balancesFile || path.join(dirs.userData || path.dirname(dirs.configFile), 'provider-balances.json'); // cached FREE balance reads (no secret)

  const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };
  const writeJson = (p, v) => { try { fs.writeFileSync(p, JSON.stringify(v, null, 2)); } catch { /* ignore */ } };

  const adminStore = { readAdmin: () => readJson(adminFile, null), writeAdmin: (o) => writeJson(adminFile, o) };
  const secureStore = new SecureStore({
    safeStorage,
    readBlob: () => { try { return fs.readFileSync(secretFile, 'utf8'); } catch { return null; } },
    writeBlob: (b64) => { try { fs.writeFileSync(secretFile, b64, 'utf8'); } catch { /* ignore */ } },
    deleteBlob: () => { try { fs.unlinkSync(secretFile); } catch { /* ignore */ } },
    log,
  });
  const session = new AdminSession(adminStore);
  const resolveIo = () => ({ secure: secureStore.getAll(), config: readJson(dirs.configFile, {}), env: process.env });
  const runtime = new ProviderRuntime((readJson(dirs.configFile, {}).providers) || {}, { isConfigured: (id) => isConfigured(id, resolveIo()) });
  // Atomic read-modify-write: only the `providers` block changes, the rest of
  // config.json (opt-in lists, costs, settings) is preserved as read from disk.
  const persist = () => {
    const r = updateConfig(dirs.configFile, (cfg) => { cfg.providers = runtime.state; return cfg; });
    if (!r.ok) log('écriture du bloc providers impossible (' + r.error + ')');
  };

  registerAdminIpc({
    ipcMain, session, secureStore, runtime, persist, resolveIo, log,
    configFile: dirs.configFile, balancesFile, getMeter, readJobReport, knownDomains,
    readEnvFile: (p) => fs.readFileSync(p, 'utf8'),
    pickEnvFile: async () => {
      const r = await dialog.showOpenDialog(getWindow ? getWindow() : undefined, {
        title: 'Importer un fichier .env',
        properties: ['openFile'],
        filters: [{ name: 'Fichiers .env', extensions: ['local', 'env'] }, { name: 'Tous les fichiers', extensions: ['*'] }],
      });
      return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
    },
    pickSavePath: async (defaultName) => {
      const r = await dialog.showSaveDialog(getWindow ? getWindow() : undefined, {
        title: 'Exporter l\'utilisation (CSV)',
        defaultPath: defaultName,
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      });
      return r.canceled || !r.filePath ? null : r.filePath;
    },
  });

  return { session, secureStore, runtime, persist, resolveIo };
}
