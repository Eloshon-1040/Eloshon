/**
 * Video metadata read by shape — JSON-LD VideoObject (standalone, ItemList), a video
 * sitemap, Open Graph, the page's player, repeated cards in the markup — with dedup by
 * page URL (never by title) and NO personal data (a Person author, an uploader, a
 * profile link, an avatar are never read). Hand-made, fictitious fixtures; no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractVideoPage, extractVideoCards, videoCardsFromDom, videoLinks, parseVideoSitemap, videoCardFromSitemapEntry,
  parseDuration, formatDuration, parseCount, parseDate, videoIdFromUrl, normalizeVideoUrl, isVideoLink, isVideoListingLink, hasVideoSignals,
} from '../extract/video.mjs';
import { detectContentType } from '../content/detect.mjs';

const BASE = 'https://videos.test/videos/recent';
const card = (id, title, dur, extra = '') => `<article class="card"><a href="/w/${id}"><img src="/thumbs/${id}.jpg" alt="${title}"></a><h3><a href="/w/${id}" title="${title}">${title}</a></h3><span class="duration">${dur}</span>${extra}</article>`;
const grid = (cards) => `<!doctype html><html><head><title>Recent</title></head><body><nav><a href="/videos/trending">Tendances</a><a href="/u/jane"><img src="/avatars/jane.png" alt="avatar"></a></nav><main>${cards.join('\n')}</main><a rel="next" href="/videos/recent?page=2">Suivant</a></body></html>`;
const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
const videoObject = (id, extra = {}) => ({
  '@context': 'https://schema.org', '@type': 'VideoObject', name: `Conférence ${id}`, description: `Résumé de la conférence ${id}.`,
  thumbnailUrl: `https://cdn.videos.test/${id}.jpg`, uploadDate: '2026-09-01T10:00:00+02:00', duration: 'PT1H2M3S',
  url: `https://videos.test/w/${id}`, embedUrl: `https://videos.test/embed/${id}`,
  interactionStatistic: { '@type': 'InteractionCounter', interactionType: { '@type': 'WatchAction' }, userInteractionCount: 12345 },
  publisher: { '@type': 'Organization', name: 'Chaîne Test' },
  author: { '@type': 'Person', name: 'Jean Dupont', url: 'https://videos.test/u/jean' },
  keywords: 'sécurité, réseau, conférence', ...extra,
});

test('repeated cards: thumbnail + title + duration + link → one card per page URL, never by title', () => {
  const html = grid([
    card('v1', 'Ouverture', '12:34'), card('v2', 'Atelier réseau', '45:01'), card('v3', 'Table ronde', '1:02:03'),
    card('v3', 'Table ronde (rediffusion)', '1:02:03'),   // same page URL, another title → merged
    card('v4', 'Clôture', '8:09'), card('v5', 'Ouverture', '9:10'),  // same title as v1, another URL → kept
  ]);
  const { cards } = extractVideoCards(html, BASE);
  assert.equal(cards.length, 5);
  assert.deepEqual(cards.map((c) => c.canonicalUrl), ['https://videos.test/w/v1', 'https://videos.test/w/v2', 'https://videos.test/w/v3', 'https://videos.test/w/v4', 'https://videos.test/w/v5']);
  assert.equal(cards[0].name, 'Ouverture'); assert.equal(cards[0].images[0], 'https://videos.test/thumbs/v1.jpg');
  assert.equal(cards[0].columns.duration, '12:34'); assert.equal(cards[2].columns.duration, '1:02:03');
  assert.equal(cards[0].price, null); assert.equal(cards[0].sku, 'v1'); assert.equal(cards[0].contentType, 'video');
  // The profile link and the avatar in the navigation are never a card.
  assert.ok(!cards.some((c) => /\/u\//.test(c.canonicalUrl)));
  assert.ok(!JSON.stringify(cards).includes('avatar'));
  // Video-page links of the page, deduplicated by normalised URL.
  assert.equal(videoLinks(html, BASE).length, 5);
});

test('a carousel: two rows of cards under two sections are one list', () => {
  const html = `<html><body><section><h2>Nouveautés</h2>${card('a1', 'Un', '1:00')}${card('a2', 'Deux', '2:00')}${card('a3', 'Trois', '3:00')}</section><section><h2>Populaires</h2>${card('b1', 'Quatre', '4:00')}${card('b2', 'Cinq', '5:00')}${card('b3', 'Six', '6:00')}</section></body></html>`;
  assert.equal(extractVideoCards(html, BASE).cards.length, 6);
  assert.equal(videoCardsFromDom(html, BASE).length, 6);
});

test('JSON-LD VideoObject page: title, description, thumbnail, duration, views, date, embed, channel, tags — never the Person author', () => {
  const html = `<html><head><title>Conférence v9 — Site</title>${ld(videoObject('v9'))}</head><body><h1>Conférence v9</h1></body></html>`;
  const v = extractVideoPage(html, 'https://videos.test/w/v9');
  assert.ok(v);
  assert.equal(v.strategy, 'video-jsonld');
  assert.equal(v.name, 'Conférence v9'); assert.equal(v.description, 'Résumé de la conférence v9.');
  assert.deepEqual(v.images, ['https://cdn.videos.test/v9.jpg']);
  assert.equal(v.canonicalUrl, 'https://videos.test/w/v9'); assert.equal(v.sku, 'v9');
  assert.deepEqual(v.columns, { duration: '1:02:03', views: '12345', published_at: '2026-09-01', embed_url: 'https://videos.test/embed/v9', tags: 'sécurité, réseau, conférence' });
  assert.equal(v.category, 'Chaîne Test');
  assert.ok(!JSON.stringify(v).includes('Dupont') && !JSON.stringify(v).includes('/u/jean'), 'a Person author is never read');
  assert.equal(v.price, null);
});

test('JSON-LD ItemList of VideoObjects → every item, deduplicated by URL; a page with several videos and none of its own is not a video page', () => {
  const list = { '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: [1, 2, 3].map((i) => ({ '@type': 'ListItem', position: i, item: videoObject(`i${i}`) })) };
  const html = `<html><head>${ld(list)}</head><body></body></html>`;
  const { cards } = extractVideoCards(html, BASE);
  assert.equal(cards.length, 3);
  assert.deepEqual(cards.map((c) => c.name), ['Conférence i1', 'Conférence i2', 'Conférence i3']);
  assert.ok(!JSON.stringify(cards).includes('Dupont'));
  assert.equal(extractVideoPage(html, BASE), null, 'a list page has no video of its own');
});

test('video sitemap: entries with title, thumbnail, duration, date, player, views, tags — the uploader and the media file are not read', () => {
  const xml = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">
    <url><loc>https://videos.test/w/s1</loc><video:video><video:thumbnail_loc>https://cdn.videos.test/s1.jpg</video:thumbnail_loc><video:title><![CDATA[Séance plénière]]></video:title><video:description>Ouverture des travaux.</video:description><video:content_loc>https://cdn.videos.test/s1.mp4</video:content_loc><video:player_loc>https://videos.test/embed/s1</video:player_loc><video:duration>754</video:duration><video:publication_date>2026-08-30T09:00:00+02:00</video:publication_date><video:view_count>980</video:view_count><video:uploader info="https://videos.test/u/marie">Marie Martin</video:uploader><video:tag>plénière</video:tag><video:tag>2026</video:tag><video:category>Assemblées</video:category></video:video></url>
    <url><loc>https://videos.test/w/s2</loc><video:video><video:title>Atelier</video:title><video:thumbnail_loc>https://cdn.videos.test/s2.jpg</video:thumbnail_loc><video:duration>61</video:duration></video:video></url>
    <url><loc>https://videos.test/about</loc></url>
  </urlset>`;
  const entries = parseVideoSitemap(xml);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, 'Séance plénière'); assert.equal(entries[0].embed, 'https://videos.test/embed/s1');
  assert.ok(!('uploader' in entries[0]) && !JSON.stringify(entries).includes('Marie Martin') && !JSON.stringify(entries).includes('.mp4'));
  const c = videoCardFromSitemapEntry(entries[0]);
  assert.equal(c.strategy, 'video-sitemap'); assert.equal(c.canonicalUrl, 'https://videos.test/w/s1');
  assert.deepEqual(c.columns, { duration: '12:34', views: '980', published_at: '2026-08-30', embed_url: 'https://videos.test/embed/s1', tags: 'plénière, 2026' });
  assert.deepEqual(c.breadcrumb, ['Assemblées']);
});

test('Open Graph only, microdata, and the page player: read as gap-fillers, in that order of trust', () => {
  const og = `<html><head><title>Clip — Site</title><meta property="og:type" content="video.other"><meta property="og:title" content="Clip du festival"><meta property="og:description" content="Deux minutes de festival."><meta property="og:image" content="https://cdn.videos.test/og.jpg"><meta property="og:url" content="https://videos.test/w/og1"><meta property="og:video" content="https://videos.test/embed/og1"><meta property="video:duration" content="125"><meta property="video:release_date" content="2026-07-14"></head><body></body></html>`;
  const v = extractVideoPage(og, 'https://videos.test/w/og1?utm_source=x');
  assert.equal(v.strategy, 'video-meta'); assert.equal(v.name, 'Clip du festival');
  assert.deepEqual(v.columns, { duration: '2:05', published_at: '2026-07-14', embed_url: 'https://videos.test/embed/og1' });
  const player = `<html><head><title>Lecture</title><meta name="description" content="Captation intégrale."></head><body><h1>Captation du concert</h1><video poster="/poster.jpg" controls><source src="/media/concert.mp4" type="video/mp4"></video></body></html>`;
  const p = extractVideoPage(player, 'https://videos.test/w/p1');
  assert.equal(p.strategy, 'video-dom'); assert.equal(p.name, 'Captation du concert'); assert.deepEqual(p.images, ['https://videos.test/poster.jpg']);
  assert.equal(p.columns, undefined, 'the media file is never an embed URL');
  assert.ok(hasVideoSignals(player) && hasVideoSignals(og) && !hasVideoSignals('<html><body><p>Bonjour</p></body></html>'));
  const noVideo = `<html><head><title>Boutique</title></head><body><h1>Chaussures</h1><p>29,90 €</p></body></html>`;
  assert.equal(extractVideoPage(noVideo, 'https://shop.test/p/1'), null);
});

test('content type recognition: a video list and a video page read as videos; a shop page and a mixed page with prices read as products', () => {
  const list = grid([card('v1', 'Un', '1:00'), card('v2', 'Deux', '2:00'), card('v3', 'Trois', '3:00'), card('v4', 'Quatre', '4:00')]);
  assert.equal(detectContentType(list, BASE).type, 'video');
  const page = `<html><head>${ld(videoObject('v9'))}</head><body></body></html>`;
  assert.equal(detectContentType(page, 'https://videos.test/w/v9').type, 'video');
  const shop = `<html><head>${ld({ '@type': 'Product', name: 'Chaussure', offers: { '@type': 'Offer', price: 59.9, priceCurrency: 'EUR' } })}</head><body><ul>${[1, 2, 3, 4, 5, 6].map((i) => `<li><a href="/product/c${i}">Chaussure ${i}</a> <b>${50 + i},90 €</b> <button class="add-to-cart">Ajouter au panier</button></li>`).join('')}</ul><iframe src="https://videos.test/embed/promo"></iframe></body></html>`;
  const d = detectContentType(shop, 'https://shop.test/c/chaussures');
  assert.equal(d.type, 'product');
  assert.ok(d.scores.product > d.scores.video);
  assert.equal(detectContentType('<html><body><p>Bonjour</p></body></html>', 'https://x.test/').type, null);
});

test('values: durations, counts, dates, URL ids and shapes', () => {
  assert.equal(parseDuration('PT1H2M3S'), 3723); assert.equal(parseDuration('PT12M'), 720); assert.equal(parseDuration('1:02:03'), 3723);
  assert.equal(parseDuration('12:34'), 754); assert.equal(parseDuration(754), 754); assert.equal(parseDuration('1 h 02 min'), 3720); assert.equal(parseDuration('PT0S'), null); assert.equal(parseDuration('abc'), null);
  assert.equal(formatDuration(754), '12:34'); assert.equal(formatDuration(3723), '1:02:03'); assert.equal(formatDuration(0), null);
  assert.equal(parseCount('1 234 vues'), 1234); assert.equal(parseCount('12 k'), 12000); assert.equal(parseCount('1.2M'), 1200000); assert.equal(parseCount(''), null);
  assert.equal(parseDate('2026-09-01T23:30:00-05:00'), '2026-09-01'); assert.equal(parseDate('nope'), null);
  assert.equal(videoIdFromUrl('https://videos.test/watch?v=abc123&t=10'), 'abc123');
  assert.equal(videoIdFromUrl('https://videos.test/videos/watch/9f0e-uuid'), '9f0e-uuid');
  assert.equal(videoIdFromUrl('https://videos.test/v/slug-title/'), 'slug-title');
  assert.equal(videoIdFromUrl('https://videos.test/videos/'), null);
  assert.equal(normalizeVideoUrl('https://WWW.videos.test/w/v1/?utm_source=a&t=12#x'), 'https://videos.test/w/v1');
  for (const u of ['https://x.test/watch?v=abc', 'https://x.test/videos/my-talk', 'https://x.test/v/abc1', 'https://x.test/w/9f0e', 'https://x.test/episode/s01e02']) assert.ok(isVideoLink(u), u);
  for (const u of ['https://x.test/videos/', 'https://x.test/videos/trending', 'https://x.test/videos/page/2', 'https://x.test/product/shoe', 'https://x.test/c/shoes']) assert.ok(!isVideoLink(u), u);
  for (const u of ['https://x.test/videos/trending', 'https://x.test/channel/abc', 'https://x.test/playlist/xyz', 'https://x.test/c/38c3', 'https://x.test/tags/security']) assert.ok(isVideoListingLink(u), u);
  assert.ok(!isVideoListingLink('https://x.test/w/9f0e'));
});
