import type { CanonCustomer, CanonProduct, FormatId } from './types';
import type { Table } from './csv';
import type { FormatKnowledge } from '../knowledge-proposal/schema';
import { parseWithKnowledge } from '../knowledge-proposal/generic-parser.mjs';
import { loadReferenceFormatsSync } from '../knowledge-proposal/reference.mjs';
import { rowMatches } from '../knowledge-proposal/legacy-units.mjs';

// ── Which parser reads a legacy-id CSV format (Phase 2 Lot 3) ─────────────────
// A legacy format id (shopify_customers, …) keeps its id — the mapping table,
// the problem analysis and the result's sourceFormat are keyed on it — but its
// knowledge entry decides, as DATA, who parses it: `structure.parser:
// "generic"` = the generic knowledge-driven parser (the bespoke parser is
// retired), otherwise the engine's bespoke parser. Shared by convert() and
// analyzeProblems() so the step-4 review always reads the file the way the
// conversion does.

/** The knowledge entry describing a legacy format id. */
export function legacyEntry(sourceFormat: FormatId | string, formats?: FormatKnowledge[]): FormatKnowledge | undefined {
  return (formats ?? loadReferenceFormatsSync()).find((f) => f.legacy?.formatId === sourceFormat);
}

/** True when the entry is executable by the generic parser. */
export function isGenericParsed(format: FormatKnowledge | undefined): boolean {
  return (format?.structure as { parser?: string } | undefined)?.parser === 'generic';
}

/** A products CSV table → canon products, when its entry is executable by the
 *  generic parser; null otherwise (the caller runs the bespoke parser). Canon
 *  derivations are left to finishProducts, exactly like the bespoke route. */
export function parseProductsTable(sourceFormat: FormatId | string, table: Table, formats?: FormatKnowledge[]): CanonProduct[] | null {
  const entry = legacyEntry(sourceFormat, formats);
  if (!entry || !isGenericParsed(entry)) return null;
  return (parseWithKnowledge(entry, table.rows, { pci: false }) as { products: unknown[] }).products as CanonProduct[];
}

/** A customers CSV table → canon customers. All three customer CSV formats
 *  are read by the generic parser since Phase 2 (their bespoke parsers are
 *  retired). It preserves the columns it does not read and traces the ones it
 *  does; rows its entry excludes (structure.rows.include) are counted. The
 *  card scanner already ran on the table at ingestion (pci off here). */
export function parseCustomersTable(sourceFormat: FormatId | string, table: Table, formats?: FormatKnowledge[]): { customers: CanonCustomer[]; skippedNonCustomers: number; rowIndex: number[] } {
  const entry = legacyEntry(sourceFormat, formats);
  if (!entry || !isGenericParsed(entry)) return { customers: [], skippedNonCustomers: 0, rowIndex: [] };
  const parsed = parseWithKnowledge(entry, table.rows, { pci: false }) as { products: unknown[]; report: { excluded?: number } };
  // the source row of each customer (rows the entry excludes are skipped), so a
  // problem names the spreadsheet line the user actually sees
  const include = (entry.structure as { rows?: { include?: Record<string, unknown> } } | undefined)?.rows?.include;
  const rowIndex = table.rows.map((_, i) => i).filter((i) => rowMatches(table.rows[i], include));
  return { customers: parsed.products as CanonCustomer[], skippedNonCustomers: parsed.report.excluded ?? 0, rowIndex };
}
