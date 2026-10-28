// Phase 7.2 / 7.3 / 7.4 / 7.6 — orders, customers, payments, consent, numbering.
// The three hard rules are tested here, on real (pseudonymised) payloads:
//   7.7  no card data ever reaches a canon object or a target file;
//   7.4  the target's order / invoice sequence is never written — the source
//        number is an immutable reference, reported (gaps, duplicates), never
//        re-emitted as a sequence;
//   7.3  a source marketing consent never activates a target subscription —
//        every target is written NOT subscribed, the source statement is
//        evidence (with its own timestamp, or 'pending' without one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as engine from '../core/dist/index.mjs';
import { scanForCardData } from '../core/knowledge-proposal/pci-scanner.mjs';
import { loadReferenceFormatsSync } from '../core/knowledge-proposal/reference.mjs';
import { CASES, runCase } from './cases.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test', 'fixtures');
const read = (rel) => fs.readFileSync(path.join(FIX, rel), 'utf8');
const J = (rel) => JSON.parse(read(rel));
const { convert, convertOrdersFromCanon, convertCustomersFromCanon, parseOrdersJson, parseCustomersJson, buildNumberingReport, buildConsentReport } = engine;
const PS = (k) => 'live/prestashop-test/' + k.replace(/_/g, '-') + '.json';
const psOrderCompanions = () => Object.fromEntries(['order_details', 'order_invoices', 'order_payments', 'order_histories', 'order_states', 'order_carriers', 'order_slips', 'addresses', 'customers', 'carriers', 'countries', 'states', 'currencies', 'languages'].map((k) => [k, J(PS(k))]));
const psCustomerCompanions = () => Object.fromEntries(['addresses', 'groups', 'countries', 'states', 'languages'].map((k) => [k, J(PS(k))]));
const entityCases = CASES.filter((c) => c.kind === 'json' && c.entity);

// ── 7.2: the generic parser reads orders / customers (entity mode) ───────────
test('7.2 entity mode: every orders / customers Reference entry parses its live fixture with nothing unknown; lineItems[] derives from items[]; the legacy flat fields derive from the typed blocks', () => {
  assert.equal(loadReferenceFormatsSync().filter((f) => f.entity === 'orders' || f.entity === 'customers').filter((f) => f.medium === 'json-api').length, 10);
  for (const c of entityCases) {
    const { res, canon } = runCase(c, { read, engine: { ...engine, loadReferenceFormatsSync } });
    assert.equal(res.ok, true, c.name);
    for (const u of canon) {
      assert.deepEqual((u.unmapped ?? []).filter((x) => x.reason === 'unknown'), [], `${c.name}: unknown source keys`);
      if (c.entity === 'orders') {
        assert.ok(Array.isArray(u.items) && u.items.length > 0, `${c.name}: items[]`);
        assert.deepEqual(u.lineItems, u.items.map((it) => ({ name: it.name, sku: it.sku, quantity: it.quantity, price: it.unitPrice })), `${c.name}: lineItems ← items`);
        assert.equal(u.number, u.numbering.sourceNumber, `${c.name}: number ← numbering.sourceNumber`);
        assert.equal(u.total, u.amounts.total, `${c.name}: total ← amounts.total`);
        assert.equal(u.financialStatus, u.status.financial, `${c.name}: financialStatus ← status.financial`);
        assert.equal(u.provenance.number.method, 'structural');
      } else {
        assert.ok(u.email && u.identity?.sourceId, `${c.name}: email + identity`);
      }
    }
  }
});

test('7.2 (decision 4): a test / sandbox order is excluded by default with a warning — BigCommerce order 100 carries a test transaction, 101 is real', () => {
  const { orders } = parseOrdersJson('bigcommerce.orders.rest-v2.v1', J('live/bigcommerce-test/orders.json'));
  assert.deepEqual(orders.map((o) => [o.number, o.test]), [['100', true], ['101', undefined]]);
  const res = convertOrdersFromCanon(orders, { direction: 'bigcommerce-to-shopify', expectPlatform: 'bigcommerce' }, 'bigcommerce.orders.rest-v2.v1');
  assert.deepEqual(res.warnings, [{ code: 'test_orders_excluded', params: { count: 1 } }]);
  assert.equal(res.counts.outputUnits, 1);
  assert.ok(res.rows.every((r) => r.Name !== '100'));
  // decision 3: the card BRAND is a payment fact and stays; nothing else of the card exists
  assert.deepEqual(orders[0].payments[0].instrument, { type: 'card', brand: 'master' });
  assert.equal(orders[0].payments[0].providerRef, '2a411a5f-9cec-4ec7-a46e-c0a31c2dc527', 'a gateway REFERENCE, kept');
});

// ── 7.7 on the way out: no card data in any canon object or target row ───────
test('7.7 invariant on outputs: no canon order / customer of any case and no target row carries card data, a token, an IBAN or a credential', () => {
  for (const c of entityCases) {
    const { res, canon } = runCase(c, { read, engine: { ...engine, loadReferenceFormatsSync } });
    assert.deepEqual(scanForCardData(canon).findings, [], `${c.name}: canon`);
    assert.deepEqual(scanForCardData(res.rows).findings, [], `${c.name}: rows`);
    const text = JSON.stringify(canon);
    assert.ok(!/passw|secure_key|card_number|card_expiration|cvv|payment_instrument_token/i.test(text), `${c.name}: no credential key in the canon`);
  }
});

// ── 7.4: numbering ───────────────────────────────────────────────────────────
test('7.4 observed in motion (Shopware, local checkouts): order numbers 10000 / 10001 from the `order` range, invoice documents 1000 / 1001 from `document_invoice` — carried as references, never as the target sequence', () => {
  const { orders } = parseOrdersJson('shopware.orders.admin-api.v1', J('live/shopware-test/orders.json'), { numberRanges: J('live/shopware-test/number-ranges.json') });
  assert.deepEqual(orders.map((o) => [o.numbering.sourceNumber, o.numbering.sourceInvoiceNumber]), [['10000', '1000'], ['10001', '1001']]);
  assert.deepEqual(orders[0].numbering.format, { pattern: '{n}' }, 'P-1 B6: the order range pattern, for the report only');
  assert.equal(orders[0].shipping_.country, 'DE', 'P-1 A1: country association loaded on the delivery address');
  const ranges = J('live/shopware-test/number-ranges.json');
  const range = (t) => ranges.find((r) => r.type?.technicalName === t);
  assert.equal(range('order').start, 10000); assert.equal(range('document_invoice').start, 1000);
  const woo = convertOrdersFromCanon(orders, { direction: 'shopware-to-woocommerce', expectPlatform: 'shopware' }, 'shopware.orders.admin-api.v1');
  assert.ok(woo.rows.every((r) => r.ORDERID === ''), 'WooCommerce ORDERID is never written (the target assigns its own)');
  assert.deepEqual(woo.rows.map((r) => r['meta:_source_order_number']), ['10000', '10001'], 'the source number travels as order meta');
  assert.deepEqual(woo.numberingReport, { orders: 2, sourceSequence: { min: '10000', max: '10001', numeric: true, gaps: [], duplicates: [] }, invoices: { withNumber: 2, withoutNumber: 0, gaps: [] }, targetPolicy: 'native-sequence', warnings: ['invoice_numbers_not_carried'] });
  assert.deepEqual(woo.losses.map((l) => l.code), ['loss_refund_risk', 'loss_woo_order_numbering', 'loss_woo_invoice_numbers', 'loss_woo_payments_detail']);
  const shopify = convertOrdersFromCanon(orders, { direction: 'shopware-to-shopify', expectPlatform: 'shopware' }, 'shopware.orders.admin-api.v1');
  // B2 (7.2 §5 upheld): no serialiser writes the target order name — Name is empty, the source reference is a structured note attribute
  assert.ok(shopify.rows.every((r) => r.Name === ''), 'Shopify: Name is never written');
  assert.deepEqual(shopify.rows.map((r) => r['Note Attributes']), [
    'source_order_number: 10000\nsource_order_id: 01a0c576071271d5b12afb1e2d231305\nsource_invoice_number: 1000',
    'source_order_number: 10001\nsource_order_id: 01a0c576664f7129b30ae8059cfbf4e6\nsource_invoice_number: 1001',
  ]);
  assert.ok(!shopify.losses.some((l) => l.code === 'loss_shopify_order_rows'), 'single-line orders: no row-association loss');
});

test('7.4 observed in motion (PrestaShop, back-office payments): invoice_number is 0 until a state with invoice=1, then assigned in STATE-CHANGE order (orders 2 and 4 → #IN000001, #IN000002); unpaid orders have none', () => {
  const { orders } = parseOrdersJson('prestashop.orders.webservice.v1', J(PS('orders')), psOrderCompanions());
  assert.deepEqual(orders.map((o) => [o.numbering.sourceId, o.numbering.sourceInvoiceNumber ?? null, o.status.sourceState]), [
    ['1', null, 'Canceled'], ['2', '#IN000001', 'Payment accepted'], ['3', null, 'Payment error'], ['4', '#IN000002', 'Payment accepted'], ['5', null, 'Awaiting bank wire payment'],
  ]);
  assert.deepEqual(orders[1].numbering.format, { prefix: '#IN', pattern: '#IN{n:6}' });
  assert.equal(orders[1].numbering.sourceNumber, 'OHSATSERP', 'the reference, not the id');
  // the raw invoice rows agree (number 1 → order 2, number 2 → order 4)
  assert.deepEqual(J(PS('order_invoices')).map((i) => [i.number, i.id_order]), [[1, 2], [2, 4]]);
  // paid orders carry their order_payments rows (by order_reference) as aggregated payments; the check payments have no transaction id
  assert.deepEqual(orders[1].payments, [{ kind: 'sale', status: 'success', amount: 169.9, method: 'Payments by check', at: '2026-09-21 21:32:46' }]);
  assert.equal(orders[0].payments, undefined);
  assert.deepEqual(orders[1].status.history.map((h) => h.state), ['Awaiting check payment', 'Payment accepted'], 'state history resolved to names through order_states (P-1 A2)');
  const res = convertOrdersFromCanon(orders, { direction: 'prestashop-to-shopify', expectPlatform: 'prestashop' }, 'prestashop.orders.webservice.v1');
  assert.equal(res.numberingReport.sourceSequence.numeric, false, 'PrestaShop references are letters: no gap analysis');
  assert.deepEqual(res.numberingReport.invoices, { withNumber: 2, withoutNumber: 3, gaps: [] });
  assert.ok(res.losses.some((l) => l.code === 'loss_shopify_invoice_numbers' && l.params.count === 2));
});

test('7.4 report: gaps and duplicates in the SOURCE sequence are reported (warnings), never repaired or merged; the CSV order paths get the same report', () => {
  const mk = (n) => ({ number: n, email: 'a@example.test', createdAt: '', financialStatus: 'paid', fulfillmentStatus: '', currency: 'EUR', subtotal: 1, shipping: 0, taxes: 0, total: 1, discountCode: '', discountAmount: null, paymentMethod: '', transactionId: '', note: '', billing: { name: '', company: '', address1: '', address2: '', city: '', province: '', provinceCode: '', country: '', zip: '', phone: '' }, shipping_: { name: '', company: '', address1: '', address2: '', city: '', province: '', provinceCode: '', country: '', zip: '', phone: '' }, lineItems: [{ name: 'x', sku: '', quantity: 1, price: 1 }] });
  const orders = ['#1001', '#1002', '#1004', '#1004', '#1008'].map(mk);
  const report = buildNumberingReport(orders);
  assert.deepEqual(report.sourceSequence, { min: '#1001', max: '#1008', numeric: true, gaps: ['1003', '1005–1007'], duplicates: ['#1004'] });
  assert.deepEqual(report.warnings, ['numbering_source_duplicate', 'numbering_source_gaps']);
  const res = convertOrdersFromCanon(orders, { direction: 'shopify-to-woocommerce', expectPlatform: 'shopify' });
  assert.equal(res.counts.outputUnits, 5, 'duplicates are kept apart, never merged');
  assert.deepEqual(res.warnings.map((w) => w.code), ['numbering_source_duplicate', 'numbering_source_gaps']);
  assert.equal(res.warnings[0].params.numbers, '#1004');
  // a CSV source (no numbering block): the flat number IS the source number
  const csv = convert(read('woo_orders.csv'), { direction: 'woocommerce-to-shopify', expectPlatform: 'woocommerce' });
  assert.equal(csv.numberingReport.targetPolicy, 'native-sequence');
  assert.equal(csv.numberingReport.orders, csv.counts.outputUnits);
});

// ── 7.3: consent ─────────────────────────────────────────────────────────────
test('7.3 evidence: opted_in ONLY with the source\'s own timestamp (PrestaShop newsletter + newsletter_date_add); a statement without timestamp is pending (Shopify / BigCommerce CSV yes, Wix SUBSCRIBED); optin (partner offers) stays a distinct, preserved consent', () => {
  const { customers } = parseCustomersJson('prestashop.customers.webservice.v1', J(PS('customers')), psCustomerCompanions());
  const c2 = customers.find((c) => c.identity.sourceId === '2');
  assert.deepEqual(c2.marketingConsent.email, { state: 'opted_in', channel: 'email', source: { platform: 'prestashop', field: 'newsletter', raw: '1' }, at: '2013-12-13 08:19:15', requiresReconfirmation: true }, 'B1: the source timestamp is kept VERBATIM — PrestaShop gives no zone and none is inferred');
  assert.ok(!/Z$|[+-]d{2}:?d{2}$/.test(c2.marketingConsent.email.at), 'never presented as UTC');
  assert.deepEqual(c2.unmapped.filter((u) => u.sourceField === 'optin').map((u) => [u.sourceValue, u.reason]), [['1', 'no-canon-field']]);
  assert.equal(c2.acceptsEmail, null, 'the legacy flag is not inferred from the evidence');
  const c1 = customers.find((c) => c.identity.sourceId === '1');
  assert.equal(c1.marketingConsent.email.state, 'opted_out');
  const wix = parseCustomersJson('wix.contacts.v4.v1', J('live/wix-test/contacts.json')).customers[0];
  assert.equal(wix.marketingConsent.email.state, 'pending', 'NOT_SET → pending');
  assert.equal(wix.marketingConsent.email.at, undefined, 'a Wix contact carries no consent timestamp');
  // CSV paths: a yes is a statement without timestamp
  const sh = convert(read('shopify_customers.csv'), { direction: 'shopify-to-woocommerce', expectPlatform: 'shopify' });
  assert.deepEqual(sh.consentReport, { customers: 3, explicitSourceConsent: 2, withTimestamp: 0, pending: 2, optedOut: 1, unknown: 0, targetPolicy: 'not-subscribed', requiresReconfirmation: true });
});

test('7.3 companion joins: Shopware newsletter-recipient (status + confirmedAt) and BigCommerce subscribers (listed + date_created) — synthetic rows, since neither live store has any', () => {
  const sw = J('live/shopware-test/customers.json');
  const recipient = (status, confirmedAt) => ({ email: sw[0].email, status, confirmedAt, createdAt: '2026-09-01T00:00:00.000+00:00' });
  const state = (rows) => parseCustomersJson('shopware.customers.admin-api.v1', sw, { newsletterRecipients: rows }).customers[0].marketingConsent?.email;
  assert.equal(state([]), undefined, 'not listed: nothing stated');
  assert.deepEqual(state([recipient('optIn', '2026-09-02T10:00:00.000+00:00')]), { state: 'opted_in', channel: 'email', source: { platform: 'shopware', field: 'newsletterRecipients[status]', raw: 'optIn' }, at: '2026-09-02T10:00:00.000Z', level: 'confirmed_opt_in', requiresReconfirmation: true });
  assert.equal(state([recipient('direct', null)]).state, 'pending', 'single opt-in without confirmation date');
  assert.equal(state([recipient('optOut', null)]).state, 'opted_out');
  assert.equal(state([recipient('notSet', null)]).state, 'pending');
  const bc = J('live/bigcommerce-test/customers.json');
  const bcState = (subs) => parseCustomersJson('bigcommerce.customers.rest-v3.v1', bc, { subscribers: subs }).customers[0].marketingConsent?.email;
  assert.equal(bcState([]), undefined);
  assert.equal(bcState([{ id: 1, email: bc[0].email, date_created: '2026-09-21T18:00:00+00:00' }]).state, 'opted_in');
  assert.equal(bcState([{ id: 1, email: bc[0].email }]).state, 'pending', 'listed without a date');
  // accepts_product_review_abandoned_cart_emails and /consent are NOT marketing consents
  const c = parseCustomersJson('bigcommerce.customers.rest-v3.v1', bc, { subscribers: [] }).customers[0];
  assert.equal(c.sourceExtension.bigcommerce.accepts_product_review_abandoned_cart_emails, true);
  assert.ok(c.sourceExtension.bigcommerce._consent);
});

test('7.3 hard rule on every target: whatever the source states (even opted_in with timestamp), the target subscription field is written NOT subscribed and the loss + report say so', () => {
  const { customers } = parseCustomersJson('prestashop.customers.webservice.v1', J(PS('customers')), psCustomerCompanions());
  assert.ok(customers.some((c) => c.marketingConsent?.email?.state === 'opted_in'));
  const legacyYes = customers.map((c) => ({ ...c, acceptsEmail: true, acceptsSms: true }));
  for (const [direction, col, value] of [['prestashop-to-shopify', 'Accepts Email Marketing', 'no'], ['prestashop-to-bigcommerce', 'Receive Marketing Emails', 'N']]) {
    const res = convertCustomersFromCanon(legacyYes, { direction, expectPlatform: 'prestashop' }, 'prestashop.customers.webservice.v1');
    assert.ok(res.rows.every((r) => r[col] === value), `${direction}: ${col} = ${value}`);
    if (col === 'Accepts Email Marketing') assert.ok(res.rows.every((r) => r['Accepts SMS Marketing'] === 'no'));
    const loss = res.losses.find((l) => l.code.endsWith('_marketing_consent'));
    assert.deepEqual(loss.params, { customers: 2, explicit: 1, timestamped: 1, pending: 0 });
    assert.equal(res.consentReport.requiresReconfirmation, true);
    assert.equal(res.consentReport.targetPolicy, 'not-subscribed');
  }
  // the CSV customer paths follow the same rule (decision 2 — intended golden change)
  const bcCsv = convert(read('bigcommerce_customers.csv'), { direction: 'bigcommerce-to-shopify', expectPlatform: 'bigcommerce' });
  assert.ok(bcCsv.rows.every((r) => r['Accepts Email Marketing'] === 'no'));
  assert.ok(!bcCsv.losses.some((l) => l.code === 'loss_marketing_consent'), 'the old "unknown consent" loss is replaced by the uniform code');
  assert.deepEqual(buildConsentReport([]), { customers: 0, explicitSourceConsent: 0, withTimestamp: 0, pending: 0, optedOut: 0, unknown: 0, targetPolicy: 'not-subscribed', requiresReconfirmation: true });
});

// ── companion joins on PrestaShop orders (addresses / states / countries) ────
test('7.6 PrestaShop joins are data: id_address_* → addresses (+ countries / states iso), current_state → order_states flags, id_currency → currencies, order_details keyed by id_order with options split from the line name', () => {
  const { orders } = parseOrdersJson('prestashop.orders.webservice.v1', J(PS('orders')), psOrderCompanions());
  const o = orders[0];
  assert.equal(o.billing.country, 'US'); assert.equal(o.billing.provinceCode, 'FL'); assert.equal(o.billing.province, 'Florida');
  assert.equal(o.currency, 'EUR'); assert.equal(o.locale, 'en');
  assert.deepEqual(o.items[0].options, [{ name: 'Color', value: 'White' }, { name: 'Size', value: 'S' }]);
  assert.equal(o.items[0].name, 'Hummingbird printed t-shirt');
  assert.equal(o.items[0].sku, 'demo_1'); assert.equal(o.items[0].variantRef, '1');
  assert.equal(o.customerRef.email, 'customer2@example.test'); assert.equal(o.customerRef.isGuest, false);
  assert.equal(o.amounts.taxes, 1.4, 'taxes = total tax-incl − tax-excl');
  assert.equal(o.status.lifecycle, 'cancelled');
});
