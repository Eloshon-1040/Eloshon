/**
 * Generic listing pagination (chantier 2). Hand-built pages, fake fetchers — no
 * network. Each test pins one signal or one stop rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginateListing, detectPagination, declaredHosts, findJsonPagination } from '../listing-pagination.mjs';

const BASE = 'https://shop.test/c/shoes';
const card = (i) => `<div class="pc"><a class="t" href="/p/item-${i}">Item ${i}</a><span class="pr">${i},00 €</span></div>`;
const grid = (ids, extra = '') => `<html><head>${extra}</head><body>${ids.map(card).join('')}</body></html>`;
const extractCards = (html, url) => [...String(html).matchAll(/href="\/p\/item-(\d+)">Item \d+<\/a><span class="pr">([\d,]+)/g)].map((m) => ({ name: `Item ${m[1]}`, price: Number(m[2].replace(',', '.')), sourceUrl: new URL(`/p/item-${m[1]}`, url).toString() }));
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const run = (pages, first, o = {}) => {
  const calls = [];
  return { calls, p: paginateListing({ entryUrl: o.entryUrl || BASE, firstHtml: first, firstCards: extractCards(first, o.entryUrl || BASE), extractCards, fetchHtml: async (u) => { calls.push(u); return pages[u] ? { ok: true, html: pages[u] } : { ok: false, status: 404 }; }, maxProducts: o.maxProducts ?? 1000, maxPages: o.maxPages ?? 50, fetchJson: o.fetchJson, extractJsonCards: o.extractJsonCards }) };
};

test('rel="next": follows <link rel=next> page by page until the last page has none', async () => {
  const p1 = grid(range(1, 3), `<link rel="next" href="${BASE}?page=2">`);
  const pages = { [`${BASE}?page=2`]: grid(range(4, 6), `<link rel="next" href="${BASE}?page=3">`), [`${BASE}?page=3`]: grid(range(7, 8)) };
  const { p, calls } = run(pages, p1);
  const r = await p;
  assert.equal(r.mechanism, 'rel-next'); assert.equal(r.pages, 3); assert.equal(r.cards.length, 8); assert.equal(r.stoppedBy, 'no_next');
  assert.deepEqual(calls, [`${BASE}?page=2`, `${BASE}?page=3`]);
  assert.deepEqual(r.memo, { mode: 'rel-next' });
});

test('"next" link text (no rel): suivant / next anchors are followed', async () => {
  const p1 = grid(range(1, 2)) .replace('</body>', `<nav><a href="${BASE}?pg=2">Suivant</a></nav></body>`);
  const r = await run({ [`${BASE}?pg=2`]: grid(range(3, 4)) }, p1).p;
  assert.equal(r.mechanism, 'next-link'); assert.equal(r.cards.length, 4);
});

test('observed page parameter: links ?page=2 on the same path → page param incremented, validated by new content', async () => {
  const p1 = grid(range(1, 3)).replace('</body>', `<a href="/c/shoes?page=2">2</a><a href="/c/shoes?page=3">3</a></body>`);
  const pages = { [`${BASE}?page=2`]: grid(range(4, 6)), [`${BASE}?page=3`]: grid(range(7, 9)), [`${BASE}?page=4`]: grid([]) };
  const r = await run(pages, p1).p;
  assert.equal(r.mechanism, 'url-param'); assert.equal(r.cards.length, 9);
  assert.deepEqual(r.memo, { mode: 'url-param', param: 'page', kind: 'page' });
  assert.equal(r.stoppedBy, 'no_new_products', 'an empty page 4 ends it');
});

test('loop: a site that ignores the page parameter (page 2 = page 1) stops at once', async () => {
  const p1 = grid(range(1, 3)).replace('</body>', '<a href="/c/shoes?page=2">2</a></body>');
  const r = await run({ [`${BASE}?page=2`]: grid(range(1, 3)) }, p1).p;
  assert.equal(r.stoppedBy, 'loop'); assert.equal(r.cards.length, 3); assert.equal(r.pages, 1);
});

test('loop: a rel=next pointing back to an already-read URL stops', async () => {
  const p1 = grid(range(1, 2), `<link rel="next" href="${BASE}?page=2">`);
  const r = await run({ [`${BASE}?page=2`]: grid(range(3, 4), `<link rel="next" href="${BASE}">`) }, p1).p;
  assert.equal(r.stoppedBy, 'loop'); assert.equal(r.cards.length, 4);
});

test('no new products: a page made only of already-seen products stops; products are deduplicated across pages', async () => {
  const p1 = grid(range(1, 3), `<link rel="next" href="${BASE}?page=2">`);
  const pages = { [`${BASE}?page=2`]: grid([3, 4, 5], `<link rel="next" href="${BASE}?page=3">`), [`${BASE}?page=3`]: grid([4, 5, 1], `<link rel="next" href="${BASE}?page=4">`) };
  const r = await run(pages, p1).p;
  assert.equal(r.cards.length, 5, 'item 3 counted once'); assert.equal(r.stoppedBy, 'no_new_products');
});

test('max products: stops at the user cap, without reading further pages', async () => {
  const p1 = grid(range(1, 3), `<link rel="next" href="${BASE}?page=2">`);
  const pages = { [`${BASE}?page=2`]: grid(range(4, 6), `<link rel="next" href="${BASE}?page=3">`), [`${BASE}?page=3`]: grid(range(7, 9)) };
  const { p, calls } = run(pages, p1, { maxProducts: 5 });
  const r = await p;
  assert.equal(r.cards.length, 5); assert.equal(r.stoppedBy, 'max_products'); assert.equal(calls.length, 1);
});

test('max pages: stops at the page cap', async () => {
  const pages = {}; for (let n = 2; n <= 10; n++) pages[`${BASE}?page=${n}`] = grid([n * 10, n * 10 + 1], `<link rel="next" href="${BASE}?page=${n + 1}">`);
  const r = await run(pages, grid([1, 2], `<link rel="next" href="${BASE}?page=2">`), { maxPages: 4 }).p;
  assert.equal(r.pages, 4); assert.equal(r.stoppedBy, 'max_pages');
});

const API_PAGE = (ids, next, total) => ({ data: { products: ids.map((i) => ({ name: `Item ${i}`, price: i, url: `https://shop.test/p/item-${i}` })), pages: { next, totalResources: total } } });
const stateHtml = (ids, next, total, hosts = '') => `<html><head>${hosts}</head><body>${ids.map(card).join('')}<script id="__STATE__" type="application/json">${JSON.stringify({ wall: { pageData: { next, prev: '', totalPages: 3, totalResources: total } } })}</script></body></html>`;
const jsonCards = (json) => ((json && json.data && json.data.products) || []).map((p) => ({ name: p.name, price: p.price, sourceUrl: p.url }));

test('internal API "next" + announced total: resolved on the page-declared API host, followed until the total is reached', async () => {
  const first = stateHtml(range(1, 3), '/listing/v1?anchor=3&count=3', 8, '<link rel="dns-prefetch" href="https://api.shop.test"><link rel="preconnect" href="https://cdn.other.net">');
  const calls = [];
  const api = {
    'https://api.shop.test/listing/v1?anchor=3&count=3': API_PAGE(range(4, 6), '/listing/v1?anchor=6&count=3', 8),
    'https://api.shop.test/listing/v1?anchor=6&count=3': API_PAGE(range(7, 9), '/listing/v1?anchor=9&count=3', 8),
  };
  const fetchJson = async (u) => { calls.push(u); return api[u] ? { ok: true, json: api[u], status: 200 } : { ok: false, status: 404, json: { errors: [{ code: 310 }] } }; };
  const r = await run({}, first, { fetchJson, extractJsonCards: jsonCards }).p;
  assert.equal(r.mechanism, 'api-next');
  assert.equal(r.totalAnnounced, 8);
  assert.equal(r.stoppedBy, 'total_reached');
  assert.ok(r.cards.length >= 8);
  assert.deepEqual(calls.slice(0, 2), ['https://shop.test/listing/v1?anchor=3&count=3', 'https://api.shop.test/listing/v1?anchor=3&count=3'], 'page origin first, then the host the page itself declares');
  assert.deepEqual(r.memo, { mode: 'api-next', api_host: 'https://api.shop.test' });
  assert.equal(r.warnings.length, 0);
});

test('internal API refused (e.g. a site-specific header required): nothing guessed, clear warnings, total not reached', async () => {
  const first = stateHtml(range(1, 3), '/listing/v1?anchor=3&count=3', 120, '<link rel="dns-prefetch" href="https://api.shop.test">');
  const fetchJson = async (u) => (u.startsWith('https://api.') ? { ok: false, status: 400, json: { errors: [{ code: 'CALLER_ID_HEADER_NOT_PRESENT', message: 'Request header must be present' }] } } : { ok: false, status: 404, json: { errors: [{ code: 310 }] } });
  const r = await run({}, first, { fetchJson, extractJsonCards: jsonCards }).p;
  assert.equal(r.stoppedBy, 'api_refused');
  assert.equal(r.cards.length, 3);
  assert.equal(r.totalAnnounced, 120);
  assert.deepEqual(r.warnings.sort(), ['api_refused', 'scroll_not_followable', 'total_not_reached']);
  assert.deepEqual(r.detail, { status: 400, error: 'CALLER_ID_HEADER_NOT_PRESENT' });
});

test('infinite scroll / "load more" with no deducible request: not followed, reported', async () => {
  const p1 = grid(range(1, 3)).replace('</body>', '<button class="more">Charger plus de produits</button></body>');
  const r = await run({}, p1).p;
  assert.equal(r.mechanism, 'none'); assert.equal(r.stoppedBy, 'no_pagination'); assert.deepEqual(r.warnings, ['scroll_not_followable']);
});

test('stored memo: a url-param recipe goes straight to its parameter', async () => {
  const p1 = grid(range(1, 2));
  const r = await paginateListing({ entryUrl: BASE, firstHtml: p1, firstCards: extractCards(p1, BASE), extractCards, fetchHtml: async (u) => (u === `${BASE}?p=2` ? { ok: true, html: grid([3, 4]) } : { ok: true, html: grid([]) }), memo: { mode: 'url-param', param: 'p', start: 1, max_pages: null } });
  assert.equal(r.mechanism, 'url-param'); assert.equal(r.cards.length, 4);
});

test('signals: detectPagination / declaredHosts / findJsonPagination', () => {
  const html = stateHtml([1], '/a?next=1', 50, '<link rel="dns-prefetch" href="https://api.shop.test"><link rel="preconnect" href="https://static.shop.test"><link rel="preconnect" href="https://fonts.other.com">');
  assert.deepEqual(declaredHosts(html, BASE), ['https://api.shop.test', 'https://static.shop.test'], 'same site only, api first');
  const s = detectPagination(html, BASE);
  assert.equal(s.api.next, '/a?next=1'); assert.equal(s.totalAnnounced, 50); assert.equal(s.relNext, null);
  assert.equal(findJsonPagination({ links: { next: 'https://x.test/api?page=2' }, meta: { total: 9 } }).next, 'https://x.test/api?page=2');
  assert.equal(findJsonPagination({ nextCursor: 'abc123', total: 9 }).cursor, 'abc123');
  assert.equal(findJsonPagination({ next: true, total: 9 }), null, 'a boolean is not a next handle');
});
