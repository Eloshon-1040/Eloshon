/**
 * Product GROUP extraction + product-page completion (chantier 1). Fixtures are
 * hand-built with fictitious data, shaped like a hydrated product page that
 * carries several colourways (code + colour name + sizes with EAN + gallery +
 * prices). No network: fetchHtml is a map.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractProductGroup, matchColourway, mergeColourway, colourwaysFromJsonLd } from '../../shared/extract/product-group.mjs';
import { enrichFromDetailPages } from '../detail-enrich.mjs';
import { extractProduct } from '../extract.mjs';
import { toNormalizedProduct } from '../normalize.mjs';

const BASE = 'https://shop.test';
const colourway = (code, colour, { sizes = ['38', '39', '40'], cur = 100, ini = 100, images = 3 } = {}) => ({
  styleColor: code, colorDescription: colour, productType: 'FOOTWEAR',
  prices: { currency: 'EUR', currentPrice: cur, initialPrice: ini, discountPercentage: ini > cur ? 20 : 0 },
  productInfo: { title: 'Runner Alpha', subtitle: 'Chaussure pour femme', productDescription: 'Une chaussure de course légère, conçue pour les longues distances sur route.' },
  taxonomyLabels: { Brand: ['Marque Test'], Gender: ['Femmes'] },
  sizes: sizes.map((s, i) => ({ label: s, localizedLabel: s, localizedLabelPrefix: 'EU', gtins: [{ gtin: `40012345${code.slice(-3)}${String(i).padStart(2, '0')}` }], status: 'ACTIVE' })),
  contentImages: [
    ...Array.from({ length: images }, (_, i) => ({ cardType: 'image', properties: { squarish: { url: `https://cdn.shop.test/images/${code}-${i}.png` }, portrait: { url: `https://cdn.shop.test/images/${code}-${i}-p.png` } } })),
    { cardType: 'video', properties: { url: 'https://cdn.shop.test/videos/x.mp4' } },
  ],
});
const page = (selected, cws) => `<!doctype html><html><head><meta name="description" content="Runner Alpha, à retrouver sur la boutique."><meta property="og:title" content="Runner Alpha"></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { productGroups: [{ products: Object.fromEntries(cws.map((c) => [c.styleColor, c])) }], selectedProduct: cws.find((c) => c.styleColor === selected) } } })}</script></body></html>`;

const MODEL_A = [colourway('AB1234-001', 'Noir/Blanc', { cur: 80, ini: 100 }), colourway('AB1234-102', 'Blanc/Rouge'), colourway('AB1234-210', 'Gris', { sizes: ['41'] })];

test('group: every colourway of the page, by shape — code, colour, sizes (EU label + EAN), gallery (no video), prices, texts', () => {
  const g = extractProductGroup(page('AB1234-001', MODEL_A));
  assert.equal(g.source, 'embedded');
  assert.equal(g.colourways.length, 3);
  assert.equal(g.selected, 'AB1234-001');
  const c = g.colourways.find((x) => x.code === 'AB1234-001');
  assert.equal(c.color, 'Noir/Blanc');
  assert.deepEqual(c.sizes.map((s) => s.label), ['EU 38', 'EU 39', 'EU 40']);
  assert.equal(c.sizes[0].gtin, '4001234500100');
  assert.equal(c.sizes[0].available, undefined, 'a lifecycle status is not stock');
  assert.equal(c.images.length, 3, 'one image per gallery entry, the video skipped');
  assert.match(c.images[0], /AB1234-001-0\.png$/);
  assert.equal(c.price, 80); assert.equal(c.listPrice, 100, 'list price only when it is a real reduction');
  assert.equal(c.currency, 'EUR');
  assert.match(c.description, /longues distances/);
  assert.equal(c.brand, 'Marque Test');
  assert.deepEqual(c.genders, ['Femmes']);
  assert.equal(c.subtitle, 'Chaussure pour femme');
  assert.equal(g.colourways.find((x) => x.code === 'AB1234-102').listPrice, undefined, 'no reduction → no list price');
});

test('group: nothing is invented — a page without a colour-coded sized object yields no group', () => {
  const html = `<script type="application/json">${JSON.stringify({ items: [{ code: 'X1', name: 'Bag', color: '#ff0000', sizes: [{ label: 'M' }] }, { styleColor: 'Y2', colorDescription: 'Bleu' }] })}</script>`;
  assert.equal(extractProductGroup(html).colourways.length, 0, 'hex colour / no sizes nor images → not a colourway');
  assert.equal(extractProductGroup('<html><body>plain</body></html>').colourways.length, 0);
});

test('group: schema.org ProductGroup (JSON-LD) grouped by colour', () => {
  const ld = { '@context': 'https://schema.org', '@type': 'ProductGroup', name: 'Pull Uni', description: 'Pull en laine mérinos, maille fine, coupe droite.', brand: { '@type': 'Brand', name: 'Laine & Co' },
    hasVariant: [
      { '@type': 'Product', sku: 'P-BL-S', color: 'Bleu', size: 'S', gtin13: '5400000000017', offers: { price: '59.00', priceCurrency: 'EUR', availability: 'https://schema.org/InStock' }, image: 'https://cdn.test/img/p-bl.jpg' },
      { '@type': 'Product', sku: 'P-BL-M', color: 'Bleu', size: 'M', gtin13: '5400000000024', offers: { price: '59.00', priceCurrency: 'EUR', availability: 'https://schema.org/OutOfStock' } },
      { '@type': 'Product', sku: 'P-VE-S', color: 'Vert', size: 'S', offers: { price: '59.00', priceCurrency: 'EUR' } },
    ] };
  const cws = colourwaysFromJsonLd(ld);
  assert.deepEqual(cws.map((c) => c.color), ['Bleu', 'Vert']);
  assert.deepEqual(cws[0].sizes, [{ label: 'S', gtin: '5400000000017', available: true }, { label: 'M', gtin: '5400000000024', available: false }]);
  assert.equal(cws[0].brand, 'Laine & Co');
  const g = extractProductGroup(`<script type="application/ld+json">${JSON.stringify(ld)}</script>`);
  assert.equal(g.source, 'json-ld');
});

test('match + merge (option A): one row = one colourway; sizes become variants; a multi-size row gets no single EAN', () => {
  const g = extractProductGroup(page('AB1234-001', MODEL_A));
  const row = { name: 'Runner Alpha', price: 80, sourceUrl: `${BASE}/t/runner-alpha-Zx9/AB1234-102`, images: [`${BASE}/thumb.png`] };
  const cw = matchColourway(g, { url: row.sourceUrl });
  assert.equal(cw.code, 'AB1234-102', 'matched by the code in the URL path');
  const added = mergeColourway(row, cw);
  assert.ok(added.includes('color') && added.includes('variants') && added.includes('images'));
  assert.equal(row.color, 'Blanc/Rouge');
  assert.deepEqual(row.variants[0], { code: '4001234510200', type: 'taille', name: 'EU 38', gtin: '4001234510200' });
  assert.equal(row.gtin, undefined, '3 sizes → no product-level EAN');
  assert.equal(row.images[0], 'https://cdn.shop.test/images/AB1234-102-0.png', 'colourway gallery first');
  assert.equal(row.images[row.images.length - 1], `${BASE}/thumb.png`, 'the listing thumbnail is kept');
  const single = { name: 'Runner Alpha', sourceUrl: `${BASE}/t/x/AB1234-210` };
  mergeColourway(single, matchColourway(g, { url: single.sourceUrl }));
  assert.equal(single.gtin, '4001234521000', 'exactly one sized EAN → product EAN');
  const np = toNormalizedProduct(row, { lang: 'fr' });
  assert.equal(np.color, 'Blanc/Rouge'); assert.equal(np.variants.length, 3); assert.equal(np.raw.brand, 'Marque Test');
  assert.equal(np.source_category, 'Chaussure pour femme');
});

test('fiche extractor (crawl lane): the page colourway completes the product; the real description replaces the meta line', () => {
  const html = page('AB1234-001', MODEL_A);
  const { product, strategies } = extractProduct(html, `${BASE}/t/runner-alpha-Zx9/AB1234-001`);
  assert.ok(strategies.includes('generic-product-group'));
  assert.equal(product.color, 'Noir/Blanc');
  assert.equal(product.variants.length, 3);
  assert.match(product.description, /longues distances/, 'not "à retrouver sur la boutique"');
  assert.equal(product.listPrice, 100);
  assert.equal(product.brand, 'Marque Test');
});

test('completion: one visit per model, other colourways filled from it; failures keep the row as listed; reasons counted', async () => {
  const fetched = [];
  const pages = {
    [`${BASE}/t/runner-alpha-Zx9/AB1234-001`]: page('AB1234-001', MODEL_A),
    [`${BASE}/t/runner-beta-Qq1/CD5678-002`]: page('CD5678-002', [colourway('CD5678-002', 'Vert')]),
  };
  const fetchHtml = async (u) => { fetched.push(u); return pages[u] ? { ok: true, html: pages[u] } : { ok: false, status: 404 }; };
  const rows = [
    { name: 'Runner Alpha', price: 80, sourceUrl: `${BASE}/t/runner-alpha-Zx9/AB1234-001` },
    { name: 'Runner Alpha', price: 100, sourceUrl: `${BASE}/t/runner-alpha-Zx9/AB1234-102?x=1` },
    { name: 'Runner Alpha', price: 100, sourceUrl: `${BASE}/t/runner-alpha-other/AB1234-210` },
    { name: 'Runner Beta', price: 90, sourceUrl: `${BASE}/t/runner-beta-Qq1/CD5678-002` },
    { name: 'Gone', price: 10, sourceUrl: `${BASE}/t/gone/ZZ0000-000` },
  ];
  const before = JSON.stringify(rows[4]);
  const rep = await enrichFromDetailPages(rows, { fetchHtml });
  assert.deepEqual(fetched, [`${BASE}/t/runner-alpha-Zx9/AB1234-001`, `${BASE}/t/runner-beta-Qq1/CD5678-002`, `${BASE}/t/gone/ZZ0000-000`], 'model A visited ONCE for its 3 colourways');
  assert.equal(rep.visited, 3); assert.equal(rep.completed, 4); assert.equal(rep.failed, 1);
  assert.deepEqual(rep.reasons, { http_404: 1 });
  assert.deepEqual(rows.slice(0, 4).map((r) => r.color), ['Noir/Blanc', 'Blanc/Rouge', 'Gris', 'Vert']);
  // The row keeps what happened to its page (the report and the "to verify" verdict read it); its data stays exactly as listed.
  const { _detail, ...asListed } = rows[4];
  assert.equal(JSON.stringify(asListed), before, 'a failed page leaves the row exactly as listed');
  assert.deepEqual(_detail, { ok: false, reason: 'http_404', url: `${BASE}/t/gone/ZZ0000-000` });
});

test('completion: sample-first — product pages that add nothing stop the visits after the sample', async () => {
  let n = 0;
  const fetchHtml = async () => { n++; return { ok: true, html: '<html><head><title>x</title></head><body>nothing structured</body></html>' }; };
  const rows = Array.from({ length: 10 }, (_, i) => ({ name: `P${i}`, price: 5, sourceUrl: `${BASE}/p/${i}`, description: 'd', brand: 'b', images: ['https://cdn.test/i.png'] }));
  const rep = await enrichFromDetailPages(rows, { fetchHtml, sample: 3 });
  assert.equal(n, 3);
  assert.equal(rep.stoppedEarly, 'sample_no_data');
  assert.equal(rep.skipped, 7);
  assert.equal(rep.reasons.sample_no_data, 7);
});

test('completion: rows that already carry colour + variants (a platform feed) are not visited; max visits honoured', async () => {
  let n = 0;
  const fetchHtml = async () => { n++; return { ok: false, status: 500 }; };
  const rows = [{ name: 'A', sourceUrl: `${BASE}/a`, color: 'Rouge', variants: [{ type: 'taille', name: 'M' }] }, { name: 'B', sourceUrl: `${BASE}/b` }, { name: 'C', sourceUrl: `${BASE}/c` }];
  const rep = await enrichFromDetailPages(rows, { fetchHtml, maxVisits: 1, sample: 99 });
  assert.equal(n, 1); assert.equal(rep.candidates, 2); assert.equal(rep.skipped, 1); assert.equal(rep.reasons.max_visits, 1);
});
