# Brief — Eloshon Converter, étape 3 « Correspondance »

*À coller dans Claude Design. Joindre les captures `captures/adidas-step3-top.png`, `captures/shopify-woo-step3-top.png` et `captures/unknown-step3-top.png`.*

## Contexte

Eloshon Converter est une application de bureau (Electron, fenêtre de 1100 à 1920 px de large) qui convertit un fichier catalogue en fichier d'import pour une boutique. Les sources possibles sont un export du Scraper Eloshon, Shopify, WooCommerce, Wix, BigCommerce, Shopware, PrestaShop ou un fichier fournisseur inconnu. Les cibles sont Shopify, WooCommerce, Wix et BigCommerce.

Le parcours compte 5 étapes : Plateformes → Fichier → **Correspondance** → Contrôle → Export.

Lecteur : un commerçant, pas un développeur. Il veut savoir, pour chaque colonne de son fichier, **où elle sera écrite dans le fichier de sa plateforme**, si c'est fiable, et corriger en deux clics ce qui ne va pas.

Aujourd'hui, l'étape 3 a trois écrans différents selon le fichier (format connu, plateforme reconnue, fichier inconnu ; voir les captures). **Le nouvel écran les remplace tous les trois** : même structure, avec des variantes d'état.

## Ce que l'écran doit faire (objectifs)

1. **Chaque ligne se lit comme une phrase.** Exemple réel, fichier adidas vers Shopify :
   « **name** — *Chaussure Handball Spezial*, *Chaussure de football F50 Hyperfast Elite Y-3…* · rempli 5/5 → **Nom du produit** → Shopify « Title » · texte repris tel quel · **Sûr** ».
2. **Libellés humains** (« Nom du produit », « Adresse web de la page (handle) », « Adresse de la fiche source »). Les noms techniques (`identity.sourceId`, `bodyHtml`) vont dans un volet « Détails techniques », replié par défaut, dans chaque ligne.
3. **Plusieurs plateformes cibles** : un sélecteur en haut affiche la destination pour la plateforme choisie (Shopify « Title », WooCommerce « Name », Wix « name », BigCommerce « Name »). *Aujourd'hui, l'étape 1 n'autorise qu'une cible : dessiner le sélecteur quand même.*
4. **Fiabilité en 3 niveaux** : **Sûr** / **À vérifier** / **Incertain**.
   - Chaque niveau a une raison d'une phrase, fondée sur le nom ET les valeurs, et une origine : *reconnu par son nom*, *confirmé par vous*, *règle connue pour ce format* ou *déduit des valeurs*.
   - Exemples : « 98 % des valeurs sont des EAN valides », « Nom de colonne connu pour ce format ; 5 valeurs sur 5 sont des nombres ».
   - **Alerte quand les valeurs contredisent la destination** : « Les valeurs ressemblent à des libellés (“Couleur du produit : Aurora Coffee / …”), pas à des SKU ».
5. **Une colonne source = une ligne**, même si elle alimente plusieurs champs. Exemple : `slug` → « Adresse web de la page (handle) » ET « Identifiant de la page ». Les destinations sont listées dans la ligne, chacune modifiable et expliquée.
6. **Colonnes ignorées.**
   - Une liste dédiée, avec pour chaque colonne la raison et ce qui est perdu à l'export, et un bouton « Utiliser quand même ».
   - Les pastilles de synthèse (« 25 colonnes », « 21 reconnues », « 2 validées par vous », « 2 ignorées ») deviennent des **filtres cliquables**.
   - Ajouter une **recherche** et un filtre « À vérifier ».
7. **« Champs de la plateforme non alimentés »** : les champs importants de la cible (obligatoires d'abord) qu'aucune colonne n'alimente, avec la conséquence (vide, valeur par défaut, à compléter).
   - C'est ici que se règle le **générateur de SKU**, DÉSACTIVÉ par défaut.
   - Exception WooCommerce, validée : le SKU parent est généré par défaut, les variations restent vides. Texte : « Dans WooCommerce, les variations sont rattachées à leur produit par le SKU du parent. Sans SKU parent, elles ne sont pas reliées. »
   - Les SKU générés sont marqués « générés ».
   - Réglages du générateur :
     - source : référence du produit / titre / titre + options / code-barres, ce dernier seulement si on le choisit ;
     - préfixe, séparateur (- _ .), casse, longueur maximale (8 à 64), accents translittérés ;
     - aperçu avant/après sur 6 lignes.
8. **Modifier une destination** : une liste de choix lisible, au style de l'app (pas une liste native).
   - Groupée par thème : Identité, Prix, Stock, Images, Variantes, Description, Référencement, Autre.
   - Avec une recherche, la destination actuelle en tête, et les options « Ignorer cette colonne » et « Garder comme champ personnalisé ».
   - Avec un aperçu de l'effet avant validation.
9. **Aperçu « première ligne telle que la plateforme la recevra »**, mis à jour en direct après chaque changement.
10. **Bandeau en français simple** :
    « Voici comment chaque colonne de votre fichier sera utilisée pour créer votre fichier [plateforme]. Vérifiez les lignes marquées À vérifier. Vos choix sont mémorisés sur cet ordinateur pour les prochains fichiers de ce type. »
    Portée réelle de la mémorisation, à refléter dans une infobulle « Comment c'est mémorisé ? » :
    - pour un format connu, le choix vaut pour les prochains fichiers **de ce format** ;
    - pour un fichier inconnu ou une plateforme, il vaut pour **toute colonne du même nom**, accents, majuscules et séparateurs ignorés ;
    - un format appris reconnaît aussi un fichier presque identique (au moins 80 % de colonnes communes).
11. **Un seul défilement** (la page), et un **en-tête de tableau fixe**. Plus d'encart vide ni de bande rose vide (états réels ci-dessous).

## Données réelles à utiliser (anonymisées si besoin ; données produit publiques)

**Fichier A — export Scraper adidas, 5 produits, 25 colonnes, vers Shopify**

| Colonne | Rempli | Exemple | Destination Shopify aujourd'hui |
|---|---|---|---|
| name | 5/5 | Chaussure Handball Spezial | Title |
| slug | 5/5 | chaussure-handball-spezial-znrlki | Handle (+ identifiant de page) |
| description | 5/5 | Cette chaussure adidas Handball Spezial est celle… | Body (HTML) |
| price | 5/5 | 110 | Variant Price |
| image_url | 5/5 | https://assets.adidas.com/images/…/IF6490_01_00_standard.jpg | Image Src (+ Variant Image) |
| source_url | 5/5 | https://www.adidas.be/fr/chaussure-handball-spezial/IF6490.html | métachamp source_url |
| source_product_id | 5/5 | IF6490 | identifiant source (non écrit) |
| source_category | 5/5 | Chaussures | Product Category |
| brand | 5/5 | adidas | Vendor |
| color | 4/5 | Earth Strata / Off White / Gum | attribut descriptif |
| variants | 4/5 | [{"code":"Couleur du produit : Aurora Coffee / …"}] | Options + Variant SKU → **alerte** (voir objectif 4) |
| availability | 5/5 | InStock | métachamp availability |
| rating / review_count | 4/5 | 4.83 / 206 | métachamps |
| technical_specs | 5/5 | {"Semelle":"Autres Fibres", …} | section de la description |
| barcode, weight_kg, hs_code, product_type, net_content, category_slug, storage_info, is_alcoholic, weight_estimated | 0/5 | — | vides : à montrer « vide dans tout le fichier » |
| store_slug | 5/5 | adidas.be | identifiant de boutique (non écrit) |

**Fichier B — Shopify à variantes vers WooCommerce, 31 colonnes dans le fichier (l'écran actuel en compte 24), 7 lignes, 5 handles**
- Handle « chemise-lin-ecru », Title « Chemise en lin – Écru », option Taille 38 / 40, SKU de variante réels « CHM-LIN-38 » / « CHM-LIN-40 ».
- Destinations WooCommerce : Title → « Name », Body (HTML) → « Description », Vendor → « Brands », Variant SKU → « SKU ».
- SKU parent **généré** « CHEMISE-EN-LIN-ECRU ».
- « 3 sans colonne dans WooCommerce » : montrer lesquelles et ce qui est perdu.

**Fichier C — fournisseur inconnu (FR), 10 colonnes**
Colonnes : Référence (F-001), Désignation (Table basse chêne), Prix de vente (129,90), Code EAN (3701234567890), Stock disponible (12), Visuel (https://…/a.jpg), Rayon (Maison > Salon), Marque, Poids (kg) (12.5), Colonne interne (zz1).
- Propositions avec confiance : « Référence » → SKU 87 %, Référence fabricant 61 %, Référence parent 60 % ; « Désignation » → Titre 92 %.
- « Colonne interne » : non identifiée.

## États à dessiner

1. Fichier A, état normal, cible Shopify.
2. Même écran, cible WooCommerce choisie dans le sélecteur (destinations changées, encart SKU parent généré visible).
3. Fichier C inconnu : propositions à confirmer, bouton « Mémoriser ce format » avec un nom.
4. Une ligne en **alerte** : valeurs incompatibles avec la destination (« Couleur du produit : … » vers SKU).
5. Liste « Colonnes ignorées » ouverte, avec « Utiliser quand même ».
6. Liste « Modifier » ouverte (groupes, recherche, aperçu de l'effet).
7. Encart « Champs de la plateforme non alimentés » avec le générateur de SKU : désactivé (Shopify), puis activé avec aperçu avant/après.
8. **Vide** : un fichier dont aucune colonne n'est reconnue.
9. **Erreur** : l'enregistrement d'un choix a échoué (message + quoi faire), à la place de la bande rose vide d'aujourd'hui.
10. Fenêtre étroite (1100 px) et large (1920 px).

## Design system existant (`converter/app/renderer/app.css`)

- **Couleurs** :
  - accent orange `--or #F26B1D`, accent foncé `--ord #C2410C`, survol `#A8360A`, fond accentué `--ors #FDECE1` ;
  - fond `--bg #E4E5E9`, carte `#FFFFFF`, carte 2 `#F5F6F8` ;
  - texte `#1A1B1E` / `#3F4147`, discret `#8A8F98`, bordures `#E1E3E8` / `#EDEEF1` ;
  - OK `#157A4C` sur `#E9F6EF`, attention `#8A6100` sur `#FBF3E2`, erreur `#D14343` sur `#FBEAEA` ;
  - barre de titre et menu latéral sombres (`#111113`, `#1A1A1D`) dans les deux thèmes ; thème sombre complet pour le contenu.
- **Typo** : Inter (texte, 13 px de base, titres 21 px / 600) et JetBrains Mono (valeurs, exemples).
- **Composants** :
  - boutons 40 / 32 / 28 px, rayon 8 px (`primary` orange, `ghost`) ;
  - cartes rayon 12 px, ombre légère ;
  - pastilles (`chip`) rondes avec point de couleur : `high` vert, `check` ambre, `low` rouge, `none` gris ;
  - tableau à en-têtes en petites capitales grises ;
  - bandeaux `info` / `warn` / `err` / `ok` ;
  - stepper en haut, barre de pied avec Retour / « Continuer vers le contrôle ».
- **Contraintes techniques** :
  - JavaScript vanilla, HTML généré, CSS maison ;
  - **aucun framework ni bibliothèque d'interface** ;
  - textes en français d'abord, puis en anglais.
- **Accessibilité** :
  - contraste AA ;
  - tout faisable au clavier, liste « Modifier » comprise ;
  - libellés lisibles par un lecteur d'écran ;
  - états signalés autrement que par la couleur seule.

## Ce que j'attends en retour

Un bundle de handoff : les écrans des 10 états, les composants nouveaux (ligne-phrase, sélecteur de cible, liste « Modifier », encart « non alimentés », générateur de SKU) et leurs états (survol, focus, désactivé, erreur). L'implémentation partira de ce bundle sans s'en écarter sans le dire.
