# État des lieux — Eloshon Converter (avant enrichissement du moteur)

> ÉTAPE 0 du chantier « moteur v2 ». Document d'observation : rien n'est modifié
> ici. Branche de travail : `feature/engine-v2` (partant de `main` @ `5f81473`).
> Rédigé le 2026-09-17.

---

## 1. Ce qui existe déjà dans `C:\eloshon-converter`

[OBSERVATION]

Dépôt Git, branche `main`, 2 commits :

- `5400521` — extraction du moteur de conversion depuis Homie Book vers `core/`
  (copie seule ; Homie Book non modifié), vérifié sans tête (headless).
- `5f81473` — couche OS (`lib/osenv.mjs`) + contrôleur de conversion
  (`app/controller.mjs`) avec la borne freemium (gratuit 10 lignes / complet si
  licence), vérifié sans tête.

Arborescence (hors `node_modules`) :

```
core/
  src/        12 fichiers .ts  — moteur pur, copié tel quel de Homie Book
  dist/       12 fichiers .mjs — transpilés (gitignorés), produits par build:engine
  directions.mjs   catalogue des 14 conversions (freeLimit 10, priceEur 19)
lib/
  osenv.mjs   couche OS : chemins app-data, chrome fenêtre (mac/Win), modKey
app/
  controller.mjs   analyze() + runConversion() (borne freemium), pur & testable
scripts/
  build-engine.mjs      transpile TS → dist/*.mjs (API TypeScript + regex .mjs)
  verify-core.mjs       preuve : detect + convert Shopify→Woo + cap 10 + mauvais fichier
  verify-controller.mjs preuve : analyze + gratuit(10)/licence(complet)
build/        (vide)  — réservé aux ressources d'empaquetage (icône, etc.)
test/         (vide)  — aucun test automatisé pour l'instant
package.json  type:module ; scripts build:engine / verify-* / test ; devDep: typescript
.gitignore    node_modules, dist, out, core/dist, data
```

**Technologie déjà choisie (à conserver, cf. ÉTAPE 5.6 de la consigne) :**
Electron pour l'app de bureau (comme Eloshon Scraper), moteur en TypeScript
transpilé en ESM sans bundler. Electron/electron-builder **pas encore installés**
(seul `typescript` est en devDependencies). L'app (main/preload/renderer) **n'a
pas encore été écrite** : seuls le moteur, la couche OS et le contrôleur existent.
La pause pour le design est intervenue avant l'écriture de la fenêtre.

---

## 2. Le moteur copié — architecture et flux de données

[OBSERVATION]

Le moteur est **pur** (aucun accès réseau, fichier, DOM, Supabase, React). Il
prend une **chaîne** CSV et renvoie des **données** (chaînes + objets). L'écriture
disque et les dialogues natifs sont la responsabilité du process principal
Electron, pas du moteur.

### 2.1 Flux (une conversion)

```
texte CSV
 └─ parseCsv (csv.ts)
      • retire le BOM UTF-8, répare le mojibake (Ã©→é), renifle le séparateur ( , ; \t )
      • parse RFC 4180 (guillemets, sauts de ligne dans les cellules)
      • valeurs gardées en STRING (préserve les zéros de tête des SKU)
      → Table { headers: string[], rows: Row[], malformed: number[] }
        (malformed = n° de lignes tableur ayant PLUS de champs que d'en-têtes)
 └─ detectFormat (detect.ts)
      • signatures = ensembles d'en-têtes propres à chaque format
      → { format, platform, entity }   (ou 'unknown')
 └─ convert() (index.ts) — aiguillage + garde-fous :
      • fichier vide / non reconnu / mauvaise plateforme / conversion impossible
        (capability.ts) → ConvertResult ok:false avec un CODE de diagnostic
      • sinon, par entité détectée :
          products  → parse<Source>Products(headers, rows) → CanonProduct[]
          customers → parse<Source>Customers(rows)          → CanonCustomer[]
          orders    → parse<Source>Orders(rows)             → CanonOrder[]
      • validation ligne (voir 2.4) → RowError[]  (produits sans titre, etc.)
      • dedupeHandles / duplicateSkuWarnings / malformedWarning → Warning[]
      • cap(usable, limitUnits)   ← BORNE FREEMIUM (coupe la SORTIE à N unités)
      • serialize<Target>(capped) → { headers, rows }
      • pertes via <entity>LossesFor(source, target) → Loss[]
      → ConvertResult
```

### 2.2 Le hub : représentation canonique (IR)

Toutes les correspondances passent par une **représentation intermédiaire
canonique**, définie dans `types.ts` :

- `CanonProduct` : handle, title, bodyHtml, vendor, productType, tags[], status,
  categories[], published, options[{name,values[]}], variants[CanonVariant],
  images[CanonImage], metafields[{key,value}], seoTitle, seoDescription.
- `CanonVariant` : optionValues[], sku, price, compareAtPrice, cost, barcode,
  grams, lengthCm/widthCm/heightCm, requiresShipping, taxable, inventoryQty,
  imageSrc.
- `CanonCustomer` / `CanonAddress`, `CanonOrder` / `CanonLineItem`.

**Invariant prix** (respecté par tous les parseurs/sérialiseurs) : `price` = prix
réellement payé (le plus bas en promo), `compareAtPrice` = ancien prix barré (le
plus haut). Woo `Sale price`, BC `Sale Price`, la remise Wix sont des prix promo
plus bas → les parseurs les **échangent** vers cet invariant, et les sérialiseurs
ré-échangent en sortie.

### 2.3 **Où sont définies les correspondances** (point clé pour l'ÉTAPE 2)

Il n'existe **aucune table de correspondance déclarative**. La correspondance est
**du code impératif**, scindée en deux moitiés autour de l'IR :

| Moitié | Fichier / fonction | Ce qu'elle fait |
|---|---|---|
| **colonne source → champ canon** | `parse<Source>…` (products.ts, wix.ts, bigcommerce.ts, customers.ts, orders.ts, bigbuy.ts) | lit des colonnes **par nom fixe** (`r['Variant Price']`) et remplit l'IR |
| **champ canon → colonne cible** | `serialize<Target>…` (mêmes fichiers) | écrit des colonnes cibles fixes depuis l'IR |

Donc, à l'écran « correspondance des colonnes » du design, une ligne
« colonne source → colonne cible » est en réalité la **composition** :
`colonne source → champ canon → colonne cible`.

Conséquences importantes :

- Beaucoup de correspondances **ne sont pas 1-pour-1** : le prix combine `Regular
  price` + `Sale price` + échange promo ; le poids fait grammes↔kg ; les options
  Woo « toutes remplies » deviennent options, sinon métachamps ; BigCommerce
  attache par ordre de lignes (`Item`) ; les commandes Woo empaquètent les lignes
  d'articles dans des listes parallèles filtrées par `item_type`.
- Une remise « libre » (n'importe quelle colonne source → n'importe quelle
  colonne cible) n'est donc **pas** faisable sans réécrire tous les transforms.
  → l'ÉTAPE 2 doit exposer/rendre modifiable la correspondance **de façon bornée
  et sûre**, sans réécrire les transforms (voir §5, proposition d'architecture).

### 2.4 Informations de ligne disponibles pendant la validation

[OBSERVATION] [NÉCESSITÉ TECHNIQUE]

Aujourd'hui la validation ligne renvoie `RowError { row, field?, code, params? }`.
Le `row` vaut `index_unité + 2` (1 en-tête + base 1). C'est **exact** pour les
formats à **une ligne par unité** : produits Woo modern (parent), Woo legacy, Wix
(parent), clients (tous), commandes Woo. C'est **imprécis** pour :

- **Shopify products** — groupés par `Handle` sur plusieurs lignes ; `row` est
  l'index du PRODUIT, pas la vraie ligne tableur.
- **BigCommerce products** — lignes typées `Item` (Product/Variant/Image) ; idem.
- **Shopify orders** — une ligne par article, en-tête sur la première.

Pour l'ÉTAPE 4 (problèmes ligne par ligne avec « Corriger/Ignorer » et n° de
ligne fiable), il faudra que les parseurs **retiennent le vrai n° de ligne source
et l'identité produit** (handle / SKU / ID) à côté de chaque unité. C'est une
**nécessité technique** de l'ÉTAPE 4, pas de l'ÉTAPE 2.

### 2.5 Conversions réellement prises en charge

[OBSERVATION]

Plateformes : `shopify`, `woocommerce`, `wix`, `bigcommerce`, `bigbuy` (source
seule). Entités : `products`, `customers`, `orders`. 14 directions
(`directions.mjs`). Deux impossibilités **dures** encodées dans `capability.ts`
(vérifiées côté plateformes) :

- **BigCommerce n'a pas d'import CSV de commandes** (API seulement) → jamais cible
  de commandes.
- **Wix n'importe que des produits en CSV** → jamais cible clients/commandes.

Formats détectés (`detect.ts`, 14 signatures) : shopify_products,
woo_products_modern, woo_products_legacy, shopify_customers, woo_customers,
shopify_orders, woo_orders, bigbuy_standard, bigbuy_presta, presta_categories,
wix_products, bigcommerce_products, bigcommerce_customers, bigcommerce_orders.

BigBuy : catalogue fournisseur en 2 mises en page (standard 33 col / PrestaShop
56 col), **semicolon-séparé**, catégories par ID numérique → **fichier de
catégories compagnon obligatoire** ; fichier langue secondaire optionnel →
métachamps de traduction.

### 2.6 Diagnostics = codes, jamais de prose

`RowError`, `Loss`, `Warning`, `Question` portent un **code** i18n + des `params`,
pas une phrase. L'app rend `converter.diag.<code>` dans la langue du lecteur.
→ toute nouvelle catégorie de problème (ÉTAPE 4) doit suivre ce contrat (code +
params), et fournir les libellés FR/EN.

---

## 3. Tests existants et couverture

[OBSERVATION]

- **Aucun test automatisé** (`test/` vide ; `package.json > test` cible
  `test/*.test.mjs` qui n'existent pas encore).
- Deux scripts de **preuve manuelle** (assertions Node, pas un runner) :
  `verify-core.mjs` (detect + Shopify→Woo 14→14 + cap 10 + garde mauvais fichier)
  et `verify-controller.mjs` (analyze + freemium).
- **Pas de tsconfig** → pas de typecheck réel aujourd'hui ; **pas de lint**.

→ ÉTAPE 1 doit créer le vrai filet : fichiers d'exemple par plateforme +
sorties de référence (« golden files ») produites par le moteur ACTUEL +
tests de non-régression. Un `tsconfig.json` (typecheck `tsc --noEmit`) est aussi
à ajouter (voir décisions §6).

---

## 4. Réutilisable / à adapter / à laisser (rien n'est supprimé à ce stade)

[OBSERVATION]

**Réutilisable tel quel :**
- `core/src/*.ts` — le moteur pur (parse/detect/serialize/normalize/capability).
  Ne pas toucher les transforms ; on ajoute une couche AU-DESSUS.
- `csv.ts` (`parseCsv`/`serializeCsv`/`splitList`), `normalize.ts` (tous les
  fixeurs de valeurs), `capability.ts`.
- `lib/osenv.mjs` — chemins app-data (déjà prévoit `configFile`, `licenseFile`,
  `recentFile` → historique & licence).
- `scripts/build-engine.mjs` — la chaîne de build TS→ESM.
- `core/directions.mjs` — le catalogue (freeLimit/priceEur).

**À adapter / étendre (sans casser le défaut) :**
- `app/controller.mjs` — `analyze()`/`runConversion()` devront exposer les
  correspondances (ÉTAPE 2), accepter des correspondances modifiées, produire la
  liste de problèmes détaillée (ÉTAPE 4), gérer les modèles (ÉTAPE 3).
- `index.ts > convert()` — accepter une option `mapping?` **optionnelle** dont
  l'absence = comportement identique à aujourd'hui (garantie de non-régression).
- parseurs produits — pour l'ÉTAPE 4, retenir vrai n° de ligne + identité.

**À laisser de côté pour l'instant (non supprimé) :**
- Rien à jeter. Le design mentionne « PrestaShop (bientôt) » comme plateforme :
  hors périmètre moteur actuel → restera marqué « à venir » côté UI.

---

## 5. [PROPOSITION] Architecture pour rendre les 3 fonctions réelles

> Détail complet et exemples viendront à l'ÉTAPE 2. Ébauche validée par la
> lecture du code, pour cadrer la suite. Ceci reste une [PROPOSITION].

1. **Correspondances déclaratives, au-dessus des transforms existants.**
   Un « plan de correspondance » par paire (formatSource → formatCible) décrit,
   pour chaque **champ canon**, la/les colonne(s) source par défaut, le transform
   (par identifiant nommé : `copy`, `price_promo`, `grams_from_kg`, …), le
   caractère requis, et une description FR/EN. Le plan est **dérivé du code réel**
   (il décrit ce que le moteur fait déjà), donc défaut = sortie identique.

2. **Modifiable de façon sûre = alias de colonne source, appliqué AVANT le
   parseur existant.** Repointer un champ canon vers une autre colonne source, ou
   l'exclure, se traduit par un renommage/masquage d'en-tête sur la `Table` avant
   d'appeler le parseur **inchangé**. Sans override → aucun alias → sortie
   octet-pour-octet identique **par construction**. (Le côté cible reste piloté
   par les transforms ; l'édition côté cible se limite à « ne pas importer » /
   passage en métachamp — honnête et non destructif.)

3. **Niveaux de confiance déterministes** (critères à figer en ÉTAPE 2) :
   Élevée = colonne attendue présente au nom exact ; À vérifier = trouvée via un
   alias/nom proche connu ; Faible = déduite par heuristique sur les valeurs ;
   Non utilisée = colonne source présente sans destination.

4. **Modèles** = un jeu d'overrides + paire + empreinte des colonnes source
   attendues + version du format de règles, stockés en JSON dans le dossier
   app-data (`lib/osenv.mjs` prévoit déjà l'emplacement). Appliqué à un fichier
   aux colonnes différentes → signaler colonnes manquantes/nouvelles.

5. **Problèmes ligne par ligne** = une liste détaillée (code, gravité, n° ligne
   source, identité produit, champ, valeur, suggestion) dont le bilan agrégé
   actuel (errors/losses/warnings) est **recalculé**. « Corriger » = édition en
   mémoire (jamais le fichier disque) + revalidation ; « Ignorer » = non
   bloquants seulement ; blocage export = uniquement problèmes réellement
   bloquants, chaque règle documentée avec sa source.

---

## 6. [DÉCISION UTILISATEUR] à prendre (rappel — détaillées dans le rapport final)

1. **Lint** : pas d'ESLint aujourd'hui. Option A (recommandée) — utiliser
   `tsc --noEmit` strict comme garde de type/qualité, sans ajouter ESLint (zéro
   dépendance lourde). Option B — ajouter ESLint (config plate) en devDep.
   → en attendant, j'installe le typecheck `tsc --noEmit` dès l'ÉTAPE 1.
2. Emplacement/nommage exact des modèles et de l'historique (proposé à l'ÉTAPE 3).
3. Critères de confiance définitifs (proposés et appliqués à l'ÉTAPE 2).
