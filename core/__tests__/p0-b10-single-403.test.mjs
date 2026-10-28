/**
 * P0 / B10 — a 403 on ONE product page is a refusal of that address, not of the
 * whole source: the page is skipped (and reported) and the run goes on. Only a
 * STREAK of refusals (`deniedStreak`, 3 by default) means the site refuses us and
 * stops the source. A challenge / captcha still stops it at once (site-wide signal).
 * Before: the first 403 with no other lane stopped everything. Mock fetcher only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScrape } from '../engine.mjs';
import { STATUS } from '../detect.mjs';

class Mock {
  constructor(map) { this.map = map; this.calls = []; this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; this.userAgent = 't'; }
  async get(u) {
    this.calls.push(u); this.stats.requests++;
    const e = this.map[u] || { status: 404, body: '' };
    const status = e.status ?? 200;
    const ok = status >= 200 && status < 300;
    return { ok, status, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body: e.body ?? '', bytes: null, headers: {}, error: ok ? null : `HTTP ${status}`, blocked: false };
  }
}
const fiche = (name, price) => `<html><body><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"${name}","offers":{"@type":"Offer","price":"${price}","priceCurrency":"EUR"}}</script>${'<p>x</p>'.repeat(30)}</body></html>`;
const denied = { status: 403, body: '<html><body>Forbidden</body></html>' };
const run = (cfg) => runScrape({ store: { slug: 't' }, concurrency: 1, useBrowser: false, defaultProductType: null, lang: 'fr', recovery: false, ...cfg });

test('one 403 among the product pages: that page is skipped, the others are read, the source is not stopped', async () => {
  const urls = Array.from({ length: 5 }, (_, i) => `https://shop.test/p/${i}`);
  const map = Object.fromEntries(urls.map((u, i) => [u, i === 1 ? denied : { body: fiche(`Article ${i}`, 10 + i) }]));
  const products = [];
  const { report } = await run({ urls, fetcher: new Mock(map), onProduct: (p) => products.push(p) });
  assert.equal(products.length, 4, 'the 4 readable pages');
  assert.equal(report.blocked, null, `source stopped: ${JSON.stringify(report.blocked)}`);
  assert.equal(report.denied, 1, 'the refused page is counted');
  assert.ok(report.errors.some((e) => e.includes('/p/1') && /403|denied/i.test(e)));
});

test('three refusals in a row: the site refuses us → the source stops (ACCESS_DENIED), with what was read kept', async () => {
  const urls = Array.from({ length: 8 }, (_, i) => `https://shop.test/p/${i}`);
  const map = Object.fromEntries(urls.map((u, i) => [u, i >= 2 ? denied : { body: fiche(`Article ${i}`, 10 + i) }]));
  const products = []; const f = new Mock(map);
  const { report } = await run({ urls, fetcher: f, onProduct: (p) => products.push(p) });
  assert.equal(products.length, 2);
  assert.equal(report.blocked && report.blocked.code, STATUS.ACCESS_DENIED);
  assert.ok(f.calls.length <= 5, `no hammering after the streak: ${f.calls.length} requests`);
  // The streak length is a setting.
  const g = new Mock(map);
  const r2 = await run({ urls, fetcher: g, deniedStreak: 1, onProduct: () => {} });
  assert.equal(r2.report.blocked && r2.report.blocked.code, STATUS.ACCESS_DENIED);
  assert.equal(g.calls.length, 3, 'deniedStreak 1 = the previous behaviour (stop at the first refusal)');
});

test('a challenge page still stops the source at once (site-wide signal)', async () => {
  const urls = ['https://shop.test/p/0', 'https://shop.test/p/1', 'https://shop.test/p/2'];
  const cf = { status: 503, body: '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>' };
  const map = { [urls[0]]: { body: fiche('A', 1) }, [urls[1]]: cf, [urls[2]]: { body: fiche('C', 3) } };
  const f = new Mock(map);
  const { report } = await run({ urls, fetcher: f, onProduct: () => {} });
  assert.equal(report.blocked && report.blocked.code, STATUS.BOT_CHALLENGE);
  assert.equal(f.calls.length, 2);
});
