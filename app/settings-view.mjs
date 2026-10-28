/**
 * What the RENDERER may see of config.json (and send back through settings:set):
 * the user's own settings only. Paid-provider blocks, keys, opt-in lists, cost
 * settings and usage counters are owner data — they reach the renderer only
 * through the admin-gated IPC, so an ordinary user never sees a provider name,
 * a credit or a cost (not even in the devtools).
 */
export const PRIVATE_KEYS = Object.freeze(['providers', 'firecrawl', 'brightData', 'zyte', 'ai', 'costs', 'scrapfly', 'oxylabs']);
const SECRETISH = /(api[_-]?key|secret|token|password|passwd|browserAuth)/i;

export function publicSettings(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return {};
  const out = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (PRIVATE_KEYS.includes(k) || SECRETISH.test(k)) continue;
    out[k] = v;
  }
  return out;
}
