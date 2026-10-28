/**
 * Garde anti-dérive sur les 3 emplacements UI qui affichent l'équivalent €.
 *
 * Le renderer (app/renderer/app.js) tourne dans Electron et garde sa propre
 * fonction `eur()` plutôt que d'importer core/credit-rate.mjs : la frontière
 * renderer → core n'existe pas aujourd'hui et l'ouvrir pour trois lignes de
 * formatage serait disproportionné. Le risque, c'est que les deux formules
 * divergent en silence — ce fichier l'empêche : il extrait le vrai `eur()` du
 * renderer, l'exécute, et compare son résultat à l'implémentation testée.
 *
 * Il vérifie aussi que les trois emplacements appellent bien `eur()`, pour
 * qu'un ajout d'affichage de crédits sans équivalent € soit remarqué.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { eurosSuffix, rateFromAccount } from '../credit-rate.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const RENDERER = path.join(HERE, '..', '..', 'app', 'renderer', 'app.js');
const src = readFileSync(RENDERER, 'utf8');

/** Extrait le corps de `function eur(credits) { … }` du renderer. */
function extractEur() {
  const start = src.indexOf('function eur(credits)');
  assert.ok(start > -1, 'le helper eur() a disparu du renderer');
  let depth = 0, i = src.indexOf('{', start), end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > -1, 'accolades non équilibrées dans eur()');
  return src.slice(start, end);
}

/** Recrée eur() hors du navigateur, avec un `state` contrôlé. */
function makeEur(creditRate) {
  const body = extractEur();
  // eslint-disable-next-line no-new-func
  return new Function('state', `${body}; return eur;`)({ creditRate });
}

test('les 3 emplacements UI appellent bien eur()', () => {
  // Written in the template (« crédits${esc(eur(…))} ») or passed to a translated text next to its credits
  // (« { credits: fmt(…), eur: eur(…) } », the « Débloquer » buttons since they are translated).
  const calls = src.match(/\$\{esc\(eur\([^)]*\)\)\}|eur: eur\([^)]*\)/g) ?? [];
  assert.equal(calls.length, 3,
    `attendu 3 appels à eur() dans le renderer, trouvé ${calls.length} — un affichage de crédits a été ajouté ou retiré sans son équivalent €`);
  // chacun doit suivre immédiatement un affichage de crédits
  const withCredits = src.match(/crédits\$\{esc\(eur\([^)]*\)\)\}|credits: fmt\([^)]*\), eur: eur\([^)]*\)/g) ?? [];
  assert.equal(withCredits.length, 3, 'un eur() ne suit pas un nombre de crédits');
});

test('eur() du renderer == eurosSuffix() testé, sur le palier Starter réel', () => {
  // Palier Starter Scraper lu en base : 39 € / 5000 crédits.
  const rate = rateFromAccount({ ok: true, plan: 'starter', plan_price_eur: '39.00', plan_credits: 5000 });
  const eur = makeEur(rate);
  for (const credits of [0, 1, 120, 850, 2000, 99999]) {
    assert.equal(eur(credits), eurosSuffix(credits, rate),
      `divergence sur ${credits} crédits entre le renderer et credit-rate.mjs`);
  }
  // valeurs attendues, recalculées à la main
  assert.match(eur(2000), /15,60/, '2000 × 39/5000 = 15,60 €');
  assert.match(eur(850), /6,63/, '850 × 0,0078 = 6,63 €');
});

test('eur() n’affiche rien quand le serveur ne fournit pas de taux', () => {
  // C'est le cas du compte de dev, sur un plan hors catalogue.
  const eur = makeEur(rateFromAccount({ ok: true, plan: 'test', plan_price_eur: null, plan_credits: null }));
  assert.equal(eur(2000), '', 'aucun équivalent inventé');
  assert.equal(eur(0), '');
});

test('eur() encaisse une entrée non numérique sans casser le rendu', () => {
  const eur = makeEur(0.0078);
  assert.equal(eur(undefined), '');
  assert.equal(eur(null), '');
  assert.equal(eur('abc'), '');
});
