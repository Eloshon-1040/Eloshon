/**
 * emptyPageDiagnosis — a zero-product run must never be a dead end. Given the
 * rendered page, it classifies WHY nothing was extracted into ONE actionable,
 * evidence-based category. Generic: no site names, only page signals + the shared
 * embedded-state extractor. These fixtures mirror the real "shapes" the extension
 * meets on an unknown site (SPA shell, embedded grid, plain-HTML grid, home page…).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyPageDiagnosis, EMPTY_DIAGNOSIS_TEXT } from '../classify/empty-diagnosis.mjs';

const page = (title, body) => `<html><head><title>${title}</title></head><body>${body}</body></html>`;

test('likely_block: a bot-shell / interstitial — tiny body, no data, no prices', () => {
  const d = emptyPageDiagnosis(page('Un instant…', '<div id="app"></div>'), { url: 'https://shop.test/fr/liste', status: 200 });
  assert.equal(d.reasonCode, 'likely_block');
  assert.equal(d.embeddedProducts, 0);
  assert.equal(d.hasStructuredData, false);
  assert.equal(EMPTY_DIAGNOSIS_TEXT[d.reasonCode].length > 0, true);
});

test('unreadable_data: the page carried embedded product JSON — a fixable extractor gap, not a block', () => {
  // A products[] array is present (so extractEmbeddedProducts would normally read
  // it); the diagnosis flags that the data WAS there, which is the highest-value
  // signal because it points at our own code, not the site.
  const grid = JSON.stringify({ products: [{ name: 'A', price: 9.9, url: '/p/a-1' }, { name: 'B', price: 5, url: '/p/b-2' }] });
  const d = emptyPageDiagnosis(page('Liste', `<script>window.__DATA__=${grid}</script>` + '<div>'.repeat(500)), { url: 'https://shop.test/fr/liste', status: 200 });
  assert.equal(d.reasonCode, 'unreadable_data');
  assert.equal(d.hasEmbeddedData, true);
  assert.ok(d.embeddedProducts >= 2);
});

test('unreadable_data: schema.org Product present but nothing extracted', () => {
  const ld = '<script type="application/ld+json">' + JSON.stringify({ '@type': 'Product', name: 'X', offers: { price: 12 } }) + '</script>';
  const d = emptyPageDiagnosis(page('Fiche', ld + '<div>'.repeat(400)), { url: 'https://shop.test/fr/p/x', status: 200 });
  assert.equal(d.reasonCode, 'unreadable_data');
  assert.ok(d.productSchema >= 1);
});

test('no_machine_data: a real listing rendered (many prices) but nothing machine-readable', () => {
  const tiles = Array.from({ length: 12 }, (_, i) => `<div class="tile"><span>Article ${i}</span><span>${10 + i},99 €</span></div>`).join('');
  const d = emptyPageDiagnosis(page('Chaussures', tiles + '<div>'.repeat(300)), { url: 'https://shop.test/fr/chaussures', status: 200 });
  assert.equal(d.reasonCode, 'no_machine_data');
  assert.ok(d.priceTokens >= 8);
  assert.equal(d.hasEmbeddedData, false);
  assert.equal(d.hasStructuredData, false);
});

test('a /c/ category URL is a LISTING, never "not a listing" (the Levi\'s regression)', () => {
  // Rendered category page, no machine-readable data yet, no visible prices: the
  // grid did not populate — but the URL is clearly a listing (/c/). Must NOT say
  // "cette adresse n\'est pas une page catégorie".
  // Fully-rendered page chrome (like the real Levi's run: textLen ~4200), grid not
  // yet populated so no visible prices and no embedded/structured data.
  const chrome = '<nav>Accueil Boutique Nouveautés Homme Femme Enfant Marques Promotions Aide Livraison Retours Mon compte Panier Recherche</nav>'
    + '<h1>Jeans Homme</h1>'
    + '<aside>Filtrer par : taille, coupe, couleur, matière, prix, coupe slim, coupe droite, coupe skinny, coupe bootcut, taille haute, taille standard, délavage clair, délavage foncé, brut.</aside>'
    + '<section>Découvrez la collection de jeans homme Levi\'s : le mythique 501 Original, le 511 Slim, le 512 Slim Taper et bien d\'autres coupes iconiques, dans une large gamme de délavages et de finitions pour tous les styles.</section>'
    + '<footer>Mentions légales, conditions générales de vente, politique de confidentialité et protection des données personnelles, nous contacter, à propos de la marque, service client, moyens de paiement sécurisés, informations de livraison et de retour, programme de fidélité, cartes cadeaux, nous rejoindre.</footer>';
  const d = emptyPageDiagnosis(page('Jeans Homme | Levi\'s BE', chrome), { url: 'https://www.levi.com/BE/fr_BE/vetements/homme/jeans/c/levi_clothing_men_jeans', status: 200 });
  assert.ok(d.textLen >= 500, `visible text ${d.textLen}`);
  assert.notEqual(d.reasonCode, 'not_a_listing');
  assert.equal(d.reasonCode, 'empty_listing');
});

test('a category URL with a rendered grid but no machine data → no_machine_data (still a listing)', () => {
  const tiles = Array.from({ length: 12 }, (_, i) => `<div><span>Jean ${i}</span><span>${89 + i},95 €</span></div>`).join('');
  const d = emptyPageDiagnosis(page('Jeans', tiles + '<div>'.repeat(200)), { url: 'https://shop.test/fr/homme/jeans/c/men_jeans', status: 200 });
  assert.equal(d.reasonCode, 'no_machine_data');
});

test('not_a_listing stays for a genuine non-listing URL (account / editorial)', () => {
  const body = '<h1>Mon compte</h1>' + '<p>Vos commandes et informations personnelles.</p>'.repeat(30);
  assert.equal(emptyPageDiagnosis(page('Mon compte', body), { url: 'https://shop.test/fr/mon-compte', status: 200 }).reasonCode, 'not_a_listing');
  const blog = '<h1>Guide</h1>' + '<p>Comment choisir son jean.</p>'.repeat(30);
  assert.equal(emptyPageDiagnosis(page('Blog', blog), { url: 'https://shop.test/fr/blog/choisir-jean', status: 200 }).reasonCode, 'not_a_listing');
});

test('not_a_listing: a home page is not a product grid (wrong URL)', () => {
  const d = emptyPageDiagnosis(page('Boutique', '<nav>menu</nav>' + '<p>bienvenue</p>'.repeat(400)), { url: 'https://shop.test/fr', status: 200 });
  assert.equal(d.reasonCode, 'not_a_listing');
});

test('not_a_listing: a soft-404 error page', () => {
  const d = emptyPageDiagnosis(page('Page introuvable', '<h1>Page introuvable</h1>' + '<div>'.repeat(400)), { url: 'https://shop.test/fr/liste', status: 200 });
  assert.equal(d.reasonCode, 'not_a_listing');
  assert.equal(d.pageKind, 'not_found');
});

test('empty_listing: a fully-rendered page (real chrome text) with no prices, no data', () => {
  // A genuinely rendered but empty listing: full nav/footer text, a "no results"
  // line — no prices, no embedded/structured data. Distinguished from a block by
  // the amount of visible text, not by raw HTML size.
  const chrome = '<nav>Accueil Boutique Nouveautés Marques Promotions Contact Aide Livraison Retours Mon compte Panier</nav>'
    + '<h1>Résultats de recherche</h1>'
    + '<p>Aucun résultat ne correspond à votre sélection actuelle. Essayez de modifier ou de retirer certains de vos filtres pour voir davantage de produits issus de notre catalogue complet.</p>'
    + '<aside>Catégories populaires : chaussures, vêtements, accessoires, sport, maison, enfants, électronique, jardin, bricolage, beauté et bien-être.</aside>'
    + '<footer>Mentions légales, conditions générales de vente, politique de confidentialité et protection des données personnelles, nous contacter, à propos de la marque, service client, moyens de paiement sécurisés, informations de livraison et de retour.</footer>';
  const d = emptyPageDiagnosis(page('Résultats', chrome), { url: 'https://shop.test/fr/marque/acme', status: 200 });
  assert.ok(d.textLen >= 500, `visible text ${d.textLen}`);
  assert.equal(d.reasonCode, 'empty_listing');
});

test('every reasonCode has a plain-French, non-technical user text', () => {
  for (const code of ['likely_block', 'unreadable_data', 'no_machine_data', 'not_a_listing', 'empty_listing']) {
    assert.equal(typeof EMPTY_DIAGNOSIS_TEXT[code], 'string');
    assert.ok(EMPTY_DIAGNOSIS_TEXT[code].length > 10);
    assert.doesNotMatch(EMPTY_DIAGNOSIS_TEXT[code], /embedded|schema|json|http|400|dom/i, 'no jargon in the user text');
  }
});
