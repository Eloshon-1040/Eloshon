# Problèmes ligne par ligne + blocage export (ÉTAPE 4)

> Fichier : `core/src/problems.ts`. Le bilan agrégé (bloquant / avertissement /
> info / perte) est **recalculé** depuis la liste détaillée. Honnêteté : une
> gravité « bloquante » n'est attribuée que si l'import échoue réellement — pas
> pour matcher le libellé d'une maquette.

## 1. Modèle de problème

`Problem { id, code, severity, messageFr, messageEn, line, lineExact, unitId,
variant?, field?, value?, suggestion?, fixable, ignorable }`

- `line` = ligne tableur source. `lineExact = true` pour les formats à **une
  ligne par unité** (Woo legacy, clients, Woo orders) ; pour les formats groupés
  (Shopify/BigCommerce produits) la ligne est **exacte au niveau de la variante**
  (via une passe de provenance qui reproduit le regroupement de chaque parseur)
  et `lineExact = false` marque une ligne représentative d'unité.
- `unitId` = handle / SKU / e-mail / n° de commande. `variant` = SKU de variante.
- `field` = identifiant de champ (aligné sur `SOURCE_FIELDS` → permet la correction).
- `id` = `code#line#field`, stable dans un run → sert de clé pour Corriger/Ignorer.

## 2. Actions

- **Corriger** : édition de valeur, `corrections[line][field] = valeur`, appliquée
  à une **copie de travail** de la table (le fichier disque n'est jamais modifié),
  puis re-détection. À l'export, `convert(csv, { corrections })` applique la même
  correction. Précis : la clé (ligne, champ) vise exactement la bonne cellule
  (produit **ou** variante).
- **Ignorer** : uniquement les problèmes **non bloquants**. L'ignoré sort du
  décompte actif mais reste listé (`report.ignored`) → annulable avant export.
- **Export** autorisé ssi `counts.blocking === 0` (`canExport`).

## 3. Catalogue des codes

| code | gravité | ligne | corrigible | source / raison |
|---|---|---|---|---|
| `no_title` | **bloquant** | exacte | oui | Un produit sans nom ne peut être créé (Shopify/Woo/BigCommerce l'exigent). Le moteur le retire déjà. |
| `duplicate_sku` | **bloquant** (cible Woo/BC) · avertissement (Shopify/Wix) | variante | oui (renommer) | WooCommerce & BigCommerce insèrent/mettent à jour **par SKU** → un SKU en double écrase ou fait refuser le 2ᵉ produit. Source : WooCommerce Product CSV Importer. Shopify/Wix indexent par handle → avertissement. |
| `customer_no_email` | **bloquant** | exacte | oui | L'e-mail est la clé du compte client → sans lui, pas de création. Le moteur le retire. |
| `order_no_line_items` | **bloquant** | — | non | Une commande sans article n'est pas importable (géré par le bilan `convert()`). |
| `missing_price` | avertissement | variante | oui | Prix vide : le fichier reste valide, mais le produit sortira sans prix. |
| `negative_stock` | avertissement | variante | oui (→ 0) | Stock négatif : suggéré à 0. |
| `variant_missing_option` | avertissement | variante | non | Variante sans valeur d'option : **le moteur répare** en titre par variante (n'est donc pas bloquant, contrairement à la maquette). |
| `duplicate_handle` | info | unité | non | Identifiant en double : **rendu unique automatiquement** par le moteur. |
| `empty_description` | info | unité | oui | Description vide. |
| `duplicate_image` | info | unité | non | Même URL d'image réutilisée. |
| `duplicate_email` | avertissement | exacte | oui | Shopify n'importe que le dernier d'un e-mail partagé. |

Les **pertes** (`Loss`) et **questions** (ex. date MM/JJ ambiguë) restent produites
par `convert()` (limitations de la plateforme cible / ambiguïtés) et s'ajoutent au
bilan comme `loss` / à résoudre — elles ne sont pas des problèmes de ligne.

## 4. Règles de blocage — récapitulatif honnête

Le moteur est **robuste** : il répare beaucoup de choses (dédoublonnage de
handles, variante sans option, stock négatif). Les **seuls** blocages réels :

1. **Champ obligatoire absent pour créer l'unité** : titre produit, e-mail client.
2. **Identifiant en double empêchant l'import** : SKU en double vers Woo/BigCommerce.
3. **Unité vide** : commande sans article.

Tout le reste est avertissement / info / perte : l'export produit un fichier
valide, l'utilisateur est informé.

## 5. API

- `analyzeProblems(csvText, { direction, overrides?, corrections?, ignored? })`
  → `ProblemReport { ok, sourceFormat, targetPlatform, entity, problems, ignored,
  counts, canExport }`.
- `convert(csv, { …, mapping:{overrides}, corrections })` — export avec édits.
- Côté app : `analyzeIssues(csvText, direction, { overrides, corrections, ignored })`.

## 6. Performance

`analyzeProblems` est O(lignes) : un passage de regroupement + un passage de
vérifications. Sur plusieurs milliers de lignes, la liste est produite en une
passe ; l'UI (étape 5) la pagine/virtualise et filtre par gravité / champ / code.
