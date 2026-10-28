// A field keeps the name the user typed; its role for the Converter is a separate choice, suggested from the
// name, changed at will, and a resemblance never blocks creating it (shared/extract/field-meaning.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestRole, roleOf, fieldKeys, freeKey, ROLES, ROLE_LABEL, keyOfRole } from '../extract/field-meaning.mjs';
import { buildManifest } from '../export/manifest.mjs';
import { columnRoles } from '../../app/your-browser/panel-requests.mjs';

test('suggested roles: « Nom de variante » is a variant name, not the product title', () => {
  const cases = { 'Nom de variante': 'variant_name', 'Variant name': 'variant_name', Taille: 'size', Pointure: 'size', 'Couleur du produit': 'color', Kleur: 'color', Contenance: 'option', Variantes: 'variants', Garantie: 'attribute', Nom: 'title', 'Prix barré': 'list_price', Marque: 'brand', Collection: 'category', 'Prix par taille': 'price' };
  for (const [label, role] of Object.entries(cases)) assert.equal(suggestRole({ label }), role, label);
  for (const r of ROLES) assert.ok(ROLE_LABEL[r], r);
});

test('a chosen role wins over the name; the name is never changed', () => {
  const fields = [{ key: 'name', label: 'Nom' }, { key: 'x', label: 'Nom de variante' }, { key: 'y', label: 'Tarif TTC', role: 'price' }, { key: 'z', label: 'Nom', role: 'variant_name' }];
  assert.deepEqual(fieldKeys(fields, { name: 'Nom' }), ['name', 'nom_de_variante', 'price', 'nom']);
  assert.equal(roleOf(fields[3]), 'variant_name'); assert.equal(roleOf(fields[1]), 'variant_name'); assert.equal(roleOf(fields[0]), 'title');
  assert.equal(keyOfRole('variant_name'), null); assert.equal(keyOfRole('title'), 'name');
});

test('a new field always gets a free key (no « existe déjà »)', () => {
  const used = new Set(['name', 'nom_de_variante']);
  assert.equal(freeKey('Nom de variante', used), 'nom_de_variante_2');
  assert.equal(freeKey('Garantie', used), 'garantie');
});

test('the role travels: panel → app (validated) → manifest', () => {
  const cols = columnRoles([{ key: 'name', label: 'Nom', role: 'title' }, { key: 'nom_de_variante', label: 'Nom de variante', role: 'variant_name' }, { key: 'bad key!', label: 'x', role: 'title' }, { key: 'z', label: 'Z', role: 'hack' }]);
  assert.deepEqual(cols, [{ key: 'name', label: 'Nom', role: 'title' }, { key: 'nom_de_variante', label: 'Nom de variante', role: 'variant_name' }, { key: 'z', label: 'Z' }]);
  const m = buildManifest({ accepted: true, rows: [], columns: cols });
  assert.deepEqual(m.columns.map((c) => c.role || null), ['title', 'variant_name', null]);
});
