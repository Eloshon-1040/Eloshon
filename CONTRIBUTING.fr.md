# Contribuer à Eloshon

**Français** · [English](CONTRIBUTING.md)

Merci de vouloir aider ! Ce projet est publié sous [PolyForm Noncommercial 1.0.0](LICENSE) : le code est ouvert à la lecture, à l'exécution et à l'amélioration, mais **l'usage commercial est réservé à Eloshon** (voir [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)). Les contributions sont les bienvenues selon l'accord ci-dessous.

## Accord de contribution (obligatoire)

En envoyant une contribution (pull request, patch, code dans une issue), vous déclarez que :

1. vous en êtes l'auteur, ou vous avez le droit de la soumettre ;
2. vous la publiez sous la licence du projet (PolyForm Noncommercial 1.0.0) ;
3. vous accordez en plus à Eloshon une licence mondiale, perpétuelle, gratuite et non exclusive pour utiliser, modifier, sous-licencier et distribuer votre contribution **sous n'importe quelle licence, y compris commerciale** ;
4. vous gardez la propriété de votre contribution.

Signez chaque commit avec `git commit -s` (ligne `Signed-off-by: Nom <email>`). Une pull request sans cette signature ne sera pas fusionnée.

## Comment aider

| Vous êtes… | Premières contributions possibles |
|---|---|
| **Commerçant / data** | Un export de plateforme mal lu, une colonne au mauvais endroit — signalez-le avec un petit exemple *synthétique* |
| **Développeur** | Corriger un bug avec un test de non-régression ; ajouter un format source ou cible ; améliorer un extracteur |
| **Traducteur** | Corriger un libellé ou ajouter un texte manquant (Converter : FR/EN/NL/ES ; Scraper : aussi DE) |
| **Rédacteur** | Clarifier le README et [`docs/`](docs), ajouter des exemples |

Parcourez les issues **good first issue** et **help wanted**, ou [`docs/ROADMAP.md`](docs/ROADMAP.md) pour des idées.

## Installation

```bash
git clone https://github.com/Eloshon-1040/Eloshon.git
cd Eloshon
npm --prefix converter ci          # Converter
npm ci                             # Scraper
```

Prérequis : Windows 10/11, Node.js 22+, npm, Git. Le [README](README.fr.md#démarrage-rapide) explique comment lancer chaque application.

## Marche à suivre

1. **Ouvrez d'abord une issue** pour tout ce qui dépasse une petite correction : cela évite un travail qui ne pourra pas être fusionné.
2. Forkez le dépôt et créez une branche : `fix/shopify-weight-unit`, `feat/wix-orders`…
3. Petits commits ciblés, messages clairs (`fix(converter): …`, `feat(scraper): …`), signés avec `-s`.
4. Lancez les tests (ci-dessous). **Un bug corrigé = un test de non-régression** qui échoue avant votre changement et passe après.
5. Ouvrez une pull request avec le modèle et décrivez le *quoi* et le *pourquoi*.

## Tests

```bash
npm --prefix converter test        # construit le moteur, lance la suite du Converter
npm test                           # Scraper, extension, hôte natif (construire d'abord le moteur du Converter)
```

Le Converter garde des **fichiers de référence (golden files)** dans `converter/test/golden` (la sortie exacte attendue de chaque paire source → cible). Si votre changement modifie une sortie volontairement, régénérez-les avec `npm --prefix converter run gen:golden` et expliquez la différence dans la pull request. `npm run smoke:live` et les scripts `verify-*` utilisent de vrais réseaux : ne les lancez pas dans une pull request.

## Conventions de code

- Suivez le code environnant : noms, densité de commentaires, idiomes. Aucun nouveau framework ni outil de build sans discussion.
- Le moteur du Converter est du TypeScript pur dans `converter/core/src` (sans E/S, déterministe). Ce qui touche au système de fichiers ou à Electron va dans `converter/app`.
- Tout texte visible existe dans **toutes les langues de l'interface** (`converter/app/renderer/i18n*`, `app/renderer/i18n/`) ; un test de parité le vérifie. Aucun texte d'interface en dur.
- Aucune valeur métier en dur (prix, limites) : lisez-les dans la configuration.
- Les fixtures de test sont **synthétiques** : pas de données clients réelles, d'adresses e-mail, de noms de boutiques ni de catalogues copiés de sites tiers.

## Refusé

- clés, jetons, mots de passe, fichiers `.env` ;
- données personnelles ou exports de boutiques réelles ;
- code copié d'un projet dont la licence interdit cette réutilisation ;
- travail visant à nuire à un site ou à un service (attaques, abus de protections).

## Sécurité

Signalez les failles en privé : voir [SECURITY.md](SECURITY.md).

## Comportement

Soyez bienveillants. Voir le [code de conduite](CODE_OF_CONDUCT.md).
