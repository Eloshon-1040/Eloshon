# Eloshon — product scraper and e-commerce catalog converter

**Collect product data from any website, then convert it into the import file of your online shop.**
Eloshon is a pair of free desktop applications (Windows) for e-commerce people: shop owners, dropshippers, agencies, developers and students.

| | What it does |
|---|---|
| **Eloshon Scraper** | Collects products (name, price, images, variants, stock, descriptions…) from a website. A Chrome/Edge extension lets you point at what you want on a page and teaches the app a site's layout from one example. |
| **Eloshon Converter** | Turns a product catalog (CSV, JSON, shop export, supplier file, or an Eloshon Scraper export) into the import file for **Shopify, WooCommerce, Wix or BigCommerce**, and migrates between these platforms. Everything is processed on your computer. |

> **Licence: noncommercial use only** — [PolyForm Noncommercial 1.0.0](LICENSE).
> Free to use, study and modify for personal use, research, education and non-profit organisations.
> **Any commercial use needs a written licence from us**: see [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).
> This is *source-available*, not "open source" in the OSI sense.

*Mots-clés / keywords: product scraper, web scraping e-commerce, CSV converter, Shopify import CSV, WooCommerce import, Wix Stores import, BigCommerce import, PrestaShop to Shopify, Shopware migration, catalogue produits, convertir un fichier produits, migration de boutique en ligne.*

---

## Français — pour qui, pour quoi ?

Vous avez un fichier de produits d'un fournisseur, un export d'une ancienne boutique, ou un site dont vous voulez récupérer le catalogue, et vous devez l'importer dans Shopify, WooCommerce, Wix ou BigCommerce sans tout ressaisir à la main ? C'est le but de ces deux applications.

**Eloshon Converter** lit le fichier, reconnaît les colonnes (en-têtes en français, anglais, néerlandais, espagnol…), vous laisse corriger la correspondance, appliquer des formules (remplacer, couper, ajouter, renommer…) et modifier à la main les cellules du fichier final avant de l'exporter dans le format exact attendu par la boutique cible. Interface en français, anglais, néerlandais et espagnol.

**Eloshon Scraper** récupère les fiches produits d'un site : avec l'extension, vous montrez un produit et l'application retrouve les autres. Les données sortent en fichier que le Converter sait ensuite transformer.

## Que peut faire le Converter ?

- **Sources reconnues :** Shopify, WooCommerce, Wix, BigCommerce, PrestaShop, Shopware, BigBuy et les exports d'Eloshon Scraper (CSV et JSON). Un format inconnu peut être appris et mémorisé.
- **Cibles :** Shopify, WooCommerce, Wix Stores, BigCommerce. Produits, variantes, images, catégories ; clients et commandes pour les plateformes prises en charge.
- **Correspondance des colonnes :** propositions automatiques avec niveau de confiance, correction à la main, modèles de correspondance réutilisables.
- **Formules prêtes à l'emploi** (équivalent des fonctions d'un tableur) appliquées avant ou après la conversion, et modification directe des cellules de sortie.
- **Vos données restent sur votre ordinateur** : aucun fichier de catalogue n'est envoyé.
- Version actuelle : sans limite de lignes.

## What can the Converter do? (English)

- **Reads:** Shopify, WooCommerce, Wix, BigCommerce, PrestaShop, Shopware, BigBuy and Eloshon Scraper exports (CSV and JSON); unknown layouts can be learned and remembered.
- **Writes:** Shopify, WooCommerce, Wix Stores and BigCommerce import files (products, variants, images, categories; customers and orders where supported).
- **Column mapping** with confidence levels, manual fixes and reusable templates; **ready-made formulas** before or after conversion; **edit output cells by hand**.
- **Local processing**: your catalog never leaves your computer.
- UI languages: French, English, Dutch, Spanish.

## Repository layout

| Folder | Role |
|---|---|
| `converter/` | Eloshon Converter — Electron app and conversion engine (`converter/core`) |
| `app/`, `core/`, `shared/`, `lib/` | Eloshon Scraper — Electron app and extraction engine |
| `extension/`, `native-host/` | Chrome/Edge extension and its bridge to the app |
| `supabase/` | Schema and server function of the optional hosted service |
| `docs/` | Technical notes (extension, providers, variants, reliability…) |

## Run it from source

Requirements: Node.js 20+, npm, Windows 10/11.

```bash
# Converter
npm --prefix converter ci
npm --prefix converter start

# Scraper
npm ci
npm run pw:install        # downloads Chromium for Playwright
npm start
```

## Tests

```bash
npm --prefix converter test      # build the engine, then the Converter suite
npm test                         # Scraper, extension, native host (needs the Converter engine built first)
```

`smoke:live` and the `verify-*` scripts make real network calls: run them knowingly.

## Where to start contributing

We would love help, especially with:

- **new or fixed import formats** (a platform export that is mis-read, a column that lands in the wrong place) — add a small **synthetic** sample file and a test;
- **translations** and wording of the interface;
- **bug reports with a minimal example** (see the issue templates);
- **tests and documentation**.

Read [CONTRIBUTING.md](CONTRIBUTING.md) first (contribution agreement and `git commit -s`). Look for issues labelled **good first issue** and **help wanted**.

## Support, bugs, security

- Bug or idea: open an [issue](../../issues/new/choose).
- Security problem: **do not open a public issue**, see [SECURITY.md](SECURITY.md).
- Never post keys, personal data or a real customer catalog.

## External services and keys

No key ships with this repository. Features that rely on paid third-party services (unblocking providers, AI) need **your own keys**, entered in the application and stored locally.

## Respect the websites you scrape

Use Eloshon Scraper in line with each site's terms of use, `robots.txt` and the law. You are responsible for how you use it.

## Licence

Copyright (c) 2026 Eloshon. [PolyForm Noncommercial 1.0.0](LICENSE). Third-party dependencies keep their own licences.
