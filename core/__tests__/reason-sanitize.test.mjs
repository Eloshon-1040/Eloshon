/**
 * Display privacy (point 3): user-facing reason strings never expose provider
 * names, technical modes, attempt counts or raw HTTP codes. The full technical
 * detail stays in report.json / job.error (asserted elsewhere), not here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeReason } from '../../app/controller.mjs';

test('strips raw HTTP codes', () => {
  assert.doesNotMatch(sanitizeReason('ACCESS_DENIED: HTTP 403 Forbidden'), /403|HTTP/);
  assert.doesNotMatch(sanitizeReason('blocked: 405 Method Not Allowed'), /405/);
});

test('strips provider names and technical modes', () => {
  const s = sanitizeReason('Débloqué via firecrawl (asp) après 4 tentatives, brightdata datacenter');
  assert.doesNotMatch(s, /firecrawl|brightdata|scrapfly/i);
  assert.doesNotMatch(s, /\(asp\)|datacenter/i);
});

test('a plain semantic reason is preserved', () => {
  assert.match(sanitizeReason('structured product data seen but no product URLs found'), /no product URLs/);
});

test('empty in, empty out', () => {
  assert.equal(sanitizeReason(''), '');
  assert.equal(sanitizeReason(null), '');
});
