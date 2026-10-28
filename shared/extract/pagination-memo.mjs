/**
 * How a site's lists load more products, as the user set it in the side panel — kept PER SITE in the app
 * (domain profile `list_pagination`, exported in recipes.json) and copied in the extension, so the
 * Chrome panel and the app share it. Shape (every part optional):
 *   { v:1, mode, next:cues, loadMore:cues, lastTest:{at, mode, ok, added, before, after, reason}, updatedAt }
 * `cues` are page-control.mjs cues. Everything coming from a page or the extension is validated and
 * bounded here; unknown keys are dropped.
 */

export const PAGINATION_MODES = Object.freeze(['auto', 'none', 'button', 'load_more', 'infinite', 'url']);
const s = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const int = (v, min, max) => { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : null; };

/** A control's cues, validated (null when nothing usable is left). */
export function sanitizeCues(c) {
  if (typeof c === 'string') return s(c, 300) ? { v: 1, kind: 'next', selector: s(c, 300) } : null; // a selector kept by an older version
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const out = { v: 1, kind: c.kind === 'load_more' ? 'load_more' : 'next' };
  const selector = s(c.selector, 300); if (selector) out.selector = selector;
  const text = s(c.text, 60); if (text) out.text = text;
  const label = s(c.label, 80); if (label) out.label = label;
  const tag = typeof c.tag === 'string' && /^[a-z][a-z0-9-]{0,20}$/.test(c.tag) ? c.tag : null; if (tag) out.tag = tag;
  const role = s(c.role, 20); if (role) out.role = role;
  const block = s(c.block, 300); if (block) out.block = block;
  const fromEnd = int(c.fromEnd, 0, 200); if (fromEnd != null) out.fromEnd = fromEnd;
  if (c.param && typeof c.param === 'object' && typeof c.param.name === 'string' && /^[\w.-]{1,40}$/.test(c.param.name)) out.param = { name: c.param.name, kind: c.param.kind === 'offset' ? 'offset' : 'page' };
  return out.selector || out.text || out.label ? out : null;
}

function sanitizeTest(t) {
  if (!t || typeof t !== 'object') return null;
  const out = { ok: t.ok === true };
  const at = s(t.at, 40); if (at && Number.isFinite(Date.parse(at))) out.at = at;
  if (PAGINATION_MODES.includes(t.mode)) out.mode = t.mode;
  for (const k of ['added', 'before', 'after']) { const n = int(t[k], 0, 100000); if (n != null) out[k] = n; }
  const reason = s(t.reason, 200); if (reason) out.reason = reason;
  return out;
}

/** The memo, validated; null when it holds nothing. */
export function sanitizePaginationMemo(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const out = { v: 1 };
  if (PAGINATION_MODES.includes(m.mode)) out.mode = m.mode;
  const next = sanitizeCues(m.next); if (next) out.next = { ...next, kind: 'next' };
  const more = sanitizeCues(m.loadMore); if (more) out.loadMore = { ...more, kind: 'load_more' };
  const test = sanitizeTest(m.lastTest); if (test) out.lastTest = test;
  const at = s(m.updatedAt, 40); if (at && Number.isFinite(Date.parse(at))) out.updatedAt = at;
  return out.mode || out.next || out.loadMore || out.lastTest ? out : null;
}

/** A memo with `patch` applied; a part set to null is forgotten. */
export function patchPaginationMemo(memo, patch, now = new Date().toISOString()) {
  const base = sanitizePaginationMemo(memo) || { v: 1 };
  const p = patch && typeof patch === 'object' ? patch : {};
  const merged = { ...base };
  for (const k of ['mode', 'next', 'loadMore', 'lastTest']) {
    if (!(k in p)) continue;
    if (p[k] == null) delete merged[k]; else merged[k] = p[k];
  }
  merged.updatedAt = now;
  return sanitizePaginationMemo(merged);
}
