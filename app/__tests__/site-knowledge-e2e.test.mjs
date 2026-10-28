/**
 * END TO END, through the real app code (controller + panel ops + domain profile on disk),
 * offline (map-backed fetcher, linkedom pages):
 *
 *   collection → product A → 🎯 description + technical_specs → the rules are stored and CHECKED
 *   on other products → back on the collection → "Accepter" → every product's description and
 *   specifications come from ITS OWN page → a new session finds the knowledge again → the site
 *   changes its markup → the rules still read (by label) and a new 🎯 corrects an AI proposal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseHTML } from 'linkedom';
import { appDirs, ensureDirs } from '../../lib/osenv.mjs';
import { createController } from '../controller.mjs';
import { handlePanelRequest } from '../your-browser/panel-requests.mjs';
import { ruleFromElement } from '../../shared/knowledge/apply.mjs';
import { growBlock, sameShapeLinks } from '../../shared/knowledge/pick-block.mjs';

const ORIGIN = 'https://www.shop.test';
const COLLECTION = `${ORIGIN}/ordinateurs`;
const IDS = ['a', 'b', 'c', 'd', 'e', 'f'];
const urlOf = (id) => `${ORIGIN}/produit/ordinateur-${id}`;
const DESC = (id) => [`L’ordinateur ${id.toUpperCase()} est conçu pour le travail quotidien et la création.`, `Son écran lumineux et son clavier rétroéclairé conviennent aux longues journées (modèle ${id}).`, 'Garantie constructeur de deux ans.'];
const SPECS = (id) => [['Processeur', `Core i${5 + IDS.indexOf(id)}`], ['Mémoire vive', `${8 * (1 + (IDS.indexOf(id) % 2))} Go`], ['Stockage', '512 Go SSD'], ['Écran', '14 pouces']];

// Product page v1: tab panels. `salt` = the generated class names of the build.
const product = (id, { salt = 'k3f9a', broken = false, v = 1 } = {}) => v === 1 ? `<html><head><title>PC ${id}</title></head><body>
  <header><a href="/">Accueil</a></header>
  <main class="pdp css-${salt}">
    <h1 class="pdp__title">Ordinateur ${id.toUpperCase()}</h1>
    <div class="pdp__price">${999 + IDS.indexOf(id)},00 €</div>
    <div class="tabs"><button role="tab" aria-controls="panel-desc">Description</button><button role="tab" aria-controls="panel-specs">Caractéristiques techniques</button></div>
    ${broken ? '' : `<div id="panel-desc" class="tab-panel tw-${salt}">${DESC(id).map((t) => `<p>${t}</p>`).join('')}</div>`}
    <div id="panel-specs" class="tab-panel"><table class="spec-table"><tbody>${SPECS(id).map(([k, val]) => `<tr><th>${k}</th><td>${val}</td></tr>`).join('')}</tbody></table></div>
    <section class="related">${IDS.filter((x) => x !== id).slice(0, 4).map((x) => `<a href="/produit/ordinateur-${x}"><img src="/i/${x}.jpg">PC ${x}</a>`).join('')}</section>
  </main></body></html>`
  // v2: the site was redesigned — new ids, new classes, accordions, specs as a definition list; same tab titles.
  : `<html><body><main class="x-${salt}"><h1>Ordinateur ${id.toUpperCase()}</h1><div class="p">${999 + IDS.indexOf(id)},00 €</div>
    <nav><button role="tab" aria-controls="z-1">Description</button><button role="tab" aria-controls="z-2">Caractéristiques techniques</button></nav>
    <section id="z-1" class="zz">${DESC(id).map((t) => `<div>${t}</div>`).join('')}</section>
    <section id="z-2" class="zz"><dl>${SPECS(id).map(([k, val]) => `<dt>${k}</dt><dd>${val}</dd>`).join('')}</dl></section></main></body></html>`;

const collection = `<html><body><main class="grid">${IDS.map((id) => `<div class="card"><a class="card__t" href="/produit/ordinateur-${id}">Ordinateur ${id.toUpperCase()}</a><span class="card__p">${999 + IDS.indexOf(id)},00 €</span></div>`).join('')}</main></body></html>`;

class MapFetcher {
  constructor(map) { this.map = map; this.calls = []; this.userAgent = 't'; this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; }
  async get(u) { this.calls.push(u); const body = this.map[u]; if (body == null) return { ok: false, status: 404, url: u, body: '', blocked: false, error: 'HTTP 404' }; return { ok: true, status: 200, url: u, contentType: 'text/html', kind: 'html', body, blocked: false, headers: {} }; }
  async getText(u) { return this.get(u); }
}

function boot(site) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-know-'));
  const dirs = ensureDirs(appDirs(root));
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1, recovery: false, sideData: { enabled: false } }));
  const fetcher = new MapFetcher(site);
  const make = () => createController({ dirs, emit: () => {}, makeFetcher: () => fetcher });
  return { root, dirs, fetcher, make };
}

// What the extension's 🎯 does on a product page: the block under the pointer, grown to the whole block,
// turned into a rule (the same modules the in-page runner imports).
function designate(html, pageUrl, clickSelector, field, label) {
  const doc = parseHTML(html).document;
  const clicked = doc.querySelector(clickSelector);
  const block = growBlock(clicked, field);
  const { rule, read } = ruleFromElement(block, doc, { field, label, url: pageUrl });
  assert.ok(read.ok, `${field}: ${read.reason}`);
  return { rule, doc };
}

const rowsFromCollection = () => IDS.map((id) => ({ name: `Ordinateur ${id.toUpperCase()}`, price: 999 + IDS.indexOf(id), sourceUrl: urlOf(id), currency: 'EUR' }));
const productsOf = (dirs, jobId) => JSON.parse(fs.readFileSync(path.join(dirs.jobs, jobId, 'products.json'), 'utf8'));

test('collection → product → 🎯 description + technical_specs → back on the collection → scrape: each product gets its OWN description and specs', async () => {
  const site = { [COLLECTION]: collection };
  IDS.forEach((id) => { site[urlOf(id)] = product(id, { salt: `s${id}9z`, broken: id === 'f' }); });
  const { dirs, fetcher, make } = boot(site);
  let ctl = make();

  // 1. On product A the user designates the description (clicks ONE paragraph) and the spec table (clicks ONE cell).
  const d1 = designate(site[urlOf('a')], urlOf('a'), '#panel-desc p', 'description', 'Description');
  const d2 = designate(site[urlOf('a')], urlOf('a'), '#panel-specs td', 'technical_specs', 'Caractéristiques techniques');
  assert.equal(d1.rule.extract.mode, 'text'); assert.equal(d2.rule.extract.mode, 'pairs');
  // The page offers links to other products of the site (to check the rules on).
  const samples = sameShapeLinks(d1.doc, urlOf('a'));
  assert.ok(samples.length >= 3, 'related products found on the page');

  // 2. "Enregistrer et tester": stored, then checked on the other product pages. F has no description block.
  const learned = await handlePanelRequest({ op: 'learn', url: urlOf('a'), scope: 'product', rules: [d1.rule, d2.rule], sampleUrls: [...IDS.slice(1).map(urlOf)] }, { knowledge: ctl.knowledge });
  assert.equal(learned.ok, true);
  const desc = learned.rules.find((r) => r.field === 'description');
  const specs = learned.rules.find((r) => r.field === 'technical_specs');
  // Tested on the 5 OTHER product pages: the page the rule was taught on (A) is no evidence.
  assert.equal(desc.tests.total, 5); assert.equal(desc.tests.ok, 4, 'B–E read, F honestly fails');
  assert.equal(specs.tests.ok, 5);
  assert.equal(desc.taughtOnly, false);
  assert.equal(desc.label, 'élevée'); assert.equal(desc.general, true);
  assert.match(desc.describe, /4\/5 autre\(s\) fiche/);
  assert.equal(desc.failures.length, 1); assert.equal(desc.failures[0].url, urlOf('f'));

  // 3. Persistence: the rules are in domain-profiles.json, and a NEW session (new controller) finds them.
  const onDisk = JSON.parse(fs.readFileSync(path.join(dirs.data, 'domain-profiles.json'), 'utf8'))['shop.test'];
  assert.equal(onDisk.siteKnowledge.rules.filter((r) => r.status === 'active').length, 2);
  ctl = make();
  const summary = ctl.knowledge.summary(COLLECTION);
  assert.deepEqual(summary.rules.map((r) => r.field).sort(), ['description', 'technical_specs']);
  assert.ok(summary.rules.every((r) => r.origin === 'manual' && r.status === 'active'));

  // 4. Back on the collection: its cards carry no description. "Accepter" (WITHOUT « Sous-pages » ticked)
  //    opens the product pages because the site was taught fields only they hold.
  fetcher.calls.length = 0;
  const res = await handlePanelRequest({ op: 'ingest', url: COLLECTION, rows: rowsFromCollection(), fields: [{ key: 'name' }, { key: 'price' }], subpages: false }, { controller: ctl });
  assert.equal(res.ok, true);
  assert.ok(IDS.every((id) => fetcher.calls.includes(urlOf(id))), 'every product page was read');
  const prods = productsOf(dirs, res.jobId);
  const byId = (id) => prods.find((p) => p.source_url === urlOf(id));
  for (const id of IDS.filter((x) => x !== 'f')) {
    const p = byId(id);
    assert.ok(p.description.includes(`L’ordinateur ${id.toUpperCase()} est conçu`), `${id}: its own description`);
    assert.ok(p.description.includes('\n'), `${id}: paragraphs kept`);
    assert.ok(p.description.includes('Garantie constructeur de deux ans.'));
    assert.deepEqual(p.raw.technical_specs, Object.fromEntries(SPECS(id)), `${id}: specs as name → value`);
    assert.equal(p.raw.specs.length, 4);
  }
  assert.equal(byId('f').description, null, 'F has no description block: nothing invented');
  assert.equal(byId('f').raw.technical_specs['Écran'], '14 pouces', 'but its specs are read');
  assert.notEqual(byId('a').description, byId('b').description);

  // 5. The scrape fed the rules' track record (B–E ok, F failed once more; A, the teaching page, is no evidence).
  const after = JSON.parse(fs.readFileSync(path.join(dirs.data, 'domain-profiles.json'), 'utf8'))['shop.test'].siteKnowledge.rules.find((r) => r.field === 'description');
  assert.equal(after.tests.total, 10); assert.equal(after.tests.ok, 8);
});

test('a collection whose cards already carry the field does NOT open the product pages for it', async () => {
  const site = { [COLLECTION]: collection };
  IDS.forEach((id) => { site[urlOf(id)] = product(id); });
  const { dirs, fetcher, make } = boot(site);
  const ctl = make();
  const d1 = designate(site[urlOf('a')], urlOf('a'), '#panel-desc p', 'description', 'Description');
  await handlePanelRequest({ op: 'learn', url: urlOf('a'), scope: 'product', rules: [d1.rule], sampleUrls: IDS.slice(1).map(urlOf) }, { knowledge: ctl.knowledge });
  fetcher.calls.length = 0;
  const rows = rowsFromCollection().map((r) => ({ ...r, description: `Description déjà présente dans la collection pour ${r.name}, assez longue.` }));
  const res = await handlePanelRequest({ op: 'ingest', url: COLLECTION, rows, fields: [{ key: 'name' }], subpages: false }, { controller: ctl });
  assert.equal(res.ok, true);
  assert.equal(fetcher.calls.length, 0, 'no product page opened: the collection already holds the information');
  assert.match(productsOf(dirs, res.jobId)[0].description, /déjà présente dans la collection/);
});

test('the site is redesigned: the rules still read (found by their label) and the outcome is counted; a new 🎯 supersedes a wrong AI proposal', async () => {
  const site = { [COLLECTION]: collection };
  IDS.forEach((id) => { site[urlOf(id)] = product(id); });
  const { dirs, fetcher, make } = boot(site);
  const ctl = make();
  // The AI (generic detection) proposes first, with a WRONG description block (the product title).
  const d0 = designate(site[urlOf('a')], urlOf('a'), '#panel-desc p', 'description', 'Description');
  const wrong = parseHTML(site[urlOf('a')]).document;
  const aiRule = ruleFromElement(wrong.querySelector('.pdp__title'), wrong, { field: 'description', origin: 'ai', url: urlOf('a') }).rule;
  aiRule.extract.multiline = false; aiRule.selector = '.pdp__title';
  await handlePanelRequest({ op: 'learn', url: urlOf('a'), scope: 'product', origin: 'ai', rules: [aiRule] }, { knowledge: ctl.knowledge });
  let k = ctl.knowledge.summary(urlOf('a')).rules;
  assert.equal(k.length, 1); assert.equal(k[0].origin, 'ai');
  // The user corrects it: the manual rule becomes the active one, the AI one is history.
  const man = await handlePanelRequest({ op: 'learn', url: urlOf('a'), scope: 'product', rules: [d0.rule], sampleUrls: IDS.slice(1).map(urlOf) }, { knowledge: ctl.knowledge });
  assert.equal(man.rules[0].origin, 'manual');
  const sp = designate(site[urlOf('a')], urlOf('a'), '#panel-specs td', 'technical_specs', 'Caractéristiques techniques');
  await handlePanelRequest({ op: 'learn', url: urlOf('a'), scope: 'product', rules: [sp.rule], sampleUrls: IDS.slice(1).map(urlOf) }, { knowledge: ctl.knowledge });
  k = ctl.knowledge.summary(urlOf('a')).rules.filter((r) => r.status !== 'superseded' && r.field === 'description');
  assert.deepEqual(k.map((r) => [r.origin, r.status]), [['manual', 'active']]);
  // Redesign.
  IDS.forEach((id) => { fetcher.map[urlOf(id)] = product(id, { v: 2, salt: 'new' }); });
  const res = await handlePanelRequest({ op: 'ingest', url: COLLECTION, rows: rowsFromCollection(), fields: [{ key: 'name' }], subpages: false }, { controller: ctl });
  const prods = productsOf(dirs, res.jobId);
  assert.ok(prods.every((p) => p.description && p.description.includes('Garantie constructeur de deux ans.')), 'descriptions read on the redesigned pages');
  assert.equal(prods[0].raw.technical_specs.Écran, '14 pouces');
  const rule = ctl.knowledge.summary(urlOf('a')).rules.find((r) => r.field === 'technical_specs' && r.status === 'active');
  assert.equal(rule.tests.total, 10, '5 other pages at learning + 5 pages of this scrape (the teaching page counts in neither)');
});

test('ops are validated: unknown field names, oversized selectors, other-host samples are refused or ignored', async () => {
  const { make } = boot({});
  const ctl = make();
  const bad = await handlePanelRequest({ op: 'learn', url: urlOf('a'), scope: 'product', rules: [{ field: 'x y', selector: '.a' }, { field: 'description', selector: 'a'.repeat(900) }, { field: 'description' }] }, { knowledge: ctl.knowledge });
  assert.equal(bad.ok, false);
  assert.equal((await handlePanelRequest({ op: 'learn', url: 'file:///c:/x', rules: [] }, { knowledge: ctl.knowledge })).ok, false);
  assert.equal((await handlePanelRequest({ op: 'knowledge', url: urlOf('a') }, {})).ok, false, 'no service → refused, not a crash');
  assert.deepEqual((await handlePanelRequest({ op: 'knowledge', url: urlOf('a') }, { knowledge: ctl.knowledge })).rules, []);
});

// A page whose structured data AND visible markup carry the product (what the generic detection can read).
const aiPage = (id, salt = 'a1') => `<html><head><title>PC ${id}</title>${`<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: `Ordinateur ${id.toUpperCase()}`, sku: `SKU-${id.toUpperCase()}1`, brand: { '@type': 'Brand', name: 'Acme' }, description: DESC(id).join(' '), offers: { '@type': 'Offer', price: String(999 + IDS.indexOf(id)), priceCurrency: 'EUR' } })}</script>`}</head><body>
  <h1 class="t-${salt}">Ordinateur ${id.toUpperCase()}</h1><span class="brand">Acme</span> <span class="sku">SKU-${id.toUpperCase()}1</span>
  <div class="tab-d">${DESC(id).map((t) => `<p>${t}</p>`).join('')}</div>
  <table class="specs"><tr><th>Processeur</th><td>Core i${5 + IDS.indexOf(id)}</td></tr><tr><th>Mémoire vive</th><td>16 Go</td></tr><tr><th>Écran</th><td>14 pouces</td></tr></table></body></html>`;

test('AI mode and manual mode feed ONE knowledge: the detection proposes, the 🎯 corrects, the scrape uses both (brand/sku from AI, description from the user)', async () => {
  const site = { [COLLECTION]: collection };
  IDS.forEach((id) => { site[urlOf(id)] = aiPage(id, `h${id}7`); });
  const { dirs, make } = boot(site);
  const ctl = make();
  // 1. ✨ on product A: nothing taught yet → the detected values are located back in the page as rules (origin 'ai').
  const prop = await handlePanelRequest({ op: 'propose', url: urlOf('a'), html: site[urlOf('a')] }, { knowledge: ctl.knowledge });
  assert.equal(prop.ok, true);
  assert.deepEqual([...prop.located].sort(), ['brand', 'description', 'sku', 'technical_specs']);
  let rules = ctl.knowledge.summary(urlOf('a')).rules;
  assert.ok(rules.every((r) => r.origin === 'ai' && r.status === 'active'));
  // 2. The user disagrees with the description block the AI found and designates the real one (only the first
  //    paragraph + the warranty line in this site's markup is what he wants): his rule wins, the AI one is history.
  const doc = parseHTML(site[urlOf('a')]).document;
  const wanted = doc.querySelector('.tab-d');
  const { rule } = ruleFromElement(wanted, doc, { field: 'description', url: urlOf('a'), label: 'Description' });
  await handlePanelRequest({ op: 'learn', url: urlOf('a'), scope: 'product', rules: [rule], sampleUrls: IDS.slice(1).map(urlOf) }, { knowledge: ctl.knowledge });
  rules = ctl.knowledge.summary(urlOf('a')).rules.filter((r) => r.status !== 'superseded');
  const byField = Object.fromEntries(rules.map((r) => [r.field, r.origin]));
  assert.deepEqual(byField, { description: 'manual', brand: 'ai', sku: 'ai', technical_specs: 'ai' });
  // 3. A later AI proposal for the same field never displaces the manual rule.
  await handlePanelRequest({ op: 'propose', url: urlOf('b'), html: site[urlOf('b')] }, { knowledge: ctl.knowledge });
  const again = ctl.knowledge.summary(urlOf('a')).rules.filter((r) => r.field === 'description' && r.status === 'active');
  assert.deepEqual(again.map((r) => r.origin), ['manual']);
  // 4. Scrape the collection: every field the cards lack is read from each product page.
  const res = await handlePanelRequest({ op: 'ingest', url: COLLECTION, rows: rowsFromCollection(), fields: [{ key: 'name' }], subpages: false }, { controller: ctl });
  const prods = productsOf(dirs, res.jobId);
  const b = prods.find((p) => p.source_url === urlOf('b'));
  assert.equal(b.raw.brand, 'Acme');
  assert.equal(b.raw.sku, 'SKU-B1');
  assert.ok(b.description.includes('modèle b') && b.description.includes('\n'));
  assert.equal(b.raw.technical_specs['Écran'], '14 pouces');
});

test('propose refuses a page that is not readable or not a product', async () => {
  const { make } = boot({});
  const ctl = make();
  assert.equal((await handlePanelRequest({ op: 'propose', url: urlOf('a'), html: '<html></html>' }, { knowledge: ctl.knowledge })).ok, false);
  assert.match((await handlePanelRequest({ op: 'propose', url: urlOf('a'), html: `<html><head><title>Blog</title></head><body>${'<p>texte sans produit</p>'.repeat(30)}</body></html>` }, { knowledge: ctl.knowledge })).reason, /fiche produit|illisible/);
});

test('what the user designated on the LIST page (🎯 on cards) becomes the site\'s card recipe — kept across sessions; an incomplete one is not stored', async () => {
  const site = { [COLLECTION]: collection };
  const { dirs, make } = boot(site);
  let ctl = make();
  const designated = { card: '.card', fields: [
    { key: 'name', selector: '.card__t', attr: null }, { key: 'url', selector: '.card__t', attr: 'href' }, { key: 'price', selector: '.card__p', attr: null },
    { key: 'ville', selector: '.card__p', attr: null, part: { sep: '·', index: 0 } }, // not replayable by the app: kept out, reported
  ] };
  const res = await handlePanelRequest({ op: 'ingest', url: COLLECTION, rows: rowsFromCollection(), fields: [{ key: 'name' }], designated }, { controller: ctl, knowledge: ctl.knowledge });
  assert.equal(res.ok, true);
  assert.deepEqual(res.cardsLearned.fields.sort(), ['name', 'price', 'url']); assert.deepEqual(res.cardsLearned.skipped, ['ville']);
  ctl = make(); // a new session
  assert.deepEqual(ctl.knowledge.summary(COLLECTION).cards, { fields: ['name', 'url', 'price'], origin: 'manual' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dirs.data, 'domain-profiles.json'), 'utf8'))['shop.test'].manual_selectors.card, '.card');
  // Only a price designated: stored nothing (it would make the automatic read worse).
  const other = boot(site); const c2 = other.make();
  const r2 = await handlePanelRequest({ op: 'ingest', url: COLLECTION, rows: rowsFromCollection(), fields: [{ key: 'price' }], designated: { card: '.card', fields: [{ key: 'price', selector: '.card__p', attr: null }] } }, { controller: c2, knowledge: c2.knowledge });
  assert.equal(r2.cardsLearned.ok, false); assert.equal(c2.knowledge.summary(COLLECTION).cards, null);
});

test('« Accepter » answers with the rows as the app FINISHED them: the panel table and its CSV export show description, specs, brand', async () => {
  const site = { [COLLECTION]: collection };
  IDS.forEach((id) => { site[urlOf(id)] = product(id); });
  const { make } = boot(site);
  const ctl = make();
  const d1 = designate(site[urlOf('a')], urlOf('a'), '#panel-desc p', 'description', 'Description');
  const d2 = designate(site[urlOf('a')], urlOf('a'), '#panel-specs td', 'technical_specs', 'Caractéristiques techniques');
  await handlePanelRequest({ op: 'learn', url: urlOf('a'), scope: 'product', rules: [d1.rule, d2.rule], sampleUrls: IDS.slice(1).map(urlOf) }, { knowledge: ctl.knowledge });
  const res = await handlePanelRequest({ op: 'ingest', url: COLLECTION, rows: rowsFromCollection(), fields: [{ key: 'name' }], subpages: false }, { controller: ctl });
  assert.equal(res.rows.length, IDS.length); assert.equal(res.rowsNext, null); assert.equal(res.rowsTotal, IDS.length);
  const b = res.rows.find((r) => r.sourceUrl === urlOf('b'));
  assert.ok(b.description.includes('modèle b'));
  assert.equal(b.technical_specs['Écran'], '14 pouces');
  assert.equal(b.name, 'Ordinateur B'); assert.equal(b.price, 1000);
});

test('the finished rows go back in chunks under the native-link size limit, and every row arrives', async () => {
  const { finishedRows } = await import('../your-browser/panel-requests.mjs');
  const big = Array.from({ length: 400 }, (_, i) => ({ name: `P${i}`, price: 1, description: 'x'.repeat(5000), source_url: `https://s.test/p/${i}`, specs: [] }));
  const out = finishedRows(big);
  assert.ok(out.next > 100 && out.next < 400); assert.equal(out.total, 400);
  assert.ok(JSON.stringify(out.rows).length <= 760000);
  const all = [...out.rows]; let next = out.next;
  while (next != null) { const c = finishedRows(big, { offset: next }); assert.ok(JSON.stringify(c.rows).length <= 760000); all.push(...c.rows); next = c.next; }
  assert.deepEqual(all.map((r) => r.name), big.map((p) => p.name));
});

// A perfume shop: each product page lists its sizes (another count, other prices per product).
const SIZES = { a: [['30 ml', '49,99'], ['50 ml', '69,99']], b: [['20 ml', '39,00'], ['60 ml', '89,00'], ['90 ml', '119,00']], c: [['100 ml', '129,00'], ['200 ml', '199,00']] };
const vproduct = (id) => `<html><body><main class="pdp"><h1>Parfum ${id.toUpperCase()}</h1><div class="variant-picker">${(SIZES[id] || SIZES.a).map(([n, p], i) => `<button class="opt${i === 0 ? ' is-selected' : ''}" data-sku="${id}-${i}"><span>${n}</span> <b class="price">${p} €</b></button>`).join('')}</div></main></body></html>`;

test('variants taught on one product page (one click on one size) are read on every product of the collection', async () => {
  const site = { [COLLECTION]: collection };
  IDS.forEach((id) => { site[urlOf(id)] = vproduct(id); });
  const { dirs, make } = boot(site);
  const ctl = make();
  const d = designate(site[urlOf('a')], urlOf('a'), '.opt span', 'variants', 'Variantes');
  assert.equal(d.rule.extract.mode, 'list');
  const learned = await handlePanelRequest({ op: 'learn', url: urlOf('a'), scope: 'product', rules: [d.rule], sampleUrls: IDS.slice(1, 3).map(urlOf) }, { knowledge: ctl.knowledge });
  assert.equal(learned.rules[0].tests.ok, 2, 'checked on the 2 other pages (the teaching page is no evidence)');
  const res = await handlePanelRequest({ op: 'ingest', url: COLLECTION, rows: rowsFromCollection().slice(0, 3), fields: [{ key: 'name' }] }, { controller: ctl });
  const prods = productsOf(dirs, res.jobId);
  const b = prods.find((p) => p.source_url === urlOf('b'));
  assert.deepEqual(b.variants.map((v) => [v.name, v.price, v.code]), [['20 ml', 39, 'b-0'], ['60 ml', 89, 'b-1'], ['90 ml', 119, 'b-2']]);
  assert.equal(res.rows.find((r) => r.sourceUrl === urlOf('b')).variants, '20 ml : 39 | 60 ml : 89 | 90 ml : 119');
});

test('« revérifier » checks a failing rule again on the pages it was checked on, and revives it when it reads', async () => {
  const site = { [COLLECTION]: collection };
  IDS.forEach((id) => { site[urlOf(id)] = product(id); });
  const { make } = boot(site);
  const ctl = make();
  const d = designate(site[urlOf('a')], urlOf('a'), '#panel-desc p', 'description', 'Description');
  await handlePanelRequest({ op: 'learn', url: urlOf('a'), scope: 'product', rules: [d.rule], sampleUrls: IDS.slice(1, 4).map(urlOf) }, { knowledge: ctl.knowledge });
  // An older version failed it on every page (simulated): the rule is « en échec ».
  const id = ctl.knowledge.summary(urlOf('a')).rules[0].id;
  // (profiles.record with outcomes is how a scrape reports them)
  for (let i = 0; i < 3; i++) await handlePanelRequest({ op: 'knowledge', url: urlOf('a') }, { knowledge: ctl.knowledge });
  const before = ctl.knowledge.summary(urlOf('a')).rules[0];
  assert.equal(before.status, 'active');
  const res = await handlePanelRequest({ op: 'retest', url: urlOf('a'), field: 'description' }, { knowledge: ctl.knowledge });
  assert.equal(res.ok, true); assert.equal(res.sampled >= 3, true);
  assert.equal(res.rules[0].id, id); assert.equal(res.rules[0].status, 'active');
  assert.match(res.rules[0].describe, /\d+\/\d+ autre\(s\) fiche\(s\) récente\(s\)/);
  assert.equal((await handlePanelRequest({ op: 'retest', url: urlOf('a'), field: 'brand' }, { knowledge: ctl.knowledge })).ok, false, 'nothing taught for that field');
});

test('sub-pages read in the user\'s browser: the app completes each row from the RENDERED page (no HTTP re-read)', async () => {
  // Over plain HTTP the shop sends no description block (built in the browser); the user's browser renders it.
  const plain = (id) => `<html><body><main class="pdp"><h1>Ordinateur ${id.toUpperCase()}</h1></main></body></html>`;
  const site = { [COLLECTION]: collection };
  IDS.forEach((id) => { site[urlOf(id)] = plain(id); });
  const { dirs, fetcher, make } = boot(site);
  const ctl = make();
  const d = designate(product('a'), urlOf('a'), '#panel-desc p', 'description', 'Description');
  await handlePanelRequest({ op: 'learn', url: urlOf('a'), scope: 'product', rules: [d.rule] }, { knowledge: ctl.knowledge });
  // The extension hands over the rendered pages of the run, then « Accepter ».
  const { createPageCache } = await import('../your-browser/panel-requests.mjs');
  const pageCache = createPageCache();
  for (const id of IDS.slice(0, 3)) assert.equal((await handlePanelRequest({ op: 'page', url: urlOf(id), runId: 'pr_run_42', html: product(id) }, { pageCache })).ok, true);
  assert.equal((await handlePanelRequest({ op: 'page', url: urlOf('a'), runId: 'bad id!', html: 'x' }, { pageCache })).ok, false);
  fetcher.calls.length = 0;
  const res = await handlePanelRequest({ op: 'ingest', url: COLLECTION, runId: 'pr_run_42', rows: rowsFromCollection().slice(0, 3), fields: [{ key: 'name' }], subpages: true }, { controller: ctl, pageCache });
  assert.equal(fetcher.calls.filter((u) => /\/produit\//.test(u)).length, 0, 'no product page fetched over HTTP');
  const prods = productsOf(dirs, res.jobId);
  for (const id of IDS.slice(0, 3)) assert.ok(prods.find((p) => p.source_url === urlOf(id)).description.includes(`modèle ${id}`), id);
  // Used once by the job; kept (until they expire, or memory is short) for « Lire les fiches manquantes » only.
  assert.equal(pageCache.take('pr_run_42'), null, 'the run\'s pages are given to its job once');
  assert.equal(pageCache.reuse('pr_run_42', 'pr_run_42-m1').length, 3, 'a follow-up run starts from them');
});
