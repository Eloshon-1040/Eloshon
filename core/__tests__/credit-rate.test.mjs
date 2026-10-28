import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  creditRate, rateFromAccount, creditsToEuros, formatEuros, eurosSuffix,
} from '../credit-rate.mjs';

test('creditRate: prix ÷ crédits du palier, jamais une constante', () => {
  // Starter Scraper : 39 € pour 5000 crédits (valeurs product_tiers réelles)
  assert.equal(creditRate({ price_eur: 39, credits: 5000 }), 39 / 5000);
  // Agency : 1299 € pour 400 000
  assert.equal(creditRate({ price_eur: 1299, credits: 400000 }), 1299 / 400000);
  // deux paliers différents donnent deux taux différents — pas de taux global
  assert.notEqual(
    creditRate({ price_eur: 39, credits: 5000 }),
    creditRate({ price_eur: 149, credits: 25000 }),
  );
});

test('creditRate: pas de taux quand la question n’a pas de réponse', () => {
  assert.equal(creditRate(null), null);
  assert.equal(creditRate({ is_free: true, price_eur: 0, credits: 500 }), null, 'palier gratuit');
  assert.equal(creditRate({ plan: 'free', price_eur: 9, credits: 750 }), null, 'plan free');
  assert.equal(creditRate({ price_eur: null, credits: 5000 }), null, 'pas de prix');
  assert.equal(creditRate({ price_eur: 39, credits: null }), null, 'pas de volume');
  assert.equal(creditRate({ price_eur: 39, credits: 0 }), null, 'division par zéro');
});

// Formes RÉELLES renvoyées par get_account_status (projet Convert | Scrap
// Apps) après la migration account_status_plan_pricing, copiées verbatim
// depuis la base. Le contrat client est testé contre ce que le serveur
// produit vraiment, pas contre une forme supposée.
const SERVER_TEST_PLAN = {
  ok: true, plan: 'test', period_month: '2026-09',
  plan_credits: null, plan_price_eur: null,
  free_quota_used: null, scraper_credits: 2000, free_quota_limit: null,
  converter_credits: 0, credits_used_period: 286,
};
const SERVER_STARTER = {
  ok: true, plan: 'starter', period_month: '2026-09',
  plan_credits: 5000, plan_price_eur: '39.00',
  free_quota_used: null, scraper_credits: 2000, free_quota_limit: null,
  converter_credits: 0, credits_used_period: 286,
};

test('rateFromAccount: résout le palier réel, ou rien', () => {
  // Un plan hors catalogue (le compte de dev est sur plan='test') : la
  // fonction SQL renvoie deux NULL et le client n'affiche aucun équivalent.
  assert.equal(rateFromAccount(SERVER_TEST_PLAN), null, 'plan hors catalogue → pas de taux');

  // Un plan du catalogue : le prix arrive en NUMERIC, donc en CHAÎNE via
  // jsonb → le taux doit quand même se calculer.
  assert.equal(rateFromAccount(SERVER_STARTER), 39 / 5000, 'prix numeric sérialisé en chaîne');

  // Chaque palier réel du catalogue Scraper (valeurs lues en base).
  const ladder = [[9, 750], [39, 5000], [149, 25000], [449, 100000], [1299, 400000]];
  for (const [price, credits] of ladder) {
    assert.equal(
      rateFromAccount({ ok: true, plan: 'x', plan_price_eur: price, plan_credits: credits }),
      price / credits,
    );
  }

  assert.equal(rateFromAccount({ ok: true, plan: 'free', plan_price_eur: null, plan_credits: null }), null,
    'palier gratuit → pas d’équivalent');
  assert.equal(rateFromAccount({ ok: false, reason: 'unknown_account' }), null);
  assert.equal(rateFromAccount({ ok: false, reason: 'account_blocked' }), null);
  assert.equal(rateFromAccount(null), null);
});

test('chaîne complète: solde réel × taux réel = ce que l’UI affiche', () => {
  // 2000 crédits sur le palier Starter (39 € / 5000 crédits) → 15,60 €.
  // Recalcul indépendant, et comparaison avec le SELECT de contrôle exécuté
  // en base : equivalent_eur = 15.60 pour ce même couple.
  const rate = rateFromAccount(SERVER_STARTER);
  const euros = creditsToEuros(SERVER_STARTER.scraper_credits, rate);
  assert.ok(Math.abs(euros - 15.60) < 0.005, `attendu 15,60 €, obtenu ${euros}`);
  assert.match(eurosSuffix(SERVER_STARTER.scraper_credits, rate), /15,60/);

  // Le même compte sur plan='test' n'affiche rien du tout.
  assert.equal(eurosSuffix(SERVER_TEST_PLAN.scraper_credits, rateFromAccount(SERVER_TEST_PLAN)), '');
});

test('crédits à zéro: 0 € et non une absence d’affichage', () => {
  const rate = rateFromAccount(SERVER_STARTER);
  assert.equal(creditsToEuros(0, rate), 0);
  assert.match(eurosSuffix(0, rate), /0,00/);
});

test('creditsToEuros: conversion au taux du compte', () => {
  const rate = 39 / 5000; // 0,0078 €/crédit
  assert.equal(creditsToEuros(850, rate), 850 * rate);
  assert.ok(Math.abs(creditsToEuros(850, rate) - 6.63) < 0.005);
  assert.equal(creditsToEuros(850, null), null, 'pas de taux → pas de conversion');
});

test('eurosSuffix: chaîne vide quand il n’y a rien à dire', () => {
  assert.equal(eurosSuffix(850, null), '', 'palier gratuit ou inconnu');
  const s = eurosSuffix(850, 39 / 5000);
  assert.match(s, /^ \(≈ /);
  assert.match(s, /€\)$/);
});

test('formatEuros: deux décimales, séparateur local', () => {
  assert.match(formatEuros(6.63), /6,63/);
  assert.match(formatEuros(1234.5), /1\s?234,50/);
});
