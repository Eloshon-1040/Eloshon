/**
 * Meter + costs + opt-in + provider status (Points 1, 2, 5): one function feeds
 * the ledger AND the cap counters; costs come from the one cost table (registry
 * defaults overridable in config); opt-in decisions and normalisation match the
 * controller's matching; the card status is derived from facts only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLedger, FIELDS, normalizeEvent } from '../metering/ledger.mjs';
import { createMeter } from '../metering/meter.mjs';
import { queryLedger } from '../metering/reader.mjs';
import { defaultCosts, effectiveCosts, estimateCost, validateCostsPatch, worstCaseForLaunch } from '../metering/costs.mjs';
import { providerStatus } from '../metering/status.mjs';
import { normalizeDomain, hostKey, isOptedIn, withOptIn, optInState, optedInDomains, validateOptInConfig, routeDecision, PAID_ROUTES } from '../providers/optin.mjs';
import { ProviderRuntime } from '../providers/runtime.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-meter-'));

test('costs: defaults are the registry values, unchanged (8 $/GB for the Scraping Browser, others unknown)', () => {
  const c = defaultCosts();
  assert.equal(c.scrapingbrowser.usdPerGb, 8);
  assert.equal(c.webunlocker.usdPerRequest, null);
  assert.equal(c.firecrawl.usdPerCredit, null);
  assert.equal(c.anthropic.usdPerMTokIn, null);
});

test('costs: config overrides, invalid values ignored, patch validation', () => {
  const c = effectiveCosts({ costs: { webunlocker: { usdPerRequest: 0.0015 }, scrapingbrowser: { usdPerGb: 'abc' } } });
  assert.equal(c.webunlocker.usdPerRequest, 0.0015);
  assert.equal(c.scrapingbrowser.usdPerGb, null, 'an invalid stored value means "unknown", never a guess');
  assert.equal(validateCostsPatch({ webunlocker: { usdPerRequest: -1 } }).ok, false);
  assert.equal(validateCostsPatch({ nope: {} }).ok, false);
  assert.deepEqual(validateCostsPatch({ firecrawl: { usdPerCredit: '0.001', usdPerRequest: '' } }).value, { firecrawl: { usdPerCredit: 0.001, usdPerRequest: null } });
});

test('costs: estimate per provider — known price → number, unknown → null with the reason', () => {
  const c = effectiveCosts({ costs: { firecrawl: { usdPerCredit: 0.001 } } });
  assert.equal(estimateCost({ provider: 'scrapingbrowser', attempted: true, channel: 'direct', bytes: 1024 ** 3 / 2 }, c).costUsd, 4);
  assert.equal(estimateCost({ provider: 'firecrawl', attempted: true, channel: 'direct', credits: 5 }, c).costUsd, 0.005);
  const wu = estimateCost({ provider: 'webunlocker', attempted: true, channel: 'direct' }, c);
  assert.equal(wu.costUsd, null); assert.match(wu.costBasis, /non renseigné/);
  assert.equal(estimateCost({ provider: 'cascade', attempted: true, channel: 'server', credits: 9 }, c).costUsd, null);
  assert.equal(estimateCost({ provider: 'local', attempted: true }, c).costUsd, 0);
  assert.equal(estimateCost({ provider: 'firecrawl', attempted: false }, c).costUsd, null, 'a blocked call costs nothing');
});

test('costs: Firecrawl — credits reported by the API are priced as such; otherwise the line says "estimation"', () => {
  const perCredit = effectiveCosts({ costs: { firecrawl: { usdPerCredit: 0.002 } } });
  const real = estimateCost({ provider: 'firecrawl', attempted: true, channel: 'direct', credits: 1 }, perCredit);
  assert.equal(real.costUsd, 0.002); assert.match(real.costBasis, /^crédits relevés/);
  // No credits reported (null): the published 1 credit/page, marked as an estimate — never 0.
  const est = estimateCost({ provider: 'firecrawl', attempted: true, channel: 'direct', credits: null }, perCredit);
  assert.equal(est.costUsd, 0.002); assert.match(est.costBasis, /^estimation : 1 crédit/);
  const perReq = effectiveCosts({ costs: { firecrawl: { usdPerRequest: 0.01 } } });
  const req = estimateCost({ provider: 'firecrawl', attempted: true, channel: 'direct' }, perReq);
  assert.equal(req.costUsd, 0.01); assert.match(req.costBasis, /^estimation : 0.01 \$\/requête/);
  const none = estimateCost({ provider: 'firecrawl', attempted: true, channel: 'direct', credits: 1 }, effectiveCosts({}));
  assert.equal(none.costUsd, null); assert.match(none.costBasis, /non renseigné/);
});

test('ledger: cacheState is kept for hit / miss only, null otherwise (field added in v0.5.37)', () => {
  assert.equal(FIELDS.at(-1), 'cacheState'); assert.equal(FIELDS.length, 25);
  assert.equal(normalizeEvent({ provider: 'firecrawl', cacheState: 'hit' }).cacheState, 'hit');
  assert.equal(normalizeEvent({ provider: 'firecrawl', cacheState: 'miss' }).cacheState, 'miss');
  assert.equal(normalizeEvent({ provider: 'firecrawl', cacheState: 'stale' }).cacheState, null);
  assert.equal(normalizeEvent({ provider: 'local' }).cacheState, null);
});

test('costs: worst case of one launch — one call per allowed route, unknown prices listed', () => {
  const w = worstCaseForLaunch([
    { provider: 'firecrawl', label: 'Firecrawl', allowed: true },
    { provider: 'scrapingbrowser', label: 'Scraping Browser', allowed: true, caps: { maxBytesPerJob: 40 * 1024 * 1024 } },
    { provider: 'webunlocker', label: 'Web Unlocker', allowed: false },
  ], defaultCosts());
  assert.equal(w.routes.length, 2);
  assert.ok(Math.abs(w.knownUsd - (40 / 1024) * 8) < 1e-9);
  assert.deepEqual(w.unknown, ['Firecrawl']);
});

test('meter: one call writes the ledger line AND bumps the DIRECT cap counter (same step)', async () => {
  const dir = tmp();
  const rt = new ProviderRuntime({}, { isConfigured: () => true, now: () => Date.UTC(2026, 9, 6) });
  let persisted = 0;
  const m = createMeter({ ledger: createLedger({ dir }), runtime: rt, persist: () => { persisted++; }, readConfig: () => ({}) });
  m.forJob({ jobId: 'j1', domain: 'shop.test', testMode: true }).record({ provider: 'scrapingbrowser', route: 'escalation', outcome: 'success', bytes: 1024 ** 3 / 8 });
  m.record({ provider: 'firecrawl', outcome: 'blocked_no_optin', attempted: false });
  m.record({ provider: 'firecrawl', channel: 'server', route: 'cascade', outcome: 'success' });
  const rows = (await queryLedger(dir, {})).rows;
  assert.equal(rows.length, 3);
  const sb = rows.find((r) => r.provider === 'scrapingbrowser');
  assert.equal(sb.jobId, 'j1'); assert.equal(sb.testMode, true); assert.equal(sb.costUsd, 1);
  assert.equal(rt.usageFor('brightData.scrapingBrowser').callsThisMonth, 1);
  assert.equal(rt.usageFor('brightData.scrapingBrowser').usdThisMonth, 1);
  assert.equal(rt.usageFor('firecrawl').callsThisMonth, 0, 'blocked and server calls do not count against the direct caps');
  assert.equal(persisted, 1);
});

test('meter: a failed ledger write still counts the call against the caps (a disk error never lifts a cap)', () => {
  const rt = new ProviderRuntime({}, { isConfigured: () => true });
  const brokenLedger = { dir: null, record: () => null, status: () => ({}) };
  const m = createMeter({ ledger: brokenLedger, runtime: rt });
  assert.equal(m.record({ provider: 'firecrawl', outcome: 'success' }), null);
  assert.equal(rt.usageFor('firecrawl').callsThisMonth, 1);
});

test('meter: reconcile raises (never lowers) the month cap counters from the ledger', async () => {
  const dir = tmp();
  const now = Date.UTC(2026, 9, 6);
  const l = createLedger({ dir, now: () => now });
  l.record({ provider: 'firecrawl', outcome: 'success' });
  l.record({ provider: 'firecrawl', outcome: 'failed' });
  const rt = new ProviderRuntime({ usage: { firecrawl: { month: '2026-10', callsThisMonth: 1, bytesThisMonth: 0, usdThisMonth: 0, callsThisJob: 0, bytesThisJob: 0 }, 'brightData.webUnlocker': { month: '2026-10', callsThisMonth: 7, bytesThisMonth: 0, usdThisMonth: 0, callsThisJob: 0, bytesThisJob: 0 } } }, { now: () => now });
  const m = createMeter({ ledger: l, runtime: rt, now: () => now });
  await m.reconcile();
  assert.equal(rt.usageFor('firecrawl').callsThisMonth, 2);
  assert.equal(rt.usageFor('brightData.webUnlocker').callsThisMonth, 7, 'pre-ledger usage still counts');
});

test('opt-in: normalisation — scheme, path, case and www stripped; matches host + www only', () => {
  const n = normalizeDomain('  HTTPS://WWW.Shop.Example.com/fr/c?x=1 ');
  assert.equal(n.ok, true);
  assert.equal(n.domain, 'shop.example.com');
  assert.deepEqual(n.matches, ['shop.example.com', 'www.shop.example.com']);
  assert.equal(normalizeDomain('').ok, false);
  assert.equal(normalizeDomain('not a domain').ok, false);
  assert.equal(normalizeDomain('localhost').ok, false);
  assert.equal(hostKey('https://www.adidas.be/x'), 'adidas.be');
});

test('opt-in: same exact matching as the controller (no subdomain inheritance)', () => {
  const cfg = withOptIn({}, 'example.com', 'firecrawl', true);
  assert.equal(isOptedIn(cfg, 'firecrawl', hostKey('https://www.example.com/a')), true);
  assert.equal(isOptedIn(cfg, 'firecrawl', hostKey('https://shop.example.com/a')), false);
  assert.equal(isOptedIn(cfg, 'webUnlocker', 'example.com'), false);
});

test('opt-in: withOptIn adds/removes without touching other keys; state + domain list', () => {
  const base = { brightData: { zone: 'z', selectors: { 'a.test': '.x' }, domains: ['a.test'] }, other: 1 };
  let cfg = withOptIn(base, 'b.test', 'scrapingBrowser', true);
  cfg = withOptIn(cfg, 'b.test', 'webUnlocker', true);
  cfg = withOptIn(cfg, 'a.test', 'webUnlocker', false);
  assert.deepEqual(cfg.brightData.domains, ['b.test']);
  assert.deepEqual(cfg.brightData.scrapingBrowserDomains, ['b.test']);
  assert.equal(cfg.brightData.zone, 'z'); assert.equal(cfg.other, 1);
  assert.deepEqual(base.brightData.domains, ['a.test'], 'input not mutated');
  assert.deepEqual(optInState(cfg, 'b.test'), { firecrawl: false, webUnlocker: true, scrapingBrowser: true });
  assert.deepEqual(optedInDomains(cfg), ['b.test']);
});

test('opt-in: schema validation rejects broken lists', () => {
  assert.equal(validateOptInConfig({}).ok, true);
  assert.equal(validateOptInConfig({ firecrawl: { domains: 'x.test' } }).ok, false);
  assert.equal(validateOptInConfig({ brightData: { domains: ['ok.test', 'bad domain'] } }).ok, false);
  assert.equal(validateOptInConfig([]).ok, false);
});

test('opt-in: route decision — not configured, no opt-in, cap, test mode', () => {
  assert.deepEqual(routeDecision({ configured: false, optedIn: true, testMode: false, gateReason: null }), { allowed: false, reason: 'not_configured', outcome: 'skipped' });
  assert.equal(routeDecision({ configured: true, optedIn: false, testMode: false, gateReason: null }).outcome, 'blocked_no_optin');
  assert.equal(routeDecision({ configured: true, optedIn: true, testMode: false, gateReason: 'cap_reached' }).outcome, 'blocked_by_cap');
  assert.equal(routeDecision({ configured: true, optedIn: true, testMode: false, gateReason: 'kill_switch' }).outcome, 'skipped');
  const t = routeDecision({ configured: true, optedIn: false, testMode: true, gateReason: null });
  assert.equal(t.allowed, true); assert.equal(t.reason, 'test_mode');
  assert.equal(PAID_ROUTES.length, 3);
});

test('status: one code per provider, in priority order', () => {
  assert.equal(providerStatus({ wired: false, configured: true }).code, 'not_wired');
  assert.equal(providerStatus({ configured: false }).code, 'not_configured');
  assert.equal(providerStatus({ configured: true, gateReason: 'cap_reached' }).code, 'cap_reached');
  assert.equal(providerStatus({ configured: true, lastEvent: { outcome: 'quota_exhausted', ts: 't' } }).code, 'quota_exhausted');
  assert.equal(providerStatus({ configured: true, balance: { remaining: 0 } }).code, 'quota_exhausted');
  assert.equal(providerStatus({ configured: true, lastEvent: { outcome: 'failed', ts: 't', reason: 'http_500' } }).code, 'last_call_error');
  assert.equal(providerStatus({ configured: true, optInCount: 0 }).code, 'no_optin');
  assert.equal(providerStatus({ configured: true, optInCount: 2, lastEvent: { outcome: 'success', ts: 't' } }).code, 'ready');
});
