# BigCommerce Catalog API v3 live fixtures

Captured 2026-09-21 from the trial store `example-store.mybigcommerce.com`
(EUR, kg, cm) with `scratch/tools/bigcommerce-extract.mjs` (store-level
read-only API account, X-Auth-Token). Verbatim v3 JSON:

| file | rows | what |
|---|---|---|
| products.json | 13 | `include=variants,images,custom_fields,bulk_pricing_rules,primary_image,videos,options,modifiers` — sample catalogue (68 variants; product 77 has 45 variants × 2 options with swatch colours). `bulk_pricing_rules`, `custom_fields`, `modifiers` are present but empty on every product. Variants show BigCommerce's null-inheritance (`price: null`, `calculated_price: 49`). |
| brands.json, categories.json, category-trees.json | 3 / 6 / 1 | |
| currencies.json, tax-classes.json | 1 / 4 | v2 |
| pricelists.json, product-metafields.json, variant-metafields.json | 0 | endpoints answer 200, no data on the trial store (read-only token: nothing could be seeded) |
| store.json | | `/v2/store` with owner e-mail / phone / address redacted |

`/v2/customer_groups` answers 204 (no groups). Sample data only, no PII.

## Phase 7.5 — orders / customers (captured 2026-09-21, `scratch/tools/orders-extract.mjs`)

Verbatim API JSON with two guards applied AT CAPTURE: the 7.7 card-data scanner
(card fields, gateway tokens, IBANs, credentials removed — `orders.json` /
`customers.json` never held them) and deterministic pseudonymisation
(`customerN@example.test`, `Test Customer N`, `1 Test Street`, `Testville`,
`1000`, `+32 000 00 00 00`, `0.0.0.0`, notes blanked). Amounts, statuses,
dates, numbers, ids and every key are as returned. See docs/phase7/7.5-orders-extraction.md.

### P-1 refresh — refunds
`orders.json`: `_refunds` = `GET /v3/orders/{id}/payment_actions/refunds`
(`[]` on both orders — accessible with the read-only token). Re-captured with
the scanner (2 removals: cvv, card container, as before).
