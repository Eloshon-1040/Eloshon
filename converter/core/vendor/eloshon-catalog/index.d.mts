// Types of the vendored runtime come from the single source of truth, the
// @eloshon/catalog declarations (tsconfig paths) — never redeclared here.
export { ELOSHON_KIND, ELOSHON_VERSION, newEloshon, stringifyEloshon, readEloshon, CommandLog } from '@eloshon/catalog';
export type { EloshonFile, EloshonHeader, EloshonSource, EloshonCatalog, EloshonEdits, EditCommand, CatalogProduct } from '@eloshon/catalog';
