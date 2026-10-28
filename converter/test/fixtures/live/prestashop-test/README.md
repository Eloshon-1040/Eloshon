# PrestaShop 9.0.3 (classic) live fixtures

Captured 2026-09-21 from the local Docker instance (`eloshon-ps-app`,
`localhost:8090`, demo catalogue + the 5 `ELO-EDGE-*` products of the Scraper
tests) through the classic Webservice (`/api/<resource>?output_format=JSON&
display=full`, read-only account `eloshon`) with
`scratch/tools/prestashop-extract.mjs`. Verbatim Webservice JSON (every value a
string, multilingual fields as `[{ id, value }]`, associations as id lists):

| file | rows | what |
|---|---|---|
| products.json | 25 | 72 keys each; `product_type` standard / combinations (11) / virtual (3) / pack (1: id 15) |
| combinations.json | 39 | per-combination identifiers, price/weight impacts, option values, images |
| specific_prices.json | 3 | 2 demo −20 % rows (`from_quantity: 1`) + **one seeded quantity tier** (product 1, `from_quantity: 10`, −15 %) |
| stock_availables.json | 64 | product- and combination-level stock, `out_of_stock` policy |
| product_features.json / product_feature_values.json | 2 / 10 | descriptive attributes (Composition, Property) |
| product_options.json / product_option_values.json | 4 / 25 | variation axes (Size, Color, Dimension, Paper Type) |
| categories.json | 9 | hierarchy (`id_parent`, `level_depth`), multilingual names/slugs |
| manufacturers.json | 2 | |
| languages.json | 2 | en (`en-US`), fr |

Seeded because the demo catalogue carries none (same rationale as the
Shopware 6.3 fixture): identifiers on product 1 (`ean13` 2000000000039, `upc`
200000000004, `isbn` 9782000000009, `mpn` MPN-DEMO-1) and on its first
combination (`ean13` 2000000000046, `mpn` MPN-DEMO-1-S), `ean13` 2000000000053
on the pack, and the tier row above. GS1 prefix 200 = restricted circulation
(test data). No PII (demo data; the admin e-mail is not in any resource).

Known Webservice quirk (9.0.3): the image index `GET /api/images/products`
answers HTTP 500 in JSON output — products carry their image ids in
`associations.images[]`.

## Phase 7.5 — orders / customers (captured 2026-09-21, `scratch/tools/orders-extract.mjs`)

Verbatim API JSON with two guards applied AT CAPTURE: the 7.7 card-data scanner
(card fields, gateway tokens, IBANs, credentials removed — `orders.json` /
`customers.json` never held them) and deterministic pseudonymisation
(`customerN@example.test`, `Test Customer N`, `1 Test Street`, `Testville`,
`1000`, `+32 000 00 00 00`, `0.0.0.0`, notes blanked). Amounts, statuses,
dates, numbers, ids and every key are as returned. See docs/phase7/7.5-orders-extraction.md.

### 7.4 refresh (same day) — invoice numbering observed in motion
Orders 2 and 4 were moved to "Payment accepted" in the back office (state
`invoice = 1`): `orders.json` now carries `invoice_number` 1 (order 2) and
2 (order 4) assigned in state-change order, `invoice_date`, `valid 1`,
`total_paid_real`; `order-invoices.json` (2), `order-payments.json` (2,
keyed by `order_reference`, `card_*` fields stripped at capture),
`order-histories.json` (9). Added companions for the joins the
`prestashop.orders.webservice.v1` / `prestashop.customers.webservice.v1`
entries declare: `countries.json` (241), `states.json` (352),
`currencies.json` (2); `languages.json` (2) is shared with the product set.

### P-1 refresh — credit slips
`order-slips.json` (0 — resource `order_slip`, GET permission granted): the
`refunds` companion of `prestashop.orders.webservice.v1`; no credit slip was
issued on the local instance, so the entry is declared from the resource
schema and unverified on real rows.
