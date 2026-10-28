import type { FormatId, Platform, Entity, CanonProduct, Row, Direction } from './types';
import type { FormatKnowledge } from '../knowledge-proposal/schema';
import type { Table } from './csv';
import { parseCsv } from './csv';
import { detectFormat, detectJson } from './detect';
import { readEloshonText } from './eloshon';
import { SOURCE_FIELDS, applyOverridesToTable } from './mapping';
import type { MappingOverrides } from './mapping';
import { parseShopifyProducts, parseWooModern } from './products';
import { parseWixProducts } from './wix';
import { parseBigCommerceProducts } from './bigcommerce';
import { parseCustomersTable, parseProductsTable } from './units';

// ── Problèmes ligne par ligne + actions (ÉTAPE 4) ────────────────────────────
// A detailed, per-unit problem list from which the aggregate (blocking/warning/
// info/loss) is recomputed. Each problem carries a stable code, a FR/EN message,
// the SOURCE line (exact where the format is one-row-per-unit; the unit's
// representative line otherwise, flagged by lineExact), the unit identity
// (handle/SKU/email/order), the field, the current value and a suggestion.
//
// Actions:
//   • Corriger — a value edit keyed by (line, field), applied to a WORKING COPY
//     of the table (the file on disk is never touched), then re-detected.
//   • Ignorer — non-blocking problems only.
// Export is blocked only by REAL blockers (see BLOCKING RULES below), documented
// with their source.

export type Severity = 'blocking' | 'warning' | 'info' | 'loss';

export type Problem = {
  id: string;              // stable within a run: `${code}#${line}#${field}`
  code: string;
  severity: Severity;
  messageFr: string;
  messageEn: string;
  params?: Record<string, string>; // the values the message shows, so the app can word it in any interface language
  line: number | null;     // source spreadsheet line
  lineExact: boolean;      // false = the unit's representative line (grouped format)
  unitId: string;          // handle / sku / email / order number
  variant?: string;        // variant sku when the problem is variant-scoped
  field?: string;          // affected field id (matches SOURCE_FIELDS id)
  value?: string;          // current value
  suggestion?: string;     // prefill for "Corriger"
  fixable: boolean;
  ignorable: boolean;
};

export type ProblemCounts = { blocking: number; warning: number; info: number; loss: number };
export type ProblemReport = {
  ok: boolean;             // detection succeeded (a real file)
  sourceFormat: FormatId;
  targetPlatform: Platform | null;
  entity: Entity | null;
  problems: Problem[];     // active (ignored ones removed)
  ignored: Problem[];      // ignored, kept for the "annuler" list
  counts: ProblemCounts;   // of active problems
  canExport: boolean;      // no active blocking problem
};

// Corrections: value edits keyed by source line → field id → new value.
export type Corrections = Record<number, Record<string, string>>;

export type ProblemOptions = {
  direction: Direction;
  overrides?: MappingOverrides;
  corrections?: Corrections;
  ignored?: string[];      // problem ids the user chose to ignore
  // Reference ⊕ Learned FormatKnowledge snapshot — the SAME detection surface
  // the wizard's earlier steps use (Phase 1). Absent = Reference only. Without
  // it, a user-taught format reaching step 4 was re-detected as 'unknown' and
  // the export gate refused a file that converted fine in step 3.
  formats?: FormatKnowledge[];
};

// ── BLOCKING RULES (documented, honest — only what truly prevents an import) ──
// no_title            : a product with no name cannot be created on any platform
//                       (Shopify/WooCommerce/BigCommerce all require it). The
//                       engine already drops such rows.
// duplicate_sku       : WooCommerce and BigCommerce update/insert BY SKU, so a
//                       duplicate SKU makes the importer overwrite or reject the
//                       second product. Blocking for target ∈ {woocommerce,
//                       bigcommerce}; a WARNING for Shopify/Wix (which key by
//                       handle). Source: WooCommerce Product CSV Importer.
// customer_no_email   : a customer with no e-mail cannot be created (the account
//                       key). Dropped by the engine.
// order_no_line_items : an order with zero line items is not importable.
// Everything else is a WARNING/INFO/LOSS: the engine produces a valid file, but
// the user should know (e.g. missing price, negative stock repaired to 0,
// duplicate handle auto-deduped, empty description, duplicate image).

const MESSAGES: Record<string, { fr: (p: Record<string, string>) => string; en: (p: Record<string, string>) => string }> = {
  no_title: { fr: () => 'Produit sans titre : il ne peut pas être créé.', en: () => 'Product has no title: it cannot be created.' },
  duplicate_sku: { fr: (p) => `SKU en double « ${p.sku} » : la cible risque d'écraser ou refuser ce produit.`, en: (p) => `Duplicate SKU “${p.sku}”: the target may overwrite or reject this product.` },
  missing_price: { fr: (p) => `Prix manquant${p.sku ? ` (${p.sku})` : ''}.`, en: (p) => `Missing price${p.sku ? ` (${p.sku})` : ''}.` },
  negative_stock: { fr: (p) => `Stock négatif (${p.value}) : sera traité comme 0.`, en: (p) => `Negative stock (${p.value}): treated as 0.` },
  empty_description: { fr: () => 'Description vide.', en: () => 'Empty description.' },
  duplicate_handle: { fr: (p) => `Identifiant en double « ${p.handle} » : rendu unique automatiquement.`, en: (p) => `Duplicate handle “${p.handle}”: made unique automatically.` },
  duplicate_image: { fr: () => 'La même image est utilisée plusieurs fois.', en: () => 'The same image is used several times.' },
  variant_missing_option: { fr: () => 'Variante sans valeur d’option : réparée en titre par variante.', en: () => 'Variant with no option value: repaired as a per-variant title.' },
  customer_no_email: { fr: () => 'Client sans e-mail : il ne peut pas être créé.', en: () => 'Customer has no e-mail: it cannot be created.' },
  duplicate_email: { fr: (p) => `E-mail en double « ${p.email} » : seul le dernier sera importé.`, en: (p) => `Duplicate e-mail “${p.email}”: only the last is imported.` },
  order_no_line_items: { fr: () => 'Commande sans article : non importable.', en: () => 'Order with no line items: not importable.' },
};

function msg(code: string, params: Record<string, string> = {}): { fr: string; en: string } {
  const m = MESSAGES[code];
  return m ? { fr: m.fr(params), en: m.en(params) } : { fr: code, en: code };
}

function columnFor(sourceFormat: FormatId, fieldId: string): string | null {
  const rule = (SOURCE_FIELDS[sourceFormat] ?? []).find((r) => r.id === fieldId);
  return rule ? rule.column : null;
}

// ── Apply value corrections to a working table (never the file on disk) ───────
export function applyCorrectionsToTable(table: Table, sourceFormat: FormatId, corrections?: Corrections): Table {
  if (!corrections || Object.keys(corrections).length === 0) return table;
  const rows: Row[] = table.rows.map((r) => ({ ...r }));
  const extra: string[] = [];
  for (const [lineStr, fields] of Object.entries(corrections)) {
    const idx = Number(lineStr) - 2; // spreadsheet line → row index (1 header + base 1)
    if (idx < 0 || idx >= rows.length) continue;
    for (const [fieldId, value] of Object.entries(fields)) {
      const col = columnFor(sourceFormat, fieldId);
      if (!col) continue;
      if (!table.headers.includes(col) && !extra.includes(col)) extra.push(col);
      rows[idx][col] = value;
    }
  }
  return { headers: [...table.headers, ...extra.filter((h) => !table.headers.includes(h))], rows, malformed: table.malformed };
}

// ── Provenance: unit → source lines, mirroring each product parser's grouping ─
type Unit = { key: string; headLine: number; variants: { line: number; sku: string }[] };

function groupProducts(table: Table, format: FormatId): Unit[] {
  const rows = table.rows;
  const lineOf = (i: number) => i + 2; // header row + 1-based
  const has = (r: Row, k: string) => (r[k] || '').trim() !== '';

  if (format === 'shopify_products') {
    const order: string[] = []; const byHandle = new Map<string, number[]>();
    rows.forEach((r, i) => { const h = r['Handle'] || ''; if (!byHandle.has(h)) { byHandle.set(h, []); order.push(h); } byHandle.get(h)!.push(i); });
    return order.map((h) => {
      const idxs = byHandle.get(h)!;
      const variants = idxs.filter((i) => has(rows[i], 'Variant Price') || (has(rows[i], 'Option1 Value') && (rows[i]['Option1 Value'] || '').trim() !== 'Default Title'))
        .map((i) => ({ line: lineOf(i), sku: rows[i]['Variant SKU'] || '' }));
      return { key: h, headLine: lineOf(idxs[0]), variants: variants.length ? variants : [{ line: lineOf(idxs[0]), sku: rows[idxs[0]]['Variant SKU'] || '' }] };
    });
  }
  if (format === 'woo_products_modern') {
    const childrenOf = new Map<string, number[]>();
    rows.forEach((r, i) => {
      if ((r['Type'] || '').trim() !== 'variation') return;
      const p = (r['Parent'] || '').trim(); const key = p.startsWith('id:') ? p.slice(3) : p;
      if (!childrenOf.has(key)) childrenOf.set(key, []); childrenOf.get(key)!.push(i);
    });
    const units: Unit[] = [];
    rows.forEach((r, i) => {
      if ((r['Type'] || '').trim() === 'variation') return;
      const kids = (r['ID'] && childrenOf.get(r['ID'])) || (r['SKU'] && childrenOf.get(r['SKU'])) || [];
      const variants = kids.length ? kids.map((k) => ({ line: lineOf(k), sku: rows[k]['SKU'] || '' })) : [{ line: lineOf(i), sku: r['SKU'] || '' }];
      units.push({ key: r['SKU'] || r['Name'] || String(i), headLine: lineOf(i), variants });
    });
    return units;
  }
  if (format === 'woo_products_legacy') {
    return rows.map((r, i) => ({ key: r['post_name'] || r['post_title'] || String(i), headLine: lineOf(i), variants: [{ line: lineOf(i), sku: r['sku'] || '' }] }));
  }
  if (format === 'wix_products') {
    const order: string[] = []; const groups = new Map<string, { head: number; variants: number[] }>();
    rows.forEach((r, i) => {
      const h = (r['handleId'] || r['handle'] || '').trim(); if (!h) return;
      if (!groups.has(h)) { groups.set(h, { head: i, variants: [] }); order.push(h); }
      const g = groups.get(h)!;
      const kind = (r['fieldType'] || '').trim().toLowerCase();
      if (kind === 'product') g.head = i;
      else if (kind !== 'media') g.variants.push(i); // an image row is not a variant
    });
    return order.map((h) => {
      const g = groups.get(h)!;
      const variants = g.variants.length ? g.variants.map((i) => ({ line: lineOf(i), sku: rows[i]['sku'] || '' })) : [{ line: lineOf(g.head), sku: rows[g.head]['sku'] || '' }];
      return { key: h, headLine: lineOf(g.head), variants };
    });
  }
  if (format === 'bigcommerce_products') {
    const units: Unit[] = []; let cur: Unit | null = null;
    rows.forEach((r, i) => {
      const item = (r['Item'] || '').trim().toLowerCase();
      if (item === 'product') { if (cur) units.push(cur); cur = { key: (r['Product URL'] || r['Name'] || String(i)), headLine: lineOf(i), variants: [] }; }
      else if (item === 'variant' && cur) cur.variants.push({ line: lineOf(i), sku: r['SKU'] || '' });
    });
    if (cur) units.push(cur);
    return units.map((u) => (u.variants.length ? u : { ...u, variants: [{ line: u.headLine, sku: '' }] }));
  }
  return [];
}

function parseProducts(format: FormatId, table: Table, formats?: FormatKnowledge[]): CanonProduct[] {
  // the same parser the conversion uses (generic when the entry is executable)
  const generic = parseProductsTable(format, table, formats);
  if (generic) return generic;
  switch (format) {
    case 'shopify_products': return parseShopifyProducts(table.headers, table.rows);
    case 'woo_products_modern': return parseWooModern(table.headers, table.rows);
    case 'wix_products': return parseWixProducts(table.rows);
    case 'bigcommerce_products': return parseBigCommerceProducts(table.rows).products;
    default: return [];
  }
}

const GROUPED_FORMATS = new Set<FormatId>(['shopify_products', 'woo_products_modern', 'wix_products', 'bigcommerce_products']);

function detectProductProblems(table: Table, format: FormatId, target: Platform, formats?: FormatKnowledge[]): Problem[] {
  const products = parseProducts(format, table, formats);
  const units = groupProducts(table, format);
  const grouped = GROUPED_FORMATS.has(format);
  const problems: Problem[] = [];
  const push = (code: string, severity: Severity, o: Partial<Problem> & { line: number | null; unitId: string; params?: Record<string, string> }) => {
    const params = { ...(o.value !== undefined ? { value: o.value } : {}), ...(o.params ?? {}) };
    const m = msg(code, params);
    problems.push({
      id: `${code}#${o.line ?? ''}#${o.field ?? ''}`, code, severity, messageFr: m.fr, messageEn: m.en, params,
      line: o.line, lineExact: o.lineExact ?? !grouped, unitId: o.unitId, variant: o.variant, field: o.field,
      value: o.value, suggestion: o.suggestion, fixable: o.fixable ?? false, ignorable: severity !== 'blocking',
    });
  };

  // Duplicate SKU across products (blocking for Woo/BC targets).
  const skuSeen = new Map<string, { line: number; unitId: string }>();
  const dupSkuBlocking = target === 'woocommerce' || target === 'bigcommerce';

  products.forEach((p, i) => {
    const u = units[i];
    const headLine = u ? u.headLine : null;
    const unitId = p.handle || (u ? u.key : `#${i + 1}`);

    if (!p.title.trim()) {
      push('no_title', 'blocking', { line: headLine, lineExact: true, unitId, field: 'title', value: '', fixable: true, suggestion: '' });
    }
    if (!p.bodyHtml.trim()) {
      push('empty_description', 'info', { line: headLine, unitId, field: 'bodyHtml', value: '', fixable: true });
    }
    // Duplicate image URLs within the product.
    const imgs = p.images.map((im) => im.src);
    if (new Set(imgs).size < imgs.length) push('duplicate_image', 'info', { line: headLine, unitId });

    p.variants.forEach((v, vi) => {
      const vLine = (u && u.variants[vi]) ? u.variants[vi].line : headLine;
      if (v.price == null) {
        push('missing_price', 'warning', { line: vLine, unitId, variant: v.sku, field: 'price', value: '', fixable: true, params: { sku: v.sku } });
      }
      if (v.inventoryQty != null && v.inventoryQty < 0) {
        push('negative_stock', 'warning', { line: vLine, unitId, variant: v.sku, field: 'inventoryQty', value: String(v.inventoryQty), suggestion: '0', fixable: true });
      }
      // Variable product: a variant missing an option value (engine repairs it).
      if (p.options.length > 0 && p.variants.length > 1) {
        const missing = p.options.some((_, oi) => !(v.optionValues[oi] || '').trim());
        if (missing) push('variant_missing_option', 'warning', { line: vLine, unitId, variant: v.sku, field: 'options', fixable: false });
      }
      const sku = (v.sku || '').trim();
      if (sku) {
        const prev = skuSeen.get(sku);
        if (prev) push('duplicate_sku', dupSkuBlocking ? 'blocking' : 'warning', { line: vLine, unitId, variant: sku, field: 'sku', value: sku, fixable: true, params: { sku } });
        else skuSeen.set(sku, { line: vLine ?? 0, unitId });
      }
    });
  });

  // Duplicate handles across products (engine auto-dedupes → info).
  const handleSeen = new Map<string, number>();
  products.forEach((p, i) => {
    const h = p.handle;
    if (handleSeen.has(h)) push('duplicate_handle', 'info', { line: units[i]?.headLine ?? null, unitId: h, params: { handle: h } });
    else handleSeen.set(h, i);
  });

  return problems;
}

function detectCustomerProblems(table: Table, format: FormatId, formats?: FormatKnowledge[]): Problem[] {
  const problems: Problem[] = [];
  if (!['shopify_customers', 'woo_customers', 'bigcommerce_customers'].includes(format)) return problems;
  // the same parser the conversion uses (bespoke or generic, per the entry)
  const { customers, rowIndex } = parseCustomersTable(format, table, formats);
  const emailSeen = new Map<string, number>();
  customers.forEach((c, i) => {
    // one row per customer, but rows the format excludes (non-customer users) are skipped
    const line = (rowIndex[i] ?? i) + 2;
    if (!c.email.trim()) {
      const m = msg('customer_no_email');
      problems.push({ id: `customer_no_email#${line}#email`, code: 'customer_no_email', severity: 'blocking', messageFr: m.fr, messageEn: m.en, line, lineExact: true, unitId: `${c.firstName} ${c.lastName}`.trim() || `#${i + 1}`, field: 'email', value: '', fixable: true, ignorable: false });
      return;
    }
    const key = c.email.trim().toLowerCase();
    if (emailSeen.has(key)) {
      const m = msg('duplicate_email', { email: c.email });
      problems.push({ id: `duplicate_email#${line}#email`, code: 'duplicate_email', severity: 'warning', messageFr: m.fr, messageEn: m.en, params: { email: c.email }, line, lineExact: true, unitId: c.email, field: 'email', value: c.email, fixable: true, ignorable: true });
    } else emailSeen.set(key, i);
  });
  return problems;
}

// ── Public: analyze a file into a problem report (after overrides+corrections) ─
export function analyzeProblems(csvText: string, opts: ProblemOptions): ProblemReport {
  const target = (opts.direction.split('-to-')[1] as Platform) ?? null;
  // A JSON drop (Shopware / PrestaShop / REST dump) is a valid, known file —
  // the same detection convert() uses. Its unit problems surface through the
  // conversion aggregate (warnings/errors), not the line-by-line table, so the
  // report is clean and the export gate stays open. Unknown JSON still falls
  // through to the CSV path below and reports ok:false.
  // An .eloshon catalogue is already canon: a readable one is a known file
  // (its edits / removals are reported by the conversion), an unreadable one
  // is not exportable.
  const env = readEloshonText(csvText);
  if (env) {
    const clean = { problems: [], ignored: [], counts: { blocking: 0, warning: 0, info: 0, loss: 0 } };
    return env.ok
      ? { ok: true, sourceFormat: 'knowledge', targetPlatform: target, entity: env.entity, ...clean, canExport: env.entity !== null }
      : { ok: false, sourceFormat: 'unknown', targetPlatform: target, entity: null, ...clean, canExport: false };
  }
  const jd = detectJson(csvText, opts.formats);
  if (jd) {
    return {
      ok: true, sourceFormat: 'knowledge', targetPlatform: target, entity: jd.entity,
      problems: [], ignored: [], counts: { blocking: 0, warning: 0, info: 0, loss: 0 }, canExport: true,
    };
  }
  const raw = parseCsv(csvText);
  const det = detectFormat(raw.headers, opts.formats);
  if (det.format === 'unknown' || !det.entity) {
    return { ok: false, sourceFormat: det.format, targetPlatform: target, entity: det.entity, problems: [], ignored: [], counts: { blocking: 0, warning: 0, info: 0, loss: 0 }, canExport: false };
  }
  // Working copy: mirror what export will do — column re-points (overrides),
  // then value corrections — so the problem list matches the file to be written.
  let table = applyOverridesToTable(raw, det.format, opts.overrides);
  table = applyCorrectionsToTable(table, det.format, opts.corrections);

  let all: Problem[] = [];
  if (det.entity === 'products' && target) all = detectProductProblems(table, det.format, target, opts.formats);
  else if (det.entity === 'customers') all = detectCustomerProblems(table, det.format, opts.formats);
  else if (det.entity === 'orders') all = []; // order line-item validation handled by convert() aggregate

  const ignoredSet = new Set(opts.ignored ?? []);
  const active = all.filter((p) => !(ignoredSet.has(p.id) && p.severity !== 'blocking'));
  const ignored = all.filter((p) => ignoredSet.has(p.id) && p.severity !== 'blocking');

  const counts: ProblemCounts = { blocking: 0, warning: 0, info: 0, loss: 0 };
  for (const p of active) counts[p.severity]++;
  const canExport = counts.blocking === 0;

  return { ok: true, sourceFormat: det.format, targetPlatform: target, entity: det.entity, problems: active, ignored, counts, canExport };
}
