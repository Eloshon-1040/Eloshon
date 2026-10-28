/**
 * Recipe producer (2b, NO AI): derive a manual_selectors recipe from a listing
 * page, then replay it over HTML → products (the "understand once, replay free"
 * loop). Pure + offline (linkedom).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveSelectorRecipe, applySelectorRecipe, replaySelectorLane } from '../recipe-producer.mjs';

const card = (i, price) => `<li class="product-card mozaic">
  <a class="p-title mc-link" href="/produits/article-${i}-${100 + i}.html">Perceuse modèle ${i}</a>
  <img class="p-img" src="/img/${i}.jpg" alt="">
  <span class="p-price">${price} €</span>
</li>`;
const GRID = `<!doctype html><html><body>
  <article class="m-card-schedule"><p>Horaires magasin</p></article>
  <ul class="grid">${[1, 2, 3, 4, 5, 6].map((i) => card(i, (i + 0.49).toFixed(2).replace('.', ','))).join('')}</ul>
  <nav class="pager"><a rel="next" href="/produits/outillage/?p=2">Suivant</a></nav>
</body></html>`;
const BASE = 'https://shop.example.com/produits/outillage/';

test('deriveSelectorRecipe: finds the repeated priced card + field selectors + pagination', () => {
  const r = deriveSelectorRecipe(GRID, BASE);
  assert.ok(r, 'a recipe is derived');
  assert.equal(r.card, '.product-card.mozaic');          // full class signature of the repeated card
  assert.equal(r.fields.name.selector, '.p-title');
  assert.equal(r.fields.name.attr, null);
  assert.equal(r.fields.price.selector, '.p-price');
  assert.equal(r.fields.image.selector, 'img');
  assert.equal(r.fields.image.attr, 'src');
  assert.equal(r.fields.url.selector, '.p-title');
  assert.equal(r.fields.url.attr, 'href');
  assert.deepEqual(r.pagination, { mode: 'url-param', param: 'p', start: 1, max_pages: null });
  assert.equal(r.origin, 'auto-discovery');
});

test('applySelectorRecipe: replays the derived recipe → products (name/price/url/image), normalize-ready', () => {
  const r = deriveSelectorRecipe(GRID, BASE);
  const products = applySelectorRecipe(GRID, r, BASE);
  assert.equal(products.length, 6);
  const p = products[0];
  assert.equal(p.strategy, 'dom-selectors');
  assert.equal(p.name, 'Perceuse modèle 1');
  assert.equal(p.price, 1.49);
  assert.equal(p.sourceUrl, 'https://shop.example.com/produits/article-1-101.html');
  assert.deepEqual(p.images, ['https://shop.example.com/img/1.jpg']);
  assert.equal(products[5].price, 6.49);
});

test('deriveSelectorRecipe: no repeated priced card → null (never a wrong recipe)', () => {
  assert.equal(deriveSelectorRecipe('<html><body><h1>À propos</h1><p>Notre histoire, 0 produit.</p></body></html>', BASE), null);
  assert.equal(deriveSelectorRecipe('', BASE), null);
});

test('applySelectorRecipe: a recipe that matches nothing on a changed page → [] (caller re-discovers)', () => {
  const r = deriveSelectorRecipe(GRID, BASE);
  const changed = '<html><body><div class="new-layout"><a href="/p/9">X</a><b>9,99 €</b></div></body></html>';
  assert.deepEqual(applySelectorRecipe(changed, r, BASE), []);
});

test('replaySelectorLane: paginates by url-param, stops on the empty page (no AI, no per-product cost)', async () => {
  const recipe = deriveSelectorRecipe(GRID, BASE);
  const pageHtml = (nums) => `<html><body><ul>${nums.map((i) => card(i, '3,00')).join('')}</ul></body></html>`;
  const seenUrls = [];
  const fetchHtml = async (url) => {
    seenUrls.push(url);
    const p = Number(new URL(url).searchParams.get('p')) || 1;
    if (p === 1) return { ok: true, html: pageHtml([1, 2, 3]) };
    if (p === 2) return { ok: true, html: pageHtml([4, 5, 6]) };
    return { ok: true, html: '<html><body><ul></ul></body></html>' };   // page 3 empty → stop
  };
  const out = await replaySelectorLane(recipe, BASE, { fetchHtml });
  assert.equal(out.ok, true);
  assert.equal(out.pages, 2);
  assert.equal(out.products.length, 6);                 // 3 + 3, then stop
  assert.equal(out.products[3].name, 'Perceuse modèle 4');
  assert.equal(new URL(seenUrls[0]).searchParams.get('p'), null); // page 1 = entry URL (no param)
  assert.equal(new URL(seenUrls[1]).searchParams.get('p'), '2');  // page 2 via ?p=2
});

test('replaySelectorLane: emits a real progress step per page (found count, no simulation)', async () => {
  const recipe = deriveSelectorRecipe(GRID, BASE);
  const pageHtml = (nums) => `<html><body><ul>${nums.map((i) => card(i, '3,00')).join('')}</ul></body></html>`;
  const fetchHtml = async (url) => { const p = Number(new URL(url).searchParams.get('p')) || 1; return { ok: true, html: p <= 2 ? pageHtml([1, 2, 3]) : '<html><body><ul></ul></body></html>' }; };
  const steps = [];
  await replaySelectorLane(recipe, BASE, { fetchHtml, onStep: (m, e) => steps.push({ m, found: e.found }) });
  assert.ok(steps.length >= 1, 'a step per fetched page');
  assert.equal(steps[0].m, 'firstPage');
  assert.ok(steps[steps.length - 1].found >= 3, 'the step carries the real found count');
});

test('replaySelectorLane: stops when a page repeats page 1 (Skyvern duplicate-first rule)', async () => {
  const recipe = deriveSelectorRecipe(GRID, BASE);
  const page1 = `<html><body><ul>${[1, 2, 3].map((i) => card(i, '3,00')).join('')}</ul></body></html>`;
  const fetchHtml = async () => ({ ok: true, html: page1 });     // every page identical to page 1
  const out = await replaySelectorLane(recipe, BASE, { fetchHtml, maxPages: 20 });
  assert.equal(out.products.length, 3);                 // page 1 only; page 2 detected as a repeat
  assert.ok(out.pages <= 2);
});

test('replaySelectorLane: a fully blocked fetch → ok:false (caller falls back / re-discovers)', async () => {
  const recipe = deriveSelectorRecipe(GRID, BASE);
  const out = await replaySelectorLane(recipe, BASE, { fetchHtml: async () => ({ ok: false, status: 403 }) });
  assert.equal(out.ok, false);
  assert.equal(out.products.length, 0);
});

test('deriveSelectorRecipe: load-more pagination is detected', () => {
  const html = `<html><body><ul>${[1, 2, 3].map((i) => card(i, '2,00')).join('')}</ul>
    <button class="more">Voir plus de produits</button></body></html>`;
  const r = deriveSelectorRecipe(html, BASE);
  assert.ok(r);
  assert.equal(r.pagination.mode, 'load-more');
});

test('derived recipe never relies on generated class names (they change with every build of the site)', async () => {
  const { deriveSelectorRecipe, applySelectorRecipe } = await import('../recipe-producer.mjs');
  const card = (i, hash) => `<div class="relative w-full flex flex-col gap-2 ${hash}-c${i % 2}x9q"><a class="${hash}-4m0ihd" href="/pd/model-${i}/40${i}">Model ${i}</a><span class="whitespace-nowrap">${30 + i},99 €</span><img src="/i/${i}.jpg"></div>`;
  const build1 = `<html><body><main>${[1, 2, 3, 4].map((i) => card(i, 'tw')).join('')}</main></body></html>`;
  const r = deriveSelectorRecipe(build1, 'https://shop.test/homme');
  assert.ok(r, 'a recipe is derived');
  assert.ok(!/tw-/.test(JSON.stringify(r)), `no generated class in ${JSON.stringify(r)}`);
  // The site's next build regenerates the hashes: the recipe still reads every card.
  const build2 = build1.replace(/tw-/g, 'qz-').replace(/4m0ihd/g, '7k2pqa');
  const rows = applySelectorRecipe(build2, r, 'https://shop.test/homme');
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((x) => x.name), ['Model 1', 'Model 2', 'Model 3', 'Model 4']);
  assert.equal(rows[0].price, 31.99);
  assert.equal(rows[2].sourceUrl, 'https://shop.test/pd/model-3/403');
});

test('selectorRowsHealth: rows without name / price beyond the quality limits → not healthy', async () => {
  const { selectorRowsHealth } = await import('../recipe-producer.mjs');
  const ok = Array.from({ length: 10 }, (_, i) => ({ name: `P${i}`, price: 10 }));
  assert.equal(selectorRowsHealth(ok).ok, true);
  const noNames = ok.map((r) => ({ ...r, name: '' }));
  assert.deepEqual(selectorRowsHealth(noNames), { ok: false, emptyNameRatio: 1, emptyPriceRatio: 0 });
  const fewPrices = ok.map((r, i) => (i < 7 ? { name: r.name } : r));
  assert.equal(selectorRowsHealth(fewPrices, { maxEmptyNameRatio: 0.3, maxEmptyPriceRatio: 0.6 }).ok, false);
  assert.equal(selectorRowsHealth([]).ok, false);
});
