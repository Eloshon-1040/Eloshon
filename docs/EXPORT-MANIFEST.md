# Export manifest (contract 1)

Every export of Eloshon Scraper says what it really holds, so an incomplete export can never pass for a
complete one. One shape, built by `shared/export/manifest.mjs` (`buildManifest`), written by the extension
and the app, read by the Converter (`converter/core/knowledge-proposal/export-manifest.mjs`).

## Where it lives

| Export | Manifest |
|---|---|
| Extension panel « Exporter CSV » | a second file beside the CSV, same name: `eloshon-<site>-<AAAAMMJJ-hhmmss>.csv` + `….manifest.json` |
| App job | `data\jobs\<JOB>\manifest.json` and `data\csv\<JOB>.manifest.json` (beside the job CSV) |
| `.eloshon` | the envelope header, `eloshon.manifest` |

## Shape

```json
{
  "kind": "eloshon.export-manifest", "contract": 1,
  "source": "extension", "sourceVersion": "0.7.31", "createdAt": "2026-10-28T10:00:00.000Z",
  "site": "shop.test", "listUrl": "https://shop.test/parfums", "jobId": null, "jobStatus": null,
  "status": "preview",
  "rows": 864,
  "productPages": { "toRead": 864, "read": 2, "blocked": 1, "notOpened": 861,
    "byReason": { "human_check": 1, "not_opened": 861 }, "limit": null,
    "list": [{ "url": "https://shop.test/p/1", "reason": "human_check" }] },
  "rulesFailing": [{ "field": "variants", "reason": "…" }],
  "truncated": { "rows": 40, "reason": "reply_incomplete" },
  "fill": { "description": { "label": "Description", "filled": 2, "total": 864 } },
  "export": { "file": "eloshon-shop.test-20261028-100000.csv", "format": "csv", "columns": ["Nom", "Prix"] }
}
```

- `status` is derived, never declared: `preview` until the rows are accepted; `complete` only when every
  product page to read was read, none was blocked or left unopened, no site rule failed, no row was cut and
  the job is not PARTIAL; `partial` otherwise.
- `productPages.list` names at most 500 pages; the counts (`blocked`, `notOpened`, `byReason`) stay exact.
- Page reasons: `human_check`, `failed`, `denied`, `limit`, `time`, `stopped`, `not_opened`.
- `listMethod` (optional, added 2026-10-28): how the panel read the list (« données publiques de la boutique (WooCommerce) »,
  « carte produit apprise », « détection automatique »…), so an export says where its rows come from.
- A listed page may carry `detail` (optional, added 2026-10-28, contract unchanged): why it failed, in words
  (« la page ne s’est pas chargée en 25 s », `page_too_large`…). Readers that do not know it ignore it.
- In a `preview`, the pages counted read / blocked are the few the panel opened for its preview (3 at most);
  the others are `not_opened` because « Accepter » has not run yet — not because a reading stopped.
- `fill` is computed on the exported cells (`columnFill`): a value is a non-empty string, a finite number,
  a non-empty list or object.
- A reader must accept a higher `contract` and read the fields it knows.

## « Accepter » in the extension: a persisted queue, no silent cap

`extension/background/enrich-queue.mjs` (since extension 0.7.31):

- Every row's own product page is read, in batches of two tabs in a minimized window, to the end. There is
  no fixed cap any more (the old `SUBPAGES_MAX` = 300 cut silently). The only limit is the user's
  « Fiches produit à lire » (Pages tab, 0 = all): announced on the state line before « Accepter », the pages
  beyond it listed with the reason `limit`.
- The queue is written to `chrome.storage.local` after every page (`enrich:<runId>`, rows in
  `enrichPayload:<runId>`). A service worker Chrome puts to sleep takes the run up when it wakes
  (`resumeEnrichments`); the panel follows the queue through `chrome.storage.onChanged` and finds it again
  when reopened.
- A human check pauses the run: « Ouvrir la fiche », « Reprendre » (the page is opened again), « Ignorer
  cette fiche », « Terminer maintenant » (pages left are listed as `stopped`). « Arrêter et enregistrer ce qui
  est lu » ends a run at any time.
- The app sends the job's finished rows back in chunks under the 1 MB native-link limit (`op 'rows'`,
  `finishedRows(products, { offset })`); the panel merges each chunk into its rows by canonical URL
  (`shared/export/merge-rows.mjs`) and never replaces them with a shorter list. Rows that could not be
  received are counted in the manifest (`truncated`).
- App-side bounds no longer cut in silence: the rendered-page cache holds as many pages as a run holds rows
  (5000), keeps them 3 h (`op 'page_keep'` for a paused run) and answers why a page is refused
  (`page_too_large`, `run_full`, `memory_full`); `jobProducts` is read without its 2000-row display limit.

## Job reports (app 0.5.56)

- `applyPartialStatus` (`core/engine.mjs`): PARTIAL, never OK, when rows are to verify, product pages failed
  or were skipped, the app's own browser stopped re-reading (`browserPagesStop`, with `browserPagesNotRead`),
  the extension left product pages unread for the job (`yourBrowserPages`), or a site rule failed on the
  pages read (`knowledgeInvalidated`). `report.partial` names each cause.
- `report.txt`: « relectures par le navigateur de l'app » replaces « pages via browser » (the app's own
  browser, not the extension) with « ce navigateur n'a pas pu relire N fiche(s), l'extension en a lu M »;
  « products read by » replaces « extraction by »; new lines « extension pages », « fill rate »,
  « time spent », « export manifest ».
- `report.fill` (`core/fill-rate.mjs`, shared with `scripts/ops-last-scraps.mjs`): fill rate per field.
- `report.timings`: `extension` (list, pacing wait, page loads, human-check guard, settle, page reads —
  measured by `shared/dsl/interpret.mjs`) and `app` (list, product pages, of which browser re-reads, stock &
  reviews, export, normalise & record).
- The 1132 s of job 20261028005908-3oq7x (36 product pages in the extension): the extension's pacer weighed
  the whole page build of each product page (scripts, images, trackers; often > 2.5 s) as server latency
  and multiplied the spacing by 1.4 per page up to its 30 s ceiling. It now weighs the server's own time
  (Navigation Timing, request → first byte, `readContext().serverMs`). Simulation with 4 s page builds
  (`core/__tests__/honest-report.test.mjs`): 919 s (667 s of pacing wait) before, 258 s (6 s) after.
  The real job's split was not recorded at the time; the next run's « time spent » line shows it.

## In the Converter (0.1.10)

- The extension panel's CSV (template « Produits », French names) is a Reference format,
  `extension.panel-csv.fr.v1`: recognised with no mapping. Its signature is `closed`: a column the user added
  leaves the file to semantic recognition (or to the manifest's roles), never kept raw.
- The « Variantes » cell (`30 ML : 77.7 | 50 ML : 115.5 (épuisé)`, or `S, M, L`) becomes real variants:
  one per value, its own price, « épuisé » = stock 0, the axis named from the values (Contenance, Taille)
  (`core/knowledge-proposal/variant-text.mjs`, `structure.variants.parseText`).
- The manifest is read beside the opened file (`app/manifest-sidecar.mjs`): `<name>.manifest.json`,
  `manifest.json` beside a job's products.json, or the `.eloshon` header. Step 2 shows it (nearly empty columns, what
  to do, « Choisir un autre fichier »). A preview says what the extension opened FOR it and that the others wait, not
  that a reading stopped (since 2026-10-28): « Aperçu de l’extension : 3 fiche(s) produit ouverte(s) sur 864 à lire.
  2 lue(s), 1 bloquée(s) par une vérification humaine. Les 861 autres ne sont pas encore lues : l’aperçu n’en ouvre
  que quelques-unes. » (before: « 2 fiche(s) lue(s) sur 864 … 861 non ouverte(s) »).
  A dropped file has no path in Electron 44 without `webUtils` in the preload (security work kept apart):
  only an `.eloshon` header is read then.
- Column roles in the manifest build a format of their own (`formatFromManifest`): renamed columns are
  recognised; columns that each list one axis (« Coloris » = "Blanc, Noir", « Pointure » = "40 | 41 | 42")
  give every combination as a variant (`structure.variants.axes`).
- A file in learn mode converts with the user's column choices before « Mémoriser ce format » (the step-3
  preview no longer says « Format non reconnu » when every column is mapped).
- Step 3 counts every row of the file (20 000 spread rows beyond that, said in the header); a column's type is
  read on its filled values.
- Shopify: a « Collection » column shows both columns it lands in (Product Category, and Tags for
  automated collections, the default).

## Fixed values for a whole scrape (« Valeurs fixes », after 0.5.56)

Typed once in the panel's « Champs » tab and given to EVERY product of the scrape, instead of designating a block
on each page (a breadcrumb only found by its place, a brand the site does not write). Logic in
`shared/export/constants.mjs`, shared by the panel, the app and the tests.

- Established terms only, never a free name, so the Converter recognises each column by its name with no guess:
  Marque (`brand`), Collection (`category`), Type de produit (`product_type`), Étiquettes (`tags`), Statut à
  l’import (`status`: Brouillon → `draft`, Actif → `active`), and the attributes Genre, Matière, Saison, Pays
  d’origine, Garantie (`attribute`, key = the term). A free attribute name is dropped by `normalizeConstants`.
- Mode per value: « pour tous les produits » (`always`, the default) replaces what the pages read; « seulement si
  la page n’en donne pas » (`empty`) keeps the page's own value. Tags are always ADDED to the existing ones.
  Status is always `always`.
- Two levels (since 2026-10-28, `shared/export/site-values.mjs`): the SITE profile keeps the brand (and the panel's
  fields); each LIST PAGE is a batch (`batchKeyOf`: host + path + category facets, without paging / sorting /
  tracking parameters, e.g. `adidas.be/fr/chaussures-hommes`) that keeps collection, type, tags, status and the
  attributes. In the extension: `panelState[origin].constants` (site level only) and `panelBatches[batchKey]`; the
  panel reloads both when the tab shows another site or another list page (a product page stays in its list's
  batch). « Enregistrer » saves them in the app (domain profile `site_values` + `list_batches`, panel op
  `site_values`, exported in recipes.json); the panel says « enregistré / modifié, non enregistré / aucun… ».
- A job the APP starts on a page (its own engine, or run in the user's browser) gets the saved site + batch values
  of that page (`storedConstantsFor`; a product type typed in the app's form wins); « Accepter » sends what the
  panel shows, which wins. `report.fixedValues` says which values were stamped and from where (`panel` / `saved`).
- « Collection » offers the breadcrumb of the list read.

## Custom fields (« cases personnalisées », since 2026-10-28)

- In the panel, every field has a « Rôle pour le Converter »: a pivot field (Type de produit, Marque, Collection,
  Étiquettes…) or « personnalisée » (role id `attribute`, unchanged: the label now says its column is chosen in the
  Converter). There is no platform choice in the extension.
- In the Converter, a Scraper file's descriptive attributes — a products.json `raw.columns.<key>` that no rule reads
  (`structure.customColumns`, before 28/10 it was lost on every target), a manifest column of role `attribute`, the
  fixed attributes Genre / Matière… — and, on a target with no Type column, the product type, are PLACED per platform
  (`converter/core/src/custom-fields.ts`, `result.customFields`). Default places (nothing lost): Shopify → metafield
  `custom.<key>`; WooCommerce → attribute (visible); Wix → a « Nom : valeur » line in the description, the type as a
  category; BigCommerce → the description. Other places per platform: Tags, Type, Meta:, Categories, Wix ribbon, « Ne pas
  exporter ». Every row lists the places in one order and marks the default (`fallback`) « (par défaut) ».
- Verified in the official docs (28/10): WooCommerce's CSV `Type` takes `simple / variable / grouped / external`
  only — no free product type (Categories, Tags or an attribute instead); Wix's V3 product CSV has no type column and
  no info-section column (categories are its only classification; `ribbon` is a 30-character badge).
- Step 3, card « Champs de {plateforme} non alimentés » → « Vos cases personnalisées »: one choice per field, per
  platform, remembered on the computer (`config.json` `customTargets`) and saved in the mapping templates
  (`templates.json` `customTargets`). A platform-to-platform conversion is not affected.
- Panel: the values are applied to the table, the CSV and the manifest (each column with its role). « Accepter »
  sends them (`constants`) through the persisted queue; the app validates them again and applies them to every
  recorded product (`applyConstantsToProduct`: brand → `raw.brand`, collection → `source_category`, type →
  `product_type`, tags / status / attributes → `raw.columns`).
- Converter: `extension.panel-csv.fr.v1` and `scraper.products-json.v2` read these columns (Shopify Vendor, Type,
  Tags, Status, Product Category; attributes as named attributes for WooCommerce, Wix…).
