/**
 * The regression case matrix — shared by gen-golden.mjs (freezes reference
 * output from the CURRENT engine) and regression.test.mjs (asserts the engine
 * still produces it). Every parser and every serializer is exercised at least
 * once. `companion` (BigBuy categories file) is read and passed as categoriesCsv.
 *
 * A case's `opts` are the ConvertOptions minus csvText. Add a case → regenerate
 * goldens → eyeball the diff → commit.
 */
// Live WooCommerce REST payloads (captured 2026-09-21, PII pseudonymised).
export const WOO_REST = { formatId: 'woocommerce.products.rest.v1', products: 'live/woocommerce-test/products.json', variations: { 13: 'live/woocommerce-test/products-13-variations.json' }, categories: 'live/woocommerce-test/categories.json' };
// Live Shopware 6.7 Admin API payloads (captured 2026-09-21, demo catalogue).
export const SHOPWARE_API = { formatId: 'shopware.products.admin-api.v1', products: 'live/shopware-test/products.json', variations: 'live/shopware-test/variations.json' };
// Phase 6.3 — the same instance re-extracted with the translations / locale /
// custom-field-set associations (one seeded family: P1 / P2 / P3 populated).
export const SHOPWARE_I18N = { formatId: 'shopware.products.admin-api.v1', products: 'live/shopware-test/products-i18n.json', variations: 'live/shopware-test/variations-i18n.json', companions: { customFieldSets: 'live/shopware-test/custom-field-sets.json' } };
// Live Shopify Admin GraphQL payload (captured 2026-09-21, dev store, 3 products / 24 variants).
export const SHOPIFY_GQL = { formatId: 'shopify.products.admin-graphql.v1', products: 'live/shopify-test/products.json' };
// Phase 7.6 — orders / customers (live payloads captured 2026-09-21 with the
// card-data scanner at capture, pseudonymised). `units` is the payload, the
// other keys are companion collections the entry's structure names.
const PS = (k) => 'live/prestashop-test/' + k.replace(/_/g, '-') + '.json';
export const WOO_ORDERS = { formatId: 'woocommerce.orders.rest.v1', units: 'live/woocommerce-test/orders.json' };
export const WOO_CUSTOMERS = { formatId: 'woocommerce.customers.rest.v1', units: 'live/woocommerce-test/customers.json' };
export const SW_ORDERS = { formatId: 'shopware.orders.admin-api.v1', units: 'live/shopware-test/orders.json', companions: { numberRanges: 'live/shopware-test/number-ranges.json' } };
export const SW_CUSTOMERS = { formatId: 'shopware.customers.admin-api.v1', units: 'live/shopware-test/customers.json', companions: { newsletterRecipients: 'live/shopware-test/newsletter-recipients.json' } };
export const PS_ORDERS = { formatId: 'prestashop.orders.webservice.v1', units: PS('orders'), companions: Object.fromEntries(['order_details', 'order_invoices', 'order_payments', 'order_histories', 'order_states', 'order_carriers', 'order_slips', 'addresses', 'customers', 'carriers', 'countries', 'states', 'currencies', 'languages'].map((k) => [k, PS(k)])) };
export const PS_PRODUCTS = { formatId: 'prestashop.products.webservice.v1', products: 'live/prestashop-test/products.json', variations: 'live/prestashop-test/combinations.json', companions: { stock: 'live/prestashop-test/stock_availables.json', specificPrices: 'live/prestashop-test/specific_prices.json', productFeatures: 'live/prestashop-test/product_features.json', productFeatureValues: 'live/prestashop-test/product_feature_values.json', productOptions: 'live/prestashop-test/product_options.json', productOptionValues: 'live/prestashop-test/product_option_values.json', categories: 'live/prestashop-test/categories.json', manufacturers: 'live/prestashop-test/manufacturers.json', languages: 'live/prestashop-test/languages.json' } };
export const PS_CUSTOMERS = { formatId: 'prestashop.customers.webservice.v1', units: PS('customers'), companions: Object.fromEntries(['addresses', 'groups', 'countries', 'states', 'languages'].map((k) => [k, PS(k)])) };
export const BC_ORDERS = { formatId: 'bigcommerce.orders.rest-v2.v1', units: 'live/bigcommerce-test/orders.json' };
export const BC_CUSTOMERS = { formatId: 'bigcommerce.customers.rest-v3.v1', units: 'live/bigcommerce-test/customers.json', companions: { subscribers: 'live/bigcommerce-test/subscribers.json' } };
export const WIX_ORDERS = { formatId: 'wix.orders.ecom.v1', units: 'live/wix-test/orders.json' };
export const WIX_CONTACTS = { formatId: 'wix.contacts.v4.v1', units: 'live/wix-test/contacts.json' };

export const CASES = [
  // ── Products ──────────────────────────────────────────────────────────────
  { name: 'shopify_products__to_woo', fixture: 'shopify_products.csv', opts: { direction: 'shopify-to-woocommerce', expectPlatform: 'shopify' } },
  { name: 'shopify_products__to_woo_redirects', fixture: 'shopify_products.csv', opts: { direction: 'shopify-to-woocommerce', expectPlatform: 'shopify', redirectOldBase: 'https://old.example.com/products/', redirectNewBase: 'https://new.example.com/produit/' } },
  { name: 'shopify_products__to_wix', fixture: 'shopify_products.csv', opts: { direction: 'shopify-to-wix', expectPlatform: 'shopify' } },
  { name: 'shopify_products__to_bigcommerce', fixture: 'shopify_products.csv', opts: { direction: 'shopify-to-bigcommerce', expectPlatform: 'shopify' } },

  { name: 'woo_modern__to_shopify', fixture: 'woo_products_modern.csv', opts: { direction: 'woocommerce-to-shopify', expectPlatform: 'woocommerce' } },
  { name: 'woo_modern__to_wix', fixture: 'woo_products_modern.csv', opts: { direction: 'woocommerce-to-wix', expectPlatform: 'woocommerce' } },
  { name: 'woo_modern__to_bigcommerce', fixture: 'woo_products_modern.csv', opts: { direction: 'woocommerce-to-bigcommerce', expectPlatform: 'woocommerce' } },

  { name: 'woo_legacy__to_shopify', fixture: 'woo_products_legacy.csv', opts: { direction: 'woocommerce-to-shopify', expectPlatform: 'woocommerce' } },

  { name: 'wix__to_shopify', fixture: 'wix_products.csv', opts: { direction: 'wix-to-shopify', expectPlatform: 'wix' } },
  { name: 'wix__to_woo', fixture: 'wix_products.csv', opts: { direction: 'wix-to-woocommerce', expectPlatform: 'wix' } },
  { name: 'wix__to_bigcommerce', fixture: 'wix_products.csv', opts: { direction: 'wix-to-bigcommerce', expectPlatform: 'wix' } },

  { name: 'bigcommerce__to_shopify', fixture: 'bigcommerce_products.csv', opts: { direction: 'bigcommerce-to-shopify', expectPlatform: 'bigcommerce', weightUnit: 'kg' } },
  { name: 'bigcommerce__to_woo', fixture: 'bigcommerce_products.csv', opts: { direction: 'bigcommerce-to-woocommerce', expectPlatform: 'bigcommerce', weightUnit: 'kg' } },
  { name: 'bigcommerce__to_wix', fixture: 'bigcommerce_products.csv', opts: { direction: 'bigcommerce-to-wix', expectPlatform: 'bigcommerce', weightUnit: 'kg' } },

  { name: 'bigbuy_standard__to_shopify', fixture: 'bigbuy_standard.csv', companion: 'presta_categories.csv', opts: { direction: 'bigbuy-to-shopify', expectPlatform: 'bigbuy' } },
  { name: 'bigbuy_standard__to_woo', fixture: 'bigbuy_standard.csv', companion: 'presta_categories.csv', opts: { direction: 'bigbuy-to-woocommerce', expectPlatform: 'bigbuy' } },
  { name: 'bigbuy_presta__to_shopify', fixture: 'bigbuy_presta.csv', companion: 'presta_categories.csv', opts: { direction: 'bigbuy-to-shopify', expectPlatform: 'bigbuy' } },

  // ── Customers ─────────────────────────────────────────────────────────────
  { name: 'shopify_customers__to_woo', fixture: 'shopify_customers.csv', opts: { direction: 'shopify-to-woocommerce', expectPlatform: 'shopify' } },
  { name: 'woo_customers__to_shopify', fixture: 'woo_customers.csv', opts: { direction: 'woocommerce-to-shopify', expectPlatform: 'woocommerce' } },
  { name: 'bigcommerce_customers__to_shopify', fixture: 'bigcommerce_customers.csv', opts: { direction: 'bigcommerce-to-shopify', expectPlatform: 'bigcommerce' } },
  { name: 'bigcommerce_customers__to_woo', fixture: 'bigcommerce_customers.csv', opts: { direction: 'bigcommerce-to-woocommerce', expectPlatform: 'bigcommerce' } },
  // Chantier 4 — a real-shaped Shopify customers export (22 columns incl. the
  // froonze_cp_custom metafields). Values are 100% synthetic: see
  // scripts/gen-synthetic-customers.mjs. The real 4204-row export is never used.
  { name: 'synthetic_customers__to_woo', fixture: 'shopify-customers-synthetic/customers_export.csv', opts: { direction: 'shopify-to-woocommerce', expectPlatform: 'shopify' } },

  // ── Orders ────────────────────────────────────────────────────────────────
  { name: 'shopify_orders__to_woo', fixture: 'shopify_orders.csv', opts: { direction: 'shopify-to-woocommerce', expectPlatform: 'shopify' } },
  { name: 'woo_orders__to_shopify', fixture: 'woo_orders.csv', opts: { direction: 'woocommerce-to-shopify', expectPlatform: 'woocommerce' } },
  { name: 'bigcommerce_orders__to_shopify', fixture: 'bigcommerce_orders.csv', opts: { direction: 'bigcommerce-to-shopify', expectPlatform: 'bigcommerce' } },
  { name: 'bigcommerce_orders__to_woo', fixture: 'bigcommerce_orders.csv', opts: { direction: 'bigcommerce-to-woocommerce', expectPlatform: 'bigcommerce' } },

  // ── Phase 5.8: knowledge-driven paths (generic parser) — canon frozen too ──
  // WooCommerce REST (real payloads) → every target
  { name: 'woo_rest__to_shopify', kind: 'json', input: WOO_REST, opts: { direction: 'woocommerce-to-shopify', expectPlatform: 'woocommerce' } },
  { name: 'woo_rest__to_woo', kind: 'json', input: WOO_REST, opts: { direction: 'woocommerce-to-woocommerce', expectPlatform: 'woocommerce' } },
  { name: 'woo_rest__to_wix', kind: 'json', input: WOO_REST, opts: { direction: 'woocommerce-to-wix', expectPlatform: 'woocommerce' } },
  { name: 'woo_rest__to_bigcommerce', kind: 'json', input: WOO_REST, opts: { direction: 'woocommerce-to-bigcommerce', expectPlatform: 'woocommerce' } },
  // Eloshon Scraper exports (real) → targets
  { name: 'scraper_levis__to_shopify', fixture: 'scraper/levis-be.csv', canon: true, opts: { direction: 'eloshon-to-shopify', expectPlatform: 'eloshon' } },
  { name: 'scraper_levis__to_woo', fixture: 'scraper/levis-be.csv', opts: { direction: 'eloshon-to-woocommerce', expectPlatform: 'eloshon' } },
  { name: 'scraper_april__to_shopify', fixture: 'scraper/april-beauty-be.csv', canon: true, opts: { direction: 'eloshon-to-shopify', expectPlatform: 'eloshon' } },
  { name: 'scraper_april__to_wix', fixture: 'scraper/april-beauty-be.csv', opts: { direction: 'eloshon-to-wix', expectPlatform: 'eloshon' } },
  { name: 'scraper_lidl__to_bigcommerce', fixture: 'scraper/lidl-de.csv', canon: true, opts: { direction: 'eloshon-to-bigcommerce', expectPlatform: 'eloshon' } },
  { name: 'scraper_colruyt__to_woo', fixture: 'scraper/colruyt-be.csv', canon: true, opts: { direction: 'eloshon-to-woocommerce', expectPlatform: 'eloshon' } },
  // Chantier 5 — the Scraper → Converter chain shown publicly: the same real
  // captures, converted into the two targets the demo advertises.
  { name: 'scraper_lidl__to_shopify', fixture: 'scraper/lidl-de.csv', opts: { direction: 'eloshon-to-shopify', expectPlatform: 'eloshon' } },
  { name: 'scraper_colruyt__to_shopify', fixture: 'scraper/colruyt-be.csv', opts: { direction: 'eloshon-to-shopify', expectPlatform: 'eloshon' } },
  // Shopware Admin API (real payloads, parent → variant inheritance) → every target
  { name: 'shopware_api__to_shopify', kind: 'json', input: SHOPWARE_API, opts: { direction: 'shopware-to-shopify', expectPlatform: 'shopware' } },
  { name: 'shopware_api__to_woo', kind: 'json', input: SHOPWARE_API, opts: { direction: 'shopware-to-woocommerce', expectPlatform: 'shopware' } },
  { name: 'shopware_api__to_wix', kind: 'json', input: SHOPWARE_API, opts: { direction: 'shopware-to-wix', expectPlatform: 'shopware' } },
  { name: 'shopware_api__to_bigcommerce', kind: 'json', input: SHOPWARE_API, opts: { direction: 'shopware-to-bigcommerce', expectPlatform: 'shopware' } },
  // A format taught through the Learned strata (fixture = the learned entry)
  { name: 'learned_supplier__to_shopify', fixture: 'supplier_fr.csv', knowledge: ['knowledge/supplier.fournisseur-x.v1.json'], canon: true, opts: { direction: 'eloshon-to-shopify', expectPlatform: 'eloshon' } },
  { name: 'learned_supplier__to_woo', fixture: 'supplier_fr.csv', knowledge: ['knowledge/supplier.fournisseur-x.v1.json'], opts: { direction: 'eloshon-to-woocommerce', expectPlatform: 'eloshon' } },
  // Chantier 2 — a generic scraping export with NO fixed schema (Thunderbit on
  // growshops.fr): 16 French columns, taught through the same Learned strata.
  // 10 land on canon fields, 6 technical specs are preserved as metafields.
  { name: 'thunderbit_growshops__to_shopify', fixture: 'scraper/Thunderbit_5dad1f_20251112_233804.csv', knowledge: ['knowledge/scraper.thunderbit-growshops.v1.json'], canon: true, opts: { direction: 'eloshon-to-shopify', expectPlatform: 'eloshon' } },
  { name: 'thunderbit_growshops__to_woo', fixture: 'scraper/Thunderbit_5dad1f_20251112_233804.csv', knowledge: ['knowledge/scraper.thunderbit-growshops.v1.json'], opts: { direction: 'eloshon-to-woocommerce', expectPlatform: 'eloshon' } },
  // Phase 2 Lot 1 — the Scraper's products.json dropped as-is (json-shape
  // detection → scraper.products-json.v1 through the generic parser).
  { name: 'scraper_productsjson__to_shopify', fixture: 'scraper/products-json/derived-21gen.json', canon: true, opts: { direction: 'eloshon-to-shopify', expectPlatform: 'eloshon' } },
  { name: 'scraper_productsjson__to_woo', fixture: 'scraper/products-json/derived-21gen.json', opts: { direction: 'eloshon-to-woocommerce', expectPlatform: 'eloshon' } },
  { name: 'scraper_productsjson_contract__to_wix', fixture: 'scraper/products-json/contract-example.json', canon: true, opts: { direction: 'eloshon-to-wix', expectPlatform: 'eloshon' } },
  { name: 'scraper_productsjson_19gen__to_bigcommerce', fixture: 'scraper/products-json/historical-19gen.json', canon: true, opts: { direction: 'eloshon-to-bigcommerce', expectPlatform: 'eloshon' } },
  // Phase 2 Lot 2 — an .eloshon catalogue (written by the catalog's own
  // newEloshon / CommandLog: scripts/gen-eloshon-fixture.mjs), edits replayed.
  { name: 'eloshon_catalog__to_shopify', fixture: 'eloshon/catalog-edited.eloshon', opts: { direction: 'eloshon-to-shopify', expectPlatform: 'eloshon' } },
  { name: 'eloshon_catalog__to_woo', fixture: 'eloshon/catalog-edited.eloshon', opts: { direction: 'eloshon-to-woocommerce', expectPlatform: 'eloshon' } },

  // ── Phase 6.3: P1 / P2 / P3 populated from real payloads — canon frozen too ──
  // Shopify Admin GraphQL (real) → the three other targets (no shopify→shopify direction; the Shopify target is covered by canon-63.test.mjs)
  { name: 'shopify_graphql__to_woo', kind: 'json', input: SHOPIFY_GQL, opts: { direction: 'shopify-to-woocommerce', expectPlatform: 'shopify' } },
  { name: 'shopify_graphql__to_wix', kind: 'json', input: SHOPIFY_GQL, opts: { direction: 'shopify-to-wix', expectPlatform: 'shopify' } },
  { name: 'shopify_graphql__to_bigcommerce', kind: 'json', input: SHOPIFY_GQL, opts: { direction: 'shopify-to-bigcommerce', expectPlatform: 'shopify' } },
  // Shopware with translations + typed custom fields + identifiers → the two targets with consumers (metafield namespaces / GTIN)
  { name: 'shopware_i18n__to_shopify', kind: 'json', input: SHOPWARE_I18N, opts: { direction: 'shopware-to-shopify', expectPlatform: 'shopware' } },
  { name: 'shopware_i18n__to_woo', kind: 'json', input: SHOPWARE_I18N, opts: { direction: 'shopware-to-woocommerce', expectPlatform: 'shopware' } },
  // PrestaShop 9.0.3 Webservice products (real payloads, combinations companion + inheritance) → every target
  { name: 'prestashop_products__to_shopify', kind: 'json', input: PS_PRODUCTS, opts: { direction: 'prestashop-to-shopify', expectPlatform: 'prestashop' } },
  { name: 'prestashop_products__to_woo', kind: 'json', input: PS_PRODUCTS, opts: { direction: 'prestashop-to-woocommerce', expectPlatform: 'prestashop' } },
  { name: 'prestashop_products__to_wix', kind: 'json', input: PS_PRODUCTS, opts: { direction: 'prestashop-to-wix', expectPlatform: 'prestashop' } },
  { name: 'prestashop_products__to_bigcommerce', kind: 'json', input: PS_PRODUCTS, opts: { direction: 'prestashop-to-bigcommerce', expectPlatform: 'prestashop' } },

  // ── Phase 7.6: orders / customers through the generic parser (canon frozen) ──
  { name: 'woo_rest_orders__to_shopify', kind: 'json', entity: 'orders', input: WOO_ORDERS, opts: { direction: 'woocommerce-to-shopify', expectPlatform: 'woocommerce' } },
  { name: 'woo_rest_orders__to_woo', kind: 'json', entity: 'orders', input: WOO_ORDERS, opts: { direction: 'woocommerce-to-woocommerce', expectPlatform: 'woocommerce' } },
  { name: 'woo_rest_customers__to_shopify', kind: 'json', entity: 'customers', input: WOO_CUSTOMERS, opts: { direction: 'woocommerce-to-shopify', expectPlatform: 'woocommerce' } },
  { name: 'shopware_orders__to_shopify', kind: 'json', entity: 'orders', input: SW_ORDERS, opts: { direction: 'shopware-to-shopify', expectPlatform: 'shopware' } },
  { name: 'shopware_orders__to_woo', kind: 'json', entity: 'orders', input: SW_ORDERS, opts: { direction: 'shopware-to-woocommerce', expectPlatform: 'shopware' } },
  { name: 'shopware_customers__to_shopify', kind: 'json', entity: 'customers', input: SW_CUSTOMERS, opts: { direction: 'shopware-to-shopify', expectPlatform: 'shopware' } },
  { name: 'shopware_customers__to_bigcommerce', kind: 'json', entity: 'customers', input: SW_CUSTOMERS, opts: { direction: 'shopware-to-bigcommerce', expectPlatform: 'shopware' } },
  { name: 'prestashop_orders__to_shopify', kind: 'json', entity: 'orders', input: PS_ORDERS, opts: { direction: 'prestashop-to-shopify', expectPlatform: 'prestashop' } },
  { name: 'prestashop_orders__to_woo', kind: 'json', entity: 'orders', input: PS_ORDERS, opts: { direction: 'prestashop-to-woocommerce', expectPlatform: 'prestashop' } },
  { name: 'prestashop_customers__to_shopify', kind: 'json', entity: 'customers', input: PS_CUSTOMERS, opts: { direction: 'prestashop-to-shopify', expectPlatform: 'prestashop' } },
  { name: 'prestashop_customers__to_woo', kind: 'json', entity: 'customers', input: PS_CUSTOMERS, opts: { direction: 'prestashop-to-woocommerce', expectPlatform: 'prestashop' } },
  { name: 'bigcommerce_api_orders__to_shopify', kind: 'json', entity: 'orders', input: BC_ORDERS, opts: { direction: 'bigcommerce-to-shopify', expectPlatform: 'bigcommerce' } },
  { name: 'bigcommerce_api_customers__to_shopify', kind: 'json', entity: 'customers', input: BC_CUSTOMERS, opts: { direction: 'bigcommerce-to-shopify', expectPlatform: 'bigcommerce' } },
  { name: 'wix_orders__to_shopify', kind: 'json', entity: 'orders', input: WIX_ORDERS, opts: { direction: 'wix-to-shopify', expectPlatform: 'wix' } },
  { name: 'wix_contacts__to_woo', kind: 'json', entity: 'customers', input: WIX_CONTACTS, opts: { direction: 'wix-to-woocommerce', expectPlatform: 'wix' } },
];


/**
 * Run one case against the engine. Shared by gen-golden and regression so both
 * see exactly the same inputs. Returns { res, canon } — canon is the parsed
 * CanonProduct[] for knowledge-driven cases (frozen as <name>.canon.json), null
 * otherwise (the CSV parsers' canon is covered by the output CSV).
 */
export function runCase(c, { read, engine }) {
  const { convert, convertFromCanon, convertOrdersFromCanon, convertCustomersFromCanon, parseJsonWithKnowledge, parseCsvWithKnowledge, loadReferenceFormatsSync } = engine;
  if (c.kind === 'json' && c.entity) {
    // Phase 7.6 — orders / customers: the payload + named companion collections
    const J = (rel) => JSON.parse(read(rel));
    const companions = Object.fromEntries(Object.entries(c.input.companions ?? {}).map(([k, f]) => [k, J(f)]));
    const { products } = parseJsonWithKnowledge(c.input.formatId, J(c.input.units), companions);
    const res = c.entity === 'orders' ? convertOrdersFromCanon(products, { ...c.opts }, c.input.formatId) : convertCustomersFromCanon(products, { ...c.opts }, c.input.formatId);
    return { res, canon: products };
  }
  if (c.kind === 'json') {
    const J = (rel) => JSON.parse(read(rel));
    const v = c.input.variations;
    // companion variations: keyed-by-parent object of files, or one flat file (children carry the parent id)
    const variations = v == null ? undefined : typeof v === 'string' ? J(v) : Object.fromEntries(Object.entries(v).map(([k, f]) => [k, J(f)]));
    // any other companion collection the format's structure names (6.3: customFieldSets)
    const extra = Object.fromEntries(Object.entries(c.input.companions ?? {}).map(([k, f]) => [k, J(f)]));
    const companions = { variations, categories: c.input.categories ? J(c.input.categories) : undefined, ...extra };
    const { products } = parseJsonWithKnowledge(c.input.formatId, J(c.input.products), companions);
    const res = convertFromCanon(products, { ...c.opts }, c.input.formatId);
    return { res, canon: products };
  }
  const csvText = read(c.fixture);
  const opts = { ...c.opts };
  if (c.companion) opts.categoriesCsv = read(c.companion);
  let formats;
  if (c.knowledge) {
    formats = [...loadReferenceFormatsSync(), ...c.knowledge.map((rel) => JSON.parse(read(rel)))];
    opts.knowledge = { formats };
  }
  const res = convert(csvText, opts);
  let canon = null;
  if (c.canon && res.ok && res.sourceFormat && !['unknown'].includes(res.sourceFormat)) {
    canon = c.fixture.endsWith('.json')
      ? parseJsonWithKnowledge(res.sourceFormat, JSON.parse(csvText)).products
      : parseCsvWithKnowledge(res.sourceFormat, csvText, { formats }).products;
  }
  return { res, canon };
}

// Canon products, serialised deterministically (key order as produced; the
// generic parser is deterministic) — provenance included on purpose: it is
// part of what the parser promises.
export function canonSnapshot(products) {
  return JSON.stringify(products, null, 2) + '\n';
}

// The behavioural snapshot frozen alongside the output CSV: everything the UI
// reads except the (separately-compared) rows. Built in a fixed key order so the
// JSON is stable across runs.
export function metaSnapshot(res) {
  return {
    ok: res.ok,
    sourceFormat: res.sourceFormat,
    targetFormat: res.targetFormat,
    counts: res.counts,
    errors: res.errors,
    losses: res.losses,
    warnings: res.warnings,
    questions: res.questions,
    hasRedirects: !!res.redirects,
    // Phase 7 — the merchant reports (absent keys are dropped by JSON.stringify)
    consentReport: res.consentReport,
    numberingReport: res.numberingReport,
  };
}
