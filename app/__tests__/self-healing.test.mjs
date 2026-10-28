/**
 * SELF-HEALING, offline. A site changes its markup:
 *   - a field the page DECLARES (here the brand, as a product meta) keeps reading through the rule's own
 *     fallback — no failure, no repair, no AI;
 *   - a field it does not declare (here the name, moved into the page title) makes the rule fail during the
 *     run; right after it, a replacement is found from the cheapest source up (declared → the generic
 *     detection located back in the page → last and counted, the app's AI), kept only if it reads on several
 *     product pages, PROPOSED for a manual rule (accept / reject) and APPLIED for an AI rule (logged,
 *     undoable). The next run reads the field again with 0 AI call.
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
import { createKnowledgeService } from '../knowledge-service.mjs';
import { createProfileStore } from '../../core/domain-profile.mjs';
import { ruleFromElement } from '../../shared/knowledge/apply.mjs';
import { newRule } from '../../shared/knowledge/rules.mjs';

const ORIGIN = 'https://www.maison.test';
const LIST = `${ORIGIN}/parfums`;
const IDS = ['a', 'b', 'c', 'd'];
const urlOf = (id) => `${ORIGIN}/p/${id}`;
const BRAND = (id) => (id === 'b' ? 'Atelier Nord' : 'Maison Sud');
const NAME = (id) => `Eau de parfum ${id.toUpperCase()} intense`;
const BLURB = '<p>Un parfum boisé aux notes de cèdre et de poivre, pensé pour durer toute la journée sans faiblir.</p>';
// v1: name and brand only in the markup. v2 (redesign): the old blocks are gone; the name is now the page's
// title, and the brand is DECLARED (a product meta) — nothing the old selectors can find.
const v1 = (id) => `<html><head><title>Parfum ${id}</title></head><body><div class="pdp"><div class="old-title">${NAME(id)}</div><span class="maker-name">${BRAND(id)}</span><b class="price">${40 + IDS.indexOf(id)},00 €</b>${BLURB}</div></body></html>`;
const v2 = (id) => `<html><head><title>Parfum ${id}</title><meta property="product:brand" content="${BRAND(id)}"></head><body><main class="x9"><h1>${NAME(id)}</h1><div class="p">${40 + IDS.indexOf(id)},00 €</div>${BLURB}</main></body></html>`;

class MapFetcher {
  constructor(map) { this.map = map; this.calls = []; this.userAgent = 't'; this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; }
  async get(u) { this.calls.push(u); const body = this.map[u]; if (body == null) return { ok: false, status: 404, url: u, body: '', blocked: false }; return { ok: true, status: 200, url: u, contentType: 'text/html', kind: 'html', body, blocked: false, headers: {} }; }
  async getText(u) { return this.get(u); }
}
function boot(site) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-heal-'));
  const dirs = ensureDirs(appDirs(root));
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1, recovery: false, sideData: { enabled: false } }));
  const fetcher = new MapFetcher(site);
  return { dirs, fetcher, ctl: createController({ dirs, emit: () => {}, makeFetcher: () => fetcher, browserAvailable: async () => false }) };
}
// The list's rows carry no name and no brand: the product pages are opened for the taught fields. The run
// reads products b–d (the page a rule was taught on is no evidence of it, so it is left out here).
const rows = () => IDS.slice(1).map((id) => ({ price: 40 + IDS.indexOf(id), currency: 'EUR', sourceUrl: urlOf(id) }));
const reportOf = (dirs, jobId) => JSON.parse(fs.readFileSync(path.join(dirs.data, 'reports', `${jobId}.json`), 'utf8'));
const productsOf = (dirs, jobId) => JSON.parse(fs.readFileSync(path.join(dirs.jobs, jobId, 'products.json'), 'utf8'));
function designate(sel, field) {
  const doc = parseHTML(v1('a')).document;
  return ruleFromElement(doc.querySelector(sel), doc, { field, url: urlOf('a'), html: v1('a') }).rule;
}

test('a declared field survives the redesign by the rule’s own fallback: no failure, no repair, no AI', async () => {
  const site = Object.fromEntries(IDS.map((id) => [urlOf(id), v1(id)]));
  const { dirs, ctl } = boot(site);
  const io = { knowledge: ctl.knowledge, controller: ctl };
  await handlePanelRequest({ op: 'learn', url: urlOf('a'), scope: 'product', rules: [designate('.maker-name', 'brand')], sampleUrls: [urlOf('b'), urlOf('c')] }, io);
  IDS.forEach((id) => { site[urlOf(id)] = v2(id); });
  const res = await handlePanelRequest({ op: 'ingest', url: LIST, rows: rows(), fields: [{ key: 'price' }] }, io);
  assert.equal(productsOf(dirs, res.jobId).find((p) => p.source_url === urlOf('b')).raw.brand, 'Atelier Nord');
  const rep = reportOf(dirs, res.jobId);
  assert.equal(rep.knowledgeRepair, undefined); assert.deepEqual(rep.aiCalls, { discovery: 0, repair: 0, chat: 0 });
  const s = await handlePanelRequest({ op: 'knowledge', url: urlOf('a') }, io);
  assert.equal(s.rules.find((r) => r.field === 'brand').status, 'active');
});

test('a manual rule broken by a redesign: detected in the run, a checked repair is PROPOSED, accepted, read again with 0 AI call, undoable', async () => {
  const site = Object.fromEntries(IDS.map((id) => [urlOf(id), v1(id)]));
  const { dirs, ctl } = boot(site);
  const io = { knowledge: ctl.knowledge, controller: ctl };
  await handlePanelRequest({ op: 'learn', url: urlOf('a'), scope: 'product', rules: [designate('.old-title', 'name')], sampleUrls: [urlOf('b'), urlOf('c')] }, io);
  IDS.forEach((id) => { site[urlOf(id)] = v2(id); });
  const res = await handlePanelRequest({ op: 'ingest', url: LIST, rows: rows(), fields: [{ key: 'price' }] }, io);
  const rep = reportOf(dirs, res.jobId);
  assert.deepEqual(rep.knowledgeRepair.failing, ['name'], 'the run made the rule fail (3 pages in a row)');
  assert.deepEqual(rep.knowledgeRepair.proposed.map((p) => [p.field, p.via, p.tests.ok]), [['name', 'detection', 3]], 'located back in the page, checked on 3 pages');
  assert.deepEqual(rep.aiCalls, { discovery: 0, repair: 0, chat: 0 }, 'no AI needed');
  assert.ok(rep.notes.some((n) => /réparation vérifiée est proposée/.test(n)), 'the report says what happened and what to do');
  let s = await handlePanelRequest({ op: 'knowledge', url: urlOf('a') }, io);
  const proposal = s.repairs.find((r) => r.status === 'proposed');
  assert.ok(proposal);
  assert.equal(s.rules.find((r) => r.field === 'name' && r.origin === 'manual' && r.status !== 'superseded').status, 'failing', 'the user’s rule is never overwritten by itself');
  // The user accepts.
  s = await handlePanelRequest({ op: 'repair', url: urlOf('a'), action: 'accept', id: proposal.id }, io);
  assert.equal(s.ok, true);
  assert.deepEqual(s.rules.filter((r) => r.field === 'name' && r.status === 'active').map((r) => [r.origin, r.confirmedAi]), [['manual', true]]);
  // Next run: read again, no failure, no repair, no AI.
  const res2 = await handlePanelRequest({ op: 'ingest', url: LIST, rows: rows(), fields: [{ key: 'price' }] }, io);
  assert.equal(productsOf(dirs, res2.jobId).find((p) => p.source_url === urlOf('b')).name, NAME('b'));
  const rep2 = reportOf(dirs, res2.jobId);
  assert.equal(rep2.knowledgeRepair, undefined); assert.deepEqual(rep2.aiCalls, { discovery: 0, repair: 0, chat: 0 });
  // Undo: the previous rule is back (still failing: the user sees it), the repair's rule is set aside.
  const accepted = s.repairs.find((r) => r.status === 'accepted');
  s = await handlePanelRequest({ op: 'repair', url: urlOf('a'), action: 'undo', id: accepted.id }, io);
  assert.equal(s.ok, true);
  assert.deepEqual(s.rules.filter((r) => r.field === 'name' && (r.status === 'active' || r.status === 'failing')).map((r) => [r.origin, r.status]), [['manual', 'failing']]);
  assert.deepEqual(s.log.slice(0, 2).map((l) => l.action), ['undo', 'accept'], 'every change is in the site’s log');
});

test('an AI rule broken by a redesign is repaired and APPLIED at once (logged, undoable)', async () => {
  const site = Object.fromEntries(IDS.map((id) => [urlOf(id), v2(id)]));
  const { dirs, ctl } = boot(site);
  const io = { knowledge: ctl.knowledge, controller: ctl };
  await handlePanelRequest({ op: 'learn', url: urlOf('a'), scope: 'product', origin: 'ai', rules: [newRule({ field: 'name', origin: 'ai', selector: '.old-title', learnedFrom: urlOf('a') })], sampleUrls: [] }, io);
  // (« Sous-pages »: a rule found automatically never makes a run open product pages by itself.)
  const res = await handlePanelRequest({ op: 'ingest', url: LIST, rows: rows(), fields: [{ key: 'price' }], subpages: true }, io);
  const rep = reportOf(dirs, res.jobId);
  assert.deepEqual(rep.knowledgeRepair.applied.map((a) => a.field), ['name']);
  assert.ok(rep.notes.some((n) => /réparée\(s\) automatiquement/.test(n)));
  const s = await handlePanelRequest({ op: 'knowledge', url: urlOf('a') }, io);
  assert.equal(s.log[0].action, 'auto_repair');
  const applied = s.repairs.find((r) => r.status === 'applied');
  const u = await handlePanelRequest({ op: 'repair', url: urlOf('a'), action: 'undo', id: applied.id }, io);
  assert.equal(u.ok, true); assert.equal(u.log[0].action, 'undo');
});

// ---- the AI, last: only when the pages declare nothing and the detection finds nothing -----------------

const page = (i) => `<html><head><title>Parfum ${i}</title></head><body><h1>Parfum ${i}</h1><span class="mk">Maison ${i % 2 ? 'Alpha' : 'Beta'}</span><b class="p">${40 + i},00 €</b>${BLURB}${BLURB}</body></html>`;
function fakeModel(log) {
  return async (prompt) => {
    log.push(prompt);
    const line = prompt.split('\n').find((l) => /<span \.mk> Maison/.test(l));
    return JSON.stringify({ fields: { brand: line ? { e: Number(line.match(/\[(\d+)\]/)[1]) } : null } });
  };
}

test('the AI is asked last, once, for the failing field only; its answer is checked on several pages before it is proposed', async () => {
  const pages = Object.fromEntries([1, 2, 3].map((i) => [`https://shop.test/p/${i}`, page(i)]));
  const map = {}; const profiles = createProfileStore({ read: () => map, write: () => {} });
  const log = [];
  const kn = createKnowledgeService({ profiles, fetchHtml: async (u) => (pages[u] ? { ok: true, html: pages[u] } : { ok: false }), aiAsker: () => fakeModel(log) });
  profiles.record('https://shop.test/p/1', { knowledgeRules: [newRule({ field: 'brand', selector: '.old-brand', learnedFrom: 'https://shop.test/p/1' })] });
  const failed = kn.forEngine('https://shop.test/p/1').rules.filter((r) => r.field === 'brand');
  const res = await kn.repair('https://shop.test/p/1', { failed, pages: new Map(Object.entries(pages)) });
  assert.equal(res.aiCalls, 1); assert.equal(log.length, 1);
  assert.match(log[0], /- brand:/); assert.ok(!/- description:/.test(log[0]), 'only the failing field is asked');
  assert.deepEqual(res.proposed.map((p) => [p.field, p.via, p.tests.ok]), [['brand', 'ai', 3]]);
  // Without an AI key: nothing invented, the field is reported as not repaired.
  const kn2 = createKnowledgeService({ profiles: createProfileStore({ read: () => ({}), write: () => {} }), fetchHtml: async (u) => ({ ok: !!pages[u], html: pages[u] }), aiAsker: () => null });
  const res2 = await kn2.repair('https://shop.test/p/1', { failed, pages: new Map(Object.entries(pages)) });
  assert.deepEqual(res2.unrepaired, ['brand']); assert.equal(res2.aiCalls, 0);
});
