# Phase 2 — Lot 3 : the 14 legacy CSV formats as knowledge data

Status at the end of Phase 2 (2026-10-04). Owner decision: migrate the 14
legacy formats to knowledge entries — uniform preservation + provenance —
format by format, each gated by byte-identical goldens; retire a bespoke
parser only once its entry reaches canon-level parity.

## How a legacy format works now

Every legacy entry in `core/knowledge-ref/formats/` carries, as DATA:

- `fields[]` — every column its parser reads: the exact `path`, multi-column
  `inputs`, or a column FAMILY via `pathPattern` (metafield columns,
  `Attribute N …`, `IMAGE1..8`, `attribute:<name>`…), with the canon path it
  feeds and the transform describing how;
- `structure.rows` — how CSV rows form units and children: `groupBy`
  (Shopify Handle / order Name, Wix handleId, BigCommerce Order ID),
  `sequence` (BigCommerce `Item` = Product…), `link` (WooCommerce variations →
  parent `id:<ID>` or SKU), `include` (WordPress users with the customer role),
  `head`, `children`.

Two ways the entry is used:

1. **Executable** (`structure.parser: "generic"`) — the generic knowledge
   parser reads the file; the bespoke parser is RETIRED. It preserves every
   column it does not read (`sourceExtension.<platform>._raw` + `unmapped[]`)
   and records provenance itself.
2. **Descriptive** — the bespoke parser still produces the canon values; the
   generic pass `core/knowledge-proposal/legacy-units.mjs` then annotates its
   units from the entry: every undeclared column with a value is preserved +
   listed (`unknown`), every declared column with a value records provenance
   (`exact`, or `override` when re-pointed in step 3). Alignment between the
   data grouping and the parser is checked, never assumed.

Either way the serialisers ignore the preservation channels, so exports are
byte-identical; the conversion result's `preserved` summary feeds the step-4
panel "Data with no match in <target>".

## The 14 formats

| # | Format (legacy id → entry) | Entry migrated | Goldens byte-identical | Preservation test | Bespoke parser |
|---|---|---|---|---|---|
| 1 | `shopify_customers` → `shopify.customers.csv.v1` | ✅ executable | yes | pass | **retired** (generic parser) |
| 2 | `bigcommerce_customers` → `bigcommerce.customers.csv.v1` | ✅ executable | yes | pass | **retired** (generic parser) |
| 3 | `woo_customers` → `woocommerce.customers.csv.v1` | ✅ executable | yes | pass | **retired** (generic parser) |
| 4 | `woo_products_legacy` → `woocommerce.products.csv.legacy.v1` | ✅ executable | yes | pass | **retired** (generic parser) |
| 5 | `shopify_products` → `shopify.products.csv.v1` | ✅ descriptive | yes | pass | kept ⚠️ |
| 6 | `woo_products_modern` → `woocommerce.products.csv.modern.v1` | ✅ descriptive | yes | pass | kept ⚠️ |
| 7 | `wix_products` → `wix.products.csv.v1` | ✅ descriptive | yes | pass | kept ⚠️ |
| 8 | `bigcommerce_products` → `bigcommerce.products.csv.v1` | ✅ descriptive | yes | pass | kept ⚠️ |
| 9 | `shopify_orders` → `shopify.orders.csv.v1` | ✅ descriptive | yes | pass | kept ⚠️ |
| 10 | `woo_orders` → `woocommerce.orders.csv.v1` | ✅ descriptive | yes | pass | kept ⚠️ |
| 11 | `bigcommerce_orders` → `bigcommerce.orders.csv.v1` | ✅ descriptive | yes | pass | kept ⚠️ |
| 12 | `bigbuy_standard` → `bigbuy.standard.v1` | ✅ descriptive | yes | pass | kept ⚠️ |
| 13 | `bigbuy_presta` → `bigbuy.presta-import.v1` | ✅ descriptive | yes | pass | kept ⚠️ |
| 14 | `presta_categories` → `bigbuy.presta-categories.v1` | ✅ descriptive (companion) | n/a (never converted alone) | n/a — its rows never become units | kept ⚠️ (with the BigBuy pair) |

Retirement proof, per retired format: canon deep-equality between the bespoke
and the generic parser on every fixture of the format AND on adversarial rows
(smart punctuation, line breaks, NBSP, Excel guard, blank vs whitespace cells,
consent literals in any case, US state names, empty shipping blocks, accented
slugs, empty category levels, a lone sale price…) — 0 differences; the retired
parser's own output on those rows is frozen in `test/retired-parsers.test.mjs`.
Value parity is by construction: the engine and the generic transforms share
ONE implementation of the cell fixers (`core/knowledge-proposal/values.mjs`).

## Why 10 parsers are kept (and what would retire them)

- **Multi-row units** — `shopify_products`, `woo_products_modern`,
  `wix_products`, `bigcommerce_products`, `shopify_orders`,
  `bigcommerce_orders`: one unit spans several rows. The grouping is now DATA
  (`structure.rows`) and interpreted for preservation, but the generic parser
  reads one object per unit; it would need a grouped-rows input (product fields
  from the head row, children from child rows, row-level aggregates such as one
  image per Shopify row). Several also depend on cross-row or file-level
  context: the WooCommerce rule "an attribute every variation fills is an
  option, otherwise a descriptive metafield", the file's dominant image origin
  for relative URLs, BigCommerce option values realigned by NAME across variant
  rows, Wix's product-level discount applied to each variant's list price.
- **Questions and per-row warnings** — `woo_orders` (column-wide day/month
  detection that raises the date-order question; coupon/fee notices per row;
  the exporter's "Array" bug probe), `bigcommerce_products` (the weight-unit
  question, orphan rows): the generic parser cannot raise a question or a
  row-numbered warning from data today.
- **Companion category tree** — `bigbuy_standard`, `bigbuy_presta`,
  `presta_categories`: category ids resolve through the companion file's
  parent-by-NAME tree, deepest path first, plus the optional second-language
  file merge.

None of these is a parity failure — they need generic-parser capabilities that
do not exist yet. Next step options: see `docs/phase1-backlog.md` §G.
