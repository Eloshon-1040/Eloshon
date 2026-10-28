/**
 * A product page in the side panel: one product, its sizes and lengths shown as
 * groups of buttons. The page is the card; a "Tailles" / "Longueurs" field takes the
 * whole group ("28 | 29 | 30"); a list on listing cards (colour swatches) works the
 * same per card. Offline (linkedom), generic markup.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { pickField, sameKindGroup } from '../extract/pick-selector.mjs';
import { readCards, mergeRecipe } from '../extract/card-recipe.mjs';
import { isListField } from '../extract/field-meaning.mjs';

const productPage = () => parseHTML(`<html><body>
  <header><nav><a href="/">Accueil</a><a href="/hommes">Hommes</a><a href="/femmes">Femmes</a></nav></header>
  <main><h1 class="pdp-title">Jean slim 513™</h1><div class="pdp-price">44,98 €</div>
    <div class="size-picker"><p>Taille (W)</p>
      <ul class="waist">${[28, 29, 30, 31, 32].map((w) => `<li class="swatch"><button class="size-btn" aria-label="W${w}">${w}</button></li>`).join('')}</ul>
      <p>Longueur (L)</p>
      <ul class="length">${[30, 32, 34].map((l) => `<li class="swatch"><button class="size-btn${l === 34 ? ' is-disabled' : ''}">${l}</button></li>`).join('')}</ul>
    </div>
    <div class="colors">${['Noir', 'Bleu'].map((c) => `<span class="dot" title="${c}"></span>`).join('')}</div>
  </main></body></html>`).document;

test('field names that hold a list', () => {
  assert.equal(isListField({ label: 'Tailles' }), true);
  assert.equal(isListField({ label: 'Longueur' }), true);
  assert.equal(isListField({ label: 'Couleurs' }), true);
  assert.equal(isListField({ label: 'Prix' }), false);
  assert.equal(isListField({ label: 'Ville' }), false);
});

test('a product page: the page is the card, a size click takes the whole size group', () => {
  const d = productPage();
  const waist = pickField(d.querySelectorAll('ul.waist button')[2], { doc: d, fieldKey: 'tailles', list: true, page: true });
  assert.equal(waist.ok, true, waist.reason);
  assert.equal(waist.card, 'body');
  assert.equal(waist.sample, '28 | 29 | 30 | 31 | 32');
  assert.equal(waist.values, 5);
  const length = pickField(d.querySelectorAll('ul.length button')[0], { doc: d, card: 'body', fieldKey: 'longueurs', list: true });
  assert.equal(length.sample, '30 | 32 | 34');
  const colors = pickField(d.querySelector('.dot'), { doc: d, card: 'body', fieldKey: 'couleurs', list: true });
  assert.equal(colors.sample, 'Noir | Bleu', 'swatches without text give their label');
  const name = pickField(d.querySelector('h1'), { doc: d, card: 'body', fieldKey: 'name' });
  assert.equal(name.ok, true, 'a single element on a product page no longer needs a repeated card');
  const recipe = mergeRecipe(null, { card: 'body', fields: [
    { key: 'name', selector: name.selector },
    { key: 'tailles', selector: waist.selector, all: waist.all },
    { key: 'longueurs', selector: length.selector, all: length.all },
  ] });
  const rows = readCards(d, recipe, 'https://www.shop.test/fr/p/085130934');
  assert.equal(rows.length, 1);
  assert.deepEqual({ name: rows[0].name, tailles: rows[0].tailles, longueurs: rows[0].longueurs, url: rows[0].sourceUrl },
    { name: 'Jean slim 513™', tailles: '28 | 29 | 30 | 31 | 32', longueurs: '30 | 32 | 34', url: 'https://www.shop.test/fr/p/085130934' });
});

test('a list on listing cards is read per card', () => {
  const card = (i, colors) => `<div class="tile"><a href="/p/${i}">Model ${i}</a><span class="price">${10 + i},00 €</span><ul class="sw">${colors.map((c) => `<li class="c" title="${c}"></li>`).join('')}</ul></div>`;
  const d = parseHTML(`<html><body><main>${[card(1, ['Rouge', 'Vert']), card(2, ['Bleu']), card(3, ['Noir', 'Blanc', 'Gris'])].join('')}</main></body></html>`).document;
  const r = pickField(d.querySelector('li.c'), { doc: d, fieldKey: 'couleurs', list: true });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.card, 'div.tile');
  const n = pickField(d.querySelector('.tile a'), { doc: d, card: r.card, fieldKey: 'name' });
  const rows = readCards(d, mergeRecipe(null, { card: r.card, fields: [{ key: 'name', selector: n.selector }, { key: 'couleurs', selector: r.selector, all: r.all }] }), 'https://shop.test/');
  assert.deepEqual(rows.map((x) => x.couleurs), ['Rouge | Vert', 'Bleu', 'Noir | Blanc | Gris'], 'a card with one swatch gives its single value');
  assert.ok(sameKindGroup(d.querySelector('.price')) === null, 'repeated product cards are not a list of values');
});

test('brand and collection fields; the card state gives brand and own category', async () => {
  const { fieldMeaning } = await import('../extract/field-meaning.mjs');
  const { extractEmbeddedProducts } = await import('../extract/embedded-state.mjs');
  assert.equal(fieldMeaning({ label: 'Marque' }), 'brand');
  assert.equal(fieldMeaning({ label: 'Collection' }), 'category');
  assert.equal(fieldMeaning({ label: 'Nom de la marque' }), 'brand');
  const html = `<script>window.S = ${JSON.stringify({ products: [
    { title: 'A', link: '/p/a', price: 10, brands: [{ code: 'CENT', name: 'Central Park' }], category: { title: 'Salons de jardin en angle', id: 'ga0201' } },
    { title: 'B', link: '/p/b', price: 12, brand: 'Keter', category: 'ga0201' },
  ] })};</script>`;
  const cards = extractEmbeddedProducts(html, 'https://shop.test/fr/jardin/ga086/').cards;
  assert.deepEqual(cards.map((c) => [c.brand, c.category]), [['Central Park', 'Salons de jardin en angle'], ['Keter', 'jardin']]);
});
