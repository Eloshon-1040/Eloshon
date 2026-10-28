/**
 * Listing extractor — pull the product CARDS a listing/category/search page
 * describes, from the RELIABLE structured sources first (JSON-LD ItemList +
 * standalone Products, and embedded-JSON product arrays: Next/Nuxt/Apollo). This
 * is generic (no merchant selectors), zero-dependency, HTTP-only, and feeds the
 * SAME pipeline: each card is a partial RawProduct used to (a) discover the
 * product URL and (b) seed enrichment when the product fiche is fetched.
 *
 * A card is kept when it has a URL (to fetch/enrich) OR real product data
 * (name + price/gtin/sku). Cards for the same URL from different sources are
 * merged (gap-fill). It never invents data.
 */
import { extractProductsFromJsonLd } from './jsonld.mjs';
import { extractProductsFromEmbeddedJson } from './html-meta.mjs';
import { extractEmbeddedProducts } from './embedded-state.mjs';
import { extractDomGrid } from '../shared/extract/dom-grid.mjs';
import { listingMicrodata } from '../shared/extract/microdata.mjs';
import { absoluteUrl, dedupKey } from './url-utils.mjs';

const empty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);
function gapFill(base, extra) { for (const k of Object.keys(extra)) if (empty(base[k]) && !empty(extra[k])) base[k] = extra[k]; return base; }

/**
 * @param {string} html
 * @param {string} baseUrl  the listing page URL (to resolve relative card URLs)
 * @returns {{ cards: import('./types.mjs').RawProduct[], count: number }}
 */
export function extractListing(html, baseUrl) {
  if (!html || typeof html !== 'string') return { cards: [], count: 0 };
  const byKey = new Map();
  const cards = [];

  const add = (p, fallbackStrategy) => {
    if (!p) return;
    const url = p.canonicalUrl ? absoluteUrl(p.canonicalUrl, baseUrl) : null;
    const hasData = !!(p.name && (p.price != null || p.gtin || p.sku));
    if (!url && !hasData) return; // nothing actionable
    const card = { ...p, sourceUrl: url, canonicalUrl: url, strategy: p.strategy || fallbackStrategy };
    const key = url ? dedupKey(url) : `data:${p.gtin || p.sku || p.name}`;
    const existing = byKey.get(key);
    if (existing) { gapFill(existing, card); return; } // same product from 2 sources → merge
    byKey.set(key, card);
    cards.push(card);
  };

  for (const p of extractProductsFromJsonLd(html) || []) add(p, 'listing-jsonld');
  for (const p of extractProductsFromEmbeddedJson(html) || []) add(p, 'listing-embedded');
  // The SAME generic embedded-state extractor the analysis (probe) uses — so a page
  // whose grid lives in a hydration blob (e.g. brico's products.collection) yields
  // the SAME cards to the scrape as the analysis promised. Fixes the analysis↔scrape
  // divergence at its common root: one extractor, not two.
  for (const p of extractEmbeddedProducts(html, baseUrl).cards || []) add(p, p.strategy || 'listing-embedded-state');
  // Tiles that are each a schema.org microdata Product (none on a product page whose
  // own <h1> sits in a Product item — the other items are its related products).
  for (const p of listingMicrodata(html, baseUrl)) add(p, 'listing-microdata');

  // LAST resort — only if structured data and embedded state yielded nothing: read
  // the rendered grid by structure (generic DOM heuristic, no per-site selector).
  if (!cards.length) { for (const p of extractDomGrid(html, baseUrl).cards || []) add(p, p.strategy || 'listing-dom-grid'); }

  return { cards, count: cards.length };
}
