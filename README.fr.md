# Eloshon — scraper de produits web et convertisseur de catalogues e-commerce

**Français** · [English](README.md)

> **Code visible, gratuit pour un usage non commercial** ([PolyForm Noncommercial 1.0.0](LICENSE)).
> Usage personnel, étude, recherche, enseignement et associations : bienvenue. **Tout usage commercial exige une licence écrite** — voir [Licence](#licence).

Eloshon, ce sont deux applications Windows qui couvrent tout le chemin entre « il me faut ces données produits » et « elles sont importées dans ma boutique » :

| Application | En une phrase |
|---|---|
| **Eloshon Scraper** | Collecte des données produits (nom, prix, images, variantes, stock, avis…) sur des sites web, avec une extension Chrome/Edge qui apprend la mise en page d'un site à partir d'un exemple que vous désignez. |
| **Eloshon Converter** | Lit un fichier produits (CSV fournisseur, export de boutique, JSON, export du Scraper) et écrit le **fichier d'import exact** de **Shopify, WooCommerce, Wix Stores ou BigCommerce** — correspondance des colonnes, formules et corrections manuelles comprises. Tout le traitement est local. |

<p align="center">
  <img src="docs/images/05-mapping.png" alt="Eloshon Converter : écran de correspondance des colonnes avec niveaux de fiabilité" width="860">
</p>

*(Captures d'écran en anglais, interface disponible en français, anglais, néerlandais et espagnol.)*

**Cas d'usage** : migrer une boutique de PrestaShop/Shopware/Wix vers Shopify/WooCommerce · charger le catalogue d'un fournisseur (BigBuy…) dans sa boutique · transformer un site scrapé en fichier d'import · réparer un export qu'une plateforme refuse d'importer.

## Sommaire

- [Eloshon Converter](#eloshon-converter)
- [Eloshon Scraper](#eloshon-scraper)
- [Démarrage rapide](#démarrage-rapide)
- [Comment ça marche](#comment-ça-marche)
- [Organisation du dépôt](#organisation-du-dépôt)
- [Tests](#tests)
- [Contribuer](#contribuer--aide-bienvenue)
- [FAQ](#faq)
- [Licence](#licence)

---

## Eloshon Converter

Les fichiers de catalogue sont désordonnés : noms de colonnes différents selon la plateforme, la langue ou le fournisseur ; prix en centimes, tailles en texte libre, images dans une seule cellule séparées par des virgules, variantes sur des lignes à plat. Le Converter en fait un fichier d'import propre en cinq étapes : **plateformes → fichier → correspondance → contrôle → export**.

**Ce qu'il fait**

- **Détecte le format** du fichier déposé (Shopify, WooCommerce, Wix, BigCommerce, PrestaShop, Shopware, BigBuy, Eloshon Scraper…), y compris des en-têtes en plusieurs langues (français, anglais, néerlandais, espagnol…) et les exports WooCommerce localisés. Un format inconnu peut être **appris une fois et mémorisé**.
- **Associe les colonnes** : proposition automatique avec un niveau de confiance par colonne ; vous confirmez, changez ou ignorez chacune. Les correspondances s'enregistrent en **modèles** réutilisables.
- **Formules** prêtes à l'emploi (façon tableur) : remplacer, supprimer, couper, préfixe/suffixe, découper, regex, opérations sur les nombres (ex. centimes → euros), slug, retrait du HTML, fusion de colonnes, remplissage des cellules vides… appliquées **avant** la conversion (sur la source) ou **après** (sur le fichier qui sera importé).
- **Modification manuelle de n'importe quelle cellule de sortie** dans l'aperçu avant l'export.
- **Comprend la structure des produits** : options et variantes, pages de couleurs regroupées en un seul produit avec un axe Couleur, images par variante, catégories (et collections Shopify via des étiquettes), règles de SKU qui n'inventent jamais une référence que la source n'a pas donnée, unités de poids et formats de prix.
- **Dit ce qu'il a fait** : toute valeur qui ne peut pas être reprise par la plateforme cible est listée (rien n'est abandonné en silence), avec une étape de contrôle avant l'export.
- **Local et privé** : aucun catalogue n'est envoyé. Interface en français, anglais, néerlandais et espagnol.

**Plateformes** — lit les exports Shopify, WooCommerce, Wix, BigCommerce, PrestaShop, Shopware, BigBuy et Eloshon Scraper ; écrit les fichiers d'import Shopify, WooCommerce, Wix Stores et BigCommerce. Clients et commandes sont couverts pour les plateformes décrites dans [`converter/docs`](converter/docs). La liste exacte des conversions est dans [`converter/core/directions.mjs`](converter/core/directions.mjs).

### Captures d'écran

Les cinq étapes, sur un petit catalogue Shopify synthétique converti vers WooCommerce.

| 1 · Choisir les plateformes | 2 · Déposer le fichier — format reconnu |
|---|---|
| ![Choix des plateformes source et cible](docs/images/02-platforms.png) | ![Le fichier est reconnu comme un export produits Shopify](docs/images/04-file-detected.png) |
| **3 · Associer les colonnes** | **3 · Modifier une cellule de sortie à la main** |
| ![Correspondance des colonnes avec niveaux de fiabilité](docs/images/05-mapping.png) | ![Aperçu avec une cellule modifiée à la main](docs/images/06-edit-output-cells.png) |
| **4 · Contrôle avant export** | **Eloshon Scraper** |
| ![Contrôle : totaux, problèmes, notes et SKU générés](docs/images/07-check.png) | ![Tableau de bord d'Eloshon Scraper](docs/images/09-scraper-dashboard.png) |

## Eloshon Scraper

Un scraper qui n'exige pas un script écrit à la main pour chaque site.

- **Un vrai navigateur fait le travail.** L'extension Chrome/Edge/Brave s'exécute dans *votre* navigateur (votre IP, votre session) : les pages s'affichent et se connectent comme pour un humain. L'application de bureau porte le moteur, les réglages, le stockage et les exports.
- **Montrez, ne codez pas.** Désignez un produit sur une page (🎯) : l'application apprend la mise en page (cartes de liste, champs, prix, variantes, pagination) et l'applique à tout le site. Les règles apprises sont enregistrées par site.
- **Plusieurs façons de lire une page**, choisies d'après les données : rejeu de l'API JSON du site · état intégré à la page (`__NEXT_DATA__`, JSON-LD, microdata) · sélecteurs DOM · actions scriptées (clic, défilement, pagination) · liste → pages détail.
- **Poli et résistant** : cadence adaptative par domaine, détection des défis anti-robot, tâches reprenables avec dédoublonnage.
- **Solutions payantes en option** : quand un site bloque un navigateur ordinaire, l'application peut passer à un fournisseur de déblocage payant **avec votre propre clé d'API** (stockée localement, jamais dans ce dépôt).
- **Sortie riche** : produits avec images, variantes, stock par taille, avis, fil d'Ariane des catégories — en `products.json` / CSV, prêts pour le Converter.

> Utilisez le Scraper dans le respect des conditions d'utilisation de chaque site, de son `robots.txt` et de la loi. Vous êtes responsable de votre usage.

---

## Démarrage rapide

Prérequis : **Windows 10/11**, **Node.js 22+**, npm, Git.

```bash
git clone https://github.com/Eloshon-1040/Eloshon.git
cd Eloshon

# Converter
npm --prefix converter ci
npm --prefix converter start

# Scraper
npm ci
npm run pw:install        # télécharge Chromium pour Playwright (une fois)
npm start
```

Construire soi-même les installateurs (`.exe` NSIS) :

```bash
npm --prefix converter run dist     # Eloshon Converter
npm run dist:win                    # Eloshon Scraper
```

**Charger l'extension** (mode développeur) : lancez `npm run ext:build`, ouvrez `chrome://extensions`, activez le *Mode développeur*, choisissez *Charger l'extension non empaquetée* et sélectionnez le dossier `extension/`. Le jumelage avec l'application est décrit dans [`docs/EXTENSION.md`](docs/EXTENSION.md).

## Comment ça marche

**Chaîne du Converter**

```
 fichier ──► détection ──► lecture ──► correspondance ──► modèle produit ──► écriture pour la cible ──► fichier d'import
             (référence +   (CSV/JSON   (règles, déductions  canonique          (colonnes Shopify /        + rapport de ce
              formats appris) encodages)  sémantiques, vos      (variantes, images, Woo / Wix / BigCommerce)  qui a changé
                                          corrections)          catégories, SKU)
```

Le moteur est en TypeScript pur dans [`converter/core/src`](converter/core/src) (transpilé en ESM par `npm --prefix converter run build:engine`, sans bundler) ; l'application Electron est dans [`converter/app`](converter/app). Les formats des plateformes sont décrits comme des données dans [`converter/core/knowledge-ref`](converter/core/knowledge-ref) ; les formats que vous lui apprenez restent sur votre machine.

**Architecture du Scraper**

```
application ── tube nommé ── hôte natif ── messagerie native ── extension (MV3)
 moteur, réglages,           relais léger,                      service worker + exécuteur dans la page
 stockage, exports           valide les messages                pilote un vrai onglet
```

Recettes, extracteurs, cadence et gestion des défis vivent une seule fois dans [`shared/`](shared) et servent l'application comme l'extension. Détails : [`docs/EXTENSION.md`](docs/EXTENSION.md), [`docs/archetypes-and-limits.md`](docs/archetypes-and-limits.md), [`docs/VARIANTS.md`](docs/VARIANTS.md) (en anglais).

## Organisation du dépôt

| Dossier | Contenu |
|---|---|
| `converter/core` | Moteur de conversion (TypeScript) et connaissance des formats |
| `converter/app` | Eloshon Converter — application Electron (main, preload, renderer) |
| `app/`, `core/` | Eloshon Scraper — application Electron et moteur d'extraction |
| `shared/` | Code partagé entre l'application Scraper et l'extension (recettes, DSL, cadence, extracteurs) |
| `extension/`, `native-host/` | Extension Chrome/Edge (Manifest V3) et son pont de messagerie native |
| `supabase/` | Schéma et fonction serveur du service hébergé facultatif |
| `docs/` | Notes techniques |

## Tests

```bash
npm --prefix converter test    # construit le moteur, puis lance la suite du Converter (formats, fichiers de référence, textes d'interface)
npm test                       # Scraper, extension, hôte natif — construire d'abord le moteur du Converter
```

Le Converter conserve des **fichiers de référence (golden files)** dans `converter/test/golden` : la sortie exacte attendue pour chaque paire source → cible. Une modification qui change une sortie doit les mettre à jour volontairement. `npm run smoke:live` et les scripts `verify-*` font de vrais appels réseau : à lancer en connaissance de cause.

## Contribuer — aide bienvenue

Toute aide est la bienvenue, quel que soit votre niveau. Bonnes portes d'entrée :

- **Formats d'import** — un export de plateforme mal lu, une colonne qui atterrit au mauvais endroit. Ajoutez un petit fichier d'exemple *synthétique* et un test.
- **Traductions** — l'interface existe en français, anglais, néerlandais et espagnol (et allemand pour le Scraper) ; fautes et langues manquantes.
- **Rapports de bug avec un exemple minimal** — voir les [modèles d'issues](../../issues/new/choose).
- **Tests et documentation.**

Lisez d'abord [CONTRIBUTING.fr.md](CONTRIBUTING.fr.md) : il explique la marche à suivre, l'accord de contribution et `git commit -s`. Cherchez les issues étiquetées **good first issue** et **help wanted**. Ne publiez jamais de clés d'API, de données personnelles ni de vrai catalogue client.

Un problème de sécurité ? **N'ouvrez pas d'issue publique** — voir [SECURITY.md](SECURITY.md).

## FAQ

**Est-ce open source ?** C'est du code *visible* (« source-available ») : vous pouvez le lire, l'exécuter et le modifier pour des usages non commerciaux. Ce n'est pas de l'« open source » au sens de l'OSI, car l'usage commercial est restreint.

**Puis-je l'utiliser pour ma propre boutique ?** Une boutique est une activité commerciale : une licence commerciale est nécessaire. Projets personnels, apprentissage, recherche, écoles et associations : gratuit.

**Puis-je convertir des catalogues pour des clients ?** C'est un usage commercial — contactez-nous pour une licence.

**Mon catalogue quitte-t-il mon ordinateur ?** Le Converter travaille en local. Le Scraper contacte les sites que vous collectez et, si vous les activez, les fournisseurs payants configurés avec vos propres clés.

**Faut-il des clés ?** Aucune pour lancer le Converter ou le Scraper de base. Les services facultatifs (déblocage, aide IA) utilisent des clés que vous saisissez dans l'application.

**Existe-t-il un installateur prêt à l'emploi ?** Pas encore dans ce dépôt — construisez-le avec les commandes ci-dessus. Des versions publiées pourront suivre.

## Licence

Copyright (c) 2026 Eloshon. Sous [PolyForm Noncommercial License 1.0.0](LICENSE).

- **Gratuit** : usage personnel, loisir, étude, recherche, enseignement, associations, institutions publiques — y compris modifier et partager le code pour ces usages, en gardant la licence et la ligne `Required Notice`.
- **Licence nécessaire** : l'utiliser pour une entreprise, une boutique, un projet client, un service ou un produit payant. Voir [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md) ou écrire à **team@eloshon.com**.

Les dépendances tierces gardent leurs propres licences.
