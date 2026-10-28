/**
 * Electron main process (ÉTAPE 5 + système de crédits v2).
 * Owns the window, the filesystem and native dialogs; all conversion logic
 * lives in the pure engine/controller. Credit checking/consumption is
 * done server-side via the firecrawl-unlock edge function before and after
 * each conversion — never locally decremented. Diagnostic flags:
 *   --selftest  boot the renderer headless, walk every screen, exit 0/1
 *   --e2e       run a real conversion to disk (no window), exit 0/1
 */
import { app, BrowserWindow, ipcMain, dialog, shell, utilityProcess, nativeTheme } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { sanitizeCustomTargets } from './custom-targets.mjs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appDirs, ensureDirs, windowChrome, isMac, modKey } from '../lib/osenv.mjs';
import { decodeBytes } from '../lib/encoding.mjs';
import { applyEditsToText, previewEdits, expandPreset, suggestEdits, EDIT_CATALOG, EDIT_GROUPS, EDIT_PRESETS, learnFormat } from '../core/dist/index.mjs';
import {
  DIRECTIONS, analyzeMapping, runConversion, learnFromAnalysis, columnEditEntries,
} from './controller.mjs';
import { createConvertService } from './convert-service.mjs';
import { readFileManifest, manifestFormatFor } from './manifest-sidecar.mjs';
import { createEngineHost } from './convert-host.mjs';
import { createTemplateStore } from './templates.mjs';
import { LANGS, uiLang, mainText } from './main-i18n.mjs';
import { SIMILAR_MIN } from '../core/knowledge-proposal/recognizer.mjs';
import { createJsonKnowledgeStore } from '../core/knowledge-proposal/json-store.mjs';
import { makeDecision } from '../core/knowledge-proposal/semantic.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Supabase edge function (credit system) ────────────────────────────────────
const EDGE_BASE = 'https://ilaakzwnfgzkinyygevv.supabase.co';
const EDGE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlsYWFrenduZmd6a2lueXlnZXZ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3NDM2ODEsImV4cCI6MjEwNTMxOTY4MX0.xg7lrPYIyK2i7L6Kn8rEMQo921aCwkzfLn9j4jnWqhs';

async function callEdge(action, body, licenseKey) {
  try {
    const r = await fetch(`${EDGE_BASE}/functions/v1/firecrawl-unlock`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': EDGE_ANON,
        'Authorization': `Bearer ${EDGE_ANON}`,
      },
      body: JSON.stringify({ action, license: licenseKey, ...body }),
    });
    return await r.json();
  } catch (err) {
    return { ok: false, reason: 'network_error', detail: String(err?.message || err) };
  }
}
const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(1);
const has = (f) => argv.includes(f);

const dirs = ensureDirs(appDirs(app.getPath('userData')));
const templates = createTemplateStore(dirs.templatesFile);
// Phase 5 knowledge: Reference ships with the app (read-only), Learned lives in
// userData (decisions, samples, taught formats). Never written to the bundle.
// Diagnostics (--selftest / --e2e) must never write into the user's Learned
// strata: they get a throw-away directory.
const learnedDir = (has('--selftest') || has('--e2e')) ? fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-kb-')) : dirs.knowledgeDir;
const knowledge = createJsonKnowledgeStore({ referenceDir: path.join(ROOT, 'core', 'knowledge-ref'), learnedDir });

// Engine host (Phase 1 step 5): the pure engine runs in a utilityProcess, off
// this process — a large catalogue never freezes the window. The host also
// keeps each loaded file's text (renderer sends a fileId, not the whole file,
// on every preview) and memoizes identical runs.
const engineHost = createEngineHost({
  spawn: () => {
    const child = utilityProcess.fork(path.join(__dirname, 'convert-worker.mjs'), [], { stdio: 'inherit' });
    return {
      post: (m) => child.postMessage(m),
      onMessage: (fn) => child.on('message', fn),
      onExit: (fn) => child.on('exit', fn),
      stop: () => child.kill(),
    };
  },
  knowledgeDirs: { referenceDir: path.join(ROOT, 'core', 'knowledge-ref'), learnedDir },
  onProgress: (p) => win?.webContents.send('conv:progress', p),
});

// A fileId-only input gets its text back from the host registry IN-PROCESS —
// the service needs csvText for the credit pre-count, the worker gets the
// file pushed once per lifetime.
// Per opened file: its export manifest and the format built from its column roles (manifest-sidecar.mjs).
const fileManifests = new Map();
// Per opened file in learn mode (format not recognised): the column choices of its last analysis. The preview and the
// conversion read the file with them, even before « Mémoriser ce format » — a complete mapping always converts.
const learnByFile = new Map();
function unsavedFormat(input) {
  const l = learnByFile.get(input.fileId);
  if (!l || !l.semantic) return null;
  try { return learnFormat({ headers: l.headers, report: l.semantic, id: l.proposedId, provenance: 'unknown', platform: input.expectPlatform || 'eloshon', by: 'user' }); } catch { return null; }
}
function withFileText(input) {
  const mf = input?.fileId != null ? (fileManifests.get(input.fileId)?.format || unsavedFormat(input)) : null;
  if (mf && !input.extraFormat) input = { ...input, extraFormat: mf };
  if (input?.fileId != null && input.csvText == null) {
    const text = engineHost.fileText(input.fileId);
    if (text != null) return { ...input, csvText: text };
  }
  return input;
}

// Billing policy around the engine (previews free, one consume per export) —
// pure module, unit-tested without Electron (test/convert-service.test.mjs).
const convertService = createConvertService({
  getLicense: () => readJson(dirs.licenseFile, { activated: false, key: '' }),
  callEdge,
  run: (input) => engineHost.run(input),
});

let fileSeq = 0;
const newFileId = () => `f_${Date.now().toString(36)}_${++fileSeq}`;

// ── Tiny JSON stores (config / license / history), tolerant of missing files ──
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const DEFAULT_CONFIG = {
  lang: 'fr', theme: 'system', exportDir: app.getPath('documents'),
  separator: ',', encoding: 'utf8bom', checkUpdates: true,
  // Phase 5.6 — semantic column recognition in step 3 (suggestions only; the
  // conversion never changes until a suggestion is accepted).
  semantic: true,
};
// An unknown stored language reads as French (the four interface languages: main-i18n.mjs LANGS).
function getConfig() { const c = { ...DEFAULT_CONFIG, ...readJson(dirs.configFile, {}) }; c.lang = uiLang(c.lang); return c; }
// Text main shows itself (dialog titles, filter names), in the interface language.
const M = (key, params) => mainText(getConfig().lang, key, params);
function setConfig(patch) { const next = { ...getConfig(), ...patch }; writeJson(dirs.configFile, next); return next; }

// Theme: « Système » follows Windows (system.md §7.2). The renderer sets data-theme; the main process sets
// nativeTheme so native dialogs, menus and scrollbars follow the same choice. Unknown values fall back to system.
const THEMES = ['system', 'light', 'dark'];
function applyNativeTheme(theme) { nativeTheme.themeSource = THEMES.includes(theme) ? theme : 'system'; }

// ── Licence stub (provisional) — NO real DRM/payment; unlocks the free cap ────
// Accepts a key shaped ELO-XXXX-XXXX-XXXX and marks the app licensed locally.
// The real activation mechanism is a separate, deliberately-unbuilt decision.
const LICENSE_RE = /^ELO-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/i;
function getLicense() {
  const l = readJson(dirs.licenseFile, { activated: false, key: '' });
  return { activated: !!l.activated, keyMasked: l.key ? maskKey(l.key) : '', activatedAt: l.activatedAt ?? null };
}
function maskKey(k) { const p = k.split('-'); return p.length === 4 ? `ELO-••••-••••-${p[3]}` : '••••'; }
function activateLicense(key) {
  const k = (key || '').trim().toUpperCase();
  if (!LICENSE_RE.test(k)) return { ok: false, code: 'license_bad_format' };
  writeJson(dirs.licenseFile, { activated: true, key: k, activatedAt: new Date().toISOString() });
  return { ok: true, license: getLicense() };
}
// The price the unlock dialog shows, formatted by the renderer with Intl in the interface language.
const LICENSE_PRICE = { amount: 19, currency: 'EUR' };
function deactivateLicense() { writeJson(dirs.licenseFile, { activated: false, key: '' }); return getLicense(); }

// ── History (recent conversions) ──────────────────────────────────────────────
function getHistory() { const h = readJson(dirs.recentFile, { items: [] }); return Array.isArray(h.items) ? h.items : []; }
function addHistory(entry) {
  const items = getHistory();
  items.unshift({ id: 'h_' + Date.now(), at: new Date().toISOString(), ...entry });
  writeJson(dirs.recentFile, { items: items.slice(0, 100) }); // keep last 100
  return items;
}
function removeHistory(id) { const items = getHistory().filter((x) => x.id !== id); writeJson(dirs.recentFile, { items }); return items; }
function clearHistory() { writeJson(dirs.recentFile, { items: [] }); return []; }

// ── Window ────────────────────────────────────────────────────────────────────
let win = null;
function createWindow(show = true) {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 940, minHeight: 640, show,
    backgroundColor: '#111113',
    title: 'Eloshon Converter',
    ...windowChrome(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  win.removeMenu?.();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
  return win;
}

// ── IPC: platform / window controls ───────────────────────────────────────────
function registerIpc() {
  ipcMain.handle('app:info', () => ({
    os: process.platform, isMac, modKey, version: app.getVersion(),
    directions: DIRECTIONS, config: getConfig(), license: getLicense(), licensePrice: LICENSE_PRICE,
    // how close a file must be to a learned format to be recognised (shown in step 3's « how it is remembered »)
    learnMatch: { ...SIMILAR_MIN },
  }));
  ipcMain.on('win:minimize', () => win?.minimize());
  ipcMain.on('win:maximize', () => { if (!win) return; win.isMaximized() ? win.unmaximize() : win.maximize(); });
  ipcMain.on('win:close', () => win?.close());

  // Config / license / history
  ipcMain.handle('config:get', () => getConfig());
  ipcMain.handle('config:set', (_e, patch) => {
    const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? { ...patch } : {};
    if ('theme' in p && !THEMES.includes(p.theme)) delete p.theme;
    if ('lang' in p && !LANGS.includes(p.lang)) delete p.lang;
    if ('customTargets' in p) p.customTargets = sanitizeCustomTargets(p.customTargets);
    const next = setConfig(p);
    if ('theme' in p) applyNativeTheme(next.theme);
    return next;
  });
  ipcMain.handle('license:get', () => getLicense());
  ipcMain.handle('license:activate', (_e, key) => activateLicense(key));
  ipcMain.handle('license:deactivate', () => deactivateLicense());
  ipcMain.handle('history:get', () => getHistory());
  ipcMain.handle('history:add', (_e, entry) => addHistory(entry));
  ipcMain.handle('history:remove', (_e, id) => removeHistory(id));
  ipcMain.handle('history:clear', () => clearHistory());

  // Files. The text is registered with the engine host under a fileId; every
  // later preview/issues/convert call sends the fileId, not the whole file.
  ipcMain.handle('file:open', async (_e, { title } = {}) => {
    const r = await dialog.showOpenDialog(win, {
      title: title || M('open_title'), properties: ['openFile'],
      filters: [{ name: M('filter_catalog'), extensions: ['csv', 'txt', 'tsv', 'json', 'eloshon'] }, { name: M('filter_all'), extensions: ['*'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const p = r.filePaths[0];
    try {
      const stat = fs.statSync(p);
      const dec = decodeBytes(fs.readFileSync(p));
      const text = dec.text;
      const fileId = newFileId();
      engineHost.registerFile(fileId, text);
      // What the file really holds (an Eloshon export's manifest beside it): shown at import, and its column roles
      // recognise a file whose column names were changed.
      const manifest = readFileManifest(p, text);
      if (manifest) fileManifests.set(fileId, { manifest, format: manifestFormatFor(manifest, text) });
      return { fileId, path: p, name: path.basename(p), size: stat.size, text, encoding: dec.encoding, lostChars: dec.replacementChars, manifest };
    } catch (err) { return { error: String(err?.message || err) }; }
  });

  // Drag-and-drop lands in the renderer, so the text crosses the bridge once
  // here and never again.
  // A dropped file may arrive as raw bytes: the encoding (UTF-8, UTF-16, an
  // Excel Windows-1252 export…) is decided here, once, for both entry points.
  ipcMain.handle('file:register', (_e, { text, bytes } = {}) => {
    const fileId = newFileId();
    const dec = bytes ? decodeBytes(bytes) : { text: text ?? '', encoding: 'utf-8', replacementChars: 0 };
    engineHost.registerFile(fileId, dec.text);
    // A dropped file has no path here: only an .eloshon header can carry its manifest.
    const manifest = readFileManifest(null, dec.text);
    if (manifest) fileManifests.set(fileId, { manifest, format: null });
    return { fileId, text: bytes ? dec.text : undefined, encoding: dec.encoding, lostChars: dec.replacementChars, manifest };
  });

  // A replaced or abandoned file: free its text in main and in the worker —
  // a long session must not pin every catalogue ever loaded.
  ipcMain.handle('file:forget', (_e, fileId) => { engineHost.forgetFile(fileId); fileManifests.delete(fileId); learnByFile.delete(fileId); return true; });

  ipcMain.handle('dir:choose', async () => {
    const r = await dialog.showOpenDialog(win, { title: M('dir_title'), properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('file:openFolder', (_e, p) => shell.openPath(p));
  ipcMain.handle('file:showItem', (_e, p) => shell.showItemInFolder(p));

  // Conversion pipeline (all pure — main only reads the string in, writes strings out)
  ipcMain.handle('conv:analyze', (_e, { csvText, fileId, direction, overrides, edits }) =>
    analyzeMapping(applyEditsToText(csvText ?? engineHost.fileText(fileId) ?? '', edits), direction, overrides || {}, { semantic: !!getConfig().semantic, store: knowledge, extraFormat: fileManifests.get(fileId)?.format || null })
      .then((r) => { if (fileId != null) { if (r && r.learn) learnByFile.set(fileId, r.learn); else learnByFile.delete(fileId); } return r; }));

  // ── Data editor: ready-made formulas, a live before / after, one-click recipes ──
  ipcMain.handle('edits:catalog', () => ({ groups: EDIT_GROUPS, entries: EDIT_CATALOG, presets: EDIT_PRESETS }));
  ipcMain.handle('edits:preview', (_e, { csvText, fileId, edits, column }) => {
    try { return { ok: true, ...previewEdits(csvText ?? engineHost.fileText(fileId) ?? '', Array.isArray(edits) ? edits : [], String(column ?? '')) }; }
    catch (err) { return { ok: false, error: String(err?.message || err) }; }
  });
  ipcMain.handle('edits:suggest', (_e, { csvText, fileId }) => {
    try { return { ok: true, hints: suggestEdits(csvText ?? engineHost.fileText(fileId) ?? '') }; }
    catch (err) { return { ok: false, error: String(err?.message || err) }; }
  });
  ipcMain.handle('edits:expand', (_e, { presetId, column }) => expandPreset(String(presetId), String(column)));

  // ── Learned knowledge (Phase 5.6): the user's mapping decisions ─────────────
  ipcMain.handle('kb:decide', async (_e, { formatId, column, action, canon, scope, args }) => {
    if (!formatId || !column || !action) return { ok: false };
    // Only a custom-field key travels in args: letters, digits, `_` and `-`.
    const key = args && typeof args.key === 'string' ? args.key.trim().slice(0, 64) : '';
    const safeArgs = key && /^[A-Za-z0-9_-]+$/.test(key) ? { key } : undefined;
    const decision = makeDecision({ formatId, column, action, canon: canon ?? null, by: 'user', scope, args: safeArgs });
    await knowledge.recordDecision(decision);
    engineHost.bumpKnowledge();
    return { ok: true, decision };
  });
  // Step 3 — re-point one column of a Reference format (stored as a learned
  // overlay; Reference itself is never written). target.kind 'reset' = back
  // to the shipped mapping for that column (or every column when none given).
  ipcMain.handle('kb:editColumn', async (_e, { formatId, column, target }) => {
    if (!formatId || !target) return { ok: false };
    try {
      if (target.kind === 'reset') await knowledge.removeColumnEdit(formatId, column || undefined);
      else await knowledge.putColumnEdit(formatId, column, columnEditEntries(column, target));
    } catch (err) { return { ok: false, error: String(err?.message || err) }; }
    engineHost.bumpKnowledge();
    return { ok: true };
  });
  ipcMain.handle('kb:decisions', (_e, formatId) => (formatId ? knowledge.listDecisions(formatId) : []));
  ipcMain.handle('kb:forget', async (_e, { formatId, column }) => {
    // Undo = a new decision that supersedes the previous one for this column.
    if (!formatId || !column) return { ok: false };
    const decision = makeDecision({ formatId, column, action: 'proposed', canon: null, by: 'user', reason: 'forget' });
    await knowledge.recordDecision(decision);
    engineHost.bumpKnowledge();
    return { ok: true };
  });
  // Step-4 gate, off the main thread. The worker loads the SAME Reference ⊕
  // Learned detection surface as steps 2-3, so a learned format or JSON drop
  // that converted fine is never re-detected as unknown here (which silently
  // locked the "Continue" button).
  ipcMain.handle('conv:issues', (_e, { csvText, fileId, direction, overrides, corrections, ignored }) =>
    engineHost.issues({ csvText, fileId, direction, overrides, corrections, ignored, extraFormat: fileManifests.get(fileId)?.format || null }));
  ipcMain.handle('account:status', async () => {
    const lic = readJson(dirs.licenseFile, { activated: false, key: '' });
    if (!lic.activated || !lic.key) return { ok: false, reason: 'no_license' };
    return callEdge('account_status', {}, lic.key);
  });

  // Previews are free; a licensed export is checked here and consumed once in
  // conv:save, after the file is really on disk (policy: convert-service.mjs).
  // The engine itself runs in the utilityProcess worker (convert-host.mjs).
  ipcMain.handle('conv:run', (_e, input) => convertService.run(withFileText(input)));
  ipcMain.handle('kb:learn', async (_e, { headers, semantic, hint, provenance }) => {
    const fmt = await learnFromAnalysis(knowledge, { headers, semantic, hint, provenance });
    engineHost.bumpKnowledge();
    return { ok: true, id: fmt.id, displayName: fmt.displayName, fields: fmt.fields.length };
  });
  ipcMain.handle('kb:formats', async () => (await knowledge.listFormats()));
  ipcMain.handle('kb:forgetFormat', async (_e, id) => {
    const ok = await knowledge.removeLearnedFormat(id);
    engineHost.bumpKnowledge();
    return { ok };
  });

  // Write the converted output to disk (+ optional redirects + optional split).
  ipcMain.handle('conv:save', async (_e, { outputCsv, redirectsCsv, baseName, exportDir, withRedirects, splitEvery }) => {
    let dir = exportDir;
    if (!dir || !fs.existsSync(dir)) {
      const r = await dialog.showOpenDialog(win, { title: M('dir_title'), properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled) return { canceled: true };
      dir = r.filePaths[0];
    }
    const written = [];
    const bom = getConfig().encoding === 'utf8bom' ? '﻿' : '';
    const safe = (baseName || 'export').replace(/[^\w.\- ]+/g, '_');
    try {
      if (splitEvery && splitEvery > 0) {
        const parts = splitCsv(outputCsv, splitEvery);
        parts.forEach((chunk, i) => {
          const fp = path.join(dir, `${safe}_${String(i + 1).padStart(2, '0')}.csv`);
          fs.writeFileSync(fp, bom + chunk); written.push({ path: fp, name: path.basename(fp) });
        });
      } else {
        const fp = path.join(dir, `${safe}.csv`);
        fs.writeFileSync(fp, bom + outputCsv); written.push({ path: fp, name: path.basename(fp) });
      }
      if (withRedirects && redirectsCsv) {
        const fp = path.join(dir, `${safe}_redirections.csv`);
        fs.writeFileSync(fp, bom + redirectsCsv); written.push({ path: fp, name: path.basename(fp) });
      }
      // The export is now real (files on disk) — fire the single credit
      // consume the export-mode conv:run armed. A cancelled dialog or a write
      // error never reaches this line, so it never bills.
      await convertService.consumePending();
      return { dir, files: written };
    } catch (err) { return { error: String(err?.message || err) }; }
  });

  // Templates
  ipcMain.handle('tpl:list', () => templates.list());
  ipcMain.handle('tpl:create', (_e, data) => templates.create(data));
  ipcMain.handle('tpl:save', (_e, { id, patch }) => templates.save(id, patch));
  ipcMain.handle('tpl:rename', (_e, { id, name }) => templates.rename(id, name));
  ipcMain.handle('tpl:duplicate', (_e, { id, name }) => templates.duplicate(id, name || M('tpl_copy', { name: templates.get(id)?.name ?? '' })));
  ipcMain.handle('tpl:remove', (_e, id) => templates.remove(id));
  ipcMain.handle('tpl:apply', (_e, { id, headers }) => templates.applyTo(id, headers));
  ipcMain.handle('tpl:export', async (_e, id) => {
    const json = templates.exportOne(id);
    const r = await dialog.showSaveDialog(win, { title: M('tpl_export_title'), defaultPath: `${M('tpl_file_name')}.eloshon.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled) return { canceled: true };
    fs.writeFileSync(r.filePath, json); return { path: r.filePath };
  });
  ipcMain.handle('tpl:import', async () => {
    const r = await dialog.showOpenDialog(win, { title: M('tpl_import_title'), properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    try { return { template: templates.importOne(fs.readFileSync(r.filePaths[0], 'utf8'), M('tpl_imported')) }; }
    catch (err) { return { error: String(err?.message || err) }; }
  });
}

// Split a serialized CSV (with header) into chunks of at most N data rows each.
function splitCsv(csv, n) {
  const lines = csv.split(/\r\n/);
  const trailing = lines[lines.length - 1] === '' ? lines.pop() : null;
  const header = lines[0];
  const body = lines.slice(1);
  const parts = [];
  for (let i = 0; i < body.length; i += n) {
    parts.push([header, ...body.slice(i, i + n)].join('\r\n') + (trailing != null ? '\r\n' : ''));
  }
  return parts.length ? parts : [csv];
}

// ── Diagnostics ───────────────────────────────────────────────────────────────
async function runSelftest() {
  const w = createWindow(false);
  const result = await new Promise((resolve) => {
    const errors = [];
    w.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
    w.webContents.on('did-finish-load', async () => {
      try {
        // Give the renderer a tick to mount, then run its own screen walk.
        const r = await w.webContents.executeJavaScript('window.__selftest ? window.__selftest() : ({ok:false,error:"no selftest hook"})', true);
        resolve({ ...r, consoleErrors: errors });
      } catch (err) { resolve({ ok: false, error: String(err?.message || err), consoleErrors: errors }); }
    });
    setTimeout(() => resolve({ ok: false, error: 'selftest timeout', consoleErrors: errors }), 15000);
  });
  console.log('SELFTEST ' + JSON.stringify(result, null, 2));
  app.exit(result.ok && result.consoleErrors.length === 0 ? 0 : 1);
}

async function runE2e() {
  // A real conversion end-to-end, to disk, in the packaged runtime.
  const csv = [
    'Handle,Title,Variant Price,Variant SKU,Variant Inventory Qty',
    'chemise,Chemise,89.00,CHM-1,12',
    'pull,Pull,59.00,PUL-1,4',
  ].join('\r\n') + '\r\n';
  const res = runConversion({ csvText: csv, direction: 'shopify-to-woocommerce', expectPlatform: 'shopify' });
  const outDir = dirs.outputs;
  const outFile = path.join(outDir, 'e2e_output.csv');
  fs.writeFileSync(outFile, res.outputCsv);
  const rows = res.outputCsv.trim().split(/\r?\n/).length - 1;
  const ok = res.ok && rows === 2 && fs.existsSync(outFile);
  console.log('E2E ' + JSON.stringify({ ok, sourceFormat: res.sourceFormat, targetFormat: res.targetFormat, rows, outFile }, null, 2));
  app.exit(ok ? 0 : 1);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock && !has('--selftest') && !has('--e2e')) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    applyNativeTheme(getConfig().theme);
    registerIpc();
    if (has('--e2e')) return runE2e();
    if (has('--selftest')) return runSelftest();
    createWindow(true);
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(true); });
  });
  app.on('window-all-closed', () => { if (!isMac) app.quit(); });
  app.on('will-quit', () => engineHost.dispose());
}
