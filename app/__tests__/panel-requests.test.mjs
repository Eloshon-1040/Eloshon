/**
 * Requests from the extension's side panel, answered by the app
 * (app/your-browser/panel-requests.mjs) and routed by the your-browser service:
 *  - 'recipe' → only the card + field selectors of the site's learned recipe;
 *  - 'ingest' → the accepted rows, validated and bounded, become a normal job.
 * Offline: fake controller / recipe resolver / bridge.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handlePanelRequest, sanitizeRow, panelRecipe } from '../your-browser/panel-requests.mjs';
import { createYourBrowserService } from '../your-browser/integration.mjs';
import * as P from '../../shared/protocol/messages.mjs';

const stored = { card: '.product-card__body', fields: { name: { selector: '.t', attr: null }, url: { selector: 'a.o', attr: 'href' }, bad: { selector: 3 } }, pagination: { mode: 'api-next', api_host: 'https://api.shop.test' }, id: 'secret-row-id' };

test('recipe: only card + valid field selectors leave the app (no pagination memo, no ids)', async () => {
  const r = await handlePanelRequest({ op: 'recipe', url: 'https://www.shop.test/w/sale' }, { resolveRecipe: async () => ({ manualSelectors: stored }) });
  assert.deepEqual(r, { ok: true, recipe: { card: '.product-card__body', fields: { name: { selector: '.t', attr: null }, url: { selector: 'a.o', attr: 'href' } } } });
  assert.equal(panelRecipe(null), null);
  const none = await handlePanelRequest({ op: 'recipe', url: 'https://x.test/' }, { resolveRecipe: async () => ({}) });
  assert.deepEqual(none, { ok: true, recipe: null });
});

test('ingest: rows sanitised (types, URLs, extra fields bounded) and recorded as a job', async () => {
  let got = null;
  const controller = { ingestExternalProducts: async (input) => { got = input; return { jobId: 'J1', status: 'done', counts: { accepted: 2 } }; } };
  const rows = [
    { name: 'Model 1', price: 52.49, currency: 'EUR', sourceUrl: 'https://www.shop.test/t/m1', images: ['https://img.test/1.jpg', 'javascript:alert(1)'], reduction: '74,99 €', fn: { x: 1 } },
    { title: 'Model 2', price: '0', url: 'https://www.shop.test/t/m2' },
    { price: 10 }, // neither name nor URL → dropped
    'nope',
  ];
  const r = await handlePanelRequest({ op: 'ingest', url: 'https://www.shop.test/w/sale', rows, fields: [{ key: 'name' }, { key: 'reduction' }], subpages: true, durationMs: 1234 }, { controller });
  // The reply also carries the job's real status and the site rules that failed (the panel's export manifest).
  assert.deepEqual(r, { ok: true, jobId: 'J1', counts: { accepted: 2 }, status: 'done', reportStatus: null, rulesFailing: [] });
  assert.equal(got.products.length, 2);
  assert.deepEqual(got.products[0].images, ['https://img.test/1.jpg']);
  assert.equal(got.products[0].reduction, '74,99 €');
  assert.equal(got.products[0].fn, undefined);
  assert.equal(got.products[1].name, 'Model 2'); assert.equal(got.products[1].price, undefined);
  assert.equal(got.completeDetails, true);
  assert.equal(got.method, 'your-browser');
  assert.equal(got.details.domain, 'shop.test');
  assert.equal(got.durationMs, 1234);
});

test('refusals: bad URL, nothing usable, unknown op', async () => {
  const controller = { ingestExternalProducts: async () => { throw new Error('must not be called'); } };
  assert.equal((await handlePanelRequest({ op: 'ingest', url: 'file:///c:/x', rows: [{ name: 'a' }] }, { controller })).ok, false);
  assert.match((await handlePanelRequest({ op: 'ingest', url: 'https://x.test/', rows: [{ price: 1 }] }, { controller })).reason, /aucune ligne/);
  assert.equal((await handlePanelRequest({ op: 'delete', url: 'https://x.test/' }, { controller })).ok, false);
  assert.equal(sanitizeRow(null), null);
});

test('the service answers a panel request over the bridge, echoing the request id', async () => {
  const sent = [];
  const bridge = { start() {}, stop() {}, send: (m) => sent.push(m) };
  const svc = createYourBrowserService({ config: {}, bridgeFactory: () => bridge, resolveRecipe: async () => ({ manualSelectors: stored }) });
  svc.start();
  const req = P.panelRequest({ op: 'recipe', url: 'https://www.shop.test/w/sale' });
  bridge.onMessage(req);
  await new Promise((r) => setTimeout(r, 10));
  const reply = sent.find((m) => m.type === P.MSG.PANEL_RESULT);
  assert.ok(reply, 'a panel_result was sent');
  assert.equal(reply.id, req.id);
  assert.equal(reply.payload.recipe.card, '.product-card__body');
  assert.deepEqual(P.validateMessage(reply).ok ?? true, true);
});

test('"Accepter" clicked several times for the same run → ONE job (concurrent and later repeats get the same answer)', async () => {
  let calls = 0;
  const controller = { ingestExternalProducts: async () => { calls++; await new Promise((r) => setTimeout(r, 30)); return { jobId: `J${calls}`, status: 'done', counts: { accepted: 1 } }; } };
  const runs = new Map();
  const req = { op: 'ingest', url: 'https://www.shop.test/w/sale', rows: [{ name: 'A', sourceUrl: 'https://www.shop.test/t/a', price: 10 }], runId: 'pr_abc_123' };
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => handlePanelRequest(req, { controller, runs })));
  const d = await handlePanelRequest(req, { controller, runs });
  assert.equal(calls, 1);
  assert.deepEqual([a.jobId, b.jobId, c.jobId, d.jobId], ['J1', 'J1', 'J1', 'J1']);
  assert.equal(a.duplicate, undefined); assert.equal(d.duplicate, true);
  // A new run (new id) is recorded again.
  const e = await handlePanelRequest({ ...req, runId: 'pr_def_456' }, { controller, runs });
  assert.equal(e.jobId, 'J2');
});

test('sanitizeRow keeps a designated list price (number only)', () => {
  assert.equal(sanitizeRow({ name: 'A', listPrice: 89.99 }).listPrice, 89.99);
  assert.equal(sanitizeRow({ name: 'A', listPrice: 'x' }).listPrice, undefined);
});
