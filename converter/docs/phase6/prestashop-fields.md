# PrestaShop 9 Webservice — inventaire réel des champs produit

État au 2026-09-21. Données tirées de l'instance **PrestaShop 9.0.3 (classic)**
locale (Docker `eloshon-ps-app`, `localhost:8090`, catalogue de démo + 5
produits `ELO-EDGE-*` du Scraper) par le **Webservice classique**
(`/api/<resource>?output_format=JSON&display=full`, compte `eloshon`, lecture
seule) avec `scratch/tools/prestashop-extract.mjs`. Fixture figée :
`test/fixtures/live/prestashop-test/` (11 ressources, 25 produits, 39
déclinaisons). Les identifiants et un palier de quantité ont été **seedés**
(le catalogue de démo n'en porte aucun) — voir le README des fixtures.

`[OBSERVATION]` Le Webservice rend **tout en chaînes** (`"23.900000"`, `"0"`,
`"1"`), les dates nulles en `0000-00-00 00:00:00`, les champs multilingues
en `[{ id: <id_lang>, value }]` (toutes les langues du shop en un appel), et
les relations en `associations.<ressource>[] = { id, … }` (ids seulement —
les objets viennent des ressources compagnes). L'index d'images
(`GET /api/images/products`) répond HTTP 500 en JSON sur 9.0.3 (bug de
sortie JSON ; XML fonctionne) : `associations.images[]` du produit suffit.

## 1. Identité (`products`, 72 clés)

| Champ | Observé | Notes |
|---|---|---|
| `id` | int | ; `reference` (chaîne, `demo_1`), `supplier_reference` |
| `link_rewrite` | multilingue | slug **par langue** → `handle` / `translations[lang].slug` |
| `name`, `description`, `description_short`, `meta_title`, `meta_description`, `available_now/later` | multilingue | `description_short` = résumé HTML (≈ WooCommerce `short_description`) |
| `product_type` | `standard` / `combinations` / `virtual` / `pack` | **enum natif de kind** ; `is_virtual`, `cache_is_pack`, `cache_has_attachments` = caches |
| `active`, `visibility` (`both`/`catalog`/`search`/`none`), `available_for_order`, `show_price`, `online_only`, `indexed` | chaînes `"0"/"1"` / enum | `visibility` = la même échelle que WooCommerce `catalog_visibility` |
| `state` (`1` = publié), `date_add`, `date_upd`, `available_date` | | |
| `id_manufacturer` + `manufacturer_name`, `id_supplier`, `id_category_default`, `id_tax_rules_group`, `id_shop_default` | ids | `manufacturers` compagne ; `categories` compagne (`id_parent`, `level_depth`, `name`/`link_rewrite` multilingues) |
| `condition` (`new/used/refurbished`), `show_condition`, `redirect_type` (`301`…), `id_type_redirected` | | |

## 2. Identifiants (P3) — **4 identifiants typés + référence**

`reference` (SKU) · `ean13` · `upc` · `isbn` · `mpn`, **au niveau produit ET
déclinaison** (`combinations`: `ean13`, `isbn`, `upc`, `mpn`, `reference`,
`supplier_reference`). Observé après seed : produit 1 `ean13 2000000000039 /
upc 200000000004 / isbn 9782000000009 / mpn MPN-DEMO-1`, déclinaison 1
`ean13 2000000000046 / mpn MPN-DEMO-1-S`. Aucun `barcode` unique : la
dérivation canon `barcode ← gtin → ean → upc → isbn` (6.3) s'applique.

## 3. Prix

| Champ | Notes |
|---|---|
| `price` (HT), `wholesale_price` (coût), `unity` + `unit_price` + `unit_price_ratio` (prix à l'unité), `ecotax`, `additional_shipping_cost`, `on_sale` (badge), `minimal_quantity` | par produit ; déclinaison : `price` = **impact** (delta, `0.000000` observé), `wholesale_price`, `ecotax`, `unit_price_impact` |
| **`specific_prices`** (ressource) | `{ id_product, id_product_attribute, id_shop, id_shop_group, id_currency, id_country, id_group, id_customer, id_cart, id_specific_price_rule, price (fixe, -1 = non), from_quantity, reduction, reduction_tax, reduction_type (amount / percentage), from, to }` |

`[OBSERVATION C1]` La matrice **règle × palier** est native : `from_quantity`
(palier) × (`id_group` client, `id_country`, `id_currency`, `id_customer`,
`id_shop`) × période, exprimée en **réduction** (montant ou %) ou prix fixe ;
`id_specific_price_rule` renvoie aux règles de prix catalogue. Démo : 2 lignes
`from_quantity: 1` (−20 %) ; palier seedé `from_quantity: 10` → −15 % sur le
produit 1 (`specific_prices.json`). Forme différente de Shopware
(`prices[]` = prix **absolus** par `ruleId` × `quantityStart/End` par devise).

`[OBSERVATION C2]` **Aucun prix de référence légal (Omnibus)** : ni colonne
(`information_schema` : rien qui matche regulation / omnibus / lowest /
previous_price) ni configuration (`PS_*OMNIBUS*`, `*LOWEST*`) dans le core
9.0.3 — modules seulement.

## 4. Stock

`stock_availables` (ressource, 64 lignes) : `{ id_product, id_product_attribute
(0 = produit), id_shop, quantity, depends_on_stock, out_of_stock (0 refuser /
1 accepter / 2 réglage global), location }` ; produit : `quantity` (cache),
`low_stock_threshold`, `low_stock_alert`, `advanced_stock_management`,
`available_date`, `additional_delivery_times`, `delivery_in_stock`/`out_stock`
(multilingue). `out_of_stock` ≈ `stockPolicy.backorders`.

## 5. Déclinaisons / options / caractéristiques

| Concept | Où | Notes |
|---|---|---|
| Axe de variation | `product_options` (`group_type` select / radio / color, `is_color_group`, `name` + `public_name` multilingues) + `product_option_values` (`name` multilingue, `color`) | 4 groupes, 25 valeurs en démo |
| Déclinaison | `combinations` (39) : `associations.product_option_values[]`, `images[]`, `default_on`, `minimal_quantity`, `low_stock_*`, `available_date`, prix/poids **impacts** | le produit porte `cache_default_attribute` / `id_default_combination` |
| Caractéristiques (attributs descriptifs) | `product_features` (`Composition`, `Property`) + `product_feature_values` (`custom` 0/1, `value` multilingue) ; produit : `associations.product_features[] = { id, id_feature_value }` | → `attributesRich[]` (`forVariation: false`) |
| Personnalisation | `customizable`, `text_fields`, `uploadable_files` (+ `product_customization_fields`) | spécifique |

## 6. Packs (6.4, forme 2 observée)

Produit 15 (`demo_21`, `product_type: pack`) :
`associations.product_bundle = [{ id: 5, id_product_attribute: 19, quantity: 5 },
{ id: 7, id_product_attribute: 0, quantity: 5 }]` — un item **épinglé sur une
déclinaison** et un item **produit** dans le même pack. `pack_stock_type`
(`3` = réglage global `PS_PACK_STOCK_TYPE` = 0 : décrémenter le pack) →
`sourceExtension.presta`. Exactement la forme anticipée par le transform
`bundle_components` (test 6.4).

## 7. Multilingue (P1)

2 langues (`en` `en-US`, `fr` locale vide en démo) ; chaque champ traduisible
porte toutes les langues (`display=full`) — les valeurs FR de la démo sont
identiques à EN. `link_rewrite` par langue = slug par locale. La langue par
défaut = `PS_LANG_DEFAULT` (configuration) → champs plats ; les autres →
`translations[<iso>]`.

## 8. Images / SEO / divers

`id_default_image`, `associations.images[]` (ids ; URL front `/{id_image}-{type}/{link_rewrite}.jpg`, API `/api/images/products/{id}/{id_image}`) ;
`meta_title` / `meta_description` multilingues ; `position_in_category`,
`new`, `quantity_discount`, `cache_default_attribute`, `id_default_combination`.

## 9. Ce qui n'existe pas nativement

Metafields libres (les « caractéristiques » sont typées et partagées ; pas de
namespace), taxonomie externe fermée, bundles à variantes (un pack n'a pas de
déclinaisons), prix Omnibus, tags (pas de `tags` en 1.7+/8/9 — uniquement via
`ps_tag` pour la recherche, non exposé en produit).
