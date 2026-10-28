# Wix Stores (Catalog V3) live fixtures

Captured 2026-09-21 from the Wix Studio site `My Site`
(`example-store.wixstudio.com/my-site`, Catalog V3) with
`scratch/tools/wix-extract.mjs` (account API key from `.env.local`,
`wix-site-id` header). Verbatim REST JSON:

| file | rows | what |
|---|---|---|
| products-v3.json | 13 | `GET /stores/v3/products/{id}` with every `fields` value of the search enum (22) — the unit: 35 keys incl. `variantsInfo` (choices + names, price, revenueDetails, physicalProperties, inventoryStatus, sku, barcode). "Pull de golf en tricot" 16 variants × 2 options; "Boloss 400" sku + barcode + cost + compare-at + weight + price per unit + package dimensions + preorder. |
| products-v3-search.json | 13 | `POST /stores/v3/products/search` (same fields) — `variantSummary` only |
| categories-v1.json | 1 | Categories API, `treeReference.appNamespace: "@wix/stores"` |
| inventory-v3.json | 34 | `stores/v3/inventory-items` per variant × location |
| customizations-v3.json, ribbons-v3.json, brands-v3.json, info-sections-v3.json | 3 / 6 / 1 / 3 | shared entities the products reference |
| _site.json | | id / name / url / published only |

V1 endpoints (`stores/v1/products`, `stores/v1/collections`, `stores/v2/inventoryItems`) answer 428 on this site. Demo + test data, no PII.

## Phase 7.5 — orders / customers (captured 2026-09-21, `scratch/tools/orders-extract.mjs`)

Verbatim API JSON with two guards applied AT CAPTURE: the 7.7 card-data scanner
(card fields, gateway tokens, IBANs, credentials removed — `orders.json` /
`customers.json` never held them) and deterministic pseudonymisation
(`customerN@example.test`, `Test Customer N`, `1 Test Street`, `Testville`,
`1000`, `+32 000 00 00 00`, `0.0.0.0`, notes blanked). Amounts, statuses,
dates, numbers, ids and every key are as returned. See docs/phase7/7.5-orders-extraction.md.

### P-1 refresh — order transactions
`orders.json`: `_transactions` = `GET /ecom/v1/payments/orders/{id}` (the
7.5 capture used a wrong `/transactions` suffix → 404). One manual
(back-office) payment: `{ id, createdDate, updatedDate, amount, status:
APPROVED, refundDisabled, supportReceiptGeneration }`, `refunds: []`; the
scanner removed one card container at capture.
