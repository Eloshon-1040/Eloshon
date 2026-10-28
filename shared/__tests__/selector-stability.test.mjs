/**
 * Which class names a taught block may be found by: build hashes (CSS modules, CSS-in-JS), state flags and
 * React ids are never used; utility classes (Tailwind…) are left out of a product-page block selector; real
 * names (BEM, semantic) stay. Folded sections are opened by one self-contained function (app + extension).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { isUnstableClass, isUtilityClass } from '../extract/pick-selector.mjs';
import { expandFoldedSections } from '../knowledge/pick-block.mjs';
import { pageSelector } from '../knowledge/dom-locate.mjs';

test('generated and state classes are unstable; real names are not', () => {
  for (const c of ['mms-ui-cBWQP', 'brREjs', 'accordion_accordion__content__dWvE_', 'product-description_name__sg_q8', 'buy-section_buy-section___rDRL', ':r2:', 'accordion--open__jRlnP', 'css-1x2y3z', 'tab--expanded']) assert.equal(isUnstableClass(c), true, c);
  for (const c of ['card__title', 'product-title', 'pdp__price', 'brand-info__brand-name', 'variants-list', 'Title', 'ProductCard', 'price']) assert.equal(isUnstableClass(c), false, c);
});

test('utility classes describe the look, not the block', () => {
  for (const c of ['flex', 'flex-col', 'gap-0.5', 'text-body', 'tracking-wide', 'md:flex', '-mt-2', 'items-center', 'justify-between']) assert.equal(isUtilityClass(c), true, c);
  for (const c of ['items-list', 'product-text', 'brand', 'content-wrapper', 'list-items']) assert.equal(isUtilityClass(c), false, c);
});

test('a block with only utility classes is found by its stable attribute', () => {
  const doc = parseHTML('<html><body><h1 class="flex flex-col"><a class="flex flex-row"><span class="tracking-wide text-body" itemprop="name">DIOR</span></a></h1><span class="tracking-wide text-body">x</span></body></html>').document;
  assert.equal(pageSelector(doc.querySelector('[itemprop]'), doc), 'span[itemprop="name"]');
});

test('folded sections: <details> and aria toggles of the page are opened; links away, menus and filled panels are not', () => {
  const doc = parseHTML(`<html><body><details id="d"><summary>Description</summary><p>…</p></details>
    <nav><details id="n"><summary>Menu</summary></details></nav>
    <button id="t" aria-expanded="false" aria-controls="p1">Composition</button><div id="p1"></div>
    <button id="f" aria-expanded="false" aria-controls="p2">Déjà rempli</button><div id="p2">${'texte '.repeat(20)}</div>
    <a id="away" href="/autre-page" aria-expanded="false" aria-controls="p3">Ailleurs</a><div id="p3"></div></body></html>`).document;
  const clicked = [];
  for (const id of ['t', 'f', 'away']) doc.getElementById(id).click = () => clicked.push(id);
  assert.equal(expandFoldedSections(doc), 2);
  assert.equal(doc.getElementById('d').hasAttribute('open'), true);
  assert.equal(doc.getElementById('n').hasAttribute('open'), false, 'never in a menu');
  assert.deepEqual(clicked, ['t']);
});
