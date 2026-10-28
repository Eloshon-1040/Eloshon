# Héritage variante → parent : les modèles réels et ce que le canon en fait

État au 2026-09-21. Écrit à partir de payloads/exports **réels** (WooCommerce
REST via WordPress Studio, Shopware 6.7 Admin API via
`scratch/tools/shopware-extract.mjs`, exports CSV Wix/BigCommerce/Shopify/
WooCommerce en fixtures, exports Eloshon Scraper) — pas de la doc des
plateformes. Wix API v3 : aucun site Wix sur le compte connecté, donc **pas de
payload réel** ; seul l'export CSV Wix (fixture) fait foi ici.

## 1. Six façons de dire « cette variante vaut comme son parent »

| Source | Mécanisme | Portée | Comment on le lit |
|---|---|---|---|
| **Shopware Admin API** | `null` sur la ligne variante = **hérité** (résolution DAL côté serveur, champ « inherited ») | Quasi tous les champs : `price`, `weight`, `length/width/height`, `taxId`, `manufacturerId`, `active`, `cover`, `shippingFree`, `purchaseSteps`, `releaseDate`… — sauf `stock`/`availableStock`, `productNumber`, `optionIds`, `seoUrls`, `variation` (propres) | `structure.inheritance.nullMeansParent` + liste `exclude` (données) |
| **BigCommerce CSV** | cellule **vide** sur une ligne `Item = Variant` = « comme le produit » | Jeu fixe : `Price`, `Cost Price`, `Weight`, `Depth/Width/Height` | parser `bigcommerce.ts` (`_base` du produit) |
| **Wix CSV** | cellule vide sur une ligne `fieldType = Variant` = valeur produit ; la **remise** est toujours au niveau produit et s'applique à chaque variante | `price`, `weight`, `cost`, `inventory` | parser `wix.ts` (`?? productPrice`…) |
| **WooCommerce REST** | valeurs **explicites** sur chaque variation ; un seul champ sentinelle : `manage_stock: "parent"` | `manage_stock` uniquement | transform `stock_policy` (`args.parentPath`) |
| **WooCommerce CSV** | aucune : une variation vide est vide (`Regular price` blanc → `null`) ; seul le lien `Parent` existe | — | parser `products.ts` |
| **Shopify CSV** | aucune côté variante ; les colonnes *produit* ne sont remplies que sur la première ligne du handle | — | parser `products.ts` |
| **Eloshon Scraper (JSON `variants`)** | pas de convention native ; l'héritage est **déclaré champ par champ** dans la connaissance | `price`, `barcode`, `weight_kg` | transform `inherit_from_parent` (`args.parentPath`, `as`) |

Deux familles donc : **héritage par absence** (Shopware, BigCommerce, Wix —
avec des portées très différentes) et **héritage par déclaration** (WooCommerce
`"parent"`, Scraper via la connaissance). Shopify et WooCommerce CSV n'en ont
pas.

## 2. Ce que le canon en fait aujourd'hui (aucun changement de canon)

`CanonVariant` porte des valeurs **matérialisées** : chaque variante a son
`price`, `grams`, `taxable`, `imageSrc`… quel que soit le mécanisme source.
C'est ce que tous les sérialiseurs attendent (Shopify écrit une ligne complète
par variante ; WooCommerce aussi). L'information « était-ce explicite ou
hérité ? » n'est **pas perdue** : elle vit dans la provenance de la variante :

```json
"provenance": {
  "price": { "platform": "shopware", "sourceField": "price", "transform": "price_pick",
             "method": "inherited" },
  "inventoryQty": { "platform": "shopware", "sourceField": "stock", "transform": "int", "method": "exact" }
}
```

Testé sur données réelles (`core/knowledge-proposal/tests/shopware-inheritance.test.mjs`) :
- variante Shopware sans prix/poids/taxe/image propres → valeurs du parent,
  `method: 'inherited'` (marqueur typé depuis 6.2 ; avant : `structural` +
  note libre) ; stock propre → `exact` ;
- héritage **désactivable par données** (`nullMeansParent: false`) → champs
  `null`, provenance `exact` avec `sourceValue: null` (fidèle : la source
  disait null) ;
- WooCommerce (sentinelle sur un champ) et Shopware (null sur presque tous)
  atterrissent sur la **même forme canon** : prix et politique de stock
  matérialisés sur chaque variante ;
- gelé dans les goldens `shopware_api__to_*` (`.canon.json` inclus).

Sans variante réelle (produit simple), le produit **est** sa propre variante
(`selfWhenNone`) — même règle que pour WooCommerce REST et le Scraper.

## 3. Le point structurant : `structure.inheritance` est de la donnée, pas du code

Le parser générique n'a aucune règle « Shopware ». L'entrée Reference déclare :

```json
"structure": {
  "variants": { "companion": "variations", "childParentPath": "parentId", "selfWhenNone": true, "sameEntity": true },
  "inheritance": { "nullMeansParent": true, "exclude": ["id", "productNumber", "stock", "availableStock", "optionIds", "seoUrls", "variation", "…"] }
}
```

- `sameEntity: true` — les variantes Shopware **sont** des produits (mêmes
  ~100 clés) : les clés consommées au niveau produit ne sont pas « inconnues »
  sur l'enfant. Résultat sur le payload réel : `unknownKeys: []` pour 3 parents
  et 10 variantes.
- `exclude` — ce qui est **propre** à la variante par définition (identité,
  stock, options, URLs). Tout le reste hérite quand c'est `null`.
- Une plateforme à héritage-par-absence sur un jeu fixe (BigCommerce, Wix)
  s'exprimerait avec `inheritance: { nullMeansParent: true, only: [...] }` le
  jour où leurs formats API passent par le parser générique (5.9) — le
  mécanisme est le même, seule la liste change.

## 4. Ce qui reste ouvert (à flagger, pas à décider ici)

| Question | Où on en est | Candidat |
|---|---|---|
| Faut-il un marqueur canon explicite « hérité » (ex. `CanonProvenanceMethod` = `'inherited'`) plutôt que `structural` + note ? | **Tranché (6.1 §E, implémenté 6.2)** : `'inherited'` est dans `CanonProvenanceMethod` ; le parser générique l'émet, la note libre a disparu. Goldens canon Shopware : 66 valeurs héritées × 4 cas, seules `method`/`note` ont bougé | clos |
| Round-trip Shopware → Shopware : faut-il **ré-émettre `null`** sur une variante dont la valeur était héritée ? | Aujourd'hui tout est matérialisé ; vers Shopify/WC c'est correct. Vers un adaptateur Shopware d'écriture, ré-émettre les valeurs explicitement changerait la sémantique côté cible (la variante cesserait d'hériter) | à trancher quand un adaptateur d'écriture Shopware existera (5.8 API adapters) ; la provenance rend la décision possible |
| Wix API v3 : héritage réel ? | Inconnu — aucun site à interroger ; l'export CSV Wix hérite `price/weight/cost/inventory` par cellule vide | reprendre quand un site Wix avec produits sera disponible |
| Même groupe de propriétés en **deux rôles** (axe de variation ET propriété filtrable — `Size` sur les produits de démo) | Les deux sont gardés dans `attributesRich` (`forVariation` true/false) ; vers WooCommerce, la collision de nom est rapportée (`loss_woo_attribute_collision`), l'axe est conservé | comportement stable ; pas de changement canon nécessaire |

## 5. Fichiers

- Parser : `core/knowledge-proposal/generic-parser.mjs` (`readInputs` → fallback parent, provenance).
- Connaissance : `core/knowledge-ref/formats/shopware.products.admin-api.v1.json` (83 entrées, `structure.inheritance`).
- Données : `test/fixtures/live/shopware-test/` (3 parents, 10 variantes), `test/fixtures/live/woocommerce-test/`.
- Tests : `core/knowledge-proposal/tests/shopware-inheritance.test.mjs` ; goldens `test/golden/shopware_api__to_*`.
- Inventaire des champs Shopware : `docs/phase5/shopware-fields.md`.
