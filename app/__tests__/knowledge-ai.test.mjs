/**
 * AI once per site: the model is asked ONLY for what no rule and no generic reader found, on a condensed
 * page (numbered elements); its answers become ordinary rules (origin 'ai'), checked on other product
 * pages and replayed without the model. Offline: a fake model that reads the outline like Claude would.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createKnowledgeService } from '../knowledge-service.mjs';
import { createProfileStore } from '../../core/domain-profile.mjs';
import { applyKnowledgeToHtml } from '../../core/site-knowledge.mjs';
import { condensePage, parseLocateAnswer, buildLocatePrompt } from '../../shared/knowledge/ai-locate.mjs';

// A shop whose page has no structured data for these blocks: the generic reader misses them.
const page = (i) => `<html><head><title>Parfum ${i}</title><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: `Parfum ${i}`, sku: `S${i}`, offers: { '@type': 'Offer', price: String(40 + i), priceCurrency: 'EUR' } })}</script></head><body>
  <h1>Parfum ${i}</h1><span class="mk">Maison ${i % 2 ? 'Alpha' : 'Beta'}</span>
  <div class="txt"><p>Un parfum floral et boisé, numéro ${i}, aux notes de rose et de cèdre.</p><p>Tenue longue, flacon rechargeable.</p></div>
  <div class="opts"><div class="o"><span>30 ml</span> <b class="price">${40 + i},00 €</b></div><div class="o"><span>50 ml</span> <b class="price">${60 + i},00 €</b></div></div>
  <section class="rel">${[1, 2, 3, 4, 5].map((k) => `<a class="rel-a" href="/p/${k}">Autre ${k}</a>`).join('')}</section></body></html>`;
const URL_OF = (i) => `https://shop.test/p/${i}`;

// The fake model: finds the numbered line holding each block, like the real one would from the outline.
function fakeModel(log) {
  return async (prompt) => {
    log.push(prompt);
    const line = (re) => { const m = prompt.split('\n').find((l) => re.test(l)); return m ? Number(m.match(/\[(\d+)\]/)[1]) : null; };
    const fields = {};
    if (/- brand:/.test(prompt)) fields.brand = { e: line(/<span \.mk> Maison/) };
    if (/- description:/.test(prompt)) fields.description = { e: line(/<div \.txt>/) };
    if (/- variants:/.test(prompt)) fields.variants = { e: line(/<span> 30 ml/) };
    if (/- technical_specs:/.test(prompt)) fields.technical_specs = null;
    return JSON.stringify({ fields });
  };
}

function service(pages, ask) {
  const map = {}; const profiles = createProfileStore({ read: () => map, write: () => {} });
  const fetchHtml = async (u) => (pages[u] ? { ok: true, html: pages[u] } : { ok: false });
  return { profiles, kn: createKnowledgeService({ profiles, fetchHtml, aiAsker: () => ask }) };
}

test('the condensed page numbers the useful elements, collapses long runs, drops scripts', () => {
  const { text, nodes } = condensePage(parseHTML(page(1)).document);
  assert.match(text, /\[\d+\] <span \.mk> Maison Alpha/);
  assert.ok(!/ld\+json|<script/.test(text));
  assert.match(text, /… \(more of the same\)/, 'the 5 related links are shown by their first 3');
  assert.ok(nodes.size > 5);
  assert.deepEqual(parseLocateAnswer('Voici : {"fields":{"brand":{"e":4},"description":{"state":"#0.product.desc"},"sku":{"e":"x"}}}', { missing: ['brand', 'description', 'sku'] }), { brand: { e: 4 }, description: { state: '#0.product.desc' } });
  assert.match(buildLocatePrompt({ condensed: 'X', missing: ['brand', 'nope'] }), /- brand:/);
});

test('✨ AI once: only the missing fields are asked; its answers become rules, checked on other pages, replayed without the model', async () => {
  const pages = Object.fromEntries([1, 2, 3, 4].map((i) => [URL_OF(i), page(i)]));
  const log = [];
  const { kn } = service(pages, fakeModel(log));
  const res = await kn.aiComplete(URL_OF(1), { html: page(1), sampleUrls: [URL_OF(2), URL_OF(3), URL_OF(4)] });
  assert.equal(res.ok, true);
  assert.ok(!res.asked.includes('sku'), 'the sku is already known (JSON-LD): not asked');
  assert.deepEqual([...res.located].sort(), ['brand', 'description', 'variants']);
  // Tested on the 3 OTHER pages; the page the model read is no evidence (taught).
  assert.ok(res.rules.every((r) => r.origin === 'ai' && r.tests.total === 3 && r.tests.ok === 3), JSON.stringify(res.rules.map((r) => r.tests)));
  assert.equal(log.length, 1, 'ONE model call for the site');
  // Replayed on another product without any model.
  const k = kn.forEngine(URL_OF(1));
  const got = applyKnowledgeToHtml(page(3), k, { url: URL_OF(3) });
  assert.equal(got.values.brand, 'Maison Alpha');
  assert.match(got.values.description, /numéro 3/);
  assert.deepEqual(got.values.variants.map((v) => [v.name, v.price]), [['30 ml', 43], ['50 ml', 63]]);
});

test('nothing missing → no model call; no key → a clear refusal; a manual rule is never replaced by the AI', async () => {
  const log = [];
  const { kn } = service({}, fakeModel(log));
  const r0 = await kn.aiComplete(URL_OF(1), { html: page(1), fields: ['sku'] });
  assert.deepEqual(r0.asked, []); assert.equal(log.length, 0);
  const none = createKnowledgeService({ profiles: createProfileStore({ read: () => ({}), write: () => {} }), fetchHtml: async () => ({ ok: false }), aiAsker: () => null });
  assert.equal((await none.aiComplete(URL_OF(1), { html: page(1) })).reason, 'ai_key_missing');
  // The user taught the brand by hand: the AI is not asked for it.
  const { kn: kn2 } = service({}, fakeModel(log));
  const d = parseHTML(page(1)).document;
  const { ruleFromElement } = await import('../../shared/knowledge/apply.mjs');
  const manual = ruleFromElement(d.querySelector('.mk'), d, { field: 'brand' }).rule;
  await kn2.learn(URL_OF(1), { scope: 'product', rules: [manual] });
  const r2 = await kn2.aiComplete(URL_OF(1), { html: page(1) });
  assert.ok(!r2.asked.includes('brand'));
});
