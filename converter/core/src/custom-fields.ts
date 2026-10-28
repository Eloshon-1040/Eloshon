// Phase 5 (28/10/2026) — the « cases personnalisées »: a product's descriptive attributes (the Scraper's own columns:
// « Taille », « Sous-titre », the fixed attributes Genre / Matière…, a panel field kept « personnalisée ») and, on a
// target with no Type column, its product type. Each one is PLACED per target where the user chose once (step 3,
// « Champs non alimentés »), else where it is never lost:
//   Shopify  → a metafield (product.metafields.custom.<key>) · Tags · Type · description
//   WooCommerce → an attribute (Attribute N, visible) · Meta: · Tags · Categories · description
//   Wix (V3 template: no custom column, no type) → description · category (categorySlugs) · ribbon (badge)
//   BigCommerce (the writer carries no custom field) → description
// Verified 28/10: WooCommerce's CSV « Type » takes simple / variable / grouped / external only and has no free-text
// product type (Categories, Tags or an attribute instead); Wix's V3 product CSV has no product-type column and no
// info-section column (categories are its only classification). Pure: the canon products are changed in place.
import type { CanonProduct } from './types';

export type CustomTarget = 'metafield' | 'attribute' | 'meta' | 'tags' | 'category' | 'type' | 'description' | 'ribbon' | 'ignore';
type Target = 'shopify' | 'woocommerce' | 'wix' | 'bigcommerce';
/** The key of the product type among the placed fields (the step-3 row names it « Type de produit »). */
export const TYPE_KEY = '__product_type';

export const CUSTOM_CHOICES: Record<Target, CustomTarget[]> = {
  shopify: ['metafield', 'tags', 'type', 'description', 'ignore'],
  woocommerce: ['attribute', 'meta', 'tags', 'category', 'description', 'ignore'],
  wix: ['description', 'category', 'ribbon', 'ignore'],
  bigcommerce: ['description', 'ignore'],
};
const CUSTOM_DEFAULT: Record<Target, CustomTarget> = { shopify: 'metafield', woocommerce: 'attribute', wix: 'description', bigcommerce: 'description' };
// Shopify has its own « Type » column: the product type is placed only elsewhere. Same order as CUSTOM_CHOICES, so every
// step-3 row lists the places in one order (the default is named by `fallback`, not by its position).
const TYPE_CHOICES: Record<Exclude<Target, 'shopify'>, CustomTarget[]> = {
  woocommerce: ['attribute', 'meta', 'tags', 'category', 'description', 'ignore'],
  wix: ['description', 'category', 'ribbon', 'ignore'],
  bigcommerce: ['description', 'ignore'],
};
const TYPE_DEFAULT: Record<Exclude<Target, 'shopify'>, CustomTarget> = { woocommerce: 'attribute', wix: 'category', bigcommerce: 'description' };

export interface CustomFieldReport {
  key: string; label: string; products: number; sample: string;
  /** where it goes now; `fallback` = where it goes when the user has not chosen (the platform's default) */
  target: CustomTarget; fallback: CustomTarget; chosen: boolean; choices: CustomTarget[]; isType?: boolean;
}

const keyOf = (s: string) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'champ';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Is `target` a platform of the step-3 placement? */
export function placesCustomFields(target: string): target is Target { return target in CUSTOM_CHOICES; }

/**
 * Place every descriptive attribute (and, off Shopify, the product type) of `products` for `target`.
 * @param choices the user's choice per field key, for this target (a choice the target does not offer is ignored)
 * @returns one line per placed field (what step 3 lists), never empty for a file that has some
 */
export function placeCustomFields(products: CanonProduct[], target: string, choices: Record<string, string> = {}): CustomFieldReport[] {
  if (!placesCustomFields(target)) return [];
  const report = new Map<string, CustomFieldReport>();
  const pick = (key: string, offered: CustomTarget[], fallback: CustomTarget) => {
    const c = choices[key] as CustomTarget;
    return offered.includes(c) ? { target: c, fallback, chosen: true } : { target: fallback, fallback, chosen: false };
  };
  const note = (key: string, label: string, value: string, offered: CustomTarget[], placed: { target: CustomTarget; fallback: CustomTarget; chosen: boolean }, isType = false) => {
    const r = report.get(key) || { key, label, products: 0, sample: value.slice(0, 80), target: placed.target, fallback: placed.fallback, chosen: placed.chosen, choices: offered, ...(isType ? { isType: true } : {}) };
    r.products += 1; report.set(key, r);
  };
  for (const p of products) {
    const place = (t: CustomTarget, label: string, value: string, key: string) => {
      if (t === 'metafield' || t === 'meta') { p.metafields = [...(p.metafields || []), { key, value }]; return; }
      if (t === 'tags') { if (!p.tags.includes(value)) p.tags = [...p.tags, value]; return; }
      if (t === 'category') { if (!p.categories.includes(value)) p.categories = [...p.categories, value]; return; }
      if (t === 'type') { if (!p.productType) p.productType = value; return; }
      if (t === 'ribbon') { if (!(p.metafields || []).some((m) => m.key === 'wix_ribbon')) p.metafields = [...(p.metafields || []), { key: 'wix_ribbon', value: value.slice(0, 30) }]; return; }
      if (t === 'description') { p.bodyHtml = `${p.bodyHtml || ''}<p>${esc(label)} : ${esc(value)}</p>`; return; }
      if (t === 'attribute') p.attributesRich = [...(p.attributesRich || []), { name: label, values: [value], forVariation: false, visible: true }];
    };
    // The descriptive attributes (never the option axes): each one placed, and taken out of the list unless it stays one.
    const axes = new Set((p.options || []).map((o) => o.name.toLowerCase()));
    const kept: NonNullable<CanonProduct['attributesRich']> = [];
    for (const a of p.attributesRich || []) {
      if (a.forVariation !== false || axes.has(a.name.toLowerCase())) { kept.push(a); continue; }
      const value = (a.values || []).map(String).filter((v) => v.trim()).join(', ');
      if (!value) continue;
      const key = keyOf((a as { key?: string }).key || a.name);
      const offered = CUSTOM_CHOICES[target];
      const placed = pick(key, offered, CUSTOM_DEFAULT[target]);
      note(key, a.name, value, offered, placed);
      if (placed.target === 'attribute') kept.push(a); else place(placed.target, a.name, value, key);
    }
    if (p.attributesRich) p.attributesRich = kept;
    // The product type, where the target has no column for it.
    if (target !== 'shopify' && p.productType && p.productType.trim()) {
      const offered = TYPE_CHOICES[target];
      const placed = pick(TYPE_KEY, offered, TYPE_DEFAULT[target]);
      note(TYPE_KEY, 'Type', p.productType.trim(), offered, placed, true);
      place(placed.target, 'Type', p.productType.trim(), 'type');
    }
  }
  return [...report.values()];
}
