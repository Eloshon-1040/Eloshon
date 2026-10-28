/**
 * Bytes-downloaded reporting (Item 6) — the report must surface the real bandwidth
 * a job pulled (total + per-lane) and the average per accepted product, so the cost
 * per product is measurable BEFORE any per-GB proxy/unlocker is connected. Offline:
 * pure formatting only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtBytes, formatReport } from '../engine.mjs';

test('fmtBytes: B / KB / MB thresholds', () => {
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytes(512), '512 B');
  assert.equal(fmtBytes(1024), '1.0 KB');
  assert.equal(fmtBytes(1536), '1.5 KB');
  assert.equal(fmtBytes(1024 * 1024), '1.00 MB');
  assert.equal(fmtBytes(3_889_192), '3.71 MB');
  assert.equal(fmtBytes(null), '0 B'); // never throws on a missing value
});

test('formatReport: renders the bytes-downloaded + per-product lines when measured', () => {
  const rep = {
    store: 's', status: 'done', discovered: 12, fetched: 1, detected: 12, normalized: 12,
    accepted: 12, toVerify: 0, excluded: 0, incomplete: 0, notAProductPage: 0, duplicates: 0,
    networkErrors: 0, parseErrors: 0, browserRequired: 0, browserUsed: 1, durationMs: 1000,
    bytesDownloaded: { total: 3_889_192, http: 12_000, browser: 3_877_192 },
    bytesPerAcceptedProduct: 324_099,
  };
  const txt = formatReport(rep);
  assert.match(txt, /bytes downloaded:\s+3\.71 MB \(http 11\.7 KB, browser 3\.70 MB\)/);
  assert.match(txt, /→ per product:\s+316\.5 KB\/accepted/);
});

test('formatReport: omits the bytes lines when nothing was measured (back-compat)', () => {
  const rep = { store: 's', status: 'done', discovered: 0, fetched: 0, detected: 0, normalized: 0, accepted: 0, toVerify: 0, excluded: 0, incomplete: 0, notAProductPage: 0, duplicates: 0, networkErrors: 0, parseErrors: 0, browserRequired: 0, durationMs: 0 };
  const txt = formatReport(rep);
  assert.ok(!/bytes downloaded/.test(txt), 'no bytes line without measurement');
});
