/**
 * The in-page card detector (_cardsInPage, run offline on a linkedom DOM) on a
 * LISTING card: the price sits 10+ levels below the card root, the card names itself
 * through aria-labelledby (no heading, hashed class names), its link is a search URL
 * pinned on the listing, and it states dates, a host type and a rating. Generic: a
 * form of markup, not a site. An e-commerce card keeps its previous result.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { _cardsInPage } from '../browser.mjs';

const PAGE_URL = 'https://stays.test/';

function withDom(html, pageUrl, imgSize, fn) {
  const { document, window } = parseHTML(html);
  window.scrollTo = () => {};
  for (const img of document.querySelectorAll('img')) img.getBoundingClientRect = () => ({ width: imgSize, height: imgSize });
  const g = globalThis;
  const prev = { document: g.document, location: g.location, window: g.window };
  g.document = document; g.location = new URL(pageUrl); g.window = window;
  try { return fn(document); } finally { g.document = prev.document; g.location = prev.location; g.window = prev.window; }
}
const runCards = (html, { imgSize = 200 } = {}) => withDom(html, PAGE_URL, imgSize, () => _cardsInPage({}));

// One card, deep: 10 wrappers between the card root and the price line.
const deep = (inner, n) => { let s = inner; for (let i = 0; i < n; i++) s = `<div class="w${i}">${s}</div>`; return s; };
const listingCard = (id, city, total, rating) => `
<div class="c1abcd atm_x" data-testid="card-container" role="group" aria-labelledby="title_${id}">
  <a href="/s/homes?pinned_listings%5B%5D=${id}&pinned_reason=HOMEPAGE" aria-label="Voir">
    <img src="https://img.stays.test/${id}.jpg" alt="">
  </a>
  ${deep(`<div id="title_${id}" class="t1xyz">Chambre · ${city}</div>
          <div class="s1"><span>23–25 oct.</span><span aria-hidden="true"> · </span><span>Particulier</span></div>
          ${deep(`<span class="p1">${total} € au total</span><span class="sr">${total} € au total</span>`, 3)}
          <span class="r1"><span class="sr">Évaluation moyenne : ${rating} sur 5</span><span aria-hidden="true">${rating}</span></span>`, 7)}
</div>`;

const ROW = `<html><body><main><section class="row"><h2>Logements · Ville</h2>
${listingCard(1001, 'Ville A', 116, '4,75')}
${listingCard(1002, 'Ville B', 104, '4,81')}
${listingCard(1003, 'Ville C', 212, '4,9')}
</section></main></body></html>`;

test('listing cards: 3 cards, named by aria-labelledby, price + basis, lines, rating — not the row container', () => {
  const cards = runCards(ROW);
  assert.equal(cards.length, 3, 'one card per listing, the row is not a card');
  const c = cards[0];
  assert.equal(c.name, 'Chambre · Ville A');
  assert.equal(c.url, 'https://stays.test/s/homes?pinned_listings%5B%5D=1001&pinned_reason=HOMEPAGE');
  assert.equal(c.priceText, '116 €');
  assert.equal(c.priceLine, '116 € au total');
  assert.equal(c.subtitle, '23–25 oct. · Particulier');
  assert.equal(c.rating, 4.75);
  assert.equal(c.image, 'https://img.stays.test/1001.jpg');
  assert.deepEqual(cards.map((x) => x.name), ['Chambre · Ville A', 'Chambre · Ville B', 'Chambre · Ville C']);
});

test('the same cards with lazy (0×0) images still come out through the price-anchored pass', () => {
  const cards = runCards(ROW, { imgSize: 0 });
  assert.equal(cards.length, 3);
  assert.equal(cards[1].name, 'Chambre · Ville B');
  assert.equal(cards[1].priceLine, '104 € au total');
  assert.equal(cards[1].rating, 4.81);
});

test('a rating with its count "4,62 (134)" and a /rooms/ link on a search card', () => {
  const html = `<html><body><div class="g">
  <div class="cx" data-testid="card-container" role="group">
    <a href="/rooms/777?adults=1"><img src="https://img.stays.test/777.jpg" alt=""></a>
    ${deep(`<div data-testid="listing-card-title">Hotel Nord</div><div data-testid="listing-card-subtitle">Hôtel · Ville</div>
            <span><span aria-hidden="true">4,62 (134)</span></span>
            ${deep('<span>802 € au total</span>', 4)}`, 6)}
  </div>
  <div class="cx" data-testid="card-container" role="group">
    <a href="/rooms/778?adults=1"><img src="https://img.stays.test/778.jpg" alt=""></a>
    ${deep(`<div data-testid="listing-card-title">Studio Sud</div><div data-testid="listing-card-subtitle">Appartement · Ville</div>
            <span><span aria-hidden="true">4,9 (12)</span></span>
            ${deep('<span>340 € au total</span>', 4)}`, 6)}
  </div>
  <div class="cx" data-testid="card-container" role="group">
    <a href="/rooms/779?adults=1"><img src="https://img.stays.test/779.jpg" alt=""></a>
    ${deep(`<div data-testid="listing-card-title">Loft Est</div><div data-testid="listing-card-subtitle">Loft · Ville</div>
            ${deep('<span>120 € par nuit</span>', 4)}`, 6)}
  </div>
  </div></body></html>`;
  const cards = runCards(html);
  assert.equal(cards.length, 3);
  assert.equal(cards[0].name, 'Hotel Nord', 'a title named by its data-testid attribute');
  assert.equal(cards[0].rating, 4.62); assert.equal(cards[0].reviewCount, 134);
  assert.equal(cards[0].subtitle, 'Hôtel · Ville');
  assert.equal(cards[2].priceLine, '120 € par nuit'); assert.equal(cards[2].rating, undefined);
});

test('e-commerce cards keep their previous result (heading name, two links, one price)', () => {
  const html = `<html><body><ul class="grid">
  <li class="product-card"><a href="/products/chaise-12345"><img src="/img/c.jpg" alt="Chaise"></a><h3><a href="/products/chaise-12345">Chaise en chêne</a></h3><a href="/brand/oakco">OakCo</a><span class="price">€ 49,95</span></li>
  <li class="product-card"><a href="/products/table-23456"><img src="/img/t.jpg" alt="Table"></a><h3><a href="/products/table-23456">Table basse</a></h3><a href="/brand/oakco">OakCo</a><span class="price">€ 89,00</span></li>
  <li class="product-card"><a href="/products/lampe-34567"><img src="/img/l.jpg" alt="Lampe"></a><h3><a href="/products/lampe-34567">Lampe</a></h3><a href="/brand/lumi">Lumi</a><span class="price">€ 19,90</span></li>
  </ul></body></html>`;
  const cards = withDom(html, 'https://shop.test/c/meubles', 200, () => _cardsInPage({}));
  assert.deepEqual(cards.map((c) => [c.name, c.priceText]), [['Chaise en chêne', '€ 49,95'], ['Table basse', '€ 89,00'], ['Lampe', '€ 19,90']]);
  assert.equal(cards[0].priceLine, undefined, 'no basis after the amount: no price line');
});
