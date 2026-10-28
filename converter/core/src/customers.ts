import type { CanonCustomer, CanonAddress, CanonMarketingConsent, Row, Loss, Warning, RowError } from './types';
import { cleanScalar } from './csv';
import { parseConsent, stateToCode } from './normalize';

// Customers, both directions. Grounded in the real files + Shopify's official
// docs: Shopify keeps ONE address and exact yes/no consent; WooCommerce exports
// a WordPress USER (roles, password hash, WP UI prefs) with TWO addresses and no
// consent columns. Passwords never migrate; purchase history never re-imports;
// duplicate emails are silently skipped by Shopify — so we flag them first.

// Phase 7.3 — a CSV consent column ("Accepts Email Marketing", "Receive
// Marketing Emails") is a statement WITHOUT the source's own timestamp: a yes
// is 'pending' (never 'opted_in'), a no is 'opted_out', anything else is not a
// statement. Evidence only — every target is written not subscribed. Since
// Phase 2 the rule is DATA: marketing_consent args in the customer entries.
const EMPTY_ADDR: CanonAddress = { company: '', address1: '', address2: '', city: '', province: '', provinceCode: '', country: '', zip: '', phone: '' };
function addrEmpty(a: CanonAddress): boolean {
  return !(a.address1 || a.city || a.zip || a.company || a.province);
}

// ── Parse: Shopify customers ─────────────────────────────────────────────────
// Read by the GENERIC parser since Phase 2: the knowledge entry
// core/knowledge-ref/formats/shopify.customers.csv.v1.json is the whole parser
// (structure.parser "generic", dispatched by units.ts parseCustomersTable).

// ── Parse: WooCommerce customers (a WordPress user export) ────────────────────
// Read by the GENERIC parser since Phase 2 (woocommerce.customers.csv.v1.json:
// the customer-role filter is structure.rows.include, the shipping address an
// address_block that is null when the user left it empty).

// ── Serialize: Shopify customers (import columns) ─────────────────────────────
const SHOPIFY_CUST_HEADERS = [
  'First Name', 'Last Name', 'Email', 'Phone', 'Accepts Email Marketing', 'Accepts SMS Marketing',
  'Default Address Company', 'Default Address Address1', 'Default Address Address2', 'Default Address City',
  'Default Address Province Code', 'Default Address Country Code', 'Default Address Zip', 'Default Address Phone',
  'Note', 'Tags', 'Tax Exempt',
];
export function serializeShopifyCustomers(customers: CanonCustomer[]): { headers: string[]; rows: Row[] } {
  const rows = customers.map((c) => {
    const a = c.address;
    return {
      'First Name': c.firstName, 'Last Name': c.lastName, 'Email': c.email, 'Phone': c.phone,
      // 7.3 hard rule: a source consent never transfers — every customer lands
      // NOT subscribed; the merchant re-confirms (consentReport / loss).
      'Accepts Email Marketing': 'no', 'Accepts SMS Marketing': 'no',
      'Default Address Company': a.company, 'Default Address Address1': a.address1, 'Default Address Address2': a.address2,
      'Default Address City': a.city, 'Default Address Province Code': stateToCode(a.provinceCode || a.province, a.country),
      'Default Address Country Code': a.country, 'Default Address Zip': a.zip, 'Default Address Phone': a.phone,
      'Note': c.note, 'Tags': c.tags.join(', '), 'Tax Exempt': c.taxExempt ? 'yes' : 'no',
    } as Row;
  });
  return { headers: SHOPIFY_CUST_HEADERS, rows };
}

// ── Serialize: WooCommerce customers (import columns) ─────────────────────────
const WOO_CUST_HEADERS = [
  'user_login', 'user_email', 'first_name', 'last_name', 'roles',
  'billing_first_name', 'billing_last_name', 'billing_company', 'billing_email', 'billing_phone',
  'billing_address_1', 'billing_address_2', 'billing_city', 'billing_state', 'billing_postcode', 'billing_country',
  'shipping_first_name', 'shipping_last_name', 'shipping_company',
  'shipping_address_1', 'shipping_address_2', 'shipping_city', 'shipping_state', 'shipping_postcode', 'shipping_country',
];
export function serializeWooCustomers(customers: CanonCustomer[]): { headers: string[]; rows: Row[] } {
  const rows = customers.map((c) => {
    const a = c.address; const s = c.shipping ?? c.address;
    return {
      user_login: c.email, user_email: c.email, first_name: c.firstName, last_name: c.lastName, roles: 'customer',
      billing_first_name: c.firstName, billing_last_name: c.lastName, billing_company: a.company,
      billing_email: c.email, billing_phone: a.phone || c.phone,
      billing_address_1: a.address1, billing_address_2: a.address2, billing_city: a.city,
      billing_state: a.provinceCode || a.province, billing_postcode: a.zip, billing_country: a.country,
      shipping_first_name: c.firstName, shipping_last_name: c.lastName, shipping_company: s.company,
      shipping_address_1: s.address1, shipping_address_2: s.address2, shipping_city: s.city,
      shipping_state: s.provinceCode || s.province, shipping_postcode: s.zip, shipping_country: s.country,
    } as Row;
  });
  return { headers: WOO_CUST_HEADERS, rows };
}

// ── Duplicates: Shopify silently imports only the last of a shared email/phone.
// Flag them BEFORE she ever gets there.
export function customerWarnings(customers: CanonCustomer[]): { warnings: Warning[]; errors: RowError[] } {
  const warnings: Warning[] = [];
  const errors: RowError[] = [];
  const byEmail = new Map<string, number[]>();
  customers.forEach((c, i) => {
    const rowNum = i + 2;
    if (!c.email.trim()) {
      errors.push({ row: rowNum, field: 'email', code: 'customer_no_email' });
      return;
    }
    const key = c.email.trim().toLowerCase();
    if (!byEmail.has(key)) byEmail.set(key, []);
    byEmail.get(key)!.push(rowNum);
  });
  for (const [email, list] of byEmail) {
    if (list.length > 1) {
      warnings.push({ code: 'duplicate_emails', params: { rows: list.join(', '), email } });
    }
  }
  return { warnings, errors };
}

// ── Losses ───────────────────────────────────────────────────────────────────
export function customerLossesToShopify(customers: CanonCustomer[]): Loss[] {
  const losses: Loss[] = [
    { code: 'loss_pw_shopify' },
    { code: 'loss_purchase_history' },
  ];
  if (customers.some((c) => c.shipping && !addrEmpty(c.shipping)))
    losses.push({ code: 'loss_shipping_address' });
  return losses;
}

export function customerLossesToWoo(): Loss[] {
  return [
    { code: 'loss_pw_generic' },
  ];
}
