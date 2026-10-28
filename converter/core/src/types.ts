// Shared types for the migration converter. The result shape encodes the
// product's discipline: failures are first-class (named + actionable), losses
// are declared up front and framed as the TARGET platform's limitation, and
// anything genuinely ambiguous becomes a question rather than a guess.

// BigBuy is a supplier catalogue — a SOURCE only (you never migrate into it).
// Wix and BigCommerce are full platforms (both directions), with two hard
// exceptions the capability matrix enforces: Wix imports only products by CSV,
// and BigCommerce has no order CSV import at all (orders API-only) — so both are
// order/customer SOURCES that can never be an order (BC) target by file.
// `eloshon` = an Eloshon Scraper export (the suite's own catalogue format) —
// a SOURCE only, converted by the knowledge-driven generic parser (Phase 5.7).
// `shopware` = Shopware 6 Admin API payloads (knowledge-driven, no CSV parser
// yet) — a SOURCE only, not exposed in the app picker until a file-based
// ingestion exists. `prestashop` (Phase 7) = PrestaShop Webservice JSON
// payloads (orders / customers), same status.
export type Platform = 'shopify' | 'woocommerce' | 'bigbuy' | 'wix' | 'bigcommerce' | 'eloshon' | 'shopware' | 'prestashop';
export type Entity = 'products' | 'customers' | 'orders';

// A detected source format — platform + entity + the specific sub-format, since
// WooCommerce alone has three product layouts and BigBuy has two.
export type FormatId =
  | 'shopify_products' | 'woo_products_modern' | 'woo_products_legacy'
  | 'shopify_customers' | 'woo_customers'
  | 'shopify_orders' | 'woo_orders'
  | 'bigbuy_standard' | 'bigbuy_presta' | 'presta_categories'
  | 'wix_products'
  | 'bigcommerce_products' | 'bigcommerce_customers' | 'bigcommerce_orders'
  // Phase 5.7 — recognised through the KnowledgeStore and converted by the
  // generic parser (no per-format parser). `Detection.knowledgeId` names it.
  | 'knowledge'
  | 'unknown';

// A conversion direction is named by (from → to). BigBuy feeds either target.
// The new-platform pairs: Wix and BigCommerce each ↔ Shopify and WooCommerce,
// plus Wix ↔ BigCommerce. Impossible (source, target, entity) cells are refused
// at convert time by the capability matrix, not by omitting the direction.
export type Direction = 'shopify-to-woocommerce' | 'woocommerce-to-shopify'
  | 'bigbuy-to-shopify' | 'bigbuy-to-woocommerce'
  | 'wix-to-shopify' | 'shopify-to-wix'
  | 'wix-to-woocommerce' | 'woocommerce-to-wix'
  | 'bigcommerce-to-shopify' | 'shopify-to-bigcommerce'
  | 'bigcommerce-to-woocommerce' | 'woocommerce-to-bigcommerce'
  | 'wix-to-bigcommerce' | 'bigcommerce-to-wix'
  | 'eloshon-to-shopify' | 'eloshon-to-woocommerce' | 'eloshon-to-wix' | 'eloshon-to-bigcommerce'
  | 'shopware-to-shopify' | 'shopware-to-woocommerce' | 'shopware-to-wix' | 'shopware-to-bigcommerce'
  | 'prestashop-to-shopify' | 'prestashop-to-woocommerce' | 'prestashop-to-wix' | 'prestashop-to-bigcommerce';

// Diagnostics carry a translation CODE + named parameters, never prose. The app
// renders `converter.diag.<code>` in the viewer's language, interpolating the
// params — so the sentence structure (and parameter order) is owned by each
// locale, not concatenated in a fixed sequence here. This is what lets an error
// read naturally in French/Dutch/Spanish, not just English.
export type DiagParams = Record<string, string | number>;

// A row that could NOT be converted: the row number (1-based, as she sees it in
// a spreadsheet), the offending field, and a code for what to DO about it.
export type RowError = { row: number; field?: string; code: string; params?: DiagParams };

// Something that will not transfer, worded (in the locale) as the target's
// limitation. e.g. code 'loss_shopify_dimensions'.
export type Loss = { code: string; params?: DiagParams };

// A non-fatal heads-up tied to the data (duplicate emails, a value the source
// itself failed to serialise, a field we cleaned).
export type Warning = { row?: number; field?: string; code: string; params?: DiagParams };

// Something we must ASK before producing the file (never guessed). The UI turns
// each into a prompt; resolving it re-runs the conversion with the answer.
export type Question =
  | { kind: 'date_format'; code: string; params?: DiagParams; options: ['MDY', 'DMY'] }
  // A BigBuy/PrestaShop product file uses numeric category IDs and is unusable
  // without the matching categories file — ask for the second file plainly.
  | { kind: 'need_file'; code: string; params?: DiagParams; fileRole: 'categories' }
  // BigCommerce Weight column has no unit label — kg and lbs are both common.
  | { kind: 'weight_unit'; code: string; params?: DiagParams; options: ['kg', 'lbs'] };

export type ConvertResult = {
  ok: boolean;                 // false when nothing usable came out
  direction: Direction;
  sourceFormat: FormatId;
  targetFormat: FormatId;
  headers: string[];           // output column order
  rows: Row[];                 // FULL converted output (the caller caps for free tier)
  // Optional migration redirect map (old URL → new URL), one row per product,
  // present only when the caller passed both URL bases. Not capped.
  redirects?: { headers: string[]; rows: Row[] };
  counts: {
    inputUnits: number;        // products / customers / orders in the source
    outputUnits: number;       // successfully converted
    failedUnits: number;
    outputRows: number;        // physical rows written (variants/line-items expand)
  };
  errors: RowError[];
  losses: Loss[];
  warnings: Warning[];
  questions: Question[];       // unresolved ambiguities (block the paid file until answered)
  // Phase 7.3 — customers only: what the source said about marketing consent,
  // as EVIDENCE for the merchant's own re-confirmation. Every target is written
  // "not subscribed"; nothing here changes that.
  consentReport?: ConsentReport;
  // Phase 7.4 — orders only: the SOURCE numbering as observed (gaps and
  // duplicates are facts to report, never to repair); the target's sequence is
  // always generated natively.
  numberingReport?: NumberingReport;
  // Phase 2 — the source fields the canon kept OUTSIDE its own fields
  // (unmapped[]: unknown columns, promotable fields with no canon home), so the
  // user is told instead of a silent drop. CSV targets do not write them.
  preserved?: PreservedReport;
  // Products: values read as SKU that are not SKUs (removed, the SKU stays empty), and the SKUs the user's
  // generator made (core/knowledge-proposal/sku.mjs). `generator` = whether the generator was on.
  skus?: {
    rejected: { product: string; variant: string; value: string; reason: 'empty' | 'label' | 'phrase' | 'option_name' | 'too_long' | 'no_identifier' }[];
    generated: { product: string; variant: string; sku: string; scope: 'parent' | 'variant' }[];
    generator: boolean;
    // Generator on: before / after on the first variants, for the step-3 preview (nothing changed by it).
    preview?: { product: string; variant: string; before: string; after: string; generated: boolean }[];
  };
  // Products: the « cases personnalisées » (descriptive attributes; off Shopify, the product type) and where each one
  // was placed for this target (core/src/custom-fields.ts) — listed in step 3 so the user chooses once per platform.
  customFields?: import('./custom-fields').CustomFieldReport[];
};

export type PreservedReport = {
  units: number;                                        // units carrying at least one preserved field
  fields: { field: string; reason: string; units: number }[]; // per source field, in first-seen order
};

export type ConsentReport = {
  customers: number;
  explicitSourceConsent: number;   // the source states an opt-in (with or without its own timestamp)
  withTimestamp: number;           // …and carries the source's own timestamp (state 'opted_in')
  pending: number;                 // stated without timestamp, or pending double opt-in at the source
  optedOut: number;
  unknown: number;                 // nothing stated at the source
  targetPolicy: 'not-subscribed';  // every target field is written not subscribed
  requiresReconfirmation: true;    // the merchant runs its own (double) opt-in on the target
};

export type NumberingReport = {
  orders: number;
  sourceSequence: { min: string | null; max: string | null; numeric: boolean; gaps: string[]; duplicates: string[] };
  invoices: { withNumber: number; withoutNumber: number; gaps: string[] };
  targetPolicy: 'native-sequence'; // the target generates its own order (and invoice) numbers
  warnings: string[];              // diagnostic codes (numbering_source_duplicate, numbering_source_gaps, invoice_numbers_not_carried)
};

export type Row = Record<string, string>;

// ── Canonical IR — sourced from the shared @eloshon/catalog package so the
// interchange model is NOT locked inside the Converter. Byte-compatible with the
// previous local definitions; platform adapters + ConvertResult stay here.
// Type-only re-export → erased at transpile → the runtime dist is unchanged.
//
// Phase 2 additive types (CanonProductKind, CanonCatalogVisibility,
// CanonStockPolicy, CanonSalePeriod, CanonAttribute, CanonDownload) are exposed
// so future adapters and the recogniser can reference the shared vocabulary.
// All new fields on CanonProduct/CanonVariant/CanonImage are OPTIONAL — the
// current parsers/serialisers keep their default behaviour byte-for-byte.
export type {
  CanonImage, CanonVariant, CanonProduct,
  CanonAddress, CanonCustomer, CanonLineItem, CanonOrder,
  CanonProductKind, CanonCatalogVisibility, CanonStockPolicy,
  CanonSalePeriod, CanonAttribute, CanonDownload,
  // Phase 3 — preservation channels
  CanonSourceExtension, CanonPreservationReason, UnmappedEntry,
  // Phase 4 — provenance
  CanonProvenance, CanonProvenanceMethod, CanonProvenanceMap,
  // Phase 6.3 / 6.4 / C1
  CanonMetafield, CanonTranslation, CanonIdentifiers, CanonBundleComponent, CanonPriceTier,
  // Phase 7 — orders / customers / payments / consent / numbering (additive)
  CanonMarketingConsent, CanonCustomerAddress, CanonOrderLineItem, CanonPayment, CanonOrderNumbering, CanonOrderStatus,
} from '@eloshon/catalog';
