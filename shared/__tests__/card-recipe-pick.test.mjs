/**
 * Panel extraction building blocks (shared by the extension's in-page runner):
 *  - readCards: a learned card recipe read on a DOM → raw product rows;
 *  - mergeRecipe: the user's designated fields override the stored recipe;
 *  - pickField: ONE clicked element → the repeated card + a selector relative to
 *    it (+ attribute), which then reads that field on EVERY card.
 * Offline (linkedom), generic markup, no site rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { readCards, rowKey, mergeRecipe } from '../extract/card-recipe.mjs';
import { pickField, deriveCardSelector, relativeSelector, stableClasses } from '../extract/pick-selector.mjs';

const BASE = 'https://shop.test/sale';
const card = (i) => `
  <div class="product-card css-8f3k2a">
    <div class="product-card__body">
      <a class="product-card__link" href="/t/model-${i}/AB${1000 + i}"></a>
      <img class="product-card__img" src="data:image/gif;base64,R0" data-src="/img/${i}.jpg" alt="Model ${i}">
      <div class="product-card__info">
        <div class="product-card__title">Model ${i}</div>
        <div class="product-price">
          <span class="product-price__current">${50 + i},99&nbsp;€</span>
          <span class="product-price__striked">${80 + i},99&nbsp;€</span>
        </div>
      </div>
    </div>
  </div>`;
const page = () => parseHTML(`<html><body><header><a href="/">Home</a></header><main class="grid">${[1, 2, 3, 4].map(card).join('')}</main><footer><a href="/help">Help</a></footer></body></html>`).document;

const recipe = { card: '.product-card__body', fields: {
  name: { selector: '.product-card__title', attr: null },
  price: { selector: '.product-price__current', attr: null },
  url: { selector: '.product-card__link', attr: 'href' },
  image: { selector: 'img', attr: 'src' },
} };

test('readCards: every card → name, parsed price, absolute URL, real image (lazy placeholder skipped)', () => {
  const rows = readCards(page(), recipe, BASE);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0].name, 'Model 1');
  assert.equal(rows[0].price, 51.99); assert.equal(rows[0].currency, 'EUR');
  assert.equal(rows[0].sourceUrl, 'https://shop.test/t/model-1/AB1001');
  assert.deepEqual(rows[0].images, ['https://shop.test/img/1.jpg']);
  assert.equal(new Set(rows.map(rowKey)).size, 4);
});

test('a user-added field (e.g. the struck price) is kept as text; mergeRecipe lets the user field win', () => {
  const merged = mergeRecipe(recipe, { card: null, fields: [{ key: 'reduction', selector: '.product-price__striked', attr: null }, { key: 'name', selector: '.product-card__title' }] });
  assert.equal(merged.card, '.product-card__body');
  const rows = readCards(page(), merged, BASE);
  assert.equal(rows[2].reduction, '83,99 €');
  assert.equal(rows[2].price, 53.99);
  // A different user card makes the stored fields (relative to another card) unusable.
  const other = mergeRecipe(recipe, { card: '.product-card', fields: [{ key: 'name', selector: '.product-card__title' }] });
  assert.deepEqual(Object.keys(other.fields), ['name']);
  assert.equal(mergeRecipe(null, { card: null, fields: [] }), null);
});

test('pickField: clicking the struck price of card 3 → the repeated card + a relative selector that reads it on every card', () => {
  const doc = page();
  const el = doc.querySelectorAll('.product-price__striked')[2];
  const r = pickField(el, { doc, fieldKey: 'reduction' });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.cards, 4);
  assert.equal(r.attr, null);
  assert.equal(r.sample, '83,99 €');
  const rows = readCards(doc, { card: r.card, fields: { reduction: { selector: r.selector, attr: r.attr }, name: { selector: '.product-card__title' } } }, BASE);
  assert.deepEqual(rows.map((x) => x.reduction), ['81,99 €', '82,99 €', '83,99 €', '84,99 €']);
});

test('pickField with a KNOWN card keeps it; "url" reads the link href, "image" the image source', () => {
  const doc = page();
  const title = doc.querySelectorAll('.product-card__title')[0];
  const u = pickField(doc.querySelector('.product-card__link'), { doc, card: '.product-card__body', fieldKey: 'url' });
  assert.equal(u.card, '.product-card__body'); assert.equal(u.attr, 'href');
  const im = pickField(doc.querySelector('img'), { doc, card: '.product-card__body', fieldKey: 'image' });
  assert.equal(im.attr, 'data-src');
  const rows = readCards(doc, { card: u.card, fields: { url: { selector: u.selector, attr: u.attr }, image: { selector: im.selector, attr: im.attr }, name: { selector: relativeSelector(title.closest('.product-card__body'), title) } } }, BASE);
  assert.equal(rows[3].sourceUrl, 'https://shop.test/t/model-4/AB1004');
  assert.deepEqual(rows[3].images, ['https://shop.test/img/4.jpg']);
});

test('a lone element (header link) is not a repeated card → a clear refusal, never a wrong recipe', () => {
  const doc = page();
  const r = pickField(doc.querySelector('header a'), { doc, fieldKey: 'name' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /liste répétée/);
});

test('unstable class names (CSS-in-JS hashes, state flags) are never used in a selector', () => {
  const doc = page();
  assert.deepEqual(stableClasses(doc.querySelector('.product-card')), ['product-card']);
  assert.equal(deriveCardSelector(doc.querySelector('.product-price__current'), doc), 'div.product-card');
});

test('positional fallback when nothing distinguishes the element inside its card', () => {
  const { document: doc } = parseHTML('<html><body>' + [1, 2, 3].map((i) => `<li class="item"><a href="/p/${i}">P${i}</a><span>${i}0 €</span><span>EAN ${i}</span></li>`).join('') + '</body></html>');
  const r = pickField(doc.querySelectorAll('li.item span')[5], { doc, fieldKey: 'ean' });
  assert.equal(r.ok, true, r.reason);
  const rows = readCards(doc, { card: r.card, fields: { ean: { selector: r.selector }, url: { selector: 'a', attr: 'href' } } }, BASE);
  assert.deepEqual(rows.map((x) => x.gtin), ['EAN 1', 'EAN 2', 'EAN 3']);
});

test('chooseFromStack: under a full-card link overlay, a text field gets the smallest element with its own text; url gets the link; image the image', async () => {
  const { chooseFromStack } = await import('../extract/pick-selector.mjs');
  const { document: doc } = parseHTML('<html><body><div class="c"><a class="overlay" href="/p/1">Model 1</a><img src="/1.jpg"><div class="info"><span class="price">99,99 €</span></div></div></body></html>');
  const size = { overlay: 300 * 400, price: 60 * 20, info: 300 * 60, c: 300 * 400, img: 300 * 300 };
  for (const [cls, a] of Object.entries(size)) { const el = cls === 'img' ? doc.querySelector('img') : doc.querySelector('.' + cls); el.getBoundingClientRect = () => ({ width: Math.sqrt(a), height: Math.sqrt(a) }); }
  const stack = [doc.querySelector('.overlay'), doc.querySelector('.price'), doc.querySelector('.info'), doc.querySelector('img'), doc.querySelector('.c'), doc.body];
  assert.equal(chooseFromStack(stack, 'reduction').className, 'price');
  assert.equal(chooseFromStack(stack, 'url').tagName, 'A');
  assert.equal(chooseFromStack(stack, 'image').tagName, 'IMG');
});
