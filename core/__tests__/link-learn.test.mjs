/**
 * Click-to-learn (link_filter producer): one captured user click → a validated
 * link_filter recipe, or null — never a wrong recipe. Pure + offline (linkedom).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveLinkFilter, learnFromClick, recognizedCount } from '../link-learn.mjs';
import { deriveSelectorRecipe } from '../recipe-producer.mjs';

const PAGE = 'https://www.shop-example.be/p/fr-BE/electromenager';

// Lidl-like grid: 6 cards under a named container, product URLs `/p/<locale>/<slug>/p<id>`.
const gridCard = (i, extra = '') => `<article class="product-card${extra}">
  <a class="product-card__link" href="/p/fr-BE/produit-${i}/p1001234${i}">
    <img src="/im/${i}.jpg" alt="">
    <h3 class="product-card__title">Produit ${i}</h3>
  </a>
  <span class="price">1${i},99 €</span>
</article>`;
const GRID = `<!doctype html><html><body>
  <header><nav class="main-nav"><a href="/fr-BE/aide">Aide</a><a href="/fr-BE/magasins">Magasins</a></nav></header>
  <section class="product-grid">${[1, 2, 3, 4, 5, 6].map((i) => gridCard(i, i === 2 ? ' is-sponsored' : '')).join('')}</section>
  <footer><a href="/fr-BE/mentions">Mentions légales</a></footer>
</body></html>`;
const CLICK = {
  role: 'product-link',
  pageUrl: PAGE,
  href: '/p/fr-BE/produit-2/p10012342',
  anchorPath: [{ tag: 'a', classes: ['product-card__link'] }, { tag: 'article', classes: ['product-card', 'is-sponsored'] }, { tag: 'section', classes: ['product-grid'] }, { tag: 'body', classes: [] }],
  domSnapshot: GRID,
};

test('deriveLinkFilter: lidl-like grid click → full validated recipe (container + card + template)', () => {
  const r = deriveLinkFilter(CLICK);
  assert.ok(r, 'a recipe is derived');
  assert.equal(r.container, 'section.product-grid');
  assert.equal(r.card, 'article.product-card');          // is-sponsored modifier filtered out
  assert.deepEqual(r.link, { selector: 'a', attr: 'href' });
  assert.equal(r.url_templates.length, 1);
  const re = new RegExp(r.url_templates[0]);
  assert.ok(re.test('/p/fr-BE/produit-2/p10012342'), 'matches the clicked URL');
  assert.ok(re.test('/p/nl-BE/autre-produit/p10099999'), 'generalises slug + id + locale');
  assert.ok(!re.test('/fr-BE/aide'), 'nav URL does not match');
  assert.ok(!re.test('/p/fr-BE/categorie/aspirateurs'), 'a category URL (no trailing id) does not match');
  assert.equal(r.origin, 'manual');
  assert.equal(r.sample_url, 'https://www.shop-example.be/p/fr-BE/produit-2/p10012342');
  assert.ok(!Number.isNaN(Date.parse(r.learned_at)), 'learned_at is a parseable timestamp');
  assert.equal(r.pagination, undefined);                 // no pagination click captured
  assert.equal(r.consent, undefined);
});

test('deriveLinkFilter: stable data-* signature wins over generated classes', () => {
  const card = (i) => `<article data-testid="product-tile" class="c-x9${i}">
    <a href="/produits/article-${i}-${100 + i}.html"><img src="/i/${i}.jpg"></a><b>${i},99 €</b>
  </article>`;
  const html = `<html><body><div class="grid">${[1, 2, 3, 4].map(card).join('')}</div></body></html>`;
  const r = deriveLinkFilter({ pageUrl: 'https://shop.example.com/produits/', href: '/produits/article-1-101.html', domSnapshot: html });
  assert.ok(r);
  assert.equal(r.card, 'article[data-testid="product-tile"]');
  assert.equal(r.container, 'div.grid');
});

test('deriveLinkFilter: banner click (no ≥3 same-signature brothers) → degraded url-only recipe', () => {
  const html = `<html><body>
    <header><nav><a href="/fr/aide">Aide</a><a href="/">Accueil</a></nav></header>
    <div class="hero"><a href="/produits/promo-ete-123.html"><img src="/i/banner.jpg"></a></div>
    <main>
      <p>Coup de coeur : <a href="/produits/perceuse-456.html">Perceuse</a></p>
      <div class="push"><a href="/produits/scie-789.html">Scie</a></div>
      <span><a href="/produits/rabot-321.html">Rabot</a></span>
    </main>
    <footer><a href="/mentions-legales">Mentions</a></footer>
  </body></html>`;
  const r = deriveLinkFilter({ pageUrl: 'https://shop.example.com/', href: '/produits/promo-ete-123.html', domSnapshot: html });
  assert.ok(r, 'url templates alone still validate (3 scattered product links, none in nav)');
  assert.equal(r.container, null);
  assert.equal(r.card, null);
  assert.ok(new RegExp(r.url_templates[0]).test('/produits/perceuse-456.html'));
});

test('deriveLinkFilter: banner whose template also matches nav links → null (free negatives)', () => {
  const html = `<html><body>
    <header><nav><a href="/produits/carte-cadeau-999.html">Carte cadeau</a></nav></header>
    <div class="hero"><a href="/produits/promo-ete-123.html"><img src="/i/banner.jpg"></a></div>
    <main>
      <a href="/produits/perceuse-456.html">Perceuse</a>
      <a href="/produits/scie-789.html">Scie</a>
    </main>
  </body></html>`;
  const r = deriveLinkFilter({ pageUrl: 'https://shop.example.com/', href: '/produits/promo-ete-123.html', domSnapshot: html });
  assert.equal(r, null);
});

test('deriveLinkFilter: card selector that would also select in the footer → null', () => {
  // Cards sit under a bare <main> (no class/id) → no nameable container → the
  // card selector applies document-wide and catches the footer widget too.
  const card = (i) => `<article class="product-card">
    <a href="/p/item-${i}/p900${i}"><img src="/i/${i}.jpg">Produit ${i}</a><b>${i},99 €</b>
  </article>`;
  const html = `<html><body>
    <main>${[1, 2, 3].map(card).join('')}</main>
    <footer><article class="product-card"><a href="/p/vu-recemment/p9999"><img src="/i/f.jpg">Vu récemment</a><b>9,99 €</b></article></footer>
  </body></html>`;
  const r = deriveLinkFilter({ pageUrl: 'https://shop.example.com/rayon', href: '/p/item-1/p9001', domSnapshot: html });
  assert.equal(r, null);
});

test('deriveLinkFilter: pagination + consent clicks in the same capture → same vocabulary as derivePagination', () => {
  const urlParam = deriveLinkFilter({ ...CLICK, pagination: { href: '/p/fr-BE/electromenager?page=2', anchorPath: [{ tag: 'a', classes: ['pagination__next'] }] } });
  assert.deepEqual(urlParam.pagination, { mode: 'url-param', param: 'page', start: 1, max_pages: null });

  const nextLink = deriveLinkFilter({ ...CLICK, pagination: { href: '/p/fr-BE/electromenager/page-suivante', anchorPath: [{ tag: 'a', classes: ['pagination__next'] }] } });
  assert.deepEqual(nextLink.pagination, { mode: 'next-link', selector: 'a.pagination__next', max_pages: null });

  const loadMore = deriveLinkFilter({ ...CLICK, pagination: { anchorPath: [{ tag: 'button', classes: ['load-more'] }] } });
  assert.deepEqual(loadMore.pagination, { mode: 'load-more', selector: 'button.load-more', max_pages: null });

  const consent = deriveLinkFilter({ ...CLICK, consent: { anchorPath: [{ tag: 'button', id: 'onetrust-accept-btn-handler', classes: [] }] } });
  assert.deepEqual(consent.consent, { selector: '#onetrust-accept-btn-handler', action: 'click' });
});

test('deriveLinkFilter: url_templates survive a JSON round-trip (jsonb storage, backslashes intact)', () => {
  const r = deriveLinkFilter(CLICK);
  const rt = JSON.parse(JSON.stringify(r));
  assert.equal(rt.url_templates[0], r.url_templates[0]);
  assert.ok(rt.url_templates[0].includes('\\d'), 'the \\d stays a two-char source token, not an escape casualty');
  assert.ok(new RegExp(rt.url_templates[0]).test('/p/fr-BE/produit-2/p10012342'), 'rebuilt regex still matches');
});

test('deriveLinkFilter: bad or non-product captures → null, never a guessed recipe', () => {
  assert.equal(deriveLinkFilter(null), null);
  assert.equal(deriveLinkFilter({ pageUrl: PAGE, href: '/p/x/p1' }), null);                        // no snapshot
  assert.equal(deriveLinkFilter({ ...CLICK, role: 'pagination' }), null);                          // not a product click
  assert.equal(deriveLinkFilter({ ...CLICK, href: '/p/fr-BE/absent/p777' }), null);                // click not in snapshot
  assert.equal(deriveLinkFilter({ ...CLICK, domSnapshot: '<html><body><p>vide</p></body></html>' }), null);
});

test('learnFromClick: a failing deriveSelectorRecipe never blocks the link_filter (and vice versa)', () => {
  const boom = learnFromClick(CLICK, { deriveSelectorRecipe: () => { throw new Error('boom'); } });
  assert.ok(boom.linkFilter, 'link_filter still derived');
  assert.equal(boom.manualSelectors, null);

  const calls = [];
  const ok = learnFromClick(CLICK, { deriveSelectorRecipe: (...a) => { calls.push(a); return { card: '.x', fields: {} }; } });
  assert.deepEqual(ok.manualSelectors, { card: '.x', fields: {} });
  assert.deepEqual(calls[0], [GRID, PAGE, 'manual'], 'replayed over the same snapshot, origin manual');

  const noProducts = learnFromClick({ ...CLICK, domSnapshot: '<html><body><p>vide</p></body></html>' }, { deriveSelectorRecipe: () => ({ card: '.y', fields: {} }) });
  assert.equal(noProducts.linkFilter, null);
  assert.deepEqual(noProducts.manualSelectors, { card: '.y', fields: {} }, 'manual_selectors attempt is independent');
});

test('learnFromClick: no injected producer → manualSelectors null, linkFilter untouched', () => {
  const out = learnFromClick(CLICK);
  assert.ok(out.linkFilter);
  assert.equal(out.manualSelectors, null);
});

test('learnFromClick: one click = BOTH recipes with the REAL recipe-producer injected', () => {
  const out = learnFromClick(CLICK, { deriveSelectorRecipe });
  assert.ok(out.linkFilter, 'link_filter recipe');
  assert.ok(out.manualSelectors, 'manual_selectors recipe from the same snapshot');
  assert.equal(out.manualSelectors.origin, 'manual');
  assert.ok(out.manualSelectors.fields.price, 'the producer found the repeated priced card');
});

test('recognizedCount: counts the distinct product links the recipe selects on the snapshot', () => {
  const recipe = deriveLinkFilter(CLICK);
  assert.equal(recognizedCount(CLICK, recipe), 6, 'the six grid cards are recognised');            // matches the feedback count
  assert.equal(recognizedCount(CLICK, null), 0, 'no recipe → 0, never throws');
  assert.equal(recognizedCount({ ...CLICK, domSnapshot: '<' }, recipe), 0, 'unparseable snapshot → 0');
  assert.equal(recognizedCount(null, recipe), 0);
});
