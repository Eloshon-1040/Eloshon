import { fr, en, nl, es, LANGS, LANG_NAMES } from './i18n.js';

// ── State ─────────────────────────────────────────────────────────────────────
const S = {
  screen: 'home', lang: 'fr', theme: 'system',
  info: null, directions: [], license: { activated: false }, config: {},
  src: 'shopify', tgt: 'woocommerce',
  file: null, analysis: null, overrides: {}, mapFilter: null, mapSearch: '', mapOpen: new Set(), mapFocus: null, mapRefocus: false, skuGen: null,
  edits: [], editedHeaders: null, editHints: undefined, outEdits: [], previewCsv: '', categoriesAsTags: true,
  convResult: null, issues: null, corrections: {}, ignored: [], problemFilter: 'all',
  // Answers the engine asked for during the last conversion (BigCommerce weight
  // unit, MM/DD-vs-DD/MM date order, …). Passed back on the re-run so the
  // question does not fire again for the same file.
  answers: {},
  exportOpts: { withRedirects: false, split: false, oldBase: '', newBase: '', baseName: '', exportDir: '' },
  exported: null, exportedCap: null, busy: false,
  // Engine progress (conv:progress events from the worker): the phase of the
  // job in flight — 'convert' | 'issues' | null — shown in the statusbar.
  progressPhase: null,
};

const DICT = { fr, en, nl, es };
const PLATFORMS = [
  { k: 'shopify', n: 'Shopify', i: 'S' },
  { k: 'woocommerce', n: 'WooCommerce', i: 'W' },
  { k: 'wix', n: 'Wix', i: 'X' },
  { k: 'bigcommerce', n: 'BigCommerce', i: 'B' },
  // Shopware and PrestaShop are consumed as JSON payloads (Admin API / Webservice
  // dumps) — the engine auto-detects a JSON drop and routes through the
  // knowledge-driven parser (products / orders / customers). SOURCE only: no
  // serializer exists, so they must not be offered as a destination.
  { k: 'shopware', n: 'Shopware', i: 'W', sourceOnly: true },
  { k: 'prestashop', n: 'PrestaShop', i: 'P', sourceOnly: true },
  // Eloshon Scraper exports (and any CSV taught to the knowledge base): SOURCE only.
  { k: 'eloshon', n: 'Eloshon Scraper', i: 'E', sourceOnly: true },
];
// Where the Eloshon Scraper writes each job's products.json (Phase 0 contract §1).
const SCRAPER_JOBS_PATH = ['%APPDATA%', 'Eloshon Scraper', 'data', 'jobs', '<job>', 'products.json'].join(String.fromCharCode(92));
const platName = (k) => (PLATFORMS.find((p) => p.k === k)?.n) || k;
const platIcon = (k) => (PLATFORMS.find((p) => p.k === k)?.i) || '?';

// ── i18n helpers ──────────────────────────────────────────────────────────────
// The interface language: one of LANGS, French when the stored value is unknown. Its tag is the Intl locale.
const uiLang = (v) => (LANGS.includes(v) ? v : 'fr');
// A missing key falls back to English, then French (the parity test keeps both cases empty).
function t(key, params) { return interp((DICT[S.lang].ui[key] ?? DICT.en.ui[key] ?? DICT.fr.ui[key] ?? key), params); }
function diag(code, params) {
  const d = DICT[S.lang].diag[code] ?? DICT.en.diag[code] ?? DICT.fr.diag[code];
  if (d) return interp(d, params);
  return code.replace(/_/g, ' ');
}
// Text the engine or the knowledge base ships per language ({ fr, en } objects, messageFr / messageEn):
// the interface language when it exists, else English (Dutch and Spanish), else French.
const engineText = (byLang) => (byLang ? byLang[S.lang] ?? byLang.en ?? byLang.fr ?? '' : '');
function interp(str, params) { return params ? str.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? String(params[k]) : '')) : str; }
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Numbers, percentages, money and dates always through Intl with the interface language (system.md §3.1).
const nf = (n) => new Intl.NumberFormat(S.lang).format(n);
// a 0..1 score as a percentage, in the interface language
const pctf = (x) => new Intl.NumberFormat(S.lang, { style: 'percent', maximumFractionDigits: 0 }).format(x);
// an amount in a currency that comes from the data or the configuration, never from this file
const moneyf = (amount, currency) => new Intl.NumberFormat(S.lang, { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(amount);

// ── DOM helpers ───────────────────────────────────────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
function on(root, sel, ev, fn) { $$(sel, root).forEach((n) => n.addEventListener(ev, fn)); }

// ── Icons ─────────────────────────────────────────────────────────────────────
const IC = {
  logo: '<svg viewBox="0 0 64 64" fill="currentColor" aria-hidden="true"><rect x="8" y="11" width="11" height="41" rx="5"/><rect x="23" y="11" width="33" height="11" rx="5.5"/><rect x="23" y="26" width="20" height="11" rx="5.5"/><rect x="47" y="26" width="9" height="11" rx="4.5" opacity=".55"/><rect x="23" y="41" width="33" height="11" rx="5.5"/></svg>',
  swap: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h13l-3.5-3.5"/><path d="M20 15H7l3.5 3.5"/></svg>',
  arrowr: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h14"/><path d="m13 7 5 5-5 5"/></svg>',
  arrowsmall: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h14"/><path d="m13 7 5 5-5 5"/></svg>',
  nav_new: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h13l-3.5-3.5"/><path d="M20 15H7l3.5 3.5"/></svg>',
  nav_history: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 4v4h4"/><path d="M12 8v4l3 2"/></svg>',
  nav_templates: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="6" rx="1.5"/><rect x="4" y="14" width="10" height="6" rx="1.5"/></svg>',
  nav_settings: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.3 1a7 7 0 0 0-1.7-1L14.5 2h-5l-.4 2.6a7 7 0 0 0-1.7 1l-2.3-1-2 3.4L3 11a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 1.7 1l.4 2.6h5l.4-2.6a7 7 0 0 0 1.7-1l2.3 1 2-3.4-2-1.5c.1-.3.1-.7.1-1z"/></svg>',
  nav_help: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 4.5 1.5c0 1.5-2 2-2 3.5"/><path d="M12 17h.01"/></svg>',
  lock: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
  upload: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 20h16"/></svg>',
  folder: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7a2 2 0 0 1 2-2h3l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/></svg>',
  check: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m4 12 5 5L20 6"/></svg>',
  alert: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l9 16H3z"/><path d="M12 10v4"/><path d="M12 17h.01"/></svg>',
  plus: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
  trash: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14"/><path d="M9 7V5h6v2"/><path d="M7 7l1 12h8l1-12"/></svg>',
  min: '<svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="5.5" width="8" height="1" fill="currentColor"/></svg>',
  max: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1"><rect x="2.5" y="2.5" width="7" height="7"/></svg>',
  x: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg>',
  info: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>',
  search: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  chev: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
  info_s: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>',
  alert_s: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4 2.8 19.5a1 1 0 0 0 .9 1.5h16.6a1 1 0 0 0 .9-1.5L12 4z"/><path d="M12 10v4"/><path d="M12 17.5h.01"/></svg>',
  // status-chip icons (system.md §5.4): settled / needs you / uncertain / empty / ignored
  c_ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>',
  c_check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4 2.8 19.5a1 1 0 0 0 .9 1.5h16.6a1 1 0 0 0 .9-1.5L12 4z"/><path d="M12 10v4"/><path d="M12 17.5h.01"/></svg>',
  c_unsure: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.3 2.4c-.5.2-.8.7-.8 1.2v.4"/><path d="M12 17h.01"/></svg>',
  c_empty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12h8"/></svg>',
  c_ignored: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/></svg>',
  k_up: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20V6"/><path d="m7 11 5-5 5 5"/></svg>',
  k_down: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v14"/><path d="m7 13 5 5 5-5"/></svg>',
  k_left: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12H6"/><path d="m11 7-5 5 5 5"/></svg>',
  k_right: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12h14"/><path d="m13 7 5 5-5 5"/></svg>',
  down: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/></svg>',
};

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  const info = await window.eloshon.info();
  S.info = info; S.directions = info.directions || []; S.license = info.license || { activated: false };
  S.config = info.config || {};
  S.lang = uiLang(S.config.lang); S.theme = ['system', 'light', 'dark'].includes(S.config.theme) ? S.config.theme : 'system';
  S.exportOpts.exportDir = S.config.exportDir || '';
  applyTheme(); applyLang();
  // Engine progress: the conversion runs in a worker; its phase events keep
  // the statusbar honest while a large file is being processed.
  window.eloshon.conv.onProgress?.((p) => { S.progressPhase = p.phase; if (S.busy) renderStatusbar(); });
  renderChrome();
  renderScreen('home');
}

function applyTheme() { document.documentElement.setAttribute('data-theme', S.theme); }
function applyLang() { document.documentElement.setAttribute('lang', S.lang); }

// ── Chrome (titlebar + sidebar + statusbar) ───────────────────────────────────
function docTitle() {
  const m = {
    home: t('home_title'), step1: t('step1'), step2: t('step2'), step3: t('step3'), step4: t('step4'), step5: t('step5'),
    history: t('nav_history'), templates: t('nav_templates'), settings: t('nav_settings'), help: t('nav_help'),
  };
  return m[S.screen] || '';
}
function renderChrome() {
  const isMac = S.info?.isMac;
  $('#titlebar').innerHTML = `
    ${isMac ? '<div class="tb-mac-pad"></div>' : `<span class="tb-logo">${IC.logo}</span>`}
    <span class="tb-title"><b>Eloshon</b> Converter<span class="sep">—</span><span class="doc" id="tb-doc">${esc(docTitle())}</span></span>
    <span class="tb-spacer"></span>
    ${isMac ? '' : `<span class="tb-controls">
      <button class="tb-btn" data-win="min" title="${esc(t('win_min'))}" aria-label="${esc(t('win_min'))}">${IC.min}</button>
      <button class="tb-btn" data-win="max" title="${esc(t('win_max'))}" aria-label="${esc(t('win_max'))}">${IC.max}</button>
      <button class="tb-btn close" data-win="close" title="${esc(t('win_close'))}" aria-label="${esc(t('win_close'))}">${IC.x}</button>
    </span>`}`;
  on($('#titlebar'), '[data-win]', 'click', (e) => {
    const a = e.currentTarget.getAttribute('data-win');
    if (a === 'min') window.eloshon.win.minimize(); else if (a === 'max') window.eloshon.win.maximize(); else window.eloshon.win.close();
  });

  const nav = [
    ['history', IC.nav_history, t('nav_history')],
    ['templates', IC.nav_templates, t('nav_templates')],
    ['settings', IC.nav_settings, t('nav_settings')],
    ['help', IC.nav_help, t('nav_help')],
  ];
  const wizardActive = ['step1', 'step2', 'step3', 'step4', 'step5', 'home'].includes(S.screen);
  $('#sidebar').innerHTML = `
    <button class="nav-cta" data-nav="home">${IC.nav_new}<span>${t('nav_new')}</span></button>
    <div class="nav-group">
      ${nav.map(([k, ic, label]) => `<button class="nav-item ${S.screen === k ? 'active' : ''}" data-nav="${k}">${ic}<span>${label}</span></button>`).join('')}
    </div>
    <div class="nav-spacer"></div>
    <div class="sidebar-badge">${IC.lock}<span>${t('local_badge')}</span></div>
    <div class="sidebar-ver">${t('version')} ${esc(S.info?.version || '')}${S.license?.activated ? ' · ' + t('license_ok') : ''}</div>`;
  on($('#sidebar'), '[data-nav]', 'click', (e) => renderScreen(e.currentTarget.getAttribute('data-nav')));
  $('.nav-cta', $('#sidebar')).classList.toggle('active', wizardActive && S.screen !== 'home' ? false : S.screen === 'home');

  renderStatusbar();
}
function renderStatusbar() {
  const ent = S.issues?.entity || S.analysis?.detection?.entity;
  const info = S.convResult ? `${nf(S.convResult.counts.inputUnits)} ${t(ent === 'customers' ? 'ent_customers' : ent === 'orders' ? 'ent_orders' : 's4_products')} · ${nf(S.convResult.counts.outputRows)} ${t('s4_rows')}` : '';
  $('#statusbar').innerHTML = `
    <span>${t('version')} ${esc(S.info?.version || '')}</span>
    <span class="local">${IC.lock}${t('local_short')}</span>
    <span class="grow"></span>
    <span class="mono">${info}</span>
    <span class="state"><span class="dot"></span>${S.busy ? busyLabel() : t('ready')}</span>`;
}
function busyLabel() {
  return S.progressPhase === 'convert' ? t('st_converting')
    : S.progressPhase === 'issues' ? t('st_checking') : t('analyzing');
}

// ── Screen router ─────────────────────────────────────────────────────────────
const SCREENS = {
  home: renderHome, step1: renderStep1, step2: renderStep2, step3: renderStep3,
  step4: renderStep4, step5: renderStep5, history: renderHistory, templates: renderTemplates,
  settings: renderSettings, help: renderHelp,
};
function renderScreen(name) {
  let target = SCREENS[name] ? name : 'home';
  // Wizard screens need a file; fall back to step1 if missing.
  if (['step3', 'step4', 'step5'].includes(target) && !S.file) target = 'step1';
  S.screen = target;
  const main = $('#main');
  main.innerHTML = '';
  main.appendChild(SCREENS[target]());
  const doc = $('#tb-doc'); if (doc) doc.textContent = docTitle();
  $$('#sidebar .nav-item').forEach((n) => n.classList.toggle('active', n.getAttribute('data-nav') === S.screen));
  $('.nav-cta', $('#sidebar'))?.classList.toggle('active', S.screen === 'home');
  renderStatusbar();
  main.scrollTop = 0;
}

function screenEl(inner) { const d = document.createElement('div'); d.className = 'screen'; d.innerHTML = inner; return d; }

function stepper() {
  const steps = [['step1', t('step1')], ['step2', t('step2')], ['step3', t('step3')], ['step4', t('step4')], ['step5', t('step5')]];
  const idx = ['step1', 'step2', 'step3', 'step4', 'step5'].indexOf(S.screen);
  return `<div class="stepper">${steps.map(([, label], i) => `
    <div class="step ${i === idx ? 'active' : i < idx ? 'done' : ''}">
      <span class="dot">${i < idx ? IC.check : i + 1}</span><span class="lbl">${label}</span>
    </div>${i < 4 ? `<span class="step ${i < idx ? 'done' : ''}"><span class="line"></span></span>` : ''}`).join('')}</div>`;
}

// ── Home ──────────────────────────────────────────────────────────────────────
function renderHome() {
  const el = screenEl(`<div class="scroll">
    <h1 class="title">${t('home_title')}</h1><p class="sub">${t('home_sub')}</p>
    <button class="btn primary" id="home-new" style="height:40px">${IC.nav_new}${t('nav_new')}</button>
    <div style="height:26px"></div>
    <div class="row" style="justify-content:space-between;align-items:flex-end;margin-bottom:12px">
      <div style="font-size:13px;font-weight:600">${t('home_recent')}</div>
    </div>
    <div id="home-recent"></div>
  </div>`);
  on(el, '#home-new', 'click', () => startWizard());
  loadRecent($('#home-recent', el));
  return el;
}
async function loadRecent(host) {
  const items = await window.eloshon.history.get();
  if (!items.length) { host.innerHTML = `<div class="card pad muted">${t('home_empty')} ${t('home_empty_hint')}</div>`; return; }
  host.className = 'recent-grid';
  host.innerHTML = items.slice(0, 8).map((h) => `
    <div class="recent" data-reopen="${esc(h.id)}">
      <div class="pair"><span class="pbadge">${platIcon(h.src)}</span>${platName(h.src)} ${IC.swap} <span class="pbadge">${platIcon(h.tgt)}</span>${platName(h.tgt)}</div>
      <div class="mono" style="font-size:12px;color:var(--ink-2)">${esc(h.file || '')}</div>
      <div class="row" style="justify-content:space-between">
        <span class="muted" style="font-size:11px">${esc(fmtDate(h.at))}</span>
        <span class="chip ${h.status === 'fail' ? 'blocking' : h.status === 'warn' ? 'warning' : 'ok'}"><span class="d"></span>${h.status === 'fail' ? t('h_fail') : h.status === 'warn' ? t('h_warn') : t('h_done')}</span>
      </div>
    </div>`).join('');
  on(host, '[data-reopen]', 'click', (e) => {
    const h = items.find((x) => x.id === e.currentTarget.getAttribute('data-reopen'));
    if (h) { S.src = h.src; S.tgt = h.tgt; renderScreen('step1'); }
  });
}
function fmtDate(iso) { try { return new Intl.DateTimeFormat(S.lang, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)); } catch { return iso; } }

function startWizard() {
  if (S.file?.fileId) window.eloshon.file.forget?.(S.file.fileId)?.catch?.(() => {});
  S.file = null; S.analysis = null; S.overrides = {}; S.edits = []; S.outEdits = []; S.previewCsv = ''; S.editedHeaders = null; S.editHints = undefined; S.corrections = {}; S.ignored = []; S.convResult = null; S.issues = null; S.exported = null; S.exportedCap = null;
  renderScreen('step1');
}

// ── Step 1: platforms ─────────────────────────────────────────────────────────
function renderStep1() {
  const el = screenEl(`${stepper()}<div class="scroll">
    <h1 class="title">${t('s1_title')}</h1><p class="sub">${t('s1_sub')}</p>
    <div class="grid" style="grid-template-columns:1fr;gap:22px;max-width:900px">
      <div><div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:10px;text-transform:uppercase;letter-spacing:.05em">${t('s1_source')}</div>
        <div class="plat-grid" id="src-grid"></div></div>
      <div><div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:10px;text-transform:uppercase;letter-spacing:.05em">${t('s1_target')}</div>
        <div class="plat-grid" id="tgt-grid"></div></div>
    </div>
    <div class="banner info" id="combo" style="margin-top:20px;max-width:900px"></div>
  </div>
  <div class="footer-bar"><span class="spacer"></span><span class="muted" style="font-size:12px">${t('step_of', { n: 1 })}</span>
    <button class="btn primary" id="s1-next" ${S.tgt && S.src !== S.tgt ? '' : 'disabled'}>${t('continue')}${IC.arrowr}</button></div>`);

  const plat = (p, role) => {
    const sel = S[role] === p.k; const same = role === 'tgt' && S.src === p.k;
    const cls = p.soon ? 'soon' : same ? 'same' : sel ? 'sel' : '';
    return `<button class="plat ${cls}" data-role="${role}" data-k="${p.k}" ${p.soon || same ? 'disabled' : ''}>
      <span class="ico">${p.i}</span><span><span class="nm">${p.n}</span>${p.soon ? `<span class="tag">${t('s1_soon')}</span>` : same ? `<span class="tag">${t('s1_same')}</span>` : ''}</span></button>`;
  };
  $('#src-grid', el).innerHTML = PLATFORMS.map((p) => plat(p, 'src')).join('');
  $('#tgt-grid', el).innerHTML = PLATFORMS.filter((p) => !p.sourceOnly).map((p) => plat(p, 'tgt')).join('');
  const combo = $('#combo', el);
  combo.innerHTML = S.tgt && S.src !== S.tgt ? t('s1_combo', { src: platName(S.src), tgt: platName(S.tgt) }) : t('s1_pick_target');
  on(el, '.plat[data-role]', 'click', (e) => {
    const role = e.currentTarget.getAttribute('data-role'); const k = e.currentTarget.getAttribute('data-k');
    if (role === 'src') { S.src = k; if (S.tgt === k) S.tgt = ''; }
    else S.tgt = k;
    renderScreen('step1');
  });
  on(el, '#s1-next', 'click', () => renderScreen('step2'));
  return el;
}

// ── Step 2: file import ───────────────────────────────────────────────────────
/** The manifest of an Eloshon export at import: what was read, what was not, the nearly empty columns, what to do. */
function manifestBanner(m) {
  const p = m.productPages || {};
  // A preview is not a reading that stopped: the extension opened a few pages FOR it, the others wait for « Accepter ».
  const preview = m.status === 'preview' && p.toRead;
  const head = !p.toRead ? t('s2_mf_nopages', { rows: nf(m.rows) })
    : preview ? t('s2_mf_preview', { opened: nf((p.read || 0) + (p.blocked || 0)), toRead: nf(p.toRead) })
    : t(m.status === 'partial' ? 's2_mf_partial' : 's2_mf_complete', { read: nf(p.read), toRead: nf(p.toRead) });
  const parts = [];
  if (preview && (p.read || p.blocked)) parts.push(t('s2_mf_read', { n: nf(p.read || 0) }));
  if (p.humanCheck) parts.push(t('s2_mf_human', { n: nf(p.humanCheck) }));
  if (p.blocked - (p.humanCheck || 0) > 0) parts.push(t('s2_mf_failed', { n: nf(p.blocked - (p.humanCheck || 0)) }));
  if (p.notOpened && !preview) parts.push(t('s2_mf_notopened', { n: nf(p.notOpened) }));
  const thin = Object.values(m.fill || {}).filter((f) => f.total && f.filled / f.total < 0.5).map((f) => `${f.label} ${nf(f.filled)}/${nf(f.total)}`);
  const more = [
    parts.length ? `${parts.join(', ')}.` : '',
    preview && p.notOpened ? t(p.notOpened === 1 ? 's2_mf_waiting_one' : 's2_mf_waiting', { n: nf(p.notOpened) }) : '',
    m.rulesFailing && m.rulesFailing.length ? t('s2_mf_rules', { fields: m.rulesFailing.join(', ') }) : '',
    m.truncated ? t('s2_mf_cut', { n: nf(m.truncated) }) : '',
    thin.length && m.status !== 'complete' ? t('s2_mf_thin', { cols: thin.join(', ') }) : '',
    m.status !== 'complete' ? t('s2_mf_advice') : '',
  ].filter(Boolean).map((x) => esc(x)).join(' ');
  const warn = m.status !== 'complete';
  return `<div class="banner ${warn ? 'warn' : 'info'}" role="status" style="margin-top:12px">${warn ? IC.alert : IC.check}<span><strong>${esc(head)}</strong>${more ? ` ${more}` : ''}${warn ? ` <button class="btn xs" id="s2-mf-other" style="margin-left:8px">${esc(t('s2_mf_other'))}</button>` : ''}</span></div>`;
}

function renderStep2() {
  const a = S.analysis;
  const detected = a && a.detection && a.detection.format !== 'unknown';
  const wrongPlatform = detected && a.detection.platform && a.detection.platform !== S.src;
  // Unknown but learnable (semantic on, at least one plausible column) → the user may continue in learn mode.
  const learnable = a && a.learn && a.learn.semantic.columns.some((c) => c.status === 'auto' || c.status === 'suggest' || c.status === 'decided');
  const el = screenEl(`${stepper()}<div class="scroll">
    <h1 class="title">${t('s2_title')}</h1><p class="sub">${t('s2_sub')}</p>
    <div class="dropzone" id="dz" style="max-width:760px">
      <span class="big">${IC.upload}</span>
      <div style="font-size:14px;font-weight:600">${t('s2_drop')}</div>
      <div class="muted" style="font-size:12px">CSV / JSON / .eloshon · ${platName(S.src)} → ${platName(S.tgt)}</div>
    </div>
    ${S.src === 'eloshon' && !S.file ? `<div class="banner info" style="max-width:760px;margin-top:14px">${IC.swap}<span>${esc(t('s2_hint_eloshon', { path: SCRAPER_JOBS_PATH }))}</span></div>` : ''}
    <div id="s2-info" style="max-width:760px;margin-top:16px"></div>
  </div>
  <div class="footer-bar"><button class="btn" id="s2-back">${t('back')}</button><span class="spacer"></span>
    <span class="muted" style="font-size:12px">${t('step_of', { n: 2 })}</span>
    <button class="btn primary" id="s2-next" ${(detected && !wrongPlatform) || learnable ? '' : 'disabled'}>${t('continue')}${IC.arrowr}</button></div>`);

  const info = $('#s2-info', el);
  if (S.file) {
    if (!detected && learnable) {
      const n = a.learn.semantic.columns.filter((c) => c.status === 'auto' || c.status === 'decided').length;
      info.innerHTML = `<div class="banner warn">${IC.alert}<span>${t('s2_unknown_learn', { n })}</span></div>`;
    } else if (!detected) info.innerHTML = `<div class="banner err">${IC.alert}<span>${a?.eloshonError ? esc(diag(a.eloshonError.code, a.eloshonError.params)) : t('s2_unknown')}</span></div>`;
    else {
      const rows = a.plan ? a.plan : null; void rows;
      info.innerHTML = `<div class="card pad">
        <div class="row gap10"><span class="pbadge">${platIcon(a.detection.platform)}</span>
          <div style="flex:1"><div style="font-weight:600">${t('s2_detected')} · ${esc(a.detection.format === 'knowledge' ? (a.detection.displayName || a.detection.knowledgeId) : diagFormatName(a.detection.format))}</div>
          ${a.knowledge ? `<div class="muted" style="font-size:12px">${t('s2_knowledge', { origin: a.knowledge.origin === 'learned' ? t('s2_origin_learned') : '' })}</div>` : ''}
          <div class="muted mono" style="font-size:12px">${esc(S.file.name)} · ${t('s2_rows', { n: nf(a.rowCount ?? 0) })}</div></div>
        </div></div>
        ${wrongPlatform ? `<div class="banner warn" style="margin-top:12px">${IC.alert}<span>${t('s2_wrong')} <button class="btn xs" id="s2-fixsrc" style="margin-left:8px">${platName(a.detection.platform)}</button></span></div>` : ''}`;
      on(info, '#s2-fixsrc', 'click', () => { S.src = a.detection.platform; if (S.tgt === S.src) S.tgt = ''; renderScreen('step1'); });
    }
    // The file was not plain UTF-8: say how it was read, and whether characters
    // were already lost in the export itself.
    if (S.file.encoding && S.file.encoding !== 'utf-8') info.insertAdjacentHTML('beforeend', `<div class="banner warn" style="margin-top:12px">${IC.alert}<span>${t('s2_encoding', { enc: S.file.encoding })}</span></div>`);
    // An Eloshon export says what it really holds (its manifest): a preview or a partial result is never taken for a complete one.
    if (S.file.manifest) {
      info.insertAdjacentHTML('beforeend', manifestBanner(S.file.manifest));
      $('#s2-mf-other', info)?.addEventListener('click', () => pickFile());
    }
    if (S.file.lostChars) info.insertAdjacentHTML('beforeend', `<div class="banner warn" style="margin-top:12px">${IC.alert}<span>${t('s2_lostchars', { n: nf(S.file.lostChars) })}</span></div>`);
  }
  const dz = $('#dz', el);
  dz.addEventListener('click', pickFile);
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', async (e) => {
    e.preventDefault(); dz.classList.remove('over');
    const f = e.dataTransfer.files[0]; if (!f) return;
    // raw bytes: main decides the encoding (UTF-8, UTF-16, Excel Windows-1252…)
    const bytes = await f.arrayBuffer(); await onFileLoaded({ name: f.name, size: f.size, bytes, path: f.path || '' });
  });
  on(el, '#s2-back', 'click', () => renderScreen('step1'));
  on(el, '#s2-next', 'click', () => goStep3());
  return el;
}
function diagFormatName(fmt) {
  // Human-ish label for a detected format id.
  const platform = fmt.split('_')[0];
  const entity = t(fmt.includes('customers') ? 'ent_customers' : fmt.includes('orders') ? 'ent_orders' : 's4_products');
  return `${platName(platform === 'woo' ? 'woocommerce' : platform === 'bigcommerce' ? 'bigcommerce' : platform)} · ${entity}`;
}
async function pickFile() {
  const r = await window.eloshon.file.open({});
  if (!r) return;
  if (r.error) { toast(t('err_read'), 'err'); return; }
  await onFileLoaded(r);
}
async function onFileLoaded(f) {
  S.busy = true; S.progressPhase = null; renderStatusbar();
  const previousFileId = S.file?.fileId;
  try {
    // Register the text with the engine host once; every preview/issues/convert
    // then sends the fileId instead of re-shipping the whole file over IPC.
    if (!f.fileId) {
      try {
        const r = await window.eloshon.file.register({ name: f.name, size: f.size, text: f.text, bytes: f.bytes });
        if (r?.fileId) f.fileId = r.fileId;
        if (r?.text !== undefined) f.text = r.text;
        if (r?.encoding) { f.encoding = r.encoding; f.lostChars = r.lostChars || 0; }
      } catch { if (f.text === undefined && f.bytes) f.text = new TextDecoder('utf-8').decode(f.bytes); /* fall back to csvText */ }
    }
    delete f.bytes;
    S.mapFilter = null; S.mapSearch = ''; S.mapOpen = new Set(); S.mapFocus = null; S.skuGen = null; S.previewSeq = 0;
    S.file = f; S.overrides = {}; S.edits = []; S.outEdits = []; S.previewCsv = ''; S.editedHeaders = null; S.editHints = undefined; S.corrections = {}; S.ignored = []; S.answers = {};
    await reanalyze();
  } catch (err) {
    S.analysis = null;
    openErrorDialog({ code: 'engine_failed' }, String((err && err.message) || err));
  } finally {
    S.busy = false;
  }
  // The replaced file's text is no longer needed by anyone — free it in the
  // engine host (main + worker) rather than letting a long session accumulate.
  if (previousFileId && previousFileId !== f.fileId) window.eloshon.file.forget?.(previousFileId)?.catch?.(() => {});
  renderScreen('step2');
}
// How the engine calls reference the loaded file: by id when registered, by
// full text as the fallback (e.g. the registration failed).
function fileRef() {
  const base = S.file?.fileId ? { fileId: S.file.fileId } : { csvText: S.file?.text };
  return { ...base, ...(S.edits && S.edits.length ? { edits: S.edits } : {}), ...(S.outEdits && S.outEdits.length ? { outEdits: S.outEdits } : {}),
    ...(S.tgt === 'shopify' && S.categoriesAsTags ? { categoriesAsTags: true } : {}),
    ...(stockModeOf(S.tgt) ? { stockMode: stockModeOf(S.tgt) } : {}) };
}
// Variant stock, chosen per target platform and remembered on this computer (none = the engine's default:
// not tracked for a file Eloshon Scraper wrote, the file's own quantities otherwise).
const STOCK_MODES = ['untracked', 'continue', 'source'];
function stockModeOf(tgt) { try { const m = JSON.parse(localStorage.getItem('stockModeByTarget') || '{}')[tgt]; return STOCK_MODES.includes(m) ? m : null; } catch { return null; } }
function setStockMode(tgt, mode) { try { const all = JSON.parse(localStorage.getItem('stockModeByTarget') || '{}'); if (STOCK_MODES.includes(mode)) all[tgt] = mode; else delete all[tgt]; localStorage.setItem('stockModeByTarget', JSON.stringify(all)); } catch { /* the choice lasts this session only */ } }
const isScrapedSource = () => /^(scraper|extension|manifest)\./.test(String(S.analysis?.detection?.knowledgeId || S.convResult?.sourceFormat || ''));
// (Re)run the mapping analysis for the loaded file. Keeps the user's overrides;
// pre-fills suggested near-name / semantic matches for rules not yet set (they
// show as "À vérifier" and feed the conversion only because they are visible
// and removable here — never silently).
async function reanalyze() {
  const direction = `${S.src}-to-${S.tgt}`;
  S.analysis = await window.eloshon.conv.analyze(fileRef(), direction, S.overrides);
  // rowCount: analyzeMapping returns it for JSON drops; for CSV, quick line count.
  if (S.analysis.rowCount == null) S.analysis.rowCount = countRows(S.file.text);
  if (S.analysis.plan && S.analysis.plan.suggestedOverrides) {
    let added = false;
    for (const [id, ov] of Object.entries(S.analysis.plan.suggestedOverrides)) if (S.overrides[id] === undefined) { S.overrides[id] = ov; added = true; }
    // step 3 shows each pre-filled suggestion as applied (« À vérifier »): analyse once more with it
    if (added) { const rc = S.analysis.rowCount; S.analysis = await window.eloshon.conv.analyze(fileRef(), direction, S.overrides); if (S.analysis.rowCount == null) S.analysis.rowCount = rc; }
  }
}
function countRows(text) {
  // rough physical data-row count (excludes header + trailing blank); good enough for display.
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim() !== '');
  return Math.max(0, lines.length - 1);
}

function goStep3() { renderScreen('step3'); }

// ── Step 3: mapping ───────────────────────────────────────────────────────────
// One screen for the three cases (known format, recognised platform, unknown file): the analysis carries
// `step3` (app/step3-rows.mjs), one row per column of the file. This code only draws it and routes « Modifier »
// to the existing action of each case (overrides, kb:editColumn, kb:decide). system.md §5.6 / §5.7.
const S3_FILTERS = ['todo', 'all', 'ok', 'check', 'uncertain', 'empty', 'ignored'];
const CHIP = {
  ok: ['ok', 'settled', 'c_ok'], check: ['warn', 'attention', 'c_check'], uncertain: ['warn', 'uncertain', 'c_unsure'],
  empty: ['neutral', 'settled', 'c_empty'], ignored: ['neutral', 'paused', 'c_ignored'], unknown: ['neutral', 'paused', 'c_ignored'],
};
const tgtName = () => platName(S.analysis?.step3?.target || S.tgt);
// A field's human label: canon_<path> (dots → _), else the platform rule's own description (customers, orders).
function fieldLabel(field, label) {
  const k = 'canon_' + String(field).replace(/\./g, '_');
  const l = t(k);
  if (l !== k) return l;
  if (label) return engineText(label) || field;
  return field;
}
const destLabel = (d) => (d.field === 'metafields' && d.key ? t('s3_custom_named', { key: d.key }) : fieldLabel(d.field, d.label));
const quoted = (v) => t('quote', { v });
const chipHtml = (key) => { const [tone, shape, ic] = CHIP[key]; return `<span class="status-chip" data-tone="${tone}" data-shape="${shape}">${IC[ic]}${esc(t('s3n_lv_' + key))}</span>`; };
const levelKey = (r) => (r.level || (r.status === 'unknown' ? 'unknown' : 'ignored'));
const needsAction = (r) => r.status === 'used' && (r.level === 'check' || r.level === 'uncertain');
const reasonText = (r) => (r.alert ? t('s3a_' + r.alert.code, { kind: r.alert.params?.kind ? t('s3k_' + r.alert.params.kind) : '' })
  : r.reason ? t('s3r_' + r.reason.code, { kind: r.reason.params?.kind ? t('s3k_' + r.reason.params.kind) : '' }) : '');
const originText = (r) => (r.origin ? t('s3o_' + r.origin) : '');
// A settled row's line: the reason and its origin, without saying the same thing twice
// (« Colonne prévue par ce format » is the format's rule; « Votre choix » is « confirmé par vous »).
function settledText(r) {
  if (r.alert || !r.reason) return [reasonText(r), originText(r)].filter(Boolean).join(' · ');
  if (r.reason.code === 'empty') return reasonText(r);
  if (r.reason.code === 'format_rule' || r.reason.code === 'name_known') return originText(r) || reasonText(r);
  if (r.reason.code === 'user_choice') return reasonText(r);
  return [reasonText(r), originText(r)].filter(Boolean).join(' · ');
}
const destCols = (d) => (d.carried ? d.cols.join(', ') : '');
function rowMatches(r, filter) {
  const ign = r.status === 'ignored' || r.status === 'unknown';
  switch (filter) {
    case 'todo': return needsAction(r);
    case 'ok': case 'check': case 'uncertain': return !ign && r.level === filter;
    case 'empty': return r.level === 'empty';
    case 'ignored': return ign && r.level !== 'empty';
    default: return true;
  }
}
function rowSearchText(r) {
  return [r.column, ...r.samples, ...r.dests.flatMap((d) => [fieldLabel(d.field, d.label), ...d.cols])].join(' ').toLowerCase();
}
function s3Filter() {
  const c = S.analysis?.step3?.counts;
  if (!S.mapFilter || !S3_FILTERS.includes(S.mapFilter)) S.mapFilter = c && c.todo > 0 ? 'todo' : 'all';
  return S.mapFilter;
}
function formatIdFor() { const a = S.analysis; return a?.learn ? a.learn.proposedId : a?.detection?.knowledgeId; }

function renderStep3() {
  const a = S.analysis;
  const st = a?.step3;
  const rows = a?.rowCount ?? st?.rowCount ?? 0;
  const el = screenEl(`${stepper()}<div class="scroll" id="s3-scroll">
    <div class="s3-head">
      <div><h1 class="title">${t('s3_title')}</h1>
        <p class="sub s3-meta"><span class="pbadge" aria-hidden="true">${platIcon(st?.target || S.tgt)}</span>${esc(t('s3n_meta', { tgt: tgtName(), cols: nf(st?.rows.length ?? 0), rows: nf(rows) }))}${st && st.analysedRows && st.analysedRows < st.rowCount ? ` · ${esc(t('s3n_sampled', { n: nf(st.analysedRows), m: nf(st.rowCount) }))}` : ''}</p></div>
      <div class="btn-row"><button class="btn sm" id="s3-usetpl">${t('s3_use_tpl')}</button><button class="btn sm" id="s3-savetpl">${t('s3_save_tpl')}</button></div>
    </div>
    <div id="s3-banner"></div>
    <div id="s3-err" class="banner err s3-err" role="alert" hidden></div>
    <div id="s3-body"></div>
    <div id="s3-unfed"></div>
    <div id="s3-edits"></div>
    ${previewCard()}
  </div>
  <div class="footer-bar"><button class="btn" id="s3-back">${t('back')}</button><span class="spacer"></span>
    <span class="muted" style="font-size:12px">${t('step_of', { n: 3 })}</span>
    <button class="btn primary" id="s3-next">${t('continue_control')}${IC.arrowr}</button></div>`);

  const body = $('#s3-body', el);
  if (a?.knowledge?.canonNative) {
    body.innerHTML = `<div class="banner info">${IC.swap}<span>${t('s3_kn_canon_native')}</span></div>`;
  } else if (!st || !st.rows.length) {
    body.innerHTML = `<div class="banner info">${IC.swap}<span>${t('s3_auto_note')}</span></div>`;
  } else {
    renderS3Banner($('#s3-banner', el));
    renderColumnTable(body);
    renderUnfed($('#s3-unfed', el));
  }
  renderEditsCard($('#s3-edits', el));
  bindPreview(el);
  on(el, '#s3-back', 'click', () => renderScreen('step2'));
  on(el, '#s3-next', 'click', () => goStep4());
  on(el, '#s3-savetpl', 'click', saveTemplateDialog);
  on(el, '#s3-usetpl', 'click', applyTemplateDialog);
  return el;
}

// Plain-language banner + « Comment c’est mémorisé ? » with the REAL scopes (diagnostic.md, Mémorisation).
function renderS3Banner(host) {
  const st = S.analysis.step3;
  // the learned-format thresholds come from the recognizer (core/knowledge-proposal/recognizer.mjs SIMILAR_MIN, via main)
  const sim = S.info?.learnMatch || { jaccard: 0.8, shared: 4 };
  const scopes = [['format', 's3n_mem_format'], ['column', 's3n_mem_column'], ['learned', 's3n_mem_learned', { n: nf(sim.shared), share: pctf(sim.jaccard) }]];
  host.innerHTML = `<div class="banner info s3-banner">${IC.info}<div class="s3-banner-txt"><p>${esc(t('s3n_banner', { tgt: tgtName() }))}</p>
    <details class="s3-mem"><summary>${t('s3n_mem_q')}</summary>
      <ul>${scopes.map(([k, key, params]) => `<li${k === st.memory ? ' class="here"' : ''}>${esc(t(key, params))}${k === st.memory ? ` <b>${esc(t('s3n_mem_here'))}</b>` : ''}</li>`).join('')}</ul>
      <p class="muted">${esc(t('s3n_mem_where'))}</p></details></div></div>
    ${st.mode === 'learn' ? `<div class="s3-learn card pad">
      <div class="field"><label class="lbl" for="learn-name">${t('s3n_learn_label')}</label>
        <div class="row gap8"><input class="inp" id="learn-name" placeholder="${esc(t('s3_learn_hint_name'))}" aria-describedby="learn-help" autocomplete="off">
        <button class="btn primary sm" id="learn-save">${t('s3_learn_save')}</button></div>
        <span class="help" id="learn-help">${esc(t('s3n_learn_help'))}</span></div></div>` : ''}
    ${st.mode === 'knowledge' && S.analysis.knowledge.origin !== 'reference' ? `<div class="banner info s3-learned">${IC.info}<span>${esc(t('s3n_learned_note'))}</span>
      <button class="btn sm" id="kn-forget">${t('s3_kn_forget')}</button></div>` : ''}`;
  on(host, '#learn-save', 'click', async () => {
    const L = S.analysis.learn;
    S.busy = true; renderStatusbar();
    try {
      const hint = ($('#learn-name', host).value || '').trim() || S.file.name.replace(/\.csv$/i, '');
      const r = await window.eloshon.kb.learn({ headers: L.headers, semantic: L.semantic, hint, provenance: 'unknown' });
      if (!r || !r.ok) throw new Error('learn');
      toast(t('s3_learn_saved'), 'ok'); await reanalyze(); renderScreen('step3');
    } catch { showS3Error(() => $('#learn-save')?.click()); } finally { S.busy = false; renderStatusbar(); }
  });
  on(host, '#kn-forget', 'click', async () => { await window.eloshon.kb.forgetFormat(S.analysis.knowledge.id); await reanalyze(); renderScreen('step3'); });
}

// Saving a choice failed: in place, what happened and what to do, with « Réessayer » (system.md §7.7).
function showS3Error(retry) {
  const box = $('#s3-err'); if (!box) return;
  box.innerHTML = `${IC.alert}<div><b>${esc(t('s3n_err_title'))}</b><p>${esc(t('s3n_err_body'))}</p>
    <div class="row gap8" style="margin-top:8px"><button class="btn sm" id="s3-retry">${t('s3n_retry')}</button></div></div>`;
  box.hidden = false;
  on(box, '#s3-retry', 'click', () => { box.hidden = true; box.innerHTML = ''; retry(); });
  box.scrollIntoView({ block: 'nearest' });
}

function renderColumnTable(body) {
  const st = S.analysis.step3;
  const filter = s3Filter();
  const allEmpty = st.mode === 'learn' && !st.rows.some((r) => r.status === 'used' || r.proposal);
  const anyEdit = st.mode === 'knowledge' && Object.keys(S.analysis.knowledge.edited || {}).length > 0;
  body.innerHTML = `
    ${allEmpty ? `<div class="s3-empty card pad"><h2 class="s3-h2">${esc(t('s3n_empty_title'))}</h2><p>${esc(t('s3n_empty_body'))}</p></div>` : ''}
    <div class="s3-tools">
      <label class="s3-search"><span class="sr">${t('s3n_search_label')}</span>${IC.search}<input type="search" id="s3-q" name="s3-search" placeholder="${esc(t('s3n_search'))}" value="${esc(S.mapSearch || '')}" autocomplete="off" spellcheck="false"></label>
      <div class="s3-pills" role="group" aria-label="${esc(t('s3n_filters_label'))}" id="s3-pills"></div>
    </div>
    <div class="map" id="s3-map">
      <table class="map-tbl" role="grid" aria-label="${esc(t('s3n_table_label'))}" aria-rowcount="-1">
        <colgroup><col class="c1"><col class="c2"><col class="c3"><col class="c4"></colgroup>
        <thead><tr role="row"><th role="columnheader">${t('s3n_th_col')}</th><th role="columnheader">${t('s3n_th_dest')}</th><th role="columnheader">${t('s3n_th_conf')}</th><th role="columnheader"><span class="sr">${t('s3n_th_act')}</span></th></tr></thead>
        <tbody id="s3-rows"></tbody>
      </table>
    </div>
    <div class="s3-under">
      <div class="keys" aria-hidden="true">
        <span><kbd>${IC.k_up}</kbd><kbd>${IC.k_down}</kbd>${t('s3n_k_rows')}</span>
        <span><kbd>${t('kbd_home')}</kbd><kbd>${t('kbd_end')}</kbd>${t('s3n_k_ends')}</span>
        <span><kbd>${IC.k_right}</kbd>${t('s3n_k_open')}</span>
        <span><kbd>${IC.k_left}</kbd>${t('s3n_k_close')}</span>
        <span><kbd>${t('kbd_enter')}</kbd>${t('s3n_k_edit')}</span>
        <span><kbd>${t('kbd_esc')}</kbd>${t('s3n_k_esc_do')}</span>
        <span><kbd>${t('kbd_ctrl')}</kbd><kbd>F</kbd>${t('s3n_k_search')}</span>
        <span><kbd>${t('kbd_ctrl')}</kbd><kbd>1</kbd>${t('s3n_k_to')}<kbd>7</kbd>${t('s3n_k_filters')}</span>
      </div>
      <p class="cap">${esc(t('s3n_legend'))}</p>
      ${anyEdit ? `<div><button class="btn xs ghost" id="kn-reset-all">${t('s3_kn_reset_all')}</button></div>` : ''}
    </div>`;
  void filter;
  drawRows(body);
  const q = $('#s3-q', body);
  q.addEventListener('input', () => { S.mapSearch = q.value; drawRows(body); });
  q.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); focusRow(body, $$('.m-row', body)[0]); } });
  on(body, '#kn-reset-all', 'click', () => applyKnowledge(null, { kind: 'reset' }));
  bindGridKeys(body);
}

// Filter pills (with their count) + rows; called on every filter or search change.
function drawRows(body) {
  const st = S.analysis.step3;
  const filter = s3Filter();
  const q = (S.mapSearch || '').trim().toLowerCase();
  const searched = q ? st.rows.filter((r) => rowSearchText(r).includes(q)) : st.rows;
  const counts = Object.fromEntries(S3_FILTERS.map((f) => [f, searched.filter((r) => rowMatches(r, f)).length]));
  $('#s3-pills', body).innerHTML = S3_FILTERS.map((f, i) => `<button type="button" class="pill" data-f="${f}" aria-pressed="${f === filter}" title="${esc(t('s3n_f_shortcut', { n: i + 1 }))}">${t('s3n_f_' + f)}<b>${nf(counts[f])}</b></button>`).join('');
  on($('#s3-pills', body), '[data-f]', 'click', (e) => { S.mapFilter = e.currentTarget.getAttribute('data-f'); drawRows(body); });
  const shown = searched.filter((r) => rowMatches(r, filter));
  const tb = $('#s3-rows', body);
  if (!shown.length) {
    tb.innerHTML = `<tr class="m-none"><td colspan="4"><div class="s3-none">${q ? `<span>${esc(t('s3n_no_match', { q: S.mapSearch.trim() }))}</span><button class="btn xs" id="s3-clearq">${t('s3n_clear_search')}</button>`
      : `<span>${esc(t('s3n_no_rows_filter'))}</span><button class="btn xs" id="s3-showall">${t('s3n_show_all')}</button>`}</div></td></tr>`;
    on(tb, '#s3-clearq', 'click', () => { S.mapSearch = ''; $('#s3-q', body).value = ''; drawRows(body); $('#s3-q', body).focus(); });
    on(tb, '#s3-showall', 'click', () => { S.mapFilter = 'all'; drawRows(body); });
    return;
  }
  tb.innerHTML = shown.map((r, i) => rowHtml(r, i)).join('');
  // roving focus: one row is the table's only tab stop
  const rowsEl = $$('.m-row', tb);
  const cur = rowsEl.find((n) => n.dataset.col === S.mapFocus) || rowsEl[0];
  rowsEl.forEach((n) => { n.tabIndex = n === cur ? 0 : -1; n.setAttribute('aria-selected', String(n === cur)); });
  on(tb, '.m-tog', 'click', (e) => { e.stopPropagation(); toggleDetails(e.currentTarget.closest('.m-row')); });
  on(tb, '.m-edit', 'click', (e) => { e.stopPropagation(); openModifier(e.currentTarget.closest('.m-row').dataset.col); });
  on(tb, '.m-use', 'click', (e) => { e.stopPropagation(); useAnyway(e.currentTarget.closest('.m-row').dataset.col); });
  on(tb, '.m-row', 'click', (e) => focusRow(body, e.currentTarget, false));
  if (S.mapRefocus) { S.mapRefocus = false; if (cur) focusRow(body, cur); }
}

function rowHtml(r, i) {
  const st = S.analysis.step3;
  const lv = levelKey(r);
  const act = needsAction(r);
  const ign = r.status === 'ignored' || r.status === 'unknown';
  const open = S.mapOpen?.has(r.column);
  const full = r.samples.map((v) => quoted(v)).join(', ');
  const fillPct = r.total ? Math.round((r.filled / r.total) * 100) : 0;
  const c1 = `<div class="cell"><div class="l1">
      <button type="button" class="m-tog" tabindex="-1" aria-expanded="${open ? 'true' : 'false'}" aria-label="${esc(t('s3n_toggle_details', { col: r.column }))}" title="${esc(t('s3n_details'))}">${IC.chev}</button>
      <span class="colname" title="${esc(r.column)}">${esc(r.column)}</span>
      <span class="fill" aria-hidden="true"><i style="width:${fillPct}%"></i></span>
      <span class="ratio${r.filled ? '' : ' empty'}"><span aria-hidden="true">${nf(r.filled)}/${nf(r.total)}</span><span class="sr">${esc(t('s3n_fill_aria', { n: nf(r.filled), m: nf(r.total) }))}</span></span></div>
    <div class="l2${r.samples.length ? ' vals' : ''}"><span class="trunc" title="${esc(full || t('s3n_empty_values', { m: nf(r.total) }))}">${esc(full || t('s3n_empty_values', { m: nf(r.total) }))}</span></div></div>`;
  let c2;
  if (ign) {
    c2 = `<div class="cell"><div class="l1"><span class="arrow">${IC.arrowsmall}</span><span class="dest none">${esc(t('s3n_no_dest'))}</span></div>
      <div class="l2"><button type="button" class="btn link m-use" tabindex="-1">${t('s3n_use_anyway')}</button></div></div>`;
  } else {
    const d = r.dests[0] || null;
    const others = r.dests.slice(1).map((x) => destLabel(x));
    const plat = d ? (d.carried ? `<span class="platcol">${esc(destCols(d))}</span>` : `<span class="platcol none">${esc(t('s3n_not_carried', { tgt: tgtName() }))}</span>`) : '';
    const how = d && d.transformKey ? `<span class="trunc how" title="${esc(t('tr_' + d.transformKey))}">${esc(t('tr_' + d.transformKey))}</span>` : '';
    c2 = `<div class="cell"><div class="l1"><span class="arrow">${IC.arrowsmall}</span><span class="dest${d?.alert ? ' alert' : ''}">${esc(d ? destLabel(d) : t('s3n_no_dest'))}</span>${r.proposal ? `<span class="tag">${t('s3n_m_tag_proposed')}</span>` : ''}</div>
      <div class="l2">${plat}${how}</div>
      ${others.length ? `<div class="l2 also"><span class="trunc" title="${esc(others.join(', '))}">${esc(t('s3n_also', { list: others.join(', ') }))}</span></div>` : ''}</div>`;
  }
  const why = reasonText(r);
  const orig = originText(r);
  const loss = ign && r.filled ? t('s3n_loss', { n: nf(r.filled) }) : '';
  const c3 = `<div class="cell"><div class="l1">${chipHtml(lv)}</div>
    ${act ? `<div class="why${r.alert ? ' alert' : ''}" title="${esc(orig)}">${r.alert ? IC.alert_s : ''}<span>${esc(why)}</span></div>`
      : `<div class="l2"><span class="trunc" title="${esc(ign ? [why, loss].filter(Boolean).join(' · ') : settledText(r))}">${esc(ign ? [why, loss].filter(Boolean).join(' · ') : settledText(r))}</span></div>`}</div>`;
  const canEdit = r.edit?.canEdit && !(st.mode === 'knowledge' && S.analysis.knowledge.origin !== 'reference');
  const c4 = canEdit ? `<button type="button" class="btn quiet m-edit" tabindex="-1" aria-label="${esc(t('s3n_modify_col', { col: r.column }))}">${t('s3n_modify')}</button>` : '';
  const tech = techHtml(r);
  return `<tr class="m-row${act ? ' needs' : ''}${ign ? ' ign' : ''}" role="row" tabindex="-1" aria-selected="false" aria-expanded="${open ? 'true' : 'false'}"
      data-col="${esc(r.column)}" data-level="${lv}" data-status="${r.status}" data-reason="${esc(r.reason?.code || '')}"${r.proposal ? ' data-proposal' : ''}${r.alert ? ` data-alert="${esc(r.alert.code)}"` : ''}
      ${r.context?.owner ? ` data-owner="${esc(r.context.owner)}"` : ''}${r.context?.locale ? ` data-locale="${esc(r.context.locale)}"` : ''} aria-rowindex="${i + 2}">
    <td role="gridcell">${c1}</td><td role="gridcell">${c2}</td><td role="gridcell">${c3}</td><td role="gridcell" class="act">${c4}</td></tr>
    <tr class="m-tech" data-for="${esc(r.column)}"${open ? '' : ' hidden'}><td colspan="4">${tech}</td></tr>`;
}

function techHtml(r) {
  const items = [];
  items.push([t('s3n_det_samples'), r.samples.length ? r.samples.map((v) => quoted(v)).join(' · ') : t('s3n_empty_values', { m: nf(r.total) })]);
  if (r.dests.length) items.push([t('s3n_det_dests'), r.dests.map((d) => `${destLabel(d)} → ${d.carried ? d.cols.join(', ') : t('s3n_not_carried', { tgt: tgtName() })}${d.transformKey ? ` (${t('tr_' + d.transformKey)})` : ''}`).join(' · ')]);
  if (r.alert?.params?.example) items.push([t('s3n_det_alert'), quoted(r.alert.params.example)]);
  if (r.origin) items.push([t('s3n_th_conf'), settledText(r)]);
  if ((r.status === 'ignored' || r.status === 'unknown') && r.filled) items.push([t('s3n_det_loss'), t('s3n_loss', { n: nf(r.filled) })]);
  if (r.edit?.canEdit === false && r.reason?.code === 'structural') items.push(['', t('s3n_cant_edit')]);
  if (r.tech?.internal?.length) items.push([t('s3n_det_internal'), r.tech.internal.join(' · '), true]);
  if (r.tech?.transforms?.length) items.push([t('s3n_det_transform'), r.tech.transforms.join(' · '), true]);
  if (typeof r.score === 'number' && r.score < 1) items.push([t('s3n_det_score'), pctf(r.score)]);
  return `<div class="tech"><div class="tech-h">${esc(t('s3n_details'))}</div><dl>${items.map(([k, v, mono]) => `<dt>${esc(k)}</dt><dd${mono ? ' class="mono"' : ''}>${esc(v)}</dd>`).join('')}</dl></div>`;
}

function toggleDetails(tr, force) {
  if (!tr) return;
  const col = tr.dataset.col;
  const tech = tr.nextElementSibling;
  if (!S.mapOpen) S.mapOpen = new Set();
  const open = force ?? !S.mapOpen.has(col);
  if (open) S.mapOpen.add(col); else S.mapOpen.delete(col);
  if (tech && tech.classList.contains('m-tech')) tech.hidden = !open;
  tr.setAttribute('aria-expanded', String(open));
  tr.querySelector('.m-tog')?.setAttribute('aria-expanded', String(open));
}
function focusRow(body, tr, moveFocus = true) {
  if (!tr) return;
  $$('.m-row', body).forEach((n) => { n.tabIndex = n === tr ? 0 : -1; n.setAttribute('aria-selected', String(n === tr)); });
  S.mapFocus = tr.dataset.col;
  if (moveFocus) { tr.focus({ preventScroll: true }); tr.scrollIntoView({ block: 'nearest' }); }
}
// §5.7: ↑ ↓ Début Fin move, → opens the details, ← folds them, Entrée opens « Modifier ».
function bindGridKeys(body) {
  const tb = $('#s3-rows', body);
  tb.addEventListener('keydown', (e) => {
    const tr = e.target.closest?.('.m-row');
    if (!tr || e.target !== tr) return;
    const rowsEl = $$('.m-row', tb);
    const i = rowsEl.indexOf(tr);
    let next = null;
    if (e.key === 'ArrowDown') next = rowsEl[Math.min(rowsEl.length - 1, i + 1)];
    else if (e.key === 'ArrowUp') next = rowsEl[Math.max(0, i - 1)];
    else if (e.key === 'Home') next = rowsEl[0];
    else if (e.key === 'End') next = rowsEl[rowsEl.length - 1];
    else if (e.key === 'ArrowRight') { e.preventDefault(); toggleDetails(tr, true); return; }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); toggleDetails(tr, false); return; }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (tr.querySelector('.m-edit')) openModifier(tr.dataset.col);
      else if (tr.querySelector('.m-use')) useAnyway(tr.dataset.col);
      return;
    } else return;
    e.preventDefault();
    focusRow(body, next);
  });
}
// Ctrl+F searches the table, Ctrl+1…7 pick a filter (step 3 only, never while a dialog is open).
document.addEventListener('keydown', (e) => {
  if (S.screen !== 'step3' || !e.ctrlKey || e.altKey || e.metaKey || $('#dialog-host .overlay')) return;
  const body = $('#s3-body'); if (!body || !$('#s3-q', body)) return;
  if (e.key === 'f' || e.key === 'F') { e.preventDefault(); const q = $('#s3-q', body); q.focus(); q.select(); return; }
  const n = Number(e.key);
  if (n >= 1 && n <= S3_FILTERS.length && !e.shiftKey) { e.preventDefault(); S.mapFilter = S3_FILTERS[n - 1]; drawRows(body); $(`#s3-pills [data-f="${S.mapFilter}"]`)?.focus(); }
});

const rowByCol = (col) => S.analysis?.step3?.rows.find((r) => r.column === col);

// « Utiliser quand même » on an ignored column: undo the user's own « ignore » when there is one, else choose.
async function useAnyway(col) {
  const r = rowByCol(col); if (!r) return;
  S.mapFocus = col;
  const st = S.analysis.step3;
  if (st.mode === 'plan' && r.edit.ignoredRule) { delete S.overrides[r.edit.ignoredRule]; return afterChoice(); }
  if ((st.mode === 'learn' || r.edit.semantic) && r.status === 'ignored') return runChoice(() => decideFor(col, { kind: 'forget' }));
  if (st.mode === 'knowledge' && r.edit.edited) return applyKnowledge(col, { kind: 'reset' });
  openModifier(col);
}
async function afterChoice() {
  S.busy = true; renderStatusbar();
  try { await reanalyze(); } finally { S.busy = false; renderStatusbar(); }
  S.mapRefocus = true;
  renderScreen('step3');
}
// A choice that writes to this computer: on failure, the error says so in place and « Réessayer » runs it again.
async function runChoice(fn) {
  try { const ok = await fn(); if (ok === false) throw new Error('not saved'); }
  catch { showS3Error(() => runChoice(fn)); return; }
  await afterChoice();
}
// Known format (Reference): the existing column edit (learned overlay of the format).
function applyKnowledge(column, target) {
  return runChoice(async () => { const r = await window.eloshon.kb.editColumn(S.analysis.knowledge.id, column, target); return !!(r && r.ok); });
}
// Unknown file, or a platform file's column no rule reads: the existing decision (scope « column »).
async function decideFor(column, choice) {
  const formatId = formatIdFor();
  if (!formatId) return false;
  const best = rowByCol(column)?.edit?.best ?? null;
  for (const [id, ov] of Object.entries(S.overrides)) if (ov && ov.column === column) delete S.overrides[id];
  if (choice.kind === 'forget') {
    const f = await window.eloshon.kb.forget(formatId, column);
    return !!(f && f.ok);
  }
  let d;
  if (choice.kind === 'ignore') d = { column, action: 'ignored', canon: null };
  else if (choice.kind === 'custom') d = { column, action: 'corrected', canon: 'metafields', args: { key: choice.key } };
  else {
    if (choice.ruleId) S.overrides[choice.ruleId] = { column };
    d = { column, action: choice.field === best ? 'confirmed' : 'corrected', canon: choice.field };
  }
  const r = await window.eloshon.kb.decide({ formatId, ...d });
  return !!(r && r.ok);
}
// The route of a « Modifier » choice, per case — the actions and stored data the app already had.
function applyChoice(col, choice) {
  const st = S.analysis.step3;
  const r = rowByCol(col);
  S.mapFocus = col;
  if (choice.kind === 'same') return afterChoice();
  if (st.mode === 'knowledge') {
    const target = choice.kind === 'canon' ? { kind: 'canon', canon: choice.field } : choice.kind === 'custom' ? { kind: 'custom', key: choice.key } : { kind: choice.kind };
    return applyKnowledge(col, target);
  }
  if (st.mode === 'learn' || r.edit.semantic) return runChoice(() => decideFor(col, choice));
  // a column a platform rule reads: overrides (rule → column), as the old per-field picker did
  if (choice.kind === 'ignore') { for (const id of r.edit.ruleIds) S.overrides[id] = { column: null }; return afterChoice(); }
  if (choice.kind === 'canon' && choice.ruleId) {
    S.overrides[choice.ruleId] = { column: col };
    for (const id of r.edit.ruleIds) if (id !== choice.ruleId) S.overrides[id] = { column: null };
  }
  return afterChoice();
}

// ── « Modifier »: a listbox in the app's style (states-a11y.md): search, current destination first, the
// Converter's proposals, the fields by theme, ignore / custom field; the effect is shown before « Valider ».
function openModifier(col) {
  const st = S.analysis.step3;
  const r = rowByCol(col); if (!r) return;
  S.mapFocus = col;
  const plan = S.analysis.plan;
  const ruleOf = (field) => (st.mode === 'plan' ? (plan?.ruleByCanon?.[field] ?? st.choices.find((c) => c.field === field)?.ruleId ?? null) : null);
  const byField = new Map(st.choices.map((c) => [c.field, c]));
  const cur = (r.status === 'used' || r.status === 'empty') ? r.dests[0] : null;
  const opts = [];
  const add = (o) => { o.id = `m-opt-${opts.length}`; opts.push(o); };
  const colsOf = (field) => byField.get(field) || r.dests.find((x) => x.field === field) || { cols: [], carried: false };
  // 1. the current destination
  const confirmable = r.proposal || ((st.mode === 'learn' || r.edit.semantic) && r.edit.status !== 'decided');
  if (cur) add({ group: 'current', kind: confirmable ? 'canon' : 'same', confirm: confirmable, field: cur.field, label: destLabel(cur), cols: cur.cols, carried: cur.carried, tag: 'current', ruleId: ruleOf(cur.field) });
  else if (r.status === 'ignored') add({ group: 'current', kind: 'same', label: t('s3n_m_ignore'), tag: 'current' });
  // 2. the Converter's proposals
  for (const c of r.candidates) {
    if (cur && c.field === cur.field) continue;
    if (st.mode === 'plan' && !r.edit.semantic && !ruleOf(c.field)) continue;
    const cc = colsOf(c.field);
    add({ group: 'proposals', kind: 'canon', field: c.field, label: fieldLabel(c.field, cc.label), cols: cc.cols, carried: cc.carried, score: c.score, ruleId: ruleOf(c.field) });
  }
  // 3. every field, by theme
  const listed = new Set(opts.map((o) => o.field).filter(Boolean));
  for (const g of ['identity', 'price', 'stock', 'images', 'variants', 'description', 'seo', 'other']) {
    for (const c of st.choices.filter((x) => x.group === g && !listed.has(x.field))) add({ group: g, kind: 'canon', field: c.field, label: fieldLabel(c.field, c.label), cols: c.cols, carried: c.carried, ruleId: c.ruleId ?? ruleOf(c.field) });
  }
  // 4. the other choices (a custom field exists where the app always offered it: known format, unknown file)
  if (r.status !== 'ignored') add({ group: 'actions', kind: 'ignore', label: t('s3n_m_ignore') });
  add({ group: 'actions', kind: 'custom', label: t('s3n_m_custom'), disabled: !(st.mode !== 'plan' || r.edit.semantic) });
  if (st.mode === 'knowledge' && r.edit.edited) add({ group: 'actions', kind: 'reset', label: t('s3n_m_reset') });
  if ((st.mode === 'learn' || r.edit.semantic) && (r.edit.status === 'decided' || r.edit.status === 'ignored')) add({ group: 'actions', kind: 'forget', label: t('s3n_m_forget') });

  const gLabel = { current: t('s3n_m_current'), proposals: t('s3n_m_proposals'), actions: t('s3n_m_actions') };
  const groupName = (g) => gLabel[g] ?? t('s3g_' + g);
  const optHtml = (o) => `<div class="m-opt" role="option" id="${o.id}" aria-selected="false"${o.disabled ? ' aria-disabled="true"' : ''} data-i="${opts.indexOf(o)}">
      <span class="m-ol">${esc(o.label)}${o.tag ? ` <span class="tag">${t('s3n_m_tag_' + o.tag)}</span>` : ''}${o.score != null ? ` <span class="m-sc">${esc(t('s3n_m_score', { n: pctf(o.score) }))}</span>` : ''}</span>
      ${o.field ? `<span class="m-oc${o.carried ? '' : ' none'}">${esc(o.carried ? o.cols.join(', ') : t('s3n_not_carried', { tgt: tgtName() }))}</span>` : ''}
      ${o.disabled ? `<span class="m-oc none">${esc(t('s3n_m_custom_na'))}</span>` : ''}</div>`;
  const groups = [...new Set(opts.map((o) => o.group))];
  const host = dialog(`<div class="dialog m-dlg" role="dialog" aria-modal="true" aria-labelledby="m-title" aria-describedby="m-sub">
    <div class="hd"><div class="m-hd"><h3 id="m-title">${esc(t('s3n_m_title', { col }))}</h3><p id="m-sub">${esc(t('s3n_m_sub', { tgt: tgtName() }))}</p>
      ${r.samples.length ? `<p class="m-samples" title="${esc(r.samples.join(' · '))}">${esc(r.samples.map((v) => quoted(v)).join(', '))}</p>` : ''}</div></div>
    <div class="bd">
      <label class="m-search"><span class="sr">${t('s3n_m_search_label')}</span>${IC.search}<input id="m-q" type="text" role="combobox" aria-expanded="true" aria-controls="m-list" aria-autocomplete="list"
        placeholder="${esc(t('s3n_m_search'))}" autocomplete="off" spellcheck="false"></label>
      <div class="m-list" id="m-list" role="listbox" aria-label="${esc(t('s3n_m_list_label'))}">
        ${groups.map((g) => `<div class="m-grp" role="group" aria-labelledby="m-g-${g}"><div class="m-gh" id="m-g-${g}">${esc(groupName(g))}</div>${opts.filter((o) => o.group === g).map(optHtml).join('')}</div>`).join('')}
        <div class="m-nores" id="m-nores" hidden></div>
      </div>
      <div class="m-custom field" id="m-custom" hidden>
        <label class="lbl" for="m-key">${t('s3n_m_key')}</label>
        <div class="row gap8"><input class="inp mono" id="m-key" value="${esc(customKeyOf(col))}" spellcheck="false" autocomplete="off" aria-describedby="m-key-help m-key-err">
          <button type="button" class="btn xs us-btn" title="${esc(t('s3_custom_us'))}" aria-label="${esc(t('s3_custom_us'))}">_</button></div>
        <span class="help" id="m-key-help">${esc(t('s3_custom_hint'))}</span>
        <span class="help err" id="m-key-err" hidden>${IC.alert_s}${esc(t('s3_custom_bad'))}</span>
      </div>
      <div class="m-effect" aria-live="polite"><div class="m-eh">${esc(t('s3n_m_effect'))}</div><p id="m-eff"></p></div>
    </div>
    <div class="ft"><button class="btn ghost" id="m-cancel">${t('cancel')}</button><button class="btn primary" id="m-ok">${t('s3n_m_ok')}</button></div></div>`);
  const q = $('#m-q', host), list = $('#m-list', host), eff = $('#m-eff', host), custom = $('#m-custom', host), key = $('#m-key', host);
  bindUnderscoreButtons(custom);
  let active = 0;
  const visible = () => $$('.m-opt', list).filter((n) => !n.hidden);
  const optOf = (n) => opts[Number(n.dataset.i)];
  const effect = (o) => {
    const v = r.samples[0];
    const ex = v ? ' ' + t('s3n_m_example', { v: quoted(v.length > 80 ? v.slice(0, 80) + '…' : v) }) : '';
    if (o.kind === 'same' || o.confirm) return o.field ? t('s3n_m_eff_same') : t('s3n_m_eff_ignore', { col: col, tgt: tgtName(), n: nf(r.filled) });
    if (o.kind === 'ignore') return t('s3n_m_eff_ignore', { col: col, tgt: tgtName(), n: nf(r.filled) });
    if (o.kind === 'reset') return t('s3n_m_eff_reset', { col: col });
    if (o.kind === 'forget') return t('s3n_m_eff_forget', { col: col });
    if (o.kind === 'custom') { const k = key.value.trim() || '…'; return t('s3n_m_eff_custom', { col: col, key: k, cols: (st.customCols.length ? st.customCols.map((c) => quoted(c.replace(/\*/g, k))).join(', ') : '—') }) + ex; }
    return (o.carried ? t('s3n_m_eff_dest', { col: col, tgt: tgtName(), cols: o.cols.map((c) => quoted(c)).join(', ') }) : t('s3n_m_eff_notcarried', { col: col, tgt: tgtName() })) + ex;
  };
  const setActive = (n, scroll = true) => {
    const vis = visible();
    if (!vis.length) { q.removeAttribute('aria-activedescendant'); eff.textContent = ''; custom.hidden = true; return; }
    const node = vis[Math.max(0, Math.min(vis.length - 1, n))];
    active = vis.indexOf(node);
    $$('.m-opt', list).forEach((x) => x.setAttribute('aria-selected', String(x === node)));
    q.setAttribute('aria-activedescendant', node.id);
    if (scroll) node.scrollIntoView({ block: 'nearest' });
    const o = optOf(node);
    custom.hidden = o.kind !== 'custom' || !!o.disabled;
    eff.textContent = o.disabled ? t('s3n_m_custom_na') : effect(o);
  };
  const filterOpts = () => {
    const s = q.value.trim().toLowerCase();
    for (const n of $$('.m-opt', list)) { const o = optOf(n); n.hidden = !!s && !`${o.label} ${(o.cols || []).join(' ')}`.toLowerCase().includes(s); }
    for (const g of $$('.m-grp', list)) g.hidden = !$$('.m-opt', g).some((n) => !n.hidden);
    const none = $('#m-nores', list); none.hidden = visible().length > 0; none.textContent = t('s3n_m_none', { q: q.value.trim() });
    setActive(0);
  };
  // Échap closes and gives the focus back to the row (system.md §5.7).
  const backToRow = () => { document.removeEventListener('keydown', escKey, true); $(`.m-row[data-col="${CSS.escape(col)}"]`)?.focus(); };
  const close = () => { closeDialog(); backToRow(); };
  function escKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'Tab') {
      const f = $$('input, button, [tabindex="0"]', host.querySelector('.m-dlg')).filter((n) => !n.disabled && !n.closest('[hidden]') && n.offsetParent);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  document.addEventListener('keydown', escKey, true);
  host.querySelector('.overlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) backToRow(); });
  on(host, '#m-cancel', 'click', close);
  const validate = async () => {
    const node = visible()[active]; if (!node) return;
    const o = optOf(node); if (o.disabled) return;
    let choice;
    if (o.kind === 'custom') {
      const k = key.value.trim();
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(k)) { $('#m-key-err', host).hidden = false; key.setAttribute('aria-invalid', 'true'); key.focus(); return; }
      choice = { kind: 'custom', key: k };
    } else choice = { kind: o.kind, field: o.field ?? null, ruleId: o.ruleId ?? null };
    closeDialog(); document.removeEventListener('keydown', escKey, true);
    S.mapRefocus = true;
    await applyChoice(col, choice);
  };
  q.addEventListener('input', filterOpts);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'PageDown') { e.preventDefault(); setActive(active + 8); }
    else if (e.key === 'PageUp') { e.preventDefault(); setActive(active - 8); }
    else if (e.key === 'Enter') { e.preventDefault(); validate(); }
  });
  key.addEventListener('input', () => { $('#m-key-err', host).hidden = true; key.removeAttribute('aria-invalid'); setActive(active, false); });
  key.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); validate(); } });
  list.addEventListener('mousedown', (e) => { if (e.target.closest('.m-opt')) e.preventDefault(); });
  list.addEventListener('click', (e) => { const n = e.target.closest('.m-opt'); if (!n || n.hidden) return; setActive(visible().indexOf(n), false); if (optOf(n).kind === 'custom' && !optOf(n).disabled) key.focus(); else q.focus(); });
  list.addEventListener('dblclick', (e) => { if (e.target.closest('.m-opt')) validate(); });
  on(host, '#m-ok', 'click', validate);
  setActive(0); q.focus();
}

// ── The platform's fields no column feeds (required first), and the SKU generator (off by default) ─────────
// The generator's settings are remembered per format on this computer (config.json, `skuGenerators`, keyed by the
// format id). Its rules are those of core/knowledge-proposal/sku.mjs, carried by the analysis (step3.sku).
function skuFormatKey() { const a = S.analysis; return a?.detection?.knowledgeId || a?.learn?.proposedId || a?.detection?.format || 'unknown'; }
function skuSettings() {
  const st = S.analysis?.step3;
  if (!st?.sku) return null;
  if (!S.skuGen) S.skuGen = { ...st.sku.defaults, ...((S.config.skuGenerators || {})[skuFormatKey()] || {}) };
  return S.skuGen;
}
// What the conversion receives: the generator only when it is on (WooCommerce's parent SKU needs no option).
// Where each « case personnalisée » goes, chosen once per platform (config.json `customTargets`, core/src/custom-fields.ts).
function ctOpt() { return { customTargets: S.config.customTargets || {} }; }
function skuOpt() { const g = S.analysis?.step3?.sku ? S.skuGen : null; return g && g.enabled ? { skuGenerator: { ...g } } : {}; }
let skuSaveTimer = 0;
function saveSkuSettings() {
  S.config.skuGenerators = { ...(S.config.skuGenerators || {}), [skuFormatKey()]: { ...S.skuGen } };
  clearTimeout(skuSaveTimer);
  skuSaveTimer = setTimeout(() => { window.eloshon.config.set({ skuGenerators: S.config.skuGenerators }).catch?.(() => {}); }, 300);
}

function renderUnfed(host) {
  const st = S.analysis.step3;
  const g = skuSettings();
  // The card also holds the « cases personnalisées » (filled after the preview conversion, renderCustomFields). Only a
  // Scraper file has some: for it the block is in place from the start (no jump when the preview answers).
  const customBox = S.src === 'eloshon'
    ? `<div class="custom-fields" id="custom-fields"><h3 class="s3-h3">${esc(t('s3c_title'))}</h3><p class="cap">${esc(t('s3c_wait'))}</p></div>`
    : '<div class="custom-fields" id="custom-fields" hidden></div>';
  const none = `<p class="unfed-none">${IC.c_ok}${esc(t('s3n_unfed_none', { tgt: tgtName() }))}</p>`;
  // Nothing unfed and no SKU generator (customers, orders): the card shows only if custom fields come (never empty).
  if (!st.unfed.length && !g) { host.innerHTML = `<section class="card s3-unfed" aria-labelledby="unfed-h" data-only-custom hidden><div class="card-hd"><h2 class="s3-h2" id="unfed-h">${esc(t('s3n_unfed_title', { tgt: tgtName() }))}</h2></div><div class="unfed-body">${none}${customBox}</div></section>`; return; }
  const consequence = (u) => t('s3u_' + u.consequence, { tgt: tgtName() });
  const list = st.unfed.length
    ? `<p class="cap unfed-sub">${esc(t('s3n_unfed_sub'))}</p><ul class="unfed">${st.unfed.map((u) => `<li data-field="${esc(u.field)}">
        <div class="u-name"><span class="dest">${esc(fieldLabel(u.field))}</span>${u.required
          ? `<span class="status-chip" data-tone="warn" data-shape="attention">${IC.c_check}${esc(t('s3n_required'))}</span>`
          : `<span class="status-chip" data-tone="neutral" data-shape="settled">${IC.info_s}${esc(t('s3n_important'))}</span>`}</div>
        <div class="u-col"><span class="platcol">${esc(u.cols.join(', '))}</span></div>
        <div class="u-why">${esc(consequence(u))}</div></li>`).join('')}</ul>`
    : none;
  const R = st.sku;
  const sku = g ? `<div class="sku" id="sku-gen">
      <h3 class="s3-h3">${esc(t('s3n_sku_title'))}</h3>
      ${R.parentByDefault ? `<div class="sku-parent"><div class="row gap8"><span class="dest">${esc(t('s3n_woo_parent_title'))}</span><span class="tag">${esc(t('s3n_sku_generated'))}</span></div>
        <p>${esc(t('s3n_woo_parent_body'))}</p><p class="cap">${esc(t('s3n_woo_parent_rule'))}</p></div>` : ''}
      <label class="check"><input type="checkbox" id="sku-on"${g.enabled ? ' checked' : ''} aria-describedby="sku-state"><span>${esc(t('s3n_sku_toggle'))}</span></label>
      <p class="help" id="sku-state">${esc(t(g.enabled ? 's3n_sku_on_help' : 's3n_sku_off'))}</p>
      <div class="sku-set" id="sku-set"${g.enabled ? '' : ' hidden'}>
        <fieldset class="field sku-src"><legend class="lbl">${esc(t('s3n_sku_source'))}</legend>
          <div class="seg" role="radiogroup" aria-label="${esc(t('s3n_sku_source'))}">${R.sources.map((k) => `<button type="button" role="radio" aria-checked="${g.source === k}" class="${g.source === k ? 'on' : ''}" data-src="${k}">${esc(t('s3n_sku_src_' + k))}</button>`).join('')}</div>
          <span class="help">${esc(t('s3n_sku_src_help'))}</span></fieldset>
        <div class="sku-grid">
          <div class="field"><label class="lbl" for="sku-prefix">${esc(t('s3n_sku_prefix'))}</label>
            <input class="inp mono" id="sku-prefix" value="${esc(g.prefix)}" maxlength="${R.prefixMax}" spellcheck="false" autocomplete="off" aria-describedby="sku-prefix-help">
            <span class="help" id="sku-prefix-help">${esc(t('s3n_sku_prefix_help'))}</span></div>
          <div class="field"><label class="lbl" for="sku-max">${esc(t('s3n_sku_max'))}</label>
            <input class="inp mono num" id="sku-max" type="number" min="${R.minLength}" max="${R.maxLength}" step="1" value="${esc(g.maxLength)}" aria-describedby="sku-max-help sku-max-err">
            <span class="help" id="sku-max-help">${esc(t('s3n_sku_max_help'))}</span>
            <span class="help err" id="sku-max-err" hidden>${IC.alert_s}${esc(t('s3n_sku_max_err'))}</span></div>
          <fieldset class="field"><legend class="lbl">${esc(t('s3n_sku_sep'))}</legend>
            <div class="seg" role="radiogroup" aria-label="${esc(t('s3n_sku_sep'))}">${R.separators.map((x) => `<button type="button" role="radio" aria-checked="${g.separator === x}" class="${g.separator === x ? 'on' : ''}" data-sep="${esc(x)}">${esc(t('s3n_sku_sep_' + ({ '-': 'dash', _: 'under', '.': 'dot' }[x] || 'dash')))}</button>`).join('')}</div>
            <span class="help">${esc(t('s3n_sku_sep_help'))}</span></fieldset>
          <fieldset class="field"><legend class="lbl">${esc(t('s3n_sku_case'))}</legend>
            <div class="seg" role="radiogroup" aria-label="${esc(t('s3n_sku_case'))}">${R.cases.map((c) => `<button type="button" role="radio" aria-checked="${g.case === c}" class="${g.case === c ? 'on' : ''}" data-case="${c}">${esc(t('s3n_sku_case_' + c))}</button>`).join('')}</div></fieldset>
        </div>
        <label class="check"><input type="checkbox" id="sku-translit"${g.transliterate ? ' checked' : ''}><span>${esc(t('s3n_sku_translit'))}</span></label>
        <div class="sku-prev"><div class="lbl">${esc(t('s3n_sku_preview'))}</div><div id="sku-preview" class="sku-preview"><p class="cap">${esc(t('s3n_sku_wait'))}</p></div></div>
        <p class="cap">${esc(t('s3n_sku_remember'))}</p>
      </div></div>` : '';
  host.innerHTML = `<section class="card s3-unfed" aria-labelledby="unfed-h"><div class="card-hd"><h2 class="s3-h2" id="unfed-h">${esc(t('s3n_unfed_title', { tgt: tgtName() }))}</h2></div>
    <div class="unfed-body">${list}${customBox}${sku}</div></section>`;
  if (!g) return;
  const changed = () => { saveSkuSettings(); bindPreview(host.closest('.screen')); };
  on(host, '#sku-on', 'change', (e) => {
    S.skuGen.enabled = e.currentTarget.checked;
    $('#sku-set', host).hidden = !S.skuGen.enabled;
    $('#sku-state', host).textContent = t(S.skuGen.enabled ? 's3n_sku_on_help' : 's3n_sku_off');
    changed();
  });
  const seg = (attr, key) => on(host, `[data-${attr}]`, 'click', (e) => {
    const v = e.currentTarget.getAttribute(`data-${attr}`);
    S.skuGen[key] = v;
    $$(`[data-${attr}]`, host).forEach((b) => { const onB = b === e.currentTarget; b.classList.toggle('on', onB); b.setAttribute('aria-checked', String(onB)); });
    changed();
  });
  seg('src', 'source'); seg('sep', 'separator'); seg('case', 'case');
  // a radio group moves with the arrows (one tab stop per group)
  for (const grp of $$('.seg[role="radiogroup"]', host)) {
    const btns = $$('[role="radio"]', grp);
    btns.forEach((b) => { b.tabIndex = b.getAttribute('aria-checked') === 'true' ? 0 : -1; });
    grp.addEventListener('keydown', (e) => {
      const i = btns.indexOf(document.activeElement); if (i < 0) return;
      const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!d) return;
      e.preventDefault(); const n = btns[(i + d + btns.length) % btns.length]; n.click(); btns.forEach((b) => { b.tabIndex = b === n ? 0 : -1; }); n.focus();
    });
  }
  let pt = 0;
  on(host, '#sku-prefix', 'input', (e) => { S.skuGen.prefix = e.currentTarget.value.slice(0, R.prefixMax); clearTimeout(pt); pt = setTimeout(changed, 350); });
  on(host, '#sku-max', 'input', (e) => {
    const n = Number(e.currentTarget.value);
    const ok = Number.isInteger(n) && n >= R.minLength && n <= R.maxLength;
    $('#sku-max-err', host).hidden = ok;
    if (ok) e.currentTarget.removeAttribute('aria-invalid'); else e.currentTarget.setAttribute('aria-invalid', 'true');
    if (ok) { S.skuGen.maxLength = n; clearTimeout(pt); pt = setTimeout(changed, 350); }
  });
  on(host, '#sku-translit', 'change', (e) => { S.skuGen.transliterate = e.currentTarget.checked; changed(); });
}
// « Vos cases personnalisées »: the file's columns with no column in the target (descriptive attributes, and off Shopify
// the product type), each with WHERE it goes for this platform — chosen once, remembered per platform on this computer
// (config.json `customTargets`) and in the mapping template saved (core/src/custom-fields.ts).
let ctTimer = 0;
function renderCustomFields(root, res) {
  const box = $('#custom-fields', root); if (!box) return;
  const card = box.closest('.s3-unfed');
  const list = res && res.ok && Array.isArray(res.customFields) ? res.customFields : [];
  const tgt = tgtName();
  if (card && card.hasAttribute('data-only-custom')) card.hidden = !list.length;
  if (!list.length) {
    // A Scraper file with none says so; a failed preview (its error is shown above) or another source shows nothing.
    const say = res && res.ok && S.src === 'eloshon';
    box.hidden = !say; box.removeAttribute('data-sig');
    box.innerHTML = say ? `<h3 class="s3-h3">${esc(t('s3c_title'))}</h3><p class="cap">${esc(t('s3c_none', { tgt }))}</p>` : '';
    return;
  }
  box.hidden = false;
  // Same fields as shown: only the chosen places and their help change, the selects stay (the keyboard focus with them).
  const sig = JSON.stringify([S.tgt, S.lang, list.map((f) => [f.key, f.label, f.products, f.sample, f.choices, f.fallback, f.isType])]);
  if (box.getAttribute('data-sig') === sig) {
    for (const f of list) {
      const sel = document.getElementById(`ct-${f.key}`); if (!sel) continue;
      if (document.activeElement !== sel) sel.value = f.target;
      const help = document.getElementById(`ct-${f.key}-help`); if (help) help.textContent = t('s3c_help_' + sel.value, { tgt });
    }
    return;
  }
  const focused = box.contains(document.activeElement) ? document.activeElement.getAttribute('data-ct') : null;
  box.setAttribute('data-sig', sig);
  const place = (f, c) => (c === f.fallback ? t('s3c_default', { place: t('s3c_to_' + c, { tgt }) }) : t('s3c_to_' + c, { tgt }));
  box.innerHTML = `<h3 class="s3-h3">${esc(t('s3c_title'))}</h3><p class="cap unfed-sub">${esc(t('s3c_sub', { tgt }))}</p>
    <ul class="unfed custom-list">${list.map((f) => { const id = `ct-${f.key}`; return `<li data-key="${esc(f.key)}">
      <div class="u-name"><span class="dest">${esc(f.isType ? t('s3c_type') : f.label)}</span><span class="cap">${esc(t('s3c_count', { n: nf(f.products) }))}</span></div>
      <div class="u-col"><span class="u-sample" title="${esc(f.sample)}">« ${esc(f.sample)} »</span></div>
      <div class="u-why field"><label class="lbl" for="${id}">${esc(t('s3c_goes'))}</label>
        <select class="inp" id="${id}" data-ct="${esc(f.key)}" aria-describedby="${id}-help">${f.choices.map((c) => `<option value="${esc(c)}"${c === f.target ? ' selected' : ''}>${esc(place(f, c))}</option>`).join('')}</select>
        <span class="help" id="${id}-help">${esc(t('s3c_help_' + f.target, { tgt }))}</span></div></li>`; }).join('')}</ul>
    <p class="cap">${esc(t('s3c_remember', { tgt }))}</p>`;
  if (focused) document.getElementById(`ct-${focused}`)?.focus();
  // A choice is kept at once (help, next conversion); the arrows of a closed list change it on each press, so the
  // saving and the preview wait for the last one.
  on(box, '[data-ct]', 'change', (e) => {
    const sel = e.currentTarget; const key = sel.getAttribute('data-ct');
    const all = { ...(S.config.customTargets || {}) };
    all[S.tgt] = { ...(all[S.tgt] || {}), [key]: sel.value };
    S.config.customTargets = all;
    const help = document.getElementById(`${sel.id}-help`); if (help) help.textContent = t('s3c_help_' + sel.value, { tgt });
    clearTimeout(ctTimer);
    ctTimer = setTimeout(() => { window.eloshon.config.set({ customTargets: S.config.customTargets }).catch?.(() => {}); bindPreview(root); }, 300);
  });
}

// Before / after on the first 6 variants, read from the preview conversion (previewSkus in the engine).
function renderSkuPreview(root, res) {
  const box = $('#sku-preview', root); if (!box) return;
  const rows = res?.skus?.preview;
  if (!rows) { box.innerHTML = `<p class="cap">${esc(t(S.skuGen?.enabled ? 's3n_sku_wait' : 's3n_sku_off'))}</p>`; return; }
  if (!rows.length) { box.innerHTML = `<p class="cap">${esc(t('s3n_sku_preview_empty'))}</p>`; return; }
  box.innerHTML = `<table class="tbl sku-tbl"><thead><tr><th>${esc(t('s3n_sku_product'))}</th><th>${esc(t('s3n_sku_variant'))}</th><th>${esc(t('s3n_sku_before'))}</th><th>${esc(t('s3n_sku_after'))}</th></tr></thead>
    <tbody>${rows.map((x) => `<tr><td>${esc(x.product)}</td><td>${esc(x.variant || '—')}</td><td class="mono">${x.before ? esc(x.before) : `<span class="muted">${esc(t('s3n_sku_none'))}</span>`}</td>
      <td><span class="mono">${esc(x.after || '—')}</span> ${x.generated ? `<span class="tag">${esc(t('s3n_sku_generated'))}</span>` : x.after ? `<span class="tag">${esc(t('s3n_sku_kept'))}</span>` : ''}</td></tr>`).join('')}</tbody></table>`;
}
// « Première ligne telle que [plateforme] la recevra »: the filled cells of the first exported row, after each choice.
function renderFirstRow(root, header, rows) {
  const box = $('#s3-first', root); if (!box) return;
  const r0 = rows[0] || [];
  const filled = header.map((h, i) => [h, r0[i] ?? '']).filter(([, v]) => String(v).trim() !== '');
  box.innerHTML = `<div class="first-h"><span class="lbl">${esc(t('s3n_first_title', { tgt: tgtName() }))}</span><span class="cap">${esc(t('s3n_first_sub'))} ${esc(t('s3n_first_count', { n: nf(filled.length), m: nf(header.length) }))}</span></div>
    ${filled.length ? `<dl class="first-dl">${filled.map(([h, v]) => `<dt class="mono">${esc(h)}</dt><dd title="${esc(v)}">${esc(String(v).length > 240 ? String(v).slice(0, 240) + '…' : v)}</dd>`).join('')}</dl>`
      : `<p class="cap">${esc(t('s3n_first_empty'))}</p>`}`;
}

function customKeyOf(column) {
  return String(column).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'field';
}
// Inserts text at the caret of an input (replacing only a selection, if any)
// and leaves the caret right after it, so typing continues naturally.
function insertAtCaret(input, text) {
  const a = input.selectionStart ?? input.value.length, b = input.selectionEnd ?? a;
  input.setRangeText(text, a, b, 'end');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
}
function bindUnderscoreButtons(root) {
  for (const btn of root.querySelectorAll('.us-btn')) {
    btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the input focused and its caret in place
    btn.addEventListener('click', () => { const inp = btn.parentElement.querySelector('input'); if (inp) insertAtCaret(inp, '_'); });
  }
}
function parseHeaders(text) {
  const first = text.replace(/^﻿/, '').split(/\r\n|\n|\r/)[0] || '';
  const delim = (first.split(';').length > first.split(',').length) ? ';' : (first.split('\t').length > first.split(',').length ? '\t' : ',');
  // simple split (headers rarely contain quoted delimiters); good enough for the picker
  return first.split(delim).map((h) => h.replace(/^"|"$/g, '').trim()).filter(Boolean);
}
function previewCard() {
  return `<div class="card" style="margin-top:14px" id="s3-preview">
    <div class="card-hd">${t('s3_preview')} <span class="muted" style="font-weight:400" id="s3-preview-note"></span></div>
    <div id="s3-first" class="s3-first" aria-live="polite"></div>
    <div id="s3-outedits" style="padding:0 16px"></div>
    <div class="tbl-wrap preview" id="s3-preview-body"><div class="muted" style="padding:16px">…</div></div></div>`;
}
async function bindPreview(root) {
  const body = $('#s3-preview-body', root); if (!body) return;
  // Preview mode: never billed, never capped — the engine runs for display only. A new run keeps the old content
  // at half opacity (system.md §7.5); only the latest run is drawn.
  const seq = (S.previewSeq = (S.previewSeq || 0) + 1);
  $('#s3-preview', root)?.classList.add('updating');
  let res;
  try {
    res = await window.eloshon.conv.run({ ...fileRef(), direction: `${S.src}-to-${S.tgt}`, expectPlatform: S.src, overrides: S.overrides, ...skuOpt(), ...ctOpt() });
  } catch {
    if (seq !== S.previewSeq) return;
    $('#s3-preview', root)?.classList.remove('updating');
    body.innerHTML = `<div class="banner err" style="margin:12px">${IC.alert}<span>${diag('engine_failed')}</span></div>`;
    return;
  }
  if (seq !== S.previewSeq) return;
  $('#s3-preview', root)?.classList.remove('updating');
  renderSkuPreview(root, res);
  renderCustomFields(root, res);
  const note = $('#s3-preview-note', root);
  if (!res.ok) { body.innerHTML = `<div class="banner err" style="margin:12px">${IC.alert}<span>${res.errors?.[0] ? diag(res.errors[0].code, res.errors[0].params) : diag('unrecognized')}</span></div>`; return; }
  S.previewCsv = res.outputCsv;
  renderOutEditsCard($('#s3-outedits', root));
  // Real cells from the engine when available (a quoted multi-line value stays ONE cell);
  // the CSV text split is only the fallback.
  let header, allRows, total;
  if (res.previewTable) { header = res.previewTable.headers; allRows = res.previewTable.rows; total = res.previewTable.total; }
  else { const lines = res.outputCsv.split(/\r\n|\n|\r/).filter((l) => l !== ''); header = splitCsvLine(lines[0]); allRows = lines.slice(1).map(splitCsvLine); total = allRows.length; }
  S.previewHeaders = header;
  renderFirstRow(root, header, allRows);
  const shown = Math.min(allRows.length, S.previewLimit || 20);
  if (note) note.textContent = t('s3_preview_note', { n: nf(shown), fmt: res.targetFormat }) + ` · ${t('s3_cell_hint')}`;
  body.innerHTML = `<table class="tbl"><thead><tr><th class="nowrap">#</th>${header.map((h) => `<th class="nowrap">${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${allRows.slice(0, shown).map((r, i) => `<tr><td class="muted" style="font-size:11px">${i + 1}</td>${header.map((h, j) => `<td class="cell-ed mono" contenteditable="plaintext-only" spellcheck="false" data-r="${i + 1}" data-c="${esc(h)}">${esc(r[j] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>
    ${allRows.length > shown ? `<div class="row gap10" style="padding:10px 14px;align-items:center"><button class="btn xs" id="s3-more">${t('s3_more_rows', { n: nf(Math.min(30, allRows.length - shown)) })}</button><span class="muted" style="font-size:12px">${t('s3_rows_of', { shown, total })}</span></div>` : ''}`;
  on(body, '#s3-more', 'click', () => { S.previewLimit = (S.previewLimit || 20) + 30; bindPreview(root); });
  // Manual edit of one output cell: stored as a `set_cell` edit (saved in templates, replayed on export).
  on(body, '.cell-ed', 'focus', (e) => { e.currentTarget.dataset.orig = e.currentTarget.textContent; });
  on(body, '.cell-ed', 'keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.blur(); }
    else if (e.key === 'Escape') { e.currentTarget.textContent = e.currentTarget.dataset.orig ?? e.currentTarget.textContent; e.currentTarget.blur(); }
  });
  on(body, '.cell-ed', 'blur', async (e) => {
    const td = e.currentTarget; const text = td.textContent;
    if (text === (td.dataset.orig ?? text)) return;
    const row = Number(td.dataset.r); const column = td.dataset.c;
    S.outEdits = S.outEdits.filter((x) => !(x.op === 'set_cell' && x.column === column && Number(x.args?.row) === row));
    S.outEdits.push({ id: edId(), op: 'set_cell', column, args: { row, text } });
    await bindPreview(root);
  });
}
function splitCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; }
  out.push(cur); return out;
}

async function runConvert(direction) {
  return window.eloshon.conv.run({
    ...fileRef(), direction, expectPlatform: S.src,
    overrides: S.overrides, corrections: S.corrections,
    weightUnit: S.answers.weightUnit, dateOrder: S.answers.dateOrder, ...skuOpt(), ...ctOpt(),
  });
}

// Some conversions ask a question the file itself can't answer (BigCommerce
// weight unit, ambiguous date order). If the last run raised one, block the
// step and prompt — the answer is persisted on S.answers and used on the
// re-run. Returns true when a re-run happened (caller should re-check).
async function handleQuestions(res) {
  const q = (res?.questions || []).find((x) => x && x.kind === 'weight_unit') ? 'weight_unit'
    : (res?.questions || []).find((x) => x && x.kind === 'date_format') ? 'date_format' : null;
  if (!q) return false;
  if (q === 'weight_unit') {
    const answer = await askWeightUnit(res.questions.find((x) => x.kind === 'weight_unit'));
    if (!answer) return false; // cancelled — leave the result as-is
    S.answers.weightUnit = answer;
  } else if (q === 'date_format') {
    const answer = await askDateOrder();
    if (!answer) return false; // cancelled — leave the result as-is
    S.answers.dateOrder = answer;
  }
  return true;
}

async function goStep4() {
  S.busy = true; S.progressPhase = null; renderStatusbar();
  const direction = `${S.src}-to-${S.tgt}`;
  try {
    S.convResult = await runConvert(direction);
    if (!S.convResult?.ok && S.convResult?.reason) {
      const r = S.convResult.reason;
      if (r === 'no_converter_credits' || r === 'insufficient_converter_credits') { toast(t('no_credits'), 'err'); return; }
      if (r === 'unknown_account') { toast(t('license_bad'), 'err'); return; }
    }
    if (await handleQuestions(S.convResult)) {
      S.convResult = await runConvert(direction);
    }
    S.issues = await window.eloshon.conv.issues(fileRef(), direction, { overrides: S.overrides, corrections: S.corrections, ignored: S.ignored });
    renderScreen('step4');
  } catch (err) {
    // An engine-worker failure must surface, never leave the UI stuck busy.
    openErrorDialog({ code: 'engine_failed' }, String((err && err.message) || err));
  } finally {
    S.busy = false; renderStatusbar();
  }
}

// ── Step 4: review / problems ─────────────────────────────────────────────────
function renderStep4() {
  const el = screenEl(`${stepper()}<div class="scroll">
    <h1 class="title">${t('s4_title')}</h1><p class="sub">${t('s4_sub')}</p>
    <div id="s4-stats"></div>
    <div id="s4-banner"></div>
    <div id="s4-problems"></div>
    <div id="s4-notes"></div>
    <div id="s4-skus"></div>
    <div id="s4-preserved"></div>
    <div id="s4-losses"></div>
  </div>
  <div class="footer-bar"><button class="btn" id="s4-back">${t('back')}</button><span class="spacer"></span>
    <span class="muted" style="font-size:12px">${t('step_of', { n: 4 })}</span>
    <button class="btn primary" id="s4-next">${t('continue')}${IC.arrowr}</button></div>`);
  on(el, '#s4-back', 'click', () => renderScreen('step3'));
  on(el, '#s4-next', 'click', () => { if (S.issues.canExport) renderScreen('step5'); else toast(t('s4_blocked', { n: nf(S.issues.counts.blocking) }), 'err'); });
  renderStep4Body(el);
  return el;
}
// A step-4 problem in the interface language: the dictionary text of its code (diag « pb_<code> », with the
// values the engine kept), else the engine's own message (English for Dutch and Spanish).
function problemText(p) {
  const key = 'pb_' + p.code;
  if (DICT[S.lang].diag[key]) return diag(key, { value: p.value ?? '', ...(p.params || {}) });
  return engineText({ fr: p.messageFr, en: p.messageEn });
}
function renderStep4Body(root) {
  const cr = S.convResult, iss = S.issues;
  const entityLabel = t(iss.entity === 'customers' ? 'ent_customers' : iss.entity === 'orders' ? 'ent_orders' : 's4_products');
  $('#s4-stats', root).className = 'stats';
  $('#s4-stats', root).innerHTML = `
    <div class="stat"><div class="v">${nf(cr.counts.inputUnits)}</div><div class="k">${entityLabel}</div></div>
    <div class="stat"><div class="v">${nf(cr.counts.outputRows)}</div><div class="k">${t('s4_rows')}</div></div>
    <div class="stat ok"><div class="v">${nf(cr.counts.outputUnits)}</div><div class="k">${t('s4_valid')}</div></div>
    <div class="stat warn"><div class="v">${nf(iss.counts.warning)}</div><div class="k">${t('s4_warnings')}</div></div>
    <div class="stat err"><div class="v">${nf(iss.counts.blocking)}</div><div class="k">${t('s4_blocking')}</div></div>`;

  $('#s4-banner', root).innerHTML = iss.canExport
    ? `<div class="banner ok" style="margin-top:13px">${IC.check}<span>${t('s4_clean')}</span></div>`
    : `<div class="banner err" style="margin-top:13px">${IC.alert}<span>${t('s4_blocked', { n: nf(iss.counts.blocking) })}</span></div>`;

  // problem table
  const all = [...iss.problems, ...iss.ignored.map((p) => ({ ...p, _ignored: true }))];
  const c = { all: all.length, blocking: 0, warning: 0, info: 0, loss: 0 };
  iss.problems.forEach((p) => c[p.severity]++);
  const filt = (p) => S.problemFilter === 'all' || p.severity === S.problemFilter;
  const list = all.filter(filt);
  const tabs = [['all', t('s4_all'), c.all], ['blocking', t('s4_only_blocking'), c.blocking], ['warning', t('s4_only_warn'), c.warning], ['info', t('s4_only_info'), c.info]];
  const sevLabel = { blocking: t('s4_only_blocking'), warning: t('s4_only_warn'), info: t('s4_only_info'), loss: t('s4_only_loss') };

  $('#s4-problems', root).innerHTML = `
    <div class="tabs" style="margin:14px 0 12px">${tabs.map(([k, l, ct]) => `<button class="tab ${S.problemFilter === k ? 'on' : ''}" data-pf="${k}">${l}<span class="ct">${nf(ct)}</span></button>`).join('')}</div>
    <div class="card"><div class="tbl-wrap h"><table class="tbl">
      <thead><tr><th>${t('s4_severity')}</th><th>${t('s4_line')}</th><th>${t('s4_problem')}</th><th>${t('s4_action')}</th></tr></thead>
      <tbody>${list.length ? list.map((p) => `<tr ${p._ignored ? 'style="opacity:.5"' : ''}>
        <td><span class="chip ${p.severity}"><span class="d"></span>${sevLabel[p.severity]}</span></td>
        <td class="muted mono">${p.line != null ? p.line : '—'}${p.lineExact === false ? '*' : ''}</td>
        <td>${esc(problemText(p))}${p.variant ? ` <span class="muted mono" style="font-size:11px">${esc(p.variant)}</span>` : ''}</td>
        <td>${actionCell(p)}</td>
      </tr>`).join('') : `<tr><td colspan="4" class="muted" style="padding:16px">${t('s4_none')}</td></tr>`}</tbody>
    </table></div></div>`;
  on($('#s4-problems', root), '[data-pf]', 'click', (e) => { S.problemFilter = e.currentTarget.getAttribute('data-pf'); renderStep4Body(root); });
  on($('#s4-problems', root), '[data-fix]', 'click', (e) => openFixDialog(JSON.parse(e.currentTarget.getAttribute('data-fix'))));
  on($('#s4-problems', root), '[data-ignore]', 'click', (e) => { S.ignored.push(e.currentTarget.getAttribute('data-ignore')); reIssues(root); });
  on($('#s4-problems', root), '[data-unignore]', 'click', (e) => { S.ignored = S.ignored.filter((x) => x !== e.currentTarget.getAttribute('data-unignore')); reIssues(root); });

  // notes: what the conversion itself reports (edits applied, rows skipped,
  // IDs removed, migrations…) — the engine's warning codes, localised.
  const notes = cr.warnings || [];
  $('#s4-notes', root).innerHTML = notes.length ? `<div class="card pad" style="margin-top:14px" id="s4-notes-card">
    <div style="font-size:13px;font-weight:600;margin-bottom:10px">${t('s4_notes_title')}</div>
    <div style="display:flex;flex-direction:column;gap:8px">${notes.map((w) => `<div class="row gap8" data-code="${esc(w.code)}" style="font-size:13px;color:var(--ink-2)"><span style="color:var(--muted)">•</span>${esc(diag(w.code, w.params))}</div>`).join('')}</div></div>` : '';

  // SKUs the conversion created (the user's generator, WooCommerce parent SKUs): each one marked « généré ».
  const gen = cr.skus?.generated || [];
  $('#s4-skus', root).innerHTML = gen.length ? `<div class="card pad" style="margin-top:14px" id="s4-skus-card">
    <div style="font-size:13px;font-weight:600;margin-bottom:6px">${esc(t('s4_skus_title'))}</div>
    <div class="muted" style="font-size:12px;margin-bottom:10px">${esc(t('s4_skus_sub', { n: nf(gen.length), tgt: platName(S.tgt) }))}</div>
    <ul class="gen-skus">${gen.slice(0, 20).map((g) => `<li data-scope="${esc(g.scope || '')}"><span class="mono">${esc(g.sku)}</span><span class="tag">${esc(t('s3n_sku_generated'))}</span>
      <span class="muted">${esc(g.product)}${g.variant ? ` · ${esc(g.variant)}` : g.scope === 'parent' ? ` · ${esc(t('s4_skus_parent'))}` : ''}</span></li>`).join('')}</ul>
    ${gen.length > 20 ? `<div class="muted" style="font-size:12px;margin-top:6px">${esc(t('s4_skus_more', { n: nf(gen.length - 20) }))}</div>` : ''}</div>` : '';

  // preserved: source data with no equivalent in the target file — listed so
  // nothing disappears without the user knowing (never written to the export).
  const kept = cr.preserved?.fields || [];
  const reasonLabel = (r) => (r === 'no-canon-field' ? t('s4_preserved_reason_nocanon') : t('s4_preserved_reason_unknown'));
  $('#s4-preserved', root).innerHTML = kept.length ? `<div class="card pad" style="margin-top:14px" id="s4-preserved-card">
    <div style="font-size:13px;font-weight:600;margin-bottom:6px">${t('s4_preserved_title', { tgt: platName(S.tgt) })}</div>
    <div class="muted" style="font-size:12px;margin-bottom:10px">${t('s4_preserved_body', { tgt: platName(S.tgt) })}</div>
    <div style="display:flex;flex-direction:column;gap:6px">${kept.map((f) => `<div class="row gap8" data-field="${esc(f.field)}" style="font-size:13px;color:var(--ink-2)"><span style="color:var(--muted)">•</span>${esc(t('s4_preserved_row', { field: f.field, n: nf(f.units) }))}<span class="muted" style="font-size:11px">— ${esc(reasonLabel(f.reason))}</span></div>`).join('')}</div></div>` : '';

  // losses
  const losses = cr.losses || [];
  const nb = root.querySelector('#s4-next'); if (nb) { nb.disabled = !iss.canExport; nb.title = iss.canExport ? '' : t('s4_blocked', { n: nf(iss.counts.blocking) }); }
  $('#s4-losses', root).innerHTML = losses.length ? `<div class="card pad" style="margin-top:14px">
    <div style="font-size:13px;font-weight:600;margin-bottom:10px">${t('s4_losses_title', { tgt: platName(S.tgt) })}</div>
    <div style="display:flex;flex-direction:column;gap:8px">${losses.map((l) => `<div class="row gap8" style="font-size:13px;color:var(--ink-2)"><span style="color:var(--warn)">•</span>${esc(diag(l.code, l.params))}</div>`).join('')}</div></div>` : '';
}
function actionCell(p) {
  if (p._ignored) return `<button class="btn xs" data-unignore="${esc(p.id)}">${t('s4_undo')}</button>`;
  const bits = [];
  if (p.fixable) bits.push(`<button class="btn xs" data-fix='${esc(JSON.stringify({ id: p.id, line: p.line, field: p.field, suggestion: p.suggestion || '', value: p.value || '' }))}'>${t('s4_fix')}</button>`);
  if (p.ignorable) bits.push(`<button class="btn xs ghost" data-ignore="${esc(p.id)}">${t('s4_ignore')}</button>`);
  return `<div class="btn-row" style="justify-content:flex-end">${bits.join('') || '—'}</div>`;
}
async function reIssues(root) {
  S.issues = await window.eloshon.conv.issues(fileRef(), `${S.src}-to-${S.tgt}`, { overrides: S.overrides, corrections: S.corrections, ignored: S.ignored });
  renderStep4Body(root);
}

// ── Step 5: export ────────────────────────────────────────────────────────────
function renderStep5() {
  if (S.exported) return renderExported();
  const cr = S.convResult;
  const isProducts = S.issues.entity === 'products';
  const defBase = (S.file.name || 'export').replace(/\.[^.]+$/, '') + '_' + S.tgt;
  if (!S.exportOpts.baseName) S.exportOpts.baseName = defBase;
  const encLabel = (S.config.encoding === 'utf8bom') ? 'UTF-8 + BOM' : 'UTF-8';
  // Free tier (existing mechanism: freeLimit on the direction) — say BEFORE the
  // export that the file will carry at most 10 products, with the unlock path.
  const freeCap = S.directions.find((d) => d.direction === `${S.src}-to-${S.tgt}`)?.freeLimit ?? 10;
  const freeCapped = false; // no row limit for anyone (owner decision 2026-10-27)
  const el = screenEl(`${stepper()}<div class="scroll">
    <h1 class="title">${t('s5_title')}</h1><p class="sub">${t('s5_sub', { tgt: platName(S.tgt) })}</p>
    ${freeCapped ? `<div class="banner warn" style="max-width:960px;margin-bottom:14px">${IC.lock}<span><b>${t('free_title', { cap: nf(freeCap) })}</b> · ${t('free_note', { cap: nf(freeCap), n: nf(cr.counts.outputUnits) })}</span><button class="btn sm primary" id="s5-unlock" style="margin-left:10px">${t('free_locked', { n: nf(cr.counts.outputUnits) })}</button></div>` : ''}
    <div class="grid" style="grid-template-columns:1fr 300px;gap:14px;align-items:start;max-width:960px">
      <div class="card pad" style="display:flex;flex-direction:column;gap:16px">
        <label class="field"><span class="lbl">${t('s5_dest')}</span>
          <span class="row gap8"><input class="inp mono" id="s5-dir" value="${esc(S.exportOpts.exportDir || S.config.exportDir || '')}" readonly style="flex:1">
          <button class="btn" id="s5-browse">${t('s5_browse')}</button></span></label>
        <label class="field"><span class="lbl">${t('s5_name')}</span>
          <span class="row gap8"><input class="inp" id="s5-name" value="${esc(S.exportOpts.baseName)}" style="flex:1"><span class="mono muted">.csv</span></span></label>
        <div style="height:1px;background:var(--line-subtle)"></div>
        ${isProducts ? `<label class="row gap10" style="align-items:flex-start;cursor:pointer"><input type="checkbox" id="s5-redir" ${S.exportOpts.withRedirects ? 'checked' : ''} style="margin-top:3px">
          <span>${t('s5_redirects')}<span class="muted" style="display:block;font-size:11px">${t('s5_redirects_note')}</span></span></label>
          <div id="s5-redir-fields" class="${S.exportOpts.withRedirects ? '' : 'hidden'}" style="display:flex;gap:8px">
            <input class="inp" id="s5-oldbase" placeholder="${esc(t('s5_old_base_ph'))}" value="${esc(S.exportOpts.oldBase)}">
            <input class="inp" id="s5-newbase" placeholder="${esc(t('s5_new_base_ph'))}" value="${esc(S.exportOpts.newBase)}"></div>` : ''}
        <label class="row gap10" style="align-items:flex-start;cursor:pointer"><input type="checkbox" id="s5-split" ${S.exportOpts.split ? 'checked' : ''} style="margin-top:3px">
          <span>${t('s5_split')}<span class="muted" style="display:block;font-size:11px">${t('s5_split_note')}</span></span></label>
      </div>
      <div class="card pad">
        <div style="font-size:13px;font-weight:600;margin-bottom:12px">${t('s5_summary')}</div>
        <div style="display:flex;flex-direction:column;gap:9px;font-size:13px">
          <div class="row" style="justify-content:space-between"><span class="muted">${t('s4_valid')}</span><span class="mono">${nf(cr.counts.outputUnits)}</span></div>
          <div class="row" style="justify-content:space-between"><span class="muted">${t('s4_rows')}</span><span class="mono">${nf(cr.counts.outputRows)}</span></div>
        </div>
        <div style="margin-top:13px;padding-top:12px;border-top:1px solid var(--line-subtle);font-size:11px;color:var(--muted);line-height:1.55">${t('s5_format_note', { enc: encLabel })}</div>
      </div>
    </div>
  </div>
  <div class="footer-bar"><button class="btn" id="s5-back">${t('back')}</button><span class="spacer"></span>
    <span class="muted" style="font-size:12px">${t('step_of', { n: 5 })}</span>
    <button class="btn primary" id="s5-export">${IC.down}${t('s5_export')}</button></div>`);

  on(el, '#s5-back', 'click', () => renderScreen('step4'));
  on(el, '#s5-unlock', 'click', openUnlockDialog);
  on(el, '#s5-browse', 'click', async () => { const d = await window.eloshon.file.chooseDir(); if (d) { S.exportOpts.exportDir = d; $('#s5-dir', el).value = d; } });
  on(el, '#s5-name', 'input', (e) => { S.exportOpts.baseName = e.target.value; });
  on(el, '#s5-split', 'change', (e) => { S.exportOpts.split = e.target.checked; });
  on(el, '#s5-redir', 'change', (e) => { S.exportOpts.withRedirects = e.target.checked; $('#s5-redir-fields', el)?.classList.toggle('hidden', !e.target.checked); });
  on(el, '#s5-oldbase', 'input', (e) => { S.exportOpts.oldBase = e.target.value; });
  on(el, '#s5-newbase', 'input', (e) => { S.exportOpts.newBase = e.target.value; });
  on(el, '#s5-export', 'click', doExport);
  return el;
}
async function doExport() {
  S.busy = true; S.progressPhase = null; renderStatusbar();
  const direction = `${S.src}-to-${S.tgt}`;
  const buildOpts = () => {
    // mode 'export': the only run that touches credits — checked here, consumed
    // once by conv:save after the file is written.
    const o = { mode: 'export', ...fileRef(), direction, expectPlatform: S.src, overrides: S.overrides, corrections: S.corrections, weightUnit: S.answers.weightUnit, dateOrder: S.answers.dateOrder };
    if (S.exportOpts.withRedirects && S.exportOpts.oldBase && S.exportOpts.newBase) { o.redirectOldBase = S.exportOpts.oldBase; o.redirectNewBase = S.exportOpts.newBase; }
    return o;
  };
  try {
    let res = await window.eloshon.conv.run(buildOpts());
    if (await handleQuestions(res)) res = await window.eloshon.conv.run(buildOpts());
    if (!res.ok) {
      if (res.reason === 'no_converter_credits' || res.reason === 'insufficient_converter_credits') { toast(t('no_credits'), 'err'); return; }
      if (res.reason === 'unknown_account') { toast(t('license_bad'), 'err'); return; }
      openErrorDialog(res.errors?.[0]); return;
    }
    const save = await window.eloshon.conv.save({
      outputCsv: res.outputCsv, redirectsCsv: res.redirectsCsv, baseName: S.exportOpts.baseName,
      exportDir: S.exportOpts.exportDir || S.config.exportDir, withRedirects: S.exportOpts.withRedirects, splitEvery: S.exportOpts.split ? 500 : 0,
    });
    if (save?.canceled) return;
    if (save?.error) { openErrorDialog({ code: 'unrecognized', params: {} }, save.error); return; }
    S.exported = save;
    S.exportedCap = (res.freeCap && res.freeCap.applied) ? res.freeCap : null;
    await window.eloshon.history.add({ src: S.src, tgt: S.tgt, file: S.file.name, products: res.counts.outputUnits, status: (S.issues.counts.warning > 0 ? 'warn' : 'ok'), dir: save.dir });
    renderScreen('step5');
  } catch (err) {
    // An engine-worker failure must surface, never leave the UI stuck busy.
    openErrorDialog({ code: 'engine_failed' }, String((err && err.message) || err));
  } finally {
    S.busy = false; renderStatusbar();
  }
}
function renderExported() {
  const save = S.exported; const cr = S.convResult;
  const el = screenEl(`<div class="scroll" style="display:flex;flex-direction:column;align-items:center">
    <div style="width:100%;max-width:620px;display:flex;flex-direction:column;align-items:center;text-align:center;animation:rise .2s ease-out;padding-top:24px">
      <span style="width:54px;height:54px;border-radius:50%;background:var(--ok-bg);border:1px solid var(--ok);display:flex;align-items:center;justify-content:center;color:var(--ok)">${IC.check}</span>
      <h1 style="margin:16px 0 6px;font-size:24px;font-weight:600;letter-spacing:-.02em">${t('s5_done_title')}</h1>
      <p class="muted" style="margin:0 0 20px;font-size:13.5px">${t('s5_done_sub', { n: nf(save.files.length) })}</p>
      ${S.exportedCap ? `<div class="banner warn" style="width:100%;margin:0 0 16px;text-align:left">${IC.lock}<span>${t('free_capped', { cap: nf(S.exportedCap.limit) })} ${t('free_note', { cap: nf(S.exportedCap.limit), n: nf(cr.counts.outputUnits) })}</span></div>` : ''}
      <div class="card" style="width:100%;text-align:left;overflow:hidden">
        ${save.files.map((f, i) => `<div class="row gap10" style="padding:13px 15px;${i < save.files.length - 1 ? 'border-bottom:1px solid var(--line-subtle)' : ''}">
          <span style="width:30px;height:30px;border-radius:var(--r-sm);background:var(--sunken);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;color:var(--accent-ink)">${IC.folder}</span>
          <span class="mono" style="font-size:13px">${esc(f.name)}</span></div>`).join('')}
      </div>
      <div class="card2 mono" style="width:100%;margin-top:11px;padding:11px 13px;border-radius:var(--r-md);background:var(--sunken);border:1px solid var(--line);font-size:11px;color:var(--ink-2);text-align:left;word-break:break-all">${esc(save.dir)}</div>
      <div class="btn-row" style="margin-top:20px;justify-content:center;flex-wrap:wrap">
        <button class="btn primary" id="ex-open">${IC.folder}${t('s5_open_folder')}</button>
        <button class="btn" id="ex-new">${t('s5_new')}</button>
      </div>
    </div>
  </div>`);
  on(el, '#ex-open', 'click', () => window.eloshon.file.openFolder(save.dir));
  on(el, '#ex-new', 'click', () => { startWizard(); });
  return el;
}

// ── History ───────────────────────────────────────────────────────────────────
function renderHistory() {
  const el = screenEl(`<div class="scroll">
    <div class="row" style="justify-content:space-between;align-items:flex-end;margin-bottom:16px">
      <div><h1 class="title">${t('h_title')}</h1><p class="sub" style="margin:0">${t('h_sub')}</p></div>
      <button class="btn sm" id="h-clear">${t('h_clear')}</button>
    </div>
    <div id="h-body"></div></div>`);
  loadHistoryTable($('#h-body', el));
  on(el, '#h-clear', 'click', async () => { await window.eloshon.history.clear(); loadHistoryTable($('#h-body', el)); });
  return el;
}
async function loadHistoryTable(host) {
  const items = await window.eloshon.history.get();
  if (!items.length) { host.innerHTML = `<div class="card pad muted">${t('h_empty')}</div>`; return; }
  host.innerHTML = `<div class="card"><div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>${t('h_date')}</th><th>${t('h_conversion')}</th><th>${t('h_file')}</th><th class="num">${t('s4_products')}</th><th>${t('h_status')}</th><th></th></tr></thead>
    <tbody>${items.map((h) => `<tr>
      <td class="muted mono nowrap">${esc(fmtDate(h.at))}</td>
      <td><span class="pair"><span class="pbadge">${platIcon(h.src)}</span>${platName(h.src)} ${IC.swap} <span class="pbadge">${platIcon(h.tgt)}</span>${platName(h.tgt)}</span></td>
      <td class="mono" style="font-size:12px;color:var(--ink-2)">${esc(h.file || '')}</td>
      <td class="num">${h.products != null ? nf(h.products) : '—'}</td>
      <td><span class="chip ${h.status === 'fail' ? 'blocking' : h.status === 'warn' ? 'warning' : 'ok'}"><span class="d"></span>${h.status === 'fail' ? t('h_fail') : h.status === 'warn' ? t('h_warn') : t('h_done')}</span></td>
      <td class="num"><div class="btn-row" style="justify-content:flex-end"><button class="btn xs" data-reopen="${esc(h.id)}">${t('h_reopen')}</button><button class="btn xs ghost" data-del="${esc(h.id)}" aria-label="${esc(t('delete'))}" title="${esc(t('delete'))}">${IC.trash}</button></div></td>
    </tr>`).join('')}</tbody></table></div>
    <div class="row" style="justify-content:space-between;padding:11px 14px;border-top:1px solid var(--line-subtle);background:var(--sunken);font-size:12px;color:var(--muted)"><span class="mono">${nf(items.length)}</span></div></div>`;
  on(host, '[data-reopen]', 'click', (e) => { const h = items.find((x) => x.id === e.currentTarget.getAttribute('data-reopen')); if (h) { S.src = h.src; S.tgt = h.tgt; renderScreen('step1'); } });
  on(host, '[data-del]', 'click', async (e) => { await window.eloshon.history.remove(e.currentTarget.getAttribute('data-del')); loadHistoryTable(host); });
}

// ── Templates ─────────────────────────────────────────────────────────────────
function renderTemplates() {
  const el = screenEl(`<div class="scroll">
    <div class="row" style="justify-content:space-between;align-items:flex-end;margin-bottom:16px">
      <div><h1 class="title">${t('t_title')}</h1><p class="sub" style="margin:0">${t('t_sub')}</p></div>
      <button class="btn primary sm" id="t-import">${IC.plus}${t('t_new')}</button>
    </div><div id="t-body"></div></div>`);
  loadTemplates($('#t-body', el));
  on(el, '#t-import', 'click', async () => { const r = await window.eloshon.tpl.import(); if (r?.template) { toast(t('t_saved'), 'ok'); loadTemplates($('#t-body', el)); } else if (r?.error) toast(r.error, 'err'); });
  return el;
}
async function loadTemplates(host) {
  const list = await window.eloshon.tpl.list();
  if (!list.length) { host.innerHTML = `<div class="card pad muted">${t('t_empty')}</div>`; return; }
  host.className = 'grid'; host.style.gridTemplateColumns = 'repeat(auto-fill, minmax(320px, 1fr))';
  host.innerHTML = list.map((tpl) => `<div class="card pad" style="display:flex;flex-direction:column;gap:12px">
    <div class="row" style="justify-content:space-between;align-items:flex-start"><div><div style="font-size:14.5px;font-weight:600">${esc(tpl.name)}</div>
      <div class="muted" style="font-size:12px;margin-top:4px">${t('t_fields', { n: nf(Object.keys(tpl.overrides || {}).length) })}</div></div>
      <button class="btn xs ghost" data-del="${esc(tpl.id)}" aria-label="${esc(t('delete'))}" title="${esc(t('delete'))}">${IC.trash}</button></div>
    <div class="pair"><span class="pbadge">${platIcon((tpl.direction || '').split('-to-')[0])}</span>${platName((tpl.direction || '').split('-to-')[0])} ${IC.swap} <span class="pbadge">${platIcon((tpl.direction || '').split('-to-')[1])}</span>${platName((tpl.direction || '').split('-to-')[1])}</div>
    <div class="row gap8" style="padding-top:12px;border-top:1px solid var(--line-subtle)"><span class="muted" style="font-size:11px">${t('t_modified', { date: fmtDate(tpl.updatedAt) })}</span><span class="spacer"></span>
      <button class="btn xs" data-dup="${esc(tpl.id)}">${t('t_dup')}</button><button class="btn xs" data-export="${esc(tpl.id)}">${t('t_export')}</button></div>
  </div>`).join('');
  on(host, '[data-del]', 'click', (e) => openDeleteTplDialog(e.currentTarget.getAttribute('data-del'), host));
  on(host, '[data-dup]', 'click', async (e) => { await window.eloshon.tpl.duplicate(e.currentTarget.getAttribute('data-dup')); loadTemplates(host); });
  on(host, '[data-export]', 'click', async (e) => { const r = await window.eloshon.tpl.export(e.currentTarget.getAttribute('data-export')); if (r?.path) toast(t('tpl_exported'), 'ok'); });
}

// ── Settings ──────────────────────────────────────────────────────────────────
function renderSettings() {
  const c = S.config;
  const el = screenEl(`<div class="scroll">
    <h1 class="title">${t('set_title')}</h1><p class="sub">${t('set_sub')}</p>
    <div style="max-width:780px;display:flex;flex-direction:column;gap:12px">
      <div class="card"><div class="card-hd">${t('set_general')}</div>
        <div class="set-row"><span class="lbl">${t('set_lang')}<small>${t('set_lang_note')}</small></span>
          <span class="seg" role="group" aria-label="${t('set_lang')}">${LANGS.map((l) => `<button class="${S.lang === l ? 'on' : ''}" data-lang="${l}" lang="${l}" aria-pressed="${S.lang === l}">${LANG_NAMES[l]}</button>`).join('')}</span></div>
        <div class="set-row"><span class="lbl">${t('set_theme')}<small>${t('set_theme_note')}</small></span>
          <span class="seg" role="group" aria-label="${t('set_theme')}"><button class="${S.theme === 'system' ? 'on' : ''}" data-theme="system" aria-pressed="${S.theme === 'system'}">${t('set_system')}</button><button class="${S.theme === 'light' ? 'on' : ''}" data-theme="light" aria-pressed="${S.theme === 'light'}">${t('set_light')}</button><button class="${S.theme === 'dark' ? 'on' : ''}" data-theme="dark" aria-pressed="${S.theme === 'dark'}">${t('set_dark')}</button></span></div>
        <div class="set-row"><span class="lbl">${t('set_exportdir')}</span>
          <span class="row gap8"><span class="mono muted" style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.exportDir || '')}</span><button class="btn sm" id="set-dir">${t('s5_browse')}</button></span></div>
      </div>
      <div class="card"><div class="card-hd">${t('set_csv')}</div>
        <div class="set-row"><span class="lbl">${t('set_enc')}<small>${t('set_enc_note')}</small></span>
          <span class="seg"><button class="${c.encoding !== 'utf8' ? 'on' : ''}" data-enc="utf8bom">UTF-8 + BOM</button><button class="${c.encoding === 'utf8' ? 'on' : ''}" data-enc="utf8">UTF-8</button></span></div>
        <div class="set-row"><span class="lbl">${t('set_semantic')}<small>${t('set_semantic_note')}</small></span>
          <span class="seg"><button class="${c.semantic !== false ? 'on' : ''}" data-semantic="1">${t('set_on')}</button><button class="${c.semantic === false ? 'on' : ''}" data-semantic="0">${t('set_off')}</button></span></div>
      </div>
      <div class="card"><div class="card-hd">${t('set_lic')}</div>
        <div class="set-row"><span class="lbl">${t('set_lic_key')}</span>
          <span class="row gap8">${S.license.activated
    ? `<span class="chip ok"><span class="d"></span>${t('license_ok')}</span><span class="mono muted">${esc(S.license.keyMasked || '')}</span><button class="btn sm" id="lic-off">${t('set_lic_deactivate')}</button>`
    : `<span class="chip none"><span class="d"></span>${t('set_lic_free')}</span><button class="btn sm primary" id="lic-on">${t('set_lic_manage')}</button>`}</span></div>
      </div>
    </div></div>`);
  on(el, '[data-lang]', 'click', async (e) => { S.lang = uiLang(e.currentTarget.getAttribute('data-lang')); S.config = await window.eloshon.config.set({ lang: S.lang }); applyLang(); renderChrome(); renderScreen('settings'); });
  on(el, '[data-theme]', 'click', async (e) => { S.theme = e.currentTarget.getAttribute('data-theme'); S.config = await window.eloshon.config.set({ theme: S.theme }); applyTheme(); renderScreen('settings'); });
  on(el, '[data-enc]', 'click', async (e) => { S.config = await window.eloshon.config.set({ encoding: e.currentTarget.getAttribute('data-enc') }); renderScreen('settings'); });
  on(el, '[data-semantic]', 'click', async (e) => { S.config = await window.eloshon.config.set({ semantic: e.currentTarget.getAttribute('data-semantic') === '1' }); renderScreen('settings'); });
  on(el, '#set-dir', 'click', async () => { const d = await window.eloshon.file.chooseDir(); if (d) { S.config = await window.eloshon.config.set({ exportDir: d }); renderScreen('settings'); } });
  on(el, '#lic-on', 'click', openUnlockDialog);
  on(el, '#lic-off', 'click', async () => { S.license = await window.eloshon.license.deactivate(); renderChrome(); renderScreen('settings'); });
  return el;
}

// ── Help ──────────────────────────────────────────────────────────────────────
function renderHelp() {
  const cols = [
    [t('help_export_from'), ['Shopify', 'WooCommerce', 'Wix', 'BigCommerce']],
    [t('help_import_into'), ['WooCommerce', 'Shopify', 'Wix', 'BigCommerce']],
    [t('help_understand'), [t('help_t_variants'), t('help_t_images'), t('help_t_blocking'), t('nav_templates')]],
  ];
  return screenEl(`<div class="scroll">
    <h1 class="title">${t('help_title')}</h1><p class="sub">${t('help_sub')}</p>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr));max-width:1000px">
      ${cols.map(([title, items]) => `<div class="card pad"><div style="font-size:13px;font-weight:600;margin-bottom:11px">${title}</div>
        <div class="help-links">${items.map((i) => `<a href="#">${esc(i)}</a>`).join('')}</div></div>`).join('')}
    </div>
    <div class="card pad" style="max-width:1000px;margin-top:12px">
      <div class="row gap10">${IC.lock}<span class="muted" style="font-size:13px">${t('local_badge')}</span></div>
    </div></div>`);
}

// ── Dialogs ───────────────────────────────────────────────────────────────────
function dialog(html) {
  const host = $('#dialog-host');
  host.innerHTML = `<div class="overlay">${html}</div>`;
  on(host, '[data-close]', 'click', closeDialog);
  host.querySelector('.overlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeDialog(); });
  return host;
}
function closeDialog() { $('#dialog-host').innerHTML = ''; }

function openFixDialog(p) {
  const host = dialog(`<div class="dialog">
    <div class="hd"><span class="ic or">${IC.arrowsmall}</span><div><h3>${t('s4_fix_title')}</h3><p>${t('s4_fix_hint')}</p></div></div>
    <div class="bd"><label class="field"><span class="lbl">${t('s4_new_value')}</span><input class="inp" id="fix-val" value="${esc(p.suggestion || p.value || '')}"></label></div>
    <div class="ft"><button class="btn ghost" data-close>${t('cancel')}</button><button class="btn primary" id="fix-ok">${t('save')}</button></div></div>`);
  const input = $('#fix-val', host); input.focus(); input.select();
  on(host, '#fix-ok', 'click', async () => {
    const val = input.value;
    if (p.line != null && p.field) {
      S.corrections[p.line] = { ...(S.corrections[p.line] || {}), [p.field]: val };
      closeDialog();
      // corrections change counts too → re-run convert + issues
      await goStep4();
    } else closeDialog();
  });
}

function openDeleteTplDialog(id, host) {
  dialog(`<div class="dialog">
    <div class="hd"><span class="ic err">${IC.trash}</span><div><h3>${t('dlg_delete_tpl_title')}</h3><p>${t('dlg_delete_tpl_body')}</p></div></div>
    <div class="ft"><button class="btn ghost" data-close>${t('cancel')}</button><button class="btn danger" id="del-ok">${t('delete')}</button></div></div>`);
  on($('#dialog-host'), '#del-ok', 'click', async () => { await window.eloshon.tpl.remove(id); closeDialog(); loadTemplates(host); });
}

// Ask the user to resolve a `weight_unit` question raised by a BigCommerce
// products file (the Weight column has no unit label). Returns 'kg' | 'lbs'
// on choice, null on cancel. The answer lives on S.answers.weightUnit and is
// passed back on every subsequent convert until the file changes.
function askWeightUnit(question) {
  return new Promise((resolve) => {
    dialog(`<div class="dialog" style="width:440px">
      <div class="hd"><span class="ic or">${IC.alert}</span><div><h3>${t('dlg_weight_title')}</h3><p>${esc(diag(question.code, question.params))}</p></div></div>
      <div class="bd" style="display:flex;flex-direction:column;gap:10px">
        <button class="btn primary" id="wu-kg">${t('dlg_weight_kg')}</button>
        <button class="btn" id="wu-lbs">${t('dlg_weight_lbs')}</button>
        <div class="muted" style="font-size:12px">${t('dlg_weight_hint')}</div>
      </div>
      <div class="ft"><button class="btn ghost" data-close id="wu-cancel">${t('cancel')}</button><span></span></div></div>`);
    const host = $('#dialog-host');
    on(host, '#wu-kg', 'click', () => { closeDialog(); resolve('kg'); });
    on(host, '#wu-lbs', 'click', () => { closeDialog(); resolve('lbs'); });
    on(host, '#wu-cancel', 'click', () => { closeDialog(); resolve(null); });
    host.querySelector('.overlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) { closeDialog(); resolve(null); } });
  });
}

// Ask the user to resolve a `date_format` question raised by an order file
// whose dates read both ways (MM/DD vs DD/MM — e.g. "04/05/2026"). Returns
// 'MDY' | 'DMY' on choice, null on cancel. The answer lives on
// S.answers.dateOrder and is passed back on every subsequent convert until
// the file changes.
function askDateOrder() {
  return new Promise((resolve) => {
    dialog(`<div class="dialog" style="width:440px">
      <div class="hd"><span class="ic or">${IC.alert}</span><div><h3>${t('dlg_date_title')}</h3><p>${t('dlg_date_body')}</p></div></div>
      <div class="bd" style="display:flex;flex-direction:column;gap:10px">
        <button class="btn primary" id="do-dmy">${t('dlg_date_dmy')}</button>
        <button class="btn" id="do-mdy">${t('dlg_date_mdy')}</button>
        <div class="muted" style="font-size:12px">${t('dlg_date_hint')}</div>
      </div>
      <div class="ft"><button class="btn ghost" data-close id="do-cancel">${t('cancel')}</button><span></span></div></div>`);
    const host = $('#dialog-host');
    on(host, '#do-dmy', 'click', () => { closeDialog(); resolve('DMY'); });
    on(host, '#do-mdy', 'click', () => { closeDialog(); resolve('MDY'); });
    on(host, '#do-cancel', 'click', () => { closeDialog(); resolve(null); });
    host.querySelector('.overlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) { closeDialog(); resolve(null); } });
  });
}

function openErrorDialog(err, extra) {
  const detail = (err ? diag(err.code, err.params) : '') + (extra ? '\n' + extra : '');
  dialog(`<div class="dialog" style="width:468px">
    <div class="hd"><span class="ic err">${IC.alert}</span><div><h3>${t('dlg_error_title')}</h3><p>${t('dlg_error_body')}</p></div></div>
    <div class="bd"><div class="card2 mono" style="background:var(--sunken);border:1px solid var(--line-subtle);border-radius:var(--r-sm);padding:11px 12px;font-size:11px;color:var(--ink-2);white-space:pre-wrap">${esc(detail)}</div></div>
    <div class="ft spread"><button class="btn ghost" id="err-copy">${t('copy_detail')}</button><span><button class="btn ghost" data-close>${t('close')}</button></span></div></div>`);
  on($('#dialog-host'), '#err-copy', 'click', () => { navigator.clipboard?.writeText(detail); toast(t('detail_copied'), 'ok'); });
}

function openUnlockDialog() {
  dialog(`<div class="dialog">
    <div class="hd"><span class="ic or">${IC.lock}</span><div><h3>${t('unlock_title')}</h3><p>${S.info?.licensePrice ? esc(t('unlock_price', { price: moneyf(S.info.licensePrice.amount, S.info.licensePrice.currency) })) + ' ' : ''}${t('unlock_hint')}</p></div></div>
    <div class="bd"><label class="field"><span class="lbl">${t('unlock_key')}</span><input class="inp mono" id="lic-key" placeholder="ELO-XXXX-XXXX-XXXX"></label>
      <div id="lic-msg" class="muted" style="font-size:11px;margin-top:8px"></div></div>
    <div class="ft"><button class="btn ghost" data-close>${t('cancel')}</button><button class="btn primary" id="lic-activate">${t('unlock_activate')}</button></div></div>`);
  const host = $('#dialog-host'); const input = $('#lic-key', host); input.focus();
  on(host, '#lic-activate', 'click', async () => {
    const r = await window.eloshon.license.activate(input.value);
    if (r.ok) { S.license = r.license; closeDialog(); renderChrome(); toast(t('license_ok'), 'ok'); if (['step5', 'settings'].includes(S.screen)) renderScreen(S.screen); }
    else { $('#lic-msg', host).textContent = t('license_bad'); $('#lic-msg', host).style.color = 'var(--danger)'; }
  });
}

async function saveTemplateDialog() {
  const name = await promptDialog(t('s3_save_tpl'), t('t_name'), (S.file?.name || '').replace(/\.[^.]+$/, ''));
  if (!name) return;
  await window.eloshon.tpl.create({
    name, direction: `${S.src}-to-${S.tgt}`, sourceFormat: S.analysis.detection.format, targetFormat: S.analysis.targetFormat,
    entity: S.analysis.detection.entity, overrides: S.overrides, headers: parseHeaders(S.file.text), edits: S.edits, outEdits: S.outEdits,
    // the custom fields' places for this platform travel with the template
    customTargets: { [S.tgt]: (S.config.customTargets || {})[S.tgt] || {} },
  });
  toast(t('t_saved'), 'ok');
}
async function applyTemplateDialog() {
  const list = await window.eloshon.tpl.list();
  const forDir = list.filter((tpl) => tpl.direction === `${S.src}-to-${S.tgt}`);
  if (!forDir.length) { toast(t('t_empty'), 'err'); return; }
  const host = dialog(`<div class="dialog"><div class="hd"><span class="ic or">${IC.nav_templates}</span><div><h3>${t('s3_use_tpl')}</h3></div></div>
    <div class="bd"><div style="display:flex;flex-direction:column;gap:8px">${forDir.map((tpl) => `<button class="btn" style="justify-content:flex-start" data-tpl="${esc(tpl.id)}">${esc(tpl.name)}</button>`).join('')}</div></div>
    <div class="ft"><button class="btn ghost" data-close>${t('cancel')}</button></div></div>`);
  on(host, '[data-tpl]', 'click', async (e) => {
    const id = e.currentTarget.getAttribute('data-tpl');
    const r = await window.eloshon.tpl.apply(id, parseHeaders(S.file.text));
    S.overrides = { ...r.overrides }; S.edits = Array.isArray(r.edits) ? r.edits : []; S.outEdits = Array.isArray(r.outEdits) ? r.outEdits : []; closeDialog();
    // the template's custom-field places become this platform's (remembered on this computer too)
    if (r.customTargets && r.customTargets[S.tgt]) { const all = { ...(S.config.customTargets || {}), [S.tgt]: { ...((S.config.customTargets || {})[S.tgt] || {}), ...r.customTargets[S.tgt] } }; S.config.customTargets = all; window.eloshon.config.set({ customTargets: all }).catch?.(() => {}); }
    if (r.missingColumns?.length || r.overridesOnMissing?.length) toast(t('tpl_missing_cols', { cols: [...r.missingColumns, ...r.overridesOnMissing.map((o) => o.column)].join(', ') }), 'err');
    if (S.edits.length) { await refreshAfterEdits(); return; }
    renderScreen('step3');
  });
}
function promptDialog(title, label, def) {
  return new Promise((resolve) => {
    const host = dialog(`<div class="dialog"><div class="hd"><span class="ic or">${IC.plus}</span><div><h3>${esc(title)}</h3></div></div>
      <div class="bd"><label class="field"><span class="lbl">${esc(label)}</span><input class="inp" id="prompt-in" value="${esc(def || '')}"></label></div>
      <div class="ft"><button class="btn ghost" data-close>${t('cancel')}</button><button class="btn primary" id="prompt-ok">${t('save')}</button></div></div>`);
    const input = $('#prompt-in', host); input.focus(); input.select();
    const done = (v) => { closeDialog(); resolve(v); };
    on(host, '#prompt-ok', 'click', () => done(input.value.trim()));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(input.value.trim()); });
    host.querySelector('[data-close]').addEventListener('click', () => resolve(null));
  });
}

// ── Data editor (before conversion) ───────────────────────────────────────────
// The user's own edits to the file: rename / add / delete a column, replace, remove, add
// or cut text, insert a character at chosen places, fix prices… Each operation is a
// ready-made "formula" (its Google Sheets equivalent is shown). The list lives in S.edits
// and rides along with every engine call (fileRef); the original file is never changed.
let EDIT_CAT = null;
async function editCatalog() { if (!EDIT_CAT) EDIT_CAT = await window.eloshon.edits.catalog(); return EDIT_CAT; }
const edText = (o) => engineText(o);
const edId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
const ED_NEEDS_COLUMN = (op) => !['add_column', 'join_columns'].includes(op);
const ED_COLUMN_ONLY = new Set(['rename_column', 'copy_column', 'delete_column']); // no "all columns" for these

function outHeaders() { return S.previewHeaders && S.previewHeaders.length ? S.previewHeaders : S.previewCsv ? splitCsvLine(S.previewCsv.split(/\r\n|\n|\r/)[0] || '') : []; }
function currentHeaders() { return S.editedHeaders && S.editedHeaders.length ? S.editedHeaders : parseHeaders(S.file.text); }

async function refreshAfterEdits() {
  // headers as the engine now sees them (a rename / add / delete changes them)
  S.editedHeaders = null;
  if (S.edits.length) {
    const first = parseHeaders(S.file.text)[0] || '';
    const r = await window.eloshon.edits.preview(fileRef(), S.edits, first);
    if (r && r.ok) S.editedHeaders = r.headers;
  }
  // a mapping that points at a column the edits removed or renamed would silently feed nothing
  const have = new Set(currentHeaders());
  for (const [id, ov] of Object.entries(S.overrides)) if (ov && ov.column && !have.has(ov.column)) delete S.overrides[id];
  await reanalyze();
  renderScreen('step3');
}

function describeEdit(e, cat) {
  if (e.op === 'set_cell') {
    const a = e.args || {};
    return `<div style="font-weight:600">${esc(t('ed_set_cell'))} · <span class="mono">${esc(e.column)}</span> · ${esc(t('ed_row'))} ${esc(a.row)}</div>
      <div class="muted" style="font-size:12px">“${esc(String(a.text ?? '').slice(0, 160))}”</div>`;
  }
  const entry = cat.entries.find((x) => x.op === e.op);
  const label = entry ? edText(entry).label : e.op;
  const col = e.column === '*' ? t('ed_all_columns') : e.column;
  const a = e.args || {};
  // a choice reads as its label (« Mode : Texte seul »), not as its stored value
  const shown = (k, v) => { const spec = entry && entry.args.find((x) => x.key === k); const c = spec && spec.choices && spec.choices.find((x) => x.value === v); return c ? `${edText(spec)}: ${edText(c)}` : `${k}: “${Array.isArray(v) ? v.join(' + ') : v}”`; };
  const bits = Object.entries(a).filter(([, v]) => v !== '' && v !== false && v !== undefined && !(Array.isArray(v) && !v.length)).map(([k, v]) => shown(k, v));
  const cond = e.when && (e.when.contains || e.when.equals || e.when.startsWith || e.when.endsWith || e.when.empty || e.when.notEmpty) ? ` · ${t('ed_only_if')} ${esc(e.when.column || e.column)} ${esc(Object.entries(e.when).filter(([k]) => k !== 'column' && k !== 'ignoreCase').map(([k, v]) => `${t('ed_cmp_' + k)}${typeof v === 'string' ? ` “${v}”` : ''}`).join(', '))}` : '';
  return `<div style="font-weight:600">${esc(label)}${ED_NEEDS_COLUMN(e.op) ? ` · <span class="mono">${esc(col)}</span>` : ''}</div>
    <div class="muted" style="font-size:12px">${esc(bits.join(' · '))}${cond}</div>`;
}

async function editsCardHtml() {
  const cat = await editCatalog();
  const rows = S.edits.map((e, i) => `<div class="row gap10" style="padding:9px 0;border-top:1px solid var(--line-subtle);align-items:flex-start">
      <span class="chip none" style="margin-top:2px">${i + 1}</span><div style="flex:1;min-width:0">${describeEdit(e, cat)}</div>
      <button class="btn xs ghost" data-ed-del="${esc(e.id)}">${t('ed_remove')}</button></div>`).join('');
  const hints = (S.editHints || []).filter((h) => !S.edits.some((e) => e.column === h.column && (e.op === 'number'))).map((h) => `<div class="banner warn" style="margin-top:10px">${IC.alert}<span style="flex:1">${t('ed_hint_cents', { column: esc(h.column), sample: esc(h.sample) })}</span><button class="btn xs" data-ed-hint="${esc(h.column)}">${t('ed_hint_fix')}</button></div>`).join('');
  return `<div class="card" style="margin-top:14px"><div class="card-hd">${t('ed_title')}
      <span class="muted" style="font-weight:400">${t('ed_sub')}</span></div>
    <div style="padding:6px 16px 14px">
      ${hints}
      ${rows || `<div class="muted" style="padding:8px 0">${t('ed_none')}</div>`}
      <div class="row gap10" style="margin-top:10px"><button class="btn" id="ed-add">${IC.plus}${t('ed_add')}</button>
      ${S.edits.length ? `<button class="btn ghost" id="ed-clear">${t('ed_clear')}</button>` : ''}</div>
    </div></div>`;
}

async function renderEditsCard(host) {
  if (!host || !S.file) return;
  // a one-time look for prices that are probably in cents (1599 for 15,99)
  if (S.editHints === undefined) {
    S.editHints = [];
    try { const r = await window.eloshon.edits.suggest(fileRef()); if (r && r.ok) S.editHints = r.hints; } catch { /* the hint is a courtesy */ }
  }
  host.innerHTML = await editsCardHtml();
  on(host, '#ed-add', 'click', () => openEditDialog());
  on(host, '#ed-clear', 'click', async () => { S.edits = []; await refreshAfterEdits(); });
  on(host, '[data-ed-del]', 'click', async (e) => { const id = e.currentTarget.getAttribute('data-ed-del'); S.edits = S.edits.filter((x) => x.id !== id); await refreshAfterEdits(); });
  on(host, '[data-ed-hint]', 'click', async (e) => {
    const column = e.currentTarget.getAttribute('data-ed-hint');
    S.edits.push({ id: edId(), op: 'number', column, args: { action: 'divide', value: 100 } });
    await refreshAfterEdits();
  });
}

// The same editor, aimed at the file that will be IMPORTED (Shopify's / Woo's / Wix's columns):
// rename an output column, fill or replace text in it, add a column. Applied after conversion.
async function renderOutEditsCard(host) {
  if (!host) return;
  const cat = await editCatalog();
  const rows = S.outEdits.map((e, i) => `<div class="row gap10" style="padding:8px 0;border-top:1px solid var(--line-subtle);align-items:flex-start">
      <span class="chip none" style="margin-top:2px">${i + 1}</span><div style="flex:1;min-width:0">${describeEdit(e, cat)}</div>
      <button class="btn xs ghost" data-oed-del="${esc(e.id)}">${t('ed_remove')}</button></div>`).join('');
  host.innerHTML = `<div style="padding:10px 0 12px"><div style="font-weight:600">${t('ed_out_title')}</div>
    <div class="muted" style="font-size:13px;margin:2px 0 6px">${t('ed_out_sub', { target: esc(platName(S.tgt)) })}</div>
    ${S.tgt === 'shopify' ? `<label class="row gap10" style="font-size:13px;margin:6px 0 2px;align-items:flex-start"><input type="checkbox" id="oed-coll" ${S.categoriesAsTags ? 'checked' : ''} style="margin-top:3px"><span>${t('ed_coll_tags')}<span class="muted" style="display:block;font-size:12px">${t('ed_coll_help')}</span></span></label>` : ''}
    <label class="row gap10" style="font-size:13px;margin:8px 0 2px;align-items:center;flex-wrap:wrap"><span>${t('ed_stock_label')}</span><select id="oed-stock" class="inp" style="width:auto">${STOCK_MODES.map((m) => `<option value="${m}" ${(stockModeOf(S.tgt) || (isScrapedSource() ? 'untracked' : 'source')) === m ? 'selected' : ''}>${esc(t(`ed_stock_${m}`))}</option>`).join('')}</select></label>
    <div class="muted" style="font-size:12px;margin:0 0 4px">${t('ed_stock_help')}</div>
    ${rows}<div class="row gap10" style="margin-top:8px"><button class="btn xs" id="oed-add">${IC.plus}${t('ed_out_add')}</button>${S.outEdits.length ? `<button class="btn xs ghost" id="oed-clear">${t('ed_clear')}</button>` : ''}</div></div>`;
  on(host, '#oed-add', 'click', () => openEditDialog('out'));
  on(host, '#oed-coll', 'change', (e) => { S.categoriesAsTags = e.target.checked; renderScreen('step3'); });
  on(host, '#oed-stock', 'change', (e) => { setStockMode(S.tgt, e.target.value); renderScreen('step3'); });
  on(host, '#oed-clear', 'click', () => { S.outEdits = []; renderScreen('step3'); });
  on(host, '[data-oed-del]', 'click', (e) => { const id = e.currentTarget.getAttribute('data-oed-del'); S.outEdits = S.outEdits.filter((x) => x.id !== id); renderScreen('step3'); });
}

async function openEditDialog(mode = 'src') {
  const cat = await editCatalog();
  const out = mode === 'out';
  const headers = out ? outHeaders() : currentHeaders();
  const target = out ? S.outEdits : S.edits;
  const st = { choice: 'op:replace', column: headers[0] || '', when: { column: '', cmp: '', text: '' }, timer: 0 };
  const opts = cat.groups.map((g) => `<optgroup label="${esc(edText(g))}">${cat.entries.filter((e) => e.group === g.id).map((e) => `<option value="op:${esc(e.op)}">${esc(edText(e).label)}</option>`).join('')}</optgroup>`).join('');
  const recipes = `<optgroup label="${esc(t('ed_recipes'))}">${cat.presets.map((p) => `<option value="preset:${esc(p.id)}">${esc(edText(p))}</option>`).join('')}</optgroup>`;
  const host = dialog(`<div class="dialog wide"><div class="hd"><span class="ic or">${IC.plus}</span><div><h3>${out ? t('ed_out_add') : t('ed_add')}</h3><p>${out ? t('ed_out_sub', { target: platName(S.tgt) }) : t('ed_sub')}</p></div></div>
    <div class="bd" style="display:flex;flex-direction:column;gap:12px">
      <label class="field"><span class="lbl">${t('ed_what')}</span><select class="inp" id="ed-op">${recipes}${opts}</select></label>
      <div id="ed-help" class="muted" style="font-size:13px"></div>
      <label class="field" id="ed-col-wrap"><span class="lbl">${t('ed_column')}</span><select class="inp" id="ed-col"></select></label>
      <div id="ed-args" style="display:flex;flex-direction:column;gap:10px"></div>
      <div id="ed-cond" class="field"><span class="lbl">${t('ed_only_if')}</span>
        <div class="row gap10"><select class="inp" id="ed-cond-col" style="flex:1"></select>
        <select class="inp" id="ed-cond-cmp" style="flex:1"><option value="">${t('ed_cond_any')}</option>${['contains', 'equals', 'startsWith', 'endsWith', 'empty', 'notEmpty'].map((k) => `<option value="${k}">${t('ed_cmp_' + k)}</option>`).join('')}</select>
        <input class="inp" id="ed-cond-text" style="flex:1" placeholder="…"></div></div>
      <div id="ed-formula" class="mono muted" style="font-size:12px"></div>
      <div><div class="lbl" style="font-size:12px;font-weight:500;color:var(--muted);margin-bottom:6px">${t('ed_preview')}</div>
        <div class="tbl-wrap h"><table class="tbl ed-prev"><thead><tr><th style="width:50%">${t('ed_before')}</th><th>${t('ed_after')}</th></tr></thead><tbody id="ed-prev"></tbody></table></div>
        <div id="ed-err" style="color:var(--danger);font-size:13px;margin-top:6px"></div></div>
    </div>
    <div class="ft"><button class="btn ghost" data-close>${t('cancel')}</button><button class="btn primary" id="ed-ok">${t('ed_add_ok')}</button></div></div>`);

  const sel = (id) => $(id, host);
  const colOptions = (withAll) => (withAll ? `<option value="*">${esc(t('ed_all_columns'))}</option>` : '') + headers.map((h) => `<option value="${esc(h)}">${esc(h)}</option>`).join('');
  sel('#ed-cond-col').innerHTML = `<option value="">${esc(t('ed_cond_samecol'))}</option>` + headers.map((h) => `<option value="${esc(h)}">${esc(h)}</option>`).join('');

  const entryOf = () => (st.choice.startsWith('op:') ? cat.entries.find((e) => e.op === st.choice.slice(3)) : null);
  const presetOf = () => (st.choice.startsWith('preset:') ? cat.presets.find((p) => p.id === st.choice.slice(7)) : null);

  function renderArgs() {
    const entry = entryOf(); const preset = presetOf();
    const argsHost = sel('#ed-args');
    sel('#ed-help').textContent = entry ? edText(entry).help : preset ? engineText(preset.hint) : '';
    sel('#ed-formula').textContent = entry ? t('ed_formula', { f: entry.sheets }) : '';
    const needCol = preset ? true : ED_NEEDS_COLUMN(entry.op);
    sel('#ed-col-wrap').style.display = needCol ? '' : 'none';
    const keepAll = !preset && entry && !ED_COLUMN_ONLY.has(entry.op) && entry.group !== 'column';
    sel('#ed-col').innerHTML = colOptions(keepAll);
    if (headers.includes(st.column) || (keepAll && st.column === '*')) sel('#ed-col').value = st.column; else { st.column = sel('#ed-col').value; }
    sel('#ed-cond').style.display = entry && entry.group !== 'column' ? '' : 'none';
    argsHost.innerHTML = (entry ? entry.args : []).map((a) => {
      const lbl = edText(a);
      if (a.type === 'bool') return `<label class="row gap10" style="font-size:13px"><input type="checkbox" data-arg="${a.key}"> ${esc(lbl)}</label>`;
      // a choice whose options carry their own rule shows the picked one's rule under the list
      if (a.type === 'choice' && a.choices.some((c) => c.help)) {
        const pick = a.choices.find((c) => c.value === a.default) || a.choices[0];
        return `<div class="field"><label class="lbl" for="ed-arg-${a.key}">${esc(lbl)}</label><select class="inp" id="ed-arg-${a.key}" data-arg="${a.key}" data-choice-help="ed-arg-${a.key}-help" aria-describedby="ed-arg-${a.key}-help">${a.choices.map((c) => `<option value="${c.value}"${c === pick ? ' selected' : ''}>${esc(edText(c))}</option>`).join('')}</select>
          <p class="cap" id="ed-arg-${a.key}-help">${esc(engineText(pick.help))}</p></div>`;
      }
      if (a.type === 'choice') return `<label class="field"><span class="lbl">${esc(lbl)}</span><select class="inp" data-arg="${a.key}">${a.choices.map((c) => `<option value="${c.value}"${c.value === a.default ? ' selected' : ''}>${esc(edText(c))}</option>`).join('')}</select></label>`;
      if (a.type === 'column') return `<label class="field"><span class="lbl">${esc(lbl)}</span><select class="inp" data-arg="${a.key}">${headers.map((h) => `<option value="${esc(h)}"${h === (st.from || '') ? ' selected' : ''}>${esc(h)}</option>`).join('')}</select></label>`;
      if (a.type === 'longtext') return `<label class="field"><span class="lbl">${esc(lbl)}</span><textarea class="inp" rows="3" data-arg="${a.key}" placeholder="${esc(a.placeholder || '')}"></textarea></label>`;
      if (a.type === 'columns') return `<div class="field"><span class="lbl">${esc(lbl)}</span><div style="display:flex;flex-wrap:wrap;gap:6px 14px">${headers.map((h) => `<label style="font-size:13px"><input type="checkbox" data-cols="${a.key}" value="${esc(h)}"> ${esc(h)}</label>`).join('')}</div></div>`;
      return `<label class="field"><span class="lbl">${esc(lbl)}</span><input class="inp" ${a.type === 'number' ? 'type="number"' : ''} data-arg="${a.key}" placeholder="${esc(a.placeholder || '')}" value="${esc(a.default !== undefined ? String(a.default) : '')}"></label>`;
    }).join('') + (entry && entry.op === 'words_from' ? '<div id="ed-learn"></div>' : '');
    argsHost.querySelectorAll('[data-choice-help]').forEach((s) => s.addEventListener('change', () => {
      const a = entry.args.find((x) => x.key === s.getAttribute('data-arg'));
      const c = a && a.choices.find((x) => x.value === s.value);
      $(`#${s.getAttribute('data-choice-help')}`, host).textContent = c ? engineText(c.help) : '';
    }));
    if (entry && entry.op === 'words_from') { const f = argsHost.querySelector('[data-arg="from"]'); if (f && !f.value) f.selectedIndex = Math.max(0, headers.findIndex((h) => /title|titre|name|nom|libell/i.test(h))); st.from = f ? f.value : ''; }
    schedule();
  }

  // "Multi-word names": a few example rows, each with the number of words that make the name.
  // Picking 2 on "Under Armour Hovr…" teaches "Under Armour" to the list, which then applies to every row.
  async function renderLearn() {
    const host2 = sel('#ed-learn'); if (!host2) return;
    const from = (host.querySelector('[data-arg="from"]') || {}).value; if (!from) { host2.innerHTML = ''; return; }
    const r = await window.eloshon.edits.preview(out ? { csvText: S.previewCsv } : fileRef(), out ? [] : S.edits, from);
    if (!r || !r.ok || !$('#ed-learn', host)) return;
    const known = host.querySelector('[data-arg="known"]');
    const done = r.before.map((txt) => { const w = String(txt).trim().split(/\s+/).filter(Boolean); return { w, n: 1 }; });
    st.learnRows = done;
    host2.innerHTML = `<div class="lbl" style="font-size:12px;font-weight:500;color:var(--muted);margin:2px 0 6px">${t('ed_learn_title')}</div>
      <div class="tbl-wrap"><table class="tbl"><tbody>${done.map((d, i) => `<tr><td class="mono" style="width:70%">${esc(d.w.slice(0, 6).join(' '))}</td><td><select class="inp" data-learn="${i}">${[1, 2, 3, 4].map((n) => `<option value="${n}">${t('ed_learn_words', { n })}</option>`).join('')}</select></td></tr>`).join('')}</tbody></table></div>`;
    host2.querySelectorAll('[data-learn]').forEach((el) => el.addEventListener('change', (ev) => {
      ev.stopPropagation();
      const d = done[Number(el.getAttribute('data-learn'))]; const n = Number(el.value);
      const prefix = d.w.slice(0, n).join(' ');
      const fold = (x) => x.toLowerCase();
      const whole = fold(d.w.join(' '));
      // drop the names that already start this row (the new choice replaces them), then add the chosen one
      const lines = known.value.split(/[\n;]+/).map((x) => x.trim()).filter(Boolean).filter((x) => !(whole === fold(x) || whole.startsWith(fold(x) + ' ')));
      if (n > 1) lines.push(prefix);
      known.value = lines.join('\n');
      schedule();
    }));
  }

  function readArgs(entry) {
    const args = {};
    for (const a of entry.args) {
      if (a.type === 'columns') { args[a.key] = [...host.querySelectorAll(`[data-cols="${a.key}"]:checked`)].map((i) => i.value); continue; }
      const inp = host.querySelector(`[data-arg="${a.key}"]`); if (!inp) continue;
      if (a.type === 'bool') { if (inp.checked) args[a.key] = true; continue; }
      if (a.type === 'number') { if (inp.value !== '') args[a.key] = Number(inp.value); continue; }
      args[a.key] = inp.value;
    }
    return args;
  }
  function readWhen() {
    const cmp = sel('#ed-cond-cmp').value; if (!cmp || sel('#ed-cond').style.display === 'none') return undefined;
    const w = { ignoreCase: true };
    const col = sel('#ed-cond-col').value; if (col) w.column = col;
    if (cmp === 'empty' || cmp === 'notEmpty') w[cmp] = true; else w[cmp] = sel('#ed-cond-text').value;
    return w;
  }

  async function candidates() {
    const entry = entryOf(); const preset = presetOf();
    if (preset) return window.eloshon.edits.expand(preset.id, st.column);
    const e = { id: edId(), op: entry.op, column: ED_NEEDS_COLUMN(entry.op) ? (sel('#ed-col').value || st.column) : '*', args: readArgs(entry) };
    const when = readWhen(); if (when) e.when = when;
    return [e];
  }

  let seq = 0;
  async function refreshPreview() {
    const my = ++seq;
    const list = await candidates();
    if (!list.length) return;
    const target = list[list.length - 1];
    const previewColumn = target.op === 'add_column' || target.op === 'join_columns' ? (target.args.to || '') : (target.column === '*' ? headers[0] : target.column);
    // output mode: the preview file ALREADY carries the edits made so far, only the new ones are applied
    const r = await window.eloshon.edits.preview(out ? { csvText: S.previewCsv } : fileRef(), out ? list : [...S.edits, ...list], previewColumn);
    if (my !== seq) return; // a newer keystroke already asked
    const err = r && r.ok ? r.report.slice(out ? 0 : S.edits.length).find((x) => x.error) : null;
    sel('#ed-err').textContent = err ? t('ed_err_' + err.error) : (r && !r.ok ? r.error : '');
    sel('#ed-prev').innerHTML = r && r.ok ? r.before.map((b, i) => `<tr><td class="mono">${esc(b)}</td><td class="mono"><b>${esc(r.after[i] ?? '')}</b></td></tr>`).join('') : '';
    st.last = { list, error: !!err };
    if (entryOf() && entryOf().op === 'words_from' && !host.querySelector('#ed-learn table')) renderLearn();
  }
  function schedule() { clearTimeout(st.timer); st.timer = setTimeout(refreshPreview, 200); }

  sel('#ed-op').addEventListener('change', (e) => { st.choice = e.target.value; renderArgs(); });
  sel('#ed-col').addEventListener('change', (e) => { st.column = e.target.value; schedule(); });
  host.addEventListener('change', (e) => { if (e.target && e.target.getAttribute && e.target.getAttribute('data-arg') === 'from') { st.from = e.target.value; renderLearn(); } });
  host.addEventListener('input', schedule); host.addEventListener('change', schedule);
  on(host, '#ed-ok', 'click', async () => {
    await refreshPreview();
    if (!st.last || st.last.error) return;
    target.push(...st.last.list);
    closeDialog();
    toast(t('ed_added'), 'ok');
    if (out) renderScreen('step3'); else await refreshAfterEdits();
  });
  renderArgs();
}

// ── Toasts ────────────────────────────────────────────────────────────────────
function toast(msg, kind = 'ok') {
  const host = $('#toast-host');
  const n = document.createElement('div');
  n.className = `toast ${kind}`;
  n.innerHTML = `<span class="dot">${kind === 'ok' ? IC.check : IC.alert}</span><span>${esc(msg)}</span>`;
  host.appendChild(n);
  setTimeout(() => n.remove(), 3600);
}

// ── Selftest hook (used by main --selftest) ───────────────────────────────────
window.__selftest = async function () {
  const screens = ['home', 'step1', 'step2', 'history', 'templates', 'settings', 'help'];
  const walked = [];
  const until = async (pred, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
  try {
    if (!window.eloshon) return { ok: false, error: 'no eloshon bridge' };
    for (const s of screens) { renderScreen(s); walked.push(s); }
    // Phase 5.6 — semantic step 3: a Shopify-shaped file with French headers
    // must surface candidates; confirming one is remembered (re-analysis shows
    // "decided") and feeds the mapping as an override.
    S.src = 'shopify'; S.tgt = 'woocommerce';
    // Libellé = auto (pre-filled override); Prix public conseillé / Poids brut = grey zone (candidates to confirm)
    const csv = ['Handle,Libellé,Variant SKU,Variant Price,Prix public conseillé,Poids brut',
      't-shirt,T-shirt bio,TS-S,19.90,24.90,0.3',
      't-shirt,,TS-M,19.90,24.90,0.35',
      'mug,Mug émaillé,MUG-1,12.00,14.90,0.4'].join('\n');
    await onFileLoaded({ name: 'selftest.csv', size: csv.length, text: csv, path: '' });
    walked.push('step2:file');
    const semantic = !!(S.analysis.plan && S.analysis.plan.semantic);
    renderScreen('step3'); walked.push('step3');
    // One row per column; a proposal is confirmed through « Modifier » (the current destination + Valider).
    const rowEl = (col) => document.querySelector(`.m-row[data-col="${CSS.escape(col)}"]`);
    const openEdit = (col) => { S.mapFilter = 'all'; drawRows($('#s3-body')); rowEl(col)?.querySelector('.m-edit')?.click(); return !!document.querySelector('#m-list'); };
    const pickOption = (text) => { const o = [...document.querySelectorAll('#m-list .m-opt')].find((n) => n.textContent.includes(text)); o?.click(); return !!o; };
    let semanticWalk = { semantic, candidates: 0, confirmed: false, override: null, rows: document.querySelectorAll('.m-row').length };
    if (semantic) {
      S.mapFilter = 'all'; drawRows($('#s3-body'));
      semanticWalk.candidates = document.querySelectorAll('.m-row[data-proposal]').length;
      // The FR title column is pre-filled as an override (auto) → shown applied, « À vérifier »
      semanticWalk.override = S.overrides.title ? S.overrides.title.column : null;
      const row = document.querySelector('.m-row[data-proposal]');
      if (row) {
        const col = row.dataset.col;
        openEdit(col);
        document.querySelector('#m-ok').click();
        semanticWalk.confirmed = await until(() => !S.busy && S.screen === 'step3' && rowEl(col) && !rowEl(col).hasAttribute('data-proposal'), 8000);
        const decisions = await window.eloshon.kb.decisions(S.analysis.detection.knowledgeId);
        semanticWalk.recorded = decisions.some((d) => d.fieldPath === col && (d.action === 'confirmed' || d.action === 'corrected'));
        semanticWalk.overrideAfter = Object.values(S.overrides).some((o) => o && o.column === col);
        semanticWalk.column = col;
        walked.push('step3:confirm');
      }
    }
    // Phase 6.7 — candidate context walk: a Shopify-shaped file carrying a typed
    // identifier (EAN → feeds the barcode rule), an app-injected metafield
    // namespace (carried, never proposed), a merchant metafield and a locale-
    // suffixed title (translation). Each must be explained on its row.
    S.file = null; S.analysis = null; S.overrides = {}; S.src = 'shopify'; S.tgt = 'woocommerce';
    const ctxCsv = ['Handle,Title,Title (en),Variant SKU,Variant Price,EAN,Condition (product.metafields.mm-google-shopping.condition),Matiere (product.metafields.custom.matiere)',
      'tasse,Tasse émaillée,Enamel mug,TS-1,12.00,4006381333931,new,acier',
      'bol,Bol en grès,Stoneware bowl,BL-1,18.00,4006381333948,new,grès',
      'plat,Plat à four,Oven dish,PL-1,29.00,4006381333955,new,fonte'].join('\n');
    await onFileLoaded({ name: 'context-67.csv', size: ctxCsv.length, text: ctxCsv, path: '' });
    renderScreen('step3'); walked.push('step3:context');
    S.mapFilter = 'all'; drawRows($('#s3-body'));
    const semCol = (col) => S.analysis.plan.semantic.columns.find((c) => c.column === col);
    const appCol = 'Condition (product.metafields.mm-google-shopping.condition)', mineCol = 'Matiere (product.metafields.custom.matiere)';
    const contextWalk = {
      eanOverride: S.overrides.barcode ? S.overrides.barcode.column : null,
      eanSemantic: semCol('EAN') && semCol('EAN').best ? semCol('EAN').best.canon : null,
      eanBridged: (S.analysis.plan.ruleByCanon || {})['identifiers.ean'] || null,
      appListed: !!rowEl(appCol), appOwner: rowEl(appCol)?.dataset.owner || null, appExplained: rowEl(appCol)?.dataset.reason === 'third_party',
      mineOwner: rowEl(mineCol)?.dataset.owner || null,
      appCandidates: semCol(appCol) ? semCol(appCol).candidates.map((c) => c.canon) : null,
      trRow: !!rowEl('Title (en)'), trLocale: rowEl('Title (en)')?.dataset.locale || null,
      rows: document.querySelectorAll('.m-row').length,
    };
    walked.push('step3:context-checked');
    // Phase 5.7 — learn walk: an UNKNOWN supplier CSV (FR, semicolons) must be
    // learnable, remembered through the UI, then recognised and previewable.
    S.src = 'eloshon'; S.tgt = 'shopify'; S.file = null; S.analysis = null; S.overrides = {};
    const unknownCsv = ['Référence;Désignation;Prix de vente;Code EAN;Stock disponible;Visuel;Rayon;Marque',
      'F-001;Table basse chêne;129,90;3701234567890;12;https://cdn.x/a.jpg;Maison > Salon;Eloshon',
      'F-002;Chaise scandinave;59,00;3701234567906;0;https://cdn.x/b.jpg;Maison > Salon;Eloshon',
      'F-003;Lampe de bureau;39,90;3701234567913;5;https://cdn.x/c.png;Maison > Bureau;Lumo'].join('\n');
    await onFileLoaded({ name: 'fournisseur-x.csv', size: unknownCsv.length, text: unknownCsv, path: '' });
    const learnWalk = { unknown: S.analysis.detection.format === 'unknown', learnable: !!S.analysis.learn, learned: null, recognised: false, previewRows: 0 };
    if (learnWalk.learnable) {
      renderScreen('step3'); walked.push('step3:learn');
      S.mapFilter = 'all'; drawRows($('#s3-body'));
      learnWalk.rows = document.querySelectorAll('.m-row').length;
      learnWalk.pills = document.querySelectorAll('#s3-pills .pill').length;
      learnWalk.samples = document.querySelectorAll('.m-row .l2.vals').length;
      // « Modifier » → custom field: "_" goes in at the caret, nothing around it is replaced; Échap closes.
      if (openEdit('Marque') && pickOption(t('s3n_m_custom'))) {
        const inp = document.querySelector('#m-key');
        learnWalk.customEditorShown = !document.querySelector('#m-custom').hidden;
        if (inp) {
          inp.value = 'brandorigin'; inp.setSelectionRange(5, 5);
          const us = document.querySelector('#m-custom .us-btn');
          us.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          us.click();
          learnWalk.underscoreInserted = inp.value; learnWalk.caretAfter = inp.selectionStart;
        }
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        learnWalk.closedByEsc = !document.querySelector('#m-list');
      }
      const nameInput = document.querySelector('#learn-name'); if (nameInput) nameInput.value = 'Fournisseur X';
      const save = document.querySelector('#learn-save');
      if (save) {
        save.click();
        await until(() => !S.busy && S.analysis && S.analysis.knowledge, 8000);
        learnWalk.learned = S.analysis.knowledge ? S.analysis.knowledge.id : null;
        learnWalk.recognised = S.analysis.detection.format === 'knowledge';
        await until(() => document.querySelector('#s3-preview-body table'), 8000);
        learnWalk.previewRows = document.querySelectorAll('#s3-preview-body tbody tr').length;
        walked.push('step3:learned');
      }
    }
    // Reference edit walk — a Scraper CSV (Reference format): re-point
    // technical_specs to a custom field typed with the "_" button, see the
    // preview follow, then restore the shipped mapping.
    S.src = 'eloshon'; S.tgt = 'shopify'; S.file = null; S.analysis = null; S.overrides = {};
    const refCsv = ['slug_fr,slug_en,name_fr,name_en,description_fr,description_en,price,category_slug,barcode,hs_code,weight_kg,image_url,store_slug,source_url,source_product_id,source_category,product_type,storage_info,is_alcoholic,color,variants,weight_estimated,brand,availability,rating,review_count,net_content,technical_specs',
      'trail-2-a1,trail-2-a1,Trail 2,Trail 2,Chaussure légère.,,89.99,,4012345678901,,0.45,https://cdn.x/t.jpg,shop,https://shop.x/p/t,T2,Sport,Chaussures,,,,,,Kalenji,InStock,4.6,128,450 g,"{""Poids"":""450 g"",""Matière"":""cuir""}"'].join('\n');
    await onFileLoaded({ name: 'scraper-ref.csv', size: refCsv.length, text: refCsv, path: '' });
    const refWalk = { detected: S.analysis?.knowledge?.id || null, editable: 0, edited: null, previewHasKey: false, restored: false };
    if (refWalk.detected) {
      renderScreen('step3');
      S.mapFilter = 'all'; drawRows($('#s3-body'));
      refWalk.editable = document.querySelectorAll('.m-row .m-edit').length;
      if (openEdit('technical_specs') && pickOption(t('s3n_m_custom'))) {
        const inp = document.querySelector('#m-key');
        inp.value = 'fichetechnique'; inp.setSelectionRange(5, 5);
        document.querySelector('#m-custom .us-btn').click();
        refWalk.typed = inp.value;
        document.querySelector('#m-ok').click();
        await until(() => !S.busy && S.analysis?.knowledge?.edited?.technical_specs, 8000);
        refWalk.edited = S.analysis?.knowledge?.edited?.technical_specs || null;
        await until(() => document.querySelector('#s3-preview-body table'), 8000);
        refWalk.previewHasKey = [...document.querySelectorAll('#s3-preview-body th')].some((th) => /fiche_technique/.test(th.textContent));
        const reset = document.querySelector('#kn-reset-all');
        if (reset) { reset.click(); await until(() => !S.busy && S.analysis?.knowledge && !Object.keys(S.analysis.knowledge.edited || {}).length, 8000); refWalk.restored = !Object.keys(S.analysis.knowledge.edited || {}).length; }
      }
      walked.push('step3:reference-edit');
    }
    // Phase 2 Lot 1 — the Scraper's products.json dropped as-is: recognised in
    // step 2, its knowledge map shown in step 3, exportable in step 4.
    S.file = null; S.analysis = null; S.overrides = {}; S.src = 'eloshon'; S.tgt = 'shopify';
    renderScreen('step2');
    const hintShown = !!document.querySelector('.banner.info') && /products\.json/.test(document.querySelector('#main').textContent);
    const pj = JSON.stringify([{ store_slug: 'demo', source_url: 'https://shop.example/p/a', source_product_id: 'A-1', source_category: 'Maison > Déco', product_type: null,
      name_fr: 'Vase en verre', name_en: 'Vase en verre', description_fr: 'Vase soufflé.', description_en: 'Vase soufflé.', storage_info: null, price: 39.9, weight_kg: 0.8,
      barcode: null, hs_code: null, images: ['https://shop.example/a1.jpg', 'https://shop.example/a2.jpg'], image_url: 'https://shop.example/a1.jpg', category_slug: null,
      color: null, variants: null, seller: 'Partenaire 7', raw: { brand: 'Verrerie', currency: 'EUR', list_price: 49.9, availability: 'InStock', weight_text: null, volume_l: null, pack_count: null,
        breadcrumb: ['Maison', 'Déco'], sku: 'A-1', mpn: null, gtin: null } }]);
    await onFileLoaded({ name: 'products.json', size: pj.length, text: pj, path: '' });
    const pjWalk = { hintShown, detected: S.analysis.detection.knowledgeId, mapRows: 0, canExport: false, outputUnits: 0 };
    renderScreen('step3');
    pjWalk.mapRows = document.querySelectorAll('#s3-body tbody tr').length;
    await goStep4();
    pjWalk.canExport = !!(S.issues && S.issues.canExport);
    pjWalk.outputUnits = S.convResult?.counts?.outputUnits ?? 0;
    // the undocumented key and the promotable raw fields are listed, never silently dropped
    pjWalk.preserved = Array.from(document.querySelectorAll('#s4-preserved-card [data-field]')).map((n) => n.getAttribute('data-field'));
    walked.push('step4:products-json');
    if (!(semanticWalk.confirmed && semanticWalk.recorded && learnWalk.learned && learnWalk.underscoreInserted === 'brand_origin' && learnWalk.closedByEsc
      && refWalk.edited && refWalk.previewHasKey && refWalk.restored && contextWalk.appExplained && contextWalk.trLocale === 'en')) {
      return { ok: false, error: 'step-3 walk failed', semanticWalk, learnWalk, refWalk, contextWalk, walked };
    }
    if (!(pjWalk.hintShown && pjWalk.detected === 'scraper.products-json.v1' && pjWalk.mapRows > 10 && pjWalk.canExport && pjWalk.outputUnits === 1
      && pjWalk.preserved.includes('seller') && pjWalk.preserved.includes('raw.currency'))) {
      return { ok: false, error: 'products.json walk failed', pjWalk, walked };
    }
    // Phase 2 Lot 2 — an .eloshon catalogue: canon-native note in step 3, its
    // edit log applied, and the engine's report visible in the step-4 notes.
    S.file = null; S.analysis = null; S.overrides = {}; S.src = 'eloshon'; S.tgt = 'woocommerce';
    const vp = { optionValues: [], sku: 'E-1', price: 19.9, compareAtPrice: null, cost: null, barcode: '', grams: null, lengthCm: null, widthCm: null, heightCm: null, requiresShipping: true, taxable: true, inventoryQty: null, imageSrc: '' };
    const env = JSON.stringify({ eloshon: { kind: 'catalog', version: 1, generator: 'selftest', createdAt: '2026-10-04T00:00:00Z' }, source: { type: 'manual' },
      catalog: { products: [{ id: 'e1', handle: 'tasse', title: 'Tasse', bodyHtml: '', vendor: '', productType: '', tags: [], status: 'active', categories: [], published: true, options: [], variants: [vp], images: [], metafields: [], seoTitle: '', seoDescription: '' }] },
      edits: { revision: 1, commands: [{ id: 'c1', at: '2026-10-04T00:00:00Z', kind: 'set-field', productId: 'e1', field: 'title', value: 'Tasse émaillée', label: 'selftest' }] } });
    await onFileLoaded({ name: 'catalogue.eloshon', size: env.length, text: env, path: '' });
    const eloWalk = { detected: S.analysis.detection.knowledgeId, canonNote: false, noteCodes: [], title: null };
    renderScreen('step3');
    eloWalk.canonNote = /\.eloshon/.test(document.querySelector('#s3-body .banner')?.textContent || '');
    await goStep4();
    eloWalk.noteCodes = Array.from(document.querySelectorAll('#s4-notes-card [data-code]')).map((n) => n.getAttribute('data-code'));
    eloWalk.title = S.convResult?.ok ? 'ok' : 'failed';
    walked.push('step4:eloshon');
    if (!(eloWalk.detected === 'eloshon.catalog.v1' && eloWalk.canonNote && eloWalk.noteCodes.includes('eloshon_edits_applied') && eloWalk.title === 'ok' && S.issues?.canExport)) {
      return { ok: false, error: '.eloshon walk failed', eloWalk, walked };
    }
    // Phase 1 step 4 — ambiguous order dates: entering step 4 must raise the
    // date-order dialog, and the chosen answer must resolve the question on
    // the re-run (S.answers.dateOrder is the only path that sets it).
    S.file = null; S.analysis = null; S.overrides = {}; S.src = 'woocommerce'; S.tgt = 'shopify';
    const ordCsv = ['ORDERID,order_status,order_date,order_currency,order_total,order_tax,order_shipping,billing_email,billing_first_name,billing_last_name,billing_country,item_name,item_type,item_product_id,item_qty,item_line_total',
      '6001,wc-completed,03/04/2026 10:30:00,EUR,52.50,8.75,6.00,marie@example.com,Marie,Lefèvre,BE,"T-shirt bio,Mug émaillé","line_item,line_item","2001,2002","2,1","38.00,14.50"',
      '6002,wc-processing,05/06/2026 16:05:00,EUR,25.00,0.00,0.00,dave@example.com,Dave,Miller,US,Écharpe alpaga,line_item,2005,1,25.00'].join('\n');
    await onFileLoaded({ name: 'orders-ambiguous.csv', size: ordCsv.length, text: ordCsv, path: '' });
    const dateWalk = { questionRaised: false, answered: null, resolved: false };
    const p4 = goStep4();
    dateWalk.questionRaised = await until(() => document.querySelector('#do-dmy'));
    if (dateWalk.questionRaised) document.querySelector('#do-dmy').click();
    await p4;
    dateWalk.answered = S.answers.dateOrder || null;
    dateWalk.resolved = !!S.convResult && S.convResult.ok === true
      && !(S.convResult.questions || []).some((q) => q && q.kind === 'date_format')
      && S.screen === 'step4';
    walked.push('step4:date-order');
    if (!(dateWalk.questionRaised && dateWalk.answered === 'DMY' && dateWalk.resolved)) {
      return { ok: false, error: 'date-order dialog walk failed', dateWalk, walked };
    }
    S.file = null; S.analysis = null; S.overrides = {}; S.src = 'shopify'; S.tgt = 'woocommerce';
    renderScreen('home');
    return { ok: true, screens: walked, semanticWalk, learnWalk, refWalk, contextWalk, pjWalk, eloWalk, dateWalk };
  } catch (err) { return { ok: false, error: String(err && err.stack || err), walked }; }
};

boot().catch((err) => { document.body.innerHTML = `<pre style="color:var(--chrome-ink);padding:20px">${String(err && err.stack || err)}</pre>`; });
