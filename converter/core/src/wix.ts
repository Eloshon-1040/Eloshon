import type { CanonProduct, CanonVariant, CanonImage, Loss } from './types';
import type { Row } from './csv';
import { cleanScalar } from './csv';
import { translationsLoss, identifiersLoss, bundlesLoss, priceTiersLoss, pivotExtrasLosses, IDENTIFIERS_CONSUMED } from './products';
import { num, kgToGrams, gramsToKg } from './normalize';
import { splitUrlList } from '../knowledge-proposal/values.mjs';

// ── Wix Stores products ──────────────────────────────────────────────────────
// Wix packs a product across a `Product` row (fieldType) followed by `Variant`
// rows sharing a `handleId`. Several fields hold MULTIPLE values joined by ';'
// inside the comma-delimited file: images, collections, and an option's value
// list. Options are typed (COLOR / DROP_DOWN); a COLOR value carries a hex code
// as `#rrggbb:Label`. Wix imports ONLY products by CSV — no customers, no orders.

const OPTION_SLOTS = [1, 2, 3, 4, 5, 6];
const INFO_SLOTS = [1, 2, 3, 4, 5, 6];

// Multi-value Wix fields separate on ';' (the CSV delimiter itself is a comma).
function splitSemi(v: string | undefined): string[] {
  return v ? v.split(';').map(cleanScalar).filter((s) => s.length > 0) : [];
}

// A COLOR option value is "#rrggbb:Label"; a plain option value is just "Label".
// We keep the label (Shopify/Woo option values are plain strings) and, for COLOR,
// remember the hex so the loss can be declared — never silently dropped.
function optionLabel(v: string): string {
  const s = cleanScalar(v);
  const i = s.indexOf(':');
  return i >= 0 && s.startsWith('#') ? s.slice(i + 1) : s;
}
function optionHex(v: string): string {
  const s = cleanScalar(v);
  const i = s.indexOf(':');
  return i >= 0 && s.startsWith('#') ? s.slice(0, i) : '';
}

// Wix inventory is a number OR the literal "InStock"/"OutOfStock".
function wixInventory(v: string | undefined): number | null {
  const s = (v ?? '').trim();
  if (s === '' || /^(in|out)stock$/i.test(s)) return null; // untracked
  return num(s);
}

export function parseWixProducts(rows: Row[]): CanonProduct[] {
  // The current Wix export (Catalog V3) names its key column `handle`, the old one `handleId`.
  if (rows.length && 'handle' in rows[0] && !('handleId' in rows[0])) return parseWixProductsV3(rows);
  // Group by handleId, preserving order; the first row (fieldType Product) is the
  // parent, the rest are its variants.
  const order: string[] = [];
  const groups = new Map<string, { product?: Row; variants: Row[] }>();
  for (const r of rows) {
    const h = cleanScalar(r.handleId || '');
    if (!h) continue;
    if (!groups.has(h)) { groups.set(h, { variants: [] }); order.push(h); }
    const g = groups.get(h)!;
    if ((r.fieldType || '').trim().toLowerCase() === 'product') g.product = r;
    else g.variants.push(r);
  }

  const out: CanonProduct[] = [];
  for (const h of order) {
    const g = groups.get(h)!;
    const p = g.product ?? g.variants[0] ?? {};

    // Options come from the Product row: name + typed value list.
    const options: { name: string; values: string[] }[] = [];
    const optTypes: string[] = [];
    for (const i of OPTION_SLOTS) {
      const name = cleanScalar(p[`productOptionName${i}`] || '');
      if (!name) continue;
      const values = splitSemi(p[`productOptionDescription${i}`]).map(optionLabel);
      options.push({ name, values });
      optTypes.push(cleanScalar(p[`productOptionType${i}`] || ''));
    }

    const productPrice = num(p.price);
    const productCost = num(p.cost);
    const productWeight = kgToGrams(num(p.weight));

    // Wix stores the LIST price in `price` and applies a product-level discount
    // to reach the currently-charged price. Canon invariant: `price` = charged
    // (lower with promo), `compareAtPrice` = the list "was" price (higher).
    const promoOf = (list: number | null): number | null => {
      if (list == null) return null;
      const mode = (p.discountMode || '').trim().toUpperCase();
      const val = num(p.discountValue);
      if (val == null || val === 0) return null;
      if (mode === 'PERCENT') return Math.round((list * (1 - val / 100)) * 100) / 100;
      if (mode === 'AMOUNT') return Math.round((list - val) * 100) / 100;
      return null;
    };

    const mkVariant = (row: Row, isVariantRow: boolean): CanonVariant => {
      const list = num(row.price) ?? productPrice;
      const promo = promoOf(list);
      const optionValues = isVariantRow
        ? OPTION_SLOTS.slice(0, options.length).map((i) => optionLabel(row[`productOptionDescription${i}`] || ''))
        : [];
      return {
        optionValues: optionValues.filter((_, i) => i < options.length),
        sku: cleanScalar(row.sku || ''),
        price: promo != null ? promo : list,
        compareAtPrice: promo != null ? list : null,
        cost: num(row.cost) ?? productCost,
        barcode: '',
        grams: kgToGrams(num(row.weight)) ?? productWeight,
        lengthCm: null, widthCm: null, heightCm: null,
        requiresShipping: true,
        taxable: true,
        inventoryQty: wixInventory(row.inventory) ?? (isVariantRow ? null : wixInventory(p.inventory)),
        imageSrc: '',
      };
    };

    const variants: CanonVariant[] = g.variants.length
      ? g.variants.map((v) => mkVariant(v, true))
      : [mkVariant(p, false)];

    // Several addresses joined by ";": split before each address, never inside one (a CDN path may hold ";" or ",").
    const images: CanonImage[] = splitUrlList(p.productImageUrl || '', ';').map((src, i) => ({ src, position: i + 1, alt: '' }));

    // Wix-only concepts kept as metafields so nothing is silently dropped: the
    // ribbon badge, the extra info sections, and the custom-text (engraving)
    // field. The hex behind each COLOR option is preserved the same way.
    const metafields: { key: string; value: string }[] = [];
    const ribbon = cleanScalar(p.ribbon || '');
    if (ribbon) metafields.push({ key: 'wix_ribbon', value: ribbon });
    for (const i of INFO_SLOTS) {
      const title = cleanScalar(p[`additionalInfoTitle${i}`] || '');
      const desc = cleanScalar(p[`additionalInfoDescription${i}`] || '');
      if (title || desc) metafields.push({ key: `info_${slug(title) || i}`, value: desc });
    }
    const customText = cleanScalar(p.customTextField1 || '');
    if (customText) metafields.push({ key: 'wix_custom_text', value: customText });
    for (const i of OPTION_SLOTS) {
      const hexes = splitSemi(p[`productOptionDescription${i}`]).map(optionHex).filter(Boolean);
      if (hexes.length) metafields.push({ key: `swatch_${slug(cleanScalar(p[`productOptionName${i}`] || '')) || i}`, value: hexes.join(';') });
    }

    void optTypes; // option control type isn't representable in Shopify/Woo options
    const visible = (p.visible || '').trim().toUpperCase() !== 'FALSE';
    out.push({
      handle: h,
      title: cleanScalar(p.name || ''),
      bodyHtml: p.description || '',
      vendor: cleanScalar(p.brand || ''),
      productType: '',
      tags: [],
      status: visible ? 'active' : 'draft',
      categories: splitSemi(p.collection),
      published: visible,
      options,
      variants,
      images,
      metafields,
      seoTitle: '',
      seoDescription: '',
    });
  }
  return out;
}

// ── Parse: Wix Stores products, Catalog V3 template ──────────────────────────
// PRODUCT row (name, description, categories, options), VARIANT rows (each with
// its own price / SKU / stock / barcode and ONE value per option) and MEDIA rows
// (one image each), all sharing `handle`. `price` is what is charged and
// `strikethroughPrice` the crossed-out price: the canonical shape as it is.
const V3_MODIFIER_SLOTS = 10;

function wixV3Stock(v: string | undefined): number | null {
  const s = (v ?? '').trim();
  if (s === '' || /^in_?stock$/i.test(s)) return null; // tracked-as-available, no count
  if (/^out_?of_?stock$/i.test(s)) return 0;
  return num(s);
}
const toCm = (n: number | null, unit: string): number | null => {
  if (n == null) return null;
  const u = unit.trim().toLowerCase();
  return u === 'in' ? Math.round(n * 2.54 * 1000) / 1000 : u === 'mm' ? n / 10 : u === 'm' ? n * 100 : n;
};

export function parseWixProductsV3(rows: Row[]): CanonProduct[] {
  const order: string[] = [];
  const groups = new Map<string, { product?: Row; variants: Row[]; media: Row[] }>();
  for (const r of rows) {
    const h = cleanScalar(r.handle || '');
    if (!h) continue;
    if (!groups.has(h)) { groups.set(h, { variants: [], media: [] }); order.push(h); }
    const g = groups.get(h)!;
    const kind = (r.fieldType || '').trim().toUpperCase();
    if (kind === 'PRODUCT') g.product = r;
    else if (kind === 'VARIANT') g.variants.push(r);
    else if (kind === 'MEDIA') g.media.push(r);
  }

  const out: CanonProduct[] = [];
  for (const h of order) {
    const g = groups.get(h)!;
    const p = g.product ?? g.variants[0] ?? g.media[0] ?? {};

    const options: { name: string; values: string[] }[] = [];
    const slots: number[] = [];
    for (const i of OPTION_SLOTS) {
      const name = cleanScalar(p[`productOptionName${i}`] || '');
      if (!name) continue;
      options.push({ name, values: splitSemi(p[`productOptionChoices${i}`]).map(optionLabel) });
      slots.push(i);
    }

    const mkVariant = (row: Row, isVariantRow: boolean): CanonVariant => {
      const unit = row.packageUnit || p.packageUnit || 'cm';
      const price = num(row.price);
      const was = num(row.strikethroughPrice);
      return {
        optionValues: isVariantRow ? slots.map((i) => optionLabel(row[`productOptionChoices${i}`] || '')) : [],
        sku: cleanScalar(row.sku || ''),
        price,
        compareAtPrice: was != null && price != null && was > price ? was : null,
        cost: num(row.cost),
        barcode: cleanScalar(row.barcode || ''),
        grams: kgToGrams(num(row.weight)),
        lengthCm: toCm(num(row.packageLength), unit), widthCm: toCm(num(row.packageWidth), unit), heightCm: toCm(num(row.packageHeight), unit),
        requiresShipping: true,
        taxable: true,
        inventoryQty: wixV3Stock(row.inventory),
        imageSrc: '',
      };
    };
    const variants: CanonVariant[] = g.variants.length ? g.variants.map((v) => mkVariant(v, true)) : [mkVariant(p, false)];

    const images: CanonImage[] = g.media
      .filter((m) => cleanScalar(m.media || ''))
      .map((m, i) => ({ src: cleanScalar(m.media), position: i + 1, alt: cleanScalar(m.mediaAltText || '') }));

    const metafields: { key: string; value: string }[] = [];
    const ribbon = cleanScalar(p.ribbon || '');
    if (ribbon) metafields.push({ key: 'wix_ribbon', value: ribbon });
    for (const i of OPTION_SLOTS) {
      if ((p[`productOptionType${i}`] || '').toUpperCase() !== 'SWATCH_CHOICES') continue;
      const hexes = splitSemi(p[`productOptionChoices${i}`]).map(optionHex).filter(Boolean);
      if (hexes.length) metafields.push({ key: `swatch_${slug(cleanScalar(p[`productOptionName${i}`] || '')) || i}`, value: hexes.join(';') });
    }
    // Customer-facing modifiers (engraving text, embroidery choice…): kept, never dropped.
    for (let i = 1; i <= V3_MODIFIER_SLOTS; i++) {
      const name = cleanScalar(p[`modifierName${i}`] || '');
      if (!name) continue;
      const detail = [cleanScalar(p[`modifierType${i}`] || ''), cleanScalar(p[`modifierDescription${i}`] || '')].filter(Boolean).join(': ');
      metafields.push({ key: metafields.some((m) => m.key === 'wix_custom_text') ? `wix_modifier_${i}` : 'wix_custom_text', value: detail ? `${name} (${detail})` : name });
    }

    const visible = (p.visible || '').trim().toUpperCase() !== 'FALSE';
    out.push({
      handle: h,
      title: cleanScalar(p.name || ''),
      bodyHtml: p.plainDescription || '',
      vendor: cleanScalar(p.brand || ''),
      productType: '',
      tags: [],
      status: visible ? 'active' : 'draft',
      categories: splitSemi(p.categorySlugs),
      published: visible,
      options,
      variants,
      images,
      metafields,
      seoTitle: '',
      seoDescription: '',
    });
  }
  return out;
}

function slug(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

// ── Serialize: Wix Stores products (Catalog V3 import template) ──────────────
// The current Wix import page hands out ONE template (97 columns, `handle` +
// `fieldType` in upper case). A product is a block of rows sharing a `handle`:
// one PRODUCT row, one VARIANT row per variant (each carries the single option
// value it stands for), then one MEDIA row per image. Unlike the older `handleId`
// template there is no product-level discount: `price` is what is charged and
// `strikethroughPrice` the crossed-out list price, i.e. the canonical shape.
// Options are typed; a colour swatch needs its hex ("#rrggbb:Label") which a
// Shopify/Woo file never has, so every option is written as TEXT_CHOICES.
export const WIX_V3_OPTION_SLOTS = 6;
const WIX_V3_MODIFIER_SLOTS = 10;

export function wixHeaders(): string[] {
  const h = ['handle', 'fieldType', 'name', 'visible', 'plainDescription', 'categorySlugs', 'primaryCategorySlug', 'media', 'mediaAltText', 'ribbon', 'brand', 'price', 'strikethroughPrice', 'baseUnit', 'baseUnitMeasurement', 'totalUnits', 'totalUnitsMeasurement', 'cost', 'inventory', 'preOrderEnabled', 'preOrderMessage', 'preOrderLimit', 'sku', 'barcode', 'weight', 'packageLength', 'packageWidth', 'packageHeight', 'packageUnit'];
  for (let i = 1; i <= WIX_V3_OPTION_SLOTS; i++) h.push(`productOptionName${i}`, `productOptionType${i}`, `productOptionChoices${i}`);
  for (let i = 1; i <= WIX_V3_MODIFIER_SLOTS; i++) h.push(`modifierName${i}`, `modifierType${i}`, `modifierCharLimit${i}`, `modifierMandatory${i}`, `modifierDescription${i}`);
  return h;
}

// Wix category slugs: lower case, hyphen separated. A hierarchical canonical
// category ("Men > Shoes") is written as its leaf, the CSV carries flat slugs.
function categorySlug(path: string): string {
  const leaf = path.split('>').pop() ?? path;
  return leaf.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
// ';' separates the values of a choice list, so it can't appear inside a value.
const choice = (v: string): string => v.replace(/;/g, ',');
const money = (n: number | null | undefined): string => (n != null ? n.toFixed(2) : '');
const wixStock = (q: number | null | undefined): string => (q != null ? String(q) : 'IN_STOCK');

export function serializeWixProducts(products: CanonProduct[]): { headers: string[]; rows: Row[] } {
  const headers = wixHeaders();
  const blank = (): Row => Object.fromEntries(headers.map((k) => [k, '']));
  const rows: Row[] = [];

  // price / strikethrough / cost / stock / sku / barcode / weight / package size:
  // the same columns sit on a variant row, or on the product row of a simple product.
  const fillSellable = (r: Row, v: CanonVariant | undefined) => {
    if (!v) return;
    r.price = money(v.price);
    r.strikethroughPrice = v.compareAtPrice != null && v.price != null && v.compareAtPrice > v.price ? money(v.compareAtPrice) : '';
    r.cost = money(v.cost);
    r.inventory = wixStock(v.inventoryQty);
    r.sku = v.sku;
    r.barcode = v.barcode;
    r.weight = v.grams != null ? String(gramsToKg(v.grams)) : '';
    const dims = [v.lengthCm, v.widthCm, v.heightCm];
    if (dims.some((d) => d != null)) {
      r.packageLength = dims[0] != null ? String(dims[0]) : '';
      r.packageWidth = dims[1] != null ? String(dims[1]) : '';
      r.packageHeight = dims[2] != null ? String(dims[2]) : '';
      r.packageUnit = 'cm';
    }
  };

  for (const p of products) {
    const hasVariants = p.options.length > 0 && p.variants.length > 1;
    const options = hasVariants ? p.options.slice(0, WIX_V3_OPTION_SLOTS) : [];
    const slugs = Array.from(new Set(p.categories.map(categorySlug).filter(Boolean)));

    const prod = blank();
    prod.handle = p.handle;
    prod.fieldType = 'PRODUCT';
    prod.name = p.title;
    prod.visible = p.published ? 'TRUE' : 'FALSE';
    prod.plainDescription = p.bodyHtml;
    prod.categorySlugs = slugs.join(';');
    prod.primaryCategorySlug = slugs[0] ?? '';
    prod.ribbon = p.metafields.find((m) => m.key === 'wix_ribbon')?.value ?? '';
    prod.brand = p.vendor;
    options.forEach((o, oi) => {
      prod[`productOptionName${oi + 1}`] = o.name;
      prod[`productOptionType${oi + 1}`] = 'TEXT_CHOICES';
      prod[`productOptionChoices${oi + 1}`] = o.values.map(choice).join(';');
    });
    if (!hasVariants) fillSellable(prod, p.variants[0]);
    rows.push(prod);

    if (hasVariants) {
      for (const v of p.variants) {
        const vr = blank();
        vr.handle = p.handle;
        vr.fieldType = 'VARIANT';
        vr.visible = 'TRUE';
        fillSellable(vr, v);
        options.forEach((o, oi) => {
          vr[`productOptionName${oi + 1}`] = o.name;
          vr[`productOptionType${oi + 1}`] = 'TEXT_CHOICES';
          vr[`productOptionChoices${oi + 1}`] = choice(v.optionValues[oi] || '');
        });
        rows.push(vr);
      }
    }

    for (const im of p.images) {
      const mr = blank();
      mr.handle = p.handle;
      mr.fieldType = 'MEDIA';
      mr.media = im.src;
      mr.mediaAltText = im.alt ?? '';
      rows.push(mr);
    }
  }
  return { headers, rows };
}

// ── Losses ───────────────────────────────────────────────────────────────────
// What a Wix SOURCE carries that no CSV target can take (regardless of target).
export function wixSourceLosses(products: CanonProduct[]): Loss[] {
  const losses: Loss[] = [];
  if (products.some((p) => p.metafields.some((m) => m.key === 'wix_custom_text')))
    losses.push({ code: 'loss_wix_customtext' });
  if (products.some((p) => p.metafields.some((m) => m.key === 'wix_ribbon')))
    losses.push({ code: 'loss_wix_ribbon' });
  if (products.some((p) => p.metafields.some((m) => m.key.startsWith('info_'))))
    losses.push({ code: 'loss_wix_infosections' });
  if (products.some((p) => p.metafields.some((m) => m.key.startsWith('swatch_'))))
    losses.push({ code: 'loss_wix_swatches' });
  return losses;
}

// What converting TO Wix can't preserve.
export function wixTargetLosses(products: CanonProduct[]): Loss[] {
  const losses: Loss[] = [{ code: 'loss_wix_option_type' }];
  // Wix takes a cost per variant now: loss_wix_cost is retired with the V3 template.
  const flattened = products.filter((p) => p.categories.some((c) => c.includes('>')));
  if (flattened.length)
    losses.push({ code: 'loss_wix_category_hierarchy', params: { count: flattened.length } });
  const overOptions = products.filter((p) => p.options.length > WIX_V3_OPTION_SLOTS && p.variants.length > 1);
  if (overOptions.length)
    losses.push({ code: 'loss_wix_options_limit', params: { count: overOptions.length, max: WIX_V3_OPTION_SLOTS } });
  // 6.3: no locale in the Wix product CSV; only a barcode, no MPN / HS code column
  losses.push(...translationsLoss('wix', products), ...identifiersLoss('wix', products, IDENTIFIERS_CONSUMED.wix), ...bundlesLoss('wix', products), ...priceTiersLoss('wix', products), ...pivotExtrasLosses('wix', products));
  return losses;
}
