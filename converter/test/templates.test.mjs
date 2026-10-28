/**
 * Modèles de correspondance (ÉTAPE 3): CRUD, apply-with-diff, export/import
 * round-trip, migration. Backed by a real JSON file in a temp dir (no Electron).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTemplateStore } from '../app/templates.mjs';

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elo-tpl-'));
  return { store: createTemplateStore(path.join(dir, 'templates.json')), dir };
}

const base = {
  name: 'Mode — FR', direction: 'shopify-to-woocommerce', sourceFormat: 'shopify_products',
  targetFormat: 'woo_products_modern', entity: 'products',
  overrides: { title: { column: 'Libelle' }, vendor: { column: null } },
  headers: ['Handle', 'Libelle', 'Variant Price', 'Vendor'],
};

test('templates: create / list / get / rename / duplicate / remove', () => {
  const { store } = freshStore();
  assert.deepEqual(store.list(), []);
  const t = store.create(base);
  assert.ok(t.id);
  assert.equal(t.rulesVersion >= 1, true);
  assert.deepEqual(t.columnFingerprint, ['Handle', 'Libelle', 'Variant Price', 'Vendor']); // sorted-unique
  assert.equal(store.list().length, 1);

  const r = store.rename(t.id, 'Mode FR v2');
  assert.equal(r.name, 'Mode FR v2');
  assert.equal(store.get(t.id).name, 'Mode FR v2');

  const dup = store.duplicate(t.id);
  assert.equal(dup.name, 'Mode FR v2 (copie)');
  assert.equal(store.list().length, 2);
  assert.notEqual(dup.id, t.id);

  assert.equal(store.remove(t.id), true);
  assert.equal(store.list().length, 1);
  assert.equal(store.remove('nope'), false);
});

test('templates: persistence across store re-open', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elo-tpl-'));
  const file = path.join(dir, 'templates.json');
  const s1 = createTemplateStore(file);
  const t = s1.create(base);
  const s2 = createTemplateStore(file);
  assert.equal(s2.get(t.id).name, 'Mode — FR');
});

test('templates: applyTo reports missing + new columns, no silent failure', () => {
  const { store } = freshStore();
  const t = store.create(base);
  // File missing "Vendor" (in fingerprint) and adds "Extra".
  const res = store.applyTo(t.id, ['Handle', 'Libelle', 'Variant Price', 'Extra']);
  assert.deepEqual(res.overrides, base.overrides);
  assert.deepEqual(res.missingColumns, ['Vendor']);
  assert.deepEqual(res.newColumns, ['Extra']);
  // title override points at "Libelle" which IS present → not flagged.
  assert.equal(res.overridesOnMissing.length, 0);

  // Now a file where the re-pointed column is gone → flagged.
  const res2 = store.applyTo(t.id, ['Handle', 'Variant Price']);
  assert.ok(res2.overridesOnMissing.some((o) => o.field === 'title' && o.column === 'Libelle'));
});

test('templates: export / import round-trip (new id, same overrides)', () => {
  const { store } = freshStore();
  const t = store.create(base);
  const json = store.exportOne(t.id);
  const imported = store.importOne(json);
  assert.notEqual(imported.id, t.id);
  assert.deepEqual(imported.overrides, base.overrides);
  assert.equal(imported.direction, base.direction);
  assert.equal(store.list().length, 2);
});

test('templates: corrupt/missing file → empty list (never throws)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elo-tpl-'));
  const file = path.join(dir, 'templates.json');
  fs.writeFileSync(file, '{ not valid json');
  const store = createTemplateStore(file);
  assert.deepEqual(store.list(), []);
  // and it can still create afterwards (overwrites the corrupt file)
  const t = store.create(base);
  assert.equal(store.list().length, 1);
  assert.ok(t.id);
});

test('templates: old rulesVersion is migrated on load', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elo-tpl-'));
  const file = path.join(dir, 'templates.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, templates: [{ id: 'x', name: 'old', direction: 'shopify-to-woocommerce', rulesVersion: 0, overrides: {}, columnFingerprint: [] }] }));
  const store = createTemplateStore(file);
  const t = store.get('x');
  assert.equal(t.rulesVersion >= 1, true);
  assert.ok(t.migratedAt);
});
