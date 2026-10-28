/**
 * Controller gate — the single, minimal hook that lets the provider runtime
 * (switches / kill / caps / per-domain) govern the existing paid lanes WITHOUT
 * editing each lane's call site. It returns a copy of appCfg in which:
 *   - AVAILABLE providers (runtime.isAvailable === true) get their credentials
 *     resolved (secure store → config → env) and injected into their config block;
 *   - UNAVAILABLE providers have their credential fields withheld, so the existing
 *     `*Config(appCfg).configured` check is false and NO billable call is made.
 *
 * When `runtime` is absent (feature off / nothing configured), it returns the base
 * config unchanged → strictly identical behaviour to today.
 */
import { PROVIDERS, resolveCredentials } from './registry.mjs';

export const LANE_TO_PROVIDER = Object.freeze({
  firecrawl: 'firecrawl',
  'web-unlocker': 'brightData.webUnlocker',
  'scraping-browser': 'brightData.scrapingBrowser',
  zyte: 'zyte',
});
export const providerIdForLane = (name) => LANE_TO_PROVIDER[name] || null;

/**
 * @param {object} baseCfg  the app config (readJson(configFile))
 * @param {{ runtime?, secureStore?, host?:string, env?:object }} io
 * @returns {object} a cfg safe to pass to the existing lane *Config functions
 */
export function buildProviderCfg(baseCfg, { runtime, secureStore, host, env } = {}) {
  if (!runtime) return baseCfg;
  const cfg = JSON.parse(JSON.stringify(baseCfg || {}));
  const resolveIo = { secure: secureStore ? secureStore.getAll() : {}, config: baseCfg || {}, env: env || (typeof process !== 'undefined' ? process.env : {}) };
  for (const p of PROVIDERS) {
    const block = cfg[p.configPath] = { ...(cfg[p.configPath] || {}) };
    if (runtime.isAvailable(p.id, host)) {
      const creds = resolveCredentials(p.id, resolveIo);
      for (const [k, v] of Object.entries(creds)) block[k] = v;
    } else {
      for (const f of p.fields) delete block[f.key]; // withhold → lane sees "not configured" → no call
    }
  }
  return cfg;
}
