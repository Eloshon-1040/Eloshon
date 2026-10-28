# Phase 5.2 — KnowledgeBase schema + KnowledgeStore contract

Proposition isolée. Aucun code de production existant n'est modifié.
Ce dossier contient :

- `schema.d.ts`      — types canoniques de la KB (documentation TS pure).
- `schema.json`      — JSON Schema Draft-07 (validation runtime).
- `store.d.ts`       — interface `KnowledgeStore` + types support.
- `validator.mjs`    — validateur JSON-Schema minimal (subset), zéro dépendance.
- `json-store.mjs`   — implémentation JSON de référence (Reference read-only,
                       Learned read-write, overlay explicite).
- `recognizer.mjs`   — (5.3) FormatRecognizer : matching de signatures = données,
                       classement par spécificité, hash structurel, pont legacy.
- `reference.mjs`    — (5.3) loader synchrone de la strate Reference
                       (`core/knowledge-ref/formats/*.json`) pour l'engine sync.
- `tests/`           — suite `node --test` couvrant schéma + contrat.
- `transforms.mjs`   — (5.5) registre de transforms génériques paramétrés
                       (`args`, `inputs`) — aucune règle plateforme.
- `generic-parser.mjs` — (5.5) parser JSON piloté par un FormatKnowledge :
                       relations reconstruites, provenance, zéro perte
                       (`sourceExtension` + `unmapped[]`). Phase 2 : familles de
                       colonnes (`pathPattern`), filtre de lignes
                       (`structure.rows.include`), objets imbriqués préservés
                       (`structure.preserveNested`).
- `values.mjs`       — (Phase 2) correcteurs de valeurs CSV PARTAGÉS avec les
                       parsers du moteur (cleanScalar, consentement, codes
                       d'État US) : une seule implémentation.
- `legacy-units.mjs` — (Phase 2) passe générique de préservation + provenance
                       pour les formats CSV encore lus par un parser dédié :
                       `fields[]` + `structure.rows` (regroupement des lignes en
                       unités, en données) décrivent le format. Voir
                       `docs/phase2-legacy-formats.md`.
- La strate Reference vit dans `core/knowledge-ref/` (formats + canon).

## Strates (rappel §A Phase 5 v2)

| Strate     | Emplacement (runtime)                | R/W | Portée                 |
|------------|--------------------------------------|-----|------------------------|
| Reference  | `<app>/core/knowledge-ref/**`        | R   | livrée avec l'app      |
| Learned    | `<userData>/knowledge-local/**`      | RW  | par utilisateur/machine|
| Shareable  | (aucune impl — schéma neutre prévu)  | —   | export/promotion futur |

`overlayView(id)` renvoie `Reference ⊕ Learned` : l'identité d'une entrée est
`(path, canon, when, scope)` — une clé source peut alimenter plusieurs cibles
canon ; Learned écrase l'entrée de même identité et ajoute sinon. La provenance (`origin: 'reference' | 'learned'`) est
toujours calculable — jamais perdue.

## Lancer les tests

```
node --test core/knowledge-proposal/tests/*.test.mjs
```

Les tests écrivent uniquement dans un tmpdir OS ; aucun effet de bord sur le
repo ni sur les Learned files d'un utilisateur réel.

## 5.3 — FormatRecognizer (fait)

- Les 14 signatures qui vivaient dans `core/src/detect.ts` (`SIGS`) sont
  devenues 14 entrées Reference dans `core/knowledge-ref/formats/`.
  `detect.ts` n'est plus qu'un pont synchrone : `recognize()` +
  `toLegacyDetection()`. Goldens byte-identiques (25 cas).
- Extensions additives du schéma : `csv-header-set.anyOf` (gating « au moins
  un », ex-`any`), `entity`, et un bloc `legacy {formatId, platform, entity}`
  **transitoire** (5.3 → 5.9) pour router vers les parsers actuels.
- Classement des formats détectés par **spécificité** (nb de colonnes de
  signature matchées) puis couverture puis id — aucun ordre de liste à
  maintenir. Vérifié : aucune fixture ne matche plus d'une signature.
- `structuralHash(columns)` : hash 6-hex du jeu de colonnes normalisé →
  nomme les formats Scraper (`scraper.<site>.<hash>.v1`, règle 8) et matche
  les signatures `structural-hash`.
- Learned : un format écrit dans `<learnedDir>/formats/` est reconnu par
  `createFormatRecognizer(store)` sans code (test dédié). Sans bloc `legacy`
  il n'est pas encore convertible — c'est le rôle du parser générique (5.5).

## 5.4 — Reconnaissance sémantique des colonnes (fait)

- `semantic.mjs` : pipeline scoré par colonne — nom (exact → alias EN/FR →
  similarité tokens+Levenshtein) · profil de valeurs (prix, EAN, HTML, URL
  image, bool, int, enum, date, e-mail, unicité, vide) · contexte (familles
  structurelles `Image1..n` / `Attribute 1 name|value` / `Meta:*`, colonnes de
  référence parent→id, voisins). Résolution : `auto` ≥ 0.80, `suggest` ≥ 0.40
  (candidats classés + 3 samples réels bornés/redactés), sinon `none`.
- Connaissance = données : `core/knowledge-ref/canon/fields.v1.json`
  (66 champs, noms EN/FR, profils acceptés, familles, relation concept-map)
  et `recognition.v1.json` (seuils, poids, synonymes, classifieurs regex).
  Aucun `if` par plateforme.
- Décisions Learned : `confirmed`/`corrected` → `decided`, `rejected` exclut le
  candidat, `ignored` supprime la colonne ; portée `format` / `family` (glob) /
  `global`. `makeDecision()` + `toFieldMapEntries()` pour écrire la KB.
- Engine (opt-in) : `analyzePlan(…, { recognize: 'semantic', rows, formatId,
  decisions })` attache `plan.semantic` et pré-remplit `suggestedOverrides` ;
  `semanticAnalyze(headers, rows, entity)` marche sur un format inconnu.
  Sans l'option : plan et sortie strictement inchangés.
- Vérifié : 147/147 colonnes seed de `mapping.ts` retrouvées (144 en auto),
  en-têtes FR, valeurs seules (jamais auto), familles, références, redaction.

## 5.5 — Peuplement du canon via le parser générique (fait)

- `woocommerce.products.rest.v1` : 92 entrées, **chaque clé** du payload REST
  réel (WC 11.1.1, `test/fixtures/live/woocommerce-test`, PII pseudonymisées)
  a un sort déclaré : canon, `sourceExtension.woocommerce.*` (platform-specific),
  ou `unmapped[]` avec raison (`no-canon-field` = promotable). `unknownKeys: []`.
- Canon étendu réellement peuplé : `identity` (slug, sourceId, timestamps),
  `kind`, `visibility`, `merchandising`, `attributesRich` (forVariation),
  `defaultOptionValues`, `digital`, `notes`, `external`, variantes :
  `stockPolicy` (héritage `manage_stock: "parent"`), `salePeriod`, `taxClass`,
  `shippingClass`, `images[]`, GTIN → `barcode`, provenance sur chaque valeur.
- Relations concept-map exécutées par les données : product↔variant
  (`structure.variants` + companion), option↔value, hiérarchie de catégories
  (companion taxonomie, ancêtres absorbés), prix↔promo, stock par variante.
- Engine : `parseWooRestJson()` (3 lignes : nomme l'entrée + companions),
  `parseJsonWithKnowledge(formatId, payload, companions)`,
  `convertFromCanon(products, opts)` (même pipeline de finition que le CSV).
  Aller-retour REST → canon → CSV WC → parser CSV : champs portés identiques.

## 5.7 — Formats Scraper et formats appris, zéro parser par site (fait)

- `scraper.eloshon-export.v1` (Reference, `routing`) : les 4 exports réels
  (Levi's, April, Lidl.de, Colruyt ; 19 ou 21 colonnes) sont reconnus et
  convertis par le parser générique. `Detection.format === 'knowledge'`.
- `structure.variants.siblingsWhen` : les coloris frères (Levi's) vont dans
  `merchandising.related`, pas en variantes. `structure.options.fromVariants`,
  `variants.parseJson`, append `metafields[]` / `attributesRich[]` / `tags[]`.
- `learn.mjs` (Learned writer) : rapport sémantique + décisions →
  `FormatKnowledge` (hash structurel, transforms via
  `canon/transform-aliases.v1.json`) → `store.putLearnedFormat()` (nouveau dans
  le contrat, avec `removeLearnedFormat`). Id provisoire stable
  `unknown.csv.<hash>.v1` = les décisions prises avant l'apprentissage restent.
- Engine : `convert(csv, { knowledge: { formats } })` (Reference ⊕ Learned),
  `parseCsvWithKnowledge`, `learnFormat`, `proposeFormatId`, plateforme source
  `eloshon` + 4 directions. App : mode « Apprendre ce format » (étape 3) et
  table des correspondances d'un format connu. Détails et observations :
  `docs/phase5/5.7-scraper-formats.md`.

## 5.8 — Porte de qualité (fait)

37 cas golden (WC REST, Scraper, format appris ; canon gelé), round-trip WC
REST → CSV WC → canon strict sur les champs étendus, contrat analyse↔conversion
automatisé sur toute la matrice. Voir `docs/phase5/5.8-quality-gate.md`.

## Peuplement du canon — Shopware Admin API + héritage variante→parent (fait)

- `shopware.products.admin-api.v1` (Reference, 83 entrées) : chaque clé du
  payload réel (SW 6.7.2.2, 3 parents + 10 variantes) a un sort déclaré,
  `unknownKeys: []`. Nouveaux transforms génériques : `price_pick`,
  `options_from_settings`, `attributes_from_flat_options`,
  `category_paths_from_breadcrumbs`, `metafields_from_object`, `pick_where`,
  `constant`, `if_gt`, `equals_map`, `includes_map`.
- Parser générique : `structure.inheritance.nullMeansParent` (+ `exclude`) —
  un `null` sur l'enfant vaut la valeur du parent, provenance `method:
  'inherited'` (marqueur typé, 6.2 — remplace `structural` + note libre) ;
  `structure.variants.sameEntity` — les variantes
  sont des produits. Aucune règle Shopware dans le code.
- Sérialiseur WooCommerce : un attribut descriptif homonyme d'un axe
  d'options est rapporté (`loss_woo_attribute_collision`), pas écrit deux fois.
- Engine : `parseShopwareAdminJson`, plateforme source `shopware` (API
  seulement, non exposée dans l'app), 4 directions ; 41 cas golden.
- Synthèse des six modèles d'héritage réels : `docs/phase5/variant-inheritance.md`.

## 6.3 — P1 / P2 / P3 peuplés (fait)

- `shopify.products.admin-graphql.v1` (Reference, 66 entrées) : chaque clé du
  payload réel (35 produit + 27 variante) a un sort déclaré, `unknownKeys: []`.
  D3 : `seo.*` → canon, `global.title_tag` / `description_tag` consommés.
- Shopware : `translations` (+ slug par locale) → `translations[locale]`,
  `customFields` typés par la companion `customFieldSets`, `ean` /
  `manufacturerNumber` → `identifiers.*` (hérités, marqueur typé).
- Catalogue canon : `derivations` (`barcode ← gtin → ean → upc → isbn`),
  7 champs `identifiers.*`, famille `translations`. Pertes uniformes
  `loss_<cible>_translations` / `loss_<cible>_identifiers`. Détails :
  `docs/phase6/6.3-canon-population.md`.

## Ce que 5.2 ne fait PAS

- Aucun changement au canon (`@eloshon/catalog`).
- Aucun changement aux parsers, aux mappings.
- Aucun code spécifique à un site (règle « connaissance = donnée »).
- Pas de validateur JSON-Schema exhaustif : `validator.mjs` couvre le subset
  utilisé par ce schéma (types, enums, required, pattern, minItems, ref
  interne). Suffisant pour les tests ; à remplacer par `ajv` si un backend
  requiert plus.
