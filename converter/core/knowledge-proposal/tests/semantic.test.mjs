// Phase 5.4 — Semantic column recogniser tests.
// (1) Agreement with the seed rules (mapping.ts) on every fixture — the engine
//     must rediscover what the hand-written parsers already know.
// (2) French headers, value-only evidence (opaque headers), structural
//     families, parent references, Learned decisions, sample redaction.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recognizeColumns, tokenize, profileValues, toFieldMapEntries, makeDecision } from '../semantic.mjs';
import { loadCanonCatalogSync, loadRecognitionConfigSync } from '../reference.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..', '..');
const FIX = path.join(ROOT, 'test', 'fixtures');
const toUrl = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:');
const { parseCsv } = await import(toUrl(path.join(ROOT, 'core', 'dist', 'csv.mjs')));
const { detectFormat } = await import(toUrl(path.join(ROOT, 'core', 'dist', 'detect.mjs')));
const { SOURCE_FIELDS } = await import(toUrl(path.join(ROOT, 'core', 'dist', 'mapping.mjs')));

const catalog = loadCanonCatalogSync();
const config = loadRecognitionConfigSync();
const run = (headers, rows, entity, extra = {}) => recognizeColumns({ headers, rows, entity, catalog, config, ...extra });
const rowsOf = (headers, matrix) => matrix.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));

test('catalogue: every field has EN names, accepted profiles, a transform; paths unique per entity', () => {
  const seen = new Set();
  for (const f of catalog.fields) {
    assert.ok(f.names.en.length >= 1, f.path);
    assert.ok(f.accepts.length >= 1, f.path);
    assert.ok(f.transform, f.path);
    const k = f.entity + '|' + f.path;
    assert.ok(!seen.has(k), 'duplicate ' + k); seen.add(k);
  }
  for (const f of catalog.fields.filter((x) => x.family)) new RegExp(f.family, 'i'); // compiles
});

test('seed agreement: on every fixture, the best candidate equals the hand-written parser rule (editable columns)', () => {
  let agree = 0, total = 0, autos = 0;
  for (const name of fs.readdirSync(FIX).filter((n) => n.endsWith('.csv'))) {
    const t = parseCsv(fs.readFileSync(path.join(FIX, name), 'utf8'));
    const det = detectFormat(t.headers);
    const rep = run(t.headers, t.rows, det.entity, { formatId: det.knowledgeId });
    const expected = new Map((SOURCE_FIELDS[det.format] || []).filter((r) => r.editable).map((r) => [r.column, r.canon]));
    for (const c of rep.columns) {
      if (!expected.has(c.column)) continue;
      total++;
      if (c.best?.canon === expected.get(c.column)) agree++;
      else assert.fail(`${name} "${c.column}": expected ${expected.get(c.column)}, got ${c.best?.canon} (${c.status})`);
      if (c.status === 'auto') autos++;
    }
  }
  assert.equal(agree, total);
  assert.ok(total >= 140, 'seed coverage shrank: ' + total);
  assert.ok(autos / total >= 0.9, `only ${autos}/${total} seed columns are auto`);
});

test('French headers with typical values are recognised (auto or top suggestion)', () => {
  const headers = ['Référence', 'Nom du produit', 'Prix TTC', 'Prix barré', 'Code EAN', 'Stock disponible', 'Description longue', 'Image principale', 'Catégorie', 'Marque', 'Poids (kg)', 'Publié'];
  const rows = rowsOf(headers, [
    ['REF-001', 'Table basse chêne', '129,90', '159,90', '3701234567890', '12', '<p>Table en chêne massif.</p>', 'https://cdn.example.com/a.jpg', 'Maison > Salon > Tables', 'Eloshon', '12.5', 'oui'],
    ['REF-002', 'Chaise scandinave', '59,00', '', '3701234567906', '0', '<p>Chaise hêtre.</p>', 'https://cdn.example.com/b.jpg', 'Maison > Salon > Chaises', 'Eloshon', '4.2', 'oui'],
    ['REF-003', 'Lampe de bureau', '39,90', '49,90', '3701234567913', '5', '<p>Lampe LED.</p>', 'https://cdn.example.com/c.png', 'Maison > Bureau', 'Lumo', '1.1', 'non'],
    ['REF-004', 'Tapis laine', '89,00', '', '3701234567920', '3', '<p>Tapis 160x230.</p>', 'https://cdn.example.com/d.jpg', 'Maison > Salon', 'Eloshon', '6.0', 'oui'],
    ['REF-005', 'Étagère murale', '24,90', '29,90', '3701234567937', '20', '<p>Étagère pin.</p>', 'https://cdn.example.com/e.jpg', 'Maison > Rangement', 'Lumo', '2.3', 'oui'],
  ]);
  const rep = run(headers, rows, 'products');
  const want = { 'Référence': 'sku', 'Nom du produit': 'title', 'Prix TTC': 'price', 'Prix barré': 'compareAtPrice', 'Code EAN': 'barcode', 'Stock disponible': 'inventoryQty', 'Description longue': 'bodyHtml', 'Image principale': 'images', 'Catégorie': 'categories', 'Marque': 'vendor', 'Poids (kg)': 'grams', 'Publié': 'published' };
  for (const c of rep.columns) {
    assert.equal(c.best?.canon, want[c.column], `${c.column} → ${c.best?.canon} ${c.best?.score}`);
    assert.ok(c.status === 'auto' || c.status === 'suggest', `${c.column} is ${c.status}`);
  }
  assert.ok(rep.columns.filter((c) => c.status === 'auto').length >= 9, 'most FR columns should be auto');
});

test('value-only evidence: opaque headers still yield suggestions (never auto) from value profiles', () => {
  const headers = ['c1', 'c2', 'c3', 'c4', 'c5'];
  const rows = rowsOf(headers, [
    ['3701234567890', '<p>Hello</p>', 'https://x.com/a.jpg', 'a@b.com', '19.99'],
    ['3701234567906', '<p>World</p>', 'https://x.com/b.png', 'c@d.org', '5.50'],
    ['3701234567913', '<div>Yo</div>', 'https://x.com/c.webp', 'e@f.net', '120.00'],
    ['3701234567920', '<p>Hi</p>', 'https://x.com/d.jpg', 'g@h.io', '7.25'],
  ]);
  const rep = run(headers, rows, 'products');
  const by = Object.fromEntries(rep.columns.map((c) => [c.column, c]));
  assert.equal(by.c1.status, 'suggest'); assert.equal(by.c1.best.canon, 'barcode'); assert.equal(by.c1.profile.primary, 'ean');
  assert.equal(by.c2.status, 'suggest'); assert.equal(by.c2.best.canon, 'bodyHtml');
  assert.equal(by.c3.status, 'suggest'); assert.ok(['images', 'variantImage'].includes(by.c3.best.canon));
  assert.equal(by.c5.status, 'suggest'); assert.ok(['price', 'compareAtPrice', 'cost'].includes(by.c5.best.canon));
  assert.equal(by.c4.status, 'none', 'no products field accepts an email');
  for (const c of rep.columns) assert.notEqual(c.status, 'auto', 'value-only evidence must never auto-map');
});

test('profile: price vs integer, bool, enum, uniqueness', () => {
  const p = (vals) => profileValues(vals, config);
  assert.equal(p(['12', '5', '0', '7', '3']).primary, 'int');
  assert.ok(p(['12', '5', '0', '7', '3']).matches.price < 1, 'integers are only a WEAK price');
  assert.equal(p(['12.99', '5.00', '0.5', '7', '3.10']).primary, 'price');
  assert.equal(p(['true', 'false', '1', '0', 'yes']).primary, 'bool');
  const e = p(['active', 'draft', 'active', 'active', 'archived', 'active', 'draft', 'active', 'active', 'active']);
  assert.ok(e.matches.enum, 'low cardinality → enum');
  assert.equal(p(['', '', '']).primary, 'empty');
});

test('structural families and parent references drive context', () => {
  const headers = ['ID', 'Parent', 'Name', 'Image1', 'Image2', 'Attribute 1 name', 'Attribute 1 value', 'Meta: warranty'];
  const rows = rowsOf(headers, [
    ['P1', '', 'Shirt', 'https://x.com/1.jpg', 'https://x.com/1b.jpg', 'Size', 'S | M | L', '2y'],
    ['V1', 'P1', '', '', '', 'Size', 'S', ''],
    ['V2', 'P1', '', '', '', 'Size', 'M', ''],
    ['V3', 'P1', '', '', '', 'Size', 'L', ''],
    ['P2', '', 'Hat', 'https://x.com/2.jpg', '', 'Color', 'Red | Blue', '1y'],
    ['V4', 'P2', '', '', '', 'Color', 'Red', ''],
    ['V5', 'P2', '', '', '', 'Color', 'Blue', ''],
  ]);
  const rep = run(headers, rows, 'products');
  const by = Object.fromEntries(rep.columns.map((c) => [c.column, c]));
  assert.equal(by['Image1'].context.family, 'images'); assert.equal(by['Image1'].best.canon, 'images');
  assert.equal(by['Image2'].best.canon, 'images');
  assert.equal(by['Attribute 1 name'].context.family, 'options'); assert.equal(by['Attribute 1 name'].best.canon, 'options');
  assert.equal(by['Attribute 1 value'].best.canon, 'options');
  assert.equal(by['Meta: warranty'].context.family, 'metafields'); assert.equal(by['Meta: warranty'].best.canon, 'metafields');
  assert.equal(by['Parent'].context.referencesColumn, 'ID', 'Parent values live in ID → reference');
  assert.equal(by['Parent'].best.canon, 'parentRef');
  assert.equal(rep.conflicts.length, 0, 'families may share a canon without conflict');
});

test('Learned decisions: confirmed forces, rejected excludes, ignored drops; family scope applies by glob', () => {
  const headers = ['Prix', 'Libellé', 'Ref', 'Extra'];
  const rows = rowsOf(headers, [['10.00', 'A', 'r1', 'x'], ['12.50', 'B', 'r2', 'y'], ['3.00', 'C', 'r3', 'z']]);
  const fid = 'scraper.demo.abc123.v1';
  const decisions = [
    makeDecision({ formatId: fid, column: 'Prix', action: 'rejected', canon: 'price' }),
    makeDecision({ formatId: fid, column: 'Libellé', action: 'corrected', canon: 'seoTitle' }),
    makeDecision({ formatId: 'scraper.other.v1', column: 'Extra', action: 'ignored', scope: { kind: 'family', pattern: 'scraper.*' } }),
    makeDecision({ formatId: 'nope', column: 'Ref', action: 'ignored', scope: { kind: 'format', id: 'nope' } }), // other format → not applicable
  ];
  const rep = run(headers, rows, 'products', { formatId: fid, decisions });
  const by = Object.fromEntries(rep.columns.map((c) => [c.column, c]));
  assert.ok(!by['Prix'].candidates.some((c) => c.canon === 'price'), 'rejected candidate removed');
  assert.notEqual(by['Prix'].best?.canon, 'price');
  assert.equal(by['Libellé'].status, 'decided'); assert.equal(by['Libellé'].best.canon, 'seoTitle'); assert.equal(by['Libellé'].best.confidence, 'user-corrected');
  assert.equal(by['Extra'].status, 'ignored');
  assert.notEqual(by['Ref'].status, 'ignored');

  const entries = toFieldMapEntries(rep, { catalog, source: 'test' });
  assert.ok(entries.find((e) => e.path === 'Libellé' && e.canon === 'seoTitle' && e.confidence === 'user-corrected'));
  assert.ok(entries.find((e) => e.path === 'Extra' && e.canon === null));
  assert.ok(!entries.find((e) => e.path === 'Prix'), 'suggestions never become knowledge on their own');
});

test('samples: 3 max, distinct, PII redacted, long values truncated', () => {
  const headers = ['Email', 'Note', 'Company'];
  const long = 'x'.repeat(300);
  const rows = rowsOf(headers, [['a@b.com', long, 'T1'], ['c@d.com', long, 'T1'], ['e@f.com', 'short', 'T2'], ['g@h.com', 'other', 'T3'], ['i@j.com', '', 'T4']]);
  const rep = run(headers, rows, 'customers');
  const by = Object.fromEntries(rep.columns.map((c) => [c.column, c]));
  assert.equal(by['Email'].best.canon, 'email');
  assert.ok(by['Email'].best.samples.length <= 3);
  assert.ok(by['Email'].best.samples.every((s) => s.kind === 'redact'), 'email samples are redacted (pii)');
  assert.equal(by['Company'].best.canon, 'company');
  assert.deepEqual(by['Company'].best.samples.map((s) => s.value), ['T1', 'T2', 'T3'], 'distinct, in order, max 3');
  const s = by['Note'].best.samples;
  assert.ok(s.length >= 1 && s.every((x) => x.kind === 'keep' && x.value.length <= config.samples.maxLength + 1), 'long values truncated');
  assert.ok(s[0].truncated);
});

test('tokenize folds FR/EN synonyms and drops stop tokens', () => {
  assert.deepEqual(tokenize('Prix TTC', config), ['price', 'ttc']);
  assert.deepEqual(tokenize('productImageUrl', config), ['image', 'url']);
  assert.deepEqual(tokenize('Quantité en stock', config), ['inventory', 'inventory']);
  assert.deepEqual(tokenize('Image1', config), ['image']);
  assert.deepEqual(tokenize('IMAGE 12', config), ['image']);
});
