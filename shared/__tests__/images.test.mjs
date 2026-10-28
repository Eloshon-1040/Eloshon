/**
 * The image contract (shared/extract/images.mjs): srcset parsed as the HTML specification says, URL lists
 * never split on a bare comma, normalisation (relative, protocol-relative, entities, spaces, unicode),
 * one picture per canonical key in its largest size, invalid addresses rejected with a reason. Generic
 * CDN shapes (Cloudinary-style transformations, Shopify suffixes, query-driven resizers), no site rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSrcset, bestFromSrcset, looksLikeSrcset, splitUrlList, decodeEntities, normalizeImageUrl, imageKey, imageSize,
  isTransformSegment, validateImageUrl, toProductImages, dedupeImages, imageUrls, mergeImageSources, normalizeRowImages,
} from '../extract/images.mjs';

// A transformation-style CDN address: commas INSIDE the path are part of the URL.
const CLOUD = (w, file = 'Chaussure_Handball_01_00_standard.jpg') => `https://cdn.example/images/e_trim:EAEEEF/c_lpad,w_iw,h_ih/b_rgb:EAEEEF/w_${w},f_auto,q_auto,fl_lossy,c_fill,g_auto/ab250e4e_9366/${file}`;

test('parseSrcset: a candidate is URL + descriptors; a comma inside a URL never separates candidates', () => {
  const ss = `${CLOUD(320)} 320w, ${CLOUD(640)} 640w,${CLOUD(1200)} 1200w`;
  const c = parseSrcset(ss);
  assert.equal(c.length, 3);
  assert.deepEqual(c.map((x) => x.w), [320, 640, 1200]);
  assert.equal(c[0].url, CLOUD(320));
  assert.equal(c[2].url, CLOUD(1200), 'a comma right after a descriptor (no space) still separates');
  // density descriptors, no descriptor, trailing comma, newlines and tabs
  assert.deepEqual(parseSrcset('a.jpg 1x,\n\tb.jpg 2x').map((x) => [x.url, x.x]), [['a.jpg', 1], ['b.jpg', 2]]);
  assert.deepEqual(parseSrcset('a.jpg, b.jpg').map((x) => x.url), ['a.jpg', 'b.jpg']);
  assert.deepEqual(parseSrcset('a.jpg 100w,').map((x) => x.url), ['a.jpg']);
  assert.deepEqual(parseSrcset(''), []);
});

test('bestFromSrcset: the largest candidate (width, else density, else height), never a data: URI', () => {
  assert.equal(bestFromSrcset(`${CLOUD(320)} 320w, ${CLOUD(1200)} 1200w, ${CLOUD(640)} 640w`), CLOUD(1200));
  assert.equal(bestFromSrcset('a.jpg 1x, b.jpg 2x'), 'b.jpg');
  assert.equal(bestFromSrcset('data:image/gif;base64,R0lGOD 1x, real.jpg 2x'), 'real.jpg');
  assert.equal(bestFromSrcset('only.jpg'), 'only.jpg');
  assert.equal(bestFromSrcset(null), null);
  assert.equal(looksLikeSrcset(`${CLOUD(320)} 320w, ${CLOUD(640)} 640w`), true);
  assert.equal(looksLikeSrcset(CLOUD(500)), false, 'one Cloudinary URL is not a srcset');
});

test('splitUrlList: splits before a new URL, on newlines, ";" / "|" / ", " between paths — never on a bare comma', () => {
  assert.deepEqual(splitUrlList(CLOUD(180)), [CLOUD(180)], 'one URL with commas stays one URL');
  assert.deepEqual(splitUrlList(`${CLOUD(180)}, ${CLOUD(500, 'b.jpg')}`), [CLOUD(180), CLOUD(500, 'b.jpg')]);
  assert.deepEqual(splitUrlList(`${CLOUD(180)},${CLOUD(500, 'b.jpg')}`), [CLOUD(180), CLOUD(500, 'b.jpg')], 'no space after the comma');
  assert.deepEqual(splitUrlList('https://a/1.jpg;https://a/2.jpg|https://a/3.jpg\nhttps://a/4.jpg'), ['https://a/1.jpg', 'https://a/2.jpg', 'https://a/3.jpg', 'https://a/4.jpg']);
  assert.deepEqual(splitUrlList('//cdn.a/1.jpg, //cdn.a/2.jpg'), ['//cdn.a/1.jpg', '//cdn.a/2.jpg'], 'protocol-relative');
  assert.deepEqual(splitUrlList('/img/a.jpg, /img/b.jpg; /img/c.jpg'), ['/img/a.jpg', '/img/b.jpg', '/img/c.jpg'], 'relative paths separated by ", " or ";"');
  assert.deepEqual(splitUrlList('https://a/1.jpg, /img/b.jpg'), ['https://a/1.jpg', '/img/b.jpg'], 'absolute then relative');
  assert.deepEqual(splitUrlList(`${CLOUD(180)};${CLOUD(500, 'b.jpg')}`, { sep: ';' }), [CLOUD(180), CLOUD(500, 'b.jpg')], 'a declared separator');
  assert.deepEqual(splitUrlList(['https://a/1.jpg', 'https://a/2.jpg, https://a/3.jpg']), ['https://a/1.jpg', 'https://a/2.jpg', 'https://a/3.jpg']);
  assert.deepEqual(splitUrlList(''), []);
});

test('normalizeImageUrl: absolute, protocol-relative, relative against the page, entities, spaces, unicode, fragments', () => {
  assert.equal(normalizeImageUrl('//cdn.example/a.jpg'), 'https://cdn.example/a.jpg');
  assert.equal(normalizeImageUrl('/media/a.jpg', 'https://shop.example/fr/p/1'), 'https://shop.example/media/a.jpg');
  assert.equal(normalizeImageUrl('img/a.jpg', 'https://shop.example/fr/p/1'), 'https://shop.example/fr/p/img/a.jpg');
  assert.equal(normalizeImageUrl('https://cdn.example/a.jpg?w=100&amp;h=200', null), 'https://cdn.example/a.jpg?w=100&h=200', 'HTML entities decoded');
  assert.equal(normalizeImageUrl('https://cdn.example/my picture.jpg'), 'https://cdn.example/my%20picture.jpg', 'spaces encoded');
  assert.equal(normalizeImageUrl('https://cdn.example/été/chaussure.jpg'), 'https://cdn.example/%C3%A9t%C3%A9/chaussure.jpg', 'unicode encoded');
  assert.equal(normalizeImageUrl(CLOUD(500)), CLOUD(500), 'commas kept in the path');
  assert.equal(normalizeImageUrl('https://cdn.example/a.jpg#zoom'), 'https://cdn.example/a.jpg');
  assert.equal(normalizeImageUrl('data:image/png;base64,AAA'), null);
  assert.equal(normalizeImageUrl('ftp://cdn.example/a.jpg'), null);
  assert.equal(normalizeImageUrl('  '), null);
  assert.equal(normalizeImageUrl('/relative/without/base.jpg'), null, 'a relative path without a page cannot be resolved');
  assert.equal(decodeEntities('a&#x2F;b&#47;c&amp;d'), 'a/b/c&d');
});

test('imageKey: the same picture in several sizes shares one key; different pictures never do', () => {
  // Cloudinary-style transformations in the path
  assert.equal(imageKey(CLOUD(180)), imageKey(CLOUD(500)));
  assert.equal(imageKey('https://cdn.example/images/w_500,f_auto,q_auto/ab250e4e_9366/x.jpg'), imageKey('https://cdn.example/images/c_fill,g_auto,w_1200,h_630,f_auto,q_auto/w_500,f_auto,q_auto/ab250e4e_9366/x.jpg'));
  assert.notEqual(imageKey(CLOUD(500, 'a_01.jpg')), imageKey(CLOUD(500, 'a_02.jpg')), 'file names that look like tokens are files');
  // Shopify suffix + version query
  assert.equal(imageKey('https://cdn.shopify.com/s/files/1/0001/products/pull_600x.jpg?v=1699'), imageKey('https://cdn.shopify.com/s/files/1/0001/products/pull.jpg?v=1700'));
  assert.equal(imageKey('https://cdn.shopify.com/s/files/1/0001/products/pull_1024x1024_crop_center.jpg'), imageKey('https://cdn.shopify.com/s/files/1/0001/products/pull.jpg'));
  assert.notEqual(imageKey('https://cdn.shopify.com/s/files/1/0001/products/pull_1.jpg'), imageKey('https://cdn.shopify.com/s/files/1/0001/products/pull_2.jpg'));
  // imgix / Akamai-style query resizers
  assert.equal(imageKey('https://img.example/p/42.jpg?w=800&auto=format&fit=max'), imageKey('https://img.example/p/42.jpg?w=200&auto=format'));
  assert.equal(imageKey('https://assets.example/isr/1/c1/-/ASSET_1?x=1248&y=936&format=webp&quality=60'), imageKey('https://assets.example/isr/1/c1/-/ASSET_1?x=300&y=200&format=webp'));
  assert.notEqual(imageKey('https://img.example/image?id=1&w=500'), imageKey('https://img.example/image?id=2&w=500'), 'an id parameter identifies the picture');
  // PrestaShop size directories
  assert.equal(imageKey('https://shop.example/1625-home_default/x.jpg'), imageKey('https://shop.example/1625-large_default/x.jpg'));
  assert.equal(isTransformSegment('c_lpad,w_iw,h_ih'), true);
  assert.equal(isTransformSegment('e_trim:EAEEEF'), true);
  assert.equal(isTransformSegment('ab250e4e84694097996b2564de682545_9366'), false, 'a hash directory is kept');
  assert.equal(isTransformSegment('img_01.jpg'), false, 'a file is never a transformation');
});

test('imageSize: explicit dimensions, Cloudinary w_/h_, Shopify _600x, query sizes, size words, unknown = 1000', () => {
  assert.equal(imageSize('https://c/x_600x600.jpg'), 600);
  assert.equal(imageSize(CLOUD(500)), 500);
  assert.equal(imageSize('https://c/w_1200,h_630/x.jpg'), 1200);
  assert.equal(imageSize('https://c/x.jpg?w=800'), 800);
  assert.equal(imageSize('https://c/x.jpg?scaleWidth=750&scaleHeight=750'), 750);
  assert.ok(imageSize('https://c/x-large_default/a.jpg') > imageSize('https://c/x-small_default/a.jpg'));
  assert.equal(imageSize('https://c/a.jpg'), 1000);
});

test('validateImageUrl: a truncated transformation address is rejected with a reason, a real one accepted', () => {
  assert.deepEqual(validateImageUrl(CLOUD(500)), { ok: true });
  const cut = validateImageUrl('https://cdn.example/images/e_trim:EAEEEF/c_lpad');
  assert.equal(cut.ok, false); assert.equal(cut.reason, 'transform_segment'); assert.match(cut.label, /tronquée/);
  assert.equal(validateImageUrl('w_iw').reason, 'invalid_url');
  assert.equal(validateImageUrl('data:image/png;base64,AAA').reason, 'data_uri');
  assert.equal(validateImageUrl('ftp://x/y.jpg').reason, 'scheme');
  assert.equal(validateImageUrl('https://cdn.example/').reason, 'no_path');
  assert.deepEqual(validateImageUrl('https://img.example/image?id=1'), { ok: true }, 'an image served by id has no path but a query');
});

test('toProductImages: strings, srcset strings, URL lists, ImageObject, nested objects, ProductImage; rejections carry a reason', () => {
  const base = 'https://shop.example/fr/p/1';
  const r = toProductImages([
    '/media/a.jpg',
    { '@type': 'ImageObject', url: 'https://cdn.example/b.jpg', name: 'Vue de côté', width: 800, height: 600 },
    { '@type': 'ImageObject', contentUrl: '//cdn.example/c.jpg' },
    `${CLOUD(320)} 320w, ${CLOUD(1200)} 1200w`,
    'https://cdn.example/d.jpg, https://cdn.example/e.jpg',
    { url: 'https://cdn.example/b.jpg' },  // duplicate URL
    { url: 'https://cdn.example/images/e_trim:EAEEEF/c_lpad' },  // truncated
    'data:image/gif;base64,R0lGOD',
    { image: { src: 'https://cdn.example/f.jpg', alt: 'f' } },
  ], { base, source: 'jsonld' });
  assert.deepEqual(imageUrls(r.images), ['https://shop.example/media/a.jpg', 'https://cdn.example/b.jpg', 'https://cdn.example/c.jpg', CLOUD(1200), 'https://cdn.example/d.jpg', 'https://cdn.example/e.jpg', 'https://cdn.example/f.jpg']);
  assert.equal(r.images[1].alt, 'Vue de côté'); assert.equal(r.images[1].width, 800); assert.equal(r.images[1].height, 600);
  assert.deepEqual(r.images.map((i) => i.position), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(r.images.every((i) => i.source === 'jsonld'));
  assert.deepEqual(r.rejected.map((x) => x.reason), ['transform_segment', 'data_uri']);
  assert.ok(r.images.every((i) => i.url !== undefined && typeof i.url === 'string'), 'no undefined anywhere');
});

test('dedupeImages: several sizes of one picture = one image, the largest kept at its first place; order kept; main first', () => {
  const list = toProductImages([
    CLOUD(180, 'main_00.jpg'),            // listing thumbnail of the main picture
    'https://cdn.example/images/w_500,f_auto,q_auto/ab250e4e_9366/view_01.jpg',
    CLOUD(500, 'main_00.jpg'),            // the same main picture, larger
    'https://cdn.example/images/c_fill,g_auto,w_1200,h_630,f_auto,q_auto/w_500,f_auto,q_auto/ab250e4e_9366/main_00.jpg',  // og:image rendition, larger still
    'https://cdn.shopify.com/s/p/pull_300x.jpg?v=1', 'https://cdn.shopify.com/s/p/pull.jpg?v=2', 'https://cdn.shopify.com/s/p/pull_600x.jpg?v=3',
  ]).images;
  const out = dedupeImages(list);
  assert.equal(out.length, 3);
  assert.equal(out[0].url, 'https://cdn.example/images/c_fill,g_auto,w_1200,h_630,f_auto,q_auto/w_500,f_auto,q_auto/ab250e4e_9366/main_00.jpg', 'the main picture stays first, in its largest size');
  assert.equal(out[1].url, 'https://cdn.example/images/w_500,f_auto,q_auto/ab250e4e_9366/view_01.jpg');
  assert.equal(out[2].url, 'https://cdn.shopify.com/s/p/pull.jpg?v=2', 'the Shopify file without a size suffix is the original: it beats every sized rendition');
  assert.deepEqual(out.map((i) => i.position), [1, 2, 3]);
});

test('mergeImageSources: reliability order, union deduplicated, rejections per source', () => {
  const r = mergeImageSources([
    { source: 'dom', items: [`${CLOUD(320, 'a.jpg')} 320w, ${CLOUD(900, 'a.jpg')} 900w`, CLOUD(900, 'b.jpg'), 'https://cdn.example/images/e_trim:EAEEEF/c_lpad'] },
    { source: 'og', items: 'https://cdn.example/images/c_fill,w_1200,h_630/ab250e4e_9366/a.jpg' },
    { source: 'jsonld', items: [{ url: CLOUD(500, 'a.jpg') }, CLOUD(500, 'c.jpg')] },
  ], { base: 'https://shop.example/' });
  assert.deepEqual(imageUrls(r.images), ['https://cdn.example/images/c_fill,w_1200,h_630/ab250e4e_9366/a.jpg', CLOUD(500, 'c.jpg'), CLOUD(900, 'b.jpg')], 'JSON-LD order first (main picture), largest rendition, then the gallery');
  assert.equal(r.images[0].source, 'jsonld', 'the main picture keeps its most reliable source');
  assert.deepEqual(r.bySource, { jsonld: 2, og: 1, dom: 2 });
  assert.deepEqual(r.rejected, [{ source: 'dom', url: 'https://cdn.example/images/e_trim:EAEEEF/c_lpad', reason: 'transform_segment', label: 'adresse tronquée : elle s’arrête sur un segment de transformation' }]);
});

test('normalizeRowImages: a row list (strings, older rows) comes out absolute, deduplicated, with its rejections', () => {
  const r = normalizeRowImages(['/img/a_small.jpg', 'https://shop.example/img/a_large.jpg', 'https://shop.example/img/b.jpg?v=1', 'data:image/png;base64,AAA'], { base: 'https://shop.example/p/1' });
  assert.deepEqual(r.urls, ['https://shop.example/img/a_large.jpg', 'https://shop.example/img/b.jpg?v=1']);
  assert.equal(r.rejected.length, 1); assert.equal(r.rejected[0].reason, 'data_uri');
});
