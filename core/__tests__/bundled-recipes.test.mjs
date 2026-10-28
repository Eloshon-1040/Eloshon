/**
 * Bundled internal_api recipes as a LOCAL FALLBACK — so Lidl/Colruyt don't
 * collapse to 0 when the shared Supabase sync is unavailable (offline / no
 * licence). Pure + offline: reads the shipped core/recipes/*.json.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundledInternalApiFor, _resetBundledCache } from '../bundled-recipes.mjs';

test('bundledInternalApiFor: ships Lidl and Colruyt internal_api recipes', () => {
  _resetBundledCache();
  const lidl = bundledInternalApiFor('lidl.be');
  assert.ok(lidl && lidl.endpoint_tpl && /lidl\.be/.test(lidl.endpoint_tpl), 'lidl.be recipe present');
  assert.equal(lidl.type, 'internal_api');
  const colruyt = bundledInternalApiFor('www.colruyt.be');
  assert.ok(colruyt && colruyt.endpoint_tpl, 'colruyt.be recipe present (www stripped)');
});

test('bundledInternalApiFor: matches a locale/region subdomain to its parent domain', () => {
  assert.ok(bundledInternalApiFor('nl.lidl.be'), 'nl.lidl.be → lidl.be recipe');
});

test('bundledInternalApiFor: unknown host or empty → null (never a wrong recipe)', () => {
  assert.equal(bundledInternalApiFor('example.com'), null);
  assert.equal(bundledInternalApiFor(''), null);
  assert.equal(bundledInternalApiFor(null), null);
});
