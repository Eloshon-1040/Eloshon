# Eloshon — Scraper & Converter

**Eloshon Scraper** collecte les produits d'un site web (via une application Electron et une extension Chrome/Edge).
**Eloshon Converter** transforme un catalogue (CSV, JSON, export de boutique) vers Shopify, WooCommerce, Wix, BigCommerce, PrestaShop, Shopware et d'autres formats d'import.

> **Licence : usage non commercial uniquement** ([PolyForm Noncommercial 1.0.0](LICENSE)).
> Le code est visible et utilisable gratuitement pour un usage personnel, l'étude, la recherche, l'enseignement et les organisations à but non lucratif.
> **Tout usage commercial est interdit sans licence écrite** (voir [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)).
> Ce n'est pas un logiciel « open source » au sens de l'OSI.

*English: source-available under the PolyForm Noncommercial License 1.0.0. Free for noncommercial use; any commercial use requires a separate written licence.*

## Contenu du dépôt

| Dossier | Rôle |
|---|---|
| `app/`, `core/`, `shared/`, `lib/` | Eloshon Scraper : application Electron et moteur d'extraction |
| `extension/`, `native-host/` | Extension Chrome/Edge et pont vers l'application |
| `converter/` | Eloshon Converter (application Electron + moteur de conversion) |
| `supabase/` | Schéma et fonction serveur du service hébergé (facultatif) |
| `docs/` | Notes techniques |

## Installation (développeurs)

Prérequis : Node.js 20 ou plus, npm, Windows 10/11 (le développement est suivi sur Windows).

```bash
npm ci
npm run pw:install        # télécharge Chromium pour Playwright
npm start                 # lance Eloshon Scraper
```

Converter :

```bash
npm --prefix converter ci
npm --prefix converter start
```

## Tests

```bash
npm test                         # Scraper, extension, hôte natif
npm --prefix converter test      # Converter (moteur, formats, golden files)
```

Les scripts `smoke:live` et `verify-*` font de vrais appels réseau : ne les lancez qu'en connaissance de cause.

## Services externes et clés

Aucune clé n'est fournie avec le dépôt. Les fonctions qui s'appuient sur des services payants (fournisseurs de déblocage, IA) demandent **vos propres clés**, saisies dans l'application et stockées localement. Ne les placez jamais dans le code ni dans une issue.

## Signaler un bug ou proposer une amélioration

- Bug ou idée : ouvrez une [issue](../../issues/new/choose) (modèles fournis).
- Faille de sécurité : **ne pas ouvrir d'issue publique**, voir [SECURITY.md](SECURITY.md).
- Contribuer au code : lisez [CONTRIBUTING.md](CONTRIBUTING.md).

N'incluez dans une issue aucune donnée personnelle, aucune clé et aucun catalogue client.

## Respect des sites web

Utilisez Eloshon Scraper dans le respect des conditions d'utilisation, du fichier `robots.txt` et de la loi applicable aux sites visités. Vous êtes responsable de l'usage que vous en faites.

## Licence

Copyright (c) 2026 Eloshon. Voir [LICENSE](LICENSE). Les dépendances tierces gardent leurs propres licences.
