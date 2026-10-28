import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { TierSession, isYourBrowserEnabled, pacingConfigFor, runYourBrowserTier } from '../your-browser/tier.mjs';
import { authenticate, ensurePairingSecret } from '../your-browser/bridge.mjs';
import * as P from '../../shared/protocol/messages.mjs';

function mockSession() {
  const sent = [];
  const s = new TierSession({ send: (m) => sent.push(m) });
  return { s, sent };
}

test('TierSession.run sends a job and resolves on a terminal DONE result', async () => {
  const { s, sent } = mockSession();
  const promise = s.run({ job_id: 'j1', domain: 'colruyt.be', recipe: { mode: 'internal_api' } });
  assert.equal(sent[0].type, 'job');
  s.onMessage(P.result('j1', P.JOB_STATUS.DONE, { products: [{ sku: 'a' }], counts: { products: 1 } }));
  const res = await promise;
  assert.equal(res.status, 'done');
  assert.equal(res.products.length, 1);
});

test('TierSession surfaces progress and pause without resolving', async () => {
  const { s } = mockSession();
  const progress = []; const pauses = [];
  const promise = s.run({ job_id: 'j1', domain: 'x.be', recipe: {}, onProgress: (p) => progress.push(p), onPause: (p) => pauses.push(p) });
  s.onMessage(P.progress('j1', { done: 2 }));
  s.onMessage(P.result('j1', P.JOB_STATUS.PAUSED_CHALLENGE, { message: 'défi' }));
  assert.equal(progress.length, 1);
  assert.equal(pauses.length, 1);
  // still pending; now finish
  s.onMessage(P.result('j1', P.JOB_STATUS.DONE, {}));
  const res = await promise;
  assert.equal(res.status, 'done');
});

test('TierSession resolves ERROR message tied to the job', async () => {
  const { s } = mockSession();
  const promise = s.run({ job_id: 'j9', domain: 'x.be', recipe: {} });
  s.onMessage(P.error('E_X', 'boom', { job_id: 'j9' }));
  const res = await promise;
  assert.equal(res.status, 'error');
  assert.equal(res.reason, 'boom');
});

test('runYourBrowserTier flags tryNextTier on blocked', async () => {
  const { s } = mockSession();
  const promise = runYourBrowserTier(s, { job_id: 'j2', domain: 'adidas.be', recipe: {} });
  s.onMessage(P.result('j2', P.JOB_STATUS.BLOCKED, { reason: 'challenge_blocked' }));
  const res = await promise;
  assert.equal(res.tryNextTier, true);
  assert.equal(res.tier, 'your_browser');
});

test('isYourBrowserEnabled is a strict per-domain opt-in', () => {
  const cfg = { yourBrowser: { perDomain: { 'colruyt.be': { enabled: true }, 'x.be': { enabled: false } } } };
  assert.equal(isYourBrowserEnabled(cfg, 'colruyt.be'), true);
  assert.equal(isYourBrowserEnabled(cfg, 'x.be'), false);
  assert.equal(isYourBrowserEnabled(cfg, 'unknown.be'), false);
  assert.equal(isYourBrowserEnabled({}, 'x.be'), false);
});

test('pacingConfigFor builds a PacingRegistry-shaped config', () => {
  const cfg = { yourBrowser: { pacing: { baseIntervalMs: 1500 }, perDomain: { 'colruyt.be': { pacing: { baseIntervalMs: 3000 } } } } };
  const pc = pacingConfigFor(cfg);
  assert.equal(pc.defaults.baseIntervalMs, 1500);
  assert.equal(pc.perDomain['colruyt.be'].baseIntervalMs, 3000);
});

test('authenticate accepts a correct host hello, rejects wrong/absent secret and non-host', () => {
  const secret = 'abc123';
  assert.equal(authenticate(P.hello('host', { secret }), secret).ok, true);
  assert.equal(authenticate(P.hello('host', { secret: 'nope' }), secret).ok, false);
  assert.equal(authenticate(P.hello('extension', { secret }), secret).reason, 'not_host');
  assert.equal(authenticate({ ...P.hello('host', { secret }), protocol_version: P.PROTOCOL_VERSION + 1 }, secret).reason, 'protocol_version');
});

test('ensurePairingSecret creates once (0600) then returns the same value', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elo-pair-'));
  const a = ensurePairingSecret(dir);
  const b = ensurePairingSecret(dir);
  assert.equal(a, b);
  assert.equal(a.length, 64); // 32 bytes hex
  fs.rmSync(dir, { recursive: true, force: true });
});
