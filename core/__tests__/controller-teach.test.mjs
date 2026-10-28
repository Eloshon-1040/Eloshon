/**
 * Click-to-learn ("Teach this page") through the REAL controller, NO browser:
 * a captured product click → BOTH recipes (link_filter + manual_selectors) are
 * derived from the one gesture, the domain profile is updated, and the honest
 * "N products recognised" count is returned. Fail-safe: a click that yields no
 * valid recipe saves NOTHING and returns an actionable reason.
 *
 * The headful BrowserSession is INJECTED (opts.session) so the test is offline
 * and deterministic — it exercises the exact derive/persist/feedback path the
 * real flow runs after captureClick resolves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appDirs, ensureDirs } from '../../lib/osenv.mjs';
import { createController } from '../../app/controller.mjs';

const PAGE = 'https://www.shop-example.be/p/fr-BE/electromenager';
const gridCard = (i, extra = '') => `<article class="product-card${extra}">
  <a class="product-card__link" href="/p/fr-BE/produit-${i}/p1001234${i}">
    <img src="/im/${i}.jpg" alt=""><h3 class="product-card__title">Produit ${i}</h3></a>
  <span class="price">1${i},99 €</span></article>`;
const GRID = `<!doctype html><html><body>
  <header><nav class="main-nav"><a href="/fr-BE/aide">Aide</a></nav></header>
  <section class="product-grid">${[1, 2, 3, 4, 5, 6].map((i) => gridCard(i, i === 2 ? ' is-sponsored' : '')).join('')}</section>
  <footer><a href="/fr-BE/mentions">Mentions</a></footer></body></html>`;
const CAPTURE = {
  role: 'product-link', pageUrl: PAGE, href: '/p/fr-BE/produit-2/p10012342',
  anchorPath: [{ tag: 'a', classes: ['product-card__link'] }, { tag: 'article', classes: ['product-card', 'is-sponsored'] }, { tag: 'section', classes: ['product-grid'] }, { tag: 'body', classes: [] }],
  domSnapshot: GRID,
};

// A BrowserSession stand-in: hands back a fixed captureClick result, records close().
class FakeSession {
  constructor(result) { this.result = result; this.closed = false; this.captureArgs = null; }
  async captureClick(url, opts) { this.captureArgs = { url, opts }; return this.result; }
  async close() { this.closed = true; }
}
const mkDirs = () => ensureDirs(appDirs(fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-teach-'))));
const profilesOf = (dirs) => { try { return JSON.parse(fs.readFileSync(path.join(dirs.data, 'domain-profiles.json'), 'utf8')); } catch { return {}; } };

test('teach: one captured click → both recipes derived, persisted, and a real recognised count', async () => {
  const dirs = mkDirs();
  fs.writeFileSync(dirs.configFile, JSON.stringify({}), 'utf8');
  const ctrl = createController({ dirs });
  const session = new FakeSession({ capture: CAPTURE, error: null });

  const res = await ctrl.teach(PAGE, { session });
  assert.equal(res.ok, true);
  assert.equal(res.recognized, 6, 'the six grid cards are reported');
  assert.equal(res.learned.linkFilter, true);
  assert.equal(res.learned.manualSelectors, true);
  assert.ok(res.learned.fields.includes('price'), 'manual_selectors fields are surfaced');
  assert.ok(session.closed, 'the browser session is always closed');

  const prof = profilesOf(dirs)['shop-example.be'];
  assert.ok(prof && prof.link_filter, 'link_filter stored in the domain profile');
  assert.equal(prof.link_filter.card, 'article.product-card');
  assert.ok(prof.manual_selectors, 'manual_selectors stored alongside');
  assert.equal(prof.linkFilterMeta.status, 'candidate');
});

test('teach: a click that yields no valid recipe saves NOTHING and returns an actionable reason', async () => {
  const dirs = mkDirs();
  fs.writeFileSync(dirs.configFile, JSON.stringify({}), 'utf8');
  const ctrl = createController({ dirs });
  // A capture on an empty page — no product grid to learn from.
  const emptyCapture = { ...CAPTURE, domSnapshot: '<!doctype html><html><body><p>vide</p></body></html>' };
  const res = await ctrl.teach(PAGE, { session: new FakeSession({ capture: emptyCapture, error: null }) });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no_recipe');
  assert.deepEqual(profilesOf(dirs), {}, 'no recipe written — never a guessed one');
});

test('teach: a cancelled / closed capture surfaces the reason, writes nothing', async () => {
  const dirs = mkDirs();
  fs.writeFileSync(dirs.configFile, JSON.stringify({}), 'utf8');
  const ctrl = createController({ dirs });
  const res = await ctrl.teach(PAGE, { session: new FakeSession({ capture: null, error: 'cancelled' }) });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'cancelled');
  assert.deepEqual(profilesOf(dirs), {});
});

test('teach: no url → guarded, no session touched', async () => {
  const dirs = mkDirs();
  const ctrl = createController({ dirs });
  const res = await ctrl.teach('', { session: new FakeSession({ capture: CAPTURE, error: null }) });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no_url');
});
