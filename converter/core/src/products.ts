import type { CanonProduct, CanonVariant, CanonImage, Row, Loss, Warning } from './types';
import { splitList, cleanScalar, splitWooList, joinWooList } from './csv';
import { splitUrlList, encodeUrlForList } from '../knowledge-proposal/values.mjs';
import { num, kgToGrams, gramsToKg, isHiddenMetaKey, dominantOrigin, absolutize } from './normalize';

// Products, all three layouts, meeting at CanonProduct. Grounded in the real
// files: Shopify Handle-grouped variants + one-image-per-row; modern Woo
// ID/Parent(id:)/variation rows + comma image lists + Meta: columns; legacy Woo
// flat rows with pipe attributes and no per-variation pricing.

const DEFAULT_TITLE = 'Default Title'; // Shopify's single-variant sentinel

function slugify(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'product';
}

// ── Parse: Shopify products ──────────────────────────────────────────────────
export function parseShopifyProducts(headers: string[], rows: Row[]): CanonProduct[] {
  const metaCols = headers.filter((h) => /\(product\.metafields\.[^)]+\)$/.test(h));
  const groups = new Map<string, Row[]>();
  const order: string[] = [];
  for (const r of rows) {
    const h = r['Handle'] || '';
    if (!groups.has(h)) { groups.set(h, []); order.push(h); }
    groups.get(h)!.push(r);
  }
  const products: CanonProduct[] = [];
  for (const handle of order) {
    const grp = groups.get(handle)!;
    const head = grp.find((r) => r['Title']) ?? grp[0];
    const optionNames = [head['Option1 Name'], head['Option2 Name'], head['Option3 Name']]
      .map((n) => (n || '').trim()).filter((n) => n && n !== 'Title');
    const variants: CanonVariant[] = [];
    const images: CanonImage[] = [];
    for (const r of grp) {
      const priceStr = r['Variant Price'];
      const optVals = [r['Option1 Value'], r['Option2 Value'], r['Option3 Value']]
        .map((v) => (v || '').trim());
      const hasVariant = (priceStr && priceStr.trim() !== '') || (optVals[0] && optVals[0] !== DEFAULT_TITLE);
      if (hasVariant) {
        variants.push({
          optionValues: optionNames.map((_, i) => optVals[i]).filter((v) => v),
          sku: cleanScalar(r['Variant SKU'] || ''),
          price: num(r['Variant Price']),
          compareAtPrice: num(r['Variant Compare At Price']),
          cost: num(r['Cost per item']),
          // the current export names the column "Variant Barcodes", older ones "Variant Barcode"
          barcode: cleanScalar(r['Variant Barcodes'] || r['Variant Barcode'] || ''),
          grams: num(r['Variant Grams']),
          lengthCm: null, widthCm: null, heightCm: null,
          requiresShipping: (r['Variant Requires Shipping'] || 'true') !== 'false',
          taxable: (r['Variant Taxable'] || 'true') !== 'false',
          inventoryQty: num(r['Variant Inventory Qty']),
          imageSrc: (r['Variant Image'] || '').trim(),
        });
      }
      const imgSrc = (r['Image Src'] || '').trim();
      if (imgSrc) images.push({ src: imgSrc, position: num(r['Image Position']) ?? images.length + 1, alt: r['Image Alt Text'] || '' });
    }
    if (variants.length === 0) {
      variants.push({ optionValues: [], sku: '', price: num(head['Variant Price']), compareAtPrice: null, cost: null, barcode: '', grams: num(head['Variant Grams']), lengthCm: null, widthCm: null, heightCm: null, requiresShipping: true, taxable: true, inventoryQty: null, imageSrc: '' });
    }
    const options = optionNames.map((name, i) => ({ name, values: Array.from(new Set(variants.map((v) => v.optionValues[i]).filter(Boolean))) }));
    // `<label> (product.metafields.<namespace>.<key>)` — the namespace is read
    // too (P2, 6.3); it changes nothing on the way out except that the Shopify
    // target writes it back instead of assuming `custom`.
    const metafields = metaCols.map((c) => {
      const m = c.match(/\(product\.metafields\.([^.)]+)\.([^.)]+)\)$/);
      const mf: CanonProduct['metafields'][number] = { key: m?.[2] ?? c, value: head[c] || '' };
      if (m?.[1]) mf.namespace = m[1];
      return mf;
    }).filter((m) => m.value);
    const statusRaw = (head['Status'] || 'active').toLowerCase();
    products.push({
      handle: handle || slugify(head['Title'] || 'product'),
      title: head['Title'] || '', bodyHtml: head['Body (HTML)'] || '',
      vendor: cleanScalar(head['Vendor'] || ''), productType: cleanScalar(head['Type'] || ''),
      tags: splitList(head['Tags'] || '', ','),
      status: statusRaw === 'draft' ? 'draft' : statusRaw === 'archived' ? 'archived' : 'active',
      categories: head['Product Category'] ? [head['Product Category']] : [],
      published: (head['Published'] || 'true') !== 'false',
      options, variants, images: images.sort((a, b) => a.position - b.position),
      metafields, seoTitle: head['SEO Title'] || '', seoDescription: head['SEO Description'] || '',
    });
  }
  return products;
}

// ── Parse: modern WooCommerce ────────────────────────────────────────────────
export function parseWooModern(headers: string[], rows: Row[]): CanonProduct[] {
  const metaCols = headers.filter((h) => h.startsWith('Meta:'));
  const attrIdx = [1, 2, 3].filter((n) => headers.includes(`Attribute ${n} name`));
  const byId = new Map<string, Row>();
  for (const r of rows) if (r['ID']) byId.set(r['ID'], r);
  // Group variations under their parent (Parent = "id:<ID>" or a SKU).
  const childrenOf = new Map<string, Row[]>();
  for (const r of rows) {
    if ((r['Type'] || '').trim() !== 'variation') continue;
    const p = (r['Parent'] || '').trim();
    const key = p.startsWith('id:') ? p.slice(3) : p; // resolve id: → parent ID; else SKU
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key)!.push(r);
  }
  const products: CanonProduct[] = [];
  for (const r of rows) {
    const type = (r['Type'] || '').trim();
    if (type === 'variation') continue; // handled under its parent
    // Woo's Images cell is a ", "-separated list: split before each address, never on a comma inside one.
    const origin = dominantOrigin(rows.map((x) => x['Images'] || '').flatMap((s) => splitUrlList(s)));
    const parentImages = splitUrlList(r['Images'] || '').map((src, i) => ({ src: absolutize(src, origin), position: i + 1, alt: '' }));
    const kids = (r['ID'] && childrenOf.get(r['ID'])) || (r['SKU'] && childrenOf.get(r['SKU'])) || [];
    const isVariable = type === 'variable' && kids.length > 0;

    // WooCommerce mixes two kinds of attribute on a variable product: ones USED
    // FOR VARIATIONS (each variation sets a value) and purely DESCRIPTIVE ones
    // (the parent lists values, but no variation uses them). A Shopify option
    // must have a value on every variant, so only an attribute EVERY variation
    // fills becomes an option; the rest become product-detail metafields — never
    // an empty option (which makes Shopify reject the whole file).
    const attrInfo = attrIdx.map((n) => {
      const name = (r[`Attribute ${n} name`] || '').trim();
      const usedBy = isVariable ? kids.filter((k) => (k[`Attribute ${n} value(s)`] || '').trim() !== '').length : 0;
      return { n, name, allUsed: isVariable && name !== '' && usedBy === kids.length };
    });
    const optionAttrs = attrInfo.filter((a) => a.allUsed);

    const variants: CanonVariant[] = [];
    if (isVariable) {
      for (const k of kids) {
        // Keep positional alignment to optionAttrs — do NOT drop blanks.
        const optVals = optionAttrs.map((a) => (k[`Attribute ${a.n} value(s)`] || '').trim());
        variants.push(wooVariant(k, optVals, origin));
      }
    } else {
      variants.push(wooVariant(r, [], origin));
    }
    const options = optionAttrs.map((a, i) => ({
      name: a.name,
      values: Array.from(new Set(variants.map((v) => v.optionValues[i]).filter(Boolean))),
    })).filter((o) => o.values.length);

    // Descriptive / partially-used attributes → metafields, so their information
    // survives instead of becoming a broken option.
    const attrMeta = attrInfo
      .filter((a) => a.name && !a.allUsed)
      .map((a) => ({ key: a.name, value: (r[`Attribute ${a.n} value(s)`] || '').trim() }));
    // `Brands` is the WC 9.6+ core brands column (comma list, `\,` escaped,
    // "Parent > Child" hierarchy). Mirrors the REST recipe: first brand's leaf
    // name = vendor, every brand kept (a metafield when there is more than one).
    // `Brand` (singular) predates it and is still honoured.
    const brands = splitWooList(r['Brands'] || '').map((b) => b.split('>').map((s) => s.trim()).join(' > '));
    const vendor = brands.length ? (brands[0].split(' > ').pop() ?? '') : cleanScalar(r['Brand'] || '');
    const metafields = [
      ...metaCols.map((c) => ({ key: c.slice('Meta:'.length).trim(), value: r[c] || '' })),
      ...attrMeta,
      ...(brands.length > 1 ? [{ key: 'brands', value: brands.join(', ') }] : []),
    ].filter((m) => m.value && !isHiddenMetaKey(m.key));
    const published = (r['Published'] || '1').trim() !== '0' && (r['Published'] || '').toLowerCase() !== 'false';
    const product: CanonProduct = {
      handle: r['SKU'] || slugify(r['Name'] || 'product'),
      title: r['Name'] || '', bodyHtml: r['Description'] || '',
      vendor, productType: '',
      tags: splitList(r['Tags'] || '', ','),
      status: published ? 'active' : 'draft',
      categories: splitWooList(r['Categories'] || '').map((c) => c.split('>').map((s) => s.trim()).join(' > ')),
      published,
      options, variants, images: parentImages,
      metafields, seoTitle: '', seoDescription: '',
      ...(r['Short description'] ? { shortDescription: r['Short description'] } : {}),
    };
    // ── Phase 5.8: extended-canon fields, ONLY when the exporter wrote the column.
    // Nothing here changes the fields above, so existing outputs stay identical.
    const has = (c: string) => headers.includes(c) && (r[c] ?? '') !== '';
    if (has('Is featured?') || has('Visibility in catalog')) {
      product.visibility = {};
      if (has('Is featured?')) product.visibility.featured = r['Is featured?'].trim() === '1';
      const cv = (r['Visibility in catalog'] || '').trim();
      if (cv === 'visible' || cv === 'catalog' || cv === 'search' || cv === 'hidden') product.visibility.catalogVisibility = cv;
    }
    if (has('Purchase note')) product.notes = { purchase: r['Purchase note'] };
    if (has('Position') || has('Upsells') || has('Cross-sells')) {
      product.merchandising = {};
      if (has('Position')) product.merchandising.menuOrder = num(r['Position']) ?? undefined;
      if (has('Upsells')) product.merchandising.upsells = splitList(r['Upsells'], ',');
      if (has('Cross-sells')) product.merchandising.crossSells = splitList(r['Cross-sells'], ',');
    }
    if (has('External URL') || has('Button text')) product.external = { ...(has('External URL') ? { url: r['External URL'] } : {}), ...(has('Button text') ? { buttonText: r['Button text'] } : {}) };
    const dls: { name?: string; file?: string }[] = [];
    for (let n = 1; has(`Download ${n} name`) || has(`Download ${n} URL`); n++) dls.push({ name: r[`Download ${n} name`] || '', file: r[`Download ${n} URL`] || '' });
    if (dls.length || has('Download limit') || has('Download expiry')) {
      product.digital = {};
      if (dls.length) product.digital.downloads = dls;
      if (has('Download limit')) { const n = num(r['Download limit']); product.digital.downloadLimit = n == null || n < 0 ? null : n; }
      if (has('Download expiry')) { const n = num(r['Download expiry']); product.digital.downloadExpiry = n == null || n < 0 ? null : String(n); }
    }
    // Every attribute → attributesRich (options AND descriptive ones), with visibility.
    const rich = attrIdxAll(headers).map((n) => {
      const name = (r[`Attribute ${n} name`] || '').trim();
      if (!name) return null;
      const isOpt = optionAttrs.some((a) => a.n === n);
      const values = isOpt ? (options.find((o) => o.name === name)?.values ?? []) : splitList(r[`Attribute ${n} value(s)`] || '', ',');
      const a: NonNullable<CanonProduct['attributesRich']>[number] = { name, values, forVariation: isOpt };
      if (has(`Attribute ${n} visible`)) a.visible = r[`Attribute ${n} visible`].trim() === '1';
      return a;
    }).filter((a): a is NonNullable<typeof a> => !!a);
    if (rich.length) product.attributesRich = rich;
    if (has('ID')) product.identity = { sourceId: r['ID'].trim() };
    products.push(product);
  }
  return products;
}
function attrIdxAll(headers: string[]): number[] {
  const out: number[] = [];
  for (let n = 1; headers.includes(`Attribute ${n} name`); n++) out.push(n);
  return out;
}

function wooVariant(r: Row, optVals: string[], origin: string | null): CanonVariant {
  const imgs = splitUrlList(r['Images'] || '');
  // Woo `Sale price` is the LOWER promo price. Enforce the canonical invariant
  // (`price` = charged, `compareAtPrice` = crossed-out higher "was") by
  // swapping when the sale is present and actually undercuts the regular price.
  const regular = num(r['Regular price']);
  const sale = num(r['Sale price']);
  const promoActive = sale != null && regular != null && sale < regular;
  const v: CanonVariant = {
    optionValues: optVals,
    sku: cleanScalar(r['SKU'] || ''),
    price: promoActive ? sale : regular,
    compareAtPrice: promoActive ? regular : null,
    cost: null, barcode: '',
    grams: kgToGrams(num(r['Weight (kg)'])),
    lengthCm: num(r['Length (cm)']), widthCm: num(r['Width (cm)']), heightCm: num(r['Height (cm)']),
    requiresShipping: (r['Virtual'] || 'no').toLowerCase() !== 'yes',
    taxable: (r['Tax status'] || 'taxable').toLowerCase() === 'taxable',
    inventoryQty: num(r['Stock']),
    imageSrc: imgs[0] ? absolutize(imgs[0], origin) : '',
  };
  // ── Phase 5.8: extended columns (only when present and non-empty)
  const cell = (c: string) => (r[c] ?? '').trim();
  if (cell('GTIN, UPC, EAN, or ISBN')) v.barcode = cell('GTIN, UPC, EAN, or ISBN');
  if (cell('Date sale price starts') || cell('Date sale price ends')) {
    const iso = (d: string) => (d ? (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00.000Z` : d) : null);
    v.salePeriod = { from: iso(cell('Date sale price starts')), to: iso(cell('Date sale price ends')) };
  }
  if (cell('Backorders allowed?') || cell('Sold individually?')) {
    v.stockPolicy = {};
    const b = cell('Backorders allowed?').toLowerCase();
    if (b) v.stockPolicy.backorders = b === '1' || b === 'yes' ? 'yes' : b === 'notify' ? 'notify' : 'no';
    const s = cell('Sold individually?');
    if (s) v.stockPolicy.soldIndividually = s === '1' || s.toLowerCase() === 'yes';
  }
  if (cell('Tax class')) v.taxClass = cell('Tax class');
  if (cell('Shipping class')) v.shippingClass = cell('Shipping class');
  return v;
}

// ── Parse: legacy WooCommerce ────────────────────────────────────────────────
// Read by the GENERIC parser since Phase 2: the knowledge entry
// woocommerce.products.csv.legacy.v1.json is the whole parser (its attribute:
// columns are a column family; units.ts parseProductsTable dispatches it).

// ── Serialize: Shopify products ──────────────────────────────────────────────
// The 43 columns of Shopify's current product CSV (a real store export, 2026):
// `Variant Inventory Tracker` = shopify is what makes Shopify READ the stock
// quantity on import — without it every imported quantity is silently ignored.
const SHOPIFY_HEADERS = [
  'Handle', 'Title', 'Body (HTML)', 'Vendor', 'Product Category', 'Type', 'Tags', 'Published',
  'Option1 Name', 'Option1 Value', 'Option1 Linked To', 'Option2 Name', 'Option2 Value', 'Option2 Linked To', 'Option3 Name', 'Option3 Value', 'Option3 Linked To',
  'Variant SKU', 'Variant Grams', 'Variant Inventory Tracker', 'Variant Inventory Qty', 'Variant Inventory Policy', 'Variant Fulfillment Service',
  'Variant Price', 'Variant Compare At Price', 'Variant Requires Shipping', 'Variant Taxable',
  'Unit Price Total Measure', 'Unit Price Total Measure Unit', 'Unit Price Base Measure', 'Unit Price Base Measure Unit',
  'Variant Barcodes', 'Image Src', 'Image Position', 'Image Alt Text', 'Gift Card', 'SEO Title', 'SEO Description',
  'Variant Image', 'Variant Weight Unit', 'Variant Tax Code', 'Cost per item', 'Status',
];

// Shopify's import recognises `<label> (product.metafields.<namespace>.<key>)`.
// P2 (6.3): a metafield that knows its source namespace keeps it — a
// `mm-google-shopping.condition` lands in its own namespace instead of being
// re-homed under `custom`; namespace-less metafields keep the historical
// `custom` (byte-identical output for every pre-6.3 source).
const shopifyMetaHeader = (m: { key: string; namespace?: string }) => `${m.key} (product.metafields.${m.namespace || 'custom'}.${m.key})`;

/** "A > B > C" → ["A", "A > B", "A > B > C"]: one tag per level, so a collection can be built on any of them. */
export function categoryTags(categories: string[]): string[] {
  const out: string[] = [];
  for (const c of categories) {
    const parts = c.split('>').map((s) => s.trim()).filter(Boolean);
    for (let i = 1; i <= parts.length; i++) out.push(parts.slice(0, i).join(' > '));
  }
  return out;
}

// Shopify has no native "source URL" column. The product's address on the source site (a Scraper export's
// source_url, any platform's source_url preserved under sourceExtension) travels as the metafield
// `source_url (product.metafields.eloshon.source_url)`: a conscious choice, not a silent loss — the
// handle stays the Scraper's stable slug, the address stays readable in the admin.
const SOURCE_URL_META = { key: 'source_url', namespace: 'eloshon' };
function sourceUrlOf(p: CanonProduct): string | null {
  const ext = p.sourceExtension as Record<string, Record<string, unknown>> | undefined;
  if (!ext) return null;
  for (const ns of Object.values(ext)) {
    if (!ns || typeof ns !== 'object') continue;
    const v = (ns as Record<string, unknown>).source_url ?? (ns as Record<string, unknown>).sourceUrl ?? (ns as Record<string, unknown>).url;
    if (typeof v === 'string' && /^https?:\/\//i.test(v.trim())) return v.trim();
  }
  return null;
}
function withSourceUrlMeta(p: CanonProduct): CanonProduct['metafields'] {
  if (p.metafields.some((m) => m.key === SOURCE_URL_META.key && (m.namespace || 'custom') === SOURCE_URL_META.namespace)) return p.metafields;
  const u = sourceUrlOf(p);
  return u ? [...p.metafields, { ...SOURCE_URL_META, value: u }] : p.metafields;
}

export function serializeShopifyProducts(products: CanonProduct[], opts: { categoriesAsTags?: boolean } = {}): { headers: string[]; rows: Row[] } {
  const metaOf = new Map(products.map((p) => [p, withSourceUrlMeta(p)] as const));
  const metaHeaders = Array.from(new Set(products.flatMap((p) => (metaOf.get(p) ?? p.metafields).map(shopifyMetaHeader))));
  const headers = [...SHOPIFY_HEADERS, ...metaHeaders];
  const rows: Row[] = [];
  for (const p of products) {
    const blank = (): Row => Object.fromEntries(headers.map((h) => [h, '']));
    // Shopify rejects an option that isn't filled on EVERY variant. Emit only
    // options every variant provides a value for; if that leaves none but there
    // are several variants, fall back to a per-variant title so the file still
    // imports (instead of every row sharing "Default Title").
    const validOpt = p.options.map((_, oi) => oi).filter((oi) => p.variants.length > 0 && p.variants.every((v) => (v.optionValues[oi] || '').trim() !== ''));
    const multiNoOpt = validOpt.length === 0 && p.variants.length > 1;
    const maxRows = Math.max(p.variants.length, p.images.length, 1);
    for (let i = 0; i < maxRows; i++) {
      const row = blank();
      row['Handle'] = p.handle;
      if (i === 0) {
        row['Title'] = p.title; row['Body (HTML)'] = p.bodyHtml; row['Vendor'] = p.vendor;
        row['Type'] = p.productType;
        const tags = opts.categoriesAsTags ? [...p.tags, ...categoryTags(p.categories)] : p.tags;
        const seen = new Set<string>();
        row['Tags'] = tags.filter((t) => { const k = t.trim().toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; }).join(', ');
        row['Published'] = p.published ? 'true' : 'false';
        row['SEO Title'] = p.seoTitle; row['SEO Description'] = p.seoDescription;
        row['Status'] = p.status;
        // Shopify takes ONE category per product, from its own taxonomy ("Home & Garden > Lawn & Garden").
        row['Product Category'] = p.categories[0] ?? '';
        row['Gift Card'] = 'false';
        for (const m of metaOf.get(p) ?? p.metafields) row[shopifyMetaHeader(m)] = m.value;
      }
      const v = p.variants[i];
      if (v) {
        if (validOpt.length) {
          validOpt.forEach((oi, slot) => { row[`Option${slot + 1} Name`] = p.options[oi].name; row[`Option${slot + 1} Value`] = v.optionValues[oi]; });
        } else if (multiNoOpt) {
          row['Option1 Name'] = 'Title'; row['Option1 Value'] = v.sku || String(i + 1);
        } else if (i === 0) {
          row['Option1 Name'] = 'Title'; row['Option1 Value'] = DEFAULT_TITLE;
        }
        row['Variant SKU'] = v.sku;
        row['Variant Grams'] = v.grams != null ? String(v.grams) : '';
        row['Variant Inventory Tracker'] = v.inventoryQty != null ? 'shopify' : '';
        row['Variant Inventory Qty'] = v.inventoryQty != null ? String(v.inventoryQty) : '';
        row['Variant Inventory Policy'] = v.stockPolicy?.backorders === 'yes' ? 'continue' : 'deny';
        row['Variant Fulfillment Service'] = 'manual';
        row['Variant Price'] = v.price != null ? v.price.toFixed(2) : '';
        row['Variant Compare At Price'] = v.compareAtPrice != null ? v.compareAtPrice.toFixed(2) : '';
        row['Variant Requires Shipping'] = v.requiresShipping ? 'true' : 'false';
        row['Variant Taxable'] = v.taxable ? 'true' : 'false';
        row['Variant Barcodes'] = v.barcode;
        row['Cost per item'] = v.cost != null ? v.cost.toFixed(2) : '';
        row['Variant Weight Unit'] = 'g';
        row['Variant Image'] = v.imageSrc;
      }
      const img = p.images[i];
      if (img) { row['Image Src'] = img.src; row['Image Position'] = String(img.position); row['Image Alt Text'] = img.alt; }
      rows.push(row);
    }
  }
  return { headers, rows };
}

// ── Serialize: modern WooCommerce ────────────────────────────────────────────
// NO `ID` column: WooCommerce's importer reads ID as the database post ID, so a
// carried-over ID (from a supplier feed or another store) OVERWRITES existing
// products. We omit it entirely — WooCommerce assigns fresh IDs — and link
// variations to their parent by SKU instead of the file-local id:. Every parent
// and variation therefore needs a SKU; we derive missing ones from the handle so
// nothing links by an empty value.
const WOO_HEADERS = [
  'Type', 'SKU', 'Name', 'Published', 'Visibility in catalog', 'Short description', 'Description',
  'In stock?', 'Stock', 'Regular price', 'Sale price', 'Tax status', 'Virtual',
  'Weight (kg)', 'Length (cm)', 'Width (cm)', 'Height (cm)',
  'Categories', 'Tags', 'Images', 'Parent',
  'Attribute 1 name', 'Attribute 1 value(s)', 'Attribute 1 visible', 'Attribute 1 global',
  'Attribute 2 name', 'Attribute 2 value(s)', 'Attribute 2 visible', 'Attribute 2 global',
  'Attribute 3 name', 'Attribute 3 value(s)', 'Attribute 3 visible', 'Attribute 3 global',
];

// Extended WooCommerce exporter columns (Phase 5.8). Emitted ONLY when at least
// one product carries the matching extended-canon field, so a source that does
// not populate the field (every pre-Phase-5 CSV parser) produces the exact
// same file as before. Names are the built-in exporter's own.
type WooExt = { header: string; has: (p: CanonProduct) => boolean };
const WOO_EXT: WooExt[] = [
  { header: 'Is featured?', has: (p) => p.visibility?.featured !== undefined },
  { header: 'Date sale price starts', has: (p) => p.variants.some((v) => !!v.salePeriod?.from) },
  { header: 'Date sale price ends', has: (p) => p.variants.some((v) => !!v.salePeriod?.to) },
  { header: 'Backorders allowed?', has: (p) => p.variants.some((v) => v.stockPolicy?.backorders !== undefined) },
  { header: 'Sold individually?', has: (p) => p.variants.some((v) => v.stockPolicy?.soldIndividually !== undefined) },
  { header: 'Tax class', has: (p) => p.variants.some((v) => !!v.taxClass) },
  { header: 'Shipping class', has: (p) => p.variants.some((v) => !!v.shippingClass) },
  // Phase 6 (user decision, data-loss reduction): `barcode` and `vendor` are
  // pre-Phase-5 canon fields the WooCommerce target used to drop. WC 9.2+ has
  // the GTIN column, WC 9.6+ the core `Brands` taxonomy column (names verified
  // in the live 11.1 exporter/importer). Both are pruned when no product
  // carries the value, so barcode-less / vendor-less sources are unchanged.
  { header: 'GTIN, UPC, EAN, or ISBN', has: (p) => p.variants.some((v) => !!v.barcode) },
  { header: 'Brands', has: (p) => !!p.vendor },
  { header: 'Purchase note', has: (p) => !!p.notes?.purchase },
  { header: 'Position', has: (p) => p.merchandising?.menuOrder !== undefined },
  { header: 'Upsells', has: (p) => (p.merchandising?.upsells?.length ?? 0) > 0 },
  { header: 'Cross-sells', has: (p) => (p.merchandising?.crossSells?.length ?? 0) > 0 },
  { header: 'External URL', has: (p) => !!p.external?.url },
  { header: 'Button text', has: (p) => !!p.external?.buttonText },
  { header: 'Download limit', has: (p) => p.digital?.downloadLimit !== undefined },
  { header: 'Download expiry', has: (p) => p.digital?.downloadExpiry !== undefined },
];
const wcDate = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : '');
// Descriptive attributes the WC CSV can carry: forVariation=false and not
// named like an option axis (Shopware demo: "Size" is both an axis and a
// filterable property with more values).
function descriptiveAttributes(p: CanonProduct): NonNullable<CanonProduct['attributesRich']> {
  const axes = new Set(p.options.map((o) => o.name.toLowerCase()));
  return (p.attributesRich ?? []).filter((a) => a.forVariation === false && !axes.has(a.name.toLowerCase()));
}
function collidingAttributes(p: CanonProduct): NonNullable<CanonProduct['attributesRich']> {
  const axes = new Set(p.options.map((o) => o.name.toLowerCase()));
  return (p.attributesRich ?? []).filter((a) => a.forVariation === false && axes.has(a.name.toLowerCase()));
}

export function serializeWooModern(products: CanonProduct[], { parentSkus = new Map<number, string>() }: { parentSkus?: Map<number, string> } = {}): { headers: string[]; rows: Row[] } {
  const metaKeys = Array.from(new Set(products.flatMap((p) => p.metafields.map((m) => m.key))));
  const ext = WOO_EXT.filter((e) => products.some(e.has)).map((e) => e.header);
  // Descriptive attributes (attributesRich, forVariation=false) take attribute
  // slots after the option axes; downloads take numbered slots.
  const descCount = Math.max(0, ...products.map((p) => descriptiveAttributes(p).length));
  const maxAttr = Math.max(3, ...products.map((p) => p.options.length + descriptiveAttributes(p).length));
  const attrExtra: string[] = [];
  for (let n = 4; n <= maxAttr; n++) attrExtra.push(`Attribute ${n} name`, `Attribute ${n} value(s)`, `Attribute ${n} visible`, `Attribute ${n} global`);
  const maxDl = Math.max(0, ...products.map((p) => p.digital?.downloads?.length ?? 0));
  const dlExtra: string[] = [];
  for (let n = 1; n <= maxDl; n++) dlExtra.push(`Download ${n} name`, `Download ${n} URL`);
  void descCount;
  const headers = [...WOO_HEADERS, ...attrExtra, ...ext, ...dlExtra, ...metaKeys.map((k) => `Meta: ${k}`)];
  const rows: Row[] = [];
  const blank = (): Row => Object.fromEntries(headers.map((h) => [h, '']));
  // Merchandising ids are SOURCE ids: resolve them to SKUs of products in this
  // batch (WooCommerce links upsells by SKU); unresolved ids are left out.
  // A SKU is only a real one (or one the user's generator made): the handle only when the source's SKU column gave
  // it (a WooCommerce CSV keys its parent rows on SKU → handle), never a handle made from the title.
  const skuOf = (p: CanonProduct, pi: number): string => ((p.options.length > 0 && p.variants.length > 1) ? (parentSkus.get(pi) || parentSkuFromSource(p)) : (p.variants[0]?.sku || ''));
  const skuBySourceId = new Map<string, string>();
  products.forEach((p, pi) => { const s = skuOf(p, pi); if (p.identity?.sourceId && s) skuBySourceId.set(String(p.identity.sourceId), s); });
  const resolveIds = (ids?: string[]): string => (ids ?? []).map((id) => skuBySourceId.get(String(id))).filter((s): s is string => !!s).join(', ');
  const setExt = (row: Row, key: string, value: string) => { if (headers.includes(key)) row[key] = value; };
  products.forEach((p, pi) => {
    const isVariable = p.options.length > 0 && p.variants.length > 1;
    // The parent's SKU is the join key of its variations in a WooCommerce import (« Parent » = the parent's SKU, or
    // id:N of a product that already exists). It is a real SKU or a generated one — never invented here: without
    // one, the variations cannot be linked and the result says so (wooParentSkuWarnings).
    const parentSku = skuOf(p, pi);
    const parent = blank();
    parent['Type'] = isVariable ? 'variable' : 'simple';
    parent['SKU'] = parentSku;
    parent['Name'] = p.title;
    parent['Published'] = p.published ? '1' : '0';
    parent['Visibility in catalog'] = p.visibility?.catalogVisibility ?? 'visible';
    if (p.visibility?.featured !== undefined) setExt(parent, 'Is featured?', p.visibility.featured ? '1' : '0');
    if (p.notes?.purchase) setExt(parent, 'Purchase note', p.notes.purchase);
    if (p.merchandising?.menuOrder !== undefined) setExt(parent, 'Position', String(p.merchandising.menuOrder));
    setExt(parent, 'Upsells', resolveIds(p.merchandising?.upsells));
    setExt(parent, 'Cross-sells', resolveIds(p.merchandising?.crossSells));
    if (p.external?.url) setExt(parent, 'External URL', p.external.url);
    if (p.external?.buttonText) setExt(parent, 'Button text', p.external.buttonText);
    if (p.digital?.downloadLimit !== undefined) setExt(parent, 'Download limit', p.digital.downloadLimit == null ? '-1' : String(p.digital.downloadLimit));
    if (p.digital?.downloadExpiry !== undefined) setExt(parent, 'Download expiry', p.digital.downloadExpiry == null ? '-1' : String(p.digital.downloadExpiry));
    (p.digital?.downloads ?? []).forEach((d, i) => { setExt(parent, `Download ${i + 1} name`, d.name ?? ''); setExt(parent, `Download ${i + 1} URL`, d.file ?? ''); });
    // descriptive attributes after the option axes — one whose NAME collides
    // with an option axis is not written twice (WooCommerce keys attributes by
    // name); it is reported as loss_woo_attribute_collision instead.
    descriptiveAttributes(p).forEach((a, i) => {
      const n = p.options.length + i + 1;
      setExt(parent, `Attribute ${n} name`, a.name);
      setExt(parent, `Attribute ${n} value(s)`, a.values.join(', '));
      setExt(parent, `Attribute ${n} visible`, a.visible === false ? '0' : '1');
      setExt(parent, `Attribute ${n} global`, '0');
    });
    const setVariantExt = (row: Row, v: CanonVariant) => {
      if (v.salePeriod?.from) setExt(row, 'Date sale price starts', wcDate(v.salePeriod.from));
      if (v.salePeriod?.to) setExt(row, 'Date sale price ends', wcDate(v.salePeriod.to));
      if (v.stockPolicy?.backorders !== undefined) setExt(row, 'Backorders allowed?', v.stockPolicy.backorders === 'no' ? '0' : v.stockPolicy.backorders === 'yes' ? '1' : 'notify');
      if (v.stockPolicy?.soldIndividually !== undefined) setExt(row, 'Sold individually?', v.stockPolicy.soldIndividually ? '1' : '0');
      if (v.taxClass) setExt(row, 'Tax class', v.taxClass);
      if (v.shippingClass) setExt(row, 'Shipping class', v.shippingClass);
      if (v.barcode) setExt(row, 'GTIN, UPC, EAN, or ISBN', v.barcode);
    };
    parent['Short description'] = p.shortDescription || p.seoDescription;
    parent['Description'] = p.bodyHtml;
    parent['Categories'] = joinWooList(p.categories);
    if (p.vendor) setExt(parent, 'Brands', joinWooList([p.vendor]));
    parent['Tags'] = p.tags.join(', ');
    // WooCommerce splits this cell on commas: a comma INSIDE an address (a CDN transformation path) is
    // percent-encoded so the importer never breaks the address apart.
    parent['Images'] = p.images.map((im) => encodeUrlForList(im.src, ',')).join(', ');
    p.options.forEach((o, oi) => {
      parent[`Attribute ${oi + 1} name`] = o.name;
      parent[`Attribute ${oi + 1} value(s)`] = o.values.join(', ');
      parent[`Attribute ${oi + 1} visible`] = '1';
      parent[`Attribute ${oi + 1} global`] = '1';
    });
    for (const m of p.metafields) parent[`Meta: ${m.key}`] = m.value;
    if (!isVariable) {
      const v = p.variants[0];
      if (v) {
        // Canon invariant: price = charged, compareAtPrice = higher "was".
        // Woo wants Regular = list (higher), Sale = the promo (lower).
        const hasPromo = v.compareAtPrice != null && v.price != null && v.compareAtPrice > v.price;
        parent['Regular price'] = hasPromo ? String(v.compareAtPrice) : (v.price != null ? String(v.price) : '');
        parent['Sale price'] = hasPromo ? String(v.price) : '';
        parent['Weight (kg)'] = v.grams != null ? String(gramsToKg(v.grams)) : '';
        parent['Length (cm)'] = v.lengthCm != null ? String(v.lengthCm) : '';
        parent['Width (cm)'] = v.widthCm != null ? String(v.widthCm) : '';
        parent['Height (cm)'] = v.heightCm != null ? String(v.heightCm) : '';
        parent['Stock'] = v.inventoryQty != null ? String(v.inventoryQty) : '';
        parent['In stock?'] = '1';
        parent['Tax status'] = v.taxable ? 'taxable' : 'none';
        parent['Virtual'] = v.requiresShipping ? 'no' : 'yes';
        setVariantExt(parent, v);
      }
      rows.push(parent);
    } else {
      rows.push(parent);
      p.variants.forEach((v, vi) => {
        const vr = blank();
        vr['Type'] = 'variation';
        // The variation's own SKU, or empty (WooCommerce does not generate one; « leave SKU blank » is allowed).
        vr['SKU'] = v.sku || '';
        vr['Name'] = `${p.title} - ${v.optionValues.join(', ')}`;
        vr['Published'] = '1';
        vr['Parent'] = parentSku;
        const vHasPromo = v.compareAtPrice != null && v.price != null && v.compareAtPrice > v.price;
        vr['Regular price'] = vHasPromo ? String(v.compareAtPrice) : (v.price != null ? String(v.price) : '');
        vr['Sale price'] = vHasPromo ? String(v.price) : '';
        vr['Tax status'] = v.taxable ? 'taxable' : 'none';
        vr['Virtual'] = v.requiresShipping ? 'no' : 'yes';
        vr['Weight (kg)'] = v.grams != null ? String(gramsToKg(v.grams)) : '';
        vr['Stock'] = v.inventoryQty != null ? String(v.inventoryQty) : '';
        // A variation without a tracked quantity is sellable: said, not left to WooCommerce's guess.
        if (v.inventoryQty == null) vr['In stock?'] = '1';
        vr['Images'] = encodeUrlForList(v.imageSrc, ',');
        p.options.forEach((o, oi) => { vr[`Attribute ${oi + 1} name`] = o.name; vr[`Attribute ${oi + 1} value(s)`] = v.optionValues[oi] || ''; });
        setVariantExt(vr, v);
        rows.push(vr);
      });
    }
  });
  return { headers, rows };
}

/** The parent SKU the source itself declared: the handle, when its provenance is a SKU / product-number column
 *  (WooCommerce CSV « SKU », Shopware « productNumber »), never a slug of the title. */
export function parentSkuFromSource(p: CanonProduct): string {
  const from = (p as { provenance?: Record<string, { sourceField?: string } | undefined> }).provenance?.handle?.sourceField || '';
  return /^(sku|reference|ref|productnumber|articlenumber|itemnumber)$/.test(String(from).toLowerCase().replace(/[\s_.-]+/g, '')) ? p.handle : '';
}

// WooCommerce links the variations of a NEW variable product to their parent by the parent's SKU (official
// importer: « Parent product ID or SKU for a variation »; a new product cannot be given an ID). A variable product
// with no real SKU and the generator off cannot be linked: said, never patched with an invented SKU.
export function wooParentSkuWarnings(products: CanonProduct[], parentSkus: Map<number, string> = new Map()): Warning[] {
  const missing = products.map((p, pi) => ((p.options.length > 0 && p.variants.length > 1 && !parentSkus.get(pi) && !parentSkuFromSource(p)) ? (p.handle || p.title) : null)).filter((h): h is string => !!h);
  if (!missing.length) return [];
  return [{ code: 'woo_parent_sku_missing', params: { count: missing.length, products: missing.slice(0, 8).join(', ') + (missing.length > 8 ? ' …' : '') } }];
}

// Handles/slugs must be unique — Shopify and WooCommerce both merge or overwrite
// rows that share one, and a duplicated parent handle breaks variation linking.
// Uniquify in place and report what was shared.
export function dedupeHandles(products: CanonProduct[]): Warning[] {
  const seen = new Map<string, number>();
  const shared = new Set<string>();
  for (const p of products) {
    const base = p.handle;
    const n = seen.get(base);
    if (n) { shared.add(base); seen.set(base, n + 1); p.handle = `${base}-${n + 1}`; }
    else seen.set(base, 1);
  }
  return [...shared].map((h) => ({ code: 'dedupe_handles', params: { handle: h } }));
}

// Duplicate SKUs make WooCommerce's importer unsure which product to update —
// a new row can overwrite an existing product. Flag them (we don't rewrite a
// real SKU she may rely on).
export function duplicateSkuWarnings(products: CanonProduct[]): Warning[] {
  // Track which products (handles) each SKU appears on, so the warning can name
  // them — a shared SKU is almost always the same code reused across two products
  // (e.g. a liquid and a powder), which the bare list of codes never made obvious.
  const bySku = new Map<string, string[]>();
  for (const p of products) for (const v of p.variants) {
    const s = v.sku.trim(); if (!s) continue;
    const arr = bySku.get(s) ?? []; arr.push(p.handle); bySku.set(s, arr);
  }
  const dups = [...bySku.entries()].filter(([, hs]) => hs.length > 1);
  if (!dups.length) return [];
  const detail = dups.slice(0, 8)
    .map(([s, hs]) => `${s} (${Array.from(new Set(hs)).join(', ')})`)
    .join(' · ') + (dups.length > 8 ? ' …' : '');
  return [{ code: 'duplicate_skus', params: { skus: detail } }];
}

// Migration redirect map: apply the old + new URL bases to every product handle,
// so the old store URL 301s to the new one and SEO follows a move. FROM uses the
// ORIGINAL source handle (the URL currently indexed); TO uses the final, unique
// handle — what the target product's slug should be. Bases are normalised to end
// with a single slash. Returns a 2-column CSV any redirect tool can read.
export function buildRedirects(products: CanonProduct[], origHandles: string[], oldBase: string, newBase: string): { headers: string[]; rows: Row[] } {
  const norm = (b: string) => b.trim().replace(/\/+$/, '') + '/';
  const ob = norm(oldBase), nb = norm(newBase);
  const rows: Row[] = products
    .map((p, i) => ({ 'Source URL': ob + (origHandles[i] || p.handle), 'Target URL': nb + p.handle }))
    .filter((r) => r['Source URL'] !== r['Target URL']);
  return { headers: ['Source URL', 'Target URL'], rows };
}

// ── Losses per direction (target-fault framing) ──────────────────────────────
// Phase 6.3 — the two canon additions no CSV target consumes in full are
// reported UNIFORMLY (one code per target, same shape everywhere) instead of
// three silent drops:
//   translations : no product CSV import is multi-locale → `loss_<target>_translations`
//                  with the locales seen;
//   identifiers  : each target consumes a subset (`consumed`); every other
//                  kind actually carried by a variant is listed in
//                  `loss_<target>_identifiers` { kinds }.
const IDENTIFIER_KINDS = ['gtin', 'ean', 'upc', 'isbn', 'mpn', 'hsCode', 'originCountry'] as const;
export function translationsLoss(target: 'shopify' | 'woo' | 'wix' | 'bc', products: CanonProduct[]): Loss[] {
  const locales = Array.from(new Set(products.flatMap((p) => Object.keys(p.translations ?? {})))).sort();
  return locales.length ? [{ code: `loss_${target}_translations`, params: { locales: locales.join(', ') } }] : [];
}
// Phase 6.4 — no product CSV import (Shopify, WooCommerce, Wix, BigCommerce)
// can create a bundle's composition: the bundle product itself is exported as
// a normal product (its own SKU / price / stock), the composition is reported
// with the handles concerned. One code per target, same shape.
export function bundlesLoss(target: 'shopify' | 'woo' | 'wix' | 'bc', products: CanonProduct[]): Loss[] {
  const handles = products.filter((p) => p.kind === 'bundle' || p.variants.some((v) => (v.components?.length ?? 0) > 0)).map((p) => p.handle);
  return handles.length ? [{ code: `loss_${target}_bundles`, params: { count: handles.length, handles: handles.slice(0, 8).join(', ') + (handles.length > 8 ? '…' : '') } }] : [];
}
// Phase 6 (C1) — no product CSV import carries quantity / rule price tiers:
// the variant keeps its single price, the tiers are reported with a count.
export function priceTiersLoss(target: 'shopify' | 'woo' | 'wix' | 'bc', products: CanonProduct[]): Loss[] {
  const tiers = products.reduce((n, p) => n + p.variants.reduce((m, v) => m + (v.priceTiers?.length ?? 0), 0), 0);
  const handles = products.filter((p) => p.variants.some((v) => (v.priceTiers?.length ?? 0) > 0)).map((p) => p.handle);
  return tiers ? [{ code: `loss_${target}_price_tiers`, params: { count: tiers, products: handles.length, handles: handles.slice(0, 8).join(', ') + (handles.length > 8 ? '…' : '') } }] : [];
}
export function identifiersLoss(target: 'shopify' | 'woo' | 'wix' | 'bc', products: CanonProduct[], consumed: readonly string[]): Loss[] {
  const kinds = IDENTIFIER_KINDS.filter((k) => !consumed.includes(k) && products.some((p) => p.variants.some((v) => !!v.identifiers?.[k])));
  return kinds.length ? [{ code: `loss_${target}_identifiers`, params: { kinds: kinds.join(', ') } }] : [];
}
// What each target's CSV can hold: the single barcode column takes the
// derived `barcode`, so gtin/ean/upc/isbn are NOT lost when they became it —
// only kinds beyond the barcode are (mpn, customs) unless a column exists.
export const IDENTIFIERS_CONSUMED = {
  shopify: ['gtin', 'ean', 'upc', 'isbn'],               // Variant Barcode (one code)
  woo: ['gtin', 'ean', 'upc', 'isbn'],                   // GTIN, UPC, EAN, or ISBN (one code)
  wix: ['gtin', 'ean', 'upc', 'isbn'],                   // barcode (one code); no MPN / HS code column
  bc: ['gtin', 'ean', 'upc', 'isbn', 'mpn'],             // UPC/EAN + Global Trade Number + Manufacturer Part Number
} as const;

// ── Pivot fields a target cannot hold (2026-10: short description, VAT, currency, unit price) ──
// The CSV of the four platforms has no column for a price currency or a price per unit of
// measure, Shopify / Wix / BigCommerce have no short description, and only the long-text
// "custom field" lanes of Shopify and WooCommerce take a VAT rate (carried below as the
// metafield vat_rate, the same key BigBuy uses). Anything else is declared, never dropped.
type PivotTarget = 'shopify' | 'woo' | 'wix' | 'bc';
const TARGET_LABEL: Record<PivotTarget, string> = { shopify: 'Shopify', woo: 'WooCommerce', wix: 'Wix', bc: 'BigCommerce' };

const vatOf = (p: CanonProduct): number | undefined => p.variants.find((v) => v.vatRate != null)?.vatRate;

/** Shopify and WooCommerce get the VAT rate as the product metafield "vat_rate". */
export function carryPivotExtras(target: PivotTarget, products: CanonProduct[]): CanonProduct[] {
  if (target !== 'shopify' && target !== 'woo') return products;
  return products.map((p) => {
    const vat = vatOf(p);
    if (vat == null || p.metafields.some((m) => m.key === 'vat_rate')) return p;
    return { ...p, metafields: [...p.metafields, { key: 'vat_rate', value: String(vat) }] };
  });
}

export function pivotExtrasLosses(target: PivotTarget, products: CanonProduct[]): Loss[] {
  const target_ = TARGET_LABEL[target];
  const losses: Loss[] = [];
  const short = products.filter((p) => (p.shortDescription ?? '').trim() !== '');
  if (short.length && target !== 'woo') losses.push({ code: 'loss_short_description', params: { target: target_, count: short.length } });
  const vat = products.filter((p) => vatOf(p) != null);
  if (vat.length && target !== 'shopify' && target !== 'woo') losses.push({ code: 'loss_vat_rate', params: { target: target_, count: vat.length } });
  const currencies = Array.from(new Set(products.map((p) => p.currency).filter((c): c is string => !!c)));
  if (currencies.length) losses.push({ code: 'loss_currency', params: { target: target_, currencies: currencies.join(', ') } });
  const unit = products.filter((p) => p.variants.some((v) => v.unitPrice));
  if (unit.length) losses.push({ code: 'loss_unit_price', params: { target: target_, count: unit.length } });
  return losses;
}

// The category is written to "Product Category", but Shopify only accepts values of ITS taxonomy
// (anything else is ignored at import) and only one per product: say so instead of hiding it.
function shopifyCategoryLoss(products: CanonProduct[]): Loss[] {
  const withCat = products.filter((p) => p.categories.length > 0);
  if (!withCat.length) return [];
  return [{ code: 'loss_shopify_category_taxonomy', params: { count: withCat.length, extra: withCat.filter((p) => p.categories.length > 1).length } }];
}

export function productLossesToWoo(products: CanonProduct[]): Loss[] {
  const losses: Loss[] = [];
  if (products.some((p) => p.variants.some((v) => v.cost != null)))
    losses.push({ code: 'loss_woo_cost' });
  losses.push(...translationsLoss('woo', products), ...identifiersLoss('woo', products, IDENTIFIERS_CONSUMED.woo), ...bundlesLoss('woo', products), ...priceTiersLoss('woo', products), ...pivotExtrasLosses('woo', products));
  // barcode → 'GTIN, UPC, EAN, or ISBN' and vendor → 'Brands' are carried since
  // Phase 6 (loss_woo_barcode retired). A hierarchical brand is flattened to
  // its leaf on the way in, never on the way out, so nothing is reported here.
  if (products.some((p) => p.seoTitle))
    losses.push({ code: 'loss_woo_seo_title' });
  const collisions = products.flatMap((p) => collidingAttributes(p).map((a) => a.name));
  if (collisions.length)
    losses.push({ code: 'loss_woo_attribute_collision', params: { names: Array.from(new Set(collisions)).join(', ') } });
  return losses;
}

export function productLossesToShopify(products: CanonProduct[]): Loss[] {
  const losses: Loss[] = [];
  if (products.some((p) => p.variants.some((v) => v.lengthCm != null || v.widthCm != null || v.heightCm != null)))
    losses.push({ code: 'loss_shopify_dimensions' });
  losses.push(...translationsLoss('shopify', products), ...identifiersLoss('shopify', products, IDENTIFIERS_CONSUMED.shopify), ...bundlesLoss('shopify', products), ...priceTiersLoss('shopify', products), ...pivotExtrasLosses('shopify', products),
    ...shopifyCategoryLoss(products));
  return losses;
}
