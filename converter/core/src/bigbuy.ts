import type { CanonProduct, CanonVariant, CanonImage, Row, Loss } from './types';
import { splitList, cleanScalar } from './csv';
import { num, kgToGrams } from './normalize';

// BigBuy — a dropshipping SUPPLIER catalogue (source only). It ships the SAME
// catalogue in two unrelated layouts: a "standard" 33-col file (numbered
// IMAGE1..8, inline ATTRIBUTE1/VALUE1, PVD/PVP prices) and a PrestaShop-format
// file (BigBuy's rendering of PrestaShop's import CSV — NOT a PrestaShop store
// export). Both are semicolon-separated and both reference categories by numeric
// ID, so the matching categories file is REQUIRED — the product file is
// unusable alone.

function slugify(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'product';
}

// ── PrestaShop categories file → an id/name resolver ─────────────────────────
// The file lists ID, NAME and PARENT_CATEGORY (by NAME, not id), up to four
// levels deep. Given a product's numeric category id we resolve NAME then walk
// the parent names up to build "Root > … > Leaf".
export type CategoryIndex = { idToName: Map<string, string>; nameToParent: Map<string, string> };

export function parsePrestaCategories(rows: Row[]): CategoryIndex {
  const idToName = new Map<string, string>();
  const nameToParent = new Map<string, string>();
  for (const r of rows) {
    const id = cleanScalar(r['ID'] || '');
    const name = cleanScalar(r['NAME'] || '');
    if (id && name) idToName.set(id, name);
    if (name) nameToParent.set(name, cleanScalar(r['PARENT_CATEGORY'] || ''));
  }
  return { idToName, nameToParent };
}

function resolvePath(catId: string, idx: CategoryIndex): string | null {
  const leaf = idx.idToName.get(catId.trim());
  if (!leaf) return null;
  const chain = [leaf];
  const seen = new Set([leaf]);
  let cur = leaf;
  while (true) {
    const parent = idx.nameToParent.get(cur);
    if (!parent || parent === '0' || seen.has(parent)) break;
    chain.unshift(parent); seen.add(parent); cur = parent;
  }
  return chain.join(' > ');
}

// Resolve a product's comma-list of category ids to hierarchy paths, deepest
// first (the most specific is the one to lead with).
function categoriesFor(idsCell: string, idx: CategoryIndex): { paths: string[]; unresolved: string[] } {
  const paths: string[] = [];
  const unresolved: string[] = [];
  for (const id of splitList(idsCell, ',')) {
    const p = resolvePath(id, idx);
    if (p) paths.push(p); else unresolved.push(id);
  }
  paths.sort((a, b) => b.split(' > ').length - a.split(' > ').length);
  return { paths: Array.from(new Set(paths)), unresolved };
}

// ── Parse: BigBuy standard (33-col) ──────────────────────────────────────────
export function parseBigBuyStandard(rows: Row[], idx: CategoryIndex): CanonProduct[] {
  return rows.map((r) => {
    const { paths } = categoriesFor(r['CATEGORY'] || '', idx);
    const images: CanonImage[] = [];
    for (let n = 1; n <= 8; n++) {
      const src = (r[`IMAGE${n}`] || '').trim();
      if (src) images.push({ src, position: images.length + 1, alt: '' });
    }
    const optNames = [cleanScalar(r['ATTRIBUTE1'] || ''), cleanScalar(r['ATTRIBUTE2'] || '')].filter(Boolean);
    const optVals = [cleanScalar(r['VALUE1'] || ''), cleanScalar(r['VALUE2'] || '')];
    const variant: CanonVariant = {
      optionValues: optNames.map((_, i) => optVals[i]).filter(Boolean),
      sku: cleanScalar(r['ID'] || ''),
      price: num(r['PVP_BIGBUY']),       // recommended retail — what she sells at
      compareAtPrice: null,
      cost: num(r['PVD']),               // distributor price — what she pays
      barcode: cleanScalar(r['EAN13'] || ''),
      grams: kgToGrams(num(r['WEIGHT'])),
      lengthCm: num(r['DEPTH']), widthCm: num(r['WIDTH']), heightCm: num(r['HEIGHT']),
      requiresShipping: true, taxable: true,
      inventoryQty: num(r['STOCK']),
      imageSrc: images[0]?.src ?? '',
    };
    const metafields: { key: string; value: string }[] = [];
    if (r['BRAND']) metafields.push({ key: 'bigbuy_brand_id', value: cleanScalar(r['BRAND']) });
    if (r['INTRASTAT']) metafields.push({ key: 'hs_code', value: cleanScalar(r['INTRASTAT']) });
    if (r['IVA']) metafields.push({ key: 'vat_rate', value: cleanScalar(r['IVA']) });
    return {
      handle: slugify(r['NAME'] || r['ID'] || 'product'),
      title: cleanScalar(r['NAME'] || ''), bodyHtml: r['DESCRIPTION'] || '',
      vendor: '', productType: paths[0] ? paths[0].split(' > ').pop() ?? '' : '',
      tags: [], status: 'active',
      categories: paths, published: true,
      options: optNames.map((name, i) => ({ name, values: optVals[i] ? [optVals[i]] : [] })).filter((o) => o.values.length),
      variants: [variant], images,
      metafields, seoTitle: '', seoDescription: '',
    } as CanonProduct;
  });
}

// ── Parse: BigBuy PrestaShop layout (56-col) ─────────────────────────────────
export function parseBigBuyPresta(rows: Row[], idx: CategoryIndex): CanonProduct[] {
  return rows.map((r) => {
    const { paths } = categoriesFor(r['CATEGORIES'] || '', idx);
    const images: CanonImage[] = splitList(r['IMAGES_URL'] || '', ',').map((src, i) => ({ src, position: i + 1, alt: '' }));
    const barcode = cleanScalar(r['EAN13'] || '') || cleanScalar(r['UPC'] || '');
    const variant: CanonVariant = {
      optionValues: [],
      sku: cleanScalar(r['bb_REFERENCE'] || r['ID'] || ''),
      price: num(r['PRICE_TAX_EXCLUDE']),  // sale price (tax excluded)
      compareAtPrice: null,
      cost: num(r['WHOLESALE_PRICE']),
      barcode,
      grams: kgToGrams(num(r['WEIGHT'])),
      lengthCm: num(r['DEPTH']), widthCm: num(r['WIDTH']), heightCm: num(r['HEIGHT']),
      requiresShipping: true, taxable: (r['TAX_RULE_ID'] || '') !== '0',
      inventoryQty: num(r['QUANTITY']),
      imageSrc: images[0]?.src ?? '',
    };
    const metafields: { key: string; value: string }[] = [];
    if (r['MANUFACTER']) metafields.push({ key: 'bigbuy_brand_id', value: cleanScalar(r['MANUFACTER']) });
    const published = (r['ACTIVE'] || '1') !== '0';
    return {
      handle: cleanScalar(r['URL_REWRITTEN'] || '') || slugify(r['NAME'] || r['ID'] || 'product'),
      title: cleanScalar(r['NAME'] || ''), bodyHtml: r['DESCRIPTION'] || '',
      vendor: '', productType: paths[0] ? paths[0].split(' > ').pop() ?? '' : '',
      tags: splitList(r['TAGS'] || '', ','),
      status: published ? 'active' : 'draft',
      categories: paths, published,
      options: [], variants: [variant], images,
      metafields, seoTitle: cleanScalar(r['META_TITLE'] || ''), seoDescription: cleanScalar(r['SHORT_DESCRIPTION'] || ''),
    } as CanonProduct;
  });
}

// Merge a same-catalogue file in another language (EN/ES) into translation
// metafields, keyed by product id. Preserves her data honestly — neither
// Shopify's nor WooCommerce's base product CSV has native translation columns.
export function mergeLanguage(products: CanonProduct[], secondRows: Row[], lang: string, idCol: string, nameCol: string, descCol: string, keyOf: (p: CanonProduct) => string): void {
  const byId = new Map<string, Row>();
  for (const r of secondRows) { const id = cleanScalar(r[idCol] || ''); if (id) byId.set(id, r); }
  for (const p of products) {
    const r = byId.get(keyOf(p));
    if (!r) continue;
    if (r[nameCol]) p.metafields.push({ key: `name_${lang}`, value: cleanScalar(r[nameCol]) });
    if (r[descCol]) p.metafields.push({ key: `description_${lang}`, value: r[descCol] });
  }
}

// ── Losses ───────────────────────────────────────────────────────────────────
export function bigbuyLosses(products: CanonProduct[], toShopify: boolean): Loss[] {
  const losses: Loss[] = [];
  if (products.some((p) => p.metafields.some((m) => m.key === 'bigbuy_brand_id')))
    losses.push({ code: 'loss_bigbuy_brand' });
  if (toShopify) {
    if (products.some((p) => p.categories.length))
      losses.push({ code: 'loss_category_hierarchy' });
    if (products.some((p) => p.metafields.some((m) => m.key === 'hs_code')))
      losses.push({ code: 'loss_hs_code' });
    if (products.some((p) => p.variants.some((v) => v.lengthCm != null)))
      losses.push({ code: 'loss_shopify_dimensions' });
  }
  return losses;
}
