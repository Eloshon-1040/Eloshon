# Wix Stores (Catalog V3) — inventaire réel des champs produit

État au 2026-09-21 (mise à jour : données réelles). Site `My Site`
(`example-store.wixstudio.com/my-site`, Wix Studio, **Catalog V3**), lu par l'API
REST avec la clé de compte de `.env.local` (`Authorization: <clé>`,
`wix-account-id` tiré du JWT de la clé, `wix-site-id`) — script
`scratch/tools/wix-extract.mjs`. Fixture figée : `test/fixtures/live/wix-test/`
(13 produits, dont « Pull de golf en tricot » 16 variantes × 2 options et
« Boloss 400 » avec SKU, code-barres, coût, prix barré, poids, prix à l'unité,
dimensions de colis, précommande).

`[OBSERVATION]` Sur un site V3, **tous les endpoints V1/V2** (`stores/v1/products`,
`stores/v1/collections`, `stores/v2/inventoryItems`) répondent **428**
« Endpoint belongs to CATALOG_V1, but your site is using CATALOG_V3 » — la
génération du catalogue est une propriété du site, pas un choix d'appel.
`POST /stores/v3/products/search` ne renvoie qu'un `variantSummary` ;
`GET /stores/v3/products/{id}?fields=…` (paramètre répété, 22 valeurs de
l'enum) renvoie le produit complet **avec `variantsInfo`** : c'est l'unité de
la fixture (35 clés). Les montants sont des chaînes (`"24.00"`), avec un
`formattedAmount` localisé.

## 1. Identité

| Champ | Observé | Notes |
|---|---|---|
| `id` (uuid), `numericId`, `revision`, `createdDate`, `updatedDate`, `entityEventSequence` | | |
| `name`, `slug`, `handle` (`Product_<uuid>`, interne), `url { relativePath, url }` | | `slug` = le handle canon |
| `visible`, `visibleInPos` | bool | |
| `productType` | `PHYSICAL` / `DIGITAL` | → `kind` (+ `requiresShipping`) |
| `description` | **rich content** (arbre `nodes[]`) | `plainDescription` = le rendu HTML (`<p>…</p>`) → `bodyHtml` |
| `brand { id, name }` (ressource `stores/v3/brands`), `ribbon { id, name }` + `additionalRibbons[]` (ressource `ribbons`), `tags { privateTags { tagIds[] } }` | | ribbons = badges (« Meilleure vente ») → metafield `wix_ribbon` comme aujourd'hui |
| `infoSections[] { id, uniqueName, title, description (rich), plainDescription }` (ressource `info-sections`) | 3 sections partagées | → metafields `info_*` (parité parser CSV) |
| `mainCategoryId`, `directCategoriesInfo.categories[] { id }`, `allCategoriesInfo`, `directCategoryIdsInfo`, `breadcrumbsInfo.breadcrumbs[] { categoryId, categoryName, categorySlug }` | | **catégories hiérarchiques** (Categories API, `treeReference.appNamespace: "@wix/stores"`) — V1 n'avait que des collections plates |
| `currency` | `EUR` | par site |

## 2. Prix (par variante ; agrégats produit)

`variantsInfo.variants[].price { actualPrice { amount }, compareAtPrice? }` ;
`revenueDetails { cost, profit, profitMargin }` ; produit :
`actualPriceRange`, `compareAtPriceRange`, `costRange`, `minVariantPriceInfo`,
`variantSummary.minPriceVariant`. `physicalProperties.pricePerUnit { settings
{ quantity, measurementUnit }, value, description }` (prix à l'unité de
référence, « 38,40€ / 800 g »). Pas de palier de quantité ni de prix par
groupe client (**C1 : non natif**), pas de prix Omnibus (**C2 : non natif**).

## 3. Identifiants (P3)

`sku`, **`barcode`** (un seul, non typé — `957466585647485` observé) par
variante → `barcode` natif ; pas d'ean/upc/mpn distincts.

## 4. Variantes / options / modificateurs

- `options[] { id, name, key, optionRenderType (TEXT_CHOICES / SWATCH_CHOICES),
  choicesSettings.choices[] { choiceId, key, name, choiceType (ONE_COLOR…),
  colorCode, linkedMedia[], inStock, visible } }` — **ids stables par valeur**
  (comme Shopify `ProductOptionValue`), couleur hex sur les swatches.
- `variantsInfo.variants[] { id, visible, sku, barcode, choices[] {
  optionChoiceIds { optionId, choiceId }, optionChoiceNames { optionName,
  choiceName, renderType } }, price, revenueDetails, physicalProperties
  { weight, pricePerUnit, packageDimensions { length, width, height, unit } },
  inventoryStatus { inStock, preorderEnabled }, subscriptionPricesInfo, media? }`.
  Tout explicite par variante (modèle Shopify) ; **poids et dimensions par
  variante**, unité de poids au niveau produit
  (`physicalProperties.weightMeasurementUnitInfo.weightMeasurementUnit: KG`).
- `modifiers[]` / `customizations` (`customizationType: MODIFIER`,
  `FREE_TEXT` : « Carte cadeau ») = champs de personnalisation à l'achat
  (≈ `customTextFields` V1) — pas des options.
- `flattenOptions` / `flattenModifiers` : vues aplaties.

## 5. Stock

Produit : `inventory { availabilityStatus (IN_STOCK…), preorderStatus
(ENABLED / DISABLED), preorderAvailability }` ; par variante
`inventoryStatus { inStock, preorderEnabled }` ; quantités dans la ressource
**`stores/v3/inventory-items`** (par variante × `locationId` :
`trackQuantity`, `quantity`, `inStock`, `availabilityStatus`, `preorderInfo`).

## 6. Physique / livraison

`physicalProperties { shippingGroupId, deliveryProfileId, shippingWeightRange,
pricePerUnitRange, weightMeasurementUnitInfo }` ; par variante `weight`,
`packageDimensions` (cm observé).

## 7. Média / SEO

`media { main { image { url, width, height, filename }, thumbnail, mediaType },
itemsInfo }` ; par choix d'option `linkedMedia[]`. **Pas de `seoData`** dans
la réponse V3 produit (SEO Wix = ressource séparée) ; `url` calculée.

## 8. P1 / P2 / bundles

Traductions : non natives (app Wix Multilingual). Metafields : aucun
namespace public typé (`extendedFields`/`merchantData` app). Bundles : non
natifs. `tags.privateTags.tagIds[]` = ids d'étiquettes privées (ressource
non publique).

## 9. Comparaison avec le CSV d'import Wix (`wix.products.csv.v1`, 5.1)

Le CSV (V1) est plat : `handleId`, `fieldType` (Product / Variant), `name`,
`description`, `productImageUrl`, `collection`, `sku`, `ribbon`, `price`,
`surcharge`, `visible`, `discountMode/Value`, `inventory`, `weight`, `cost`,
`productOptionName/Type/Description1..6`, `additionalInfoTitle/Description1..6`,
`customTextField1..2`, `brand`. V3 ajoute par rapport au CSV : code-barres,
prix barré par variante, dimensions, prix à l'unité, catégories hiérarchiques,
ids stables par valeur d'option, précommande, `visibleInPos`.
