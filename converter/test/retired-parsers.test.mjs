/**
 * Phase 2 Lot 3 — formats whose bespoke parser was RETIRED: the generic parser
 * reads them from their knowledge entry (structure.parser "generic"). Before
 * each retirement the two were compared on every fixture of the format (canon
 * deep-equal, 0 differences); the expectations below are the RETIRED parser's
 * own output on adversarial cells the fixtures do not carry, frozen at
 * retirement — so the generic route keeps reading a cell exactly as before.
 * The goldens guard the exported files on top of this.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCustomersTable, parseProductsTable, isGenericParsed, legacyEntry } from '../core/dist/units.mjs';

const strip = (u) => { const { sourceExtension, unmapped, provenance, ...rest } = u; return rest; };
const nb = String.fromCharCode(0xa0), cr = String.fromCharCode(13), lf = String.fromCharCode(10);
const ADDR = { company: '', address1: '', address2: '', city: '', province: '', provinceCode: '', country: '', zip: '', phone: '' };

test('the formats whose bespoke parser is retired are read by the generic parser', () => {
  for (const id of ['shopify_customers', 'bigcommerce_customers', 'woo_customers', 'woo_products_legacy']) assert.equal(isGenericParsed(legacyEntry(id)), true, id);
});

test('woo_products_legacy: slug fallback, brand leaf, empty category levels, attribute family, lone sale price — as the retired parser read them', () => {
  const rows = [
    { post_name: '', post_title: 'Écharpe en laine — édition', post_content: '<p>a</p>', post_status: '', sku: ' SKU’1 ', regular_price: '', sale_price: '12,50', weight: '1,25', virtual: 'YES', tax_status: '', stock: '-2', 'tax:product_brand': 'Maison > Sous-marque ', 'tax:product_tag': ' a , ,b', 'tax:product_cat': 'A >  > B, , C>', 'attribute:Taille': 'S | M |', 'attribute:Couleur': '' },
    { post_name: '  ', post_title: '', post_content: '', post_status: 'draft', sku: '', regular_price: '20', sale_price: '25', weight: '', virtual: 'yes', tax_status: 'none', stock: '', 'tax:product_brand': '', 'tax:product_tag': '', 'tax:product_cat': '', 'attribute:Taille': '', 'attribute:Couleur': '' },
  ];
  const VARIANT = { optionValues: [], sku: '', price: null, compareAtPrice: null, cost: null, barcode: '', grams: null, lengthCm: null, widthCm: null, heightCm: null, requiresShipping: true, taxable: true, inventoryQty: null, imageSrc: '' };
  const PRODUCT = { productType: '', images: [], metafields: [], seoTitle: '', seoDescription: '' };
  const parsed = parseProductsTable('woo_products_legacy', table(rows)).map((p) => ({ ...strip(p), variants: p.variants.map(strip) }));
  assert.deepEqual(parsed, [
    { ...PRODUCT, handle: 'echarpe-en-laine-edition', title: 'Écharpe en laine — édition', bodyHtml: '<p>a</p>', vendor: 'Sous-marque', tags: ['a', 'b'], status: 'active', categories: ['A >  > B', 'C > '], published: true,
      options: [{ name: 'Taille', values: ['S', 'M'] }], variants: [{ ...VARIANT, sku: "SKU'1", grams: 1250, inventoryQty: -2 }] },
    { ...PRODUCT, handle: '  ', title: '', bodyHtml: '', vendor: '', tags: [], status: 'draft', categories: [], published: false, options: [],
      variants: [{ ...VARIANT, price: 20, requiresShipping: false, taxable: false }] },
  ]);
});

const table = (rows) => ({ headers: [...new Set(rows.flatMap((r) => Object.keys(r)))], rows, malformed: [] });

test('bigcommerce_customers: blank-vs-whitespace fallbacks, store credit, one-tag group — as the retired parser read them', () => {
  const lf = String.fromCharCode(10);
  const rows = [
    { Email: ' x@y.z ', 'First Name': 'Ana', Company: 'Acme', 'Address Company': '   ', Notes: '', 'Store Credit': '0', 'Customer Group': 'Retail, Gold', 'Tax Exempt Code': '  ', 'Receive Marketing Emails': 'N', 'State/Province': ' Texas ' },
    { Email: 'b@b', Company: 'Corp', Notes: 'VIP' + lf + 'client', 'Store Credit': '0.00', 'Receive Marketing Emails': '   ', 'Address Phone': nb + '12' },
  ];
  const { customers } = parseCustomersTable('bigcommerce_customers', table(rows));
  assert.deepEqual(customers.map(strip), [
    { firstName: 'Ana', lastName: '', email: 'x@y.z', phone: '', address: { ...ADDR, province: 'Texas', provinceCode: 'Texas' }, shipping: null, acceptsEmail: null, acceptsSms: null, note: '', tags: ['Retail, Gold'], taxExempt: false,
      marketingConsent: { email: { state: 'unknown', channel: 'email', source: { platform: 'bigcommerce', field: 'Receive Marketing Emails', raw: 'N' }, requiresReconfirmation: true } } },
    { firstName: '', lastName: '', email: 'b@b', phone: '', address: { ...ADDR, company: 'Corp', phone: '12' }, shipping: null, acceptsEmail: null, acceptsSms: null, note: 'VIP client — Store credit: 0.00', tags: [], taxExempt: false },
  ]);
});

test('woo_customers: role filter, US state codes, empty vs partial shipping address — as the retired parser read them', () => {
  const rows = [
    { user_login: 'u1', user_email: '', billing_email: ' e@e ', first_name: '  ', billing_first_name: 'Bill', roles: 'Subscriber|CUSTOMER', billing_state: 'new york', billing_country: 'US', shipping_state: 'Ohio', shipping_country: ' us ' },
    { user_login: 'u2', roles: 'shop_manager', user_email: 'm@m' },
    { user_login: 'u3', roles: '', user_email: 'n@n', shipping_company: '  ', shipping_address_2: 'Apt 4', shipping_country: 'FR' },
  ];
  const { customers, skippedNonCustomers } = parseCustomersTable('woo_customers', table(rows));
  assert.equal(skippedNonCustomers, 1);
  assert.deepEqual(customers.map(strip), [
    { firstName: '', lastName: '', email: 'e@e', phone: '', address: { ...ADDR, province: 'new york', provinceCode: 'NY', country: 'US' }, shipping: { ...ADDR, province: 'Ohio', provinceCode: 'OH', country: 'us' }, acceptsEmail: null, acceptsSms: null, note: '', tags: [], taxExempt: false },
    { firstName: '', lastName: '', email: 'n@n', phone: '', address: ADDR, shipping: null, acceptsEmail: null, acceptsSms: null, note: '', tags: [], taxExempt: false },
  ]);
});

test('shopify_customers: smart punctuation, line breaks, NBSP, Excel guard, consent literals — as the retired parser read them', () => {
  const rows = [
    { 'First Name': ' Zoé ', 'Last Name': 'O’Brien', Email: ' a@b.c ', Phone: "'+33 6 12", 'Accepts Email Marketing': ' Yes ', 'Accepts SMS Marketing': 'SUBSCRIBED', 'Default Address Province Code': ' QC ', 'Default Address Phone': "'0612", Note: 'l1' + cr + lf + 'l2' + nb + '“x”', Tags: ' a , ,b ', 'Tax Exempt': 'TRUE' },
    { 'First Name': '', 'Accepts Email Marketing': '   ', 'Accepts SMS Marketing': 'maybe', 'Tax Exempt': 'no' },
  ];
  const { customers } = parseCustomersTable('shopify_customers', { headers: Object.keys(rows[0]), rows, malformed: [] });
  assert.deepEqual(customers.map(strip), [
    {
      firstName: 'Zoé', lastName: "O'Brien", email: 'a@b.c', phone: '+33 6 12',
      address: { ...ADDR, province: 'QC', provinceCode: 'QC', phone: '0612' },
      shipping: null, acceptsEmail: true, acceptsSms: true, note: 'l1 l2 "x"', tags: ['a', 'b'], taxExempt: true,
      marketingConsent: {
        email: { state: 'pending', channel: 'email', source: { platform: 'shopify', field: 'Accepts Email Marketing', raw: 'Yes' }, requiresReconfirmation: true },
        sms: { state: 'pending', channel: 'sms', source: { platform: 'shopify', field: 'Accepts SMS Marketing', raw: 'SUBSCRIBED' }, requiresReconfirmation: true },
      },
    },
    {
      firstName: '', lastName: '', email: '', phone: '', address: ADDR, shipping: null, acceptsEmail: null, acceptsSms: null, note: '', tags: [], taxExempt: false,
      marketingConsent: { sms: { state: 'unknown', channel: 'sms', source: { platform: 'shopify', field: 'Accepts SMS Marketing', raw: 'maybe' }, requiresReconfirmation: true } },
    },
  ]);
});
