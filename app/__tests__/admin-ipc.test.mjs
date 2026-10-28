import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerAdminIpc } from '../admin/ipc.mjs';
import { AdminSession } from '../admin/session.mjs';
import { SecureStore } from '../admin/secure-store.mjs';
import { ProviderRuntime } from '../../core/providers/runtime.mjs';
import { isConfigured } from '../../core/providers/registry.mjs';

const FAKE = 'FAKE_KEY_FOR_TESTS';

function harness({ envText = '' } = {}) {
  let admin = null; const adminStore = { readAdmin: () => admin, writeAdmin: (o) => { admin = JSON.parse(JSON.stringify(o)); } };
  let blob = null; const ss = new SecureStore({
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => Buffer.from(b).toString() },
    readBlob: () => blob, writeBlob: (b) => { blob = b; }, deleteBlob: () => { blob = null; },
  });
  let t = 0; const session = new AdminSession(adminStore, { now: () => t });
  const resolveIo = () => ({ secure: ss.getAll(), config: {}, env: {} });
  const runtime = new ProviderRuntime({}, { isConfigured: (id) => isConfigured(id, resolveIo()), now: () => t });
  let persisted = 0;
  // The free connection test (Firecrawl credit-usage) goes through this fake: no
  // request may leave the test process, even with a fake key.
  const fetchCalls = [];
  const fetchImpl = async (url) => { fetchCalls.push(String(url)); return { status: 200, ok: true, json: async () => ({ data: { remaining_credits: 42 } }) }; };
  const { handlers } = registerAdminIpc({
    session, secureStore: ss, runtime, persist: () => { persisted++; }, resolveIo,
    readEnvFile: () => envText, pickEnvFile: async () => 'C:/fake/.env.local', fetchImpl,
  });
  return { handlers, session, ss, runtime, adminStore, setTime: (v) => { t = v; }, persisted: () => persisted, fetchCalls };
}

const GATED = ['provider:list', 'provider:setCredentials', 'provider:deleteCredentials', 'provider:test', 'provider:importPreview', 'provider:importConfirm', 'provider:setEnabled', 'provider:setKill', 'provider:setDomain', 'provider:addDomain', 'provider:removeDomain', 'provider:setCap', 'provider:usage', 'admin:log', 'admin:setAutoLock'];

test('LOCKED: every gated channel refuses with {locked:true} and NO data', async () => {
  const h = harness();
  for (const chan of GATED) {
    const res = await h.handlers[chan]('brightData.webUnlocker', { apiKey: FAKE });
    assert.equal(res.ok, false, `${chan} should refuse`);
    assert.equal(res.locked, true, `${chan} should report locked`);
    // no provider data leaked
    assert.ok(!('providers' in res) && !('rows' in res) && !('usage' in res) && !('mask' in res), `${chan} leaked data while locked`);
  }
});

test('create passphrase unlocks; then gated channels work', async () => {
  const h = harness();
  assert.equal(h.handlers['admin:create']('longpass12', 'longpass12').ok, true);
  const list = await h.handlers['provider:list']();
  assert.equal(list.ok, true);
  assert.equal(list.providers.length, 4);
});

test('setCredentials stores but the RESULT never contains the value', async () => {
  const h = harness();
  h.handlers['admin:create']('longpass12', 'longpass12');
  const res = await h.handlers['provider:setCredentials']('firecrawl', { apiKey: FAKE });
  assert.equal(res.ok, true);
  assert.ok(!JSON.stringify(res).includes(FAKE), 'setCredentials result must not echo the value');
  assert.equal(h.ss.has('firecrawl'), true);
  assert.equal(res.mask.configured, true);
});

test('test connection: not configured → message; configured → free/format message (never billable)', async () => {
  const h = harness();
  h.handlers['admin:create']('longpass12', 'longpass12');
  const nc = await h.handlers['provider:test']('zyte');
  assert.equal(nc.ok, false);
  assert.match(nc.message, /Non configuré/);
  await h.handlers['provider:setCredentials']('zyte', { apiKey: FAKE });
  const ok = await h.handlers['provider:test']('zyte');
  assert.equal(ok.ok, true);
  assert.match(ok.message, /aucun test gratuit/i);
});

test('import preview lists NAMES only; confirm writes values to the store (not returned)', async () => {
  const env = 'FIRECRAWL-API-KEY=FAKE_FC\nZYTE_API_KEY=FAKE_ZY\nWIX_SECRET_KEY=FAKE_WIX';
  const h = harness({ envText: env });
  h.handlers['admin:create']('longpass12', 'longpass12');
  const pv = await h.handlers['provider:importPreview']();
  assert.equal(pv.ok, true);
  assert.ok(!JSON.stringify(pv).includes('FAKE_'), 'preview must not contain values');
  assert.ok(pv.mapped.some((m) => m.providerId === 'firecrawl'));
  assert.ok(pv.unmapped.includes('WIX_SECRET_KEY'));
  const cf = await h.handlers['provider:importConfirm'](pv.path);
  assert.equal(cf.ok, true);
  assert.equal(cf.count, 2);
  assert.ok(!JSON.stringify(cf).includes('FAKE_'), 'confirm must not echo values');
  assert.equal(h.ss.getAll().firecrawl.apiKey, 'FAKE_FC'); // stored internally
});

test('switches + kill + per-domain persist and reflect in state', async () => {
  const h = harness();
  h.handlers['admin:create']('longpass12', 'longpass12');
  await h.handlers['provider:setEnabled']('firecrawl', false);
  await h.handlers['provider:setKill'](true);
  await h.handlers['provider:setDomain']('adidas.be', 'zyte', false);
  assert.ok(h.persisted() >= 3);
  const st = await h.handlers['provider:list']();
  assert.equal(st.killSwitch, true);
  assert.equal(st.switches.find((s) => s.id === 'firecrawl').enabled, false);
});

test('reset requires the exact confirmation and wipes the store; no backdoor', async () => {
  const h = harness();
  h.handlers['admin:create']('longpass12', 'longpass12');
  await h.handlers['provider:setCredentials']('firecrawl', { apiKey: FAKE });
  assert.equal(h.handlers['admin:reset']('nope').ok, false);
  const r = h.handlers['admin:reset']('REINITIALISER');
  assert.equal(r.ok, true);
  assert.equal(h.ss.has('firecrawl'), false);
  assert.equal(h.session.hasPassphrase(), false);
});

test('admin:log carries provider detail; it is only reachable when unlocked', async () => {
  const h = harness();
  // locked → refused
  assert.equal((await h.handlers['admin:log']('x.be')).locked, true);
  h.handlers['admin:create']('longpass12', 'longpass12');
  const log = await h.handlers['admin:log']('x.be');
  assert.equal(log.ok, true);
  assert.equal(log.rows.length, 4);
});

test('no FAKE secret appears in ANY handler result across a full admin session', async () => {
  const env = 'FIRECRAWL-API-KEY=' + FAKE;
  const h = harness({ envText: env });
  const results = [];
  results.push(h.handlers['admin:status']());
  results.push(h.handlers['admin:create']('longpass12', 'longpass12'));
  results.push(await h.handlers['provider:setCredentials']('firecrawl', { apiKey: FAKE }));
  const pv = await h.handlers['provider:importPreview'](); results.push(pv);
  results.push(await h.handlers['provider:importConfirm'](pv.path));
  results.push(await h.handlers['provider:list']());
  const tested = await h.handlers['provider:test']('firecrawl'); results.push(tested);
  results.push(await h.handlers['admin:log']('x.be'));
  results.push(await h.handlers['provider:usage']());
  assert.ok(!JSON.stringify(results).includes(FAKE), 'no credential value may appear in any IPC result');
  // The free check ran through the injected fetch only (one call, the credit-usage read).
  assert.equal(tested.ok, true); assert.equal(tested.remaining, 42);
  assert.deepEqual(h.fetchCalls, ['https://api.firecrawl.dev/v2/team/credit-usage']);
});
