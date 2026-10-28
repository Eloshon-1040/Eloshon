# Shopify Admin GraphQL — inventaire réel des champs produit

État au 2026-09-21. Données tirées d'une **vraie boutique de développement**
(`example-store.myshopify.com`, plan Development, France/EUR) via le MCP
Shopify **déjà connecté** — `graphql_query` (Admin GraphQL API, lecture seule),
après `graphql_schema` (Product, ProductVariant, InventoryItem) et
`validate_graphql_codeblocks`. Comparé, comme demandé, à la même profondeur
que les analyses WooCommerce REST et Shopware Admin API.

**Chemin utilisé** : MCP direct — pas de script de secours. Le MCP Shopify
connecté n'est pas limité à de l'assistance dev/setup : `search_products`,
`get-product`, `get-shop-info` interrogent la vraie boutique, et
`graphql_query` donne un accès en lecture à l'intégralité du schéma Admin
GraphQL. Aucun identifiant Supabase n'a été nécessaire (le projet Supabase
connecté — backend du Scraper — ne contient d'ailleurs aucun secret Shopify :
`vault.secrets` vide, `app_config` ne concerne que la cascade de providers de
scraping).

Produits réels utilisés :
- **`Qnubu - Sacs à presse`** — 14 variantes réelles (2 options : Taille × Taille des mailles, 2×7).
- **`Pack Advanced Nutrients - expert`** — 9 variantes réelles (2 options : Base × Capacité, 3×3, matrice complète).
- **`Bionova Coco Brick - 1 x 10 Litres`** — produit simple, option `Title` = `Default Title` (le mécanisme Shopify natif pour "pas de variantes").

## 1. Identité

| Champ | Type observé | Notes |
|---|---|---|
| `id` | GID (`gid://shopify/Product/...`) | Identifiant opaque, jamais un entier nu |
| `handle` | string | Slug URL, unique |
| `title` | string | — |
| `status` | enum | `ACTIVE` \| `ARCHIVED` \| `DRAFT` |
| `createdAt` / `updatedAt` / `publishedAt` | ISO 8601 | `publishedAt` distinct de `createdAt` (peut être `null` si jamais publié) |
| `templateSuffix` | string \| null | Thème Liquid personnalisé pour la fiche produit — présentation, pas donnée catalogue |
| `onlineStoreUrl` | URL \| null | `null` si le produit n'est pas publié sur le canal Online Store |
| `category` | objet `TaxonomyCategory` | **Taxonomie standard Shopify** : `{ id, name, fullName }`, ex. `"Maison et jardin > Plantes > Kits de plantation"`. Un produit non catégorisé a `fullName: "Non classé"`. Distinct de `productType` (texte libre) ET de `collections` (assignation manuelle) |
| `productType` | string libre | Ex. `"substrat"`, `"engrais"` — indépendant de `category` |
| `vendor` | string | — |
| `tags[]` | string[] | — |

## 2. Prix

| Champ | Type | Notes |
|---|---|---|
| `variant.price` | Money (string décimale) | Toujours explicite sur CHAQUE variante — jamais hérité, jamais vide |
| `variant.compareAtPrice` | Money \| null | Prix barré ; `null` dans les 3 produits réels observés (aucune promo active sur cette boutique) |
| `variant.unitPrice` / `unitPriceMeasurement` | objet \| null | Prix à l'unité de référence (ex. €/kg) — même concept que `referenceUnit`/`unitId` Shopware, `null` quand non configuré |
| `product.priceRangeV2` | `{ minVariantPrice, maxVariantPrice }` | Calculé, pas stocké — plage de prix du produit |
| `product.compareAtPriceRange` | idem, ou `null` en bloc si aucune variante n'a de `compareAtPrice` |

**Comparaison** : pas de règle métier ni de palier de quantité au niveau de
l'API produit (contrairement à Shopware `prices[]` avec `ruleId` +
`quantityStart/End`) — les remises par quantité/règle client existent côté
Shopify mais via des objets séparés (Price Rules / Discounts, Selling Plans),
pas sur le produit lui-même.

## 3. Stock / politique d'inventaire

| Champ | Type | Notes |
|---|---|---|
| `variant.inventoryItem.tracked` | bool | Suivi de stock activé pour CETTE variante — observé `false` sur une variante du même produit où les autres ont `true` (mix possible au sein d'un seul produit) |
| `variant.inventoryQuantity` | int | Quantité vendable totale (toutes localisations agrégées au niveau de ce champ racine) |
| `variant.inventoryPolicy` | enum | `DENY` \| `CONTINUE` — autoriser la vente à stock épuisé (équivalent `backorders`) |
| `variant.availableForSale` | bool | Calculé (tient compte de `inventoryPolicy` + stock + statut produit) |
| `variant.inventoryItem.measurement.weight` | `{ value, unit }` | Unité **par variante**, pas globale (`GRAMS` ou `KILOGRAMS` observés sur le même produit selon la variante — pas de conversion automatique, chaque variante déclare sa propre unité) |
| `variant.inventoryItem.requiresShipping` | bool | — |
| `variant.inventoryItem.harmonizedSystemCode` / `countryCodeOfOrigin` | string \| null | Code douanier + pays d'origine — **par variante**, jamais peuplés dans l'échantillon mais le champ existe (comparable à `manufacturerNumber`/douane absent ailleurs) |
| `variant.inventoryItem.unitCost` | Money \| null | Coût — nécessite la permission « View product costs » ; `null` faute de permission ou non renseigné, impossible de distinguer les deux cas depuis l'API |
| `product.totalInventory` / `tracksInventory` | int / bool | Agrégats produit |
| `product.hasOutOfStockVariants` | bool | Calculé |

## 4. Variantes / options — le point demandé : héritage et structure

**Aucun héritage.** Chaque variante porte **toutes** ses valeurs explicitement
— prix, SKU, poids (avec sa propre unité), politique de stock, taxe. Il n'y a
ni `null` signifiant « comme le parent » (Shopware) ni sentinelle du type
`"parent"` sur un champ isolé (WooCommerce `manage_stock`). C'est un
**troisième modèle**, le plus simple des trois : rien à résoudre, tout est sur
la ligne.

| Champ | Notes |
|---|---|
| `product.options[]` | Objets **de premier ordre** : `{ id, name, position, values[], optionValues[] }` — chaque valeur a elle-même un `id` stable (`ProductOptionValue`), pas seulement une chaîne. Ni WooCommerce ni Shopware n'exposent un ID par VALEUR d'option dans leur API produit standard |
| `product.hasOnlyDefaultVariant` | `true` = produit simple ; l'option s'appelle alors littéralement `Title` avec la valeur `Default Title` — c'est comment Shopify encode « pas de variantes », pas un cas séparé dans le schéma |
| `variant.selectedOptions[]` | `[{ name, value }]` — la combinaison de CETTE variante, alignée sur `product.options` par position |
| `variant.title` | Concaténation lisible des `selectedOptions` (`"11x5cm / 15 microns"`) — pré-calculée comme le `variation[]` de Shopware, mais en une seule chaîne, pas une paire structurée |
| `variant.requiresComponents` / `productComponents` | **Bundles** : une variante peut être composée d'autres produits (kit). Concept fondamentalement absent du canon (`kind` n'a pas de valeur `bundle`/`pack` — déjà noté `canon-evolution-open` en 5.1 côté PrestaShop `pack`) |
| `variant.availableForSale` mix observé | Sur `Pack Advanced Nutrients`, une seule variante sur 9 a `availableForSale: true` (et `inventoryItem.tracked: false`) — les autres `false`/`tracked: true`. Le tracking de stock est **configurable variante par variante**, pas seulement produit par produit |

**Conclusion sur l'axe demandé** : Shopify **confirme** que le canon actuel
(valeurs matérialisées sur chaque `CanonVariant`) est la forme native de
Shopify lui-même — aucune reconstruction d'héritage nécessaire pour cette
plateforme, contrairement à Shopware. Les trois modèles réels observés
(Shopware : héritage quasi total par `null` ; WooCommerce : une sentinelle
`"parent"` sur un seul champ ; Shopify : aucun héritage, tout explicite)
couvrent l'éventail probable — le parser générique gère déjà les deux
premiers via `structure.inheritance`, et n'a besoin de rien de spécial pour
le troisième (cas par défaut).

## 5. Catégories / collections — deux systèmes indépendants

| Système | Champ | Notes |
|---|---|---|
| Taxonomie standard | `category` | Un seul nœud, taxonomie fermée Shopify (`TaxonomyCategory`), sert au matching Google/Meta Shopping |
| Type libre | `productType` | Texte libre, un seul par produit |
| Collections | `collections[]` | **Many-to-many**, manuelles ou automatiques (règles) — aucune hiérarchie native (une collection ne contient pas d'autres collections) |

Aucun de ces trois n'est un arbre de catégories comparable à WooCommerce
(`categories[]` hiérarchique) ou Shopware (`breadcrumb`). Le canon actuel
(`categories: string[]`, chemins `"A > B"`) correspond bien à `collections[]`
mise à plat, mais perd la distinction collection-manuelle vs
collection-automatique-par-règle, et perd totalement `category` (taxonomie
fermée) et `productType` (texte libre) comme concepts séparés — actuellement
ces deux derniers n'ont pas d'équivalent canon direct au-delà de
`productType`/`vendor`.

## 6. Images / média

| Champ | Notes |
|---|---|
| `product.media[]` | Type `MediaImage` (peut aussi être vidéo/3D — interface `Media`) ; chaque image a `width`/`height` en plus de `url`/`alt` |
| variante ↔ média | Une variante peut avoir SES PROPRES médias (`variant.media`, non interrogé ici faute de données pertinentes mais présent au schéma) — même logique que le `mediaId` par option Shopware, exposé différemment |

## 7. Taxe

| Champ | Notes |
|---|---|
| `variant.taxable` | Booléen simple — **aucun objet taxe réutilisable, aucune règle par pays** contrairement à Shopware (`tax.rules[]`, taux par pays sur une même entité). La logique par pays existe côté Shopify mais dans les paramètres du magasin (zones de taxe), pas sur le produit |

C'est la plateforme la **plus pauvre des trois** sur cet axe — confirme que
`taxable: boolean` (déjà dans le canon) suffit à Shopify ; la richesse
Shopware (par-pays) reste un `canon-evolution-open` séparé, non contredit ici.

## 8. Metafields — typés, namespacés, et déjà peuplés par des apps tierces

| Champ | Notes |
|---|---|
| `metafields[].namespace` / `.key` / `.type` / `.value` | Système typé (`string`, `boolean`, futurs `number_integer`, `json`, `list.single_line_text_field`, etc. — `type` observé : `string`, `boolean`) |
| Namespace `global` | `title_tag` / `description_tag` — **le SEO (`seo.title`/`seo.description`) est en réalité stocké comme des metafields** namespace `global`. Les deux surfaces API (`product.seo` et `product.metafields`) exposent la MÊME donnée sous deux formes |
| Namespace `mm-google-shopping` | **Observation réelle** : une app tierce (extension Google Shopping) a déjà écrit `google_product_category`, `condition`, `custom_product` sur ce produit, sans intervention manuelle — les metafields ne sont pas seulement un espace pour l'opérateur, des apps y écrivent silencieusement | 
| Metafields **par variante** | Champ présent (`variant.metafields`), vide dans l'échantillon mais structurellement séparé des metafields produit — comme WooCommerce (aucun champ variante) et Shopware (aucun champ variante) qui n'en ont pas non plus nativement |

## 9. SEO

| Champ | Notes |
|---|---|
| `seo.title` / `seo.description` | Alias de lecture pratique des metafields `global.title_tag`/`global.description_tag` (voir §8) |
| `onlineStoreUrl` | URL calculée, pas stockée |

Pas de multi-langue observé sur cette boutique (single-locale) — le champ
`translations` existe au schéma (comme pour Shopware `seoUrls` par langue)
mais n'a pas été exploré faute de deuxième locale configurée.

## 10. Concepts spécifiques Shopify sans équivalent direct dans le canon actuel

| Concept | Description | Candidat |
|---|---|---|
| **`category` (taxonomie standard fermée)** | Arbre unique, contrôlé par Shopify, distinct de `productType`/`collections` | `canon-evolution-open` — aucune des 3 plateformes (Woo/Shopware/Shopify) n'a le même modèle de catégorisation ; Shopify est la seule avec une taxonomie EXTERNE fermée |
| **ID stable par valeur d'option** (`ProductOptionValue`) | Permet de renommer une valeur sans casser les références (swatches, traductions) | `sourceExtension` — le canon `options[].values: string[]` n'a pas d'ID par valeur |
| **`requiresComponents` / bundles composés d'autres produits** | Une variante = assemblage d'autres produits vendables séparément | `canon-evolution-open`, déjà entrevu côté PrestaShop `pack` (5.1) et Shopware `bundleComponents` (non exploré ici mais présent au schéma) |
| **Unité de poids par variante** (pas par produit) | `GRAMS` vs `KILOGRAMS` sur deux variantes du même produit | Le canon `grams` normalise déjà tout en grammes — pas de perte, juste à noter que la source varie field-by-field, pas produit-par-produit |
| **Metafields = double surface (SEO alias + apps tierces)** | Le SEO n'est pas un concept séparé côté stockage ; des apps écrivent des metafields hors du contrôle de l'opérateur | Sans impact canon (le canon a déjà `seoTitle`/`seoDescription` + `metafields[]` génériques) — à noter pour l'UI de mapping : un metafield namespace `mm-*`/`app--*` est probablement un signal "généré par une app", jamais à proposer comme candidat de mapping évident |
| **`unitPriceMeasurement`** | Prix à l'unité de référence, par variante | Même famille que `sourceExtension.shopware.packaging` (5.9) — candidat `sourceExtension`, pas de champ canon dédié |
| **Tracking de stock variable au sein d'un même produit** | `inventoryItem.tracked` diffère entre variantes du même produit | Le canon `stockPolicy.manageStock` est déjà par variante — **aucun changement nécessaire**, confirmé compatible |

## 11. Ce que Shopify N'A PAS que Shopware/WooCommerce avaient

- Pas de règle de prix par palier de quantité sur le produit (Shopware `prices[]`).
- Pas de taxe par pays sur une entité produit (Shopware `tax.rules[]`).
- Pas de page CMS assignable par produit (Shopware `cmsPageId`).
- Pas de note d'achat post-vente au niveau produit dans ce schéma de base (existe côté commande, pas exploré ici).
- Pas de compteur de ventes/notes exposé sur `Product` (WooCommerce `total_sales`/`average_rating`, Shopware `sales`/`ratingAverage`) — pas de champ correspondant trouvé dans le schéma `Product`.

## Fichiers

Extraction faite entièrement via le MCP Shopify connecté (`graphql_schema` →
`validate_graphql_codeblocks` → `graphql_query`), aucun script de secours
nécessaire — contrairement à Shopware où le MCP n'exposait aucun outil
utilisable pour les données catalogue (voir `docs/phase5/shopware-fields.md`).
Fixture figée en 6.3 : `test/fixtures/live/shopify-test/products.json`
(3 produits / 24 variantes, réponse verbatim — voir le README du dossier) et
entrée Reference `shopify.products.admin-graphql.v1.json` (`unknownKeys: []`).
