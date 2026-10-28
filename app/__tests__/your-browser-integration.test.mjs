/**
 * Integration tests for the "your browser" tier wiring — mocked only, no live
 * network to any target site. A mock native-host client connects to the REAL
 * HostBridge endpoint (a unique temp pipe/socket) to exercise the handshake and a
 * full round trip.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createYourBrowserService, enabledDomains } from '../your-browser/integration.mjs';
import { HostBridge, ensurePairingSecret } from '../your-browser/bridge.mjs';
import { encodeMessage, MessageDecoder } from '../../native-host/framing.mjs';
import * as P from '../../shared/protocol/messages.mjs';

const uniqEndpoint = () => (process.platform === 'win32'
  ? `\\\\.\\pipe\\elo-test-${crypto.randomBytes(6).toString('hex')}`
  : path.join(os.tmpdir(), `elo-${crypto.randomBytes(6).toString('hex')}.sock`));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'elo-yb-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 3000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { if (fn()) return true; await wait(20); } return false; }

/** A mock native host: connects to the bridge endpoint and speaks framed protocol. */
function mockHost(endpoint, secret) {
  const inbound = [];
  const dec = new MessageDecoder();
  const sock = net.connect(endpoint);
  const api = {
    inbound,
    connected: false,
    send: (m) => sock.write(encodeMessage(m)),
    authenticate: () => sock.write(encodeMessage(P.hello('host', { secret }))),
    close: () => sock.destroy(),
  };
  sock.on('connect', () => { api.connected = true; try { sock.unref(); } catch { /* */ } });
  sock.on('data', (chunk) => { for (const m of dec.push(chunk)) inbound.push(m); });
  sock.on('error', () => {});
  return api;
}

test('enabledDomains reads the per-domain opt-in flag', () => {
  assert.deepEqual(enabledDomains({ yourBrowser: { perDomain: { 'a.be': { enabled: true }, 'b.be': { enabled: false } } } }), ['a.be']);
  assert.deepEqual(enabledDomains({}), []);
});

test('feature ON by default: the bridge starts with NO domain opted in (authorization comes live from the extension)', () => {
  const svc = createYourBrowserService({ config: {}, bridgeOptions: { endpoint: uniqEndpoint(), dir: tmpDir() } });
  const r = svc.start();
  assert.equal(r.started, true, 'bridge waits for the extension even without a config flag');
  assert.ok(svc._bridge);
  svc.stop();
});

test('the extension grant is the live source of truth: a domain NOT in config becomes usable on capabilities, no restart', () => {
  const bridge = { sent: [], start() {}, stop() {}, send(m) { bridge.sent.push(m); } };
  // Config has no perDomain entry for levi.test at all.
  const svc = createYourBrowserService({ config: { yourBrowser: {} }, bridgeFactory: () => bridge });
  svc.start();
  bridge.onStatus('connected');
  // Extension connected but has not authorized levi.test yet.
  bridge.onMessage(P.capabilities(['auto'], { browser: 'chrome', domains: [] }));
  assert.equal(svc.availability('https://www.levi.test/fr/jeans').code, 'domain_not_activated');
  // The user clicks "Activer ce domaine": the extension re-announces its grant.
  bridge.onMessage(P.capabilities(['auto'], { browser: 'chrome', domains: ['levi.test'] }));
  assert.deepEqual(svc.status().permittedDomains, ['levi.test']);
  const av = svc.availability('https://www.levi.test/fr/jeans');
  assert.equal(av.ok, true, 'usable the moment the extension grants it — no config, no restart');
  assert.equal(av.domain, 'levi.test');
  // Revoking in the extension (a fresh capabilities without it) disables it live.
  bridge.onMessage(P.capabilities(['auto'], { browser: 'chrome', domains: [] }));
  assert.equal(svc.availability('https://www.levi.test/fr/jeans').code, 'domain_not_activated');
  svc.stop();
});

test('feature OFF only when explicitly disabled (yourBrowser.enabled:false) -> no listener', () => {
  const svc = createYourBrowserService({ config: { yourBrowser: { enabled: false } }, bridgeOptions: { endpoint: uniqEndpoint(), dir: tmpDir() } });
  const r = svc.start();
  assert.equal(r.started, false);
  assert.equal(r.reason, 'feature_off');
  assert.equal(svc._bridge, null);
  svc.stop();
});

test('feature ON: listener starts and reports state', async () => {
  const endpoint = uniqEndpoint(); const dir = tmpDir();
  const states = [];
  const svc = createYourBrowserService({ config: { yourBrowser: { perDomain: { 'colruyt.be': { enabled: true } } } }, emit: (t, p) => { if (t === 'yourBrowser') states.push(p); }, bridgeOptions: { endpoint, dir } });
  const r = svc.start();
  assert.equal(r.started, true);
  assert.ok(await until(() => svc.status().bridge === 'listening'));
  svc.stop();
  assert.equal(svc.status().bridge, 'stopped');
});

test('handshake success + capabilities -> extension connected; wrong secret refused', async () => {
  const endpoint = uniqEndpoint(); const dir = tmpDir();
  const secret = ensurePairingSecret(dir);
  const svc = createYourBrowserService({ config: { yourBrowser: { perDomain: { 'x.be': { enabled: true } } } }, bridgeOptions: { endpoint, dir } });
  svc.start();
  await until(() => svc.status().bridge === 'listening');

  // Wrong secret is refused.
  const bad = mockHost(endpoint, 'not-the-secret');
  await until(() => bad.connected);
  bad.authenticate();
  assert.ok(await until(() => svc.status().lastAuth === 'failed'), 'wrong secret should be refused');
  assert.notEqual(svc.status().extension, 'connected');
  bad.close();

  // Correct secret authenticates; app solicits capabilities; host replies.
  const host = mockHost(endpoint, secret);
  await until(() => host.connected);
  host.authenticate();
  assert.ok(await until(() => host.inbound.some((m) => m.type === P.MSG.HELLO)), 'app should send hello after auth');
  host.send(P.capabilities(['internal_api', 'dom'], { browser: 'chrome' }));
  assert.ok(await until(() => svc.status().extension === 'connected'));
  assert.equal(svc.status().browser, 'chrome');
  host.close();
  svc.stop();
});

test('full round trip: job -> progress -> result, routed through controller ingest', async () => {
  const endpoint = uniqEndpoint(); const dir = tmpDir();
  const secret = ensurePairingSecret(dir);
  const ingested = [];
  const controller = { ingestExternalProducts: async (input) => { ingested.push(input); return { jobId: 'j-local', counts: { accepted: input.products.length }, csvPath: '/tmp/x.csv' }; } };
  const svc = createYourBrowserService({ config: { yourBrowser: { perDomain: { 'colruyt.be': { enabled: true } } } }, controller, bridgeOptions: { endpoint, dir } });
  svc.start();
  await until(() => svc.status().bridge === 'listening');
  const host = mockHost(endpoint, secret);
  await until(() => host.connected);
  host.authenticate();
  await until(() => host.inbound.some((m) => m.type === P.MSG.HELLO));

  const runP = svc.runJob({ job_id: 'j1', domain: 'colruyt.be', recipe: { mode: 'internal_api' }, store: 'colruyt' });
  assert.ok(await until(() => host.inbound.some((m) => m.type === P.MSG.JOB)), 'host should receive the job');
  host.send(P.progress('j1', { done: 2, total: 5 }));
  host.send(P.result('j1', P.JOB_STATUS.DONE, { products: [{ name: 'Lait', price: 1.29, sku: 'a' }], counts: { products: 1 } }));
  const res = await runP;
  assert.equal(res.status, 'done');
  assert.equal(ingested.length, 1);
  assert.equal(ingested[0].products.length, 1);
  assert.equal(ingested[0].store, 'colruyt');
  host.close();
  svc.stop();
});

test('pause/resume/stop are relayed to the host (for the active job only)', async () => {
  const endpoint = uniqEndpoint(); const dir = tmpDir();
  const secret = ensurePairingSecret(dir);
  const svc = createYourBrowserService({ config: { yourBrowser: { perDomain: { 'x.be': { enabled: true } } } }, bridgeOptions: { endpoint, dir }, stopGraceMs: 50 });
  svc.start();
  await until(() => svc.status().bridge === 'listening');
  const host = mockHost(endpoint, secret);
  await until(() => host.connected);
  host.authenticate();
  await until(() => host.inbound.some((m) => m.type === P.MSG.HELLO));
  assert.equal(svc.pause('j1').code, 'unknown_job', 'no control for a job that is not running');
  const runP = svc.runJob({ job_id: 'j1', domain: 'x.be', recipe: {} });
  svc.pause('j1'); svc.resume('j1'); svc.stopJob('j1');
  assert.ok(await until(() => host.inbound.some((m) => m.type === P.MSG.PAUSE) && host.inbound.some((m) => m.type === P.MSG.RESUME) && host.inbound.some((m) => m.type === P.MSG.STOP)));
  assert.equal((await runP).status, 'stopped', 'an unconfirmed stop settles after the grace period');
  host.close();
  svc.stop();
});

test('busy endpoint does not crash start (surfaces an error status)', async () => {
  const endpoint = uniqEndpoint(); const dir = tmpDir();
  const a = new HostBridge({ endpoint, dir, onStatus: () => {}, onMessage: () => {} });
  a.start();
  await wait(100);
  let errored = false;
  const svc = createYourBrowserService({ config: { yourBrowser: { perDomain: { 'x.be': { enabled: true } } } }, emit: (t, p) => { if (t === 'yourBrowser' && p.bridge === 'error') errored = true; }, bridgeOptions: { endpoint, dir } });
  const r = svc.start(); // must not throw
  assert.equal(r.started, true);
  assert.ok(await until(() => errored), 'busy endpoint should surface an error status, not crash');
  svc.stop(); a.stop();
});

test('no secret leaks into logs or emitted states during a full round trip', async () => {
  const endpoint = uniqEndpoint(); const dir = tmpDir();
  const secret = ensurePairingSecret(dir);
  const captured = [];
  const svc = createYourBrowserService({
    config: { yourBrowser: { perDomain: { 'x.be': { enabled: true } } } },
    controller: { ingestExternalProducts: async () => ({ jobId: 'j', counts: {}, csvPath: '' }) },
    emit: (t, p) => captured.push(JSON.stringify({ t, p })),
    log: (m) => captured.push(String(m)),
    bridgeOptions: { endpoint, dir },
  });
  svc.start();
  await until(() => svc.status().bridge === 'listening');
  const host = mockHost(endpoint, secret);
  await until(() => host.connected);
  host.authenticate();
  await until(() => host.inbound.some((m) => m.type === P.MSG.HELLO));
  host.send(P.capabilities(['dom'], { browser: 'edge' }));
  const runP = svc.runJob({ job_id: 'j1', domain: 'x.be', recipe: {}, store: 's' });
  await until(() => host.inbound.some((m) => m.type === P.MSG.JOB));
  host.send(P.result('j1', P.JOB_STATUS.DONE, { products: [{ name: 'p', sku: '1' }] }));
  await runP;
  const blob = captured.join('\n');
  assert.ok(secret.length >= 32);
  assert.ok(!blob.includes(secret), 'the pairing secret must never appear in logs or emitted states');
  host.close();
  svc.stop();
});
