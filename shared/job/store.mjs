/**
 * Resumable job store (Requirement D): chunked, idempotent, deduplicated by
 * product id, cursor persisted so a job survives service-worker sleep, browser
 * restart and long human pauses. Storage is an injected async adapter with
 * get/set/remove — chrome.storage in the extension, a Map in tests. NEVER stores
 * secrets (no cookies, no keys) — only recipe id, cursor, seen-keys and products.
 *
 * PORTABLE: zero Node built-ins, zero dependencies.
 *
 * Adapter contract (all async): get(key)->value|undefined, set(key,value), remove(key).
 */
import { STATE, transition, isTerminal } from './machine.mjs';

const KEY = (jobId) => `elo:job:${jobId}`;

/** A default product identity for dedup — same rule as the interpreter. */
export const productKey = (p) => (p && (p.sku || p.id || p.sourceUrl || p.url || (p.name && p.price != null ? `${p.name}|${p.price}` : null))) || null;

export class JobStore {
  /** @param {{get:Function,set:Function,remove:Function}} adapter */
  constructor(adapter, { dedupKey = productKey } = {}) {
    this.a = adapter;
    this.dedupKey = dedupKey;
  }

  /** Create (or reset) a job record. Idempotent per jobId (returns existing if present). */
  async create(jobId, { domain, recipeRevision, cursor = {} } = {}) {
    const existing = await this.a.get(KEY(jobId));
    if (existing) return existing;
    const rec = {
      jobId, domain, recipeRevision: recipeRevision ?? null,
      state: STATE.RUNNING,
      cursor: { page: 0, detailIndex: 0, ...cursor },
      seen: [],                 // dedup keys (array for JSON storage)
      productCount: 0,
      chunks: 0,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.a.set(KEY(jobId), rec);
    return rec;
  }

  async load(jobId) { return this.a.get(KEY(jobId)); }

  async _save(rec) { rec.updatedAt = Date.now(); await this.a.set(KEY(rec.jobId), rec); return rec; }

  /** Move to a new state (validated). No-op if already there. */
  async setState(jobId, to) {
    const rec = await this.load(jobId);
    if (!rec) throw new Error(`Job inconnu « ${jobId} ».`);
    if (rec.state === to) return rec;
    rec.state = transition(rec.state, to);
    return this._save(rec);
  }

  /** Persist the cursor (page / detailIndex / any extra fields). */
  async saveCursor(jobId, cursor) {
    const rec = await this.load(jobId);
    if (!rec) throw new Error(`Job inconnu « ${jobId} ».`);
    rec.cursor = { ...rec.cursor, ...cursor };
    return this._save(rec);
  }

  /**
   * Append a chunk of products, deduplicating against the persisted seen-set.
   * Idempotent: replaying the same chunk adds nothing. Returns the NEW products.
   */
  async appendProducts(jobId, products) {
    const rec = await this.load(jobId);
    if (!rec) throw new Error(`Job inconnu « ${jobId} ».`);
    const seen = new Set(rec.seen);
    const fresh = [];
    for (const p of (products || [])) {
      const k = this.dedupKey(p);
      if (k != null && seen.has(k)) continue;
      if (k != null) seen.add(k);
      fresh.push(p);
    }
    if (fresh.length) {
      rec.seen = [...seen];
      rec.productCount += fresh.length;
      rec.chunks += 1;
      // Store product chunk under its own key so the main record stays small.
      await this.a.set(`${KEY(jobId)}:chunk:${rec.chunks}`, fresh);
      await this._save(rec);
    }
    return fresh;
  }

  /** Read all product chunks back in order (for the final result assembly). */
  async allProducts(jobId) {
    const rec = await this.load(jobId);
    if (!rec) return [];
    const out = [];
    for (let i = 1; i <= rec.chunks; i++) {
      const c = await this.a.get(`${KEY(jobId)}:chunk:${i}`);
      if (Array.isArray(c)) out.push(...c);
    }
    return out;
  }

  /** Delete the job and its chunks. */
  async destroy(jobId) {
    const rec = await this.load(jobId);
    if (rec) for (let i = 1; i <= rec.chunks; i++) await this.a.remove(`${KEY(jobId)}:chunk:${i}`);
    await this.a.remove(KEY(jobId));
  }

  isDone(rec) { return rec ? isTerminal(rec.state) : false; }
}

/** A trivial in-memory adapter (tests, and a fallback). */
export function memoryAdapter() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? structuredCloneSafe(m.get(k)) : undefined; },
    async set(k, v) { m.set(k, structuredCloneSafe(v)); },
    async remove(k) { m.delete(k); },
    _map: m,
  };
}

// structuredClone exists in Node 17+ and modern browsers; fall back to JSON.
function structuredCloneSafe(v) {
  try { return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)); }
  catch { return JSON.parse(JSON.stringify(v)); }
}
