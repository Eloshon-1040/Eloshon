/**
 * BUG 2 regression: after the panel is closed/locked, the discreet entry-point
 * trigger must STILL exist so the panel can be reopened. Uses a minimal DOM shim
 * to load the real admin-panel.js and drive open → close.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- tiny DOM shim (only what admin-panel.js touches in the create/close flow) ----
class El {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.parent = null; this.attrs = {}; this.listeners = {}; this.className = ''; this._text = ''; this.style = {}; this.value = ''; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] != null ? this.attrs[k] : null; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  dispatch(t, ev = {}) { for (const fn of (this.listeners[t] || [])) fn({ target: this, ...ev }); }
  click() { this.dispatch('click'); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text || this.children.map((c) => c.textContent || c._text || '').join(''); }
  set innerHTML(v) { this._text = ''; this.children = []; /* used only to clear */ }
  get innerHTML() { return ''; }
  _match(sel) {
    if (!sel) return false;
    if (sel[0] === '#') return this.attrs.id === sel.slice(1);
    if (sel[0] === '.') return (this.className || '').split(/\s+/).includes(sel.slice(1));
    const [tag, cls] = sel.split('.');
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    if (cls && !(this.className || '').split(/\s+/).includes(cls)) return false;
    return true;
  }
  _all() { const out = []; const walk = (n) => { for (const c of n.children) { out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel) { return this._all().find((n) => n._match(sel)) || null; }
  querySelectorAll(sel) { return this._all().filter((n) => n._match(sel)); }
  closest(sel) { let n = this; while (n) { if (n._match && n._match(sel)) return n; n = n.parent; } return null; }
}
function makeDoc() {
  const root = new El('div'); root.attrs.id = 'admin-root';
  const head = new El('head'); const body = new El('body');
  const byId = { 'admin-root': root };
  return {
    root, head, body,
    createElement: (t) => new El(t),
    createTextNode: (t) => { const n = new El('#text'); n._text = String(t); return n; },
    getElementById: (id) => byId[id] || root.querySelector('#' + id),
    get documentElement() { return body; },
  };
}

test('BUG2: entry-point trigger survives open → close (would vanish before the fix)', async () => {
  const doc = makeDoc();
  const statusStub = { hasPassphrase: false, unlocked: false, autoLockMs: 900000, lockedForMs: 0 };
  global.window = { eloshon: { admin: { status: async () => statusStub, create: async () => ({ ok: true }) }, provider: {} } };
  global.document = doc;
  global.CSS = { escape: (s) => s };
  global.setInterval = () => 0; global.clearInterval = () => {};

  await import('../renderer/admin-panel.js');

  // trigger created and mounted in root
  const trigger = doc.root.querySelector('.elo-a-trigger');
  assert.ok(trigger, 'trigger button should exist after load');

  // open the panel
  trigger.click();
  await new Promise((r) => setTimeout(r, 20)); // let open()/status() resolve
  assert.ok(doc.root.querySelector('.elo-a-modal'), 'a modal should be shown after opening');
  assert.ok(doc.root.querySelector('.elo-a-trigger'), 'trigger must still exist while the modal is open');

  // close via the × button
  const x = doc.root.querySelectorAll('button').find((b) => b.textContent.includes('×'));
  assert.ok(x, 'close (×) button present');
  x.click();
  await new Promise((r) => setTimeout(r, 5));

  // modal gone, but the trigger MUST remain (the BUG 2 fix)
  assert.ok(!doc.root.querySelector('.elo-a-modal'), 'modal should be closed');
  assert.ok(doc.root.querySelector('.elo-a-trigger'), 'BUG 2: trigger must survive closing so the panel is reachable again');
});
