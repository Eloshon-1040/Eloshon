/**
 * The analysis path (probe) must read the pasted URL like the scrape path:
 *  - a bare listing root (/produits, /products, /shop…) is a collection, not
 *    "unknown" (was: Colruyt /fr/produits → unknown);
 *  - a /fr/ URL yields language fr + country BE (ccTLD), never "?";
 *  - the sample product is taken from the PASTED URL's own grid (right language),
 *    never a wrong-language fiche pulled from the sitemap.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUrl, detectLocale } from '../url-context.mjs';
import { probeSource } from '../probe.mjs';

test('classifyUrl: a bare listing root is a collection', () => {
  assert.equal(classifyUrl('https://www.colruyt.be/fr/produits?page=1').type, 'collection');
  assert.equal(classifyUrl('https://shop.com/en/products').type, 'collection');
  assert.equal(classifyUrl('https://shop.com/fr/boutique/').type, 'collection');
  // a real product slug under /produits/ is still a product
  assert.equal(classifyUrl('https://shop.com/fr/produits/jean-501').type, 'product');
});

test('detectLocale: /fr/ path yields the language (country via ccTLD in the probe)', () => {
  const l = detectLocale('https://www.colruyt.be/fr/produits?page=1');
  assert.equal(l.language, 'fr');
});

// Sample selection prefers the pasted language and never a competing one.
class Mock {
  constructor(map) { this.map = map; this.stats = { requests: 0, ok: 0, blocked: 0 }; this.userAgent = 't'; }
  async get(url) {
    this.stats.requests++;
    const e = this.map[url] || { status: 404 };
    const ok = (e.status ?? 200) < 400; if (ok) this.stats.ok++;
    return { ok, status: e.status ?? 200, url, requestedUrl: url, body: ok ? (e.body ?? '') : '', headers: {}, error: ok ? null : `HTTP ${e.status}` };
  }
  async getText(url) { return this.get(url); }
}

test('probe: the sample comes from the PASTED /fr/ page grid, never a /nl/ sitemap fiche; country=BE', async () => {
  const entry = 'https://www.colruyt.be/fr/produits?page=1';
  // The pasted /fr/ listing carries its own product cards (JSON-LD) → the probe
  // samples THOSE (right language), and never touches the /nl/ sitemap fiche.
  const grid = '<html><body><script type="application/ld+json">'
    + '{"@type":"ItemList","itemListElement":[{"@type":"Product","name":"Café moulu","url":"https://www.colruyt.be/fr/produits/cafe-moulu","offers":{"price":"3.49","priceCurrency":"EUR"}}]}'
    + '</script></body></html>';
  const map = {
    'https://www.colruyt.be/robots.txt': { body: 'Sitemap: https://www.colruyt.be/sitemap.xml' },
    'https://www.colruyt.be/sitemap.xml': { body: '<?xml version="1.0"?><urlset><url><loc>https://www.colruyt.be/nl/producten/5656</loc></url></urlset>' },
    [entry]: { body: grid },
  };
  const p = await probeSource(entry, { fetcher: new Mock(map) });
  assert.equal(p.url_type, 'collection');
  assert.equal(p.locale.language, 'fr');
  assert.equal(p.locale.country, 'BE');
  assert.equal(p.best_path, 'listing');
  assert.equal(p.diagnosis, 'ok');
  assert.ok(p.sample_url && p.sample_url.includes('/fr/'), `sample must be /fr/, got ${p.sample_url}`);
  assert.ok(!(p.sample_url || '').includes('/nl/'), 'never a /nl/ sample for a /fr/ entry');
  assert.equal(p.field_status.name, 'free');
  assert.equal(p.field_status.price, 'free');
});
