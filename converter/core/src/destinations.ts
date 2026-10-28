// Where each canon field lands in a target's product file — READ FROM THE SERIALISERS, never copied by hand.
//
// For each field a step-3 column can be pointed at, the probe parses a one-row file through the real generic parser
// (the same entries a user's « Modifier » choice writes: entryForCanon), serialises it with the real serialiser, and
// keeps the output columns that differ from the same product without that field. Variation-only columns (a variant
// image, an option) are probed on a two-variant product too. The option axes and the merchant metafields, which no
// single column feeds, are probed the same way. Result memoised per target; nothing here is written to disk.
//
// This replaces the hand-maintained product tables of mapping.ts, which had drifted from the serialisers (WooCommerce
// « handle → SKU (parent) » after the SKU rule; barcodes, technical sheet and availability said « not carried »).
import type { CanonProduct, Platform } from './types';
import type { Row } from './csv';
import { parseWithKnowledge, applyCanonDerivations } from '../knowledge-proposal/generic-parser.mjs';
import { entryForCanon } from '../knowledge-proposal/learn.mjs';
import { loadCanonCatalogSync, loadTransformAliasesSync } from '../knowledge-proposal/reference.mjs';
import { serializeProductsFor } from './serialize';

export type ProductTarget = 'shopify' | 'woocommerce' | 'wix' | 'bigcommerce';
export const PRODUCT_TARGETS: ProductTarget[] = ['shopify', 'woocommerce', 'wix', 'bigcommerce'];

type CatalogField = { path: string; entity: string; transform: string };
type FormatEntry = { path: string; canon: string | null; transform: string; when?: string; args?: Record<string, unknown> };

/** The fields a step-3 column can be pointed at: product fields of the canon catalog whose transform the engine knows. */
export function editableProductFields(): string[] {
  const aliases = loadTransformAliasesSync() as { aliases?: Record<string, unknown> };
  return (loadCanonCatalogSync().fields as CatalogField[])
    .filter((f) => f.entity === 'products' && f.path !== 'metafields' && f.path !== 'translations' && aliases.aliases?.[f.transform])
    .map((f) => f.path);
}

// Probe values the real transforms accept (an image must be an address, a promo price above the price, a status
// one the platforms know); booleans are probed both ways.
const URL_V = 'https://probe.test/p/a.jpg';
const SAMPLE: Record<string, string[]> = {
  images: [URL_V], variantImage: [URL_V], sourceUrl: ['https://probe.test/p/1'], status: ['draft', 'archived'],
  price: ['7.5'], compareAtPrice: ['20'], cost: ['4'], grams: ['2'], inventoryQty: ['3'], lengthCm: ['4'], widthCm: ['5'], heightCm: ['6'],
  categories: ['Probe A > Probe B'], tags: ['probe-tag'], vatRate: ['21'], currency: ['USD'], unitPrice: ['12.5', '1.25 €/kg'],
  barcode: ['4006381333931'], 'identifiers.gtin': ['4006381333931'], 'identifiers.ean': ['4006381333931'],
  'identifiers.upc': ['036000291452'], 'identifiers.isbn': ['9780306406157'],
};
const BASE: FormatEntry[] = [
  { path: 'n', canon: 'title', transform: 'text' },
  { path: 'h', canon: 'handle', transform: 'text' },
  { path: 'p', canon: 'variants[].price', transform: 'money', when: 'self' },
];
const BASE_ROW = { n: 'Probe', h: 'probe', p: '10' };
// A promotion (compare-at price above the price): some targets then write the price elsewhere (WooCommerce « Sale price »).
const PROMO: FormatEntry = { path: 'c', canon: 'variants[].compareAtPrice', transform: 'money', when: 'self' };
const PROMO_ROW = { ...BASE_ROW, c: '50' };

function parseOne(extra: FormatEntry[], row: Record<string, string>): CanonProduct {
  const format = { id: 'probe.csv.v1', entity: 'products', platformHint: 'probe', structure: { unit: 'product' }, fields: [...BASE, ...extra] };
  const { products } = parseWithKnowledge(format as never, [row], { platform: 'probe', pci: false }) as { products: CanonProduct[] };
  return products[0];
}
// The same product with two variants on one option axis (variation rows exist only then).
function asVariable(p: CanonProduct, axis = { name: 'Probe size', values: ['S', 'M'] }): CanonProduct {
  const q = structuredClone(p) as CanonProduct & { options: { name: string; values: string[] }[] };
  const v0 = q.variants[0];
  q.options = [{ name: axis.name, values: [...axis.values] }];
  q.variants = [{ ...v0, optionValues: [axis.values[0]] }, { ...structuredClone(v0), optionValues: [axis.values[1]] }];
  return q;
}
// As a real conversion does (finishProducts): canon derivations first (barcode ← EAN / GTIN…), then the serialiser.
// Categories also go to Shopify's Tags by default (the app's « catégories en tags », on unless turned off), so a
// « Collection » column shows both columns it really lands in: Product Category, and Tags for automated collections.
function write(target: Platform, p: CanonProduct): { headers: string[]; rows: Row[] } {
  return serializeProductsFor(target, applyCanonDerivations([structuredClone(p)], loadCanonCatalogSync() as never), true);
}
// Columns that differ between two outputs (a column only one of them has counts). When the field ADDS rows (a
// picture written as its own MEDIA / Image row), every column of the new row differs: only the columns that now hold
// the probe value (or the picture's file name) are its destination.
function changed(a: { headers: string[]; rows: Row[] }, b: { headers: string[]; rows: Row[] }, probe?: string): string[] {
  const cols = [...new Set([...a.headers, ...b.headers])];
  if (a.rows.length !== b.rows.length && probe) {
    const tokens = [probe, probe.split('/').pop() || probe].filter((x) => x.length >= 3);
    const holds = (out: { rows: Row[] }, c: string) => out.rows.some((r) => tokens.some((t) => String(r[c] ?? '').includes(t)));
    return cols.filter((c) => holds(b, c) && !holds(a, c));
  }
  return cols.filter((c) => !a.headers.includes(c) || !b.headers.includes(c)
    || a.rows.length !== b.rows.length || a.rows.some((r, i) => String(r[c] ?? '') !== String((b.rows[i] || {})[c] ?? '')));
}

const memo = new Map<ProductTarget, Record<string, string[]>>();

/** canon field → the output columns the target's serialiser writes it to ([] = not carried). Families: `options`,
 *  `metafields` (its columns hold `*` where the merchant's key goes). */
export function productDestinations(target: ProductTarget): Record<string, string[]> {
  const hit = memo.get(target); if (hit) return hit;
  const catalog = loadCanonCatalogSync().fields as CatalogField[];
  const aliases = loadTransformAliasesSync();
  const spec = (p: string) => catalog.find((f) => f.entity === 'products' && f.path === p);
  const base = parseOne([], BASE_ROW);
  const baseSimple = write(target, base); const baseVar = write(target, asVariable(base));
  const basePromo = write(target, parseOne([PROMO], PROMO_ROW));
  const out: Record<string, string[]> = {};
  for (const field of editableProductFields()) {
    // The probe column is named `probecol`: a field stored under the column's own name (a metafield) shows `*` there.
    const sp = spec(field); const e = (sp ? entryForCanon({ column: 'probecol', spec: sp as never, aliases }) : null) as FormatEntry | null;
    if (!e) { out[field] = []; continue; }
    const values = SAMPLE[field] ?? (e.transform === 'bool' ? ['false', 'true'] : ['PROBE-1']);
    const cols = new Set<string>();
    for (const v of values) {
      const p = parseOne([e], { ...BASE_ROW, probecol: v });
      for (const c of changed(baseSimple, write(target, p), v)) cols.add(c);
      for (const c of changed(baseVar, write(target, asVariable(p)), v)) cols.add(c);
      if (e.canon !== PROMO.canon) for (const c of changed(basePromo, write(target, parseOne([PROMO, e], { ...PROMO_ROW, probecol: v })), v)) cols.add(c);
    }
    // The base title / handle / price feed the probe product; their own probe changes the value they already hold.
    out[field] = [...cols].map((c) => c.replace(/probecol/g, '*'));
  }
  // Option axes: the same two-variant product with another axis name and values.
  out.options = changed(write(target, asVariable(base)), write(target, asVariable(base, { name: 'Probe colour', values: ['Red', 'Blue'] })));
  // Merchant metafields (a custom field the user names): its key shows as `*`.
  const metaSpec = spec('metafields'); const meta = (metaSpec ? entryForCanon({ column: 'probekey', spec: metaSpec as never, aliases, customKey: 'probekey' }) : null) as FormatEntry | null;
  out.metafields = meta ? changed(baseSimple, write(target, parseOne([meta], { ...BASE_ROW, probekey: 'PROBE-1' }))).map((c) => c.replace(/probekey/g, '*')) : [];
  memo.set(target, out);
  return out;
}

// One entry of a known format, as the format stores it (a value kept for the source's own record, a descriptive
// attribute, the page slug…): no step-3 field describes it, so it is probed on its own, through the same parser and
// serialiser, with the column's own first value. Result memoised; [] when the target writes nothing for it.
const entryMemo = new Map<string, string[]>();
export function entryDestinations(target: ProductTarget, entry: { canon: string; transform: string; when?: string; args?: Record<string, unknown> }, value?: string): string[] {
  const v = value != null && String(value).trim() !== '' ? String(value).trim() : 'PROBE-1';
  const key = JSON.stringify([target, entry.canon, entry.transform, entry.args ?? null, v]);
  const hit = entryMemo.get(key); if (hit) return hit;
  let out: string[] = [];
  try {
    const e: FormatEntry = { path: 'probecol', canon: entry.canon, transform: entry.transform, ...(entry.when === 'self' ? { when: 'self' } : {}), ...(entry.args ? { args: entry.args } : {}) };
    const base = parseOne([], BASE_ROW);
    const p = parseOne([e], { ...BASE_ROW, probecol: v });
    const cols = new Set<string>([...changed(write(target, base), write(target, p), v), ...changed(write(target, asVariable(base)), write(target, asVariable(p)), v)]);
    out = [...cols].map((c) => c.replace(/probecol/g, '*'));
  } catch { out = []; }
  entryMemo.set(key, out);
  return out;
}
