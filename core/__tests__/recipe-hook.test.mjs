/**
 * Engine-hook building blocks (2b): the generic embedded-state extractor now
 * covers a brico-shaped `products.collection` grid, and the recipe lane resolves
 * template variables + estimates cost (free vs paid bootstrap) BEFORE running.
 * Pure + offline (a fake httpGet serves canned pages).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEmbeddedProducts } from '../embedded-state.mjs';
import { resolveVars, estimateRecipeCost, runRecipeLane } from '../internal-api.mjs';

// Real brico shape (measured live 2026-09-19): products live under products.collection,
// price under regular:{price}, identity via ean (GTIN) + id, url via link.
const BRICO_HTML = `<!doctype html><html><body><script>window.__PRELOADED_STATE_listerFragment__=${JSON.stringify({
  products: { collection: [
    { id: '10589617', title: 'Perceuse-Visseuse Bosch EasyImpact 18V', link: '/fr/outillage/perceuse-bosch/10589617', category: { title: 'Perceuses', id: 'to0032' }, image: 'https://d2fb.net/products/10589617/origin.webp', ean: '4053423483994', regular: { price: 149 }, currency: 'EUR' },
    { id: '10466480', title: 'Visseuse Makita DF333', link: '/fr/outillage/visseuse-makita/10466480', image: 'https://d2fb.net/products/10466480/origin.webp', ean: '0088381609647', regular: { price: 89.9 }, currency: 'EUR' },
  ] },
  content: { response: { totalNumberOfResults: 508 } },
  page: { page: 1 }, viewSize: 24,
})}</script></body></html>`;

test('embedded-state: covers a brico-shaped products.collection grid (generic fix, no site rule)', () => {
  const { cards, pagination } = extractEmbeddedProducts(BRICO_HTML, 'https://www.brico.be/fr/outillage-machines-atelier/perceuses/to021/');
  assert.equal(cards.length, 2);
  const p = cards[0];
  assert.equal(p.strategy, 'embedded-state');
  assert.equal(p.name, 'Perceuse-Visseuse Bosch EasyImpact 18V');
  assert.equal(p.price, 149);                       // regular:{price} picked up
  assert.equal(p.gtin, '4053423483994');            // ean → gtin
  assert.equal(p.sku, '10589617');
  assert.equal(p.sourceUrl, 'https://www.brico.be/fr/outillage/perceuse-bosch/10589617');
  assert.equal(cards[1].price, 89.9);
  assert.ok(pagination && pagination.totalResults === 508 && pagination.pageSize === 24); // generic synonyms
});

test('resolveVars: const + url sources resolve without any network', async () => {
  const recipe = { vars: {
    placeId: { source: 'const', value: '604' },
    categoryCode: { source: 'url', pattern: '/([a-z]{2}\\d+)/?$' },
  } };
  const out = await resolveVars(recipe, 'https://www.brico.be/fr/outillage/perceuses/to021/', { httpGet: async () => { throw new Error('should not fetch'); } });
  assert.equal(out.error, null);
  assert.equal(out.vars.placeId, '604');
  assert.equal(out.vars.categoryCode, 'to021');
  assert.equal(out.needsBrowser, false);
});

test('resolveVars: category_to_id maps the URL slug through category_map (colruyt shape)', async () => {
  const recipe = {
    category_map: { boissons: '1684', 'fruits-legumes': '1639' },
    vars: { categoryId: { source: 'url', pattern: '/produits/(?:[\\w-]+/)*([\\w-]+)/?$', resolve: 'category_to_id' } },
  };
  const noFetch = { httpGet: async () => { throw new Error('should not fetch'); } };
  // Canonical nested URL: the terminal segment is the mapped slug.
  const a = await resolveVars(recipe, 'https://www.colruyt.be/fr/produits/toutes-les-categories/boissons', noFetch);
  assert.equal(a.error, null);
  assert.equal(a.vars.categoryId, '1684');
  // Deeper than the map: falls back to the NEAREST mapped ancestor (right-to-left).
  const b = await resolveVars(recipe, 'https://www.colruyt.be/fr/produits/toutes-les-categories/boissons/lait-boissons-lactee', noFetch);
  assert.equal(b.error, null);
  assert.equal(b.vars.categoryId, '1684');
  // No segment mapped at all → explicit error naming the cause, not a slug sent as an id.
  const c = await resolveVars(recipe, 'https://www.colruyt.be/fr/produits/toutes-les-categories/surgeles', noFetch);
  assert.match(c.error, /category_map/);
});

test('resolveVars: an HTTP page-var is resolved; a protected one is left pending for the browser bootstrap', async () => {
  const httpGet = async (url, { as } = {}) => (as === 'json'
    ? { status: 200, body: { category: { uuid: 'e1416a6c-386e' } } }
    : { status: 200, body: 'noise categoryId=abc123 end' });
  const recipe = { vars: {
    fromHtml: { source: 'page', pattern: 'categoryId=([a-z0-9]+)' },
    fromJson: { source: 'page', from: 'https://s/api/cat', json_path: 'category.uuid' },
    gated:    { source: 'page', json_path: 'x', needs_browser: true },
  } };
  const out = await resolveVars(recipe, 'https://s/cat', { httpGet });
  assert.equal(out.error, null);
  assert.equal(out.vars.fromHtml, 'abc123');
  assert.equal(out.vars.fromJson, 'e1416a6c-386e');
  assert.equal(out.needsBrowser, true);
  assert.deepEqual(out.pending, ['gated']);         // filled once by the browser bootstrap
});

test('estimateRecipeCost: free when no paid lane; distinguishes local vs paid bootstrap', () => {
  // brico/Colruyt-style: all vars url/const → fully free
  const free = estimateRecipeCost({ vars: { c: { source: 'url', pattern: '(x)' }, p: { source: 'const', value: '1' } } });
  assert.equal(free.free, true); assert.equal(free.bootstrap, 'none'); assert.match(free.label, /gratuit \(site connu\)/);

  // Decathlon-style, page-var needs browser but site is NOT paid-unlock → local browser, still free (0 credits)
  const local = estimateRecipeCost({ vars: { cat: { source: 'page', json_path: 'x', needs_browser: true } } }, { needsUnlock: false });
  assert.equal(local.free, true); assert.equal(local.bootstrap, 'local-browser'); assert.equal(local.bootstrapCredits, 0);

  // Same but the domain needs the PAID unlock even to bootstrap → not free, catalogue still free
  const paid = estimateRecipeCost({ vars: { cat: { source: 'page', json_path: 'x', needs_browser: true } } }, { needsUnlock: true }, 5);
  assert.equal(paid.free, false); assert.equal(paid.bootstrap, 'paid-unlock'); assert.equal(paid.bootstrapCredits, 5);
  assert.equal(paid.catalog, 'free'); assert.match(paid.label, /environ 5 crédit/);
});

test('runRecipeLane (Decathlon case): browser bootstrap ONCE, then all pages over HTTP reusing session+vars', async () => {
  const TOTAL = 5;
  const all = Array.from({ length: TOTAL }, (_, i) => ({ title: 'bike' + i, id: 'b' + i, priceInfo: { value: i } }));
  let cookieSeenOnEveryPage = true; let apiCalls = 0;
  const httpGet = async (url, { headers = {}, as } = {}) => {
    if (as === 'text' || as === 'json' && /resolver/.test(url)) return { status: 200, body: '' };
    apiCalls += 1;
    if (headers.Cookie !== 'sess=abc') cookieSeenOnEveryPage = false; // session reused on EVERY catalogue call
    const u = new URL(url); const skip = Number(u.searchParams.get('skip')); const size = Number(u.searchParams.get('size'));
    return { status: 200, body: { total: TOTAL, products: all.slice(skip, skip + size) } };
  };
  let bootstrapCalls = 0;
  const browserBootstrap = async ({ pending }) => { bootstrapCalls += 1; return { vars: { categoryId: 'uuid-1416' }, cookie: 'sess=abc' }; };
  const recipe = {
    endpoint_tpl: 'https://s/api/grid?categoryIds={categoryId}&size={size}&skip={skip}',
    pagination: { type: 'offset', param: 'skip', size_param: 'size', size: 2, total_json_path: 'total' },
    json_path: 'products',
    field_map: { name: 'title', sku: 'id', price: 'priceInfo.value' },
    vars: { categoryId: { source: 'page', json_path: 'x', needs_browser: true } },
  };
  const out = await runRecipeLane(recipe, 'https://www.decathlon.fr/velos-vtt', { httpGet, browserBootstrap });
  assert.equal(out.ok, true);
  assert.equal(out.usedBrowser, true);
  assert.equal(bootstrapCalls, 1);                 // browser used exactly ONCE
  assert.equal(out.products.length, TOTAL);        // all pages fetched over HTTP
  assert.ok(apiCalls >= 3);                         // 2+2+1 → 3 HTTP catalogue calls
  assert.equal(cookieSeenOnEveryPage, true);       // bootstrap session reused per page
  assert.equal(out.vars.categoryId, 'uuid-1416');
  assert.deepEqual(out.products[0], { strategy: 'internal-api', name: 'bike0', sku: 'b0', price: 0 });
});

test('runRecipeLane (free case): no browser when all vars resolve over HTTP/URL', async () => {
  const httpGet = async (url, { as } = {}) => (as === 'json'
    ? { status: 200, body: { total: 2, products: [{ n: 'a' }, { n: 'b' }] } }
    : { status: 200, body: '' });
  const recipe = {
    endpoint_tpl: 'https://s/api?cat={cat}&size={size}&skip={skip}',
    pagination: { type: 'offset', param: 'skip', size_param: 'size', size: 50, total_json_path: 'total' },
    json_path: 'products', field_map: { name: 'n' },
    vars: { cat: { source: 'url', pattern: '/([a-z0-9]+)$' } },
  };
  let bootstrap = 0;
  const out = await runRecipeLane(recipe, 'https://s/c/to021', { httpGet, browserBootstrap: async () => { bootstrap += 1; return {}; } });
  assert.equal(out.ok, true);
  assert.equal(out.usedBrowser, false);
  assert.equal(bootstrap, 0);                       // never touched the browser
  assert.equal(out.vars.cat, 'to021');
  assert.equal(out.products.length, 2);
});
