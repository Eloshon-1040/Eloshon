/**
 * "Why did this page yield 0 products?" — a generic, evidence-based diagnosis so a
 * zero-product run is never a dead end. Given the page's rendered HTML, it reports
 * which machine-readable data the page actually carried and classifies the empty
 * result into ONE actionable category. Both engines can use it; the "your browser"
 * tier attaches it to the report so a failed run states the real reason.
 *
 * GENERIC: no site names. It reuses the shared page signals (schema.org / prices /
 * add-to-cart / URL) and the shared embedded-state extractor, then reasons about
 * the counts. PORTABLE: zero Node built-ins, zero new dependencies.
 *
 * Categories (reasonCode):
 *   likely_block        — the page barely rendered (tiny body, no data, no prices):
 *                         a bot-shell / interstitial the challenge detector didn't
 *                         catch, or the user's session isn't logged in.
 *   unreadable_data     — the page DID carry product data (embedded JSON and/or
 *                         schema.org Product) yet extraction produced nothing: a
 *                         real extractor/mapping gap, not a block — the highest-value
 *                         signal, because it is fixable in our own code.
 *   no_machine_data     — a real listing rendered (many prices) but exposes NO
 *                         machine-readable product data (no embedded JSON, no
 *                         Product schema): only a DOM/visual heuristic or a paid
 *                         extraction fallback could read it.
 *   not_a_listing       — the page is a home / editorial / account / search page,
 *                         or an error page — not a product grid at all (wrong URL).
 *   empty_listing       — looks like a listing but is genuinely empty (0 results,
 *                         filtered to nothing, out of stock).
 */

import { pageSignals } from './page-kind.mjs';
import { extractEmbeddedProducts } from '../extract/embedded-state.mjs';

// URL path segments that mean "this IS a listing / category / search page" — a
// page that legitimately holds a product grid. A `/c/` category (Hybris/SAP, e.g.
// Levi's), `/collection/`, `/search`, `/shop`, `/rayon`… are LISTINGS: extracting
// 0 products there is a grid-read failure, NOT "this is not a listing".
const LISTING_SEGMENTS = new Set(['c', 'cat', 'category', 'categories', 'categorie', 'categorieen', 'kategorie', 'kategorien', 'categoria', 'categorias', 'collection', 'collections', 'search', 'recherche', 'zoeken', 'suche', 'buscar', 'cerca', 'shop', 'boutique', 'catalog', 'catalogue', 'rayon', 'assortiment', 'gamme', 'plp']);
// URL path segments of pages that are genuinely NOT a product listing at all —
// account/cart/editorial/help/legal/store-locator. A 0-product run here means the
// user pasted the wrong kind of page.
const NON_LISTING_SEGMENTS = new Set(['cart', 'panier', 'basket', 'winkelwagen', 'warenkorb', 'carrito', 'checkout', 'caisse', 'kassa', 'kasse', 'account', 'compte', 'mon-compte', 'login', 'signin', 'sign-in', 'register', 'inscription', 'wishlist', 'favoris', 'favorites', 'blog', 'magazine', 'inspiration', 'inspiratie', 'news', 'actualites', 'guides', 'conseils', 'help', 'aide', 'faq', 'contact', 'service', 'services', 'legal', 'mentions-legales', 'cgv', 'privacy', 'cookies', 'newsletter', 'stores', 'magasins', 'store-locator', 'winkels', 'filialen']);
function urlSegments(url) { try { return new URL(url).pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s).toLowerCase()); } catch { return []; } }
const looksLikeListingUrl = (url) => urlSegments(url).some((s) => LISTING_SEGMENTS.has(s));
const hasNonListingSegment = (url) => urlSegments(url).some((s) => NON_LISTING_SEGMENTS.has(s));

const clip = (s, n = 120) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) : t; };

// Visible-text length: the real "did the page render?" signal. A bot-shell /
// interstitial can have a large HTML body (inline scripts) yet almost no visible
// text; a fully-rendered listing — even an empty one — carries real chrome text
// (nav, footer, a "no results" line). Strip scripts/styles/tags, then measure.
function visibleTextLength(html) {
  return String(html || '')
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
}
const SHELL_TEXT_MAX = 500; // below this many visible chars: the page barely rendered

/**
 * @param {string} html   the page's rendered outerHTML
 * @param {{url?:string, status?:number|null, rules?:object}} [opts]
 * @returns {{
 *   reasonCode:string, bodyBytes:number, priceTokens:number, addToCart:number,
 *   embeddedProducts:number, productSchema:number, microdataProducts:number,
 *   hasStructuredData:boolean, hasEmbeddedData:boolean, pageKind:string, title:string|null
 * }}
 */
export function emptyPageDiagnosis(html, { url = '', status = null, rules } = {}) {
  const body = String(html || '');
  const bodyBytes = body.length;
  const textLen = visibleTextLength(body);
  const sig = pageSignals(body, { url, status, rules });
  let embeddedProducts = 0;
  try { embeddedProducts = (extractEmbeddedProducts(body, url || 'https://example.invalid/').cards || []).length; } catch { embeddedProducts = 0; }

  const productSchema = sig.productSchemaCount || 0;
  const microdataProducts = sig.microdataProducts || 0;
  const hasStructuredData = productSchema > 0 || microdataProducts > 0 || !!sig.listingType || (sig.itemListSize || 0) > 0;
  const hasEmbeddedData = embeddedProducts > 0;
  const priceTokens = sig.priceCount || 0;

  let reasonCode;
  if (hasEmbeddedData || productSchema > 0 || microdataProducts > 0) {
    // The page carried real product data yet we extracted nothing — our gap.
    reasonCode = 'unreadable_data';
  } else if (sig.soft404 || status === 404 || status === 410) {
    reasonCode = 'not_a_listing';
  } else if (textLen < SHELL_TEXT_MAX && priceTokens === 0 && !hasStructuredData) {
    // Barely-rendered shell with no data and no prices → a block/interstitial or
    // a login-gated page, not a page we simply failed to parse.
    reasonCode = 'likely_block';
  } else if (!looksLikeListingUrl(url) && (sig.isHome || hasNonListingSegment(url) || (sig.ogType && /^(website|article|blog|profile)$/.test(sig.ogType)))) {
    // Genuinely not a listing (home / account / editorial). A category/collection/
    // search URL (looksLikeListingUrl) is EXEMPT: a `/c/` page IS a listing, so 0
    // products there is a grid-read failure, never "not a listing".
    reasonCode = 'not_a_listing';
  } else if (priceTokens >= 2) {
    // A real listing rendered (prices on screen) but nothing machine-readable to
    // extract — needs a DOM/visual heuristic or a paid extraction fallback.
    reasonCode = 'no_machine_data';
  } else {
    // Rendered fully, no prices, no data, no listing signals → an empty result set.
    reasonCode = 'empty_listing';
  }

  return {
    reasonCode, bodyBytes, textLen, priceTokens, addToCart: sig.addToCart || 0,
    embeddedProducts, productSchema, microdataProducts,
    hasStructuredData, hasEmbeddedData,
    pageKind: sig.listingType ? 'listing' : (sig.isHome ? 'home' : (sig.soft404 ? 'not_found' : 'other')),
    title: clip(sig.title || sig.h1 || sig.ogTitle) || null,
  };
}

/** Plain-French, non-technical one-liner for each diagnosis category (user-facing). */
export const EMPTY_DIAGNOSIS_TEXT = Object.freeze({
  likely_block: 'la page ne s’est pas chargée normalement (site protégé ou session non connectée)',
  unreadable_data: 'la page contient des produits mais leur format n’a pas pu être lu',
  no_machine_data: 'la page affiche des produits mais sans données exploitables automatiquement',
  not_a_listing: 'cette adresse n’est pas une page catégorie (utilisez une page de liste de produits du site)',
  empty_listing: 'la page de liste ne contient aucun produit',
  // Grid rendered by an external search engine (Sensefuel/Algolia/Constructor.io…):
  // its product call does not complete during an automated read — offer AI assist.
  saas_search_grid: 'ce catalogue est affiché par un moteur de recherche externe (JavaScript) qui ne se charge pas en lecture directe — essayez l’assistance IA pour cette page',
});
