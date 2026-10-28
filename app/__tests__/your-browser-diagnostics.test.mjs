/**
 * Diagnostics of a "your browser" run (fixes after job 20260929222644-dm2zb):
 * an empty or failed run is never an "OK", the user gets a plain detail, the
 * journal gets the technical one (recipe source/revision, var names, lane error,
 * real duration), and each step is logged to the terminal. Mocked only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { appDirs, ensureDirs } from '../../lib/osenv.mjs';
import { createController } from '../controller.mjs';
import { createYourBrowserService } from '../your-browser/integration.mjs';
import { outcomeFor, readableDetail } from '../your-browser/launch.mjs';
import * as P from '../../shared/protocol/messages.mjs';

const CFG = { yourBrowser: { perDomain: { 'boutique-alpha.test': { enabled: true }, 'colruyt.be': { enabled: true } } } };
const until = async (fn, t = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 10)); } return false; };

function setup({ clock } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'elo-ybdiag-'));
  const dirs = ensureDirs(appDirs(base));
  const controller = createController({ dirs });
  const bridge = { sent: [], start() {}, stop() {}, send(m) { bridge.sent.push(m); } };
  const logs = [];
  const svc = createYourBrowserService({
    config: CFG, readConfig: () => CFG, controller, bridgeFactory: () => bridge, log: (m) => logs.push(m),
    resolveRecipe: (url) => controller.resolveExternalRecipe(url), newJobId: () => 'yb_diag_1', now: clock,
  });
  svc.start();
  bridge.onStatus('connected');
  bridge.onMessage(P.capabilities(['internal_api'], { browser: 'chrome' }));
  const journal = (jobId) => JSON.parse(fs.readFileSync(path.join(base, 'data', 'reports', `${jobId}.json`), 'utf8'));
  return { controller, svc, bridge, logs, journal, dirs };
}

test('readableDetail: plain French, never an HTTP code or a raw var syntax', () => {
  assert.match(readableDetail("Échec de l'action « extract » : var categoryId: not found on https://www.colruyt.be/fr/produits?page=1"), /« categoryId » sur cette page \(utilisez une page catégorie/);
  assert.match(readableDetail('var categoryId: no URL segment matches category_map'), /l’adresse ne contient pas « categoryId »/);
  assert.match(readableDetail('header X-CG-APIKey: source https://x → 403'), /clé d’accès/);
  const http = readableDetail('HTTP 456');
  assert.doesNotMatch(http, /\d{3}/);
  assert.equal(readableDetail(''), '');
});

test('an empty "done" is never OK: distinct status + detail when the lane said why', () => {
  assert.equal(outcomeFor({ status: 'done', products: [] }).status, 'stopped:no_products');
  const o = outcomeFor({ status: 'done', products: [], laneError: 'var categoryId: not found on https://x' });
  assert.match(o.text, /^Aucun produit trouvé sur cette page\. Détail : la recette n’a pas trouvé « categoryId »/);
  assert.equal(outcomeFor({ status: 'done', products: [{}] }).status, 'done');
});

test('Colruyt-like failure end to end: ERROR with plain reason for the user, technical detail + real duration in the journal, terminal trace', async () => {
  let t = 1_000_000; const clock = () => t;
  const { controller, svc, bridge, logs, journal } = setup({ clock });
  const res = await svc.launch({ startUrl: 'https://www.colruyt.be/fr/produits?page=1' });
  assert.equal(res.ok, true);
  assert.equal(res.recipeKind, 'internal_api');
  await until(() => bridge.sent.some((m) => m.type === P.MSG.JOB));
  t += 4200; // the extension worked for 4.2 s
  const reason = "Échec de l'action « extract » : var categoryId: not found on https://www.colruyt.be/fr/produits?page=1";
  bridge.onMessage(P.result('yb_diag_1', P.JOB_STATUS.ERROR, { reason, products: [], counts: { products: 0, fresh: 0, pages: 0 }, recipe_diag: { varsResolved: ['placeId'], varsMissing: ['categoryId'], laneError: 'var categoryId: not found on https://www.colruyt.be/fr/produits?page=1' } }));
  assert.ok(await until(() => controller.listJobs().length === 1));
  const job = controller.listJobs()[0];
  assert.equal(job.status, 'error', 'no longer a silent OK');
  assert.match(job.reason, /Détail : la recette n’a pas trouvé « categoryId » sur cette page/);
  const j = journal(job.id);
  assert.equal(j.status, 'error');
  assert.equal(j.durationMs, 4200, 'real duration, not 0');
  assert.equal(j.yourBrowser.recipeSource, 'bundled', 'where the recipe came from (offline → bundled)');
  assert.deepEqual(j.yourBrowser.recipeDiag.varsMissing, ['categoryId']);
  assert.match(j.yourBrowser.extensionReason, /categoryId: not found/);
  assert.match(controller.jobReport(job.id).text, /duration:\s+4\.2s/);
  const trace = logs.join('\n');
  assert.match(trace, /travail yb_diag_1 envoyé à l'extension — domaine colruyt\.be, recette internal_api \(source bundled/);
  assert.match(trace, /résultat error, 0 produit\(s\), 4\.2 s — raison : .*categoryId/);
  assert.match(trace, new RegExp(`enregistré comme job ${job.id} \\(error\\)`));
  assert.doesNotMatch(trace, /X-CG-APIKey:\s*\S{8,}/, 'no header value ever logged');
});

test('first progress and challenge pause are traced; a refused launch logs its code', async () => {
  const { svc, bridge, logs } = setup();
  const refused = await svc.launch({ startUrl: 'https://pas-configure.test/x' });
  assert.equal(refused.code, 'domain_not_activated');
  assert.match(logs.join('\n'), /lancement refusé \(domain_not_activated\)/);
  await svc.launch({ startUrl: 'https://boutique-alpha.test/c' });
  await until(() => bridge.sent.some((m) => m.type === P.MSG.JOB));
  bridge.onMessage(P.progress('yb_diag_1', { done: 1, total: 3 }));
  bridge.onMessage(P.progress('yb_diag_1', { done: 2, total: 3 }));
  bridge.onMessage(P.pause('yb_diag_1', 'challenge', {}));
  const trace = logs.join('\n');
  assert.equal((trace.match(/première progression/g) || []).length, 1, 'logged once, not per event');
  assert.match(trace, /en pause \(défi à résoudre dans l'onglet\)/);
});

test('a failed domain-profiles.json write is logged, not silent', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'elo-ybprof-'));
  const dirs = ensureDirs(appDirs(base));
  fs.mkdirSync(path.join(dirs.data, 'domain-profiles.json')); // a DIRECTORY in its place → write fails (EISDIR/EPERM)
  const warns = []; const orig = console.warn; console.warn = (m) => warns.push(String(m));
  try {
    const controller = createController({ dirs });
    return controller.resolveExternalRecipe('https://www.colruyt.be/fr/produits/toutes-les-categories/boissons/eau').then((h) => {
      assert.equal(h.source, 'bundled');
      // Since B5 the unreadable path is caught at READ time: the run turns read-only
      // (nothing can be replaced by a partial view) and says so — never silent.
      assert.ok(warns.some((w) => /\[profiles\] (écriture|lecture) de domain-profiles\.json impossible \(E[A-Z]+\)/.test(w)), warns.join('|'));
    }).finally(() => { console.warn = orig; });
  } catch (e) { console.warn = orig; throw e; }
});
