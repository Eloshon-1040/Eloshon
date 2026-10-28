/**
 * Portable field-mapping + URL/dot-path helpers — the SINGLE source of truth for
 * turning a raw API/JSON item into a partial RawProduct via a recipe's
 * `field_map`. Lifted verbatim (behaviour-preserving) from core/internal-api.mjs
 * so the app and the extension map fields identically; core re-exports from here.
 *
 * PORTABLE: zero Node built-ins; depends only on the portable money parser.
 *
 * A field_map value is either a dot-path string ("price.basicPrice") or a
 * template object ({ template: "https://…/{id}" }) for a field the source does
 * not carry verbatim (e.g. a product URL rebuilt from an id).
 */
import { parseMoney, parseAmount } from './money.mjs';

// Coerce a price to a number when a recipe maps VISIBLE TEXT ("72,90 €",
// "1.299,00") instead of a numeric JSON field — otherwise eligibility drops it
// (Number("72,90 €") is NaN). Returns { price, currency } or nulls; a number
// passes through. Generic: any DOM/recipe price, any locale/currency.
function coerceMoney(v) {
  if (typeof v === 'number') return { price: Number.isFinite(v) ? v : null, currency: null };
  if (typeof v === 'string') {
    const m = parseMoney(v);
    if (m && m.price != null) return { price: m.price, currency: m.currency || null };
    const n = parseAmount(v);
    return { price: (n != null && n > 0 && n < 1e9) ? n : null, currency: null };
  }
  return { price: null, currency: null };
}

/** Read a dot-path (e.g. "price.basicPrice") from a nested object; undefined if absent. */
export function getPath(obj, path) {
  if (!path) return undefined;
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Fill {name} placeholders in a template from a vars map (URL-encoded). Unknown
 *  tokens are left as-is. */
export function fillTemplate(tpl, vars = {}) {
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (k in vars && vars[k] != null ? encodeURIComponent(vars[k]) : m));
}

/** Fill a template from an ITEM (supports hyphenated/dotted keys); an unresolved
 *  token drops the whole value (returns null) so no literal "{…}" leaks into a URL. */
export function fillFromItem(tpl, item) {
  let missing = false;
  const out = String(tpl).replace(/[{]([^{}]+)[}]/g, (m, k) => {
    const v = getPath(item, k.trim());
    if (v == null || v === '' || typeof v === 'object') { missing = true; return m; }
    return encodeURIComponent(String(v));
  });
  return missing ? null : out;
}

/** Case-insensitive header lookup (browsers capture lower-case names). */
export function headerValue(headers, name) {
  if (!headers || name == null) return undefined;
  const want = String(name).toLowerCase();
  for (const k of Object.keys(headers)) if (k.toLowerCase() === want) return headers[k];
  return undefined;
}

/** Replace every occurrence of a secret value in a string with '***'. Never let a
 *  captured header/cookie value survive into a log or an error message. */
export function redactValues(s, values = []) {
  let out = String(s == null ? '' : s);
  for (const v of values) if (v != null && String(v).length >= 4) out = out.split(String(v)).join('***');
  return out;
}

/**
 * Map one raw item to a partial RawProduct via the recipe's field_map. Bridges
 * `url` → sourceUrl/canonicalUrl (absolute only) and singular `image` → images[]
 * exactly as the app expects normalize.mjs to consume.
 * @param {object} item
 * @param {object} fieldMap
 * @param {{strategy?:string}} [opts]
 */
export function mapItem(item, fieldMap = {}, opts = {}) {
  const out = { strategy: opts.strategy || 'internal-api' };
  for (const [field, path] of Object.entries(fieldMap)) {
    const v = (path && typeof path === 'object' && typeof path.template === 'string') ? fillFromItem(path.template, item) : getPath(item, path);
    if (v !== undefined && v !== null && v !== '') out[field] = v;
  }
  if (typeof out.url === 'string' && /^https?:[/][/]/i.test(out.url)) {
    if (out.sourceUrl == null) out.sourceUrl = out.url;
    if (out.canonicalUrl == null) out.canonicalUrl = out.url;
  }
  if (out.images == null && out.image != null) {
    const imgs = Array.isArray(out.image) ? out.image : [out.image];
    const clean = imgs.filter((u) => typeof u === 'string' && u.trim() !== '');
    if (clean.length) out.images = clean;
  }
  delete out.image;
  // A price mapped from visible text is a formatted string — turn it into a number
  // (and recover the currency if the recipe did not map one) so it survives the
  // numeric eligibility check.
  if (typeof out.price === 'string') { const pm = coerceMoney(out.price); if (pm.price != null) { out.price = pm.price; if (pm.currency && out.currency == null) out.currency = pm.currency; } }
  if (typeof out.listPrice === 'string') { const pm = coerceMoney(out.listPrice); if (pm.price != null) out.listPrice = pm.price; }
  return out;
}
