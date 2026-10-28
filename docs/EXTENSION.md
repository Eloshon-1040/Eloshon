# Eloshon Scraper — "your browser" tier (v0.6.0)

The browser extension is the **executor** tier: a real Chrome/Edge/Brave running
with the user's own IP, session and login. The engine, config, validation,
storage, exports, budget and paid-provider credentials all stay in the desktop
app. One shared set of recipes / extractors / pacing / challenge logic
(`shared/`) is used by both the app and the extension — never two diverging
copies (the extension ships a build-copied snapshot in `extension/vendor/shared/`).

## Architecture

```
desktop app  ──named pipe (pairing secret)──  native host  ──stdio native msg──  extension (MV3)
  controller        app/your-browser/bridge        native-host/host.mjs        background/service-worker
  tier contract     HostBridge + auth               framing + relay             TabDriver -> real tab
  (app/your-browser/tier.mjs)                                                    shared interpreter + pacer + challenge
```

- **Shared foundation** (`shared/`, portable, zero deps): `recipe/` (versioned
  format + migration), `dsl/` (action schema, validator, interpreter), `pacing/`
  (adaptive token bucket), `challenge/` (config-driven detection + pluggable
  strategies), `protocol/` (versioned messages), `job/` (state machine + resumable
  dedup store), `extract/` + `internal-api.mjs` (field mapping + API replay).
- **Extension** (`extension/`): MV3 service worker orchestrates; the in-page
  runner reads the live DOM / embedded state and runs in-page fetch; the
  interpreter's `env.page` is bound to the tab by `TabDriver`.
- **Native host** (`native-host/`): a thin, protocol-validating relay. Ships with
  the desktop installer, **not** in the extension zip.
  - Lifecycle (app 0.5.43, extension 0.7.18): the browser starts the host as
    `Eloshon Scraper.exe …\native-host\host.mjs`, i.e. under the app's own name. The
    extension keeps **one** link (`NativeLink.ensure()` never opens a second port or a
    second reconnect loop), the host exits after 8 s without the app
    (`native-host/idle.mjs`), the retry delay grows to 5 minutes while the app stays
    closed, and a panel request retries at once (`connectNow()`). The NSIS installer
    stops leftover relays (matched by command line) before installing/uninstalling
    (`build/installer.nsh`). Before this, several relays stayed alive after the app was
    closed and blocked new installations.

## Site knowledge

Rules taught on product pages (tab « Fiche produit ») — see `docs/SITE-KNOWLEDGE.md`.

## Execution modes (chosen per recipe, from data)

`internal_api` (replay the site's JSON API in the page session) · `embedded_state`
(`__NEXT_DATA__`/JSON-LD/…) · `dom` (selectors) · `actions` (the DSL) · combos
(list → detail via `followLinks`). A recipe with no `actions` gets a default
single-lane program from its `mode`.

## The tier contract (for the future chain)

`runYourBrowserTier(session, spec)` → `{ status, products, counts, reason, tryNextTier }`.
`status: done` = success; `blocked` = this tier can't (challenge/hand-back) →
`tryNextTier: true` so the chain calls the next tier (paid provider). This is the
clean seam; the full multi-provider fallback chain is a separate backlog item.

Per-domain opt-in (`isYourBrowserEnabled(config, domain)`) and per-domain pacing
(`pacingConfigFor(config)`) read `config.yourBrowser.perDomain[domain]`.

## Design note — future hooks (where each plugs in, reserved fields)

These are **not built** here; the architecture already has the seam so none needs
a rewrite. Reserved recipe keys are declared in `shared/recipe/schema.mjs`
(`RECIPE_KEYS`).

| Future feature | Seam | Reserved data |
|---|---|---|
| Click-to-teach picker (freely named columns) | a new DSL op + a `teach` recipe block authored from the page; interpreter already maps arbitrary `field_map` keys → columns | `recipe.teach` |
| Automatic sub-page / detail detection | `followLinks` already exists; a detector proposes `url_field` + a detail `extract` spec | `recipe.subpages` |
| Export to Shopify / Woo / Wix | app-side, consumes the tier's product shape (already normalized by `mapItem`) | `recipe.export_profiles` |
| Scheduled jobs | app schedules `job` messages; the job model is already resumable/idempotent | — |
| Recipe reuse across similar sites | `supersedes()` + `reuse_of` pointer; migration-safe format | `recipe.reuse_of`, `recipe.revision` |
| Product "to verify" status | normalize already emits `to_verify`; carried through the tier result | `recipe.status_rules` |
| Licensing | an opaque licence token checked by the **app** (never by extension logic); the tier contract is the gate point | `recipe.license_scope` |

## Side panel (extension 0.7.4, app 0.5.22)

The side panel scrapes the page open in the user's own tab. Three actions:

| Button | What it does | Where the logic lives |
|---|---|---|
| **▶ Exécuter maintenant** | Reads the page with the site's learned card recipe (asked from the app, `panel_request` op `recipe`), merged with the fields the user designated; without a recipe, the automatic detection (JSON-LD, embedded JSON, DOM grid). Then loads more products like the site does: a real "load more" control (button, or a link that stays on the list page, short label) and scrolling, until the maximum, the end of the list (two rounds without a new row), a navigation away, or 4 minutes. Progress is pushed to the panel. | `extension/background/panel-run.mjs` (loop, unit-tested), `shared/extract/card-recipe.mjs` (`readCards`, `mergeRecipe`), runner `readRecipeCards` / `loadMoreOnce` / `pagePath` |
| **🎯 Désigner à la souris** | The page shows a highlight; the user clicks the element of one product card that holds the field. Under a full-card link overlay, the element meant is chosen from the pointer stack (link field → the link, image field → the image, otherwise the smallest element with its own text). The repeated card is the known recipe card, or derived ("find similar": the highest ancestor repeating as often as the first repeated ancestor holding a link). The field selector is relative to the card (leaf, then with ancestors, else a positional path). Unstable class names (CSS-in-JS hashes, state flags) are never used. A price field (by its name: "Prix", "Prix promo", "Prix barré"…) is picked WHOLE: a price split over elements ("649," + `<sup>99</sup>`, "399," + "-") climbs to the smallest element holding the complete amount, never to one holding a second amount (the struck price). Text read from a card ignores the style sheets / scripts some sites render inside it. A free column (not name / price / link / image / description / reference) clicked on ONE piece of a line ("Charleroi" in "Chambre · Charleroi") keeps only that piece on every card: the separator (the middle dots `·` `⋅` `∙` as one, `•` `|`, or `–` `-` `/` `,` with spaces) and the piece's position (counted from the end when it is the last) are stored with the field (`part`); « texte entier » in the panel drops it. While hovering, the highlight shows the piece that a click takes. The position clicked is found by geometry, so a link laid over the card does not hide it. Columns the user designated are kept even when the rows have no name or price (a lodging, a directory): the automatic detection never replaces them. A field whose name means a list of values ("Tailles", "Longueurs", "Couleurs", "Options"… `isListField`) takes the whole group of small same-kind entries around the click ("28 | 29 | 30"; a swatch without text gives its label); on listing cards it is read per card. On a **product page** (the shared classifier says "product"), the page itself is the card (`body`): any element can be designated, the row's link is the page, and the page's own structured data (name, price, image) completes the designated columns. Accepted rows keep the user's columns in `raw.columns`. A right click or Escape cancels (the keyboard stays in the side panel, which forwards Escape to the page: `pick_cancel` → runner `cancelPick`); 2 minutes without a click stops. | `shared/extract/pick-selector.mjs` (`pickField`, `chooseFromStack`, `wholeAmountElement`), runner `pick` / `cancelPick` |
| **✨ Détecter par IA** | Sends the page's data to the model through the app (the key stays in the app): the JSON islands, the lists that look like products in the page's inline state (`embeddedJsonValues` + `productArraySources`: menus and breadcrumbs score 0 and are not sent), the captured answers; at most ~800 KB (the link to the app takes 1 MB). No list found → the rows already shown are kept. | `extension/background/service-worker.mjs` (`aiCollectAndAssist`), `shared/extract/ai-assist.mjs` |
| **✓ Accepter** | Sends the previewed rows to the app (`panel_request` op `ingest`): validated and bounded app-side (5,000 rows, typed known fields, ≤ 20 extra text fields, http(s) URLs only), recorded as a normal job (normalise → eligibility → CSV/report, usage ledger `extension` line). With **Sous-pages** on, each product page is read first (same free completion as a listing lane). | `app/your-browser/panel-requests.mjs`, `controller.ingestExternalProducts({ completeDetails })` |

The panel keeps, per site origin, the fields, the designated selectors and the card. Choosing another template clears the designations. Templates: **Produits** (name, price, **struck price**, **brand**, **collection**, image, link, reference), **Locations (hébergements)** (title, lodging type, city, dates, host, price, rating, image, link), videos, articles, contacts, generic. The automatic read keeps a card's price before reduction (`regular` / `listPrice` / an `original` entry of a price list) as the struck price, and the card's brand (`brand` / `brands[0]` / `manufacturer`) and own category (`category.title`, never a code). A card recipe without an image field takes the thumbnail next to the card when every link of that block leads to the same product.

Protocol: `panel_request` (extension → app, `op` required) and `panel_result` (app → extension, echoes the request id), same envelope and validation as `ai_request` / `ai_result`. The native host relay validates both.

## Pacing & challenges (fixed boundaries)

Adaptive per-domain pacing (token bucket, jitter, Retry-After, backoff on
429/456/403/challenge, latency-aware, gentle restart) — all thresholds from config,
conservative defaults. Challenges are handled by pluggable strategies
(`human_in_the_loop`, `cooldown_retry`, `hand_back`); detection is 100% config-driven.
**Hard boundary (never changes):** no captcha solving, no fingerprint/identity
spoofing, no IP rotation, and the extension never clicks or types inside a
challenge. Its power is being a real browser.

## Field-test protocol (polite by design)

At most **3 listing pages + 5 detail pages per site per run**, adaptive pacing on.
This is a test-protocol choice to protect the operator's IP, not a product cap —
the engine's limits come from config (`limits.maxListPages` / `maxDetailPages`).

### Verdict table (fill during Phase 2, on a loaded extension)

| Site | Loaded/Blocked | Status codes | Challenge shown | Strategy | Human solve time | Resume correct? | Challenge recurrences | Products | Fill % (name/price/image/url/id) | Time/page | Pacing decisions | Bytes | **Verdict** |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Adidas (Akamai) | | | | | | | | | | | | | |
| Leroy Merlin (DataDome) | | | | | | | | | | | | | |
| Delhaize | | | | | | | | | | | | | |
| Colruyt (control, store from config) | | | | | | | | | | | | | |

"**Pass with human intervention**" is its own verdict (it changes the customer
promise). The verdict prioritises per-site recipes; it does **not** gate the
foundation.

## Store / distribution checklist

- Stable dev ID: `acpkobbipplbgncgjkabebhmpojlndge` (from the pinned public `key`;
  private `.pem` is git-ignored, never committed).
- `npm run package:extension` → `dist-extension/…zip` (manifest at root, `key`
  stripped, runtime-only). `npm run verify:extension` must pass.
- **After publication:** update the native host manifest `allowed_origins` with the
  **store-assigned** extension ID (unless a fixed ID is chosen in the developer
  dashboard). Regenerate with `npm run host:gen` once the ID is known.
- The store listing must **disclose** that the Eloshon Scraper desktop app must be
  installed (Native Messaging).
- **Edge Add-ons (Partner Center) is a separate submission.** The same zip works;
  Edge accepts the `chrome-extension://` origin form for the native host.
- Permission justifications: `docs/extension-permissions.json` (checked by the verifier).
