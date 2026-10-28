/**
 * Probe fallback (a+b): a NON-terminal failure of the pasted URL (404 / network
 * error) must never be reported as the site's verdict when the scrape chain
 * would still deliver:
 *   (a) sample a SAME-LANGUAGE fiche from the sitemaps → coverage → 'ok';
 *   (b) no conclusive sample but the origin or a sitemap answers → the scrape's
 *       free local-browser fallback still runs → 'needs-browser';
 *   'unreachable' is reserved for a site where NOTHING answers.
 * The pasted URL stays the priority: nothing here fires on a 200.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeSource } from '../probe.mjs';

class Mock {
  constructor(map) { this.map = map; this.stats = { requests: 0, ok: 0, blocked: 0 }; this.userAgent = 't'; }
  async get(url) {
    this.stats.requests++;
    const e = this.map[url] || { status: 404 };
    const status = e.status ?? 200; const ok = !e.error && status < 400; if (ok) this.stats.ok++; if (status === 403) this.stats.blocked++;
    return { ok, status: e.error ? 0 : status, url, requestedUrl: url, body: e.body ?? '', headers: {}, error: e.error ?? (ok ? null : `HTTP ${status}`) };
  }
  async getText(url) { return this.get(url); }
}

const FICHE = (name, price) => '<html><body><script type="application/ld+json">'
  + JSON.stringify({ '@type': 'Product', name, offers: { price: String(price), priceCurrency: 'EUR' }, gtin13: '5400000000001' })
  + `</script><p>${'contenu produit lisible '.repeat(30)}</p></body></html>`;

test('404 entry + same-language sitemap fiche extracts → ok (fiche), never unreachable', async () => {
  const entry = 'https://shop.example.be/fr/produits/rayon-disparu';   // 404
  const map = {
    'https://shop.example.be/robots.txt': { body: 'Sitemap: https://shop.example.be/sitemap.xml' },
    'https://shop.example.be': { body: '<html><body>home</body></html>' },
    'https://shop.example.be/sitemap.xml': { body: '<?xml version="1.0"?><urlset>'
      + '<url><loc>https://shop.example.be/nl/producten/koffie-1</loc></url>'
      + '<url><loc>https://shop.example.be/fr/produits/cafe-1</loc></url></urlset>' },
    'https://shop.example.be/fr/produits/cafe-1': { body: FICHE('Café moulu', 3.49) },
    'https://shop.example.be/nl/producten/koffie-1': { body: FICHE('Gemalen koffie', 3.49) },
  };
  const p = await probeSource(entry, { fetcher: new Mock(map) });
  assert.equal(p.diagnosis, 'ok');
  assert.equal(p.best_path, 'fiche');
  assert.equal(p.protected_site, false);
  assert.ok(p.sample_url && p.sample_url.includes('/fr/'), `sample must be /fr/, got ${p.sample_url}`);
  assert.ok(!(p.sample_url || '').includes('/nl/'), 'never a /nl/ sample for a /fr/ entry');
  assert.equal(p.field_status.name, 'free');
  assert.equal(p.field_status.price, 'free');
});

test('404 entry + origin OK but no conclusive fiche → needs-browser (free lane), not unreachable', async () => {
  const entry = 'https://shop.example.be/fr/produits/rayon-disparu';   // 404
  const map = {
    'https://shop.example.be/robots.txt': { body: '' },
    'https://shop.example.be': { body: '<html><body><main>' + 'accueil sans produit '.repeat(80) + '</main></body></html>' },
  };
  const p = await probeSource(entry, { fetcher: new Mock(map) });
  assert.equal(p.diagnosis, 'needs-browser');
  assert.equal(p.best_path, 'browser');
  assert.notEqual(p.diagnosis, 'blocked');
});

test('404 entry + dead origin but a READABLE sitemap (no extractable fiche) → needs-browser', async () => {
  const entry = 'https://shop.example.be/fr/produits/rayon-disparu';
  const map = {
    'https://shop.example.be/robots.txt': { body: 'Sitemap: https://shop.example.be/sitemap.xml' },
    'https://shop.example.be/sitemap.xml': { body: '<?xml version="1.0"?><urlset><url><loc>https://shop.example.be/fr/produits/mort-1</loc></url></urlset>' },
    // origin and the fiche itself are dead → sample inconclusive, sitemap readable
  };
  const p = await probeSource(entry, { fetcher: new Mock(map) });
  assert.equal(p.diagnosis, 'needs-browser');
  assert.equal(p.best_path, 'browser');
});

test('everything dead (entry + origin + robots/sitemaps) → unreachable', async () => {
  const entry = 'https://shop.example.be/fr/produits/rayon-disparu';
  const p = await probeSource(entry, { fetcher: new Mock({}) });   // every URL → 404
  assert.equal(p.diagnosis, 'unreachable');
  assert.equal(p.best_path, null);
});

test('wrong-language-only sitemap: a /fr/ entry NEVER samples a /nl/ fiche (falls to needs-browser)', async () => {
  const entry = 'https://shop.example.be/fr/produits/rayon-disparu';
  const map = {
    'https://shop.example.be/robots.txt': { body: 'Sitemap: https://shop.example.be/sitemap.xml' },
    'https://shop.example.be': { body: '<html><body><main>' + 'accueil sans produit '.repeat(80) + '</main></body></html>' },
    'https://shop.example.be/sitemap.xml': { body: '<?xml version="1.0"?><urlset><url><loc>https://shop.example.be/nl/producten/koffie-1</loc></url></urlset>' },
    'https://shop.example.be/nl/producten/koffie-1': { body: FICHE('Gemalen koffie', 3.49) },
  };
  const fetcher = new Mock(map);
  const p = await probeSource(entry, { fetcher });
  assert.equal(p.diagnosis, 'needs-browser');
  assert.ok(!(p.sample_url || '').includes('/nl/'), 'the wrong-language fiche must not be sampled');
});

test('a 200 entry with products is untouched by the fallback (no sitemap fetches)', async () => {
  const entry = 'https://shop.example.be/fr/produits/cafe-1';
  const map = {
    'https://shop.example.be/robots.txt': { body: 'Sitemap: https://shop.example.be/sitemap.xml' },
    [entry]: { body: FICHE('Café moulu', 3.49) },
  };
  const fetcher = new Mock(map);
  const p = await probeSource(entry, { fetcher });
  assert.equal(p.diagnosis, 'ok');
  assert.ok(!fetcher.stats || fetcher.stats.requests <= 2, `no extra fetches on a healthy entry (got ${fetcher.stats.requests})`);
});
