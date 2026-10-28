// Phase 7.7 — card-data scanner in the ingestion path. Hard rule: raw card
// data (PAN, CVV, full numbers) — and, by the same mechanism, truncated /
// masked numbers, expiry, holder, gateway tokens, IBANs and credentials —
// never reaches the canon, sourceExtension._raw, a fixture or a target.
// Detection is data (pci.v1.json): name families + value shapes + containers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as engine from '../core/dist/index.mjs';
import { scanForCardData, scanTable, luhnValid } from '../core/knowledge-proposal/pci-scanner.mjs';
import { parseWithKnowledge } from '../core/knowledge-proposal/generic-parser.mjs';
import { loadReferenceFormatsSync } from '../core/knowledge-proposal/reference.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { convert, parseCsv } = engine;
const kinds = (r) => r.findings.map((f) => f.kind + ':' + f.path).sort();

test('Luhn: a real-looking PAN validates, a GTIN-13 / random digits do not', () => {
  assert.equal(luhnValid('4242424242424242'), true);
  assert.equal(luhnValid('4242 4242 4242 4242'), true);
  assert.equal(luhnValid('5400141000016'), false, 'EAN-13 with its own check digit is not Luhn');
  assert.equal(luhnValid('1234567890123'), false);
  assert.equal(luhnValid('42424242'), false, 'too short');
});

test('BigCommerce v3 transaction shape (observed): credit_card container, cvv/avs results and the instrument token are stripped; the brand and every payment fact stay', () => {
  const tx = { id: 1283976039, order_id: '100', event: 'purchase', method: 'credit_card', amount: 249.95, currency: 'EUR', gateway: 'bigpaypay', gateway_transaction_id: '2a41-…', payment_method_id: 'bigpaypay.card', status: 'error', test: true, fraud_review: false,
    avs_result: { code: 'X', message: 'match', street_match: true, postal_match: true }, cvv_result: { code: 'M', message: 'match' },
    credit_card: { card_type: 'master', card_iin: '555555', card_last4: '4444', card_expiry_month: 12, card_expiry_year: 2030 }, gift_certificate: null, store_credit: null, offline: null, custom: null, payment_instrument_token: 'tok_abc', custom_provider_field_result: null };
  const r = scanForCardData({ transactions: [tx] });
  const out = r.value.transactions[0];
  assert.deepEqual(out.credit_card, { card_type: 'master' }, 'the brand is a payment fact; iin / last4 / expiry are card data');
  assert.equal(out.cvv_result, undefined); assert.equal(out.payment_instrument_token, undefined);
  assert.equal(out.avs_result.code, 'X', 'AVS is an address check, not card data');
  assert.equal(out.gateway_transaction_id, '2a41-…'); assert.equal(out.amount, 249.95); assert.equal(out.method, 'credit_card');
  assert.deepEqual(kinds(r), ['card-container:transactions[0].credit_card', 'cvv:transactions[0].cvv_result', 'token:transactions[0].payment_instrument_token']);
  assert.ok(!JSON.stringify(r).includes('4444') && !JSON.stringify(r).includes('555555'), 'findings never carry the value');
});

test('PrestaShop shapes (observed schema): order_payments card fields and customer credentials are stripped even when masked / hashed / null', () => {
  const payment = { id_order_payment: 1, order_reference: 'XKBKNABJK', id_currency: 1, amount: '61.800000', payment_method: 'Payment by check', conversion_rate: '1.000000', transaction_id: null, card_number: '4242XXXXXXXX4242', card_brand: 'Visa', card_expiration: '12/30', card_holder: 'J. DOE', date_add: '2026-09-21 00:00:00' };
  const p = scanForCardData(payment);
  assert.deepEqual(Object.keys(p.value).sort(), ['amount', 'card_brand', 'conversion_rate', 'date_add', 'id_currency', 'id_order_payment', 'order_reference', 'payment_method', 'transaction_id']);
  assert.deepEqual(kinds(p), ['expiry:card_expiration', 'holder:card_holder', 'pan:card_number']);
  const customer = { id: 2, email: 'x@example.test', passwd: '$2y$10$hash', secure_key: 'abc', reset_password_token: null, reset_password_validity: '0000-00-00 00:00:00', last_passwd_gen: '2026-01-01', newsletter: '1', newsletter_date_add: '2013-12-13 08:19:15', optin: '1', hash: null };
  const c = scanForCardData(customer);
  assert.deepEqual(Object.keys(c.value).sort(), ['email', 'id', 'newsletter', 'newsletter_date_add', 'optin']);
  assert.ok(c.findings.every((f) => f.kind === 'credential'));
  assert.ok(!c.findings.some((f) => f.path === 'reset_password_token'), 'a null value is stripped silently (nothing to report)');
});

test('Shopify CardPaymentDetails (schema): the container goes, company (brand) and wallet stay', () => {
  const t = { kind: 'SALE', gateway: 'shopify_payments', amountSet: { shopMoney: { amount: '12.00' } }, paymentDetails: { company: 'Visa', number: '•••• •••• •••• 4242', bin: '424242', expirationMonth: 12, expirationYear: 2030, name: 'J DOE', avsResultCode: 'Y', cvvResultCode: 'M', wallet: null } };
  const r = scanForCardData(t);
  assert.deepEqual(r.value.paymentDetails, { company: 'Visa', wallet: null });
  assert.equal(r.value.gateway, 'shopify_payments');
  assert.deepEqual(kinds(r), ['card-container:paymentDetails']);
});

test('value shapes without a telling name: masked PAN and IBAN anywhere; a bare Luhn number only in a card context', () => {
  const r = scanForCardData({ note: 'XXXX-XXXX-XXXX-1234', memo: 'DE89370400440532013000', ref: '4242424242424242', line: { global_unique_id: '4242424242424242', sku: 'A' }, cc: { number: '4242424242424242', exp: '12/30', brand: 'visa' } });
  assert.deepEqual(kinds(r), ['bank:memo', 'card-container:cc', 'pan:note']);
  assert.equal(r.value.ref, '4242424242424242', 'a bare number with no card context is left alone (could be an id)');
  assert.equal(r.value.line.global_unique_id, '4242424242424242', 'a GTIN on a product line is not a card');
  assert.deepEqual(r.value.cc, { brand: 'visa' });
});

test('false positives guarded: order number, BigCommerce currency token, product identifiers, download expiry, WooCommerce order keys', () => {
  const o = { number: '10001', id: 33, order_key: 'wc_order_abc', cart_hash: 'h', transaction_id: '6849669', currency: { token: '€', currency_code: 'EUR' }, download_expiry: '-1', line_items: [{ sku: 'A', global_unique_id: '06735597626425', price: 10 }], customer_ip_address: '0.0.0.0' };
  const r = scanForCardData(o);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.value, o);
});

test('generic parser: card data stripped BEFORE any entry or preservation channel sees it; report carries findings + a warning; goldens untouched (no card data in any fixture)', () => {
  const fmt = { id: 'x.orders.v1', platformHint: 'x', fields: [{ path: 'name', canon: 'title', transform: 'text', confidence: 'seed' }], structure: { variants: { selfWhenNone: true } } };
  const unit = { name: 'Order 1', payment: { credit_card: { card_number: '4242424242424242', card_type: 'visa' }, gateway: 'stripe', stripe_source_id: 'src_123' }, iban: 'DE89370400440532013000' };
  const { products, report } = parseWithKnowledge(fmt, [unit], { companions: { extra: [{ cvv: '123', ok: 1 }] } });
  const raw = products[0].sourceExtension.x._raw;
  assert.deepEqual(raw.payment, { credit_card: { card_type: 'visa' }, gateway: 'stripe' });
  assert.equal(raw.iban, undefined);
  assert.ok(!JSON.stringify(products).includes('4242424242424242') && !JSON.stringify(products).includes('src_123') && !JSON.stringify(products).includes('DE8937'));
  assert.deepEqual(report.warnings, [{ code: 'pci_card_data_stripped', count: 4, kinds: ['bank', 'card-container', 'cvv', 'token'] }]);
  assert.deepEqual(report.pciFindings.map((f) => f.path).sort(), ['[0].iban', '[0].payment.credit_card', '[0].payment.stripe_source_id', 'extra[0].cvv']);
  // every live fixture is clean by construction (extractors strip at capture)
  for (const dir of ['shopify-test', 'shopware-test', 'prestashop-test', 'bigcommerce-test', 'wix-test', 'woocommerce-test']) {
    for (const f of fs.readdirSync(path.join(ROOT, 'test/fixtures/live', dir)).filter((n) => n.endsWith('.json'))) {
      const r = scanForCardData(JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/live', dir, f), 'utf8')));
      assert.deepEqual(r.findings, [], `${dir}/${f}`);
    }
  }
});

test('CSV path: a card / credential column is blanked before the parser and reported; a plain file is byte-identical; an order "Number" column survives', () => {
  const csv = ['First Name,Last Name,Email,Card Number,CVV,Password,Accepts Email Marketing', 'A,B,a@example.test,4242424242424242,123,hunter2,yes', 'C,D,c@example.test,4000056655665556,456,secret,no'].join('\n');
  const res = convert(csv, { direction: 'shopify-to-woocommerce', expectPlatform: 'shopify' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.warnings[0], { code: 'pci_card_data_stripped', params: { count: 3, columns: 'Card Number, CVV, Password' } });
  assert.ok(!JSON.stringify(res.rows).includes('4242424242424242') && !JSON.stringify(res.rows).includes('hunter2'));
  const t = scanTable(parseCsv('Number,Name,Total\n1001,A,10\n1002,B,12\n1003,C,9\n'));
  assert.deepEqual(t.findings, []); assert.equal(t.rows[0].Number, '1001');
  const t2 = scanTable(parseCsv('Number,Expiry Date,Total\n4242424242424242,12/30,10\n4000056655665556,11/29,12\n5555555555554444,10/28,9\n'));
  assert.deepEqual(t2.findings.map((f) => f.path).sort(), ['Expiry Date', 'Number']);
});
