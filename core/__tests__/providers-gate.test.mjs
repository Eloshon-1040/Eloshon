import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProviderCfg, providerIdForLane } from '../providers/gate.mjs';
import { ProviderRuntime } from '../providers/runtime.mjs';
import { isConfigured } from '../providers/registry.mjs';
import { firecrawlConfig } from '../unlock/firecrawl.mjs';
import { webUnlockerConfig } from '../unlock/web-unlocker.mjs';

const FAKE = 'FAKE_KEY_FOR_TESTS';
const fakeSecure = (map) => ({ getAll: () => map });
const rt = (state, secure, env = {}) => new ProviderRuntime(state, { now: () => Date.UTC(2026, 8, 28), isConfigured: (id) => isConfigured(id, { secure, config: {}, env }) });

test('providerIdForLane maps lane names', () => {
  assert.equal(providerIdForLane('firecrawl'), 'firecrawl');
  assert.equal(providerIdForLane('web-unlocker'), 'brightData.webUnlocker');
  assert.equal(providerIdForLane('scraping-browser'), 'brightData.scrapingBrowser');
  assert.equal(providerIdForLane('nope'), null);
});

test('no runtime → base config returned unchanged (identical reference)', () => {
  const base = { firecrawl: { apiKey: 'X' } };
  assert.equal(buildProviderCfg(base, {}), base);
});

test('available provider gets secure creds injected; lane sees configured', () => {
  const secure = { firecrawl: { apiKey: FAKE } };
  const runtime = rt({}, secure);
  const cfg = buildProviderCfg({}, { runtime, secureStore: fakeSecure(secure), host: 'x.be', env: {} });
  assert.equal(cfg.firecrawl.apiKey, FAKE);
  assert.equal(firecrawlConfig(cfg, {}).configured, true);
});

test('disabled provider → creds withheld → lane sees NOT configured (no billable call)', () => {
  const secure = { firecrawl: { apiKey: FAKE } };
  const runtime = rt({}, secure).setEnabled('firecrawl', false);
  const cfg = buildProviderCfg({ firecrawl: { apiKey: 'CFGKEY' } }, { runtime, secureStore: fakeSecure(secure), host: 'x.be', env: {} });
  assert.equal(cfg.firecrawl.apiKey, undefined);
  assert.equal(firecrawlConfig(cfg, {}).configured, false);
});

test('kill switch withholds ALL providers', () => {
  const secure = { firecrawl: { apiKey: FAKE }, 'brightData.webUnlocker': { apiKey: FAKE } };
  const runtime = rt({}, secure).setKill(true);
  const cfg = buildProviderCfg({}, { runtime, secureStore: fakeSecure(secure), host: 'x.be', env: {} });
  assert.equal(firecrawlConfig(cfg, {}).configured, false);
  assert.equal(webUnlockerConfig(cfg, {}).configured, false);
});

test('per-domain OFF withholds for that host only', () => {
  const secure = { firecrawl: { apiKey: FAKE } };
  const runtime = rt({}, secure).setDomainEnabled('adidas.be', 'firecrawl', false);
  const off = buildProviderCfg({}, { runtime, secureStore: fakeSecure(secure), host: 'adidas.be', env: {} });
  const on = buildProviderCfg({}, { runtime, secureStore: fakeSecure(secure), host: 'other.be', env: {} });
  assert.equal(firecrawlConfig(off, {}).configured, false);
  assert.equal(firecrawlConfig(on, {}).configured, true);
});

test('cap reached withholds creds', () => {
  const secure = { firecrawl: { apiKey: FAKE } };
  const runtime = rt({}, secure).setCap('firecrawl', { maxCallsPerJob: 1 });
  runtime.recordCall('firecrawl');
  const cfg = buildProviderCfg({}, { runtime, secureStore: fakeSecure(secure), host: 'x.be', env: {} });
  assert.equal(firecrawlConfig(cfg, {}).configured, false);
});

test('webUnlocker + scrapingBrowser share the brightData block without clobbering', () => {
  const secure = { 'brightData.webUnlocker': { apiKey: FAKE }, 'brightData.scrapingBrowser': { browserAuth: 'brd-customer-x-zone-z:pw' } };
  const runtime = rt({}, secure);
  const cfg = buildProviderCfg({}, { runtime, secureStore: fakeSecure(secure), host: 'x.be', env: {} });
  assert.equal(cfg.brightData.apiKey, FAKE);
  assert.equal(cfg.brightData.browserAuth, 'brd-customer-x-zone-z:pw');
});
