# Contribuer

Merci de vouloir aider. Ce projet est publié sous [PolyForm Noncommercial 1.0.0](LICENSE) : le code est visible et partagé gratuitement, mais **l'usage commercial est réservé à Eloshon** (voir [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)).

## Accord de contribution (obligatoire)

En envoyant une contribution (pull request, patch, code dans une issue), vous déclarez que :

1. vous êtes l'auteur du code, ou vous avez le droit de le soumettre ;
2. vous le publiez sous la licence du projet (PolyForm Noncommercial 1.0.0) ;
3. vous accordez en plus à Eloshon une licence mondiale, perpétuelle, gratuite et non exclusive pour utiliser, modifier, sous-licencier et distribuer votre contribution **sous n'importe quelle licence, y compris commerciale** ;
4. vous gardez la propriété de votre contribution.

Signez chaque commit avec `git commit -s` (ligne `Signed-off-by: Nom <email>`). Une pull request sans cette signature ne sera pas fusionnée.

## Avant de commencer

- Ouvrez d'abord une issue pour une grosse modification : cela évite un travail refusé.
- Une pull request = un sujet. Petits commits, message clair (`fix(converter): …`, `feat(scraper): …`).
- Le code existant fait foi pour le style. Pas de nouveau framework ni de changement d'architecture sans discussion.

## Tests

```bash
npm ci && npm test
npm --prefix converter ci && npm --prefix converter test
```

- Un bug corrigé = un test de non-régression qui échoue avant, passe après.
- Les fixtures de test sont **synthétiques** : jamais de vraies données client, de vrais e-mails ni de catalogue copié depuis un site tiers.
- Tout texte visible dans le Converter existe dans toutes les langues de l'interface (fichier `i18n`).

## Interdit dans une contribution

- clés, jetons, mots de passe, fichiers `.env` ;
- données personnelles ou exports de boutiques réelles ;
- code copié d'un projet dont la licence interdit cette réutilisation ;
- contournement de protections visant à nuire à un site ou à un service.

## Sécurité

Une faille se signale en privé : voir [SECURITY.md](SECURITY.md).

## Comportement

Respectez le [code de conduite](CODE_OF_CONDUCT.md).
