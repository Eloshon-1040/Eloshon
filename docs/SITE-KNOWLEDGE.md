# Site knowledge — what a site has taught the scraper

One store, fed by both detection modes, read by every lane. Added 2026-10-23.

```
 ✨ detection (AI mode)            🎯 designation (manual mode)
   proposes rules (origin 'ai')      teaches / corrects rules (origin 'manual')
                  \                  /
                   siteKnowledge  (domain-profiles.json, per host)
                  /                  \
   product pages of a collection     one product page scraped on its own
   (Sous-pages / "Accepter")         (runScrape)
```

## Where things are

| What | File |
|---|---|
| Rules, priority, versions, tests, confidence (pure) | `shared/knowledge/rules.mjs` |
| Fingerprint + re-locating a block on another page | `shared/knowledge/dom-locate.mjs` |
| Reading a block: text with paragraphs, spec **pairs** | `shared/knowledge/readers.mjs` |
| Apply / test a rule, rule from a clicked element, AI proposals | `shared/knowledge/apply.mjs` |
| What the pointer selects (whole description, whole table), sibling product links | `shared/knowledge/pick-block.mjs` |
| Generic reader of labelled blocks (no rule needed) | `shared/knowledge/labelled-blocks.mjs` |
| Store in the profile (`siteKnowledge`, `knowledgeRules/Tests/Outcomes`) | `core/domain-profile.mjs` |
| Merge into a row, priority general-manual > generic > gap-fill | `core/site-knowledge.mjs` |
| Panel ops `learn` / `propose` / `knowledge` / `forget` + list-page card recipe | `app/knowledge-service.mjs`, `app/your-browser/panel-requests.mjs` |
| In-page tool (hover → highlight → wheel → click) | `extension/content/runner.mjs` → `pickKnowledge` |
| « Fiche produit » tab | `extension/ui/learn.mjs`, `panel.html` |

## A rule

`{ id, scope:'product'|'collection', field, origin:'manual'|'ai', status:'active'|'proposed'|'failing'|'superseded'|'deprecated', version, selector, fingerprint, extract:{mode:'text'|'pairs'|'attr', multiline, label}, example, tests:{ok,total,urls}, stats, supersedes }`

The fingerprint keeps the tag, stable classes and attributes, the parents, the label of the tab / accordion / heading that names the block, and the shape of its content. `resolveRule` tries, in order: the selector (best-scoring match), the stable attributes, the **label**, then a structural similarity search. A block that does not look like the field (description shorter than 30 characters, fewer than 2 spec pairs…) is a **failure**, not data.

## Priority

* A manual rule beats an AI one. A new manual rule supersedes the previous one (history kept, 4 per field).
* An AI proposal never displaces a manual rule: it stays `proposed`. The same block designated by the user is a *confirmation* (`confirmedAi`, more trust).
* Three consecutive failures: a manual rule becomes `failing` (tried last, revived by a success); an AI rule is `deprecated`.
* Chain per field: active manual → active AI → proposals → failing → recent superseded manual → generic extractors (structured data, embedded state, DOM) → rendered page (local browser) when a taught field stays unread in the plain HTML.
* Each rule reads the HTML first; when the block is not there (many shops build it in the browser), it reads the **page's embedded state** for the page's own product: the state key learned when the block was designated (`rule.state.key`), else the field's usual keys (description) or the state's spec groups (technical specifications). Never a related product's value (`shared/knowledge/state-values.mjs`).
* On a row: what the **user** designated (manual rule) overrides the generic read on every page where it reads a value passing the field's check; AI rules only fill a gap. « général » (≥ 3 pages, ≥ 60 %) is the confidence shown, not a gate.
* A designated category (breadcrumb) reads as « A > B > C » and replaces the trail read automatically.

## Confidence

`testLabel`: not tested / faible / moyenne / élevée from « ok/total » pages. Learning checks the rule on up to 5 other product pages of the site (links found on the page, links of the last collection read in the panel); every later scrape adds its pages to the counters.

## The scenario

collection → product A → 🎯 description + technical_specs → back on the collection → « Exécuter » → « Accepter ». The app sees that the site holds taught fields the rows lack, opens each product page (even without « Sous-pages »; never when the card already carries the field), applies the rules, and writes `description` (paragraphs kept) and `raw.specs` + `raw.technical_specs`.

## Learning a new site in one pass (Oct 2026, after studying Thunderbit, Instant Data Scraper, Web Scraper, Octoparse, Browse AI, Crawl4AI, Zyte, Diffbot)

* **Sub-pages in the user's browser** (`extension/background/subpages.mjs`): after the list, « Accepter » opens each product page in a minimized window of the user's Chrome (2 tabs, 0.7–1.5 s irregular pause, 15 min budget), waits until the page has built itself (`runner.settle`: ≥ 1.5 s, then 1 s without DOM change or new request, ≤ 10 s), sends the lightened rendered page (`runner.compactHtml`: data scripts kept) to the app (op `page`, kept per run by `createPageCache`), and the app completes each row from it — no plain HTTP re-read for those pages. « Sous-pages » is on by default for products.
* **Pagination** (`shared/extract/next-page.mjs`, `panel-run.mjs`): load more + scroll on the page, then the next page — the control the user showed (🎯 in « Pages », kept per site), rel=next, a « suivant / next / › » control (never « précédent », never disabled; a link before a click), the next page number, a page parameter. Page limit, « nothing new twice » stop. The panel's « Pagination » setting now chooses: Automatique / Aucune / Défilement infini / Bouton suivant / Paramètre d'URL.
  * **Since 2026-10-28 (after ext 0.7.32, not released yet)** — modes: Automatique, Bouton « page suivante » (`button`), Bouton « charger plus » (`load_more`, clicks only), Défilement infini (`infinite`, scroll only), Numéro de page dans l’adresse (`url`), Aucune. Stops per mode: no new product (`no_new`), control gone / disabled (`button_gone`, `end`), announced total reached (`total_reached`, `shared/extract/list-total.mjs`), page limit (for `load_more` / `infinite` each load counts as a page).
  * 🎯 « page suivante » and 🎯 « charger plus » keep CUES, not one selector (`shared/extract/page-control.mjs`): the real link / button around the click, a stable selector (own marks, else a stable ancestor + path, e.g. hydrozone `#pagination_next_bottom > a`), text (counts made generic), label, block, place from the end, page parameter. The last page is recognised when the shown control is found disabled (PrestaShop: a `<span>` in `li.disabled`). A pointed element with no usable cue is refused with its reason (0.7.32 erased it with « Aucun bouton mémorisé »).
  * Per site, shared with the app: domain profile `list_pagination` (`{v, mode, next, loadMore, lastTest, updatedAt}`, `shared/extract/pagination-memo.mjs`), panel op `pagination` (get / set / forget), exported in recipes.json; copied in `chrome.storage.local.sitePagination` (the old `nextSelectors` entries are migrated). « Tester » runs ONE step and counts the product cards before / after.
  * Before a pagination click: cookie banners / pop-ups closed the private way (`shared/extract/overlays.mjs`: « Rejeter tout » / « Refuser », else ×, never « Accepter »), control scrolled into view.
  * The announced total travels with « Accepter » (`report.pagination`, mechanism `your-browser`); a shortfall no user limit explains makes the job PARTIAL (`partial.listShort`).
* **Product card learned from one click** (since 2026-10-28, `shared/extract/card-model.mjs`, tab « Champs » → « Carte produit »): the card selector (`deriveCardSelector`), its grid on the page it was learned on (`scopes`, `learnedOn`; a click on a card of another section adds it), the link kind (`linkShape`, e.g. `/products/*`), and what a card must show (title; price when the clicked one had one). `classifyCards` keeps / rejects every candidate with a reason (`outside_list`, `carousel`, `marked_not_product`, `no_link`, `other_link`, `no_title`, `no_price`); on another page of the site the whole content is the list except header, menus, footer and suggestions. « 🎯 Pas un produit » adds a negative signature. Green / red outlines + count in the page. Kept per site in the app (profile `card_model`, panel op `card_model`, recipes.json). When a card is learned it is the panel's only reader; the rejected cards go to `meta.rejected` → `report.listRejected`.
  * Root cause it answers (marshydro hub, WooCommerce/Woodmart): `extractDomGrid` reads the first 200 product links in page order — header mega-menu and promo blocks included — 37 « cards », 30 without price, while the page has the real cards with prices.
* **Hub page** (tab « Pages »): 🎯 on the block of sub-collection links; « Exécuter » opens each one, reads it like a list (card, pagination), tags each row `subCollection` (and `category` when chosen), keeps a product of two series once (`alsoIn`), goes back to the hub; `meta.hub` → `report.hub`. The hub is kept with the batch of the page (`panelBatches[key].hub`, `list_batches[key].hub`).
* **Collection rules**: the product page's OWN breadcrumb against the list's trail (or the hub sub-collection): no shared category → `to_verify_out_of_collection` + `report.outOfCollection` (`shared/extract/collection-check.mjs`; no breadcrumb → no verdict). A product already recorded from another list page of the site → kept in EACH batch (Andy's decision, 2026-10-28: a unisex product belongs to both lists), listed in `report.crossBatch` with the other batches (profile `batch_index`).
* **Leaving a 🎯 designation is always possible** (fix 2026-10-28): every in-page designation's `finish` IS `activePick` (a wrapper made every exit return early in `pickOnce`); Escape and right-click in the page, Escape in the panel (`withEscape` relays `pick_cancel` for every designation), the page hidden (another tab) or left (`visibilitychange` / `pagehide`), the panel closed (the service worker cancels the picks of `pickTabs` when the last panel port disconnects). Guarded by `tests/extension/pick-exit.test.mjs` on the real runner.
* **adidas audit (2026-10-28, saved page + real export)**: specs no longer read from feature flags (`isConfig`, CONSTANT_CASE groups, on/off values) — `usps` bullets read instead (« Tige : Cuir », « Détails »); RDFa breadcrumbs (`property="itemListElement"`) read on product and list pages; a list « description » that is only a label (`isLabelText`: « Femmes Originals ») gives way to the page's description and is kept as `subtitle`; the audience check (`audienceVerdict`: a « hommes » list vs a card « Femmes … ») flags women's products of a men's list `to_verify_out_of_collection`; a taught text rule on a group of choices reads « 35 1/2 | 36 | … » (`groupedText`).
* **Platform feeds limited to the collection** (`shared/platform/`, moved from `core/`, re-exported there): Shopify `/<locale>/collections/<handle>/products.json`; WooCommerce: the Store API category whose `permalink` is the page (in its `lang`), then `products?category=<id>`; an unresolved collection never falls back to the whole store (`collection_not_resolved`). Used by the app's platform lane and first by the panel (in-page fetch) on a Shopify / WooCommerce collection, the visual read as fallback.
* **AI once per site** (`shared/knowledge/ai-locate.mjs`, `knowledge.aiComplete`): ✨ on a product page asks the model ONLY for the fields that no rule and no generic reader found, on a condensed outline of the page (numbered elements, ~4–10k tokens) plus a summary of the page state; the answers (element numbers or state paths) become ordinary rules (origin 'ai'), checked on other product pages, and replayed without the model. Admin's Claude key; metered in the usage ledger (route `ai-locate`).

## Variants

Field `variants` (tab « Fiche produit », « Variantes (tailles, contenances, couleurs…) »), extract mode `list`. One click on one option takes the smallest block holding ≥ 2 options of the same kind (`growBlock`); `readVariants` (`shared/knowledge/readers.mjs`) reads buttons, swatches (label from aria-label / title / image alt), list entries and `<select>` options: label, price (a price element, else the amount written with its currency — never the volume « 30 ML »), link, code (`data-sku`, `value`…), out of stock (disabled, aria-disabled, sold-out classes), selected. Stored on the row as `variants` ({code, type:'option', name, price, availability, url}); the panel shows them as « 30 ml : 49.99 | 50 ml : 69.99 ». Without a rule the generic reader keeps finding variants from JSON-LD ProductGroup / embedded state (ICI PARIS XL: sizes with price, EAN, stock, link). A ProductGroup's entries that miss an axis the others have (adidas: one entry per OTHER colourway, a link to its own page, no size) are other products, left out when complete entries exist; an axis with one value across the variants (the page's colourway) is left out of their names (since 2026-10-28: « 35 1/2 », « 36 »… instead of « Earth Strata / Off White / Gum / 36 », mixed with the other colourways).

## Without any rule

The generic product-page reader also uses the embedded state: when the JSON-LD description is a short marketing snippet (< 400 characters) and the state holds a much longer description for the page's product, the state text is kept (strategy `generic-state-description`). Seen on a real electronics shop where `description` used to be « Commande le … à … ».

## After « Accepter »

The app answers with the finished rows (description, specs, brand, category read on each product page), bounded to 750 KB for the native link; the panel's table and « Exporter CSV » show them instead of the list preview.

## Pictures (field « Images », knowledge version 3, 2026-10-27)

A picture rule reads `ProductImage[]` (`shared/extract/images.mjs`: absolute
address, alt, position, source, the attribute it came from) with
`readImages` (`shared/knowledge/readers.mjs`): the largest address of each
`<img>` (zoom attributes, `srcset` parsed as the HTML spec says, lazy
attributes, the `<picture>`'s sources, `src`), CSS backgrounds, each picture
once; a picture inside a link to another page of the site (a colour swatch
leading to its own product page, a related product) is never read. A rule
learned with 🎯 stores its **strategy**: `extract.source` (`dom`, or the page's
declaration when it holds the designated picture) and `extract.attr` (the
attribute that gave complete addresses on the teaching page: `srcset`,
`data-zoom-image`, `source@srcset`…), tried first on other pages, the others as
fallback. The check on other pages looks at the **content**: every address must
be complete and usable (`validateValue`), a block holding only a truncated
address fails with the reason, the count is reported (`testRule` → `count`).
The panel preview (`shared/knowledge/preview.mjs`, the only formatter) shows a
thumbnail and the address of each picture — never a property that does not
exist. Older rules (v2) migrate to v3 with `source: 'dom'` and keep working.

## Limits (known)

* Knowledge lives in the local profile; it is **not** pushed to the shared Supabase recipes (no column for it).
* The product-page ✨ detection is deterministic (structured data, embedded state, labelled blocks, DOM), not an LLM call; the LLM assist still handles JSON lists on collection pages only.
* Content that exists only after a click or an XHR is read when the rendered page (local browser) is available and the plain HTML failed every rule on the first pages; otherwise it is reported as a failure.
* A list-page designation is stored as the site's card recipe only when it reads a name and a link; « part of a line » and « list of values » columns stay in the panel (the app's replay cannot read them).

## Autonomous sites (25/10/2026, app 0.5.51 / extension 0.7.26)

* **Schema v2** (`rules.mjs` `migrateKnowledge`, migrated on load after a one-time copy `domain-profiles.before-knowledge-v2.json`): `tests` count OTHER product pages only; the teaching page is kept apart (`tests.taught`) and outcomes read on it are ignored — a rule checked nowhere else says « pas encore testée sur d’autres fiches », never « 1/1 ».
* **Ordered strategies per rule** (`rule.strategies`: `jsonld | microdata | meta | dom | state`, each `requires: static | browser`, optional `action.expand`): what the page DECLARES for the field (`shared/knowledge/structured.mjs`: JSON-LD incl. ProductGroup variants, microdata offers, product meta) comes first for a short field the user designated on that very value, as a fallback for a text (paragraphs kept from the block); then the block, its learned state key, the declared value, the guessed state key. Generated classes (CSS modules, CSS-in-JS, React ids) and utility classes are left out of new block selectors and ignored in old fingerprints. Site feature switches are refused as specs. Folded sections (accordions, `<details>`) are opened before a product page is read (`pick-block.mjs` `expandFoldedSections`, app browser + extension).
* **Typed fields**: `price` / `list_price` (amount + currency, page currency as fallback), `name`, `ean` (GS1 check digit), `brand` (short text) — a failed check is a rule failure.
* **Fragile rules flagged** (`auditRule`): positional, generated, shared block, failing, untested — with what to do, shown in « Fiche produit »; never deleted.
* **Self-healing** (`knowledge.repair`, after every real run): a rule the run made fail gets a replacement from declared data → detection → (last, counted) the app's AI; kept if it reads on ≥ 2 pages; applied for an AI rule, proposed for a manual one; `knowledge.repairs` + `knowledge.log`; accept / reject / undo in the panel.
* **First discovery** (`knowledge.onboard`, once per site, no extra request): every standard field from the pages the run read (declared → detection, also the list's values, a breadcrumb, the image named like the product, a stock line → ONE AI call for the rest); report `onboarding` per field (found, via, strategy, confidence, tests) and `aiCalls {discovery, repair, chat}`. Rules found automatically never make a run open pages it would not have opened.
* **Access per site**: product pages `detailAccess` (http | browser | extension, 7 days), lists `listAccess` (app | extension): a site that refuses the app is scraped in the user's browser (automatically after a refused run, directly next time).
* **Product pages in the user's browser for app-launched jobs** (`interpret.mjs` `followLinks` + `onDetailPage`, « Fiches produit » limit, same site, challenge → pause).
* **Chat agent** (`app/ai/agent.mjs`, panel tab « Agent »): tool loop in the app (`propose_recipe`, `inspect_page`, `test_selector`, `save_recipe`, `highlight_element`), model `ai.agentModel` (default `claude-opus-5-5`).
* **recipes.json** (`core/recipes-file.mjs`): export / preview / apply in Settings and in the panel's Réglages.
