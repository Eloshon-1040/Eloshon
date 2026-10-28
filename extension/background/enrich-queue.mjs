/**
 * « Accepter » as a PERSISTED queue: every product page to read, what happened to each one, and where the
 * run stands (reading → paused on a human check → reading … → ingesting → done). The queue lives in
 * chrome.storage.local, written after every page, so a service worker put to sleep by Chrome (MV3) picks
 * the run up where it was when it wakes, and the panel, closed and reopened, finds it again.
 *
 * No silent cap: every row's own page is read, in batches, to the end. A limit only exists when the user
 * set one (« Fiches produit à lire »); the pages beyond it are listed with the reason `limit`, announced
 * before the run and written in the export manifest.
 *
 * Free of chrome.*: the storage area is injected (same get/set/remove as chrome.storage.local), so the
 * module is tested in Node.
 */
import { subpageUrls } from './subpages.mjs';

export const QUEUE_PREFIX = 'enrich:';
export const PAYLOAD_PREFIX = 'enrichPayload:';
const KEEP_QUEUES = 5; // finished queues kept for the panel to show again (the rest is removed)
export const RESUME_WINDOW_MS = 3 * 60 * 60 * 1000;

/** Final outcomes; `human_check` stays pending while the run is paused (retried on « Reprendre »). */
const FINAL = new Set(['read', 'failed', 'human_check_skipped', 'stopped']);

/**
 * The pages « Accepter » will read: every row's own page on the list's site, in list order.
 * @returns {{ urls:string[], limited:string[], toRead:number, limit:{max:number,from:string}|null }}
 */
export function planEnrichment({ rows, listUrl, maxPages = 0, alreadyRead = [] }) {
  const all = subpageUrls(rows, listUrl, Number.MAX_SAFE_INTEGER);
  const max = Math.floor(Number(maxPages) || 0);
  const cut = max > 0 && all.length > max;
  const done = new Set(alreadyRead);
  const kept = cut ? all.slice(0, max) : all;
  return { toRead: all.length, urls: kept.filter((u) => !done.has(u)), already: kept.filter((u) => done.has(u)), limited: cut ? all.slice(max) : [], limit: cut ? { max, from: 'settings' } : null };
}

export function newQueue({ runId, origin, listUrl, plan, wantSub, at = Date.now() }) {
  const outcomes = {};
  for (const u of plan.already || []) outcomes[u] = 'read'; // read for the preview: never opened twice
  return {
    runId, origin: origin || '', listUrl: listUrl || '', wantSub: !!wantSub,
    phase: wantSub ? 'reading' : 'ingesting',
    urls: [...(plan.already || []), ...plan.urls], limited: plan.limited || [], limit: plan.limit || null, toRead: plan.toRead || 0,
    outcomes, reasons: {}, pauseUrl: null, windowId: null, result: null, error: null, consumed: false,
    createdAt: at, updatedAt: at,
  };
}

/** The pages still to open (a page behind a human check is opened again when the run resumes). */
export function pendingUrls(q) {
  return (q.urls || []).filter((u) => !FINAL.has(q.outcomes[u]));
}

/** What the run read, page by page: the panel's state line and the export manifest (a failed page says why). */
export function summarize(q) {
  const out = { toRead: q.toRead || 0, read: 0, blocked: [], notOpened: [], limit: q.limit || null };
  const why = q.reasons || {};
  for (const u of q.urls || []) {
    const o = q.outcomes[u];
    if (o === 'read') out.read++;
    else if (o === 'human_check' || o === 'human_check_skipped') out.blocked.push({ url: u, reason: 'human_check' });
    else if (o === 'failed') out.blocked.push({ url: u, reason: 'failed', ...(why[u] ? { detail: String(why[u]).slice(0, 120) } : {}) });
    else if (o === 'stopped') out.notOpened.push({ url: u, reason: 'stopped' });
    else out.notOpened.push({ url: u, reason: 'not_opened' });
  }
  for (const u of q.limited || []) out.notOpened.push({ url: u, reason: 'limit' });
  return out;
}

/** The product pages a finished run did not read (failed, human check, stopped, never opened, beyond the limit). */
export function missingUrls(q) {
  if (!q) return [];
  return [...(q.urls || []).filter((u) => q.outcomes[u] !== 'read'), ...(q.limited || [])];
}

/**
 * « Lire les fiches manquantes »: a new run on the SAME rows (the list is not read again) that opens only the
 * pages the finished run `q` did not read. The pages it read are counted read when the app still holds them
 * (`reused`: their URLs), else they are read again — never assumed.
 */
export function followUpQueue(q, { runId, reused = [], at = Date.now() }) {
  const kept = new Set(reused);
  const urls = [...(q.urls || []), ...(q.limited || [])];
  const outcomes = {};
  for (const u of urls) if (q.outcomes[u] === 'read' && kept.has(u)) outcomes[u] = 'read';
  return {
    runId, origin: q.origin || '', listUrl: q.listUrl || '', wantSub: true, phase: 'reading',
    urls, limited: [], limit: null, toRead: urls.length, followUpOf: q.runId,
    outcomes, reasons: {}, pauseUrl: null, windowId: null, result: null, error: null, consumed: false,
    rowsCut: q.rowsCut || 0, createdAt: at, updatedAt: at,
  };
}

/** The run is over: every page left unopened is written as stopped (the user ended it, or nothing is left). */
export function closeReading(q, at = Date.now()) {
  for (const u of pendingUrls(q)) if (q.outcomes[u] !== 'human_check') q.outcomes[u] = 'stopped';
  q.pauseUrl = null; q.phase = 'ingesting'; q.updatedAt = at;
  return q;
}

/** @param {{get:Function,set:Function,remove:Function}} area chrome.storage.local (or a Node stand-in) */
export function createQueueStore(area) {
  const key = (id) => `${QUEUE_PREFIX}${id}`;
  return {
    async get(runId) { const r = await area.get(key(runId)); return r[key(runId)] || null; },
    async put(q) { q.updatedAt = Date.now(); await area.set({ [key(q.runId)]: q }); return q; },
    async payload(runId) { const k = `${PAYLOAD_PREFIX}${runId}`; const r = await area.get(k); return r[k] || null; },
    async putPayload(runId, payload) { await area.set({ [`${PAYLOAD_PREFIX}${runId}`]: payload }); },
    async dropPayload(runId) { await area.remove(`${PAYLOAD_PREFIX}${runId}`); },
    /** Every queue, newest first. */
    async list() {
      const all = await area.get(null);
      return Object.entries(all || {}).filter(([k]) => k.startsWith(QUEUE_PREFIX)).map(([, v]) => v).filter(Boolean).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    },
    /**
     * Old finished queues go (and every payload of a finished queue): storage.local holds 10 MB. The rows of a
     * finished run that left pages unread stay a while (RESUME_WINDOW_MS): « Lire les fiches manquantes » needs them.
     */
    async prune(now = Date.now()) {
      const qs = await this.list();
      const done = qs.filter((q) => q.phase === 'done' || q.phase === 'error');
      for (const q of done.slice(KEEP_QUEUES)) { await area.remove(key(q.runId)); await area.remove(`${PAYLOAD_PREFIX}${q.runId}`); }
      for (const q of done.slice(0, KEEP_QUEUES)) {
        const resumable = q.phase === 'done' && missingUrls(q).length > 0 && now - (q.updatedAt || 0) < RESUME_WINDOW_MS;
        if (q.consumed && !resumable) await area.remove(`${PAYLOAD_PREFIX}${q.runId}`);
      }
    },
  };
}

/** Queues a woken service worker must take up again (it slept while they were reading or ingesting). */
export function toResume(queues, now = Date.now()) {
  return (queues || []).filter((q) => q && (q.phase === 'reading' || q.phase === 'ingesting') && now - (q.updatedAt || 0) < RESUME_WINDOW_MS);
}
