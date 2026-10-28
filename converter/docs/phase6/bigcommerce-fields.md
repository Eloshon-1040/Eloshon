# BigCommerce Catalog API v3 — inventaire réel des champs produit

État au 2026-09-21 (mise à jour : données réelles). Boutique d'essai
`example-store.mybigcommerce.com` (« 15 Day Trial », EUR, kg, cm, en),
compte API **store-level** en lecture seule (Products / Orders / Customers),
`X-Auth-Token` sur `https://api.bigcommerce.com/stores/{hash}` — script
`scratch/tools/bigcommerce-extract.mjs`. Fixture figée :
`test/fixtures/live/bigcommerce-test/` (13 produits de démo, 68 variantes,
brands, catégories, devises, classes de taxe, `store.json` expurgé).

`[OBSERVATION]` Deux jeux d'identifiants coexistaient dans `.env.local` : l'ancienne
paire (`BIGCOMMERCE_ID_CLIENT` / `BIGCOMMERCE_SECRET_KEY`) répond **401** en
`X-Auth-Token` sur `GET /v3/catalog/products` ; la paire du compte store-level
(`BIGCOMMERCE_ACCESS_TOKEN`) répond **200**. L'ancienne a été retirée du
fichier (commentaire laissé) ; `BIGCOMMERCE_STORE_HASH` contenait le chemin
API complet → gardé en `BIGCOMMERCE_API_PATH`, hash nu dans `STORE_HASH`.
Avec la liste `include` complète l'API **tronque la page** (10 renvoyés sur 13
à `limit=50`) : pagination obligatoire.

## 1. Identité (`products`, 76 clés)

| Champ | Observé | Notes |
|---|---|---|
| `id`, `name`, `sku`, `type` (`physical` / `digital`) | | `type` → `kind` / `requiresShipping` |
| `custom_url { url: "/fog-linen-…/", is_customized }` | | slug avec slashes → `handle` |
| `description` (HTML), `page_title`, `meta_description`, `meta_keywords[]`, `search_keywords`, `open_graph_*` (5) | | |
| `date_created`, `date_modified`, `date_last_imported`, `sort_order`, `layout_file` | | |
| `is_visible`, `is_featured`, `availability` (`available` / `disabled` / `preorder`), `availability_description`, `preorder_release_date`, `preorder_message`, `is_preorder_only`, `is_price_hidden`, `price_hidden_label` | | |
| `categories[]` (ids ; arbre par `catalog/trees/categories` : `category_id`, `parent_id`, `tree_id`, `url.path`), `brand_id` (ressource `brands`), `related_products[]` (`[-1]` = automatique) | | |
| `condition` (`New`…) + `is_condition_shown`, `warranty`, `gift_wrapping_options_type/list`, `order_quantity_minimum/maximum` | | |
| `reviews_rating_sum`, `reviews_count`, `total_sold`, `view_count` | compteurs | → `sourceExtension` (comme WC / Shopware) |

## 2. Prix

`price`, `cost_price`, `retail_price` (PDSF), `sale_price`, `map_price`,
`calculated_price` (dérivé), `tax_class_id` (ressource `tax_classes`),
`product_tax_code`, `is_free_shipping`, `fixed_cost_shipping_price`.
Une seule devise (`currencies`, EUR par défaut).

`[OBSERVATION C1]` **`bulk_pricing_rules[]` est natif** : la clé est présente sur
chacun des 13 produits réels (vide — la boutique d'essai n'a aucune règle et
le jeton est en lecture seule, impossible d'en créer). Forme documentée de
l'item : `{ id, quantity_min, quantity_max, type: price | percent | fixed,
amount }`. `/v3/pricelists` répond 200 (0 liste) — prix par groupe client
avec `bulk_pricing_tiers` par enregistrement ; `/v2/customer_groups` → 204
(aucun groupe). Concept confirmé natif, **forme d'item non observée**.

`[OBSERVATION C2]` Rien : `retail_price` = PDSF, `map_price` = prix minimum
affiché — aucun « prix le plus bas des 30 jours ». Non natif.

## 3. Identifiants (P3) — **3 identifiants typés + SKU**

`upc`, `mpn`, `gtin` (+ `bin_picking_number`) au niveau produit **et**
variante (`variants[].upc / mpn / gtin`) — vides dans la démo. Pas d'`ean` ni
d'`isbn` distincts (le CSV dit `UPC/EAN`). Dérivation canon → `barcode`.

## 4. Variantes / options / modificateurs — **4ᵉ modèle d'héritage**

`variants[] { id, product_id, sku, sku_id, price, calculated_price, sale_price,
retail_price, map_price, weight, calculated_weight, width, height, depth,
is_free_shipping, fixed_cost_shipping_price, purchasing_disabled(+_message),
image_url, cost_price, upc, mpn, gtin, inventory_level,
inventory_warning_level, bin_picking_number, option_values[] { id, label,
option_id, option_display_name } }` (27 clés, 45 variantes sur le produit 77).

`[OBSERVATION]` **`price: null` + `calculated_price: 49`**, `weight: null` +
`calculated_weight: 1`, `sale_price/retail_price/map_price/width/height/depth/
fixed_cost_shipping_price: null` : sur BigCommerce **null = la valeur du
produit** (héritage), et l'API fournit la valeur **résolue** à côté
(`calculated_*`). Un quatrième modèle après Shopware (null = parent, non
résolu), WooCommerce (sentinelle `"parent"` sur un champ) et Shopify (tout
explicite) : `structure.inheritance.nullMeansParent` couvre le null, et les
champs `calculated_*` donnent une provenance `exact` directe quand on les
préfère.

`options[] { id, product_id, name (interne : "Apparel sizes"), display_name
("Size"), type (rectangles / swatch / dropdown / radio…), sort_order,
option_values[] { id, label, sort_order, value_data { colors: ["#cccccc"] },
is_default }, config }` — ids stables par valeur, couleur hex sur les
swatches (comme Wix / Shopify). `modifiers[]` : aucun dans la démo (forme
documentée : pick list = **option**, 6.4). `base_variant_id`, `option_set_id`,
`option_set_display` : héritage du modèle v2.

## 5. Stock

`inventory_tracking` (`none` / `product` / `variant`), `inventory_level`,
`inventory_warning_level` (produit et variante). Démo : `none` partout.

## 6. Images / vidéos

`images[] { id, product_id, is_thumbnail, sort_order, description,
image_file, url_zoom, url_standard, url_thumbnail, url_tiny, date_modified }`,
`primary_image` (même forme), `videos[]` (vide).

## 7. Custom fields / metafields (P2)

`custom_fields[] { id, name, value }` (vide en démo) — chaînes sans
namespace ni type ; `/v3/catalog/products/{id}/metafields` et
`/variants/{id}/metafields` répondent 200 (vides) — forme documentée
`{ namespace, key, value, permission_set, resource_type }` :
`permission_set = app_only` sera une grammaire de propriété BigCommerce pour
6.5 dès qu'observée.

## 8. Absent nativement

Traductions (mono-langue), bundles (pick list = option), taxonomie externe
fermée, Omnibus.
