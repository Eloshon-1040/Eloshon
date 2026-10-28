import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateActions } from '../dsl/validate.mjs';
import { DSL_VERSION } from '../dsl/schema.mjs';

const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r.errors)); };
const failsAt = (r, pathIncludes) => {
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path.includes(pathIncludes)), `expected an error at ${pathIncludes}, got ${JSON.stringify(r.errors)}`);
};

test('valid program: list extract -> paginate -> follow links', () => {
  ok(validateActions([
    { op: 'waitFor', selector: '.product-card', timeout_ms: 8000 },
    { op: 'extract', using: 'embedded_state', json_path: 'products' },
    { op: 'paginate', style: 'url_param', param: 'page', max_pages: 3 },
    { op: 'followLinks', url_field: 'url', max_links: 5 },
  ]));
});

test('non-array program is rejected in French', () => {
  const r = validateActions({});
  failsAt(r, 'actions');
  assert.match(r.errors[0].message, /liste/);
});

test('unknown op lists valid ops', () => {
  const r = validateActions([{ op: 'teleport' }]);
  failsAt(r, 'actions[0].op');
  assert.match(r.errors.find((e) => e.path.endsWith('.op')).message, /inconnue/);
});

test('missing required param reported with French op label', () => {
  const r = validateActions([{ op: 'click' }]); // selector required
  failsAt(r, 'actions[0].selector');
  assert.match(r.errors[0].message, /cliquer/);
});

test('anyOf enforced: waitFor needs selector|url_includes|state_key', () => {
  failsAt(validateActions([{ op: 'waitFor', timeout_ms: 1000 }]), 'actions[0]');
});

test('anyOf satisfied by one member', () => {
  ok(validateActions([{ op: 'waitFor', url_includes: '/list' }]));
});

test('enum enforced on paginate.style', () => {
  failsAt(validateActions([{ op: 'paginate', style: 'telepathy' }]), 'actions[0].style');
});

test('type check: timeout_ms must be integer', () => {
  failsAt(validateActions([{ op: 'waitFor', selector: '.x', timeout_ms: '8000' }]), 'actions[0].timeout_ms');
});

test('unknown param flagged', () => {
  failsAt(validateActions([{ op: 'click', selector: '.x', frobnicate: true }]), 'actions[0].frobnicate');
});

test('empty program is flagged', () => {
  failsAt(validateActions([]), 'actions');
});

test('future dsl_version is refused with an update message', () => {
  const r = validateActions([{ op: 'click', selector: '.x' }], { dsl_version: DSL_VERSION + 1 });
  failsAt(r, 'dsl_version');
  assert.match(r.errors[0].message, /Mettez à jour/);
});

test('type action requires value or value_from (never a hardcoded secret path)', () => {
  failsAt(validateActions([{ op: 'type', selector: '#q' }]), 'actions[0]');
  ok(validateActions([{ op: 'type', selector: '#q', value_from: 'searchTerm' }]));
});
