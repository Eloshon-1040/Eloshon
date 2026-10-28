/**
 * P0 / B5 — learned recipes survive a crash and a bad read. domain-profiles.json was
 * written in place (a crash mid-write left a truncated file) and an unreadable file
 * was read as {} — so the next write replaced every learned recipe with the one
 * host of that run. Now: atomic write (temp + rename + verify, previous copy kept);
 * a corrupt file is set aside (never overwritten) and the previous copy is used; a
 * file that cannot be read for another reason (locked) blocks every write of the
 * run. Temp folders only, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appDirs, ensureDirs } from '../../lib/osenv.mjs';
import { createController } from '../../app/controller.mjs';
import { profileFileIo, PROFILES_BACKUP } from '../profile-file.mjs';
import { createProfileStore } from '../domain-profile.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-b5-'));
const RECIPES = { 'old.test': { method: 'internal-api', manual_selectors: { card: '.c', fields: { name: '.n' } }, runs: 4 }, 'other.test': { method: 'sitemap', runs: 2 } };

test('controller: a truncated domain-profiles.json (crash mid-write) is never overwritten by a run', { timeout: 20000 }, async () => {
  const dirs = ensureDirs(appDirs(tmp()));
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1, recovery: false, maxProducts: 5 }));
  const file = path.join(dirs.data, 'domain-profiles.json');
  const truncated = JSON.stringify(RECIPES, null, 2).slice(0, 90); // what a crash leaves behind
  fs.writeFileSync(file, truncated);
  class Mock { constructor() { this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; this.userAgent = 't'; } async get(u) { return { ok: true, status: 200, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body: '<html><body><p>rien</p></body></html>', headers: {}, error: null, blocked: false }; } async getText(u) { return this.get(u); } }
  const ctrl = createController({ dirs });
  await ctrl.start({ origin: 'https://new.test/c', store: 'demo', browser: false, fetcher: new Mock() });
  const kept = fs.readdirSync(dirs.data).filter((n) => n.startsWith('domain-profiles.corrupt-'));
  assert.equal(kept.length, 1, `the unreadable file is set aside: ${fs.readdirSync(dirs.data).join(', ')}`);
  assert.equal(fs.readFileSync(path.join(dirs.data, kept[0]), 'utf8'), truncated, 'byte-identical, nothing lost');
});

test('profileFileIo: writes are atomic and keep the previous copy', () => {
  const dir = tmp(); const file = path.join(dir, 'domain-profiles.json');
  const io = profileFileIo(file);
  io.write({ 'a.test': { runs: 1 } });
  io.write({ 'a.test': { runs: 2 } });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { 'a.test': { runs: 2 } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, PROFILES_BACKUP), 'utf8')), { 'a.test': { runs: 1 } });
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no temp file left');
});

test('profileFileIo: a corrupt file is set aside and the previous copy is used; the store keeps every recipe', () => {
  const dir = tmp(); const file = path.join(dir, 'domain-profiles.json');
  fs.writeFileSync(path.join(dir, PROFILES_BACKUP), JSON.stringify(RECIPES));
  fs.writeFileSync(file, '{"old.test": {"method": "internal-a');
  const store = createProfileStore(profileFileIo(file));
  assert.equal(store.get('https://old.test/x').method, 'internal-api', 'read from the previous copy');
  store.record('https://new.test/c', { method: 'crawl', productCount: 3 });
  const now = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(now).sort(), ['new.test', 'old.test', 'other.test']);
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith('domain-profiles.corrupt-')).length, 1);
});

test('profileFileIo: a file that cannot be read (locked) blocks every write of the run', () => {
  const dir = tmp(); const file = path.join(dir, 'domain-profiles.json');
  fs.writeFileSync(file, JSON.stringify(RECIPES));
  const locked = { ...fs, readFileSync: (p, ...a) => { if (p === file) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } return fs.readFileSync(p, ...a); } };
  const store = createProfileStore(profileFileIo(file, { fsImpl: locked }));
  store.record('https://new.test/c', { method: 'crawl', productCount: 3 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), RECIPES, 'the file was not touched');
});

test('profileFileIo: no file yet → empty store, first write creates it', () => {
  const dir = tmp(); const file = path.join(dir, 'domain-profiles.json');
  const store = createProfileStore(profileFileIo(file));
  assert.equal(store.get('https://a.test/'), null);
  store.record('https://a.test/', { method: 'sitemap' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))['a.test'].method, 'sitemap');
});
