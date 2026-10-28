/**
 * Shared typedefs + constants for the scraping engine.
 *
 * The engine is store-agnostic: every source funnels through the SAME
 * NormalizedProduct shape already used by the project's CSV import and the
 * `isLunaEligibleProduct` filter (the authority on food eligibility). The
 * scraper NEVER decides eligibility itself and NEVER writes to the DB — it
 * produces NormalizedProduct[] and hands them to the existing pipeline
 * (filter → preview → import), or emits the admin-import CSV.
 *
 * Pure JS (JSDoc types) so it runs under Node with zero dependencies and can
 * import the project's product-eligibility.ts via Node's type-stripping.
 *
 * The NormalizedProduct typedef below matches `toNormalizedProduct`'s ACTUAL
 * runtime output (normalize.mjs) — it is the products.json contract, locked by
 * core/__tests__/products-json-contract.test.mjs and documented for the
 * Converter handoff in converter/docs/phase0-products-json-contract.md.
 *
 * @typedef {Object} NormalizedVariant
 *  One entry of the inline `variants` JSON produced by the embedded-state
 *  extractor (shared/extract/embedded-state.mjs). May describe a SIBLING
 *  product rather than a true variant (the Converter's `siblingsWhen` rule).
 * @property {string=} code
 * @property {('couleur'|'taille'|'autre'|string)=} type
 * @property {string|null=} name
 * @property {number|null=} price
 * @property {string|null=} image
 * @property {string|null=} availability
 * @property {string|null=} url
 *
 * @typedef {Object} RawBag
 *  Rich fields with NO CSV column — JSON-only, preserved verbatim for the
 *  Converter (products.json is the rich handoff; the CSV is the human/Luna
 *  surface).
 * @property {string|null} brand
 * @property {string|null} currency      // currency of `price` when the source said
 * @property {number|null} list_price    // compare-at / "was" price
 * @property {string|null} availability  // stock statement, verbatim
 * @property {string|null} weight_text   // raw contenance text
 * @property {boolean} weight_estimated  // true when weight_kg is an ESTIMATE from a liquid's volume (config "weightEstimate"), not a stated mass
 * @property {number|null} volume_l
 * @property {number|null} pack_count
 * @property {string[]}    breadcrumb    // full path; joined form = source_category
 * @property {string|null} sku
 * @property {string=}     reference     // the product's reference (article code of its colourway / URL) — NOT a SKU; absent when none
 * @property {string|null} mpn
 * @property {string|null} gtin          // verbatim, pre-GS1-validation
 * @property {string=}     extractor     // producing strategy id — several real
 *                                       //  lanes (recipe replay via mapItem,
 *                                       //  extension ingest, card seeds) never
 *                                       //  set raw.strategy, so ON DISK the key
 *                                       //  is absent (undefined drops from JSON)
 * @property {number=}     confidence    // 0..1 — same optionality as extractor
 *
 * @typedef {Object} EligibilityInfo
 *  Attached AFTER normalisation by the engine/controller (never set by
 *  toNormalizedProduct): routes the product between the accepted /
 *  to-verify CSVs and the exclusion list.
 * @property {('accepted'|'to_verify'|'excluded')} status
 * @property {string=} code
 * @property {string=} reason
 * @property {string=} matched
 * @property {boolean=} is_alcoholic
 * @property {boolean=} requires_cold_chain
 *
 * @typedef {Object} NormalizedProduct
 * @property {string|null} store_slug
 * @property {string|null} source_url
 * @property {string|null} source_product_id
 * @property {string|null} source_category
 * @property {string|null} product_type
 * @property {string} name
 * @property {string|null} description
 * @property {string|null} storage_info
 * @property {boolean=} is_alcoholic     // undefined until eligibility decides
 * @property {number|null} price         // charged price; currency in raw.currency
 * @property {number|null} weight_kg
 * @property {string|null} barcode       // GS1-valid GTIN only
 * @property {string|null} hs_code
 * @property {string[]}    images        // FULL ordered list, absolutized (Phase 0); [] when none
 * @property {string|null} image_url     // first raw image absolutized — the CSV's single cell
 * @property {string|null} category_slug
 * @property {string|null} color
 * @property {NormalizedVariant[]|null} variants
 * @property {RawBag} raw
 * @property {EligibilityInfo=} __eligibility
 *
 * @typedef {Object} RawProduct
 *  Intermediate, pre-normalisation shape produced by an extractor. Field names
 *  mirror common e-commerce/JSON-LD vocabulary; unknowns stay null.
 * @property {string|null} name
 * @property {string|null} description
 * @property {number|null} price
 * @property {number|null} listPrice   // "normal" price when a promo exists
 * @property {string|null} currency
 * @property {string|null} availability
 * @property {string|null} gtin        // EAN/UPC/GTIN-8/12/13/14
 * @property {string|null} sku
 * @property {string=}     reference   // article code (colourway productId, URL code) — never a SKU (shared/extract/sku.mjs)
 * @property {string|null} mpn
 * @property {string|null} brand
 * @property {string[]}    images
 * @property {string|null} category
 * @property {string[]}    breadcrumb
 * @property {string|null} weightText  // raw contenance/weight text, e.g. "500 g"
 * @property {string|null} sourceUrl
 * @property {string|null} canonicalUrl
 * @property {string}      strategy    // which extractor produced this
 * @property {number}      confidence  // 0..1
 */

import { resolveDefaultUserAgent } from './user-agent.mjs';

// Realistic desktop-browser User-Agent, overridable per source/profile via
// new Fetcher({ userAgent }). Its Chrome version is READ from the Chromium the app
// ships (core/user-agent.mjs: playwright-core's browsers.json, else the Electron
// runtime) — never written here — so the HTTP lane and the local browser lane name
// the same, current browser. No client hints, no TLS mimicry: only the UA string.
export const DEFAULT_USER_AGENT = resolveDefaultUserAgent().userAgent;

/** Query params that never identify a product and are stripped for dedup. */
export const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'mc_cid', 'mc_eid',
  '_ga', 'ref', 'ref_', 'referrer', 'source', 'igshid', 'yclid', 'dclid',
  's_kwcid', 'cmpid', 'campaign', 'spm',
];

export const EXTRACTOR = {
  JSONLD: 'generic-jsonld',
  JSON: 'generic-json',
  MICRODATA: 'generic-microdata',
  META: 'generic-meta',
  HTML: 'generic-html',
  SHOPIFY: 'adapter-shopify',
  BROWSER: 'browser-playwright',
};
