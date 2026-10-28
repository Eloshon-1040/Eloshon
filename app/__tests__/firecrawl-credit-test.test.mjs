/**
 * BUG 5: "Tester la connexion" on Firecrawl must run the real FREE credit-usage
 * check (read-only, never billable) and return a DISTINCT pass/fail result — not
 * the static capability description. Mocked fetch only; the key never leaks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firecrawlCreditUsage } from '../../core/unlock/firecrawl.mjs';
import { registerAdminIpc } from '../admin/ipc.mjs';
import { AdminSession } from '../admin/session.mjs';
import { SecureStore } from '../admin/secure-store.mjs';
import { ProviderRuntime } from '../../core/providers/runtime.mjs';
import { isConfigured } from '../../core/providers/registry.mjs';

const FAKE = 'FAKE_KEY_FOR_TESTS';

test('firecrawlCreditUsage: GET /v2/team/credit-usage with Bearer, returns remaining', async () => {
  let seen = null;
  const fetchImpl = async (url, opts) => { seen = { url, opts }; return { status: 200, json: async () => ({ success: true, data: { remaining_credits: 812 } }) }; };
  const r = await firecrawlCreditUsage(FAKE, { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.remaining, 812);
  assert.equal(seen.url, 'https://api.firecrawl.dev/v2/team/credit-usage');
  assert.equal(seen.opts.method, 'GET');
  assert.equal(seen.opts.headers.Authorization, `Bearer ${FAKE}`);
});

test('firecrawlCreditUsage: v2 camelCase answer (remainingCredits, planCredits, billingPeriodEnd)', async () => {
  // Hand-built from the v2 reference (GET /v2/team/credit-usage), read on 2026-10-20.
  const body = { success: true, data: { remainingCredits: 1234, planCredits: 3000, billingPeriodStart: '2026-10-01T00:00:00.000Z', billingPeriodEnd: '2026-11-01T00:00:00.000Z' } };
  const r = await firecrawlCreditUsage(FAKE, { fetchImpl: async () => ({ status: 200, json: async () => body }) });
  assert.deepEqual(r, { ok: true, remaining: 1234, resetAt: '2026-11-01T00:00:00.000Z', planCredits: 3000 });
  // Nothing stated → nothing invented.
  const bare = await firecrawlCreditUsage(FAKE, { fetchImpl: async () => ({ status: 200, json: async () => ({ success: true, data: { remainingCredits: 5, billingPeriodEnd: null } }) }) });
  assert.deepEqual(bare, { ok: true, remaining: 5 });
});

test('firecrawlCreditUsage: 401 → invalid key; network error → clear error; no key', async () => {
  const bad = await firecrawlCreditUsage(FAKE, { fetchImpl: async () => ({ status: 401, json: async () => ({}) }) });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /invalide/);
  assert.ok(!JSON.stringify(bad).includes(FAKE));
  const net = await firecrawlCreditUsage(FAKE, { fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  assert.equal(net.ok, false);
  assert.match(net.error, /échouée/);
});

test('firecrawlCreditUsage: not configured is inert (no request)', async () => {
  let called = 0;
  const r = await firecrawlCreditUsage(null, { fetchImpl: async () => { called++; return { status: 200, json: async () => ({}) }; } });
  assert.equal(r.ok, false);
  assert.equal(called, 0);
});

// ---- IPC handler integration (mocked safeStorage + fetch) ----
function harness({ fetchImpl } = {}) {
  let admin = null; const adminStore = { readAdmin: () => admin, writeAdmin: (o) => { admin = JSON.parse(JSON.stringify(o)); } };
  let blob = null; const ss = new SecureStore({ safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => Buffer.from(b).toString() }, readBlob: () => blob, writeBlob: (b) => { blob = b; }, deleteBlob: () => { blob = null; } });
  let t = 0; const session = new AdminSession(adminStore, { now: () => t });
  const resolveIo = () => ({ secure: ss.getAll(), config: {}, env: {} });
  const runtime = new ProviderRuntime({}, { isConfigured: (id) => isConfigured(id, resolveIo()), now: () => t });
  const { handlers } = registerAdminIpc({ session, secureStore: ss, runtime, persist: () => {}, resolveIo, readEnvFile: () => '', pickEnvFile: async () => null, fetchImpl });
  return { handlers, ss, session };
}

test('provider:test Firecrawl runs the real check and returns a distinct "connecté" result', async () => {
  const h = harness({ fetchImpl: async () => ({ status: 200, json: async () => ({ data: { remaining_credits: 500 } }) }) });
  h.handlers['admin:create']('longpass12', 'longpass12');
  await h.handlers['provider:setCredentials']('firecrawl', { apiKey: FAKE });
  const r = await h.handlers['provider:test']('firecrawl');
  assert.equal(r.ok, true);
  assert.equal(r.status, 'connecté');           // distinct from the static description
  assert.equal(r.remaining, 500);
  assert.match(r.message, /500 crédits restants/);
  assert.ok(r.at, 'a timestamp is returned');
  assert.ok(!JSON.stringify(r).includes(FAKE), 'the key never appears in the result');
});

test('provider:test Firecrawl surfaces a distinct "échec" on an invalid key', async () => {
  const h = harness({ fetchImpl: async () => ({ status: 401, json: async () => ({}) }) });
  h.handlers['admin:create']('longpass12', 'longpass12');
  await h.handlers['provider:setCredentials']('firecrawl', { apiKey: FAKE });
  const r = await h.handlers['provider:test']('firecrawl');
  assert.equal(r.ok, false);
  assert.equal(r.status, 'échec');
  assert.match(r.message, /Échec/);
});

test('the other three providers show ONLY format_only, no fake result, no API call', async () => {
  let called = 0;
  const h = harness({ fetchImpl: async () => { called++; return { status: 200, json: async () => ({}) }; } });
  h.handlers['admin:create']('longpass12', 'longpass12');
  for (const id of ['brightData.webUnlocker', 'brightData.scrapingBrowser', 'zyte']) {
    await h.handlers['provider:setCredentials'](id, id === 'brightData.scrapingBrowser' ? { browserAuth: FAKE } : { apiKey: FAKE });
    const r = await h.handlers['provider:test'](id);
    assert.equal(r.status, 'format_only', `${id} should be format-only`);
    assert.match(r.message, /aucun test gratuit/i);
  }
  assert.equal(called, 0, 'no network call for non-Firecrawl providers');
});

test('provider:test not configured → non_configuré (no API call)', async () => {
  let called = 0;
  const h = harness({ fetchImpl: async () => { called++; return { status: 200, json: async () => ({}) }; } });
  h.handlers['admin:create']('longpass12', 'longpass12');
  const r = await h.handlers['provider:test']('firecrawl');
  assert.equal(r.status, 'non_configuré');
  assert.equal(called, 0);
});
