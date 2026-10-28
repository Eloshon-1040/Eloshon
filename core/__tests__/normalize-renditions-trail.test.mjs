/**
 * Output quality seen on a real shop: the same picture listed in two sizes, a
 * breadcrumb carrying HTML entities and ending with the product itself, a panel row
 * whose "link" is a picture. Offline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeRenditions, categoryPath, toNormalizedProduct } from '../normalize.mjs';
import { tidyTrail } from '../../shared/extract/listing-trail.mjs';
import { sanitizeRow } from '../../app/your-browser/panel-requests.mjs';
import { nextPageUrl } from '../../shared/extract/paginate-url.mjs';
import { samePagePagination } from '../discover.mjs';

test('one URL per picture, in its largest size, different pictures kept', () => {
  assert.deepEqual(dedupeRenditions([
    'https://shop.test/1625-home_default/vents.jpg', 'https://shop.test/1625-large_default/vents.jpg', 'https://shop.test/1626-large_default/vents.jpg',
  ]), ['https://shop.test/1625-large_default/vents.jpg', 'https://shop.test/1626-large_default/vents.jpg']);
  const distinct = ['https://cdn.test/products/1/s00/424x424/origin.webp', 'https://cdn.test/products/1/s01/424x424/origin.webp'];
  assert.deepEqual(dedupeRenditions(distinct), distinct, 'two photos of one product are two pictures');
  assert.deepEqual(dedupeRenditions(['https://cdn.test/a.jpg', 'https://cdn.test/a.jpg']), ['https://cdn.test/a.jpg']);
});

test('the category trail: entities decoded, the product itself dropped', () => {
  assert.deepEqual(tidyTrail(['Accueil', 'Extracteurs d&#039;air', 'Pots &amp; bacs'], 'https://shop.test/x'), ["Extracteurs d'air", 'Pots & bacs']);
  assert.equal(categoryPath(['Accueil', 'Ventilation', 'Extracteurs Vents', 'Vents VK 125'], null, 'https://shop.test/x', 'Vents VK 125'), 'Ventilation > Extracteurs Vents');
  // The card's category read from the listing URL repeats the page's trail: not appended again.
  assert.equal(categoryPath(['Jardin, terrasse & extérieur', 'Salons & meubles de jardin', 'Salons de jardin', 'En angle'],
    'jardin terrasse exterieur > salons meubles de jardin > salons de jardin'), 'Jardin, terrasse & extérieur > Salons & meubles de jardin > Salons de jardin > En angle');
  assert.equal(categoryPath(['Homme'], 'Homme > Chaussures'), 'Homme > Chaussures');
  const np = toNormalizedProduct({ name: 'Vents VK 125', price: 72.9, breadcrumb: ['Accueil', 'Ventilation', 'Extracteurs d&#039;air', 'Vents VK 125'],
    images: ['https://shop.test/1625-home_default/v.jpg', 'https://shop.test/1625-large_default/v.jpg'], sourceUrl: 'https://shop.test/v.html' });
  assert.equal(np.source_category, "Ventilation > Extracteurs d'air");
  assert.deepEqual(np.images, ['https://shop.test/1625-large_default/v.jpg']);
  assert.equal(np.image_url, 'https://shop.test/1625-large_default/v.jpg');
});

test('a panel row whose link is a picture: the picture becomes its image, never its page', () => {
  const r = sanitizeRow({ name: 'Salons de jardin', url: 'https://cdn.test/products/10141437/s00/424x424/origin.webp' });
  assert.equal(r.sourceUrl, undefined);
  assert.deepEqual(r.images, ['https://cdn.test/products/10141437/s00/424x424/origin.webp']);
  const ok = sanitizeRow({ name: 'Salon', url: 'https://shop.test/fr/salon/10141429' });
  assert.equal(ok.sourceUrl, 'https://shop.test/fr/salon/10141429');
});

test('a page-number parameter of any name', () => {
  assert.equal(samePagePagination('https://shop.test/fr/salons/ga086/?currentPage=2', 'https://shop.test/fr/salons/ga086/'), true);
  assert.equal(samePagePagination('https://shop.test/fr/salons/ga086/?pageSize=48', 'https://shop.test/fr/salons/ga086/'), false);
  assert.equal(samePagePagination('https://shop.test/fr/abris/?currentPage=2', 'https://shop.test/fr/salons/'), false);
  assert.equal(nextPageUrl('https://shop.test/x/?currentPage=2&pageSize=24'), 'https://shop.test/x/?currentPage=3&pageSize=24');
});

test('the columns added in the panel reach products.json (raw.columns)', () => {
  const row = sanitizeRow({ name: 'Chambre · Charleroi', price: 116, url: 'https://rent.test/rooms/1', ville: 'Charleroi', tailles: '28 | 29 | 30' });
  assert.deepEqual(row.columns, { ville: 'Charleroi', tailles: '28 | 29 | 30' });
  const np = toNormalizedProduct(row);
  assert.deepEqual(np.raw.columns, { ville: 'Charleroi', tailles: '28 | 29 | 30' });
  assert.equal(toNormalizedProduct({ name: 'X', price: 1 }).raw.columns, undefined, 'absent on the other lanes');
});

test('panel rows: availability, category, rating are fields, not free columns', () => {
  const row = sanitizeRow({ name: 'Terra Grow', price: 11.5, url: 'https://shop.test/p/1', availability: 'InStock', category: 'Engrais terre', rating: 4.5, reviewCount: 12, ville: 'x' });
  assert.deepEqual(row.columns, { ville: 'x' });
  assert.equal(row.availability, 'InStock'); assert.equal(row.category, 'Engrais terre'); assert.equal(row.rating, 4.5); assert.equal(row.reviewCount, 12);
});
