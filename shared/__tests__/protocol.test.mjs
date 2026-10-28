import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTOCOL_VERSION, MSG, makeMessage, validateMessage,
  hello, capabilities, job, progress, result, error, pause, resume, stop, diagnostic, JOB_STATUS,
} from '../protocol/messages.mjs';

test('makeMessage: stamps version/type/id/ts and rejects unknown types', () => {
  const m = makeMessage(MSG.PROGRESS, { job_id: 'j1', done: 3 });
  assert.equal(m.protocol_version, PROTOCOL_VERSION);
  assert.equal(m.type, 'progress');
  assert.ok(m.id && typeof m.ts === 'number');
  assert.throws(() => makeMessage('nope', {}), /inconnu/);
});

test('validateMessage: valid job passes', () => {
  const m = job('j1', 'colruyt.be', { mode: 'internal_api' });
  const v = validateMessage(m);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
});

test('validateMessage: missing required payload field fails with French message', () => {
  const m = makeMessage(MSG.JOB, { job_id: 'j1' }); // missing domain + recipe
  const v = validateMessage(m);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('domain')));
  assert.ok(v.errors.some((e) => e.includes('recipe')));
});

test('validateMessage: higher protocol_version is a version mismatch, not ok', () => {
  const m = { ...hello('extension'), protocol_version: PROTOCOL_VERSION + 1 };
  const v = validateMessage(m);
  assert.equal(v.versionMismatch, true);
  assert.equal(v.ok, false);
});

test('validateMessage: garbage input never throws', () => {
  assert.equal(validateMessage(null).ok, false);
  assert.equal(validateMessage(42).ok, false);
  assert.equal(validateMessage({}).ok, false);
});

test('factories build each message type validly', () => {
  const msgs = [
    hello('extension', { browser: 'chrome' }),
    capabilities(['internal_api', 'dom']),
    job('j', 'x.be', { mode: 'dom' }),
    progress('j', { done: 1, total: 10 }),
    result('j', JOB_STATUS.DONE, { products: [] }),
    error('E_X', 'boom'),
    pause('j', 'challenge'),
    resume('j'),
    stop('j'),
    diagnostic('j', { pages: [] }),
  ];
  for (const m of msgs) assert.equal(validateMessage(m).ok, true, `${m.type}: ${JSON.stringify(validateMessage(m).errors)}`);
});

test('ids are unique across rapid creation', () => {
  const ids = new Set();
  for (let i = 0; i < 500; i++) ids.add(progress('j').id);
  assert.equal(ids.size, 500);
});

test('JOB_STATUS carries the challenge/blocked states the controller needs', () => {
  assert.equal(JOB_STATUS.PAUSED_CHALLENGE, 'paused_challenge');
  assert.equal(JOB_STATUS.BLOCKED, 'blocked');
});
