# adidas : vérification à la main (10 produits)

adidas bloque tout Chrome piloté : ce contrôle se fait dans **votre** Chrome, avec l'extension et l'app installées
(app 0.5.56, extension 0.7.31, Converter 0.1.10). Comptez 20 minutes.

## Préparer

1. Installez `Eloshon Scraper Setup 0.5.56.exe` et `Eloshon-Converter-Setup-0.1.10.exe` (dossiers `dist\` et
   `converter\out\`). Ouvrez l'app Eloshon Scraper.
2. Dans `chrome://extensions`, cliquez sur « Recharger » sous Eloshon Scraper : la version affichée doit être
   **0.7.31**. Rechargez ensuite l'onglet adidas (F5).
3. Ouvrez une liste homme, par exemple `https://www.adidas.be/fr/homme-chaussures`.

## Lire la liste et les fiches

4. Ouvrez le panneau (icône Eloshon), onglet **Réglages** : « Produits maximum » = **10**. Onglet **Pages** :
   « Sous-pages » coché, « Fiches produit à lire » = **0** (toutes).
5. Sur UNE fiche produit adidas ouverte dans l'onglet actif :
   - onglet **Champs** : ajoutez un champ (« ＋ »), laissez son nom « Champ 1 », cliquez sur 🎯 puis sur **un
     bouton de taille** (pas sur le titre « Taille ») : le panneau doit dire « option « Taille » » (ou le nom
     écrit par adidas), lister toutes les tailles, et le rôle passe à « taille » ;
   - faites de même avec un autre champ sur **une pastille de couleur** (rôle « couleur ») ;
   - onglet **Fiche produit** : ajoutez un champ nommé « Nom de variante » : il doit être créé (plus de message
     « Un champ « name » existe déjà ») avec le rôle « nom de variante », modifiable.
6. Revenez sur la liste, cliquez **▶ Exécuter**. À côté du tableau, la ligne doit dire « Aperçu : N fiches lues
   sur 10 … » et « « Accepter » lira les 10 fiches produit ».
7. Cliquez **Exporter CSV** avant d'accepter : un avertissement « Ceci est un aperçu, pas le résultat complet »
   doit apparaître. Cliquez **Annuler**.
8. Cliquez **✓ Accepter**. Une fenêtre réduite lit les fiches ; la progression s'affiche sous les boutons.
   - Si adidas demande une vérification humaine : un encadré « Vérification humaine demandée » apparaît.
     Cliquez « Ouvrir la fiche », répondez à la vérification, puis « Reprendre ». Notez si la lecture reprend.
9. À la fin : la ligne d'état dit « Complet : 10 fiches lues sur 10 » ou « Partiel … » avec les fiches non lues.
   Cliquez **Exporter CSV** : deux fichiers arrivent (`eloshon-adidas.be-….csv` et `….manifest.json`).

## Convertir

10. Ouvrez le Converter : **Nouvelle conversion**, source **Eloshon Scraper**, cible **Shopify**, puis choisissez
    le CSV exporté (par le bouton, pas par glisser-déposer : le manifeste n'est lu qu'ainsi).
11. Étape 2 : le format doit être reconnu sans correspondance manuelle, et l'encadré du manifeste doit dire
    « Export complet … » (ou « partiel » avec la raison).
12. Étape 3 : en descendant dans l'aperçu, les titres de colonnes restent visibles et la barre horizontale aussi.
    Vérifiez :
    - **Couleur** et **Taille** sont deux options (`Option1 Name` / `Option2 Name`) ;
    - toutes les combinaisons couleur × taille sont là (ex. 3 couleurs × 8 tailles = 24 lignes de variante) ;
    - chaque couleur a ses photos ; le titre du produit ne contient plus la couleur ;
    - « Stock des variantes » = « Non suivi : toujours en vente ».
13. Refaites l'étape 10 avec la cible **WooCommerce**, puis **Wix** : produit variable + une variation par
    combinaison (Woo) ; une ligne VARIANT par combinaison (Wix).

## Ce qu'il faut me renvoyer

- Les deux fichiers exportés à l'étape 9 (CSV + manifeste).
- Une capture de l'étape 3 du Converter (Shopify).
- Ce qui s'est passé à l'étape 8 si une vérification humaine est apparue (reprise oui / non).
- Le numéro du job dans l'app (onglet Jobs), pour que je relise son rapport : la ligne « time spent » dit
  maintenant où le temps est passé.
