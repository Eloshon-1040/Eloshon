# Étape 3 « Correspondance » — plan d’implémentation (aligné sur system.md v2)

État de départ (28/10/2026, commits 6366dd0 à cd03cef) :
- clés de traduction résolues et testées ;
- `[hidden]` gagne toujours ;
- un seul défilement, avec en-tête collé ;
- destinations réelles en mode apprentissage, lues dans les sérialiseurs (`productDestinations()`) ;
- habillage refait sur les tokens partagés (phase 2, `design/converter-restyle`).

Référence visuelle : `.interface-design/system.md` v2 (§ 2.3, 3.1, 5.1, 5.2, 5.4, 5.5, **5.6**, **5.7**, 6, 7.7, 7.8) et la planche `.interface-design/specimen/index.html`. En cas d’écart, system.md gagne.

## 1. Un seul modèle pour les trois écrans
- **Données :** une fonction pure, `app/step3-rows.mjs` (`buildStep3`), appelée par `analyzeMapping`, produit pour les trois cas (format connu, plateforme reconnue, fichier inconnu) une même liste de **lignes-colonnes** (`analysis.step3.rows`).
  - Une ligne correspond à une colonne du FICHIER, jamais à une entrée interne du format. Les entrées `self` / `child` d’un format deviennent les destinations de la colonne qui les porte : `variants` est une ligne, avec SKU, options, image de variante…
  - Chaque ligne porte : 3 exemples réels au plus, le remplissage N/M, un statut (utilisée / ignorée / non identifiée / vide), ses destinations (champ, colonnes réelles de la cible, transformation), une fiabilité, une raison, une origine, une alerte éventuelle, ce que « Modifier » touche, des détails techniques.
  - Une colonne lue avec sa famille (Option1 Value, Image Alt Text, métachamps) est une ligne, marquée « lue avec sa famille », sans « Modifier ».
- **Destinations :** colonnes réelles de la cible, lues dans les sérialiseurs : `productDestinations()` pour les champs décrits, `entryDestinations()` (même sonde, sur l’entrée du format et la vraie valeur de la colonne) pour les autres (adresse de la page source, attribut descriptif, slug).
- **Fiabilité :** score ≥ 0,85 → Sûr ; 0,60 à 0,85 → À vérifier ; < 0,60 → Incertain ; colonne vide sur toutes les lignes → **Vide** (jamais Sûr, hors du compte « Sûres »).
  - Origines : *reconnu par son nom*, *confirmé par vous*, *règle connue pour ce format*, *déduit des valeurs*.
  - Raison fondée sur les valeurs quand le profil est net (« Les valeurs sont des codes-barres EAN »), 45 caractères au plus.
  - **Alerte** quand les valeurs contredisent la destination (`skuVerdict` pour le SKU, profils de valeurs sinon) : au moins « À vérifier », raison en `--warn` avec icône.
- **Libellés :** champs (`canon_*`), transformations (`tr_*`), raisons (`s3r_*`), alertes (`s3a_*`), origines (`s3o_*`), natures de valeurs (`s3k_*`), thèmes (`s3g_*`), conséquences (`s3u_*`), en FR et EN. Le test `ui-keys` vérifie chaque famille.
- **Modèle de données du produit et données mémorisées :** inchangés. Seule une structure d’affichage est ajoutée.

## 2. Le tableau (system.md § 5.6)
- Une seule fonction de rendu pour les trois cas ; les trois anciennes (`renderMappingTable`, `renderKnowledgeTable`, `renderLearnTable`) sont retirées, leurs garanties reprises par les tests.
- Ligne-phrase : « Votre colonne » (nom mono, barre de remplissage 40 px, N/M, exemples entre « ») → « Sera écrite dans » (flèche, libellé humain, colonne de la plateforme en mono, transformation en clair) → « Fiabilité » (pastille `status-chip` avec icône SVG, raison + origine) → « Modifier ».
- **Deux dispositions** par requête de conteneur (`container: map / inline-size`) : tableau ≥ 960 px → une ligne de 36 px ; en dessous → deux lignes de 56 px.
- Ce qui peut être coupé : les exemples (et, sur une ligne réglée, la transformation et la raison), avec `title`. Le libellé humain et la colonne de la plateforme ne sont jamais coupés. Une ligne à traiter ne coupe jamais sa raison (2 lignes au plus).
- « Détails techniques » repliés dans chaque ligne : exemples complets, champ interne, transformation.
- Un seul défilement vertical (la page), en-tête du tableau collé ; l’aperçu défile seulement à l’horizontale.

## 3. Recherche, filtres, tri
- Recherche (Ctrl+F) sur le nom de colonne, les exemples, le libellé et la colonne de la plateforme.
- Pastilles-filtres avec leur compte, dans l’ordre : **À traiter** (ouverture par défaut dès qu’une ligne est À vérifier ou Incertain), Toutes, Sûres, À vérifier, Incertaines, Vides, Ignorées. Raccourcis Ctrl+1 à Ctrl+7.
- Tri par fiabilité, la plus basse d’abord : Incertain, À vérifier, Sûr, Vide ; colonnes ignorées en dernier.
- Colonnes ignorées : la raison, ce qui est perdu à l’export (« 5 valeurs ne seront pas écrites »), et « Utiliser quand même ».

## 4. Liste « Modifier »
- Liste maison (pas de liste native), dans un dialogue : recherche, destination actuelle en tête, propositions du moteur avec leur score, puis les champs groupés par thème (Identité, Prix, Stock, Images, Variantes, Description, Référencement, Autre), puis « Ignorer cette colonne » et « Garder comme champ personnalisé ».
- Chaque option affiche la colonne réelle de la plateforme ou « non repris par [plateforme] ». Aperçu de l’effet avant validation.
- Clavier complet et ARIA (`listbox`, `option`, `aria-activedescendant`), Échap rend le focus à la ligne.
- Elle appelle les actions EXISTANTES de chaque cas : surcharges (plateforme reconnue), `kb:editColumn` (format connu), `kb:decide` (fichier inconnu, colonne non lue par une règle). Rien ne change dans ce qui est enregistré.

## 5. « Champs de la plateforme non alimentés » et générateur de SKU
- Les champs obligatoires de la cible d’abord (`REQUIRED_P`), puis les importants (SKU, prix, images, description, stock, code-barres, marque, catégories), avec la conséquence de chacun.
- Générateur de SKU désactivé par défaut ; réglages (source, préfixe, séparateur, casse, longueur maximale, accents) avec les vraies règles de `sku.mjs` ; aperçu avant/après sur 6 lignes (`previewSkus`, calculé par la conversion d’aperçu) ; option `skuGenerator` passée à la conversion ; SKU générés marqués « générés » à l’étape 4.
- WooCommerce : ligne fixe « SKU parent généré », texte validé : « Dans WooCommerce, les variations sont rattachées à leur produit par le SKU du parent. Sans SKU parent, elles ne sont pas reliées. »
- **Décision prise (défaut proposé) :** les réglages du générateur sont mémorisés par format, sur cet ordinateur (`config.json`, clé `skuGenerators`, indexée par l’identifiant du format).

## 6. Aperçu en direct
- « Première ligne telle que [plateforme] la recevra » : les cellules remplies de la première ligne exportée, recalculées après chaque choix ; le tableau des lignes converties reste dessous (défilement horizontal seulement).

## 7. Bandeau en français simple
- « Voici comment chaque colonne de votre fichier sera utilisée pour créer votre fichier [plateforme]. Vérifiez les lignes marquées À vérifier. Vos choix sont mémorisés sur cet ordinateur pour les prochains fichiers de ce type. »
- Volet « Comment c’est mémorisé ? » avec la portée réelle (diagnostic.md, « Mémorisation ») : format connu → les prochains fichiers de ce format ; fichier inconnu ou plateforme → toute colonne du même nom, accents, casse et séparateurs ignorés ; format appris → aussi un fichier presque identique (80 % de colonnes communes au moins).

## 8. États
- Vide : aucune colonne reconnue → ce qui apparaîtra et comment l’obtenir (Modifier, puis Mémoriser ce format).
- Erreur : l’enregistrement d’un choix a échoué → à la place de l’élément, ce qui s’est passé, quoi faire, « Réessayer ».
- Clavier (§ 5.7) : le tableau est un seul arrêt de tabulation, focus itinérant sur les lignes, ↑ / ↓, Début / Fin, → déplie, ← replie, Entrée ouvre « Modifier », Échap ferme, Ctrl+F, Ctrl+1 à 7 ; rangée de `<kbd>` sous le tableau.

## 9. Découpage en commits (chacun testé)
1. Données des lignes-colonnes (`step3-rows.mjs`), destinations des entrées de format, libellés, tests sur fixtures réelles.
2. Tableau unifié (deux dispositions, pastilles, détails techniques), états vide et erreur.
3. Recherche, pastilles-filtres, tri, colonnes ignorées avec « Utiliser quand même », clavier.
4. Liste « Modifier » maison.
5. Encart « non alimentés » et générateur de SKU (option branchée jusqu’à la conversion, SKU « générés » à l’étape 4).
6. Aperçu « première ligne », en direct.
7. Bandeau en français simple et « Comment c’est mémorisé ? ».

## 10. Ce qui reste ouvert
- **[DÉCISION ANDY] Multi-cibles (ancien commit 8) :** une conversion vers plusieurs plateformes compte-t-elle une fois ou une fois par fichier ? La réponse touche la licence et `convert-service`. En attendant, l’écran affiche la cible choisie dans son en-tête, sans sélecteur.
- **[DÉCISION ANDY, phase 2] Menu latéral repliable** (system.md § 5.6) : il donnerait la disposition sur une ligne à 1366 × 768 en 125 %.
- NL et ES : phase 4.

Vérification à chaque étape : suite complète du Converter, captures de l’app réelle (Electron, dossier de données temporaire) à 940 × 640, 1366 × 768, 1920 × 1080, 125 % et 150 %, clair et sombre, parcours au clavier. Aucune release sans accord.
