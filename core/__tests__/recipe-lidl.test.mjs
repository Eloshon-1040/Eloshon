/**
 * lidl.be internal_api recipe — offline. The recipe file is the contract (it is
 * exactly the recipes.internal_api jsonb the seed migration ships), so this test
 * pins its shape against the schema in internal-api.mjs and replays runRecipeLane
 * on a mocked httpGet serving 2 pages with the REAL live item structure
 * (captured 2026-09-25 from campaign a10103434).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runRecipeLane, resolveVars, estimateRecipeCost } from '../internal-api.mjs';
import { toNormalizedProduct } from '../normalize.mjs';

const recipe = JSON.parse(fs.readFileSync(new URL('../recipes/lidl-be.json', import.meta.url), 'utf8'));

const CAMPAIGN_URL = 'https://www.lidl.be/c/asc/nl-BE/herostage-nonfood-39-omni-krachtige-tools/a10103434';

/** One item exactly as the live API shapes it (trimmed to the mapped fields + known traps). */
function makeItem(i, { oldPrice = null } = {}) {
  return {
    resultClass: 'PRODUCT_RETAIL',
    code: String(100400000 + i),
    url: '', // always empty live — the recipe must not rely on it
    gridbox: {
      productId: 100400000 + i,
      data: {
        fullTitle: `Alleszuiger PARKSIDE® PWS${i}`,
        brand: { name: 'PARKSIDE®', id: 'PARK', url: '/q/search?q=parkside' },
        erpNumber: String(100400000 + i),
        canonicalPath: `/p/nl-BE/alleszuiger-parkside-pws${i}/p${100400000 + i}`,
        canonicalUrl: `/p/nl-BE/alleszuiger-parkside-pws${i}/p${100400000 + i}`, // relative too, live
        image: `https://www.lidl.be/assets/img${i}.jpg`,
        imageList: [`https://www.lidl.be/assets/img${i}.jpg`],
        cutoutimageV2: [], // always empty live — never mapped
        ians: ['500208'],  // Lidl IAN (6-9 digits), NOT an EAN — never mapped to gtin
        price: {
          currencyCode: 'EUR', currencySymbol: '€', hasVat: true,
          price: 79.99, ...(oldPrice != null ? { oldPrice, discount: '-20%' } : {}),
        },
        keyfacts: { supplementalDescription: `<ul><li>fact ${i}</li></ul>` },
        category: 'Assortiment/Klussen/Garage/Reiningsapparaten/Nat- en droogzuigers',
      },
    },
  };
}

test('lidl recipe file: shape matches the internal-api schema', () => {
  assert.equal(recipe.domain, 'lidl.be');
  assert.equal(recipe.type, 'internal_api');
  assert.equal(recipe.method, 'GET');
  // Endpoint carries every placeholder the replay fills.
  assert.ok(recipe.endpoint_tpl.startsWith('https://www.lidl.be/q/api/search?'));
  for (const ph of ['{campaign}', '{lang}', '{fetchsize}', '{offset}']) assert.ok(recipe.endpoint_tpl.includes(ph), `endpoint_tpl missing ${ph}`);
  assert.ok(recipe.endpoint_tpl.includes('automatedCampaign={campaign}'), 'automatedCampaign must reuse the campaign var');
  // Accept must stay */* — the API answers 406 to Accept: application/json.
  assert.equal(recipe.static_headers.Accept, '*/*');
  assert.equal(recipe.headers, undefined); // no dynamic headers, no cookies
  // Vars resolve from the pasted URL (free lane, no page fetch, no browser).
  assert.equal(recipe.vars.campaign.source, 'url');
  assert.equal(recipe.vars.lang.source, 'url');
  // Section support: a 2nd endpoint variant keyed by category.id (/s<ID>), with
  // both id vars OPTIONAL and mutually exclusive per URL; the campaign template
  // stays the base endpoint_tpl (back-compat).
  assert.equal(recipe.endpoint_variants.length, 2);
  assert.deepEqual(recipe.endpoint_variants.map((v) => v.require), ['campaign', 'categoryId']);
  assert.ok(recipe.endpoint_variants[1].endpoint_tpl.includes('category.id={categoryId}'), 'section variant uses category.id');
  assert.equal(recipe.vars.campaign.optional, true);
  assert.equal(recipe.vars.categoryId.source, 'url');
  assert.equal(recipe.vars.categoryId.optional, true);
  assert.equal(recipe.vars.lang.optional, undefined); // lang stays required
  const cost = estimateRecipeCost(recipe, {});
  assert.equal(cost.free, true);
  assert.equal(cost.bootstrap, 'none');
  // Pagination: offset/fetchsize, server caps ~60 per request so size must stay under.
  assert.deepEqual(recipe.pagination, { type: 'offset', param: 'offset', size_param: 'fetchsize', size: 48, start: 0, total_json_path: 'numFound' });
  assert.ok(recipe.pagination.size <= 60);
  assert.equal(recipe.json_path, 'items');
  // Exact live dot-paths.
  assert.deepEqual(recipe.field_map, {
    name: 'gridbox.data.fullTitle',
    price: 'gridbox.data.price.price',
    listPrice: 'gridbox.data.price.oldPrice',
    currency: 'gridbox.data.price.currencyCode',
    sku: 'gridbox.data.erpNumber',
    image: 'gridbox.data.image',
    url: 'gridbox.data.canonicalPath',
    brand: 'gridbox.data.brand.name',
    description: 'gridbox.data.keyfacts.supplementalDescription',
    category: 'gridbox.data.category',
    // Net quantity: the API's unit-price line ("500 g - 2,58 EUR/kg"); the normaliser keeps its quantity part.
    weightText: 'gridbox.data.price.basePrice.text',
  });
  // Known traps: cutoutimageV2 is always empty and ians are not EANs.
  for (const path of Object.values(recipe.field_map)) {
    assert.ok(!path.includes('cutoutimageV2'), 'cutoutimageV2 must never be mapped');
    assert.ok(!path.includes('ians'), 'ians are Lidl IANs, not EANs — must never be mapped');
  }
});

test('lidl recipe vars: campaign + lang extracted from the pasted URL', async () => {
  const nl = await resolveVars(recipe, CAMPAIGN_URL);
  assert.equal(nl.error, null);
  assert.equal(nl.needsBrowser, false);
  assert.deepEqual(nl.vars, { campaign: '10103434', lang: 'nl' });
  // /c/ (non-asc) campaign URLs carry the same a<ID> suffix.
  const fr = await resolveVars(recipe, 'https://www.lidl.be/c/fr-BE/promos-de-la-semaine/a10082242');
  assert.equal(fr.error, null);
  assert.deepEqual(fr.vars, { campaign: '10082242', lang: 'fr' });
  // Section URLs resolve categoryId (not campaign) + lang, no error.
  const section = await resolveVars(recipe, 'https://www.lidl.be/c/fr-BE/aliments-boissons/s10068374?offset=36');
  assert.equal(section.error, null);
  assert.deepEqual(section.vars, { categoryId: '10068374', lang: 'fr' });
  assert.equal(section.vars.campaign, undefined); // optional, absent on a section URL
  // campaign is now OPTIONAL (section URLs use categoryId), so a bare homepage —
  // no locale, no id — fails fast on the still-required lang var, not campaign.
  const home = await resolveVars(recipe, 'https://www.lidl.be/');
  assert.ok(home.error, 'a URL with neither locale nor id must fail fast, not replay');
  assert.match(home.error, /lang/);
});

test('lidl recipe replay: 2 real-shaped pages, full pagination, complete products', async () => {
  const TOTAL = 66; // page 1: 48 (== fetchsize), page 2: 18 (short page → stop)
  const all = Array.from({ length: TOTAL }, (_, i) => makeItem(i, i === 0 ? { oldPrice: 99.99 } : {}));
  const urls = [];
  const httpGet = async (url, { headers = {} } = {}) => {
    urls.push(url);
    assert.equal(headers.Accept, '*/*'); // the 406 guard must reach the wire
    const u = new URL(url);
    const offset = Number(u.searchParams.get('offset'));
    const size = Number(u.searchParams.get('fetchsize'));
    return { status: 200, body: { numFound: TOTAL, items: all.slice(offset, offset + size) } };
  };

  const out = await runRecipeLane(recipe, CAMPAIGN_URL, { httpGet });
  assert.equal(out.ok, true);
  assert.equal(out.error, null);
  assert.equal(out.usedBrowser, false);
  assert.equal(out.requests, 2);
  assert.equal(out.pages, 2);
  assert.equal(out.total, TOTAL);
  assert.equal(out.products.length, TOTAL);

  // The replay must rebuild the exact endpoint: locale from the URL's lang,
  // campaign twice, fetchsize/offset owned by the pagination loop.
  const first = new URL(urls[0]);
  assert.equal(first.searchParams.get('assortment'), 'BE');
  assert.equal(first.searchParams.get('locale'), 'nl_BE');
  assert.equal(first.searchParams.get('version'), 'v2.0.0');
  assert.equal(first.searchParams.get('campaign'), '10103434');
  assert.equal(first.searchParams.get('automatedCampaign'), '10103434');
  assert.equal(first.searchParams.get('fetchsize'), '48');
  assert.equal(first.searchParams.get('offset'), '0');
  assert.equal(new URL(urls[1]).searchParams.get('offset'), '48');

  // Field mapping on the real structure — promo item carries listPrice. The
  // singular field-map `image` is canonicalized to the RawProduct `images[]`
  // array (what normalize.mjs reads); `image` itself must not survive.
  assert.deepEqual(out.products[0], {
    strategy: 'internal-api',
    name: 'Alleszuiger PARKSIDE® PWS0',
    price: 79.99,
    listPrice: 99.99,
    currency: 'EUR',
    sku: '100400000',
    images: ['https://www.lidl.be/assets/img0.jpg'],
    url: '/p/nl-BE/alleszuiger-parkside-pws0/p100400000',
    brand: 'PARKSIDE®',
    description: '<ul><li>fact 0</li></ul>',
    category: 'Assortiment/Klussen/Garage/Reiningsapparaten/Nat- en droogzuigers',
  });
  assert.equal(out.products[0].image, undefined, 'singular `image` must be dropped in favour of images[]');
  // Non-promo item: no oldPrice live → mapItem must simply omit listPrice.
  assert.equal(out.products[1].listPrice, undefined);
  assert.equal(out.products[1].price, 79.99);
  // Every product is complete (mirrors the live acceptance bar).
  for (const p of out.products) {
    assert.ok(p.name && typeof p.price === 'number' && p.images && p.images.length && p.url, 'incomplete product');
    assert.ok(p.url.startsWith('/p/'), 'url must be the site-relative canonicalPath');
  }
});

test('lidl recipe → normalize: image_url is filled from the mapped image (img-fill regression)', async () => {
  // The Lidl img 0% regression was a mapItem/normalize contract mismatch: mapItem
  // produced a singular `image`, but toNormalizedProduct only reads `images[]`, so
  // image_url normalized to null even though the API returns a real URL. This pins
  // the WHOLE lane → normalize path so a per-field mapItem check can't hide it again.
  const httpGet = async () => ({ status: 200, body: { numFound: 1, items: [makeItem(0)] } });
  const out = await runRecipeLane(recipe, CAMPAIGN_URL, { httpGet });
  assert.equal(out.ok, true);
  const np = toNormalizedProduct(out.products[0], { storeSlug: 'lidl', lang: 'fr' });
  assert.equal(np.image_url, 'https://www.lidl.be/assets/img0.jpg', 'image_url must be the real API image, not null');
});

test('lidl recipe replay: fr-BE URL drives locale=fr_BE on the wire', async () => {
  const urls = [];
  const httpGet = async (url) => { urls.push(url); return { status: 200, body: { numFound: 1, items: [makeItem(0)] } }; };
  const out = await runRecipeLane(recipe, 'https://www.lidl.be/c/fr-BE/promos-de-la-semaine/a10082242', { httpGet });
  assert.equal(out.ok, true);
  assert.equal(new URL(urls[0]).searchParams.get('locale'), 'fr_BE');
  assert.equal(new URL(urls[0]).searchParams.get('campaign'), '10082242');
});

// ── section-style /s<ID> support (category.id variant) ──────────────────────
const SECTION_URL = 'https://www.lidl.be/c/fr-BE/aliments-boissons/s10068374?offset=36';

test('lidl recipe (section /s<ID>): category.id endpoint, real item shape, full pagination', async () => {
  const TOTAL = 60; // page 1: 48 (== fetchsize), page 2: 12 (short → stop)
  const all = Array.from({ length: TOTAL }, (_, i) => makeItem(i));
  const urls = [];
  const httpGet = async (url, { headers = {} } = {}) => {
    urls.push(url);
    assert.equal(headers.Accept, '*/*');
    const u = new URL(url);
    const offset = Number(u.searchParams.get('offset'));
    const size = Number(u.searchParams.get('fetchsize'));
    return { status: 200, body: { numFound: TOTAL, items: all.slice(offset, offset + size) } };
  };
  const out = await runRecipeLane(recipe, SECTION_URL, { httpGet });
  assert.equal(out.ok, true);
  assert.equal(out.error, null);
  assert.equal(out.usedBrowser, false);
  assert.equal(out.total, TOTAL);
  assert.equal(out.products.length, TOTAL);
  assert.equal(out.pages, 2);
  // The category.id variant fired — never the campaign one — with the URL's locale.
  assert.ok(urls.every((u) => u.includes('category.id=10068374')), 'section run must use category.id');
  assert.ok(urls.every((u) => !u.includes('campaign=')), 'section run must not send campaign');
  assert.ok(urls.every((u) => new URL(u).searchParams.get('locale') === 'fr_BE'), 'locale preserved');
  // Existing field_map applies unchanged.
  assert.equal(out.products[0].name, 'Alleszuiger PARKSIDE® PWS0');
  assert.equal(out.products[0].price, 79.99);
  assert.ok(out.products[0].url.startsWith('/p/'));
});

test('lidl recipe (campaign /a<ID>): campaign endpoint preserved, never category.id', async () => {
  const urls = [];
  const httpGet = async (url) => {
    urls.push(url);
    const u = new URL(url);
    const offset = Number(u.searchParams.get('offset'));
    const size = Number(u.searchParams.get('fetchsize'));
    return { status: 200, body: { numFound: 2, items: [makeItem(0), makeItem(1)].slice(offset, offset + size) } };
  };
  const out = await runRecipeLane(recipe, CAMPAIGN_URL, { httpGet });
  assert.equal(out.ok, true);
  assert.ok(urls.every((u) => u.includes('campaign=10103434') && u.includes('automatedCampaign=10103434')), 'campaign params present');
  assert.ok(urls.every((u) => !u.includes('category.id=')), 'campaign URL must not use category.id');
});

test('lidl recipe (nav/service section): an empty API response is a clean no-products result, not a crash', async () => {
  const NAV_URL = 'https://www.lidl.be/c/fr-BE/abonner/s10008105'; // "Newsletter" — a nav/service hub, no catalogue
  const urls = [];
  const httpGet = async (url) => { urls.push(url); return { status: 200, body: { type: 'empty', resultType: 'empty' } }; }; // no items[]
  const out = await runRecipeLane(recipe, NAV_URL, { httpGet });
  assert.ok(urls.every((u) => u.includes('category.id=10008105')), 'nav section still routes via category.id');
  assert.equal(out.ok, false);          // no products
  assert.equal(out.products.length, 0);
  assert.equal(out.error, null);        // empty is expected for a nav hub — not an error
});
