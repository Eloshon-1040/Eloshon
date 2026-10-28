/**
 * Extra request headers (the ones a listing page sends to its own API, learned in
 * the local browser): the Fetcher sends them, an extra replaces a default of the
 * same name, and identity / session / transport headers are NEVER taken from the
 * caller — no cookie, no credential, the Fetcher keeps its own user agent.
 * Offline: global fetch is stubbed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fetcher, extraHeaders } from '../http-fetcher.mjs';

test('extraHeaders: reserved names dropped, values flattened and bounded', () => {
  const h = extraHeaders({
    'x-caller-id': 'web-1', accept: 'application/json', Cookie: 's=1', authorization: 'Bearer t', 'proxy-authorization': 'x',
    'user-agent': 'Bot', host: 'evil', 'sec-ch-ua': '"x"', ':authority': 'a', 'bad name': 'x', 'x-obj': { a: 1 }, 'x-long': 'y'.repeat(5000), 'x-crlf': 'a\r\nInjected: 1',
  });
  assert.deepEqual(Object.keys(h).sort(), ['accept', 'x-caller-id', 'x-crlf', 'x-long']);
  assert.equal(h['x-long'].length, 1024);
  assert.equal(h['x-crlf'], 'a  Injected: 1');
  assert.deepEqual(extraHeaders(null), {});
});

test('Fetcher.get sends the extras, replaces a same-name default (any case), keeps its own UA and cookie', async () => {
  const orig = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => { seen = init.headers; return new Response('{"ok":1}', { status: 200, headers: { 'content-type': 'application/json' } }); };
  try {
    const f = new Fetcher({ minDelayMs: 0, retries: 0, userAgent: 'EloshonTest/1' });
    await f.get('https://api.shop.test/x', { accept: 'application/json, */*', headers: { 'x-caller-id': 'web-1', accept: 'application/json', 'User-Agent': 'Other', cookie: 'stolen=1' } });
    const lower = Object.fromEntries(Object.entries(seen).map(([k, v]) => [k.toLowerCase(), v]));
    assert.equal(lower['x-caller-id'], 'web-1');
    assert.equal(lower.accept, 'application/json', 'the extra replaces the default');
    assert.equal(Object.keys(seen).filter((k) => k.toLowerCase() === 'accept').length, 1, 'no duplicate header');
    assert.equal(lower['user-agent'], 'EloshonTest/1');
    assert.equal(lower.cookie, undefined);
  } finally { globalThis.fetch = orig; }
});
