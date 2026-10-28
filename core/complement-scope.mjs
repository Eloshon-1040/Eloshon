/**
 * Scope of the SITEMAP COMPLEMENT: which whole-site sitemap URLs may stand in for
 * a listing that could not be read (blocked, empty, too few products).
 *
 * The complement used to take any same-site product URL. On a blocked listing
 * that meant off-topic products — a French men's listing returned Dutch
 * football-boot pages, all from the first product sitemap read. A complement URL
 * now has to keep BOTH of the pasted listing's scopes, decided from URL shapes and
 * the sitemap structure only (no site rule, no name):
 *
 *   language — the URL carries the listing's language segment (`/fr/`, `/fr-be/`,
 *              `fr.` host…). A listing WITHOUT one is in the site's unprefixed
 *              branch: a URL with a language segment belongs to another branch.
 *              A URL without a segment matches a prefixed listing only when the
 *              site's item URLs carry no language segment at all.
 *   category — the listing is the whole catalogue (a root word such as /shop,
 *              /products, /collections/all, no facet filter), OR the URL is nested
 *              under the listing's path (/fr/homme/… under /fr/homme), OR the URL
 *              is listed by a sitemap file named after the listing's category
 *              (sitemap-homme.xml for /homme).
 *
 * The entry grid's learned URL pattern (when the listing page was read) is an
 * extra constraint, never a substitute for the category scope.
 *
 * When no URL is in scope the caller reports the listing as blocked / not found
 * instead of returning products that are not part of it.
 */
import { KNOWN_LANG, classifyUrl } from './url-context.mjs';

// Path words that name the whole catalogue, not a category of it (data, generic).
const CATALOGUE_ROOT = new Set([
  'shop', 'store', 'boutique', 'winkel', 'tienda', 'negozio', 'loja', 'sklep', 'webshop', 'eshop', 'e-shop',
  'products', 'product', 'produits', 'produit', 'producten', 'produkte', 'productos', 'prodotti', 'produtos', 'artikel', 'articles', 'items',
  'catalog', 'catalogue', 'catalogus', 'katalog', 'catalogo', 'assortiment', 'sortiment', 'assortment', 'gamme',
  'collections', 'collection', 'categories', 'category', 'categorie', 'categorieen', 'kategorien', 'categorias', 'categorie-prodotti', 'c',
  'all', 'alle', 'tous', 'tout', 'toutes', 'todo', 'todos', 'tutti', 'all-products', 'tous-les-produits', 'toutes-les-categories', 'alle-producten', 'alle-produkte', 'shop-all', 'view-all',
]);
// Query parameters that are not a filter (same spirit as discover.mjs NON_FACET_PARAM).
const NON_FACET = /^(page|p|pg|pagenumber|paged|pageindex|pagenum|pagina|seite|offset|start|from|skip|startindex|begin|size|limit|perpage|per_page|pagesize|page_size|count|rows|take|sort|order|orderby|sortby|sort_by|tri|view|display|mode|layout|affichage|lang|language|locale|hl|gl|currency|cur|country|utm_[a-z]+|gclid|gbraid|wbraid|fbclid|msclkid|mc_cid|mc_eid|ref|ref_|referrer|source|igshid|yclid|dclid|spm|cmpid)$/i;
// A whole path segment that is a language or a language-country locale.
const LOCALE_SEG = /^([a-z]{2})(?:[-_][a-z]{2})?$/i;
const COUNTRY_SEG = /^[a-z]{2}$/i;

const segmentsOf = (pathname) => pathname.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s).toLowerCase(); } catch { return s.toLowerCase(); } });

/**
 * Language of a URL read from a WHOLE path segment or the first host label —
 * never from a word inside a slug ("-de-" in "chaussure-de-sport" is not German).
 * `/BE/fr_BE/` and `/c/fr-BE/` give "fr"; a bare `/fr/` gives "fr" only when it
 * is a known language. Null when the URL carries none.
 * @param {string} url
 * @returns {string|null}
 */
export function urlLanguage(url) {
  let u; try { u = new URL(url); } catch { return null; }
  const segs = segmentsOf(u.pathname);
  for (const s of segs) {
    const m = s.match(LOCALE_SEG);
    if (!m) continue;
    const l = m[1].toLowerCase();
    if (s.length > 2 && KNOWN_LANG.has(l)) return l;                  // fr-be, nl_BE: a locale, wherever it is
  }
  for (const s of segs.slice(0, 2)) if (s.length === 2 && KNOWN_LANG.has(s)) return s;   // /fr/… or /be/fr/…
  const label = u.hostname.split('.')[0].toLowerCase();
  if (u.hostname.split('.').length > 2 && KNOWN_LANG.has(label)) return label;             // fr.shop.com
  return null;
}

/** Path segments that carry no language/locale (and no country right before a language). */
function contentSegments(url) {
  let u; try { u = new URL(url); } catch { return []; }
  const segs = segmentsOf(u.pathname);
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const m = s.match(LOCALE_SEG);
    if (m && KNOWN_LANG.has(m[1].toLowerCase()) && (s.length > 2 || i < 2)) continue;              // the language segment
    if (i === 0 && COUNTRY_SEG.test(s) && segs[1] && LOCALE_SEG.test(segs[1])) continue;           // /BE/fr_BE/…: the country before it
    out.push(i === segs.length - 1 ? s.replace(/\.(html?|php|aspx?|jsp)$/, '') : s);
  }
  return out.filter(Boolean);
}

const tokensOf = (s) => String(s || '').toLowerCase().split(/[^a-z0-9À-ɏ]+/).filter(Boolean);
const hasRun = (hay, needle) => {
  if (!needle.length || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) if (needle.every((t, j) => hay[i + j] === t)) return true;
  return false;
};

/**
 * Build the complement scope of a pasted listing URL.
 * @param {string} startUrl
 * @param {{ urlPattern?:{regexSource:string}|null, siteUrls?:string[] }} [opts]
 *   urlPattern — the entry grid's learned product-URL pattern (extra constraint);
 *   siteUrls — item URLs already seen in the sitemaps (does the site put a
 *   language segment in its item URLs at all?).
 */
export function createComplementScope(startUrl, { urlPattern = null, siteUrls = [] } = {}) {
  const language = urlLanguage(startUrl);
  const siteUsesLanguage = siteUrls.some((u) => urlLanguage(u));
  const category = contentSegments(startUrl);
  let facets = [];
  try { facets = [...new URL(startUrl).searchParams].filter(([k, v]) => v && !NON_FACET.test(k)).map(([k]) => k.toLowerCase()); } catch { /* */ }
  const searchQuery = classifyUrl(startUrl).type === 'search';
  const wholeCatalogue = !facets.length && !searchQuery && category.every((s) => CATALOGUE_ROOT.has(s));
  // The listing's own category slug: its last segment that is a word, not a root word or a bare id.
  const slug = [...category].reverse().find((s) => !CATALOGUE_ROOT.has(s) && /[a-zÀ-ɏ]{3}/.test(s) && !/^\d+$/.test(s)) || null;
  const slugTokens = slug ? tokensOf(slug) : [];
  let patRe = null;
  if (urlPattern && urlPattern.regexSource) { try { patRe = new RegExp(urlPattern.regexSource); } catch { patRe = null; } }

  const languageOk = (u) => {
    const l = urlLanguage(u);
    if (language) return l === language || (!l && !siteUsesLanguage);
    return !l;
  };
  const nested = (u) => {
    if (!category.length) return false;
    const segs = contentSegments(u);
    return segs.length > category.length && category.every((s, i) => segs[i] === s);
  };
  const sitemapNamesCategory = (sitemapUrl) => {
    if (!sitemapUrl || !slugTokens.length) return false;
    let p = ''; try { p = new URL(sitemapUrl).pathname; } catch { return false; }
    return hasRun(tokensOf(p), slugTokens);
  };

  /**
   * @param {string} url
   * @param {string|null} [sitemapUrl]  the sitemap file that listed it
   * @returns {{ ok:boolean, why:'language'|'category'|'pattern'|null }}
   */
  const check = (url, sitemapUrl = null) => {
    if (!languageOk(url)) return { ok: false, why: 'language' };
    if (!(wholeCatalogue || nested(url) || sitemapNamesCategory(sitemapUrl))) return { ok: false, why: 'category' };
    if (patRe) {
      let p = null; try { p = new URL(url).pathname; } catch { p = null; }
      if (!p || !patRe.test(p)) return { ok: false, why: 'pattern' };
    }
    return { ok: true, why: null };
  };

  /** Read order of sitemap files: one named after the category, then the listing's language; another language last. */
  const rankSitemap = (sitemapUrl) => {
    let r = 0;
    if (sitemapNamesCategory(sitemapUrl)) r += 2;
    if (language) {
      const toks = tokensOf((() => { try { return new URL(sitemapUrl).pathname; } catch { return ''; } })());
      const langs = toks.filter((t) => t.length === 2 && KNOWN_LANG.has(t));
      if (langs.includes(language)) r += 1;
      else if (langs.length) r -= 1;
    }
    return r;
  };

  return {
    language, category, wholeCatalogue, slug,
    check, rankSitemap,
    /** Report view (logs/report only). */
    describe: () => ({ language: language || null, category: wholeCatalogue ? 'whole-catalogue' : (category.join('/') || null), slug, pattern: !!patRe }),
  };
}
