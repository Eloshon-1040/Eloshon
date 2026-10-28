/**
 * The extension keeps ONE link to the app: each link is a host process named « Eloshon Scraper.exe »,
 * so duplicated links looked like the app staying open in the background and blocked new installs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeLink } from '../../extension/background/native-link.mjs';

function fakeChrome() {
  const ports = [];
  return {
    ports,
    runtime: {
      lastError: null,
      connectNative() {
        const l = { msg: [], dis: [] };
        const port = { onMessage: { addListener: (f) => l.msg.push(f) }, onDisconnect: { addListener: (f) => l.dis.push(f) }, postMessage() {}, disconnect() {}, drop: () => l.dis.forEach((f) => f()) };
        ports.push(port); return port;
      },
    },
  };
}

test('ensure() / connect() never open a second port while one is open', () => {
  const c = fakeChrome(); const link = new NativeLink(c, {});
  link.ensure(); link.ensure(); link.connect(); link.connectNow();
  assert.equal(c.ports.length, 1);
});

test('after a disconnect: one scheduled reconnect, the wake-up alarm does not add another, connectNow retries at once', async () => {
  const c = fakeChrome(); const link = new NativeLink(c, {});
  link.connect(); c.ports[0].drop();
  link.ensure(); link.ensure();             // the alarm firing while a reconnect is pending
  assert.equal(c.ports.length, 1, 'no extra port before the scheduled retry');
  link.connectNow();                          // the panel needs the app now
  assert.equal(c.ports.length, 2);
  await new Promise((r) => setTimeout(r, 1200)); // the cancelled timer must not open a third port
  assert.equal(c.ports.length, 2);
  link.disconnect();
});

test('while the app stays closed the retry delay grows up to 5 minutes', () => {
  const link = new NativeLink(fakeChrome(), {});
  assert.equal(link.maxBackoffMs, 300000);
});
