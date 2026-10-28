/**
 * Reading a FRAGMENTED price from the DOM (the reported Colruyt bug): euros and a
 * superscript cents with NO decimal separator ("10" + <sup>99</sup> + "/pce") must
 * read 10,99 — not 1099 from the flattened text — and a three-decimal unit price
 * ("0" + <sup>956</sup> € /pce) must read 0,956. A per-unit price shown alongside the
 * sale price (… €/l) is never taken for the selling price. Generic (sup/sub markup),
 * no site rule. Offline (linkedom).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { priceFromEl, readCards } from '../extract/card-recipe.mjs';

const el = (html) => { const { document } = parseHTML(`<!doctype html><div id="p">${html}</div>`); return document.getElementById('p'); };

test('euros + superscript cents with no separator → a decimal, not a glued integer', () => {
  assert.deepEqual(priceFromEl(el('<span>10</span><sup>99</sup><span>/pce</span>')), { price: 10.99, currency: null });
  assert.deepEqual(priceFromEl(el('<span>10</span><sup>99</sup> €/pce')), { price: 10.99, currency: 'EUR' });
  assert.deepEqual(priceFromEl(el('€<span>10</span><sup>99</sup>')), { price: 10.99, currency: 'EUR' });
});

test('a three-decimal unit price in a superscript → 0,956 (not 956)', () => {
  assert.deepEqual(priceFromEl(el('<span>0</span><sup>956</sup> €/pce')), { price: 0.956, currency: 'EUR' });
});

test('a price already written whole (with its decimal) is read as-is', () => {
  assert.deepEqual(priceFromEl(el('10,99&nbsp;€')), { price: 10.99, currency: 'EUR' });
  assert.deepEqual(priceFromEl(el('<span>649,</span><sup>99</sup>&nbsp;€')), { price: 649.99, currency: 'EUR' });
  assert.equal(priceFromEl(el('Rupture de stock')), null);
});

test('the selling price is kept apart from a per-litre price in the same element', () => {
  // "0" + <sup>75</sup> € is the sale; the "1,50 €/l" that follows is the unit price.
  assert.deepEqual(priceFromEl(el('<span>0</span><sup>75</sup> € <span>1,50 €/l</span>')), { price: 0.75, currency: 'EUR' });
});

test('readCards reads a fragmented price per card via its element, not the flattened text', () => {
  const html = `<!doctype html><html><body><main>${[1, 2, 3].map((i) => `
    <article class="card"><a class="lnk" href="/p/${i}"></a>
      <div class="name">Boisson ${i}</div>
      <div class="price"><span>${9 + i}</span><sup>${48 + i}</sup><span class="unit">/pce</span></div>
      <div class="byunit">${20 + i},9${i} €/l</div>
    </article>`).join('')}</main></body></html>`;
  const { document } = parseHTML(html);
  const recipe = { card: 'article.card', fields: {
    name: { selector: '.name' }, url: { selector: 'a.lnk', attr: 'href' }, price: { selector: '.price' },
  } };
  const rows = readCards(document, recipe, 'https://shop.test/');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.price), [10.49, 11.5, 12.51]); // 9+"49"→10.49, 10+"50"→11.50, 11+"51"→12.51
  assert.ok(rows.every((r) => r.price < 100), 'no glued "1049/pce" → 1049');
  assert.equal(rows[0].currency, undefined); // no currency symbol in the picked element → left unset
});
