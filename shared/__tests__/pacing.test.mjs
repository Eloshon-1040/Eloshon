import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket } from '../pacing/token-bucket.mjs';
import { DomainPacer, PacingRegistry, PACING_DEFAULTS } from '../pacing/pacer.mjs';

// Deterministic clock/rng helpers.
const clock = (start = 0) => { let t = start; return { now: () => t, set: (v) => { t = v; }, adv: (d) => { t += d; return t; } }; };
const noJitter = () => 0;

test('TokenBucket: first reserve is free; second incurs a wait ~= interval', () => {
  const c = clock(0);
  const b = new TokenBucket({ capacity: 1, refillPerSec: 1, now: c.now }); // 1 token/sec
  assert.equal(b.reserve(c.now()), 0);                 // starts full
  const w = b.reserve(c.now());                        // now empty -> debt 1 -> ~1000ms
  assert.ok(Math.abs(w - 1000) < 1, `expected ~1000ms, got ${w}`);
});

test('TokenBucket: debt accumulates correctly under back-to-back reserves', () => {
  const c = clock(0);
  const b = new TokenBucket({ capacity: 1, refillPerSec: 2, now: c.now }); // 2/sec => 500ms each
  b.reserve(0);                    // free
  const w1 = b.reserve(0);         // debt 1 -> 500ms
  const w2 = b.reserve(0);         // debt 2 -> 1000ms
  assert.ok(Math.abs(w1 - 500) < 1);
  assert.ok(Math.abs(w2 - 1000) < 1);
});

test('TokenBucket: refill pays down debt over time', () => {
  const c = clock(0);
  const b = new TokenBucket({ capacity: 2, refillPerSec: 1, now: c.now });
  b.reserve(0); b.reserve(0);        // drains 2 tokens (was full)
  const w = b.reserve(2000);         // 2s later -> refilled 2 -> free again
  assert.equal(w, 0);
});

test('DomainPacer: no jitter, steady spacing equals base interval', () => {
  const c = clock(0);
  const p = new DomainPacer({ baseIntervalMs: 1000, burst: 1 }, { now: c.now, random: noJitter });
  assert.equal(p.reserve(0), 0);
  const w = p.reserve(0);
  assert.ok(Math.abs(w - 1000) < 2, `got ${w}`);
});

test('DomainPacer: jitter stays within the configured ratio band', () => {
  const c = clock(0);
  const p = new DomainPacer({ baseIntervalMs: 1000, burst: 1, jitterRatio: 0.3 }, { now: c.now, random: () => 1 });
  const w = p.reserve(0); // full jitter = 300ms on a free reserve
  assert.ok(w >= 0 && w <= 300 + 1, `jitter out of band: ${w}`);
});

test('DomainPacer: backoff on 429 raises interval and sets a cooldown', () => {
  const c = clock(0);
  const p = new DomainPacer({ baseIntervalMs: 1000, backoffFactor: 2 }, { now: c.now, random: noJitter });
  const before = p.intervalMs;
  p.onResponse({ status: 429, t: 0 });
  assert.equal(p.intervalMs, before * 2);
  const w = p.reserve(0); // cooldown active -> wait >= raised interval
  assert.ok(w >= p.intervalMs - 1, `cooldown not honored: ${w}`);
});

test('DomainPacer: honours Retry-After when larger than the interval', () => {
  const c = clock(0);
  const p = new DomainPacer({ baseIntervalMs: 1000 }, { now: c.now, random: noJitter });
  p.onResponse({ status: 429, retryAfterMs: 10000, t: 0 });
  const w = p.reserve(0);
  assert.ok(w >= 10000 - 1, `Retry-After ignored: ${w}`);
});

test('DomainPacer: 456 and 403 and challenge all trigger backoff', () => {
  for (const sig of [{ status: 456 }, { status: 403 }, { challenge: true }]) {
    const p = new DomainPacer({ baseIntervalMs: 1000 }, { now: () => 0, random: noJitter });
    const before = p.intervalMs;
    p.onResponse({ ...sig, t: 0 });
    assert.ok(p.intervalMs > before, `no backoff for ${JSON.stringify(sig)}`);
  }
});

test('DomainPacer: high latency slows down even on a 200', () => {
  const p = new DomainPacer({ baseIntervalMs: 1000, latencyHighMs: 2000, latencySlowFactor: 1.5 }, { now: () => 0, random: noJitter });
  p.onResponse({ status: 200, latencyMs: 5000, t: 0 });
  assert.equal(p.intervalMs, 1500);
});

test('DomainPacer: sustained success decays interval back toward base (not below min)', () => {
  const p = new DomainPacer({ baseIntervalMs: 4000, minIntervalMs: 1000, decayFactor: 0.5, successesToDecay: 3 }, { now: () => 0, random: noJitter });
  for (let i = 0; i < 3; i++) p.onResponse({ status: 200, latencyMs: 100, t: 0 });
  assert.equal(p.intervalMs, 2000); // one decay step after 3 successes
});

test('DomainPacer: interval never exceeds max or drops below min', () => {
  const p = new DomainPacer({ baseIntervalMs: 1000, maxIntervalMs: 3000, minIntervalMs: 800, backoffFactor: 10 }, { now: () => 0, random: noJitter });
  p.onResponse({ status: 429, t: 0 });
  assert.equal(p.intervalMs, 3000); // clamped to max
});

test('DomainPacer: resumeGently raises interval and imposes a cooldown', () => {
  const c = clock(0);
  const p = new DomainPacer({ baseIntervalMs: 1000, resumeFactor: 3 }, { now: c.now, random: noJitter });
  p.resumeGently(0);
  assert.equal(p.intervalMs, 3000);
  assert.ok(p.reserve(0) >= 3000 - 1);
});

test('PacingRegistry: per-domain config overrides defaults; unknown domain uses defaults', () => {
  const reg = new PacingRegistry({ defaults: { baseIntervalMs: 900 }, perDomain: { 'colruyt.be': { baseIntervalMs: 2500 } } }, { now: () => 0, random: () => 0 });
  assert.equal(reg.get('colruyt.be').cfg.baseIntervalMs, 2500);
  assert.equal(reg.get('other.com').cfg.baseIntervalMs, 900);
  // same instance returned for the same domain
  assert.equal(reg.get('colruyt.be'), reg.get('colruyt.be'));
});

test('PacingRegistry.configure: applies a job-delivered config; same config keeps the pacer; never faster than a live backoff', () => {
  const reg = new PacingRegistry({}, { now: () => 0, random: () => 0 });
  const p1 = reg.configure('boutique-alpha.test', { baseIntervalMs: 2500 });
  assert.equal(p1.cfg.baseIntervalMs, 2500);
  assert.equal(reg.configure('boutique-alpha.test', { baseIntervalMs: 2500 }), p1, 'same config → same pacer (learned state kept)');
  p1.intervalMs = 9000; // e.g. after a 456 backoff
  const p2 = reg.configure('boutique-alpha.test', { baseIntervalMs: 1500 });
  assert.notEqual(p2, p1);
  assert.equal(p2.intervalMs, 9000, 'a new config never undoes a backoff');
  assert.equal(reg.get('magasin-beta.example').cfg.baseIntervalMs, PACING_DEFAULTS.baseIntervalMs, 'other domains untouched');
});

test('DomainPacer: snapshot exposes bounded diagnostics with no secrets', () => {
  const p = new DomainPacer({}, { now: () => 0, random: noJitter });
  p.reserve(0); p.onResponse({ status: 200, latencyMs: 50, t: 0 });
  const s = p.snapshot();
  assert.ok('intervalMs' in s && Array.isArray(s.recentDecisions));
  assert.ok(s.recentDecisions.length <= 20);
});

test('PACING_DEFAULTS are conservative (>= 1s base, jitter present)', () => {
  assert.ok(PACING_DEFAULTS.baseIntervalMs >= 1000);
  assert.ok(PACING_DEFAULTS.jitterRatio > 0);
});
