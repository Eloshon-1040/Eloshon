// Phase 5.2 — Schema tests.
// Validate the shipped example against the JSON Schema and check that
// tampered variants are rejected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeValidator } from '../validator.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

async function loadJson(p) { return JSON.parse(await fs.readFile(p, 'utf8')); }

const schema = await loadJson(path.join(root, 'schema.json'));
const example = await loadJson(path.join(root, '..', 'knowledge-ref', 'formats', 'woocommerce.products.rest.v1.json'));

const validateFormat = makeValidator(schema, 'formatKnowledge');
const validateDecision = makeValidator(schema, 'learnedDecision');
const validateSample = makeValidator(schema, 'sample');

test('shipped example FormatKnowledge validates', () => {
  const r = validateFormat(example);
  assert.equal(r.ok, true, r.errors.map((e) => e.path + ' ' + e.msg).join('\n'));
});

test('FormatKnowledge rejects unknown top-level property', () => {
  const bad = { ...example, hasSecret: 'oops' };
  const r = validateFormat(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /unknown property "hasSecret"/.test(e.msg)));
});

test('FormatKnowledge rejects unknown provenance', () => {
  const bad = { ...example, provenance: 'aliens' };
  const r = validateFormat(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /expected one of/.test(e.msg)));
});

test('FormatKnowledge requires at least one signature', () => {
  const bad = { ...example, signatures: [] };
  const r = validateFormat(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /minItems/.test(e.msg)));
});

test('Signature oneOf: csv-header-set and json-shape are both accepted', () => {
  const csv = { ...example, signatures: [{ kind: 'csv-header-set', required: ['SKU', 'Name'] }] };
  const json = { ...example, signatures: [{ kind: 'json-shape', requiredPaths: ['id', 'sku'] }] };
  assert.equal(validateFormat(csv).ok, true);
  assert.equal(validateFormat(json).ok, true);
});

test('Signature oneOf: xml-root works with only `root`', () => {
  const xml = { ...example, signatures: [{ kind: 'xml-root', root: 'prestashop' }] };
  const r = validateFormat(xml);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('Signature oneOf: unknown kind is rejected', () => {
  const bad = { ...example, signatures: [{ kind: 'foobar', required: [] }] };
  assert.equal(validateFormat(bad).ok, false);
});

test('LearnedDecision validates a minimal record', () => {
  const d = {
    at: '2026-09-22T14:03:44Z',
    by: 'user:test',
    formatId: 'wix.products.csv.v1',
    fieldPath: 'Option Name',
    action: 'confirmed',
    canonCandidate: 'options',
    confidence: 'user-confirmed'
  };
  assert.equal(validateDecision(d).ok, true);
});

test('LearnedDecision rejects unknown action', () => {
  const d = {
    at: '2026-09-22T14:03:44Z',
    by: 'user:test',
    formatId: 'wix.products.csv.v1',
    fieldPath: 'Option Name',
    action: 'maybe',
    confidence: 'user-confirmed'
  };
  assert.equal(validateDecision(d).ok, false);
});

test('LearnedDecision accepts scope=family with pattern', () => {
  const d = {
    at: '2026-09-22T14:03:44Z',
    by: 'user:test',
    formatId: 'scraper.colruyt.a1f3c7.v1',
    fieldPath: 'PRIX_TTC',
    action: 'confirmed',
    canonCandidate: 'variants[].price',
    confidence: 'user-confirmed',
    scope: { kind: 'family', pattern: 'scraper.colruyt.*' }
  };
  assert.equal(validateDecision(d).ok, true);
});

test('Sample.keep payload validates', () => {
  const s = {
    at: '2026-09-21T00:00:00Z',
    formatId: 'woocommerce.products.rest.v1',
    fieldPath: 'name',
    payload: { kind: 'keep', value: 'AC Infinity A7' }
  };
  assert.equal(validateSample(s).ok, true);
});

test('Sample.hash-only payload validates', () => {
  const s = {
    at: '2026-09-21T00:00:00Z',
    formatId: 'woocommerce.products.rest.v1',
    fieldPath: 'description',
    payload: { kind: 'hash-only', hash: 'a3f9', length: 812, valueType: 'string' }
  };
  assert.equal(validateSample(s).ok, true);
});

test('Sample.redact payload validates', () => {
  const s = {
    at: '2026-09-21T00:00:00Z',
    formatId: 'woocommerce.orders.rest.v1',
    fieldPath: 'billing.phone',
    payload: { kind: 'redact', length: 10, valueType: 'string' }
  };
  assert.equal(validateSample(s).ok, true);
});

test('FieldMapEntry with canon=null is allowed (ignored fields)', () => {
  const patched = { ...example, fields: [...example.fields, { path: '_internalTrash', canon: null, transform: 'copy', confidence: 'user-confirmed' }] };
  const r = validateFormat(patched);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('History entry requires origin', () => {
  const bad = { ...example, history: [{ at: '2026-09-21', op: 'seed', from: 'x' }] };
  assert.equal(validateFormat(bad).ok, false);
});
