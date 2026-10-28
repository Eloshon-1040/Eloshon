# Shopify Admin GraphQL live fixture

Captured 2026-09-21 from the development store `example-store.myshopify.com`
(plan Development, FR primary locale, EN published locale) through the
connected Shopify MCP (`graphql_query`, Admin GraphQL API, read-only; query
`ProductsFull`, validated with `validate_graphql_codeblocks`). The Dev
Dashboard app in `.env.local` is not installed on the store (client-credentials
grant → `app_not_installed`), so the MCP was the extraction path.

`products.json` = 3 products in the RESPONSE shape (connections as
`{ nodes: [...] }`, GIDs, Money as decimal strings, UPPER_CASE enums):

| handle | why |
|---|---|
| `ac-infinity-ciseaux-secateur-droit` | simple (Title = Default Title), on promo (15.50 / was 19.00), barcode, 6 media, automatic collection with `ruleSet`, `global.*` SEO metafields + app-injected `mm-google-shopping.*` (typed `string` / `boolean`) |
| `qnubu-sac-a-presse-de-11x11cm-10pcs` | 14 variants, 2 options (2 × 7), one image shared by every variant, only the SEO metafields |
| `pack-advanced-nutrients` | 9 variants (3 × 3), weights in `KILOGRAMS` (vs `GRAMS` above — unit per variant), ONE variant untracked and available for sale, tag-rule collection |

`translations(locale: "en")` is `[]` on every product of the store (checked
through `translatableResources`): the EN locale is published but nothing is
translated. `bundleComponents` / `productVariantComponents` are empty (the
store has no bundles — `has_variant_with_components:true` returns none).
`harmonizedSystemCode` / `countryCodeOfOrigin` / `unitCost` are null.

No PII (catalogue data only). Query cost: 2 products per call max at this
depth (1000-point limit) — the three were fetched one by one.

## P-3 data acquisition (2026-09-21, connected Shopify MCP — the .env.local app is not installed)
Real data on the dev store `example-store.myshopify.com`, captured through the
MCP `graphql_query` and run through the same guards as every platform
(`scratch/tools/shopify-orders-capture.mjs` → `orders-extract.mjs --from-json
shopify`: 7.7 scanner + deterministic pseudonymiser, audited: no real name /
address / phone / e-mail remains):
- `orders.json` (1) — order #1001, created in the back office (draft order),
  paid by two manual transactions (213.4 + 13.0), fulfilled, `taxesIncluded`,
  18 line items (one product with 14 option variants), BE VAT 21 % / 6 % tax
  lines, BPOST shipping line; `paymentDetails: null` (manual gateway).
- `customers.json` (2) — customer 1 (the store's real account: NOT_SUBSCRIBED,
  no consent timestamp, 1 order) and customer 2 = the P-3 test customer
  created through `customerCreate` with an explicit e-mail marketing consent
  **and its own timestamp** (`SUBSCRIBED`, `SINGLE_OPT_IN`,
  `consentUpdatedAt: 2026-09-21T20:00:00Z`).
- `products-p3.json` (1) — the same product as in `products.json` (Bionova
  Coco Brick) after the P-3 dataset mutations: `translationsRegister` (en:
  title, handle, meta_title), `metafieldsSet` (`eloshon.p3_material`,
  `eloshon.p3_volume_l`), `inventorySetQuantities` (12 available); no PII.
Store facts: locales fr (primary) + en, currency EUR, 24+ products with
images / SEO metafields / collections already present.
