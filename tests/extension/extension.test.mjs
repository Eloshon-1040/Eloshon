import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originsForDomain, domainFromOrigin, domainsFromOrigins, grantedDomains } from '../../extension/background/permissions.mjs';
import { createRouter } from '../../extension/background/native-link.mjs';
import { bumpParam } from '../../extension/background/tab-driver.mjs';
import { defaultProgram, mapState } from '../../extension/background/program.mjs';
import * as P from '../../extension/vendor/shared/protocol/messages.mjs';
import { STATE } from '../../extension/vendor/shared/job/machine.mjs';

test('originsForDomain: apex + subdomains for a valid domain; empty for junk', () => {
  assert.deepEqual(originsForDomain('colruyt.be'), ['*://colruyt.be/*', '*://*.colruyt.be/*']);
  assert.deepEqual(originsForDomain('www.leroymerlin.be/x'), ['*://leroymerlin.be/*', '*://*.leroymerlin.be/*']);
  assert.deepEqual(originsForDomain('not a domain'), []);
  assert.deepEqual(originsForDomain(''), []);
});

test('domainFromOrigin / domainsFromOrigins: the inverse of originsForDomain (granted origins → domains)', () => {
  assert.equal(domainFromOrigin('*://colruyt.be/*'), 'colruyt.be');
  assert.equal(domainFromOrigin('*://*.colruyt.be/*'), 'colruyt.be');
  assert.equal(domainFromOrigin('https://levi.test/fr/*'), 'levi.test');
  assert.equal(domainFromOrigin('<all_urls>'), null);
  // A domain granted via the popup exposes exactly one domain in the app.
  assert.deepEqual(domainsFromOrigins(originsForDomain('colruyt.be')), ['colruyt.be']);
  assert.deepEqual(domainsFromOrigins(['*://a.test/*', '*://*.a.test/*', '*://b.test/*']), ['a.test', 'b.test']);
  assert.deepEqual(domainsFromOrigins([]), []);
});

test('grantedDomains: reads the live chrome.permissions grant → distinct domains', async () => {
  const chromeApi = { permissions: { getAll: (cb) => cb({ permissions: ['scripting'], origins: ['*://levi.test/*', '*://*.levi.test/*', '*://colruyt.be/*'] }) } };
  assert.deepEqual((await grantedDomains(chromeApi)).sort(), ['colruyt.be', 'levi.test']);
  const broken = { permissions: { getAll: () => { throw new Error('x'); } } };
  assert.deepEqual(await grantedDomains(broken), [], 'never throws');
});

test('router: dispatches a valid job to its handler', () => {
  const seen = [];
  const sent = [];
  const router = createRouter({ [P.MSG.JOB]: (payload) => seen.push(payload) }, { send: (m) => sent.push(m) });
  const ok = router.handle(P.job('j1', 'colruyt.be', { mode: 'internal_api' }));
  assert.equal(ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].job_id, 'j1');
  assert.equal(sent.length, 0);
});

test('router: malformed message is rejected with an error envelope', () => {
  const sent = [];
  const router = createRouter({}, { send: (m) => sent.push(m) });
  const ok = router.handle({ type: 'job', payload: {} }); // no protocol_version/id
  assert.equal(ok, false);
  assert.equal(sent[0].type, 'error');
  assert.equal(sent[0].payload.code, 'E_BAD_MESSAGE');
});

test('router: version mismatch produces a protocol-version error', () => {
  const sent = [];
  const router = createRouter({ [P.MSG.HELLO]: () => {} }, { send: (m) => sent.push(m) });
  const msg = { ...P.hello('app'), protocol_version: P.PROTOCOL_VERSION + 1 };
  router.handle(msg);
  assert.equal(sent[0].payload.code, 'E_PROTOCOL_VERSION');
});

test('router: unknown type is a no-op (no throw, no dispatch)', () => {
  const sent = [];
  const router = createRouter({}, { send: (m) => sent.push(m) });
  const ok = router.handle(P.progress('j1')); // valid but no handler registered
  assert.equal(ok, false);
});

test('bumpParam increments an existing page number or sets it to 2', () => {
  assert.equal(bumpParam('https://x/list?page=3', 'page'), 'https://x/list?page=4');
  assert.equal(bumpParam('https://x/list', 'page'), 'https://x/list?page=2');
  assert.equal(bumpParam('not a url', 'page'), null);
});

test('defaultProgram maps mode to a single extract action', () => {
  assert.equal(defaultProgram({ mode: 'internal_api', field_map: {} }).actions[0].using, 'internal_api');
  assert.equal(defaultProgram({ mode: 'dom', item_selector: '.c' }).actions[0].using, 'dom');
  assert.equal(defaultProgram({ mode: 'embedded_state' }).actions[0].using, 'embedded_state');
  assert.equal(defaultProgram({ mode: 'mystery' }).actions[0].using, 'auto');
});

test('mapState maps protocol status to persisted state', () => {
  assert.equal(mapState(P.JOB_STATUS.DONE), STATE.DONE);
  assert.equal(mapState(P.JOB_STATUS.BLOCKED), STATE.BLOCKED);
  assert.equal(mapState(P.JOB_STATUS.STOPPED), STATE.STOPPED);
  assert.equal(mapState(P.JOB_STATUS.ERROR), STATE.ERROR);
});
