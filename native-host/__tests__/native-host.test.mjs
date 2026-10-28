import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeMessage, MessageDecoder, MAX_MESSAGE_BYTES } from '../framing.mjs';
import { createRelay } from '../relay.mjs';
import * as P from '../../shared/protocol/messages.mjs';

test('framing: encode/decode round-trip', () => {
  const dec = new MessageDecoder();
  const msgs = dec.push(encodeMessage({ type: 'hello', n: 1 }));
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].n, 1);
});

test('framing: split header and body across chunks', () => {
  const dec = new MessageDecoder();
  const full = encodeMessage({ type: 'progress', payload: { job_id: 'j' } });
  assert.deepEqual(dec.push(full.subarray(0, 2)), []);      // partial header
  assert.deepEqual(dec.push(full.subarray(2, 5)), []);      // rest of header + 1 byte body
  const done = dec.push(full.subarray(5));
  assert.equal(done.length, 1);
  assert.equal(done[0].type, 'progress');
});

test('framing: two messages in one chunk', () => {
  const dec = new MessageDecoder();
  const chunk = Buffer.concat([encodeMessage({ a: 1 }), encodeMessage({ b: 2 })]);
  const out = dec.push(chunk);
  assert.equal(out.length, 2);
  assert.equal(out[0].a, 1);
  assert.equal(out[1].b, 2);
});

test('framing: oversized framed length is rejected', () => {
  const dec = new MessageDecoder({ maxBytes: 8 });
  const header = Buffer.alloc(4); header.writeUInt32LE(9, 0);
  assert.throws(() => dec.push(header), /exceeds cap/);
});

test('framing: MAX cap is 64MB', () => { assert.equal(MAX_MESSAGE_BYTES, 64 * 1024 * 1024); });

function harness({ connected = true } = {}) {
  const toExt = []; const toApp = [];
  const relay = createRelay({
    sendExtension: (m) => toExt.push(m),
    sendApp: (m) => { toApp.push(m); return connected; },
    appConnected: () => connected,
  });
  return { relay, toExt, toApp };
}

test('relay: valid extension message is forwarded to the app', () => {
  const h = harness({ connected: true });
  const ok = h.relay.onExtensionMessage(P.job('j', 'x.be', { mode: 'dom' }));
  assert.equal(ok, true);
  assert.equal(h.toApp.length, 1);
  assert.equal(h.toExt.length, 0);
});

test('relay: app down -> E_APP_DOWN back to extension, nothing forwarded', () => {
  const h = harness({ connected: false });
  const ok = h.relay.onExtensionMessage(P.job('j', 'x.be', { mode: 'dom' }));
  assert.equal(ok, false);
  assert.equal(h.toApp.length, 0);
  assert.equal(h.toExt[0].payload.code, 'E_APP_DOWN');
  assert.equal(h.toExt[0].payload.retriable, true);
});

test('relay: malformed message -> E_BAD_MESSAGE, not forwarded', () => {
  const h = harness();
  h.relay.onExtensionMessage({ type: 'job', payload: {} }); // missing version/id
  assert.equal(h.toApp.length, 0);
  assert.equal(h.toExt[0].payload.code, 'E_BAD_MESSAGE');
});

test('relay: version mismatch -> E_PROTOCOL_VERSION', () => {
  const h = harness();
  h.relay.onExtensionMessage({ ...P.hello('extension'), protocol_version: P.PROTOCOL_VERSION + 1 });
  assert.equal(h.toExt[0].payload.code, 'E_PROTOCOL_VERSION');
});

test('relay: app -> extension forwards valid, drops invalid', () => {
  const h = harness();
  assert.equal(h.relay.onAppMessage(P.result('j', P.JOB_STATUS.DONE)), true);
  assert.equal(h.toExt.length, 1);
  assert.equal(h.relay.onAppMessage({ nope: true }), false);
  assert.equal(h.toExt.length, 1); // unchanged
});

test('host relay leaves once the app has been unreachable for a while (never lingers as « Eloshon Scraper.exe »)', async () => {
  const { createIdleExit, HOST_IDLE_EXIT_MS } = await import('../idle.mjs');
  let t = 0; let up = false; let exits = 0;
  const idle = createIdleExit({ isUp: () => up, exit: () => { exits++; }, now: () => t });
  t = HOST_IDLE_EXIT_MS - 1; assert.equal(idle.tick(), false, 'still waiting for the app');
  up = true; t += 5000; assert.equal(idle.tick(), false);
  up = false; t += 1000; assert.equal(idle.tick(), false, 'the app just closed: a grace period first');
  t += HOST_IDLE_EXIT_MS; assert.equal(idle.tick(), true); assert.equal(exits, 1);
  idle.tick(); assert.equal(exits, 1, 'exits once');
});
