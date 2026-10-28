// « Accepter » as a persisted queue (extension/background/enrich-queue.mjs): no silent cap, no lost page,
// a worker put to sleep picks the run up, a human check pauses it, and 900 rows come back whole.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planEnrichment, newQueue, pendingUrls, summarize, closeReading, createQueueStore, toResume, missingUrls, followUpQueue } from '../../extension/background/enrich-queue.mjs';
import { readSubpages } from '../../extension/background/subpages.mjs';
import { finishedRows } from '../../app/your-browser/panel-requests.mjs';
import { mergeRowsByUrl } from '../../shared/export/merge-rows.mjs';
import { buildManifest } from '../../shared/export/manifest.mjs';

const LIST = 'https://shop.test/cat';
const listRows = (n) => Array.from({ length: n }, (_, i) => ({ name: `P${i}`, price: i + 1, sourceUrl: `https://shop.test/p/${i}` }));
/** chrome.storage.local in memory (same get/set/remove contract). */
function memoryArea() {
  const m = new Map();
  return {
    m,
    async get(k) { if (k == null) return Object.fromEntries(m); return m.has(k) ? { [k]: structuredClone(m.get(k)) } : {}; },
    async set(o) { for (const [k, v] of Object.entries(o)) m.set(k, structuredClone(v)); },
    async remove(k) { m.delete(k); },
  };
}

test('every row page is planned (no 300 cap); a user limit is announced and the rest listed as « limit »', () => {
  const all = planEnrichment({ rows: listRows(864), listUrl: LIST });
  assert.equal(all.toRead, 864); assert.equal(all.urls.length, 864); assert.equal(all.limit, null);
  const lim = planEnrichment({ rows: listRows(864), listUrl: LIST, maxPages: 300, alreadyRead: ['https://shop.test/p/0', 'https://shop.test/p/2'] });
  assert.equal(lim.urls.length, 298); assert.equal(lim.already.length, 2); assert.equal(lim.limited.length, 564);
  const q = newQueue({ runId: 'r1', listUrl: LIST, plan: lim, wantSub: true });
  const s = summarize(q);
  assert.equal(s.read, 2); assert.equal(s.toRead, 864);
  assert.equal(s.notOpened.filter((p) => p.reason === 'limit').length, 564);
  assert.deepEqual(s.limit, { max: 300, from: 'settings' });
});

test('a human check pauses the run; « Reprendre » opens that page again; « Terminer » lists what is left', () => {
  const q = newQueue({ runId: 'r2', listUrl: LIST, plan: planEnrichment({ rows: listRows(5), listUrl: LIST }), wantSub: true });
  q.outcomes['https://shop.test/p/0'] = 'read';
  q.outcomes['https://shop.test/p/1'] = 'human_check';
  assert.deepEqual(pendingUrls(q), ['https://shop.test/p/1', 'https://shop.test/p/2', 'https://shop.test/p/3', 'https://shop.test/p/4']);
  closeReading(q);
  const s = summarize(q);
  assert.equal(q.phase, 'ingesting');
  assert.deepEqual(s.blocked, [{ url: 'https://shop.test/p/1', reason: 'human_check' }]);
  assert.equal(s.notOpened.filter((p) => p.reason === 'stopped').length, 3);
  const m = buildManifest({ accepted: true, rows: listRows(5), productPages: s });
  assert.equal(m.status, 'partial'); assert.equal(m.productPages.byReason.human_check, 1); assert.equal(m.productPages.byReason.stopped, 3);
});

test('a worker put to sleep mid-run: the next one reads only what is left, and no page is lost or read twice', async () => {
  const area = memoryArea(); const store = createQueueStore(area);
  const plan = planEnrichment({ rows: listRows(40), listUrl: LIST });
  await store.put(newQueue({ runId: 'r3', listUrl: LIST, plan, wantSub: true }));
  const visits = [];
  const io = (q, stopAfter) => ({
    open: async () => ({}), close: async () => {}, concurrency: 2, sleep: async () => {},
    visit: async (_w, u) => { visits.push(u); return { html: `<html>${u}</html>` }; }, send: async () => true,
    isStopped: () => (Object.keys(q.outcomes).length >= stopAfter ? 'stopped' : false),
    onOutcome: async (u, o) => { q.outcomes[u] = o; await store.put(q); },
  });
  // First worker: Chrome stops it after ~15 pages (the outcomes written so far are in storage).
  let q = await store.get('r3');
  await readSubpages(pendingUrls(q), io(q, 15));
  // A new worker wakes: it finds the run to resume and reads only the pages left.
  const resumable = toResume(await store.list());
  assert.deepEqual(resumable.map((x) => x.runId), ['r3']);
  q = await store.get('r3');
  const left = pendingUrls(q);
  assert.ok(left.length >= 23 && left.length <= 25, `left ${left.length}`);
  await readSubpages(left, io(q, Infinity));
  q = await store.get('r3');
  assert.equal(summarize(q).read, 40);
  assert.equal(new Set(visits).size, 40); assert.equal(visits.length, 40, 'no page read twice');
});

test('900 simulated rows: every finished row comes back in chunks and merges by URL; none is lost', () => {
  const shown = listRows(900).map((r) => ({ ...r, sourceUrl: `${r.sourceUrl}?utm_source=list` }));
  // The app's job: one product per row, in another order, with what the product page gave (long descriptions).
  const products = [...listRows(900)].reverse().map((r) => ({ name: r.name, price: r.price, source_url: r.sourceUrl, description: `Description ${r.name} `.repeat(120), brand: 'Marque', images: [`https://img.test/${r.name}-1.jpg`, `https://img.test/${r.name}-2.jpg`], specs: [] }));
  let rows = shown; let offset = 0; let chunks = 0;
  while (offset != null) { const c = finishedRows(products, { offset }); assert.ok(JSON.stringify(c.rows).length <= 760000); rows = mergeRowsByUrl(rows, c.rows).rows; offset = c.next; chunks++; }
  assert.ok(chunks > 1, `sent in ${chunks} chunks`);
  assert.equal(rows.length, 900);
  assert.ok(rows.every((r, i) => r.name === `P${i}` && r.brand === 'Marque' && r.description.startsWith(`Description P${i} `) && r.images.length === 2));
});

test('old finished queues are pruned, and the rows of a run already shown are dropped', async () => {
  const area = memoryArea(); const store = createQueueStore(area);
  for (let i = 0; i < 8; i++) {
    const q = newQueue({ runId: `d${i}`, listUrl: LIST, plan: planEnrichment({ rows: listRows(2), listUrl: LIST }), wantSub: true });
    q.phase = 'done'; q.consumed = i >= 6;
    if (i !== 6) for (const u of q.urls) q.outcomes[u] = 'read'; // d6 left a page unread
    else q.outcomes[q.urls[0]] = 'read';
    await store.put(q); await store.putPayload(q.runId, { rows: listRows(2) }); await new Promise((r) => setTimeout(r, 2));
  }
  await store.prune();
  const left = (await store.list()).map((q) => q.runId);
  assert.equal(left.length, 5); assert.ok(left.includes('d7'));
  assert.equal(await store.payload('d7'), null, 'consumed and complete: rows dropped');
  assert.ok(await store.payload('d6'), 'consumed but a page is missing: rows kept for « Lire les fiches manquantes »');
  assert.ok(await store.payload('d5'), 'not shown yet: rows kept');
  await store.prune(Date.now() + 4 * 60 * 60 * 1000);
  assert.equal(await store.payload('d6'), null, 'after 3 h the rows go: the app no longer holds the pages either');
});

test('« Lire les fiches manquantes »: only the pages not read are opened; pages the app still holds are not opened again', () => {
  const plan = planEnrichment({ rows: listRows(6), listUrl: LIST, maxPages: 5 });
  const q = newQueue({ runId: 'pr_a', listUrl: LIST, plan, wantSub: true });
  const [p0, p1, p2, p3, p4] = q.urls;
  Object.assign(q.outcomes, { [p0]: 'read', [p1]: 'read', [p2]: 'failed', [p3]: 'human_check_skipped' });
  q.reasons = { [p2]: 'la page ne s’est pas chargée en 25 s' };
  closeReading(q); q.phase = 'done'; // p4 never opened: stopped
  const s = summarize(q);
  assert.deepEqual(s.blocked.find((b) => b.url === p2), { url: p2, reason: 'failed', detail: 'la page ne s’est pas chargée en 25 s' });
  assert.deepEqual(missingUrls(q), [p2, p3, p4, 'https://shop.test/p/5'], 'failed, human check, stopped, beyond the limit');
  const nq = followUpQueue(q, { runId: 'pr_a-m1', reused: [p0] }); // the app still holds p0 only
  assert.deepEqual(pendingUrls(nq), [p1, p2, p3, p4, 'https://shop.test/p/5'], 'p1 is read again: the app no longer has it');
  assert.equal(nq.outcomes[p0], 'read'); assert.equal(nq.toRead, 6); assert.equal(nq.limit, null); assert.equal(nq.followUpOf, 'pr_a');
});
