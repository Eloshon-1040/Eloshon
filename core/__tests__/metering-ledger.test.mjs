/**
 * Usage ledger (Point 1): append-only JSON Lines, one line per event, never reset
 * on a month change, rotation keeps every file, concurrent writers never corrupt
 * a line, the reader streams across rotated files, secrets never land on disk.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createLedger, ledgerFiles, sanitizeUrl, redactSecrets, normalizeEvent, FIELDS, SCHEMA_VERSION, CURRENT_FILE } from '../metering/ledger.mjs';
import { queryLedger, summarizeLedger, jobEvents, capUsageFromLedger, toCsv, exportRows, iterateLedger, periodStarts } from '../metering/reader.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-ledger-'));
const lines = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
const allText = (dir) => ledgerFiles(dir).map((f) => fs.readFileSync(f, 'utf8')).join('');

test('ledger: one complete, versioned line per event, every field present', () => {
  const dir = tmp();
  const l = createLedger({ dir, appVersion: '9.9.9' });
  l.record({ jobId: 'j1', url: 'https://www.shop.test/c?x=1', provider: 'firecrawl', route: 'escalation', outcome: 'success', bytes: 1200, durationMs: 55, products: 3 });
  l.record({ jobId: 'j1', provider: 'local', route: 'crawl', outcome: 'failed', reason: 'ACCESS_DENIED' });
  const ls = lines(path.join(dir, CURRENT_FILE));
  assert.equal(ls.length, 2);
  const a = JSON.parse(ls[0]);
  assert.equal(a.v, SCHEMA_VERSION);
  assert.deepEqual(Object.keys(a), FIELDS, 'stable field order, all keys present');
  assert.equal(a.domain, 'shop.test');
  assert.equal(a.url, 'https://www.shop.test/c', 'query string dropped');
  assert.equal(a.channel, 'direct');
  assert.equal(a.appVersion, '9.9.9');
  assert.equal(JSON.parse(ls[1]).channel, 'local');
});

test('ledger: URL sanitising drops query, fragment and credentials', () => {
  assert.equal(sanitizeUrl('https://user:pw@shop.test/p/1?token=abc#x'), 'https://shop.test/p/1');
  assert.equal(sanitizeUrl('wss://brd-customer-x-zone-y:pw@brd.superproxy.io:9222'), null, 'non-http schemes are not stored');
  assert.equal(sanitizeUrl('not a url'), null);
});

test('ledger: secrets never reach the file — known values, bearer tokens, auth strings, query tokens', () => {
  const dir = tmp();
  const KEY = 'fc-0123456789abcdef0123456789abcdef';
  const PW = 'Zone$ecretPW';
  const l = createLedger({ dir, secrets: () => [KEY, PW] });
  l.record({ provider: 'firecrawl', outcome: 'failed', reason: `HTTP 401 Authorization: Bearer ${KEY} invalid` });
  l.record({ provider: 'scrapingbrowser', outcome: 'failed', reason: `connect wss://brd-customer-hl_1-zone-mcp_browser:${PW}@brd.superproxy.io:9222/ refused` });
  l.record({ provider: 'webunlocker', outcome: 'failed', reason: 'fetch https://api.test/x?api_key=SUPERSECRETVALUE123 failed', url: `https://shop.test/a?key=${KEY}` });
  l.record({ provider: 'anthropic', outcome: 'failed', reason: 'x-api-key: sk-ant-api03-ABCDEFGHIJKLMNOP rejected' });
  const txt = allText(dir);
  for (const s of [KEY, PW, 'SUPERSECRETVALUE123', 'sk-ant-api03-ABCDEFGHIJKLMNOP', 'hl_1']) assert.equal(txt.includes(s), false, `${s} leaked`);
  assert.match(txt, /\*\*\*/);
});

test('ledger: redactSecrets keeps ordinary words', () => {
  assert.equal(redactSecrets('http_403 blocked by WAF'), 'http_403 blocked by WAF');
});

test('ledger: never reset on a month change — a new month just appends', () => {
  const dir = tmp();
  let now = Date.UTC(2026, 8, 30, 23, 59);
  const l = createLedger({ dir, now: () => now });
  l.record({ provider: 'firecrawl', outcome: 'success' });
  now = Date.UTC(2026, 9, 1, 0, 1);
  l.record({ provider: 'firecrawl', outcome: 'success' });
  const ls = lines(path.join(dir, CURRENT_FILE)).map((x) => JSON.parse(x));
  assert.equal(ls.length, 2);
  assert.equal(ls[0].ts.slice(0, 7), '2026-09');
  assert.equal(ls[1].ts.slice(0, 7), '2026-10');
});

test('ledger: rotation renames to ledger-YYYY-MM-NNN.jsonl, keeps ALL files, reader aggregates across them', async () => {
  const dir = tmp();
  const l = createLedger({ dir, maxBytes: 2000, now: () => Date.UTC(2026, 9, 6, 12) });
  for (let i = 0; i < 40; i++) l.record({ jobId: `j${i % 4}`, provider: i % 2 ? 'firecrawl' : 'local', outcome: 'success', bytes: 10 });
  const files = ledgerFiles(dir);
  assert.ok(files.length >= 3, `rotated into several files (${files.length})`);
  assert.ok(files.slice(0, -1).every((f) => /ledger-2026-10-\d{3}\.jsonl$/.test(f)));
  assert.ok(files[files.length - 1].endsWith(CURRENT_FILE));
  let n = 0; for await (const _ of iterateLedger(dir)) n++; // eslint-disable-line no-unused-vars
  assert.equal(n, 40, 'nothing lost across rotation');
  const page = await queryLedger(dir, {}, { offset: 0, limit: 5 });
  assert.equal(page.total, 40);
  assert.equal(page.rows.length, 5);
  assert.ok(page.rows[0].ts >= page.rows[4].ts, 'newest first');
  const j0 = await jobEvents(dir, 'j0');
  assert.equal(j0.length, 10);
});

test('ledger: concurrent async writers (same process) produce only valid lines', async () => {
  const dir = tmp();
  const l = createLedger({ dir, maxBytes: 50000 });
  await Promise.all(Array.from({ length: 300 }, (_, i) => Promise.resolve().then(() => l.record({ jobId: `w${i}`, provider: 'local', reason: 'x'.repeat(i % 50) }))));
  let n = 0; const stats = { badLines: 0 };
  for await (const o of iterateLedger(dir, stats)) { assert.ok(o.jobId.startsWith('w')); n++; }
  assert.equal(n, 300);
  assert.equal(stats.badLines, 0);
});

test('ledger: concurrent writers in separate threads never corrupt a line', async () => {
  const dir = tmp();
  const mod = new URL('../metering/ledger.mjs', import.meta.url).href;
  const code = `
    const { workerData } = require('node:worker_threads');
    import(workerData.mod).then(({ createLedger }) => {
      const l = createLedger({ dir: workerData.dir, maxBytes: 1e9 });
      for (let i = 0; i < 150; i++) l.record({ jobId: 't' + workerData.n + '-' + i, provider: 'local', reason: 'r'.repeat(80) });
    });`;
  await Promise.all([0, 1, 2, 3].map((n) => new Promise((res, rej) => {
    const w = new Worker(code, { eval: true, workerData: { dir, mod, n } });
    w.on('exit', res); w.on('error', rej);
  })));
  const stats = { badLines: 0 }; let n = 0;
  for await (const _ of iterateLedger(dir, stats)) n++; // eslint-disable-line no-unused-vars
  assert.equal(stats.badLines, 0, 'every line parses');
  assert.equal(n, 600);
});

test('ledger: a write failure never throws, is reported ONCE and kept in status()', () => {
  const dir = tmp();
  const blocker = path.join(dir, 'blocked');
  fs.writeFileSync(blocker, 'a file where a directory is expected');
  const errors = [];
  const l = createLedger({ dir: path.join(blocker, 'sub'), onError: (e) => errors.push(e) });
  assert.equal(l.record({ provider: 'local' }), null);
  assert.equal(l.record({ provider: 'local' }), null);
  assert.equal(errors.length, 1, 'reported once');
  assert.equal(l.status().errorCount, 2);
  assert.ok(l.status().lastError.code);
});

test('reader: malformed lines are skipped and counted, the rest is read', async () => {
  const dir = tmp();
  const l = createLedger({ dir });
  l.record({ provider: 'local' });
  fs.appendFileSync(path.join(dir, CURRENT_FILE), '{"broken":\n');
  l.record({ provider: 'firecrawl' });
  const page = await queryLedger(dir, {});
  assert.equal(page.total, 2);
  assert.equal(page.badLines, 1);
});

test('reader: filters — provider, outcome, domain (with subdomains), job, test mode, dates', async () => {
  const dir = tmp();
  let now = Date.UTC(2026, 9, 1, 10);
  const l = createLedger({ dir, now: () => now });
  l.record({ jobId: 'a', url: 'https://www.shop.test/x', provider: 'firecrawl', outcome: 'success', testMode: true });
  now += 3600e3;
  l.record({ jobId: 'b', url: 'https://eu.shop.test/x', provider: 'webunlocker', outcome: 'blocked_no_optin', attempted: false });
  now += 3600e3;
  l.record({ jobId: 'c', url: 'https://other.test/x', provider: 'local', outcome: 'failed' });
  const q = async (f) => (await queryLedger(dir, f)).rows.map((r) => r.jobId).sort().join(',');
  assert.equal(await q({ provider: 'firecrawl' }), 'a');
  assert.equal(await q({ provider: ['firecrawl', 'webunlocker'] }), 'a,b');
  assert.equal(await q({ outcome: 'blocked_no_optin' }), 'b');
  assert.equal(await q({ domain: 'shop.test' }), 'a,b', 'host + subdomains');
  assert.equal(await q({ jobId: 'c' }), 'c');
  assert.equal(await q({ testMode: true }), 'a');
  assert.equal(await q({ testMode: false }), 'b,c');
  assert.equal(await q({ from: Date.UTC(2026, 9, 1, 10, 30) }), 'b,c');
  assert.equal(await q({ to: Date.UTC(2026, 9, 1, 10, 30) }), 'a');
  assert.equal(await q({ paidOnly: true }), 'a,b');
});

test('reader: summary — today / 7 days / month, last use, last error', async () => {
  const dir = tmp();
  const nowMs = new Date(2026, 9, 6, 15).getTime(); // local time
  const l = createLedger({ dir, now: () => nowMs });
  const at = (d, h) => new Date(2026, 9, d, h).toISOString();
  l.record({ ts: at(6, 9), provider: 'firecrawl', outcome: 'success', credits: 2, bytes: 100 });
  l.record({ ts: at(6, 10), provider: 'firecrawl', outcome: 'failed', reason: 'http_500' });
  l.record({ ts: at(2, 10), provider: 'scrapingbrowser', outcome: 'success', costUsd: 0.01, bytes: 1000 });
  l.record({ ts: at(1, 10), provider: 'cascade', outcome: 'quota_exhausted', attempted: true });
  l.record({ ts: new Date(2026, 8, 20, 10).toISOString(), provider: 'webunlocker', outcome: 'success' });
  const s = await summarizeLedger(dir, { now: nowMs });
  assert.equal(s.periods.today.byProvider.firecrawl.calls, 2);
  assert.equal(s.periods.today.byProvider.firecrawl.failed, 1);
  assert.equal(s.periods.today.byProvider.firecrawl.credits, 2);
  assert.equal(s.periods.last7d.total.events, 4, 'the last 7 days of Oct 6 start on Oct 0 = Sep 30 → Oct 1 is included');
  assert.equal(s.periods.month.total.events, 4);
  assert.equal(s.periods.month.byProvider.webunlocker, undefined, 'September stays out of October');
  assert.equal(s.lastUse.webunlocker.slice(0, 7), new Date(2026, 8, 20, 10).toISOString().slice(0, 7));
  assert.equal(s.lastError.firecrawl.reason, 'http_500');
  assert.equal(s.lastError.cascade.outcome, 'quota_exhausted');
  assert.equal(s.events, 5);
  const p = periodStarts(nowMs);
  assert.ok(p.today > p.last7d && p.last7d >= p.month - 31 * 864e5);
  assert.equal(new Date(p.month).getDate(), 1);
  assert.equal(new Date(p.today).getHours(), 0);
});

test('reader: cap usage counts only DIRECT attempted calls of the current UTC month', async () => {
  const dir = tmp();
  const nowMs = Date.UTC(2026, 9, 6, 12);
  const l = createLedger({ dir, now: () => nowMs });
  l.record({ provider: 'firecrawl', outcome: 'success' });
  l.record({ provider: 'firecrawl', outcome: 'failed' });
  l.record({ provider: 'firecrawl', outcome: 'blocked_no_optin', attempted: false });
  l.record({ provider: 'firecrawl', channel: 'server', outcome: 'success' });
  l.record({ provider: 'scrapingbrowser', outcome: 'success', bytes: 2048, costUsd: 0.5 });
  l.record({ ts: '2026-09-15T00:00:00.000Z', provider: 'firecrawl', outcome: 'success' });
  const u = await capUsageFromLedger(dir, { now: nowMs });
  assert.equal(u.firecrawl.calls, 2);
  assert.equal(u['brightData.scrapingBrowser'].bytes, 2048);
  assert.equal(u['brightData.scrapingBrowser'].usd, 0.5);
});

test('reader: CSV export — header = v1 fields, values escaped, no secret by construction', async () => {
  const dir = tmp();
  const l = createLedger({ dir, secrets: () => ['TOPSECRET123'] });
  l.record({ jobId: 'j', provider: 'firecrawl', reason: 'a, "quoted" TOPSECRET123 reason' });
  const rows = await exportRows(dir, {});
  const csv = toCsv(rows);
  const [head, line] = csv.trim().split('\r\n');
  assert.equal(head, FIELDS.join(','));
  assert.match(line, /"a, ""quoted"" \*\*\* reason"/);
  assert.equal(csv.includes('TOPSECRET123'), false);
});

test('reader: large ledger streams page by page without reading everything into one array', async () => {
  const dir = tmp();
  const l = createLedger({ dir, maxBytes: 200000 });
  for (let i = 0; i < 6000; i++) l.record({ jobId: `j${i}`, provider: i % 3 ? 'local' : 'firecrawl', outcome: 'success' });
  assert.ok(ledgerFiles(dir).length >= 5);
  const page = await queryLedger(dir, { provider: 'firecrawl' }, { offset: 100, limit: 20 });
  assert.equal(page.total, 2000);
  assert.equal(page.rows.length, 20);
  assert.equal(page.rows[0].jobId, 'j5697', 'newest-first offset honoured across files');
});

test('normalizeEvent: unknown provider kept, numbers coerced, testMode boolean', () => {
  const o = normalizeEvent({ provider: 'futureRoute', bytes: '12', credits: 'x', testMode: 1 });
  assert.equal(o.provider, 'futureRoute');
  assert.equal(o.bytes, 12);
  assert.equal(o.credits, null);
  assert.equal(o.testMode, true);
});
