# Variants: from the page to the store (28/10/2026)

## What the Scraper and the extension write

- **products.json** (unchanged shape, the contract of `converter/docs/phase0-products-json-contract.md`):
  `variants` is a flat list of typed entries `{ code?, type, name, price?, image?, url?, availability?, sku? }`.
  `type` names the axis (`couleur`, `taille`, or the generic `option`); colourways sold as separate pages are
  entries whose `code` is another product's `source_product_id` (siblings).
- **Panel CSV**: a « Variantes » cell `30 ML : 77.7 | 50 ML : 115.5 (épuisé)` (value : price, « épuisé » = sold
  out), or a column per axis listing its values `40 | 41 | 42`. A 🎯 designation on a picker the shopper chooses
  from (buttons, swatches, radios, listbox) is read as a whole axis (`shared/extract/pick-selector.mjs`
  `looksLikeChoice`), named as the page names it (aria-label, legend, the label before it: `groupAxisName`),
  each value with its price when the page shows one with its currency (`valueWithPrice`: « 30 ML : 77.70 »).
  The field's role becomes an option axis unless the user chose another; the axis name travels in the manifest
  (`columns[].axis`).
- **SKU**: only what the source declares. A combination the source gives no reference for has an empty SKU,
  said in the conversion notices.

## What the Converter does (`converter/core/src/families.ts`, `variant-policy.ts`)

1. A generic axis (« option », « variant ») is named from its values: Contenance (volumes, weights), Taille
   (garment sizes, shoe sizes), else Variante (`option_axis_named`).
2. Colour pages of one model present in the same file (siblings) become one parent: a Couleur axis with each
   colour's pictures × the size axis read on each page; the parent title and handle lose the first page's
   colour (`colour_family_grouped`). A family with a page without a readable colour, two identical colours or
   different axes stays as it is (`colour_family_not_grouped`): nothing is guessed.
3. A page listing two axes as one flat list (colours, then sizes) gives every combination; a value's own price
   and picture go to its combinations (`variants_combined`). Availability per combination is not known: all
   combinations are created.
4. Stock: a file Eloshon Scraper wrote has its variants **not tracked** by default (the source site's
   availability is not the merchant's stock; a sold-out size is not imported as out of stock). « Stock des
   variantes » under the step-3 preview: not tracked / quantities kept and selling beyond allowed / quantities
   kept and selling stops at zero; remembered per target platform. Platform and taught supplier files keep
   their quantities by default.
5. Limits (reported, never cut in silence): Shopify 3 options and 2 048 variants per product (shopify.dev, Admin
   API 2026-10); Wix 6 options, 100 choices per option, 1 000 variants per product (Wix Help Center « Wix
   Stores: Limits & Recommended Guidelines », 2026-01-26); WooCommerce no fixed limit.
6. Exports: Shopify Option1/2/3 Name and Value per variant row; WooCommerce a `variable` parent with its
   attributes and one `variation` per combination; Wix one `VARIANT` row per combination.
