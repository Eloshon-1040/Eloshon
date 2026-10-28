# Phase 1+ backlog — deferred items and their owning phase

Written at the end of Phase 1 (2026-10-04). Sources: the Phase 0 report
(out-of-scope observations, `docs/phase0-inventory.md` §7) plus everything
noticed while executing Phase 1. Each item carries its file references and the
phase (or parallel track) that owns it. Nothing here was changed in Phase 1.
Updated at the end of Phase 2: §B done, §G added.

## A. Credit backend reconciliation — separate parallel track (NOT a wizard phase)

Phase 1 fixed the app-side TIMING (previews free, one `converter_check` per
export run, one `converter_consume` after the file is written —
`app/convert-service.mjs`, `app/main.mjs` `conv:save`). The backend itself was
deliberately not touched:

- `wip/credit-system`: the edge function (`firecrawl-unlock`, actions
  `converter_check` / `converter_consume` / `account_status`) and its schema
  live on the Supabase side; the app branches on `check.allowed` while parts of
  the backend speak `ok` — the **allowed-vs-ok mismatch** must be reconciled
  there, not papered over in the app.
- Consume durability: `callEdge` (`app/main.mjs`) swallows network errors by
  design, so a `converter_consume` that fails AFTER a successful save is
  silently lost (user-friendly, revenue-lossy). Retry/queue semantics are a
  backend-track decision.
- The license stub (`app/main.mjs`, `LICENSE_RE`, "provisional — NO real DRM")
  and the `free_locked` unlock button both route to the key dialog; the real
  activation/purchase mechanism is the same deliberately-unbuilt decision.

## B. Phase 2 — Scraper handoff & preservation — ✅ DONE (2026-10-04)

- ~~products.json ingestion + `.eloshon` reader~~ → `scraper.products-json.v1`
  (read directly, decision A) and `core/src/eloshon.ts` (reader only).
- ~~Legacy-CSV unmapped-column preservation~~ → all 14 legacy formats carry
  their column map as knowledge data; 4 bespoke parsers retired, 10 kept with
  reasons — `docs/phase2-legacy-formats.md`.
- ~~Sites×platforms test bench~~ → `test/bench.test.mjs` +
  `docs/phase2-conversion-matrix.md` (148 cells, regression-guarded).
- Follow-ups are in §G.

## C. Phase 3 — AI mapping agent

- The step-3 semantic recogniser (`core/src/mapping.ts`, `semanticAnalyze`) is
  deliberately suggestion-only. The AI agent that proposes/validates whole
  mappings is Phase 3; no LLM calls exist anywhere in the Converter today.

## D. Later i18n phase — NL / ES

- `app/renderer/i18n.js` ships FR + EN only. Every string added in Phase 1
  (`dlg_date_*`, `st_converting`, `st_checking`, `engine_failed`, the
  parameterised `free_*` family) exists in both dictionaries, so the NL/ES
  phase is a pure translation pass.

## E. Tooling / infrastructure debt (from Phase 0 §7, still true)

- **verify-core fresh-clone trap**: `scripts/verify-core.mjs:6` and
  `scripts/verify-controller.mjs` import `core/dist` without chaining
  `build:engine` — they fail on a fresh clone until `npm run build:engine`
  (`npm test` / `npm run dist` both chain it).
- **tsc coverage gap**: `tsconfig.json:16` includes `core/src/**/*.ts` only;
  `app/*.mjs`, `scripts/`, and the knowledge runtime
  (`core/knowledge-proposal/*.mjs`) are never typechecked. The Phase 1 app
  modules (`convert-service.mjs`, `convert-host.mjs`, `convert-worker.mjs`)
  inherit that gap; their behavior is locked by tests instead.
- **Catalog coupling by machine layout**: `tsconfig.json:7` maps
  `@eloshon/catalog` to `../../eloshon-catalog/index.d.ts` — two levels above
  the repo, no commit pin. A clone without `C:\eloshon-catalog` fails
  typecheck (runtime unaffected: since Phase 2 the `.eloshon` runtime is
  VENDORED in `core/vendor/eloshon-catalog`, drift-tested against the catalog).
- **Scraper `mac.icon` points at `.ico`** (scraper `package.json`) — same
  latent mac issue as the converter's; the scraper installer stays untouched
  per the standing constraint.

## F. Newly noticed during Phase 1 (recorded, not done)

- **[PROPOSITION] Step-4 gate depth**: `analyzeProblems`
  (`core/src/problems.ts:~303`) opens the gate for any recognised file without
  consulting `capabilityFor`, so an impossible combination (e.g. an orders
  JSON heading into Wix) only fails at export time in `convert()`. Parity with
  the historic CSV behavior, but the gate could refuse one step earlier.
- **[PROPOSITION] Row-level progress / streaming**: the worker reports coarse
  phases only (`convert` / `issues`) because the engine is a single pure
  synchronous call. Determinate progress bars and chunked parsing for very
  large catalogues need an optional engine hook (e.g. an `onProgress` callback
  threaded through `convert()`) — an engine API change, deliberately not done
  as plumbing.
- **[PROPOSITION] Knowledge reload per job**: `app/convert-worker.mjs:~57`
  re-reads every knowledge JSON per job (parity with the old `conv:run`).
  Bounded today (~30 files); add an mtime-based cache if the Learned strata
  ever grows to hundreds of taught formats.
- **[PROPOSITION] fileId→credit-count coverage**: `withFileText`
  (`app/main.mjs`) resolves a fileId back to text so the licensed credit
  pre-count sees the file; that glue is only exercised by the Electron
  selftest, not `node --test`. Extract it into a testable module or add a
  main-glue test.

## G. Newly noticed / deferred during Phase 2

- **[DÉCISION UTILISATEUR] Retire the 10 remaining bespoke parsers** (reasons
  in `docs/phase2-legacy-formats.md`). Options: (a) teach the generic parser a
  grouped-rows input — the grouping already exists as data
  (`structure.rows`, interpreted by `core/knowledge-proposal/legacy-units.mjs`) —
  then migrate Shopify orders / BigCommerce orders first (no cross-row
  inference); (b) add data-declared questions and row-numbered warnings
  (unblocks WooCommerce orders and BigCommerce products); (c) a companion
  tree-walk transform (unblocks the BigBuy pair); (d) keep them — preservation
  and provenance are already uniform. Recommended default: (d) until a real
  file needs it, then (a).
- **[OBSERVATION] PrestaShop orders dropped as one JSON file fail**
  (`order_no_line_items`, bench cells shopify/woocommerce): the line items live
  in the `order_details` companion, which a single-file drop cannot carry. The
  error should name the missing companion (Phase 3 UX, or a multi-file drop).
- **[DÉCISION UTILISATEUR] Export preserved columns as target metafields?**
  Unknown source columns are kept in the canon and listed in step 4, never
  written to the CSV. Shopify (`… (product.metafields.custom.x)`) and
  WooCommerce (`Meta: x`) could carry them. Default kept: no (exports stay
  byte-identical, no store pollution).
- **[DÉCISION UTILISATEUR] .eloshon with several entities**: one run converts
  products, otherwise customers, otherwise orders (warning names the others).
  A per-run entity picker is the alternative.
- **[DÉCISION UTILISATEUR] products.json `__eligibility`**: to_verify /
  excluded products are imported as DRAFT, unpublished (kept, never live).
  Alternatives: skip them (data loss) or import them live.
- **[PROPOSITION] Edit replay cost**: `core/src/eloshon.ts replayEdits` applies
  commands one by one through `CommandLog.apply`, which rebuilds the model each
  time (O(edits × products)). Fine for real edit logs today; a validating
  replay without per-command rebuild belongs in `@eloshon/catalog`.
- **[PROPOSITION] One slug implementation**: products.ts, bigbuy.ts,
  wix.ts, eloshon.ts, generic-parser.mjs and the `value_or_slug` / `slug_hash`
  transforms each slugify with slightly different caps/fallbacks — fold into
  `values.mjs` like the other cell fixers.
- **Official-template verification pass** (separate task): the bench lists,
  per target, every output column the serialisers emit
  (`docs/phase2-conversion-matrix.md`, last section) — each "to verify against
  the current official template"; nothing was fetched in Phase 2.
- **[OBSERVATION] `catalog` EditKind `restore` is declared but not implemented**
  by `CommandLog` (`@eloshon/catalog`): the reader reports such commands as
  skipped. Owned by the catalog package.
