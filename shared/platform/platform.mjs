/**
 * Platform detection + platform-native structured data.
 *
 * When a known platform is detected we prefer its public structured endpoint
 * over DOM parsing — but the engine NEVER depends on a platform: detection is
 * an optimisation, and generic extractors remain the default.
 */

/** Detect platform from HTML markers. Returns a slug or null. */
export function detectPlatform(html, headers = {}) {
  const h = html || '';
  const server = (headers['x-powered-by'] || headers['server'] || '').toLowerCase();
  // Shopify — only UNAMBIGUOUS signals. The bare word "shopify" (e.g. a payment
  // gateway or blog mention on a WordPress/WooCommerce site) must NOT classify as
  // Shopify, or a Woo site gets routed to the wrong lane. cdn.shopify.com /
  // myshopify.com / window.Shopify / Shopify.* are Shopify-only.
  if (/cdn\.shopify\.com|\.myshopify\.com|window\.Shopify|Shopify\.(theme|shop|routes|loadFeatures)/i.test(h) || server.includes('shopify')) return 'shopify';
  // WooCommerce: asset paths + the wc-ajax hook, plus robust fallbacks for a
  // cached/minimal homepage — the Store-API route, the generator meta, and the
  // woocommerce-* body class WC always emits. (frenchtoday.com is WooCommerce, not
  // Shopify — its "Original price was:/Current price is:" sale markup is WC's.)
  if (/woocommerce|wp-content\/plugins\/woocommerce|wc-ajax|wp-json\/wc\/|generator"\s+content="woocommerce/i.test(h)) return 'woocommerce';
  if (/Magento|mage\/|static\/version\d+|"magento"/i.test(h) || /magento/i.test(server)) return 'magento';
  if (/PrestaShop|prestashop/i.test(h)) return 'prestashop';
  if (/BigCommerce|bigcommerce/i.test(h)) return 'bigcommerce';
  return null;
}

/**
 * Shopify adapter: map a product from the public `<handle>.js` / `products.json`
 * JSON (structured, no DOM parse). `productJson` is the parsed object from
 * `${productUrl}.json` (one product) or a variant of the products list.
 * @returns {import('./types.mjs').RawProduct|null}
 */
export function shopifyProductToRaw(productJson, sourceUrl) {
  const p = productJson?.product || productJson;
  if (!p || typeof p !== 'object' || !p.title) return null;
  const variants = Array.isArray(p.variants) ? p.variants : [];
  const prices = variants.map((v) => parseFloat(v.price)).filter((n) => Number.isFinite(n));
  const listPrices = variants.map((v) => parseFloat(v.compare_at_price)).filter((n) => Number.isFinite(n));
  const firstVariant = variants[0] || {};
  const images = Array.isArray(p.images)
    ? p.images.map((i) => (typeof i === 'string' ? i : i.src)).filter(Boolean)
    : (p.image?.src ? [p.image.src] : []);
  return {
    name: String(p.title).trim(),
    description: p.body_html ? String(p.body_html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null,
    price: prices.length ? Math.min(...prices) : null,
    listPrice: listPrices.length ? Math.max(...listPrices) : null,
    currency: null,
    availability: variants.some((v) => v.available) ? 'InStock' : (variants.length ? 'OutOfStock' : null),
    // NOTE: Shopify's public /products.json and /products/<handle>.js do NOT
    // expose variant.barcode — it is Admin-API-only, stripped from the
    // unauthenticated storefront feed. So on public-feed sites (e.g. Allbirds)
    // gtin/barcode is null by design; the slug-EAN fallback (normalize.mjs) is the
    // only public recovery. Not fixable via the public endpoint — known limitation.
    gtin: firstVariant.barcode ? String(firstVariant.barcode).trim() : null,
    sku: firstVariant.sku ? String(firstVariant.sku).trim() : null,
    mpn: null,
    brand: p.vendor || null,
    images,
    category: p.product_type || null,
    breadcrumb: p.product_type ? [p.product_type] : [],
    // Weight comes from the variant's `grams` (Shopify's canonical field), not the
    // variant TITLE ("Large / Blue" is not a weight). Fall back to the title only
    // when there is no usable grams value — parseWeight ignores non-mass strings,
    // so a "Large" title still yields weight_kg = null (never a wrong mass).
    weightText: (Number.isFinite(Number(firstVariant.grams)) && Number(firstVariant.grams) > 0)
      ? `${Number(firstVariant.grams)} g`
      : (firstVariant.title && firstVariant.title !== 'Default Title' ? firstVariant.title : null),
    sourceUrl,
    canonicalUrl: sourceUrl,
    strategy: 'adapter-shopify',
    confidence: 0.95,
  };
}

/** Given a Shopify product page URL, the structured JSON lives at `${url}.json`. */
export function shopifyJsonUrl(productUrl) {
  try {
    const u = new URL(productUrl);
    u.search = ''; u.hash = '';
    return `${u.origin}${u.pathname.replace(/\/$/, '')}.json`;
  } catch { return null; }
}
