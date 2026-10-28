// The panel's fixed values reach the job: validated, given to the controller, and listed with their role (manifest).
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePanelRequest } from '../your-browser/panel-requests.mjs';

test('« Accepter » sends the fixed values; the app validates them and adds their columns to the job', async () => {
  let got = null;
  const controller = { ingestExternalProducts: async (input) => { got = input; return { jobId: 'J1', status: 'done', counts: {} }; } };
  await handlePanelRequest({
    op: 'ingest', url: 'https://shop.test/homme', rows: [{ name: 'Samba', sourceUrl: 'https://shop.test/p/1' }], fields: [{ key: 'name', label: 'Nom', role: 'title' }],
    constants: [{ role: 'brand', value: 'adidas' }, { role: 'status', value: 'Brouillon' }, { role: 'attribute', label: 'Couleur préférée', value: 'x' }, { role: 'attribute', term: 'saison', value: 'Été' }],
  }, { controller });
  assert.deepEqual(got.constants.map((c) => [c.role, c.key, c.value]), [['brand', 'brand', 'adidas'], ['status', 'status', 'draft'], ['attribute', 'saison', 'Été']], 'a free name is refused: only established terms');
  assert.deepEqual(got.columns.map((c) => `${c.label}:${c.role}`), ['Nom:title', 'Marque:brand', 'Statut à l’import:status', 'Saison:attribute']);
});
