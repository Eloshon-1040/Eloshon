// Phase 5.2 — KnowledgeStore contract.
// Backend-agnostic. First implementation = JSON files. Engine consumers
// (FormatRecognizer, mapping resolver, generic parser) code against THIS
// interface, never against the filesystem.

import type {
  FormatId,
  FormatKnowledge,
  FieldMapEntry,
  OverlayedFormatKnowledge,
  LearnedDecision,
  Sample,
  SamplePolicy,
  SampleShape,
  SignatureMatch,
  KnowledgeStoreConfig,
  StrataOrigin,
} from './schema';

/** Descriptor emitted by list/summary queries — no field data. */
export interface FormatDescriptor {
  id: FormatId;
  displayName: string;
  provenance: FormatKnowledge['provenance'];
  medium: FormatKnowledge['medium'];
  version?: string;
  origin: StrataOrigin;
}

/** How to write a sample. The store enforces samplePolicy at write time. */
export interface SampleInput {
  formatId: FormatId;
  fieldPath: string;
  /** Raw source value. The store converts it to the right payload shape
   *  according to samplePolicy — never store `raw` verbatim yourself. */
  raw: unknown;
  /** Optional path-scoped override; defaults to store config. */
  policy?: SamplePolicy;
}

/** Contract every backend implementation must honour.
 *
 *  Design rules:
 *  1. Reference is READ-ONLY.
 *  2. Learned is READ-WRITE and lives outside the app bundle.
 *  3. Every method that returns FormatKnowledge or a FieldMapEntry MUST
 *     make StrataOrigin discoverable (via overlayView or origin() ).
 *  4. Nothing in this interface knows about JSON files, SQLite, or
 *     Supabase. Backends can differ; the engine is portable.
 */
export interface KnowledgeStore {
  /** List every known format (Reference ∪ Learned). Cheap. */
  listFormats(): Promise<FormatDescriptor[]>;

  /** Fetch a raw Reference or Learned entry. Returns null when absent. */
  getFormat(id: FormatId, strata?: StrataOrigin): Promise<FormatKnowledge | null>;

  /** Match an input shape against every known signature.
   *  Results are sorted best-to-worst; a `none` verdict is only returned
   *  when NO format at all matched.
   */
  matchSignature(input: SampleShape): Promise<SignatureMatch[]>;

  /** Overlay view: Reference ⊕ Learned. Every field carries its origin.
   *  Rejected candidates (from learned decisions) are excluded from the
   *  proposals surface — but a raw getFormat() still shows the underlying
   *  Reference untouched. */
  overlayView(id: FormatId): Promise<OverlayedFormatKnowledge | null>;

  // ── Learned writes ────────────────────────────────────────────────────

  /** Create or replace a Learned FormatKnowledge entry (a taught format, or
   *  an overlay for a Reference id). Must be schema-valid; never touches
   *  Reference. Returns the stored entry. */
  putLearnedFormat(format: FormatKnowledge): Promise<FormatKnowledge>;

  /** Remove a Learned entry (Reference stays). Returns true when it existed. */
  removeLearnedFormat(id: FormatId): Promise<boolean>;

  /** Step-3 column edits of a Reference format (stored apart from Reference;
   *  getFormat() returns Reference with the edited columns' entries replaced). */
  getColumnEdits(id: FormatId): Promise<{ schemaVersion: 1; id: FormatId; at: string; columns: Record<string, { at: string; entries: FieldMapEntry[] }> } | null>;
  /** Replace one column's Reference entries with `entries` (each `path` = column). */
  putColumnEdit(id: FormatId, column: string, entries: FieldMapEntry[]): Promise<unknown>;
  /** Back to the Reference mapping for one column, or for all when column is omitted. */
  removeColumnEdit(id: FormatId, column?: string): Promise<boolean>;

  /** Append a decision to the learned log. Idempotent by (at, formatId,
   *  fieldPath, action, canonCandidate). */
  recordDecision(decision: LearnedDecision): Promise<void>;

  /** All decisions for a format, oldest first. */
  listDecisions(formatId: FormatId): Promise<LearnedDecision[]>;

  // ── Samples ───────────────────────────────────────────────────────────

  addSample(input: SampleInput): Promise<void>;
  listSamples(formatId: FormatId, fieldPath: string): Promise<Sample[]>;
  /** Delete samples. Scope selectors:
   *  - `field`  : one (formatId, fieldPath)
   *  - `format` : every sample for that formatId
   *  - `all`    : every sample in Learned
   */
  purgeSamples(
    scope: { kind: 'field'; formatId: FormatId; fieldPath: string }
         | { kind: 'format'; formatId: FormatId }
         | { kind: 'all' }
  ): Promise<number>;

  // ── Introspection ─────────────────────────────────────────────────────

  /** Which strata does this entry live in? For UI/trace only. */
  origin(id: FormatId): Promise<StrataOrigin | null>;

  /** Current store configuration (samples etc.). */
  getConfig(): Promise<KnowledgeStoreConfig>;
  /** Update store configuration (Learned side only). */
  setConfig(patch: Partial<KnowledgeStoreConfig>): Promise<KnowledgeStoreConfig>;
}
