/**
 * Extraction orchestrator. Tries strategies in priority order and MERGES them
 * so a strong source (JSON-LD) provides the core and weaker sources (meta,
 * microdata, <title>) only fill gaps:
 *
 *   1. JSON-LD Product        (best)
 *   2. microdata (itemprop)
 *   3. OpenGraph / product meta
 *   4. <title> / canonical     (last resort)
 *
 * Returns a RawProduct plus `needsBrowser` when the initial HTML looks like an
 * unrendered SPA shell. Never calls the network; operate on an HTML string.
 */
import { extractProductFromJsonLd } from './jsonld.mjs';
import { extractFromMeta, extractFromMicrodata, extractProductFromEmbeddedJson, extractBreadcrumbFromDom, titleOf, canonicalOf, needsBrowser, cleanText } from './html-meta.mjs';
import { extractFromDom, extractDescriptionFromDom, extractSpecsFromDom, weightFromUnitPrice, fieldsFromSpecPairs } from './dom-fallback.mjs';
import { weightFromName } from './weight.mjs';
import { extractProductGroup, matchColourway, mergeColourway, pageJsonPayloads } from '../shared/extract/product-group.mjs';
import { specsFromState, specsFromHtml, dedupeSpecs } from '../shared/extract/specs.mjs';
import { parseHTML } from 'linkedom';
import { descriptionFromLabelledBlock, specsFromLabelledBlock } from '../shared/knowledge/labelled-blocks.mjs';
import { stateTextFor } from '../shared/knowledge/state-values.mjs';
import { mergeImageSources, imageUrls } from '../shared/extract/images.mjs';
import { readGallery } from '../shared/extract/gallery.mjs';
import { absoluteUrl, cleanUrl } from './url-utils.mjs';

const pick = (...vals) => { for (const v of vals) if (v != null && v !== '') return v; return null; };
/** The number that ends a product URL's path ("…-2232378.html" → "2232378"), a common product id. */
const trailingId = (u) => { try { const m = new URL(u).pathname.match(/(\d{4,})(?:\.[a-z]{2,5})?\/?$/i); return m ? m[1] : null; } catch { return null; } };
/**
 * The product's canonical address: <link rel=canonical>, else og:url, else the JSON-LD / state `url`, else
 * the visited address — absolute (resolved against the page), without tracking parameters, locale kept.
 * @returns {{ url:string|null, source:string|null }}
 */
export function canonicalProductUrl({ canonical = null, ogUrl = null, declared = null, visited = null } = {}) {
  const base = visited || undefined;
  for (const [source, raw] of [['canonical', canonical], ['og:url', ogUrl], ['declared', declared], ['visited', visited]]) {
    const abs = raw ? absoluteUrl(String(raw).trim(), base) : null;
    if (!abs || !/^https?:/i.test(abs)) continue;
    return { url: cleanUrl(abs), source };
  }
  return { url: null, source: null };
}
// Multi-signal confidence: the more coherent product signals a fiche carries, the
// higher the score — so a product with a name, price, image, GTIN, brand and a
// structured source is trusted far more than a bare name+link. Weights sum to >1
// (capped) so a rich fiche saturates. Used for review/observability, not
// eligibility (which decides purely on name/identity/price).
function scoreConfidence(p, hasStructured) {
  let s = 0.05;
  if (p.name) s += 0.18;
  if (p.price != null) s += 0.20;
  if ((p.images || []).length) s += 0.12;
  if (p.gtin) s += 0.14;
  if (p.sku) s += 0.08;
  if (p.brand) s += 0.08;
  if (cleanText(p.description)) s += 0.07;
  if (p.category || (p.breadcrumb || []).length) s += 0.06;
  if (p.canonicalUrl) s += 0.04;
  if (hasStructured) s += 0.10;
  return Math.min(1, Math.round(s * 100) / 100);
}

/**
 * @param {string} html
 * @param {string} sourceUrl  final URL of the page (for relative-image + fallback id)
 * @returns {{ product: import('./types.mjs').RawProduct|null, needsBrowser: boolean, strategies: string[] }}
 */
export function extractProduct(html, sourceUrl) {
  const strategies = [];
  const jsonld = extractProductFromJsonLd(html);
  if (jsonld) strategies.push('generic-jsonld');
  const micro = extractFromMicrodata(html);
  if (micro) strategies.push('generic-microdata');
  const meta = extractFromMeta(html);
  if (meta?.name) strategies.push('generic-meta');
  // Embedded JSON (Next/Nuxt/Apollo/SSR hydration) — a GAP-FILLER, not a fallback.
  // It runs whenever the structured sources above did not already deliver a RICH
  // fiche (a JSON-LD with name+price+gtin+image), so a page that extracts name+
  // price from weak microdata still gets brand/gtin/weight/category/image from a
  // hydration blob. A truly rich JSON-LD skips it (perf: no need to parse a large
  // blob). Priority order below keeps structured data authoritative; embedded
  // only fills what is still empty.
  const richJsonld = !!(jsonld?.name && jsonld.price != null && jsonld.gtin && jsonld.images?.length);
  const embedded = richJsonld ? null : extractProductFromEmbeddedJson(html);
  if (embedded?.name) strategies.push('generic-embedded-json');

  // Last resort: generic DOM/text extraction for pages with NO structured price.
  // Only when no source above yielded a usable name+price; conservative + low
  // confidence, so it never overrides structured extraction (see dom-fallback).
  const haveUsable = (jsonld?.name && jsonld.price != null)
    || (micro?.name && micro.price != null)
    || (meta?.name && meta.price != null)
    || (embedded?.name && embedded.price != null);
  const dom = haveUsable ? null : extractFromDom(html);
  if (dom && (dom.name || dom.price != null)) strategies.push('generic-dom');

  // Labeled DOM spec fields (EAN/GTIN, weight/contenance, brand, reference/SKU,
  // category) from data sheets / spec tables / definition lists — the fields most
  // often absent from structured data. Gap-filler only, lowest priority.
  const specs = extractSpecsFromDom(html);
  if (specs.gtin || specs.weightText || specs.brand || specs.sku || specs.category) strategies.push('generic-dom-specs');

  // Description: prefer structured sources; if none has a usable one, look for a
  // description section in the DOM (e.g. Lidl "Productbeschrijving", Colruyt
  // "Description du produit") so real descriptions are not lost.
  const structuredDescription = pick(jsonld?.description, micro?.description, embedded?.description);
  let description = pick(structuredDescription, meta?.description);
  // The page's DOM, parsed once and only when a gap has to be filled from it.
  let domDoc = null; const pageDoc = () => domDoc || (domDoc = parseHTML(html).document);
  // No structured description (only a <meta> snippet, or nothing): the block the page labels
  // "Description" (a tab, an accordion, a heading) — whole, with its paragraphs — when it says more.
  let richText = false;
  if (!cleanText(structuredDescription)) {
    try {
      const block = descriptionFromLabelledBlock(pageDoc(), { name: pick(jsonld?.name, micro?.name, meta?.name, embedded?.name) || '' });
      const have = cleanText(description);
      if (block && (!have || block.length > have.length * 1.3)) { description = block; richText = true; }
    } catch { /* gap-filler only */ }
  }
  if (!cleanText(description)) { const d = extractDescriptionFromDom(html); if (d) description = d; }

  const canonical = canonicalOf(html);
  const anyName = jsonld?.name || micro?.name || meta?.name || embedded?.name || dom?.name || titleOf(html);

  // If nothing at all resolved and the shell looks unrendered → defer to browser.
  const nb = needsBrowser(html);
  if (!anyName) return { product: null, needsBrowser: nb, strategies };

  const base = jsonld || {};
  // Per-field fusion: for EACH field, take the best available value across ALL
  // sources in priority order (structured → embedded → labeled DOM specs →
  // derived). No single extractor "wins" the whole fiche.
  const name = pick(base.name, micro?.name, meta?.name, embedded?.name, dom?.name, titleOf(html));
  // The page's JSON payloads, parsed ONCE: technical specs + product group below.
  let payloads = { json: [], jsonLd: [] };
  try { payloads = pageJsonPayloads(html); } catch { /* none */ }
  // Technical specifications (JSON-LD additionalProperty, embedded state groups of THIS
  // product, else the page's label/value rows), and the known fields they carry.
  const productIds = [pick(base.sku, micro?.sku, embedded?.sku, specs.sku), pick(base.gtin, micro?.gtin, embedded?.gtin, specs.gtin), pick(base.mpn, micro?.mpn, embedded?.mpn), trailingId(pick(base.canonicalUrl, canonical, sourceUrl))].filter(Boolean);
  // The shop's own long description kept in the page state for THIS product (the page builds the
  // block in the browser), when the structured one is only a short snippet ("Commande le … chez …").
  try {
    const st = stateTextFor(payloads.json, { productIds, minLen: 120 });
    const have = cleanText(description) || '';
    const structuredLen = (cleanText(structuredDescription) || '').length;
    if (st && st.text.length > have.length * 1.6 && structuredLen < 400) { description = st.text; richText = true; strategies.push('generic-state-description'); }
  } catch { /* gap-filler only */ }
  let specList = [];
  try {
    const fromState = []; for (const s of payloads.json) fromState.push(...specsFromState(s, { productIds }));
    specList = dedupeSpecs([...(base.specs || []), ...fromState]);
    // The block the page labels "Caractéristiques techniques" (tab, accordion, heading), as pairs,
    // before any table of the page: a size chart or a shipping table is not the specifications.
    if (!specList.length) { try { specList = dedupeSpecs(specsFromLabelledBlock(pageDoc())); } catch { specList = []; } }
    if (!specList.length) specList = dedupeSpecs(specsFromHtml(html));
  } catch { specList = []; }
  if (specList.length) strategies.push('generic-specs');
  const specFields = fieldsFromSpecPairs(specList);
  let weightText = pick(base.weightText, micro?.weightText, embedded?.weightText, specs.weightText, specFields.weightText);
  if (!weightText) weightText = weightFromUnitPrice(html);   // grocery net qty from "150 g - 11,93 €/kg"
  if (!weightText) weightText = weightFromName(name);
  // The canonical address (link[rel=canonical] → og:url → declared url → visited), tracking parameters dropped.
  const canon = canonicalProductUrl({ canonical, ogUrl: meta?.ogUrl, declared: pick(base.canonicalUrl, embedded?.canonicalUrl), visited: sourceUrl });
  // Pictures, by source reliability: JSON-LD, microdata, og:image, the page's gallery (every picture in its
  // largest size: srcset / zoom / lazy attributes), the embedded state — one image per picture, the main
  // picture first. What is not a usable address is listed (never exported silently).
  let gallery = [];
  try { gallery = readGallery(pageDoc(), { pageUrl: canon.url || sourceUrl || null, seeds: imageUrls([...(base.images || []), ...((micro && micro.images) || []), ...((meta && meta.images) || [])]), name: name || '' }); } catch { gallery = []; }
  const merged = mergeImageSources([
    { source: 'jsonld', items: base.images || [] }, { source: 'microdata', items: (micro && micro.images) || [] }, { source: 'og', items: (meta && meta.images) || [] },
    { source: 'dom', items: gallery }, { source: 'state', items: (embedded && embedded.images) || [] },
  ], { base: canon.url || sourceUrl || null });
  /** @type {import('./types.mjs').RawProduct} */
  const product = {
    name,
    description,
    ...(richText ? { richText: true } : {}),
    price: pick(base.price, micro?.price, meta?.price, embedded?.price, dom?.price),
    listPrice: pick(base.listPrice, embedded?.listPrice, micro?.listPrice),
    currency: pick(base.currency, micro?.currency, meta?.currency, embedded?.currency, dom?.currency),
    availability: pick(base.availability, micro?.availability, meta?.availability, embedded?.availability),
    rating: pick(base.rating, micro?.rating, embedded?.rating),
    reviewCount: pick(base.reviewCount, micro?.reviewCount, embedded?.reviewCount),
    gtin: pick(base.gtin, micro?.gtin, embedded?.gtin, specs.gtin, specFields.gtin),
    sku: pick(base.sku, micro?.sku, embedded?.sku, specs.sku, specFields.sku),
    mpn: pick(base.mpn, micro?.mpn, embedded?.mpn, specs.mpn, specFields.mpn),
    brand: pick(base.brand, micro?.brand, meta?.brand, embedded?.brand, specs.brand, specFields.brand),
    images: imageUrls(merged.images),
    ...(merged.rejected.length ? { imagesRejected: merged.rejected.slice(0, 20) } : {}),
    imageSources: merged.bySource,
    category: pick(base.category, micro?.category, embedded?.category, specs.category),
    // Breadcrumb → source_category downstream. JSON-LD BreadcrumbList first;
    // otherwise a microdata BreadcrumbList (SSR sites with no JSON-LD).
    breadcrumb: (base.breadcrumb && base.breadcrumb.length) ? base.breadcrumb : extractBreadcrumbFromDom(html),
    weightText,
    ...(specList.length ? { specs: specList } : {}),
    sourceUrl,
    canonicalUrl: canon.url || pick(base.canonicalUrl, embedded?.canonicalUrl, canonical),
    canonicalSource: canon.source,
    strategy: strategies[0] || 'generic-html',
    confidence: 0,
  };
  // Product GROUP (colourway + sizes + EAN + gallery) from the page's embedded JSON
  // or JSON-LD ProductGroup — gap-filler, generic by shape. The colourway is the
  // one this URL / SKU points at (option A: this row = this colourway); a page
  // whose colourway cannot be identified gets nothing from the group.
  try {
    const group = extractProductGroup(html, { payloads });
    if (group.colourways.length) {
      let cw = matchColourway(group, { sku: product.sku, url: sourceUrl });
      if (!cw && group.selected) cw = group.colourways.find((c) => c.code === group.selected) || null;
      if (cw) {
        const weakDescription = !cleanText(pick(jsonld?.description, micro?.description, embedded?.description));
        if (mergeColourway(product, cw, { weakDescription }).length) strategies.push('generic-product-group');
        // The colourway's code (`productId`, the article code in its URL) is the product's REFERENCE, not a SKU
        // the page declares: it travels as `reference` and the user decides to use it as SKU (shared/extract/sku.mjs).
        if (!product.reference && cw.code && cw.code !== product.sku) product.reference = cw.code;
        // The colourway's gallery joined the row's pictures: one image per picture again, the largest size kept.
        const again = mergeImageSources([{ source: 'state', items: product.images }], { base: canon.url || sourceUrl || null });
        product.images = imageUrls(again.images);
      }
    }
  } catch { /* gap-filler only */ }
  product.confidence = scoreConfidence(product, !!(jsonld || micro || embedded));
  return { product, needsBrowser: false, strategies };
}
