/**
 * Side-panel issues seen on a real listing (brico-like markup, generic):
 *  - a price split over two elements ("649," + <sup>99</sup>) is picked WHOLE, never
 *    beyond the element that also holds the struck price;
 *  - a designated price without a currency ("649,99", "399,-", "29€20") is read;
 *  - "Détail de produit" / "Fiche technique" mean a description, not the name;
 *  - the AI gets the page-state product list, not a menu or a breadcrumb.
 * Offline (linkedom).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { pickField, wholeAmountElement, chooseFromStack } from '../extract/pick-selector.mjs';
import { readCards } from '../extract/card-recipe.mjs';
import { designatedPrice } from '../extract/money.mjs';
import { fieldMeaning } from '../extract/field-meaning.mjs';
import { embeddedJsonValues } from '../extract/embedded-state.mjs';
import { productArraySources } from '../extract/ai-assist.mjs';

const card = (i, was, now) => `
  <div data-class="product-card" class="lstr-1emyjpm"><a href="/fr/jardin/salon-${i}/${10141429 + i}">
    <p class="title">Salon ${i}</p><span class="reviews">(9${i})</span>
    <div class="prices"><del><p class="old">${was[0]}</p><sup>${was[1]}</sup></del><ins><p class="now">${now[0]}</p><sup class="cents">${now[1]}</sup></ins></div>
  </a></div>`;
const doc = () => parseHTML(`<html><body><main>${[
  card(1, ['799,', '99'], ['649,', '99']), card(2, ['599,', '-'], ['399,', '-']), card(3, ['299,', '-'], ['249,', '-']),
].join('')}</main></body></html>`).document;

test('a split price is picked whole: "649," or "99" → the <ins> holding 649,99, not the block with the old price', () => {
  const d = doc();
  const euros = d.querySelector('p.now'); const cents = d.querySelector('sup.cents');
  assert.equal(wholeAmountElement(euros).tagName, 'INS');
  assert.equal(wholeAmountElement(cents).tagName, 'INS');
  assert.equal(chooseFromStack([cents, cents.parentElement, d.querySelector('.prices')], 'price').tagName, 'INS');
  const r = pickField(cents, { doc: d, fieldKey: 'price' });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.sample, '649,99');
  assert.equal(pickField(d.querySelectorAll('p.now')[1], { doc: d, fieldKey: 'price' }).sample, '399,-', 'a whole-euro price is picked with its ",-"');
  const n = pickField(d.querySelector('p.title'), { doc: d, card: r.card, fieldKey: 'name' });
  const rows = readCards(d, { card: r.card, fields: { name: { selector: n.selector }, price: { selector: r.selector } } }, 'https://www.shop.test/fr/jardin/');
  assert.deepEqual(rows.map((x) => x.price), [649.99, 399, 249]);
});

test('a name or a review count is never climbed', () => {
  const d = doc();
  const name = d.querySelector('p.title');
  assert.equal(chooseFromStack([name], 'name'), name);
  const reviews = d.querySelector('.reviews');
  assert.equal(wholeAmountElement(reviews), reviews, 'its parent holds other amounts');
});

test('designated price text', () => {
  assert.deepEqual(designatedPrice('649,99'), { price: 649.99, currency: null });
  assert.deepEqual(designatedPrice('399,-'), { price: 399, currency: null });
  assert.deepEqual(designatedPrice('29€20'), { price: 29.2, currency: 'EUR' });
  assert.deepEqual(designatedPrice('12,50 €'), { price: 12.5, currency: 'EUR' });
  assert.equal(designatedPrice('Voir le produit'), null);
});

test('field names: a detail is a description, a technical sheet is technical specifications (its own field)', () => {
  assert.equal(fieldMeaning({ label: 'Détail de produit' }), 'description');
  assert.equal(fieldMeaning({ label: 'Fiche technique' }), 'technical_specs');
  assert.equal(fieldMeaning({ label: 'Caractéristiques techniques' }), 'technical_specs');
  assert.equal(fieldMeaning({ label: 'Description' }), 'description');
  assert.equal(fieldMeaning({ label: 'Lien de la fiche' }), 'url');
  assert.equal(fieldMeaning({ label: 'Nom du produit' }), 'name');
});

test('AI input: the product list of the page state, not its menu or breadcrumb', () => {
  const menu = { items: Array.from({ length: 30 }, (_, i) => ({ title: `Rayon ${i}`, icon_url: `https://cdn.test/products/${i}/origin.webp`, items: [{ title: `Sous ${i}` }] })) };
  const products = Array.from({ length: 5 }, (_, i) => ({ id: String(100 + i), title: `Salon ${i}`, link: `/fr/salon-${i}/${100 + i}`, image: `https://cdn.test/p/${i}.webp`, regular: { price: 599 }, discount: { price: 399 } }));
  const html = `<script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[{"name":"A"},{"name":"B"}]}</script>
    <script>window.__LAYOUT__ = ${JSON.stringify(menu)};</script>
    <script>window.__STATE__ = ${JSON.stringify({ products: { quantity: 3788, collection: products } })};</script>`;
  const sources = productArraySources(embeddedJsonValues(html));
  assert.ok(sources.length >= 1);
  const first = JSON.parse(sources[0]);
  assert.equal(first.length, 5);
  assert.equal(first[0].title, 'Salon 0');
  assert.ok(!sources.some((s) => s.includes('Rayon 0')), 'the menu is not sent');
});
