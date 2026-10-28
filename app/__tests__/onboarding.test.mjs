/**
 * A NEW SITE, no developer: the first run builds the site's rules from the product pages it read — what
 * the pages declare, the generic detection located back in the page, then ONE call to the app's AI for
 * what is still missing — each rule checked on several product pages, saved. The report says, per field,
 * found / missing, the strategy and the confidence, and the AI calls. The second run replays the rules:
 * no discovery, no AI call. Offline (map-backed fetcher, fake model).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appDirs, ensureDirs } from '../../lib/osenv.mjs';
import { createController } from '../controller.mjs';
import { handlePanelRequest } from '../your-browser/panel-requests.mjs';
import { createKnowledgeService } from '../knowledge-service.mjs';
import { createProfileStore } from '../../core/domain-profile.mjs';

const ORIGIN = 'https://www.nouvelle.test';
const LIST = `${ORIGIN}/thes`;
const IDS = ['a', 'b', 'c'];
const urlOf = (id) => `${ORIGIN}/p/the-${id}`;
// A product page: name + price + brand + sku DECLARED (JSON-LD); description only in the markup; the
// options (sachets) only as buttons — what the declared data and the detection cannot give.
const pageOf = (id) => `<html><head><title>Thé ${id}</title><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: `Thé vert ${id.toUpperCase()}`, sku: `TV-${id}`, brand: { '@type': 'Brand', name: 'Jardin d’Orient' }, offers: { '@type': 'Offer', price: String(8 + IDS.indexOf(id)), priceCurrency: 'EUR', availability: 'https://schema.org/InStock' } })}</script></head><body>
  <h1>Thé vert ${id.toUpperCase()}</h1><div class="prix">${8 + IDS.indexOf(id)},00 €</div>
  <section class="fiche"><h2>Description</h2><div class="texte"><p>Un thé vert de printemps, récolté à la main, aux notes fraîches et légèrement iodées (lot ${id}).</p><p>Infusion : 3 minutes à 80 °C.</p></div></section>
  <div class="formats"><button class="fmt">20 sachets</button><button class="fmt">50 sachets</button></div></body></html>`;

class MapFetcher {
  constructor(map) { this.map = map; this.calls = []; this.userAgent = 't'; this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; }
  async get(u) { this.calls.push(u); const body = this.map[u]; if (body == null) return { ok: false, status: 404, url: u, body: '', blocked: false }; return { ok: true, status: 200, url: u, contentType: 'text/html', kind: 'html', body, blocked: false, headers: {} }; }
  async getText(u) { return this.get(u); }
}
const reportOf = (dirs, jobId) => JSON.parse(fs.readFileSync(path.join(dirs.data, 'reports', `${jobId}.json`), 'utf8'));

test('first run on a site no one taught: its rules are learned from the pages it read (no AI key: declared + detection only); the second run replays them with 0 AI call', async () => {
  const site = Object.fromEntries(IDS.map((id) => [urlOf(id), pageOf(id)]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-onboard-'));
  const dirs = ensureDirs(appDirs(root));
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1, recovery: false, sideData: { enabled: false } }));
  const fetcher = new MapFetcher(site);
  const ctl = createController({ dirs, emit: () => {}, makeFetcher: () => fetcher, browserAvailable: async () => false });
  const rows = IDS.map((id) => ({ name: `Thé vert ${id.toUpperCase()}`, price: 8 + IDS.indexOf(id), currency: 'EUR', sourceUrl: urlOf(id) }));
  const res = await handlePanelRequest({ op: 'ingest', url: LIST, rows, fields: [{ key: 'name' }], subpages: true }, { controller: ctl, knowledge: ctl.knowledge });
  const rep = reportOf(dirs, res.jobId);
  const f = rep.onboarding.fields;
  assert.equal(f.name.found, true); assert.equal(f.name.via, 'declared'); assert.equal(f.name.strategy, 'jsonld');
  assert.equal(f.price.via, 'declared'); assert.equal(f.brand.via, 'declared'); assert.equal(f.sku.via, 'declared');
  assert.equal(f.description.found, true); assert.equal(f.description.via, 'detection', 'only in the markup: located back in the page');
  assert.match(f.description.tests, /^3\/3$/, 'checked on every product page read');
  assert.ok(f.price.confidence > 0 && f.price.confidence <= 1);
  assert.equal(f.variants.found, false, 'buttons nothing declares: left to the AI / a 🎯');
  assert.ok(rep.onboarding.missing.includes('variants'));
  assert.deepEqual(rep.aiCalls, { discovery: 0, repair: 0, chat: 0 });
  assert.ok(rep.notes.some((n) => /Site appris automatiquement/.test(n)) && rep.notes.some((n) => /non trouvé/.test(n)), 'the report says what was learned and what is left to do');
  // Second run: the saved rules, no discovery, no AI.
  const before = fetcher.calls.length;
  const res2 = await handlePanelRequest({ op: 'ingest', url: LIST, rows, fields: [{ key: 'name' }], subpages: true }, { controller: ctl, knowledge: ctl.knowledge });
  const rep2 = reportOf(dirs, res2.jobId);
  assert.equal(rep2.onboarding, undefined, 'no second discovery');
  assert.deepEqual(rep2.aiCalls, { discovery: 0, repair: 0, chat: 0 });
  assert.equal(fetcher.calls.length - before, IDS.length, 'one read per product page, nothing more');
  const prods = JSON.parse(fs.readFileSync(path.join(dirs.jobs, res2.jobId, 'products.json'), 'utf8'));
  assert.match(prods.find((p) => p.source_url === urlOf('b')).description, /lot b/);
});

test('with the app’s AI: ONE call, for the fields nothing else found, its answers checked on several pages', async () => {
  const pages = Object.fromEntries(IDS.map((id) => [urlOf(id), pageOf(id)]));
  const store = {}; const profiles = createProfileStore({ read: () => store, write: () => {} });
  const prompts = [];
  const model = async (prompt) => {
    prompts.push(prompt);
    const line = prompt.split('\n').find((l) => /<div \.formats>/.test(l));
    return JSON.stringify({ fields: { variants: line ? { e: Number(line.match(/\[(\d+)\]/)[1]) } : null } });
  };
  const kn = createKnowledgeService({ profiles, fetchHtml: async () => ({ ok: false }), aiAsker: () => model });
  const out = await kn.onboard(urlOf('a'), { pages: new Map(Object.entries(pages)) });
  assert.equal(out.aiCalls, 1); assert.equal(prompts.length, 1);
  assert.match(prompts[0], /- variants:/); assert.ok(!/- name:|- price:|- brand:/.test(prompts[0]), 'never asked what the pages declare');
  assert.equal(out.fields.variants.found, true); assert.equal(out.fields.variants.via, 'ai'); assert.equal(out.fields.variants.tests, '3/3');
  const again = await kn.onboard(urlOf('a'), { pages: new Map(Object.entries(pages)) });
  assert.equal(again.done, true); assert.equal(again.aiCalls, 0); assert.equal(prompts.length, 1, 'once per site');
});
