/**
 * "No button that looks wired but isn't": every message the Fiche produit tab sends is handled by the
 * service worker, every op the worker sends to the app is answered by the app, every element the tab
 * script looks for exists in the panel, and the in-page tool it calls is exported by the runner.
 * (The real behaviour is covered end to end in app/__tests__/site-knowledge-e2e.test.mjs.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const learn = read('extension/ui/learn.mjs');
const panelJs = read('extension/ui/panel.mjs');
const html = read('extension/ui/panel.html');
const worker = read('extension/background/service-worker.mjs');
const runner = read('extension/content/runner.mjs');
const requests = read('app/your-browser/panel-requests.mjs');
const messages = read('shared/protocol/messages.mjs');
const uniq = (a) => [...new Set(a)];

test('every message kind sent by the panel scripts has a handler in the service worker', () => {
  const sent = uniq([...(learn + panelJs).matchAll(/send\('([a-z_]+)'/g)].map((m) => m[1]));
  assert.ok(sent.includes('knowledge_pick') && sent.includes('knowledge_learn') && sent.includes('knowledge_propose') && sent.includes('knowledge_summary') && sent.includes('knowledge_forget') && sent.includes('page_kind'));
  const handled = new Set([...worker.matchAll(/msg\.kind === '([a-z_]+)'/g)].map((m) => m[1]));
  for (const k of sent) assert.ok(handled.has(k), `service worker does not handle « ${k} »`);
});

test('every op the worker sends to the app is answered by the app (and is valid in the protocol)', () => {
  const ops = uniq([...worker.matchAll(/appRequest\(\{ op: '([a-z]+)'/g)].map((m) => m[1]));
  for (const op of ['learn', 'propose', 'knowledge', 'forget', 'recipe', 'ingest']) assert.ok(ops.includes(op) || /recipe|ingest/.test(op), `worker never sends « ${op} »`);
  for (const op of ops) assert.ok(new RegExp(`p\\.op === '${op}'`).test(requests), `app does not answer op « ${op} »`);
  for (const op of ['learn', 'propose', 'knowledge', 'forget']) assert.ok(messages.includes(`'${op}'`), `protocol does not list « ${op} »`);
});

test('every element the Fiche produit script looks for exists in the panel; the tab is in the menu', () => {
  const ids = uniq([...learn.matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]));
  for (const id of ids) assert.ok(new RegExp(`id="${id}"`).test(html), `#${id} missing from panel.html`);
  assert.ok(/data-tab="learn"/.test(html) && /id="pane-learn"/.test(html));
  assert.ok(/learn\.mjs/.test(html), 'learn.mjs is loaded by the panel');
});

test('the in-page tools the worker calls are exported by the runner', () => {
  const calls = uniq([...worker.matchAll(/_call\('([A-Za-z]+)'/g)].map((m) => m[1]));
  const exported = (runner.match(/globalThis\.__eloRunner = \{([^}]+)\}/) || [])[1] || '';
  for (const c of calls) assert.ok(new RegExp(`\\b${c}\\b`).test(exported), `runner does not export « ${c} »`);
});
