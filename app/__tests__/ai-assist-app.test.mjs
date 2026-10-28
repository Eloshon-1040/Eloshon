import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAiAssist } from '../ai/assist.mjs';

const okReply = (obj) => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] }) });
const keyIo = { secure: { 'ai.anthropic': { apiKey: 'sk-test' } } };

test('runAiAssist: no key configured → clean refusal', async () => {
  const r = await runAiAssist({ sources: [{}], io: {} });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ai_key_missing');
});

test('runAiAssist: resolves the admin key, runs the model, returns cards + hints', async () => {
  const fetchImpl = async () => okReply({ arrayPath: '__sources[0].data.products', fieldMap: { name: 'title', price: 'cost', url: 'slug' }, confidence: 0.85 });
  const sources = [{ data: { products: [{ title: 'A', cost: '9,90 €', slug: '/p/a' }, { title: 'B', cost: '12,00 €', slug: '/p/b' }] } }];
  const r = await runAiAssist({ sources, baseUrl: 'https://s.test/c', io: keyIo, fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.cards.length, 2);
  assert.equal(r.cards[0].price, 9.9);
  assert.equal(r.cards[1].sourceUrl, 'https://s.test/p/b');
  assert.equal(r.hints.confidence, 0.85);
});

test('runAiAssist: VIDEO schema (custom fields) is honoured — non-product content', async () => {
  const fetchImpl = async () => okReply({ arrayPath: '__sources[0].items', fieldMap: { title: 't', url: 'href', thumbnail: 'thumb', views: 'v', tags: 'tags' }, confidence: 0.8 });
  const sources = [{ items: [
    { t: 'Clip', href: '/w/1', thumb: '/t/1.jpg', v: '12k', tags: ['hd', 'fun'] },
    { t: 'Clip 2', href: '/w/2', thumb: '/t/2.jpg', v: '8k', tags: ['sd'] },
  ] }];
  const fields = [{ key: 'title' }, { key: 'url' }, { key: 'thumbnail' }, { key: 'views' }, { key: 'tags', hint: 'les étiquettes de la vidéo' }];
  const r = await runAiAssist({ sources, baseUrl: 'https://v.test', io: keyIo, fetchImpl, fields });
  assert.equal(r.ok, true);
  assert.equal(r.cards.length, 2);
  assert.equal(r.cards[0].title, 'Clip');
  assert.equal(r.cards[0].views, '12k');
  assert.deepEqual(r.cards[0].tags, ['hd', 'fun']);
});

test('runAiAssist: string JSON sources (captured XHR bodies) are decoded', async () => {
  const fetchImpl = async () => okReply({ arrayPath: '__sources[0].list', fieldMap: { name: 'n' }, confidence: 0.6 });
  const r = await runAiAssist({ sources: ['{"list":[{"n":"X"},{"n":"Y"}]}'], baseUrl: 'https://s.test', io: keyIo, fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.cards.length, 2);
  assert.equal(r.cards[0].name, 'X');
});
