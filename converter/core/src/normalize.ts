import { toNumber } from '../knowledge-proposal/transforms.mjs';
import type { RowError, Warning } from './types';

// Shared value fixers. Each exists because a real export needed it, not because
// a spec listed it.

// Parse a money/number cell tolerantly: strip currency symbols and spaces,
// accept comma decimals, keep blanks as null. Never throws.
// One number reader for the whole engine (see knowledge-proposal/values.mjs): the
// first numeric token of the cell, "12,99 € / 500 g" → 12.99, never 12.995.
export function num(v: string | undefined): number | null {
  return v == null ? null : toNumber(v);
}

// Excel-guard stripping and consent literals live in the knowledge runtime's
// shared value module (one implementation for these parsers and the generic one).
export { stripExcelGuard, parseConsent } from '../knowledge-proposal/values.mjs';
export function consentYesNo(b: boolean | null): string { return b == null ? '' : b ? 'yes' : 'no'; }

export function kgToGrams(kg: number | null): number | null { return kg == null ? null : Math.round(kg * 1000); }
export function lbsToGrams(lbs: number | null): number | null { return lbs == null ? null : Math.round(lbs * 453.592); }
export function gramsToKg(g: number | null): number | null { return g == null ? null : g / 1000; }

// ── US state name ↔ code (Woo customers spell it out; Shopify wants the code).
// One table and implementation, shared with the generic parser (values.mjs).
export { stateToCode, stateToName } from '../knowledge-proposal/values.mjs';

// ── Dates. Woo orders emit "03/15/2026 10:30:00" — MDY or DMY is ambiguous
// until a token exceeds 12. Detect across the whole column; only ask when it is
// genuinely undecidable, never guess.
export type DateOrder = 'MDY' | 'DMY' | 'ambiguous';
export function detectDateOrder(values: string[]): DateOrder {
  let sawMDY = false, sawDMY = false, sawSlash = false;
  for (const v of values) {
    const m = v.match(/^\s*(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
    if (!m) continue;
    sawSlash = true;
    const a = Number(m[1]), b = Number(m[2]);
    if (a > 12 && b <= 12) sawDMY = true;      // first field must be the day
    else if (b > 12 && a <= 12) sawMDY = true; // second field must be the day
  }
  if (sawMDY && !sawDMY) return 'MDY';
  if (sawDMY && !sawMDY) return 'DMY';
  if (!sawSlash) return 'ambiguous';
  return 'ambiguous'; // no decisive token, or a conflict → ask her
}

// Convert a slash date + known order to ISO 8601 (Shopify's format). ISO input
// passes through. Returns '' if unparseable.
export function toIso(value: string, order: DateOrder): string {
  const v = value.trim();
  if (!v) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.replace(' ', 'T'); // already ISO-ish
  const m = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return '';
  let day: number, month: number;
  if (order === 'DMY') { day = Number(m[1]); month = Number(m[2]); } else { month = Number(m[1]); day = Number(m[2]); }
  let year = Number(m[3]); if (year < 100) year += 2000;
  const hh = m[4] ?? '00', mm = m[5] ?? '00', ss = m[6] ?? '00';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${year}-${p(month)}-${p(day)}T${p(Number(hh))}:${mm}:${ss}Z`;
}

// ── Meta hygiene: WooCommerce leading-underscore keys, and known page-builder /
// theme / SEO plugin internals, are NOT product data — exclude them.
const HIDDEN_META_PREFIXES = ['_et_pb', '_elementor', '_yoast', '_wp', '_edit', '_thumbnail', '_vc_', '_wpb', '_aioseo', '_oembed'];
export function isHiddenMetaKey(key: string): boolean {
  const k = key.trim().toLowerCase();
  if (k.startsWith('_')) return true;
  return HIDDEN_META_PREFIXES.some((p) => k.startsWith(p));
}

// ── URLs / images. We can't fetch here (that's the async check), but we can
// classify and complete relative URLs against the file's dominant image origin.
export function isAbsoluteUrl(u: string): boolean { return /^https?:\/\//i.test(u.trim()); }

export function dominantOrigin(urls: string[]): string | null {
  const counts: Record<string, number> = {};
  for (const u of urls) {
    const m = u.trim().match(/^(https?:\/\/[^/]+)/i);
    if (m) counts[m[1]] = (counts[m[1]] ?? 0) + 1;
  }
  let best: string | null = null, n = 0;
  for (const [o, c] of Object.entries(counts)) if (c > n) { best = o; n = c; }
  return best;
}

// Complete a relative URL against an origin; leave absolute ones untouched.
export function absolutize(u: string, origin: string | null): string {
  const s = u.trim();
  if (!s || isAbsoluteUrl(s)) return s;
  if (!origin) return s;
  return origin.replace(/\/$/, '') + (s.startsWith('/') ? '' : '/') + s;
}

// ── WooCommerce order status (wc-*) → Shopify's two fields.
export function wooStatusToShopify(wc: string): { financial: string; fulfillment: string } {
  const s = wc.replace(/^wc-/, '').toLowerCase();
  switch (s) {
    case 'completed': return { financial: 'paid', fulfillment: 'fulfilled' };
    case 'processing': return { financial: 'paid', fulfillment: 'unfulfilled' };
    case 'on-hold': return { financial: 'pending', fulfillment: 'unfulfilled' };
    case 'pending': return { financial: 'pending', fulfillment: 'unfulfilled' };
    case 'refunded': return { financial: 'refunded', fulfillment: 'fulfilled' };
    case 'cancelled': return { financial: 'voided', fulfillment: 'unfulfilled' };
    case 'failed': return { financial: 'voided', fulfillment: 'unfulfilled' };
    default: return { financial: 'pending', fulfillment: 'unfulfilled' };
  }
}

// ── The order-line trap: parallel comma-lists of DIFFERENT lengths, where
// item_type marks some entries as coupons/fees, not products. Return only the
// real line items, aligned to the PRODUCT-level lists (which count line_items
// only), never zipping the coupon's name onto a product.
export function alignLineItems(
  itemNames: string[], itemTypes: string[], productLevel: Record<string, string[]>,
  orderRow: number,
): { items: Record<string, string>[]; warnings: Warning[]; errors: RowError[] } {
  const warnings: Warning[] = [];
  const errors: RowError[] = [];
  // Indices in the name/type lists that are real products.
  const lineItemIdx: number[] = [];
  itemTypes.forEach((t, i) => { if (t.trim() === 'line_item') lineItemIdx.push(i); });
  // Product-level lists (product_id, qty, price…) are emitted for line_items
  // only, in order. Align by sequence, not by the name-list index.
  const items: Record<string, string>[] = [];
  lineItemIdx.forEach((nameIdx, seq) => {
    const item: Record<string, string> = { name: itemNames[nameIdx] ?? '' };
    for (const [k, list] of Object.entries(productLevel)) item[k] = list[seq] ?? '';
    items.push(item);
  });
  // Note any non-product entries so nothing silently vanishes.
  const coupons = itemTypes.filter((t) => t.trim() === 'coupon').length;
  const fees = itemTypes.filter((t) => t.trim() === 'fee').length;
  if (coupons) warnings.push({ row: orderRow, code: 'coupons_become_discount', params: { count: coupons } });
  if (fees) warnings.push({ row: orderRow, code: 'fees_become_adjustment', params: { count: fees } });
  return { items, warnings, errors };
}
