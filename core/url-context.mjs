/**
 * URL context — read what the PROVIDED URL already tells us, before any network:
 *   • classifyUrl  → is this a product fiche, a collection/listing, a search
 *     results page, the home page, or unknown? (best-effort from the path)
 *   • detectLocale → country + language embedded in the URL (/BE/fr_BE/, /fr-be/,
 *     a country sub-domain, ?country=/?lang=), so a Belgian-French page yields the
 *     Belgian-French catalogue, not a default-country one.
 *   • normalizeHost / sameSite → treat www and the apex as one site.
 * Pure, no network. Generic — no per-site rules.
 */
import { PRODUCT_RE, LISTING_RE } from './discover.mjs';

const SEARCH_RE = /([?&](q|s|query|search|keyword|k)=)|\/(search|recherche|zoeken|buscar|suche)(\/|\?|$)/i;
// A listing ROOT segment with nothing (or only a page/query) after it.
const LISTING_ROOT = /\/(produits?|products?|shop|boutique|catalogue?|rayon|assortiment|gamme|collections?|categor(?:y|ie|ies|ies))\/?(?:[?#]|$)/i;

/**
 * @param {string} url
 * @returns {{ type:'product'|'collection'|'search'|'home'|'unknown', reason:string }}
 */
export function classifyUrl(url) {
  let u;
  try { u = new URL(url); } catch { return { type: 'unknown', reason: 'unparseable URL' }; }
  const path = u.pathname;
  const full = u.pathname + u.search;
  // Home: empty path, or just a locale segment (/, /fr/, /BE/fr_BE/).
  if (/^\/?$/.test(path) || /^\/[a-z]{2}(?:[-_][a-z]{2})?\/?$/i.test(path) || /^\/[A-Z]{2}\/[a-z]{2}_[A-Z]{2}\/?$/.test(path)) {
    return { type: 'home', reason: 'root or locale-only path' };
  }
  if (SEARCH_RE.test(full)) return { type: 'search', reason: 'search path/param' };
  // A bare listing ROOT (/produits, /products, /shop, /catalogue, /rayon…) with no
  // product slug after it is a collection — checked before PRODUCT_RE so a page
  // like /fr/produits?page=1 is not left "unknown".
  if (LISTING_ROOT.test(path)) return { type: 'collection', reason: 'listing-root segment' };
  if (isNestedCategoryTrail(path)) {
    return { type: 'collection', reason: 'nested category trail under a listing root' };
  }
  // Product markers win over listing (a product slug may contain a category word).
  if (PRODUCT_RE.test(full)) return { type: 'product', reason: 'product URL pattern' };
  if (LISTING_RE.test(full)) return { type: 'collection', reason: 'listing/category URL pattern' };
  return { type: 'unknown', reason: 'no decisive path marker' };
}

/**
 * A PLURAL listing root (/produits/, /products/) followed by a NESTED trail of
 * segments whose terminal carries no digit is a category tree — the colruyt.be
 * shape /fr/produits/toutes-les-categories/boissons — never a fiche. A fiche
 * under a plural root sits ONE segment deep (Shopify /products/<slug>), and an
 * id-carrying terminal slug keeps the product verdict — an id being a run of 3+
 * digits (p100400138, cnk123), never a quantity word inside a category name
 * (bieres-75cl-emballages-cadeaux). Takes a URL or a bare path; also the veto
 * discovery applies before queueing a PRODUCT_RE link as a product.
 */
export function isNestedCategoryTrail(urlOrPath) {
  let path = String(urlOrPath || '');
  try { path = new URL(path).pathname; } catch { /* already a bare path */ }
  const m = path.match(/\/(?:produits|products)\/((?:[^/]+\/)+[^/]+?)\/?$/i);
  if (m && !/\d{3}/.test(m[1].split('/').pop())) return true;
  // A single segment after the plural root whose slug is itself a category
  // INDEX word (/produits/toutes-les-categories, /products/all-categories,
  // /produits/categorieen) is the catalogue root, never a fiche.
  const one = path.match(/\/(?:produits|products)\/([^/]+?)\/?$/i);
  return !!one && /categor/i.test(one[1]);
}

export const KNOWN_LANG = new Set(['fr', 'en', 'nl', 'de', 'es', 'it', 'pt', 'pl', 'da', 'sv', 'fi', 'cs', 'nb', 'no', 'ro', 'hu', 'sk', 'bg', 'hr', 'sl', 'et', 'lt', 'lv', 'el', 'tr', 'ru', 'ja', 'zh', 'ko', 'ar']);

/**
 * @param {string} url
 * @returns {{ country:string|null, language:string|null, source:string|null }}
 *   country upper-case ISO-3166-1 alpha-2, language lower-case ISO-639-1.
 */
export function detectLocale(url) {
  let u;
  try { u = new URL(url); } catch { return { country: null, language: null, source: null }; }
  const path = u.pathname;

  // /BE/fr_BE/ or /BE/fr-BE/  (country/lang_country)
  let m = path.match(/^\/([A-Za-z]{2})\/([a-z]{2})[-_]([A-Za-z]{2})(?:\/|$)/);
  if (m) return { country: m[3].toUpperCase(), language: m[2].toLowerCase(), source: 'URL country+language segment' };

  // /fr_BE/ or /fr-be/  (lang_country)
  m = path.match(/^\/([a-z]{2})[-_]([A-Za-z]{2})(?:\/|$)/i);
  if (m && KNOWN_LANG.has(m[1].toLowerCase())) return { country: m[2].toUpperCase(), language: m[1].toLowerCase(), source: 'URL language-country segment' };

  // lang-country segment ANYWHERE in the path: /c/fr-BE/…, /shop/nl_BE/… (Lidl-style).
  // Anchored patterns above miss it when a routing segment (/c/) comes first.
  m = path.match(/[/_-]([a-z]{2})[-_]([A-Za-z]{2})(?:[/_-]|$)/i);
  if (m && KNOWN_LANG.has(m[1].toLowerCase())) return { country: m[2].toUpperCase(), language: m[1].toLowerCase(), source: 'URL locale segment' };

  // ?country=BE & ?lang=fr / ?locale=fr_BE
  const qc = u.searchParams.get('country') || u.searchParams.get('cc');
  const ql = u.searchParams.get('lang') || u.searchParams.get('language') || u.searchParams.get('locale');
  if (qc || ql) {
    const loc = (ql || '').match(/([a-z]{2})[-_]([A-Za-z]{2})/i);
    return { country: (qc || (loc && loc[2]) || '').toUpperCase() || null, language: ((loc && loc[1]) || ql || '').slice(0, 2).toLowerCase() || null, source: 'URL query parameter' };
  }

  // country sub-domain: be.example.com / fr.example.com (2-letter first label)
  m = u.hostname.match(/^([a-z]{2})\.(?!com\b|net\b|org\b|co\b)/i);
  if (m) {
    const s = m[1].toLowerCase();
    if (KNOWN_LANG.has(s)) return { country: null, language: s, source: 'sub-domain (language)' };
    return { country: s.toUpperCase(), language: null, source: 'sub-domain (country)' };
  }

  // bare leading segment: /fr/ (a language) — report it as a language, clearly.
  m = path.match(/^\/([a-z]{2})(?:\/|$)/i);
  if (m) {
    const s = m[1].toLowerCase();
    if (KNOWN_LANG.has(s)) return { country: null, language: s, source: `language URL segment (/${s}/)` };
  }
  return { country: null, language: null, source: null };
}

/** Host without a leading www. — used to treat www and apex as the same site. */
export function normalizeHost(url) {
  try { return new URL(url).hostname.replace(/^www\./i, '').toLowerCase(); } catch { return ''; }
}

/** True when two URLs belong to the same site (www-insensitive). */
export function sameSite(a, b) {
  const ha = normalizeHost(a); return !!ha && ha === normalizeHost(b);
}
