import type { Confidence, FieldMapEntry, LearnedDecision, KnowledgeStoreConfig, DecisionScope, MappingAction } from './schema';

export interface CanonFieldSpec {
  path: string;
  entity: 'products' | 'customers' | 'orders';
  scope: 'product' | 'variant';
  accepts: string[];
  names: { en: string[]; fr: string[] };
  transform: string;
  required?: boolean; unique?: boolean; reviewAlways?: boolean; pii?: boolean;
  relation?: string; role?: string; unitHint?: string; family?: string;
}
/** Phase 6.3 — a canonical field filled from other canonical fields when the source left it empty (see generic-parser applyCanonDerivations). */
export interface CanonDerivation { scope: 'product' | 'variant' | 'order' | 'customer'; path: string; from: string[]; transform?: string; args?: Record<string, unknown>; notes?: string }
export interface CanonCatalog { schemaVersion: 1; id: string; canonRef: string; fields: CanonFieldSpec[]; derivations?: CanonDerivation[] }
/** Phase 6.5 — metafield namespace ownership, all data (recognition.v1.json#metafieldOwnership). */
export interface MetafieldOwnershipConfig {
  columnPatterns: { platform: string; pattern: string; flags?: string; namespace?: number; key?: number }[];
  platformOwned?: Record<string, string[]>;
  merchantOwned?: Record<string, string[]>;
  thirdPartyGrammar?: { platform?: string; on: 'namespace' | 'key'; pattern: string; flags?: string; note?: string }[];
  unknownNamespaceIsThirdParty?: boolean;
  prefixCluster?: { minKeys?: number; separators?: string; minPrefixLength?: number; note?: string };
  thirdPartyPenalty?: number;
}
/** Phase 6.7 — a locale-suffixed translatable column: its locale, the canon translation field, the flat field it would be when elected default. */
export interface TranslationFact { locale: string; field: 'title' | 'bodyHtml' | 'slug' | 'seoTitle' | 'seoDescription'; flatField: string; isDefault: boolean }
export type MetafieldOwner = 'platform' | 'merchant' | 'thirdParty';
export interface MetafieldOwnership { platform: string; namespace: string | null; key: string | null; owner: MetafieldOwner; via: 'grammar' | 'list' | 'cluster' | 'default' }
export interface RecognitionConfig {
  thresholds: { auto: number; grey: number };
  weights: { name: number; profile: number; context: number };
  name: {
    exact: number; alias: number; similarityMax: number; similarityMin: number; stopTokens: string[]; tokenSynonyms: Record<string, string>;
    normalized?: number; tokens?: number; tokensExclude?: string[]; ambiguousScore?: number; ambiguous?: Record<string, string[]>;
    unitTokens?: Record<string, string>; unitKindOf?: Record<string, string>; unitMismatchPenalty?: number;
  };
  profiles: Record<string, unknown>;
  context: Record<string, unknown>;
  samples: { perCandidate: number; maxLength: number };
  metafieldOwnership?: MetafieldOwnershipConfig;
}
export type SampleDisplay =
  | { kind: 'keep'; value: string; truncated: boolean }
  | { kind: 'hash-only'; length: number; preview: string }
  | { kind: 'redact'; length: number };
export interface Candidate {
  canon: string; score: number;
  name: { score: number; via: 'exact' | 'alias' | 'normalized' | 'tokens' | 'ambiguous' | 'family' | 'similar' | 'none'; matchedName: string | null };
  profile: { score: number }; context: { score: number };
  reasons: string[]; samples: SampleDisplay[];
  confidence?: Confidence;
  decision?: { action: MappingAction; at: string; by: string; args?: Record<string, unknown> };
}
export interface ProfileSummary { primary: string; profiles: string[]; nonEmpty: number; emptyRatio: number; distinct: number; uniqueRatio: number; avgLength: number }
export interface ColumnReport {
  column: string;
  status: 'auto' | 'suggest' | 'none' | 'decided' | 'ignored';
  best: Candidate | null;
  candidates: Candidate[];
  profile: ProfileSummary;
  context: { family: string | null; referencesColumn: string | null; neighbourOf: { column: string; canon: string } | null; metafield?: MetafieldOwnership; translation?: TranslationFact };
}
export interface SemanticReport {
  entity: string | null; formatId: string | null;
  thresholds: { auto: number; grey: number };
  columns: ColumnReport[];
  conflicts: { canon: string; kept: string; demoted: string }[];
}
export function tokenize(name: string, cfg: RecognitionConfig): string[];
export function tokenSimilarity(a: string[], b: string[]): number;
/** Separator-blind form of a column name (`product_name` = `Product-Name` = `PRODUCT NAME`). */
export function normalizeColumnName(name: string): string;
/** The unit a column name states (`Poids (kg)`, `weight_kg`), by kind; null when none. */
export function columnUnit(column: string, cfg: RecognitionConfig): { unit: string; kind: string; bare: string } | null;
/** Order-free token key once synonyms, stop words and the unit are folded. */
export function tokenKey(name: string, cfg: RecognitionConfig): string;
export function profileValues(values: unknown[], cfg: RecognitionConfig): Record<string, unknown>;
export function recognizeColumns(input: {
  headers: string[]; rows?: Record<string, string>[]; entity?: string;
  catalog: CanonCatalog; config: RecognitionConfig; formatId?: string;
  decisions?: LearnedDecision[]; storeConfig?: KnowledgeStoreConfig;
}): SemanticReport;
export function toFieldMapEntries(report: SemanticReport, opts?: { source?: string; catalog?: CanonCatalog }): FieldMapEntry[];
export function makeDecision(d: { formatId: string; column: string; action: MappingAction; canon?: string | null; by?: string; transform?: string; args?: Record<string, unknown>; reason?: string; scope?: DecisionScope; confidence?: Confidence }): LearnedDecision;
/** 6.7 — { column, locale, field, base } when the column is a locale-suffixed translatable field, else null. */
export function translationColumn(column: string, cfg: RecognitionConfig): { column: string; locale: string; field: string; base: string } | null;
/** 6.7 — every translation column of a header set with its default-locale election. */
export function translationFacts(headers: string[], cfg: RecognitionConfig): Map<string, TranslationFact>;
/** 6.5 — { platform, namespace, key } when the column is a metafield column (per columnPatterns), else null. */
export function metafieldColumn(column: string, cfg: RecognitionConfig): { platform: string; namespace: string | null; key: string | null } | null;
/** 6.5 — vendor-like key prefixes shared by >= minKeys metafield columns of one header set. */
export function prefixClusters(headers: string[], cfg: RecognitionConfig): Set<string>;
/** 6.5 — ownership tier of a metafield column (pure). null when the column is not a metafield column. */
export function classifyMetafieldOwnership(column: string, cfg: RecognitionConfig, opts?: { headers?: string[]; clusters?: Set<string> }): MetafieldOwnership | null;
