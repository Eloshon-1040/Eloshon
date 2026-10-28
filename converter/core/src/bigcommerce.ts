import type {
  CanonProduct, CanonVariant, CanonImage, CanonCustomer, CanonOrder, CanonLineItem, Loss, Warning, Question,
} from './types';
import type { Row } from './csv';
import { cleanScalar } from './csv';
import { num, kgToGrams, lbsToGrams, gramsToKg, stateToName, parseConsent } from './normalize';
import { translationsLoss, identifiersLoss, bundlesLoss, priceTiersLoss, pivotExtrasLosses, IDENTIFIERS_CONSUMED } from './products';

// P3 (6.3): BigCommerce splits its identifiers over three columns. Only set
// when the exporter wrote them, so a plain file yields the same canon as before.
function bcIdentifiers(r: Row): CanonVariant['identifiers'] | undefined {
  const out: NonNullable<CanonVariant['identifiers']> = {};
  const gtin = cleanScalar(r['Global Trade Number'] || ''); if (gtin) out.gtin = gtin;
  const mpn = cleanScalar(r['Manufacturer Part Number'] || ''); if (mpn) out.mpn = mpn;
  return Object.keys(out).length ? out : undefined;
}

// ── BigCommerce ──────────────────────────────────────────────────────────────
// Three hard facts shape this module:
//  1. PRODUCTS attach POSITIONALLY. An `Item` column declares each row's role
//     (Product / Variant / Image / Video); nothing links a Variant or Image to
//     its Product except row order. So we must read in order and never sort.
//  2. The IMAGE column is asymmetric: an export fills `Internal Image URL
//     (Export)`, but an import reads `Image URL (Import)`. We read the former and
//     write the latter — otherwise images vanish silently.
//  3. Several fields are bare numeric IDs with NO lookup table in the export —
//     `Categories` (e.g. 23;18), `Brand ID`, `Tax Class`. Names are unrecoverable
//     from the file, so we keep the IDs (as metafields) and declare the loss.
// ORDERS have no CSV import at all (API only) — BigCommerce is an order source,
// never an order target. The capability matrix enforces that.

const c = cleanScalar;
const isTrue = (v: string | undefined) => (v ?? '').trim().toUpperCase() === 'TRUE';

// ── Products: the 50 columns, in the export's exact order ─────────────────────
const BC_PRODUCT_HEADERS = [
  'Item', 'ID', 'Name', 'Type', 'SKU', 'Options', 'Inventory Tracking', 'Current Stock', 'Low Stock',
  'Price', 'Cost Price', 'Retail Price', 'Sale Price', 'Brand ID', 'Channels', 'Categories', 'Description',
  'Custom Fields', 'Page Title', 'Product URL', 'Meta Description', 'Search Keywords', 'Meta Keywords',
  'Bin Picking Number', 'UPC/EAN', 'Global Trade Number', 'Manufacturer Part Number', 'Free Shipping',
  'Fixed Shipping Cost', 'Weight', 'Width', 'Height', 'Depth', 'Is Visible', 'Is Featured', 'Warranty',
  'Tax Class', 'Product Condition', 'Show Product Condition', 'Sort Order', 'Variant Image URL',
  'Internal Image URL (Export)', 'Image URL (Import)', 'Image Description', 'Image is Thumbnail',
  'Image Sort Order', 'YouTube ID', 'Video Title', 'Video Description', 'Video Sort Order',
];

// The Options cell packs blocks with NO separator between them:
//   Type=Rectangle|Name=Size|Value=XSType=Swatch|Name=Color|Value=Silver[#cccccc]
// A block always starts at "Type=<word>|Name=" — split on that boundary, never on
// '|' (which would give a size value of "XSType=Swatch").
function parseOptions(options: string): { name: string; label: string; hex: string }[] {
  const raw = (options ?? '').trim();
  if (!raw) return [];
  return raw.split(/(?=Type=\w+\|Name=)/).filter(Boolean).map((block) => {
    const m = block.match(/^Type=[^|]*\|Name=(.+?)\|Value=([\s\S]*)$/);
    if (!m) return { name: '', label: c(block), hex: '' };
    const name = c(m[1]);
    const rawVal = c(m[2]);
    const hexMatch = rawVal.match(/\[(#?[0-9a-fA-F]{3,8})\]\s*$/);
    const label = rawVal.replace(/\[#?[0-9a-fA-F]{3,8}\]\s*$/, '').trim();
    const hex = hexMatch ? (hexMatch[1].startsWith('#') ? hexMatch[1] : `#${hexMatch[1]}`) : '';
    return { name, label, hex };
  });
}

export function parseBigCommerceProducts(rows: Row[], weightUnit?: 'kg' | 'lbs'): { products: CanonProduct[]; warnings: Warning[]; questions: Question[] } {
  const warnings: Warning[] = [];
  const questions: Question[] = [];
  const products: CanonProduct[] = [];
  type Base = { price: number | null; cost: number | null; grams: number | null; lengthCm: number | null; widthCm: number | null; heightCm: number | null };
  let cur: (CanonProduct & { _swatch?: Record<string, string>; _optNames?: string[]; _base?: Base; _varOpts?: Record<string, string>[] }) | null = null;
  let weightUnitAsked = false;
  let orphanRows = 0;

  function toGrams(w: number | null): number | null {
    if (w == null) return null;
    if (weightUnit === 'lbs') return lbsToGrams(w);
    if (weightUnit === 'kg') return kgToGrams(w);
    if (!weightUnitAsked) {
      weightUnitAsked = true;
      questions.push({ kind: 'weight_unit', code: 'bc_weight_unit_unknown', options: ['kg', 'lbs'] });
    }
    return null;
  }

  // Build options and swatch metafields, then drop the transient helper fields.
  // CRITICAL: a variant's option values are realigned to the product's option
  // ORDER by NAME (via the per-variant name→value map), never by the block order
  // they happened to appear in — otherwise a variant that lists Color before
  // Size would silently file Color's value under Size (a wrong-but-valid row).
  const flush = () => {
    if (!cur) return;
    const names = cur._optNames ?? [];
    const vo = cur._varOpts ?? [];
    if (names.length && vo.length) {
      cur.variants.forEach((v, i) => { v.optionValues = names.map((n) => vo[i]?.[n] ?? ''); });
      cur.options = names.map((name, i) => ({
        name,
        values: Array.from(new Set(cur!.variants.map((v) => v.optionValues[i]).filter(Boolean))),
      }));
    }
    for (const [name, hex] of Object.entries(cur._swatch ?? {})) {
      if (hex) cur.metafields.push({ key: `swatch_${slug(name)}`, value: hex });
    }
    delete cur._swatch; delete cur._optNames; delete cur._base; delete cur._varOpts;
    products.push(cur);
    cur = null;
  };

  for (const r of rows) {
    const item = (r.Item || '').trim().toLowerCase();

    if (item === 'product') {
      flush();
      const url = c(r['Product URL'] || '');
      const handle = url ? url.replace(/^\/+|\/+$/g, '') : slug(c(r.Name || ''));
      const metafields: { key: string; value: string }[] = [];
      const brandId = c(r['Brand ID'] || '');
      if (brandId) metafields.push({ key: 'bigcommerce_brand_id', value: brandId });
      const catIds = c(r.Categories || '');
      if (catIds) metafields.push({ key: 'bigcommerce_category_ids', value: catIds });
      const retail = num(r['Retail Price']);
      if (retail != null) metafields.push({ key: 'retail_price', value: String(retail) });
      const warranty = c(r.Warranty || '');
      if (warranty) metafields.push({ key: 'warranty', value: warranty });
      const bin = c(r['Bin Picking Number'] || '');
      if (bin) metafields.push({ key: 'bin_picking_number', value: bin });

      const grams = toGrams(num(r.Weight));
      const digital = (r.Type || '').trim().toLowerCase() === 'digital';
      // BC `Sale Price` is the LOWER promo price. Canon invariant: `price` =
      // charged, `compareAtPrice` = higher "was". Swap when a real promo is set.
      const bcPrice = num(r.Price);
      const bcSale = num(r['Sale Price']);
      const bcPromo = bcSale != null && bcPrice != null && bcSale < bcPrice;
      const baseVariant: CanonVariant = {
        optionValues: [],
        sku: c(r.SKU || ''),
        price: bcPromo ? bcSale : bcPrice,
        compareAtPrice: bcPromo ? bcPrice : null,
        cost: num(r['Cost Price']),
        barcode: c(r['UPC/EAN'] || ''),
        grams,
        lengthCm: num(r.Depth), widthCm: num(r.Width), heightCm: num(r.Height),
        requiresShipping: !digital,
        taxable: true,
        inventoryQty: num(r['Current Stock']),
        imageSrc: '',
        ...(bcIdentifiers(r) ? { identifiers: bcIdentifiers(r) } : {}),
      };
      const visible = isTrue(r['Is Visible']);
      cur = {
        handle,
        title: c(r.Name || ''),
        bodyHtml: r.Description || '',
        vendor: '',
        productType: '',
        tags: [],
        status: visible ? 'active' : 'draft',
        categories: [],
        published: visible,
        options: [],
        variants: [baseVariant], // replaced if the product has Variant rows
        images: [],
        metafields,
        seoTitle: c(r['Page Title'] || ''),
        seoDescription: c(r['Meta Description'] || ''),
        _swatch: {},
        _optNames: [],
        _varOpts: [],
        // Product-level defaults a bare Variant row inherits (BigCommerce leaves
        // a variant's price/weight blank to mean "same as the product").
        _base: { price: num(r.Price), cost: num(r['Cost Price']), grams, lengthCm: num(r.Depth), widthCm: num(r.Width), heightCm: num(r.Height) },
      };
      continue;
    }

    if (!cur) { orphanRows++; continue; } // a variant/image/video before any Product — the file was re-sorted

    if (item === 'variant') {
      // First Variant row replaces the placeholder single variant.
      if (cur.variants.length === 1 && cur.variants[0].optionValues.length === 0 && cur._optNames!.length === 0) {
        cur.variants = [];
      }
      const opts = parseOptions(r.Options || '');
      const vmap: Record<string, string> = {};
      for (const o of opts) {
        if (o.name && !cur._optNames!.includes(o.name)) cur._optNames!.push(o.name);
        if (o.name) vmap[o.name] = o.label; // keyed by NAME so flush can realign by name, not position
        if (o.hex) cur._swatch![o.name] = o.hex;
      }
      cur._varOpts!.push(vmap);
      const base = cur._base!;
      const vPrice = num(r.Price) ?? base.price;
      const vSale = num(r['Sale Price']);
      const vPromo = vSale != null && vPrice != null && vSale < vPrice;
      cur.variants.push({
        optionValues: opts.map((o) => o.label), // provisional — flush realigns by name
        sku: c(r.SKU || ''),
        price: vPromo ? vSale : vPrice,
        compareAtPrice: vPromo ? vPrice : null,
        cost: num(r['Cost Price']) ?? base.cost,
        barcode: c(r['UPC/EAN'] || ''),
        grams: toGrams(num(r.Weight)) ?? base.grams,
        lengthCm: num(r.Depth) ?? base.lengthCm, widthCm: num(r.Width) ?? base.widthCm, heightCm: num(r.Height) ?? base.heightCm,
        requiresShipping: true,
        taxable: true,
        inventoryQty: num(r['Current Stock']),
        imageSrc: c(r['Variant Image URL'] || ''),
        ...(bcIdentifiers(r) ? { identifiers: bcIdentifiers(r) } : {}),
      });
      continue;
    }

    if (item === 'image') {
      // Read the EXPORT column (import column is empty in an export).
      const src = c(r['Internal Image URL (Export)'] || r['Image URL (Import)'] || '');
      if (src) {
        cur.images.push({
          src,
          position: (num(r['Image Sort Order']) ?? cur.images.length) + 1,
          alt: c(r['Image Description'] || ''),
        } as CanonImage);
      }
      continue;
    }

    if (item === 'video') {
      const yt = c(r['YouTube ID'] || '');
      if (yt) cur.metafields.push({ key: 'youtube_id', value: yt });
      continue;
    }
  }
  flush();
  if (orphanRows > 0)
    warnings.push({ code: 'bc_orphan_rows', params: { count: orphanRows } });
  return { products, warnings, questions };
}

// ── Serialize: BigCommerce products ──────────────────────────────────────────
export function serializeBigCommerceProducts(products: CanonProduct[]): { headers: string[]; rows: Row[] } {
  const rows: Row[] = [];
  const blank = (): Row => Object.fromEntries(BC_PRODUCT_HEADERS.map((h) => [h, '']));
  for (const p of products) {
    const hasVariants = p.options.length > 0 && p.variants.length > 1;
    const first = p.variants[0];
    const catIds = p.metafields.find((m) => m.key === 'bigcommerce_category_ids')?.value ?? '';
    const brandId = p.metafields.find((m) => m.key === 'bigcommerce_brand_id')?.value ?? '';
    const retail = p.metafields.find((m) => m.key === 'retail_price')?.value ?? '';

    const prod = blank();
    prod.Item = 'Product';
    prod.ID = ''; // vacate — a carried ID overwrites an existing BigCommerce product
    prod.Name = p.title;
    prod.Type = first && first.requiresShipping === false ? 'digital' : 'physical';
    prod.SKU = hasVariants ? '' : (first?.sku ?? '');
    prod['Inventory Tracking'] = hasVariants ? 'variant' : (first?.inventoryQty != null ? 'product' : 'none');
    prod['Current Stock'] = !hasVariants && first?.inventoryQty != null ? String(first.inventoryQty) : '';
    // BC wants Price = list (higher) + Sale Price = promo (lower). Canon
    // stores it the OPPOSITE way (price = charged, compareAtPrice = higher
    // "was"), so swap on the way out.
    const prodPromo = first?.compareAtPrice != null && first?.price != null && first.compareAtPrice > first.price;
    prod.Price = prodPromo ? first!.compareAtPrice!.toFixed(2) : (first?.price != null ? first.price.toFixed(2) : '');
    prod['Cost Price'] = first?.cost != null ? first.cost.toFixed(2) : '';
    prod['Retail Price'] = retail;
    prod['Sale Price'] = prodPromo ? first!.price!.toFixed(2) : '';
    prod['Brand ID'] = brandId;
    prod.Categories = catIds; // only pre-existing IDs — never invented
    prod.Description = p.bodyHtml;
    prod['Page Title'] = p.seoTitle;
    prod['Product URL'] = `/${p.handle}/`;
    prod['Meta Description'] = p.seoDescription;
    prod['UPC/EAN'] = first?.barcode ?? '';
    // P3 (6.3): the typed identifiers BigCommerce has columns for. Pruned with
    // the other empty columns when no product carries them.
    prod['Global Trade Number'] = first?.identifiers?.gtin ?? '';
    prod['Manufacturer Part Number'] = first?.identifiers?.mpn ?? '';
    prod.Weight = first?.grams != null ? String(gramsToKg(first.grams)) : '';
    prod.Width = first?.widthCm != null ? String(first.widthCm) : '';
    prod.Height = first?.heightCm != null ? String(first.heightCm) : '';
    prod.Depth = first?.lengthCm != null ? String(first.lengthCm) : '';
    prod['Is Visible'] = p.published ? 'TRUE' : 'FALSE';
    prod['Product Condition'] = 'New';
    prod['Show Product Condition'] = 'FALSE';
    prod['Free Shipping'] = 'FALSE';
    rows.push(prod);

    if (hasVariants) {
      for (const v of p.variants) {
        const vr = blank();
        vr.Item = 'Variant';
        vr.SKU = v.sku;
        vr.Options = p.options.map((o, oi) => `Type=Dropdown|Name=${o.name}|Value=${v.optionValues[oi] || ''}`).join('');
        vr['Current Stock'] = v.inventoryQty != null ? String(v.inventoryQty) : '';
        vr['Cost Price'] = v.cost != null ? v.cost.toFixed(2) : '';
        const vPromo2 = v.compareAtPrice != null && v.price != null && v.compareAtPrice > v.price;
        if (vPromo2) { vr.Price = v.compareAtPrice!.toFixed(2); vr['Sale Price'] = v.price!.toFixed(2); }
        else if (v.price != null) vr.Price = v.price.toFixed(2);
        vr['UPC/EAN'] = v.barcode;
        if (v.identifiers?.gtin) vr['Global Trade Number'] = v.identifiers.gtin;
        if (v.identifiers?.mpn) vr['Manufacturer Part Number'] = v.identifiers.mpn;
        vr.Weight = v.grams != null ? String(gramsToKg(v.grams)) : '';
        if (v.imageSrc) vr['Variant Image URL'] = v.imageSrc;
        rows.push(vr);
      }
    }

    p.images.forEach((img, i) => {
      const ir = blank();
      ir.Item = 'Image';
      ir['Image URL (Import)'] = img.src; // write the IMPORT column, not the export one
      ir['Image Description'] = img.alt;
      ir['Image is Thumbnail'] = i === 0 ? 'TRUE' : 'FALSE';
      ir['Image Sort Order'] = String(i);
      rows.push(ir);
    });
  }

  // The doc's guidance: don't ship empty columns. Keep only columns actually
  // used (always keep Item), so the file is the clean subset BigCommerce wants.
  const headers = BC_PRODUCT_HEADERS.filter((h) => h === 'Item' || rows.some((r) => (r[h] ?? '') !== ''));
  return { headers, rows };
}

// ── Customers ────────────────────────────────────────────────────────────────
const BC_CUSTOMER_HEADERS = [
  'Email', 'First Name', 'Last Name', 'Company', 'Phone', 'Notes', 'Store Credit', 'Customer Group',
  'Address First Name', 'Address Last Name', 'Address Company', 'Address Line 1', 'Address Line 2',
  'City/Suburb', 'State/Province', 'Zip/Postcode', 'Country', 'Address Phone', 'Receive Marketing Emails',
];

// Parsed by the GENERIC parser since Phase 2 (bigcommerce.customers.csv.v1.json).

export function serializeBigCommerceCustomers(customers: CanonCustomer[]): { headers: string[]; rows: Row[] } {
  const rows = customers.map((cu) => {
    const a = cu.address;
    return {
      Email: cu.email,
      'First Name': cu.firstName,
      'Last Name': cu.lastName,
      Company: a.company,
      Phone: cu.phone,
      Notes: cu.note,
      'Store Credit': '',
      'Customer Group': cu.tags[0] ?? '',
      'Address First Name': cu.firstName,
      'Address Last Name': cu.lastName,
      'Address Company': a.company,
      'Address Line 1': a.address1,
      'Address Line 2': a.address2,
      'City/Suburb': a.city,
      // BigCommerce customer addresses want the state spelled out, never abbreviated.
      'State/Province': stateToName(a.provinceCode || a.province, a.country),
      'Zip/Postcode': a.zip,
      Country: a.country,
      'Address Phone': a.phone || cu.phone,
      // 7.3 hard rule: never subscribed on the target — the merchant re-confirms.
      'Receive Marketing Emails': 'N',
    } as Row;
  });
  return { headers: BC_CUSTOMER_HEADERS, rows };
}

// ── Orders (SOURCE only — no CSV import into BigCommerce) ─────────────────────
export function parseBigCommerceOrders(rows: Row[]): { orders: CanonOrder[]; warnings: Warning[] } {
  const warnings: Warning[] = [];
  // Rows sharing an Order ID are one order split across line items (or
  // consignments). Group in order; order-level fields come from the first row.
  const order: string[] = [];
  const groups = new Map<string, Row[]>();
  rows.forEach((r) => {
    const id = c(r['Order ID'] || '');
    if (!id) return;
    if (!groups.has(id)) { groups.set(id, []); order.push(id); }
    groups.get(id)!.push(r);
  });

  const addr = (r: Row, side: 'Billing' | 'Shipping') => ({
    company: c(r[`${side} Company`] || ''),
    address1: c(r[`${side} Street 1`] || ''),
    address2: c(r[`${side} Street 2`] || ''),
    city: c(r[`${side} Suburb`] || ''),
    province: c(r[`${side} State Abbreviation`] || ''),
    provinceCode: c(r[`${side} State Abbreviation`] || ''),
    country: c(r[`${side} Country`] || ''),
    zip: c(r[`${side} Zip`] || ''),
    phone: c(r[`${side} Phone`] || ''),
  });

  const orders = order.map((id) => {
    const g = groups.get(id)!;
    const head = g[0];
    const lineItems: CanonLineItem[] = g
      .filter((r) => c(r['Product Name'] || r['Product SKU'] || '') !== '')
      .map((r) => ({
        name: c(r['Product Name'] || ''),
        sku: c(r['Product SKU'] || ''),
        quantity: num(r['Product Qty']) ?? 1,
        price: num(r['Product Unit Price']),
      }));
    const status = (head['Order Status'] || '').trim().toLowerCase();
    const financial = /refun/.test(status) ? 'refunded' : /cancel|void/.test(status) ? 'voided' : /pend|await|incomplete/.test(status) ? 'pending' : 'paid';
    const fulfillment = /ship|complet|deliver/.test(status) ? 'fulfilled' : 'unfulfilled';
    return {
      number: id,
      email: c(head['Customer Email'] || ''),
      createdAt: c(head['Order Date'] || ''),
      financialStatus: financial,
      fulfillmentStatus: fulfillment,
      currency: c(head['Order Currency Code'] || ''),
      subtotal: num(head['Subtotal (inc tax)']),
      shipping: num(head['Shipping Cost (inc tax)']),
      taxes: num(head['Tax Total']),
      total: num(head['Order Total (inc tax)']),
      discountCode: c(head['Coupon Code'] || ''),
      discountAmount: num(head['Coupon Value']),
      paymentMethod: c(head['Payment Method'] || ''),
      transactionId: c(head['Transaction ID'] || ''),
      note: c(head['Customer Message'] || head['Order Notes'] || ''),
      billing: { name: `${c(head['Billing First Name'] || '')} ${c(head['Billing Last Name'] || '')}`.trim(), ...addr(head, 'Billing') },
      shipping_: { name: `${c(head['Shipping First Name'] || '')} ${c(head['Shipping Last Name'] || '')}`.trim(), ...addr(head, 'Shipping') },
      lineItems,
    } as CanonOrder;
  });

  if (rows.some((r) => c(r['Fee details'] || r['Gift Certificate Amount Redeemed'] || '') !== ''))
    warnings.push({ code: 'bc_order_fees' });
  return { orders, warnings };
}

// ── Losses ───────────────────────────────────────────────────────────────────
export function bcProductSourceLosses(products: CanonProduct[]): Loss[] {
  const l: Loss[] = [];
  if (products.some((p) => p.metafields.some((m) => m.key === 'bigcommerce_category_ids')))
    l.push({ code: 'loss_bc_category_names' });
  if (products.some((p) => p.metafields.some((m) => m.key === 'bigcommerce_brand_id')))
    l.push({ code: 'loss_bc_brand_name' });
  if (products.some((p) => p.metafields.some((m) => m.key === 'bin_picking_number' || m.key === 'warranty')))
    l.push({ code: 'loss_bc_warranty_bin' });
  return l;
}

export function bcProductTargetLosses(products: CanonProduct[] = []): Loss[] {
  return [
    { code: 'loss_bc_categories_target' },
    { code: 'loss_bc_images_target' },
    // 6.3: no locale in the BC product CSV; identifiers beyond UPC/EAN + GTIN + MPN (customs) are not carried
    ...translationsLoss('bc', products),
    ...identifiersLoss('bc', products, IDENTIFIERS_CONSUMED.bc),
    ...bundlesLoss('bc', products),
    ...priceTiersLoss('bc', products),
    ...pivotExtrasLosses('bc', products),
  ];
}

export function bcCustomerTargetLosses(): Loss[] {
  return [{ code: 'loss_bc_passwords' }];
}

export function bcOrderSourceLosses(): Loss[] {
  return [
    { code: 'loss_bc_order_fees' },
  ];
}

function slug(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'product';
}
