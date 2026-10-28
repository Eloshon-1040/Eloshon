/**
 * P0 / B2 — the watchdog covers the WHOLE job, last phase included, and can end it.
 * Before: the heartbeat was cleared before the last phase (category trail, stock and
 * reviews, browser close), so a hang there froze the job forever; its stop could
 * not unblock an await that never returns; and a stall was reported as a user stop.
 * Now: a job signal aborts every external wait (HTTP, recipe HTTP, local browser),
 * the heartbeat runs until the end, and the reason is exact ('stopped:stalled').
 * Fake browser, loopback server, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { appDirs, ensureDirs } from '../../lib/osenv.mjs';
import { createController } from '../../app/controller.mjs';
import { createLedger } from '../metering/ledger.mjs';
import { createMeter } from '../metering/meter.mjs';
import { queryLedger } from '../metering/reader.mjs';

const page = (name) => `<html><body><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"${name}","offers":{"@type":"Offer","price":"19.90","priceCurrency":"EUR"}}</script>${'<p>x</p>'.repeat(40)}</body></html>`;
class Mock { constructor() { this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; this.userAgent = 't'; } async get(u) { const ok = u.includes('/p/'); return { ok, status: ok ? 200 : 404, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body: ok ? page('Lampe') : '', headers: {}, error: ok ? null : 'HTTP 404', blocked: false }; } async getText(u) { return this.get(u); } }
/** A local browser whose stock/reviews read never returns — until the browser is closed (like Playwright). */
function stuckBrowser() {
  const pending = [];
  return {
    stats: { bytes: 0, responses: 0 }, closed: false,
    async render(u) { return { html: page('Lampe'), status: 200, url: u }; },
    captureJson() { return new Promise((_, reject) => pending.push(reject)); },
    async close() { this.closed = true; for (const r of pending.splice(0)) r(new Error('Target closed')); },
  };
}
const setup = (config) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-b2-'));
  const dirs = ensureDirs(appDirs(root));
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1, recovery: false, maxProducts: 5, ...config }));
  const ledgerDir = path.join(root, 'usage-ledger');
  const meter = createMeter({ ledger: createLedger({ dir: ledgerDir }) });
  const events = [];
  const ctrl = createController({ dirs, meter, emit: (t, p) => events.push({ t, p }) });
  return { ctrl, events, ledgerDir, done: () => (events.find((e) => e.t === 'done') || {}).p };
};

test('a hang in the last phase (stock and reviews) is ended by the watchdog, with the exact reason', { timeout: 15000 }, async () => {
  const s = setup({ watchdog: { stallMs: 600 } });
  const browser = stuckBrowser();
  const t0 = Date.now();
  await s.ctrl.start({ urls: ['https://shop.test/p/lampe'], store: 'demo', browser: true, fetcher: new Mock(), browserSession: browser });
  const d = s.done();
  assert.ok(d, 'the job finished');
  assert.ok(Date.now() - t0 < 10000, `took ${Date.now() - t0} ms`);
  assert.equal(d.status, 'stopped:stalled');
  assert.equal(d.stoppedByUser, false, 'a stall is not a user stop');
  assert.equal(d.stalled, true);
  assert.equal(d.counts.detected, 1, 'the product already read is kept');
  assert.equal(browser.closed, true, 'the browser was closed to release the wait');
  const local = (await queryLedger(s.ledgerDir, { provider: ['local'] }, { limit: 10 })).rows[0];
  assert.equal(local.reason, 'stalled');
});

test('a user stop that cannot finish (a body that never ends) is released after the grace delay', { timeout: 20000 }, async () => {
  const sockets = new Set();
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.write('<html>'); });
  srv.on('connection', (k) => { sockets.add(k); k.on('close', () => sockets.delete(k)); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/p/1`;
  try {
    const s = setup({ timeoutMs: 60000, retries: 0, rateLimitMs: 0, watchdog: { stallMs: 60000, stopGraceMs: 500 } });
    const run = s.ctrl.start({ urls: [url], store: 'demo', browser: false });
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    s.ctrl.stop();
    await run;
    const d = s.done();
    assert.ok(Date.now() - t0 < 8000, `released after ${Date.now() - t0} ms`);
    assert.equal(d.status, 'interrupted');
    assert.equal(d.stoppedByUser, true);
  } finally { for (const k of sockets) k.destroy(); srv.close(); }
});
