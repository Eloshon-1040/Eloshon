import test from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest, columnFill, isManifest, manifestFileName, exportStem, manifestSummaryFr, MANIFEST_KIND } from '../export/manifest.mjs';
import { mergeRowsByUrl, canonicalUrlKey } from '../export/merge-rows.mjs';

const rows = [
  { name: 'A', price: 10, description: 'long text', sourceUrl: 'https://shop.test/p/1' },
  { name: 'B', price: 12, description: '', sourceUrl: 'https://shop.test/p/2' },
  { name: 'C', price: null, sourceUrl: 'https://shop.test/p/3' },
];

test('columnFill counts the rows that hold a value, per column', () => {
  const f = columnFill(rows, [{ key: 'name', label: 'Nom' }, { key: 'price', label: 'Prix' }, { key: 'description', label: 'Description' }]);
  assert.deepEqual(f.name, { label: 'Nom', filled: 3, total: 3 });
  assert.equal(f.price.filled, 2);
  assert.equal(f.description.filled, 1); // an empty string is not a value
});

test('a list that was not accepted is a preview, whatever was read', () => {
  const m = buildManifest({ source: 'extension', rows, accepted: false, productPages: { toRead: 864, read: 2, blocked: [{ url: 'https://shop.test/p/2', reason: 'human_check' }] } });
  assert.equal(m.kind, MANIFEST_KIND); assert.equal(m.contract, 1);
  assert.equal(m.status, 'preview');
  assert.equal(m.productPages.read, 2); assert.equal(m.productPages.blocked, 1);
  assert.equal(m.productPages.notOpened, 861); // never a silent gap: 864 - 2 read - 1 blocked
  assert.equal(m.productPages.byReason.human_check, 1);
  assert.equal(m.productPages.byReason.not_opened, 861);
  // The pages not opened yet WAIT for « Accepter »: never worded as if the reading had stopped (hydrozone 28/10).
  assert.equal(manifestSummaryFr(m), 'Aperçu : 864 fiches produit à lire ; 3 ouvertes pour l’aperçu (2 lues, 1 bloquée par une vérification humaine) ; les 861 autres attendent « Accepter »');
  const hz = buildManifest({ source: 'extension', rows, accepted: false, productPages: { toRead: 32, read: 2, blocked: [{ url: 'https://www.hydrozone.fr/x/7941-a.html', reason: 'failed', detail: 'chargement trop long' }] } });
  assert.equal(manifestSummaryFr(hz), 'Aperçu : 32 fiches produit à lire ; 3 ouvertes pour l’aperçu (2 lues, 1 en échec) ; les 29 autres attendent « Accepter »');
  assert.equal(hz.productPages.list[0].detail, 'chargement trop long', 'why a page failed travels in the manifest');
  assert.ok(isManifest(m));
});

test('complete only when every page was read and nothing failed or was cut', () => {
  const ok = buildManifest({ source: 'app', rows, accepted: true, productPages: { toRead: 3, read: 3 } });
  assert.equal(ok.status, 'complete');
  assert.equal(buildManifest({ rows, accepted: true, productPages: { toRead: 3, read: 3 }, rulesFailing: [{ field: 'variants', reason: 'invalidated' }] }).status, 'partial');
  assert.equal(buildManifest({ rows, accepted: true, productPages: { toRead: 3, read: 3 }, truncated: { rows: 4 } }).status, 'partial');
  assert.equal(buildManifest({ rows, accepted: true, productPages: { toRead: 3, read: 2, notOpened: [{ url: 'https://shop.test/p/3', reason: 'limit' }], limit: { max: 2, from: 'settings' } } }).status, 'partial');
  assert.equal(buildManifest({ rows, accepted: true, productPages: { toRead: 0, read: 0 }, jobStatus: 'PARTIAL' }).status, 'partial');
  const lim = buildManifest({ rows, accepted: true, productPages: { toRead: 3, read: 2, notOpened: [{ url: 'https://shop.test/p/3', reason: 'limit' }], limit: { max: 2, from: 'settings' } } });
  assert.deepEqual(lim.productPages.limit, { max: 2, from: 'settings' });
  assert.equal(lim.productPages.byReason.limit, 1);
});

test('export names: one stem per export, the manifest beside it', () => {
  const stem = exportStem('https://www.iciparisxl.be/fr/parfums', new Date(2026, 9, 28, 10, 5, 9));
  assert.equal(stem, 'eloshon-iciparisxl.be-20261028-100509');
  assert.equal(manifestFileName(`${stem}.csv`), `${stem}.manifest.json`);
  assert.equal(isManifest({ kind: 'other' }), false);
});

test('finished rows merge into the rows shown by canonical URL; nothing is dropped', () => {
  const shown = Array.from({ length: 900 }, (_, i) => ({ name: `P${i}`, price: i + 1, sourceUrl: `https://shop.test/p/${i}?utm_source=x` }));
  // The app sends the finished rows in chunks and in another order; one row has no match.
  const finished = [...shown].reverse().map((r, i) => ({ sourceUrl: r.sourceUrl.replace('?utm_source=x', '#top'), description: `D${i}`, name: '' }));
  let rows = shown;
  for (let i = 0; i < finished.length; i += 250) rows = mergeRowsByUrl(rows, finished.slice(i, i + 250)).rows;
  const extra = mergeRowsByUrl(rows, [{ sourceUrl: 'https://shop.test/p/new', name: 'New' }]);
  assert.equal(rows.length, 900);
  assert.ok(rows.every((r) => r.description && r.name), 'every row keeps its name and gets its description');
  assert.equal(extra.rows.length, 901); assert.equal(extra.added, 1);
  assert.equal(canonicalUrlKey('https://www.Shop.test/p/1/?b=2&a=1&gclid=z#x'), 'shop.test/p/1?a=1&b=2');
});
