/**
 * - One piece of a line: a listing card shows "Chambre · Charleroi"; the user clicks
 *   "Charleroi" for a "Ville" column → only the city, on every card.
 * - The price before reduction stated by a card ({ regular:{price}, discount:{price} },
 *   prices:[{type:'original'}]) is kept as the list price.
 * Offline (linkedom), generic markup.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { textPart, applyPart, readCards, mergeRecipe } from '../extract/card-recipe.mjs';
import { pickField, rawText } from '../extract/pick-selector.mjs';
import { extractEmbeddedProducts } from '../extract/embedded-state.mjs';

test('textPart / applyPart: the clicked piece, counted from the end when it is the last', () => {
  const s = 'Chambre · Charleroi';
  assert.deepEqual(textPart(s, s.indexOf('Charleroi') + 2), { sep: '·', index: -1, value: 'Charleroi', start: s.indexOf('Charleroi'), end: s.length });
  assert.deepEqual(textPart(s, 2), { sep: '·', index: 0, value: 'Chambre', start: 0, end: 7 });
  assert.equal(textPart(s, s.indexOf('·')), null, 'on the separator: the whole line');
  assert.equal(applyPart('Appartement entier · Liège', { sep: '·', index: -1 }), 'Liège');
  assert.equal(applyPart('Chambre · Charleroi-MARCINELLE', { sep: '·', index: -1 }), 'Charleroi-MARCINELLE', 'a hyphen without spaces is not a separator');
  assert.equal(applyPart('Loft', { sep: '·', index: -1 }), 'Loft', 'a card without the separator keeps its single value');
  assert.equal(textPart('2,5 kg', 1), null, 'a comma without a space is not a separator');
});

const card = (type, city, price) => `<div class="listing"><a class="cover" href="/rooms/${city.length}${price}"></a>
  <div class="t">${type} · ${city}</div><div class="d">9–11 oct. · Particulier</div><div class="p">${price} € au total</div></div>`;
const doc = () => parseHTML(`<html><body><main>${[card('Chambre', 'Charleroi', 116), card('Appartement', 'Liège', 211), card('Loft', 'Liège', 291)].join('')}</main></body></html>`).document;

test('a "Ville" column picked on "Charleroi" reads only the city on every card', () => {
  const d = doc(); const t = d.querySelector('.t');
  const offset = rawText(t).indexOf('Charleroi') + 3;
  const r = pickField(t, { doc: d, fieldKey: 'ville', offset });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.sample, 'Charleroi');
  assert.deepEqual(r.part, { sep: '·', index: -1 });
  assert.equal(r.whole, 'Chambre · Charleroi');
  const name = pickField(t, { doc: d, card: r.card, fieldKey: 'name', offset });
  assert.equal(name.part, undefined, 'a name is always the whole element');
  const recipe = mergeRecipe(null, { card: r.card, fields: [{ key: 'name', selector: name.selector }, { key: 'ville', selector: r.selector, part: r.part }] });
  assert.deepEqual(readCards(d, recipe, 'https://www.rent.test/').map((x) => x.ville), ['Charleroi', 'Liège', 'Liège']);
  assert.deepEqual(readCards(d, recipe, 'https://www.rent.test/').map((x) => x.name), ['Chambre · Charleroi', 'Appartement · Liège', 'Loft · Liège']);
});

test('the price before reduction stated by the card is kept as the list price', () => {
  const html = `<script>window.S = ${JSON.stringify({ products: [
    { title: 'A', link: '/p/a', regular: { price: 599 }, discount: { price: 399 } },
    { title: 'B', link: '/p/b', prices: [{ type: 'original', value: 110 }, { type: 'sale', value: 80 }] },
    { title: 'C', link: '/p/c', regular: { price: 50 } },
  ] })};</script>`;
  const cards = extractEmbeddedProducts(html, 'https://shop.test/').cards;
  assert.deepEqual(cards.map((c) => [c.price, c.listPrice]), [[399, 599], [80, 110], [50, undefined]]);
});

test('the middle dots a site may write are one separator ("Appartement ⋅ Liège")', () => {
  const s = 'Appartement ⋅ Liège';
  assert.deepEqual(textPart(s, s.indexOf('Liège') + 1).value, 'Liège');
  assert.equal(applyPart('Chambre · Charleroi', { sep: '·', index: -1 }), 'Charleroi');
  assert.equal(applyPart('Péniche ∙ Liège', { sep: '·', index: 0 }), 'Péniche');
});

test('a card recipe without an image field takes the thumbnail next to the card (same product only)', () => {
  const tile = (i) => `<article class="mini"><div class="top"><a href="/p/${i}.html"><img data-src="/img/${i}.jpg" src="data:image/gif;base64,R0"></a></div>
    <div class="bottom"><a class="title" href="/p/${i}.html">Produit ${i}</a><span class="price">${i},00 €</span></div></article>`;
  const d = parseHTML(`<html><body><main>${[1, 2, 3].map(tile).join('')}</main></body></html>`).document;
  const rows = readCards(d, { card: '.bottom', fields: { name: { selector: 'a.title' }, url: { selector: 'a.title', attr: 'href' }, price: { selector: '.price' } } }, 'https://shop.test/');
  assert.deepEqual(rows.map((r) => r.images && r.images[0]), ['https://shop.test/img/1.jpg', 'https://shop.test/img/2.jpg', 'https://shop.test/img/3.jpg']);
});
