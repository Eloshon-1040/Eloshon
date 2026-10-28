import type { FormatKnowledge } from './schema';
import type { CanonCatalog, SemanticReport } from './semantic.mjs';
export interface TransformAliases {
  aliases: Record<string, { transform: string; args?: Record<string, unknown> } | null>;
  variantScoped: string[];
  canonPaths: Record<string, string>;
  appendPaths: Record<string, string>;
  unitHints?: Record<string, { transform: string; argName: string; default: string; units: string[]; note?: string }>;
}
export function proposeFormatId(headers: string[], opts?: { provenance?: string; hint?: string }): string;
export function buildLearnedFormat(input: {
  id?: string; headers: string[]; report: SemanticReport; catalog: CanonCatalog; aliases: TransformAliases;
  displayName?: string; provenance?: string; platform?: string; entity?: string; hint?: string; by?: string;
}): FormatKnowledge;
/** The field entry sending one source column to a canon field (null for a structural field). */
export function entryForCanon(input: {
  column: string; spec: CanonCatalog['fields'][number]; aliases: TransformAliases; platform?: string;
  confidence?: string; by?: string; metafield?: { key: string | null; namespace: string | null; owner?: string; via?: string } | null; customKey?: string;
}): import('./schema').FieldMapEntry | null;
