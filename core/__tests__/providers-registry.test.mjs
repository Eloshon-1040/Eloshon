import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, PROVIDER_IDS, getProvider, resolveField, resolveCredentials, isConfigured, maskState } from '../providers/registry.mjs';

const FAKE = 'FAKE_KEY_FOR_TESTS';

test('registry: four providers with stable ids', () => {
  assert.deepEqual(PROVIDER_IDS, ['brightData.webUnlocker', 'brightData.scrapingBrowser', 'firecrawl', 'zyte']);
  for (const p of PROVIDERS) { assert.ok(p.label && p.configPath && Array.isArray(p.fields) && p.costModel); }
});

test('resolveField: order secure > config > env > default', () => {
  const p = getProvider('brightData.webUnlocker');
  const apiKey = p.fields.find((f) => f.key === 'apiKey');
  const zone = p.fields.find((f) => f.key === 'zone');
  // secure wins
  assert.equal(resolveField(p, apiKey, { secure: { 'brightData.webUnlocker': { apiKey: FAKE } }, config: { brightData: { apiKey: 'CFG' } }, env: { 'BRIGHT-DATA-API-KEY': 'ENV' } }).source, 'secure');
  // config next
  assert.equal(resolveField(p, apiKey, { config: { brightData: { apiKey: 'CFG' } }, env: { 'BRIGHT-DATA-API-KEY': 'ENV' } }).source, 'config');
  // env next (name-only fallback)
  assert.equal(resolveField(p, apiKey, { env: { 'BRIGHT-DATA-API-KEY': 'ENV' } }).source, 'env');
  // default for non-required zone
  assert.equal(resolveField(p, zone, {}).value, 'mcp_unlocker');
  assert.equal(resolveField(p, zone, {}).source, 'default');
});

test('isConfigured: requires all required fields; zone default does not count as configured alone', () => {
  assert.equal(isConfigured('brightData.webUnlocker', {}), false); // apiKey missing
  assert.equal(isConfigured('brightData.webUnlocker', { env: { 'BRIGHT-DATA-API-KEY': FAKE } }), true);
  assert.equal(isConfigured('firecrawl', { secure: { firecrawl: { apiKey: FAKE } } }), true);
  assert.equal(isConfigured('zyte', {}), false);
});

test('maskState: never returns values — only presence/source/flags', () => {
  const m = maskState('brightData.scrapingBrowser', { secure: { 'brightData.scrapingBrowser': { browserAuth: FAKE } } });
  const json = JSON.stringify(m);
  assert.ok(!json.includes(FAKE), 'mask must not contain the secret value');
  assert.equal(m.configured, true);
  const authField = m.fields.find((f) => f.key === 'browserAuth');
  assert.equal(authField.present, true);
  assert.equal(authField.source, 'secure');
  assert.equal(authField.secret, true);
});

test('maskState: incomplete when a non-required present but required missing', () => {
  // webUnlocker: zone present (config), apiKey missing → incomplete
  const m = maskState('brightData.webUnlocker', { config: { brightData: { zone: 'z1' } } });
  assert.equal(m.configured, false);
  assert.equal(m.incomplete, true);
});

test('resolveCredentials: returns a value map for the lane (main process only)', () => {
  const creds = resolveCredentials('firecrawl', { secure: { firecrawl: { apiKey: FAKE } } });
  assert.equal(creds.apiKey, FAKE);
  // includes non-secret default (zone) for web unlocker
  const wu = resolveCredentials('brightData.webUnlocker', { env: { 'BRIGHT-DATA-API-KEY': FAKE } });
  assert.equal(wu.zone, 'mcp_unlocker');
});

test('cost models are represented (Zyte per-request/variable, SB per-GB)', () => {
  assert.equal(getProvider('zyte').costModel.type, 'per_request');
  assert.equal(getProvider('brightData.scrapingBrowser').costModel.type, 'per_gb');
  assert.equal(getProvider('brightData.scrapingBrowser').costModel.usdPerGb, 8);
});

test('BUG1b caps/units: Scraping Browser is byte/USD-capped (not calls/month) — matches the panel UI', () => {
  const sb = getProvider('brightData.scrapingBrowser').caps;
  assert.ok(sb.maxBytesPerJob != null && sb.maxBytesPerMonth != null && sb.maxUsdPerMonth != null, 'SB should expose byte + USD caps');
  assert.equal(sb.maxCallsPerMonth, undefined, 'SB has no calls/month cap → the empty "appels/mois" field was the mismatch');
  // call-billed providers keep call caps
  assert.ok(getProvider('firecrawl').caps.maxCallsPerMonth != null);
  assert.ok(getProvider('zyte').caps.maxCallsPerMonth != null);
});
