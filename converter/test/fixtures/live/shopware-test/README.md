# Shopware 6.7.2.2 live fixtures

Captured 2026-09-21 from the shopware-test Docker instance (dockware demo data) with scratch/tools/shopware-extract.mjs (Admin API, OAuth2 client_credentials). Verbatim payloads: products.json = 3 parent products (SWDEMO10005 variant product with 6 children, SWDEMO10007 with 4 children + 7 properties, SWDEMO10002 with rule/tier prices); variations.json = the 10 child products (flat, parentId set). No PII (demo catalogue).

## Phase 6.3 — `products-i18n.json` / `variations-i18n.json` / `custom-field-sets.json`

Same instance, re-extracted with `--i18n --numbers SWDEMO10005` (associations
`translations.language.locale`, `seoUrls.language.locale`,
`customFieldSets.customFields`). The demo catalogue carries real German
translations (`Variantenprodukt`) but no EAN / MPN / custom field anywhere, so
the family was SEEDED first with `scratch/tools/shopware-seed-63.mjs` (local
test instance only, idempotent):

- custom field set `eloshon_specs` (product relation) — `eloshon_specs_material`
  (text), `eloshon_specs_warranty_months` (int), `eloshon_specs_fragile`
  (bool), the shape the admin UI creates;
- parent SWDEMO10005: `ean` 2000000000015 (GS1 restricted-circulation prefix =
  test data), `manufacturerNumber` MPN-SWDEMO10005, the three custom fields;
- child SWDEMO10005.1: its own `ean` 2000000000022; the five other children keep
  `null` → inherited from the parent (DAL semantics).

`custom-field-sets.json` = `POST /api/search/custom-field-set` with
`customFields` + `relations`: the typed definitions the parser uses as the
`customFieldSets` companion (namespace = set name, type = declared type).
Observed: Shopware stores custom fields on the TRANSLATION entity (the en-GB
row carries them); the product-level `customFieldSets` association is the
per-product set SELECTION (empty here), not the definitions. `seoUrls` only
exist for en-GB (no DE domain on the test sales channel).

The 5.x files above are untouched: their 12 goldens prove the 6.3 entries emit
nothing when the associations were not loaded.

## Phase 7.5 — orders / customers (captured 2026-09-21, `scratch/tools/orders-extract.mjs`)

Verbatim API JSON with two guards applied AT CAPTURE: the 7.7 card-data scanner
(card fields, gateway tokens, IBANs, credentials removed — `orders.json` /
`customers.json` never held them) and deterministic pseudonymisation
(`customerN@example.test`, `Test Customer N`, `1 Test Street`, `Testville`,
`1000`, `+32 000 00 00 00`, `0.0.0.0`, notes blanked). Amounts, statuses,
dates, numbers, ids and every key are as returned. See docs/phase7/7.5-orders-extraction.md.

### 7.4 refresh (same day) — numbering observed in motion
Two orders were placed through the real Store API checkout on the local
instance (`scratch/tools/shopware-seed-orders.mjs`), set paid and given an
invoice document: `orders.json` (2 — orderNumber 10000 / 10001 from the
`order` range, transactions paid, documents association loaded),
`documents.json` (2 — invoice documentNumber 1000 / 1001 from the
`document_invoice` range), `number-ranges.json` (lastValue advanced). Read by
`shopware.orders.admin-api.v1`; `customers.json` by
`shopware.customers.admin-api.v1` (+ `newsletter-recipients.json`, still 0).

### P-1 refresh — associations completed
`orders.json`: `deliveries.shippingOrderAddress.country` (+ `countryState`) and
`transactions.captures.refunds` loaded (no refund exists: cash on delivery has
no refund handler); `customers.json`: `country` on `defaultShippingAddress` /
`addresses[]`. `number-ranges.json` is now a declared companion
(`numberRanges` → `numbering.format`).
