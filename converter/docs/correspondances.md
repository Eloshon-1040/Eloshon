# Correspondances de colonnes — format des règles (ÉTAPE 2)

> [PROPOSITION] appliquée. Rend VISIBLE et (pour les champs scalaires) MODIFIABLE
> la correspondance que le moteur applique déjà, sans réécrire un seul transform.
> Fichier : `core/src/mapping.ts`. Version du format : `MAPPING_RULES_VERSION = 1`.

## 1. Principe

La correspondance réelle du moteur est **impérative** et scindée autour de la
représentation canonique (IR) :

```
colonne source ──(parseur)──▶ champ canonique ──(sérialiseur)──▶ colonne cible
```

On la décrit donc par **deux tables jointes sur le champ canonique** :

- `SOURCE_FIELDS[formatSource]` : chaque colonne fixe qu'un parseur lit, son champ
  canon, le transform, si elle est **re-pointable**, ses **noms proches** (alias),
  et une description FR/EN.
- `TARGET_FIELDS[formatCible]` : pour chaque champ canon, la/les **colonne(s)
  cible** qu'un sérialiseur écrit. `cols: []` (ou clé absente) = le champ **n'est
  pas repris** par la cible → c'est une **perte réelle**, affichée honnêtement.

Le « plan » d'une paire (source → cible) est la jointure. Il révèle aussi les
pertes : p. ex. `vendor`, `productType`, `seoTitle`, `cost`, `barcode` de Shopify
ne sont **pas repris** par l'export WooCommerce moderne (vérifié dans le code du
sérialiseur, jamais inventé).

## 2. Exemple commenté (une règle source)

```ts
F({
  id: 'compareAtPrice',            // identifiant stable (= clé canon ici)
  canon: 'compareAtPrice',         // champ canonique (clé de jointure vers la cible)
  scope: 'variant',                // niveau produit ou variante
  column: 'Variant Compare At Price', // colonne source lue PAR DÉFAUT
  transform: 'money',              // transform (documentation + libellé UI)
  editable: true,                  // re-pointable / exclu-able (copie simple 1 colonne)
  reviewAlways: true,              // force « À vérifier » même en correspondance exacte
  descFr: 'Prix barré (ancien prix). À ne pas confondre avec un prix promo.',
  descEn: 'Compare-at (was) price. Not the same as a sale price.',
})
```

Côté cible (WooCommerce moderne), la jointure donne :

```ts
compareAtPrice: { cols: ['Regular price', 'Sale price'] } // via le transform price_promo
```

**Transforms complexes = code, référencé par identifiant** (`price_promo`,
`grams_from_kg`, `options`, `images`, `metafields`, `category_path`…). On ne rend
pas tout « déclaratif » : les champs multi-colonnes ou structurels sont
`editable: false` (affichés et décrits, mais non re-pointables), car les
re-pointer casserait le transform. Les copies simples 1-colonne sont `editable`.

## 3. Niveaux de confiance (critères déterministes)

Calculés par `analyzePlan(headers, source, cible, entité, overrides)` :

| Niveau | Critère |
|---|---|
| **Élevée** (`high`) | colonne par défaut présente **au nom exact** ; correspondance appliquée telle quelle. |
| **À vérifier** (`check`) | colonne trouvée via un **nom proche connu** (alias) ; **ou** l'utilisateur a re-pointé la colonne ; **ou** champ sémantiquement délicat (`reviewAlways`, ex. prix barré). |
| **Faible** (`low`) | déduite par **heuristique sur les valeurs** (contenu des cellules). *(Réservé ; non encore activé — voir §5.)* |
| **Non utilisée** (`none`) | colonne source **présente dans le fichier sans destination** (liste `unused`). |

**Règle d'honnêteté (clé) :** un nom proche (alias) est une **suggestion**, pas
une correspondance silencieuse. `applied=false` + `suggestedOverrides` : la
conversion ne l'utilise **que** si l'utilisateur l'accepte (override). Le moteur
par défaut (sans `mapping`) lit toujours les colonnes exactes → sortie inchangée.

## 4. Modifier une correspondance — mécanisme sûr

Un override = `{ [id]: { column: string | null } }` :
- `column: 'AutreColonne'` → **re-pointe** le champ ;
- `column: null` → **exclut** le champ (« Ne pas importer »).

`applyOverridesToTable(table, formatSource, overrides)` écrit la valeur choisie
dans la colonne que le parseur attend **avant** de lancer le parseur **inchangé**.

**Garantie de non-régression (par construction) :** sans override,
`applyOverridesToTable` renvoie la table **telle quelle** → le parseur voit le
fichier d'origine → sortie **octet-pour-octet identique**. Prouvé par les 25
golden files (verts) + un test dédié « empty overrides = no-op ».

## 5. API moteur exposée

- `analyzePlan(headers, source, cible, entité, overrides?)` → plan lié aux vraies
  colonnes (bindings + confiance + `unused` + `missingRequiredSource` +
  `suggestedOverrides` + `reassignTargets`).
- `validatePlan(plan, overrides?)` → erreurs (source requise absente, cible
  requise non couverte, override sur champ non éditable) + avertissements.
- `applyOverridesToTable(table, source, overrides)` → table aliasée.
- `convert(csv, { …, mapping: { overrides } })` → conversion avec correspondances
  modifiées.
- `hasMappingPlan(source, cible)`, `targetFormatFor(direction, entité)`.
- Côté app : `analyzeMapping(csvText, direction, overrides?)` (controller).

## 6. Couverture actuelle & extension

Plans définis pour **les 3 entités** :
- **Produits** : 5 formats source (shopify, woo moderne, woo legacy, wix,
  bigcommerce) × 4 cibles (shopify, woo moderne, wix, bigcommerce).
- **Clients** : shopify / woo / bigcommerce (source et cible) — champs scalaires
  re-pointables ; adresse d'expédition Woo et rôles WordPress structurels.
- **Commandes** : shopify / woo / bigcommerce en source ; shopify / woo en cible
  (BigCommerce n'a pas d'import CSV de commandes). Champs de commande scalaires
  re-pointables ; blocs adresse (facturation/livraison) et lignes d'articles
  **structurels** (affichés, non re-pointables — transforms multi-colonnes).

BigBuy (catalogue fournisseur) n'a pas de plan éditable : `hasMappingPlan` renvoie
`false`, l'app affichera « correspondance automatique » pour ces fichiers.
`low`/heuristique de valeurs : point d'extension réservé (critère documenté,
activation ultérieure).

## 7. Canon générique — extension Phase 2 (additive uniquement)

Le canon partagé `@eloshon/catalog` a été enrichi de champs **optionnels** pour
représenter des concepts génériques multi-plateformes qui n'avaient pas de home
canonique. Aucun champ existant n'a été supprimé, renommé, ni rendu obligatoire.
Les parseurs et sérialiseurs actuels **ne les alimentent pas encore** — c'est
une extension du vocabulaire ; l'alimentation viendra dans les phases suivantes
(reconnaissance, adaptateurs, mapping canon → cible).

Distinctions à retenir :

- **`handle` vs `identity.slug` vs `identity.sourceId`** — `handle` reste la
  clé de regroupement/migration (déjà unifiée par `dedupeHandles`). `slug` est
  le slug d'URL public quand il doit être conservé distinctement. `sourceId`
  est l'identifiant assigné par la source (post id WooCommerce, product id
  Shopify…). Les trois peuvent coexister.
- **`options[]` vs `attributesRich[]`** — `options[]` reste la vue « axes de
  variation » (jusqu'à 3, remplis par chaque variante). `attributesRich[]`
  ajoute la vue complète des attributs source, y compris ceux qui sont
  descriptifs (`forVariation=false`) et étaient auparavant repliés en
  metafields. Les deux vues coexistent et se complètent.
- **`inventoryQty` vs `stockPolicy.manageStock`** — `inventoryQty` est la
  **quantité** ; `stockPolicy.manageStock` dit si la boutique **suit** ce
  stock. Deux faits indépendants (une boutique peut « ne pas gérer le stock »
  tout en ayant une quantité connue, et inversement).
- **Canon vs `sourceExtension`** — `sourceExtension` est un canal générique
  qui préserve une donnée source **quand elle n'a pas encore d'équivalent
  canonique**. Ce n'est pas un canon-fantôme parallèle ; les phases suivantes
  y puiseront pour PROMOUVOIR certaines entrées vers de vrais champs canon.
- **`kind` (générique)** — `'simple' | 'variable' | 'grouped' | 'external' | 'digital'`.
  Chaque adaptateur traduit son propre type produit (WC `grouped`,
  Shopify `giftcard`…) vers cette liste normalisée ; jamais l'inverse.
- **`salePeriod.from/to`** — normalisées en **ISO 8601 UTC** (`…Z`) quand
  l'adaptateur peut normaliser sans risque ; sinon la chaîne source brute est
  conservée telle quelle.
- **`digital.downloads` / `external.url`** — représentent les concepts
  génériques « fichier téléchargeable » et « produit externe/affilié », pas
  spécifiquement les cas WooCommerce.

**Rétrocompatibilité** garantie par les 25 golden files (byte-identiques) et
les 53 tests existants (verts) + 3 tests de contrat (`test/canon-shape.test.mjs`)
qui vérifient qu'un objet legacy reste valide et qu'un objet portant tous les
nouveaux champs est accepté sans faire échouer les sérialiseurs actuels.

## 8. Préservation des données — Phase 3 (canaux `sourceExtension` + `unmapped[]`)

Deux canaux additifs, tous deux optionnels et ignorés par les sérialiseurs
actuels (garanti par `test/preservation.test.mjs`) :

- **`sourceExtension: { [platform]: {...verbatim} }`** — les **valeurs** brutes
  d'une source, rangées sous le nom de la plateforme qui les a émises. Chaque
  adaptateur possède son propre namespace (`woocommerce`, `wix`, `shopify`,
  `bigcommerce`, `shopware`, `bigbuy`…) et **ne lit jamais** un autre
  namespace. Présent sur `CanonProduct` et `CanonVariant`.
- **`unmapped: UnmappedEntry[]`** — la **liste** énumérable des champs source
  conservés hors-canon, chacun avec un **motif** (`no-canon-field` |
  `platform-specific` | `unknown` | `ambiguous` | libre). Une UI peut lister
  « N champs non reconnus » sans traverser l'arbre verbatim de
  `sourceExtension`. Présent sur `CanonProduct`, `CanonVariant`, `CanonImage`.

Taxonomie appliquée par un adaptateur pour chaque champ source :

| Cas | `sourceExtension.<plat>` | `unmapped[]` avec reason |
|---|---|---|
| Canonique (adaptateur remplit un champ Canon) | — | — |
| Promotable (candidat pour futur champ canon) | valeur brute | `no-canon-field` |
| Spécifique à la plateforme (round-trip mais jamais promu) | valeur brute | (facultatif : `platform-specific` si UI doit l'afficher) |
| Inconnu (adaptateur ne sait pas quoi en faire) | valeur brute sous `_raw` | `unknown` |
| Ambigu (plusieurs candidats canon possibles) | valeur brute | `ambiguous` |

**Non concerné** : la « perte cible » (le canon a un champ, mais la
plateforme cible ne peut pas le recevoir) reste dans `ConvertResult.losses` —
c'est une préoccupation par-conversion, pas un fait du modèle source.

**Ce que Phase 3 ne fait PAS** : aucun parseur/sérialiseur actuel n'est
modifié pour remplir ces canaux. C'est un enrichissement du vocabulaire ; les
adaptateurs (Phase 5) et le recognizer (Phases 6-7) les rempliront ensuite.

## 9. Provenance — Phase 4 (`CanonProvenance` + `CanonProvenanceMap`)

Contrat additif optionnel présent sur `CanonProduct`, `CanonVariant`,
`CanonImage`. Répond à la question :
« pourquoi cette valeur canonique a-t-elle cette valeur, et d'où vient-elle ? ».

**Structure** : `provenance?: Record<canonicalPath, CanonProvenance>` avec
`CanonProvenance = { platform, sourceField, sourceValue?, transform?, method?,
confidence?, note? }`. Chemins canoniques dotés :
`'title'`, `'variants[0].price'`, `'options[1].name'`, `'images[0].src'`, etc.

**Méthodes** (`method`) alignées sur les niveaux de confiance existants :

| method | Sens | Confidence associée |
|---|---|---|
| `'exact'` | Colonne source par défaut au nom exact | `high` |
| `'alias'` | Nom proche connu | `check` |
| `'structural'` | Reconnu par structure (row-type, parent-enfant, groupement) | `high`/`check` |
| `'semantic'` | Reconnu par profil de valeurs (Phase 7) | `check`/`low` |
| `'override'` | Repointé par l'utilisateur | `check` |
| `'default'` | Rempli depuis une valeur par défaut (source silencieuse) | `check` |

**Indépendant de la source** : le shape marche identiquement pour CSV, JSON,
API distante, XML, base de données — chaque adaptateur choisit sa convention
pour `sourceField` (nom de colonne, JSON path, XPath…).

**Ce que Phase 4 ne fait PAS** : aucun parseur ne remplit `provenance` encore.
C'est le vocabulaire ; les adaptateurs Phase 5+ et le recognizer Phases 6-7
l'émettront sans changer le comportement existant.
