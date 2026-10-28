/**
 * scripts/ops-last-scraps.mjs — the read-only report of the latest scraps (skill eloshon-scraper-ops, §3).
 *
 * Offline and read-only by construction: a fixture userData folder is built in the temp dir (jobs,
 * reports, a ledger written by the real writer); `fetch` and every socket throw while the report runs;
 * the folder is compared file by file (path, size, mtime) before and after.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLedger } from '../metering/ledger.mjs';
import {
  buildReport, formatText, fillRates, findAnomalies, collapses, summarizeChain, parseArgs, defaultUserData,
  run, isFilled, outcomeLabel, listJobIds, MIN_COMPARE,
} from '../../scripts/ops-last-scraps.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/ops-last-scraps.mjs', import.meta.url));
const ID_A = '20261001100000-aaaaa'; // oldest: shop.test, healthy
const ID_B = '20261002100000-bbbbb'; // shop.test again: columns collapsed, anomalies, paid lane (admin test mode)
const ID_C = '20261003100000-ccccc'; // other site, extension run, no ledger line

const product = (i, over = {}) => ({
  source_url: `https://shop.test/p/${i}`, source_product_id: `REF${i}`, source_category: 'Shoes', name: `Model ${i}`, price: 10 + i,
  barcode: `54000000${i}`, description: `Description ${i}`, images: [`https://cdn.test/${i}-1.jpg`, `https://cdn.test/${i}-2.jpg`],
  image_url: `https://cdn.test/${i}-1.jpg`, color: 'Black', variants: [{ type: 'couleur', code: 'c1', name: 'Black' }],
  raw: { brand: 'Acme', list_price: 20 + i, currency: 'EUR' }, ...over,
});
const range = (n) => Array.from({ length: n }, (_, i) => i + 1);
const made = []; // temp folders of this file, removed at the end
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

function writeJob(root, id, { meta, report, products, status = 'done', createdAt, reason }) {
  const dir = path.join(root, 'data', 'jobs', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'reports'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ id, createdAt, status, config: {}, meta, report, ...(reason ? { reason } : {}) }));
  if (products) fs.writeFileSync(path.join(dir, 'products.json'), JSON.stringify(products));
  if (report) fs.writeFileSync(path.join(root, 'data', 'reports', `${id}.json`), '﻿' + JSON.stringify(report)); // BOM: tolerated
}

function fixture() {
  const root = tmp('eloshon-ops-');
  const A = range(8).map((i) => product(i));
  writeJob(root, ID_A, {
    createdAt: '2026-10-01T10:00:00.000Z', meta: { origin: 'https://www.shop.test/c/shoes', provider: 'manual' }, products: A,
    report: { status: 'OK', method: 'crawl', byStrategy: { 'generic-jsonld': 8 }, discovered: 8, accepted: 8, toVerify: 0, excluded: 0,
      pagination: { mechanism: 'url-param', pages: 3, totalAnnounced: 8, stoppedBy: 'total_reached', warnings: [] }, detailPages: { listed: 8, visited: 8, completed: 8, failed: 0 } },
  });
  const B = range(8).map((i) => product(i, { raw: { brand: null, list_price: null, currency: 'EUR' }, description: null }));
  B[1] = product(1, { raw: { brand: null, list_price: null, currency: 'EUR' }, description: null });           // same URL and reference as B[0]
  B[2].price = 0;                                                                                                   // price at 0
  for (const k of [3, 4, 5]) B[k].variants = [{ type: 'couleur', code: `c${k}`, name: null, image: 'https://cdn.test/sw.png' }]; // colour without a name
  B[6].images = ['https://cdn.test/x.jpg', 'https://cdn.test/x.jpg'];                                               // same picture twice
  writeJob(root, ID_B, {
    createdAt: '2026-10-02T10:00:00.000Z', meta: { origin: 'https://shop.test/c/shoes', provider: 'manual', testMode: true }, products: B, reason: 'accès refusé (site protégé)',
    report: { status: 'OK', method: 'firecrawl', byStrategy: { firecrawl: 8 }, discovered: 8, accepted: 7, toVerify: 1, excluded: 0,
      pagination: { mechanism: 'browser-scroll', pages: 2, totalAnnounced: 40, stoppedBy: 'scroll_end', warnings: ['total_not_reached'], apiAfterScroll: { pages: 1, added: 2, headersLearned: 2 } } },
  });
  writeJob(root, ID_C, {
    createdAt: '2026-10-03T10:00:00.000Z', meta: { origin: 'https://other.test/list', provider: 'your-browser' }, products: range(3).map((i) => product(i, { source_url: `https://other.test/p/${i}`, raw: { brand: 'Zed', columns: { Ville: i === 3 ? '' : 'Liège' } } })),
    report: { status: 'OK', method: 'your-browser', executor: 'votre navigateur (extension Eloshon Scraper, aucun fournisseur payant)', accepted: 3, toVerify: 0, excluded: 0 },
  });
  // The ledger is written by the real writer, one file, in the userData folder.
  const ledger = createLedger({ dir: path.join(root, 'usage-ledger') });
  ledger.record({ ts: '2026-10-01T10:00:05.000Z', jobId: ID_A, domain: 'shop.test', provider: 'local', route: 'crawl', outcome: 'success', products: 8 });
  ledger.record({ ts: '2026-10-02T10:00:05.000Z', jobId: ID_B, domain: 'shop.test', provider: 'local', route: 'crawl', outcome: 'failed', reason: 'needs-unlock', products: 0, testMode: true });
  ledger.record({ ts: '2026-10-02T10:00:09.000Z', jobId: ID_B, domain: 'shop.test', provider: 'firecrawl', route: 'escalation', channel: 'direct', outcome: 'success', reason: 'test_mode', products: 8, credits: 1, costUsd: 0.0042, testMode: true });
  ledger.record({ ts: '2026-10-02T10:00:10.000Z', jobId: ID_B, domain: 'shop.test', provider: 'webunlocker', route: 'escalation', outcome: 'blocked_no_optin', attempted: false, reason: 'no_optin', testMode: true });
  ledger.record({ ts: '2026-10-02T10:00:11.000Z', jobId: ID_B, domain: 'shop.test', provider: 'scrapingbrowser', route: 'escalation', outcome: 'skipped', attempted: false, reason: 'priority', testMode: true });
  ledger.close();
  return { root, A, B };
}

/** (path, size, mtime) of every file under a folder — proves a run wrote nothing. */
function tree(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) tree(p, base, out);
    else { const s = fs.statSync(p); out.push(`${path.relative(base, p)}|${s.size}|${s.mtimeMs}`); }
  }
  return out;
}

test('isFilled: text, numbers (0 counts), lists and objects; empty things do not', () => {
  assert.equal(isFilled('x'), true); assert.equal(isFilled('  '), false); assert.equal(isFilled(''), false);
  assert.equal(isFilled(0), true); assert.equal(isFilled(NaN), false); assert.equal(isFilled(null), false); assert.equal(isFilled(undefined), false);
  assert.equal(isFilled([]), false); assert.equal(isFilled([1]), true); assert.equal(isFilled({}), false); assert.equal(isFilled({ a: 1 }), true);
});

test('fillRates: one rate per column of §3 (name, price, URL, reference, images, colour, variants, EAN, description, brand, category, struck price)', () => {
  const f = fillRates([product(1), product(2, { barcode: null, raw: { brand: 'Acme', list_price: null } }), product(3, { images: [], image_url: null, color: '' })]);
  assert.equal(f.total, 3);
  assert.deepEqual(f.fields.map((x) => x.key), ['nom', 'prix', 'url', 'reference', 'images', 'couleur', 'variantes', 'ean', 'description', 'marque', 'categorie', 'prix_barre']);
  const by = Object.fromEntries(f.fields.map((x) => [x.key, x.pct]));
  assert.equal(by.nom, 100); assert.equal(by.ean, 67); assert.equal(by.images, 67); assert.equal(by.couleur, 67); assert.equal(by.prix_barre, 67); assert.equal(by.marque, 100);
  assert.deepEqual(fillRates([]).fields.map((x) => x.pct), Array(12).fill(null), 'no product: no percentage, never a made-up 0');
});

test('findAnomalies: duplicates, colours without a name, price at 0, the same picture twice', () => {
  const { B } = fixture();
  const codes = Object.fromEntries(findAnomalies(B).map((a) => [a.code, a.products]));
  assert.equal(codes.duplicate_url, 2); assert.equal(codes.duplicate_reference, 2);
  assert.equal(codes.colour_without_name, 3); assert.equal(codes.price_zero, 1); assert.equal(codes.duplicate_images, 1);
  assert.deepEqual(findAnomalies([product(1), product(2)]), [], 'a healthy list has no anomaly');
});

test('collapses: only columns that lost more than 10 points', () => {
  const healthy = fillRates(range(10).map((i) => product(i)));
  const worse = fillRates(range(10).map((i) => product(i, { raw: { brand: i <= 5 ? 'Acme' : null, list_price: 5 }, barcode: i <= 1 ? null : '1' })));
  const c = collapses(worse, healthy);
  assert.deepEqual(c.map((x) => x.key), ['marque'], 'brand 100 → 50; EAN 100 → 90 is a loss of exactly 10 points, not more');
  assert.deepEqual(c[0], { key: 'marque', label: 'marque', from: 100, to: 50 });
});

test('summarizeChain: lanes tried, paid lane tried, refusals apart from lanes not tried, cost and credits', () => {
  const lines = [
    { ts: '2026-10-02T10:00:10.000Z', provider: 'webunlocker', outcome: 'blocked_no_optin', attempted: false, reason: 'no_optin' },
    { ts: '2026-10-02T10:00:05.000Z', provider: 'local', outcome: 'failed', attempted: true, products: 0 },
    { ts: '2026-10-02T10:00:09.000Z', provider: 'firecrawl', outcome: 'success', attempted: true, credits: 1, costUsd: 0.0042, testMode: true },
    { ts: '2026-10-02T10:00:11.000Z', provider: 'scrapingbrowser', outcome: 'skipped', attempted: false, reason: 'priority' },
    { ts: '2026-10-02T10:00:12.000Z', provider: 'zyte', outcome: 'success', attempted: true, costUsd: null },
  ];
  const s = summarizeChain(lines);
  assert.deepEqual(s.chain.map((c) => c.provider), ['local', 'firecrawl', 'zyte'], 'ordered by time, only lanes really tried');
  assert.equal(s.paidAttempted, 2); assert.deepEqual(s.paidProviders, ['firecrawl', 'zyte']);
  assert.deepEqual(s.refused.map((r) => r.provider), ['webunlocker']);
  assert.deepEqual(s.notTried.map((r) => `${r.provider}:${r.reason}`), ['scrapingbrowser:priority']);
  assert.equal(s.costUsd, 0.0042); assert.equal(s.costUnknown, 1); assert.equal(s.credits, 1); assert.equal(s.testMode, true);
});

test('outcomeLabel: the two refusals keep their ledger code, a stop by the user is not a failure', () => {
  assert.match(outcomeLabel({ outcome: 'blocked_no_optin' }), /blocked_no_optin/);
  assert.match(outcomeLabel({ outcome: 'blocked_by_cap' }), /blocked_by_cap/);
  assert.equal(outcomeLabel({ outcome: 'skipped', attempted: true, reason: 'stopped_by_user' }), 'interrompue par l\'utilisateur');
  assert.equal(outcomeLabel({ outcome: 'skipped', attempted: false, reason: 'priority' }), 'non utilisée');
  assert.equal(outcomeLabel({ outcome: 'success' }), 'réussite');
});

test('buildReport: newest first, ledger lines joined by job id, previous pass of the same site compared, no ledger line = no cost invented', async () => {
  const { root } = fixture();
  const rep = await buildReport({ userData: root, last: 3 });
  assert.deepEqual(rep.jobs.map((j) => j.id), [ID_C, ID_B, ID_A]);
  assert.equal(rep.ledger.events, 5); assert.equal(rep.ledger.badLines, 0);
  const [c, b, a] = rep.jobs;
  assert.equal(c.chain, null, 'a job without ledger line has no chain and no cost');
  assert.equal(c.domain, 'other.test'); assert.equal(c.launcher.provider, 'your-browser');
  assert.deepEqual(c.fill.panelColumns, [{ label: 'Ville', filled: 2, total: 3, pct: 67 }]);
  assert.equal(b.domain, 'shop.test', 'www. is dropped'); assert.equal(a.domain, 'shop.test');
  assert.equal(b.chain.paidAttempted, 1); assert.equal(b.chain.costUsd, 0.0042); assert.equal(b.launcher.testMode, true);
  assert.equal(b.list.pagination.mechanism, 'browser-scroll'); assert.deepEqual(b.list.pagination.warnings, ['total_not_reached']);
  assert.deepEqual(b.list.apiAfterScroll, { pages: 1, added: 2, headersLearned: 2 });
  assert.equal(b.collapsed.since, ID_A); assert.equal(b.collapsed.method, 'crawl');
  assert.deepEqual(b.collapsed.columns.map((x) => x.key).sort(), ['description', 'marque', 'prix_barre']);
  assert.equal(a.collapsed, null, 'the oldest pass of a site has nothing to be compared with');
  assert.equal(a.list.detailPages.completed, 8);
  assert.equal(a.chain.paidAttempted, 0);
  assert.ok(MIN_COMPARE >= 1);
});

test('buildReport: --job selects, an unknown job is reported as such, a damaged job does not stop the others', async () => {
  const { root } = fixture();
  writeJob(root, '20261004100000-ddddd', { createdAt: '2026-10-04T10:00:00.000Z', meta: { origin: 'https://shop.test/x' }, report: null });
  fs.writeFileSync(path.join(root, 'data', 'jobs', '20261004100000-ddddd', 'products.json'), '{not json');
  const rep = await buildReport({ userData: root, jobIds: ['20261004100000-ddddd', ID_A, '20269999999999-zzzzz'] });
  assert.deepEqual(rep.jobs.map((j) => j.id), ['20261004100000-ddddd', ID_A, '20269999999999-zzzzz']);
  assert.equal(rep.jobs[0].source.products, 'illisible'); assert.equal(rep.jobs[0].fill, null);
  assert.equal(rep.jobs[1].counts.inFile, 8);
  assert.equal(rep.jobs[2].found, false);
  const text = formatText(rep);
  assert.match(text, /20269999999999-zzzzz · introuvable/);
  assert.match(text, /aucun produit exploitable \(products\.json : illisible\)/);
});

test('formatText: states what the skill asks for — route, refusals, cost, list, fiches, fill rates, anomalies', async () => {
  const { root } = fixture();
  const text = formatText(await buildReport({ userData: root, last: 3 }));
  assert.match(text, new RegExp(`■ Job ${ID_B} · shop\\.test · OK \\(job : done\\)`));
  assert.match(text, /Lancement   : logiciel · mode test administrateur/);
  assert.match(text, /Voies       : local\/crawl \(échec \[needs-unlock\], 0 produit\) → firecrawl\/escalation \(réussite \[test_mode\], 8 produits\)/);
  assert.match(text, /Refusées    : webunlocker — domaine non autorisé \(blocked_no_optin\) \[no_optin\]/);
  assert.match(text, /Non tentées : scrapingbrowser \[priority\]/);
  assert.match(text, /Coût        : 1 appel\(s\) payant\(s\) tenté\(s\) : firecrawl · 1 crédit\(s\) · 0,0042 \$ estimés/);
  assert.match(text, /Liste       : browser-scroll, 2 page\(s\) lue\(s\), total annoncé : 40, arrêt : scroll_end, avertissements : total_not_reached/);
  assert.match(text, /Après défilement : API du site, 1 page\(s\), 2 produit\(s\) ajouté\(s\), 2 en-tête\(s\) repris de la page/);
  assert.match(text, /Fiches      : 8 complétée\(s\) sur 8 visitée\(s\)/);
  assert.match(text, /Remplissage \(8 produits\) : nom 100 % · prix 100 %/);
  assert.match(text, /coloris sans nom de couleur/);
  assert.match(text, /en baisse de plus de 10 points depuis le job 20261001100000-aaaaa \(méthode crawl\)/);
  assert.match(text, /Coût        : non établi : aucune ligne dans le registre pour ce job/, 'job C has no ledger line');
  assert.match(text, /Coût        : 0 \$ \(aucune voie payante tentée\)/, 'job A only used a free lane');
  assert.match(text, /Vides partout : .*\bEAN\b/s);
  assert.match(text, /Colonnes du panneau : Ville 67 %/);
});

test('the report is read-only and offline: nothing is written, no fetch, no socket', async () => {
  const { root } = fixture();
  const before = tree(root);
  const realFetch = globalThis.fetch; const realConnect = net.Socket.prototype.connect;
  let attempts = 0;
  globalThis.fetch = async () => { attempts++; throw new Error('network call'); };
  net.Socket.prototype.connect = function () { attempts++; throw new Error('network call'); };
  try {
    const out = []; const err = [];
    assert.equal(await run(['--user-data', root, '--last', '3'], { out: (s) => out.push(s), err: (s) => err.push(s) }), 0);
    assert.equal(await run(['--user-data', root, '--json'], { out: (s) => out.push(s), err: (s) => err.push(s) }), 0);
    assert.equal(err.length, 0); assert.ok(out.join('\n').includes(ID_B));
  } finally { globalThis.fetch = realFetch; net.Socket.prototype.connect = realConnect; }
  assert.equal(attempts, 0, 'no network use');
  assert.deepEqual(tree(root), before, 'no file created, changed or removed');
});

test('command line: JSON mode, default Windows folder, refusals with a French message', async () => {
  const { root } = fixture();
  const json = spawnSync(process.execPath, [SCRIPT, '--user-data', root, '--last', '2', '--json'], { encoding: 'utf8' });
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout).jobs.map((j) => j.id), [ID_C, ID_B]);
  const text = spawnSync(process.execPath, [SCRIPT, '--user-data', root, '--job', ID_A], { encoding: 'utf8' });
  assert.equal(text.status, 0, text.stderr); assert.match(text.stdout, new RegExp(`■ Job ${ID_A}`));
  const bad = spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8' });
  assert.equal(bad.status, 2); assert.match(bad.stderr, /option inconnue : --nope/);
  const missing = spawnSync(process.execPath, [SCRIPT, '--user-data', path.join(root, 'absent')], { encoding: 'utf8' });
  assert.equal(missing.status, 1); assert.match(missing.stderr, /Aucun dossier « data »/);
  // default folder: <APPDATA>\Eloshon Scraper on Windows, nothing guessed elsewhere
  const appdata = tmp('eloshon-appdata-');
  fs.cpSync(root, path.join(appdata, 'Eloshon Scraper'), { recursive: true });
  const out = [];
  assert.equal(await run(['--last', '1'], { out: (s) => out.push(s), env: { APPDATA: appdata }, platform: 'win32' }), 0);
  assert.match(out.join('\n'), new RegExp(ID_C));
  assert.equal(defaultUserData({ APPDATA: appdata }, 'win32'), path.join(appdata, 'Eloshon Scraper'));
  assert.equal(defaultUserData({}, 'win32'), null); assert.equal(defaultUserData({ APPDATA: appdata }, 'linux'), null);
  const err = []; assert.equal(await run([], { out() {}, err: (s) => err.push(s), env: {}, platform: 'linux' }), 2); assert.match(err[0], /donne --user-data/);
});

test('parseArgs: options are validated, --job can be repeated', () => {
  assert.deepEqual(parseArgs([]), { last: 5, jobIds: [], userData: null, json: false, help: false, error: null });
  assert.equal(parseArgs(['--last', '0']).error, '--last attend un entier positif');
  assert.match(parseArgs(['--job', 'abc']).error, /identifiant de job/);
  assert.deepEqual(parseArgs(['--job', ID_A, '--job', ID_B, '--json']).jobIds, [ID_A, ID_B]);
  assert.match(parseArgs(['--user-data']).error, /attend un dossier/);
});

test('listJobIds: only job ids, newest first; a folder with no data gives an empty list and a missing ledger is stated', async () => {
  const root = tmp('eloshon-ops-empty-');
  fs.mkdirSync(path.join(root, 'data', 'reports'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'reports', 'not-a-job.json'), '{}');
  fs.writeFileSync(path.join(root, 'data', 'reports', `${ID_A}.txt`), 'x');
  assert.deepEqual(listJobIds(root), []);
  const rep = await buildReport({ userData: root, last: 5 });
  assert.deepEqual(rep.jobs, []); assert.equal(rep.ledger.present, false);
  assert.match(formatText(rep), /dossier usage-ledger absent/);
});
