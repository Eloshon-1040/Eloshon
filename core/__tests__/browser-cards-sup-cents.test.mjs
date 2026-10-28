/**
 * The in-page card detector (_cardsInPage, run offline on a linkedom DOM) on a
 * price whose cents sit apart in a superscript: "€" + "15" + <sup>99</sup>, each in
 * its own element (a grocery listing, 21/10/2026). textContent glues it into
 * "€1599" and the product left with price 1599 instead of 15.99. Generic: a form of
 * markup (fictional shop, hashed class names), not a site.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { _cardsInPage } from '../browser.mjs';
import { parseMoney } from '../dom-fallback.mjs';

const PAGE_URL = 'https://shop.test/fr/c/spirits';

function runCards(html) {
  const { document, window } = parseHTML(html);
  window.scrollTo = () => {};
  for (const img of document.querySelectorAll('img')) img.getBoundingClientRect = () => ({ width: 200, height: 200 });
  const g = globalThis;
  const prev = { document: g.document, location: g.location, window: g.window };
  g.document = document; g.location = new URL(PAGE_URL); g.window = window;
  try { return _cardsInPage({}); } finally { g.document = prev.document; g.location = prev.location; g.window = prev.window; }
}

// The price block as the listing renders it: currency, euros and cents in three
// sibling elements, the cents in <sup>, the accessible label spelled out.
const supPrice = (euros, cents) => `<div data-testid="product-block-price" aria-label="Prix: ${euros} euros et ${cents} centimes" class="x1">`
  + `<div aria-hidden="true" class="x2">€</div><div aria-hidden="true" class="x3">${euros}</div><sup aria-hidden="true" class="x4">${cents}</sup></div>`;
const card = (id, name, priceHtml) => `
<div data-testid="product-tile" class="t${id}">
  <a href="/fr/p/S${id}000"><img src="https://img.shop.test/${id}.jpg" alt="${name}"></a>
  <a href="/fr/p/S${id}000"><h3 class="n">${name}</h3></a>
  <div data-testid="product-tile-footer"><div class="f1"><div class="f2">${priceHtml}</div></div>
  <button>Ajouter</button></div>
</div>`;
const page = (cards) => `<html><body><main><ul class="grid">${cards.map((c) => `<li>${c}</li>`).join('')}</ul></main></body></html>`;

test('cents in <sup>: "€" "15" <sup>99</sup> is read as €15,99, never €1599', () => {
  const cards = runCards(page([
    card(1, 'Vodka Blanc 37,5% 70cl', supPrice(15, 99)),
    card(2, 'Vodka Rouge 18% 70cl', supPrice(14, 45)),
    card(3, 'Boisson énergisante 25cl', supPrice(1, 49)),
  ]));
  assert.equal(cards.length, 3);
  assert.deepEqual(cards.map((c) => c.priceText), ['€15,99', '€14,45', '€1,49']);
  assert.deepEqual(cards.map((c) => parseMoney(c.priceText).price), [15.99, 14.45, 1.49]);
});

test('three-digit fraction in <sup> (0 + <sup>956</sup>) keeps three decimals', () => {
  const [c] = runCards(page([card(4, 'Lait demi-écrémé 1L', supPrice(0, 956))]));
  assert.equal(c.priceText, '€0,956');
  assert.equal(parseMoney(c.priceText).price, 0.956);
});

test('a price already written with its decimals is unchanged, a footnote <sup> is not glued as cents', () => {
  const whole = `<span class="p">12,49 €</span>`;
  const note = `<span class="p">€9,99<sup>1</sup></span>`;
  const cards = runCards(page([card(5, 'Café moulu 500g', whole), card(6, 'Thé vert 20 sachets', note)]));
  assert.equal(parseMoney(cards[0].priceText).price, 12.49);
  assert.equal(parseMoney(cards[1].priceText).price, 9.99);
});
