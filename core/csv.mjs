/**
 * Emit NormalizedProduct[] as a CSV whose columns match the admin CSV import
 * (see store-import.ts / AdminProducts CsvImport). This is the bridge to the
 * EXISTING pipeline: the operator loads the file in Admin → Produits → Import
 * CSV, which runs the same eligibility filter + preview + draft import.
 *
 * The scraper cannot decide the Luna category (§9) — `category_slug` is left
 * for the operator to fill (or set via the run's --category-slug), and slugs
 * are derived from the name. Nothing is written to the DB here.
 */

const COLUMNS = [
  'slug', 'name', 'description',
  'price', 'category_slug', 'barcode', 'hs_code', 'weight_kg', 'image_url',
  'store_slug', 'source_url', 'source_product_id', 'source_category',
  'product_type', 'storage_info', 'is_alcoholic', 'color', 'variants',
  // Added 2026-10-20 (trailing, optional for the importer): "true" when weight_kg is an ESTIMATE
  // (a liquid's volume x density + container), empty when it is a stated mass or absent.
  'weight_estimated',
  // Added 2026-10-24 (trailing, read by name like the others): what the results panel already shows
  // for a product page — brand, availability (schema.org term), rating and its review count, the net
  // content as the page states it ("113 g"), the technical specs as one JSON object.
  'brand', 'availability', 'rating', 'review_count', 'net_content', 'technical_specs',
];

export function slugify(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'produit';
}

function shortId(np) {
  const basis = np.source_product_id || np.source_url || np.name || Math.random().toString();
  let h = 0;
  for (let i = 0; i < basis.length; i++) h = (h * 31 + basis.charCodeAt(i)) >>> 0;
  return h.toString(36).slice(0, 6);
}

const esc = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** @param {import('./types.mjs').NormalizedProduct[]} products */
export function toImportCsv(products, opts = {}) {
  const rows = [COLUMNS.join(',')];
  for (const p of products) {
    const base = slugify(p.name);
    const id = shortId(p);
    const slug = `${base}-${id}`;
    const raw = p.raw || {};
    const rec = {
      slug: slug,
      name: p.name || '',
      description: p.description || '',
      price: p.price ?? '',
      category_slug: p.category_slug || opts.categorySlug || '',
      barcode: p.barcode || '',
      hs_code: p.hs_code || '',
      weight_kg: p.weight_kg ?? '',
      image_url: p.image_url || '',
      store_slug: p.store_slug || opts.storeSlug || '',
      source_url: p.source_url || '',
      source_product_id: p.source_product_id || '',
      source_category: p.source_category || '',
      product_type: p.product_type || '',
      storage_info: p.storage_info || '',
      is_alcoholic: p.is_alcoholic ? 'true' : '',
      color: p.color || '',
      variants: (Array.isArray(p.variants) && p.variants.length) ? JSON.stringify(p.variants) : '',
      weight_estimated: p.raw && p.raw.weight_estimated ? 'true' : '',
      brand: raw.brand || '',
      availability: raw.availability || '',
      rating: raw.rating ?? '',
      review_count: raw.review_count ?? '',
      net_content: raw.weight_text || '',
      technical_specs: raw.technical_specs && typeof raw.technical_specs === 'object' && Object.keys(raw.technical_specs).length ? JSON.stringify(raw.technical_specs) : '',
    };
    rows.push(COLUMNS.map((c) => esc(rec[c])).join(','));
  }
  return '﻿' + rows.join('\r\n') + '\r\n';
}

export { COLUMNS };
