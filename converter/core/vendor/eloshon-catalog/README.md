# Vendored `@eloshon/catalog` runtime

Byte-identical copies of the catalog's RUNTIME files (`index.mjs`,
`src/catalog-io.mjs`, `src/edits.mjs`), taken from `C:\eloshon-catalog` at
commit `daebd47`. Types are NOT copied: `index.d.mts` re-exports them from
`@eloshon/catalog` (tsconfig `paths`), the single source of truth.

Why a copy: until Phase 2 the Converter used the catalog for TYPES only, so the
packaged app never needed `C:\eloshon-catalog`. The `.eloshon` reader (Phase 2
Lot 2) needs `readEloshon` and `CommandLog` at RUNTIME; importing them from a
path outside `converter/` would break the independent installer and any clone
without that sibling folder. The installer ships `core/vendor/**/*`.

Drift guard: `test/vendor-catalog.test.mjs` compares these files byte-for-byte
with the catalog whenever `../../eloshon-catalog` exists. When the catalog
changes, re-copy the three files and update the commit above.
