/**
 * Conversion catalog — the pure data from Homie Book's converter/config.ts
 * (CONVERTER_DIRS), WITHOUT the web routing/i18n helpers (which depended on the
 * site's routes.data). Each entry drives one conversion in the app.
 *   freeLimit = free-tier unit cap (10) ; priceEur = one-off unlock price.
 */
export const DIRECTIONS = [
  { slug: 'shopify-vers-woocommerce', direction: 'shopify-to-woocommerce', expectPlatform: 'shopify', sourceName: 'Shopify', targetName: 'WooCommerce', key: 'shopify_to_woo', freeLimit: 10, priceEur: 19 },
  { slug: 'woocommerce-vers-shopify', direction: 'woocommerce-to-shopify', expectPlatform: 'woocommerce', sourceName: 'WooCommerce', targetName: 'Shopify', key: 'woo_to_shopify', freeLimit: 10, priceEur: 19 },
  { slug: 'wix-vers-shopify', direction: 'wix-to-shopify', expectPlatform: 'wix', sourceName: 'Wix', targetName: 'Shopify', key: 'wix_shopify', freeLimit: 10, priceEur: 19, templated: true },
  { slug: 'shopify-vers-wix', direction: 'shopify-to-wix', expectPlatform: 'shopify', sourceName: 'Shopify', targetName: 'Wix', key: 'shopify_wix', freeLimit: 10, priceEur: 19, templated: true },
  { slug: 'wix-vers-woocommerce', direction: 'wix-to-woocommerce', expectPlatform: 'wix', sourceName: 'Wix', targetName: 'WooCommerce', key: 'wix_woo', freeLimit: 10, priceEur: 19, templated: true },
  { slug: 'woocommerce-vers-wix', direction: 'woocommerce-to-wix', expectPlatform: 'woocommerce', sourceName: 'WooCommerce', targetName: 'Wix', key: 'woo_wix', freeLimit: 10, priceEur: 19, templated: true },
  { slug: 'bigcommerce-vers-shopify', direction: 'bigcommerce-to-shopify', expectPlatform: 'bigcommerce', sourceName: 'BigCommerce', targetName: 'Shopify', key: 'bigcommerce_shopify', freeLimit: 10, priceEur: 19, templated: true },
  { slug: 'shopify-vers-bigcommerce', direction: 'shopify-to-bigcommerce', expectPlatform: 'shopify', sourceName: 'Shopify', targetName: 'BigCommerce', key: 'shopify_bigcommerce', freeLimit: 10, priceEur: 19, templated: true },
  { slug: 'bigcommerce-vers-woocommerce', direction: 'bigcommerce-to-woocommerce', expectPlatform: 'bigcommerce', sourceName: 'BigCommerce', targetName: 'WooCommerce', key: 'bigcommerce_woo', freeLimit: 10, priceEur: 19, templated: true },
  { slug: 'woocommerce-vers-bigcommerce', direction: 'woocommerce-to-bigcommerce', expectPlatform: 'woocommerce', sourceName: 'WooCommerce', targetName: 'BigCommerce', key: 'woo_bigcommerce', freeLimit: 10, priceEur: 19, templated: true },
  { slug: 'wix-vers-bigcommerce', direction: 'wix-to-bigcommerce', expectPlatform: 'wix', sourceName: 'Wix', targetName: 'BigCommerce', key: 'wix_bigcommerce', freeLimit: 10, priceEur: 19, templated: true },
  { slug: 'bigcommerce-vers-wix', direction: 'bigcommerce-to-wix', expectPlatform: 'bigcommerce', sourceName: 'BigCommerce', targetName: 'Wix', key: 'bigcommerce_wix', freeLimit: 10, priceEur: 19, templated: true },
  // BigBuy = supplier catalogue, SOURCE only (needs a companion categories file).
  { slug: 'bigbuy-vers-shopify', direction: 'bigbuy-to-shopify', expectPlatform: 'bigbuy', sourceName: 'BigBuy', targetName: 'Shopify', key: 'bigbuy_shopify', freeLimit: 10, priceEur: 19, templated: true, needsCategories: true },
  { slug: 'bigbuy-vers-woocommerce', direction: 'bigbuy-to-woocommerce', expectPlatform: 'bigbuy', sourceName: 'BigBuy', targetName: 'WooCommerce', key: 'bigbuy_woo', freeLimit: 10, priceEur: 19, templated: true, needsCategories: true },
  // Eloshon Scraper export = the suite's own catalogue format, SOURCE only (Phase 5.7).
  { slug: 'eloshon-vers-shopify', direction: 'eloshon-to-shopify', expectPlatform: 'eloshon', sourceName: 'Eloshon Scraper', targetName: 'Shopify', key: 'eloshon_shopify', freeLimit: 10, priceEur: 19, templated: true },
  { slug: 'eloshon-vers-woocommerce', direction: 'eloshon-to-woocommerce', expectPlatform: 'eloshon', sourceName: 'Eloshon Scraper', targetName: 'WooCommerce', key: 'eloshon_woo', freeLimit: 10, priceEur: 19, templated: true },
  { slug: 'eloshon-vers-wix', direction: 'eloshon-to-wix', expectPlatform: 'eloshon', sourceName: 'Eloshon Scraper', targetName: 'Wix', key: 'eloshon_wix', freeLimit: 10, priceEur: 19, templated: true },
  { slug: 'eloshon-vers-bigcommerce', direction: 'eloshon-to-bigcommerce', expectPlatform: 'eloshon', sourceName: 'Eloshon Scraper', targetName: 'BigCommerce', key: 'eloshon_bigcommerce', freeLimit: 10, priceEur: 19, templated: true },
  // Shopware 6 Admin API and PrestaShop Webservice payloads (knowledge-driven,
  // consumed as JSON files rather than CSV). The engine auto-detects a JSON
  // drop via the `json-shape` signatures in each format entry (Phase 8).
  { slug: 'shopware-vers-shopify', direction: 'shopware-to-shopify', expectPlatform: 'shopware', sourceName: 'Shopware', targetName: 'Shopify', key: 'shopware_shopify', freeLimit: 10, priceEur: 19, templated: true },
  { slug: 'shopware-vers-woocommerce', direction: 'shopware-to-woocommerce', expectPlatform: 'shopware', sourceName: 'Shopware', targetName: 'WooCommerce', key: 'shopware_woo', freeLimit: 10, priceEur: 19, templated: true },
  { slug: 'shopware-vers-wix', direction: 'shopware-to-wix', expectPlatform: 'shopware', sourceName: 'Shopware', targetName: 'Wix', key: 'shopware_wix', freeLimit: 10, priceEur: 19, templated: true },
  { slug: 'shopware-vers-bigcommerce', direction: 'shopware-to-bigcommerce', expectPlatform: 'shopware', sourceName: 'Shopware', targetName: 'BigCommerce', key: 'shopware_bigcommerce', freeLimit: 10, priceEur: 19, templated: true },
  { slug: 'prestashop-vers-shopify', direction: 'prestashop-to-shopify', expectPlatform: 'prestashop', sourceName: 'PrestaShop', targetName: 'Shopify', key: 'prestashop_shopify', freeLimit: 10, priceEur: 19, templated: true },
  { slug: 'prestashop-vers-woocommerce', direction: 'prestashop-to-woocommerce', expectPlatform: 'prestashop', sourceName: 'PrestaShop', targetName: 'WooCommerce', key: 'prestashop_woo', freeLimit: 10, priceEur: 19, templated: true },
  { slug: 'prestashop-vers-wix', direction: 'prestashop-to-wix', expectPlatform: 'prestashop', sourceName: 'PrestaShop', targetName: 'Wix', key: 'prestashop_wix', freeLimit: 10, priceEur: 19, templated: true },
  { slug: 'prestashop-vers-bigcommerce', direction: 'prestashop-to-bigcommerce', expectPlatform: 'prestashop', sourceName: 'PrestaShop', targetName: 'BigCommerce', key: 'prestashop_bigcommerce', freeLimit: 10, priceEur: 19, templated: true },
];

// THE free-tier cap value (what the UI copy "Version gratuite — 10 lignes"
// promises). An unlicensed EXPORT carries at most this many units (products /
// customers / orders) in the output file; previews always show the full count.
// Applied in app/convert-service.mjs (see its free-cap block, the single place
// to flip the basis to input-rows instead). Change the number HERE.
export const DEFAULT_FREE_LIMIT = 10;
