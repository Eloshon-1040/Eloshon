/**
 * Unit tests for the declarative correspondence layer (ÉTAPE 2): analyze +
 * confidence, the source→target join (incl. honest losses), the override
 * mechanism end-to-end through convert(), and plan validation.
 *
 *   node scripts/build-engine.mjs && node --test test/*.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convert, serializeCsv, parseCsv, analyzePlan, validatePlan, hasMappingPlan } from '../core/dist/index.mjs';

const find = (plan, id) => plan.bindings.find((b) => b.id === id);

test('mapping: plan exists for product pairs, not for unknown', () => {
  assert.equal(hasMappingPlan('shopify_products', 'woo_products_modern'), true);
  assert.equal(hasMappingPlan('bigbuy_standard', 'shopify_products'), false); // BigBuy source has no editable plan (supplier feed)
});

test('mapping: exact columns → high confidence, applied, joined to target', () => {
  const plan = analyzePlan(['Handle', 'Title', 'Variant Price', 'Vendor', 'Foobar Custom'], 'shopify_products', 'woo_products_modern', 'products');
  const title = find(plan, 'title');
  assert.equal(title.confidence, 'high');
  assert.equal(title.applied, true);
  assert.equal(title.carried, true);
  assert.deepEqual(title.targetColumns, ['Name']);

  const price = find(plan, 'price');
  assert.equal(price.confidence, 'high');
  assert.deepEqual(price.targetColumns, ['Regular price', 'Sale price']);

  // Phase 6: Shopify Vendor is carried to the WC 9.6+ core `Brands` column
  // (it used to be an honest loss — the modern exporter had no brand column).
  const vendor = find(plan, 'vendor');
  assert.equal(vendor.present, true);
  assert.equal(vendor.carried, true, 'vendor lands in the modern Woo `Brands` column');
  assert.deepEqual(vendor.targetColumns, ['Brands']);

  // compare-at price column absent → not a binding row.
  assert.equal(find(plan, 'compareAtPrice'), undefined);

  // A column no rule consumes → "Non utilisée".
  assert.ok(plan.unused.some((u) => u.column === 'Foobar Custom'));
  assert.deepEqual(plan.suggestedOverrides, {}, 'all exact → nothing to suggest');
});

test('mapping: reviewAlways forces "check" even on exact match', () => {
  const plan = analyzePlan(['Handle', 'Title', 'Variant Price', 'Variant Compare At Price'], 'shopify_products', 'woo_products_modern', 'products');
  const cmp = find(plan, 'compareAtPrice');
  assert.equal(cmp.confidence, 'check', 'compare-at price is semantically tricky → always review');
  assert.equal(cmp.applied, true);
});

test('mapping: near-name match → "check", not applied, suggested (never silent)', () => {
  const plan = analyzePlan(['Handle', 'Title', 'Prix'], 'shopify_products', 'woo_products_modern', 'products');
  const price = find(plan, 'price');
  assert.equal(price.resolvedColumn, 'Prix');
  assert.equal(price.confidence, 'check');
  assert.equal(price.applied, false, 'a near-name is a suggestion, not silently used');
  assert.deepEqual(plan.suggestedOverrides.price, { column: 'Prix' });
});

test('mapping: override RE-POINTS a source column through the unchanged parser', () => {
  const csv = serializeCsv(['Handle', 'Libelle', 'Variant Price', 'Variant SKU'], [
    { Handle: 'p1', Libelle: 'Mon Produit', 'Variant Price': '10.00', 'Variant SKU': 'SKU1' },
  ]);
  // No override: 'Title' is absent → product has no title → dropped (error).
  const base = convert(csv, { direction: 'shopify-to-woocommerce', expectPlatform: 'shopify' });
  assert.equal(base.ok, false);
  assert.equal(base.errors[0].code, 'product_no_title');

  // Re-point title → 'Libelle': the product now has a name and converts.
  const mapped = convert(csv, { direction: 'shopify-to-woocommerce', expectPlatform: 'shopify', mapping: { overrides: { title: { column: 'Libelle' } } } });
  assert.equal(mapped.ok, true);
  assert.equal(mapped.counts.outputUnits, 1);
  const nameCol = mapped.rows.find((r) => r['Name']);
  assert.equal(nameCol['Name'], 'Mon Produit');
});

test('mapping: override EXCLUDES a field ("Ne pas importer")', () => {
  const csv = serializeCsv(['Handle', 'Title', 'Variant Price', 'Tags'], [
    { Handle: 'p1', Title: 'Prod', 'Variant Price': '10.00', Tags: 'a, b' },
  ]);
  const base = convert(csv, { direction: 'shopify-to-woocommerce', expectPlatform: 'shopify' });
  assert.equal(base.rows[0]['Tags'], 'a, b');

  const excluded = convert(csv, { direction: 'shopify-to-woocommerce', expectPlatform: 'shopify', mapping: { overrides: { tags: { column: null } } } });
  assert.equal(excluded.rows[0]['Tags'], '', 'excluded field is blank in output');
});

test('mapping: empty overrides is a byte-for-byte no-op', () => {
  const csv = serializeCsv(['Handle', 'Title', 'Variant Price', 'Variant SKU'], [
    { Handle: 'p1', Title: 'Prod', 'Variant Price': '10.00', 'Variant SKU': 'SKU1' },
  ]);
  const a = convert(csv, { direction: 'shopify-to-woocommerce', expectPlatform: 'shopify' });
  const b = convert(csv, { direction: 'shopify-to-woocommerce', expectPlatform: 'shopify', mapping: { overrides: {} } });
  assert.equal(serializeCsv(b.headers, b.rows), serializeCsv(a.headers, a.rows));
});

test('mapping: customer + order plans exist; BC-order target has none (impossible)', () => {
  assert.equal(hasMappingPlan('shopify_customers', 'woo_customers'), true);
  assert.equal(hasMappingPlan('woo_customers', 'bigcommerce_customers'), true);
  assert.equal(hasMappingPlan('woo_orders', 'shopify_orders'), true);
  assert.equal(hasMappingPlan('shopify_orders', 'bigcommerce_orders'), false); // BC has no order CSV import
});

test('mapping: order address + line items are structural (not re-pointable)', () => {
  const plan = analyzePlan(
    ['ORDERID', 'billing_email', 'order_date', 'order_status', 'billing_first_name', 'item_name'],
    'woo_orders', 'shopify_orders', 'orders',
  );
  const billing = find(plan, 'billing');
  assert.equal(billing.editable, false);
  const li = find(plan, 'lineItems');
  assert.equal(li.editable, false);
  const num = find(plan, 'number');
  assert.equal(num.editable, true);
  assert.equal(num.confidence, 'high');
});

test('mapping: customer override re-points through convert (note → custom column)', () => {
  const csv = serializeCsv(['First Name', 'Last Name', 'Email', 'Accepts Email Marketing', 'Comment'], [
    { 'First Name': 'Jane', 'Last Name': 'Doe', Email: 'jane@example.com', 'Accepts Email Marketing': 'yes', Comment: 'client VIP' },
  ]);
  const base = convert(csv, { direction: 'shopify-to-bigcommerce', expectPlatform: 'shopify' });
  assert.equal(base.rows[0]['Notes'], '');
  const mapped = convert(csv, { direction: 'shopify-to-bigcommerce', expectPlatform: 'shopify', mapping: { overrides: { note: { column: 'Comment' } } } });
  assert.equal(mapped.rows[0]['Notes'], 'client VIP');
});

test('mapping: validate flags missing required source + non-editable override', () => {
  // Title (source-required) absent.
  const plan = analyzePlan(['Handle', 'Variant Price'], 'shopify_products', 'woo_products_modern', 'products');
  const v1 = validatePlan(plan);
  assert.ok(v1.errors.some((e) => e.code === 'map_source_required_missing' && e.params.field === 'title'));

  // Overriding a structural (non-editable) field is refused.
  const plan2 = analyzePlan(['Handle', 'Title', 'Variant Price'], 'shopify_products', 'woo_products_modern', 'products', { images: { column: 'Foo' } });
  const v2 = validatePlan(plan2, { images: { column: 'Foo' } });
  assert.ok(v2.errors.some((e) => e.code === 'map_field_not_editable'));
});
