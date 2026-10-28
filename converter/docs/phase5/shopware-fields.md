# Shopware 6.7 — inventaire réel des champs produit (Admin API)

État au 2026-09-21. Données tirées d'une instance Shopware 6.7.2.2 réelle
(conteneur Docker `shopware-test`, dockware/dev:latest, `http://localhost:8080`),
via l'**Admin API** (`POST /api/search/product`, associations complètes),
authentification OAuth2 client-credentials. Extraites avec
[`scratch/tools/shopware-extract.mjs`](../../scratch/tools/shopware-extract.mjs)
— un script autonome, hors du code de production, qui échange les
identifiants d'une intégration Admin API contre un jeton Bearer puis
interroge l'API directement. Décision explicite (2026-09-21) : ne pas écrire
de classes `#[McpTool]` ni de pont d'authentification pour Shopware — voir la
note de connexion MCP en fin de document pour le diagnostic complet. La
donnée sous-jacente est la même Admin API que servirait un outil MCP réel ;
seul le transport MCP manque.

Reproduire l'extraction :
```
SHOPWARE_URL=http://localhost:8080 \
SHOPWARE_ACCESS_KEY_ID=<access-key> \
SHOPWARE_SECRET_ACCESS_KEY=<secret-access-key> \
node scratch/tools/shopware-extract.mjs --limit 3 --out scratch/tools/out
```

**Suite (peuplement du canon)** : ces données alimentent désormais l'entrée
Reference `core/knowledge-ref/formats/shopware.products.admin-api.v1.json`
lue par le parser générique (`parseShopwareAdminJson`), fixtures figées dans
`test/fixtures/live/shopware-test/`, goldens `shopware_api__to_*`. L'héritage
variante→parent est traité dans `docs/phase5/variant-inheritance.md`.

Produits réels utilisés (démo Shopware, `SWDEMO*`) :
- **`SWDEMO10005` « Variant product »** — 6 variantes réelles (Couleur × Taille : Bleu/Rouge/Blanc × M/XL), config complète.
- **`SWDEMO10007` « Main product with properties »** — 4 variantes, 7 propriétés filtrables sur 3 groupes (Size, Material, Target group).
- **`SWDEMO10002` « Main product with advanced prices »** — pas de variantes, mais prix par palier de quantité + règle métier.

Comparé, comme demandé, à la même profondeur que l'analyse WooCommerce REST
(`docs/phase5/... woocommerce.products.rest.v1.json`, Phase 5.5).

## 1. Identité

| Champ | Type observé | Notes |
|---|---|---|
| `id` | UUID (hex 32) | Identifiant Shopware natif |
| `productNumber` | string | SKU-équivalent, unique, ex. `SWDEMO10005.1` (variantes = `<parent>.<n>`) |
| `parentId` | UUID \| null | Non-null = ligne de variante |
| `childCount` | int | Nombre de variantes (0 sur une variante ou un produit simple) |
| `versionId` | UUID | Shopware versionne CHAQUE entité (live vs version de travail/staging) — concept sans équivalent WooCommerce/Shopify |
| `autoIncrement` | int | Compteur interne, jamais montré à l'utilisateur |
| `active` | bool \| null (hérité) | `null` sur une variante = hérite du parent |
| `states` | string[] | Machine à états calculée, ex. `is-physical`, `is-download` |
| `createdAt` / `updatedAt` | ISO 8601 | — |

## 2. Prix — le plus riche des 3 plateformes comparées

| Champ | Type | Notes |
|---|---|---|
| `price[]` | array (1 par devise) | `{ currencyId, net, gross, linked, listPrice, percentage, regulationPrice }` — prix de base |
| `price[].linked` | bool | `true` = gross calculé depuis net (ou l'inverse) selon le taux de taxe |
| `price[].listPrice` | objet prix \| null | Prix de référence affiché barré ("was") |
| `price[].regulationPrice` | objet prix \| null | **Prix réglementaire** (directive Omnibus UE : plus bas prix des 30 derniers jours) — concept absent de WooCommerce/Shopify/Wix |
| `prices[]` (association séparée, entité `product_price`) | array | Prix **par palier de quantité ET par règle métier** : `{ ruleId, quantityStart, quantityEnd, price: [...] }` |
| `prices[].ruleId` | UUID | Référence au moteur de règles Shopware (groupe client, valeur panier, pays…) — un produit peut avoir un prix différent par règle, indépendamment de la quantité |
| `purchasePrices` | objet prix \| null | Prix d'achat (coût) — équivalent `cost` |

**Donnée réelle observée (`SWDEMO10002`)** : prix de base 950 € TTC ; règle
`28caae75...` donne 800 €/unité pour 1–11, 750 €/unité pour 12+. Deux axes
orthogonaux (règle × palier) sur la MÊME ligne produit, aucune duplication de
ligne — structurellement plus riche que le simple `regular/sale` de
WooCommerce ou `price/compareAtPrice` de Shopify/Wix.

## 3. Stock / politique d'inventaire

| Champ | Type | Notes |
|---|---|---|
| `stock` | int | Quantité |
| `availableStock` | int | Stock disponible (déduit des réservations panier) — distinct de `stock` |
| `available` | bool | Calculé |
| `isCloseout` | bool \| null (hérité) | Fin de série : ne plus réapprovisionner |
| `minPurchase` / `maxPurchase` / `purchaseSteps` | int | Quantités mini/maxi/pas d'achat — plus riche que `sold_individually` WooCommerce |
| `purchaseUnit` / `referenceUnit` / `unit` / `unitId` | — | Unité de vente (ex. "par 100g") — proche de `unit` WooCommerce mais avec ratio de référence |
| `deliveryTimeId` / `deliveryTime` | référence | Délai de livraison **en tant qu'entité réutilisable** (nom + plage jours), pas une chaîne libre |
| `restockTime` | int \| null | Jours avant réapprovisionnement (pour `isCloseout=false`) |
| `shippingFree` | bool \| null (hérité) | Livraison gratuite pour CE produit spécifiquement |

## 4. Variantes / options — architecture fondamentalement différente

Shopware utilise **un seul type d'entité** (`property_group` /
`property_group_option`) pour DEUX rôles distincts, distingués par la relation
utilisée, pas par un champ :

| Rôle | Relation sur le parent | Relation sur l'enfant |
|---|---|---|
| Axe de variation (génère des variantes) | `configuratorSettings[]` (avec `displayType`, `position`, media/prix par option) | `optionIds[]` + `options[]` (les valeurs choisies) |
| Propriété filtrable (ne génère pas de variante) | — | `propertyIds[]` + `properties[]` |

C'est l'inverse du modèle WooCommerce (un seul type "attribute" avec un flag
`variation: true/false`) et distinct du modèle Shopify (`options[]` séparé de
tout système de specs). **Un même groupe** (`Colour`, `Size`) peut apparaître
comme axe de variation sur un produit et comme propriété filtrable sur un
autre — c'est le CONTEXTE (quelle relation le référence) qui décide, pas une
propriété du groupe lui-même. `SWDEMO10007` a "Size" et "Material" en
propriétés (7 valeurs, 3 groupes) alors que `SWDEMO10005` a "Colour"+"Size" en
axes de variation (6 combinaisons réelles).

| Champ (parent, `product_configurator_setting`) | Notes |
|---|---|
| `displayType` (sur le groupe) | `text` \| `color` (avec `colorHexCode`) \| … |
| `sortingType` (sur le groupe) | `alphanumeric` \| … |
| `position` | Ordre d'affichage |
| `price` (sur le setting) | Surcoût **par option de variante**, distinct du prix de la variante elle-même |
| `mediaId` (sur le setting) | Image associée à CETTE option (ex. swatch couleur), pas au produit |

| Champ (enfant/variante) | Notes |
|---|---|
| `variation[]` | Résumé lisible pré-calculé : `[{ group: "Colour", option: "Blue" }, …]` — absent du modèle WooCommerce/Shopify |
| `optionIds[]` | IDs bruts de la combinaison |
| `variantRestrictions` / `variantListingConfig` | Configuration d'affichage/restriction spécifique aux variantes (non peuplée dans les données de démo) |
| `canonicalProductId` | Une variante peut pointer vers une AUTRE variante comme "canonique" (SEO) |
| `featureSetId` | Jeu de specs mises en avant sur la fiche produit |

### Héritage — la différence la plus structurante

Sur une variante réelle (`SWDEMO10005.1`), la quasi-totalité des champs sont
`null` **dans la ligne elle-même** : `taxId`, `manufacturerId`, `active`,
`price`, `weight`, `width/height/length`, `shippingFree`, `purchaseSteps`,
`releaseDate`… Ce n'est pas une absence de donnée : Shopware **résout
l'héritage côté serveur** (DAL "inherited fields") — `null` = "prends la
valeur du parent". Seuls les champs réellement redéfinis sont non-null
(observé : `stock`, `availableStock`, `optionIds`, `propertyIds`,
`categoryTree`, `cmsPageId`, `seoUrls`). Aucun champ `stockPolicy` WooCommerce
ni `compareAtPrice` Shopify n'a cette sémantique d'héritage explicite au
niveau du protocole — WooCommerce simule ça avec `manage_stock: "parent"`
(une seule valeur sentinelle sur UN champ), Shopware le fait sur PRESQUE TOUS
les champs produit.

## 5. Catégories / taxonomie

| Champ | Notes |
|---|---|
| `categories[]` | Association directe (peut être multiple, sans hiérarchie unique) |
| `categoryIds[]` | IDs bruts |
| `categoryTree[]` | **Chemin complet incluant tous les ancêtres**, à plat (pas de séparateur "A > B") — nécessite de résoudre chaque ID contre l'entité `category` (parent/nom) pour reconstruire un chemin lisible, comme pour la taxonomie WooCommerce |
| `categoriesRo` / `mainCategories` | Vue lecture-seule / catégorie "principale" par canal de vente — un produit peut avoir une catégorie de navigation différente PAR sales channel |
| `streamIds` / `streams` | Rattachement à des **flux dynamiques** (règles de filtrage automatique, ex. "tous les produits < 20 €") — concept sans équivalent direct |

## 6. Images

| Champ | Notes |
|---|---|
| `media[]` (`product_media`) | `{ id, position, mediaId }` — la relation ; le fichier réel est une entité `media` séparée (URL, alt text, dimensions vivent là-bas, non résolues dans cette extraction) |
| `cover` / `coverId` | Image de couverture désignée, séparée de la position 1 de `media[]` |
| Media par option de variante | `product_configurator_setting.mediaId` — une image de swatch peut différer de l'image produit |

## 7. Taxe — par pays, pas un simple statut

| Champ | Notes |
|---|---|
| `taxId` → `tax` | Entité réutilisable : `taxRate` (taux de base) + `name` |
| `tax.rules[]` (`tax_rule`) | **Surcharges par pays** : `{ countryId, taxRate, taxRuleTypeId, activeFrom }` — ex. observé : taux de base 19 %, mais 21 % pour un pays, 25 % pour un autre, etc. sur PLUS DE 25 pays dans les données de démo | 
| — | WooCommerce (`tax_status`/`tax_class` : booléen + classe nommée) et Shopify/Wix n'ont rien d'équivalent à des taux par pays sur une seule entité taxe |

## 8. Champs personnalisés / SEO / merchandising

| Champ | Notes |
|---|---|
| `customFieldSets[]` / `customFields` | Système de "custom fields" typés (texte, nombre, date, select…) définis par jeu réutilisable — proche des metafields Shopify/WooCommerce mais avec un schéma de types déclaré à l'avance (aucun peuplé dans l'échantillon) |
| `metaTitle` / `metaDescription` / `keywords` | SEO classique (traduit) |
| `seoUrls[]` | **Par sales channel ET par langue** : `{ salesChannelId, languageId, seoPathInfo, isCanonical, isModified }` — un même produit peut avoir des URLs SEO différentes selon le canal |
| `searchKeywords` / `customSearchKeywords` | Mots-clés de recherche internes distincts des `keywords` SEO publics |
| `markAsTopseller` | Flag marketing simple |
| `crossSellings[]` / `crossSellingAssignedProducts` | Ventes croisées **groupées et nommées** (ex. "Accessoires assortis"), plus riche qu'une simple liste d'IDs upsell/cross-sell WooCommerce |
| `productReviews` / `ratingAverage` | Avis produits — canon n'a pas ce concept (déjà noté côté WooCommerce `average_rating`/`rating_count`) |
| `tags[]` / `tagIds[]` | Tags internes (distincts des tags publics WooCommerce/Shopify — usage principalement pour les règles de flux/promo) |
| `wishlists` | Relation liste de souhaits (vide dans l'échantillon) |
| `downloads[]` | Téléchargements numériques — même concept que `digital.downloads` canon |
| `cmsPageId` / `cmsPage` | **Page CMS dédiée** assignable par produit (mise en page de fiche produit personnalisée par le back-office) — concept sans équivalent WooCommerce/Shopify/Wix |
| `slotConfig` | Configuration des blocs de layout CMS pour ce produit précis |

## 9. Concepts spécifiques Shopware sans équivalent direct dans les autres plateformes

| Concept | Description | Impact canon |
|---|---|---|
| **`versionId` (versioning d'entité)** | Chaque produit existe en plusieurs "versions" (live + versions de travail) ; l'API en retourne toujours une explicite | Aucun champ canon ne modélise une version d'entité — hors périmètre probable, mais à noter si un jour Shopware devient une SOURCE |
| **Règles métier (`ruleId`) sur les prix** | Un prix peut dépendre d'une règle arbitraire (groupe client, pays, devise, panier) au-delà du simple palier de quantité | `canon-evolution-open` : le canon actuel n'a que `price`/`compareAtPrice`/`cost`, aucune notion de règle |
| **`regulationPrice` (prix réglementaire Omnibus)** | Prix légal de référence distinct du prix barré marketing | `canon-evolution-open` : à distinguer de `compareAtPrice` |
| **Taxe par pays sur une même entité** | `tax.rules[]` | `canon-evolution-open` : le canon n'a qu'un booléen `taxable` |
| **Héritage de champ explicite parent→variante** | La quasi-totalité des champs variante peuvent être `null` = hérité | Le canon actuel duplique déjà les valeurs sur chaque `CanonVariant` (pas d'héritage) — fonctionne pour la conversion mais perd l'information "était explicite ou hérité" si Shopware devenait une source |
| **Groupe de propriétés partagé variantes/specs** | Même entité, deux rôles selon la relation | Le canon distingue déjà `options` (axe) vs `attributesRich` (specs) — **compatible**, à condition que l'adaptateur sache lire les deux relations Shopware séparément (pas un souci de canon, un souci d'adaptateur) |
| **Visibilité par sales channel avec niveau gradué** | `visibilities[].visibility` (entier, ex. 30) plutôt qu'un booléen | Le canon a `published` (bool) + `visibility.catalogVisibility` (enum) — pas de notion multi-canal ; `sourceExtension` suffit pour l'instant |
| **SEO URL par canal ET par langue** | `seoUrls[]` multi-dimensions | Aligné avec le point `multilingue` déjà marqué `canon-evolution-open` en 5.1 — Shopware confirme que ce n'est pas propre à PrestaShop |
| **Page CMS assignée par produit** | `cmsPageId`/`slotConfig` | Pas de champ canon — présentation, pas donnée catalogue ; `sourceExtension` |
| **Flux dynamiques (`streamIds`)** | Appartenance calculée par règles, pas assignation manuelle | Pas d'équivalent canon ; hors périmètre conversion fichier-à-fichier |
| **Numéro fabricant distinct du SKU** | `manufacturerNumber` vs `productNumber` vs `ean` — 3 identifiants distincts | Confirme le point `identifiers-relation` déjà marqué borderline en 5.1 (UPC/MPN/EAN séparés observés sur 3/6 plateformes ; Shopware fait 4/7) |

## 10. Ce que Shopware N'A PAS que WooCommerce avait

- Pas de `brands` en taxonomie séparée observée sur cette version : `manufacturer` est une entité unique par produit (pas de multi-marques), plus proche de Shopify `vendor` que du système `brands[]` WooCommerce 9.6+.
- Pas de `total_sales` / compteur de ventes au niveau produit dans les champs de base (existe potentiellement via analytics séparées, non explorées ici).

## Note — état de la connexion MCP (Task 1)

**Connexion non établie via `claude mcp add` tel que configuré ; cause
racine identifiée et documentée, pas contournée en silence.** Détails complets
demandés dans le rapport de tâche (canal de conversation), résumé ici pour
mémoire :

1. `symfony/mcp-bundle` n'était pas installé du tout (aucun code MCP nulle
   part dans l'installation) → installé (`composer require symfony/mcp-bundle:^0.13`).
2. Le fichier d'import de route (`config/routes/mcp_bundle.yaml`) n'existait
   pas — la recette Flex ne s'exécute pas avec `--no-scripts` → créé
   manuellement.
3. Le routeur compilé RUNTIME de Shopware **filtre silencieusement** toute
   route sans `_routeScope` déclaré (différence CLI `debug:router` vs matcher
   compilé réellement utilisé par le serveur web) → corrigé en ajoutant
   `defaults: { _routeScope: ['api'] }` sur l'import de route.
4. Après ces 3 corrections, la route `/api/_mcp` répond, le handshake MCP
   fonctionne intégralement (`initialize` → 200, session, `tools/list` → 200)
   **avec un jeton Bearer OAuth2 valide**.
5. **Blocage architectural réel, non contourné** : les identifiants créés par
   `integration:create` sont des identifiants OAuth2 *client_credentials*
   (échange contre un jeton Bearer de courte durée via `POST
   /api/oauth/token`), pas des en-têtes statiques. Le schéma configuré dans
   `claude mcp add --header "sw-access-key: ..." --header
   "sw-secret-access-key: ..."` ne correspond à AUCUN mécanisme
   d'authentification réel de Shopware (ni Admin API OAuth2, ni Store API
   `sw-access-key` qui n'a pas de "secret" homologue). `claude mcp add
   --client-id/--client-secret` (flux OAuth générique) ne peut pas non plus
   s'auto-configurer : Shopware n'expose pas les points de découverte OAuth du
   spec MCP (`/.well-known/oauth-authorization-server` et
   `/.well-known/oauth-protected-resource` renvoient 404 tous les deux).
6. **Second blocage, indépendant du premier** : même une fois authentifié,
   `tools/list` renvoie `{"tools": []}` — `symfony/mcp-bundle` est un bundle
   Symfony générique qui n'expose QUE les services PHP explicitement tagués
   `#[McpTool]`/`#[McpResource]` ; aucune classe de ce type n'existe pour les
   entités Shopware (produit, catégorie, commande…) dans cette installation
   ni dans aucun paquet Composer découvert (recherche Packagist : aucun
   paquet Shopware-MCP officiel n'existe). Exposer les produits Shopware par
   MCP demande d'écrire ce code d'intégration — un développement, pas un
   dépannage.

**Décision (utilisateur, 2026-09-21)** : ne pas écrire les classes
`#[McpTool]` ni le pont d'authentification OAuth pour Shopware — pas
rentable pour ce qu'on en tire. À la place : les données ci-dessus ont été
obtenues en appelant directement l'Admin API (mêmes entités qu'un outil MCP
interrogerait) via
[`scratch/tools/shopware-extract.mjs`](../../scratch/tools/shopware-extract.mjs),
un script autonome hors du code de production qui échange les identifiants
contre un jeton via le flux OAuth2 réel — pas de contournement silencieux :
la même API que consommerait un futur outil MCP Shopware, juste sans la
couche de transport MCP, qui reste un investissement non retenu pour l'instant.
