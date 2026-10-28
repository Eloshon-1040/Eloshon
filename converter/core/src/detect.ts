import type { FormatId, Entity, Platform } from './types';
import type { FormatKnowledge } from '../knowledge-proposal/schema';
import { recognize, toLegacyDetection } from '../knowledge-proposal/recognizer.mjs';
import { loadReferenceFormatsSync } from '../knowledge-proposal/reference.mjs';

// Detect the source format from the header set alone — grounded in the real
// export files, not a spec. Since Phase 5.3 the signatures are DATA: one
// FormatKnowledge entry per format in `core/knowledge-ref/formats/*.json`
// (the Reference strata), matched by the FormatRecognizer. Nothing here knows
// a platform by name. Detected formats are ranked by specificity (how many
// signature columns matched) — no list order to maintain.
//
// This module is the synchronous bridge the engine needs (`convert()` is
// sync). Learned knowledge (user-taught formats) is overlaid by the async
// recognizer (`createFormatRecognizer(store)`), not here — pass `formats` to
// inject a Reference ⊕ Learned snapshot when the caller has one.

export type Detection = {
  format: FormatId; platform: Platform | null; entity: Entity | null;
  /** KnowledgeStore id of the recognised format (also set when format is 'unknown'
   *  but a knowledge entry matched without being convertible yet). */
  knowledgeId?: string | null;
  /** Human name of the knowledge entry. */
  displayName?: string | null;
  /** Set when a TAUGHT format matched because the file is nearly (not exactly) the columns
   *  it was taught on: how many columns the file adds / lacks compared with it. */
  similar?: { added: number; missing: number };
};

export function detectFormat(headers: string[], formats: FormatKnowledge[] = loadReferenceFormatsSync()): Detection {
  const matches = recognize({ kind: 'csv-header-set', columns: headers }, formats);
  const d = toLegacyDetection(matches, formats);
  return { format: d.format as FormatId, platform: d.platform as Platform | null, entity: d.entity, knowledgeId: d.knowledgeId, displayName: d.displayName, ...(d.similar ? { similar: d.similar } : {}) };
}

// ── JSON drops ───────────────────────────────────────────────────────────────
// A Shopware / PrestaShop / scraper payload dropped as a .json file is matched
// by `json-shape` signatures: the paths present in the FIRST item. These
// helpers are the ONE implementation shared by convert() and analyzeProblems()
// so step 4 can never disagree with step 5 about what a JSON file is (the
// pre-fix bug: problems re-detected with the CSV path only, saw 'unknown', and
// blocked the export gate).
function collectJsonPaths(sample: unknown, prefix = '', out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 4 || sample == null) return out;
  if (Array.isArray(sample)) {
    if (sample.length > 0) collectJsonPaths(sample[0], prefix, out, depth + 1);
    return out;
  }
  if (typeof sample === 'object') {
    for (const k of Object.keys(sample as Record<string, unknown>)) {
      const p = prefix ? prefix + '.' + k : k;
      out.add(p);
      const v = (sample as Record<string, unknown>)[k];
      if (v && typeof v === 'object') collectJsonPaths(v, p, out, depth + 1);
    }
  }
  return out;
}

/** The dotted paths present in a JSON item (what json-shape signatures match). */
export function jsonShapePaths(item: unknown): string[] {
  return [...collectJsonPaths(item)];
}

/** Parse a JSON payload (text starting with [ or {) and unwrap the item array
 *  ([...], or {products|orders|customers|data|items: [...]}, or one object).
 *  Returns null when the text is not JSON at all — the caller falls back to
 *  the CSV path. An empty array comes back as [] (empty file, not "not JSON"). */
export function extractJsonItems(text: string): unknown[] | null {
  const trimmed = (text || '').replace(/^﻿/, '').trimStart();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return null;
  let payload: unknown;
  try { payload = JSON.parse(trimmed); } catch { return null; }
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    const wrapped = ['products', 'orders', 'customers', 'data', 'items'].find((k) => Array.isArray(obj[k]));
    return wrapped ? (obj[wrapped] as unknown[]) : [payload];
  }
  return null;
}

/** Match extracted JSON items against the `json-shape` signatures of `formats`.
 *  Returns the best-matching FormatKnowledge entry, or null (unknown JSON). */
export function matchJsonFormat(items: unknown[], formats: FormatKnowledge[]): FormatKnowledge | null {
  if (items.length === 0) return null;
  const paths = jsonShapePaths(items[0]);
  const jsonFormats = formats.filter((f) => Array.isArray(f.signatures) && f.signatures.some((s: { kind: string }) => s.kind === 'json-shape'));
  const matches = recognize({ kind: 'json-shape', paths } as unknown as { kind: 'json-shape'; paths: string[] }, jsonFormats) as { formatId: string; kind: string }[];
  const best = matches.find((m) => m.kind === 'exact' || m.kind === 'superset') ?? matches[0];
  if (!best) return null;
  return jsonFormats.find((f) => f.id === best.formatId) ?? null;
}

/** The source platform a JSON knowledge entry declares (hint > routing > legacy). */
export function jsonFormatPlatform(format: FormatKnowledge): Platform | null {
  return ((format as { platformHint?: string }).platformHint
    ?? (format as { routing?: { platform?: string } }).routing?.platform
    ?? (format as { legacy?: { platform?: string } }).legacy?.platform ?? null) as Platform | null;
}

export type JsonDetection = { knowledgeId: string; displayName: string | null; platform: Platform | null; entity: Entity | null; items: unknown[] };

/** Detect a JSON payload against the json-shape signatures of `formats`.
 *  Returns null when the text is not JSON, is empty, or no format matches —
 *  the caller falls back to the CSV path. */
export function detectJson(text: string, formats: FormatKnowledge[] = loadReferenceFormatsSync()): JsonDetection | null {
  const items = extractJsonItems(text);
  if (!items || items.length === 0) return null;
  const format = matchJsonFormat(items, formats);
  if (!format) return null;
  return {
    knowledgeId: format.id, displayName: format.displayName ?? null,
    platform: jsonFormatPlatform(format), entity: (format.entity ?? null) as Entity | null, items,
  };
}

// Does this detection match what the page expects (its direction + entity)?
// Drives the "wrong file — did you mean the other converter?" redirect.
export function matchesExpected(det: Detection, expectPlatform: Platform, expectEntity: Entity): boolean {
  return det.platform === expectPlatform && det.entity === expectEntity;
}

// Describe a detected file in the words she'd use for what she is HOLDING — not
// the internal format name. Someone with a BigBuy feed in PrestaShop format has
// probably never used PrestaShop; "PrestaShop format detected" reads as a
// mistake. Name the thing, then note the format.
export function describeFormat(format: FormatId): string {
  switch (format) {
    case 'shopify_products': return 'a Shopify product export';
    case 'woo_products_modern': return 'a WooCommerce product export';
    case 'woo_products_legacy': return 'a WooCommerce product export (older format)';
    case 'shopify_customers': return 'a Shopify customer export';
    case 'woo_customers': return 'a WooCommerce customer export';
    case 'shopify_orders': return 'a Shopify order export';
    case 'woo_orders': return 'a WooCommerce order export';
    case 'bigbuy_standard': return 'a supplier catalogue (BigBuy standard format)';
    case 'bigbuy_presta': return 'a supplier catalogue in PrestaShop format — BigBuy and other suppliers produce these';
    case 'presta_categories': return 'a supplier categories file (the companion to a PrestaShop-format catalogue)';
    case 'wix_products': return 'a Wix product export';
    case 'bigcommerce_products': return 'a BigCommerce product export';
    case 'bigcommerce_customers': return 'a BigCommerce customer export';
    case 'bigcommerce_orders': return 'a BigCommerce order export';
    default: return 'this file';
  }
}
