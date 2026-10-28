/**
 * Link scoping (collection scope): S2 card clusters + S1 URL templates +
 * S4 position, learned link_filter domination, and the fail-open contract.
 * Fixtures reproduce the field-measured failure modes (mega-menu, hidden nav,
 * BEM modifiers, off-grid banner, repeated footer, PrestaShop URLs).
 * Pure + offline (linkedom).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scopeLinks, PRICE_RE } from '../link-scope.mjs';
import { PRODUCT_RE } from '../discover.mjs';

const BASE = 'https://shop.example.com/rayon/outillage';

const card = (i, cls = 'product-card') => `<div class="${cls}">
  <a class="p-link" href="/produits/article-${i}-${1000 + i}.html"><img src="/img/${i}.jpg" alt=""></a>
  <span class="p-price">${(i % 9) + 1},99 €</span>
</div>`;

const page = (body) => `<!doctype html><html><body><div class="page">${body}</div></body></html>`;

test('PRICE_RE stays in sync with recipe-producer.mjs', () => {
  const src = readFileSync(new URL('../recipe-producer.mjs', import.meta.url), 'utf8');
  const m = src.match(/^const PRICE_RE = (.+);$/m);
  assert.ok(m, 'recipe-producer.mjs declares PRICE_RE');
  assert.equal('/' + PRICE_RE.source + '/' + PRICE_RE.flags, m[1].trim());
});

test('S2: 24-card grid wins over a 100-link mega-menu (img/price constraint)', () => {
  const menu = '<div class="mega-menu">' + Array.from({ length: 100 }, (_, i) => `<a href="/c/rayon-${i}">Rayon ${i}</a>`).join('') + '</div>';
  const grid = '<div class="grid">' + Array.from({ length: 24 }, (_, i) => card(i)).join('') + '</div>';
  const s = scopeLinks(page(menu + grid), BASE);
  assert.equal(s.confident, true);
  assert.equal(s.cardCount, 24);
  assert.equal(s.urlPattern.template, '/produits/*.html');
  assert.equal(s.classify('/produits/article-3-1003.html'), 'in_grid');
  assert.equal(s.classify('/c/rayon-5'), 'other');
  assert.equal(s.stats.anchors, 124);
  assert.equal(s.stats.inGrid, 24);
  assert.equal(s.stats.offGrid, 100);
});

test('S4: hidden nav menu with imgs+prices never wins; its product-shaped links are pattern_off_grid', () => {
  // 30 nav tiles (more than the 24 cards) WITH img+price: only position excludes
  // them — linkedom computes no rects, display:none alone would not help.
  const navTiles = Array.from({ length: 30 }, (_, i) => `<div class="menu-tile">
    <a href="/produits/menu-promo-${i}-${2000 + i}.html"><img src="/m${i}.jpg"></a><span>9,99 €</span>
  </div>`).join('');
  const html = page(`<nav class="main-nav" style="display:none">${navTiles}</nav>
    <div class="grid">${Array.from({ length: 24 }, (_, i) => card(i)).join('')}</div>`);
  const s = scopeLinks(html, BASE);
  assert.equal(s.confident, true);
  assert.equal(s.cardCount, 24);
  assert.equal(s.classify('/produits/article-1-1001.html'), 'in_grid');
  assert.equal(s.classify('/produits/menu-promo-2-2002.html'), 'pattern_off_grid');
});

test('S2 signature: BEM modifiers (--with-label) do not split the cluster', () => {
  const cards = Array.from({ length: 6 }, (_, i) => card(i, i % 2 ? 'product-card product-card--with-label' : 'product-card')).join('');
  const s = scopeLinks(page(`<div class="grid">${cards}</div>`), BASE);
  assert.equal(s.confident, true);
  assert.equal(s.cardCount, 6, 'modifiers cluster with their base class');
  assert.equal(s.gridSelector, 'div.product-card');
});

test('S1: product link in an off-grid banner → pattern_off_grid', () => {
  const html = page(`<div class="hero-banner"><a href="/produits/article-99-1099.html"><img src="/b.jpg"></a></div>
    <div class="grid">${Array.from({ length: 5 }, (_, i) => card(i)).join('')}</div>`);
  const s = scopeLinks(html, BASE);
  assert.equal(s.confident, true);
  assert.equal(s.cardCount, 5);
  assert.equal(s.classify('/produits/article-99-1099.html'), 'pattern_off_grid');
});

test('footer of 37 repeated links without img/price is never elected', () => {
  const footer = '<footer>' + Array.from({ length: 37 }, (_, i) => `<a href="/aide/page-${i % 5}">Aide ${i}</a>`).join('') + '</footer>';
  const withGrid = scopeLinks(page(`<div class="grid">${Array.from({ length: 6 }, (_, i) => card(i)).join('')}</div>${footer}`), BASE);
  assert.equal(withGrid.confident, true);
  assert.equal(withGrid.cardCount, 6);
  assert.equal(withGrid.classify('/aide/page-2'), 'other');
  // footer alone: no grid → fail-open, callers keep current behaviour
  const alone = scopeLinks(page(footer), BASE);
  assert.equal(alone.confident, false);
  assert.equal(alone.classify('/aide/page-2'), 'in_grid');
});

test('PrestaShop-like /12-slug.html: in_grid via S2 without any /p/ marker (S1 confirmatory only)', () => {
  const slugs = ['nappe-coton', 'serviette-lin', 'tapis-jute', 'rideau-voile', 'coussin-velours', 'plaid-laine'];
  const cards = slugs.map((slug, i) => `<article class="product-miniature">
    <a href="/${12 + i}-${slug}.html"><img src="/i${i}.jpg"></a><span class="price">1${i},50 €</span>
  </article>`).join('');
  const s = scopeLinks(page(`<div class="products">${cards}</div>`), BASE, { productReSource: PRODUCT_RE.source });
  assert.equal(s.confident, true);
  assert.equal(s.cardCount, 6);
  assert.equal(s.urlPattern.template, '/*.html', 'slug-first templating wildcards the whole segment');
  assert.equal(s.classify('/17-plaid-laine.html'), 'in_grid');
  assert.equal(s.classify('/44-housse-couette.html'), 'pattern_off_grid');
  assert.equal(s.classify('/content/4-notre-histoire'), 'other');
});

test('shell page (<5 anchors) → confident=false, classify fail-open', () => {
  const html = page('<a href="/a">1</a><a href="/b">2</a><a href="/c">3</a><a href="/d">4</a>');
  const s = scopeLinks(html, BASE);
  assert.equal(s.confident, false);
  assert.equal(s.urlPattern, null);
  assert.equal(s.classify('/anything'), 'in_grid');
});

test('HTML > 3 MB → confident=false immediately (perf cap)', () => {
  const s = scopeLinks('x'.repeat(3.2 * 1024 * 1024), BASE);
  assert.equal(s.confident, false);
  assert.equal(s.classify('/anything'), 'in_grid');
});

test('learned link_filter: a matching container dominates the heuristics', () => {
  const learned = {
    container: '#main-grid',
    card: '.pc',
    link: { selector: 'a.title', attr: 'href' },
    url_templates: ['/produits/*.html'],
  };
  // decoy: a bigger heuristic-perfect grid the learned recipe must override
  const decoy = Array.from({ length: 6 }, (_, i) => `<div class="promo-tile">
    <a href="/fiche/xyz-${i}-${2000 + i}.html"><img src="/d${i}.jpg"></a><span>5,99 €</span>
  </div>`).join('');
  const pcs = Array.from({ length: 4 }, (_, i) => `<div class="pc">
    <a class="title" href="/produits/article-${i}-${1000 + i}.html">P${i}</a><span>2,99 €</span>
  </div>`).join('');
  const s = scopeLinks(page(`<div class="promos">${decoy}</div><div id="main-grid">${pcs}</div>`), BASE, { learned });
  assert.equal(s.confident, true);
  assert.equal(s.gridSelector, '#main-grid');
  assert.equal(s.cardCount, 4);
  assert.equal(s.classify('/produits/article-2-1002.html'), 'in_grid');
  assert.equal(s.classify('/produits/article-99-1099.html'), 'pattern_off_grid');
  assert.equal(s.classify('/fiche/xyz-1-2001.html'), 'other');
});

test('learned link_filter: dead container falls back to the heuristics (learned templates kept)', () => {
  const learned = { container: '#gone-after-redesign', url_templates: ['/produits/*.html'] };
  const s = scopeLinks(page(`<div class="grid">${Array.from({ length: 6 }, (_, i) => card(i)).join('')}</div>`), BASE, { learned });
  assert.equal(s.confident, true);
  assert.equal(s.cardCount, 6, 'heuristic grid found despite the dead container');
  assert.equal(s.urlPattern.template, '/produits/*.html');
  assert.equal(s.classify('/produits/article-1-1001.html'), 'in_grid');
});

test('learned link_filter: dead container + no heuristic grid → url_templates alone', () => {
  const learned = { container: '#gone', url_templates: ['/produits/*.html'] };
  // plain link list, no img/price anywhere: heuristics cannot find a grid
  const links = ['/produits/article-1-1001.html', '/produits/article-2-1002.html', '/produits/article-3-1003.html',
    '/aide/faq', '/blog/post-un', '/contact', '/a-propos', '/panier']
    .map((h) => `<a href="${h}">${h}</a>`).join('');
  const s = scopeLinks(page(links), BASE, { learned });
  assert.equal(s.confident, true);
  assert.equal(s.cardCount, 0);
  assert.equal(s.classify('/produits/article-2-1002.html'), 'in_grid');
  assert.equal(s.classify('/aide/faq'), 'other');
  assert.equal(s.stats.inGrid, 3);
});

test('perf: ~500 KB page scoped well under the budget', () => {
  const filler = '<p>' + 'lorem ipsum dolor sit amet consectetur '.repeat(24) + '</p>';
  const body = '<div class="mega-menu">' + Array.from({ length: 200 }, (_, i) => `<a href="/c/rayon-${i}">R${i}</a>`).join('') + '</div>'
    + '<div class="grid">' + Array.from({ length: 48 }, (_, i) => card(i)).join('') + '</div>'
    + filler.repeat(520);
  const html = page(body);
  assert.ok(html.length > 480 * 1024, `fixture is ~500 KB (${html.length} bytes)`);
  const t0 = performance.now();
  const s = scopeLinks(html, BASE);
  const ms = performance.now() - t0;
  assert.equal(s.confident, true);
  assert.equal(s.cardCount, 48);
  assert.ok(ms < 200, `scoped in ${ms.toFixed(0)} ms (< 200 ms budget)`);
});
