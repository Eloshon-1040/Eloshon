# Listing pagination and product-page completion (v0.5.18)

Two generic, free mechanisms run after a LISTING lane (learned recipe, internal
API recipe, platform feed). Neither contains a site name; both read the shape
of the data. Neither ever starts a paid route.

## 1. Product-page completion (option A)

After the listing, each product page is visited once over free HTTP (the run's
Fetcher: same polite rate, cookies, byte accounting).

- The page's embedded JSON (any `<script type="application/json">`, any
  `window.X = {…}` state) or its JSON-LD `ProductGroup` is read for the shape
  *colourway = colour code + colour name + sizes (with EAN) + gallery + prices*
  (`shared/extract/product-group.mjs`).
- **Option A**: one row per colourway. The row keeps its own reference and gets
  `color`, `variants` (`{code, type:'taille', name, gtin?, availability?}`), the
  gallery (colourway images first, the listing thumbnail kept), the real
  description (replaces a `<meta>` marketing line), brand, category (the page's
  subtitle, or the gender labels) and `listPrice` when the page shows a real
  reduction. A product-level `barcode` is set only when the colourway has
  exactly one sized EAN; otherwise the EANs live in the variants.
- **One visit per model**: a page carries every colourway of its model, so the
  other listed colourways are completed without another visit.
- **Every listed product can be completed**: visits are bounded by the job's
  "Max produits" (about 1 s per page at the polite rate); an explicit positive
  `maxPerJob` adds a lower cap (`null` by default = none).
- **Sample first**: if the first `sample` pages (default 3) add nothing
  significant, the rest is skipped (a grocery API whose pages add nothing costs
  3 requests).
- **Never invented**: a failed page (404, block) leaves the row exactly as
  listed; the reason is counted. A lifecycle "ACTIVE" status is not stock.
- **Stock and reviews stated by the page** are taken too: schema.org
  `availability` (product and per size), `aggregateRating` (rating 0–5, review
  count), and a missing name / price from the page's structured data (never
  replacing what the listing showed).
- The same extractor also runs inside the fiche extractor, so the crawl lane
  (which already visits every product page) gets colour/sizes/EAN too.

Settings (config.json, optional):

```json
"detailPages": { "enabled": true, "maxPerJob": null, "sample": 3 }
```

### A site that refuses plain HTTP but lets a browser in

Measured on a protected shop (an anti-bot waiting page answers plain HTTP with
403): page 1 came through the local browser, then page 2 and every product page
were refused over HTTP (24 of 40 products, no image, no description). Handing
the browser's cookies to the HTTP client does not help (still refused), and
repeated refused HTTP attempts made the site distrust the browser too.

Now, after the first refused HTTP page, the next pages of the run (pagination,
product pages, also for panel rows with "Sous-pages") are read in the local
browser (`core/browser-pages.mjs`): spaced (`browserPageGapMs`, default 3 s),
bounded (the browser budget, at least the product cap), and HTTP is not tried
again in the run. The FIRST human check the site asks for stops these pages for
the rest of the run — no manual-intervention prompt in the middle of a
completion, no retry, no bypass; the products keep what the listing gave. The
same shop let a browser read about four pages in a row at a human pace before
asking for a check. Report: `pagesViaBrowser`, `browserPagesStop`
(`human_check` / `budget` / `browser_unavailable`).

### Stock per size and reviews loaded by the page itself

Many product pages state neither the stock nor the reviews in their HTML: the
page asks for them with its own requests after loading. When products still
lack a stock state or a review count at the end of a run (any lane), and the
browser fallback is on (`core/side-requests.mjs`):

1. **Learn on ONE product page** (one whose sizes carry codes): the local browser
   renders it and keeps the JSON answers to the page's own GET requests, with
   their request headers (filtered: never a cookie, a credential, `sec-*`, proxy
   or transport header, nor the user agent).
2. **Choose** the answer that gives a stock state for this product's own size
   codes (EAN / GTIN / size id — flat `{gtin, available, level}` or nested
   `{gtin, availability:{isAvailable, ship}}` shapes, quantities, schema.org or
   word states) and the one that gives its rating + review count. Each request
   URL becomes a **template** with the product's own values as placeholders (URL
   path parts, reference): `…styleColor({seg.3})…`, `…/{seg.3.0}/review/…`. A URL
   that carries no product value is not a per-product request and is ignored
   (e.g. recommendations of other products).
3. **Ask for every product** over free HTTP (the run's polite Fetcher; stock and
   reviews usually on two hosts, asked at once; one request per distinct URL;
   a terminal block stops the asking; at most 3 requests per product).

Each size gets `availability` (schema.org term) and, when given, `stock_level`
(`high` / `medium` / `low` / `none`); the product gets `raw.availability` (from
its sizes), `raw.rating` (null when no review) and `raw.review_count`. A size
the answer does not mention keeps no state (never guessed). Nothing learned is
stored beyond the job.

Measured on a real listing (30 products, free): 30/30 with a stock state, 327 of
349 sizes with a state (69 out of stock, levels high/medium/low), 30/30 review
counts, 27 ratings.

```json
"sideData": { "enabled": true }
```

### Category trail

`source_category` is the product's category trail joined with `" > "`: its page's
breadcrumb, else the **listing page's** (JSON-LD `BreadcrumbList`, microdata, a
breadcrumb navigation block, else the listing title — never the home page's),
followed by its own category when that is not already the last step. HTML
entities left in the structured data (`d&#039;air`) are decoded, and a last step
that is the product's own name is dropped (a product page's breadcrumb often ends
with the product). The leading "Home" / "Accueil" step and the site's own name are dropped
(`shared/extract/listing-trail.mjs`, `core/listing-context.mjs`). The listing
page is the one the run already fetched (no extra request). In the extension
panel, the trail of the page open in the tab is sent with the accepted rows.

### Pictures (image contract, 2026-10-27)

One contract for the app, the extension, the taught rules, the panel preview and
the Converter pivot: `ProductImage = { url, alt?, width?, height?, position,
source }` (`shared/extract/images.mjs`). Rows and `products.json` keep the
serialised form `images: string[]` (ordered, absolute, one entry per picture);
`image_url` stays the first one.

- **Sources, in reliability order, then merged** (`core/extract.mjs`): JSON-LD
  `Product.image` (string, array or `ImageObject`, `@graph` and `hasVariant`
  included), microdata and `og:image` / `og:image:secure_url`, the page's
  gallery read from the DOM (`shared/extract/gallery.mjs`: anchored on a
  declared picture, else the block that reads as a gallery; `<img src>`, lazy
  attributes, `<picture><source srcset>`, zoom attributes, CSS
  `background-image`), then the embedded state. The colourway of THIS page
  (JSON-LD variant `url`, code or sku in the path) gives its own gallery, never
  the first colourway of the group.
- **`srcset` is parsed as the HTML specification says** (`parseSrcset`): a
  candidate is a URL plus descriptors; a comma inside a URL is part of it
  (Cloudinary-style paths `c_lpad,w_iw,h_ih`); the largest candidate is kept.
  A string of several addresses is split only before a new URL, on a newline or
  on `;` / `|` / `, ` between two paths — never on a bare comma.
- **Normalisation**: absolute against the page, protocol-relative resolved,
  HTML entities decoded, spaces and unicode percent-encoded, commas kept,
  `http(s)` only. A Shopify-shaped size suffix (`…/files/…/pull_600x.jpg`) is
  replaced by the original file; other resizers keep the largest candidate seen.
- **One image per picture** (`imageKey`): transformation segments, size words,
  Shopify suffixes and size / version query parameters are not part of a
  picture's identity; the largest known rendition is kept at the place of the
  first appearance; the main picture (first of the most reliable source) stays
  first. Two different photos are never merged.
- **Rejected, never silently**: an address that is not usable (unparsable, not
  `http(s)`, a `data:` URI, a path cut on a transformation segment such as
  `…/e_trim:EAEEEF/c_lpad`, a video's still frame when the product has photos)
  is listed in `report.images` with its reason and shown in `report.txt`
  ("images rejected").
- A picture inside a link to ANOTHER page of the site (a related product, a
  colour swatch leading to its own page) is never this product's picture.
- The extension scrolls through a product page before reading it
  (`revealLazy`, `extension/content/runner.mjs`) so lazy-loaded gallery
  pictures are in the page it sends.

### SKU and product reference (2026-10-27)

`shared/extract/sku.mjs` is the one rule (mirrored in the Converter):

- **A SKU is an identifier the source declares**: JSON-LD / state `sku`, a code
  attribute of the page (`data-sku`, `data-code`…), a per-variant SKU (`IF6490_520`).
  When there is none, `raw.sku` and `variants[].code` stay **empty** — nothing is
  invented.
- **Guard by value profile** (`skuVerdict`): a value holding « : » or « / », a
  phrase, a repeat of an option / colour / product name, longer than 64
  characters or with no letter or digit is never a SKU; it is removed and listed
  in `report.skus` with its reason.
- **The product reference is not a SKU**: a colourway's `productID` /
  `productId`, a listing card's `code` / `id` / `productCode` (`skuIsReference`
  on the card) go to `raw.reference`; `source_product_id` still uses it, and the
  Converter's SKU generator can use it when the user chooses so.
- **Taught variants** (🎯 « Variantes »): a label shared by every entry
  (« Couleur du produit : Aurora Coffee / … ») names the option and gives the
  type (`couleur` / `taille` / `autre`, `optionTypeOf`); the value alone is the
  option's name; the code is the entry's code attribute, never its label.
- Live case 2026-10-27 (adidas.be, job `20261027205754-x7tst`): the colour-swatch
  strip taught as « Variantes » gave `code` = « Couleur du produit : … » → Shopify
  « Variant SKU ». Tests: `core/__tests__/sku-contract.test.mjs`.

### Product address

`source_url` is the canonical address: `<link rel=canonical>`, else `og:url`,
else the declared `url` (JSON-LD / state), else the visited address — absolute,
without tracking parameters (`utm_*`, `gclid`, `fbclid`…), locale kept
(`canonicalProductUrl`, `core/extract.mjs`; `cleanUrl` in `core/normalize.mjs`).
A corrected address is counted in `report.urls`. The Converter writes it to
Shopify as the metafield `source_url (product.metafields.eloshon.source_url)`
(Shopify has no native source-URL column); the handle stays the Scraper's slug.

### Product details: wrapped JSON-LD, technical specifications, options (2026-10-20)

- **Wrapped product.** A JSON-LD product may sit inside another entity: an Action's
  `object` (`BuyAction` → `ProductGroup`), a page's `mainEntity`, an Offer's
  `itemOffered`. `collectNodes` (`core/jsonld.mjs`) and the group reader
  (`shared/extract/product-group.mjs`) unwrap them; `ProductGroup` counts as the
  product when no plain `Product` is on the page. Before, such a page fell back to
  `<meta>` tags (name with the shop suffix, no brand, no EAN, one picture).
- **Page state that is JS, not JSON.** A `window.X = {…}` state serialised with
  `undefined` / `NaN` / `Infinity` was dropped whole by `JSON.parse`.
  `parseDataLiteral` (`shared/extract/js-literal.mjs`) nulls those three tokens
  outside strings and still rejects anything else (unquoted keys, functions,
  comments). Used by `pageJsonPayloads`, the embedded-state grid and `spa-state`.
- **Technical specifications** → `raw.specs` = `[{ group, name, value }]`
  (`shared/extract/specs.mjs`): JSON-LD `additionalProperty`, then the page state
  (a group label + at least two label/value objects; an Apollo cache's `__ref`
  entries resolved), else two-cell table rows and `<dt>/<dd>`. When the state holds
  several products' specs (the page product + accessories shown with it), only the
  groups whose `productId`/`sku`… is the page product's (sku, EAN, mpn, number ending
  the URL) are kept; several products and none the page's → nothing from the state.
  The known labels among them fill EAN, brand, reference and weight
  (`fieldsFromSpecPairs`, `core/dom-fallback.mjs`; "Poids sans pied", "Poids du
  produit"… count, a load or maximum never does).
- **Options without colour.** A `ProductGroup` varying by size (or another
  `variesBy` property) with no colour is one colourway (`color: null`); each option
  keeps its own `price`, absolute `url`, `sku`, EAN and stock in `variants`. Their
  pictures are other products' and stay out of the gallery.
- **Model codes are not quantities.** A number glued to letters in a name
  ("40S5L", "XR-55A80L", "98X11L") is no longer read as litres; a multipack
  ("6x1,5L", "24 x 33cl", 2 to 48 units) still is.
- **In the app.** Résultats › a product shows brand, stock (schema.org term
  translated, else as written), customer rating, the options with their price and
  stock, and the technical specifications by group.
- Live check 2026-10-20 (mediamarkt.be TV listing, free lanes, 0 $, 30 products):
  EAN 0 → 100 %, brand 0 → 100 %, specs 100 % (82 on a single TV page; 2 on a
  "pack" page, whose components are other products), stock 100 %, rating where the
  page has reviews (17 %), real weight read on 20 % instead of an estimate from the
  model code. Tests: `core/__tests__/product-page-details.test.mjs`,
  `shared/__tests__/specs-and-literals.test.mjs`, `app/__tests__/product-detail-ui.test.mjs`.

## 1-bis. Reading a listing and telling a product page from a listing

Measured on three real shops (October 2026), all generic:

- **Microdata tiles** (`shared/extract/microdata.mjs`): the tags are walked once
  and every `itemprop` is given to the `itemscope` item it belongs to. A listing
  whose tiles are each a schema.org `Product` gives its cards (name, URL, image,
  price + currency + availability from the tile's `Offer`). Used by the app's
  listing reader and by the extension's automatic reader.
- **A product page with related products**: several microdata `Product` items, but
  the page's `<h1>` sits inside one of them → that one is the page's own product,
  the others are related products. The page is a product page (it used to be
  rejected as a listing, 18 of 19 pages lost on one shop) and gives no listing card.
- **A site menu in the page state**: a page's embedded state can carry the whole
  category menu (hundreds of entries, each with a picture) next to the product
  grid. A menu entry (a node holding labelled child entries, no price) is never a
  product, and a picture / file URL (`.webp`, `.jpg`, `.css`…) is never a
  product's page — so the real grid wins (24 products instead of 202 menu tiles).
  In the panel, a row whose link is a picture keeps it as its image, never as its
  page or its reference.
- **Prices and reviews on the card**: `{ regular:{price:599}, discount:{price:399} }`
  reads 399 (only the inner key `price`, only below the regular price — a discount
  stated as an amount is never a price) and keeps 599 as the list price (`list_price`;
  also `listPrice`, or an `original` entry of a price list); `{ reviews:{ rating, count } }` gives the
  rating and the review count. A category code in the listing URL (`/ga086/`) is
  not a category name.
- **The pasted listing first**: its own next pages (rel="next", or any page-number
  parameter: `?currentPage=2`, `?pageNumber=3`) are read before a neighbouring
  category linked from it (a promotion banner's collection no longer fills the
  product cap ahead of page 2). The "12 pages without a new product" stop counts
  the products a page gives from its state too (it stopped a 3,786-product listing
  at 282).

### A listing that cannot be read: the sitemap complement keeps its scope (0.5.41)

When the pasted listing gives fewer than `sitemapMin` products (blocked, empty,
dead), discovery used to fill in with any product URL of the site's sitemap. On
2026-10-20/21 a blocked French men's listing (`/homme`) got 30 Dutch football-boot
pages that way, all from the first product sitemap read. Now a sitemap URL stands
in for the listing only when it keeps BOTH of its scopes (`core/complement-scope.mjs`,
URL shapes and sitemap structure only, no site rule):

- **Language**: a whole path segment (`/fr/`, `/fr-be/`, `/BE/fr_BE/`) or a
  language host label (`fr.`), never a word inside a slug. A listing without a
  segment is the site's unprefixed branch: `/nl/…` is another branch. A prefixed
  listing accepts an unprefixed URL only when the site's item URLs carry no
  language segment at all.
- **Category**: the listing is the whole catalogue (root words only — `/shop`,
  `/products`, `/collections/all`, `/produits/toutes-les-categories` — and no
  facet filter, not a search), or the URL is nested under the listing's path
  (`/fr/homme/…` under `/fr/homme`), or the URL comes from a sitemap file named
  after the listing's category (`sitemap-homme.xml` for `/homme`, whole tokens).
- The entry grid's learned URL pattern, when the listing page was read, stays an
  extra constraint.

The first sitemap read stops at the product cap whatever the scope. When it was
cut short and too few URLs are in scope, ONE more read is made with the scope as
a filter: files named after the category, then the listing's language, first;
at most `complementMaxSitemaps` (12) files, stopped after `complementBarrenSitemaps`
(3) files in a row without an in-scope URL.

Nothing in scope → nothing added. If the listing itself was blocked, the run ends
`stopped:<code>` with 0 products, `discovery.listingBlocked` = `{ url, code,
outOfScope }`, reason « liste bloquée : … », and the completion screen says so
(`complete.listingBlocked`, 5 languages). With 0 free products, the paid unlock
chain can then take the listing (opt-in and caps unchanged). Report:
`discovery.complement` = `{ scope, checked, added, outOfScope:{language, category,
pattern}, outOfScopeSamples, sitemapReread, rereadSitemaps, rereadRejected }` and
the `sitemap complement:` / `listing blocked:` lines of `report.txt`. The analysis
(`core/probe.mjs`, dead entry) samples a sitemap fiche from the same scope.

Real free check (2026-10-23, `adidas.be/homme`, isolated, 0 $): 6 s,
`stopped:ACCESS_DENIED`, 0 products (was 3 off-topic `/nl/` products in 107 s);
30 URLs out of scope by language; the scoped re-read read 4 files and rejected
16,864 URLs. Limit: a site whose product URLs carry neither the category path
nor a category-named sitemap cannot be complemented for a category listing —
it is reported blocked.

## 2. Generic listing pagination

`core/listing-pagination.mjs`, used by the learned-selector recipe replay.

| Priority | Signal | How the next page is built |
|---|---|---|
| 1 | `rel="next"` (`<link>` or `<a>`) | the link, page after page |
| 2 | a "next / suivant / volgende / weiter / siguiente / › / »" link | the link |
| 3 | a page/offset parameter **observed** on the page (`page`, `p`, `pg`, `offset`, `start`, `from`, `skip`…) | parameter incremented (offset by the first page's size), each page validated by new content |
| 4 | an internal-API `next` URL in the embedded JSON (`next`, `nextPage`, `nextUrl`, `links.next`…) with an announced total (`totalResources`, `totalResults`, `totalCount`, `total`…) | resolved on the page origin, then on the same-site hosts the page itself declares (`<link rel="preconnect|dns-prefetch">`, API-looking first); the response's own `next` is followed |
| — | "load more" / infinite scroll with no deducible request, or an API that refuses the request | **not followed over HTTP**; see the browser scroll fallback below |

**Browser scroll fallback (free, local).** When the HTTP pagination ends with
`scroll_not_followable` and products are still missing (below the product cap
and below the announced total), the job opens the page in the local browser
(Playwright Chromium, only when the "browser fallback" option is on). It
scrolls / clicks "load more" until the product cap is reached or nothing new
appears (`BrowserSession.collectListing` with `recipeCard`, `recipeUrlSelector`,
`stopAt`). Every card seen is kept (lists that recycle their DOM are covered),
then read by the **same learned recipe**. Rows are deduplicated by URL. No paid
route is involved. The report then says `mechanism: "browser-scroll"` and
`browserScroll: { cards, added, blocked, error }`. With the option off, the limit
is reported as before.

The scroll is bounded: every page call has a 15 s limit (retried on the current
document after a navigation, e.g. the reload that follows a cookie banner), and
the whole collection has a ceiling (paused during a manual intervention); past it,
what was collected is kept. A "load more" match that leads to another page ends
the collection (nothing from that page is read).

**Then the site's own API (free).** Many lists stop loading on scroll after a few
pages. While scrolling, the browser watches the requests the page itself sends to
the listing API the HTTP pagination could not complete (same path), and keeps
their request headers — filtered by `extraHeaders`: never a cookie, an
authorization, a `sec-*` / proxy / transport header or the user agent — plus the
latest JSON answer. The HTTP pagination then continues from the request after the
last one the page made (`paginateListing({ apiStart })`), with those headers, for
this job only (nothing is stored). Report: `apiAfterScroll: { pages, added,
stoppedBy, headersLearned, detail }`.

The generic JSON reader also reads, one level deeper and with no site rule: a
grouped grid (`[{…, products:[p]}, …]`), a name in a small text sub-object
(`{ copy: { title } }`, never a brand / category one), a link object
(`{ url, path }`) and an image object of named renditions (`{ portraitURL, … }`).

Stop rules (all enforced): no new product on the next page; announced total
reached; maximum products; page cap per job (`listPagination.maxPages`,
default 50, never above `maxPages`); loop (same URL or same content again);
error or block. Products are deduplicated across pages (URL, then reference).

The working mechanism is remembered in the recipe
(`manual_selectors.pagination`: `mode` = `url-param` | `rel-next` | `next-link` |
`api-next`, plus `param` / `kind` / `api_host` and `detected_at`). An old recipe
(`mode: none` / `load-more` / `next-link`) keeps working: the signals are
detected again on each run.

```json
"listPagination": { "enabled": true, "maxPages": 50 }
```

### Lanes covered

| Lane | Pagination | Product pages |
|---|---|---|
| Learned selectors (manual_selectors) | generic (this module), then local browser scroll when the list only loads on scroll | completed |
| Internal-API recipe | the recipe's own API pagination (unchanged) | completed |
| Platform feed (Shopify / WooCommerce) | the feed's page parameter (unchanged) | completed only for rows without colour + variants |
| Crawl / sitemap discovery | the crawl's existing rel=next / page synthesis (unchanged) | every product page is already read; the group extractor completes it |
| Paid escalation, server cascade | not paginated here (one call, no paid pagination) | not completed |
| "Your browser" extension | not covered (runs inside the extension) | not covered |

## 3. What the job report says

`report.json` / `report.txt` / the result screen:

- `pagination`: mechanism, pages read, total announced by the site, stop
  reason, warnings (`total_not_reached`, `scroll_not_followable`,
  `api_refused`) and, for a refused API, its HTTP status and error code;
- `detailPages`: pages visited, rows completed / unchanged / failed / skipped,
  reasons (`http_404`, `blocked`, `sample_no_data`, `max_visits`…);
- `sideData`: what was learned on the sample page (`learned.availability`,
  `learned.rating`, `pageRequests`), then `requests`, `failed`,
  `availabilityRows`, `ratingRows`, `stoppedBy`; or `reason`
  (`browser_unavailable`, `no_product_page`);
- `categoryTrail`: `{ source, trail, products }` — where the trail came from and
  how many products received it.
- `status` is **`PARTIAL`** (never `OK`) when the run ended but left rows to
  verify or product pages unread (`partial: { toVerify, pagesUnread, reasons }`,
  `applyPartialStatus` in `core/engine.mjs`); a stopped or blocked run keeps its
  own code. A row whose own product page failed (`needs_user_browser`, the page
  limit, a refusal) and that still lacks what the page gives (description,
  images, brand, variants, specifications) is `to_verify` with code
  `to_verify_detail_unread` and the list of missing fields
  (`detailUnreadVerdict`, `core/detail-enrich.mjs`); the listing data alone is
  never "accepted".
- `store`: the form's store, else the site itself (a run started from the
  extension's panel names none); `fetched` counts the list pages and the product
  pages read (the ones the user's browser sent included).
- `images`: `{ rejected, byReason, samples[{ product, url, reason, label }] }`;
  `urls`: `{ corrected, samples }`; `knowledgeInvalidated`: the taught rules
  this run made fail (`field`, `ruleId`, `reason`). `report.txt` shows them as
  "images rejected", "urls corrected", "rules invalidated".
- `skus`: `{ rejected, byReason, samples[{ product, value, field, reason, label }] }`
  — values read as SKU (`raw.sku`, `variants[].code`) that are labels, phrases or
  option names, removed so the SKU stays empty. `report.txt`: "skus rejected".
- A "your browser" run whose product-page limit (« Fiches produit ») cut the
  pages says so in its notes; the limit now follows « Max produits » unless set
  in the form or in `config.json` (`LIMIT_BOUNDS`, `app/your-browser/launch.mjs`).

The usage ledger is unchanged (schema `v:1`): the free `local` line's bytes now
include the pagination and product-page requests.
