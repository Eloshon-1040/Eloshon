/**
 * Eloshon Scraper — Electron main process.
 *
 * Bridges the OS + the GUI controller (which drives the generic core). All user
 * data lives under the OS app-data dir. Chromium is resolved dynamically for dev
 * and packaged builds. No Luna, no vendor lock-in.
 */
import { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { windowChrome, appDirs, ensureDirs } from '../lib/osenv.mjs';
import { createController } from './controller.mjs';
import { createAdminSubsystem } from './admin/index.mjs';
import { createYourBrowserService } from './your-browser/integration.mjs';
import { registerYourBrowserIpc } from './your-browser/ipc.mjs';
import { createLedger, LEDGER_DIRNAME } from '../core/metering/ledger.mjs';
import { createMeter } from '../core/metering/meter.mjs';
import { collectSecrets } from '../core/metering/secrets.mjs';
import { hostKey } from '../core/providers/optin.mjs';
import { sanitizeTestMode } from './controller.mjs';
import { updateConfig } from './admin/config-store.mjs';
import { publicSettings } from './settings-view.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const isSmoke = process.argv.includes('--smoke');
const isSelfTest = process.argv.includes('--selftest');
const isE2E = process.argv.includes('--e2e');

// Chromium: packaged → resources/ms-playwright ; dev → project/.playwright-browsers.
// Always derived from process.resourcesPath — never a hard-coded install path.
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH
  || (app.isPackaged ? path.join(process.resourcesPath, 'ms-playwright') : path.join(ROOT, '.playwright-browsers'));

let mainWindow = null;
let controller = null;
let DIRS = null;
let admin = null; // provider admin subsystem (owner-only); dormant until a passphrase is set
let yourBrowser = null; // "your browser" tier service (off unless a domain is opted in)
let meter = null; // usage metering: the permanent ledger + cap counters (see core/metering)

// ── settings + sources (plain JSON in app-data; secrets would go to safeStorage) ──
const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };
const writeJson = (p, v) => { try { fs.writeFileSync(p, JSON.stringify(v, null, 2)); return true; } catch { return false; } };

// Theme (.interface-design/system.md §7.2): « Système » (default) follows Windows; Clair / Sombre force it. The
// renderer sets data-theme on <html>; nativeTheme makes native dialogs, menus and scrollbars follow the same choice.
// Only these three values are accepted from the renderer; anything else is dropped and reads as « system ».
const THEMES = ['system', 'light', 'dark'];
const DEFAULT_THEME = 'system';
function applyNativeTheme(theme) { nativeTheme.themeSource = THEMES.includes(theme) ? theme : DEFAULT_THEME; }

function send(type, payload) { mainWindow?.webContents.send('scrape:event', { t: type, p: payload }); }

// ── Playwright / Chromium smoke (Step 3) ──
async function playwrightSmoke() {
  const started = Date.now();
  const out = { ok: false, when: new Date().toISOString(), platform: process.platform, arch: process.arch, packaged: app.isPackaged, browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH };
  try {
    const { chromium } = await import('playwright');
    out.executablePath = chromium.executablePath();
    const b = await chromium.launch({ headless: true });
    const pg = await b.newPage();
    await pg.setContent('<title>Eloshon Chromium OK</title>');
    out.title = await pg.title();
    await b.close();
    out.ok = out.title === 'Eloshon Chromium OK';
    out.ms = Date.now() - started;
  } catch (e) { out.error = String((e && e.stack) || e); }
  return out;
}
async function runSmokeAndExit() {
  const res = await playwrightSmoke();
  const outFile = process.env.ELOSHON_SMOKE_OUT || path.join(app.getPath('userData'), 'smoke-result.json');
  try { fs.writeFileSync(outFile, JSON.stringify(res, null, 2)); } catch { /* ignore */ }
  console.log('SMOKE_RESULT ' + JSON.stringify(res));
  app.exit(res.ok ? 0 : 1);
}

// Packaging self-test (like --smoke): runs a REAL scrape through the bundled
// controller/engine against a local fixture (deterministic, offline) and proves
// the CSV is written under the OS app-data dir. No user feature; validation only.
async function runE2EAndExit() {
  const out = { ok: false, when: new Date().toISOString(), packaged: app.isPackaged };
  let srv = null;
  try {
    const { appDirs, ensureDirs } = await import('../lib/osenv.mjs');
    const { createController } = await import('./controller.mjs');
    const http = await import('node:http');
    const dirs = ensureDirs(appDirs(app.getPath('userData')));
    out.dataDir = dirs.data;
    const product = { '@context':'https://schema.org','@type':'Product', name:'E2E Test Widget', sku:'E2E-1', offers:{ '@type':'Offer', price:'7.50', priceCurrency:'EUR' } };
    const html = `<html><head><script type="application/ld+json">${JSON.stringify(product)}</script></head><body>ok</body></html>`;
    srv = http.createServer((_q, r) => { r.writeHead(200, { 'Content-Type':'text/html' }); r.end(html); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    let done = null;
    const controller = createController({ dirs, emit: (t, p) => { if (t === 'done') done = p; } });
    const { jobId } = await controller.start({ urls: [`http://127.0.0.1:${port}/p/e2e`], store: 'e2e-test', browser: false });
    out.jobId = jobId; out.counts = done && done.counts; out.csvPath = done && done.csvPath;
    out.csvExists = !!(out.csvPath && fs.existsSync(out.csvPath));
    out.csvUnderAppData = !!(out.csvPath && out.csvPath.startsWith(dirs.data));
    out.ok = out.csvExists && out.csvUnderAppData && done && done.counts && done.counts.accepted >= 1;
  } catch (e) { out.error = String((e && e.stack) || e); }
  if (srv) try { srv.close(); } catch { /* ignore */ }
  const outFile = process.env.ELOSHON_E2E_OUT || path.join(app.getPath('userData'), 'e2e-result.json');
  try { fs.writeFileSync(outFile, JSON.stringify(out, null, 2)); } catch { /* ignore */ }
  console.log('E2E_RESULT ' + JSON.stringify(out));
  app.exit(out.ok ? 0 : 1);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180, height: 760, minWidth: 940, minHeight: 620, backgroundColor: '#0A1650',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    ...windowChrome(),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: false, nodeIntegration: false },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Right-click context menu (copy/paste/cut/select-all). Without this, standard
  // clipboard actions are unavailable via the mouse.
  mainWindow.webContents.on('context-menu', (_e, params) => {
    const items = [];
    if (params.isEditable) {
      items.push({ role: 'cut', enabled: params.editFlags?.canCut !== false });
      items.push({ role: 'copy', enabled: params.editFlags?.canCopy !== false });
      items.push({ role: 'paste', enabled: params.editFlags?.canPaste !== false });
      items.push({ type: 'separator' }, { role: 'selectAll' });
    } else if (params.selectionText && params.selectionText.trim()) {
      items.push({ role: 'copy' }, { role: 'selectAll' });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: mainWindow });
  });
  return mainWindow;
}

function wireIpc() {
  // window controls
  ipcMain.on('win:minimize', () => mainWindow?.minimize());
  ipcMain.on('win:maximize', () => { if (!mainWindow) return; mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); });
  ipcMain.on('win:close', () => mainWindow?.close());

  ipcMain.handle('app:info', () => ({ platform: process.platform, arch: process.arch, packaged: app.isPackaged, version: app.getVersion(), browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH, dataDir: DIRS?.data }));
  ipcMain.handle('smoke:run', () => playwrightSmoke());
  ipcMain.on('ui:ready', () => { if (isSelfTest) { console.log('SELFTEST_OK'); setTimeout(() => app.exit(0), 50); } });

  // scrape lifecycle (fire-and-forget; progress streams via 'scrape:event')
  // The admin test mode is honoured ONLY when the admin session is unlocked at
  // launch time — the renderer's word is never trusted.
  ipcMain.handle('scrape:start', (_e, input) => {
    const inp = { ...(input || {}) };
    const tm = sanitizeTestMode(inp.testMode);
    inp.testMode = tm && admin && admin.session && admin.session.isUnlocked() ? tm : null;
    // Test-only injection points are never accepted from the renderer.
    delete inp.browserSession; delete inp.fetcher; delete inp.recipeHttpGet; delete inp.scrapingBrowserConnect;
    controller.start(inp).catch((err) => send('error', { message: String(err && err.message || err) }));
    return { ok: true, testMode: !!inp.testMode };
  });
  ipcMain.handle('jobs:resume', (_e, id, extra) => { controller.resume(id, extra || {}).catch((err) => send('error', { message: String(err && err.message || err) })); return { ok: true }; });
  ipcMain.on('scrape:pause', () => controller.pause());
  ipcMain.on('scrape:resume', () => controller.resumeRun());
  ipcMain.on('scrape:stop', () => controller.stop());
  ipcMain.on('scrape:intervention', (_e, action) => controller.intervention(action));

  ipcMain.handle('jobs:list', () => controller.listJobs());
  ipcMain.handle('job:products', (_e, id, opts) => controller.jobProducts(id, opts || {}));
  ipcMain.handle('job:override', (_e, id, key, status) => controller.overrideEligibility(id, key, status));
  ipcMain.handle('job:report', (_e, id) => controller.jobReport(id));
  ipcMain.handle('probe:run', (_e, url, opts) => controller.probe(url, { contentType: opts && typeof opts === 'object' && typeof opts.contentType === 'string' ? opts.contentType : 'auto' }));
  // Click-to-learn: opens a headful browser, waits for one product click, derives
  // + saves the recipe. Returns {ok, recognized, learned, reason}. teach:cancel
  // aborts an open capture (fire-and-forget).
  ipcMain.handle('teach:run', (_e, url, labels) => controller.teach(url, { labels: labels || undefined }).catch((err) => ({ ok: false, reason: String((err && err.message) || err) })));
  ipcMain.on('teach:cancel', () => controller.teachCancel());
  ipcMain.handle('providers:status', () => controller.providerStatus());
  ipcMain.handle('account:status', () => controller.accountStatus());
  ipcMain.handle('unlock:status', () => controller.unlockStatus());
  ipcMain.handle('unlock:retry', (_e, input) => { controller.unlockRetry(input || {}).catch((err) => send('error', { message: String((err && err.message) || err) })); return { ok: true }; });
  ipcMain.handle('unlock:estimate', (_e, input) => controller.estimateUnlock(input || {}));
  ipcMain.handle('unlock:cascade', (_e, input) => { controller.cascadeUnlock(input || {}).catch((err) => send('error', { message: String((err && err.message) || err) })); return { ok: true }; });

  // native OS integrations
  ipcMain.handle('open:path', (_e, p) => shell.openPath(p));
  ipcMain.handle('open:external', (_e, u) => { try { if (/^https?:\/\//i.test(u)) shell.openExternal(u); return true; } catch { return false; } });
  ipcMain.handle('open:folder', (_e, p) => { try { shell.showItemInFolder(p); return true; } catch { return false; } });
  ipcMain.handle('dialog:pickFolder', async () => { const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] }); return r.canceled ? null : r.filePaths[0]; });

  // recipes.json: the sites' recipes exported to / imported from a file (a preview first, then the user confirms).
  ipcMain.handle('recipes:export', async () => {
    const r = await dialog.showSaveDialog(mainWindow, { defaultPath: 'recipes.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    const file = controller.recipesExport({ appVersion: app.getVersion() });
    try { fs.writeFileSync(r.filePath, JSON.stringify(file, null, 1), 'utf8'); } catch (e) { return { ok: false, reason: String((e && e.code) || 'écriture impossible') }; }
    return { ok: true, path: r.filePath, sites: Object.keys(file.sites).length };
  });
  ipcMain.handle('recipes:import', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    let file = null;
    try { const text = fs.readFileSync(r.filePaths[0], 'utf8'); if (text.length > 20 * 1024 * 1024) return { ok: false, reason: 'fichier trop volumineux' }; file = JSON.parse(text.replace(/^﻿/, '')); } catch { return { ok: false, reason: 'fichier illisible (JSON attendu)' }; }
    return controller.recipesPreview(file);
  });
  ipcMain.handle('recipes:apply', (_e, previewId) => controller.recipesApply(String(previewId || '')));

  // settings + user-defined sources (a "source" is user config, NOT a Luna store)
  // The renderer gets the user settings only: provider blocks, keys, costs and
  // usage counters stay in the main process (admin data goes through gated IPC).
  ipcMain.handle('settings:get', () => publicSettings(readJson(DIRS.configFile, {})));
  ipcMain.handle('settings:set', (_e, patch) => {
    const p = publicSettings(patch || {}); // a renderer patch can never overwrite a provider block
    if ('theme' in p && !THEMES.includes(p.theme)) delete p.theme; // validated here, never trusted from the renderer
    const r = updateConfig(DIRS.configFile, (cur) => ({ ...cur, ...p }));
    if (!r.ok) { const cur = readJson(DIRS.configFile, {}); writeJson(DIRS.configFile, { ...cur, ...p }); }
    if ('theme' in p) applyNativeTheme(p.theme);
    return publicSettings(readJson(DIRS.configFile, {}));
  });
  ipcMain.handle('sources:list', () => readJson(DIRS.profilesFile, []));
  ipcMain.handle('sources:save', (_e, list) => { writeJson(DIRS.profilesFile, Array.isArray(list) ? list : []); return true; });

  // "Your browser" tier IPC — user-facing, NOT admin-gated (no provider secret
  // involved). Validated in the main process; see app/your-browser/ipc.mjs.
  registerYourBrowserIpc(ipcMain, { getService: () => yourBrowser, readConfig: () => readJson(DIRS.configFile, {}) });
}

app.whenReady().then(async () => {
  if (isSmoke) return runSmokeAndExit();
  if (isE2E) return runE2EAndExit();
  const probeArg = process.argv.find((a) => a.startsWith('--probe='));
  if (probeArg) {
    const url = probeArg.slice('--probe='.length);
    try {
      const { probeSource, formatProbe } = await import('../core/probe.mjs');
      const t0 = Date.now();
      const p = await probeSource(url);
      console.log('PROBE_MS ' + (Date.now() - t0));
      console.log(formatProbe(p));
      console.log('PROBE_JSON ' + JSON.stringify({ discovery_method: p.discovery_method, product_data: p.product_data, sitemap: p.sitemap_product_urls, sample: p.sample_url, fetch_stats: p.fetch_stats }));
    } catch (e) { console.log('PROBE_ERR ' + String((e && e.stack) || e)); }
    return app.exit(0);
  }
  const unlockArg = process.argv.find((a) => a === '--unlock-check' || a.startsWith('--unlock-check='));
  if (unlockArg) {
    try {
      const { unlockAvailable, resolveChrome, unlockRender } = await import('../core/unlock.mjs');
      const dirs = ensureDirs(appDirs(app.getPath('userData')));
      const saved = readJson(dirs.configFile, {});
      const chrome = resolveChrome({ chromePath: saved.chromePath });
      const a = await unlockAvailable({ pythonPath: saved.unlockPython, recheck: true });
      console.log('UNLOCK_STATUS ' + JSON.stringify({ enabled: !!saved.unlock, chromeFound: !!chrome, ready: a.ok, reason: a.reason || null, chrome, sidecar: a.ok ? 'resolved' : undefined }));
      console.log('UNLOCK_DIAG ' + JSON.stringify({ version: app.getVersion(), execPath: process.execPath, resourcesPath: process.resourcesPath, sidecar: a.sidecar, env: a.env, tried: a.tried }));
      const url = unlockArg.includes('=') ? unlockArg.slice(unlockArg.indexOf('=') + 1) : null;
      if (url && a.ok) {
        const { extractListing } = await import('../core/listing.mjs');
        const t0 = Date.now();
        const r = await unlockRender(url, { pythonPath: saved.unlockPython, timeoutMs: 75000 });
        const cards = r.html ? extractListing(r.html, url).cards.length : 0;
        console.log('UNLOCK_RENDER ' + JSON.stringify({ url, ms: Date.now() - t0, htmlBytes: r.html ? r.html.length : 0, cards, error: r.error || null }));
      }
    } catch (e) { console.log('UNLOCK_ERR ' + String((e && e.stack) || e)); }
    return app.exit(0);
  }
  const retryArg = process.argv.find((a) => a.startsWith('--unlock-retry='));
  if (retryArg) {
    try {
      const url = retryArg.slice('--unlock-retry='.length);
      const dirs = ensureDirs(appDirs(app.getPath('userData')));
      let done = null; let products = 0;
      const controller = createController({ dirs, emit: (t, p) => { if (t === 'product') products++; if (t === 'done') done = p; if (t === 'error') console.log('[UNLOCK] emit error: ' + (p && p.message)); if (t === 'phase') console.log('[UNLOCK] phase: ' + JSON.stringify(p)); } });
      const res = await controller.unlockRetry({ url });
      console.log('UNLOCK_RETRY ' + JSON.stringify({ ok: !!(res && res.ok), count: res && res.count, error: res && res.error, doneStatus: done && done.status, doneCounts: done && done.counts, productEvents: products }));
    } catch (e) { console.log('UNLOCK_RETRY_ERR ' + String((e && e.stack) || e)); }
    return app.exit(0);
  }
  if (process.argv.includes('--domain-profiles')) {
    try {
      const dirs = ensureDirs(appDirs(app.getPath('userData')));
      const controller = createController({ dirs });
      console.log('DOMAIN_PROFILES ' + JSON.stringify(controller.domainProfiles(), null, 2));
    } catch (e) { console.log('DP_ERR ' + String((e && e.stack) || e)); }
    return app.exit(0);
  }
  const scrapeArg = process.argv.find((a) => a.startsWith('--scrape='));
  if (scrapeArg) {
    try {
      const url = scrapeArg.slice('--scrape='.length);
      const dirs = ensureDirs(appDirs(app.getPath('userData')));
      let done = null;
      const controller = createController({ dirs, emit: (t, p) => { if (t === 'done') done = p; } });
      await controller.start({ origin: url, store: 'diag', browser: false, limits: { maxProducts: 8 } });
      const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } })();
      console.log('SCRAPE_DONE ' + JSON.stringify({ status: done && done.status, counts: done && done.counts }));
      console.log('PROFILE ' + JSON.stringify(controller.domainProfiles()[host] || null));
    } catch (e) { console.log('SCRAPE_ERR ' + String((e && e.stack) || e)); }
    return app.exit(0);
  }
  DIRS = ensureDirs(appDirs(app.getPath('userData')));
  // Owner-only provider admin subsystem (secure store + lock + IPC). Never blocks
  // app start; when unused, no provider config is written and behaviour is unchanged.
  try {
    admin = createAdminSubsystem({
      dirs: DIRS, ipcMain, dialog, getWindow: () => mainWindow, log: (m) => console.log('[admin] ' + m),
      getMeter: () => meter,
      readJobReport: (jobId) => (controller ? controller.jobReportData(jobId) : null),
      knownDomains: () => { try { return Object.keys((controller && controller.domainProfiles()) || {}).map((h) => hostKey(h)).filter(Boolean); } catch { return []; } },
    });
  } catch (e) { console.log('[admin] init ignorée (' + String((e && e.code) || 'erreur') + ')'); admin = null; }
  // Usage metering: permanent ledger in userData (next to config.json, so an app
  // update never wipes it). Secrets known to the app are scrubbed from every line.
  // A write failure is logged once (code only) and shown in the admin page; it
  // never stops a job.
  const ledger = createLedger({
    dir: DIRS.ledgerDir || path.join(DIRS.userData, LEDGER_DIRNAME),
    appVersion: app.getVersion(),
    secrets: () => collectSecrets(admin ? admin.resolveIo() : { config: readJson(DIRS.configFile, {}), env: process.env }),
    onError: (e) => console.log('[ledger] écriture du registre d\'utilisation impossible (' + e.code + ') — le scraping continue'),
  });
  meter = createMeter({ ledger, runtime: admin && admin.runtime, persist: admin && admin.persist, readConfig: () => readJson(DIRS.configFile, {}) });
  meter.reconcile().catch(() => {}); // caps counters ≥ the ledger's month totals
  controller = createController({ dirs: DIRS, emit: (t, p) => send(t, p), providerRuntime: admin && admin.runtime, secureStore: admin && admin.secureStore, persistProviders: admin && admin.persist, meter });
  // "Your browser" tier — the bridge starts with the app and waits for the
  // extension; per-domain authorization comes live from the extension's host
  // permission (no config flag, no restart). Off only if yourBrowser.enabled:false.
  // Never blocks or crashes app start; on any error it logs a non-secret message
  // and leaves the feature off.
  try {
    yourBrowser = createYourBrowserService({
      config: readJson(DIRS.configFile, {}), readConfig: () => readJson(DIRS.configFile, {}),
      controller, emit: (t, p) => send(t, p), log: (m) => console.log('[yourBrowser] ' + m),
      // Recipe resolved exactly like a normal job (shared sync → local/bundled profile).
      resolveRecipe: (url) => controller.resolveExternalRecipe(url),
      prefersYourBrowser: (url) => controller.prefersYourBrowser(url),
      // Admin journal: a run in the user's own browser, distinct from paid providers.
      recordRun: (entry) => { if (admin && admin.runtime) { admin.runtime.recordExternalRun(entry); if (admin.persist) admin.persist(); } },
      // Opt-in AI assist: resolve the Claude key from the same encrypted store/config
      // the admin panel uses, then run the model-agnostic core. Only invoked when the
      // extension forwards a user-initiated AI request.
      aiAssist: async (payload) => {
        const { runAiAssist } = await import('./ai/assist.mjs');
        const io = admin && admin.resolveIo ? admin.resolveIo() : { config: readJson(DIRS.configFile, {}), env: process.env };
        const pageUrl = (payload && (payload.url || payload.baseUrl)) || null;
        // Usage ledger: model, tokens, status, duration — never the prompt or the reply.
        const onCall = (info) => meter && meter.record({
          provider: 'anthropic', route: 'ai-assist', channel: 'direct', url: pageUrl, domain: pageUrl ? hostKey(pageUrl) : null,
          attempted: true, outcome: info.ok ? 'success' : (info.status === 429 || /rate_limit|overloaded/.test(String(info.reason)) ? 'failed' : (/credit|billing/i.test(String(info.reason)) ? 'quota_exhausted' : 'failed')),
          reason: info.ok ? null : info.reason, model: info.model, tokensIn: info.tokensIn, tokensOut: info.tokensOut, durationMs: info.durationMs,
        });
        const res = await runAiAssist({ ...payload, io, onCall });
        if (res && !res.ok && res.reason === 'ai_key_missing' && meter) meter.record({ provider: 'anthropic', route: 'ai-assist', url: pageUrl, attempted: false, outcome: 'skipped', reason: 'not_configured' });
        return res;
      },
    });
    const r = yourBrowser.start();
    console.log('[yourBrowser] ' + (r.started ? 'pont démarré — en attente de l\'extension (autorisation des domaines côté extension)' : `inactif (${r.reason})`));
  } catch (e) { console.log('[yourBrowser] init ignorée (' + String((e && e.code) || 'erreur') + ')'); }
  // Self-register the native messaging host for THIS app (no PowerShell, no admin, no
  // system Node): the end user just installs and the extension connects. Best-effort.
  try {
    const { ensureNativeHostRegistered, resolveHostMjs } = await import('./native-host-register.mjs');
    const cfg = readJson(DIRS.configFile, {});
    ensureNativeHostRegistered({
      platform: process.platform,
      dataDir: DIRS.data,
      execPath: process.execPath,
      hostMjsPath: resolveHostMjs({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, repoRoot: ROOT }),
      extensionIds: (cfg.yourBrowser && Array.isArray(cfg.yourBrowser.extensionIds)) ? cfg.yourBrowser.extensionIds : undefined,
      fs, execFile,
      log: (m) => console.log('[nativeHost] ' + m),
    }).catch((e) => console.log('[nativeHost] ignoré (' + String((e && e.code) || 'erreur') + ')'));
  } catch (e) { console.log('[nativeHost] init ignorée (' + String((e && e.code) || 'erreur') + ')'); }
  wireIpc();
  applyNativeTheme(readJson(DIRS.configFile, {}).theme);
  createWindow();
  // Warm the hard-unlock capability once on launch (fire-and-forget): it writes the
  // GUI-context diagnostic (unlock-diag.json) with the REAL Explorer-launch env, and
  // primes the cache so Settings shows the status instantly instead of "…".
  Promise.resolve().then(() => controller.unlockStatus()).catch(() => {});
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('before-quit', () => { try { admin && admin.session.lock(); } catch { /* ignore */ } try { yourBrowser?.stop(); } catch { /* ignore */ } try { meter && meter.ledger && meter.ledger.close && meter.ledger.close(); } catch { /* ignore */ } });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
