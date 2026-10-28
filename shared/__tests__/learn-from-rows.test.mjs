/**
 * Learn a card recipe on the page from rows read correctly from its structured
 * data, then read every card — including the ones the structured data does not
 * describe (loaded later on scroll). Measured shape: utility classes, a generated
 * class, a full-card link overlay, a promo + a regular price. Offline (linkedom).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { learnRecipeFromRows } from '../extract/learn-from-rows.mjs';
import { readCards } from '../extract/card-recipe.mjs';

const BASE = 'https://shop.test/be/fr/homme';
const card = (i) => `
  <div class="relative w-full flex flex-col gap-2 tw-${i}k9q2x">
    <a class="cursor-pointer absolute inset-0 tw-4m0ihd" href="/be/fr/pd/model-${i}/40${i}?swatch=01" aria-label="${i} Couleurs, Model ${i}, Prix, €${30 + i}.95"></a>
    <img class="w-full bg-neutral-0" src="/img/${i}.png">
    <div class="flex flex-col"><h2 class="w-full text-sm">Model ${i}</h2>
      <div class="flex-nowrap leading-tight">${i % 2 ? `<span class="whitespace-nowrap text-base">${20 + i},95 €</span><span class="line-through">${30 + i},95 €</span>` : `<span class="whitespace-nowrap text-base">${30 + i},95 €</span>`}</div>
    </div>
  </div>`;
const page = (n) => parseHTML(`<html><body><header><a href="/be/fr/homme">Homme</a></header><div class="grid">${Array.from({ length: n }, (_, i) => card(i + 1)).join('')}</div><div class="relative w-full flex flex-col gap-2"><a href="/promo">Promo</a></div></body></html>`).document;
// What the structured data said (first 4 products only): exact name, current price, link.
const structured = [1, 2, 3, 4].map((i) => ({ name: `Model ${i}`, price: i % 2 ? 20 + i + 0.95 : 30 + i + 0.95, sourceUrl: `https://shop.test/be/fr/pd/model-${i}/40${i}?swatch=01` }));

test('learned from 4 structured rows, the recipe reads all 8 cards: clean names, current (promo) prices, links', () => {
  const doc = page(8);
  const dbg = {};
  const recipe = learnRecipeFromRows(doc, structured, BASE, { debug: dbg });
  assert.ok(recipe, JSON.stringify(dbg));
  assert.ok(!/tw-/.test(JSON.stringify(recipe)), 'no generated class');
  const rows = readCards(doc, recipe, BASE);
  assert.equal(rows.length, 8);
  assert.deepEqual(rows.map((r) => r.name), Array.from({ length: 8 }, (_, i) => `Model ${i + 1}`));
  assert.equal(rows[0].price, 21.95, 'promo price, not the struck one');
  assert.equal(rows[1].price, 32.95);
  assert.equal(rows[7].sourceUrl, 'https://shop.test/be/fr/pd/model-8/408?swatch=01');
  assert.deepEqual(rows[6].images, ['https://shop.test/img/7.png']);
});

test('too few examples, or examples not found on the page → no recipe (never a guess)', () => {
  const doc = page(8);
  assert.equal(learnRecipeFromRows(doc, structured.slice(0, 2), BASE), null);
  assert.equal(learnRecipeFromRows(doc, structured.map((r) => ({ ...r, sourceUrl: r.sourceUrl.replace('/pd/', '/xx/') })), BASE), null);
});
