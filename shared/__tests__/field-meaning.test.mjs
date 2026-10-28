/**
 * Side-panel field roles follow the field's NAME (+ hint), not its slot in the
 * template — measured: "Nom" renamed "Valeur de réduction" and designated on the
 * discount badge replaced every product name with "30 % Rabatt"; "Prix" renamed
 * "Prix de base" put the struck price in the selling price.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { fieldMeaning, fieldKeys, meaningLabel } from '../extract/field-meaning.mjs';
import { readCards, mergeRecipe } from '../extract/card-recipe.mjs';

const PRODUCT_LABELS = { name: 'Nom', price: 'Prix', image: 'Image', url: 'Lien', sku: 'Référence' };

test('meanings from the name (FR / EN / DE / NL keywords), hint used for prices', () => {
  const m = (label, hint = '') => fieldMeaning({ label, hint });
  assert.equal(m('Nom'), 'name'); assert.equal(m('Titre'), 'name'); assert.equal(m('Product name'), 'name');
  assert.equal(m('Prix'), 'price'); assert.equal(m('Prix de vente'), 'price'); assert.equal(m('Prix avec réduction'), 'price');
  assert.equal(m('Prix de base'), 'list_price'); assert.equal(m('Prix barré'), 'list_price'); assert.equal(m('UVP Preis'), 'list_price');
  assert.equal(m('Réduction', 'ici c’est le prix après réduction'), 'price');
  assert.equal(m('Valeur de réduction'), 'valeur_de_reduction');
  assert.equal(m('Image'), 'image'); assert.equal(m('Lien'), 'url'); assert.equal(m('Référence'), 'sku'); assert.equal(m('EAN'), 'ean');
  assert.equal(m('Couleur dispo'), 'couleur_dispo');
  assert.equal(meaningLabel('list_price'), 'prix barré (avant réduction)');
  assert.equal(meaningLabel('valeur_de_reduction'), 'colonne libre');
});

test('the measured Nike set-up: renamed template fields lose their template role; no two fields share a role', () => {
  const fields = [
    { key: 'name', label: 'Valeur de réduction' }, { key: 'price', label: 'Prix de base' }, { key: 'image', label: 'Image' },
    { key: 'url', label: 'Lien' }, { key: 'sku', label: 'Référence' },
    { key: 'reduction', label: 'Réduction', hint: 'ici c’est le prix après réduction', custom: true }, { key: 'champ_2', label: 'Champ 2', custom: true },
  ];
  assert.deepEqual(fieldKeys(fields, PRODUCT_LABELS), ['valeur_de_reduction', 'list_price', 'image', 'url', 'sku', 'price', 'champ_2']);
  assert.deepEqual(fieldKeys([{ key: 'title', label: 'Titre' }, { key: 'duration', label: 'Durée' }], { title: 'Titre', duration: 'Durée' }), ['title', 'duration'], 'unrenamed template fields keep their keys');
  assert.deepEqual(fieldKeys([{ key: 'price', label: 'Prix' }, { key: 'x', label: 'Prix de vente' }], PRODUCT_LABELS), ['price', 'prix_de_vente']);
});

test('with those roles, the stored recipe keeps the names; prices land in the right fields', () => {
  const { document } = parseHTML(`<html><body>${[1, 2].map((i) => `<div class="product-card__body"><a class="t" href="/t/m${i}">Model ${i}</a><div class="product-price is-current">${50 + i},99 €</div><div class="product-price strike">${80 + i},99 €</div><div class="perc">30 % Rabatt</div></div>`).join('')}</body></html>`);
  const stored = { card: '.product-card__body', fields: { name: { selector: '.t' }, price: { selector: '.product-price' }, url: { selector: '.t', attr: 'href' } } };
  const keys = fieldKeys([{ key: 'name', label: 'Valeur de réduction' }, { key: 'price', label: 'Prix de base' }, { key: 'reduction', label: 'Réduction', hint: 'prix après réduction', custom: true }], PRODUCT_LABELS);
  const user = [{ key: keys[0], selector: '.perc' }, { key: keys[1], selector: '.strike' }, { key: keys[2], selector: '.product-price' }];
  const rows = readCards(document, mergeRecipe(stored, { card: '.product-card__body', fields: user }), 'https://shop.test/sale');
  assert.equal(rows[0].name, 'Model 1');
  assert.equal(rows[0].price, 51.99);
  assert.equal(rows[0].listPrice, 81.99);
  assert.equal(rows[0].valeur_de_reduction, '30 % Rabatt');
});
