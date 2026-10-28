/**
 * Increment 3 — realistic default User-Agent. A self-identifying bot UA is
 * trivially blocked and makes the real Chromium look like a bot; a standard
 * desktop-browser UA is the most basic legitimate compatibility setting. Still
 * fully overridable per source. (No fingerprint/client-hint spoofing is added.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Fetcher } from '../http-fetcher.mjs';
import { DEFAULT_USER_AGENT } from '../types.mjs';

test('default UA is a realistic desktop browser, not a bot string', () => {
  assert.match(DEFAULT_USER_AGENT, /Mozilla\/5\.0/);
  assert.match(DEFAULT_USER_AGENT, /Chrome\/\d+/);
  assert.doesNotMatch(DEFAULT_USER_AGENT, /Eloshon|bot|Headless/i);
  assert.equal(new Fetcher().userAgent, DEFAULT_USER_AGENT);
  assert.equal(new Fetcher({ userAgent: 'Custom/9' }).userAgent, 'Custom/9'); // still configurable
});

test('the UA is actually sent on the request', async () => {
  let seenDefault = null, seenCustom = null;
  const server = http.createServer((req, res) => {
    (req.url === '/c' ? (seenCustom = req.headers['user-agent']) : (seenDefault = req.headers['user-agent']));
    res.setHeader('Content-Type', 'text/html'); res.end('<html>ok</html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    await new Fetcher({ minDelayMs: 0, retries: 0 }).get(`http://127.0.0.1:${port}/`);
    await new Fetcher({ minDelayMs: 0, retries: 0, userAgent: 'Custom/9' }).get(`http://127.0.0.1:${port}/c`);
    assert.equal(seenDefault, DEFAULT_USER_AGENT);
    assert.equal(seenCustom, 'Custom/9');
  } finally { await new Promise((r) => server.close(r)); }
});
