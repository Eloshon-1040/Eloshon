// The step-3 choice of where each « case personnalisée » goes, per target platform ({ shopify: { taille: 'tags' }, … }),
// as stored in config.json and sent with every conversion. Validated here: known platforms and places only
// (core/src/custom-fields.ts CUSTOM_CHOICES), field keys as the engine makes them, bounded.
import { CUSTOM_CHOICES } from '../core/dist/index.mjs';

const KEY = /^[a-z0-9_]{1,40}$/;
const MAX_KEYS = 200;

/** @returns {Record<string, Record<string, string>>} */
export function sanitizeCustomTargets(v) {
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [target, choices] of Object.entries(v)) {
    const offered = CUSTOM_CHOICES[target];
    if (!offered || !choices || typeof choices !== 'object' || Array.isArray(choices)) continue;
    const kept = {};
    for (const [key, place] of Object.entries(choices).slice(0, MAX_KEYS)) if (KEY.test(key) && offered.includes(place)) kept[key] = place;
    if (Object.keys(kept).length) out[target] = kept;
  }
  return out;
}
