/**
 * Pictures and the product address through the engine's extractor and normaliser, on generic markup and on
 * the real product pages of four sites of different build (fixtures/sites, compressed): every exported
 * image is a complete address in its largest known size, each picture once, the main picture first, the
 * swatches and related products of a page never among them; the product address is canonical, absolute,
 * without tracking parameters; what is rejected is reported with its reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { extractProduct, canonicalProductUrl } from '../extract.mjs';
import { toNormalizedProduct } from '../normalize.mjs';
import { toImportCsv } from '../csv.mjs';
import { validateImageUrl, imageKey, isTransformSegment } from '../../shared/extract/images.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const site = (name) => zlib.gunzipSync(fs.readFileSync(path.join(HERE, 'fixtures', 'sites', `${name}.html.gz`))).toString('utf8');
const CLOUD = (t, file) => `https://cdn.test/images/e_trim:EAEEEF/c_lpad,w_iw,h_ih/${t}/ab250e4e_9366/${file}`;
const PAGE = 'https://shop.test/fr/p/chaussure-spezial/IF6490?utm_source=news&gclid=abc';

// A generic product page: JSON-LD in a @graph with ImageObject + plain addresses, two og:image, a gallery of
// <picture> with Cloudinary-style srcsets (commas in the path), lazy / zoom attributes, a CSS background, an
// entity-encoded Shopify address with a version query, a swatch strip leading to other colourways, related
// products, an SVG icon, a relative and a protocol-relative picture.
const GENERIC = `<html><head>
  <link rel="canonical" href="/fr/p/chaussure-spezial/IF6490?utm_campaign=x">
  <meta property="og:url" content="https://shop.test/fr/p/chaussure-spezial/IF6490?ref=og">
  <meta property="og:image" content="${CLOUD('c_fill,g_auto,w_1200,h_630', 'IF6490_01_standard.jpg')}">
  <meta property="og:image" content="https://cdn.test/og/second.jpg">
  <meta property="og:image:secure_url" content="https://cdn.test/og/second.jpg">
  <script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': [
    { '@type': 'Organization', name: 'Shop' },
    { '@type': 'Product', name: 'Chaussure Spezial', sku: 'IF6490', brand: { '@type': 'Brand', name: 'Marque' }, url: '/fr/p/chaussure-spezial/IF6490',
      image: [{ '@type': 'ImageObject', url: CLOUD('w_500,f_auto', 'IF6490_01_standard.jpg'), name: 'Vue 1' }, CLOUD('w_500,f_auto', 'IF6490_02_standard.jpg'), 'https://cdn.shopify.test/s/files/1/pull_600x.jpg?v=1699&amp;x=1'],
      offers: { '@type': 'Offer', price: 110, priceCurrency: 'EUR', availability: 'https://schema.org/InStock' } },
  ] })}</script></head><body>
  <nav><a href="/fr"><img src="/static/logo.svg"></a></nav>
  <main><h1>Chaussure Spezial</h1>
    <div class="pdp-gallery">
      ${[1, 2, 3].map((i) => `<picture><source srcset="${CLOUD('h_320,f_auto', `IF6490_0${i}_standard.jpg`)} 320w, ${CLOUD('h_2000,f_auto', `IF6490_0${i}_standard.jpg`)} 2000w"><img src="${CLOUD('h_320,f_auto', `IF6490_0${i}_standard.jpg`)}" alt="Vue ${i}"></picture>`).join('')}
      <img data-src="//cdn.test/media/IF6490_detail.jpg" src="data:image/gif;base64,R0lGOD" alt="détail">
      <img src="/media/IF6490_zoom_small.jpg" data-zoom-image="/media/IF6490 zoom large.jpg" alt="zoom">
      <div style="background-image:url('https://cdn.test/media/été/IF6490_bg.jpg')"></div>
    </div>
    <ul class="swatches"><li><a href="/fr/p/chaussure-spezial/KH9814"><img src="${CLOUD('w_180', 'KH9814_00_plp.jpg')}" alt="Marron"></a></li></ul>
    <section class="related"><a href="/fr/p/autre/ZZ1"><img src="https://cdn.test/media/ZZ1_00.jpg" alt="Autre"></a></section>
  </main></body></html>`;

test('generic page: every source merged in reliability order, one image per picture in its largest size, main first, others’ pictures excluded, addresses normalised', () => {
  const { product, strategies } = extractProduct(GENERIC, PAGE);
  assert.ok(strategies.includes('generic-jsonld'));
  const imgs = product.images;
  assert.equal(imgs[0], CLOUD('h_2000,f_auto', 'IF6490_01_standard.jpg'), 'the JSON-LD main picture, in the gallery’s largest size');
  assert.equal(imgs[1], CLOUD('h_2000,f_auto', 'IF6490_02_standard.jpg'));
  assert.equal(imgs[2], 'https://cdn.shopify.test/s/files/1/pull.jpg?v=1699&x=1', 'entity decoded; the Shopify file without a size suffix is the original');
  assert.ok(imgs.includes('https://cdn.test/og/second.jpg') && imgs.filter((u) => u === 'https://cdn.test/og/second.jpg').length === 1, 'og:image and its secure_url twin: once');
  assert.ok(imgs.includes(CLOUD('h_2000,f_auto', 'IF6490_03_standard.jpg')));
  assert.ok(imgs.includes('https://cdn.test/media/IF6490_detail.jpg'), 'protocol-relative lazy picture');
  assert.ok(imgs.includes('https://shop.test/media/IF6490%20zoom%20large.jpg'), 'relative zoom picture with a space, resolved and encoded');
  assert.ok(imgs.includes('https://cdn.test/media/%C3%A9t%C3%A9/IF6490_bg.jpg'), 'unicode background picture encoded');
  assert.ok(!imgs.some((u) => /KH9814|ZZ1_00|logo\.svg|zoom_small|c_fill,g_auto,w_1200/.test(u)), `no swatch, related, icon, thumbnail or og rendition twin: ${imgs.join(' ')}`);
  assert.equal(new Set(imgs.map(imageKey)).size, imgs.length, 'each picture once');
  for (const u of imgs) assert.deepEqual(validateImageUrl(u), { ok: true }, u);
  assert.deepEqual(product.imageSources, { jsonld: 3, microdata: 0, og: 2, dom: 6, state: 0 });
  // The product address: the canonical link, absolute, without tracking parameters.
  assert.equal(product.canonicalUrl, 'https://shop.test/fr/p/chaussure-spezial/IF6490');
  assert.equal(product.canonicalSource, 'canonical');
});

test('canonicalProductUrl: canonical → og:url → declared → visited; absolute; tracking parameters dropped; locale kept', () => {
  const visited = 'https://shop.test/nl/p/x?fbclid=1&size=42';
  assert.deepEqual(canonicalProductUrl({ canonical: '/nl/p/x?utm_source=a', visited }), { url: 'https://shop.test/nl/p/x', source: 'canonical' });
  assert.deepEqual(canonicalProductUrl({ ogUrl: 'https://shop.test/nl/p/x?gclid=z', visited }), { url: 'https://shop.test/nl/p/x', source: 'og:url' });
  assert.deepEqual(canonicalProductUrl({ declared: '/nl/p/x', visited }), { url: 'https://shop.test/nl/p/x', source: 'declared' });
  assert.deepEqual(canonicalProductUrl({ visited }), { url: 'https://shop.test/nl/p/x?size=42', source: 'visited' }, 'a variant parameter is kept, a tracking one dropped');
  assert.deepEqual(canonicalProductUrl({ canonical: 'javascript:void(0)', visited }), { url: 'https://shop.test/nl/p/x?size=42', source: 'visited' });
  assert.deepEqual(canonicalProductUrl({}), { url: null, source: null });
});

test('real product pages (four sites, different builds): complete addresses, each picture once, main first, no other product’s picture', () => {
  const expect = {
    'adidas.be.product': { min: 8, first: /IF6490_01_00_standard/, never: /KH9814|plp_standard|\/videos\// },
    'iciparisxl.be.product': { min: 1, first: /prd-front-1116707/, never: /\.svg/ },
    'mediamarkt.be.product': { min: 8, first: /ASSET_MMS_162895121/, never: /ASSET_MMS_163025962|ASSET_MMS_162895130/ },
    'sephora.fr.product': { min: 3, first: /761423/, never: /scaleWidth=40/ },
  };
  for (const [name, e] of Object.entries(expect)) {
    const html = site(name);
    const url = (html.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)/i) || [])[1];
    const { product } = extractProduct(html, url);
    const imgs = product.images;
    assert.ok(imgs.length >= e.min, `${name}: ${imgs.length} image(s)`);
    assert.match(imgs[0], e.first, `${name}: main picture first — ${imgs[0]}`);
    for (const u of imgs) {
      assert.deepEqual(validateImageUrl(u), { ok: true }, `${name}: ${u}`);
      assert.doesNotMatch(u, e.never, `${name}: ${u}`);
      assert.ok(!isTransformSegment(new URL(u).pathname.split('/').pop()) || /\d{6}/.test(u), `${name}: ends on a transformation — ${u}`);
    }
    assert.equal(new Set(imgs.map(imageKey)).size, imgs.length, `${name}: a picture listed twice`);
    assert.match(product.canonicalUrl, /^https:\/\//, name);
  }
  // Adidas: the colourway of THIS page (JSON-LD variant url) gives its gallery — not the first colourway of the group.
  const adidas = extractProduct(site('adidas.be.product'), 'https://www.adidas.be/fr/chaussure-handball-spezial/IF6490.html');
  assert.ok(adidas.strategies.includes('generic-product-group'));
  assert.ok(adidas.product.images.filter((u) => /IF6490/.test(u)).length >= 8, 'the page’s own colourway pictures');
  assert.ok(adidas.product.imagesRejected.some((r) => r.reason === 'video_poster'), 'the video still frames are set aside with their reason, not exported');
});

test('normalisation: addresses absolute and deduplicated, a rejected address reported with its reason, the product address cleaned and counted', () => {
  const diag = { rejectedImages: [], urlsCorrected: 0, urlSamples: [] };
  const raw = {
    name: 'Chaussure Spezial', sku: 'IF6490', price: 110, currency: 'EUR',
    sourceUrl: 'https://shop.test/fr/p/x?utm_source=mail&fbclid=9', canonicalUrl: '/fr/p/x?gclid=1',
    images: ['/img/IF6490_small.jpg', 'https://shop.test/img/IF6490_large.jpg', 'https://cdn.test/images/e_trim:EAEEEF/c_lpad', 'data:image/png;base64,AAA', 'https://shop.test/img/IF6490_large.jpg?v=2'],
    imagesRejected: [{ url: 'https://cdn.test/videos/x_video.jpg', reason: 'video_poster', label: 'image d’aperçu d’une vidéo' }],
  };
  const np = toNormalizedProduct(raw, { storeSlug: 'demo', diag });
  assert.deepEqual(np.images, ['https://shop.test/img/IF6490_large.jpg'], 'small + large + versioned = one picture, the large one');
  assert.equal(np.image_url, np.images[0]);
  assert.equal(np.source_url, 'https://shop.test/fr/p/x', 'canonical, absolute, tracking parameters dropped');
  assert.equal(diag.urlsCorrected, 1); assert.deepEqual(diag.urlSamples, [{ from: '/fr/p/x?gclid=1', to: 'https://shop.test/fr/p/x' }]);
  assert.deepEqual(diag.rejectedImages.map((r) => [r.product, r.reason]), [['IF6490', 'transform_segment'], ['IF6490', 'data_uri'], ['IF6490', 'video_poster']]);
  // The CSV cell keeps the address byte for byte (commas inside the path are quoted, never split).
  const np2 = toNormalizedProduct({ name: 'X', sku: 'X1', price: 1, sourceUrl: 'https://shop.test/p/x', images: [CLOUD('w_500,f_auto', 'X1_01.jpg')] }, {});
  const csv = toImportCsv([np2]);
  const line = csv.split('\r\n')[1];
  assert.ok(line.includes(`"${CLOUD('w_500,f_auto', 'X1_01.jpg')}"`), 'quoted as one cell');
  const cells = [...line.matchAll(/("(?:[^"]|"")*"|[^,]*)(?:,|$)/g)].map((m) => m[1].replace(/^"|"$/g, '').replace(/""/g, '"'));
  assert.equal(cells[8], CLOUD('w_500,f_auto', 'X1_01.jpg'), 'image_url read back identical');
});
