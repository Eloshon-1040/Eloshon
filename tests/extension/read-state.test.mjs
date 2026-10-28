// The panel never lets a preview or a partial result pass for a complete export (extension/ui/read-state.mjs).
// Needs extension/vendor (npm test builds it first).
import test from 'node:test';
import assert from 'node:assert/strict';
import { panelManifest, exportWarning, thinColumns } from '../../extension/ui/read-state.mjs';
import { readSubpages } from '../../extension/background/subpages.mjs';

const LIST = 'https://shop.test/parfums';
const rows = Array.from({ length: 864 }, (_, i) => ({ name: `P${i}`, price: 10 + i, sourceUrl: `https://shop.test/p/${i}`, ...(i === 0 || i === 2 ? { description: 'Texte lu sur la fiche', brand: 'Marque' } : {}) }));
const columns = [{ key: 'name', label: 'Nom' }, { key: 'price', label: 'Prix' }, { key: 'description', label: 'Description' }, { key: 'brand', label: 'Marque' }];

test('the 864-row preview of a taught site says 2 product pages read out of 864, 1 behind a human check', () => {
  const meta = { url: LIST, taught: ['description', 'brand'], taughtPreview: { pages: 2, challenged: 1, unread: 0, blocked: [{ url: 'https://shop.test/p/1', reason: 'human_check' }] } };
  const m = panelManifest({ rows, columns, meta, settings: { subpages: false }, now: '2026-10-28T10:00:00.000Z', version: '0.7.31' });
  assert.equal(m.status, 'preview'); assert.equal(m.source, 'extension'); assert.equal(m.site, 'shop.test');
  assert.equal(m.productPages.toRead, 864); assert.equal(m.productPages.read, 2); assert.equal(m.productPages.byReason.human_check, 1);
  assert.deepEqual(m.fill.description, { label: 'Description', filled: 2, total: 864 });
  assert.deepEqual(thinColumns(m).map((c) => c.label), ['Description', 'Marque']);
  const w = exportWarning(m);
  assert.equal(w.canAccept, true);
  // The 861 others wait for « Accepter »: never worded as if the reading had stopped (hydrozone 28/10).
  assert.match(w.text, /864 fiches produit à lire ; 3 ouvertes pour l’aperçu \(2 lues, 1 bloquée par une vérification humaine\) ; les 861 autres attendent « Accepter »/);
  assert.match(w.text, /Description 2\/864/);
});

test('accepted with every page read is complete and exports without a warning; one blocked page makes it partial', () => {
  const small = rows.slice(0, 3).map((r) => ({ ...r, description: 'd', brand: 'b' }));
  const ok = panelManifest({ rows: small, columns, meta: { url: LIST }, settings: { subpages: true }, accepted: { jobId: 'j1', reportStatus: 'OK', enrich: { toRead: 3, read: 3, blocked: [], notOpened: [] } } });
  assert.equal(ok.status, 'complete'); assert.equal(exportWarning(ok), null);
  const part = panelManifest({ rows: small, columns, meta: { url: LIST }, settings: { subpages: true }, accepted: { jobId: 'j1', reportStatus: 'PARTIAL', enrich: { toRead: 3, read: 2, blocked: [{ url: 'https://shop.test/p/1', reason: 'human_check' }], notOpened: [] } } });
  assert.equal(part.status, 'partial');
  const w = exportWarning(part); assert.equal(w.canAccept, false); assert.match(w.title, /partiel/i); assert.match(w.text, /1 fiche\(s\) bloquée\(s\)/);
  // A failing site rule or rows the app could not send back also make it partial.
  assert.equal(panelManifest({ rows: small, columns, meta: { url: LIST }, accepted: { reportStatus: 'OK', rulesFailing: [{ field: 'variants' }], enrich: { toRead: 0, read: 0 } } }).status, 'partial');
  assert.equal(panelManifest({ rows: small, columns, meta: { url: LIST }, accepted: { reportStatus: 'OK', rowsMissing: 40, enrich: { toRead: 0, read: 0 } } }).truncated.rows, 40);
});

test('readSubpages says what happened to every page: read, human check, failed, never opened', async () => {
  const urls = ['https://shop.test/p/1', 'https://shop.test/p/2', 'https://shop.test/p/3', 'https://shop.test/p/4'];
  let t = 0;
  const rep = await readSubpages(urls, {
    open: async () => ({}), close: async () => {}, concurrency: 1, sleep: async () => {}, now: () => t, budgetMs: 2500,
    visit: async (_w, u) => { t += 1000; return u.endsWith('/2') ? { challenge: true } : u.endsWith('/3') ? null : { html: '<html>' }; },
    send: async () => true,
  });
  assert.equal(rep.outcomes.get(urls[0]), 'read');
  assert.equal(rep.outcomes.get(urls[1]), 'human_check');
  assert.equal(rep.outcomes.get(urls[2]), 'failed');
  assert.equal(rep.challenged, 1); assert.equal(rep.failed, 2);
  assert.equal(rep.stoppedBy, 'time'); assert.deepEqual(rep.notOpened, [urls[3]]);
});
