/**
 * needsBrowser (c): structured data only rules the browser out when it actually
 * YIELDS a product. A CSR shell shipping an empty __NUXT__ blob (or a
 * non-product JSON-LD) must keep the free browser lane open — the exact case
 * where a valid 200 listing used to be diagnosed 'no-signal'.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsBrowser } from '../html-meta.mjs';
import { probeSource } from '../probe.mjs';

const NUXT_SHELL = '<html><head><title>Shop</title></head><body><div id="__nuxt"></div><script>window.__NUXT__='
  + JSON.stringify({ state: { cart: { items: [] }, config: { locale: 'fr', currency: 'EUR' }, filler: 'x'.repeat(3000) } })
  + '</script></body></html>';

test('CSR shell with a product-less __NUXT__ blob → needsBrowser true', () => {
  assert.equal(needsBrowser(NUXT_SHELL), true);
});

test('page whose embedded state yields products → needsBrowser false (unchanged)', () => {
  const html = '<html><body><div id="app"></div><script>window.__NUXT__='
    + JSON.stringify({ products: [
      { name: 'Radiateur X', price: 149, sku: 'R1', image: 'https://img/x.webp' },
      { name: 'Convecteur Y', price: 89.9, sku: 'C2', image: 'https://img/y.webp' },
      { name: 'Poêle Z', price: 219, sku: 'P3', image: 'https://img/z.webp' },
    ] })
    + '</script></body></html>';
  assert.equal(needsBrowser(html), false);
});

// The live lidl.be campaign shape: a POPULATED root (full SSR header/footer,
// well over the tiny-body threshold) whose hydration blob is empty — the grid
// is fetched client-side. Neither emptyRoot nor tinyBody can see this shell.
const BIG_CHROME_SHELL = '<html><head><title>Campagne</title>'
  + '<script type="application/ld+json">{"@type":"Organization","name":"Shop"}</script></head>'
  + '<body><div id="__nuxt"><header><nav>' + '<a href="/c/x">cat</a> '.repeat(120) + '</nav></header>'
  + '<main><div class="grid"></div></main>'
  + '<footer>' + '<p>mentions légales et liens de bas de page</p>'.repeat(40) + '</footer></div>'
  + '<script>window.__NUXT__={};window.__NUXT__.config={public:{searchPath:"/q/api/search"}}</script>'
  + '</body></html>';

test('big-chrome CSR listing (populated root, empty __NUXT__ blob) → needsBrowser true', () => {
  // Guard the fixture: it must NOT be catchable by the emptyRoot/tinyBody gates.
  assert.equal(/<div[^>]*id=["'](root|app|__next|__nuxt)["'][^>]*>\s*<\/div>/i.test(BIG_CHROME_SHELL), false);
  const body = BIG_CHROME_SHELL.match(/<body[\s\S]*<\/body>/i)[0].replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ');
  assert.ok(body.length >= 1500, 'fixture body must be over the tiny-body threshold');
  assert.equal(needsBrowser(BIG_CHROME_SHELL), true);
});

test('tiny page with a Product JSON-LD → false; Organization-only JSON-LD shell → true', () => {
  const product = '<html><body><script type="application/ld+json">{"@type":"Product","name":"X"}</script></body></html>';
  assert.equal(needsBrowser(product), false);
  const org = '<html><body><div id="root"></div><script type="application/ld+json">{"@type":"Organization","name":"Shop"}</script></body></html>';
  assert.equal(needsBrowser(org), true);
});

// End-to-end through the probe: the 200 CSR listing shell must be diagnosed
// 'needs-browser' (the free lane the scrape actually uses), never 'no-signal'.
class Mock {
  constructor(map) { this.map = map; this.stats = { requests: 0, ok: 0, blocked: 0 }; this.userAgent = 't'; }
  async get(url) {
    this.stats.requests++;
    const e = this.map[url] || { status: 404 };
    const status = e.status ?? 200; const ok = status < 400; if (ok) this.stats.ok++;
    return { ok, status, url, requestedUrl: url, body: e.body ?? '', headers: {}, error: ok ? null : `HTTP ${status}` };
  }
  async getText(url) { return this.get(url); }
}

test('probe: a valid 200 CSR listing shell (__NUXT__, 0 products) → needs-browser, not no-signal', async () => {
  const entry = 'https://shop.example.be/fr/produits';
  const map = { 'https://shop.example.be/robots.txt': { body: '' }, [entry]: { body: NUXT_SHELL } };
  const p = await probeSource(entry, { fetcher: new Mock(map) });
  assert.equal(p.diagnosis, 'needs-browser');
  assert.equal(p.best_path, 'browser');
  assert.notEqual(p.diagnosis, 'no-signal');
});

test('probe: big-chrome CSR listing (populated root, empty state blob) → needs-browser, not no-signal', async () => {
  const entry = 'https://shop.example.be/c/fr-BE/campagne/a123';
  const map = { 'https://shop.example.be/robots.txt': { body: '' }, [entry]: { body: BIG_CHROME_SHELL } };
  const p = await probeSource(entry, { fetcher: new Mock(map) });
  assert.equal(p.diagnosis, 'needs-browser');
  assert.equal(p.best_path, 'browser');
});

// A free browser-lane verdict must NOT label its fields as paid unlock. This was
// the self-contradiction on the lidl.be section URL: the headline said "navigateur
// local (gratuit)" while the field list read "€ déblocage : nom, prix, …" — because
// browser (free) and unlock (paid) were both folded into unlock_fields.
test('probe: a browser (free) verdict puts fields in browser_fields, never unlock_fields', async () => {
  const entry = 'https://www.lidl.be/c/fr-BE/aliments-boissons/s10068374?offset=36';
  const map = { 'https://www.lidl.be/robots.txt': { body: '' }, [entry]: { body: NUXT_SHELL } };
  const p = await probeSource(entry, { fetcher: new Mock(map) });
  assert.equal(p.best_path, 'browser');
  assert.equal(p.unlock_fields.length, 0, 'no field is € (paid) on a free browser verdict');
  assert.equal(p.browser_fields.length, 9, 'all unreached fields are "free after render"');
  for (const k of p.browser_fields) assert.equal(p.field_status[k], 'browser');
});
