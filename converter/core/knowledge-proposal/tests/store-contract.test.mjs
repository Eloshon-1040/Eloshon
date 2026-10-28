// Phase 5.2 — KnowledgeStore contract tests.
// Runs against the reference JSON implementation. Any future backend must
// pass THIS suite unchanged. Uses an OS tmpdir; the repo is untouched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createJsonKnowledgeStore } from '../json-store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const exampleFmt = path.join(root, '..', 'knowledge-ref', 'formats', 'woocommerce.products.rest.v1.json');

async function makeStore() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-test-'));
  const referenceDir = path.join(base, 'ref');
  const learnedDir = path.join(base, 'learned');
  await fs.mkdir(path.join(referenceDir, 'formats'), { recursive: true });
  await fs.mkdir(learnedDir, { recursive: true });
  await fs.copyFile(exampleFmt, path.join(referenceDir, 'formats', 'woocommerce.products.rest.v1.json'));
  const store = createJsonKnowledgeStore({ referenceDir, learnedDir });
  return { store, base, referenceDir, learnedDir };
}

test('listFormats returns the shipped Reference format with origin=reference', async () => {
  const { store } = await makeStore();
  const list = await store.listFormats();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'woocommerce.products.rest.v1');
  assert.equal(list[0].origin, 'reference');
});

test('getFormat with strata=reference reads reference dir', async () => {
  const { store } = await makeStore();
  const fmt = await store.getFormat('woocommerce.products.rest.v1', 'reference');
  assert.ok(fmt);
  assert.equal(fmt.provenance, 'native-platform');
});

test('Reference is read-only from the store point of view', async () => {
  // The store never exposes a write API for Reference. This test asserts by
  // inspection: no method mutates referenceDir.
  const { store, referenceDir } = await makeStore();
  const before = await fs.readdir(path.join(referenceDir, 'formats'));
  await store.recordDecision({
    at: '2026-09-22T00:00:00Z', by: 'user:test',
    formatId: 'woocommerce.products.rest.v1',
    fieldPath: 'menu_order', action: 'confirmed',
    canonCandidate: 'merchandising.menuOrder', confidence: 'user-confirmed'
  });
  const after = await fs.readdir(path.join(referenceDir, 'formats'));
  assert.deepEqual(before, after);
});

test('recordDecision then listDecisions returns the appended entry', async () => {
  const { store } = await makeStore();
  const d = {
    at: '2026-09-22T00:00:00Z', by: 'user:test',
    formatId: 'woocommerce.products.rest.v1',
    fieldPath: 'menu_order', action: 'confirmed',
    canonCandidate: 'merchandising.menuOrder', confidence: 'user-confirmed'
  };
  await store.recordDecision(d);
  const got = await store.listDecisions('woocommerce.products.rest.v1');
  assert.deepEqual(got, [d]);
});

test('recordDecision is idempotent on identical tuple', async () => {
  const { store } = await makeStore();
  const d = {
    at: '2026-09-22T00:00:00Z', by: 'user:test',
    formatId: 'woocommerce.products.rest.v1',
    fieldPath: 'menu_order', action: 'confirmed',
    canonCandidate: 'merchandising.menuOrder', confidence: 'user-confirmed'
  };
  await store.recordDecision(d);
  await store.recordDecision(d);
  const got = await store.listDecisions('woocommerce.products.rest.v1');
  assert.equal(got.length, 1);
});

test('overlayView returns Reference fields with origin=reference', async () => {
  const { store } = await makeStore();
  const ov = await store.overlayView('woocommerce.products.rest.v1');
  assert.ok(ov);
  const title = ov.fields.find((f) => f.path === 'name');
  assert.equal(title.origin, 'reference');
  assert.equal(title.canon, 'title');
});

test('Learned entry OVERRIDES Reference and origin becomes learned', async () => {
  const { store, learnedDir } = await makeStore();
  const learnedFmt = {
    schemaVersion: 1,
    id: 'woocommerce.products.rest.v1',
    displayName: 'WooCommerce Products (REST API v3) — learned override',
    provenance: 'native-platform',
    medium: 'json-api',
    signatures: [{ kind: 'json-shape', requiredPaths: ['id', 'sku'] }],
    fields: [{ path: 'name', canon: 'title', transform: 'text', confidence: 'user-corrected' }],
    history: [{ at: '2026-09-22', op: 'correct', from: 'user:test', origin: 'learned' }]
  };
  await fs.mkdir(path.join(learnedDir, 'formats'), { recursive: true });
  await fs.writeFile(path.join(learnedDir, 'formats', 'woocommerce.products.rest.v1.json'), JSON.stringify(learnedFmt), 'utf8');

  const ov = await store.overlayView('woocommerce.products.rest.v1');
  const title = ov.fields.find((f) => f.path === 'name');
  assert.equal(title.origin, 'learned');
  assert.equal(title.confidence, 'user-corrected');
  assert.ok(title.overriddenReference, 'should carry the underlying Reference entry for tracing');
  assert.equal(title.overriddenReference.confidence, 'verified-live');

  assert.equal(await store.origin('woocommerce.products.rest.v1'), 'learned');
});

test('rejected decision hides the candidate from overlayView.fields surface', async () => {
  const { store } = await makeStore();
  // Reject the mapping name → title
  await store.recordDecision({
    at: '2026-09-22T00:00:00Z', by: 'user:test',
    formatId: 'woocommerce.products.rest.v1',
    fieldPath: 'name', action: 'rejected',
    canonCandidate: 'title', confidence: 'user-corrected',
    reason: 'test override'
  });
  const ov = await store.overlayView('woocommerce.products.rest.v1');
  const rejected = ov.fields.find((f) => f.path === 'name' && f.canon === 'title');
  assert.equal(rejected, undefined, 'rejected candidate must not appear in surface');
  // Raw Reference is untouched
  const raw = await store.getFormat('woocommerce.products.rest.v1', 'reference');
  assert.ok(raw.fields.find((f) => f.path === 'name' && f.canon === 'title'));
});

test('matchSignature: exact match on json-shape', async () => {
  const { store } = await makeStore();
  const matches = await store.matchSignature({
    kind: 'json-shape',
    paths: ['id', 'sku', 'type', 'regular_price']
  });
  assert.ok(matches.length >= 1);
  assert.equal(matches[0].kind, 'exact');
  assert.equal(matches[0].formatId, 'woocommerce.products.rest.v1');
});

test('matchSignature: superset match when payload has extras', async () => {
  const { store } = await makeStore();
  const matches = await store.matchSignature({
    kind: 'json-shape',
    paths: ['id', 'sku', 'type', 'regular_price', 'unexpected_field', 'another_one']
  });
  assert.equal(matches[0].kind, 'superset');
  assert.deepEqual(matches[0].extra.sort(), ['another_one', 'unexpected_field']);
});

test('matchSignature: partial match when some required paths are missing', async () => {
  const { store } = await makeStore();
  const matches = await store.matchSignature({
    kind: 'json-shape',
    paths: ['id', 'sku'] // missing type, regular_price
  });
  assert.ok(['partial', 'subset'].includes(matches[0].kind));
  assert.ok(matches[0].missing.includes('type'));
});

test('matchSignature: none when nothing overlaps', async () => {
  const { store } = await makeStore();
  const matches = await store.matchSignature({
    kind: 'json-shape',
    paths: ['aaaa', 'bbbb', 'cccc']
  });
  assert.equal(matches.length, 0);
});

test('samples: keep policy stores truncated value; hash-only stores hash; redact stores length only', async () => {
  const { store } = await makeStore();
  await store.addSample({
    formatId: 'woocommerce.products.rest.v1', fieldPath: 'name', raw: 'AC Infinity A7 - 150mm'
  });
  await store.addSample({
    formatId: 'woocommerce.products.rest.v1', fieldPath: 'description',
    raw: '<p>Long HTML body</p>'.repeat(100)
  });
  await store.addSample({
    formatId: 'woocommerce.products.rest.v1', fieldPath: 'billing_email',
    raw: 'user@example.com'
  });

  const name = await store.listSamples('woocommerce.products.rest.v1', 'name');
  assert.equal(name.length, 1);
  assert.equal(name[0].payload.kind, 'keep');

  const desc = await store.listSamples('woocommerce.products.rest.v1', 'description');
  assert.equal(desc.length, 1);
  assert.equal(desc[0].payload.kind, 'hash-only', 'description should default to hash-only');

  const email = await store.listSamples('woocommerce.products.rest.v1', 'billing_email');
  assert.equal(email.length, 1);
  assert.equal(email[0].payload.kind, 'redact', 'billing_email must be redacted by default');
  assert.equal('value' in email[0].payload, false, 'redacted payload must NOT carry the raw value');
});

test('samples: maxPerField enforces a ring buffer', async () => {
  const { store } = await makeStore();
  for (let i = 0; i < 8; i++) {
    await store.addSample({ formatId: 'woocommerce.products.rest.v1', fieldPath: 'name', raw: 'val-' + i });
  }
  const list = await store.listSamples('woocommerce.products.rest.v1', 'name');
  assert.equal(list.length, 5, 'default maxPerField=5');
  assert.equal(list[0].payload.value, 'val-3');
  assert.equal(list[4].payload.value, 'val-7');
});

test('samples: enabled=false blocks writes', async () => {
  const { store } = await makeStore();
  await store.setConfig({ samples: { enabled: false } });
  await store.addSample({ formatId: 'woocommerce.products.rest.v1', fieldPath: 'name', raw: 'nope' });
  const list = await store.listSamples('woocommerce.products.rest.v1', 'name');
  assert.equal(list.length, 0);
});

test('purgeSamples scope=field removes only the target', async () => {
  const { store } = await makeStore();
  await store.addSample({ formatId: 'woocommerce.products.rest.v1', fieldPath: 'name', raw: 'a' });
  await store.addSample({ formatId: 'woocommerce.products.rest.v1', fieldPath: 'sku',  raw: 'x' });
  const removed = await store.purgeSamples({ kind: 'field', formatId: 'woocommerce.products.rest.v1', fieldPath: 'name' });
  assert.equal(removed, 1);
  assert.equal((await store.listSamples('woocommerce.products.rest.v1', 'name')).length, 0);
  assert.equal((await store.listSamples('woocommerce.products.rest.v1', 'sku')).length, 1);
});

test('origin() reports learned when a Learned override exists, else reference', async () => {
  const { store, learnedDir } = await makeStore();
  assert.equal(await store.origin('woocommerce.products.rest.v1'), 'reference');
  await fs.mkdir(path.join(learnedDir, 'formats'), { recursive: true });
  await fs.writeFile(path.join(learnedDir, 'formats', 'woocommerce.products.rest.v1.json'),
    JSON.stringify({ schemaVersion: 1, id: 'woocommerce.products.rest.v1', displayName: 'x',
      provenance: 'native-platform', medium: 'json-api',
      signatures: [{ kind: 'json-shape', requiredPaths: ['id'] }],
      fields: [], history: [{ at: '2026-09-22', op: 'correct', from: 'x', origin: 'learned' }] }), 'utf8');
  assert.equal(await store.origin('woocommerce.products.rest.v1'), 'learned');
});

test('origin() returns null for unknown format', async () => {
  const { store } = await makeStore();
  assert.equal(await store.origin('does.not.exist'), null);
});
