/**
 * Admin usage IPC (Points 2–5): every new channel is admin-gated (locked → no
 * data); the opt-in write is atomic with a backup and a rollback; the domain
 * normalisation is the controller's; the test plan computes the worst case from
 * the existing caps and cost settings; the renderer's settings never carry a
 * provider block, a key or a cost.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerAdminIpc } from '../admin/ipc.mjs';
import { USAGE_GATED, reportView } from '../admin/usage-ipc.mjs';
import { AdminSession } from '../admin/session.mjs';
import { SecureStore } from '../admin/secure-store.mjs';
import { ProviderRuntime } from '../../core/providers/runtime.mjs';
import { isConfigured } from '../../core/providers/registry.mjs';
import { createLedger } from '../../core/metering/ledger.mjs';
import { createMeter } from '../../core/metering/meter.mjs';
import { writeJsonAtomic, updateConfig, BACKUP_NAME } from '../admin/config-store.mjs';
import { publicSettings } from '../settings-view.mjs';

function harness({ config = {}, fetchImpl } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-uipc-'));
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  let admin = null; const adminStore = { readAdmin: () => admin, writeAdmin: (o) => { admin = JSON.parse(JSON.stringify(o)); } };
  let blob = null; const ss = new SecureStore({ safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => Buffer.from(b).toString() }, readBlob: () => blob, writeBlob: (b) => { blob = b; }, deleteBlob: () => { blob = null; } });
  const session = new AdminSession(adminStore);
  const resolveIo = () => ({ secure: ss.getAll(), config: JSON.parse(fs.readFileSync(configFile, 'utf8')), env: {} });
  const runtime = new ProviderRuntime({}, { isConfigured: (id) => isConfigured(id, resolveIo()) });
  const ledgerDir = path.join(root, 'usage-ledger');
  const meter = createMeter({ ledger: createLedger({ dir: ledgerDir }), runtime });
  const { handlers } = registerAdminIpc({ session, secureStore: ss, runtime, persist: () => {}, resolveIo, readEnvFile: () => '', pickEnvFile: async () => null, fetchImpl, configFile, balancesFile: path.join(root, 'provider-balances.json'), getMeter: () => meter, readJobReport: () => ({ status: 'ok', unlock: { provider: 'firecrawl', ok: true, bytes: 10 }, bytesDownloaded: { total: 10 } }), pickSavePath: async () => path.join(root, 'export.csv') });
  const unlock = () => handlers['admin:create']('longpass12', 'longpass12');
  return { root, configFile, handlers, session, ss, runtime, meter, ledgerDir, unlock };
}

test('every usage/opt-in/cost/balance/test-plan channel is admin-gated: locked → {locked:true} and no data', async () => {
  const h = harness();
  for (const chan of USAGE_GATED) {
    assert.ok(h.handlers[chan], `${chan} registered`);
    const r = await h.handlers[chan]('x', 'y', true);
    assert.deepEqual(r, { ok: false, locked: true }, `${chan} must refuse while locked`);
  }
});

test('optin:set writes config.json atomically, keeps a backup, validates, and leaves every other key intact', async () => {
  const h = harness({ config: { lang: 'fr', brightData: { zone: 'z', selectors: { 'a.test': '.x' } }, providers: { killSwitch: false } } });
  h.unlock();
  const r = await h.handlers['optin:set']('https://WWW.Shop.test/fr/x?y=1', 'scrapingBrowser', true);
  assert.equal(r.ok, true);
  assert.equal(r.domain, 'shop.test');
  const cfg = JSON.parse(fs.readFileSync(h.configFile, 'utf8'));
  assert.deepEqual(cfg.brightData.scrapingBrowserDomains, ['shop.test']);
  assert.equal(cfg.brightData.zone, 'z'); assert.equal(cfg.lang, 'fr'); assert.equal(cfg.providers.killSwitch, false);
  assert.ok(fs.existsSync(path.join(h.root, BACKUP_NAME)), 'previous config backed up');
  const row = r.rows.find((x) => x.domain === 'shop.test');
  assert.equal(row.routes.find((x) => x.key === 'scrapingBrowser').optedIn, true);
  const off = await h.handlers['optin:set']('shop.test', 'scrapingBrowser', false);
  assert.deepEqual(JSON.parse(fs.readFileSync(h.configFile, 'utf8')).brightData.scrapingBrowserDomains, []);
  assert.equal(off.ok, true);
  assert.equal((await h.handlers['optin:set']('not a domain', 'firecrawl', true)).ok, false);
  assert.equal((await h.handlers['optin:set']('shop.test', 'nope', true)).ok, false);
});

test('optin:set refuses to touch a corrupt config.json (never overwritten)', async () => {
  const h = harness();
  h.unlock();
  fs.writeFileSync(h.configFile, '{ "lang": "fr", broken');
  const r = await h.handlers['optin:set']('shop.test', 'firecrawl', true);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'config_corrupt');
  assert.equal(fs.readFileSync(h.configFile, 'utf8'), '{ "lang": "fr", broken');
});

test('config store: verify-after-write rolls back to the backup on a mismatch; validation stops a bad write', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-cfg-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ a: 1 }));
  assert.equal(writeJsonAtomic(file, { a: 2 }, { backup: true }).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, BACKUP_NAME), 'utf8')).a, 1);
  const bad = updateConfig(file, (c) => ({ ...c, firecrawl: { domains: 'oops' } }), { validate: (c) => (Array.isArray(c.firecrawl.domains) ? { ok: true } : { ok: false, error: 'not_array' }) });
  assert.equal(bad.ok, false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).a, 2, 'unchanged after a failed validation');
  // simulate a write that does not land as expected → rollback to backup
  const realRead = fs.readFileSync;
  fs.readFileSync = (p, enc) => (p === file ? 'garbled' : realRead(p, enc));
  let r;
  try { r = writeJsonAtomic(file, { a: 3 }, { backup: true }); } finally { fs.readFileSync = realRead; }
  assert.equal(r.ok, false); assert.equal(r.rolledBack, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).a, 2, 'restored from the backup');
});

test('optin:normalize / optin:add — shows exactly what the stored key matches', async () => {
  const h = harness();
  h.unlock();
  const n = await h.handlers['optin:normalize']('HTTPS://www.Example.com/path');
  assert.deepEqual(n.matches, ['example.com', 'www.example.com']);
  assert.match(n.notMatched, /boutique\.example\.com/);
  const a = await h.handlers['optin:add']('example.com');
  assert.ok(a.rows.some((r) => r.domain === 'example.com'), 'added to the table (no opt-in yet)');
  assert.equal(a.rows.find((r) => r.domain === 'example.com').routes.every((x) => !x.optedIn), true);
});

test('usage:summary / usage:query / usage:jobRoutes / usage:job / usage:export read the ledger', async () => {
  const h = harness({ config: { firecrawl: { apiKey: 'fc-x1234567', domains: ['shop.test'] } } });
  h.unlock();
  const jm = h.meter.forJob({ jobId: 'J1', domain: 'shop.test', testMode: true });
  jm.record({ provider: 'local', route: 'crawl', outcome: 'failed', reason: 'ACCESS_DENIED' });
  jm.record({ provider: 'firecrawl', route: 'escalation', outcome: 'success', credits: 2, products: 4 });
  const s = await h.handlers['usage:summary']();
  assert.equal(s.ok, true);
  const fc = s.cards.find((c) => c.id === 'firecrawl');
  assert.equal(fc.configured, true); assert.equal(fc.optInCount, 1); assert.ok(fc.lastUse);
  assert.equal(fc.status.code, 'ready');
  assert.equal(s.cards.find((c) => c.id === 'zyte').status.code, 'not_wired');
  assert.equal(s.periods.today.byProvider.firecrawl.credits, 2);
  const q = await h.handlers['usage:query']({ provider: 'firecrawl' }, { limit: 10 });
  assert.equal(q.total, 1);
  const jr = await h.handlers['usage:jobRoutes']('J1');
  assert.deepEqual(jr.events.map((e) => e.provider), ['local', 'firecrawl']);
  assert.ok(jr.events.every((e) => e.testMode));
  const jv = await h.handlers['usage:job']('J1');
  assert.equal(jv.report.unlock.provider, 'firecrawl');
  const ex = await h.handlers['usage:export']({});
  assert.equal(ex.ok, true); assert.equal(ex.rows, 2);
  const csv = fs.readFileSync(ex.path, 'utf8');
  assert.match(csv, /^﻿v,ts,jobId/);
  assert.equal(csv.includes('fc-x1234567'), false);
});

test('admin:testPlan — caps + worst case from the existing settings; not-configured routes are not allowed', async () => {
  const h = harness({ config: { brightData: { browserAuth: 'brd-customer-c-zone-z:pw123456' } } });
  h.unlock();
  const p = await h.handlers['admin:testPlan']('https://www.shop.test/c');
  assert.equal(p.ok, true); assert.equal(p.domain, 'shop.test');
  const sb = p.routes.find((r) => r.key === 'scrapingBrowser');
  assert.equal(sb.configured, true); assert.equal(sb.allowedWithTest, true); assert.equal(sb.caps.maxBytesPerJob, 40 * 1024 * 1024);
  assert.equal(p.routes.find((r) => r.key === 'firecrawl').allowedWithTest, false);
  assert.ok(p.worst.knownUsd > 0.3 && p.worst.knownUsd < 0.32, '40 MB × 8 $/GB ≈ 0.31 $');
  assert.equal((await h.handlers['admin:testPlan']('')).ok, false);
});

test('costs:get / costs:set — one cost table, validated, written atomically', async () => {
  const h = harness();
  h.unlock();
  assert.equal((await h.handlers['costs:get']()).costs.scrapingbrowser.usdPerGb, 8);
  assert.equal((await h.handlers['costs:set']({ webunlocker: { usdPerRequest: 0.0015 } })).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(h.configFile, 'utf8')).costs.webunlocker.usdPerRequest, 0.0015);
  assert.equal((await h.handlers['costs:set']({ webunlocker: { usdPerRequest: -2 } })).ok, false);
});

test('balance:refresh — only the documented FREE Firecrawl read; cached with its timestamp; never for others', async () => {
  let calls = 0;
  const h = harness({ fetchImpl: async () => { calls++; return { status: 200, json: async () => ({ data: { remaining_credits: 1258, billing_period_end: '2026-10-16T00:00:00Z' } }) }; } });
  h.unlock();
  await h.handlers['provider:setCredentials']('firecrawl', { apiKey: 'fc-FAKEKEY123' });
  const r = await h.handlers['balance:refresh']('firecrawl');
  assert.equal(r.ok, true); assert.equal(r.balance.remaining, 1258); assert.equal(r.balance.resetAt, '2026-10-16T00:00:00.000Z'); assert.ok(r.balance.at);
  assert.equal(calls, 1);
  assert.equal((await h.handlers['balance:refresh']('brightData.webUnlocker')).ok, false);
  assert.equal(calls, 1, 'no request for a provider without a free read');
  const s = await h.handlers['usage:summary']();
  assert.equal(s.cards.find((c) => c.id === 'firecrawl').balance.remaining, 1258);
  assert.equal(JSON.stringify(s).includes('fc-FAKEKEY123'), false);
});

test('reportView keeps only the admin job-view fields', () => {
  const v = reportView({ status: 'ok', method: 'cascade:scrapfly', credits: 9, provider: 'scrapfly', unlock: true, notes: ['x'], errors: [] });
  assert.equal(v.credits, 9); assert.deepEqual(v.unlock, { localUnlock: true }); assert.equal(v.notes, undefined);
});

test('renderer settings: provider blocks, keys, costs and usage counters are never sent to the renderer', () => {
  const pub = publicSettings({ lang: 'fr', workers: 4, edgeLicense: 'LIC-123', unlock: true, ai: { apiKey: 'sk-ant-x' }, providers: { usage: {} }, firecrawl: { apiKey: 'fc', domains: ['a.test'] }, brightData: { apiKey: 'b' }, zyte: {}, costs: {}, someApiKey: 'x' });
  assert.deepEqual(Object.keys(pub).sort(), ['edgeLicense', 'lang', 'unlock', 'workers']);
});
