import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATE, canTransition, transition, isTerminal } from '../job/machine.mjs';
import { JobStore, memoryAdapter, productKey } from '../job/store.mjs';

test('machine: legal and illegal transitions', () => {
  assert.equal(canTransition(STATE.RUNNING, STATE.PAUSED_CHALLENGE), true);
  assert.equal(canTransition(STATE.PAUSED_CHALLENGE, STATE.RUNNING), true);
  assert.equal(canTransition(STATE.DONE, STATE.RUNNING), false);
  assert.equal(canTransition(STATE.BLOCKED, STATE.RUNNING), false);
  assert.throws(() => transition(STATE.DONE, STATE.RUNNING), /illégale/);
});

test('machine: terminal detection', () => {
  for (const s of [STATE.DONE, STATE.BLOCKED, STATE.STOPPED, STATE.ERROR]) assert.equal(isTerminal(s), true);
  assert.equal(isTerminal(STATE.RUNNING), false);
});

test('store: create is idempotent per jobId', async () => {
  const s = new JobStore(memoryAdapter());
  const a = await s.create('j1', { domain: 'x.be' });
  const b = await s.create('j1', { domain: 'x.be' });
  assert.equal(a.startedAt, b.startedAt);
});

test('store: appendProducts dedups against persisted seen-set (idempotent replay)', async () => {
  const s = new JobStore(memoryAdapter());
  await s.create('j1', { domain: 'x.be' });
  const first = await s.appendProducts('j1', [{ sku: 'a' }, { sku: 'b' }]);
  assert.equal(first.length, 2);
  const second = await s.appendProducts('j1', [{ sku: 'b' }, { sku: 'c' }]); // b dup
  assert.deepEqual(second.map((p) => p.sku), ['c']);
  const replay = await s.appendProducts('j1', [{ sku: 'a' }, { sku: 'b' }, { sku: 'c' }]); // all dup
  assert.equal(replay.length, 0);
  const rec = await s.load('j1');
  assert.equal(rec.productCount, 3);
});

test('store: cursor survives and merges', async () => {
  const s = new JobStore(memoryAdapter());
  await s.create('j1', { domain: 'x.be' });
  await s.saveCursor('j1', { page: 2 });
  await s.saveCursor('j1', { detailIndex: 4 });
  const rec = await s.load('j1');
  assert.equal(rec.cursor.page, 2);
  assert.equal(rec.cursor.detailIndex, 4);
});

test('store: allProducts reassembles chunks in order', async () => {
  const s = new JobStore(memoryAdapter());
  await s.create('j1', { domain: 'x.be' });
  await s.appendProducts('j1', [{ sku: 'a' }, { sku: 'b' }]);
  await s.appendProducts('j1', [{ sku: 'c' }]);
  const all = await s.allProducts('j1');
  assert.deepEqual(all.map((p) => p.sku), ['a', 'b', 'c']);
});

test('store: resume simulation — reload keeps seen-set so no duplicate after "restart"', async () => {
  const adapter = memoryAdapter();
  let s = new JobStore(adapter);
  await s.create('j1', { domain: 'x.be' });
  await s.appendProducts('j1', [{ sku: 'a' }]);
  await s.setState('j1', STATE.PAUSED_CHALLENGE);
  // simulate service-worker restart: brand-new store over the SAME adapter
  s = new JobStore(adapter);
  const rec = await s.load('j1');
  assert.equal(rec.state, STATE.PAUSED_CHALLENGE);
  await s.setState('j1', STATE.RUNNING);
  const fresh = await s.appendProducts('j1', [{ sku: 'a' }, { sku: 'd' }]); // a already seen
  assert.deepEqual(fresh.map((p) => p.sku), ['d']);
});

test('store: setState enforces the machine', async () => {
  const s = new JobStore(memoryAdapter());
  await s.create('j1', { domain: 'x.be' });
  await s.setState('j1', STATE.DONE);
  await assert.rejects(() => s.setState('j1', STATE.RUNNING), /illégale/);
});

test('productKey identity priority: sku > id > url > name|price', () => {
  assert.equal(productKey({ sku: 's', id: 'i' }), 's');
  assert.equal(productKey({ id: 'i', url: 'u' }), 'i');
  assert.equal(productKey({ url: 'u' }), 'u');
  assert.equal(productKey({ name: 'n', price: 1 }), 'n|1');
  assert.equal(productKey({}), null);
});

test('store: destroy removes record and chunks', async () => {
  const adapter = memoryAdapter();
  const s = new JobStore(adapter);
  await s.create('j1', { domain: 'x.be' });
  await s.appendProducts('j1', [{ sku: 'a' }]);
  await s.destroy('j1');
  assert.equal(await s.load('j1'), undefined);
  assert.equal(adapter._map.size, 0);
});
