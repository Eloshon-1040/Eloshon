/**
 * The side panel's chat agent, offline: a fake Messages API plays the model. One user message runs the
 * tool loop in the app (propose_recipe → inspect_page → test_selector → highlight_element → save_recipe),
 * the rule is saved in the site's knowledge and checked on other pages, the history stays append-only
 * (the model's blocks passed back unchanged), every tool result goes back in ONE user message, and every
 * model request is counted. No key in the extension: without the app's key the agent says so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentService, AGENT_TOOLS, AGENT_DEFAULT_MODEL } from '../ai/agent.mjs';
import { createKnowledgeService } from '../knowledge-service.mjs';
import { createProfileStore } from '../../core/domain-profile.mjs';

const urlOf = (i) => `https://www.boutique.test/p/creme-${i}`;
const page = (i) => `<html><head><title>Crème ${i}</title><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: `Crème hydratante ${i}`, offers: { '@type': 'Offer', price: String(20 + i), priceCurrency: 'EUR' } })}</script></head><body>
  <nav class="crumbs"><a href="/">Accueil</a> › <a href="/soins">Soins</a> › <a href="/soins/visage">Visage</a></nav>
  <h1>Crème hydratante ${i}</h1><p class="maker">Fabriqué par <span class="mk">Laboratoire Rivage</span></p><div class="prix">${20 + i},00 €</div>
  <div class="desc"><p>Une crème légère qui hydrate la peau toute la journée, sans parfum, pour peaux sensibles (réf. ${i}).</p></div></body></html>`;
const PAGES = Object.fromEntries([1, 2, 3].map((i) => [urlOf(i), page(i)]));

function setup({ fetchImpl, key = 'test-key' } = {}) {
  const map = {}; const profiles = createProfileStore({ read: () => map, write: () => {} });
  const knowledge = createKnowledgeService({ profiles, fetchHtml: async (u) => (PAGES[u] ? { ok: true, html: PAGES[u] } : { ok: false }) });
  const calls = [];
  const agent = createAgentService({ knowledge, credentials: () => (key ? { apiKey: key } : null), fetchImpl, onCall: (i) => calls.push(i) });
  return { agent, knowledge, calls };
}

// The fake model: a scripted conversation, checking what the app sends at each step.
function scriptedModel(steps, seen) {
  let n = 0;
  return async (url, init) => {
    const body = JSON.parse(init.body); seen.push({ url, headers: init.headers, body });
    const step = steps[Math.min(n++, steps.length - 1)];
    const out = typeof step === 'function' ? step(body) : step;
    return { ok: (out.status || 200) < 400, status: out.status || 200, text: async () => JSON.stringify(out.json) };
  };
}
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const msg = (content, stop_reason = 'end_turn') => ({ json: { id: 'msg', model: AGENT_DEFAULT_MODEL, content, stop_reason, usage: { input_tokens: 100, output_tokens: 20 } } });

test('one user message: the tool loop reads the page, tests, shows, saves a rule for the site; every request counted', async () => {
  const seen = [];
  const lineOf = (text, re) => { const l = String(text).split('\n').find((x) => re.test(x)); return l ? Number(l.match(/\[(\d+)\]/)[1]) : null; };
  let mkElement = null;
  const steps = [
    msg([{ type: 'thinking', thinking: '', signature: 'sig-1' }, toolUse('t1', 'propose_recipe', {})], 'tool_use'),
    (body) => {
      const last = body.messages[body.messages.length - 1];
      assert.equal(last.role, 'user'); assert.equal(last.content[0].type, 'tool_result');
      const r = JSON.parse(last.content[0].content);
      assert.match(r.fields.name.value, /Crème hydratante 1/); assert.match(r.fields.name.from, /déclarées/);
      assert.ok(r.missing.includes('brand'), 'the brand is not declared');
      return msg([toolUse('t2', 'inspect_page', { find: 'Rivage' })], 'tool_use');
    },
    (body) => {
      const r = JSON.parse(body.messages[body.messages.length - 1].content[0].content);
      mkElement = lineOf(r.outline, /Laboratoire Rivage/);
      assert.ok(Number.isInteger(mkElement), r.outline);
      // Two calls in one turn: both results must come back in ONE user message.
      return msg([toolUse('t3', 'test_selector', { field: 'brand', element: mkElement }), toolUse('t4', 'highlight_element', { element: mkElement, label: 'Marque' })], 'tool_use');
    },
    (body) => {
      const last = body.messages[body.messages.length - 1];
      assert.deepEqual(last.content.map((b) => b.tool_use_id), ['t3', 't4']);
      const t = JSON.parse(last.content[0].content);
      assert.equal(t.ok, true); assert.equal(t.value, 'Laboratoire Rivage');
      return msg([toolUse('t5', 'save_recipe', { field: 'brand', element: mkElement })], 'tool_use');
    },
    (body) => {
      const s = JSON.parse(body.messages[body.messages.length - 1].content[0].content);
      assert.equal(s.ok, true); assert.equal(s.checkedOn, '2/2 autre(s) fiche(s)');
      return msg([{ type: 'text', text: 'La marque est « Laboratoire Rivage » ; règle enregistrée et vérifiée sur 2 autres fiches.' }]);
    },
  ];
  const { agent, knowledge, calls } = setup({ fetchImpl: scriptedModel(steps, seen) });
  const r = await agent.chat(urlOf(1), { message: 'La marque manque, elle est écrite sous le titre.', html: PAGES[urlOf(1)], sampleUrls: [urlOf(2), urlOf(3)] });
  assert.equal(r.ok, true); assert.match(r.reply, /Laboratoire Rivage/);
  assert.equal(r.aiCalls, 5); assert.equal(calls.length, 5);
  assert.deepEqual(r.actions.map((a) => a.label), ['Marque']); assert.ok(r.actions[0].highlight);
  // The rule is the site's: the next scrape reads it without any AI.
  const rule = knowledge.forEngine(urlOf(2)).rules.find((x) => x.field === 'brand' && x.status === 'active');
  assert.equal(rule.origin, 'manual');
  // What was sent: the agent's model, its tools, no forced tool choice, no sampling parameter, the server fallback.
  const b0 = seen[0].body;
  assert.equal(b0.model, AGENT_DEFAULT_MODEL); assert.deepEqual(b0.tools.map((t) => t.name), AGENT_TOOLS.map((t) => t.name));
  assert.equal(b0.tool_choice, undefined); assert.equal(b0.temperature, undefined); assert.equal(b0.fallbacks, 'default');
  assert.equal(seen[0].headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  // Append-only: request n+1 starts with exactly request n's messages, the model's blocks unchanged.
  for (let i = 1; i < seen.length; i++) assert.deepEqual(seen[i].body.messages.slice(0, seen[i - 1].body.messages.length), seen[i - 1].body.messages);
  assert.deepEqual(seen[1].body.messages[1].content[0], { type: 'thinking', thinking: '', signature: 'sig-1' });
  // A second message continues the SAME conversation.
  const seen2 = []; const { agent: a2 } = setup({ fetchImpl: scriptedModel([msg([{ type: 'text', text: 'ok' }])], seen2) });
  const first = await a2.chat(urlOf(1), { message: 'bonjour', html: PAGES[urlOf(1)] });
  await a2.chat(urlOf(1), { chatId: first.chatId, message: 'encore', html: PAGES[urlOf(1)] });
  assert.equal(seen2[1].body.messages.length, 3, 'user, assistant, user');
});

test('a platform that refuses the fallback parameter: asked again without it; a refusal is said plainly; no key, no call', async () => {
  const seen = [];
  const steps = [{ status: 400, json: { error: { type: 'invalid_request_error', message: 'fallbacks: not supported' } } }, msg([{ type: 'text', text: 'Bonjour' }])];
  const { agent } = setup({ fetchImpl: scriptedModel(steps, seen) });
  const r = await agent.chat(urlOf(1), { message: 'bonjour', html: PAGES[urlOf(1)] });
  assert.equal(r.ok, true); assert.equal(r.reply, 'Bonjour');
  assert.equal(seen[1].body.fallbacks, undefined); assert.equal(seen[1].headers['anthropic-beta'], undefined);
  const { agent: a2 } = setup({ fetchImpl: scriptedModel([msg([], 'refusal')], []) });
  const ref = await a2.chat(urlOf(1), { message: 'x', html: PAGES[urlOf(1)] });
  assert.equal(ref.stop, 'refusal'); assert.match(ref.reply, /ne peux pas/);
  let called = false;
  const { agent: a3 } = setup({ key: null, fetchImpl: async () => { called = true; return { ok: true, status: 200, text: async () => '{}' }; } });
  const nok = await a3.chat(urlOf(1), { message: 'x', html: PAGES[urlOf(1)] });
  assert.equal(nok.ok, false); assert.match(nok.reason, /clé/); assert.equal(called, false);
});
