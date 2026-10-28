/**
 * Provider registry — one descriptor per paid provider. A new provider is a new
 * descriptor (+ a lane), never a rewrite of the panel/store/admin lock.
 *
 * SECRETS HYGIENE: this module resolves credential VALUES only in the main process
 * (via `resolveCredentials`). Everything the renderer may see comes from
 * `maskState`, which returns booleans / sources / field metadata — NEVER a value.
 *
 * Resolution order for a field: secure store → config.json block → env var NAME →
 * field default. The env-NAME fallback preserves today's behaviour.
 *
 * PORTABLE-ish: pure logic; no Electron, no fs. `secure`/`config`/`env` injected.
 */

/** Field spec: { key, label, secret, required, default? }. */
const F = (key, label, { secret = false, required = false, def = undefined } = {}) => ({ key, label, secret, required, default: def });

/** The four providers. `configPath` = where the existing lane reads creds in appCfg. */
export const PROVIDERS = Object.freeze([
  {
    id: 'brightData.webUnlocker',
    label: 'Bright Data — Web Unlocker',
    configPath: 'brightData',
    fields: [
      F('apiKey', 'Clé API', { secret: true, required: true }),
      F('zone', 'Zone', { secret: false, required: false, def: 'mcp_unlocker' }),
    ],
    envNames: { apiKey: ['BRIGHTDATA_API_KEY', 'BRIGHT-DATA-API-KEY'], zone: ['BRIGHTDATA_UNLOCKER_ZONE'] },
    capabilities: ['unlock', 'html'],
    costModel: { type: 'per_request', unit: 'requête', note: 'Facturé par requête réussie.' },
    caps: { maxCallsPerJob: 50, maxCallsPerMonth: 2000 },
    freeCheck: 'format', // no documented free API check → local format check only
  },
  {
    id: 'brightData.scrapingBrowser',
    label: 'Bright Data — Scraping Browser',
    configPath: 'brightData',
    fields: [
      F('browserAuth', 'Auth navigateur (brd-customer-…:…)', { secret: true, required: true }),
    ],
    envNames: { browserAuth: ['BROWSER_AUTH', 'BRD_BROWSER_AUTH'] },
    capabilities: ['browser', 'cdp'],
    // Billed by traffic (~$8/GB). Conservative defaults for a ~$7.47 balance:
    // ~0.5 GB/month cap ≈ $4, and a small per-job byte cap.
    costModel: { type: 'per_gb', unit: 'Go', usdPerGb: 8, note: 'Facturé au trafic (~8 $/Go).' },
    caps: { maxCallsPerJob: 10, maxBytesPerJob: 40 * 1024 * 1024, maxBytesPerMonth: 500 * 1024 * 1024, maxUsdPerMonth: 4 },
    freeCheck: 'format',
  },
  {
    id: 'firecrawl',
    label: 'Firecrawl',
    configPath: 'firecrawl',
    fields: [
      F('apiKey', 'Clé API', { secret: true, required: true }),
    ],
    envNames: { apiKey: ['FIRECRAWL_API_KEY', 'FIRECRAWL-API-KEY'] },
    capabilities: ['browser', 'html', 'markdown', 'wait_selector'],
    costModel: { type: 'credits', unit: 'crédit', note: 'Basé sur des crédits.' },
    caps: { maxCallsPerJob: 30, maxCallsPerMonth: 1000 },
    freeCheck: 'credit_usage', // GET /v2/team/credit-usage is read-only (no scrape)
  },
  {
    id: 'zyte',
    label: 'Zyte API',
    configPath: 'zyte',
    fields: [
      F('apiKey', 'Clé API', { secret: true, required: true }),
    ],
    envNames: { apiKey: ['ZYTE_API_KEY'] },
    capabilities: ['http', 'browser', 'html'],
    // Per successful request; price varies with site difficulty.
    costModel: { type: 'per_request', unit: 'requête', note: 'Par requête réussie; le prix varie selon la difficulté du site.' },
    caps: { maxCallsPerJob: 40, maxCallsPerMonth: 1000 },
    freeCheck: 'format',
  },
]);

export const PROVIDER_IDS = Object.freeze(PROVIDERS.map((p) => p.id));
export const getProvider = (id) => PROVIDERS.find((p) => p.id === id) || null;

const firstEnv = (env, names) => {
  for (const n of (names || [])) { const v = env && env[n]; if (v != null && String(v) !== '') return v; }
  return undefined;
};

/**
 * Resolve one field's VALUE (main process only). Returns { value, source }.
 * source ∈ 'secure' | 'config' | 'env' | 'default' | null.
 */
export function resolveField(provider, field, { secure = {}, config = {}, env = {} } = {}) {
  const sv = secure[provider.id] && secure[provider.id][field.key];
  if (sv != null && String(sv) !== '') return { value: sv, source: 'secure' };
  const cfgBlock = (config && config[provider.configPath]) || {};
  if (cfgBlock[field.key] != null && String(cfgBlock[field.key]) !== '') return { value: cfgBlock[field.key], source: 'config' };
  const ev = firstEnv(env, provider.envNames && provider.envNames[field.key]);
  if (ev !== undefined) return { value: ev, source: 'env' };
  if (field.default !== undefined) return { value: field.default, source: 'default' };
  return { value: null, source: null };
}

/**
 * Resolve ALL credential fields for a provider into a plain value map (main
 * process only — feeds the lane via appCfg). Non-secret defaults included.
 */
export function resolveCredentials(providerId, io = {}) {
  const p = getProvider(providerId); if (!p) return {};
  const out = {};
  for (const f of p.fields) { const { value } = resolveField(p, f, io); if (value != null && value !== '') out[f.key] = value; }
  return out;
}

/** True when every REQUIRED field resolves to a value. */
export function isConfigured(providerId, io = {}) {
  const p = getProvider(providerId); if (!p) return false;
  return p.fields.filter((f) => f.required).every((f) => resolveField(p, f, io).value != null && String(resolveField(p, f, io).value) !== '');
}

/**
 * The ONLY provider credential info the renderer may receive: per-field presence
 * and source, plus a coarse configured/incomplete flag. NO values, ever.
 */
export function maskState(providerId, io = {}) {
  const p = getProvider(providerId); if (!p) return null;
  const fields = p.fields.map((f) => {
    const { source } = resolveField(p, f, io);
    return { key: f.key, label: f.label, secret: f.secret, required: f.required, present: source != null && source !== 'default', source: source || null };
  });
  const requiredPresent = fields.filter((f) => f.required).every((f) => f.present);
  const anyPresent = fields.some((f) => f.present);
  return {
    id: p.id, label: p.label, capabilities: p.capabilities, costModel: p.costModel, freeCheck: p.freeCheck,
    fields,
    configured: requiredPresent,
    incomplete: anyPresent && !requiredPresent,
  };
}
