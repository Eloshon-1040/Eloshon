import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnthropicAsker, aiErrorText } from '../ai/provider.mjs';
import { aiAssistJson } from '../../shared/extract/ai-assist.mjs';

const okResponse = (text) => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text }] }) });

test('createAnthropicAsker posts to the Messages API with the key and returns the text', async () => {
  let seen = null;
  const fetchImpl = async (url, opts) => { seen = { url, opts }; return okResponse('{"arrayPath":"a","fieldMap":{"name":"n"},"confidence":0.7}'); };
  const askJson = createAnthropicAsker({ apiKey: 'sk-test', model: 'claude-opus-4-8', fetchImpl });
  const out = await askJson('hello');
  assert.equal(seen.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen.opts.headers['x-api-key'], 'sk-test');
  const body = JSON.parse(seen.opts.body);
  assert.equal(body.model, 'claude-opus-4-8');
  assert.equal(body.messages[0].content, 'hello');
  assert.match(out, /arrayPath/);
});

test('missing key throws before any call', () => {
  assert.throws(() => createAnthropicAsker({ apiKey: '' }), /ai_key_missing/);
});

test('an HTTP error surfaces a code (mapped to a friendly line, no code to the user)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401 });
  const askJson = createAnthropicAsker({ apiKey: 'x', fetchImpl });
  await assert.rejects(askJson('p'), /ai_http_401/);
  assert.match(aiErrorText(new Error('ai_http_401')), /refusée/);
  assert.match(aiErrorText(new Error('ai_key_missing')), /aucune clé/);
});

test('end to end: the real asker + the shared core extract products from a mocked model reply', async () => {
  const reply = JSON.stringify({ arrayPath: 'data.products', fieldMap: { name: 'title', price: 'cost', url: 'slug' }, confidence: 0.9 });
  const fetchImpl = async () => okResponse('```json\n' + reply + '\n```');
  const askJson = createAnthropicAsker({ apiKey: 'k', fetchImpl });
  const page = { data: { products: [{ title: 'X', cost: '9,90 €', slug: '/p/x' }, { title: 'Y', cost: '12,00 €', slug: '/p/y' }] } };
  const { cards, hints } = await aiAssistJson(page, 'https://s.test/c', { askJson });
  assert.equal(hints.confidence, 0.9);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].price, 9.9);
  assert.equal(cards[1].sourceUrl, 'https://s.test/p/y');
});
