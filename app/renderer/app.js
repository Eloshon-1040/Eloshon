/* Eloshon Scraper — renderer SPA. Talks to main only via window.eloshon.
 * All UI strings come from i18n (t/tc). Never translates scraped data. */
import { t, tc, setLang, getLang, availableLangs, LANG_LABELS, DEFAULT_LANG } from './i18n/index.js';
import { ybModeHTML, ybModeView, ybLimitsHTML, ybRunning, applyYbState, ybRunningTopHTML, ybErrorText, YB_TERMINAL } from './your-browser-ui.js';
import { attachAdminPage, detachAdminPage, confirmLeaveAdmin, adminOpenJob } from './admin-panel.js';
import { CI, chip, progressCardHTML, fmtDuration, runElapsed, etaText } from './ui-kit.js';
import { passeParLine, fmtUsd as admUsd, reasonText as admReason } from './admin-usage-ui.js';

const E = window.eloshon || null;
const I = {
  moon:'<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><path d="M20 15a8 8 0 1 1-9.9-9.4A6.2 6.2 0 0 0 20 15Z"/></svg>',
  // Eloshon monogram (logo direction C): the "E" as a stack of data rows, the
  // middle arm shortened, releasing one unit (extraction inscribed in the letter).
  logo:'<svg aria-hidden="true" viewBox="0 0 64 64" fill="currentColor" aria-hidden="true"><rect x="8" y="11" width="11" height="41" rx="5"/><rect x="23" y="11" width="33" height="11" rx="5.5"/><rect x="23" y="26" width="20" height="11" rx="5.5"/><rect x="47" y="26" width="9" height="11" rx="4.5" opacity="0.55"/><rect x="23" y="41" width="33" height="11" rx="5.5"/></svg>',
  dash:'<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>',
  plus:'<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 5v14M5 12h14"/></svg>',
  list:'<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>',
  grid:'<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M9.5 9.5V19.5"/></svg>',
  store:'<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 9l1.4-4.5h13.2L20 9M5 9v10h14V9M5 9h14M9.5 19v-5h5v5"/></svg>',
  gear:'<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3.1"/><path d="M12 3.6v2.1M12 18.3v2.1M20.4 12h-2.1M5.7 12H3.6M18 6l-1.5 1.5M7.5 16.5 6 18M18 18l-1.5-1.5M7.5 7.5 6 6"/></svg>',
  shield:'<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/><path d="M9.2 12l2 2 3.6-3.8"/></svg>',
  search:'<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/></svg>',
  play:'<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  pause:'<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  stop:'<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  check:'<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 7L9.5 17.5 4 12"/></svg>',
  checkC:'<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M8.4 12.2l2.4 2.4 4.8-5"/></svg>',
  alert:'<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 4 2.8 20h18.4L12 4Z"/><path d="M12 10.5v4M12 17.4h.01"/></svg>',
  info:'<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  doc:'<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M7 3h8l4 4v14H7z"/><path d="M15 3v4h4M10 13h6M10 16.5h6M10 9.5h3"/></svg>',
  dl:'<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 3v11M8 10.5l4 4 4-4M5 19h14"/></svg>',
  folder:'<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2.2h8A1.5 1.5 0 0 1 20.5 9.7V18a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18Z"/></svg>',
  chevR:'<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 6l6 6-6 6"/></svg>',
  globe:'<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>',
  refr:'<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4"/></svg>',
  image:'<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="8.5" cy="9.5" r="1.7"/><path d="M4.5 17l4.5-4 3.5 3 3-2.5 4.5 4"/></svg>',
  ext:'<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 5h5v5M19 5l-8 8M11 5H6.5A1.5 1.5 0 0 0 5 6.5v11A1.5 1.5 0 0 0 6.5 19h11a1.5 1.5 0 0 0 1.5-1.5V13"/></svg>',
  min:'<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 12h12"/></svg>',
  max:'<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/></svg>',
  cls:'<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M7 7l10 10M17 7L7 17"/></svg>',
  inbox:'<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3.5 13.5 6 6.2A2 2 0 0 1 7.9 5h8.2A2 2 0 0 1 18 6.2l2.5 7.3M3.5 13.5V18a1.5 1.5 0 0 0 1.5 1.5h14A1.5 1.5 0 0 0 20.5 18v-4.5M3.5 13.5H9l1.4 2.2h3.2L15 13.5h5.5"/></svg>',
  browser:'<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9h17M7 6.7h.01M9.3 6.7h.01"/></svg>',
  key:'<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3M17 6l2 2M14 9l2 2"/></svg>',
  bolt:'<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M13 3 4 14h7l-1 7 9-11h-7z"/></svg>',
  plug:'<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/></svg>',
  dots:'<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
  lock:'<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/></svg>',
};

// "Administration" is a normal entry: the page itself asks for the passphrase and
// shows nothing about providers until it is unlocked.
const THEMES = ['system', 'light', 'dark'];
const NAVDEF = [['dash',I.dash],['new',I.plus],['jobs',I.list],['results',I.grid],['sources',I.store],['settings',I.gear],['admin',I.lock]];

const state = {
  view: 'dash', lang: DEFAULT_LANG,
  form: { url:'', store:'', productType:'auto', contentType:'auto', browser:true, intervene:true, maxProducts:1000, maxPages:150, maxDepth:3, workers:4, maxBrowser:40, ua:'', _sourceId:null, mode:'standard', yb:null,
    // Admin test mode (one launch only, never saved): which paid routes it allows.
    test:{ on:false, routes:{ firecrawl:true, webUnlocker:true, scrapingBrowser:true } } },
  // "Scraper via votre navigateur": availability of the mode for the typed address
  // (from the main process: opt-in, extension connection, default limits/bounds).
  ybAv: null,
  running: null, lastResult: null, jobs: [], results: null, info: {}, settings: {}, sources: [],
  detail: null, resumePrompt: null, reportView: null, sourceEdit: null, teach: null,
  // (store, domain) last established together — by a started run or a selected
  // saved source. Powers the New-scrape "Source doesn't match this site" nudge:
  // it fires only when the store is UNCHANGED from that pairing but the pasted
  // URL's domain has moved on (a Source left over from a prior job).
  srcCtx: null,
  // € par crédit du palier RÉELLEMENT actif sur le compte (jamais un taux
  // générique). null = palier gratuit, compte inconnu, ou serveur muet : on
  // affiche alors les crédits seuls, sans équivalent monétaire inventé.
  creditRate: null,
  // Admin-only extras on the ordinary screens (never rendered when locked):
  // unlocked flag (re-read on navigation), the job route chain for "Passé par",
  // the test-mode plan of the New-scrape screen and its confirmation step.
  adminUnlocked: false, lastRoutes: null, testPlan: null, testConfirm: false,
  // Theme (system.md §7.2): system | light | dark, from config.json. stopConfirm: the « Arrêter… » dialog is open.
  theme: 'system', stopConfirm: false, srcDelete: null,
};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
// Numbers and dates through Intl in the interface language (system.md §3.1), never a hand-written separator or format.
const fmt = (n) => { if (n == null || n === '') return '—'; const x = Number(n); return Number.isFinite(x) ? new Intl.NumberFormat(getLang()).format(x) : String(n); };
const fmtWhen = (iso) => { const d = iso ? new Date(iso) : null; if (!d || Number.isNaN(d.getTime())) return '—'; return new Intl.DateTimeFormat(getLang(), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d); };
const fmtDay = (iso) => { const d = iso ? new Date(iso) : null; if (!d || Number.isNaN(d.getTime())) return '—'; return new Intl.DateTimeFormat(getLang(), { day: 'numeric', month: 'short', year: 'numeric' }).format(d); };
// Prices through Intl in the interface language (system.md §3.1): the product's own currency when the site states it,
// else the amount alone (never an assumed « € »).
const price = (p, currency) => {
  if (p == null || p === '') return '—';
  if (typeof p !== 'number') return String(p);
  try { return new Intl.NumberFormat(getLang(), currency ? { style: 'currency', currency } : { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(p); } catch { return p.toFixed(2); }
};
// Product eligibility: settled = accepted / excluded, attention = to check.
const statusPill = (s) => s === 'accepted' ? chip('ok', 'settled', CI.checkC, t('elig.accepted'))
  : s === 'excluded' ? chip('neutral', 'settled', CI.minusC, t('elig.excluded'))
  : chip('warn', 'attention', CI.alert, t('elig.to_verify'));
// Job states (system.md §5.4). Red only for a failure or a block; a stall asks for attention (resume it in Jobs).
const jobPill = (s) => {
  if (s === 'stopped:no_products') return chip('neutral', 'settled', CI.minusC, t('status.empty'));
  if (s === 'stopped:stalled') return chip('warn', 'attention', CI.alert, t('status.stalled'));
  // Stopped by the quality check: the products are there, to look at (« Apprendre cette page »), not a block.
  if (s === 'stopped:low_quality') return chip('warn', 'attention', CI.alert, t('status.lowQuality'));
  if (String(s).startsWith('stopped')) return chip('danger', 'attention', CI.octX, t('status.blocked'));
  const word = t('status.' + s) !== 'status.' + s ? t('status.' + s) : (s || '—');
  if (s === 'done') return chip('ok', 'settled', CI.check, word);
  if (s === 'running' || s === 'discovering') return chip('neutral', 'settled', '', word, true);
  if (s === 'paused') return chip('neutral', 'paused', CI.pause, word);
  if (s === 'interrupted') return chip('neutral', 'settled', CI.stopC, word);
  if (s === 'error') return chip('danger', 'attention', CI.xC, word);
  return chip('neutral', 'settled', CI.clock, word);
};
const reasonText = (p) => (p.status === 'accepted' ? '' : tc('eligReason', p.code, p.reason || t('eligReason._default')));

let toastTimer = null;
function toast(msg) { const el = document.getElementById('toast'); if (!el) return; el.textContent = msg; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2400); }

// ── Source ↔ site mismatch nudge (New-scrape, Item 3) ──
// Registrable-ish display host (drop www); tolerant of a bare domain typed w/o scheme.
const regDomain = (u) => { if (!u) return null; try { return new URL(/^[a-z]+:\/\//i.test(u) ? u : 'https://' + u).hostname.replace(/^www\./, '').toLowerCase() || null; } catch { return null; } };
// An address shown in a narrow column without its scheme and "www." (the full address stays in the title).
const shortUrl = (u) => String(u || '').replace(/^https?:\/\/(www\.)?/i, '');
const domainLabel = (d) => { const base = (d || '').split('.')[0]; return base ? base.charAt(0).toUpperCase() + base.slice(1) : ''; };
// Inner HTML of the hint, or '' when there is nothing to warn about.
function sourceHintHTML(url, store) {
  const s = (store || '').trim(); const d = regDomain(url); const ctx = state.srcCtx;
  if (!s || !d || !ctx || !ctx.store || ctx.store.trim() !== s || !ctx.domain || ctx.domain === d) return '';
  const label = domainLabel(d);
  return `<div class="noteline warn">${I.alert} <span>${esc(t('new.srcMismatch', { store: s, domain: d }))}</span>`
    + `<button class="btn btn-ghost btn-sm" data-act="src-hint-apply" data-label="${esc(label)}">${esc(t('new.srcMismatchApply', { label }))}</button></div>`;
}
// Live refresh (direct DOM, so it never wipes the URL field or the probe output).
function paintSourceHint() { const el = document.getElementById('src-hint'); if (el) el.innerHTML = sourceHintHTML(document.getElementById('f-url')?.value, document.getElementById('f-store')?.value); }

/* ---------------- shell ---------------- */
function shell(body) {
  // Suite lockup (system.md §8): the Eloshon mark on --signal, « Eloshon » 600, « Scraper » 400.
  const winBtn = (k, ic, cls) => `<button class="tb-btn${cls ? ' ' + cls : ''}" data-win="${k}" aria-label="${esc(t('win.' + k))}" title="${esc(t('win.' + k))}">${ic}</button>`;
  return `<div class="win">
    <div class="titlebar"><div class="lockup"><span class="lockup-mark">${I.logo}</span><b>Eloshon</b><span class="prod">Scraper</span></div>
      <div class="tb-btns">${winBtn('min', I.min)}${winBtn('max', I.max)}${winBtn('close', I.cls, 'close')}</div></div>
    <div class="shell">
      <aside class="sidebar">
        <nav class="nav" aria-label="${esc(t('side.workspace'))}"><div class="nav-cap">${esc(t('side.workspace'))}</div>
          ${NAVDEF.map(([k,ic]) => `<button type="button" class="nav-item ${state.view===k?'active':''}" data-nav="${k}"${state.view===k?' aria-current="page"':''}>${ic}<span>${esc(t('nav.'+k))}</span></button>`).join('')}
        </nav>
        <div class="side-foot">
          <div class="side-stat"><span class="sdot ${state.running?'run':'ok'}"></span> ${esc(state.running?t('side.jobRunning'):t('side.engineReady'))}</div>
          <div class="side-stat"><span class="sdot idle"></span> v${esc(state.info.version||'?')} · ${esc(state.info.arch||'')} · ${esc(state.info.packaged?t('side.packaged'):t('side.dev'))}</div>
        </div>
      </aside>
      <main class="content" id="content">${body}</main>
    </div>
  </div>`;
}

const numField = (id, label, val) => `<div class="field"><label class="label" for="${id}">${esc(label)}</label><div class="control"><input id="${id}" type="number" min="1" value="${esc(val)}"></div></div>`;
// On/off switch: a real switch for assistive tech, named by the visible label it sits next to.
const switchBtn = (on, attrs, labelledBy) => `<button type="button" class="switch ${on ? 'on' : 'off'}" role="switch" aria-checked="${on ? 'true' : 'false'}"${labelledBy ? ` aria-labelledby="${labelledBy}"` : ''} ${attrs}></button>`;
// One cell of a figures strip (.kpis): icon in the state color, label, tabular number, optional caption.
const kpi = (icon, tone, label, value, desc) => `<div class="kpi"><div class="kpi-k"><span class="ic ic-${tone}">${icon}</span>${esc(label)}</div><div class="kpi-v">${fmt(value)}</div>${desc ? `<div class="kpi-d">${esc(desc)}</div>` : ''}</div>`;

/* ---------------- views ---------------- */
function vDashboard() {
  const totals = state.jobs.reduce((a, j) => { const c = j.counts||{}; a.acc+=c.accepted||0; a.ver+=c.toVerify||0; a.exc+=c.excluded||0; return a; }, {acc:0,ver:0,exc:0});
  const recent = state.jobs.slice(0, 4);
  return `<div class="page-head"><div><h1 class="h1">${esc(t('dash.greeting'))}</h1><p class="sub">${esc(t('dash.sub'))}</p></div></div>
    <div class="card card-pad gap-bottom"><div class="field-row">
      <div class="field grow"><label class="label" for="qs-url">${esc(t('dash.addr'))}</label><div class="control big">${I.globe}<input id="qs-url" placeholder="${esc(t('dash.addrPh'))}" value="${esc(state.form.url)}"></div></div>
      <div class="field w-store"><label class="label" for="qs-store">${esc(t('dash.source'))}</label><div class="control big">${I.store}<input id="qs-store" placeholder="${esc(t('dash.sourcePh'))}" value="${esc(state.form.store)}"></div></div>
      <button class="btn btn-primary btn-lg" data-act="qs-start">${I.play} ${esc(t('common.start'))}</button></div></div>
    <div class="kpis">
      ${kpi(CI.checkC, 'ok', t('dash.kpiAccepted'), totals.acc, t('dash.kpiAcceptedD'))}
      ${kpi(CI.alert, 'warn', t('dash.kpiToVerify'), totals.ver, t('dash.kpiToVerifyD'))}
      ${kpi(CI.minusC, 'neutral', t('dash.kpiExcluded'), totals.exc, t('dash.kpiExcludedD'))}
      ${kpi(I.list, 'neutral', t('dash.kpiJobs'), state.jobs.length, t('dash.kpiJobsD'))}</div>
    <div class="card"><div class="card-head"><h2 class="h2">${esc(t('dash.recent'))}</h2><a data-nav="jobs" href="#">${esc(t('common.seeAll'))}</a></div>
      <div class="card-list">${recent.length ? recent.map((j)=>`<div class="mini"><div class="favi">${I.store}</div><div class="mini-main"><div class="mini-t">${esc(j.source)}</div><div class="mini-s">${esc(j.store||'—')} · ${esc(fmtWhen(j.createdAt))}</div></div>${jobPill(j.status)}</div>`).join('') : `<div class="mini-s mini-empty">${esc(t('dash.noJobs'))}</div>`}</div></div>`;
}

function vNew() {
  const f = state.form;
  // Mode "via votre navigateur" only when the typed site is opted in (else the
  // option is shown greyed with a plain explanation); standard mode otherwise.
  const yb = f.mode === 'yb' && ybModeView(state.ybAv).selectable;
  const standardOpts = `<div class="sect"><span class="sect-t">${esc(t('new.advanced'))}</span><span class="sect-line"></span><span class="chip-note">${esc(t('common.optional'))}</span></div>
      <div class="grid4">${numField('f-maxp',t('new.maxProducts'),f.maxProducts)}${numField('f-maxpg',t('new.maxPages'),f.maxPages)}${numField('f-depth',t('new.depth'),f.maxDepth)}${numField('f-workers',t('new.workers'),f.workers)}</div>
      <div class="sect"><span class="sect-t">${esc(t('new.browserProtections'))}</span><span class="sect-line"></span><span class="chip-note">${I.shield} ${esc(t('common.noBypass'))}</span></div>
      <div class="togrow"><div class="tog-txt"><span class="tog-name" id="tg-browser">${esc(t('new.fallbackName'))}</span><span class="tog-desc">${esc(t('new.fallbackDesc'))}</span></div>
        <div class="inline-num"><div class="control num-sm"><input id="f-maxb" type="number" value="${esc(f.maxBrowser)}" aria-label="${esc(t('settings.maxBrowser'))}"></div>${switchBtn(f.browser, 'data-toggle="browser"', 'tg-browser')}</div></div>
      <div class="togrow"><div class="tog-txt"><span class="tog-name" id="tg-intervene">${esc(t('new.interveneName'))}</span><span class="tog-desc">${esc(t('new.interveneDesc'))}</span></div>${switchBtn(f.intervene, 'data-toggle="intervene"', 'tg-intervene')}</div>
      ${state.adminUnlocked ? testModeHTML() : ''}`;
  const ybOpts = yb ? ybLimitsHTML(f.yb || state.ybAv.limits || {}, state.ybAv.bounds || {}) : '';
  return `<div class="page-head"><div><h1 class="h1">${esc(t('new.title'))}</h1><p class="sub">${esc(t('new.sub'))}</p></div></div>
    <div class="card card-pad">
      <div class="field"><label class="label" for="f-url">${esc(t('new.addr'))} <span class="opt">${esc(t('new.addrHint'))}</span></label><div class="control big">${I.globe}<input id="f-url" placeholder="${esc(t('new.addrPh'))}" value="${esc(f.url)}"></div></div>
      <div class="grid3 fit gap-top">
        <div class="field"><label class="label" for="f-store">${esc(t('new.source'))} <span class="opt">${esc(t('new.sourceHint'))}</span></label><div class="control">${I.store}<input id="f-store" placeholder="${esc(t('new.sourcePh'))}" value="${esc(f.store)}"></div></div>
        <div class="field"><label class="label" for="f-type">${esc(t('new.type'))}</label><div class="control"><input id="f-type" placeholder="${esc(t('new.typePh'))}" value="${esc(f.productType)}"></div></div>
        <div class="field"><label class="label" for="f-ctype">${esc(t('new.contentType'))}</label><div class="control"><select id="f-ctype">${['auto','product','video'].map((v)=>`<option value="${v}"${(f.contentType||'auto')===v?' selected':''}>${esc(t('new.ct_'+v))}</option>`).join('')}</select></div><div class="field-help">${esc(t('new.ctHint'))}</div></div></div>
      <div id="src-hint">${sourceHintHTML(f.url, f.store)}</div>
      <div id="yb-mode">${ybModeHTML(state.ybAv, f.mode, I)}</div>
      ${yb ? ybOpts : standardOpts}
      <div id="yb-msg"></div>
      <div class="btn-row form-foot">
        <button class="btn btn-primary btn-lg" data-act="start">${yb ? I.browser : I.play} ${esc(yb ? t('yb.start') : t('common.startScrape'))}</button>
        <button class="btn btn-ghost btn-lg" data-act="probe">${I.search} ${esc(t('common.analyze'))}</button>
        <span class="noteline push">${I.info} ${esc(t('new.analyzeHint'))}</span></div>
      <div id="probe-out"></div></div>${state.testConfirm ? testConfirmOverlay() : ''}`;
}

/* ---- admin test mode (New scrape; admin unlocked only; one launch, never saved) ---- */
const TEST_ROUTES = [['firecrawl','Firecrawl'],['webUnlocker','Bright Data Web Unlocker'],['scrapingBrowser','Bright Data Scraping Browser']];
function capsLine(c, u) {
  if (!c) return '';
  const p = [];
  if (c.maxCallsPerJob != null) p.push(`${c.maxCallsPerJob} appel(s)/job`);
  if (c.maxCallsPerMonth != null) p.push(`${u && u.callsThisMonth || 0} sur ${c.maxCallsPerMonth} appel(s) ce mois`);
  if (c.maxBytesPerJob != null) p.push(`${Math.round(c.maxBytesPerJob / 1048576)} Mo/job`);
  if (c.maxUsdPerMonth != null) p.push(`${(u && u.usdThisMonth || 0).toFixed(2).replace('.', ',')} $ sur ${c.maxUsdPerMonth} $ ce mois`);
  return p.join(' · ');
}
function testPlanHTML(plan, routes) {
  if (!plan) return `<div class="tog-desc gap-top">Saisissez l’adresse du site pour voir les voies, les plafonds et le coût maximal estimé.</div>`;
  if (!plan.ok) return `<div class="tog-desc gap-top note-tone-warn">${esc(plan.error === 'adresse invalide' ? 'Adresse invalide : saisissez une adresse complète (https://…).' : 'Plan indisponible : déverrouillez l’Administration puis réessayez.')}</div>`;
  const rows = plan.routes.map((r) => {
    const wanted = !!routes[r.key];
    const state0 = !r.configured ? 'clé non enregistrée : ne partira pas' : r.gateReason ? `bloqué (${admReason(r.gateReason)})` : r.optedIn ? 'déjà autorisé pour ce site' : (wanted ? 'autorisé par le mode test' : 'non autorisé');
    return `<label class="check-row"><input type="checkbox" data-act="test-route" data-route="${esc(r.key)}" ${wanted ? 'checked' : ''}><span><b>${esc(r.label)}</b> : ${esc(state0)}<br><span class="t-mut">${esc(capsLine(r.caps, r.usage))}</span></span></label>`;
  }).join('');
  const w = plan.worst || { routes: [], knownUsd: 0, unknown: [] };
  const sel = w.routes.filter((x) => routes[(plan.routes.find((r) => r.provider === x.provider) || {}).key]);
  const known = sel.reduce((a, x) => a + (x.usd || 0), 0);
  const unknown = sel.filter((x) => x.usd == null).map((x) => x.label);
  return `<div class="gap-top">${rows}</div>
    <div class="tog-desc gap-top">Pire cas estimé pour ce lancement : <b>${esc(admUsd(known))}</b>${unknown.length ? ` + ${esc(unknown.join(', '))} (prix non renseigné, onglet Coûts)` : ''}. Au plus un appel payant par voie, et seulement si la lecture gratuite ne trouve aucun produit.${plan.bootstrap ? ' Ce site a aussi une session d’amorçage Scraping Browser configurée.' : ''}</div>`;
}
function testModeHTML() {
  const ts = state.form.test;
  return `<div class="togrow warn"><div class="tog-txt"><span class="tog-name" id="tg-test">${I.lock} Mode test (administrateur)</span>
      <span class="tog-desc">Autorise les voies payantes pour ce seul lancement, même si le site n’est pas autorisé dans Administration › Domaines. Rien n’est enregistré dans la configuration ; chaque ligne du registre de ce job porte la mention « mode test ».</span>
      ${ts.on ? `<div id="test-plan">${testPlanHTML(state.testPlan, ts.routes)}</div>` : ''}</div>
    ${switchBtn(ts.on, 'data-act="test-toggle"', 'tg-test')}</div>`;
}
function testConfirmOverlay() {
  const plan = state.testPlan; const ts = state.form.test;
  const chosen = TEST_ROUTES.filter(([k]) => ts.routes[k]).map(([, l]) => l);
  return `<div class="overlay"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="dlg-test-t"><div class="modal-body">
    <div class="modal-icn warn">${I.lock}</div>
    <h3 class="modal-t" id="dlg-test-t">Lancer en mode test ?</h3>
    <p class="modal-p">Voies payantes autorisées pour ce lancement : <b>${esc(chosen.join(', ') || 'aucune')}</b>. Elles ne partent que si la lecture gratuite ne trouve aucun produit.</p>
    ${plan && plan.ok ? testPlanHTML(plan, ts.routes) : ''}
    <div class="noteline">${I.info} Le résultat et le coût de chaque appel s’affichent dans Administration › Utilisation.</div></div>
    <div class="modal-foot"><button class="btn btn-primary" data-act="test-confirm">${I.play} Lancer en mode test</button><button class="btn btn-ghost push" data-act="test-cancel">${esc(t('common.cancel'))}</button></div></div></div>`;
}
let testPlanTimer = null; let testPlanSeq = 0;
function scheduleTestPlan() { clearTimeout(testPlanTimer); testPlanTimer = setTimeout(refreshTestPlan, 350); }
async function refreshTestPlan() {
  if (!E || !E.admin || !E.admin.testPlan || !state.form.test.on) return;
  const url = (document.getElementById('f-url')?.value ?? state.form.url ?? '').trim();
  const seq = ++testPlanSeq;
  let plan = null;
  if (url) { try { plan = await E.admin.testPlan(/^[a-z]+:\/\//i.test(url) ? url : 'https://' + url); } catch { plan = { ok: false }; } }
  if (seq !== testPlanSeq) return;
  if (plan && plan.locked) { state.adminUnlocked = false; state.form.test.on = false; state.testPlan = null; if (state.view === 'new') renderKeepFocus(); return; }
  state.testPlan = plan;
  const el = document.getElementById('test-plan'); if (el) el.innerHTML = testPlanHTML(plan, state.form.test.routes);
}
async function refreshAdminFlag() {
  try { const s = E && E.admin ? await E.admin.status() : null; state.adminUnlocked = !!(s && s.unlocked); } catch { state.adminUnlocked = false; }
  if (!state.adminUnlocked) { state.form.test.on = false; state.testPlan = null; state.testConfirm = false; }
}

// Build the analysis verdict from the probe's STRUCTURED data, localised in the
// current language — the engine never sends display text, so no language leaks.
function fieldLabels(keys) { return (keys && keys.length) ? keys.map((k) => t('field.' + k)).join(', ') : t('probe.none'); }
function probeVerdict(o) {
  const bp = o.best_path;
  let headline;
  if (bp === 'video-list' || bp === 'video-page') {
    headline = t('probe.freeVideo', { n: o.product_count != null ? o.product_count : '?', fields: fieldLabels(o.free_fields) });
  } else if (['recipe', 'embedded', 'listing', 'fiche'].includes(bp)) {
    headline = t('probe.free', { n: o.product_count != null ? o.product_count : '?', fields: fieldLabels(o.free_fields) });
    if (o.unlock_fields && o.unlock_fields.length) headline += t('probe.unlockSuffix', { fields: fieldLabels(o.unlock_fields) });
  } else if (bp === 'unlock') {
    const count = o.known_count != null ? t('probe.protectedCount', { n: o.known_count }) : '';
    const fields = (o.free_fields && o.free_fields.length) ? o.free_fields : ['name', 'price', 'image', 'ean', 'sku'];
    headline = t('probe.protected', { count, fields: fieldLabels(fields) });
  } else if (bp === 'browser') headline = t('probe.browser');
  else if (o.diagnosis === 'unreachable') headline = t('probe.unreachable');
  else headline = t('probe.nosignal');
  // Field status, built from ONLY the non-empty groups — never a "✓ free: none"
  // next to a 9-credit unlock. An empty free set with an unlock available reads
  // "No field available without unlock", with no green tick before an empty list.
  // Each segment with its icon (system.md: shapes, never ✓ ✗ ⟳ characters): free, after a free render, assisted unlock, absent.
  const seg = []; const segIcon = [];
  const add = (icon, text) => { seg.push(text); segIcon.push(icon); };
  if (o.free_fields && o.free_fields.length) add(CI.checkC, t('probe.freeSeg', { fields: fieldLabels(o.free_fields) }));
  else if (o.unlock_fields && o.unlock_fields.length) add(CI.minusC, t('probe.noneFree'));
  // Free local-browser render: fields cost nothing, they await a render — never
  // rendered as "€ déblocage" (paid), which contradicted the "(gratuit)" headline.
  if (o.browser_fields && o.browser_fields.length) add(CI.clock, t('probe.browserSeg', { fields: fieldLabels(o.browser_fields) }));
  if (o.unlock_fields && o.unlock_fields.length) add(CI.alert, t('probe.unlockSeg', { fields: fieldLabels(o.unlock_fields) }));
  if (o.absent_fields && o.absent_fields.length) add(CI.xC, t('probe.absentSeg', { fields: fieldLabels(o.absent_fields) }));
  const fieldsLine = seg.join(' · ');
  const fieldsHtml = seg.map((s, i) => `<span class="seg-ic">${segIcon[i]}${esc(s)}</span>`).join(' · ');
  return { headline, fieldsLine, fieldsHtml };
}

// Figures strip + live product feed, shared by the standard and "your browser" runs. The feed grows with the
// page (one vertical scroll, sticky header): no inner scrolling box.
function runningBody(r) {
  const c = r.counters||{};
  const feed = (r.products||[]).slice(0,60).map((pr)=>`<tr><td><div class="prod-cell"><div class="thumb ${pr.image?'':'none'}">${pr.image?I.image:''}</div><div class="prod-name">${esc(pr.name)}</div></div></td><td class="r t-strong">${price(pr.price)}</td><td>${statusPill(pr.status)}</td></tr>`).join('');
  return `<div class="kpis">
      ${kpi(I.list, 'neutral', t('running.tDetected'), c.detected)}${kpi(CI.checkC, 'ok', t('running.tAccepted'), c.accepted)}${kpi(CI.alert, 'warn', t('running.tToVerify'), c.toVerify)}${kpi(CI.minusC, 'neutral', t('running.tExcluded'), c.excluded)}</div>
    <div class="card"><div class="card-head"><h2 class="h2">${esc(t('running.feedTitle'))} <span class="aside">${esc(t('running.feedLive'))}</span></h2></div>
      <table class="tbl tbl-fixed"><thead><tr><th>${esc(t('running.colProduct'))}</th><th class="r" style="width:120px;">${esc(t('running.colPrice'))}</th><th style="width:136px;">${esc(t('running.colStatus'))}</th></tr></thead>
        <tbody>${feed || `<tr><td colspan="3" class="empty-row">${esc(t('running.waitingProducts'))}</td></tr>`}</tbody></table></div>`;
}

// The run's state chip: stopping, CAPTCHA requested (an intervention waits for you), paused, running.
function runChip(r) {
  if (r.stopping) return chip('neutral', 'settled', '', t('running.stopping'), true);
  if (r.intervention) return chip('warn', 'attention', CI.hand, t('status.captcha'));
  if (r.paused) return chip('neutral', 'paused', CI.pause, t('status.paused'));
  return chip('neutral', 'settled', '', t('status.running'), true);
}
// « Arrêter… » asks first (system.md §7.4): what is kept, what happens next; focus on the safe option.
function stopConfirmOverlay(r) {
  if (!state.stopConfirm || !r) return '';
  const yb = r.mode === 'yb'; const n = (r.counters && r.counters.detected) || (r.progress && r.progress.done) || 0;
  return `<div class="overlay"><div class="modal sm" role="dialog" aria-modal="true" aria-labelledby="dlg-stop-t" aria-describedby="dlg-stop-p"><div class="modal-body">
    <h3 class="modal-t" id="dlg-stop-t">${esc(t(yb ? 'yb.stopTitle' : 'running.stopTitle'))}</h3>
    <p class="modal-p" id="dlg-stop-p">${esc(yb ? t('yb.stopDesc') : t('running.stopDesc', { n: fmt(n) }))}</p></div>
    <div class="modal-foot"><button class="btn btn-ghost push" id="stop-keep" data-keepfocus data-act="stop-keep">${esc(t('running.stopKeep'))}</button><button class="btn btn-danger" id="stop-confirm" data-keepfocus data-act="stop-confirm">${I.stop} ${esc(t(yb ? 'yb.stopConfirm' : 'running.stopConfirm'))}</button></div></div></div>`;
}

function vRunning() {
  const r = state.running; if (!r) return vDashboard();
  if (r.mode === 'yb') return ybRunningTopHTML(r, I) + runningBody(r) + stopConfirmOverlay(r);
  const p = r.progress||{done:0,total:0}; const pct = p.total?Math.round((p.done/p.total)*100):0;
  const indeterminate = !p.total;
  const count = indeterminate ? (r.stepFound!=null ? esc(t('running.foundN',{n:fmt(r.stepFound)})) : esc(t('running.working'))) : `<b>${fmt(p.done)}</b> / ${fmt(p.total)} · ${pct}%`;
  const step = (r.message || (r.phase==='discovering'?t('running.discovering'):(r.phase==='unlock'?t(r.stage==='extracting'?'running.unlockExtract':'running.unlockRender'):t('running.extracting'))))+((!r.message&&r.discovered)?(' · '+t('running.discovered',{n:fmt(r.discovered.total)})):'');
  const known = r.profile&&r.profile.known ? `<div class="prog-note">${I.check}<span>${esc(r.profile.needsUnlock?t('running.knownSiteUnlock'):t('running.knownSite',{n:fmt(r.profile.lastProductCount||0),method:r.profile.method||'—'}))}</span></div>` : '';
  // Pause is the main action while running; « Reprendre » becomes the primary button once paused.
  const pauseBtn = `<button class="btn ${r.paused ? 'btn-primary' : 'btn-ghost'}" id="run-pause" data-keepfocus data-act="pause"${r.stopping?' aria-disabled="true"':''}>${r.paused?I.play:I.pause} ${esc(r.paused?t('common.resume'):t('common.pause'))}</button>`;
  const stopBtn = `<button class="btn btn-danger" id="run-stop" data-keepfocus data-act="stop"${r.stopping?' aria-disabled="true"':''}>${I.stop} ${esc(r.stopping?t('running.stopShort'):t('running.stopAsk'))}</button>`;
  return `${r.intervention ? interventionOverlay(r.intervention) : ''}${stopConfirmOverlay(r)}
    <div class="page-head"><div><h1 class="h1">${esc(t('running.title'))}</h1><p class="sub">${esc(r.source||'')}</p></div>
      <div class="btn-row">${pauseBtn}${stopBtn}</div></div>
    ${progressCardHTML(r, { count, step, chipHTML: runChip(r), paused: r.paused && !r.stopping, extra: known })}
    ${runningBody(r)}`;
}

function interventionOverlay(iv) {
  return `<div class="overlay"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="dlg-iv-t"><div class="modal-body">
    <div class="modal-top"><div class="modal-icn warn">${I.shield}</div><span class="chip-note accent">${I.browser} ${esc(t('intervention.mode'))}</span></div>
    <h3 class="modal-t" id="dlg-iv-t">${esc(t('intervention.title'))}</h3><p class="modal-p">${t('intervention.desc')}</p>
    <div class="chflow"><span class="chstep done"><span class="cn">${I.check}</span> ${esc(t('intervention.stepDetect'))}</span><span class="chsep done"></span><span class="chstep cur"><span class="cn">${I.browser}</span> ${esc(t('intervention.stepAction'))}</span><span class="chsep"></span><span class="chstep"><span class="cn">3</span> ${esc(t('intervention.stepResume'))}</span></div>
    <div class="kv"><div class="kv-row"><span class="kv-k">${esc(t('intervention.type'))}</span><span class="kv-v">${chip('warn', 'attention', CI.hand, tc('challenge', iv.code, iv.code||''))}</span></div>
      <div class="kv-row"><span class="kv-k">${esc(t('intervention.address'))}</span><span class="kv-v mono">${esc(iv.url||'')}</span></div>
      <div class="kv-row"><span class="kv-k">${esc(t('intervention.reason'))}</span><span class="kv-v soft">${esc(iv.reason||'')}</span></div></div>
    <div class="noteline">${I.shield} ${esc(t('intervention.note'))}</div></div>
    <div class="modal-foot"><button class="btn btn-primary" data-act="iv-continue">${I.check} ${esc(t('intervention.continue'))}</button><button class="btn btn-danger push" data-act="iv-skip">${esc(t('intervention.skip'))}</button></div>
  </div></div>`;
}

/* ---------------- click-to-learn (teach) ---------------- */
// What the single click actually learned, phrased for the confirmation. Both
// recipes come from one gesture; the copy reflects which side validated.
function teachScopeMsg(learned) {
  if (!learned) return t('teach.doneScope');
  if (learned.linkFilter && learned.manualSelectors) return t('teach.doneScope');
  if (learned.linkFilter) return t('teach.doneLinks');
  return t('teach.doneFields');
}
// A specific, actionable message per failure — never a bare error (fail-safe
// principle: we saved nothing, so guide the user to the click that would work).
function teachFailMsg(reason) {
  if (reason === 'no_recipe') return t('teach.failNoRecipe');
  if (reason === 'timeout') return t('teach.failTimeout');
  if (reason === 'no_browser') return t('teach.failNoBrowser');
  return t('teach.failGeneric');
}
function teachOverlay(tc) {
  if (!tc) return '';
  if (tc.phase === 'done') {
    return `<div class="overlay"><div class="modal"><div class="modal-body">
      <div class="modal-icn ok">${I.checkC}</div>
      <h3 class="modal-t"><span class="title-ic">${CI.checkC}</span>${esc(t('teach.doneTitle'))}</h3>
      <p class="modal-p">${esc(tc.recognized ? t('teach.doneCount', { n: fmt(tc.recognized) }) : t('teach.doneCountNone'))}</p>
      <div class="noteline">${I.check} ${esc(teachScopeMsg(tc.learned))}</div></div>
      <div class="modal-foot"><button class="btn btn-primary" data-act="teach-start" data-url="${esc(tc.url)}">${I.play} ${esc(t('common.startScrape'))}</button><button class="btn btn-ghost push" data-act="teach-close">${esc(t('teach.done'))}</button></div>
    </div></div>`;
  }
  if (tc.phase === 'fail') {
    return `<div class="overlay"><div class="modal"><div class="modal-body">
      <div class="modal-icn warn">${I.alert}</div>
      <h3 class="modal-t">${esc(t('teach.failTitle'))}</h3>
      <p class="modal-p">${esc(teachFailMsg(tc.reason))}</p></div>
      <div class="modal-foot"><button class="btn btn-primary" data-act="teach" data-url="${esc(tc.url)}">${I.refr} ${esc(t('teach.retry'))}</button><button class="btn btn-ghost push" data-act="teach-close">${esc(t('common.close'))}</button></div>
    </div></div>`;
  }
  // waiting — a headful window is open; the user clicks a product in it.
  return `<div class="overlay"><div class="modal"><div class="modal-body">
    <div class="modal-top"><div class="modal-icn info">${I.browser}</div><span class="chip-note accent">${I.search} ${esc(t('teach.badge'))}</span></div>
    <h3 class="modal-t">${esc(t('teach.waitTitle'))}</h3><p class="modal-p">${t('teach.waitDesc')}</p>
    <div class="kv"><div class="kv-row"><span class="kv-k">${esc(t('intervention.address'))}</span><span class="kv-v mono">${esc(tc.url || '')}</span></div></div>
    <div class="noteline">${I.shield} ${esc(t('teach.waitNote'))}</div>
    <div class="noteline" role="status">${CI.clock}${esc(t('teach.waiting'))}</div></div>
    <div class="modal-foot"><button class="btn btn-ghost push" data-act="teach-cancel">${esc(t('teach.cancel'))}</button></div>
  </div></div>`;
}
// The teach overlay lives in a PORTAL, not a view template: the Analyze verdict
// is ephemeral DOM (injected into #probe-out), so a full render() would wipe it.
// Direct DOM keeps the verdict card intact behind the modal.
function paintTeach() {
  let portal = document.getElementById('teach-portal');
  if (!state.teach) { if (portal) portal.remove(); return; }
  if (!portal) { portal = document.createElement('div'); portal.id = 'teach-portal'; document.getElementById('app').appendChild(portal); }
  portal.innerHTML = teachOverlay(state.teach);
}

const CTX_TYPE = { collection:'Page de collection détectée', product:'Fiche produit détectée', search:'Page de recherche détectée', home:'Page d’accueil détectée', unknown:'Page détectée' };
const CTX_LANG = { fr:'français', nl:'néerlandais', en:'anglais', de:'allemand', es:'espagnol', it:'italien', pt:'portugais' };
const CTX_COUNTRY = { BE:'Belgique', FR:'France', NL:'Pays-Bas', DE:'Allemagne', ES:'Espagne', IT:'Italie', US:'États-Unis', GB:'Royaume-Uni', CA:'Canada', LU:'Luxembourg' };
function ctxLine(ctx) {
  if (!ctx || !ctx.pageType) return '';
  const parts = [CTX_TYPE[ctx.pageType] || 'Page détectée'];
  if (ctx.host) parts.push(ctx.host);
  if (ctx.language) parts.push(CTX_LANG[ctx.language] || ctx.language);
  if (ctx.country) parts.push(CTX_COUNTRY[ctx.country] || ctx.country);
  const warn = ctx.languageWarning ? `<div class="noteline center warn">${esc(ctx.languageWarning)}${ctx.availableLanguages && ctx.availableLanguages.length ? ' (' + esc(ctx.availableLanguages.join(', ')) + ')' : ''}</div>` : '';
  return `<div class="noteline center">${I.check || ''} ${esc(parts.join(' · '))}</div>${warn}`;
}
function offerBlock(d) {
  const o = d.unlockOffer; if (!o || !o.estimate || !o.estimate.ok) return '';
  return `<div class="banner banner-amber gap-top"><div class="bic">${I.alert}</div><div>`
    + `<div class="banner-t">Ce site est protégé — déblocage assisté disponible</div>`
    + `<div class="banner-d">${esc(o.estimate.message)}</div>`
    + `<div class="banner-act"><button class="btn btn-primary btn-sm" data-act="unlock-cascade" data-url="${esc(o.url)}">${I.browser} Débloquer (≈ ${esc(String(o.estimate.total))} crédits${esc(eur(o.estimate.total))})</button></div>`
    + `</div></div>`;
}
// Friendly label for the extraction/discovery strategy the run used (from the
// done event's `method`). Proper nouns stay as-is; the rest is localized.
function methodLabel(m) {
  if (!m) return '';
  if (m === 'platform-shopify') return 'Shopify';
  if (m === 'platform-woocommerce') return 'WooCommerce';
  if (m === 'internal-api') return t('complete.mApi');
  if (m === 'dom-selectors') return t('complete.mSelectors');
  // Paid routes are never named to the user: the direct lanes (firecrawl /
  // web-unlocker / scraping-browser) read like the cascade — "assisted unlock".
  if (m === 'unlock' || m.indexOf('cascade:') === 0 || m === 'firecrawl' || m === 'web-unlocker' || m === 'scraping-browser') return t('complete.mUnlock');
  if (m === 'your-browser') return t('complete.mYourBrowser');
  if (/sitemap/.test(m)) return t('complete.mSitemap');
  return t('complete.mPages'); // never a raw method id on screen (crawl, json_ld, embedded_state…)
}
// Admin-only "Passé par" line (route chain, credits, estimated cost) — built from
// the job's usage-ledger lines. Absent when the admin is locked: an ordinary user
// sees exactly the same completion screen as before.
function passeParHTML(d) {
  const lr = state.lastRoutes;
  if (!state.adminUnlocked || !d || !d.jobId || !lr || lr.jobId !== d.jobId) return '';
  const p = passeParLine(lr.events, { unlocked: state.adminUnlocked });
  if (!p) return '';
  return `<div class="noteline center accent wrap">${I.lock} <span>${esc(p.text)}</span>${p.testMode ? ' <span class="chip-note">mode test</span>' : ''}${p.blocked.length ? `<span class="t-mut" style="width:100%;">Voies bloquées : ${esc(p.blocked.join(' · '))}</span>` : ''} <a data-act="admin-job" data-job="${esc(d.jobId)}">Détail dans Administration</a></div>`;
}
async function loadRoutes(jobId) {
  state.lastRoutes = null;
  if (!jobId || !E || !E.usage) return;
  await refreshAdminFlag();
  if (!state.adminUnlocked) return;
  try { const r = await E.usage.jobRoutes(jobId); if (r && r.ok) state.lastRoutes = { jobId, events: r.events || [] }; } catch { /* admin extra only */ }
}

// Listing pagination + product-page completion, for every user (no provider, no
// cost): pages read, the site's announced total, and a clear warning when the
// whole list could not be read.
function listingInfoHTML(d) {
  const p = d && d.pagination; const dp = d && d.detailPages; const out = [];
  const line = (txt, warn) => `<div class="noteline center${warn ? ' warn' : ''}">${warn ? I.alert : I.info} <span>${esc(txt)}</span></div>`;
  if (d && d.listingBlocked) out.push(line(t('complete.listingBlocked'), true));
  if (p && p.mechanism === 'browser-scroll') out.push(line(p.totalAnnounced != null ? t('complete.scrolledTotal', { total: fmt(p.totalAnnounced) }) : t('complete.scrolled')));
  else if (p && p.pages > 1 || (p && p.totalAnnounced != null)) out.push(line(p.totalAnnounced != null ? t('complete.pagesTotal', { n: fmt(p.pages), total: fmt(p.totalAnnounced) }) : t('complete.pages', { n: fmt(p.pages) })));
  if (p && Array.isArray(p.warnings)) {
    const got = (d.counts && d.counts.detected) || 0;
    if (p.warnings.includes('total_not_reached') && p.totalAnnounced != null) out.push(line(t('complete.warnTotal', { total: fmt(p.totalAnnounced), n: fmt(got) }), true));
    if (p.warnings.includes('scroll_not_followable')) out.push(line(t('complete.warnScroll'), true));
  }
  if (p && p.stoppedBy === 'max_pages') out.push(line(t('complete.warnMaxPages', { n: fmt(p.pages) }), true));
  if (dp && dp.visited > 0) {
    if (dp.completed > 0) out.push(line(t('complete.detail', { done: fmt(dp.completed), visited: fmt(dp.visited) })));
    if (dp.failed > 0) out.push(line(t('complete.detailFailed', { n: fmt(dp.failed) }), true));
    if (dp.stoppedEarly === 'sample_no_data') out.push(line(t('complete.detailSample')));
  }
  if (d && d.pagesViaBrowser > 0) out.push(line(t('complete.viaBrowser', { n: fmt(d.pagesViaBrowser) })));
  if (d && d.browserPagesStop === 'human_check') out.push(line(t('complete.viaBrowserCheck', { n: fmt(d.pagesViaBrowser || 0) }), true));
  const sd = d && d.sideData;
  if (sd && sd.availabilityRows > 0) out.push(line(t('complete.stock', { n: fmt(sd.availabilityRows) })));
  if (sd && sd.ratingRows > 0) out.push(line(t('complete.reviews', { n: fmt(sd.ratingRows) })));
  const ct = d && d.categoryTrail;
  if (ct && ct.products > 0 && Array.isArray(ct.trail) && ct.trail.length) out.push(line(t('complete.trail', { trail: ct.trail.join(' > ') })));
  return out.join('');
}

function vComplete() {
  const d = state.lastResult; if (!d) return vDashboard(); const c = d.counts||{};
  const yb = d.method === 'your-browser'; // run in the user's own browser (extension)
  const failed = yb && d.status === 'error';
  const empty = yb && d.status === 'stopped:no_products';
  const title = d.stalled ? t('complete.stalled') : d.stoppedByUser ? t('complete.stopped') : d.blocked ? t('complete.blocked') : failed ? t('complete.failed') : empty ? t('complete.empty') : t('complete.done');
  const warn = d.stalled || d.blocked || d.stoppedByUser || failed || empty;
  const total = (c.accepted||0)+(c.toVerify||0)+(c.excluded||0);
  const video = !!(d.contentType && d.contentType.type === 'video');
  const sub = video
    ? (d.durationMs ? t('complete.processedVideosIn',{n:fmt(total),s:Math.round(d.durationMs/1000)}) : t('complete.processedVideos',{n:fmt(total)}))
    : (d.durationMs ? t('complete.processedIn',{n:fmt(total),s:Math.round(d.durationMs/1000)}) : t('complete.processed',{n:fmt(total)}));
    return `<div class="centerwrap"><div class="success">
    <div class="succ-icn${warn?' warn':''}">${warn?I.alert:I.checkC}</div>
    <h1 class="h1">${esc(title)}</h1><p class="sub">${esc(sub)}</p>
    ${ctxLine(d.context)}
    ${d.stalled ? `<div class="noteline center warn">${I.info} ${esc(t('complete.stalledHelp', { s: Math.round((d.stallMs || 120000) / 1000) }))}</div>` : ''}
    ${d.method && !d.stoppedByUser ? `<div class="noteline center">${yb ? I.browser : I.bolt} ${esc(t('complete.method',{m:methodLabel(d.method)}))}</div>` : ''}
    ${video ? `<div class="noteline center">${I.info} ${esc(t(d.contentType.requested === 'auto' ? 'complete.contentVideosAuto' : 'complete.contentVideos'))}</div>` : ''}
    ${yb && d.reason ? `<div class="noteline center warn">${I.info} ${esc(d.reason)}</div>` : ''}
    ${listingInfoHTML(d)}
    ${passeParHTML(d)}
    ${offerBlock(d)}
    <div class="kpis">
      ${kpi(CI.checkC,'ok',t('complete.accepted'),c.accepted)}${kpi(CI.alert,'warn',t('complete.toVerify'),c.toVerify)}${kpi(CI.minusC,'neutral',t('complete.excluded'),c.excluded)}${kpi(I.list,'neutral',t('complete.detected'),c.detected)}</div>
    ${d.remaining?`<div class="banner banner-amber gap-top"><div class="bic">${I.alert}</div><div><div class="banner-t">${esc(t('complete.remainingTitle',{n:fmt(d.remaining)}))}</div><div class="banner-d">${esc(t('complete.remainingDesc'))}</div></div></div>`:''}
    <div class="btn-row">
      <button class="btn btn-primary btn-lg" data-act="open-csv" data-path="${esc(d.csvPath)}">${I.dl} ${esc(t('common.openCsv'))}</button>
      <button class="btn btn-ghost btn-lg" data-act="view-results" data-job="${esc(d.jobId)}">${I.grid} ${esc(t('common.viewResults'))}</button>
      <button class="btn btn-ghost btn-lg" data-act="open-report" data-path="${esc(d.reportPath)}">${I.doc} ${esc(t('common.openReport'))}</button></div>
    <div class="noteline center">${I.folder} ${esc(d.csvPath||'')}</div></div></div>`;
}

function vJobs() {
  const overlay = (state.resumePrompt ? resumeOverlay(state.resumePrompt) : '') + (state.reportView ? reportOverlay(state.reportView) : '');
  if (!state.jobs.length) return overlay + `<div class="page-head"><div><h1 class="h1">${esc(t('jobs.title'))}</h1><p class="sub">${esc(t('jobs.sub'))}</p></div><button class="btn btn-primary" data-nav="new">${I.plus} ${esc(t('common.newScrape'))}</button></div>
    <div class="card"><div class="empty"><div class="empty-ill">${I.inbox}</div><h2 class="empty-t">${esc(t('jobs.emptyTitle'))}</h2><p class="empty-d">${esc(t('jobs.emptyDesc'))}</p><button class="btn btn-primary btn-lg" data-nav="new">${I.play} ${esc(t('jobs.startFirst'))}</button></div></div>`;
  const rows = state.jobs.map((j) => {
    // A FINISHED job is 100% done. The processed/discovered ratio is a CRAWL cursor,
    // meaningless once done (internal-api jobs record no discovered URLs → showed 0%).
    const pct = j.status === 'done' ? 100 : (j.discovered ? Math.round((j.processed / j.discovered) * 100) : 0);
    // Distinguishable label: the explicit store/label, else the domain (auto-filled).
    const label = j.store || regDomain(j.source) || '—';
    // A run done in the user's own browser is not resumable by the engine (the
    // extension holds no engine cursor) — it only offers its results + report.
    const ybJob = j.via === 'your-browser';
    const resumable = !ybJob && (['interrupted','paused','created'].includes(j.status) || String(j.status).startsWith('stopped'));
    const noProducts = (j.products||0) === 0;
    const act = resumable
      ? `<button class="btn btn-ghost btn-sm" data-act="resume-prompt" data-job="${esc(j.id)}">${I.play} ${esc(t('jobs.resume'))}</button>`
      : (!ybJob && noProducts && j.isUrl
        ? `<button class="btn btn-ghost btn-sm" data-act="rerun-browser" data-url="${esc(j.source)}" title="${esc(t('probe.action.browser'))}">${I.browser} ${esc(t('jobs.rerunBrowser'))}</button>`
        : `<button class="btn btn-ghost btn-sm" data-act="view-results" data-job="${esc(j.id)}">${I.grid} ${esc(t('jobs.results'))}</button>`);
    const rapport = `<button class="btn btn-ghost btn-sm btn-icon" data-act="view-report" data-job="${esc(j.id)}" aria-label="${esc(t('jobs.reportTitle'))}" title="${esc(t('jobs.reportTitle'))}">${I.doc}</button>`
      // Admin only: the job's route chain + technical report in Administration › Utilisation.
      + (state.adminUnlocked ? `<button class="btn btn-ghost btn-sm btn-icon" data-act="admin-job" data-job="${esc(j.id)}" aria-label="Voies utilisées, crédits et coût estimé (administration)" title="Voies utilisées, crédits et coût estimé (administration)">${I.lock}</button>` : '');
    const reason = j.reason ? esc(j.reason) : '';
    return `<tr><td><div class="src-cell"><div class="favi">${I.store}</div><span class="src-url t-strong" title="${esc(j.source)}"><span class="ellip">${esc(shortUrl(j.source))}</span>${ybJob ? ` <span class="chip-note">${I.browser} ${esc(t('yb.badge'))}</span>` : ''}${j.contentType === 'video' ? ` <span class="chip-note">${esc(t('jobs.videos'))}</span>` : ''}</span></div></td><td class="t-mut col-label"><span class="ellip" title="${esc(label)}">${esc(label)}</span></td><td class="t-mut col-date num">${esc(fmtWhen(j.createdAt))}</td><td${reason?` title="${reason}"`:''}>${jobPill(j.status)}</td><td class="col-prog"><div class="prog-cell"><div class="bar-sm"><span style="width:${pct}%"></span></div><span class="pc">${pct}%</span></div></td><td class="r t-strong">${fmt(j.products)}</td><td><div class="rowacts">${act}${rapport}</div></td></tr>`;
  }).join('');
  return overlay + `<div class="page-head"><div><h1 class="h1">${esc(t('jobs.title'))}</h1><p class="sub">${esc(t('jobs.sub'))}</p></div><button class="btn btn-primary" data-nav="new">${I.plus} ${esc(t('common.newScrape'))}</button></div>
    <div class="card"><table class="tbl tbl-fixed"><thead><tr><th>${esc(t('jobs.colSource'))}</th><th class="col-label" style="width:14%;">${esc(t('jobs.colLabel'))}</th><th class="col-date" style="width:136px;">${esc(t('jobs.colStarted'))}</th><th style="width:164px;">${esc(t('jobs.colStatus'))}</th><th class="col-prog" style="width:124px;">${esc(t('jobs.colProgress'))}</th><th class="r" style="width:88px;">${esc(t('jobs.colProducts'))}</th><th class="r" style="width:${state.adminUnlocked ? 252 : 220}px;">${esc(t('jobs.colActions'))}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function reportOverlay(rv) {
  const body = rv.text
    ? `<pre class="pre">${esc(rv.text)}</pre>`
    : `<p class="modal-p">${esc(t('jobs.reportMissing'))}</p>`;
  return `<div class="overlay"><div class="modal wide" role="dialog" aria-modal="true" aria-labelledby="dlg-rep-t"><div class="modal-body">
    <h3 class="modal-t" id="dlg-rep-t">${esc(t('jobs.reportTitle'))}</h3>
    ${body}
    </div><div class="modal-foot">${rv.reportPath ? `<button class="btn btn-ghost" data-act="open-report" data-path="${esc(rv.reportPath)}">${I.ext} ${esc(t('jobs.reportOpenFile'))}</button>` : ''}<button class="btn btn-ghost push" data-act="report-close">${esc(t('common.close'))}</button></div></div></div>`;
}

function resumeOverlay(j) {
  const pct = j.discovered?Math.round((j.processed/j.discovered)*100):0; const remaining = Math.max(0,(j.discovered||0)-(j.processed||0));
  return `<div class="overlay"><div class="modal"><div class="modal-body">
    <div class="modal-icn info">${I.refr}</div>
    <h3 class="modal-t">${esc(t('jobs.resumeTitle'))}</h3><p class="modal-p">${esc(t('jobs.resumeDesc'))}</p>
    <div class="resume-box">
      <div class="resume-head"><div class="favi">${I.store}</div><div><div class="t-strong">${esc(j.source)}</div><div class="t-mut">${esc(j.store||'—')} · ${esc(fmtWhen(j.updatedAt||j.createdAt))}</div></div></div>
      <div class="row-split"><span class="t-mut">${esc(t('jobs.resumeProcessed'))}</span><span class="prog-count"><b>${fmt(j.processed)}</b> / ${fmt(j.discovered)} · ${pct}%</span></div>
      <div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>
      <div class="t-mut">${esc(t('jobs.resumeRemaining',{n:fmt(remaining)}))}</div></div>
    <div class="noteline">${I.info} ${esc(t('jobs.resumeNote'))}</div></div>
    <div class="modal-foot"><button class="btn btn-primary" data-act="resume-go" data-job="${esc(j.id)}">${I.play} ${esc(t('jobs.resumeGo'))}</button><button class="btn btn-ghost push" data-act="resume-cancel">${esc(t('common.cancel'))}</button></div>
  </div></div>`;
}

function vResults() {
  const R = state.results; const overlay = state.detail ? detailOverlay(state.detail) : '';
  if (!R) {
    // No job picked yet: offer the latest jobs right here instead of sending the
    // user to another screen to pick one.
    const recent = (state.jobs || []).filter((j) => (j.products || 0) > 0).slice(0, 8);
    if (recent.length) {
      const list = recent.map((j) => `<div class="mini"><div class="favi">${I.store}</div><div class="mini-main"><div class="mini-t">${esc(j.store || regDomain(j.source) || j.source)}</div><div class="mini-s">${esc(fmtWhen(j.createdAt))} · ${fmt(j.products)} ${esc(t('results.pickProducts'))}</div></div><button class="btn btn-ghost btn-sm" data-act="view-results" data-job="${esc(j.id)}">${I.grid} ${esc(t('jobs.results'))}</button></div>`).join('');
      return `<div class="page-head"><div><h1 class="h1">${esc(t('results.title'))}</h1><p class="sub">${esc(t('results.pickDesc'))}</p></div></div><div class="card"><div class="card-list">${list}</div></div>`;
    }
    return `<div class="page-head"><div><h1 class="h1">${esc(t('results.title'))}</h1><p class="sub">${esc(t('results.emptyDesc'))}</p></div></div><div class="card"><div class="empty"><div class="empty-ill">${I.grid}</div><h2 class="empty-t">${esc(t('results.emptyTitle'))}</h2><p class="empty-d">${esc(t('results.emptyDesc'))}</p><button class="btn btn-primary" data-nav="jobs">${esc(t('results.gotoJobs'))}</button></div></div>`;
  }
  const all = R.products||[];
  const counts = { all:all.length, accepted:all.filter(p=>p.status==='accepted').length, to_verify:all.filter(p=>p.status==='to_verify').length, excluded:all.filter(p=>p.status==='excluded').length };
  const shown = R.filter && R.filter!=='all' ? all.filter(p=>p.status===R.filter) : all;
  const verify = R.filter === 'to_verify';
  const video = R.contentType === 'video'; // a video job: the "Vidéo" column, the duration in place of the price
  const rows = shown.slice(0,400).map((p)=>{
    const rt = reasonText(p);
    const decision = verify ? `<td class="c"><div class="rowacts center"><button class="btn btn-ghost btn-sm btn-ok" data-act="override" data-key="${esc(p.key)}" data-status="accepted">${I.check} ${esc(t('common.accept'))}</button><button class="btn btn-ghost btn-sm" data-act="override" data-key="${esc(p.key)}" data-status="excluded">${esc(t('common.exclude'))}</button></div></td>` : '';
    return `<tr><td><div class="prod-cell"><div class="thumb ${p.image_url?'':'none'}">${p.image_url?`<img src="${esc(p.image_url)}">`:''}</div><div><a class="prod-name" data-act="detail" data-key="${esc(p.key)}">${esc(p.name)}</a><div class="prod-meta"><span>${esc(video ? (p.source_category||'—') : (p.product_type||p.source_category||'—'))}</span>${p.barcode?`<span class="mono">${esc(p.barcode)}</span>`:''}</div></div></div></td>
      <td class="r t-strong">${video ? esc(p.duration||'—') : price(p.price, p.currency)}</td><td class="t-mut"><span class="ellip" title="${esc(rt)}">${esc(rt)}</span></td><td class="c">${statusPill(p.status)}</td>${decision}</tr>`;
  }).join('');
  const seg = (k,l) => `<button type="button" class="${R.filter===k?'on':''}" aria-pressed="${R.filter===k}" data-filter="${k}">${esc(l)} <span class="c">${fmt(counts[k])}</span></button>`;
  const head = verify
    ? `<div><h1 class="h1">${esc(t('results.verifyTitle'))} ${chip('warn', 'attention', CI.alert, fmt(counts.to_verify))}</h1><p class="sub">${esc(t('results.verifySub'))}</p></div>`
    : `<div><h1 class="h1">${esc(t('results.title'))}</h1><p class="sub">${esc(video ? t('results.subVideos') : t('results.sub'))}</p></div>`;
  return `${overlay}<div class="crumb"><a data-nav="jobs" href="#">${esc(t('nav.jobs'))}</a>${I.chevR}<span class="cur">${esc(verify?t('results.verifyTitle'):t('results.title'))}</span></div>
    <div class="page-head">${head}${R.csvPath?`<button class="btn btn-primary" data-act="open-csv" data-path="${esc(R.csvPath)}">${I.dl} ${esc(t('results.exportCsv'))}</button>`:''}</div>
    <div class="toolbar"><div class="seg" role="group" aria-label="${esc(t('results.colStatus'))}">${seg('all',t('results.all'))}${seg('accepted',t('results.accepted'))}${seg('to_verify',t('results.toVerify'))}${seg('excluded',t('results.excluded'))}</div></div>
    <div class="card"><table class="tbl tbl-fixed"><thead><tr><th>${esc(video ? t('results.colVideo') : t('results.colProduct'))}</th><th class="r" style="width:110px;">${esc(video ? t('results.colDuration') : t('results.colPrice'))}</th><th style="width:28%;">${esc(t('results.colReason'))}</th><th class="c" style="width:120px;">${esc(t('results.colStatus'))}</th>${verify?`<th class="c" style="width:210px;">${esc(t('results.colDecision'))}</th>`:''}</tr></thead>
      <tbody>${rows||`<tr><td colspan="5" class="empty-row">${esc(verify?t('results.verifyEmpty'):t('results.noForFilter'))}</td></tr>`}</tbody></table></div>`;
}

/** schema.org stock term → label; any other statement is shown as the site wrote it. */
const availabilityLabel = (a) => (a ? tc('product', 'av' + String(a).replace(/^.*[/#]/, ''), String(a)) : '');
/** Brand, stock, rating, options (with their own price and stock) and technical specs, grouped. */
function detailExtras(p, row) {
  const rating = p.rating != null ? t(p.review_count != null ? 'product.ratingOf' : 'product.ratingOnly', { r: String(p.rating).replace('.', ','), n: fmt(p.review_count) }) : '';
  let out = `${row(t('product.brand'), p.brand)}${row(t('product.availability'), availabilityLabel(p.availability))}${row(t('product.rating'), rating)}`;
  if (p.variants && p.variants.length) {
    out += `<h2 class="h3">${esc(t('product.variants'))}</h2>`;
    out += p.variants.map((v) => row(v.name, [v.price != null ? price(v.price, p.currency) : '', availabilityLabel(v.availability)].filter(Boolean).join(' · ') || '—')).join('');
  }
  if (p.specs && p.specs.length) {
    const groups = new Map();
    for (const s of p.specs) { const g = s.group || ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(s); }
    out += `<h2 class="h3">${esc(t('product.specs'))}</h2>`;
    for (const [g, list] of groups) {
      out += `<div class="t-strong gap-top">${esc(g || t('product.specsOther'))}</div>`;
      out += list.map((s) => row(s.name, s.value)).join('');
    }
  }
  return out;
}

function detailOverlay(p) {
  const row = (k,v) => v==null||v===''?'':`<div class="drow"><span>${esc(k)}</span><span>${esc(v)}</span></div>`;
  const rt = reasonText(p);
  return `<div class="overlay"><div class="modal detail" role="dialog" aria-modal="true" aria-labelledby="dlg-prod-t"><div class="modal-body">
    <div class="modal-top"><h3 class="modal-t" id="dlg-prod-t">${esc(p.name)}</h3>${statusPill(p.status)}</div>
    <div class="detail-top">
      <div class="thumb lg ${p.image_url?'':'none'}">${p.image_url?`<img src="${esc(p.image_url)}">`:I.image}</div>
      <div class="grow-min">${p.status!=='accepted'&&rt?`<div class="banner banner-amber"><div class="bic">${I.alert}</div><div><div class="banner-t">${esc(t('results.colReason'))}</div><div class="banner-d">${esc(rt)}</div></div></div>`:`<div class="noteline">${I.checkC} ${esc(tc('eligReason',p.code,t('elig.accepted')))}</div>`}
        ${p.source_url?`<button class="btn btn-ghost btn-sm gap-top" data-act="open-source" data-url="${esc(p.source_url)}">${I.ext} ${esc(t('product.openSource'))}</button>`:''}</div></div>
    <h2 class="h3">${esc(t('product.fields'))}</h2>
${p.duration ? row(t('product.duration'),p.duration) : row(t('product.price'),price(p.price, p.currency))}${row(t('product.weight'),p.weight_kg!=null?p.weight_kg+' kg'+(p.weight_estimated?' ('+t('product.estimated')+')':''):'')}${row(t('product.netContent'),p.net_content)}${row(t('product.barcode'),p.barcode)}${row(t('product.type'),p.product_type)}${row(t('product.category'),p.category_slug||p.source_category)}${row(t('product.storage'),p.storage_info)}${row(t('product.alcohol'),p.is_alcoholic?t('product.yes'):t('product.no'))}${row(t('product.sourceId'),p.source_product_id)}${row(t('product.description'),p.description)}${row(t('product.views'),p.views)}${row(t('product.published'),p.published_at)}${row(t('product.embed'),p.embed_url)}
    ${detailExtras(p, row)}
    </div><div class="modal-foot"><button class="btn btn-ghost push" data-act="detail-close">${esc(t('common.close'))}</button></div></div></div>`;
}

function vSources() {
  const overlay = (state.sourceEdit ? sourceEditOverlay(state.sourceEdit) : '') + (state.srcDelete != null && state.sources[state.srcDelete] ? sourceDeleteOverlay(state.sources[state.srcDelete], state.srcDelete) : '');
  const S = state.sources||[];
  if (!S.length) return overlay + `<div class="page-head"><div><h1 class="h1">${esc(t('sources.title'))}</h1><p class="sub">${esc(t('sources.sub'))}</p></div><button class="btn btn-primary" data-act="src-add">${I.plus} ${esc(t('sources.add'))}</button></div>
    <div class="card"><div class="empty"><div class="empty-ill">${I.store}</div><h2 class="empty-t">${esc(t('sources.emptyTitle'))}</h2><p class="empty-d">${esc(t('sources.emptyDesc'))}</p><button class="btn btn-primary btn-lg" data-act="src-add">${I.plus} ${esc(t('sources.add'))}</button></div></div>`;
  const cards = S.map((s,i)=>`<div class="card card-pad">
    <div class="src-card-head"><div class="favi">${I.store}</div>
      <div class="grow-min"><div class="t-strong ellip">${esc(s.name)}</div><div class="t-mut mono ellip">${esc(s.url)}</div></div></div>
    <div class="src-card-meta"><span class="num">${fmt(s.products||0)} ${esc(t('sources.products'))}</span><span>${esc(t('sources.lastUsed'))}: ${s.lastUsed?esc(fmtDay(s.lastUsed)):esc(t('sources.never'))}</span></div>
    <div class="btn-row src-card-acts"><button class="btn btn-primary btn-sm" data-act="src-run" data-idx="${i}">${I.play} ${esc(t('sources.run'))}</button><button class="btn btn-ghost btn-sm" data-act="src-edit" data-idx="${i}">${esc(t('common.edit'))}</button><button class="btn btn-ghost btn-sm" data-act="src-delete" data-idx="${i}">${esc(t('common.delete'))}</button></div></div>`).join('');
  return overlay + `<div class="page-head"><div><h1 class="h1">${esc(t('sources.title'))}</h1><p class="sub">${esc(t('sources.sub'))}</p></div><button class="btn btn-primary" data-act="src-add">${I.plus} ${esc(t('sources.add'))}</button></div>
    <div class="grid3 fit">${cards}</div>`;
}

// Deleting a source asks first (destructive): the safe option has the focus, Escape cancels.
function sourceDeleteOverlay(s, i) {
  return `<div class="overlay"><div class="modal sm" role="dialog" aria-modal="true" aria-labelledby="dlg-del-t"><div class="modal-body">
    <h3 class="modal-t" id="dlg-del-t">${esc(t('sources.confirmDelete'))}</h3><p class="modal-p">${esc(s.name)} · <span class="mono">${esc(shortUrl(s.url))}</span></p></div>
    <div class="modal-foot"><button class="btn btn-ghost push" id="src-del-cancel" data-keepfocus data-act="src-delete-cancel">${esc(t('common.cancel'))}</button><button class="btn btn-danger" data-act="src-delete-confirm" data-idx="${i}">${esc(t('common.delete'))}</button></div></div></div>`;
}
function sourceEditOverlay(s) {
  return `<div class="overlay"><div class="modal"><div class="modal-body">
    <h3 class="modal-t">${esc(s._idx==null?t('sources.addTitle'):t('sources.editTitle'))}</h3>
    <div class="field gap-top"><label class="label" for="se-name">${esc(t('sources.name'))}</label><div class="control"><input id="se-name" value="${esc(s.name||'')}" placeholder="${esc(t('sources.namePh'))}"></div></div>
    <div class="field gap-top"><label class="label" for="se-url">${esc(t('sources.url'))}</label><div class="control">${I.globe}<input id="se-url" value="${esc(s.url||'')}" placeholder="${esc(t('sources.urlPh'))}"></div></div>
    <div class="grid2 gap-top">
      <div class="field"><label class="label">${esc(t('sources.ua'))}</label><div class="control">${I.browser}<input id="se-ua" value="${esc(s.ua||'')}" placeholder="${esc(t('sources.uaPh'))}"></div></div>
      <div class="field"><label class="label">${esc(t('new.type'))}</label><div class="control"><input id="se-type" value="${esc(s.productType||'')}" placeholder="${esc(t('new.typePh'))}"></div></div></div>
    </div><div class="modal-foot"><button class="btn btn-primary" data-act="src-save">${I.check} ${esc(t('sources.save'))}</button><button class="btn btn-ghost push" data-act="src-cancel">${esc(t('common.cancel'))}</button></div>
  </div></div>`;
}

function vSettings() {
  const s = state.settings||{}; const g = (k,d)=> (s[k]!=null?s[k]:d);
  const langs = availableLangs().map((l)=>`<button type="button" class="${state.lang===l?'on':''}" aria-pressed="${state.lang===l}" data-lang="${l}" lang="${l}">${esc(LANG_LABELS[l]||l)}</button>`).join('');
  // Theme (system.md §7.2): « Système » follows Windows; the choice is stored in config.json and validated in main.
  const themes = THEMES.map((th)=>`<button type="button" class="${state.theme===th?'on':''}" aria-pressed="${state.theme===th}" data-theme-set="${th}">${esc(t('settings.theme_'+th))}</button>`).join('');
  const card = (title, body, wide) => `<section class="card${wide ? ' wide' : ''}"><div class="card-head"><h2 class="h2">${esc(title)}</h2></div><div class="card-body">${body}</div></section>`;
  return `<div class="page-head"><div><h1 class="h1">${esc(t('settings.title'))}</h1><p class="sub">${esc(t('settings.sub'))}</p></div></div>
    <div class="settings-grid">
      ${card(t('settings.language'), `<div class="seg" role="group" aria-label="${esc(t('settings.language'))}">${langs}</div><p class="hint">${esc(t('settings.languageHint'))}</p>`)}
      ${card(t('settings.theme'), `<div class="seg" role="group" aria-label="${esc(t('settings.theme'))}">${themes}</div><p class="hint">${esc(t('settings.themeHint'))}</p>`)}
      ${card(t('settings.network'), `<div class="grid2">${numField('s-timeout',t('settings.timeout'),g('timeoutMs',20000))}${numField('s-retries',t('settings.retries'),g('retries',2))}${numField('s-rate',t('settings.rate'),g('rateLimitMs',600))}${numField('s-workers',t('settings.workers'),g('workers',4))}</div><p class="hint">${esc(t('settings.defaultsNote'))}</p>`)}
      ${card(t('settings.limits'), `<div class="grid2">${numField('s-maxp',t('settings.maxProducts'),g('maxProducts',1000))}${numField('s-maxpg',t('settings.maxPages'),g('maxPages',150))}${numField('s-depth',t('settings.depth'),g('maxDepth',3))}${numField('s-maxb',t('settings.maxBrowser'),g('maxBrowser',40))}</div><p class="hint">${esc(t('settings.defaultsNote'))}</p>`)}
      ${card(t('settings.account'), `<div class="field"><label class="label" for="s-license">${esc(t('settings.licenseKey'))}</label><div class="control">${I.shield||''}<input id="s-license" class="mono" placeholder="${esc(t('settings.licensePh'))}" value="${esc(g('edgeLicense',''))}"></div></div>
        <p class="hint">${esc(t('settings.licenseHint'))}</p>`, true)}
      ${card(t('settings.recipesTitle'), `<p class="hint">${esc(t('settings.recipesHint'))}</p>
        <div class="btn-row gap-top"><button class="btn btn-ghost" data-act="recipes-export">${esc(t('settings.recipesExport'))}</button><button class="btn btn-ghost" data-act="recipes-import">${esc(t('settings.recipesImport'))}</button></div>
        ${recipesPreviewHTML()}`, true)}
      ${card(t('settings.files'), `<div class="field"><label class="label" for="s-datadir">${esc(t('settings.dataDir'))}</label><div class="control">${I.folder}<input id="s-datadir" class="mono" value="${esc(state.info.dataDir||'')}" readonly></div></div>
        <p class="hint">${esc(t('settings.dataHint',{browser:(state.info.browsersPath||'').split(/[\\/]/).slice(-1)[0]||'ms-playwright'}))}</p>`, true)}
    </div>
    <div class="btn-row form-foot"><button class="btn btn-primary" data-act="save-settings">${I.check} ${esc(t('common.save'))}</button><a class="btn btn-ghost" data-nav="protection" href="#">${I.shield} ${esc(t('settings.protectionLink'))} ${I.chevR}</a></div>`;
}

function vProtection() {
  const unlockOn = !!(state.settings && state.settings.unlock);
  const us = state.unlockStatus;
  // Capability checks: yes / no as chips with a word, never a bare symbol; « … » while the check runs.
  const pill = (v) => v == null ? chip('neutral', 'settled', '', '…', true) : (v ? chip('ok', 'settled', CI.check, t('product.yes')) : chip('neutral', 'settled', CI.minusC, t('product.no')));
  const statusRow = (label, v) => `<div class="status-row"><span>${esc(label)}</span>${pill(v)}</div>`;
  const nodriverCard = `<div class="card"><div class="card-head"><h2 class="h2" id="tg-nodriver">${esc(t('protection.nodriverTitle'))}</h2>
      ${switchBtn(unlockOn, 'data-act="toggle-unlock"', 'tg-nodriver')}</div>
    <div class="card-body">
      <p class="tog-desc gap-bottom">${esc(t('protection.nodriverDesc'))}</p>
      ${statusRow(t('protection.nodriverEnabled'), unlockOn)}${statusRow(t('protection.nodriverChrome'), us ? us.chromeFound : null)}${statusRow(t('protection.nodriverPy'), us ? us.ready : null)}
      ${us && !us.ready && us.reason ? `<p class="tog-desc">${esc(us.reason)}</p>` : ''}
      <div class="noteline">${I.info} ${esc(t('protection.nodriverNote'))}</div>
    </div></div>`;
  return `<div class="crumb"><a data-nav="settings" href="#">${esc(t('nav.settings'))}</a>${I.chevR}<span class="cur">${esc(t('protection.crumb'))}</span></div>
    <div class="page-head"><div><h1 class="h1">${esc(t('protection.title'))}</h1><p class="sub">${esc(t('protection.sub'))}</p></div></div>
    <div class="card"><div class="card-head"><h2 class="h2">${esc(t('protection.mode'))}</h2></div><div class="card-body">
      <div class="radio-row active"><div class="rdot"></div><div><div class="tog-name">${esc(t('protection.manual'))} ${chip('ok', 'settled', CI.check, t('protection.active'))}</div><div class="tog-desc">${esc(t('protection.manualDesc'))}</div></div></div>
      </div></div></div>
    <!-- Paid services (and their keys) are named only in Administration, never on this page (eloshon-scraper-ops rule 7). -->
    ${nodriverCard}
    <div class="banner banner-blue gap-top"><div class="bic">${I.info}</div><div><div class="banner-t">${esc(t('protection.bannerTitle'))}</div><div class="banner-d">${esc(t('protection.bannerDesc'))}</div></div></div>`;
}

// Administration: an empty mount point; the admin module keeps its own page
// element (so unsaved inputs survive the app's re-renders) and attaches it here.
function vAdmin() { return '<div id="admin-mount"></div>'; }

const VIEWS = { dash:vDashboard, new:vNew, running:vRunning, complete:vComplete, jobs:vJobs, results:vResults, sources:vSources, settings:vSettings, protection:vProtection, admin:vAdmin };

/* ---------------- render + wiring ---------------- */
let dirty = false;
let adminFresh = false;
function render() {
  // Live updates re-render the screen: a control marked data-keepfocus (dialog and run buttons) keeps the keyboard focus.
  const ae = document.activeElement; const keep = ae && ae.id && ae.hasAttribute && ae.hasAttribute('data-keepfocus') ? ae.id : null;
  document.getElementById('app').innerHTML = shell((VIEWS[state.view]||vDashboard)()); dirty = false;
  if (keep && state.stopConfirm !== 'new') { const k = document.getElementById(keep); if (k && k.focus) k.focus(); }
  // A dialog that just opened takes the focus on its safe option (system.md §7.3); later renders leave the focus alone.
  if (state.stopConfirm === 'new') { state.stopConfirm = true; const k = document.getElementById('stop-keep'); if (k && k.focus) k.focus(); }
  if (state.view !== 'running' || !state.running) state.stopConfirm = false;
  announceRun();
  if (state.view === 'admin') { attachAdminPage(document.getElementById('admin-mount'), { fresh: adminFresh }); adminFresh = false; }
  else detachAdminPage();
}
// Theme on <html> (system.md §7.2): color-scheme picks each light-dark() value, so « system » follows Windows.
function applyTheme() { const root = document.documentElement; if (root && root.setAttribute) root.setAttribute('data-theme', THEMES.includes(state.theme) ? state.theme : 'system'); }
// Keyboard: Escape closes the « Arrêter… » dialog; Enter or Space activates a focused radio row.
function onKeydown(e) {
  if (e.key === 'Escape' && state.stopConfirm) { state.stopConfirm = false; render(); return; }
  if (e.key === 'Escape' && state.srcDelete != null) { state.srcDelete = null; render(); return; }
  const el = e.target;
  if ((e.key === 'Enter' || e.key === ' ') && el && el.getAttribute && el.getAttribute('role') === 'radio' && el.dataset && el.dataset.act) { e.preventDefault(); onClick({ target: el }); }
}
// Long task: elapsed and remaining time refresh once a second without re-rendering the screen.
function tickRunning() {
  const r = state.running; if (state.view !== 'running' || !r) return;
  const a = document.getElementById('run-elapsed'); if (a) a.textContent = fmtDuration(runElapsed(r));
  const b = document.getElementById('run-eta'); if (b) b.textContent = etaText(r);
}
// Screen readers hear the run state when it changes (polite, at most once a second), not every counter update.
let lastAnnounce = { text: '', at: 0 };
function announceRun() {
  const live = document.getElementById('live'); const r = state.running;
  if (!live || state.view !== 'running' || !r) return;
  const word = r.mode === 'yb' ? t('yb.phase.' + (r.ybPhase || 'connecting')) : r.stopping ? t('running.stopping') : r.intervention ? t('status.captcha') : r.paused ? t('status.paused') : t('status.running');
  const now = Date.now();
  if (word === lastAnnounce.text || now - lastAnnounce.at < 1000) return;
  lastAnnounce = { text: word, at: now }; live.textContent = word;
}
function scheduleRender() { if (dirty) return; dirty = true; requestAnimationFrame(render); }
async function refreshJobs() { try { state.jobs = await E.jobs.list(); } catch { state.jobs = []; } }

// Taux €/crédit du compte. Best-effort : une panne réseau laisse simplement
// l'équivalent monétaire de côté, elle ne casse jamais l'affichage des crédits.
async function refreshCreditRate() {
  try { const s = await E.accountStatus(); state.creditRate = (s && s.rate) ?? null; }
  catch { state.creditRate = null; }
}

/** « (≈ 6,63 €) » derrière un nombre de crédits, ou rien si aucun taux connu.
 *  Garde le même contrat que core/credit-rate.mjs (eurosSuffix), vérifié par
 *  core/__tests__/credit-rate-ui.test.mjs. `credits` absent ⇒ rien : Number(null)
 *  vaut 0 et non NaN, sans ce garde une estimation manquante s'afficherait
 *  « (≈ 0,00 €) », c'est-à-dire gratuite. 0 crédit, lui, vaut bien 0,00 €. */
function eur(credits) {
  const r = state.creditRate;
  if (r == null || credits === null || credits === undefined || credits === '') return '';
  const n = Number(credits);
  if (!Number.isFinite(n)) return '';
  return ` (≈ ${new Intl.NumberFormat('fr-BE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n * r)})`;
}
async function go(view) {
  // Leaving the Administration page with unsaved edits asks first.
  if (state.view === 'admin' && view !== 'admin' && !confirmLeaveAdmin()) return;
  if (view === 'admin') adminFresh = true;
  state.view = view;
  if (state.creditRate === null) await refreshCreditRate();
  if (view==='new'||view==='jobs'||view==='complete') await refreshAdminFlag();
  if (view==='jobs'||view==='dash'||(view==='results'&&!state.results)) await refreshJobs();
  if (view==='settings') state.settings = await E.settings.get();
  if (view==='protection') {
    try { state.settings = await E.settings.get(); } catch { /* keep */ }
    render(); // paint immediately, then fill the (async) capability status
    try { state.unlockStatus = await E.unlockStatus(); } catch { state.unlockStatus = null; }
  }
  if (view==='sources') { try { state.sources = await E.sources.list(); } catch { state.sources = []; } }
  render();
  if (view==='new') { refreshYbAvail(); if (state.form.test.on) refreshTestPlan(); }
}

// Re-render without losing the caret in the field being typed in.
function renderKeepFocus() {
  const a = document.activeElement; const id = a && a.id; const s = a && a.selectionStart, e2 = a && a.selectionEnd;
  render();
  if (id) { const el = document.getElementById(id); if (el) { el.focus(); try { el.setSelectionRange(s, e2); } catch { /* not a text field */ } } }
}

/* ---- "Scraper via votre navigateur" ---- */
let ybAvTimer = null; let ybAvSeq = 0;
function scheduleYbAvail() { clearTimeout(ybAvTimer); ybAvTimer = setTimeout(refreshYbAvail, 300); }
// Ask the main process whether the mode is usable for the typed address (opt-in,
// extension connection, default limits). Repaints only the mode picker unless
// the form's layout must change (so typing is never interrupted).
async function refreshYbAvail() {
  if (!E || !E.yourBrowser) return;
  const url = (document.getElementById('f-url')?.value ?? state.form.url ?? '').trim();
  const seq = ++ybAvSeq;
  let av = null;
  if (url) { try { av = await E.yourBrowser.availability(url); } catch { av = null; } }
  if (seq !== ybAvSeq) return; // a newer address was typed meanwhile
  const prevDomain = state.ybAv && state.ybAv.domain;
  state.ybAv = av;
  if (state.view !== 'new') return;
  const f = state.form; const selectable = ybModeView(av).selectable;
  if (f.mode === 'yb' && (!selectable || (av && av.domain !== prevDomain))) {
    collectForm(); if (!selectable) f.mode = 'standard'; f.yb = null; renderKeepFocus(); return;
  }
  const el = document.getElementById('yb-mode'); if (el) el.innerHTML = ybModeHTML(av, f.mode, I);
}
function collectYb() {
  const n = (id) => { const el = document.getElementById(id); if (!el) return undefined; const x = parseInt(el.value, 10); return Number.isNaN(x) ? undefined : x; };
  const cur = state.form.yb || (state.ybAv && state.ybAv.limits) || {};
  state.form.yb = { maxProducts: n('yb-maxp') ?? cur.maxProducts, maxListPages: n('yb-maxlp') ?? cur.maxListPages, maxDetailPages: n('yb-maxdp') ?? cur.maxDetailPages };
  return state.form.yb;
}
async function launchYb(f) {
  const limits = collectYb();
  let res;
  try { res = await E.yourBrowser.run({ startUrl: f.url, store: f.store || '', productType: (f.productType && f.productType !== 'auto') ? f.productType : '', limits }); }
  catch { res = { ok: false, code: 'invalid_request' }; }
  if (!res || !res.ok) {
    const msg = document.getElementById('yb-msg');
    const text = ybErrorText(res);
    if (msg) msg.innerHTML = `<div class="banner banner-amber gap-top" role="alert"><div class="bic">${I.alert}</div><div><div class="banner-t">${esc(text)}</div></div></div>`;
    else toast(text);
    refreshYbAvail();
    return;
  }
  state.srcCtx = { store: (f.store || '').trim(), domain: regDomain(f.url) };
  state.running = ybRunning({ url: f.url, store: f.store, jobId: res.jobId, domain: res.domain });
  state.view = 'running'; render();
}
// 'yourBrowser' state events: drive the running screen of THIS run only. When a
// run ends, the normal 'done' event (from the job pipeline) opens the completion
// screen; the fallback below only covers a run whose job could not be recorded.
const permKey = (a) => (Array.isArray(a) ? a.slice().sort().join(',') : '');
function onYbEvent(p) {
  if (!p || p.kind !== 'state') return;
  const prevExt = state.ybStatus && state.ybStatus.extension;
  const prevPerm = permKey(state.ybStatus && state.ybStatus.permittedDomains);
  state.ybStatus = p;
  const r = state.running;
  if (applyYbState(r, p)) {
    if (YB_TERMINAL.includes(r.ybPhase)) {
      setTimeout(() => {
        if (state.running !== r) return;
        state.running = null;
        state.lastResult = { jobId: null, status: r.ybPhase === 'done' ? 'done' : r.ybPhase === 'error' ? 'error' : 'stopped', method: 'your-browser', counts: {}, blocked: r.ybPhase === 'blocked' ? { code: 'blocked' } : null, stoppedByUser: r.ybPhase === 'stopped', reason: r.message || '' };
        state.view = 'complete'; refreshJobs().then(render); render();
      }, 4000);
    }
    if (state.view === 'running') scheduleRender();
  }
  // Re-evaluate the mode when the extension connects OR the user just authorized a
  // domain in the extension (its granted-domain list changed) — live, no restart.
  if (state.view === 'new' && (prevExt !== p.extension || prevPerm !== permKey(p.permittedDomains))) scheduleYbAvail();
}

function collectForm() {
  const v = (id)=>document.getElementById(id)?.value?.trim();
  const n = (id,d)=>{ const x=parseInt(v(id),10); return Number.isNaN(x)?d:x; };
  const f = state.form;
  f.url = v('f-url') ?? f.url; f.store = v('f-store') ?? ''; const type=v('f-type'); f.productType = type||'auto'; f.contentType = v('f-ctype') || 'auto';
  f.maxProducts=n('f-maxp',f.maxProducts); f.maxPages=n('f-maxpg',f.maxPages); f.maxDepth=n('f-depth',f.maxDepth); f.workers=n('f-workers',f.workers); f.maxBrowser=n('f-maxb',f.maxBrowser);
  return f;
}
// New-Scraping fields start from the saved Settings defaults (still editable per run).
// The preview of a recipes.json import: every change, site by site, with why; nothing applied before the user confirms.
function recipesPreviewHTML() {
  const p = state.recipesPreview; if (!p) return '';
  if (p.empty) return `<p class="hint">${esc(t('settings.recipesNothing'))}</p><div class="btn-row gap-top"><button class="btn btn-ghost" data-act="recipes-cancel">${esc(t('settings.recipesCancel'))}</button></div>`;
  const c = (p.summary && p.summary.counts) || {};
  const lines = [];
  for (const [host, items] of Object.entries((p.summary && p.summary.sites) || {})) for (const it of items) lines.push(`<li><b>${esc(host)}</b> — ${esc(t('settings.recipesWhat.' + it.what, { field: it.field || '' }))} : ${esc(t('settings.recipesAction.' + it.action))} (${esc(t('settings.recipesWhy.' + it.why))})</li>`);
  return `<div class="gap-top"><p class="hint">${esc(t('settings.recipesCounts', { added: c.added || 0, replaced: c.replaced || 0, kept: c.kept || 0, identical: c.identical || 0 }))}</p>
    <ul class="list-tight">${lines.slice(0, 200).join('')}</ul>
    <div class="btn-row"><button class="btn btn-primary" data-act="recipes-apply">${esc(t('settings.recipesApply'))}</button><button class="btn btn-ghost" data-act="recipes-cancel">${esc(t('settings.recipesCancel'))}</button></div></div>`;
}
function seedFormFromSettings() {
  const s = state.settings || {};
  for (const k of ['maxProducts', 'maxPages', 'maxDepth', 'workers', 'maxBrowser']) {
    const v = Number(s[k]);
    if (s[k] != null && s[k] !== '' && Number.isFinite(v)) state.form[k] = v;
  }
}
async function launchRun(f, { testConfirmed = false } = {}) {
  // Remember the (store, domain) pairing this run established, for the mismatch nudge.
  state.srcCtx = { store: (f.store || '').trim(), domain: regDomain(f.url) };
  state.running = { source:(f.store?f.store+' · ':'')+f.url, url:f.url, sourceId:f._sourceId||null, phase:'discovering', startedAt:Date.now(), progress:{done:0,total:0}, counters:{}, products:[], paused:false, intervention:null, discovered:null };
  state.view='running'; render();
  // Admin test mode: sent only from the confirmation step (never from a quick
  // start, a source or "teach" launch); the main process drops it unless the
  // admin session is unlocked. Switched off after the launch (one launch only).
  const testMode = (testConfirmed && f.test && f.test.on && state.adminUnlocked) ? { ...f.test.routes } : undefined;
  if (f.test) f.test.on = false;
  const res = await E.scrape.start({ origin:f.url, store:f.store||null, productType:(f.productType&&f.productType!=='auto')?f.productType:null, contentType:f.contentType||'auto', browser:f.browser, intervene:f.intervene, provider:'manual', userAgent:f.ua||undefined,
    limits:{ maxProducts:f.maxProducts, maxPages:f.maxPages, maxDepth:f.maxDepth, workers:f.workers, maxBrowser:f.maxBrowser }, testMode });
  if (testMode && res && res.testMode === false) toast('Mode test refusé : l’Administration est verrouillée. Le job tourne sans voie payante non autorisée.');
}
// The access ladder's last rung: a site whose lists only the user's own browser could read lately is scraped
// there directly; a standard run refused by the site (blocked, nothing read) continues there at once.
async function ybIfPreferred(url) {
  let av = null; try { av = await E.yourBrowser.availability(url); } catch { av = null; }
  return av && av.preferred && ybModeView(av).selectable ? av : null;
}
async function maybeContinueInYb(runUrl, p) {
  if (!runUrl || !p || p.stoppedByUser || p.method === 'your-browser' || (p.counts && p.counts.detected > 0) || !(p.blocked || /^stopped:(ACCESS_DENIED|BOT_CHALLENGE|CAPTCHA|RATE_LIMITED)/.test(String(p.status || '')))) return false;
  let av = null; try { av = await E.yourBrowser.availability(runUrl); } catch { av = null; }
  if (!ybModeView(av).selectable) return false;
  state.ybAv = av; toast(t('yb.autoEscalate'));
  await launchYb({ url: runUrl, store: (state.srcCtx && state.srcCtx.store) || '', productType: '' });
  return true;
}
async function startScrape(fromQuick) {
  const f = fromQuick ? (()=>{ state.form.url=document.getElementById('qs-url')?.value?.trim()||''; state.form.store=document.getElementById('qs-store')?.value?.trim()||''; state.form._sourceId=null; state.form.ua=''; return state.form; })() : collectForm();
  if (!f.url) { toast(t('toast.enterUrl')); return; }
  if (!fromQuick && f.mode === 'yb' && ybModeView(state.ybAv).selectable) return launchYb(f);
  { const av = await ybIfPreferred(f.url); if (av) { state.ybAv = av; toast(t('yb.autoPreferred')); return launchYb(f); } }
  // Test mode asks for confirmation, with the routes, caps and worst case shown first.
  if (!fromQuick && f.test && f.test.on && state.adminUnlocked) { await refreshTestPlan(); state.testConfirm = true; renderKeepFocus(); return; }
  await launchRun(f);
}

async function updateSourceStats(runUrl, sourceId, counts) {
  try {
    const list = await E.sources.list(); let changed = false;
    for (const s of list) { if ((sourceId && s.id===sourceId) || (!sourceId && s.url===runUrl)) { s.lastUsed = new Date().toISOString(); s.runs=(s.runs||0)+1; s.products=(s.products||0)+((counts&&counts.detected)||0); changed=true; break; } }
    if (changed) { await E.sources.save(list); state.sources = list; }
  } catch { /* ignore */ }
}

function onEvent(type, p) {
  if (type==='yourBrowser') { onYbEvent(p); return; }
  const r = state.running;
  if (type==='started') { if (r) r.jobId=p.jobId; return; }
  if (type==='done') {
    const runUrl=r?.url, sid=r?.sourceId; state.lastResult=p; state.running=null; updateSourceStats(runUrl,sid,p.counts);
    // Do not pull the owner off the Administration page (unsaved edits); say it instead.
    if (state.view === 'admin') { toast(t('toast.jobDoneElsewhere')); refreshJobs(); loadRoutes(p.jobId); return; }
    state.view='complete'; render();
    maybeContinueInYb(runUrl, p).catch(() => {});
    loadRoutes(p.jobId).then(() => { if (state.view === 'complete') render(); });
    refreshJobs().then(() => { if (state.view !== 'admin') render(); });
    return;
  }
  if (type==='unlock:offer') { if (state.lastResult) { state.lastResult.unlockOffer=p; if (state.view==='complete') render(); } return; }
  if (!r) return;
  if (type==='phase') { r.phase=p.phase; r.stage=p.stage||null; if (p.phase!=='discovering') r.intervention=null; }
  else if (type==='profile') { r.profile=p; }
  else if (type==='discovered') { r.discovered=p; if (p.total!==r.progress.total) r.totalSince=Date.now(); r.progress.total=p.total; }
  else if (type==='progress') { if (p.total!==(r.progress&&r.progress.total)) r.totalSince=Date.now(); r.progress=p; r.intervention=null; if (p.total) r.message=null; } // real total known → the count takes over from the step text
  else if (type==='counters') { r.counters=p; }
  else if (type==='step') { r.message=p.code?t('running.step.'+p.code,p):(p.message||''); if (p.found!=null) r.stepFound=p.found; } // localise the engine's stable step code
  else if (type==='product') { r.products.unshift(p); if (r.products.length>120) r.products.length=120; }
  else if (type==='intervention') { r.intervention=p; }
  else if (type==='state') { r.paused=!!p.paused; if (p.stopping) r.stopping=true; }
  else if (type==='error') { toast(t('toast.error',{e:p.message||''})); }
  if (state.view==='running') scheduleRender();
}

async function onClick(e) {
  const t0 = e.target.closest('[data-nav],[data-act],[data-win],[data-toggle],[data-filter],[data-lang],[data-theme-set]');
  if (!t0) return;
  if (t0.tagName === 'A' && e.preventDefault) e.preventDefault();
  // A button that is unavailable keeps its focus (aria-disabled) but does nothing.
  if (t0.getAttribute && t0.getAttribute('aria-disabled') === 'true' && !t0.dataset.mode) return;
  if (t0.dataset.win) { E.win[{min:'minimize',max:'maximize',close:'close'}[t0.dataset.win]](); return; }
  if (t0.dataset.nav) { go(t0.dataset.nav); return; }
  if (t0.dataset.themeSet) { const th = THEMES.includes(t0.dataset.themeSet) ? t0.dataset.themeSet : 'system'; state.theme = th; applyTheme(); try { state.settings = await E.settings.set({ theme: th }); } catch { /* keep the choice for this session */ } render(); return; }
  if (t0.dataset.lang) { state.lang = setLang(t0.dataset.lang); await E.settings.set({ lang: state.lang }); render(); return; }
  if (t0.dataset.toggle) { const k=t0.dataset.toggle; state.form[k]=!state.form[k]; t0.classList.toggle('on'); t0.classList.toggle('off'); if (t0.setAttribute) t0.setAttribute('aria-checked', state.form[k] ? 'true' : 'false'); return; }
  if (t0.dataset.filter) { if (state.results) { state.results.filter=t0.dataset.filter; render(); } return; }
  const act = t0.dataset.act;
  // ---- admin-only actions (test mode, job route chain) ----
  if (act==='test-toggle') {
    collectForm(); await refreshAdminFlag();
    if (!state.adminUnlocked) { toast('Déverrouillez d’abord l’Administration pour utiliser le mode test.'); renderKeepFocus(); return; }
    state.form.test.on = !state.form.test.on; state.testPlan = null; renderKeepFocus();
    if (state.form.test.on) refreshTestPlan();
    return;
  }
  if (act==='test-route') { const k=t0.dataset.route; if (k && state.form.test.routes[k] !== undefined) state.form.test.routes[k] = !!t0.checked; const el=document.getElementById('test-plan'); if (el) el.innerHTML = testPlanHTML(state.testPlan, state.form.test.routes); if (state.testConfirm) renderKeepFocus(); return; }
  if (act==='test-cancel') { state.testConfirm=false; renderKeepFocus(); return; }
  if (act==='test-confirm') { state.testConfirm=false; await refreshAdminFlag(); const f=collectForm(); if (!state.adminUnlocked) { toast('Mode test refusé : l’Administration est verrouillée.'); renderKeepFocus(); return; } await launchRun(f, { testConfirmed: true }); return; }
  if (act==='admin-job') { adminOpenJob(t0.dataset.job); go('admin'); return; }
  if (act==='qs-start') return startScrape(true);
  if (act==='start') return startScrape(false);
  if (act==='probe') {
    const url=document.getElementById('f-url')?.value?.trim(); if (!url) { toast(t('toast.enterAddr')); return; }
    const out=document.getElementById('probe-out'); out.innerHTML=`<div class="card card-pad gap-top" role="status">${esc(t('new.probing'))}</div>`;
    try {
      const rep=await E.probe(url, { contentType: document.getElementById('f-ctype')?.value || 'auto' });
      // rep may be the structured object {text, diagnosis, …} or (older) a string.
      const obj = (rep && typeof rep === 'object') ? rep : { text: String(rep) };
      const dg = obj.diagnosis || null;
      const au = obj.assistedUnlock;
      const verdict = (obj && obj.best_path !== undefined) ? probeVerdict(obj) : { headline: '', fieldsLine: '', fieldsHtml: '' };
      // When the free path is blocked but an assisted unlock is available, the
      // analysis reflects the WHOLE chain (protected → scrapable), not a bare
      // failure. Provider names / raw HTTP codes are never shown to the user.
      let tone = dg==='ok' ? 'green' : (dg==='blocked'||dg==='unreachable') ? 'red' : 'amber';
      if (au && au.available) tone='amber';
      let banner='';
      if (dg) {
        let msg, detail, btn='';
        if (au && au.available) {
          // Reflect reality: a KNOWN site (or one with known extractable fields) is
          // announced as scrapable; an UNPROVEN site is offered with an explicit
          // caution that the paid unlock may return nothing (point 1a/1b).
          if (au.unproven) {
            msg = verdict.headline || t('probe.protected', { count: '', fields: fieldLabels(['name', 'price', 'image']) });
            detail = verdict.fieldsLine;
            btn = `<div class="banner-act"><button class="btn btn-ghost btn-sm" data-act="unlock-cascade" data-url="${esc(url)}">${I.browser} ${esc(t('probe.unlockAnyway', { credits: fmt(au.credits), eur: eur(au.credits) }))}</button></div>`;
            tone='amber';
          } else {
            msg = verdict.headline;
            detail = verdict.fieldsLine;
            btn = `<div class="banner-act"><button class="btn btn-primary btn-sm" data-act="unlock-cascade" data-url="${esc(url)}">${I.browser} ${esc(t('probe.unlockBtn', { credits: fmt(au.credits), eur: eur(au.credits) }))}</button></div>`;
          }
        } else {
          // Prefer the best-achievable verdict (what the product CAN do) over the
          // generic diagnosis label — so a free lane reads "Extraction gratuite
          // possible · N produits · champs…" instead of a bare "ok".
          msg = verdict.headline; detail = verdict.fieldsLine; // localised verdict + field status — no engine display strings, no language leak
          // Fallback: the specialized-browser (nodriver) escalation, only when enabled + ready.
          if (['blocked','needs-browser','structured-undetected','unreachable'].includes(dg)) {
            try { state.unlockStatus = await E.unlockStatus(); } catch { state.unlockStatus=null; }
            if (state.unlockStatus && state.unlockStatus.enabled && state.unlockStatus.ready) {
              btn = `<div class="banner-act"><button class="btn btn-primary btn-sm" data-act="unlock-retry" data-url="${esc(url)}">${I.browser} ${esc(t('probe.unlockRetry'))}</button></div>`;
            }
          }
        }
        // Click-to-learn: on any weak/blocked verdict, offer to TEACH the page —
        // a free alternative that points the engine at a product with one click.
        const teachBtn = (dg && dg !== 'ok')
          ? `<div class="banner-act"><button class="btn btn-ghost btn-sm" data-act="teach" data-url="${esc(url)}">${I.browser} ${esc(t('teach.button'))}</button><span class="t-mut">${esc(t('teach.buttonHint'))}</span></div>`
          : '';
        banner=`<div class="banner banner-${tone} gap-top"><div class="bic">${dg==='ok'?I.check:(au&&au.available?I.browser:I.alert)}</div>`
          +`<div><div class="banner-t">${esc(msg)}</div>`
          +`<div class="banner-d">${detail === verdict.fieldsLine ? (verdict.fieldsHtml || '') : esc(detail)}</div>${btn}${teachBtn}</div></div>`;
      }
      out.innerHTML=banner+`<div class="card card-pad gap-top"><h2 class="h2">${esc(t('new.analysis'))}</h2><div class="prog-step">${verdict.fieldsHtml||''}</div></div>`;
    }
    catch (err) { out.innerHTML=`<div class="banner banner-red gap-top" role="alert"><div class="bic">${I.alert}</div><div><div class="banner-t">${esc(t('new.analysisFail'))}</div><div class="banner-d">${esc(String(err.message||err))}</div></div></div>`; }
    return;
  }
  if (act==='teach') {
    const url=t0.dataset.url; if (!url) { toast(t('toast.enterAddr')); return; }
    state.teach={ url, phase:'waiting' }; paintTeach();
    let res;
    try { res=await E.teach.run(url, { instruction:t('teach.overlayInstruction'), cancel:t('teach.cancel') }); } catch (err) { res={ ok:false, reason:String((err&&err.message)||err) }; }
    // Ignore a stale resolve: the user cancelled/closed, or started another teach.
    if (!state.teach || state.teach.url!==url || state.teach.phase!=='waiting') return;
    if (res && res.ok) state.teach={ url, phase:'done', recognized:res.recognized, learned:res.learned };
    else if (res && (res.reason==='cancelled'||res.reason==='closed')) state.teach=null; // user closed the window — no scary error
    else state.teach={ url, phase:'fail', reason:(res&&res.reason)||'no_capture' };
    paintTeach();
    return;
  }
  if (act==='teach-cancel') { E.teach.cancel(); state.teach=null; paintTeach(); return; }
  if (act==='teach-close') { state.teach=null; paintTeach(); return; }
  if (act==='teach-start') {
    // Close the loop: scrape the just-learned page immediately, in browser mode
    // (so the learned link_filter rides the browser lane's pagination).
    const url=t0.dataset.url; state.teach=null; paintTeach(); if (!url) return;
    const f=collectForm(); f.url=url; f.browser=true; f.intervene=true; f._sourceId=null;
    await launchRun(f);
    return;
  }
  if (act==='unlock-cascade') {
    const url=t0.dataset.url; if(!url) return;
    state.running={ source:url, url, sourceId:null, phase:'unlock', stage:'cascade', startedAt:Date.now(), progress:{done:0,total:0}, counters:{}, products:[], paused:false, intervention:null, discovered:null };
    state.view='running'; render();
    E.unlockCascade({ url });
    return;
  }
  if (act==='unlock-retry') {
    const url=t0.dataset.url; if(!url) return;
    state.running={ source:url, url, sourceId:null, phase:'unlock', stage:'rendering', startedAt:Date.now(), progress:{done:0,total:0}, counters:{}, products:[], paused:false, intervention:null, discovered:null };
    state.view='running'; render();
    E.unlockRetry({ url });
    return;
  }
  if (act==='rerun-browser') {
    const url=t0.dataset.url; if(!url) return;
    state.form.url=url; state.form.browser=true; state.form.intervene=true; state.form._sourceId=null;
    go('new'); toast(t('jobs.rerunBrowserToast'));
    return;
  }
  if (act==='toggle-unlock') {
    const cur = !!(state.settings && state.settings.unlock);
    try { state.settings = await E.settings.set({ unlock: !cur }); } catch { /* keep */ }
    render(); // reflect the toggle immediately
    try { state.unlockStatus = await E.unlockStatus(); } catch { state.unlockStatus = null; }
    render();
    return;
  }
  if (act==='yb-mode') {
    const want = t0.dataset.mode === 'yb' ? 'yb' : 'standard';
    if (want === 'yb' && !ybModeView(state.ybAv).selectable) { toast(ybModeView(state.ybAv).note); return; }
    if (state.form.mode === 'yb') collectYb();
    collectForm(); state.form.mode = want; render(); return;
  }
  if (act==='yb-resume') { const r=state.running; if (!r||r.mode!=='yb') return; const res=await E.yourBrowser.resume(r.ybJobId); if (res&&!res.ok) toast(ybErrorText(res)); return; }
  if (act==='yb-stop' || act==='stop') { const r=state.running; if (!r||r.stopping) return; state.stopConfirm='new'; render(); return; }
  if (act==='stop-keep') { state.stopConfirm=false; render(); return; }
  if (act==='stop-confirm' && state.running && state.running.mode==='yb') { state.stopConfirm=false; const r=state.running; const res=await E.yourBrowser.stop(r.ybJobId); if (res&&!res.ok) toast(ybErrorText(res)); else { r.ybPhase='stopping'; r.stopping=true; render(); } return; }
  if (act==='pause') { const r=state.running; if (!r) return; if (r.paused) E.scrape.resume(); else E.scrape.pause(); r.paused=!r.paused; render(); return; }
  if (act==='stop-confirm') { state.stopConfirm=false; E.scrape.stop(); if (state.running) state.running.stopping=true; render(); toast(t('toast.stopRequested')); return; }
  if (act==='iv-continue') { E.scrape.intervention('retry'); if (state.running) state.running.intervention=null; render(); return; }
  if (act==='iv-skip') { E.scrape.intervention('skip'); if (state.running) state.running.intervention=null; render(); return; }
  if (act==='open-csv'||act==='open-report') { if (t0.dataset.path) { const err=await E.openPath(t0.dataset.path); if (err) toast(t('toast.openError',{e:err})); } return; }
  if (act==='open-source') { if (t0.dataset.url) E.openExternal(t0.dataset.url); return; }
  if (act==='view-report') { const id=t0.dataset.job; try { const r=await E.jobs.report(id); state.reportView={ jobId:id, text:(r&&r.ok)?r.text:null, reportPath:(r&&r.reportPath)||null }; } catch { state.reportView={ jobId:id, text:null, reportPath:null }; } render(); return; }
  if (act==='report-close') { state.reportView=null; render(); return; }
  if (act==='resume-prompt') { state.resumePrompt = state.jobs.find(j=>j.id===t0.dataset.job)||null; render(); return; }
  if (act==='resume-cancel') { state.resumePrompt=null; render(); return; }
  if (act==='resume-go') { const id=t0.dataset.job; const j=state.jobs.find(x=>x.id===id); state.resumePrompt=null; state.running={ source:j?j.source:id, url:j?.source, sourceId:null, phase:'running', startedAt:Date.now(), progress:{done:0,total:0}, counters:{}, products:[], paused:false, intervention:null, discovered:null }; state.view='running'; render(); await E.jobs.resume(id,{}); return; }
  if (act==='view-results') { const id=t0.dataset.job; try { const products=await E.jobs.products(id); const jb=(state.jobs||[]).find((x)=>x.id===id); const lr=state.lastResult&&state.lastResult.jobId===id?state.lastResult:null; state.results={ jobId:id, products, filter:'all', csvPath:lr?lr.csvPath:null, contentType:(jb&&jb.contentType)||(lr&&lr.contentType&&lr.contentType.type)||null }; state.view='results'; render(); } catch { toast(t('toast.readError')); } return; }
  if (act==='detail') { const R=state.results; state.detail=R?.products.find(x=>x.key===t0.dataset.key)||null; render(); return; }
  if (act==='detail-close') { state.detail=null; render(); return; }
  if (act==='override') { const R=state.results; if (!R) return; const key=t0.dataset.key, status=t0.dataset.status; try { const res=await E.jobs.override(R.jobId,key,status); const pr=R.products.find(x=>x.key===key); if (pr) pr.status=status; toast(t('toast.decisionSaved')); render(); } catch { toast(t('toast.error',{e:''})); } return; }
  // recipes.json: export, import (a preview of every change first), apply or cancel.
  if (act==='recipes-export') { const r=await E.recipes.export(); if (r && r.ok) toast(t('settings.recipesExported',{n:r.sites,path:r.path})); else if (r && !r.canceled) toast(t('settings.recipesErr.generic',{e:r.reason||''})); return; }
  if (act==='recipes-import') { const r=await E.recipes.import(); if (r && r.canceled) return; if (!r || !r.ok) { toast(r && r.code ? t('settings.recipesErr.'+r.code) : t('settings.recipesErr.generic',{e:(r&&r.reason)||''})); return; } state.recipesPreview=r; render(); return; }
  if (act==='recipes-cancel') { state.recipesPreview=null; render(); return; }
  if (act==='recipes-apply') { const p=state.recipesPreview; if (!p) return; const r=await E.recipes.apply(p.previewId); state.recipesPreview=null; toast(r && r.ok ? t('settings.recipesApplied',{n:(r.sites||[]).length}) : t('settings.recipesErr.generic',{e:(r&&r.reason)||''})); render(); return; }
  if (act==='save-settings') {
    const n=(id)=>{ const x=parseInt(document.getElementById(id)?.value,10); return Number.isNaN(x)?undefined:x; };
    const licenseEl=document.getElementById('s-license');
    state.settings=await E.settings.set({ timeoutMs:n('s-timeout'), retries:n('s-retries'), rateLimitMs:n('s-rate'), workers:n('s-workers'), maxProducts:n('s-maxp'), maxPages:n('s-maxpg'), maxDepth:n('s-depth'), maxBrowser:n('s-maxb'), edgeLicense: licenseEl?licenseEl.value.trim():(state.settings&&state.settings.edgeLicense)||'' });
    seedFormFromSettings();
    toast(t('toast.settingsSaved')); return;
  }
  // sources CRUD
  if (act==='src-add') { state.sourceEdit={ _idx:null }; render(); return; }
  if (act==='src-edit') { const i=+t0.dataset.idx; state.sourceEdit={ ...state.sources[i], _idx:i }; render(); return; }
  if (act==='src-cancel') { state.sourceEdit=null; render(); return; }
  if (act==='src-delete') { state.srcDelete=+t0.dataset.idx; render(); const c=document.getElementById('src-del-cancel'); if (c && c.focus) c.focus(); return; }
  if (act==='src-delete-cancel') { state.srcDelete=null; render(); return; }
  if (act==='src-delete-confirm') { const i=+t0.dataset.idx; state.srcDelete=null; state.sources.splice(i,1); await E.sources.save(state.sources); toast(t('toast.sourceDeleted')); render(); return; }
  if (act==='src-save') {
    const v=(id)=>document.getElementById(id)?.value?.trim();
    const name=v('se-name'), url=v('se-url'); if (!name||!url) { toast(t('toast.enterUrl')); return; }
    const rec={ id:(state.sourceEdit._idx!=null?state.sources[state.sourceEdit._idx].id:('s_'+Date.now().toString(36))), name, url, ua:v('se-ua')||'', productType:v('se-type')||'', lastUsed:(state.sourceEdit._idx!=null?state.sources[state.sourceEdit._idx].lastUsed:null), runs:(state.sourceEdit._idx!=null?state.sources[state.sourceEdit._idx].runs:0)||0, products:(state.sourceEdit._idx!=null?state.sources[state.sourceEdit._idx].products:0)||0 };
    if (state.sourceEdit._idx!=null) state.sources[state.sourceEdit._idx]=rec; else state.sources.push(rec);
    await E.sources.save(state.sources); state.sourceEdit=null; toast(t('toast.sourceSaved')); render(); return;
  }
  if (act==='src-run') { const s=state.sources[+t0.dataset.idx]; state.form={ ...state.form, url:s.url, store:s.name, productType:s.productType||'auto', ua:s.ua||'', _sourceId:s.id }; state.srcCtx={ store:(s.name||'').trim(), domain:regDomain(s.url) }; state.view='new'; render(); refreshYbAvail(); return; }
  if (act==='src-hint-apply') {
    const label=t0.dataset.label||''; const el=document.getElementById('f-store'); if (el) el.value=label;
    state.form.store=label; state.srcCtx={ store:label.trim(), domain:regDomain(document.getElementById('f-url')?.value) }; // re-pair so the nudge clears
    paintSourceHint(); return;
  }
}

async function init() {
  if (!E) { document.getElementById('app').innerHTML = '<p class="sub" style="padding:var(--s-10);">'+esc(t('errors.bridge'))+'</p>'; return; }
  if (E.platform==='darwin') document.body.classList.add('mac');
  // The sidebar entry replaces the old floating "Administration" button (hidden by
  // CSS; if reached, it routes here through eloshonNav).
  document.body.classList.add('has-admin-nav');
  window.eloshonNav = { go: (v) => go(v) };
  try { state.info = await E.appInfo(); } catch { /* ignore */ }
  try { const s = await E.settings.get(); state.settings=s||{}; if (s&&s.lang) state.lang=setLang(s.lang); if (s&&THEMES.includes(s.theme)) state.theme=s.theme; } catch { /* ignore */ }
  applyTheme();
  seedFormFromSettings();
  await refreshJobs();
  render();
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKeydown);
  // A product image that fails to load leaves the dashed placeholder (no inline handler: the CSP forbids them).
  document.addEventListener('error', (e) => { const img = e.target; const box = img && img.tagName === 'IMG' ? img.parentNode : null; if (box && box.classList && box.classList.contains('thumb')) { box.classList.add('none'); img.remove(); } }, true);
  { const iv = setInterval(tickRunning, 1000); if (iv && iv.unref) iv.unref(); } // unref: a test harness in Node can still exit
  document.addEventListener('input', (e) => { const id = e.target && e.target.id; if (id === 'f-url' || id === 'f-store') paintSourceHint(); if (id === 'f-url') { scheduleYbAvail(); if (state.form.test.on) scheduleTestPlan(); } });
  E.onEvent(onEvent);
  E.uiReady();
}
init();
