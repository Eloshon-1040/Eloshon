/**
 * Bundled internal_api recipes (core/recipes/*.json) as a LOCAL FALLBACK.
 *
 * The shared Supabase sync is the primary source, but it needs a licence/network
 * context; without it (offline, no licence, a fresh install) the app's best-known
 * sites — Lidl, Colruyt — had no recipe at all and collapsed to the browser lane
 * → 0 products. These JSON files ship with the app and ARE exactly the
 * internal_api recipe shape the domain profile stores, so loading them locally
 * when the shared sync yields nothing restores those sites for free. Shared always
 * wins when available (this is only consulted when no internal_api is present);
 * the recipe still goes through the normal lifecycle (replay + outcome recording).
 *
 * Pure + offline: reads the bundled dir once, keyed by the recipe's `domain`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('./recipes/', import.meta.url));
let _cache = null;

function all() {
  if (_cache) return _cache;
  _cache = {};
  try {
    for (const f of fs.readdirSync(DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const r = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
        if (r && r.domain && r.endpoint_tpl) _cache[String(r.domain).toLowerCase().replace(/^www\./, '')] = r;
      } catch { /* skip a malformed file */ }
    }
  } catch { /* no bundled dir (unexpected) → empty map */ }
  return _cache;
}

/**
 * The bundled internal_api recipe for a host, or null. Matches the registrable
 * host against the recipe's `domain` (and its parent, so `nl.lidl.be` → `lidl.be`).
 * @param {string} host  a hostname (any case, with/without www)
 * @returns {object|null}
 */
export function bundledInternalApiFor(host) {
  if (!host) return null;
  const map = all();
  const h = String(host).toLowerCase().replace(/^www\./, '');
  if (map[h]) return map[h];
  const parts = h.split('.');
  for (let i = 1; i < parts.length - 1; i++) { const parent = parts.slice(i).join('.'); if (map[parent]) return map[parent]; }
  return null;
}

/** Reset the cache (tests only). */
export function _resetBundledCache() { _cache = null; }
