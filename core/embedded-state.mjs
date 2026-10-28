/**
 * Embedded product-state extractor (A1 "état intégré").
 *
 * The implementation now lives in shared/extract/embedded-state.mjs — the SINGLE
 * source of truth shared with the "your browser" extension tier (one extractor,
 * not two diverging copies). The standard engine keeps importing it from here;
 * the existing embedded-state / json-products / recipe-hook tests run against the
 * shared code through this re-export and guard it against any drift.
 */
export { extractEmbeddedProducts, extractProductsFromJson } from '../shared/extract/embedded-state.mjs';
