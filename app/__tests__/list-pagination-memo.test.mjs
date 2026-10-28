/**
 * How a site's lists load more, set in the extension's side panel, kept in the APP (domain profile
 * `list_pagination`) so every browser with the extension and recipes.json share it; and the list read in
 * the browser reported honestly (report.pagination; PARTIAL when it ends short of the announced total for
 * no limit the user set). Offline: the profile store in memory, a fake controller.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handlePanelRequest, listPagination } from '../your-browser/panel-requests.mjs';
import { createProfileStore, mergeProfile, profileHints } from '../../core/domain-profile.mjs';
import { exportRecipes, planImport, applyImport } from '../../core/recipes-file.mjs';
import { applyPartialStatus } from '../../core/engine.mjs';

const URL0 = 'https://www.hydrozone.fr/755-ph-perfect-base-nutrients';
const memo = { v: 1, mode: 'button', next: { v: 1, kind: 'next', selector: '#pagination_next_bottom > a', text: 'Suivant', block: 'ul.pagination', fromEnd: 0, param: { name: 'p', kind: 'page' } } };

function memStore() {
  let map = {};
  return createProfileStore({ read: () => map, write: (m) => { map = m; } });
}

test('op « pagination »: set / get / forget through the site profile; anything unreadable is refused', async () => {
  const profiles = memStore();
  const sitePagination = { get: (u) => profiles.hints(u).listPagination, set: (u, m) => profiles.record(u, { listPagination: m || null }) };
  const io = { sitePagination };
  assert.deepEqual(await handlePanelRequest({ op: 'pagination', action: 'get', url: URL0 }, io), { ok: true, memo: null });
  const set = await handlePanelRequest({ op: 'pagination', action: 'set', url: URL0, memo: { ...memo, next: { ...memo.next, onclick: 'x' } } }, io);
  assert.equal(set.ok, true); assert.equal(set.memo.next.onclick, undefined);
  assert.equal((await handlePanelRequest({ op: 'pagination', action: 'get', url: URL0 }, io)).memo.next.selector, '#pagination_next_bottom > a');
  assert.equal((await handlePanelRequest({ op: 'pagination', action: 'set', url: URL0, memo: { mode: 'nope' } }, io)).ok, false);
  await handlePanelRequest({ op: 'pagination', action: 'forget', url: URL0 }, io);
  assert.equal((await handlePanelRequest({ op: 'pagination', action: 'get', url: URL0 }, io)).memo, null);
  assert.equal((await handlePanelRequest({ op: 'pagination', action: 'get', url: URL0 }, {})).ok, false, 'an app without the store says so');
});

test('the profile keeps it apart from the list recipe (no manual_selectors created) and recipes.json carries it', () => {
  const p = mergeProfile(null, { listPagination: memo });
  assert.equal(p.manual_selectors, undefined, 'a pagination memo alone never looks like a list recipe to the engine');
  assert.deepEqual(profileHints(p).listPagination, memo);
  assert.equal(profileHints(p).manualSelectors, null);
  const file = exportRecipes({ 'hydrozone.fr': p }, { now: '2026-10-28T12:00:00.000Z' });
  assert.deepEqual(file.sites['hydrozone.fr'].list_pagination, memo);
  const plan = planImport({}, file);
  const next = applyImport({}, plan.plan);
  assert.deepEqual(next['hydrozone.fr'].list_pagination, memo);
  assert.equal(mergeProfile(p, { listPagination: null }).list_pagination, undefined, 'null forgets');
});

test('the panel\'s list read becomes report.pagination; a shortfall for no user limit makes the job PARTIAL', () => {
  const full = listPagination({ mode: 'button', pages: 2, stoppedBy: 'total_reached', total: { announced: 32, read: 32, text: 'Résultats 1 - 24 sur 32.' } });
  assert.deepEqual(full, { mechanism: 'your-browser', mode: 'button', pages: 2, loads: 0, stoppedBy: 'total_reached', totalAnnounced: 32, totalText: 'Résultats 1 - 24 sur 32.', read: 32, warnings: [] });
  assert.equal(applyPartialStatus({ status: 'OK', pagination: full }).status, 'OK');
  const short = listPagination({ mode: 'load_more', pages: 1, loads: 2, stoppedBy: 'button_gone', total: { announced: 32, read: 20 } });
  assert.deepEqual(short.warnings, ['total_not_reached']);
  const rep = applyPartialStatus({ status: 'OK', pagination: short });
  assert.equal(rep.status, 'PARTIAL'); assert.deepEqual(rep.partial.listShort, { announced: 32, read: 20 });
  const capped = listPagination({ mode: 'button', pages: 5, stoppedBy: 'max_pages', total: { announced: 300, read: 120 } });
  assert.deepEqual(capped.warnings, [], 'the user\'s own page limit explains it');
  assert.equal(applyPartialStatus({ status: 'OK', pagination: capped }).status, 'OK');
  assert.equal(listPagination({ stoppedBy: 'hack', mode: 'x', pages: -1 }).stoppedBy, null);
  assert.equal(listPagination(null), null);
});
