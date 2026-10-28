/**
 * Administration PAGE (Point 3) through a minimal DOM shim driving the real
 * admin-panel.js in page mode: locked → only the unlock prompt (no provider
 * name, no cost); unlocked → four tabs (Fournisseurs, Utilisation, Domaines,
 * Coûts) fed by the gated IPC; unsaved edits are protected when switching tab.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

class El {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.parent = null; this.attrs = {}; this.listeners = {}; this.className = ''; this._text = ''; this.style = {}; this.value = ''; }
  appendChild(c) { if (c.parent) c.parent.children = c.parent.children.filter((x) => x !== c); c.parent = this; this.children.push(c); return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this.value = String(v); }
  getAttribute(k) { return this.attrs[k] != null ? this.attrs[k] : null; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  dispatch(t, ev = {}) { for (const fn of (this.listeners[t] || [])) fn({ target: this, ...ev }); }
  click() { this.dispatch('click'); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set innerHTML(v) { this._text = ''; this.children = []; }
  get innerHTML() { return ''; }
  _match(sel) { if (!sel) return false; if (sel[0] === '#') return this.attrs.id === sel.slice(1); if (sel[0] === '.') return (this.className || '').split(/\s+/).includes(sel.slice(1)); const [tag, cls] = sel.split('.'); if (tag && this.tagName !== tag.toUpperCase()) return false; if (cls && !(this.className || '').split(/\s+/).includes(cls)) return false; return true; }
  _all() { const out = []; const walk = (n) => { for (const c of n.children) { out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel) { return this._all().find((n) => n._match(sel)) || null; }
  querySelectorAll(sel) { return this._all().filter((n) => n._match(sel)); }
  closest(sel) { let n = this; while (n) { if (n._match && n._match(sel)) return n; n = n.parent; } return null; }
}
const root = new El('div'); root.attrs.id = 'admin-root';
const mount = new El('div'); mount.attrs.id = 'admin-mount'; root.appendChild(mount);
global.document = { head: new El('head'), body: new El('body'), createElement: (t) => new El(t), createTextNode: (t) => { const n = new El('#text'); n._text = String(t); return n; }, getElementById: (id) => (id === 'admin-root' ? root : root.querySelector('#' + id)) };
global.setInterval = () => 0; global.clearInterval = () => {};

const st = { hasPassphrase: true, unlocked: false, autoLockMs: 900000, lockedForMs: 0 };
const fc = { id: 'firecrawl', label: 'Firecrawl', capabilities: ['browser'], costModel: { type: 'credits', note: 'Basé sur des crédits.' }, freeCheck: 'credit_usage', fields: [{ key: 'apiKey', label: 'Clé API', secret: true, required: true, present: true, source: 'secure' }], configured: true, incomplete: false };
const period = { total: { events: 3, calls: 2 }, byProvider: { firecrawl: { events: 2, calls: 2, credits: 3, costUsd: 0, costUnknown: 2, blocked: 0 } } };
const calls = [];
global.window = { confirm: () => true, eloshon: {
  admin: { status: async () => st, unlock: async () => ({ ok: true }), lock: async () => ({ ok: true }), log: async () => ({ ok: true, rows: [], runs: [] }) },
  provider: { list: async () => (st.unlocked ? { ok: true, providers: [fc], switches: [{ id: 'firecrawl', enabled: true, caps: { maxCallsPerJob: 30, maxCallsPerMonth: 1000 }, usage: { callsThisMonth: 2 } }], killSwitch: false, domains: [] } : { ok: false, locked: true }) },
  usage: {
    summary: async () => (st.unlocked ? { ok: true, periods: { today: period, last7d: period, month: period }, cards: [{ id: 'firecrawl', status: { code: 'ready' }, lastUse: new Date().toISOString(), today: { calls: 2 }, month: { calls: 2 }, balance: { remaining: 1258, at: new Date().toISOString(), resetAt: '2026-10-16T00:00:00.000Z' } }], extra: [], events: 3, badLines: 0, ledger: { errorCount: 0 }, legacyRuns: [] } : { ok: false, locked: true }),
    query: async (f, p) => { calls.push(['query', f, p]); return { ok: true, rows: [{ ts: '2026-10-06T10:00:00Z', jobId: 'J1', domain: 'shop.test', provider: 'firecrawl', channel: 'direct', route: 'escalation', outcome: 'success', attempted: true, credits: 1, costUsd: null, durationMs: 1200, products: 3, testMode: true }], total: 1, offset: 0, limit: 50 }; },
    job: async () => ({ ok: true, events: [], report: null }),
  },
  optin: { table: async () => ({ ok: true, routes: [{ key: 'firecrawl', label: 'Firecrawl' }], rows: [{ domain: 'shop.test', routes: [{ key: 'firecrawl', label: 'Firecrawl', optedIn: true, allowed: true, reason: null, caps: { maxCallsPerJob: 30 } }] }] }), normalize: async () => ({ ok: false }) },
  costs: { get: async () => ({ ok: true, costs: { scrapingbrowser: { usdPerGb: 8 }, webunlocker: { usdPerRequest: null }, firecrawl: { usdPerCredit: null, usdPerRequest: null }, zyte: { usdPerRequest: null }, anthropic: { usdPerMTokIn: null, usdPerMTokOut: null } }, stored: {} }) },
} };

const mod = await import('../renderer/admin-panel.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = () => mount.textContent;
const tabBtn = (label) => mount.querySelectorAll('button').find((b) => b.className.includes('elo-a-tab') && b.textContent === label);

test('locked: the page shows only the unlock prompt — no provider name, no cost, no usage', async () => {
  mod.attachAdminPage(mount, { fresh: true });
  await sleep(30);
  assert.match(text(), /Administration — déverrouiller/);
  for (const w of ['Firecrawl', 'Bright Data', 'crédit', '$', 'Utilisation']) assert.equal(text().includes(w), false, `"${w}" must not appear while locked`);
});

test('unlocked: four tabs; Fournisseurs shows status, last use, balance; Utilisation lists ledger lines; Domaines and Coûts render', async () => {
  st.unlocked = true;
  mod.attachAdminPage(mount, { fresh: true });
  await sleep(40);
  for (const l of ['Fournisseurs', 'Utilisation', 'Domaines', 'Coûts']) assert.ok(tabBtn(l), `tab ${l}`);
  assert.match(text(), /Prêt/);
  assert.match(text(), /Dernière utilisation : à l’instant/);
  assert.match(text(), /Solde Firecrawl : 1\s?258 crédits/);
  assert.ok(mount.querySelector('.elo-a-tmsg'), 'the connection test stays available');
  tabBtn('Utilisation').click(); await sleep(40);
  assert.match(text(), /Aujourd'hui/);
  assert.match(text(), /J1/);
  assert.match(text(), /mode test/);
  assert.ok(calls.some((c) => c[0] === 'query'));
  tabBtn('Domaines').click(); await sleep(40);
  assert.match(text(), /shop\.test/);
  assert.match(text(), /Voie payante autorisée/);
  tabBtn('Coûts').click(); await sleep(40);
  assert.match(text(), /Prix/);
  assert.match(text(), /valeur par défaut du code/);
});

test('unsaved edits: switching tab asks first; refusing keeps the tab and the edit', async () => {
  tabBtn('Fournisseurs').click(); await sleep(40);
  const capInput = mount.querySelectorAll('input').find((i) => i.attrs['data-cap'] === 'maxCallsPerMonth');
  assert.ok(capInput);
  capInput.value = '5'; capInput.dispatch('input');
  assert.equal(mod.adminHasUnsaved(), true);
  window.confirm = () => false;
  tabBtn('Utilisation').click(); await sleep(20);
  assert.ok(tabBtn('Fournisseurs').className.includes(' on'), 'still on Fournisseurs');
  assert.equal(mod.confirmLeaveAdmin(), false, 'leaving the page is refused too');
  window.confirm = () => true;
  assert.equal(mod.confirmLeaveAdmin(), true);
  assert.equal(mod.adminHasUnsaved(), false);
});
