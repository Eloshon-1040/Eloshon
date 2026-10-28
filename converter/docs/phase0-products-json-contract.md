# Phase 0 — Step 4 : `products.json`, the rich Scraper → Converter contract

> Status: **stable, locked by test** (`core/__tests__/products-json-contract.test.mjs`).
> This is the handoff spec Phase 2 will wire the Converter onto. The 21-column
> CSV (`core/csv.mjs`) remains the HUMAN/Luna surface and is deliberately
> unchanged — including its single-image `image_url` cell.

## 1. Where the file lives and what it is

Per job: `%APPDATA%\Eloshon Scraper\data\jobs\<id>\products.json` — a JSON array
of `NormalizedProduct` (layout: `core/jobstore.mjs:4-39`). Every scraping lane
(generic crawl, recipes, platform defaults, Firecrawl/Bright Data, server
cascade, nodriver, extension ingest) funnels through ONE producer,
`toNormalizedProduct` (`core/normalize.mjs`), then the engine/controller attach
`__eligibility`. The typedef in `core/types.mjs` now matches this runtime
output exactly (it was stale before Phase 0: `color`, `variants` and the
`raw{}` shape were undeclared, `images` did not exist).

## 2. Field map — every key, first-class vs `raw{}`

### First-class (CSV-visible unless noted)

| Key | Type | Source | Notes |
|---|---|---|---|
| `store_slug` | string\|null | operator (`opts.storeSlug`) | |
| `source_url` | string\|null | `canonicalUrl \|\| sourceUrl` | |
| `source_product_id` | string\|null | gtin → sku → mpn → URL id → last path segment (`normalize.mjs:93-115`) | |
| `source_category` | string\|null | the category trail joined `" > "`: the breadcrumb (the product page's, else the listing page's, else the listing title) followed by `raw.category` when that is not already its last step | category tree, 2026-10-08 |
| `product_type` | string\|null | operator declaration, never inferred | |
| `name_fr` / `name_en` | string | cleaned name; single-language sources mirror | |
| `description_fr` / `description_en` | string\|null | `cleanText` (tags stripped) | plain text by design |
| `storage_info` | null | reserved | |
| `is_alcoholic` | boolean\|undefined | eligibility layer | serialization note: while undefined, `JSON.stringify` drops the key — on disk it is ABSENT until eligibility sets it (readers must treat missing as unknown) |
| `price` | number\|null | charged price (`coerceMoney`) | currency in `raw.currency` |
| `weight_kg` | number\|null | a stated mass (`core/weight.mjs`); for a liquid with only a volume, an ESTIMATE (volume × `weightEstimate.kgPerLitre` × (1 + `containerPct` %)) — then `raw.weight_estimated` is `true` | the Luna CSV (21 historical columns) carries a trailing `weight_estimated` column (`true` / empty) since 2026-10-20 |
| `barcode` | string\|null | GTIN of EAN/UPC length (8/12/13/14 digits). Primary path validates LENGTH only; the URL-slug fallback additionally passes the GS1 check digit (`normalize.mjs` `gtinToBarcode` vs `barcodeFromUrl`) | |
| `hs_code` | null | reserved | |
| **`images`** | **string[]** | **Phase 0 addition** — the FULL ordered list from the extractor, each entry resolved absolute against the page URL; `[]` when none. **NOT in the CSV** (JSON-only). | fixes the audited loss where `images[1..n]` were discarded (`normalize.mjs` pre-fix `:129-131`) |
| `image_url` | string\|null | first raw image absolutized — byte-identical to pre-Phase-0 behaviour; equals `images[0]` whenever the first extractor entry is a resolvable URL | the CSV's single image cell |
| `category_slug` | string\|null | operator | |
| `color` | string\|null | embedded-state extractor | 21-col generation |
| `variants` | array\|null | inline JSON; element `{code?, type?, name?, gtin?, price?, image?, availability?, stock_level?, url?}` — `availability` is a schema.org term (`InStock`, `OutOfStock`, `PreOrder`, `BackOrder`, `Discontinued`), `stock_level` is `high`\|`medium`\|`low`\|`none` when the site states it (`shared/extract/stock.mjs`, `shared/extract/embedded-state.mjs:262-283`) | 21-col generation; may be SIBLING products (converter's `siblingsWhen` rule). Since 2026-10-20 an option of a schema.org `ProductGroup` that varies without colour (a TV in several screen sizes) also carries its own `price`, absolute `url` and `sku` — these are sibling products |

### `raw{}` — rich fields with no CSV column (JSON-only, the Phase 2 payload)

| Key | Type | Meaning |
|---|---|---|
| `raw.brand` | string\|null | brand/vendor as scraped |
| `raw.currency` | string\|null | ISO-ish currency of `price` when the source said |
| `raw.list_price` | number\|null | compare-at/"was" price |
| `raw.availability` | string\|null | stock state: the schema.org term when recognised (`InStock`, `OutOfStock`, `PreOrder`, `BackOrder`, `Discontinued`; taken from the sizes when they carry one), else the statement verbatim |
| `raw.rating` | number\|null | average rating on a 0–5 scale; null when there is no review |
| `raw.review_count` | number\|null | number of reviews (0 = none; null = unknown) |
| `raw.specs` | array (optional) | technical specifications as the product page states them: `[{ "group": "Caractéristiques techniques", "name": "Résolution", "value": "Full HD" }]` (`group` null when the source has none; a unit stated apart is appended to the value). Read from JSON-LD `additionalProperty`, the page state (only the page product's groups), else label/value rows (`shared/extract/specs.mjs`). Absent when the page has none. Added 2026-10-20 (additive). |
| `raw.technical_specs` | object (optional) | the same specifications as `{ "Résolution": "Full HD", … }` (a name repeated in two groups keeps its group: `"Écran · Type"`). Present whenever `raw.specs` is (read by a rule taught for the site — 🎯 on a product page, `siteKnowledge` — or by the generic extractors). Absent otherwise. Added 2026-10-23 (additive). |
| `raw.columns` | object (optional) | the columns the user added in the extension panel, as read: `{ "ville": "Charleroi", "tailles": "28 \| 29 \| 30" }`. Absent on every other lane. |
| `raw.weight_text` | string\|null | raw contenance text |
| `raw.volume_l` / `raw.pack_count` | number\|null | non-mass contenance |
| `raw.weight_estimated` | boolean | `true` when `weight_kg` is an estimate from `raw.volume_l` (liquids), `false` otherwise. Added 2026-10-20 (additive). |
| `raw.breadcrumb` | string[] | full breadcrumb (joined form is `source_category`) |
| `raw.sku` / `raw.mpn` / `raw.gtin` | string\|null | identifiers verbatim (gtin pre-GS1-validation) |
| `raw.extractor` | string (optional on disk) | producing strategy id. Several real lanes never set it (recipe replay via `mapItem`, extension ingest, card seeds) → undefined → **the key is ABSENT in those products.json rows** (locked by test) |
| `raw.confidence` | number 0..1 (optional on disk) | same optionality as `raw.extractor` |

### `__eligibility` (added after normalize; `core/engine.mjs` / controller)

`{ status: 'accepted'|'to_verify'|'excluded', code?, reason?, matched?, is_alcoholic?, requires_cold_chain? }` — routing of the product between the two CSVs and the exclusion list.

## 3. Language

`name_en` / `description_en` mirror the FR values on single-language sources
(`normalize.mjs`, lang mirror); a real translation pipeline is a later phase.
Converter side, `scraper.eloshon-export.v1`'s `differs_from` transform already
treats the mirror correctly.

## 4. Generations

- **19-column generation** (before commit `7c206b6`, Scraper ≤ 0.3.8): no
  `color`, no `variants` in the CSV. products.json files written by THOSE
  builds lack the two keys entirely; since `7c206b6` the normalizer always
  emits them (`null` when absent). The contract test validates the
  current-normalizer shape of a color/variant-less product; readers of
  historical files must treat a missing key as `null`.
- **21-column generation** (current): adds `color`, `variants`.
- **Phase 0**: adds `images` (JSON-only; CSV untouched, still 21 columns —
  locked by the contract test asserting `COLUMNS.length === 21` and that the
  CSV cell carries exactly one URL).

Older `products.json` files on disk predate `images`; Phase 2 readers must
treat a missing `images` as `image_url ? [image_url] : []`.

## 5. The lock (what the test asserts)

`core/__tests__/products-json-contract.test.mjs`:
1. a Raw fixture with N=3 images (relative + absolute mixed) yields
   `images.length === 3`, all absolute, `image_url === images[0]`;
2. every documented first-class key and every documented `raw` key is present —
   by **exact key-set equality**, so an accidental add/remove/rename of a field
   fails the suite (the contract is closed, not best-effort);
3. both generations validate: a 21-gen fixture (color+variants) and a 19-gen
   fixture (no color/variants → null);
4. the CSV surface is untouched: still exactly the 21 historical columns, and
   the `image_url` cell of a 3-image product contains exactly the first URL;
4b. a strategy-less lane (recipe/extension shape) serializes with
   `raw.extractor` / `raw.confidence` ABSENT — the on-disk optionality above
   is asserted, not just documented;
5. the committed example `core/__tests__/fixtures/products-json-contract.example.json`
   re-validates against the same key sets in their SERIALIZED form (minus the
   undefined-dropped `is_alcoholic`) — doc and code cannot drift.

## 6. What Phase 2 builds on this (explicitly NOT done in Phase 0)

- A Converter knowledge entry / adapter ingesting `products.json`
  (→ `CanonProduct.images[]`, `vendor ← raw.brand`, `compareAtPrice ←
  raw.list_price`, `identifiers ← raw.{sku,mpn,gtin}`, availability → stock).
- The `.eloshon` envelope writer (`@eloshon/catalog` `newEloshon`).
- Any CSV change (the single-image cell stays as-is for Luna/humans).
