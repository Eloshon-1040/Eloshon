/**
 * Phase 2 Lot 3 — the legacy CSV formats, one spec per format. Each format's
 * knowledge entry (core/knowledge-ref/formats) declares its columns and row
 * structure as DATA; the generic pass (core/knowledge-proposal/legacy-units.mjs)
 * then preserves every undeclared column and traces every declared one, on the
 * canon units the bespoke parser produced. Per format this suite proves:
 *   1. the data-declared grouping is aligned with the parser on every fixture
 *      of the format (no 'preservation_unaligned'), and exactly the reviewed
 *      columns are undeclared (a column the parser reads is never "unknown");
 *   2. an extra unknown column is preserved verbatim (canon) and reported in
 *      ConvertResult.preserved — while the exported file stays byte-identical
 *      to the same file without that column;
 *   3. declared columns carry provenance on the canon path they feed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convert, parseCsv, serializeCsv, analyzeProblems } from '../core/dist/index.mjs';
import * as products from '../core/dist/products.mjs';
import * as units from '../core/dist/units.mjs';
import * as bigcommerce from '../core/dist/bigcommerce.mjs';
import * as bigbuy from '../core/dist/bigbuy.mjs';
import * as orders from '../core/dist/orders.mjs';
import * as wix from '../core/dist/wix.mjs';
import { loadReferenceFormatsSync } from '../core/knowledge-proposal/reference.mjs';
import { annotateUnits, declaredColumns } from '../core/knowledge-proposal/legacy-units.mjs';

const FIX = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'test', 'fixtures');
const read = (rel) => fs.readFileSync(path.join(FIX, rel), 'utf8');
const REF = loadReferenceFormatsSync();
const EXTRA = 'Note interne (export ERP)';

// One spec per migrated format. `undeclared` is the REVIEWED list of columns
// the bespoke parser does not read, per fixture. `parse` returns the parser's
// canon units for a table; `trace` names one declared column whose provenance
// must land on a canon path of the first unit (or its first child).
export const SPECS = [
  {
    id: 'woocommerce.products.csv.legacy.v1', platform: 'woocommerce',
    opts: { direction: 'woocommerce-to-shopify', expectPlatform: 'woocommerce' },
    fixtures: { 'woo_products_legacy.csv': [] },
    generic: true,
    parse: (t) => units.parseProductsTable('woo_products_legacy', t),
    trace: [{ path: 'title', column: 'post_title' }, { child: true, path: 'price', column: 'regular_price + sale_price' }],
  },
  {
    id: 'shopify.customers.csv.v1', platform: 'shopify',
    opts: { direction: 'shopify-to-woocommerce', expectPlatform: 'shopify' },
    fixtures: {
      'shopify_customers.csv': [],
      // the real-shaped export: ids, purchase totals and an app's customer metafields were silently dropped before
      'shopify-customers-synthetic/customers_export.csv': ['Customer ID', 'Total Spent', 'Total Orders', 'Company (customer.metafields.froonze_cp_custom.company)', 'Taxes number (customer.metafields.froonze_cp_custom.taxes_number)', 'Website URL (customer.metafields.froonze_cp_custom.website_url)'],
    },
    // retired bespoke parser: the generic parser reads it (structure.parser "generic")
    generic: true,
    parse: (t) => units.parseCustomersTable('shopify_customers', t).customers,
    trace: [{ path: 'email', column: 'Email' }, { path: 'address.city', column: 'Default Address City' }, { path: 'marketingConsent.email', column: 'Accepts Email Marketing' }],
  },
  {
    id: 'bigcommerce.customers.csv.v1', platform: 'bigcommerce',
    opts: { direction: 'bigcommerce-to-shopify', expectPlatform: 'bigcommerce' },
    fixtures: { 'bigcommerce_customers.csv': [] },
    generic: true,
    parse: (t) => units.parseCustomersTable('bigcommerce_customers', t).customers,
    trace: [{ path: 'email', column: 'Email' }, { path: 'address.city', column: 'City/Suburb' }, { path: 'note', column: 'Notes + Store Credit' }, { path: 'taxExempt', column: 'Tax Exempt Code' }],
  },
  {
    id: 'woocommerce.customers.csv.v1', platform: 'woocommerce',
    opts: { direction: 'woocommerce-to-shopify', expectPlatform: 'woocommerce' },
    // the WordPress login and the shipping contact names were silently dropped before
    fixtures: { 'woo_customers.csv': ['user_login', 'shipping_first_name', 'shipping_last_name'] },
    generic: true,
    parse: (t) => units.parseCustomersTable('woo_customers', t).customers,
    trace: [{ path: 'email', column: 'user_email + billing_email' }, { path: 'address.city', column: 'billing_city' }],
  },
  {
    id: 'bigbuy.standard.v1', platform: 'bigbuy',
    opts: { direction: 'bigbuy-to-shopify', expectPlatform: 'bigbuy' },
    fixtures: { 'bigbuy_standard.csv': [] },
    parse: (t) => bigbuy.parseBigBuyStandard(t.rows, bigbuy.parsePrestaCategories(parseCsv(read('presta_categories.csv')).rows)),
    trace: [{ path: 'title', column: 'NAME' }, { path: 'images', column: 'IMAGE1 + IMAGE2' }, { child: true, path: 'price', column: 'PVP_BIGBUY' }, { child: true, path: 'cost', column: 'PVD' }],
  },
  {
    id: 'bigbuy.presta-import.v1', platform: 'bigbuy',
    opts: { direction: 'bigbuy-to-woocommerce', expectPlatform: 'bigbuy' },
    fixtures: { 'bigbuy_presta.csv': [] },
    parse: (t) => bigbuy.parseBigBuyPresta(t.rows, bigbuy.parsePrestaCategories(parseCsv(read('presta_categories.csv')).rows)),
    trace: [{ path: 'title', column: 'NAME' }, { path: 'handle', column: 'URL_REWRITTEN + NAME + ID' }, { child: true, path: 'price', column: 'PRICE_TAX_EXCLUDE' }],
  },
  {
    id: 'woocommerce.orders.csv.v1', platform: 'woocommerce', childKey: 'lineItems',
    opts: { direction: 'woocommerce-to-shopify', expectPlatform: 'woocommerce', dateOrder: 'DMY' },
    fixtures: { 'woo_orders.csv': [], 'woo_orders_ambiguous.csv': [] },
    parse: (t) => orders.parseWooOrders(t.headers, t.rows, 'DMY').orders,
    trace: [{ path: 'number', column: 'ORDERID' }, { path: 'billing.city', column: 'billing_city' }, { path: 'lineItems', column: 'item_name + item_type + item_product_id + item_qty + item_line_total' }],
  },
  {
    id: 'shopify.orders.csv.v1', platform: 'shopify', childKey: 'lineItems',
    opts: { direction: 'shopify-to-woocommerce', expectPlatform: 'shopify' },
    fixtures: { 'shopify_orders.csv': [] },
    parse: (t) => orders.parseShopifyOrders(t.rows).orders,
    trace: [{ path: 'number', column: 'Name' }, { path: 'total', column: 'Total' }, { child: true, path: 'name', column: 'Lineitem name' }, { child: true, path: 'price', column: 'Lineitem price' }],
  },
  {
    id: 'bigcommerce.orders.csv.v1', platform: 'bigcommerce', childKey: 'lineItems',
    opts: { direction: 'bigcommerce-to-shopify', expectPlatform: 'bigcommerce' },
    fixtures: { 'bigcommerce_orders.csv': [] },
    parse: (t) => bigcommerce.parseBigCommerceOrders(t.rows).orders,
    trace: [{ path: 'number', column: 'Order ID' }, { path: 'email', column: 'Customer Email' }, { child: true, path: 'name', column: 'Product Name' }],
  },
  {
    id: 'shopify.products.csv.v1', platform: 'shopify',
    opts: { direction: 'shopify-to-woocommerce', expectPlatform: 'shopify' },
    fixtures: { 'shopify_products.csv': [] },
    parse: (t) => products.parseShopifyProducts(t.headers, t.rows),
    trace: [{ path: 'title', column: 'Title' }, { path: 'handle', column: 'Handle' }, { child: true, path: 'price', column: 'Variant Price' }, { child: true, path: 'sku', column: 'Variant SKU' }],
  },
  {
    id: 'woocommerce.products.csv.modern.v1', platform: 'woocommerce',
    opts: { direction: 'woocommerce-to-shopify', expectPlatform: 'woocommerce' },
    // the stock-status flag and a WordPress internal meta key were silently dropped before
    fixtures: { 'woo_products_modern.csv': ['In stock?', 'Meta: _edit_lock'] },
    parse: (t) => products.parseWooModern(t.headers, t.rows),
    trace: [{ path: 'title', column: 'Name' }, { path: 'handle', column: 'SKU' }, { child: true, path: 'price', column: 'Regular price + Sale price' }],
  },
  {
    id: 'wix.products.csv.v1', platform: 'wix',
    opts: { direction: 'wix-to-shopify', expectPlatform: 'wix' },
    // a variant price surcharge and the option control types were silently dropped before
    fixtures: { 'wix_products.csv': ['surcharge', 'productOptionType1', 'productOptionType2'] },
    parse: (t) => wix.parseWixProducts(t.rows),
    trace: [{ path: 'title', column: 'name' }, { path: 'handle', column: 'handleId' }, { child: true, path: 'sku', column: 'sku' }],
  },
  {
    id: 'bigcommerce.products.csv.v1', platform: 'bigcommerce',
    opts: { direction: 'bigcommerce-to-shopify', expectPlatform: 'bigcommerce', weightUnit: 'kg' },
    // the product id, inventory-tracking mode and free-shipping flag were silently dropped before
    fixtures: { 'bigcommerce_products.csv': ['ID', 'Inventory Tracking', 'Free Shipping'] },
    parse: (t) => bigcommerce.parseBigCommerceProducts(t.rows, 'kg').products,
    trace: [{ path: 'title', column: 'Name' }, { child: true, path: 'sku', column: 'SKU' }],
  },
];

test('review fix: a BigBuy feed is scanned for card data before parsing and preservation', () => {
  const table = parseCsv(read('bigbuy_standard.csv'));
  const withCard = { headers: [...table.headers, 'Card number'], rows: table.rows.map((r) => ({ ...r, 'Card number': '4111111111111111' })) };
  const text = serializeCsv(withCard.headers, withCard.rows).replace(/,/g, ';');
  const r = convert(text, { direction: 'bigbuy-to-shopify', expectPlatform: 'bigbuy', categoriesCsv: read('presta_categories.csv') });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.code === 'pci_card_data_stripped'));
  assert.equal(r.preserved?.fields.some((f) => f.field === 'Card number') ?? false, false, 'a blanked card column is not reported as preserved data');
});

test('review fix: customer problems name the real spreadsheet line when non-customer rows are skipped', () => {
  const csv = serializeCsv(['user_login', 'user_email', 'roles', 'billing_city'], [
    { user_login: 'admin', user_email: 'a@a', roles: 'administrator', billing_city: '' }, // line 2, skipped
    { user_login: 'u', user_email: '', roles: 'customer', billing_city: 'Lyon' },        // line 3, no e-mail
  ]);
  const report = analyzeProblems(csv, { direction: 'woocommerce-to-shopify' });
  assert.equal(report.problems.find((p) => p.code === 'customer_no_email').line, 3);
});

test('legacy entries: a canon list never mixes unit-level and child-level paths', () => {
  const isChild = (p) => /^(variants|lineItems|items)\[\]\./.test(p);
  for (const f of REF.filter((x) => x.legacy)) {
    for (const e of f.fields) {
      if (typeof e.canon !== 'string') continue;
      const parts = e.canon.split('+').map((s) => s.trim());
      assert.ok(parts.every(isChild) || !parts.some(isChild), `${f.id}: "${e.path}" → ${e.canon} mixes scopes`);
    }
  }
});

test('bigbuy.presta-categories.v1: a companion lookup — columns declared, never a unit source', () => {
  const format = REF.find((f) => f.id === 'bigbuy.presta-categories.v1');
  const declared = declaredColumns(format);
  const headers = parseCsv(read('presta_categories.csv')).headers;
  // ROOT_CATEGORY is not read by the resolver; its rows never become canon units,
  // so there is no unit to preserve it on (recorded, not silently claimed).
  assert.deepEqual(headers.filter((h) => !declared.has(h)), ['ROOT_CATEGORY']);
  for (const col of ['ID', 'NAME', 'PARENT_CATEGORY']) assert.ok(declared.has(col), col);
  const r = convert(read('presta_categories.csv'), { direction: 'bigbuy-to-shopify', expectPlatform: 'bigbuy', categoriesCsv: read('presta_categories.csv') });
  assert.equal(r.errors[0].code, 'bigbuy_categories_as_main');
});

const withExtra = (table) => ({
  headers: [...table.headers, EXTRA],
  rows: table.rows.map((r, i) => ({ ...r, [EXTRA]: `ERP-${i + 1}` })),
});

for (const spec of SPECS) {
  const format = REF.find((f) => f.id === spec.id);
  const companion = spec.opts.direction.startsWith('bigbuy') ? { categoriesCsv: read('presta_categories.csv') } : {};

  test(`${spec.id}: grouping aligned with the parser, only reviewed columns undeclared`, () => {
    assert.ok(format.fields.length > 0, 'the entry declares its columns');
    const declared = declaredColumns(format);
    for (const [fixture, expected] of Object.entries(spec.fixtures)) {
      const text = read(fixture);
      const table = parseCsv(text);
      assert.deepEqual(table.headers.filter((h) => !declared.has(h)), expected, `${fixture}: undeclared columns`);
      const r = convert(text, { ...spec.opts, ...companion });
      assert.equal(r.ok, true, JSON.stringify(r.errors));
      assert.equal(r.warnings.some((w) => w.code === 'preservation_unaligned'), false, `${fixture}: grouping not aligned with the parser`);
      if (spec.parse) assert.equal(annotateUnits(format, table, spec.parse(table)).aligned, true, `${fixture}: aligned on the parser units`);
    }
  });

  test(`${spec.id}: an extra column is preserved and reported; the exported file does not move`, () => {
    const [fixture] = Object.keys(spec.fixtures);
    const table = parseCsv(read(fixture));
    const plain = serializeCsv(table.headers, table.rows);
    const extra = withExtra(table);
    const a = convert(plain, { ...spec.opts, ...companion });
    const b = convert(serializeCsv(extra.headers, extra.rows), { ...spec.opts, ...companion });
    assert.equal(b.ok, true);
    assert.equal(serializeCsv(b.headers, b.rows), serializeCsv(a.headers, a.rows), 'byte-identical export with or without the extra column');
    assert.deepEqual({ ...b, rows: undefined, headers: undefined, preserved: undefined }, { ...a, rows: undefined, headers: undefined, preserved: undefined }, 'same counts, losses, warnings');
    const reported = b.preserved?.fields.find((f) => f.field === EXTRA);
    assert.ok(reported, 'the extra column is reported');
    assert.equal(reported.reason, 'unknown');
    assert.equal(reported.units, b.counts.outputUnits, 'on every exported unit');
    if (spec.parse) {
      const parsed = spec.parse(extra);
      if (!spec.generic) annotateUnits(format, extra, parsed); // the generic parser preserves by itself
      const raw = parsed[0].sourceExtension[spec.platform]._raw[EXTRA];
      assert.ok(raw === 'ERP-1' || (Array.isArray(raw) && raw[0] === 'ERP-1'), `verbatim on the first unit (got ${JSON.stringify(raw)})`);
      assert.ok(parsed[0].unmapped.some((u) => u.sourceField === EXTRA && u.reason === 'unknown'));
    }
  });

  if (spec.trace && spec.parse) {
    test(`${spec.id}: declared columns carry provenance on the canon path they feed`, () => {
      const [fixture] = Object.keys(spec.fixtures);
      const table = parseCsv(read(fixture));
      const parsed = spec.parse(table);
      if (!spec.generic) annotateUnits(format, table, parsed, { childKey: spec.childKey ?? 'variants' });
      for (const t of spec.trace) {
        const holder = t.child ? parsed[0][spec.childKey ?? 'variants'][0] : parsed[0];
        const key = t.child && (spec.childKey === 'lineItems') ? `lineItems[0].${t.path}` : t.path;
        const p = (spec.childKey === 'lineItems' && t.child ? parsed[0].provenance : holder.provenance)?.[key];
        assert.ok(p, `provenance for ${key}`);
        assert.equal(p.sourceField, t.column);
        assert.equal(p.platform, spec.platform);
        assert.equal(p.method, 'exact');
      }
    });
  }
}
