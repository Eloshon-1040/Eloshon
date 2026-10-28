# Site archetypes & known limits

What the scraper has learned from the sites tested so far. Everything here is
**generic** — keyed on the *shape* of a page, never on a site name. Test sites
(Levi's, Lidl, Microfluo, Colruyt, Leroy Merlin, brico) are examples only.

## The three product-page archetypes

1. **Embedded flat JSON state** — the product grid is hydrated from a JSON blob in
   the HTML (`window.__X_STATE__`, `__NEXT_DATA__`, a Nuxt payload). One list page
   already carries every product with name/price/sku.
   → handled by `core/embedded-state.mjs` (`extractEmbeddedProducts`) and, for any
   already-parsed JSON, `extractProductsFromJson`.

2. **JSON-LD / microdata fiche** — the product fiche exposes schema.org Product
   (Shopify/Woo/Presta and most classic e-commerce).
   → handled by `core/extract.mjs` + `core/listing.mjs`.

3. **XHR-grid** — the products are **not in the HTML**; they arrive as a JSON
   API/XHR response after load (Colruyt, Leroy Merlin, many SPA retailers). The
   HTML holds only nav/org JSON-LD and a client-rendered shell.
   → the generic answer is the **network-observation / internal-API path** (A1):
   render in a browser that passes protection, capture the JSON responses, and run
   `extractProductsFromJson` on them (same product SIGNAL + pagination as the
   embedded path). The discovered endpoint + its pagination are to be memorised in
   `recipes.internal_api` so later runs call the API directly. **Not yet built** —
   this is the next engine increment after the 0.3.10 block.

## Known limits (measured, not coded around)

### Main image: packshot vs ambiance (measured on Lidl, 2026-09)

Lidl serves product data as an embedded Nuxt blob (archetype 1/3), not JSON-LD.
Measured facts about its images:

- images come as an **ordered `imageList`**; the alt text lives in a separate,
  **localised** (nl/fr) `accessibility` string;
- image URLs are **opaque hashes** (`/assets/gcp<hash>.jpeg`) — no
  `packshot`/`main`/`ambiance` token;
- **no** per-image width/height/aspect-ratio is exposed.

**Conclusion:** the only per-image discriminator is free-text alt in the page
language. Choosing a packshot over a lifestyle shot from that would require a
language- and site-specific heuristic — forbidden by the generic rule. The
generic behaviour stays: **`images[0]` = the first image of the site's own
ordered gallery**. No cross-site signal justifies reordering, which would regress
the majority of sites that already put the packshot first.

*Possible future generic signal:* when a source provides per-image alt text, an
image whose alt contains the product name/brand is more likely the packshot than
one whose alt describes a scene. Deferred — most sources give image arrays as
bare URLs with no per-image alt, so it is not reliably available cross-site.
