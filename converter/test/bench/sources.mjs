// The bench sources — every SAVED input in test/fixtures, enumerated from what
// exists (Phase 2 inventory), never invented. `platform` is the source side of
// the direction (eloshon = Eloshon Scraper / taught formats); `knowledge` adds
// a Learned entry; `companion` is the BigBuy categories file.
const learned = (f) => [`knowledge/${f}`];

export const SOURCES = [
  // ── Eloshon Scraper CSV exports, real per-site captures (both generations) ──
  { group: 'Eloshon Scraper — CSV exports (real captures)', id: 'scraper-csv-levis-be', label: "Levi's BE (21-col)", platform: 'eloshon', file: 'scraper/levis-be.csv' },
  { group: 'Eloshon Scraper — CSV exports (real captures)', id: 'scraper-csv-lidl-de', label: 'Lidl DE (21-col)', platform: 'eloshon', file: 'scraper/lidl-de.csv' },
  { group: 'Eloshon Scraper — CSV exports (real captures)', id: 'scraper-csv-lidl-be', label: 'Lidl BE (21-col)', platform: 'eloshon', file: 'scraper/scrap lidl be.csv' },
  { group: 'Eloshon Scraper — CSV exports (real captures)', id: 'scraper-csv-april-be', label: 'April Beauty BE (19-col)', platform: 'eloshon', file: 'scraper/april-beauty-be.csv' },
  { group: 'Eloshon Scraper — CSV exports (real captures)', id: 'scraper-csv-colruyt-be', label: 'Colruyt BE (19-col)', platform: 'eloshon', file: 'scraper/colruyt-be.csv' },

  // ── Eloshon Scraper products.json (the Phase 2 handoff) ──
  { group: 'Eloshon Scraper — products.json', id: 'scraper-pj-contract', label: 'Contract example (Phase 0)', platform: 'eloshon', file: 'scraper/products-json/contract-example.json' },
  { group: 'Eloshon Scraper — products.json', id: 'scraper-pj-21gen', label: 'Derived 21-gen (siblings, variants, review)', platform: 'eloshon', file: 'scraper/products-json/derived-21gen.json' },
  { group: 'Eloshon Scraper — products.json', id: 'scraper-pj-19gen', label: 'Historical 19-gen', platform: 'eloshon', file: 'scraper/products-json/historical-19gen.json' },
  { group: 'Eloshon Scraper — products.json', id: 'scraper-pj-extension', label: 'Extension lane ("your browser")', platform: 'eloshon', file: 'scraper/products-json/extension-lane.json' },

  // ── .eloshon (reader only) ──
  { group: '.eloshon catalogue', id: 'eloshon-catalog-edited', label: 'Edited catalogue (3 edits, 1 removal)', platform: 'eloshon', file: 'eloshon/catalog-edited.eloshon' },

  // ── Third-party scraping exports and supplier feeds ──
  { group: 'Third-party scraping exports and supplier feeds', id: 'thunderbit-growshops', label: 'Thunderbit (growshops.fr)', platform: 'eloshon', file: 'scraper/Thunderbit_5dad1f_20251112_233804.csv', knowledge: learned('scraper.thunderbit-growshops.v1.json') },
  { group: 'Third-party scraping exports and supplier feeds', id: 'supplier-fr', label: 'French supplier feed (taught format)', platform: 'eloshon', file: 'supplier_fr.csv', knowledge: learned('supplier.fournisseur-x.v1.json') },
  { group: 'Third-party scraping exports and supplier feeds', id: 'bigbuy-standard', label: 'BigBuy standard feed', platform: 'bigbuy', file: 'bigbuy_standard.csv', companion: 'presta_categories.csv' },
  { group: 'Third-party scraping exports and supplier feeds', id: 'bigbuy-presta', label: 'BigBuy PrestaShop-layout feed', platform: 'bigbuy', file: 'bigbuy_presta.csv', companion: 'presta_categories.csv' },

  // ── Platform CSV exports (the 14 legacy formats' fixtures) ──
  { group: 'Platform CSV exports', id: 'shopify-products', label: 'Shopify products', platform: 'shopify', file: 'shopify_products.csv' },
  { group: 'Platform CSV exports', id: 'shopify-customers', label: 'Shopify customers', platform: 'shopify', file: 'shopify_customers.csv' },
  { group: 'Platform CSV exports', id: 'shopify-customers-synthetic', label: 'Shopify customers (real-shaped, synthetic)', platform: 'shopify', file: 'shopify-customers-synthetic/customers_export.csv' },
  { group: 'Platform CSV exports', id: 'shopify-orders', label: 'Shopify orders', platform: 'shopify', file: 'shopify_orders.csv' },
  { group: 'Platform CSV exports', id: 'woo-products-modern', label: 'WooCommerce products', platform: 'woocommerce', file: 'woo_products_modern.csv' },
  { group: 'Platform CSV exports', id: 'woo-products-legacy', label: 'WooCommerce products (older export)', platform: 'woocommerce', file: 'woo_products_legacy.csv' },
  { group: 'Platform CSV exports', id: 'woo-customers', label: 'WooCommerce customers', platform: 'woocommerce', file: 'woo_customers.csv' },
  { group: 'Platform CSV exports', id: 'woo-orders', label: 'WooCommerce orders', platform: 'woocommerce', file: 'woo_orders.csv' },
  { group: 'Platform CSV exports', id: 'wix-products', label: 'Wix products', platform: 'wix', file: 'wix_products.csv' },
  { group: 'Platform CSV exports', id: 'bigcommerce-products', label: 'BigCommerce products (weight in kg)', platform: 'bigcommerce', file: 'bigcommerce_products.csv', opts: { weightUnit: 'kg' } },
  { group: 'Platform CSV exports', id: 'bigcommerce-customers', label: 'BigCommerce customers', platform: 'bigcommerce', file: 'bigcommerce_customers.csv' },
  { group: 'Platform CSV exports', id: 'bigcommerce-orders', label: 'BigCommerce orders', platform: 'bigcommerce', file: 'bigcommerce_orders.csv' },

  // ── Platform API captures dropped as ONE JSON file (no companion files) ──
  { group: 'Platform API captures dropped as one JSON file', id: 'woo-rest-products', label: 'WooCommerce REST products', platform: 'woocommerce', file: 'live/woocommerce-test/products.json' },
  { group: 'Platform API captures dropped as one JSON file', id: 'woo-rest-orders', label: 'WooCommerce REST orders', platform: 'woocommerce', file: 'live/woocommerce-test/orders.json' },
  { group: 'Platform API captures dropped as one JSON file', id: 'woo-rest-customers', label: 'WooCommerce REST customers', platform: 'woocommerce', file: 'live/woocommerce-test/customers.json' },
  { group: 'Platform API captures dropped as one JSON file', id: 'shopify-graphql-products', label: 'Shopify Admin GraphQL products', platform: 'shopify', file: 'live/shopify-test/products.json' },
  { group: 'Platform API captures dropped as one JSON file', id: 'shopware-products', label: 'Shopware Admin API products', platform: 'shopware', file: 'live/shopware-test/products.json' },
  { group: 'Platform API captures dropped as one JSON file', id: 'shopware-orders', label: 'Shopware Admin API orders', platform: 'shopware', file: 'live/shopware-test/orders.json' },
  { group: 'Platform API captures dropped as one JSON file', id: 'shopware-customers', label: 'Shopware Admin API customers', platform: 'shopware', file: 'live/shopware-test/customers.json' },
  { group: 'Platform API captures dropped as one JSON file', id: 'prestashop-products', label: 'PrestaShop Webservice products', platform: 'prestashop', file: 'live/prestashop-test/products.json' },
  { group: 'Platform API captures dropped as one JSON file', id: 'prestashop-orders', label: 'PrestaShop Webservice orders', platform: 'prestashop', file: 'live/prestashop-test/orders.json' },
  { group: 'Platform API captures dropped as one JSON file', id: 'bigcommerce-api-orders', label: 'BigCommerce REST orders', platform: 'bigcommerce', file: 'live/bigcommerce-test/orders.json' },
  { group: 'Platform API captures dropped as one JSON file', id: 'wix-orders', label: 'Wix eCom orders', platform: 'wix', file: 'live/wix-test/orders.json' },
];
