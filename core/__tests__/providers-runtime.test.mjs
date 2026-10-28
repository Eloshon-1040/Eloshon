import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderRuntime, withDefaults } from '../providers/runtime.mjs';

const allConfigured = () => true;
const rt = (state = {}, configured = allConfigured, now = () => Date.UTC(2026, 8, 28)) => new ProviderRuntime(state, { isConfigured: configured, now });

test('defaults: providers ON, kill OFF, available when configured & under caps', () => {
  const r = rt();
  assert.equal(r.isAvailable('firecrawl', 'x.be'), true);
  assert.equal(r.availabilityReason('firecrawl', 'x.be'), null);
});

test('per-provider switch OFF makes it unavailable but keeps others', () => {
  const r = rt();
  r.setEnabled('firecrawl', false);
  assert.equal(r.availabilityReason('firecrawl', 'x.be'), 'disabled');
  assert.equal(r.isAvailable('zyte', 'x.be'), true);
});

test('master kill switch disables all', () => {
  const r = rt();
  r.setKill(true);
  for (const id of ['brightData.webUnlocker', 'brightData.scrapingBrowser', 'firecrawl', 'zyte']) assert.equal(r.availabilityReason(id, 'x.be'), 'kill_switch');
});

test('not configured → not_configured reason', () => {
  const r = rt({}, (id) => id === 'firecrawl'); // only firecrawl configured
  assert.equal(r.availabilityReason('zyte', 'x.be'), 'not_configured');
  assert.equal(r.isAvailable('firecrawl', 'x.be'), true);
});

test('per-domain toggle OFF blocks only that domain', () => {
  const r = rt();
  r.setDomainEnabled('adidas.be', 'firecrawl', false);
  assert.equal(r.availabilityReason('firecrawl', 'adidas.be'), 'domain_off');
  assert.equal(r.isAvailable('firecrawl', 'other.be'), true);
});

test('effective availability = switch AND domain AND configured AND caps AND not-kill', () => {
  const r = rt({}, (id) => id === 'zyte');
  // zyte configured + on + domain on + caps ok
  assert.equal(r.isAvailable('zyte', 'x.be'), true);
  r.setDomainEnabled('x.be', 'zyte', false);
  assert.equal(r.isAvailable('zyte', 'x.be'), false);
});

test('caps: per-job call cap stops after N calls', () => {
  const r = rt();
  r.setCap('firecrawl', { maxCallsPerJob: 2 });
  assert.equal(r.isAvailable('firecrawl', 'x'), true);
  r.recordCall('firecrawl'); r.recordCall('firecrawl');
  assert.equal(r.availabilityReason('firecrawl', 'x'), 'cap_reached');
  r.resetJobCounters();
  assert.equal(r.isAvailable('firecrawl', 'x'), true); // job counter reset; month still ok
});

test('per-GB cap: bytes accumulate to USD and stop at monthly USD cap', () => {
  const r = rt();
  r.setCap('brightData.scrapingBrowser', { maxUsdPerMonth: 0.02 }); // ~2.5MB at $8/GB
  r.recordCall('brightData.scrapingBrowser', { bytes: 4 * 1024 * 1024 }); // ~$0.03
  assert.equal(r.availabilityReason('brightData.scrapingBrowser', 'x'), 'cap_reached');
});

test('usage month rollover resets monthly counters', () => {
  const state = { usage: { firecrawl: { month: '2025-01', callsThisMonth: 999, callsThisJob: 5 } } };
  const r = rt(state);
  const u = r.usageFor('firecrawl'); // now is 2026-09 → rollover
  assert.equal(u.callsThisMonth, 0);
});

test('adminLog carries provider detail incl skip reason; userFacingNote is generic', () => {
  const r = rt({}, (id) => id !== 'zyte'); // zyte not configured
  r.setEnabled('firecrawl', false);
  const log = r.adminLog('adidas.be');
  const fc = log.find((x) => x.id === 'firecrawl');
  const zy = log.find((x) => x.id === 'zyte');
  assert.match(fc.skipReason, /désactivé/);
  assert.match(zy.skipReason, /non configuré/);
  // user note: no provider name/cost
  const note = r.userFacingNote();
  assert.ok(!/Firecrawl|Bright|Zyte|\$|Go|crédit/i.test(note));
});

test('withDefaults never mutates input and fills the shape', () => {
  const input = {};
  const s = withDefaults(input);
  assert.deepEqual(Object.keys(s).sort(), ['caps', 'enabled', 'killSwitch', 'perDomain', 'usage']);
});
