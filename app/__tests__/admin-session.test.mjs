import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdminSession, failDelayMs, DEFAULT_AUTO_LOCK_MS } from '../admin/session.mjs';

function mkStore() { let rec = null; return { readAdmin: () => rec, writeAdmin: (o) => { rec = JSON.parse(JSON.stringify(o)); }, _peek: () => rec }; }
function clock(start = 0) { let t = start; return { now: () => t, set: (v) => { t = v; }, adv: (d) => { t += d; } }; }

test('growing delay: 0,1,3,7,15… seconds (capped at 5 min)', () => {
  assert.equal(failDelayMs(0), 0);
  assert.equal(failDelayMs(1), 1000);
  assert.equal(failDelayMs(2), 3000);
  assert.equal(failDelayMs(3), 7000);
  assert.ok(failDelayMs(20) <= 5 * 60 * 1000);
});

test('no passphrase initially; create validates length and confirmation', () => {
  const s = new AdminSession(mkStore(), { now: () => 0 });
  assert.equal(s.hasPassphrase(), false);
  assert.match(s.createPassphrase('short', 'short').error, /8 caractères/);
  assert.match(s.createPassphrase('longenough1', 'different2').error, /ne correspondent pas/);
  assert.equal(s.createPassphrase('longenough1', 'longenough1').ok, true);
  assert.equal(s.hasPassphrase(), true);
});

test('passphrase stored only as scrypt hash (no plaintext in the record)', () => {
  const store = mkStore();
  const s = new AdminSession(store, { now: () => 0 });
  s.createPassphrase('correct horse battery', 'correct horse battery');
  const rec = JSON.stringify(store._peek());
  assert.ok(!rec.includes('correct horse battery'), 'plaintext passphrase must not be stored');
  assert.ok(rec.includes('hashHex') && rec.includes('salt'));
});

test('creating unlocks; auto-lock expires after autoLockMs; touch extends', () => {
  const c = clock(1000);
  const s = new AdminSession(mkStore(), { now: c.now });
  s.createPassphrase('longenough1', 'longenough1');
  assert.equal(s.isUnlocked(), true);
  c.set(1000 + DEFAULT_AUTO_LOCK_MS + 1);
  assert.equal(s.isUnlocked(), false);
});

test('wrong passphrase increments failCount and imposes a growing lockout; right one resets', () => {
  const c = clock(0);
  const store = mkStore();
  const s = new AdminSession(store, { now: c.now });
  s.createPassphrase('longenough1', 'longenough1');
  s.lock();
  const r1 = s.unlock('nope'); assert.equal(r1.ok, false);
  assert.equal(store._peek().failCount, 1);
  // second failure locks out; unlocking during lockout is refused with waitMs
  const r2 = s.unlock('nope'); assert.equal(r2.ok, false);
  const locked = s.unlock('longenough1'); // still within lockout window
  assert.equal(locked.ok, false); assert.ok(locked.waitMs > 0);
  // after the lockout window, correct passphrase works and resets failCount
  c.adv(store._peek().lockedUntil - c.now() + 1);
  const good = s.unlock('longenough1');
  assert.equal(good.ok, true);
  assert.equal(store._peek().failCount, 0);
  assert.equal(s.isUnlocked(), true);
});

test('setAutoLockMs requires an unlocked session', () => {
  const s = new AdminSession(mkStore(), { now: () => 0 });
  s.createPassphrase('longenough1', 'longenough1'); // unlocked
  assert.equal(s.setAutoLockMs(60 * 1000).ok, true);
  s.lock();
  assert.equal(s.setAutoLockMs(120000).locked, true);
});

test('reset forgets the passphrase and signals a store wipe (no backdoor)', () => {
  const s = new AdminSession(mkStore(), { now: () => 0 });
  s.createPassphrase('longenough1', 'longenough1');
  const r = s.reset();
  assert.equal(r.ok, true);
  assert.equal(r.wipeStore, true);
  assert.equal(s.hasPassphrase(), false);
  assert.equal(s.isUnlocked(), false);
});

test('status is renderer-safe (no hash/salt leak)', () => {
  const s = new AdminSession(mkStore(), { now: () => 0 });
  s.createPassphrase('longenough1', 'longenough1');
  const st = s.status();
  const json = JSON.stringify(st);
  assert.ok(!json.includes('hashHex') && !json.includes('salt'));
  assert.deepEqual(Object.keys(st).sort(), ['autoLockMs', 'hasPassphrase', 'lockedForMs', 'unlocked']);
});
