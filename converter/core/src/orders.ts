import type { CanonOrder, CanonLineItem, CanonAddress, Row, Loss, Warning, Question } from './types';
import { splitList, cleanScalar } from './csv';
import { num, stripExcelGuard, stateToCode, wooStatusToShopify, detectDateOrder, toIso, alignLineItems, type DateOrder } from './normalize';

// Orders — the hard one. Shopify is ONE ROW PER LINE ITEM (order-level fields on
// the first row, blank after). WooCommerce is ONE ROW PER ORDER with the line
// items packed into parallel comma-lists that DON'T all have the same length:
// item_name/item_type include coupons and fees, while item_product_id/qty count
// line_items only. We filter on item_type before recombining, so a coupon's
// name is never zipped onto a product. Dates are MM/DD or DD/MM ambiguous — we
// detect from the column and ask only when it is genuinely undecidable.

const addr = (name: string, a: CanonAddress): CanonAddress & { name: string } => ({ name, ...a });

// ── Parse: WooCommerce orders ────────────────────────────────────────────────
export function parseWooOrders(headers: string[], rows: Row[], override?: DateOrder): { orders: CanonOrder[]; warnings: Warning[]; questions: Question[] } {
  const warnings: Warning[] = [];
  const questions: Question[] = [];
  const detected = detectDateOrder(rows.map((r) => r['order_date'] || ''));
  const order: DateOrder = override ?? (detected === 'ambiguous' ? 'MDY' : detected);
  if (!override && detected === 'ambiguous' && rows.some((r) => /[/-]/.test(r['order_date'] || ''))) {
    questions.push({ kind: 'date_format', code: 'date_ambiguous', options: ['MDY', 'DMY'] });
  }

  const orders = rows.map((r, i) => {
    const rowNum = i + 2;
    const status = wooStatusToShopify(r['order_status'] || '');
    const names = splitList(r['item_name'] || '', ',');
    const types = splitList(r['item_type'] || '', ',');
    const { items, warnings: liWarn } = alignLineItems(names, types, {
      product_id: splitList(r['item_product_id'] || '', ','),
      qty: splitList(r['item_qty'] || '', ','),
      total: splitList(r['item_line_total'] || '', ','),
    }, rowNum);
    warnings.push(...liWarn);
    // The source itself failed to serialise these — say so rather than seeming to drop them.
    if ((r['fee_line_tax_data'] || '').trim() === 'Array' || (r['shipment_taxes'] || '').trim() === 'Array')
      warnings.push({ row: rowNum, code: 'order_array_export' });

    const lineItems: CanonLineItem[] = items.map((it) => ({ name: it.name, sku: '', quantity: num(it['qty']) ?? 1, price: num(it['total']) }));
    const bCountry = cleanScalar(r['billing_country'] || '');
    const sCountry = cleanScalar(r['shipping_country'] || '');
    const mkAddr = (p: string, country: string): CanonAddress => ({
      company: cleanScalar(r[`${p}_company`] || ''), address1: cleanScalar(r[`${p}_address_1`] || ''),
      address2: cleanScalar(r[`${p}_address_2`] || ''), city: cleanScalar(r[`${p}_city`] || ''),
      province: cleanScalar(r[`${p}_state`] || ''), provinceCode: stateToCode(cleanScalar(r[`${p}_state`] || ''), country),
      country, zip: cleanScalar(r[`${p}_postcode`] || ''), phone: cleanScalar(r[`${p}_phone`] || ''),
    });
    return {
      number: cleanScalar(r['ORDERID'] || ''), email: cleanScalar(r['billing_email'] || r['customer_user'] || ''),
      createdAt: toIso(r['order_date'] || '', order),
      financialStatus: status.financial, fulfillmentStatus: status.fulfillment,
      currency: cleanScalar(r['order_currency'] || ''),
      subtotal: null, shipping: num(r['order_shipping']), taxes: num(r['order_tax']), total: num(r['order_total']),
      discountCode: names[types.indexOf('coupon')] || '', discountAmount: num(r['cart_discount']),
      paymentMethod: cleanScalar(r['payment_method_title'] || ''), transactionId: cleanScalar(r['transaction_id'] || ''),
      note: cleanScalar(r['customer_note'] || ''),
      billing: addr(`${cleanScalar(r['billing_first_name'] || '')} ${cleanScalar(r['billing_last_name'] || '')}`.trim(), mkAddr('billing', bCountry)),
      shipping_: addr(`${cleanScalar(r['shipping_first_name'] || '')} ${cleanScalar(r['shipping_last_name'] || '')}`.trim(), mkAddr('shipping', sCountry)),
      lineItems,
    } as CanonOrder;
  });
  return { orders, warnings, questions };
}

// ── Parse: Shopify orders (one row per line item, order-level on the first) ──
export function parseShopifyOrders(rows: Row[]): { orders: CanonOrder[]; warnings: Warning[] } {
  const groups = new Map<string, Row[]>(); const order: string[] = [];
  for (const r of rows) { const n = r['Name'] || ''; if (!groups.has(n)) { groups.set(n, []); order.push(n); } groups.get(n)!.push(r); }
  const orders = order.map((name) => {
    const grp = groups.get(name)!; const head = grp[0];
    const mkAddr = (p: string): CanonAddress => ({
      company: cleanScalar(head[`${p} Company`] || ''), address1: cleanScalar(head[`${p} Address1`] || ''),
      address2: cleanScalar(head[`${p} Address2`] || ''), city: cleanScalar(head[`${p} City`] || ''),
      province: cleanScalar(head[`${p} Province`] || ''), provinceCode: cleanScalar(head[`${p} Province`] || ''),
      country: cleanScalar(head[`${p} Country`] || ''), zip: cleanScalar(head[`${p} Zip`] || ''),
      phone: stripExcelGuard(cleanScalar(head[`${p} Phone`] || '')),
    });
    const lineItems: CanonLineItem[] = grp.filter((r) => (r['Lineitem name'] || '').trim()).map((r) => ({
      name: cleanScalar(r['Lineitem name'] || ''), sku: cleanScalar(r['Lineitem sku'] || ''),
      quantity: num(r['Lineitem quantity']) ?? 1, price: num(r['Lineitem price']),
    }));
    return {
      number: name, email: cleanScalar(head['Email'] || ''), createdAt: cleanScalar(head['Created at'] || ''),
      financialStatus: (head['Financial Status'] || '').toLowerCase(), fulfillmentStatus: (head['Fulfillment Status'] || 'unfulfilled').toLowerCase(),
      currency: cleanScalar(head['Currency'] || ''),
      subtotal: num(head['Subtotal']), shipping: num(head['Shipping']), taxes: num(head['Taxes']), total: num(head['Total']),
      discountCode: cleanScalar(head['Discount Code'] || ''), discountAmount: num(head['Discount Amount']),
      paymentMethod: cleanScalar(head['Payment Method'] || ''), transactionId: cleanScalar(head['Payment Reference'] || ''),
      note: cleanScalar(head['Notes'] || ''),
      billing: addr(cleanScalar(head['Billing Name'] || ''), mkAddr('Billing')),
      shipping_: addr(cleanScalar(head['Shipping Name'] || ''), mkAddr('Shipping')),
      lineItems,
    } as CanonOrder;
  });
  return { orders, warnings: [] };
}

// ── Serialize: Shopify orders ────────────────────────────────────────────────
const SHOPIFY_ORDER_HEADERS = [
  'Name', 'Email', 'Financial Status', 'Fulfillment Status', 'Currency', 'Subtotal', 'Shipping', 'Taxes', 'Total',
  'Discount Code', 'Discount Amount', 'Created at',
  'Lineitem quantity', 'Lineitem name', 'Lineitem price', 'Lineitem sku',
  'Billing Name', 'Billing Company', 'Billing Address1', 'Billing Address2', 'Billing City', 'Billing Zip', 'Billing Province', 'Billing Country', 'Billing Phone',
  'Shipping Name', 'Shipping Company', 'Shipping Address1', 'Shipping Address2', 'Shipping City', 'Shipping Zip', 'Shipping Province', 'Shipping Country',
  'Payment Method', 'Notes',
  // 7.4 (B2) — the SOURCE order number / id as structured note attributes,
  // the target's own attribute channel (like WooCommerce order meta). Never in
  // Name: Shopify generates its own order name / number.
  'Note Attributes',
];
// Structured note attributes, Shopify export convention: one "key: value" per line.
function sourceRefAttributes(o: CanonOrder): string {
  const n = o.numbering;
  const pairs: [string, string][] = [['source_order_number', (n?.sourceNumber ?? o.number ?? '').trim()]];
  if (n?.sourceId && n.sourceId !== pairs[0][1]) pairs.push(['source_order_id', n.sourceId]);
  if (n?.sourceInvoiceNumber) pairs.push(['source_invoice_number', n.sourceInvoiceNumber]);
  return pairs.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n');
}
export function serializeShopifyOrders(orders: CanonOrder[]): { headers: string[]; rows: Row[] } {
  const rows: Row[] = [];
  const blank = (): Row => Object.fromEntries(SHOPIFY_ORDER_HEADERS.map((h) => [h, '']));
  for (const o of orders) {
    const lines = o.lineItems.length ? o.lineItems : [{ name: '', sku: '', quantity: 1, price: null }];
    lines.forEach((li, i) => {
      const row = blank();
      // 7.4 (B2, validated 7.2 §5): no serialiser writes the target's order
      // name / number — Name stays empty and Shopify assigns its sequence. The
      // source reference travels as Note Attributes (below). Constraint: the
      // Shopify order CSV layout associates the rows of a multi-line order by
      // Name only, so a multi-line order is declared as loss_shopify_order_rows.
      row['Name'] = '';
      row['Lineitem quantity'] = String(li.quantity);
      row['Lineitem name'] = li.name;
      row['Lineitem price'] = li.price != null ? li.price.toFixed(2) : '';
      row['Lineitem sku'] = li.sku;
      if (i === 0) {
        row['Email'] = o.email; row['Financial Status'] = o.financialStatus; row['Fulfillment Status'] = o.fulfillmentStatus;
        row['Currency'] = o.currency;
        row['Subtotal'] = o.subtotal != null ? o.subtotal.toFixed(2) : '';
        row['Shipping'] = o.shipping != null ? o.shipping.toFixed(2) : '';
        row['Taxes'] = o.taxes != null ? o.taxes.toFixed(2) : '';
        row['Total'] = o.total != null ? o.total.toFixed(2) : '';
        row['Discount Code'] = o.discountCode; row['Discount Amount'] = o.discountAmount != null ? o.discountAmount.toFixed(2) : '';
        row['Created at'] = o.createdAt;
        row['Billing Name'] = o.billing.name; row['Billing Company'] = o.billing.company;
        row['Billing Address1'] = o.billing.address1; row['Billing Address2'] = o.billing.address2;
        row['Billing City'] = o.billing.city; row['Billing Zip'] = o.billing.zip;
        row['Billing Province'] = o.billing.provinceCode || o.billing.province; row['Billing Country'] = o.billing.country; row['Billing Phone'] = o.billing.phone;
        row['Shipping Name'] = o.shipping_.name; row['Shipping Company'] = o.shipping_.company;
        row['Shipping Address1'] = o.shipping_.address1; row['Shipping Address2'] = o.shipping_.address2;
        row['Shipping City'] = o.shipping_.city; row['Shipping Zip'] = o.shipping_.zip;
        row['Shipping Province'] = o.shipping_.provinceCode || o.shipping_.province; row['Shipping Country'] = o.shipping_.country;
        row['Payment Method'] = o.paymentMethod; row['Notes'] = o.note;
        row['Note Attributes'] = sourceRefAttributes(o);
      }
      rows.push(row);
    });
  }
  return { headers: SHOPIFY_ORDER_HEADERS, rows };
}

// ── Serialize: WooCommerce orders (pack line items back into comma-lists) ─────
function shopifyStatusToWc(financial: string, fulfillment: string): string {
  if (financial === 'refunded') return 'wc-refunded';
  if (financial === 'voided') return 'wc-cancelled';
  if (fulfillment === 'fulfilled') return 'wc-completed';
  if (financial === 'paid') return 'wc-processing';
  return 'wc-pending';
}
const WOO_ORDER_HEADERS = [
  'ORDERID', 'order_status', 'order_date', 'customer_note', 'order_currency', 'order_total', 'order_tax', 'order_shipping', 'cart_discount',
  'payment_method_title', 'transaction_id',
  'billing_first_name', 'billing_last_name', 'billing_company', 'billing_email', 'billing_phone',
  'billing_address_1', 'billing_address_2', 'billing_city', 'billing_state', 'billing_postcode', 'billing_country',
  'shipping_first_name', 'shipping_last_name', 'shipping_company',
  'shipping_address_1', 'shipping_address_2', 'shipping_city', 'shipping_state', 'shipping_postcode', 'shipping_country',
  'item_name', 'item_type', 'item_product_id', 'item_qty', 'item_line_total',
  // 7.4 — the SOURCE order number, visible as order meta; never the target's ID
  'meta:_source_order_number',
];
export function serializeWooOrders(orders: CanonOrder[]): { headers: string[]; rows: Row[] } {
  const splitName = (n: string) => { const p = n.split(' '); return { first: p.slice(0, -1).join(' ') || p[0] || '', last: p.length > 1 ? p[p.length - 1] : '' }; };
  const rows = orders.map((o) => {
    const b = splitName(o.billing.name); const s = splitName(o.shipping_.name);
    return {
      // 7.4 hard rule: ORDERID is WooCommerce's own post ID — an importer given
      // a value updates / claims that ID. Left empty so the target assigns its
      // sequence natively; the source number travels as order meta below.
      ORDERID: '', order_status: shopifyStatusToWc(o.financialStatus, o.fulfillmentStatus),
      order_date: o.createdAt, customer_note: o.note, order_currency: o.currency,
      order_total: o.total != null ? String(o.total) : '', order_tax: o.taxes != null ? String(o.taxes) : '',
      order_shipping: o.shipping != null ? String(o.shipping) : '', cart_discount: o.discountAmount != null ? String(o.discountAmount) : '',
      payment_method_title: o.paymentMethod, transaction_id: o.transactionId,
      billing_first_name: b.first, billing_last_name: b.last, billing_company: o.billing.company, billing_email: o.email, billing_phone: o.billing.phone,
      billing_address_1: o.billing.address1, billing_address_2: o.billing.address2, billing_city: o.billing.city,
      billing_state: o.billing.provinceCode || o.billing.province, billing_postcode: o.billing.zip, billing_country: o.billing.country,
      shipping_first_name: s.first, shipping_last_name: s.last, shipping_company: o.shipping_.company,
      shipping_address_1: o.shipping_.address1, shipping_address_2: o.shipping_.address2, shipping_city: o.shipping_.city,
      shipping_state: o.shipping_.provinceCode || o.shipping_.province, shipping_postcode: o.shipping_.zip, shipping_country: o.shipping_.country,
      item_name: o.lineItems.map((li) => li.name).join(','),
      item_type: o.lineItems.map(() => 'line_item').join(','),
      item_product_id: o.lineItems.map(() => '').join(','),
      item_qty: o.lineItems.map((li) => String(li.quantity)).join(','),
      item_line_total: o.lineItems.map((li) => (li.price != null ? String(li.price) : '')).join(','),
      'meta:_source_order_number': o.numbering?.sourceNumber ?? o.number,
    } as Row;
  });
  return { headers: WOO_ORDER_HEADERS, rows };
}

// ── Losses ───────────────────────────────────────────────────────────────────
export function orderLossesToShopify(orders: CanonOrder[] = []): Loss[] {
  const losses: Loss[] = [
    { code: 'loss_per_tax' },
    { code: 'loss_coupons_as_lines' },
  ];
  // B2: without an order key in Name, the line rows of a multi-line order are
  // only associated by their position (first row carries the order fields).
  const multi = orders.filter((o) => o.lineItems.length > 1).length;
  if (multi) losses.push({ code: 'loss_shopify_order_rows', params: { orders: multi } });
  return losses;
}
export function orderLossesToWoo(): Loss[] {
  return [
    { code: 'loss_refund_risk' },
  ];
}
