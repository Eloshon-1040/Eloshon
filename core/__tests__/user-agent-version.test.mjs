/**
 * User-Agent aligned on the shipped Chromium (no version written in the code): the
 * default UA names the major version of playwright-core's bundled Chromium, falls
 * back to the Electron runtime's Chromium, and fails clearly when neither exists.
 * The request headers stay coherent: the UA alone is aligned — no partial client
 * hints are sent next to it (decision recorded in the project skill, §6).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DEFAULT_USER_AGENT } from '../types.mjs';
import { Fetcher } from '../http-fetcher.mjs';
import { bundledChromiumVersion, runtimeChromiumVersion, userAgentFor, resolveDefaultUserAgent, platformToken, PLATFORM_TOKENS } from '../user-agent.mjs';

const shippedMajor = () => {
  const pkg = createRequire(import.meta.url).resolve('playwright-core/package.json');
  const b = JSON.parse(fs.readFileSync(path.join(path.dirname(pkg), 'browsers.json'), 'utf8'));
  return Number(b.browsers.find((x) => x.name === 'chromium').browserVersion.split('.')[0]);
};

test('the default UA names the bundled Chromium major (read from browsers.json), in Chrome\'s reduced form', () => {
  const major = shippedMajor();
  assert.ok(major > 100, 'a current Chromium');
  assert.ok(DEFAULT_USER_AGENT.includes(`Chrome/${major}.0.0.0 Safari/537.36`), DEFAULT_USER_AGENT);
  assert.ok(DEFAULT_USER_AGENT.startsWith(`Mozilla/5.0 (${platformToken(process.platform)}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/`));
  assert.doesNotMatch(DEFAULT_USER_AGENT, /Headless|Electron|Eloshon|bot/i);
  const r = resolveDefaultUserAgent();
  assert.equal(r.source, 'playwright-core'); assert.equal(r.major, major); assert.equal(r.userAgent, DEFAULT_USER_AGENT);
});

test('no Chrome version is written in the code: the UA follows whatever browsers.json says', () => {
  const fakeResolve = () => 'C:/fake/node_modules/playwright-core/package.json';
  const readFile = () => JSON.stringify({ browsers: [{ name: 'chromium', browserVersion: '161.0.9000.1' }, { name: 'firefox', browserVersion: '150.0' }] });
  const v = bundledChromiumVersion({ readFile, resolve: fakeResolve });
  assert.deepEqual(v, { version: '161.0.9000.1', major: 161, source: 'playwright-core' });
  assert.equal(resolveDefaultUserAgent({ platform: 'win32', readFile, resolve: fakeResolve }).userAgent, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/161.0.0.0 Safari/537.36');
  assert.equal(bundledChromiumVersion({ readFile: () => { throw new Error('ENOENT'); }, resolve: fakeResolve }), null, 'unreadable file → null, never a guess');
  assert.equal(bundledChromiumVersion({ readFile: () => JSON.stringify({ browsers: [{ name: 'chromium' }] }), resolve: fakeResolve }), null, 'no browserVersion → null');
});

test('fallbacks: the Electron runtime Chromium, then a clear error (never an invented version)', () => {
  assert.deepEqual(runtimeChromiumVersion({ chrome: '136.0.7103.149' }), { version: '136.0.7103.149', major: 136, source: 'electron' });
  assert.equal(runtimeChromiumVersion({}), null);
  const none = { readFile: () => { throw new Error('ENOENT'); }, resolve: () => 'x/package.json' };
  const r = resolveDefaultUserAgent({ ...none, versions: { chrome: '136.0.7103.149' }, platform: 'darwin' });
  assert.equal(r.source, 'electron');
  assert.equal(r.userAgent, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36');
  assert.throws(() => resolveDefaultUserAgent({ ...none, versions: {} }), /no Chromium version source/);
  assert.throws(() => userAgentFor({ major: 0 }), /major version/);
});

test('platform token follows the real platform (Windows / macOS / Linux, frozen reduced-UA tokens)', () => {
  assert.equal(userAgentFor({ major: 153, platform: 'win32' }).includes(`(${PLATFORM_TOKENS.win32})`), true);
  assert.equal(userAgentFor({ major: 153, platform: 'darwin' }).includes(`(${PLATFORM_TOKENS.darwin})`), true);
  assert.equal(userAgentFor({ major: 153, platform: 'linux' }).includes(`(${PLATFORM_TOKENS.linux})`), true);
  assert.equal(userAgentFor({ major: 153, platform: 'freebsd' }).includes(`(${PLATFORM_TOKENS.linux})`), true, 'other Unix → the Linux token');
});

test('request headers are coherent: the aligned UA is sent, and no partial client hints ride along', async () => {
  let seen = null;
  const server = http.createServer((req, res) => { seen = req.headers; res.setHeader('Content-Type', 'text/html'); res.end('<html>ok</html>'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await new Fetcher({ minDelayMs: 0, retries: 0 }).get(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(seen['user-agent'], DEFAULT_USER_AGENT);
    // Node's fetch (undici) forces `sec-fetch-mode: cors` on every request and lets
    // nothing override it (measured 09/10/2026, Node 24). A real Chrome navigation says
    // `navigate` and adds sec-fetch-dest/site/user + sec-ch-ua*; a set built around a
    // forced `cors` could never match it, so the fetcher adds no sec-* header at all.
    const sec = Object.keys(seen).filter((k) => k.startsWith('sec-'));
    assert.deepEqual(sec, ['sec-fetch-mode'], 'only the header undici forces; no sec-ch-ua*, no other sec-fetch-*');
    // A caller cannot smuggle a client hint through the extra headers either (reserved).
    seen = null;
    await new Fetcher({ minDelayMs: 0, retries: 0 }).get(`http://127.0.0.1:${server.address().port}/x`, { headers: { 'sec-ch-ua': '"X";v="1"', 'x-custom': 'ok' } });
    assert.equal(seen['sec-ch-ua'], undefined); assert.equal(seen['x-custom'], 'ok');
  } finally { await new Promise((r) => server.close(r)); }
});
