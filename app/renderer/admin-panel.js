/**
 * Owner-only Administration (renderer). ONE module renders the admin area into
 * either a page (the "Administration" sidebar entry — the normal entry point) or
 * the historical modal (kept as a fallback when the app shell is absent). It is
 * driven entirely by window.eloshon.admin / .provider / .usage / .optin / .costs
 * / .balance; every one of those channels is admin-gated in the main process.
 *
 * Tabs: Fournisseurs (keys, switches, caps, status, balance), Utilisation (the
 * usage ledger: totals, filters, table, CSV export, job view), Domaines (paid
 * route opt-in per site + the per-site provider switch), Coûts (unit prices
 * used for the "estimé" costs).
 *
 * It never handles a secret value: credential inputs are write-only and the
 * main process only returns masked state. Locked session → the unlock screen,
 * and no provider information anywhere. French-first (owner-facing).
 */
import { providerBadge } from '../admin/status-badge.mjs';
import * as U from './admin-usage-ui.js';

const E = (typeof window !== 'undefined' && window.eloshon) || null;

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) { if (c == null || c === false) continue; el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }
  return el;
};
const clear = (el) => { el.innerHTML = ''; return el; };
const MB = 1024 * 1024;

// ---------------------------------------------------------------- state

const S = {
  host: null,          // { el, mode: 'page' | 'modal' }
  pageEl: null,        // the persistent page element (survives app re-renders)
  tab: 'providers',
  dirty: false,        // unsaved edits in the visible tab
  poll: null,
  pendingJob: null,    // a job to open in the Utilisation tab (from the Jobs screen)
  usage: { filter: {}, offset: 0, limit: 50, sort: null, jobView: null },
};

const setDirty = (v) => { S.dirty = !!v; };
const markDirty = () => setDirty(true);
function confirmDiscard() {
  if (!S.dirty) return true;
  const ok = (typeof window !== 'undefined' && typeof window.confirm === 'function')
    ? window.confirm('Des modifications ne sont pas enregistrées dans cet onglet. Les abandonner ?')
    : true;
  if (ok) S.dirty = false;
  return ok;
}

/** True when the visible admin tab holds unsaved edits (the app asks before leaving). */
export function adminHasUnsaved() { return S.dirty; }
/** Ask before leaving the admin page with unsaved edits. Returns true to proceed. */
export function confirmLeaveAdmin() { return confirmDiscard(); }

// ---------------------------------------------------------------- styles

let styled = false;
function injectStyle() {
  if (styled || typeof document === 'undefined') return; styled = true;
  const style = document.createElement('style');
  style.textContent = `
  .elo-a-trigger{position:fixed;left:var(--s-3);bottom:var(--s-3);font:var(--t-caption);opacity:.6;background:var(--surface);border:1px solid var(--line-control);color:var(--ink-2);border-radius:var(--r-sm);padding:var(--s-1) var(--s-2);cursor:pointer;z-index:9998}
  .elo-a-trigger:hover{opacity:1}
  .has-admin-nav .elo-a-trigger{display:none}
  .elo-a-ov{position:fixed;inset:0;background:var(--scrim);display:flex;align-items:center;justify-content:center;z-index:9999}
  .elo-a-modal{background:var(--surface);color:var(--ink);border:1px solid var(--line-strong);max-width:980px;width:94%;max-height:88vh;overflow:auto;border-radius:var(--r-lg);padding:var(--s-5);font:var(--t-body)}
  .elo-a-page{font:var(--t-body);color:var(--ink)}
  .elo-a-modal h2,.elo-a-page h2{margin:0 0 var(--s-1);font:var(--t-sub)}.elo-a-modal h3,.elo-a-page h3{font:var(--t-label);font-weight:600;margin:var(--s-4) 0 var(--s-2)}
  .elo-a-row{display:flex;justify-content:space-between;align-items:center;gap:var(--s-2);min-height:var(--row);padding:var(--s-1) 0;border-bottom:1px solid var(--line-subtle);flex-wrap:wrap}
  .elo-a-card{border:1px solid var(--line);border-radius:var(--r-md);padding:var(--s-3) var(--s-4);margin:var(--s-2) 0;background:var(--surface)}
  .elo-a-pill{display:inline-flex;align-items:center;height:20px;font:var(--chip-font);padding:0 6px;border:1px solid currentColor;border-radius:var(--r-sm);color:var(--neutral);white-space:nowrap}
  .elo-a-pill.ok{color:var(--ok)}.elo-a-pill.err{color:var(--danger);background:var(--danger-bg)}.elo-a-pill.warn{color:var(--warn);background:var(--warn-bg)}
  .elo-a-modal input,.elo-a-modal button,.elo-a-modal select,.elo-a-page input,.elo-a-page button,.elo-a-page select{font:inherit}
  .elo-a-modal input,.elo-a-modal select,.elo-a-page input,.elo-a-page select{height:32px;padding:0 var(--s-2);border:1px solid var(--line-control);border-radius:var(--r-sm);background:var(--sunken);color:var(--ink)}
  .elo-a-modal input[type=checkbox],.elo-a-page input[type=checkbox]{height:auto;accent-color:var(--accent)}
  .elo-a-btn{display:inline-flex;align-items:center;gap:var(--s-2);height:32px;padding:0 var(--s-3);border:1px solid var(--accent);border-radius:var(--r-sm);background:var(--accent);color:var(--on-accent);font:var(--t-label);cursor:pointer}
  .elo-a-btn:hover{background:var(--accent-hover);border-color:var(--accent-hover)}
  .elo-a-btn.sec{background:var(--surface);border-color:var(--line-control);color:var(--ink)}.elo-a-btn.sec:hover{background:var(--row-hover)}
  .elo-a-btn.danger{background:var(--surface);border-color:var(--danger);color:var(--danger)}.elo-a-btn.danger:hover{background:var(--danger-bg)}
  .elo-a-btn[disabled]{background:var(--sunken);border-color:var(--line-subtle);color:var(--disabled);cursor:not-allowed}
  .elo-a-msg{color:var(--muted);font:var(--t-caption);font-weight:400;margin:var(--s-2) 0;min-height:1em}
  .elo-a-x{float:right;cursor:pointer;border:0;background:transparent;width:32px;height:32px;border-radius:var(--r-sm);font-size:18px;color:var(--ink-2)}
  .elo-a-x:hover{background:var(--row-hover)}
  .elo-a-tabs{display:flex;gap:var(--s-1);margin:var(--s-4) 0 var(--s-2);border-bottom:1px solid var(--line);flex-wrap:wrap}
  .elo-a-tab{height:36px;padding:0 var(--s-3);border:0;border-bottom:2px solid transparent;background:transparent;color:var(--ink-2);cursor:pointer;font:var(--t-label)}
  .elo-a-tab:hover{color:var(--ink)}
  .elo-a-tab.on{border-bottom-color:var(--accent-ink);color:var(--accent-ink);font-weight:600}
  .elo-a-alert{border-radius:var(--r-md);padding:var(--s-2) var(--s-3);margin:var(--s-2) 0;font:var(--t-body);color:var(--ink)}
  .elo-a-alert.err{background:var(--danger-bg);border:1px solid var(--danger)}.elo-a-alert.warn{background:var(--warn-bg);border:1px solid var(--warn)}.elo-a-alert.info{background:var(--neutral-bg);border:1px solid var(--line-strong)}
  .elo-a-kpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--s-3);margin:var(--s-3) 0}
  .elo-a-kpi{border:1px solid var(--line);border-radius:var(--r-md);padding:var(--s-3) var(--s-4);background:var(--surface)}
  .elo-a-kpi b{font:600 19px/24px var(--font-ui);font-variant-numeric:tabular-nums}
  .elo-a-tbl{width:100%;border-collapse:separate;border-spacing:0;font:var(--t-body)}
  .elo-a-tbl th{text-align:left;height:var(--row-head);font:var(--t-th);text-transform:uppercase;letter-spacing:.04em;color:var(--muted);padding:0 var(--s-2);border-bottom:1px solid var(--line-strong);cursor:pointer;white-space:nowrap;background:var(--surface);position:sticky;top:0}
  .elo-a-tbl td{padding:var(--s-2);border-bottom:1px solid var(--line-subtle);vertical-align:top}
  .elo-a-tbl tbody tr:hover td{background:var(--row-hover)}
  .elo-a-link{color:var(--accent-ink);cursor:pointer;text-decoration:underline;background:none;border:0;padding:0;font:inherit}
  .elo-a-filters{display:flex;gap:var(--s-2);flex-wrap:wrap;align-items:flex-end;margin:var(--s-2) 0}
  .elo-a-filters label{display:flex;flex-direction:column;gap:var(--s-1);font:var(--t-caption);color:var(--ink-2)}
  .elo-a-small{font:var(--t-caption);font-weight:400;color:var(--muted)}
  .elo-a-lock{max-width:560px}
  .elo-a-ok{color:var(--ok)}.elo-a-err{color:var(--danger)}
  `;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------- host + routing

function render(nodes) {
  if (!S.host) return;
  const el = clear(S.host.el);
  if (S.host.mode === 'modal') el.appendChild(h('button', { class: 'elo-a-x', title: 'Fermer', onclick: () => { if (confirmDiscard()) closeModal(); } }, '×'));
  for (const n of [].concat(nodes)) if (n) el.appendChild(n);
}
function stopPoll() { if (S.poll) { clearInterval(S.poll); S.poll = null; } }
function startPoll() {
  stopPoll();
  // Auto-lock watch: when the session expires, fall back to the unlock screen.
  S.poll = setInterval(async () => {
    if (!S.host) { stopPoll(); return; }
    try { const s = await E.admin.status(); if (!s.unlocked && !S.lockScreen) screenUnlock(s); } catch { /* ignore */ }
  }, 5000);
}

async function open() {
  const st = await E.admin.status();
  if (!st.hasPassphrase) return screenCreate();
  if (!st.unlocked) return screenUnlock(st);
  return screenPanel();
}

// Modal (fallback entry point)
let modalHost = null;
function closeModal() { stopPoll(); if (modalHost) clear(modalHost); if (S.host && S.host.mode === 'modal') S.host = null; }
function openModal() {
  injectStyle();
  const modal = h('div', { class: 'elo-a-modal' });
  const ov = h('div', { class: 'elo-a-ov', onclick: (e) => { if (e.target === ov && confirmDiscard()) closeModal(); } }, modal);
  clear(modalHost); modalHost.appendChild(ov);
  S.host = { el: modal, mode: 'modal' };
  return open();
}

/**
 * Mount the Administration PAGE into `placeholder` (app shell). The page element
 * persists across app re-renders, so unsaved inputs survive; `fresh` re-reads
 * the data (navigation into the page).
 */
export function attachAdminPage(placeholder, { fresh = false } = {}) {
  if (!E || !E.admin || !placeholder) return;
  injectStyle();
  if (!S.pageEl) S.pageEl = h('div', { class: 'elo-a-page' });
  placeholder.appendChild(S.pageEl);
  const first = !S.host || S.host.mode !== 'page';
  S.host = { el: S.pageEl, mode: 'page' };
  if (fresh || first || !S.pageEl.children.length) { setDirty(false); open(); }
}
/** The app left the Administration page. */
export function detachAdminPage() { stopPoll(); if (S.host && S.host.mode === 'page') S.host = null; }
/** Open a job's route chain in the Utilisation tab (from the Jobs screen). */
export function adminOpenJob(jobId) { S.tab = 'usage'; S.usage.jobView = jobId ? { jobId } : null; }

// ---------------------------------------------------------------- lock screens

function screenCreate() {
  S.lockScreen = true;
  render(h('div', { class: 'elo-a-lock' },
    h('h2', {}, 'Administration — créer la phrase secrète'),
    h('p', { class: 'elo-a-msg' }, 'Cette phrase protège les clés des fournisseurs payants et toutes les données de coût. Conservez-la : en cas d\'oubli, la réinitialisation efface toutes les clés, qu\'il faudra réimporter.'),
    h('div', { class: 'elo-a-row' }, 'Phrase secrète (8 caractères minimum)', h('input', { type: 'password', id: 'p1', autocomplete: 'new-password' })),
    h('div', { class: 'elo-a-row' }, 'Confirmer la phrase', h('input', { type: 'password', id: 'p2', autocomplete: 'new-password' })),
    h('p', { class: 'elo-a-msg', id: 'lock-msg' }),
    h('div', { style: 'text-align:right;margin-top:10px' }, h('button', { class: 'elo-a-btn', onclick: async () => {
      const p1 = document.getElementById('p1'), p2 = document.getElementById('p2');
      const r = await E.admin.create(p1 ? p1.value : '', p2 ? p2.value : '');
      if (r.ok) screenPanel(); else { const m = document.getElementById('lock-msg'); if (m) { m.textContent = r.error || 'Création impossible.'; m.style.color = 'var(--danger)'; } }
    } }, 'Créer et déverrouiller')),
  ));
}

function screenUnlock(st) {
  S.lockScreen = true; stopPoll();
  render(h('div', { class: 'elo-a-lock' },
    h('h2', {}, 'Administration — déverrouiller'),
    h('p', { class: 'elo-a-msg' }, 'Les fournisseurs, l\'utilisation et les coûts ne s\'affichent qu\'après saisie de la phrase secrète.'),
    st && st.lockedForMs > 0 ? h('p', { class: 'elo-a-msg' }, `Trop de tentatives. Réessayez dans ${Math.ceil(st.lockedForMs / 1000)} s.`) : null,
    h('div', { class: 'elo-a-row' }, 'Phrase secrète', h('input', { type: 'password', id: 'pu', autocomplete: 'current-password' })),
    h('p', { class: 'elo-a-msg', id: 'lock-msg' }),
    h('div', { style: 'display:flex;justify-content:space-between;margin-top:10px' },
      h('button', { class: 'elo-a-btn danger', onclick: () => screenReset() }, 'Phrase oubliée / réinitialiser'),
      h('button', { class: 'elo-a-btn', onclick: async () => {
        const pu = document.getElementById('pu');
        const r = await E.admin.unlock(pu ? pu.value : '');
        if (r.ok) screenPanel(); else { const m = document.getElementById('lock-msg'); if (m) { m.textContent = r.error || 'Phrase incorrecte.'; m.style.color = 'var(--danger)'; } }
      } }, 'Déverrouiller')),
  ));
}

function screenReset() {
  S.lockScreen = true;
  render(h('div', { class: 'elo-a-lock' },
    h('h2', {}, 'Réinitialiser l\'administration'),
    h('p', { class: 'elo-a-msg' }, 'Cette action efface la phrase secrète ET toutes les clés des fournisseurs. Vous devrez tout réimporter. Le registre d\'utilisation est conservé. Tapez REINITIALISER pour confirmer.'),
    h('div', { class: 'elo-a-row' }, 'Confirmation', h('input', { type: 'text', id: 'rc', placeholder: 'REINITIALISER' })),
    h('p', { class: 'elo-a-msg', id: 'lock-msg' }),
    h('div', { style: 'text-align:right;margin-top:10px' }, h('button', { class: 'elo-a-btn danger', onclick: async () => {
      const rc = document.getElementById('rc');
      const r = await E.admin.reset(rc ? rc.value : '');
      if (r.ok) screenCreate(); else { const m = document.getElementById('lock-msg'); if (m) { m.textContent = r.error || 'Réinitialisation refusée.'; m.style.color = 'var(--danger)'; } }
    } }, 'Effacer et réinitialiser')),
  ));
}

// ---------------------------------------------------------------- panel + tabs

const TABS = [['providers', 'Fournisseurs'], ['usage', 'Utilisation'], ['domains', 'Domaines'], ['costs', 'Coûts']];

async function screenPanel() {
  S.lockScreen = false;
  if (S.pendingJob) { S.tab = 'usage'; }
  const head = S.host && S.host.mode === 'page'
    ? h('div', { class: 'page-head' },
      h('div', {}, h('h1', { class: 'h1' }, 'Administration'), h('p', { class: 'sub' }, 'Fournisseurs payants, utilisation, autorisations par site et coûts estimés. Visible uniquement après déverrouillage.')),
      h('button', { class: 'elo-a-btn sec', onclick: () => { if (!confirmDiscard()) return; E.admin.lock(); screenUnlock({}); } }, 'Verrouiller'))
    : null;
  const tabs = h('div', { class: 'elo-a-tabs', role: 'tablist' }, ...TABS.map(([k, label]) => h('button', {
    class: 'elo-a-tab' + (S.tab === k ? ' on' : ''), role: 'tab', 'data-tab': k,
    onclick: () => { if (S.tab === k) return; if (!confirmDiscard()) return; S.tab = k; screenPanel(); },
  }, label)));
  const body = h('div', { class: 'elo-a-body' });
  render([head, tabs, body]);
  startPoll();
  try {
    if (S.tab === 'usage') await tabUsage(body);
    else if (S.tab === 'domains') await tabDomains(body);
    else if (S.tab === 'costs') await tabCosts(body);
    else await tabProviders(body);
  } catch { body.appendChild(h('p', { class: 'elo-a-alert err' }, 'Cet onglet n\'a pas pu être chargé. Fermez puis rouvrez l\'Administration ; si le problème continue, redémarrez l\'application.')); }
}

const locked = (r) => r && r.locked;
const pill = (text, tone) => h('span', { class: 'elo-a-pill' + (tone ? ' ' + tone : '') }, text);

// ---------------------------------------------------------------- tab: Fournisseurs

async function tabProviders(body) {
  const data = await E.provider.list();
  if (locked(data)) return open();
  const sum = E.usage ? await E.usage.summary() : null;
  if (locked(sum)) return open();
  const cardOf = sum && sum.ok ? Object.fromEntries((sum.cards || []).map((c) => [c.id, c])) : {};
  const swById = Object.fromEntries((data.switches || []).map((s) => [s.id, s]));
  const now = Date.now();

  body.appendChild(h('h2', {}, 'Fournisseurs'));
  if (sum && sum.ledger && sum.ledger.errorCount) {
    body.appendChild(h('p', { class: 'elo-a-alert err' }, `Le registre d'utilisation n'a pas pu être écrit ${sum.ledger.errorCount} fois (dernière erreur : ${sum.ledger.lastError ? sum.ledger.lastError.code : 'inconnue'}, ${U.fmtDateTime(sum.ledger.lastError && sum.ledger.lastError.at)}). Le scraping continue, mais ces appels manquent dans l'onglet Utilisation. Vérifiez l'espace disque et les droits d'écriture du dossier ${sum.ledger.dir || 'usage-ledger'}.`));
  }
  body.appendChild(h('div', { class: 'elo-a-row' },
    h('label', {}, h('input', { type: 'checkbox', checked: !!data.killSwitch, onchange: async (e) => { await E.provider.setKill(e.target.checked); screenPanel(); } }), ' Tout désactiver (interrupteur général)'),
    h('div', {}, h('button', { class: 'elo-a-btn sec', onclick: importFlow }, 'Importer un .env'), ' ',
      // The page has its own "Verrouiller" in its header; the modal keeps this one.
      S.host && S.host.mode === 'modal' ? h('button', { class: 'elo-a-btn sec', onclick: () => { if (!confirmDiscard()) return; E.admin.lock(); closeModal(); } }, 'Verrouiller') : null),
  ));
  body.appendChild(h('p', { class: 'elo-a-msg', id: 'panel-msg' }));

  for (const p of (data.providers || [])) {
    const sw = swById[p.id]; const s = cardOf[p.id] || null;
    const b = providerBadge(p, sw, data.killSwitch);
    const st = s ? U.statusView(s.status) : { t: b.t, c: b.c };
    const card = h('div', { class: 'elo-a-card' });
    card.appendChild(h('div', { class: 'elo-a-row' },
      h('strong', {}, p.label),
      h('span', {}, pill(st.t, st.c), ' ',
        h('label', {}, h('input', { type: 'checkbox', checked: !!(sw && sw.enabled !== false), onchange: async (e) => { await E.provider.setEnabled(p.id, e.target.checked); screenPanel(); } }), ' activé'))));
    if (s) {
      card.appendChild(h('div', { class: 'elo-a-row' },
        h('span', {}, `Dernière utilisation : ${U.relTime(s.lastUse, now)}${s.lastUse ? ` (${U.fmtDateTime(s.lastUse)})` : ''}`),
        h('span', {}, `Appels envoyés : ${U.fmtInt(s.today ? s.today.calls : 0)} aujourd'hui · ${U.fmtInt(s.month ? s.month.calls : 0)} ce mois`)));
      if (s.lastError && (s.status.code === 'last_call_error' || s.status.code === 'quota_exhausted')) {
        card.appendChild(h('p', { class: 'elo-a-alert ' + (s.status.code === 'quota_exhausted' ? 'err' : 'warn') }, `Dernière erreur : ${U.outcomeText(s.lastError.outcome)}${s.lastError.reason ? ` — ${U.reasonText(s.lastError.reason)}` : ''} (${U.fmtDateTime(s.lastError.ts)}).${s.balance && s.balance.resetAt ? ` Remise à zéro annoncée par le fournisseur : ${U.fmtDate(s.balance.resetAt)}.` : ''}`));
      }
      if (s.status.code === 'cap_reached') {
        // Counters are monthly (UTC month of the provider runtime): they restart on the 1st.
        const m = String((s.usage && s.usage.month) || '').match(/^(\d{4})-(\d{2})$/);
        const next = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]), 1)).toISOString() : null;
        card.appendChild(h('p', { class: 'elo-a-alert err' }, `Plafond atteint : aucun nouvel appel ne partira.${next ? ` Les compteurs mensuels repartent à zéro le ${U.fmtDate(next)}.` : ''} Le compteur « par job » n'est pas remis à zéro entre deux jobs (comportement actuel) : relevez le plafond « appels/job » si c'est lui qui bloque.`));
      }
      if (p.id === 'firecrawl') card.appendChild(balanceRow(s.balance, now));
    }
    for (const f of p.fields) {
      card.appendChild(h('div', { class: 'elo-a-row' },
        h('span', {}, `${f.label}${f.required ? ' *' : ''} `, pill(f.present ? `enregistré (${f.source})` : 'vide', f.present ? 'ok' : 'warn')),
        h('span', {},
          h('input', { type: f.secret ? 'password' : 'text', placeholder: f.secret ? '•••• (écriture seule)' : '', 'data-field': f.key, autocomplete: 'off', oninput: markDirty }), ' ',
          h('button', { class: 'elo-a-btn', onclick: async (e) => { const inp = e.target.closest('.elo-a-row').querySelector('input'); const r = await E.provider.setCredentials(p.id, { [f.key]: inp.value }); inp.value = ''; setDirty(false); if (locked(r)) return open(); const m = document.getElementById('panel-msg'); if (m) m.textContent = r.ok ? `${p.label} : ${f.label} enregistré.` : (r.message || r.error || 'Enregistrement impossible.'); screenPanel(); } }, 'Enregistrer'),
          f.present ? h('button', { class: 'elo-a-btn danger', onclick: async () => { await E.provider.deleteCredentials(p.id, f.key); screenPanel(); } }, 'Supprimer') : null)));
    }
    const cap = (sw && sw.caps) || {}; const use = (sw && sw.usage) || {};
    const freeHint = p.freeCheck === 'credit_usage' ? 'test gratuit disponible (lecture des crédits)' : 'aucun test gratuit — un test réel serait facturé';
    card.appendChild(h('div', { class: 'elo-a-row' },
      h('span', {},
        h('button', { class: 'elo-a-btn sec', onclick: async (e) => {
          const span = e.target.closest('.elo-a-row').querySelector('.elo-a-tmsg');
          span.textContent = '…'; span.style.color = '';
          const r = await E.provider.test(p.id);
          if (locked(r)) return open();
          // The state in words (never a ✓ ✗ character nor the colour alone).
          const mark = r.status === 'connecté' ? 'Connecté :' : r.status === 'échec' ? 'Échec :' : r.status === 'non_configuré' ? 'Non configuré :' : 'Info :';
          const time = r.at ? ' · ' + new Date(r.at).toLocaleTimeString() : '';
          span.textContent = `${mark} ${r.message || (r.ok ? 'OK' : 'échec')}${time}`;
          span.style.color = r.status === 'connecté' ? 'var(--ok)' : r.status === 'échec' ? 'var(--danger)' : '';
          span.setAttribute('data-result', r.status || (r.ok ? 'ok' : 'ko'));
        } }, 'Tester la connexion'),
        h('span', { class: 'elo-a-msg', style: 'margin-left:8px;font-size:11px;' }, freeHint)),
      h('span', { class: 'elo-a-tmsg elo-a-msg' })));
    card.appendChild(h('div', { class: 'elo-a-row' },
      h('span', {}, `Coût : ${(p.costModel && p.costModel.note) || ''}`),
      h('span', {}, `Utilisé : ${use.callsThisMonth || 0} ce mois`)));
    const isGb = p.costModel && p.costModel.type === 'per_gb';
    const numInput = (attrs) => h('input', { type: 'number', style: 'width:78px', oninput: markDirty, ...attrs });
    const capInputs = isGb ? [
      'Mo/job ', numInput({ value: cap.maxBytesPerJob != null ? Math.round(cap.maxBytesPerJob / MB) : '', 'data-cap': 'maxBytesPerJob', 'data-unit': 'mb' }), ' ',
      'Mo/mois ', numInput({ value: cap.maxBytesPerMonth != null ? Math.round(cap.maxBytesPerMonth / MB) : '', 'data-cap': 'maxBytesPerMonth', 'data-unit': 'mb' }), ' ',
      '$/mois ', numInput({ value: cap.maxUsdPerMonth != null ? cap.maxUsdPerMonth : '', step: '0.5', 'data-cap': 'maxUsdPerMonth' }), ' ',
      'appels/job ', numInput({ value: cap.maxCallsPerJob != null ? cap.maxCallsPerJob : '', 'data-cap': 'maxCallsPerJob' }),
    ] : [
      'appels/job ', numInput({ value: cap.maxCallsPerJob != null ? cap.maxCallsPerJob : '', 'data-cap': 'maxCallsPerJob' }), ' ',
      'appels/mois ', numInput({ value: cap.maxCallsPerMonth != null ? cap.maxCallsPerMonth : '', 'data-cap': 'maxCallsPerMonth' }),
    ];
    card.appendChild(h('div', { class: 'elo-a-row' },
      h('span', {}, 'Plafonds'),
      h('span', {}, ...capInputs, ' ',
        h('button', { class: 'elo-a-btn sec', onclick: async (e) => { const box = e.target.closest('.elo-a-row'); const patch = {}; box.querySelectorAll('input[data-cap]').forEach((i) => { if (i.value !== '') { let v = Number(i.value); if (i.getAttribute('data-unit') === 'mb') v = Math.round(v * MB); patch[i.getAttribute('data-cap')] = v; } }); const r = await E.provider.setCap(p.id, patch); if (locked(r)) return open(); setDirty(false); const m = document.getElementById('panel-msg'); if (m) m.textContent = `${p.label} : plafonds enregistrés.`; screenPanel(); } }, 'Enregistrer les plafonds'))));
    card.appendChild(h('div', { class: 'elo-a-small' }, consumptionText(cap, use, isGb)));
    body.appendChild(card);
  }

  if (sum && sum.ok && Array.isArray(sum.extra)) {
    body.appendChild(h('h3', {}, 'Autres voies (lues dans le registre)'));
    for (const x of sum.extra) {
      body.appendChild(h('div', { class: 'elo-a-row' },
        h('strong', {}, x.label),
        h('span', { class: 'elo-a-small' }, `${x.configured === false ? 'non configuré · ' : ''}dernière utilisation : ${U.relTime(x.lastUse, now)} · ${U.fmtInt(x.today ? x.today.calls : 0)} appel(s) aujourd'hui · ${U.fmtInt(x.month ? x.month.calls : 0)} ce mois${x.month && x.month.credits ? ` · ${U.fmtInt(x.month.credits)} crédits ce mois` : ''}${x.lastError ? ` · dernière erreur ${U.fmtDateTime(x.lastError.ts)} (${U.outcomeText(x.lastError.outcome).toLowerCase()})` : ''}`)));
    }
  }

  // Historical admin journal (monthly counters + "votre navigateur" runs) — kept.
  body.appendChild(h('h3', {}, 'Journal administrateur (compteurs du mois)'));
  const log = E.admin.log ? await E.admin.log(null) : null;
  if (log && !log.locked) {
    for (const r of (log.rows || [])) body.appendChild(h('div', { class: 'elo-a-row' }, h('span', {}, r.label), h('span', {}, `${r.configured ? 'configuré' : 'non configuré'} · ${r.calls} appel(s) · ${r.estCost}${r.skipReason ? ' · ' + r.skipReason : ''}`)));
    for (const r of (log.runs || []).slice(0, 10)) body.appendChild(h('div', { class: 'elo-a-row' }, h('span', {}, r.label || 'Votre navigateur'), h('span', {}, `${r.domain || '—'} · ${r.status || '—'} · ${Number(r.products) || 0} produit(s) · gratuit (aucun fournisseur payant) · ${String(r.at || '').slice(0, 16).replace('T', ' ')}`)));
  }
}

function consumptionText(cap, use, isGb) {
  const parts = [];
  if (isGb) {
    parts.push(`${U.fmtBytes(use.bytesThisMonth || 0)}${cap.maxBytesPerMonth != null ? ` sur ${U.fmtBytes(cap.maxBytesPerMonth)}` : ''} ce mois`);
    parts.push(`${U.fmtUsd(use.usdThisMonth || 0)}${cap.maxUsdPerMonth != null ? ` sur ${cap.maxUsdPerMonth} $` : ''} (estimé)`);
  } else if (cap.maxCallsPerMonth != null) parts.push(`${use.callsThisMonth || 0} appel(s) sur ${cap.maxCallsPerMonth} ce mois`);
  if (cap.maxCallsPerJob != null) parts.push(`compteur « par job » : ${use.callsThisJob || 0} sur ${cap.maxCallsPerJob}`);
  return `Consommation : ${parts.join(' · ') || 'aucune'}.`;
}

function balanceRow(bal, now) {
  const txt = bal && bal.remaining != null
    ? `Solde Firecrawl : ${U.fmtInt(bal.remaining)} crédits — lu ${U.relTime(bal.at, now)}${bal.resetAt ? ` · remise à zéro le ${U.fmtDate(bal.resetAt)}` : ''}.`
    : 'Solde Firecrawl : jamais lu.';
  const msg = h('span', { class: 'elo-a-small' });
  return h('div', { class: 'elo-a-row' }, h('span', {}, txt, ' ', h('span', { class: 'elo-a-small' }, '(lecture gratuite, aucun crédit consommé)')),
    h('span', {}, h('button', { class: 'elo-a-btn sec', onclick: async () => {
      if (!E.balance) return;
      msg.textContent = 'Lecture…';
      const r = await E.balance.refresh('firecrawl');
      if (locked(r)) return open();
      if (!r.ok) { msg.textContent = `Lecture impossible : ${r.error || 'erreur'}.`; return; }
      screenPanel();
    } }, 'Actualiser le solde'), ' ', msg));
}

// ---------------------------------------------------------------- tab: Utilisation

const PROVIDER_OPTS = [['', 'Toutes les voies'], ...U.PROVIDER_ORDER.map((p) => [p, U.PROVIDER_LABEL[p]])];
const OUTCOME_OPTS = [['', 'Tous les résultats'], ...Object.entries(U.OUTCOME_LABEL)];
const TEST_OPTS = [['', 'Avec et sans mode test'], ['true', 'Mode test uniquement'], ['false', 'Hors mode test']];
const select = (id, opts, value) => h('select', { id }, ...opts.map(([v, l]) => h('option', { value: v, selected: String(value ?? '') === v }, l)));
const dayStart = (d) => (d ? new Date(`${d}T00:00:00`).getTime() : null);
const dayEnd = (d) => (d ? new Date(`${d}T00:00:00`).getTime() + 864e5 : null);

function readFilter() {
  const v = (id) => { const el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; };
  const f = {};
  if (v('uf-provider')) f.provider = v('uf-provider');
  if (v('uf-outcome')) f.outcome = v('uf-outcome');
  if (v('uf-domain')) f.domain = v('uf-domain');
  if (v('uf-test')) f.testMode = v('uf-test');
  if (v('uf-from')) { f.fromDay = v('uf-from'); f.from = dayStart(f.fromDay); }
  if (v('uf-to')) { f.toDay = v('uf-to'); f.to = dayEnd(f.toDay); }
  if (S.usage.filter.jobId) f.jobId = S.usage.filter.jobId;
  return f;
}

function periodCard(title, p) {
  const t = (p && p.total) || {};
  const by = (p && p.byProvider) || {};
  const paid = U.PAID.filter((k) => by[k] && (by[k].events || 0) > 0);
  const lines = paid.map((k) => h('div', { class: 'elo-a-small' }, `${U.PROVIDER_LABEL[k]} : ${U.fmtInt(by[k].calls)} appel(s)${by[k].credits ? ` · ${U.fmtInt(by[k].credits)} crédits` : ''}${by[k].costUsd ? ` · ${U.fmtUsd(by[k].costUsd)}` : ''}${by[k].costUnknown ? ` · ${by[k].costUnknown} sans prix` : ''}${by[k].blocked ? ` · ${by[k].blocked} bloqué(s)` : ''}`));
  const paidCalls = paid.reduce((a, k) => a + (by[k].calls || 0), 0);
  const credits = paid.reduce((a, k) => a + (by[k].credits || 0), 0);
  const cost = paid.reduce((a, k) => a + (by[k].costUsd || 0), 0);
  const unknown = paid.reduce((a, k) => a + (by[k].costUnknown || 0), 0);
  return h('div', { class: 'elo-a-kpi' },
    h('div', { class: 'elo-a-small' }, title),
    h('div', {}, h('b', {}, U.fmtInt(paidCalls)), ' appel(s) payant(s)'),
    h('div', { class: 'elo-a-small' }, `${U.fmtInt(credits)} crédits Eloshon · coût estimé ${U.fmtUsd(cost)}${unknown ? ` + ${unknown} appel(s) sans prix renseigné` : ''}`),
    h('div', { class: 'elo-a-small' }, `${U.fmtInt(t.events || 0)} évènement(s) au total, voies gratuites comprises`),
    ...lines);
}

async function tabUsage(body) {
  if (!E.usage) { body.appendChild(h('p', { class: 'elo-a-alert warn' }, 'Le registre d\'utilisation n\'est pas disponible dans cette version.')); return; }
  if (S.pendingJob) { S.usage.jobView = { jobId: S.pendingJob }; S.pendingJob = null; }
  const sum = await E.usage.summary(); if (locked(sum)) return open();
  body.appendChild(h('h2', {}, 'Utilisation'));
  body.appendChild(h('p', { class: 'elo-a-small' }, `Chaque ligne est un évènement du registre permanent (jamais remis à zéro). Les heures sont affichées dans votre fuseau horaire. Les coûts sont des estimations calculées avec les prix de l'onglet Coûts ; la facture du fournisseur fait foi.${sum.firstEventAt ? ` Premier évènement enregistré : ${U.fmtDateTime(sum.firstEventAt)}.` : ' Aucun évènement enregistré pour l\'instant.'}`));
  if (sum.badLines) body.appendChild(h('p', { class: 'elo-a-alert warn' }, `${sum.badLines} ligne(s) illisible(s) ont été ignorées dans le registre (écriture interrompue). Les autres lignes sont affichées.`));
  body.appendChild(h('div', { class: 'elo-a-kpis' }, periodCard('Aujourd\'hui', sum.periods.today), periodCard('7 derniers jours', sum.periods.last7d), periodCard('Ce mois-ci', sum.periods.month)));

  if (S.usage.jobView) body.appendChild(await jobPanel(S.usage.jobView.jobId));

  const f = S.usage.filter;
  const filters = h('div', { class: 'elo-a-filters' },
    h('label', {}, 'Voie', select('uf-provider', PROVIDER_OPTS, f.provider)),
    h('label', {}, 'Résultat', select('uf-outcome', OUTCOME_OPTS, f.outcome)),
    h('label', {}, 'Du', h('input', { type: 'date', id: 'uf-from', value: f.fromDay || '' })),
    h('label', {}, 'Au (inclus)', h('input', { type: 'date', id: 'uf-to', value: f.toDay || '' })),
    h('label', {}, 'Domaine (sous-domaines inclus)', h('input', { type: 'text', id: 'uf-domain', placeholder: 'ex. adidas.be', value: f.domain || '' })),
    h('label', {}, 'Mode test', select('uf-test', TEST_OPTS, f.testMode)),
    h('button', { class: 'elo-a-btn', onclick: () => { S.usage.filter = readFilter(); S.usage.offset = 0; screenPanel(); } }, 'Filtrer'),
    h('button', { class: 'elo-a-btn sec', onclick: () => { S.usage.filter = {}; S.usage.offset = 0; S.usage.jobView = null; screenPanel(); } }, 'Réinitialiser'),
    h('button', { class: 'elo-a-btn sec', onclick: async (e) => {
      const r = await E.usage.exportCsv(apiFilter(readFilter()));
      const m = e.target.parentNode && e.target.parentNode.querySelector('.elo-a-small');
      if (locked(r)) return open();
      if (m) m.textContent = r.ok ? `Export enregistré : ${r.path} (${r.rows} ligne(s)).` : (r.cancelled ? 'Export annulé.' : `Export impossible : ${r.error || 'erreur'}.`);
    } }, 'Exporter en CSV (filtre actuel)'),
    h('span', { class: 'elo-a-small' }),
  );
  body.appendChild(filters);
  if (f.jobId) body.appendChild(h('p', { class: 'elo-a-small' }, `Filtré sur le job ${f.jobId}. `, h('button', { class: 'elo-a-link', onclick: () => { delete S.usage.filter.jobId; screenPanel(); } }, 'Retirer ce filtre')));

  const page = await E.usage.query(apiFilter(f), { offset: S.usage.offset, limit: S.usage.limit });
  if (locked(page)) return open();
  if (!page.ok) { body.appendChild(h('p', { class: 'elo-a-alert err' }, `Lecture du registre impossible : ${page.error || 'erreur'}.`)); return; }
  let rows = page.rows.slice();
  const so = S.usage.sort;
  if (so) {
    const val = (r) => (so.k === 'ts' ? r.ts : so.k === 'costUsd' || so.k === 'durationMs' || so.k === 'credits' || so.k === 'products' ? (Number(r[so.k]) || 0) : String(r[so.k] || ''));
    rows.sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * (so.dir === 'asc' ? 1 : -1));
  }
  const th = (k, label) => h('th', { title: 'Trier cette page', onclick: () => { S.usage.sort = { k, dir: so && so.k === k && so.dir === 'desc' ? 'asc' : 'desc' }; screenPanel(); } }, label + (so && so.k === k ? (so.dir === 'asc' ? ' ▲' : ' ▼') : ''));
  const table = h('table', { class: 'elo-a-tbl' },
    h('thead', {}, h('tr', {}, th('ts', 'Date et heure'), th('jobId', 'Job'), th('domain', 'Domaine'), th('provider', 'Voie'), th('outcome', 'Résultat'), th('products', 'Produits'), th('credits', 'Crédits'), th('costUsd', 'Coût estimé'), th('durationMs', 'Durée'))),
    h('tbody', {}, ...(rows.length ? rows.map((r) => h('tr', {},
      h('td', {}, U.fmtDateTime(r.ts)),
      h('td', {}, r.jobId ? h('button', { class: 'elo-a-link', title: 'Ouvrir ce job', onclick: () => { S.usage.jobView = { jobId: r.jobId }; screenPanel(); } }, r.jobId) : '—'),
      h('td', {}, r.domain || '—'),
      h('td', {}, U.providerName(r.provider, r.channel), r.route ? h('div', { class: 'elo-a-small' }, U.routeName(r.route)) : null, r.testMode ? pill('mode test', 'warn') : null),
      h('td', {}, pill(U.outcomeText(r.outcome), U.OUTCOME_TONE[r.outcome] || ''), r.reason ? h('div', { class: 'elo-a-small' }, U.reasonText(r.reason)) : null),
      h('td', {}, U.fmtInt(r.products)),
      h('td', {}, r.credits != null ? U.fmtInt(r.credits) : '—'),
      h('td', {}, !r.attempted ? '—' : (r.channel === 'server' || r.provider === 'cascade') ? 'en crédits' : U.fmtUsd(r.costUsd), U.paidForNothing(r) ? h('div', { class: 'elo-a-small' }, 'Appel payé, aucun produit') : null),
      h('td', {}, U.fmtDuration(r.durationMs)),
    )) : [h('tr', {}, h('td', { colspan: '9' }, 'Aucun évènement ne correspond à ce filtre.'))])));
  body.appendChild(table);
  const from = page.total ? page.offset + 1 : 0; const to = page.offset + page.rows.length;
  body.appendChild(h('div', { class: 'elo-a-row' },
    h('span', { class: 'elo-a-small' }, `Lignes ${U.fmtInt(from)} à ${U.fmtInt(to)} sur ${U.fmtInt(page.total)} (les plus récentes d'abord ; le tri par colonne s'applique à la page affichée).`),
    h('span', {},
      h('button', { class: 'elo-a-btn sec', disabled: page.offset <= 0, onclick: () => { S.usage.offset = Math.max(0, page.offset - S.usage.limit); screenPanel(); } }, 'Précédent'), ' ',
      h('button', { class: 'elo-a-btn sec', disabled: to >= page.total, onclick: () => { S.usage.offset = page.offset + S.usage.limit; screenPanel(); } }, 'Suivant'))));
  if (Array.isArray(sum.legacyRuns) && sum.legacyRuns.length) {
    body.appendChild(h('h3', {}, 'Exécutions « Votre navigateur » du journal précédent (20 dernières)'));
    for (const r of sum.legacyRuns.slice(0, 20)) body.appendChild(h('div', { class: 'elo-a-row elo-a-small' }, h('span', {}, `${U.fmtDateTime(r.at)} · ${r.domain || '—'}`), h('span', {}, `${r.status || '—'} · ${Number(r.products) || 0} produit(s) · gratuit`)));
  }
}

/** Filter for the IPC: day strings stay UI-only. */
function apiFilter(f) { const o = { ...(f || {}) }; delete o.fromDay; delete o.toDay; return o; }

async function jobPanel(jobId) {
  const box = h('div', { class: 'elo-a-card' });
  const r = await E.usage.job(jobId);
  if (locked(r)) { open(); return box; }
  box.appendChild(h('div', { class: 'elo-a-row' }, h('strong', {}, `Job ${jobId}`), h('span', {},
    h('button', { class: 'elo-a-btn sec', onclick: () => { S.usage.filter = { jobId }; S.usage.offset = 0; screenPanel(); } }, 'Filtrer le tableau sur ce job'), ' ',
    h('button', { class: 'elo-a-btn sec', onclick: () => { S.usage.jobView = null; screenPanel(); } }, 'Fermer'))));
  const pp = U.passeParLine(r.events || [], { unlocked: true });
  box.appendChild(h('p', {}, pp ? pp.text : 'Aucune ligne dans le registre pour ce job (job antérieur au registre, ou rien n\'a été enregistré).', pp && pp.testMode ? ' ' : null, pp && pp.testMode ? pill('mode test', 'warn') : null));
  if (pp && pp.blocked.length) box.appendChild(h('p', { class: 'elo-a-small' }, `Voies bloquées : ${pp.blocked.join(' · ')}.`));
  for (const e of (r.events || [])) {
    box.appendChild(h('div', { class: 'elo-a-row elo-a-small' },
      h('span', {}, `${U.fmtDateTime(e.ts)} · ${U.providerName(e.provider, e.channel)}${e.route ? ` (${U.routeName(e.route)})` : ''}`),
      h('span', {}, [
        `${U.outcomeText(e.outcome)}${e.reason ? ` — ${U.reasonText(e.reason)}` : ''}`,
        e.products != null ? `${U.fmtInt(e.products)} produit(s)` : null,
        e.bytes != null ? U.fmtBytes(e.bytes) : null,
        e.durationMs != null ? U.fmtDuration(e.durationMs) : null,
        e.credits != null ? `${U.fmtInt(e.credits)} crédit(s)` : null,
        e.attempted && e.channel !== 'server' && e.provider !== 'cascade' ? `coût ${U.fmtUsd(e.costUsd)}` : null,
      ].filter(Boolean).join(' · '))));
  }
  const rep = r.report;
  if (rep) {
    const bd = rep.bytesDownloaded || {};
    const lines = [
      `Résultat du job : ${rep.status || '—'} · méthode : ${rep.method || '—'}${rep.diagnosis ? ` · diagnostic : ${rep.diagnosis}` : ''} · ${U.fmtInt(rep.accepted)} accepté(s) sur ${U.fmtInt(rep.detected)} · durée ${U.fmtDuration(rep.durationMs)}`,
      bd.total != null ? `Octets téléchargés : ${U.fmtBytes(bd.total)} (HTTP ${U.fmtBytes(bd.http)}, navigateur ${U.fmtBytes(bd.browser)}, Web Unlocker ${U.fmtBytes(bd.unlocker)}, Firecrawl ${U.fmtBytes(bd.firecrawl)}, Scraping Browser ${U.fmtBytes(bd.scrapingBrowser)})` : null,
      rep.scrapingBrowser && rep.scrapingBrowser.runtimeSec != null ? `Durée de session Scraping Browser : ${rep.scrapingBrowser.runtimeSec} s` : null,
      rep.unlock && rep.unlock.provider ? `Voie payante du rapport : ${rep.unlock.provider} — ${rep.unlock.ok ? 'réussie' : 'échouée'}${rep.unlock.note ? ` (${rep.unlock.note})` : ''}` : null,
      Array.isArray(rep.unlockChain) && rep.unlockChain.length ? `Voies payantes essayées, dans l'ordre : ${rep.unlockChain.map((c) => `${c.provider} — ${c.attempted ? (c.outcome === 'success' ? `produits trouvés${c.products ? ` (${U.fmtInt(c.products)})` : ''}` : c.outcome === 'empty' ? 'page reçue, aucun produit' : `${U.outcomeText(c.outcome).toLowerCase()}${c.reason ? ` [${c.reason}]` : ''}`) : `non tentée${c.reason ? ` [${c.reason}]` : ''}`}`).join(' → ')}` : null,
      rep.productLimit && rep.productLimit.max != null ? `Limite de produits du formulaire atteinte : ${U.fmtInt(rep.productLimit.max)}${rep.productLimit.read != null ? ` (${U.fmtInt(rep.productLimit.read)} carte(s) lues sur la page, ${U.fmtInt(rep.productLimit.kept)} gardées)` : ''}` : null,
      rep.credits != null ? `Crédits Eloshon (cascade) : ${U.fmtInt(rep.credits)}${rep.provider ? ` · fournisseur ${rep.provider}` : ''}` : null,
      rep.recipeBootstrap ? `Session d'amorçage : ${rep.recipeBootstrap.ok ? 'réussie' : 'échouée'} · ${U.fmtBytes(rep.recipeBootstrap.bytes)}${rep.recipeBootstrap.runtimeSec != null ? ` · ${rep.recipeBootstrap.runtimeSec} s` : ''}` : null,
    ].filter(Boolean);
    box.appendChild(h('h3', {}, 'Rapport technique du job (report.json)'));
    for (const l of lines) box.appendChild(h('div', { class: 'elo-a-small' }, l));
  }
  return box;
}

// ---------------------------------------------------------------- tab: Domaines

async function tabDomains(body) {
  body.appendChild(h('h2', {}, 'Domaines'));
  body.appendChild(h('p', { class: 'elo-a-alert info' },
    'Deux réglages distincts par site. « Voie payante autorisée » : sans cette case cochée, l\'application n\'appelle jamais ce fournisseur pour ce site (sauf lancement en mode test). « Non bloqué » : l\'ancien interrupteur du site, coché par défaut ; le décocher bloque le fournisseur pour ce site même si la voie est autorisée. La voie ne part que si les deux sont cochés, que la clé est enregistrée et que le plafond n\'est pas atteint.'));
  if (!E.optin) { body.appendChild(h('p', { class: 'elo-a-alert warn' }, 'Les autorisations par site ne sont pas disponibles dans cette version.')); return; }
  const preview = h('span', { class: 'elo-a-small', id: 'dom-preview' });
  const input = h('input', { type: 'text', id: 'dom-new', placeholder: 'ex. https://www.adidas.be/homme ou adidas.be', style: 'min-width:320px', oninput: async (e) => {
    const r = await E.optin.normalize(e.target.value);
    if (locked(r)) return;
    preview.textContent = r.ok ? `Sera enregistré comme « ${r.domain} » : couvre ${r.matches.join(' et ')} ; ne couvre pas les ${r.notMatched}.` : (e.target.value.trim() ? 'Ce n\'est pas un nom de domaine valide.' : '');
  } });
  const msg = h('p', { class: 'elo-a-msg', id: 'dom-msg' });
  body.appendChild(h('div', { class: 'elo-a-row' }, h('span', {}, input, ' ', h('button', { class: 'elo-a-btn', onclick: async () => {
    const r = await E.optin.add(input.value);
    if (locked(r)) return open();
    if (!r.ok) { msg.textContent = 'Domaine refusé : saisissez un nom comme adidas.be ou une adresse complète.'; msg.style.color = 'var(--danger)'; return; }
    msg.textContent = `« ${r.domain} » ajouté. Cochez maintenant les voies payantes à autoriser pour ce site.`; msg.style.color = 'var(--ok)';
    screenPanel();
  } }, 'Ajouter le domaine')), preview));
  body.appendChild(msg);

  const t = await E.optin.table(); if (locked(t)) return open();
  const prov = await E.provider.list(); if (locked(prov)) return open();
  const providerIds = (prov.providers || []).map((p) => ({ id: p.id, label: p.label.replace('Bright Data — ', 'BD ') }));
  const toggles = Object.fromEntries((prov.domains || []).map((d) => [d.domain, d.toggles]));
  if (!t.rows.length) { body.appendChild(h('p', { class: 'elo-a-small' }, 'Aucun domaine pour l\'instant. Ajoutez le site à tester ci-dessus.')); return; }
  const head = h('tr', {}, h('th', {}, 'Domaine'), ...t.routes.map((r) => h('th', {}, r.label)), h('th', {}, 'Interrupteurs du site (non bloqué)'), h('th', {}, ''));
  const rows = t.rows.map((row) => h('tr', {},
    h('td', {}, h('strong', {}, row.domain), h('div', { class: 'elo-a-small' }, `couvre aussi www.${row.domain}`)),
    ...row.routes.map((r) => h('td', {},
      h('label', {}, h('input', { type: 'checkbox', checked: r.optedIn, onchange: async (e) => {
        const res = await E.optin.set(row.domain, r.key, e.target.checked);
        if (locked(res)) return open();
        const m = document.getElementById('dom-msg');
        if (m) { m.textContent = res.ok ? `${r.label} ${e.target.checked ? 'autorisé' : 'retiré'} pour ${row.domain}. config.json enregistré (copie de l'ancienne version : config.previous.json).` : `Enregistrement refusé (${res.error}) : config.json n'a pas été modifié.`; m.style.color = res.ok ? 'var(--ok)' : 'var(--danger)'; }
        screenPanel();
      } }), ' Voie payante autorisée'),
      h('div', { class: 'elo-a-small' }, r.allowed ? pill('partira si le site est bloqué', 'ok') : pill(effectiveReason(r), r.reason === 'no_optin' || r.reason === 'not_configured' ? '' : 'warn')),
      h('div', { class: 'elo-a-small' }, capsText(r.caps)))),
    h('td', {}, ...providerIds.map((p) => h('label', { style: 'display:block' }, h('input', { type: 'checkbox', checked: !toggles[row.domain] || toggles[row.domain][p.id] !== false, onchange: async (e) => { await E.provider.setDomain(row.domain, p.id, e.target.checked); screenPanel(); } }), ` ${p.label}`))),
    h('td', {}, h('button', { class: 'elo-a-btn danger', title: 'Retire le site de la liste, de ses interrupteurs et de toutes ses autorisations payantes', onclick: async () => {
      if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(`Retirer ${row.domain} : ses autorisations payantes et ses interrupteurs seront supprimés. Continuer ?`)) return;
      for (const r of row.routes) if (r.optedIn) await E.optin.set(row.domain, r.key, false);
      await E.provider.removeDomain(row.domain); screenPanel();
    } }, 'Retirer')),
  ));
  body.appendChild(h('table', { class: 'elo-a-tbl' }, h('thead', {}, head), h('tbody', {}, ...rows)));
  body.appendChild(h('p', { class: 'elo-a-small' }, 'Un sous-domaine (ex. boutique.exemple.com) doit être ajouté séparément : l\'autorisation porte exactement sur le nom saisi, avec ou sans « www. ». Les domaines appris par l\'application (sites déjà scrapés) apparaissent aussi ici, sans aucune autorisation.'));
}

function effectiveReason(r) {
  if (r.reason === 'no_optin') return 'non autorisé';
  if (r.reason === 'not_configured') return 'clé non enregistrée';
  if (r.reason === 'cap_reached') return 'plafond atteint';
  if (r.reason === 'domain_off') return 'bloqué par l\'interrupteur du site';
  if (r.reason === 'kill_switch') return 'tout est désactivé';
  if (r.reason === 'disabled') return 'fournisseur désactivé';
  return 'ne partira pas';
}
function capsText(c) {
  if (!c) return '';
  const p = [];
  if (c.maxCallsPerJob != null) p.push(`${c.maxCallsPerJob}/job`);
  if (c.maxCallsPerMonth != null) p.push(`${c.maxCallsPerMonth}/mois`);
  if (c.maxBytesPerJob != null) p.push(`${Math.round(c.maxBytesPerJob / MB)} Mo/job`);
  if (c.maxUsdPerMonth != null) p.push(`${c.maxUsdPerMonth} $/mois`);
  return p.length ? `plafonds : ${p.join(' · ')}` : '';
}

// ---------------------------------------------------------------- tab: Coûts

const COST_ROWS = [
  ['scrapingbrowser', 'usdPerGb', 'Bright Data Scraping Browser', '$ par Go de trafic'],
  ['webunlocker', 'usdPerRequest', 'Bright Data Web Unlocker', '$ par requête'],
  ['firecrawl', 'usdPerCredit', 'Firecrawl', '$ par crédit (si l\'API renvoie les crédits)'],
  ['firecrawl', 'usdPerRequest', 'Firecrawl', '$ par requête (sinon)'],
  ['zyte', 'usdPerRequest', 'Zyte', '$ par requête'],
  ['anthropic', 'usdPerMTokIn', 'Claude (Anthropic)', '$ par million de tokens en entrée'],
  ['anthropic', 'usdPerMTokOut', 'Claude (Anthropic)', '$ par million de tokens en sortie'],
];

async function tabCosts(body) {
  body.appendChild(h('h2', {}, 'Coûts'));
  body.appendChild(h('p', { class: 'elo-a-alert info' }, 'Ces prix servent uniquement à estimer le coût de chaque appel dans l\'onglet Utilisation. Un prix vide signifie « inconnu » : l\'appel est compté, sans montant. Recopiez le prix de votre contrat ; la facture du fournisseur fait toujours foi. La cascade serveur est comptée en crédits Eloshon, pas en dollars.'));
  if (!E.costs) { body.appendChild(h('p', { class: 'elo-a-alert warn' }, 'Les réglages de coût ne sont pas disponibles dans cette version.')); return; }
  const c = await E.costs.get(); if (locked(c)) return open();
  const sum = E.usage ? await E.usage.summary() : null; if (locked(sum)) return open();
  const stored = c.stored || {};
  const rows = COST_ROWS.map(([prov, field, label, unit]) => {
    const v = c.costs[prov] ? c.costs[prov][field] : null;
    const fromCfg = stored[prov] && Object.prototype.hasOwnProperty.call(stored[prov], field);
    const month = sum && sum.ok ? sum.periods.month.byProvider[prov] : null;
    return h('tr', {},
      h('td', {}, label), h('td', {}, unit),
      h('td', {}, h('input', { type: 'number', min: '0', step: 'any', style: 'width:110px', 'data-prov': prov, 'data-field': field, value: v == null ? '' : String(v), placeholder: 'inconnu', oninput: markDirty })),
      h('td', { class: 'elo-a-small' }, fromCfg ? 'config.json' : (v != null ? 'valeur par défaut du code' : 'non renseigné')),
      h('td', { class: 'elo-a-small' }, month ? `${U.fmtInt(month.calls)} appel(s) ce mois · ${U.fmtUsd(month.costUsd)}${month.costUnknown ? ` + ${month.costUnknown} sans prix` : ''}` : '—'));
  });
  const msg = h('p', { class: 'elo-a-msg' });
  body.appendChild(h('table', { class: 'elo-a-tbl' }, h('thead', {}, h('tr', {}, h('th', {}, 'Fournisseur'), h('th', {}, 'Unité'), h('th', {}, 'Prix'), h('th', {}, 'Source'), h('th', {}, 'Ce mois (estimé)'))), h('tbody', {}, ...rows)));
  body.appendChild(h('div', { style: 'margin-top:10px' }, h('button', { class: 'elo-a-btn', onclick: async () => {
    const patch = {};
    for (const i of body.querySelectorAll('input[data-prov]')) { const p = i.getAttribute('data-prov'); (patch[p] = patch[p] || {})[i.getAttribute('data-field')] = i.value === '' ? null : Number(i.value); }
    const r = await E.costs.set(patch); if (locked(r)) return open();
    if (r.ok) { setDirty(false); msg.textContent = 'Prix enregistrés dans config.json. Ils s\'appliquent aux prochains appels ; les lignes déjà écrites gardent leur estimation.'; msg.style.color = 'var(--ok)'; }
    else { msg.textContent = `Prix refusés (${r.error}) : saisissez un nombre positif ou laissez la case vide.`; msg.style.color = 'var(--danger)'; }
  } }, 'Enregistrer les prix')), msg);
}

// ---------------------------------------------------------------- .env import (unchanged flow)

async function importFlow() {
  const pv = await E.provider.importPreview();
  if (locked(pv)) return open();
  if (pv.cancelled) return;
  if (!pv.ok) { const m = document.getElementById('panel-msg'); if (m) m.textContent = pv.error || 'échec'; return; }
  const list = pv.mapped.map((m) => `• ${m.name} → ${m.providerLabel} (${m.field})`).join('\n');
  const unmapped = pv.unmapped.length ? `\n\nNon reconnus : ${pv.unmapped.join(', ')}` : '';
  const warnLabel = (w) => (w.reason === 'colon-separator'
    ? `ligne ${w.line} : « : » au lieu de « = »${w.name ? ` (${w.name})` : ''}`
    : w.reason === 'invalid-name'
      ? `ligne ${w.line} : nom de variable invalide`
      : `ligne ${w.line} : pas une affectation KEY=valeur${(w.mentions && w.mentions.length) ? ` (mentionne ${w.mentions.join(', ')})` : ''}`);
  const warns = (pv.warnings && pv.warnings.length) ? `\n\nLignes ignorées :\n${pv.warnings.map(warnLabel).join('\n')}` : '';
  render(h('div', { class: 'elo-a-lock' },
    h('h2', {}, 'Importer des clés'),
    h('p', { class: 'elo-a-msg' }, `Fichier : ${pv.path}`),
    h('pre', { style: 'white-space:pre-wrap;font:var(--t-value)' }, list + unmapped + warns),
    h('div', { style: 'text-align:right' },
      h('button', { class: 'elo-a-btn sec', onclick: () => screenPanel() }, 'Annuler'), ' ',
      h('button', { class: 'elo-a-btn', onclick: async () => { const r = await E.provider.importConfirm(pv.path); if (locked(r)) return open(); screenPanel(); } }, `Importer ${pv.mapped.length} clé(s)`))));
}

// ---------------------------------------------------------------- entry point (fallback trigger)

if (E && E.admin && typeof document !== 'undefined') {
  const root = document.getElementById('admin-root');
  if (root) {
    injectStyle();
    // The modal lives in its OWN host so opening/closing it never removes the
    // persistent trigger button (BUG 2: root.innerHTML='' used to wipe the trigger).
    modalHost = document.createElement('div');
    root.appendChild(modalHost);
    // In the app the sidebar entry is the way in (the trigger is hidden by CSS and
    // redirects to the page); standalone, the trigger opens the modal.
    root.appendChild(h('button', { class: 'elo-a-trigger', title: 'Administration (propriétaire)', onclick: () => {
      if (typeof window !== 'undefined' && window.eloshonNav && typeof window.eloshonNav.go === 'function') { window.eloshonNav.go('admin'); return; }
      openModal();
    } }, 'Administration'));
  }
}
