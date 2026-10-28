// Variants, the merchant's way (roadmap phase 6, 28/10/2026):
//  - stock: a scraped catalogue carries the SOURCE site's availability, not the merchant's stock. By default its
//    variants are not tracked (always sellable), so a size the source site had sold out is not imported as an
//    out-of-stock variant. « continue » keeps the quantities but allows selling beyond them; « source » keeps
//    them as they are (a platform-to-platform migration, where the stock is the merchant's own).
//  - platform limits (options, choices per option, variants per product): reported, never cut in silence.
//    Shopify: 3 options, 2 048 variants per product (shopify.dev, ProductVariant / productOptionsCreate,
//    API 2026-10). Wix Stores: 6 options, 100 choices per option, 1 000 variants per product (Wix Help Center,
//    « Wix Stores: Limits & Recommended Guidelines », 2026-01-26). WooCommerce: no fixed limit.
import type { CanonProduct, Loss, Platform, Warning } from './types';

export type StockMode = 'untracked' | 'continue' | 'source';

/** A file Eloshon Scraper wrote (its job CSV / products.json, the extension panel's CSV, a manifest's columns). */
export const isScrapedFormat = (sourceFormat: string): boolean => /^(scraper|extension|manifest)\./.test(String(sourceFormat || ''));

/** The stock mode of a conversion: the one chosen, else « untracked » for a scraped source. A supplier file the user
 *  taught or a platform export keeps its quantities: that stock is the merchant's own. */
export function stockModeFor(sourceFormat: string, chosen?: StockMode | null): StockMode {
  if (chosen === 'untracked' || chosen === 'continue' || chosen === 'source') return chosen;
  return isScrapedFormat(sourceFormat) ? 'untracked' : 'source';
}

/** Applies the stock mode to every variant (in place); says what changed. */
export function applyStockMode(products: CanonProduct[], mode: StockMode): Warning[] {
  if (mode === 'source') return [];
  let count = 0;
  for (const p of products) {
    for (const v of p.variants) {
      if (mode === 'untracked') {
        if (v.inventoryQty != null) { v.inventoryQty = null; count++; }
      } else if (v.inventoryQty != null) {
        v.stockPolicy = { ...(v.stockPolicy || {}), backorders: 'yes' };
        count++;
      }
    }
  }
  return count ? [{ code: mode === 'untracked' ? 'stock_untracked' : 'stock_continue', params: { count } }] : [];
}

const LIMITS: Partial<Record<Platform, { options?: number; choices?: number; variants?: number; name: string }>> = {
  shopify: { options: 3, variants: 2048, name: 'Shopify' },
  wix: { choices: 100, variants: 1000, name: 'Wix' }, // its 6 options: loss_wix_options_limit (wix.ts)
};

/** The products over a target's limits, as losses (counts and the limit, per kind). */
export function platformLimitLosses(target: Platform, products: CanonProduct[]): Loss[] {
  const L = LIMITS[target];
  if (!L) return [];
  const out: Loss[] = [];
  if (L.options != null) {
    const over = products.filter((p) => p.options.length > L.options! && p.variants.length > 1);
    if (over.length) out.push({ code: 'loss_options_limit', params: { target: L.name, count: over.length, max: L.options } });
  }
  if (L.choices != null) {
    const over = products.filter((p) => p.options.some((o) => (o.values || []).length > L.choices!));
    if (over.length) out.push({ code: 'loss_choices_limit', params: { target: L.name, count: over.length, max: L.choices } });
  }
  if (L.variants != null) {
    const over = products.filter((p) => p.variants.length > L.variants!);
    if (over.length) out.push({ code: 'loss_variants_limit', params: { target: L.name, count: over.length, max: L.variants, most: Math.max(...over.map((p) => p.variants.length)) } });
  }
  return out;
}
