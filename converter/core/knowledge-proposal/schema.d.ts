// Phase 5.2 — KnowledgeBase schema (types canoniques).
// Documentation TS. Aucune runtime consumer dans ce fichier.
//
// Trois strates séparées ; overlay Reference ⊕ Learned au runtime.
// Learned lives OUTSIDE the repo (userData). Shareable is a future
// promotion path — the schema stays neutral so no migration is needed.

// ── Identifiants ────────────────────────────────────────────────────────────

/**
 * FormatId = `<provenance>.<slug>[.<signatureHash>][.<majorRev>]`
 * Ex. `woocommerce.products.rest.v1`
 *     `shopify.products.csv.v1`
 *     `scraper.colruyt.a1f3c7.v1`
 *     `scraper.unknown.9d2b41.v1`
 * Rules:
 *   – lowercase, dot-separated, [a-z0-9._-]
 *   – domain slug is a human hint, never a metier rule
 *   – signatureHash is optional for well-known natives, mandatory for
 *     scraper-generated formats (multiple formats per site).
 */
export type FormatId = string;

/** Where the knowledge lives at runtime. Never lie: origin is data. */
export type StrataOrigin = 'reference' | 'learned' | 'shareable';

/** Provenance of a format entry — orthogonal to StrataOrigin. */
export type FormatProvenance =
  | 'native-platform'   // Shopify, WC, Wix, BC, PS, Shopware…
  | 'supplier'          // BigBuy and other feed suppliers
  | 'scraper-generated' // Eloshon Scraper produced this CSV
  | 'unknown';          // ingested but not yet classified

/** Physical medium of a format — CSV vs JSON/API vs XML… */
export type FormatMedium = 'csv' | 'json-api' | 'json' | 'xml' | 'tsv' | 'other';

/** How confident we are in a given field mapping. Ordered low → high. */
export type Confidence =
  | 'seed'              // shipped with the app; not user-validated
  | 'inferred'          // heuristic guess
  | 'verified-fixture'  // matched against a checked-in fixture
  | 'verified-live'     // matched against a live payload we observed
  | 'user-confirmed'    // the user said yes
  | 'user-corrected';   // the user changed a previous decision

/** Reason a source field is kept outside the canon.
 *  Aligned with CanonPreservationReason in @eloshon/catalog. */
export type PreservationReason =
  | 'no-canon-field'
  | 'platform-specific'
  | 'unknown'
  | 'ambiguous';

/** Verdict on a candidate mapping — richer than a simple boolean.
 *  A `rejected` verdict for (formatId, fieldPath, canonCandidate)
 *  excludes that candidate from future proposals for this format. */
export type MappingAction =
  | 'proposed'          // the engine offered this
  | 'confirmed'         // user validated
  | 'corrected'         // user changed the target
  | 'rejected'          // user said “not this one”
  | 'ambiguous'         // deferred
  | 'ignored';          // column intentionally dropped

/** Sample retention policy per field. */
export type SamplePolicy = 'keep' | 'hash-only' | 'redact' | 'none';

// ── Format signatures ───────────────────────────────────────────────────────

/**
 * A signature is what the FormatRecognizer matches against. It is DATA,
 * not code. Kinds are open — a JSON backend can add new ones without
 * changing the interface.
 */
export type FormatSignature =
  | {
      kind: 'csv-header-set';
      /** Required column names, case- and whitespace-insensitive. */
      required: string[];
      /** At least ONE of these must be present (gating, like `required`).
       *  Distinct from `hints`, which only raise coverage. */
      anyOf?: string[];
      /** Optional columns that raise confidence when present. */
      hints?: string[];
      /** Column separator (default: auto-detected). */
      separator?: ',' | ';' | '\t' | '|';
      /** Threshold under which a match is `partial` rather than `exact`. */
      minCoverage?: number; // 0..1, default 1.0 for exact
      /** Only these columns: an added column makes the file a partial match (semantic recognition takes over). */
      closed?: boolean;
    }
  | {
      kind: 'json-shape';
      /** Dotted paths that must exist on any element. */
      requiredPaths: string[];
      /** Paths whose presence raises confidence. */
      hintPaths?: string[];
    }
  | {
      kind: 'xml-root';
      /** Root element local name (namespace-agnostic). */
      root: string;
      /** Required descendant element local names. */
      requiredElements?: string[];
    }
  | {
      kind: 'structural-hash';
      /** Opaque hash computed by the recognizer from column set + patterns. */
      hash: string;
      /** Optional human-readable columns list for debug/UI. */
      columnsPreview?: string[];
      /** The full normalised column set the format was taught on (similarity matching). */
      columns?: string[];
    };

// ── Fields ──────────────────────────────────────────────────────────────────

/**
 * A single mapping entry: how a source field maps to a canonical path,
 * through a NAMED transform (never inline code).
 */
export interface FieldMapEntry {
  /** Stable path in the source: column name, dotted JSON path, XPath. */
  path: string;
  /** Canonical destination:
   *  – a canon path (`title`, `variants[].price`) if the concept exists,
   *  – `sourceExtension.<platform>.<key>` for platform-specific keep,
   *  – `unmapped` when the field is deliberately preserved with a reason,
   *  – null for `ignored` (never emitted). */
  canon: string | null;
  /** Transform id from the shared registry (Phase 5 transform catalog). */
  transform: string;
  /** Multi-input transforms: source paths read in order. `path` stays the
   *  display / consumption key. */
  inputs?: string[];
  /** Transform parameters (enum maps, key names, units…) — knowledge, not code. */
  args?: Record<string, unknown>;
  /** Object the path is relative to. Default: 'variant' when canon starts
   *  with `variants[].`, 'product' otherwise. */
  scope?: 'product' | 'variant' | 'item';   // item = an order line (Phase 7, structure.items)
  /** Extra top-level source keys this entry accounts for. */
  consumes?: string[];
  /** A family of source columns (RegExp source); `path` is then a label. */
  pathPattern?: string;
  /** Variant-scope entries: 'child' = real variation object only, 'self' =
   *  product standing as its own variant only, 'always' (default). */
  when?: 'child' | 'self' | 'always';
  /** How this entry was established. */
  confidence: Confidence;
  /** Optional preservation reason (only when canon starts with 'unmapped'). */
  preservationReason?: PreservationReason;
  /** Where the knowledge came from (free text; e.g. `seed:WOO_MODERN_P`
   *  or `live:woocommerce-test:2026-09-21`). */
  source?: string;
  /** Free-text human note. One line, no code. */
  notes?: string;
  /** Per-field sample retention override. Defaults from the store config. */
  samplePolicy?: SamplePolicy;
}

// ── Format knowledge (persisted unit) ───────────────────────────────────────

export interface FormatKnowledge {
  /** Schema envelope version, integer, ascending. */
  schemaVersion: 1;
  /** Stable format identifier. */
  id: FormatId;
  displayName: string;
  provenance: FormatProvenance;
  medium: FormatMedium;
  /** Free label — a human hint (e.g. `shopify`, `colruyt.be`). Never a rule. */
  platformHint?: string;
  /** Format-family version tag when it makes sense (e.g. `ps-9.x`). */
  version?: string;
  /** Companion format for the same platform in another medium
   *  (e.g. CSV ↔ API). Used by the mapper to propagate learnings across media
   *  after user confirmation. */
  sibling?: FormatId;
  /** Previous version this format supersedes, if any. */
  succeeds?: FormatId;
  /** What the format describes. Knowledge about the format, not routing. */
  entity?: 'products' | 'customers' | 'orders' | 'categories' | 'mixed';
  /** TRANSITIONAL (5.3 → 5.9). Bridge to the pre-Phase-5 engine: the legacy
   *  FormatId and the platform/entity the current per-format parsers route on.
   *  Removed once the generic parser (5.5/5.9) replaces those parsers. */
  legacy?: { formatId: string; platform: string; entity: 'products' | 'customers' | 'orders' };
  /** How the engine routes a KNOWLEDGE-DRIVEN format (generic parser): the
   *  source platform the direction expects + the entity. Formats carrying a
   *  `legacy` block route to per-format parsers instead. */
  routing?: { platform: string; entity: 'products' | 'customers' | 'orders' };

  /** Detection signature — one or several. First match wins. */
  signatures: FormatSignature[];

  /** How units and their children are found in the payload (medium-specific;
   *  interpreted by the generic parser). For JSON:
   *  { variants: { companion: 'variations', keyedBy: 'id', selfWhenNone: true } } */
  structure?: Record<string, unknown>;

  /** Field-by-field mapping into the canon. */
  fields: FieldMapEntry[];

  /** Source columns/paths observed but not yet mapped. Fed by the
   *  recognizer for later resolution. */
  unknownFields?: { path: string; observedAt?: string; samplesRef?: string }[];

  /** Invariants the parser should assert about the shape (documentation,
   *  not enforced by the store itself). */
  invariantsExpected?: string[];

  /** Append-only history. `origin: reference` entries are shipped;
   *  `origin: learned` entries are written at runtime. */
  history: {
    at: string;         // ISO
    op: 'seed' | 'enrich' | 'correct' | 'rename' | 'deprecate';
    from: string;       // free text: 'seed:mapping.ts:WOO_MODERN_P',
                        // 'live:...', 'user:<id>'
    origin: StrataOrigin;
    diff?: string[];    // optional bullet points
  }[];
}

// ── Learned decisions (append-only log) ─────────────────────────────────────

/** Scope of a decision. `format:` is the safe default. */
export type DecisionScope =
  | { kind: 'format'; id: FormatId }
  | { kind: 'family'; pattern: string }   // e.g. `scraper.colruyt.*`
  | { kind: 'global' };

export interface LearnedDecision {
  at: string;            // ISO
  by: string;            // 'user:<id>' or 'engine'
  formatId: FormatId;    // primary format context
  fieldPath: string;     // source field the decision applies to
  action: MappingAction;
  /** Candidate the decision talks about. */
  canonCandidate?: string | null;
  /** Transform the user picked, if any. */
  transform?: string;
  /** Arguments of that choice — e.g. { key } of a custom field the user named. */
  args?: Record<string, unknown>;
  confidence: Confidence;
  reason?: string;
  scope?: DecisionScope; // default { kind: 'format', id: formatId }
}

// ── Samples ─────────────────────────────────────────────────────────────────

export interface Sample {
  at: string;
  formatId: FormatId;
  fieldPath: string;
  /** Payload — the exact shape depends on samplePolicy:
   *  - `keep`      : { value: string }        (truncated to configured max)
   *  - `hash-only` : { hash: string, length: number, type: string }
   *  - `redact`    : { redacted: true, length: number, type: string }
   *  - `none`      : this record should never be written.
   */
  payload:
    | { kind: 'keep'; value: string; truncated?: boolean }
    | { kind: 'hash-only'; hash: string; length: number; valueType: string }
    | { kind: 'redact'; length: number; valueType: string };
}

// ── Store-wide config ───────────────────────────────────────────────────────

export interface KnowledgeStoreConfig {
  samples: {
    enabled: boolean;               // hard master switch
    maxPerField: number;            // default 5
    maxLength: number;              // default 200
    maxLengthLong: number;          // default 500 (for html/description-like)
    defaultPolicy: SamplePolicy;    // default 'keep'
    redactByPathHint: string[];     // paths matching → 'redact' by default
    hashOnlyByPathHint: string[];   // paths matching → 'hash-only'
  };
}

// ── Overlay view ────────────────────────────────────────────────────────────

/**
 * The engine sees FormatKnowledge, not the two strata separately.
 * Overlay merges Reference ⊕ Learned, resolving conflicts field-by-field
 * with Learned winning. Each merged field carries its origin for tracing.
 */
export interface OverlayedFieldMapEntry extends FieldMapEntry {
  /** Where this final value came from. Never null. */
  origin: StrataOrigin;
  /** Was there a Reference entry underneath? Useful for the UI. */
  overriddenReference?: FieldMapEntry;
}

export interface OverlayedFormatKnowledge
  extends Omit<FormatKnowledge, 'fields'> {
  fields: OverlayedFieldMapEntry[];
}

// ── Signature match verdicts ────────────────────────────────────────────────

export type SignatureMatchKind =
  | 'exact'
  | 'superset'   // input has all Reference columns AND extras
  | 'similar'    // a TAUGHT format whose column set is nearly the input's
  | 'subset'     // input has fewer columns than Reference
  | 'partial'   // some overlap under threshold
  | 'none';

export interface SignatureMatch {
  formatId: FormatId;
  kind: SignatureMatchKind;
  coverage: number;     // 0..1
  missing: string[];    // fields the input lacks
  extra: string[];      // fields the input has beyond signature
  /** Signature columns/paths actually found in the input (required + anyOf + hints). */
  matched: string[];
  /** Specificity: how many signature columns matched. Ranks detected formats
   *  (a 4-column signature beats a 2-column one). Data-driven — no list order. */
  score: number;
}

// ── Input shape used by matchSignature ──────────────────────────────────────

export type SampleShape =
  | { kind: 'csv-header-set'; columns: string[]; separator?: string }
  | { kind: 'json-shape'; paths: string[] }
  | { kind: 'xml-root'; root: string; elements: string[] };
