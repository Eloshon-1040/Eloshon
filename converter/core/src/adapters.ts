import type { CanonProduct, CanonOrder, CanonCustomer } from './types';
import { parseCsv } from './csv';
import { parseWithKnowledge } from '../knowledge-proposal/generic-parser.mjs';
import type { ParseReport } from '../knowledge-proposal/generic-parser.mjs';
import { loadReferenceFormatsSync, loadCanonCatalogSync, loadTransformAliasesSync } from '../knowledge-proposal/reference.mjs';
import { buildLearnedFormat, proposeFormatId } from '../knowledge-proposal/learn.mjs';
import type { SemanticReport } from '../knowledge-proposal/semantic.mjs';
import type { FormatKnowledge } from '../knowledge-proposal/schema';

// Phase 5.5 — JSON/API adapters. There is NO adapter code per platform: each
// one is a Reference FormatKnowledge entry (core/knowledge-ref/formats/*.json)
// interpreted by the generic parser. These functions only name the entry and
// shape the companions the structure expects.

export type JsonCompanions = {
  /** Variation objects keyed by parent id ({ '13': [...] }) or a flat array carrying parent_id. */
  variations?: Record<string, unknown[]> | unknown[];
  /** Category taxonomy ({ id, name, parent }[]) used to rebuild hierarchy paths. */
  categories?: unknown[];
  [companion: string]: unknown;
};

export type ParsedCanon = { products: CanonProduct[]; report: ParseReport };
export type ParsedOrders = { orders: CanonOrder[]; report: ParseReport };
export type ParsedCustomers = { customers: CanonCustomer[]; report: ParseReport };

export function parseJsonWithKnowledge(formatId: string, payload: unknown, companions: JsonCompanions = {}): ParsedCanon {
  const format = loadReferenceFormatsSync().find((f) => f.id === formatId);
  if (!format) throw new Error(`unknown format knowledge: ${formatId}`);
  // 6.3: the canon catalogue's derivation rules (barcode ← identifiers…) run after the entries.
  return parseWithKnowledge(format, payload, { companions, canon: loadCanonCatalogSync() }) as ParsedCanon;
}

/** Phase 7 — orders / customers through the same knowledge entries
 *  (format.entity = 'orders' | 'customers'). `companions` carries the
 *  collections the entry's structure names (PrestaShop order_details,
 *  addresses, order_states…; Shopware newsletterRecipients; BigCommerce
 *  subscribers). The card-data scanner (7.7) runs on every object first. */
export function parseOrdersJson(formatId: string, orders: unknown, companions: Record<string, unknown> = {}): ParsedOrders {
  const format = loadReferenceFormatsSync().find((f) => f.id === formatId);
  if (!format) throw new Error(`unknown format knowledge: ${formatId}`);
  if (format.entity !== 'orders') throw new Error(`${formatId} is not an orders format`);
  const r = parseWithKnowledge(format, orders, { companions, canon: loadCanonCatalogSync() }) as { products: CanonOrder[]; report: ParseReport };
  return { orders: r.products, report: r.report };
}
export function parseCustomersJson(formatId: string, customers: unknown, companions: Record<string, unknown> = {}): ParsedCustomers {
  const format = loadReferenceFormatsSync().find((f) => f.id === formatId);
  if (!format) throw new Error(`unknown format knowledge: ${formatId}`);
  if (format.entity !== 'customers') throw new Error(`${formatId} is not a customers format`);
  const r = parseWithKnowledge(format, customers, { companions, canon: loadCanonCatalogSync() }) as { products: CanonCustomer[]; report: ParseReport };
  return { customers: r.products, report: r.report };
}

/** Shopify Admin GraphQL (2025-xx): `products { nodes { … variants { nodes } media { nodes } metafields { nodes } … } }`
 *  kept in the response shape (connections as { nodes }). One locale per
 *  `translations(locale:)` selection; the store's primary locale is the flat
 *  fields. No companion: variants are inline (structure.variants.inlinePath). */
export function parseShopifyAdminJson(input: { products: unknown[] }): ParsedCanon {
  return parseJsonWithKnowledge('shopify.products.admin-graphql.v1', input.products, {});
}

/** WooCommerce REST API v3: GET /wc/v3/products (+ /products/{id}/variations, /products/categories). */
export function parseWooRestJson(input: { products: unknown[]; variations?: JsonCompanions['variations']; categories?: unknown[] }): ParsedCanon {
  return parseJsonWithKnowledge('woocommerce.products.rest.v1', input.products, { variations: input.variations, categories: input.categories });
}

/** Shopware 6 Admin API: POST /api/search/product (parents) + the same query
 *  filtered by parentId for variants (flat array; nested `children` lack their
 *  associations). Inheritance (null → parent) is declared in the entry. */
export function parseShopwareAdminJson(input: { products: unknown[]; variations?: unknown[] }): ParsedCanon {
  return parseJsonWithKnowledge('shopware.products.admin-api.v1', input.products, { variations: input.variations ?? [] });
}

/** Any CSV whose format is a knowledge entry (Reference or Learned): rows become
 *  source objects (column → value) for the generic parser. */
export function parseCsvWithKnowledge(formatId: string, csvText: string, opts: { formats?: FormatKnowledge[] } = {}): ParsedCanon {
  const format = (opts.formats ?? loadReferenceFormatsSync()).find((f) => f.id === formatId);
  if (!format) throw new Error(`unknown format knowledge: ${formatId}`);
  const table = parseCsv(csvText);
  return parseWithKnowledge(format, table.rows, { companions: {}, canon: loadCanonCatalogSync() }) as ParsedCanon;
}

/** Phase 5.7 — teach a format: the semantic report of an unknown file (with the
 *  user's decisions applied) becomes a Learned FormatKnowledge entry the engine
 *  converts through the generic parser. The caller persists it with
 *  store.putLearnedFormat(). */
export function learnFormat(input: { headers: string[]; report: SemanticReport; id?: string; displayName?: string; provenance?: string; platform?: string; entity?: string; hint?: string; by?: string }): FormatKnowledge {
  return buildLearnedFormat({ ...input, catalog: loadCanonCatalogSync(), aliases: loadTransformAliasesSync() });
}
export { proposeFormatId };
