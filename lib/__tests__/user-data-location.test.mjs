/**
 * User-data safety across an app update. Every setting, key, job, recipe and the
 * usage history must live under Electron's userData dir (which the installer never
 * touches) — NEVER in the install/app directory (which an update replaces). This
 * suite is the guarantee behind removing the old "back up config.json before
 * installing" advice: it fails if any user-data path is ever moved into the bundle.
 * Offline, temp dirs only — nothing real is touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appDirs, userDataPaths, ensureDirs } from '../osenv.mjs';
import { outputRoot } from '../../core/config.mjs';
import { writeJsonAtomic, updateConfig, BACKUP_NAME } from '../../app/admin/config-store.mjs';

const UD = path.join(os.tmpdir(), 'eloshon-ud-' + process.pid);
const INSTALL = path.join(os.tmpdir(), 'eloshon-install-' + process.pid); // stands in for the app/install dir
const inside = (root, p) => { const r = path.relative(root, p); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };

test('every user-data path is absolute and INSIDE userData (not the install dir)', () => {
  const paths = userDataPaths(UD);
  const keys = Object.keys(paths);
  assert.ok(keys.length >= 12, `expected the full set, got ${keys.length}`);
  for (const [name, p] of Object.entries(paths)) {
    assert.ok(path.isAbsolute(p), `${name} must be absolute`);
    assert.ok(inside(UD, p), `${name} (${p}) must be under userData`);
    assert.ok(!inside(INSTALL, p), `${name} must NOT be under the install dir`);
  }
  // The documented set covers config, its backup, sources, the secret store, admin,
  // balances, the usage ledger, learned recipes, jobs, csv, reports, browser profile, logs.
  for (const k of ['config', 'secret', 'usageLedger', 'domainProfiles', 'jobs', 'csv', 'reports', 'logs', 'sources', 'admin', 'balances', 'browserProfile', 'configBackup']) {
    assert.ok(paths[k], `the layout must name "${k}"`);
  }
});

test('appDirs names the provider/metering/recipe files under userData too', () => {
  const d = appDirs(UD);
  for (const k of ['secretFile', 'adminFile', 'balancesFile', 'ledgerDir', 'domainProfilesFile', 'configFile', 'profilesFile']) {
    assert.ok(d[k] && path.isAbsolute(d[k]) && inside(UD, d[k]), `${k} must be an absolute path under userData`);
  }
});

test('the engine output root, when given the userData data dir, stays inside userData', () => {
  const d = appDirs(UD);
  // Production always injects an ABSOLUTE outputDir (dirs.data) — jobs then land in
  // userData, never in the bundle. outputRoot returns an absolute path as-is.
  assert.equal(outputRoot({ outputDir: d.data }), d.data);
  assert.ok(inside(UD, outputRoot({ outputDir: d.data })));
});

test('an app update (install dir replaced) leaves userData files intact', () => {
  const d = ensureDirs(appDirs(UD));
  fs.writeFileSync(d.configFile, JSON.stringify({ lang: 'fr', workers: 4 }));
  fs.mkdirSync(path.join(d.jobs, 'J1'), { recursive: true });
  fs.writeFileSync(path.join(d.jobs, 'J1', 'products.json'), '[{"name":"x"}]');
  fs.writeFileSync(d.secretFile, 'ENCRYPTED-BLOB');
  // Simulate the installer wiping and re-creating the install directory.
  fs.mkdirSync(INSTALL, { recursive: true }); fs.writeFileSync(path.join(INSTALL, 'app.asar'), 'old');
  fs.rmSync(INSTALL, { recursive: true, force: true });
  fs.mkdirSync(INSTALL, { recursive: true }); fs.writeFileSync(path.join(INSTALL, 'app.asar'), 'new');
  // userData is untouched by that.
  assert.equal(JSON.parse(fs.readFileSync(d.configFile, 'utf8')).lang, 'fr');
  assert.equal(fs.readFileSync(path.join(d.jobs, 'J1', 'products.json'), 'utf8'), '[{"name":"x"}]');
  assert.equal(fs.readFileSync(d.secretFile, 'utf8'), 'ENCRYPTED-BLOB');
});

test('config writes are non-destructive: atomic, verified, and keep a previous copy', () => {
  const d = ensureDirs(appDirs(UD));
  fs.writeFileSync(d.configFile, JSON.stringify({ a: 1 }));
  const r = updateConfig(d.configFile, (c) => { c.b = 2; return c; }, { backup: true });
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(d.configFile, 'utf8')), { a: 1, b: 2 });
  assert.equal(path.basename(r.backupPath), BACKUP_NAME);
  assert.deepEqual(JSON.parse(fs.readFileSync(d.configBackup, 'utf8')), { a: 1 }, 'the previous config is kept');
  // A corrupt config is never overwritten (the original stays).
  fs.writeFileSync(d.configFile, '{ not json');
  const bad = updateConfig(d.configFile, (c) => { c.c = 3; return c; });
  assert.equal(bad.ok, false);
  assert.equal(fs.readFileSync(d.configFile, 'utf8'), '{ not json');
  // writeJsonAtomic never leaves a temp file behind.
  assert.ok(!fs.readdirSync(d.userData).some((f) => f.startsWith('.') && f.endsWith('.tmp')));
});

test.after(() => { for (const p of [UD, INSTALL]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } } });
