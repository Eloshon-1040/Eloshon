import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA_VERSION, withDefaults, supersedes, EXECUTION_MODES } from '../recipe/schema.mjs';
import { migrateRecipe } from '../recipe/migrate.mjs';

test('withDefaults: fills revision=0, schema_version, maps legacy type->mode', () => {
  const r = withDefaults({ domain: 'x.be', type: 'internal_api' });
  assert.equal(r.revision, 0);
  assert.equal(r.schema_version, SCHEMA_VERSION);
  assert.equal(r.mode, 'internal_api');
});

test('withDefaults: does not clobber an explicit revision/mode', () => {
  const r = withDefaults({ domain: 'x.be', revision: 5, mode: 'dom', type: 'internal_api' });
  assert.equal(r.revision, 5);
  assert.equal(r.mode, 'dom');
});

test('supersedes: strictly-higher revision wins; equal/lower does not; other domain never', () => {
  assert.equal(supersedes({ domain: 'x', revision: 2 }, { domain: 'x', revision: 1 }), true);
  assert.equal(supersedes({ domain: 'x', revision: 1 }, { domain: 'x', revision: 1 }), false);
  assert.equal(supersedes({ domain: 'x', revision: 0 }, { domain: 'x', revision: 3 }), false);
  assert.equal(supersedes({ domain: 'y', revision: 9 }, { domain: 'x', revision: 1 }), false);
  assert.equal(supersedes({ domain: 'x', revision: 1 }, null), true);
  assert.equal(supersedes(null, { domain: 'x', revision: 1 }), false);
});

test('supersedes: absent revision is treated as 0 (legacy always superseded)', () => {
  assert.equal(supersedes({ domain: 'x', revision: 1 }, { domain: 'x' }), true);
});

test('migrateRecipe: 0 -> current for a legacy recipe', () => {
  const { recipe, migrated, fromVersion, toVersion, unknownFuture } = migrateRecipe({ domain: 'x', type: 'internal_api' });
  assert.equal(fromVersion, 0);
  assert.equal(toVersion, SCHEMA_VERSION);
  assert.equal(migrated, true);
  assert.equal(unknownFuture, false);
  assert.equal(recipe.mode, 'internal_api');
  assert.equal(recipe.schema_version, SCHEMA_VERSION);
});

test('migrateRecipe: already-current recipe is not migrated', () => {
  const { migrated, unknownFuture } = migrateRecipe({ domain: 'x', mode: 'dom', schema_version: SCHEMA_VERSION });
  assert.equal(migrated, false);
  assert.equal(unknownFuture, false);
});

test('migrateRecipe: newer-than-known version is flagged, not guessed', () => {
  const { migrated, unknownFuture, fromVersion } = migrateRecipe({ domain: 'x', schema_version: SCHEMA_VERSION + 5 });
  assert.equal(migrated, false);
  assert.equal(unknownFuture, true);
  assert.equal(fromVersion, SCHEMA_VERSION + 5);
});

test('EXECUTION_MODES exposes the documented set', () => {
  assert.deepEqual([...EXECUTION_MODES].sort(), ['actions', 'dom', 'embedded_state', 'internal_api', 'observe_network'].sort());
});
