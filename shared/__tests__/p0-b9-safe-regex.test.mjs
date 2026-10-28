/**
 * P0 / B9 — a recipe's patterns (they may come from the recipe server) are checked
 * and bounded before they run. Before: `new RegExp(pattern)` straight from the
 * recipe, run over a whole page — one catastrophic pattern froze the job (and the
 * main process). Now: length, flags, back-references, nested / overlapping
 * unbounded repetition are refused; the text a pattern reads is capped.
 * Hand-built inputs, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regexRisk, safeRegExp, boundedMatch, MAX_INPUT } from '../safe-regex.mjs';
import { resolveHeaders } from '../internal-api.mjs';

test('patterns of the shipped recipes are accepted', () => {
  for (const p of ['X-CG-APIKey:\\s*([^"&,<>\\]\\s]+)', '[?&]categories=(\\d+)', 'alle-categorieen/(?:\\d+/)*(\\d+)/jcr:content', '/a(\\d+)(?:[/?#]|$)', '/s(\\d+)(?:[/?#]|$)', '/([a-z]{2})-BE/']) {
    assert.equal(regexRisk(p), null, p);
  }
});

test('catastrophic shapes are refused with a reason', () => {
  const bad = {
    '(a+)+$': /nested/, '(\\w+\\s?)*$': /nested/, '(.*a){20}': /nested/, '(x|x)*y': /alternation/,
    '\\w*\\w*\\w*!': /overlapping/, '(a)\\1': /back-reference/, [`${'a'.repeat(500)}`]: /long/,
  };
  for (const [p, why] of Object.entries(bad)) { const r = regexRisk(p); assert.ok(r && why.test(r), `${p} → ${r}`); }
  assert.match(safeRegExp('a', 'gy').error, /flags/);
  assert.match(safeRegExp('(', '').error, /invalid/);
});

test('boundedMatch reads at most MAX_INPUT characters', () => {
  const big = 'x'.repeat(MAX_INPUT) + 'KEY=abc';
  assert.equal(boundedMatch(big, /KEY=(\w+)/), null, 'past the cap is not read');
  assert.equal(boundedMatch('…KEY=abc', /KEY=(\w+)/)[1], 'abc');
});

test('a recipe with a catastrophic header pattern is refused before running, quickly', { timeout: 5000 }, async () => {
  const recipe = { endpoint_tpl: 'https://api.shop.test/x', headers: { 'X-Key': { from: 'https://www.shop.test/', pattern: '(a+)+$' } } };
  const page = 'a'.repeat(40) + '!';
  const httpGet = async () => ({ status: 200, body: page });
  const t0 = Date.now();
  const r = await resolveHeaders(recipe, httpGet);
  assert.ok(r.error && /unsafe pattern/.test(r.error), JSON.stringify(r));
  assert.ok(Date.now() - t0 < 1000);
});
