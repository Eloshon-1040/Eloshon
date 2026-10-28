/**
 * Stock + reviews a product page loads with its OWN requests: learned on one page
 * (which answer gives this product's sizes a stock state, which one its rating),
 * turned into templates with the product's own values, then asked for every row.
 * Offline: captures and answers are fakes shaped like the measured ones.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowTokens, templateFromUrl, fillTemplate, learnSideRequests, applySideRequests, completeSideData } from '../side-requests.mjs';

const P = 'https://www.shop.test/de/t/city-hoodie-kids-NCzpJpxR';
const row = (code, gtins) => ({ sourceUrl: `${P.replace('NCzpJpxR', `G${code.slice(0, 3)}x7`)}/${code}`, variants: gtins.map((g) => ({ code: g, gtin: g, type: 'taille' })) });
const sample = row('IO0763-011', ['00198730966311', '00198730984315', '00198730991993']);
const stockUrl = (code) => `https://api.shop.test/deliver/available_gtins/v3?filter=styleColor(${code})&filter=merchGroup(EU)`;
const reviewsUrl = (model) => `https://cdn.reviews.test/v5/sitedata/SITEKEY/${model}/d/review/summary/de_DE?`;
const stockAnswer = (gtins, oos = []) => ({ objects: gtins.map((g) => ({ gtin: g, level: oos.includes(g) ? 'OOS' : 'LOW', available: !oos.includes(g) })) });
const captures = [
  { url: 'https://www.shop.test/assets/i18n/de-DE.json', json: { rating: 'Bewertung', reviews: 'Bewertungen' }, headers: {}, bytes: 5000 },
  { url: 'https://api.shop.test/recs?count=3', json: { products: [{ rating: 4.9, reviewCount: 300 }] }, headers: {}, bytes: 200 },
  { url: stockUrl('IO0763-011'), json: stockAnswer(sample.variants.map((v) => v.gtin)), headers: { 'x-caller-id': 'web' }, bytes: 900 },
  { url: reviewsUrl('IO0763'), json: { catItem: { sku: 'IO0763' }, rating: 4.2, directReviewsCount: 12 }, headers: {}, bytes: 700 },
];

test('rowTokens / templates: the product\'s own values become placeholders and give the URL back', () => {
  const names = rowTokens(sample).map((t) => t.name);
  assert.ok(names.includes('seg.3') && names.includes('seg.3.0'));
  const tpl = templateFromUrl(stockUrl('IO0763-011'), sample);
  assert.equal(tpl, 'https://api.shop.test/deliver/available_gtins/v3?filter=styleColor({seg.3})&filter=merchGroup(EU)');
  assert.equal(fillTemplate(tpl, row('HQ6918-320', [])), stockUrl('HQ6918-320'));
  assert.equal(templateFromUrl('https://www.shop.test/assets/i18n/de-DE.json', sample), null, 'no product value → not a per-product request');
});

test('learnSideRequests keeps the stock answer for THIS product\'s sizes and the reviews answer templated on its model', () => {
  const l = learnSideRequests(captures, sample);
  assert.equal(l.availability.template, 'https://api.shop.test/deliver/available_gtins/v3?filter=styleColor({seg.3})&filter=merchGroup(EU)');
  assert.deepEqual(l.availability.headers, { 'x-caller-id': 'web' });
  assert.equal(l.rating.template, 'https://cdn.reviews.test/v5/sitedata/SITEKEY/{seg.3.0}/d/review/summary/de_DE?');
  assert.deepEqual(learnSideRequests(captures.slice(0, 2), sample), { availability: null, rating: null }, 'recommendations of OTHER products are not this product\'s reviews (no product value in the URL)');
});

test('applySideRequests: each size gets its state + level, the row its state and reviews; one request per distinct URL; headers sent', async () => {
  const learned = learnSideRequests(captures, sample);
  const r1 = row('HQ6918-320', ['00190000000011', '00190000000028']);
  const r2 = row('HQ6918-001', ['00190000000035']);
  const r3 = row('HQ6918-320', ['00190000000011', '00190000000028']); // same colourway twice
  const calls = [];
  const answers = {
    [stockUrl('HQ6918-320')]: stockAnswer(['00190000000011', '00190000000028'], ['00190000000028']),
    [stockUrl('HQ6918-001')]: stockAnswer(['00190000000035'], ['00190000000035']),
    [reviewsUrl('HQ6918')]: { rating: 3.8, directReviewsCount: 5 },
  };
  const fetchJson = async (u, h) => { calls.push({ u, h }); return answers[u] ? { ok: true, json: answers[u] } : { ok: false, status: 404 }; };
  const rep = await applySideRequests([r1, r2, r3], learned, { fetchJson });
  assert.equal(r1.variants[0].availability, 'InStock'); assert.equal(r1.variants[0].stock_level, 'low');
  assert.equal(r1.variants[1].availability, 'OutOfStock'); assert.equal(r1.variants[1].stock_level, 'none');
  assert.equal(r1.availability, 'InStock');
  assert.equal(r2.availability, 'OutOfStock');
  assert.equal(r1.rating, 3.8); assert.equal(r1.reviewCount, 5); assert.equal(r2.reviewCount, 5, 'same model → same reviews');
  assert.equal(calls.length, 3, 'stock ×2 colourways + reviews ×1 model');
  assert.deepEqual(calls.find((c) => c.u.includes('available_gtins')).h, { 'x-caller-id': 'web' });
  assert.deepEqual({ availabilityRows: rep.availabilityRows, ratingRows: rep.ratingRows, requests: rep.requests }, { availabilityRows: 3, ratingRows: 3, requests: 3 });
});

test('completeSideData: no browser → reported, nothing asked; a blocked answer stops the asking', async () => {
  assert.deepEqual(await completeSideData([sample], { getSession: async () => null, fetchJson: async () => ({ ok: true }) }), { learned: null, reason: 'browser_unavailable' });
  const session = { captureJson: async () => ({ captures, error: null }) };
  let n = 0;
  const rows = [row('A00001-001', ['1']), row('A00002-001', ['2']), row('A00003-001', ['3'])];
  rows.unshift(sample);
  const rep = await completeSideData(rows, { getSession: async () => session, fetchJson: async () => { n++; return { ok: false, status: 429, blocked: true }; } });
  assert.deepEqual(rep.learned, { availability: true, rating: true });
  assert.equal(rep.stoppedBy, 'blocked');
  assert.ok(n <= 2, `stopped after the block (${n} requests)`);
});
