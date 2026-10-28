/**
 * Recipe migrations — run on load so a recipe written for an older shape keeps
 * working when the format grows, WITHOUT rewriting stored recipes in place.
 * Migration-safe: each step is pure and idempotent; unknown-future versions are
 * left untouched and flagged by the caller.
 *
 * PORTABLE: zero Node built-ins, zero dependencies.
 */
import { SCHEMA_VERSION, withDefaults } from './schema.mjs';

/**
 * Ordered migration steps. Index i migrates a recipe FROM schema_version i TO
 * i+1. To evolve the format: append a step, bump SCHEMA_VERSION in schema.mjs.
 * Never edit an existing step's output shape (that would rewrite history).
 */
const STEPS = [
  // 0 -> 1: legacy v0.5.9 recipes (`type: "internal_api"`, no schema_version).
  (r) => {
    const out = { ...r };
    if (!out.mode && out.type) out.mode = out.type; // expose `type` as `mode`
    out.schema_version = 1;
    return out;
  },
];

/**
 * Migrate a raw recipe to the current SCHEMA_VERSION.
 * @param {object} raw
 * @returns {{recipe:object, migrated:boolean, fromVersion:number, toVersion:number, unknownFuture:boolean}}
 */
export function migrateRecipe(raw) {
  // Read the ORIGINAL version before withDefaults normalizes it, so an absent
  // schema_version is correctly detected as legacy (0), not silently current.
  const from = Number(raw && raw.schema_version) || 0;
  let r = withDefaults(raw);
  r.schema_version = from;
  if (from > SCHEMA_VERSION) {
    // Written by a newer app; don't guess. Caller surfaces a "please update" message.
    return { recipe: r, migrated: false, fromVersion: from, toVersion: SCHEMA_VERSION, unknownFuture: true };
  }
  let v = from;
  while (v < SCHEMA_VERSION) {
    const step = STEPS[v];
    if (!step) break;
    r = step(r);
    v = Number(r.schema_version) || v + 1;
  }
  return { recipe: r, migrated: v !== from, fromVersion: from, toVersion: v, unknownFuture: false };
}
