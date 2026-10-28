/**
 * An honest job report for a "your browser" run whose product pages were only partly read: the rows whose
 * page the extension did not send (the « Fiches produit » limit, on a site only the user's browser reads)
 * are "to verify" with the fields they lack, the status is PARTIAL (never OK), the store is the site, the
 * pages read are counted, the rejected image addresses are listed with their reason. Offline: a temp data
 * dir, the site's profile says its pages are read by the extension only, so no request is ever attempted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { appDirs, ensureDirs } from '../../lib/osenv.mjs';
import { createController } from '../controller.mjs';

const ORIGIN = 'https://www.boutique-sport.test/fr/chaussures';
const CLOUD = (t, file) => `https://cdn.boutique-sport.test/images/e_trim:EAEEEF/c_lpad,w_iw,h_ih/${t}/ab250e4e_9366/${file}`;
const productPage = (id, name) => `<html><head><link rel="canonical" href="https://www.boutique-sport.test/fr/p/${id}">
  <script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name, sku: id, description: `Description longue de ${name}, avec ses matières et son histoire.`, brand: { '@type': 'Brand', name: 'Marque' }, image: [CLOUD('w_500,f_auto', `${id}_01.jpg`), CLOUD('w_500,f_auto', `${id}_02.jpg`)], offers: { '@type': 'Offer', price: 110, priceCurrency: 'EUR' } })}</script>
  </head><body><h1>${name}</h1></body></html>`;

function ctl() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'elo-ctl-partial-'));
  const dirs = ensureDirs(appDirs(base));
  // This site's product pages are read by the user's browser only (learned on a previous run): no HTTP, no local browser.
  fs.writeFileSync(path.join(dirs.data, 'domain-profiles.json'), JSON.stringify({ 'boutique-sport.test': { detailAccess: 'extension', detailAccessAt: '2026-10-26T00:00:00.000Z', runs: 1 } }));
  const events = [];
  const controller = createController({ dirs, emit: (t, p) => events.push({ t, p }) });
  return { controller, events, dirs };
}

const listed = (id, name, extra = {}) => ({ name, price: 110, currency: 'EUR', sku: id, sourceUrl: `https://www.boutique-sport.test/fr/p/${id}`, images: [CLOUD('w_180', `${id}_00_plp.jpg`)], category: 'Chaussures', ...extra });

test('a run with half its product pages unread is PARTIAL: those rows are to verify with the missing fields; store, pages read and notes are honest', async () => {
  const { controller, dirs } = ctl();
  const rendered = new Map([
    ['https://www.boutique-sport.test/fr/p/A1', productPage('A1', 'Chaussure Alpha')],
    ['https://www.boutique-sport.test/fr/p/A2', productPage('A2', 'Chaussure Beta')],
  ]);
  const r = await controller.ingestExternalProducts({
    origin: ORIGIN, lang: 'fr', method: 'your-browser', completeDetails: true, renderedPages: rendered,
    products: [listed('A1', 'Chaussure Alpha'), listed('A2', 'Chaussure Beta'), listed('A3', 'Chaussure Gamma', { images: ['https://cdn.boutique-sport.test/images/e_trim:EAEEEF/c_lpad', CLOUD('w_180', 'A3_00_plp.jpg')] }), listed('A4', 'Chaussure Delta')],
    details: { domain: 'boutique-sport.test', limits: { maxProducts: 4, maxListPages: 3, maxDetailPages: 2 }, counts: { products: 4, pages: 1, detailPages: 2, detailPagesSent: 2 } },
  });
  assert.equal(r.status, 'done', 'the job itself finished');
  assert.equal(r.counts.accepted, 2); assert.equal(r.counts.toVerify, 2);
  const rep = JSON.parse(fs.readFileSync(path.join(dirs.data, 'reports', `${r.jobId}.json`), 'utf8'));
  assert.equal(rep.status, 'PARTIAL', 'never OK when product pages failed');
  assert.equal(rep.store, 'boutique-sport.test', 'the site when the run named no store');
  assert.equal(rep.fetched, 3, '1 list page + 2 product pages the browser sent');
  assert.equal(rep.detailPages.completed, 2); assert.equal(rep.detailPages.failed, 2); assert.deepEqual(rep.detailPages.reasons, { needs_user_browser: 2 });
  assert.deepEqual(rep.partial, { toVerify: 2, pagesUnread: 2, reasons: { needs_user_browser: 2 } });
  // The rows: the completed ones carry their page's gallery (largest size, deduplicated), the unread ones say what they lack.
  const products = controller.jobProducts(r.jobId);
  const byId = Object.fromEntries(products.map((p) => [p.source_product_id, p]));
  assert.equal(byId.A1.status, 'accepted');
  const full = JSON.parse(fs.readFileSync(path.join(dirs.data, 'jobs', r.jobId, 'products.json'), 'utf8'));
  const a1 = full.find((p) => p.source_product_id === 'A1');
  assert.deepEqual(a1.images, [CLOUD('w_500,f_auto', 'A1_01.jpg'), CLOUD('w_500,f_auto', 'A1_02.jpg'), CLOUD('w_180', 'A1_00_plp.jpg')], 'gallery first, the listing thumbnail (another picture) kept, complete addresses');
  assert.ok(a1.description && a1.raw.brand === 'Marque');
  const a3 = full.find((p) => p.source_product_id === 'A3');
  assert.equal(a3.__eligibility.status, 'to_verify'); assert.equal(a3.__eligibility.code, 'to_verify_detail_unread');
  assert.match(a3.__eligibility.reason, /fiche produit non lue \(ce site ne laisse lire ses fiches que dans votre navigateur\) : champs manquants : description, marque, variantes, caractéristiques/);
  assert.deepEqual(a3.images, [CLOUD('w_180', 'A3_00_plp.jpg')], 'the truncated address is gone, the listing picture stays');
  // The store and the CSVs: accepted + to-verify files, the store slug filled.
  const csv = fs.readFileSync(r.csvPath, 'utf8');
  assert.equal(csv.trim().split('\n').length, 1 + 2);
  assert.ok(csv.includes(',boutique-sport.test,'), 'store_slug filled with the site');
  assert.ok(fs.existsSync(r.csvPath.replace(/\.csv$/, '-to-verify.csv')));
  // The rejected image address is in the report, with its reason; the text report says so too.
  assert.equal(rep.images.rejected, 1); assert.deepEqual(rep.images.byReason, { transform_segment: 1 });
  assert.equal(rep.images.samples[0].product, 'A3'); assert.match(rep.images.samples[0].label, /tronquée/);
  const txt = controller.jobReport(r.jobId).text;
  assert.match(txt, /status:\s+PARTIAL/);
  assert.match(txt, /partial:\s+2 product\(s\) to verify, 2 product page\(s\) unread \(needs_user_browser×2\)/);
  assert.match(txt, /images rejected:\s+1 — transform_segment×1/);
  assert.match(txt, /A3 : https:\/\/cdn\.boutique-sport\.test\/images\/e_trim:EAEEEF\/c_lpad \(adresse tronquée/);
  assert.ok(rep.notes.some((n) => /2 fiche\(s\) produit non lue\(s\).*limite « Fiches produit » \(2\) a été atteinte.*« à vérifier »/.test(n)), rep.notes.join('\n'));
});

test('a run whose every product page was read stays OK; a named store is kept', async () => {
  const { controller, dirs } = ctl();
  const rendered = new Map([['https://www.boutique-sport.test/fr/p/B1', productPage('B1', 'Chaussure Omega')]]);
  const r = await controller.ingestExternalProducts({ origin: ORIGIN, store: 'ma-boutique', lang: 'fr', completeDetails: true, renderedPages: rendered, products: [listed('B1', 'Chaussure Omega')], details: { domain: 'boutique-sport.test', counts: { pages: 1, detailPagesSent: 1 } } });
  const rep = JSON.parse(fs.readFileSync(path.join(dirs.data, 'reports', `${r.jobId}.json`), 'utf8'));
  assert.equal(rep.status, 'OK'); assert.equal(rep.store, 'ma-boutique'); assert.equal(rep.fetched, 2);
  assert.equal(rep.images.rejected, 0); assert.equal(r.counts.toVerify, 0);
});
