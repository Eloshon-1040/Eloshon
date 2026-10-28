/**
 * A pasted listing: its own next pages are read before any neighbouring category
 * (a promo banner's collection must not fill the product cap ahead of page 2).
 * Offline: mock fetcher.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverProducts } from '../discover.mjs';

class Mock {
  constructor(map) { this.map = map; this.reads = []; this.stats = { requests: 0 }; this.userAgent = 't'; }
  async get(url) {
    this.reads.push(url); this.stats.requests++;
    const e = this.map[url] || { status: 404 };
    const status = e.status ?? 200; const ok = status >= 200 && status < 300;
    return { ok, status, url, requestedUrl: url, contentType: 'text/html', kind: 'html', body: ok ? (e.body ?? '') : '', bytes: null, headers: {}, error: ok ? null : `HTTP ${status}`, blocked: !ok };
  }
  async getText(url) { return this.get(url); }
}
const grid = (ids, extra = '') => `<html><body><main>${extra}<ul>${ids.map((i) => `<li><a href="/fr/products/salon-${i}">Salon ${i}</a></li>`).join('')}</ul></main></body></html>`;

test('page 2 of the pasted listing comes before a promo collection linked from page 1', async () => {
  const shop = 'https://shop.test';
  const url = `${shop}/fr/jardin/salons/ga086/`;
  const promo = `${shop}/fr/collection/promotions`;
  const map = {
    [url]: { body: grid([1, 2, 3, 4], `<a href="${promo}">Promotions</a>`).replace('</main>', `<a href="?currentPage=2" rel="next">suivant</a></main>`) },
    [`${url}?currentPage=2`]: { body: grid([5, 6, 7, 8]) },
    [promo]: { body: grid([90, 91, 92, 93]).replace(/salon-/g, 'receveur-') },
  };
  const mock = new Mock(map);
  const { urls } = await discoverProducts(mock, url, { maxProducts: 8 });
  assert.equal(urls.length, 8);
  assert.ok(urls.every((u) => /salon-\d$/.test(u)), urls.join(' '));
  const page2 = mock.reads.indexOf(`${url}?currentPage=2`); const promoAt = mock.reads.indexOf(promo);
  assert.ok(page2 > 0 && (promoAt < 0 || page2 < promoAt), mock.reads.join(' '));
});

test('a listing whose products come only from the page state is not stopped as "no new products"', async () => {
  const shop = 'https://shop.test'; const url = `${shop}/fr/salons/ga086/`;
  const pageOf = (n) => {
    const products = [1, 2].map((k) => ({ id: `${n}${k}`, title: `Salon ${n}-${k}`, link: `/fr/salons/salon-${n}-${k}/${1000 + n * 10 + k}`, price: 100 + k, image: `https://cdn.test/${n}${k}.jpg` }));
    const next = n < 15 ? `<a href="?currentPage=${n + 1}" rel="next">suivant</a>` : '';
    return { body: `<html><body><script>window.__S__ = ${JSON.stringify({ products })};</script>${next}</body></html>` };
  };
  const map = { [url]: pageOf(1) };
  for (let n = 2; n <= 15; n++) map[`${url}?currentPage=${n}`] = pageOf(n);
  const { urls, report } = await discoverProducts(new Mock(map), url, { maxProducts: 100 });
  assert.equal(urls.length, 30, report.notes.join(' | '));
  assert.ok(!report.notes.some((n) => /no new products/.test(n)));
});
