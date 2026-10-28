/**
 * Increment 5 — F3.2 run-scoped, per-origin HTTP cookie jar. A session/consent
 * cookie set on one page is resent on the next SAME-SITE request; never across
 * domains; never auth credentials; honours path/secure/expiry. Includes a
 * loopback integration proving the Fetcher wires it. Offline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { CookieJar } from '../cookie-jar.mjs';
import { Fetcher } from '../http-fetcher.mjs';

test('jar: stores and resends a same-host cookie on later requests', () => {
  const j = new CookieJar();
  j.setFromResponse('https://shop.com/a', ['sid=abc; Path=/']);
  assert.equal(j.headerFor('https://shop.com/b'), 'sid=abc');
  assert.equal(j.headerFor('https://shop.com/deep/page'), 'sid=abc');
});

test('jar: never leaks across domains', () => {
  const j = new CookieJar();
  j.setFromResponse('https://shop.com/', ['sid=abc; Path=/']);
  assert.equal(j.headerFor('https://other.com/'), '');
  // A Set-Cookie for a foreign domain is narrowed to the response host, not honoured elsewhere.
  j.setFromResponse('https://shop.com/', ['x=1; Domain=evil.com']);
  assert.equal(j.headerFor('https://evil.com/'), '');
});

test('jar: never stores auth-credential cookies', () => {
  const j = new CookieJar();
  j.setFromResponse('https://shop.com/', ['auth_token=secret; Path=/', 'jwt=xyz', 'access_token=zzz', 'sid=ok']);
  assert.equal(j.headerFor('https://shop.com/'), 'sid=ok'); // only the non-auth cookie
});

test('jar: honours path, secure and expiry', () => {
  const j = new CookieJar();
  j.setFromResponse('https://shop.com/cat', ['p=1; Path=/cat', 's=1; Secure', 'e=1; Max-Age=0']);
  assert.match(j.headerFor('https://shop.com/cat/x'), /p=1/);
  assert.doesNotMatch(j.headerFor('https://shop.com/other'), /p=1/);   // path scoped
  assert.doesNotMatch(j.headerFor('http://shop.com/cat'), /s=1/);      // secure → https only
  assert.match(j.headerFor('https://shop.com/cat'), /s=1/);
  assert.doesNotMatch(j.headerFor('https://shop.com/cat'), /e=1/);     // already expired
});

test('jar: setFromBrowser imports session cookies (handoff), with auth denylist + leading-dot domain', () => {
  const j = new CookieJar();
  j.setFromBrowser([
    { name: 'sess', value: 'v1', domain: '.shop.com', path: '/', secure: true, expires: -1 },
    { name: 'auth_token', value: 'secret', domain: 'shop.com', path: '/', secure: true, expires: -1 },
    { name: 'gone', value: 'x', domain: 'shop.com', path: '/', expires: 1 }, // already expired (epoch 1s)
  ]);
  assert.equal(j.headerFor('https://shop.com/p/1'), 'sess=v1'); // sess kept; auth dropped; expired dropped
  assert.equal(j.headerFor('http://shop.com/p/1'), '');         // secure → https only
});

test('fetcher: resends a cookie across requests (loopback), and cookies:false disables it', async () => {
  let got1 = null, got2 = null, gotOff = null;
  const server = http.createServer((req, res) => {
    if (req.url === '/set') { res.setHeader('Set-Cookie', 'sess=xyz; Path=/'); res.end('<html>set</html>'); return; }
    if (req.url === '/off') { gotOff = req.headers.cookie || ''; res.end('<html>off</html>'); return; }
    if (got1 === null) got1 = req.headers.cookie || ''; else got2 = req.headers.cookie || '';
    res.end('<html>echo</html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const f = new Fetcher({ minDelayMs: 0, retries: 0 });
    await f.get(`${base}/set`);       // receives Set-Cookie
    await f.get(`${base}/echo`);      // got1 should carry it
    assert.match(got1, /sess=xyz/);

    const off = new Fetcher({ minDelayMs: 0, retries: 0, cookies: false });
    await off.get(`${base}/set`);
    await off.get(`${base}/off`);
    assert.equal(gotOff, '');         // disabled → no cookie carried
  } finally { await new Promise((r) => server.close(r)); }
});
