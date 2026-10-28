/**
 * Product pages read in the USER'S browser for a site that refuses the app (offline, map-backed):
 *
 *   - the knowledge schema v2: the page a rule was taught on is no evidence ("1/1" is gone), migrated
 *     on load with a one-time copy of the file as it was;
 *   - the way a site's product pages can be read is learned per site (http | browser | extension) and
 *     reused: a site only the user's browser reads is not asked over HTTP again;
 *   - the extension's job opens the product pages itself (followLinks within the « Fiches produit »
 *     limit, same site only), hands each built page to the app, and a human check pauses the job;
 *   - a rule taught on a protected site is tested on pages the user's browser read;
 *   - the panel gets the taught rules to apply in its preview.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseHTML } from 'linkedom';
import { appDirs, ensureDirs } from '../../lib/osenv.mjs';
import { createController } from '../controller.mjs';
import { handlePanelRequest, createPageCache } from '../your-browser/panel-requests.mjs';
import { detailPlan } from '../your-browser/launch.mjs';
import { ruleFromElement, applyKnowledge, foldOutcomes, mergeKnowledgeIntoRow } from '../../shared/knowledge/apply.mjs';
import { growBlock } from '../../shared/knowledge/pick-block.mjs';
import { migrateKnowledge, KNOWLEDGE_VERSION, newRule, describeRule } from '../../shared/knowledge/rules.mjs';
import { createProfileStore, mergeProfile, detailAccessOf, createAccessTracker, DETAIL_ACCESS_TTL_MS } from '../../core/domain-profile.mjs';
import { profileFileIo } from '../../core/profile-file.mjs';
import { runProgram } from '../../shared/dsl/interpret.mjs';
import { RESOLUTION } from '../../shared/challenge/strategy.mjs';
import { JOB_STATUS } from '../../shared/protocol/messages.mjs';
import { defaultProgram, detailPlanOf, sameSiteUrl } from '../../extension/background/program.mjs';

const ORIGIN = 'https://www.protected.test';
const LIST = `${ORIGIN}/parfums`;
const IDS = ['a', 'b', 'c', 'd'];
const urlOf = (id) => `${ORIGIN}/p/parfum-${id}`;
const DESC = (id) => `Le parfum ${id.toUpperCase()} ouvre sur des notes de bergamote et de poivre rose, avec un cœur floral et un fond boisé (édition ${id}).`;
// The product page AS THE BROWSER BUILT IT (the description block is drawn by the page's scripts).
const built = (id) => `<html><head><title>Parfum ${id}</title></head><body><main class="pdp"><h1 class="pdp-title">Parfum ${id.toUpperCase()}</h1>
  <div class="price">${50 + IDS.indexOf(id)},00 €</div>
  <section><h2>Description</h2><div class="desc-body" data-testid="pdp-description"><p>${DESC(id)}</p></div></section></main></body></html>`;
const BLOCK_PAGE = '<html><head><title>Access denied</title></head><body><h1>Pardon our interruption</h1><p>Verify you are human.</p></body></html>';

class RefusingFetcher {
  constructor() { this.calls = []; this.userAgent = 't'; this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; }
  async get(u) { this.calls.push(u); return { ok: false, status: 403, url: u, body: BLOCK_PAGE, blocked: true, block: { terminal: true, code: 'ACCESS_DENIED' }, headers: {} }; }
  async getText(u) { return this.get(u); }
}

function boot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-detail-'));
  const dirs = ensureDirs(appDirs(root));
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1, recovery: false, sideData: { enabled: false } }));
  const fetcher = new RefusingFetcher();
  const make = () => createController({ dirs, emit: () => {}, makeFetcher: () => fetcher, browserAvailable: async () => false });
  return { root, dirs, fetcher, make };
}
const productsOf = (dirs, jobId) => JSON.parse(fs.readFileSync(path.join(dirs.jobs, jobId, 'products.json'), 'utf8'));
const reportOf = (dirs, jobId) => JSON.parse(fs.readFileSync(path.join(dirs.data, 'reports', `${jobId}.json`), 'utf8'));
const profileOf = (dirs) => JSON.parse(fs.readFileSync(path.join(dirs.data, 'domain-profiles.json'), 'utf8'))['protected.test'];

function designateDescription(id) {
  const doc = parseHTML(built(id)).document;
  const block = growBlock(doc.querySelector('.desc-body p'), 'description');
  const { rule, read } = ruleFromElement(block, doc, { field: 'description', label: 'Description', url: urlOf(id) });
  assert.ok(read.ok, read.reason);
  return rule;
}

// ---- schema v2 ---------------------------------------------------------------------------

test('v1 → v2: the teaching page leaves the counted tests (a rule checked nowhere else no longer shows 1/1)', () => {
  const learnedFrom = urlOf('a');
  const only = { ...newRule({ field: 'brand', selector: '.b', learnedFrom }), tests: { ok: 1, total: 1, urls: [learnedFrom], at: 'x', recent: '1' } };
  const checked = { ...newRule({ field: 'description', selector: '.d', learnedFrom }), tests: { ok: 4, total: 5, urls: [learnedFrom, urlOf('b'), urlOf('c')], at: 'x', recent: '11101' } };
  const noRecent = { ...newRule({ field: 'sku', selector: '.s', learnedFrom }), tests: { ok: 3, total: 3, urls: [learnedFrom, urlOf('b')], at: 'x' } };
  const v1 = { version: 1, rules: [only, checked, noRecent], updatedAt: null };
  const m = migrateKnowledge(v1);
  assert.equal(m.changed, true); assert.equal(m.knowledge.version, KNOWLEDGE_VERSION);
  const [a, b, c] = m.knowledge.rules;
  assert.deepEqual([a.tests.ok, a.tests.total], [0, 0], 'taught page only → not tested');
  assert.match(describeRule(a), /pas encore testée sur d’autres fiches/);
  assert.deepEqual([b.tests.ok, b.tests.total, b.tests.recent], [3, 4, '1101']);
  assert.ok(!b.tests.urls.includes(learnedFrom)); assert.equal(b.tests.taught.url, learnedFrom);
  assert.deepEqual([c.tests.ok, c.tests.total], [2, 2]);
  assert.equal(v1.rules[0].tests.total, 1, 'the input is never mutated');
  assert.equal(migrateKnowledge(m.knowledge).changed, false, 'idempotent');
  const newer = migrateKnowledge({ version: KNOWLEDGE_VERSION + 1, rules: [] });
  assert.equal(newer.newer, true); assert.equal(newer.changed, false);
});

test('the profile file is migrated on load, after a one-time copy of the file as it was', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-mig-'));
  const file = path.join(dir, 'domain-profiles.json');
  const learnedFrom = urlOf('a');
  const v1 = { 'protected.test': { runs: 1, siteKnowledge: { version: 1, rules: [{ ...newRule({ field: 'brand', selector: '.b', learnedFrom }), tests: { ok: 1, total: 1, urls: [learnedFrom], recent: '1' } }] } } };
  fs.writeFileSync(file, JSON.stringify(v1));
  const store = createProfileStore(profileFileIo(file, { warn: () => {} }));
  assert.equal(store.get(ORIGIN).siteKnowledge.version, KNOWLEDGE_VERSION);
  const copy = path.join(dir, `domain-profiles.before-knowledge-v${KNOWLEDGE_VERSION}.json`);
  assert.deepEqual(JSON.parse(fs.readFileSync(copy, 'utf8')), v1, 'the copy is the file before the migration');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))['protected.test'].siteKnowledge.rules[0].tests.total, 0, 'migrated on disk');
  // A second app start: nothing to migrate, the copy is never overwritten.
  fs.writeFileSync(copy, 'KEEP');
  createProfileStore(profileFileIo(file, { warn: () => {} })).get(ORIGIN);
  assert.equal(fs.readFileSync(copy, 'utf8'), 'KEEP');
});

test('outcomes read on the teaching page are not evidence for the rule', () => {
  const rule = designateDescription('a');
  const k = { version: 2, rules: [rule] };
  const onA = applyKnowledge(parseHTML(built('a')).document, k, { url: urlOf('a') });
  const onB = applyKnowledge(parseHTML(built('b')).document, k, { url: urlOf('b') });
  const totals = foldOutcomes(foldOutcomes({}, onA), onB);
  assert.deepEqual(totals[rule.id], { ok: 1, fail: 0 }, 'B counts, A does not');
  const row = { name: 'Parfum B' };
  assert.deepEqual(mergeKnowledgeIntoRow(row, onB), ['description']);
  assert.match(row.description, /bergamote/);
});

// ---- the way to read product pages, per site --------------------------------------------

test('detail access: learned from what a run saw, the cheapest way that worked, forgotten when old', () => {
  const t1 = createAccessTracker(); t1.note('http', false); t1.note('extension', true);
  assert.equal(t1.verdict(), 'extension', 'HTTP refused, the user’s browser read the pages');
  const t2 = createAccessTracker(); t2.note('extension', true);
  assert.equal(t2.verdict(), null, 'pages from the user’s browser alone prove nothing about HTTP');
  const t3 = createAccessTracker(); t3.note('http', false); t3.note('browser', true); t3.note('extension', true);
  assert.equal(t3.verdict(), 'browser');
  const t4 = createAccessTracker(); t4.note('http', true); t4.note('http', false);
  assert.equal(t4.verdict(), 'http');
  const now = Date.parse('2026-10-25T10:00:00Z');
  const p = mergeProfile(null, { detailAccess: 'extension' }, new Date(now).toISOString());
  assert.equal(detailAccessOf(p, now), 'extension');
  assert.equal(detailAccessOf(p, now + DETAIL_ACCESS_TTL_MS + 1), null, 'expired: the cheaper ways are tried again');
  assert.equal(mergeProfile(p, { detailAccess: 'nope' }).detailAccess, 'extension', 'an unknown value is ignored');
});

test('the job plan: product pages opened in the user’s browser unless the site answers HTTP for them', () => {
  assert.deepEqual(detailPlan({ maxDetailPages: 5 }, null), { follow: true, max: 5 });
  assert.deepEqual(detailPlan({ maxDetailPages: 5 }, { detailAccess: 'http' }), { follow: false, max: 5 });
  assert.deepEqual(detailPlan({ maxDetailPages: 0 }, { detailAccess: 'extension' }), { follow: false, max: 0 });
  const prog = defaultProgram({ mode: 'auto' }, { detail: { follow: true, max: 3 } });
  assert.deepEqual(prog.actions.map((a) => a.op), ['extract', 'followLinks']);
  assert.equal(prog.actions[1].max_links, 3);
  assert.equal(defaultProgram({ mode: 'auto' }, { detail: { follow: false, max: 3 } }).actions.length, 1);
  assert.equal(detailPlanOf({ follow: true, max: 0 }), null);
  assert.equal(sameSiteUrl('https://www.protected.test/p/x', 'protected.test'), true);
  assert.equal(sameSiteUrl('https://fr.protected.test/p/x', 'protected.test'), true);
  assert.equal(sameSiteUrl('https://evil.test/p/x', 'protected.test'), false);
  assert.equal(sameSiteUrl('javascript:alert(1)', 'protected.test'), false);
});

// ---- the extension's job opens the product pages ------------------------------------------

function mockPage(pages) {
  const visited = []; let settled = 0; let cur = LIST;
  return {
    visited, get settled() { return settled; },
    page: {
      async goto(u) { visited.push(u); cur = u; return { status: 200, url: u, body: pages[u] || '' }; },
      async context() { return { status: 200, url: cur, body: pages[cur] || '' }; },
      async settle() { settled++; },
    },
  };
}
const listed = () => [...IDS.map((id) => ({ name: `Parfum ${id}`, sourceUrl: urlOf(id) })), { name: 'Ailleurs', sourceUrl: 'https://other.test/p/z' }];
const envFor = (m, { onDetailPage, strategy } = {}) => ({
  page: m.page, limits: { maxDetailPages: 3 }, now: () => 0, sleep: async () => {}, signal: { aborted: false },
  extractors: { auto: async () => listed() },
  acceptDetailUrl: (u) => sameSiteUrl(u, 'protected.test'),
  onDetailPage,
  challenge: { registry: { create: () => ({ handle: async () => strategy || { resolution: RESOLUTION.BLOCKED } }) }, detect: {} },
});

test('followLinks: within the « Fiches produit » limit, same site only, each page settled then handed over', async () => {
  const pages = Object.fromEntries(IDS.map((id) => [urlOf(id), built(id)]));
  const m = mockPage(pages);
  const handed = [];
  const out = await runProgram(defaultProgram({ mode: 'auto' }, { detail: { follow: true, max: 9 } }), envFor(m, { onDetailPage: async (u) => { handed.push(u); } }));
  assert.equal(out.status, JOB_STATUS.DONE);
  assert.deepEqual(m.visited, [urlOf('a'), urlOf('b'), urlOf('c')], 'the env limit (3) wins over the plan (9); the other site is never opened');
  assert.deepEqual(handed, m.visited); assert.equal(m.settled, 3);
  assert.equal(out.detailPages, 3); assert.equal(out.products.length, 5, 'rows are never dropped for lack of a page');
});

test('followLinks: a human check on a product page pauses the job (strategy) and ends it « blocked » with the rows read so far', async () => {
  const pages = { [urlOf('a')]: built('a'), [urlOf('b')]: BLOCK_PAGE };
  const m = mockPage(pages);
  const handed = [];
  const out = await runProgram(defaultProgram({ mode: 'auto' }, { detail: { follow: true, max: 3 } }), envFor(m, { onDetailPage: async (u) => { handed.push(u); } }));
  assert.equal(out.status, JOB_STATUS.BLOCKED); assert.equal(out.reason, 'challenge_blocked');
  assert.deepEqual(handed, [urlOf('a')], 'the challenge page is never handed over as a product page');
  assert.equal(out.products.length, 5);
  // The user answered the check: the strategy resumes and the job goes on.
  const m2 = mockPage(pages); const handed2 = [];
  let calls = 0; m2.page.context = async () => ({ status: 200, url: urlOf('b'), body: calls++ ? built('b') : BLOCK_PAGE });
  const out2 = await runProgram(defaultProgram({ mode: 'auto' }, { detail: { follow: true, max: 2 } }), envFor(m2, { onDetailPage: async (u) => { handed2.push(u); }, strategy: { resolution: RESOLUTION.RESUMED } }));
  assert.equal(out2.status, JOB_STATUS.DONE); assert.deepEqual(handed2, [urlOf('a'), urlOf('b')]);
});

// ---- end to end through the app ----------------------------------------------------------

test('protected site: a rule is tested on pages the user’s browser read; a job completes from them; the way is remembered', async () => {
  const { dirs, fetcher, make } = boot();
  const ctl = make();
  const cache = createPageCache();
  const io = { knowledge: ctl.knowledge, controller: ctl, pageCache: cache };
  // 1. 🎯 on A: the other pages refuse plain HTTP → nothing tested yet, and it says so (no « 1/1 »).
  const learned = await handlePanelRequest({ op: 'learn', url: urlOf('a'), scope: 'product', rules: [designateDescription('a')], sampleUrls: [urlOf('b'), urlOf('c')] }, io);
  assert.equal(learned.ok, true); assert.equal(learned.sampled, 0);
  assert.deepEqual([learned.rules[0].tests.ok, learned.rules[0].tests.total], [0, 0]);
  assert.equal(learned.rules[0].taughtOnly, true);
  assert.match(learned.rules[0].describe, /pas encore testée sur d’autres fiches/);
  // 2. The extension opens B and C in the user's browser and the app tests the rule on exactly those pages.
  for (const id of ['b', 'c']) assert.equal((await handlePanelRequest({ op: 'page', url: urlOf(id), runId: 'kt_check1', html: built(id) }, io)).ok, true);
  const rt = await handlePanelRequest({ op: 'retest', url: urlOf('a'), field: 'description', pageRunId: 'kt_check1' }, io);
  assert.equal(rt.ok, true); assert.equal(rt.sampled, 2);
  assert.deepEqual([rt.rules[0].tests.ok, rt.rules[0].tests.total], [2, 2]);
  // 3. The panel preview gets the rules it applies itself (selectors included).
  const rules = await handlePanelRequest({ op: 'rules', url: LIST }, io);
  assert.equal(rules.ok, true); assert.equal(rules.knowledge.rules[0].selector, learned.rules[0] && ctl.knowledge.forEngine(LIST).rules[0].selector);
  // 4. « Accepter »: the user's browser sent A and B; HTTP is refused for C and D (no app browser here).
  for (const id of ['a', 'b']) await handlePanelRequest({ op: 'page', url: urlOf(id), runId: 'pr_run1', html: built(id) }, io);
  const rows = IDS.map((id) => ({ name: `Parfum ${id.toUpperCase()}`, price: 50 + IDS.indexOf(id), currency: 'EUR', sourceUrl: urlOf(id) }));
  const res = await handlePanelRequest({ op: 'ingest', url: LIST, runId: 'pr_run1', rows, fields: [{ key: 'name' }] }, io);
  assert.equal(res.ok, true);
  const prods = productsOf(dirs, res.jobId);
  const byUrl = (id) => prods.find((p) => p.source_url === urlOf(id));
  assert.match(byUrl('a').description, /édition a/); assert.match(byUrl('b').description, /édition b/);
  assert.ok(!byUrl('c').description, 'C was not read: left empty, never invented');
  assert.equal(profileOf(dirs).detailAccess, 'extension', 'HTTP refused + the user’s browser read them → remembered');
  const rep = reportOf(dirs, res.jobId);
  assert.equal(rep.detailAccess.learned, 'extension'); assert.equal(rep.detailAccess.browserPages, 2);
  // 5. Next job: the site is known to need the user's browser — no HTTP request for its product pages.
  const before = fetcher.calls.length;
  for (const id of ['c']) await handlePanelRequest({ op: 'page', url: urlOf(id), runId: 'pr_run2', html: built(id) }, io);
  const res2 = await handlePanelRequest({ op: 'ingest', url: LIST, runId: 'pr_run2', rows: rows.slice(2), fields: [{ key: 'name' }] }, io);
  assert.equal(fetcher.calls.slice(before).filter((u) => /\/p\//.test(u)).length, 0, 'no HTTP retry of a refused way');
  const prods2 = productsOf(dirs, res2.jobId);
  assert.match(prods2.find((p) => p.source_url === urlOf('c')).description, /édition c/);
  const rep2 = reportOf(dirs, res2.jobId);
  assert.equal(rep2.detailAccess.used, 'extension');
  assert.ok(rep2.notes.some((n) => /ne laisse lire ses fiches que dans votre navigateur/.test(n)), 'D unread: the report says why and what to do');
});

// ---- the list reader per site (the access ladder's last rung) -------------------------------------

test('list reader: the user’s browser is remembered for a site that refuses the app, forgotten when the app reads it again or after a week', async () => {
  const { listAccessOf } = await import('../../core/domain-profile.mjs');
  const now = Date.parse('2026-10-25T10:00:00Z');
  let p = mergeProfile({ blockedBy: 'ACCESS_DENIED', needsUnlock: true }, { listAccess: 'extension' }, new Date(now).toISOString());
  assert.equal(listAccessOf(p, now), 'extension');
  assert.equal(listAccessOf(p, now + DETAIL_ACCESS_TTL_MS + 1), null, 'a week later the app tries its own (cheaper) ways again');
  p = mergeProfile(p, { listAccess: 'app' }, new Date(now).toISOString());
  assert.equal(listAccessOf(p, now), 'app');
  p = mergeProfile(p, { listAccess: null }, new Date(now).toISOString());
  assert.equal(listAccessOf(p, now), null, 'the app was refused again: no longer the reader');
});

test('a list the app was refused, read in the user’s browser: that site is launched in the user’s browser next time', async () => {
  const { dirs, make } = boot();
  fs.writeFileSync(path.join(dirs.data, 'domain-profiles.json'), JSON.stringify({ 'protected.test': { blockedBy: 'ACCESS_DENIED', needsUnlock: true, runs: 1 } }));
  const ctl = make();
  assert.equal(ctl.prefersYourBrowser(LIST), false);
  const rows = IDS.map((id) => ({ name: `Parfum ${id.toUpperCase()}`, price: 50, currency: 'EUR', sourceUrl: urlOf(id) }));
  const res = await ctl.ingestExternalProducts({ products: rows, origin: LIST, method: 'your-browser', outcome: { status: 'done', blocked: null, stoppedByUser: false, text: '' } });
  assert.equal(reportOf(dirs, res.jobId).listAccess, 'extension');
  assert.equal(ctl.prefersYourBrowser(LIST), true);
  const { createYourBrowserService } = await import('../your-browser/integration.mjs');
  const svc = createYourBrowserService({ config: {}, prefersYourBrowser: (u) => ctl.prefersYourBrowser(u) });
  assert.equal(svc.availability(LIST).preferred, true, 'the renderer launches it in the user’s browser directly');
  assert.equal(svc.availability('https://other.test/x').preferred, false);
});
