/**
 * The analysis (probe) must evaluate the WHOLE chain and report the BEST achievable
 * result — free lanes first (recipe / embedded / listing / fiche), then protected
 * (browser / unlock) — with a per-field status (free / unlock / absent). A cross is
 * only ever shown for a field genuinely missing from a product we read for free;
 * on a protected site every field is "needs unlock", never a bare cross.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeSource } from '../probe.mjs';

class Mock {
  constructor(map) { this.map = map; this.stats = { requests: 0, ok: 0, blocked: 0 }; this.userAgent = 't'; }
  async get(url) {
    this.stats.requests++;
    const e = this.map[url] || { status: 404 };
    const status = e.status ?? 200; const ok = status < 400; if (ok) this.stats.ok++; if (status === 403) this.stats.blocked++;
    return { ok, status, url, requestedUrl: url, body: ok ? (e.body ?? '') : (e.body ?? ''), headers: {}, error: ok ? null : `HTTP ${status}` };
  }
  async getText(url) { return this.get(url); }
}
const CHALLENGE = '<html><head><title>Just a moment...</title></head><body>Checking your browser /cdn-cgi/challenge-platform ray id</body></html>';

test('brico case: embedded products.collection → FREE, ok, no crosses for present fields', async () => {
  const entry = 'https://www.brico.be/fr/chauffage-climatisation/he1/tous-les-produits';
  const grid = '<html><body><script>window.__X=' + JSON.stringify({
    products: { collection: [
      { id: '10589617', title: 'Radiateur X', link: '/fr/chauffage/radiateur-x/10589617', image: 'https://img/x.webp', ean: '4053423483994', regular: { price: 149 } },
      { id: '10466480', title: 'Convecteur Y', link: '/fr/chauffage/convecteur-y/10466480', image: 'https://img/y.webp', ean: '0088381609647', regular: { price: 89.9 } },
    ] },
    content: { response: { totalNumberOfResults: 508 } }, viewSize: 24,
  }) + '</script></body></html>';
  const map = { 'https://www.brico.be/robots.txt': { body: '' }, [entry]: { body: grid } };
  const p = await probeSource(entry, { fetcher: new Mock(map) });
  assert.equal(p.best_path, 'embedded');
  assert.equal(p.diagnosis, 'ok');
  assert.equal(p.product_count, 508);                 // from pagination, not the 2 sampled cards
  assert.equal(p.field_status.name, 'free');
  assert.equal(p.field_status.price, 'free');
  assert.equal(p.field_status.ean, 'free');
  assert.ok(p.free_fields.includes('name') && p.free_fields.includes('price'));
  assert.match(p.headline, /gratuite possible/i);
});

test('protected case (Levi\'s/Microfluo): blocked + profile.needsUnlock → unlock, EVERY field is € not ✗', async () => {
  const entry = 'https://www.levi.com/BE/fr_BE/vetements/homme/jeans/c/x';
  const map = { 'https://www.levi.com/robots.txt': { status: 403, body: CHALLENGE }, [entry]: { status: 403, body: CHALLENGE } };
  const profile = { needsUnlock: true, needsBrowser: true, lastProductCount: 105 };
  const p = await probeSource(entry, { fetcher: new Mock(map), profile });
  assert.equal(p.best_path, 'unlock');
  assert.equal(p.diagnosis, 'blocked');
  assert.equal(p.protected_site, true);
  assert.equal(p.known_count, 105);
  assert.equal(p.absent_fields.length, 0, 'a protected site shows NO absent crosses');
  for (const k of ['name', 'price', 'image']) assert.equal(p.field_status[k], 'unlock');
  assert.match(p.headline, /prot[ée]g[ée]|déblocage/i);
});

test('recipe case (Colruyt seeded): internal_api replay → FREE, products from the recipe, right fields', async () => {
  const entry = 'https://www.colruyt.be/fr/produits/legumes';
  const recipe = {
    endpoint_tpl: 'https://api.colruyt/list?size={size}&skip={skip}',
    method: 'GET',
    pagination: { type: 'offset', param: 'skip', size_param: 'size', size: 2, total_json_path: 'totalProductsFound' },
    json_path: 'products',
    field_map: { name: 'name', price: 'price.basicPrice', sku: 'commercialArticleNumber' },
  };
  const ALL = [{ name: 'concombre', price: { basicPrice: 0.89 }, commercialArticleNumber: '29750' }, { name: 'poivrons', price: { basicPrice: 1.65 }, commercialArticleNumber: '29522' }];
  const httpGet = async (url, { as } = {}) => { const u = new URL(url); const skip = Number(u.searchParams.get('skip')); const size = Number(u.searchParams.get('size')); return { status: 200, body: { totalProductsFound: 271, products: ALL.slice(skip, skip + size) } }; };
  const p = await probeSource(entry, { fetcher: new Mock({}), recipe, httpGet });
  assert.equal(p.best_path, 'recipe');
  assert.equal(p.diagnosis, 'ok');
  assert.equal(p.product_count, 271);
  assert.equal(p.field_status.name, 'free');
  assert.equal(p.field_status.price, 'free');
  assert.equal(p.field_status.sku, 'free');
});

test('readable fiche with partial data → absent fields ARE crosses (the legitimate ✗ case)', async () => {
  const entry = 'https://shop.example.com/fr/produits/jean-501';   // a product URL (free fiche lane)
  const jsonld = '<script type="application/ld+json">{"@type":"Product","name":"Jean 501","offers":{"price":"89.90","priceCurrency":"EUR"}}</script>';
  const map = { 'https://shop.example.com/robots.txt': { body: '' }, [entry]: { body: `<html><body>${jsonld}<p>${'contenu produit lisible '.repeat(30)}</p></body></html>` } };
  const p = await probeSource(entry, { fetcher: new Mock(map) });
  assert.ok(['fiche', 'listing'].includes(p.best_path), `free from the page, got ${p.best_path}`);
  assert.equal(p.diagnosis, 'ok');
  assert.equal(p.protected_site, false);
  assert.equal(p.field_status.name, 'free');
  assert.equal(p.field_status.price, 'free');
  assert.equal(p.field_status.ean, 'absent');          // readable for free + truly missing → a real cross
  assert.equal(p.field_status.brand, 'absent');
  assert.ok(p.absent_fields.includes('ean'));
});

test('Item 2: probe evaluates a recipe endpoint_variant — a Lidl /s section URL reports the free recipe path', async () => {
  const fs = await import('node:fs');
  const recipe = JSON.parse(fs.readFileSync(new URL('../recipes/lidl-be.json', import.meta.url), 'utf8'));
  const SECTION = 'https://www.lidl.be/c/fr-BE/aliments-boissons/s10068374';
  const item = (i) => ({ gridbox: { data: { fullTitle: `Produit ${i}`, price: { price: 1 + i, currencyCode: 'EUR' }, erpNumber: String(1000 + i), image: 'https://img', canonicalPath: `/p/fr-BE/produit-${i}/p${1000 + i}` } } });
  const httpGet = async (url) => {
    const u = new URL(url);
    assert.equal(u.searchParams.get('category.id'), '10068374', 'section URL resolved through the categoryId variant, not the base campaign template');
    const size = Number(u.searchParams.get('fetchsize'));
    const offset = Number(u.searchParams.get('offset'));
    const all = Array.from({ length: 24 }, (_, i) => item(i));
    return { status: 200, body: { numFound: 122, items: all.slice(offset, offset + size) } };
  };
  const p = await probeSource(SECTION, { fetcher: new Mock({ 'https://www.lidl.be/robots.txt': { body: '' } }), recipe, httpGet });
  assert.equal(p.best_path, 'recipe', 'the section endpoint_variant is evaluated — Analyze reflects the working recipe, not "browser/teach"');
  assert.equal(p.product_count, 122);                  // numFound from the API, not the 24 sampled
  assert.equal(p.diagnosis, 'ok');
});
