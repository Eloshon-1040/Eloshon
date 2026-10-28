/**
 * BUG 5 (UI): after clicking "Tester la connexion" on Firecrawl, the card must
 * render a DISTINCT result state (✓/✗ + message + timestamp), not merely the
 * static capability description. Minimal DOM shim drives the real admin-panel.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

class El {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.parent = null; this.attrs = {}; this.listeners = {}; this.className = ''; this._text = ''; this.style = {}; this.value = ''; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] != null ? this.attrs[k] : null; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  dispatch(t, ev = {}) { for (const fn of (this.listeners[t] || [])) fn({ target: this, ...ev }); }
  click() { this.dispatch('click'); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text || this.children.map((c) => c.textContent || c._text || '').join(''); }
  set innerHTML(v) { this._text = ''; this.children = []; }
  get innerHTML() { return ''; }
  _match(sel) { if (!sel) return false; if (sel[0] === '#') return this.attrs.id === sel.slice(1); if (sel[0] === '.') return (this.className || '').split(/\s+/).includes(sel.slice(1)); const [tag, cls] = sel.split('.'); if (tag && this.tagName !== tag.toUpperCase()) return false; if (cls && !(this.className || '').split(/\s+/).includes(cls)) return false; return true; }
  _all() { const out = []; const walk = (n) => { for (const c of n.children) { out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel) { return this._all().find((n) => n._match(sel)) || null; }
  querySelectorAll(sel) { return this._all().filter((n) => n._match(sel)); }
  closest(sel) { let n = this; while (n) { if (n._match && n._match(sel)) return n; n = n.parent; } return null; }
}
function makeDoc() {
  const root = new El('div'); root.attrs.id = 'admin-root';
  const byId = { 'admin-root': root };
  return { root, head: new El('head'), body: new El('body'), createElement: (t) => new El(t), createTextNode: (t) => { const n = new El('#text'); n._text = String(t); return n; }, getElementById: (id) => byId[id] || root.querySelector('#' + id) };
}

test('BUG5: a successful Firecrawl test renders a distinct "connecté" result in the card', async () => {
  const doc = makeDoc();
  const mask = { id: 'firecrawl', label: 'Firecrawl', capabilities: ['browser'], costModel: { type: 'credits', note: 'Basé sur des crédits.' }, freeCheck: 'credit_usage', fields: [{ key: 'apiKey', label: 'Clé API', secret: true, required: true, present: true, source: 'secure' }], configured: true, incomplete: false };
  let tested = 0;
  global.window = { eloshon: {
    admin: { status: async () => ({ hasPassphrase: false, unlocked: false, autoLockMs: 900000, lockedForMs: 0 }), create: async () => ({ ok: true }), log: async () => ({ ok: true, rows: [] }) },
    provider: {
      list: async () => ({ ok: true, providers: [mask], switches: [{ id: 'firecrawl', enabled: true, caps: { maxCallsPerJob: 30, maxCallsPerMonth: 1000 }, usage: { callsThisMonth: 0 } }], killSwitch: false, domains: [] }),
      test: async () => { tested++; return { ok: true, status: 'connecté', remaining: 500, message: 'Connexion réussie — 500 crédits restants', at: Date.now() }; },
    },
  } };
  global.document = doc; global.CSS = { escape: (s) => s }; global.setInterval = () => 0; global.clearInterval = () => {};

  await import('../renderer/admin-panel.js');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  doc.root.querySelector('.elo-a-trigger').click();
  await sleep(20);
  // create passphrase → panel
  doc.getElementById('p1').value = 'longpass12'; doc.getElementById('p2').value = 'longpass12';
  doc.root.querySelectorAll('button').find((b) => b.textContent.includes('Créer')).click();
  await sleep(30);
  assert.ok(doc.root.querySelectorAll('h2').some((x) => x.textContent.includes('Fournisseurs')), 'panel should render');

  const tbtn = doc.root.querySelectorAll('button').find((b) => b.textContent.includes('Tester la connexion'));
  assert.ok(tbtn, 'Tester la connexion button present');
  tbtn.click();
  await sleep(30);

  assert.equal(tested, 1, 'the test IPC must actually be called');
  const result = doc.root.querySelector('.elo-a-tmsg');
  assert.equal(result.getAttribute('data-result'), 'connecté', 'a DISTINCT result state must be set (not the static description)');
  assert.match(result.textContent, /^Connecté :/); // the state in words, never a ✓ character
  assert.match(result.textContent, /500 crédits restants/);
});
