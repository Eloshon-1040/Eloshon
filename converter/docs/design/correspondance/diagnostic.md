# Étape 3 « Correspondance » — diagnostic (27/10/2026, Converter 0.1.8 + commits bb5f5df / ef10b9f)

Relevé dans l'app réelle, lancée dans un dossier de données temporaire (jamais le vôtre), fenêtre 1600 × 1000.
Captures : `captures/` (`adidas-*` = export Scraper adidas réel, `shopify-woo-*` = fichier Shopify à variantes
→ WooCommerce, `unknown-*` = fichier fournisseur inconnu).

## Trois écrans différents pour la même étape

| Fichier | Écran affiché | Code |
|---|---|---|
| Format connu (export Scraper, formats livrés) | « Correspondances de ce format » : Colonne / Champ canonique / Transformation / Confiance / Exemple / Modifier | `renderKnowledgeTable` (`app/renderer/app.js:656`) |
| Plateforme reconnue par l'ancien moteur (Shopify, Woo, Wix, BigCommerce) | Colonne source / Type / Champ cible / Confiance « Élevée · 100 % » / Exemple, avec onglets-filtres et destination sous la liste | `renderMappingTable` (`app.js:425`) |
| Fichier inconnu | « Apprendre ce format » : propositions à cocher par colonne | `renderLearnTable` (`app.js:635`) |

Les noms de colonnes, la confiance, les filtres et la façon de modifier diffèrent d'un écran à l'autre.

## Ce qui est incompréhensible ou faux

1. **Clés de traduction brutes.** L'encart « Modifications » affiche `ed_title`, `ed_sub`, `ed_none`, `+ ed_add`. Dans l'aperçu, on voit aussi `ed_out_title`, `ed_out_sub`, `ed_coll_tags`, `ed_coll_help` et `+ ed_out_add`. La liste « Modifier » affiche `(s3_kn_not_carried)`.
   Cause : 29 clés sont rangées dans la section `diag` d'`i18n.js` au lieu de `ui`, et `t()` ne cherche que dans `ui`.
2. **Bande rose vide** sous le tableau. C'est l'encart d'erreur `#kn-err`, marqué `hidden`, mais `.banner { display: flex }` l'emporte sur `hidden`.
3. **Double défilement.** La page (`.scroll`) défile, et le tableau aussi (`.tbl-wrap.h`, `max-height: 46vh`). L'aperçu ajoute un troisième défilement, horizontal. L'en-tête du tableau n'est pas fixe.
4. **Noms de code au lieu de libellés.**
   - Colonne « Champ canonique » : `identity.sourceId`, `bodyHtml`, `sourceExtension.eloshon.source_url`, `variants[].sku`.
   - Colonne « Transformation » : `string_id`, `category_path_split`, `images_from_urls`, `option_values_from_typed`, `inherit_from_parent`.
   - Mentions `self` / `child` sous le nom de colonne.
5. **Une ligne par entrée interne du format, pas par colonne du fichier.**
   - Le fichier adidas a 25 colonnes, le tableau 40 lignes.
   - `slug` apparaît 2 fois, `image_url` 2 fois et `is_alcoholic` 2 fois. La seconde ligne n'a pas de liste « Modifier ».
   - La colonne `variants` n'apparaît pas en tant que telle. Ses sous-clés apparaissent comme lignes : `code child`, `type child`, `price child`, `url child`…
6. **La destination réelle n'apparaît pas dans la ligne.** On la trouve seulement dans les libellés de la liste (« SKU → Variant SKU »).
7. **« verified-fixture » partout** dans la colonne Confiance. C'est la valeur interne du format JSON : ni niveau, ni raison.
8. **Exemples tronqués** (« … »), une seule valeur, aucun taux de remplissage. Sur le fichier adidas, `barcode`, `weight_kg`, `hs_code`, `product_type` et `net_content` sont vides sur 5 lignes sur 5, sans que l'écran le dise.
9. **Pastilles non cliquables** sur l'écran « format connu » : « 25 colonnes », « 23 reconnues automatiquement », « 2 ignorées ». On ne sait pas quelles colonnes sont ignorées, ni ce qui est perdu. Les filtres n'existent que sur l'écran automatique.
10. **Liste « Modifier ».**
    - Liste native au style différent du reste, 45 options à plat, sans recherche, sans afficher la destination actuelle (« Changer la destination… »).
    - Quatre champs sans libellé : `shortDescription`, `vatRate`, `currency`, `unitPrice`.
11. **Bug de l'écran « Apprendre ce format ».** Chaque proposition affiche « ce champ n'est pas repris par la cible Shopify », y compris SKU et Titre, qui le sont pourtant.
    Cause : les colonnes de destination ne sont calculées que pour un format livré (`targetCols: origin === 'reference' ? … : {}`, `app/controller.mjs:145`).
12. **Bandeau en jargon** : « décrit par la base de connaissances », « convertisseur générique ».
13. **Destination tirée d'une table recopiée** (`TARGET_FIELDS`, `core/src/mapping.ts:465`), et non des sérialiseurs.
    Dérive constatée : pour WooCommerce, la table dit encore « handle → SKU (parent) ». Or depuis bb5f5df, le SKU parent est le SKU de la source ou un SKU généré, plus jamais le handle.
14. **Une seule plateforme cible à l'étape 1** (`S.tgt`). L'objectif 3 (sélecteur quand plusieurs plateformes sont choisies) demande de changer l'étape 1.
15. **Ancien fichier adidas.** L'aperçu montre `Option1 Name` = « option » et `Option1 Value` = « Couleur du produit : … ». Les nouveaux scraps n'auront plus ce défaut (correctif Scraper 43f98a0), mais le Converter recopie tels quels les anciens fichiers.

## Mémorisation : ce que le code fait réellement

- **Format connu** (« Modifier » → `kb:editColumn`) : surcouche du format, enregistrée sur cet ordinateur (`learned/overlays/<format>.json`). Elle s'applique aux prochains fichiers **de ce format**. Le format livré n'est jamais modifié.
- **Écran automatique et fichier inconnu** (`kb:decide`) : décision de portée « colonne » par défaut. Elle s'applique à **toute colonne du même nom** (accents, casse et séparateurs ignorés), dans tout fichier, sur cet ordinateur.
- **Format appris** (« Mémoriser ce format ») : il reconnaît aussi un fichier presque identique, d'au moins 4 colonnes et dont au moins 80 % des colonnes sont communes.
