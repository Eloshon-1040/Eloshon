// Phase 3: a job report never says OK while something was left unread, says where the time went, and shows
// what each field holds (not only how many pages were visited).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyPartialStatus, formatReport, timingsLine } from '../engine.mjs';
import { runProgram } from '../../shared/dsl/interpret.mjs';
import { DomainPacer } from '../../shared/pacing/pacer.mjs';
import { fillRates } from '../fill-rate.mjs';
import { jobManifest, writeJobManifest } from '../job-manifest.mjs';
import { finishJobReport } from '../../app/controller.mjs';
import { handlePanelRequest } from '../../app/your-browser/panel-requests.mjs';

const okReport = (extra = {}) => ({ store: 's', status: 'OK', toVerify: 0, detailPages: { listed: 36, candidates: 36, visited: 36, completed: 36, unchanged: 0, failed: 0, skipped: 0, reasons: {} }, ...extra });

test('PARTIAL when the app browser stopped re-reading, when a rule failed, when the extension left pages unread', () => {
  assert.equal(applyPartialStatus(okReport()).status, 'OK');
  const stop = applyPartialStatus(okReport({ pagesViaBrowser: 1, browserPagesStop: 'human_check', browserPagesNotRead: 1, detailAccess: { counts: { extension: { ok: 36 } } } }));
  assert.equal(stop.status, 'PARTIAL'); assert.equal(stop.partial.browserStop, 'human_check');
  const txt = formatReport(stop);
  assert.match(txt, /relectures par le navigateur de l'app: 1 fiche\(s\) — arrêtées par une vérification humaine : ce navigateur n'a pas pu relire 1 fiche\(s\), l'extension en a lu 36/);
  assert.doesNotMatch(txt, /pages via browser/);
  const rule = applyPartialStatus(okReport({ knowledgeInvalidated: [{ field: 'variants', ruleId: 'product.variants.x', reason: 'en échec' }] }));
  assert.equal(rule.status, 'PARTIAL'); assert.deepEqual(rule.partial.rulesInvalidated, ['variants']);
  const ext = applyPartialStatus(okReport({ yourBrowserPages: { toRead: 3, read: 2, blocked: 1, notOpened: 0 } }));
  assert.equal(ext.status, 'PARTIAL'); assert.equal(ext.partial.extensionPagesUnread, 1);
  assert.match(formatReport(ext), /extension pages: +2 read of 3 in your browser, 1 blocked/);
  // A stopped run keeps its own code.
  assert.equal(applyPartialStatus({ status: 'STOPPED_BY_USER', browserPagesStop: 'human_check' }).status, 'STOPPED_BY_USER');
});

test('the report shows the fill rate per field', () => {
  const products = [
    { name: 'A', price: 1, source_url: 'https://s.test/a', description: 'x', raw: { brand: 'B' }, images: ['i'] },
    { name: 'B', price: 2, source_url: 'https://s.test/b', description: '', raw: {}, images: [] },
  ];
  const rep = okReport({ fill: fillRates(products) });
  const line = formatReport(rep).split('\n').find((l) => l.startsWith('fill rate:'));
  assert.match(line, /nom 100 %/); assert.match(line, /description 50 %/); assert.match(line, /marque 50 %/); assert.match(line, /\(2 products\)/);
});

test('extension pacing weighs the server time, not the whole page build (the 1132 s of 36 product pages)', async () => {
  // Each product page takes 4 s to build in the browser; the server answers in 300 ms.
  const run = async (serverMs) => {
    let t = 0;
    const pacer = new DomainPacer({ baseIntervalMs: 1500 }, { now: () => t, random: () => 0.5 });
    const products = Array.from({ length: 36 }, (_, i) => ({ name: `P${i}`, url: `https://shop.test/p/${i}` }));
    const page = {
      goto: async (u) => { t += 4000; return { url: u, body: '<html></html>', status: 200, serverMs }; },
      context: async () => ({ url: 'https://shop.test/list', body: '', status: 200, serverMs }),
      settle: async () => { t += 1000; },
    };
    const env = {
      page, pacer, now: () => t, sleep: async (ms) => { t += ms; }, limits: { maxListPages: 1, maxDetailPages: 100, maxProducts: 100 },
      extractors: { auto: async () => products }, onDetailPage: async () => { t += 2000; },
    };
    const out = await runProgram({ actions: [{ op: 'extract', using: 'auto' }, { op: 'followLinks', max_links: 100 }] }, env);
    return out.timings;
  };
  const fixed = await run(300);
  const before = await run(undefined); // a page without its server time: the old behaviour (page build weighed)
  assert.equal(fixed.detailPages, 36);
  assert.ok(fixed.pacingMs < 100000, `pacing wait ${fixed.pacingMs} ms`);
  assert.ok(before.pacingMs > 500000, `old pacing wait ${before.pacingMs} ms`);
  assert.equal(fixed.totalMs, fixed.listMs + fixed.pacingMs + fixed.loadMs + fixed.checkMs + fixed.settleMs + fixed.readMs);
  assert.match(timingsLine({ totalMs: fixed.totalMs, extension: fixed, app: { productPagesMs: 1200, exportMs: 30 } }), /extension .*pacing wait .*page loads 144\.0 s.*\(36 product page\(s\)\); app: product pages 1\.2 s, export 0\.0 s/);
});

test('a job writes its manifest beside products.json and the CSV; a page blocked by a human check is listed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elo-manifest-'));
  const paths = { dir: path.join(dir, 'jobs', 'J1'), csv: path.join(dir, 'csv', 'J1.csv') };
  const products = [{ name: 'A', price: 1, source_url: 'https://s.test/a', description: 'x' }, { name: 'B', price: 2, source_url: 'https://s.test/b' }];
  const report = applyPartialStatus(okReport({ yourBrowserPages: { toRead: 2, read: 1, blocked: 1, notOpened: 0, list: [{ url: 'https://s.test/b', reason: 'human_check' }] } }));
  finishJobReport({ id: 'J1', products, paths }, report, 'https://s.test/cat', { source: 'extension', totalMs: 5000 });
  assert.equal(report.manifest.status, 'partial');
  assert.deepEqual(report.manifest.files, ['manifest.json', 'J1.manifest.json']);
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'csv', 'J1.manifest.json'), 'utf8'));
  assert.equal(m.jobStatus, 'PARTIAL'); assert.equal(m.source, 'extension'); assert.equal(m.site, 's.test');
  assert.deepEqual(m.productPages.list, [{ url: 'https://s.test/b', reason: 'human_check' }]);
  assert.equal(m.fill.description.filled, 1);
  assert.match(formatReport(report), /export manifest: +partial \(manifest\.json, J1\.manifest\.json\)/);
  // Same manifest from the pure builder; writing never throws.
  assert.equal(jobManifest({ report, products, jobId: 'J1' }).status, 'partial');
  assert.deepEqual(writeJobManifest({ dir: path.join(dir, 'x'), csv: path.join(dir, 'y', 'J2.csv') }, { a: 1 }).length, 2);
});

test('the panel ingest passes what your browser read (blocked page listed) to the job', async () => {
  let got = null;
  const controller = { ingestExternalProducts: async (input) => { got = input; return { jobId: 'J1', status: 'done', reportStatus: 'PARTIAL', counts: {} }; } };
  await handlePanelRequest({ op: 'ingest', url: 'https://s.test/cat', rows: [{ name: 'A', sourceUrl: 'https://s.test/a' }], enrich: { toRead: 2, read: 1, blocked: 1, notOpened: 0, list: [{ url: 'https://s.test/b', reason: 'human_check' }, { url: 'javascript:x', reason: 'human_check' }] } }, { controller });
  assert.deepEqual(got.yourBrowserPages, { toRead: 2, read: 1, blocked: 1, notOpened: 0, list: [{ url: 'https://s.test/b', reason: 'human_check' }] });
});
