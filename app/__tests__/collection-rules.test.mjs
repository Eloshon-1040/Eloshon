/**
 * Collection rules in the app (28/10): a product whose own page classes it elsewhere is « à vérifier », never imported
 * as part of the collection; a product already recorded from another list page of the site is kept and listed; the
 * cards the learned card left out and the sub-collections of a hub are in the job's report; the learned card is kept
 * in the site's profile. Offline: a real controller in a temp folder.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appDirs, ensureDirs } from '../../lib/osenv.mjs';
import { createController } from '../controller.mjs';
import { handlePanelRequest, listRejected, hubRead } from '../your-browser/panel-requests.mjs';

const LED = 'https://marshydro.eu/collections/led-grow-light-fr/?lang=fr';
const H = 'https://www.adidas.be/fr/chaussures-hommes'; const F = 'https://www.adidas.be/fr/chaussures-femmes';
function boot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-coll-'));
  const dirs = ensureDirs(appDirs(root));
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1, recovery: false, sideData: { enabled: false } }));
  return { dirs, ctl: createController({ dirs, emit: () => {} }) };
}
const productsOf = (dirs, jobId) => JSON.parse(fs.readFileSync(path.join(dirs.jobs, jobId, 'products.json'), 'utf8'));
const reportOf = (dirs, jobId) => JSON.parse(fs.readFileSync(path.join(dirs.jobs, jobId, 'job.json'), 'utf8')).report;
const p = (slug, crumb, extra = {}) => ({ name: `Mars Hydro ${slug}`, price: 199, currency: 'EUR', sourceUrl: `https://marshydro.eu/products/${slug}/?lang=fr`, images: [`https://i.test/${slug}.jpg`], ...(crumb ? { breadcrumb: crumb } : {}), ...extra });

test('a product classed elsewhere by its own page is « à vérifier » with the reason; no breadcrumb, no verdict', async () => {
  const { dirs, ctl } = boot();
  const res = await ctl.ingestExternalProducts({
    origin: LED, method: 'your-browser', listing: { trail: ['Accueil', 'Lampe de culture LED'] },
    products: [p('fc-e3000', ['Accueil', 'Lampes de culture LED', 'Série FC-E']), p('tente-60x60', ['Accueil', 'Kits de tentes de culture']), p('ts-1000', null)],
  });
  const prods = productsOf(dirs, res.jobId);
  const st = Object.fromEntries(prods.map((x) => [x.source_url.split('/')[4], x.__eligibility.status]));
  assert.deepEqual(st, { 'fc-e3000': 'accepted', 'tente-60x60': 'to_verify', 'ts-1000': 'accepted' });
  assert.equal(prods.find((x) => /tente/.test(x.source_url)).__eligibility.code, 'to_verify_out_of_collection');
  const rep = reportOf(dirs, res.jobId);
  assert.equal(rep.outOfCollection.count, 1); assert.match(rep.outOfCollection.list[0].reason, /Kits de tentes de culture/);
});

test('a hub\'s sub-collection is the expected collection of its products', async () => {
  const { dirs, ctl } = boot();
  const res = await ctl.ingestExternalProducts({ origin: LED, method: 'your-browser', listing: { trail: [] }, products: [p('fc-e3000', ['Série FC-E'], { subCollection: 'FC-E Série - LED Bridgelux USA' }), p('vg-80', ['Série VG'], { subCollection: 'FC-E Série - LED Bridgelux USA' })] });
  assert.deepEqual(productsOf(dirs, res.jobId).map((x) => x.__eligibility.status), ['accepted', 'to_verify']);
});

test('the same product from two list pages of the site (a unisex shoe): kept in both, listed with the other batch', async () => {
  const { dirs, ctl } = boot();
  const shoe = { name: 'Samba OG', price: 120, sourceUrl: 'https://www.adidas.be/fr/samba-og/B75806.html', images: ['https://i.test/s.jpg'] };
  await ctl.ingestExternalProducts({ origin: H, method: 'your-browser', products: [shoe, { ...shoe, name: 'Gazelle', sourceUrl: 'https://www.adidas.be/fr/gazelle/BB5476.html' }] });
  const women = await ctl.ingestExternalProducts({ origin: F, method: 'your-browser', products: [shoe] });
  assert.equal(productsOf(dirs, women.jobId).length, 1, 'kept: it belongs to this list too');
  const rep = reportOf(dirs, women.jobId);
  assert.equal(rep.crossBatch.count, 1); assert.deepEqual(rep.crossBatch.list[0].alsoIn, ['adidas / chaussures-hommes']);
  const again = await ctl.ingestExternalProducts({ origin: `${H}?start=48`, method: 'your-browser', products: [{ ...shoe, name: 'Gazelle', sourceUrl: 'https://www.adidas.be/fr/gazelle/BB5476.html' }] });
  assert.equal(reportOf(dirs, again.jobId).crossBatch, undefined, 'page 2 of the same list is the same batch');
});

test('the rejected cards and the hub\'s sub-collections are kept in the report; the learned card in the site\'s profile', async () => {
  const lr = listRejected({ count: 3, byReason: { outside_list: 2, no_price: 1, evil: 9 }, list: [{ reason: 'outside_list', name: 'Menu', url: 'https://s.test/products/m' }, { reason: 'hack', name: 'x' }] });
  assert.deepEqual(lr.byReason, { outside_list: 2, no_price: 1 }); assert.equal(lr.list.length, 1); assert.match(lr.list[0].label, /hors de la liste/);
  assert.deepEqual(hubRead([{ name: 'Série FC', url: 'https://marshydro.eu/collections/fc/', rows: 4, stoppedBy: 'no_new' }, { name: 'x', url: 'javascript:alert(1)' }]), [{ name: 'Série FC', url: 'https://marshydro.eu/collections/fc/', rows: 4, stoppedBy: 'no_new' }]);
  const { ctl } = boot();
  const model = { card: 'div.product-grid-item.wd-with-labels', scopes: ['section.x'], linkShape: '/products/*', needs: { title: true, price: true }, fields: { name: { selector: 'h3' } }, negatives: [{ name: 'soldes', classes: [], zone: null }] };
  const set = await handlePanelRequest({ op: 'card_model', action: 'set', url: LED, model }, { controller: ctl });
  assert.equal(set.ok, true);
  const got = await handlePanelRequest({ op: 'card_model', action: 'get', url: 'https://marshydro.eu/collections/fc-e-series-led-fr/' }, { controller: ctl });
  assert.equal(got.model.card, model.card, 'one card for the whole site');
  assert.equal((await handlePanelRequest({ op: 'card_model', action: 'set', url: LED, model: { card: '' } }, { controller: ctl })).ok, false);
});
