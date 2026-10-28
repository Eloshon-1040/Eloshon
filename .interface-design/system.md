# Système de design Eloshon — Converter et Scraper

Source unique de vérité visuelle des deux apps Electron. Tenu avec le skill `interface-design`. Une décision venue d'un autre skill s'écrit ici, avec l'accord d'Andy, avant d'être utilisée.
Les règles du skill `eloshon-ui` sont des contraintes dures : en cas de conflit avec ce fichier, on s'arrête et on demande à Andy.

- **Statut :** version 2 approuvée par Andy le 28/10/2026. Toute modification passe par Andy.
- **Valeurs des tokens :** `shared/design/` et nulle part ailleurs (§ 11). Planche : `.interface-design/specimen/index.html`, qui lit ces fichiers.
- **Hors champ :** panneau de l'extension Chrome, site eloshon.com.

## 1. Direction

- **Personnalité :** Précision et densité.
- **Fondation :** neutres froids, une seule teinte de gris, seule la luminosité varie.
- **Profondeur :** filets uniquement. Aucune ombre portée.
- **Pour qui :** un commerçant, pas un développeur, qui parcourt 25 à 40 colonnes, ou une liste de pages scrapées, et veut savoir ce qui est sûr et ce qu'il doit vérifier.
- **Ce que ça doit donner :** un bordereau bien tenu. Tout est aligné, chaque valeur a sa place, l'œil va droit à ce qui demande une action.
- **Monde du produit :** bordereau d'expédition, déclaration en douane, code-barres EAN, étiquette produit, poste de tri, gabarit d'import.
- **Signature :**
  - la ligne de correspondance se lit comme une phrase de bordereau (« colonne → destination · rempli · fiabilité ») ;
  - les états se lisent à la forme d'un tampon (§ 5.4) ;
  - l'écran s'ouvre sur ce qui demande une action (§ 5.6).
- **Défauts écartés :** grille de cartes SaaS → tableau dense à filets ; pastilles qui ne parlent que par la couleur → forme + icône + mot ; tableaux zébrés et bordés partout → filets fins, en-tête collé.

## 2. Couleurs

Chaque couleur est un token défini une seule fois, pour les deux thèmes, avec `light-dark(clair, sombre)`. Aucune valeur hexadécimale dans les composants.

### 2.1 Neutres

| Token | Rôle | Clair | Sombre |
|---|---|---|---|
| `--canvas` | fond de page | `#EEF0F3` | `#0F1013` |
| `--surface` | feuille : tableaux, panneaux, dialogues | `#FFFFFF` | `#17191E` |
| `--sunken` | champs, zone de dépôt, `kbd` | `#F6F7F9` | `#121418` |
| `--row-hover` | survol d'une ligne | `#F3F5F8` | `#1C1F25` |
| `--ink` | texte principal | `#16181D` | `#E8EAEE` |
| `--ink-2` | texte secondaire, libellés | `#454A54` | `#C1C6CF` |
| `--muted` | métadonnées, exemples, aides (lisible, AA) | `#5C6370` | `#959CA8` |
| `--disabled` | texte d'un élément indisponible seulement | `#8A8F98` | `#646B76` |
| `--line` | filet standard | `#E1E4E9` | `#2A2E35` |
| `--line-subtle` | filet entre lignes de tableau | `#EDEFF2` | `#22252B` |
| `--line-strong` | sous l'en-tête de tableau, contour des menus et dialogues | `#C9CED6` | `#3A3F48` |
| `--line-control` | contour des champs, cases, boutons secondaires (3:1) | `#848B96` | `#6B7380` |
| `--scrim` | voile derrière un dialogue | `rgba(10,12,16,.48)` | `rgba(0,0,0,.6)` |

### 2.2 Accent, un par app

Une seule action principale par écran (`eloshon-ui`). L'accent sert aux actions, à la sélection et au focus ; jamais à un état.

| Token | Converter clair | Converter sombre | Scraper clair | Scraper sombre |
|---|---|---|---|---|
| `--accent` (bouton principal) | `#C2410C` | `#C2410C` | `#2456A6` | `#2F64BE` |
| `--accent-hover` | `#A8360A` | `#B03A0A` | `#1D4A90` | `#2858AB` |
| `--accent-press` | `#8F2E09` | `#9A3309` | `#173C78` | `#2456A6` |
| `--accent-ink` (texte, lien d'accent) | `#C2410C` | `#FF8F55` | `#2456A6` | `#8DB4F0` |
| `--focus` (anneau de focus) | = `--accent-ink` | | | |
| `--accent-tint` (ligne sélectionnée, filtre actif) | `#FDECE1` | `#2E2019` | `#EAF1FB` | `#1B2638` |
| `--accent-tint-ink` | `#9A3412` | `#FFB38A` | `#123C86` | `#B5CDF5` |
| `--on-accent` | `#FFFFFF` | `#FFFFFF` | `#FFFFFF` | `#FFFFFF` |
| `--signal` (fond de la marque du logotype, jamais du texte) | `#F26B1D` | `#F26B1D` | `#2456A6` | `#5B84C9` |

### 2.3 États

Distincts de l'accent, ils servent seulement à signifier. Chaque état porte toujours un mot et une icône.

| Token | Sens | Clair (texte / fond) | Sombre (texte / fond) |
|---|---|---|---|
| `--ok` / `--ok-bg` | réussi, sûr | `#157A4C` / `#E9F6EF` | `#4DC48C` / `#15291F` |
| `--warn` / `--warn-bg` | à vérifier, incertain, action attendue | `#704F00` / `#FBF3E2` | `#F0C75E` / `#2C2410` |
| `--danger` / `--danger-bg` | **erreur, blocage, action destructrice seulement** | `#B42318` / `#FCEBEA` | `#F27D73` / `#301A19` |
| `--neutral` / `--neutral-bg` | vide, en cours, en pause, conservé, info | `#454A54` / `#EEF0F3` | `#C1C6CF` / `#22252B` |

- **Le rouge est réservé** aux erreurs, au blocage (« Bloqué ») et aux actions destructrices (« Arrêter », « Supprimer »). Une fiabilité faible n'est pas une erreur : « Incertain » est dans la famille ambre.
- L'ambre `#704F00` a une luminance (0,090) distincte de l'orange d'accent (0,153), comme l'exige `eloshon-ui`.
- Un état ne prend jamais la couleur d'accent : « En cours » est neutre.

### 2.4 Habillage (barre de titre et menu latéral)

Sombre dans les deux thèmes ; c'est l'identité de chaque app. Toujours séparé du contenu par un filet 1 px `--chrome-line` : en thème sombre, `#111113` et `--canvas` se confondent sans lui.

| Token | Converter | Scraper |
|---|---|---|
| `--chrome` | `#111113` | `#0A1650` |
| `--chrome-2` (survol, encarts) | `#1A1A1D` | `#0D2E6B` |
| `--chrome-line` | `#26272B` | `#1B2B6B` |
| `--chrome-ink` | `#E7E8EB` | `#EAF0FA` |
| `--chrome-muted` | `#A1A5AD` | `#8FA6D6` |

L'entrée de menu active prend `--accent` avec `--on-accent`.

### 2.5 Contrastes mesurés (WCAG 2.x)

136 couples vérifiés le 28/10/2026, tous conformes. Le script lit les valeurs dans `shared/design/*.css` : il se relance à chaque changement de couleur. Il couvre chaque état sur son fond teinté et sur tous les fonds de ligne (normal, survol, sélectionné dans chaque app).

| Couple | Clair | Sombre |
|---|---|---|
| `--ink` sur `--surface` | 17,76 | 14,60 |
| `--muted` sur `--surface` / `--canvas` / `--sunken` | 6,05 / 5,30 / 5,64 | 6,36 / 6,88 / 6,67 |
| `--line-control` sur `--surface` / `--sunken` (3:1) | 3,43 / 3,20 | 3,68 / 3,85 |
| `--ok` / `--warn` / `--danger` / `--neutral` sur leur fond | 4,82 / 6,78 / 5,70 / 7,79 | 7,01 / 9,54 / 6,18 / 8,95 |
| Blanc sur `--accent` Converter / Scraper | 5,18 / 7,10 | 5,18 / 5,70 |
| `--accent-ink` Converter sur `--surface` / `--canvas` | 5,18 / 4,54 | 7,80 / 8,44 |
| `--chrome-muted` sur `--chrome` Converter / Scraper | 7,63 / 6,91 | idem |

## 3. Typographie

- **Polices embarquées** dans `shared/design/fonts/` (woff2 variables, Latin et Latin étendu, licences OFL à côté) :
  - `--font-ui: 'Inter Variable'` : toute l'interface des deux apps, logotype compris ;
  - `--font-mono: 'JetBrains Mono Variable'` : les valeurs (SKU, URL, EAN, prix dans les aperçus, noms de colonnes du fichier, codes) ;
  - `--font-brand: 'Poppins'` : Scraper seulement, titres de 22 px et plus (Poppins reste dans `app/renderer/fonts/`).
- Aucune dépendance à une police du système (Segoe UI) : la police générique n'est qu'un dernier recours.
- **Échelle :** base 13 px, rapport 1,2.

| Rôle | Taille / interligne | Graisse | Usage |
|---|---|---|---|
| Grand titre | 27 / 32 | 600, `-0.015em` | écran d'accueil, état vide d'un écran entier |
| Titre de page | 22 / 28 | 600, `-0.01em` | `h1`, un par écran |
| Titre de section | 19 / 24 | 600 | `h2` |
| Sous-titre | 16 / 24 | 600 | `h3`, titre de panneau ou de dialogue |
| Texte | 13 / 20 | 400 | texte courant, cellules |
| Libellé | 13 / 20 | 500 | boutons, libellés de champ, destination |
| Valeur | mono 12 / 20 | 400 (500 pour un nom de colonne) | valeurs et identifiants |
| Légende | 11 / 16 | 500 | métadonnées, raisons, dates, `kbd` |
| En-tête de tableau | 11 / 16 | 600, capitales, `+0.04em` | seulement les en-têtes de tableau |

- Hiérarchie par taille + graisse + couleur, jamais la taille seule. Jamais sous 11 px. Casse de phrase partout.
- `font-variant-numeric: tabular-nums` sur toute colonne de nombres, compteur, pourcentage, progression. Nombres alignés à droite.
- `text-wrap: balance` sur les titres, `pretty` sur les paragraphes.
- Le sous-ensemble Latin n'a pas « → », « ← » ni les coches : flèches et coches sont des icônes SVG.

### 3.1 Nombres et dates

- **Toujours** `Intl.NumberFormat` et `Intl.DateTimeFormat` avec la langue de l'interface (`fr`, `nl`, `en`, `es`, `de`). Jamais un séparateur, un symbole monétaire ou un format de date écrit à la main.
- La devise vient des données ou de la configuration, jamais du code.
- Résultat attendu pour 1 111,10 € (rendu par la planche) : FR `1 111,10 €` (espace fine insécable), NL `€ 1.111,10`, EN `€1,111.10`, ES `1111,10 €` (l'espagnol ne groupe pas les nombres de 4 chiffres). Date du 28/10/2026 : FR `28 oct. 2026`, NL `28 okt 2026`, EN `Oct 28, 2026`, ES `28 oct 2026`.
- Un choix de région (`fr-BE`, `en-GB`…) se fait dans la configuration, pas dans un composant.

## 4. Espacement, densité, rayons, profondeur

- **Grille de 4 px.** `--s-1` 4, `--s-2` 8, `--s-3` 12, `--s-4` 16, `--s-5` 20, `--s-6` 24, `--s-8` 32, `--s-10` 40, `--s-12` 48.
- **Densité :** ligne de tableau 36 px, filet compris ; en-tête 32 px ; ligne de correspondance sur deux lignes 56 px (§ 5.6) ; marge de page 24 px, 32 px à partir de 1366 px de large ; entre sections 24 px ; dans un groupe 8 ou 12 px, avec `gap`.
- **Rayons :** `--r-sm` 4 px (champs, boutons, pastilles, `kbd`), `--r-md` 6 px (panneaux, tableaux, zone de dépôt, marque du logotype), `--r-lg` 8 px (dialogues, menus). Rayons concentriques.
- **Profondeur : filets uniquement.** Aucune `box-shadow`. Les plans se distinguent par la surface et un filet. Menu ou dialogue : `--surface`, contour `--line-strong`, rayon `--r-lg`, sur `--scrim`. Pas de carte dans une carte, pas de bordure colorée d'un seul côté.

## 5. Composants

### 5.1 Boutons

| Variante | Hauteur | Remplissage | Usage |
|---|---|---|---|
| Principal | 32 (40 dans la barre de pied) | `--accent`, texte `--on-accent`, 500 | une seule action principale par écran |
| Secondaire | 32 | `--surface`, contour `--line-control`, texte `--ink` | actions courantes |
| Discret | 28 ou 32 | transparent, texte `--ink-2`, survol `--row-hover` | actions de ligne, barres d'outils |
| Danger | 32 | `--surface`, contour et texte `--danger` | arrêter, supprimer |
| Icône seule | 28 ou 32, carré | comme Discret | toujours `aria-label` + `title` |

- Marges : 12 px (32), 10 px (28), 16 px (40). Icône 16 px, écart 8 px. Appui : `scale(.98)` en 100 ms.
- **Indisponible :** un bouton indisponible dit toujours pourquoi.
  - Par défaut, il reste actif et l'action se valide au clic (message près du bouton : ce qui manque, quoi faire).
  - S'il doit être indisponible : `aria-disabled="true"` (il garde le focus), texte `--disabled`, fond `--sunken`, et la raison en texte visible juste dessous, reliée par `aria-describedby` (« Disponible quand le contrôle est terminé. »). Jamais l'attribut `disabled` seul, qui retire le bouton du clavier et cache la raison.
- Une action destructrice ou définitive finit par « … » quand elle ouvre une confirmation (« Arrêter… »).

### 5.2 Champs

- Hauteur 32, fond `--sunken`, contour `--line-control`, rayon `--r-sm`, texte 13 px (mono 12 pour une valeur).
- Libellé visible au-dessus ; aide dessous (11 px `--muted`) qui dit la vraie règle du champ, lue dans le code.
  - Exemple, générateur de SKU : « Préfixe du SKU » : *Facultatif, 12 caractères au plus. Placé devant chaque SKU généré, suivi du séparateur.* « Longueur maximale » : *Entre 8 et 64 caractères, préfixe compris.* (`converter/core/knowledge-proposal/sku.mjs`).
- Indication de saisie en `--muted`, terminée par « … ».
- Erreur : contour `--danger`, message dessous avec icône, `aria-invalid` et `aria-describedby`.

### 5.3 Focus, survol, erreur

- **Focus :** `:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px }` (dans `tokens.base.css`). Ligne de tableau : contour sur toute la ligne, `outline-offset: -2px`.
- **Survol :** lignes en `--row-hover` ; liens soulignés.
- **Erreur :** texte `--danger` + icône + phrase « ce qui s'est passé, quoi faire » (§ 7.7).

### 5.4 Pastilles d'état

- **Composant partagé** `status-chip` (`tokens.base.css`) : `<span class="status-chip" data-tone="…" data-shape="…">`. Hauteur 20, marges 0 × 6, rayon 4, icône SVG 12 px, mot en 11 / 16 / 600.
- **Quatre formes, une par sens :**
  - **réglé** : contour 1 px de la couleur d'état ;
  - **demande votre attention** : fond teinté + contour plein ;
  - **incertain** : fond teinté + contour **pointillé** (plus d'attention que « À vérifier ») ;
  - **en pause** : fond neutre, sans contour.
- Légende affichée : « contour = réglé · fond teinté = demande votre attention · fond teinté + pointillé = incertain ».
- **Jamais la couleur seule.** Une pastille n'est jamais cliquable : si l'état demande une action, un bouton est à côté.

| App | Pastille | Couleur | Forme | Icône |
|---|---|---|---|---|
| Converter, fiabilité | Sûr | `--ok` | réglé | cercle coché |
| | À vérifier | `--warn` | attention | triangle d'alerte |
| | Incertain | `--warn` | incertain | cercle point d'interrogation |
| | Vide | `--neutral` | réglé | cercle barré d'un trait |
| Converter, conversion | Converti | `--ok` | réglé | coche |
| | Conservé | `--neutral` | réglé | boîte d'archive |
| | Signalé | `--warn` | attention | drapeau |
| Scraper, job | En cours | `--neutral` | réglé | anneau qui tourne ; horloge fixe si mouvement réduit |
| | En pause | `--neutral` | en pause | cercle avec deux barres |
| | Terminé | `--ok` | réglé | coche |
| | Bloqué | `--danger` | attention | octogone barré |
| | CAPTCHA requis | `--warn` | attention | main levée (« à vous ») |

- **« Vide »** : une colonne vide sur toutes les lignes n'est jamais « Sûr ». Raison : « Rien à écrire : la colonne est vide ». Elle n'entre pas dans le compte « Sûres ».
- Libellés dans le système i18n : FR ci-dessus ; EN Safe / To check / Uncertain / Empty, Converted / Kept / Flagged, Running / Paused / Done / Blocked / CAPTCHA required ; NL et ES en phase 4 et 5.

### 5.5 Pastilles-filtres et tableaux denses

- **Pastilles-filtres** : des boutons (`aria-pressed`), hauteur 28, rayon 4, contour `--line`, libellé + compte en chiffres tabulaires, **compte toujours visible sur chaque filtre**. Actif : `--accent-tint`, texte `--accent-tint-ink`, contour `--accent-ink`. Elles passent à la ligne plutôt que de rétrécir.
- **Tableaux :** un seul défilement vertical, celui de la page ; en-tête collé (`position: sticky; top: 0`) sans conteneur défilant entre lui et la page ; en-tête 32 px, filet `--line-strong` ; lignes 36 px, filet `--line-subtle` ; pas de zébrage ; texte à gauche, nombres à droite, valeurs en mono.
- Valeur absente : « — » dans la cellule, « vide sur 5 lignes sur 5 » au niveau de la colonne. Jamais une valeur plausible inventée.
- Aperçu plus large que l'écran : défilement horizontal seulement, dans son propre conteneur.
  - **Exception décidée par Andy le 28/10/2026** (aperçu des lignes converties, étape 3 du Converter) : une boîte haute au plus comme la fenêtre, qui défile dans les deux sens, en-tête collé en haut de la boîte. Les titres de colonnes restent visibles en lisant vers le bas et la barre de défilement horizontal reste visible, sans descendre en bas du tableau.

### 5.6 Ligne de correspondance (étape 3 du Converter)

Reprend `converter/docs/design/correspondance/` et `eloshon-ui` (`data-screens.md`).

- **Une ligne = une colonne du fichier**, qui se lit comme une phrase. Une colonne qui alimente plusieurs champs reste une ligne.
- **Deux dispositions, par requête de conteneur** sur le tableau (`container: map / inline-size`) :
  - **tableau de 960 px et plus : une ligne de 36 px** — nom de colonne · remplissage · exemples | flèche · libellé humain · colonne de la plateforme · transformation | pastille · raison | Modifier ;
  - **moins de 960 px : deux lignes, 56 px** — la phrase en ligne 1, le détail en ligne 2 :

| Colonne | Ligne 1 | Ligne 2 |
|---|---|---|
| Votre colonne | nom en mono 12 / 500 · barre de remplissage 40 px · « 4/5 » | exemples réels en mono `--muted`, entre « » |
| Sera écrite dans | flèche · libellé humain 13 / 600, seul sur sa ligne | colonne de la plateforme en mono `--ink-2` · transformation en langage simple |
| Fiabilité | pastille | raison + origine, 11 px |
| (action) | bouton Discret « Modifier », 28 px | — |

- **Ce qui peut être coupé :** seulement les exemples (et, pour une ligne réglée, la transformation et la raison), par « … ». Le libellé humain et la colonne de la plateforme ne sont jamais coupés.
- **Une ligne « À vérifier » ou « Incertain » ne coupe jamais sa raison** : elle passe à la ligne, 2 lignes au plus, même à 940 px de fenêtre (ligne de 50 px en disposition large, 70 px en disposition étroite). Une raison s'écrit en 45 caractères au plus pour tenir.
- **Valeur complète accessible à la souris ET au clavier :** attribut `title` sur chaque texte coupé, et volet « Détails techniques » de la ligne (exemples complets, champ interne, transformation), que la flèche droite déplie au clavier.
- **Seuils de fiabilité :** score ≥ 0,85 → Sûr ; 0,60 à 0,85 → À vérifier ; < 0,60 → Incertain ; colonne vide partout → Vide. Origine affichée : *reconnu par son nom*, *confirmé par vous*, *règle connue pour ce format*, *déduit des valeurs*.
- **Alerte** quand les valeurs contredisent la destination : au moins « À vérifier », raison en `--warn` avec son icône.
- **Guider vers ce qui demande une action :**
  - s'il existe au moins une ligne « À vérifier » ou « Incertain », le tableau s'ouvre sur le filtre **« À traiter »** (ces deux familles) ;
  - le tri par défaut est la fiabilité, la plus basse d'abord : Incertain, À vérifier, Sûr, Vide ;
  - filtres, dans l'ordre : À traiter, Toutes, Sûres, À vérifier, Incertaines, Vides, Ignorées, chacun avec son compte.
- Colonnes ignorées : liste à part, avec la raison, la perte à l'export et « Utiliser quand même ».
- **Lignes visibles en défilant** (en-tête de tableau collé ; barre de titre, étapes, barre de pied et barre d'état de l'étape 3 actuelle : 215 px fixes) :

| Fenêtre | Mise à l'échelle Windows | Largeur du tableau | Disposition | Lignes réglées visibles | Lignes à traiter visibles |
|---|---|---|---|---|---|
| 1920 × 1080 | 100 % | 1624 px | une ligne | 24 | 24 |
| 1920 × 1080 | 125 % | 1240 px | une ligne | 18 | 18 |
| 1920 × 1080 | 150 % | 1000 px | une ligne | 14 | 10 |
| 1366 × 768 | 100 % | 1070 px | une ligne | 15 | 11 |
| 1366 × 768 | 125 % | 813 px | deux lignes | 7 | 5 |
| 940 × 640 (minimum) | 100 % | 660 px | deux lignes | 7 | 6 |

  Le cas 1366 × 768 à 125 %, courant sur les portables, ne montre que 7 lignes. **[DÉCISION ANDY, phase 2]** Un menu latéral repliable en barre d'icônes de 56 px donnerait un tableau de 989 px, donc la disposition sur une ligne (11 lignes réglées).

### 5.7 Clavier dans le tableau de correspondance

- Le tableau est **un seul arrêt de tabulation** (`role="grid"`, focus itinérant sur les lignes, `aria-selected`).
- **↑ / ↓** : ligne précédente / suivante ; **Début / Fin** : première / dernière ligne. La ligne qui a le focus porte un contour de 2 px `--focus` sur toute sa largeur.
- **→** : déplie les détails de la ligne (exemples complets) ; **←** : les replie.
- **Entrée** : ouvre « Modifier » pour la ligne ; **Échap** : ferme la liste ou le dialogue ouvert et rend le focus à la ligne.
- **Ctrl+F** : recherche dans le tableau. **Ctrl+1 à Ctrl+7** : les filtres, dans l'ordre affiché.
- Indications visibles : une rangée de `<kbd>` sous le tableau, et chaque filtre affiche son raccourci dans son infobulle.
- **Conventions Windows respectées :** aucun Alt+lettre (accès aux menus), aucun Ctrl+W, Ctrl+Q, Ctrl+Tab, Alt+F4, F10 ni raccourci avec la touche Windows. F1 reste l'aide. Ctrl+S exporte, Ctrl+O ouvre un fichier, Ctrl+Entrée passe à l'étape suivante.
- `<kbd>` : mono 11 px, hauteur 18, fond `--sunken`, contour `--line`, rayon 4 ; les flèches y sont des icônes SVG.

## 6. Mouvement

- 100 ms pour l'appui, 120 ms pour le survol, 160 ms pour un menu ou une infobulle. Courbe `cubic-bezier(.23, 1, .32, 1)`. Seulement `transform` et `opacity`, jamais `transition: all`. Aucune animation sur une action répétée au clavier.
- `prefers-reduced-motion: reduce` : aucun déplacement ; un indicateur qui tourne est **remplacé par une icône fixe** (horloge), géré par `status-chip` (`.moving` / `.still`).

## 7. Comportements de bureau

### 7.1 Import par glisser-déposer
- Zone de dépôt : fond `--sunken`, contour pointillé 1 px `--line-control`, rayon `--r-md`, 120 px au moins ; icône, « Déposez votre fichier ici », bouton « Choisir un fichier… » (dialogue natif), formats acceptés.
- Pendant le glisser : contour plein 2 px `--accent-ink`, fond `--accent-tint`, « Relâchez pour importer « nom du fichier » ». Fichier refusé : message `--danger`, la raison et quoi faire.

### 7.2 Thème qui suit Windows
- Réglage « Thème » : **Système** (par défaut) / Clair / Sombre. Main : `nativeTheme.themeSource`. Renderer : `data-theme="system|light|dark"` sur `<html>` ; `color-scheme` choisit la valeur de chaque `light-dark()`, donc « Système » suit Windows sans copie des valeurs sombres.

### 7.3 Dialogues ouvrir / enregistrer
- Toujours les dialogues natifs d'Electron, avec filtres et nom proposé traduits. Les confirmations restent des dialogues de l'app : Entrée valide l'option qui a le focus, Échap annule, le focus va d'abord sur l'option sans risque.

### 7.4 Tâches longues (Scraper)
- Carte de progression : ce qui se passe, pastille d'état, barre de 4 px (`--accent` ; `--neutral` en pause), puis en chiffres tabulaires :
  - pages lues / prévues ;
  - **temps écoulé** ;
  - **temps restant estimé**, affiché seulement quand l'estimation est stable, sinon « Calcul en cours… » ;
  - **crédits utilisés / estimés** : les crédits du compte Eloshon de l'utilisateur, comme le bouton actuel « Débloquer (≈ N crédits) ». Valeurs lues dans le compte et la configuration (`accountStatus`, estimation du job), jamais écrites dans le code. Jamais un nom de fournisseur, un coût de fournisseur ni un compteur interne (`eloshon-scraper-ops`, règle 7).
- Boutons : « Mettre en pause » / « Reprendre » (Principal quand c'est la seule action), « Arrêter… » (Danger).
- **« Arrêter… » demande confirmation**, car un arrêt est définitif : dialogue « Arrêter la lecture ? », ce qui est gardé (« Les 412 produits déjà lus sont gardés »), le rappel que la pause permet de reprendre, focus sur « Continuer la lecture ».
- États : En cours, En pause, Terminé, Bloqué, CAPTCHA requis (§ 5.4) ; échec : message § 7.7.
- Zone `aria-live="polite"`, mise à jour au plus une fois par seconde.

### 7.5 Chargement et vide
- Chargement : barres de squelette ; un nouveau calcul garde l'ancien contenu à 50 % d'opacité, sans saut de mise en page. Vide : ce qui apparaîtra et comment l'obtenir, avec l'action. Hauteur minimale réservée.

### 7.6 Langues
- Tout texte visible passe par le système i18n : FR, EN, NL, ES (Converter) ; FR, EN, ES, NL, DE (Scraper). Mises en page prévues pour un libellé 40 % plus long que le français.

### 7.7 Messages d'erreur
- En place de l'élément, en gardant sa hauteur : icône, **ce qui s'est passé**, **quoi faire**, bouton d'action si possible. Détail technique dans le journal, pas à l'écran. Jamais « Une erreur est survenue » seul ; jamais un encadré vide (`[hidden]` gagne).

### 7.8 Textes
- `writing-guidelines` (règles figées) et `redaction-claire` sur chaque texte d'interface : voix active, deuxième personne (« votre »), pas de tiret long comme ponctuation, « … » et non « ... », casse de phrase, typographie de chaque langue.

## 8. Logotype de la suite

- **Même structure pour les deux apps :** marque Eloshon (le « E » à barres, blanc) dans un carré de 24 px, rayon 6, fond `--signal` · « Eloshon » en Inter 600 · nom du produit (« Converter », « Scraper ») en Inter 400, 13 px, `--chrome-ink`, écart 8 px.
- Seuls l'accent (`--signal`) et l'habillage changent. Poppins n'est pas dans le logotype ; elle reste pour les titres du Scraper de 22 px et plus.
- Les icônes d'application (`.exe`, barre des tâches) ne changent pas dans cette phase.

## 9. Différences entre les deux apps

| | Converter | Scraper |
|---|---|---|
| Fichier d'accent | `tokens.converter.css` (orange) | `tokens.scraper.css` (bleu) |
| Habillage | `#111113` | `#0A1650` |
| Titres de 22 px et plus | Inter | Poppins |
| Langues | FR, EN, NL, ES (NL et ES en phase 4) | FR, EN, ES, NL, DE |
| Thème sombre | existe, à remapper (phase 2) | à créer (phase 5) |

## 10. Décisions

| Décision | Raison | Date |
|---|---|---|
| Direction A, Précision et densité | Le commerçant parcourt 25 à 40 colonnes ; densité et alignement priment. | 28/10/2026 (Andy) |
| Inter + JetBrains Mono embarquées dans les deux apps ; Poppins pour les grands titres du Scraper | Une seule voix typographique ; Inter n'était pas livrée. | 28/10/2026 (Andy) |
| Filets uniquement ; base 13 px, rapport 1,2, grille 4 px, lignes de 36 px | Densité d'outil. | 28/10/2026 (Andy) |
| `--muted` `#5C6370`, ambre `#704F00`, rouge `#B42318`, contour de champ `#848B96`, « En cours » neutre, filet de l'habillage | Contraste AA et règles `eloshon-ui`. | 28/10/2026 (Andy) |
| Rouge réservé aux erreurs, au blocage et aux actions destructrices ; « Incertain » en ambre pointillé | Une fiabilité faible n'est pas une erreur. | 28/10/2026 (Andy) |
| Statut « Vide », hors du compte « Sûres » | Une colonne vide n'est jamais « Sûr ». | 28/10/2026 (Andy) |
| Une ligne de 36 px dès 960 px de tableau, deux lignes de 56 px en dessous | Garder la densité quand la place existe. Seuil réglé à 960 px pour que 1920 × 1080 à 150 % tienne sur une ligne. | 28/10/2026 (Andy) |
| Raison jamais coupée sur une ligne à traiter ; ouverture sur « À traiter », tri par fiabilité | Guider vers l'action. | 28/10/2026 (Andy) |
| Logotype commun en Inter | Une structure pour la suite ; Poppins seulement dans les titres du Scraper. | 28/10/2026 (Andy) |
| Tokens dans `shared/design/`, `light-dark()` | Une seule source, aucune copie des valeurs sombres. | 28/10/2026 (Andy) |
| Seuils 0,85 / 0,60 | Ceux de `eloshon-csv-mapping-expert`. | 27/10/2026 |

## 11. Source des tokens et chargement

- `shared/design/tokens.base.css` : neutres, états, typographie, espacements, rayons, focus, pastilles d'état (`status-chip`), polices.
- `shared/design/tokens.converter.css`, `shared/design/tokens.scraper.css` : accent et habillage seulement.
- `shared/design/fonts/` : Inter et JetBrains Mono (`@fontsource-variable` 5.3.0, Latin et Latin étendu) et leurs licences OFL.
- **Scraper :** le renderer charge `../../shared/design/` directement. L'installeur embarque déjà `shared/**` (`package.json`, `build.files`) ; garde : `app/__tests__/design-tokens-packaging.test.mjs`. L'extension ne reçoit pas ces fichiers (`build-extension.mjs` ne copie que les `.mjs`).
- **Converter :** il est empaqueté depuis `converter/` seulement, donc `../shared` n'est pas dans son installeur. Il porte une copie commitée dans `converter/app/renderer/design/`, régénérée par `npm run sync:design` (aussi première étape de `npm run dist`). `converter/test/design-sync.test.mjs` échoue dès que la copie diffère de `shared/design/`.
- Le `app.css` de chaque app ne garde que ses règles propres et **ne redéfinit aucune valeur de token** (phases 2 et 5).

## 12. Vérification d'un écran

- Captures dans l'app Electron réelle (Playwright `_electron`, `userData` temporaire) : largeur minimale (940 px), 1366 × 768, 1920 × 1080, échelle Windows 125 % et 150 %, thèmes clair et sombre, toutes les langues de l'app.
- Contraste recalculé pour toute nouvelle couleur ; parcours au clavier ; `/ui-pass` sans constat bloquant.
