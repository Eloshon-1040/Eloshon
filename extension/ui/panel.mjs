/**
 * Interactive side-panel UI (Thunderbit-style): a menu (Champs / Pages / Résultats /
 * Réglages), an AI-driven field editor (add/remove fields, per-field AI hint), page
 * options (pagination, sub-pages), a result preview with accept/reject/export, and a
 * Run button. Dependency-free (CSP script-src 'self'). State persists per tab-origin.
 *
 * The AI "Détecter par IA" and "Exécuter" actions message the service worker, which
 * runs the deterministic + (opt-in) AI extraction and the app round-trip. This file
 * owns only the UI and local state.
 */
import { requestDomainPermission, hasDomainPermission, originsForDomain } from '../background/permissions.mjs';
import { fieldKeys, ROLES, ROLE_LABEL, suggestRole, roleOf } from '../vendor/shared/extract/field-meaning.mjs';
import { manifestSummaryFr, exportStem, manifestFileName } from '../vendor/shared/export/manifest.mjs';
import { mergeRowsByUrl } from '../vendor/shared/export/merge-rows.mjs';
import { panelManifest, exportWarning, acceptPlanText, appWhy } from './read-state.mjs';
import { normalizeConstants, applyConstantsToRow, constantColumns, CONSTANT_ROLES, ATTRIBUTE_TERMS, STATUS_VALUES } from '../vendor/shared/export/constants.mjs';
import { summarize } from '../background/enrich-queue.mjs';
import { batchKeyOf, batchLabelOf, levelOf, splitConstants, sameConstants } from '../vendor/shared/export/site-values.mjs';

const $ = (sel) => document.querySelector(sel);
const hasChrome = typeof chrome !== 'undefined' && chrome.runtime;

// Field templates per content type — so the panel scrapes products, videos, blogs,
// directories, etc. out of the box (the AI and the user can still add/remove any).
const TEMPLATES = {
  produits: [['name', 'Nom'], ['price', 'Prix'], ['list_price', 'Prix barré'], ['brand', 'Marque'], ['category', 'Collection'], ['image', 'Image'], ['url', 'Lien'], ['sku', 'Référence']],
  // Holiday rentals / lodgings: a card line like "Chambre · Charleroi" gives the type and
  // the city (click on the word wanted), "9–11 oct. · Particulier" the dates and the host.
  locations: [['name', 'Titre'], ['type', 'Type de logement'], ['city', 'Ville'], ['dates', 'Dates'], ['host', 'Hôte'], ['price', 'Prix'], ['rating', 'Note'], ['image', 'Image'], ['url', 'Lien']],
  videos: [['title', 'Titre'], ['url', 'Lien'], ['thumbnail', 'Vignette'], ['duration', 'Durée'], ['views', 'Vues'], ['channel', 'Chaîne'], ['tags', 'Tags']],
  articles: [['title', 'Titre'], ['url', 'Lien'], ['author', 'Auteur'], ['date', 'Date'], ['excerpt', 'Extrait'], ['image', 'Image']],
  contacts: [['name', 'Nom'], ['email', 'E-mail'], ['phone', 'Téléphone'], ['company', 'Société'], ['url', 'Lien']],
  generique: [['title', 'Titre'], ['url', 'Lien'], ['image', 'Image'], ['description', 'Description']],
};
const mkFields = (name) => (TEMPLATES[name] || TEMPLATES.produits).map(([key, label]) => ({ key, label, hint: '' }));
const DEFAULT_FIELDS = mkFields('produits');
const FIELD_ICON = { name: 'Aa', title: 'Aa', price: '€', list_price: '€', ean: '#', brand: '®', category: '🗂', type: 'Aa', city: '📍', dates: '📅', host: 'Aa', rating: '★', image: '🖼', thumbnail: '🖼', url: '🔗', sku: '#', tags: '#', views: '#', duration: '#', email: '✉', phone: '☎', date: '📅', author: 'Aa', channel: 'Aa', company: 'Aa', excerpt: '¶', description: '¶', default: 'Aa' };

const state = {
  template: 'produits',
  fields: DEFAULT_FIELDS.map((f) => ({ ...f })),
  settings: { pagination: 'auto', maxPages: 5, subpages: true, lang: 'fr', maxProducts: 500, maxProductPages: 0 },
  rows: null,
  meta: null,
  constants: null, // fixed values for every product of this site (set in load())
  accepted: null, // the « Accepter » reply: what was read on each product page (null = the rows are a preview)
  card: null, // repeated product card selector of the fields designated with the mouse
  origin: '',
  batch: { key: null, label: '', url: '' }, // the list page whose batch values are on screen (site-values.mjs)
  hub: null, // a hub page: { links:[{name,url}], useName } — its sub-collections are read by « Exécuter »
  local: { site: false, batch: false }, // what this browser kept for the site / the batch
  saved: { site: null, batch: null, online: false, checked: false, reason: '' }, // what the app holds (« Enregistrer »)
  seenUrl: '',
};

function applyTemplate(name) {
  state.template = name;
  state.fields = mkFields(name);
  state.card = null; // designations belong to the previous field set
  renderFields();
  const sel = $('#template'); if (sel) sel.value = name;
  save();
}

function send(kind, payload = {}) {
  return new Promise((resolve) => {
    if (!hasChrome) return resolve({ ok: false, reason: 'hors extension' });
    try { chrome.runtime.sendMessage({ kind, ...payload }, (r) => resolve(r || { ok: false, reason: chrome.runtime.lastError ? 'indisponible' : 'vide' })); }
    catch { resolve({ ok: false, reason: 'indisponible' }); }
  });
}

async function activeTab() {
  if (!hasChrome || !chrome.tabs) return null;
  try { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); return t || null; } catch { return null; }
}

// ---- persistence (per site, and per list page for the batch values) ---------------------------------
// The SITE (origin) keeps the fields, settings, card and the site-level fixed values (brand); each LIST PAGE (batch,
// shared/export/site-values.mjs) keeps its own collection, type, tags, status and attributes. Changing site or list
// page reloads both: the values of one site, or of one batch, never stay on screen for another.
const DEFAULT_SETTINGS = () => ({ pagination: 'auto', maxPages: 5, subpages: true, lang: 'fr', maxProducts: 500, maxProductPages: 0 });
/** The form's rows: the standard ones always there, in order, then the attributes. */
const formConstants = (list) => [...FIXED_DEFAULT().map((d) => list.find((c) => c && c.role === d.role) || d), ...list.filter((c) => c && c.role === 'attribute')];
const pageOf = (url) => { try { return /^https?:/.test(url) ? { origin: new URL(url).origin, key: batchKeyOf(url), label: batchLabelOf(url) } : { origin: '', key: null, label: '' }; } catch { return { origin: '', key: null, label: '' }; } };
async function load() {
  const tab = await activeTab();
  const page = pageOf((tab && tab.url) || '');
  state.origin = page.origin; state.seenUrl = (tab && tab.url) || '';
  Object.assign(state, { template: 'produits', fields: DEFAULT_FIELDS.map((f) => ({ ...f })), settings: DEFAULT_SETTINGS(), card: null });
  state.batch = { key: page.key, label: page.label, url: (tab && tab.url) || '' };
  state.local = { site: false, batch: false }; state.hub = null;
  let siteC = []; let batchC = [];
  if (hasChrome && chrome.storage) {
    try {
      const all = await chrome.storage.local.get(['panelState', 'panelBatches']);
      const saved = (all.panelState || {})[state.origin];
      if (saved && Array.isArray(saved.fields) && saved.fields.length) { state.fields = saved.fields; state.settings = { ...state.settings, ...(saved.settings || {}) }; if (!saved.settingsV2) state.settings.subpages = true; /* sub-pages now read in the browser: on for sites saved before */ if (saved.template) state.template = saved.template; state.card = saved.card || null; rekey(); }
      // Site level only: a value kept per site by 0.7.32 for a collection or a type is not given to every page of the site.
      siteC = (saved && Array.isArray(saved.constants) ? saved.constants : []).filter((c) => levelOf(c) === 'site');
      state.local.site = !!saved;
      const b = page.key ? (all.panelBatches || {})[page.key] : null;
      if (b && Array.isArray(b.constants)) { batchC = b.constants.filter((c) => levelOf(c) === 'batch'); state.local.batch = true; }
      state.hub = b && b.hub && Array.isArray(b.hub.links) && b.hub.links.length ? b.hub : null;
    } catch { /* fresh */ }
  }
  state.constants = formConstants([...siteC, ...batchC]);
}
async function save() {
  if (!hasChrome || !chrome.storage || !state.origin) return;
  try {
    const all = await chrome.storage.local.get(['panelState', 'panelBatches']);
    const map = all.panelState || {};
    map[state.origin] = { template: state.template, fields: state.fields, settings: state.settings, card: state.card, constants: (state.constants || []).filter((c) => levelOf(c) === 'site'), settingsV2: true };
    const batches = all.panelBatches || {};
    if (state.batch && state.batch.key) batches[state.batch.key] = { label: state.batch.label, url: state.batch.url, constants: (state.constants || []).filter((c) => levelOf(c) === 'batch'), hub: state.hub || null, at: Date.now() };
    // the oldest batches go beyond 300 (storage.local holds 10 MB)
    const keys = Object.keys(batches); if (keys.length > 300) keys.sort((a, b) => (batches[a].at || 0) - (batches[b].at || 0)).slice(0, keys.length - 300).forEach((k) => delete batches[k]);
    await chrome.storage.local.set({ panelState: map, panelBatches: batches });
    state.local = { site: true, batch: !!(state.batch && state.batch.key) };
  } catch { /* ignore */ }
  renderFixedState();
}

// ---- field editor ----------------------------------------------------------
function renderFields() {
  const list = $('#field-list');
  list.innerHTML = '';
  state.fields.forEach((f, i) => {
    const el = document.createElement('div');
    el.className = 'field';
    const ico = FIELD_ICON[f.key] || FIELD_ICON.default;
    el.innerHTML = `
      <div class="top">
        <span class="ico">${ico}</span>
        <input type="text" value="${escapeAttr(f.label)}" data-i="${i}" data-k="label" placeholder="Nom du champ" />
        <button class="iconbtn" title="Invite IA" data-i="${i}" data-act="toggle-hint">✨</button>
        <button class="iconbtn" title="Désigner à la souris" data-i="${i}" data-act="pick">🎯</button>
        <button class="iconbtn" title="Retirer" data-i="${i}" data-act="remove">✕</button>
      </div>
      <div class="meaning"><label>Rôle pour le Converter <select data-i="${i}" data-k="role" aria-label="Rôle de « ${escapeAttr(f.label)} » pour le Converter">${roleOptions(f)}</select></label></div>
      ${f.selector ? `<div class="picked">🎯 Désigné à la souris${f.part ? ' · une partie de la ligne' : ''}${f.all ? ` · liste de ${f.values || 'plusieurs'} valeur(s)` : ''}${f.axis ? ` · option « ${escapeHtml(f.axis)} »` : ''}${state.card === 'body' ? ' · sur cette fiche produit' : ''}${f.sample ? ` · exemple : « ${escapeHtml(String(f.sample).slice(0, 60))} »` : ''} ${f.part ? `<button class="linkbtn" data-i="${i}" data-act="wholetext">texte entier</button> ` : ''}<button class="linkbtn" data-i="${i}" data-act="unpick">annuler</button></div>` : ''}
      <div class="ai" data-hintrow="${i}" style="${f.hint ? '' : 'display:none;'}">
        <textarea data-i="${i}" data-k="hint" placeholder="Invite d'IA pour ce champ (ex: « ici ce sont les tags à afficher »)">${escapeHtml(f.hint || '')}</textarea>
      </div>`;
    list.appendChild(el);
  });
}
function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function escapeAttr(s) { return String(s).replace(/"/g, '&quot;').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

// The role is a choice of its own: « automatique » follows the name (shown), any other choice stays as picked.
function roleOptions(f) {
  const auto = suggestRole(f);
  const cur = f.role && f.role !== 'auto' ? f.role : 'auto';
  return [`<option value="auto"${cur === 'auto' ? ' selected' : ''} data-auto>automatique : ${escapeHtml(ROLE_LABEL[auto])}</option>`, ...ROLES.map((r) => `<option value="${r}"${cur === r ? ' selected' : ''}>${escapeHtml(ROLE_LABEL[r])}</option>`)].join('');
}

function onFieldInput(e) {
  const t = e.target; const i = t.getAttribute('data-i'); const k = t.getAttribute('data-k');
  if (i == null || !k) return;
  state.fields[Number(i)][k] = t.value;
  // A field's role follows its NAME (and hint): "Nom" renamed "Valeur de réduction" is no
  // longer the product name, so a designation on it never overwrites the names.
  if (k === 'label' || k === 'hint' || k === 'role') { rekey(); showMeanings(); }
  save();
}
function onFieldClick(e) {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const i = Number(b.getAttribute('data-i')); const act = b.getAttribute('data-act');
  if (act === 'remove') { state.fields.splice(i, 1); renderFields(); save(); }
  else if (act === 'toggle-hint') { const row = document.querySelector(`[data-hintrow="${i}"]`); if (row) row.style.display = row.style.display === 'none' ? 'flex' : 'none'; }
  else if (act === 'pick') { pickElement(i); }
  else if (act === 'wholetext') { const f = state.fields[i]; delete f.part; if (f.whole) f.sample = f.whole; delete f.whole; renderFields(); save(); }
  else if (act === 'unpick') { const f = state.fields[i]; delete f.selector; delete f.attr; delete f.sample; delete f.part; delete f.whole; delete f.all; delete f.values; delete f.axis; if (!state.fields.some((x) => x.selector)) state.card = null; renderFields(); save(); }
}

// Template labels of the current template (a field keeps its key while it keeps its template name).
function defaultLabels() { return Object.fromEntries((TEMPLATES[state.template] || []).map(([key, label]) => [key, label])); }
function rekey() { const keys = fieldKeys(state.fields, defaultLabels()); state.fields.forEach((f, i) => { f.key = keys[i]; }); }
function showMeanings() { state.fields.forEach((f, i) => { const o = document.querySelector(`select[data-i="${i}"][data-k="role"] option[data-auto]`); if (o) o.textContent = `automatique : ${ROLE_LABEL[suggestRole(f)]}`; }); }

function addField() {
  const n = state.fields.filter((f) => f.custom).length + 1;
  state.fields.push({ key: `champ_${n}`, label: `Champ ${n}`, hint: '', custom: true });
  rekey(); renderFields(); save();
}

// ---- actions (message the worker) ------------------------------------------
const aiReason = (r) => {
  const s = (r && r.reason) || '';
  if (/ai_key_missing/.test(s)) return 'clé IA non configurée dans l’application (réglages administrateur)';
  if (/ai_http_401|ai_http_403/.test(s)) return 'clé IA refusée';
  if (/ai_http_429/.test(s)) return 'service IA saturé — réessaie dans un instant';
  if (/ai_http_/.test(s)) { const d = s.replace(/^ai_http_\w+:?\s*/, ''); return d && d !== s ? d : 'le service IA n’a pas répondu'; }
  if (/ai_unavailable/.test(s)) return 'assistance IA indisponible dans cette version de l’application';
  if (/délai IA dépassé/.test(s)) return 'délai dépassé — la page est peut-être trop volumineuse ; réessayez ou utilisez 🎯';
  if (/^(indisponible|vide)$/.test(s)) return 'le service de l’extension n’a pas répondu — rechargez la page, puis réessayez';
  return s || 'IA indisponible';
};
async function aiDetect() {
  const toast = $('#fields-toast');
  const btn = $('#ai-detect');
  // A click must NEVER stay silent: show a loading state now, always restore the
  // button in `finally`, and turn any failure (even a thrown one) into a clear,
  // actionable message — never a dead button with no feedback.
  if (btn) btn.disabled = true;
  if (toast) toast.textContent = '✨ Analyse de la page par l’IA… (quelques secondes)';
  try {
    const tab = await activeTab();
    if (!tab || tab.id == null) { if (toast) toast.textContent = 'IA : aucun onglet actif — ouvrez la page à analyser, puis réessayez.'; return; }
    // A product page holds ONE product: the detection reads its fields and proposes site rules (tab « Fiche produit »).
    const pk = await send('page_kind', { tabId: tab.id });
    if (pk && pk.ok && pk.kind === 'product') { if (toast) toast.textContent = ''; showTab('learn'); window.dispatchEvent(new CustomEvent('elo-propose')); return; }
    const r = await send('ai_detect', { tabId: tab.id, fields: state.fields, settings: state.settings });
    if (r && r.ok && Array.isArray(r.cards) && !r.cards.length) {
      if (toast) toast.textContent = 'L’IA n’a trouvé aucune liste de produits dans les données de cette page. Cliquez sur « Exécuter maintenant », ou désignez les champs avec 🎯.';
    } else if (r && r.ok && Array.isArray(r.cards)) {
      state.rows = r.cards; state.accepted = null; finished = false;
      const conf = r.hints && r.hints.confidence != null ? ` · confiance ${Math.round(r.hints.confidence * 100)}%` : '';
      renderResults({ method: `IA${conf}` });
      showTab('results');
      if (toast) toast.textContent = `✓ ${r.cards.length} ligne(s) extraite(s) par l’IA.`;
    } else {
      if (toast) toast.textContent = `IA : ${aiReason(r)}.`;
    }
  } catch (e) {
    if (toast) toast.textContent = `IA : échec inattendu (${String((e && e.message) || e).slice(0, 80)}). Réessayez, ou utilisez 🎯 / « Exécuter ».`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// While the page waits for a 🎯 click, the keyboard stays in this panel (its button was clicked): Escape pressed here
// cancels the designation in the page. Every designation goes through this (the card, the hub, « suivant »).
async function withEscape(tab, work) {
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); send('pick_cancel', { tabId: tab && tab.id }); } };
  document.addEventListener('keydown', onKey, true);
  try { return await work(); } finally { document.removeEventListener('keydown', onKey, true); }
}

// 🎯 "Désigner à la souris": the page shows a highlight; the user clicks the element
// of ONE product card that holds this field. Every card is then read the same way.
async function pickElement(i) {
  const toast = $('#fields-toast');
  const f = state.fields[i]; if (!f) return;
  toast.textContent = `Dans la page, cliquez sur « ${f.label} » dans une fiche produit. Échap ou clic droit pour annuler.`;
  const tab = await activeTab();
  // The keyboard stays in this panel while the page waits for the click: Escape
  // pressed here cancels the designation in the page.
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); send('pick_cancel', { tabId: tab && tab.id }); } };
  document.addEventListener('keydown', onKey, true);
  let r;
  try { r = await send('pick_element', { tabId: tab && tab.id, fieldKey: f.key, label: f.label, card: state.card }); }
  finally { document.removeEventListener('keydown', onKey, true); }
  if (r && !r.ok && r.reason === 'annulé') { toast.textContent = `Désignation de « ${f.label} » annulée.`; return; }
  if (!r || !r.ok) { toast.textContent = `« ${f.label} » non défini : ${(r && r.reason) || 'aucune réponse'}.`; return; }
  if (state.card && r.card !== state.card) {
    // A new card: the earlier designations were relative to the old one.
    for (const x of state.fields) if (x !== f) { delete x.selector; delete x.attr; delete x.sample; }
  }
  state.card = r.card;
  f.selector = r.selector; f.attr = r.attr || null; f.sample = r.sample || '';
  if (r.part) { f.part = r.part; f.whole = r.whole || ''; } else { delete f.part; delete f.whole; }
  if (r.all) { f.all = r.all; f.values = r.values || 0; } else { delete f.all; delete f.values; }
  // A picker the shopper chooses from (sizes, swatches): an option axis, named as the page names it.
  if (r.axis) f.axis = r.axis; else delete f.axis;
  if (r.chooser && (!f.role || f.role === 'auto')) { const sr = suggestRole({ label: r.axis || f.label }); f.role = ['size', 'color', 'option', 'variant_name', 'variants'].includes(sr) ? sr : 'option'; rekey(); }
  renderFields(); save();
  const partOf = r.part && r.whole ? `, la partie cliquée de « ${String(r.whole).slice(0, 60)} »` : '';
  const bodyHint = r.card === 'body' ? ' (fiche produit seule — pour apprendre le site entier, utilise l’onglet « Fiche produit »)' : '';
  toast.textContent = `✓ « ${f.label} » défini${bodyHint}${r.sample ? ` (exemple : « ${String(r.sample).slice(0, 60)} »${partOf})` : ''} — ${r.cards} fiche(s) repérée(s) sur la page.${r.part ? ' Pour garder la ligne entière, cliquez sur « texte entier ».' : ''}`;
}

// Two buttons start the same run: the one in the footer and the one at the top (the footer can be pushed out of
// sight when the browser window is taller than the screen).
const runButtons = () => ['#run', '#run-top'].map((q) => $(q)).filter(Boolean);
const setRunLabel = (t, off) => runButtons().forEach((b) => { b.disabled = !!off; b.textContent = b.id === 'run-top' ? t.replace(' maintenant', '').replace('extraction en cours', 'en cours').replace(/ ligne\(s\) lue\(s\)/, ' lignes') : t; });
let running = false;
// Champs tab: the fields this site learned on its product pages (tab « Fiche produit »). They are not columns to
// designate on the list: the app reads them on each product page when the rows are accepted.
const LEARNED_LABEL = { name: 'Nom', price: 'Prix', list_price: 'Prix barré', listPrice: 'Prix barré', ean: 'EAN', gtin: 'EAN', description: 'Description', technical_specs: 'Caractéristiques techniques', specs: 'Caractéristiques techniques', brand: 'Marque', category: 'Collection', variants: 'Variantes', sku: 'Référence', availability: 'Disponibilité', image: 'Images', images: 'Images' };
async function refreshTaught() {
  const box = $('#taught-box'); if (!box) return;
  const tab = await activeTab();
  const k = await send('knowledge_summary', { tabId: tab && tab.id });
  if (k && !k.ok && /demande inconnue/.test(k.reason || '')) {
    box.style.display = 'block';
    box.innerHTML = '<b>Application à mettre à jour</b><div class="hint" style="margin:4px 0 0">L’application installée ne sait pas encore lire les champs appris sur les fiches produit.</div>';
    return;
  }
  const live = k && k.ok ? (k.rules || []).filter((r) => r.scope === 'product' && (r.status === 'active' || r.status === 'failing' || r.status === 'proposed')) : [];
  const fields = [...new Set(live.map((r) => r.field))];
  if (!fields.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = 'block';
  box.innerHTML = `<b>Lus sur chaque fiche produit</b><div class="hint" style="margin:4px 0 0">${fields.map((f) => escapeHtml(LEARNED_LABEL[f] || f)).join(' · ')} — appris dans l’onglet « Fiche produit ». Ajoutés automatiquement à chaque produit quand tu cliques « ✓ Accepter » après « ▶ Exécuter » sur la collection.</div>`;
}

// The fields as the page reads them (« Exécuter », « Tester »).
const runFields = () => state.fields.map((f) => ({ key: f.key, label: f.label, role: roleOf(f), axis: f.axis || null, selector: f.selector || null, attr: f.attr || null, part: f.part || null, all: f.all || null }));

async function run() {
  if (running) return;
  running = true; setRunLabel('… extraction en cours', true);
  const tab = await activeTab();
  const r = await send('panel_run', { tabId: tab && tab.id, fields: runFields(), card: state.card, settings: { ...state.settings, hub: state.hub || null } });
  running = false; setRunLabel('▶ Exécuter maintenant', false);
  if (r && r.ok && Array.isArray(r.rows)) { state.rows = r.rows; state.meta = r.meta || null; state.accepted = null; finished = false; renderResults(r.meta || {}); renderFixed(); showTab('results'); }
  else { showTab('results'); renderResults({ error: (r && r.reason) || 'échec' }); }
}

const STOPPED = { max_pages: 'nombre de pages maximal atteint', max_products: 'maximum atteint', end: 'fin de la liste', navigated: 'la page a changé', time: 'durée maximale atteinte', max_rounds: 'nombre de chargements maximal atteint', single_page: 'cette page seulement', stopped: 'arrêté', total_reached: 'total annoncé atteint', no_new: 'plus de nouveaux produits', button_gone: 'bouton « charger plus » absent ou disparu', hub_done: 'toutes les sous-collections lues', platform_feed: 'collection lue dans les données de la boutique' };
// The cards the learned card left out, by reason (listed in the app's report and the export with « Accepter »).
function rejectedTip(r) {
  if (!r || !r.count) return '';
  return ` · ${r.count} carte(s) écartée(s) : ${Object.entries(r.byReason || {}).map(([k, n]) => `${n} ${(r.labels && r.labels[k]) || k}`).join(' ; ')}`;
}
// A hub page: what each sub-collection gave.
function hubTip(h) {
  if (!Array.isArray(h) || !h.length) return '';
  return ` · ${h.length} sous-collection(s) : ${h.map((s) => `${s.name} ${s.error ? `(${s.error})` : `(${s.rows})`}`).join(', ').slice(0, 300)}`;
}
// The count against the total the list announced (« Résultats 1 - 24 sur 32 »).
function totalTip(t) {
  if (!t || !Number.isInteger(t.announced)) return '';
  if (t.ok) return ` · ${t.read} lus sur ${t.announced} annoncés ✓`;
  return ` · ⚠ ${t.read} lus sur ${t.announced} annoncés${t.explained ? ' (limite de vos réglages, onglet Pages)' : ` : ${t.short} produit(s) manquant(s)`}`;
}

// Rows already recorded in the app for this run (one record per run, however many clicks).
let savedRun = null;
let finished = false; // the table shows the rows the app finished (after « Accepter »), not the list preview
async function accept() {
  const meta = $('#result-meta'); const btn = $('#accept');
  if (!state.rows || !state.rows.length || btn.disabled) return false;
  const runId = state.meta && state.meta.runId;
  if (runId && savedRun && savedRun.runId === runId) { meta.textContent = `Ces ${state.rows.length} ligne(s) sont déjà enregistrées dans l’application — retrouvez-les dans « Résultats ».`; return true; }
  btn.disabled = true;
  meta.textContent = 'Préparation de la lecture des fiches produit…';
  const tab = await activeTab();
  // « Accepter » answers at once: the worker reads the product pages as a persisted queue, which the panel follows.
  // Every column with its name as typed and its role for the Converter: the panel's fields, then the fields taught
  // on the product pages (tab « Fiche produit »). The app writes them in the job's manifest.
  const fields = [...state.fields.map((f) => ({ ...f, role: roleOf(f) })), ...(await learnColumns()).filter((c) => !state.fields.some((f) => f.key === c.key))];
  const r = await send('panel_accept', { tabId: tab && tab.id, rows: state.rows, fields, card: state.card, settings: state.settings, meta: state.meta, constants: fixedValues() });
  if (!r || !r.ok) { btn.disabled = false; meta.textContent = `Non enregistré : ${(r && r.reason) || 'aucune réponse de l’application'}.`; return false; }
  const q = await followEnrichment(r.runId);
  btn.disabled = false;
  return applyEnrichment(q);
}

// « Lire les fiches manquantes »: after « Accepter », only the pages it did not read are opened; the list is not
// read again and the pages already read are not opened again (a new job is recorded with every row).
function missingCount() { const e = state.accepted && state.accepted.enrich; return e ? (e.blocked || []).length + (e.notOpened || []).length : 0; }
function renderMissing() {
  const b = $('#read-missing'); if (!b) return;
  const n = missingCount();
  b.hidden = !(n > 0 && savedRun && savedRun.runId);
  b.textContent = `Lire les fiches manquantes (${n})`;
}
async function readMissing() {
  const btn = $('#read-missing'); const meta = $('#result-meta');
  if (!savedRun || !savedRun.runId || btn.disabled) return;
  btn.disabled = true; meta.textContent = 'Préparation de la lecture des fiches manquantes…';
  const r = await send('enrich_missing', { runId: savedRun.runId });
  if (!r || !r.ok) { btn.disabled = false; meta.textContent = `Lecture impossible : ${(r && r.reason) || 'aucune réponse'}.`; return; }
  meta.textContent = `${r.toOpen} fiche(s) à ouvrir${r.reused ? ` ; ${r.reused} fiche(s) déjà lue(s) reprise(s) sans les rouvrir` : ''}.`;
  const q = await followEnrichment(r.runId);
  btn.disabled = false;
  await applyEnrichment(q);
}

/** The columns taught on the product pages (tab « Fiche produit »), with the role chosen there. */
async function learnColumns() {
  if (!hasChrome || !chrome.storage) return [];
  try { const all = await chrome.storage.local.get('learnFields'); return (Array.isArray(all.learnFields) ? all.learnFields : []).filter((c) => c && c.field && c.label).map((c) => ({ key: c.field, label: c.label, role: roleOf({ label: c.label, role: c.role }), learned: true })); } catch { return []; }
}

// ---- the « Accepter » queue, followed from chrome.storage.local (it outlives a sleeping worker and this panel) ----
let followed = null; // { runId, resolve }
function followEnrichment(runId) {
  if (followed && followed.runId === runId) return followed.promise;
  let resolve; const promise = new Promise((r) => { resolve = r; });
  followed = { runId, resolve, promise };
  send('enrich_state', { runId }).then((s) => { if (s && s.ok && s.queue) onEnrich(s.queue); });
  return promise;
}
function onEnrich(q) {
  if (!followed || !q || q.runId !== followed.runId) return;
  renderEnrich(q);
  if (q.phase === 'done' || q.phase === 'error') { const f = followed; followed = null; f.resolve(q); }
}
function bindEnrichWatch() {
  if (!hasChrome || !chrome.storage || !chrome.storage.onChanged) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !followed) return;
    const c = changes[`enrich:${followed.runId}`];
    if (c && c.newValue) onEnrich(c.newValue);
  });
}
const pageCount = (q) => {
  let read = 0; let done = 0;
  for (const o of Object.values(q.outcomes || {})) { done++; if (o === 'read') read++; }
  return { read, done, toRead: q.toRead || 0, reading: (q.urls || []).length };
};
function renderEnrich(q) {
  const meta = $('#result-meta'); const run = $('#enrich-run'); const pause = $('#enrich-pause');
  const n = pageCount(q);
  const wasPaused = !pause.hidden;
  run.hidden = q.phase !== 'reading';
  pause.hidden = q.phase !== 'paused';
  let text = '';
  if (q.phase === 'reading') text = `Lecture des fiches produit dans votre navigateur : ${n.done} / ${n.reading}${n.toRead > n.reading ? ` (${n.toRead - n.reading} au-delà de la limite « Fiches produit à lire »)` : ''}. Une fenêtre réduite s’ouvre : ne la fermez pas. La lecture continue si vous fermez ce panneau.`;
  else if (q.phase === 'paused') {
    text = `Lecture en pause : ${n.done} / ${n.reading} fiche(s) traitée(s).`;
    $('#enrich-pause-text').textContent = `La fiche ${q.pauseUrl || ''} affiche une vérification « êtes-vous humain ? ». Cliquez « Ouvrir la fiche », répondez à la vérification dans l’onglet, puis cliquez « Reprendre ». « Ignorer cette fiche » continue sans elle ; « Terminer maintenant » enregistre ce qui est lu, les fiches restantes sont signalées comme non lues.`;
    // The user clicked « Accepter » at the bottom of the table: the question comes into view, focus on its answer.
    if (!wasPaused) { try { pause.scrollIntoView({ block: 'nearest' }); $('#enrich-resume').focus(); } catch { /* not shown */ } }
  } else if (q.phase === 'ingesting') text = `Enregistrement dans l’application (${n.read} fiche(s) lue(s))…`;
  else if (q.phase === 'error') text = `Non enregistré : ${q.error || 'erreur inconnue'}.`;
  meta.textContent = text; $('#enrich-progress').textContent = text;
}
async function enrichAction(action) {
  const runId = followed && followed.runId; if (!runId) return;
  const r = await send('enrich_control', { runId, action });
  if (!r || !r.ok) $('#result-meta').textContent = `Impossible : ${(r && r.reason) || 'aucune réponse'}.`;
}
async function openPausedPage() {
  const s = followed ? await send('enrich_state', { runId: followed.runId }) : null;
  const u = s && s.queue && s.queue.pauseUrl;
  if (u && hasChrome && chrome.tabs) { try { await chrome.tabs.create({ url: u, active: true }); } catch { /* the user can open it */ } }
}

// The run is over: the job's finished rows come back in chunks and are merged into the rows shown, by product
// address — a row the app did not send back keeps its list values, nothing is dropped or replaced.
async function applyEnrichment(q) {
  const meta = $('#result-meta');
  $('#enrich-run').hidden = true; $('#enrich-pause').hidden = true;
  if (!q || q.phase !== 'done' || !q.result) { meta.textContent = `Non enregistré : ${(q && q.error) || 'aucune réponse de l’application'}.`; return false; }
  const res = q.result;
  let received = 0; let offset = 0; let failed = null;
  while (offset != null) {
    meta.textContent = `Réception des lignes complétées : ${received}${res.rowsTotal != null ? ` / ${res.rowsTotal}` : ''}…`;
    const c = await send('enrich_rows', { runId: q.runId, jobId: res.jobId, url: q.listUrl, offset });
    if (!c || !c.ok || !Array.isArray(c.rows)) { failed = (c && c.reason) || 'aucune réponse'; break; }
    state.rows = mergeRowsByUrl(state.rows, c.rows).rows;
    received += c.rows.length; offset = c.next != null ? c.next : null;
  }
  const total = res.rowsTotal != null ? res.rowsTotal : received;
  savedRun = { runId: q.runId, jobId: res.jobId };
  state.accepted = { jobId: res.jobId, enrich: summarize(q), reportStatus: res.reportStatus, rulesFailing: res.rulesFailing || [], rowsMissing: Math.max(0, total - received) + (q.rowsCut || 0) };
  finished = true;
  send('enrich_consumed', { runId: q.runId });
  renderResults({ method: 'complété depuis chaque fiche produit' });
  meta.textContent = `✓ ${state.rows.length} ligne(s) enregistrée(s) dans l’application — retrouvez-les dans « Résultats »${res.counts && res.counts.accepted != null ? ` (${res.counts.accepted} acceptée(s))` : ''}. Le tableau et « Exporter CSV » montrent maintenant les données lues sur chaque fiche produit.${failed ? ` ${total - received} ligne(s) complétée(s) n’ont pas pu être reçues (${failed}) : elles gardent les données de la liste.` : ''}`;
  return true;
}

// The panel reopened while « Accepter » was running (or finished unseen): the rows and the run come back.
async function restoreEnrichment() {
  if (!state.origin) return;
  const s = await send('enrich_state', { origin: state.origin, withRows: true });
  const q = s && s.ok && s.queue;
  if (!q || q.consumed || q.phase === 'error' || !Array.isArray(s.rows)) return;
  state.rows = s.rows; state.meta = s.meta || null; state.accepted = null; finished = false;
  renderResults(state.meta || {}); showTab('results');
  if (q.phase === 'done') { await applyEnrichment(q); return; }
  const btn = $('#accept'); btn.disabled = true;
  const end = await followEnrichment(q.runId);
  btn.disabled = false;
  await applyEnrichment(end);
}

function renderResults(meta) {
  const empty = $('#result-empty'); const wrap = $('#result-wrap');
  if (!state.rows || !state.rows.length) {
    empty.style.display = 'block'; wrap.style.display = 'none';
    empty.textContent = meta.error ? `Aucun résultat : ${meta.error}` : 'Aucun résultat. Lance « Exécuter » pour prévisualiser.';
    return;
  }
  empty.style.display = 'none'; wrap.style.display = 'block';
  const missing = state.template === 'produits' ? state.rows.filter((r) => !(r && (r.name || r.title)) || r.price == null).length : 0;
  const taughtTip = Array.isArray(meta.taught) && meta.taught.length && state.template === 'produits' ? ` · appris sur les fiches produit : ${meta.taught.join(', ')} — « Accepter » les lira sur chaque fiche` + previewTip(meta.taughtPreview) : '';
  const weakTip = missing ? ` · ${missing} ligne(s) sans nom ou sans prix : ${state.settings.subpages ? '« Accepter » les complétera depuis chaque fiche produit' : 'cochez « Sous-pages » (onglet Pages) avant « Accepter » pour les compléter depuis chaque fiche produit'}` : '';
  $('#result-meta').textContent = `${state.rows.length} ligne(s)${meta.method ? ` · ${meta.method}` : ''}${meta.pages > 1 ? ` · ${meta.pages} pages lues` : ''}${meta.loads ? ` · ${meta.loads} chargement(s)` : ''}${meta.stoppedBy && STOPPED[meta.stoppedBy] ? ` · ${STOPPED[meta.stoppedBy]}` : ''}${totalTip(meta.total)}${hubTip(meta.hub)}${rejectedTip(meta.rejected)}${taughtTip}${weakTip}`;
  const colDefs = resultColumns();
  const cols = colDefs.map((f) => f.key);
  // What these rows really are (preview or accepted), always beside the table, and how full each column is.
  const m = currentManifest();
  const rs = $('#read-state');
  if (rs) { rs.className = `readstate${m.status === 'complete' ? ' complete' : ''}`; const plan = m.status === 'preview' ? acceptPlanText(m, state.settings) : ''; rs.innerHTML = `<b>${escapeHtml(manifestSummaryFr(m))}</b>${m.status === 'preview' ? ` — les colonnes lues sur les fiches produit restent incomplètes tant que « Accepter » n’est pas terminé.${plan ? ` ${escapeHtml(plan)}` : ''}` : ''}`; }
  renderMissing();
  const table = $('#result-table');
  const fillOf = (c) => { const f = m.fill[c]; if (!f || !f.total) return ''; const low = f.filled / f.total < 0.5; return `<span class="fill${low ? ' low' : ''}" title="${f.filled} ligne(s) remplie(s) sur ${f.total}">${f.filled}/${f.total}</span>`; };
  table.innerHTML = `<thead><tr>${colDefs.map((f) => `<th>${escapeHtml(f.label)}${fillOf(f.key)}</th>`).join('')}</tr></thead>` +
    `<tbody>${viewRows().slice(0, SHOWN_ROWS).map((row) => `<tr>${cols.map((c) => `<td>${escapeHtml(cellText(row, c))}</td>`).join('')}</tr>`).join('')}</tbody>`;
  const shown = $('#result-shown');
  if (shown) shown.textContent = state.rows.length > SHOWN_ROWS ? `${SHOWN_ROWS} premières lignes affichées sur ${state.rows.length}. L’export contient toutes les lignes.` : '';
}
const SHOWN_ROWS = 50;

/** The manifest of the rows on screen (shared/export/manifest.mjs): the panel's single source for its state line and exports. */
function currentManifest() {
  const colDefs = resultColumns();
  let version = null; try { version = hasChrome && chrome.runtime.getManifest ? chrome.runtime.getManifest().version : null; } catch { version = null; }
  return panelManifest({ rows: viewRows(), columns: colDefs, read: cellText, meta: state.meta || {}, settings: state.settings, accepted: state.accepted, version });
}
// What the taught product rules read in the preview: per field, on how many previewed rows; what they did
// not read; the product pages that showed a human check instead (the user can answer it, then run again).
function previewTip(p) {
  if (!p) return '';
  const label = (f) => LEARNED_LABEL[f] || f;
  const read = Object.entries(p.fields || {}).map(([f, n]) => `${label(f)} ${n}/${p.pages}`);
  const parts = [];
  if (p.pages) parts.push(`aperçu sur ${p.pages} fiche(s) : ${read.length ? read.join(', ') : 'aucun champ appris lu'}`);
  if (p.pages && p.missing && p.missing.length) parts.push(`non lus : ${p.missing.map(label).join(', ')}`);
  if (p.challenged) parts.push(`${p.challenged} fiche(s) affichent une vérification « êtes-vous humain ? » : ouvrez une fiche du site dans ce navigateur, répondez-y, puis relancez « Exécuter »`);
  else if (!p.pages && p.unread) parts.push('aucune fiche produit n’a pu être ouverte pour l’aperçu');
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}

// The panel's fields, plus the columns the finished rows carry beyond them (read on each product page).
const EXTRA_COLS = [['description', 'Description'], ['technical_specs', 'Caractéristiques techniques'], ['variants', 'Variantes'], ['brand', 'Marque'], ['category', 'Collection']];
const EXTRA_ROLE = { description: 'description', technical_specs: 'technical_specs', variants: 'variants', brand: 'brand', category: 'category' };
function resultColumns() {
  const base = state.fields.map((f) => ({ key: f.key, label: f.label, role: roleOf(f), ...(f.axis ? { axis: f.axis } : {}) }));
  const have = new Set(base.map((f) => f.key));
  // The fixed values: a column each (Marque and Collection are often already there), with its role for the Converter.
  for (const c of constantColumns(fixedValues())) { const at = base.find((b) => b.key === c.key); if (at) at.role = c.role; else { base.push(c); have.add(c.key); } }
  // The preview already carries what the taught rules read: show those columns too.
  if (!finished && !(state.meta && state.meta.taughtPreview && state.meta.taughtPreview.pages)) return base;
  const filledIn = (key) => (state.rows || []).some((r) => r && r[key] != null && r[key] !== '');
  for (const [key, label] of EXTRA_COLS) if (!have.has(key) && filledIn(key)) { base.push({ key, label, role: EXTRA_ROLE[key] }); have.add(key); }
  // The fields taught on the product pages (tab « Fiche produit »), under the name the user gave them.
  for (const c of state.learnCols || []) if (!have.has(c.key) && filledIn(c.key)) { base.push({ key: c.key, label: c.label, role: c.role }); have.add(c.key); }
  return base;
}
function cellText(row, c) {
  const v = row && (row[c] ?? (c === 'url' ? row.sourceUrl : null) ?? (c === 'image' ? (row.images && row.images[0]) : null)
    ?? (c === 'list_price' ? row.listPrice : null) ?? (c === 'ean' ? row.gtin : null));
  if (v == null) return '';
  if ((c === 'price' || c === 'list_price') && typeof v === 'number' && row.currency) return `${v} ${row.currency}`;
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? (x.name || x.code || '') : x)).filter((x) => x !== '').join(', ');
  if (typeof v === 'object') return Object.entries(v).map(([k, x]) => `${k} : ${x}`).join(' ; ');
  return String(v);
}

// « Exporter CSV »: a preview or a partial result is never exported as if it were complete. The panel says
// what the file holds first, and offers to accept (read every product page) before exporting.
function exportCsv() {
  if (!state.rows || !state.rows.length) return;
  const warn = exportWarning(currentManifest());
  if (!warn) { writeExport(); return; }
  const box = $('#export-warn');
  $('#export-warn-title').textContent = warn.title;
  $('#export-warn-text').textContent = warn.text;
  $('#export-accept').hidden = !warn.canAccept;
  box.hidden = false;
  (warn.canAccept ? $('#export-accept') : $('#export-anyway')).focus();
}
function closeExportWarn() { const box = $('#export-warn'); if (box) box.hidden = true; }
async function acceptThenExport() {
  closeExportWarn();
  if (!(await accept())) return;
  exportCsv(); // complete → exported at once; still partial → the panel says why before exporting
}

const download = (text, type, name) => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
};
// The CSV and, beside it, its manifest (same name, « .manifest.json »): the Converter reads both.
function writeExport() {
  closeExportWarn();
  const colDefs = resultColumns(); const cols = colDefs.map((f) => f.key);
  const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const csv = [colDefs.map((f) => esc(f.label)).join(','), ...viewRows().map((row) => cols.map((c) => esc(cellText(row, c))).join(','))].join('\n');
  const stem = exportStem((state.meta && state.meta.url) || state.origin);
  const manifest = { ...currentManifest(), export: { file: `${stem}.csv`, format: 'csv', columns: colDefs.map((f) => f.label) } };
  try {
    download(csv, 'text/csv', `${stem}.csv`);
    download(JSON.stringify(manifest, null, 1), 'application/json', manifestFileName(`${stem}.csv`));
    $('#result-meta').textContent = `Exporté : ${stem}.csv et son manifeste (${manifestSummaryFr(manifest)}).`;
  } catch { $('#result-meta').textContent = 'Export impossible dans ce navigateur.'; }
}

// ---- status ----------------------------------------------------------------
async function refreshStatus() {
  const s = await send('status');
  const connected = s && s.link === 'connected';
  $('#appdot').className = `dot ${connected ? 'on' : 'off'}`;
  $('#appstate').textContent = connected ? 'app connectée' : 'app hors ligne';
  const ai = await send('ai_status');
  // The Claude key lives in the app: when the app is connected the IA is available
  // (the key is checked at click and any gap is reported clearly then), so the dot is
  // "on" for "managed" — not a misleading red "non configurée".
  const ok = !!(ai && ai.ok && (ai.configured || ai.managed));
  $('#aidot').className = `dot ${ok ? 'on' : 'off'}`;
  $('#aistate').textContent = ok ? (ai.configured ? 'clé IA configurée' : 'IA gérée par l’application') : ((ai && ai.reason) || 'IA indisponible — application hors ligne');
}

// ---- site activation (the required user gesture for permissions.request) ----
let siteHost = '';
async function refreshSite() {
  const tab = await activeTab();
  let host = '';
  try { if (tab && tab.url && /^https?:/.test(tab.url)) host = new URL(tab.url).hostname.replace(/^www\./, ''); } catch { /* */ }
  siteHost = host;
  $('#site-host').textContent = host || '—';
  let granted = false;
  if (host && hasChrome) { try { granted = await hasDomainPermission(chrome, host); } catch { granted = false; } }
  $('#site-perm').className = `dot ${granted ? 'on' : 'off'}`;
  $('#site-perm-txt').textContent = host ? (granted ? 'site activé' : 'non activé') : '';
  $('#activate').style.display = host && !granted ? '' : 'none';
}
async function activateSite() {
  if (!siteHost || !hasChrome) return;
  if (!originsForDomain(siteHost).length) { $('#site-perm-txt').textContent = 'domaine invalide'; return; }
  try { await requestDomainPermission(chrome, siteHost); } catch { /* user declined */ }
  refreshSite();
}

// ---- live job status (long-lived port, like the old popup) ------------------
function showJob(stateName, message, { resume } = {}) {
  $('#jobbar').style.display = 'block';
  const label = { running: 'en cours', paused: 'en pause (action requise)', blocked: 'bloqué', done: 'terminé' }[stateName] || stateName;
  $('#job-state').textContent = label;
  $('#job-msg').textContent = message || '';
  $('#job-stop').style.display = stateName === 'done' ? 'none' : '';
  $('#job-resume').style.display = (resume === false || stateName !== 'paused') ? 'none' : '';
}
let currentJob = null;
function connectPort() {
  if (!hasChrome || !chrome.runtime.connect) return;
  try {
    const port = chrome.runtime.connect({ name: 'popup' });
    port.onMessage.addListener((m) => {
      if (m.kind === 'panel_progress') { if (running) setRunLabel(`… ${m.count} ligne(s) lue(s)`, true); }
      else if (m.kind === 'subpage_progress') { const el = $('#result-meta'); if (el) el.textContent = `Lecture de chaque fiche produit dans votre navigateur : ${m.done} / ${m.total}… (une fenêtre réduite s’ouvre, ne la fermez pas)`; }
      else if (m.kind === 'progress') { currentJob = m.job_id || currentJob; showJob('running', `Produits : ${(m.data && (m.data.total ?? m.data.count)) ?? ''}`); }
      else if (m.kind === 'challenge') { currentJob = m.job_id || currentJob; showJob('paused', m.message || 'Action requise dans l’onglet.', { resume: false }); }
      else if (m.kind === 'challenge_resolved' || m.kind === 'job_resumed') { showJob('running', 'Reprise…'); }
    });
  } catch { /* no port */ }
}

// ---- tabs ------------------------------------------------------------------
function showTab(name) {
  document.body.dataset.tab = name;
  window.dispatchEvent(new CustomEvent('elo-tab', { detail: name }));
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.getAttribute('data-tab') === name));
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.id === `pane-${name}`));
}

// ---- wire up ---------------------------------------------------------------
// ---- recipes.json (through the app: the extension keeps no recipe of its own) ------------------------------
const R_WHAT = { rule: 'règle', manual_selectors: 'recette de liste', link_filter: 'filtre de liens', internal_api: 'recette d’API', list_pagination: 'pagination de liste', site_values: 'profil du site (valeurs fixes)', list_batches: 'valeurs fixes des pages de liste', card_model: 'carte produit apprise' };
const R_ACTION = { added: 'ajouté', replaced: 'remplacé', kept: 'gardé', identical: 'identique' };
const R_WHY = { none_here: 'aucune règle pour ce champ ici', same: 'déjà identique', manual_kept: 'votre règle désignée est gardée', more_trusted_file: 'plus fiable dans le fichier', newer_file: 'plus récente dans le fichier', more_trusted_here: 'plus fiable ici', newer_here: 'plus récente ici', absent_here: 'absente ici', other_here: 'une autre existe ici : gardée' };
function bindRecipes() {
  const box = $('#recipes-preview'); const exp = $('#recipes-export'); const inp = $('#recipes-file');
  if (!box || !exp || !inp) return;
  const tabId = async () => { const t = await activeTab(); return t && t.id; };
  const say = (text) => { box.innerHTML = `<div class="hint">${escapeHtml(text)}</div>`; };
  exp.addEventListener('click', async () => {
    const r = await send('recipes', { tabId: await tabId(), action: 'export' });
    if (!r || !r.ok) { say(`Export impossible : ${(r && r.reason) || 'aucune réponse de l’application'}`); return; }
    const url = URL.createObjectURL(new Blob([JSON.stringify(r.file, null, 1)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'recipes.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
    say(`${Object.keys(r.file.sites || {}).length} site(s) exporté(s) dans recipes.json.`);
  });
  inp.addEventListener('change', async () => {
    const f = inp.files && inp.files[0]; inp.value = ''; if (!f) return;
    let file = null; try { file = JSON.parse(await f.text()); } catch { say('Fichier illisible (JSON attendu).'); return; }
    const r = await send('recipes', { tabId: await tabId(), action: 'preview', file });
    if (!r || !r.ok) { say(`Import impossible : ${(r && r.reason) || 'aucune réponse de l’application'}`); return; }
    if (r.empty) { say('Rien à importer : tout est déjà identique ou mieux ici.'); return; }
    const c = r.summary.counts; const lines = [];
    for (const [host, items] of Object.entries(r.summary.sites)) for (const it of items) lines.push(`<div>${escapeHtml(host)} — ${escapeHtml(R_WHAT[it.what] || it.what)}${it.field ? ` « ${escapeHtml(it.field)} »` : ''} : ${escapeHtml(R_ACTION[it.action] || it.action)} (${escapeHtml(R_WHY[it.why] || it.why)})</div>`);
    box.innerHTML = `<div class="card"><div class="hint" style="margin:0 0 6px">${c.added || 0} ajout(s) · ${c.replaced || 0} remplacement(s) · ${c.kept || 0} gardé(s) · ${c.identical || 0} identique(s)</div><div class="sample">${lines.slice(0, 120).join('')}</div><div class="row" style="margin-top:6px"><button class="btn primary sm" id="recipes-apply">Appliquer l’import</button><button class="btn ghost sm" id="recipes-cancel">Annuler</button></div></div>`;
    $('#recipes-cancel').addEventListener('click', () => { box.innerHTML = ''; });
    $('#recipes-apply').addEventListener('click', async () => {
      const a = await send('recipes', { tabId: await tabId(), action: 'apply', previewId: r.previewId });
      say(a && a.ok ? `Import appliqué : ${(a.sites || []).length} site(s) mis à jour. Une copie de l’ancien fichier est gardée dans l’application.` : `Import non appliqué : ${(a && a.reason) || 'aucune réponse'}`);
    });
  });
}

// ---- fixed values: typed once, given to every product of this site's scrapes (shared/export/constants.mjs) -------
// Established terms only (no free name): Marque, Collection, Type de produit, Étiquettes, Statut à l'import, and the
// attribute terms of a closed list — the Converter recognises each column by its name, with no guess.
const FIXED_DEFAULT = () => [{ role: 'brand', value: '', mode: 'always' }, { role: 'category', value: '', mode: 'always' }, { role: 'product_type', value: '', mode: 'always' }, { role: 'tags', value: '' }, { role: 'status', value: '' }];
// A value typed for the whole scrape is given to every product by default; « only if the page gives none » on demand.
const MODE_TEXT = { always: 'pour tous les produits', empty: 'seulement si la page n’en donne pas' };
const fixedValues = () => normalizeConstants(state.constants);
/** The rows as they will be exported and recorded: each with the fixed values. */
const viewRows = () => { const c = fixedValues(); return c.length ? (state.rows || []).map((r) => applyConstantsToRow(r, c)) : (state.rows || []); };

function renderFixed() {
  const box = $('#fixed-list'); if (!box) return;
  const trail = state.meta && Array.isArray(state.meta.trail) && state.meta.trail.length ? state.meta.trail.join(' > ') : '';
  const usedTerms = new Set(state.constants.filter((c) => c.role === 'attribute' && c.term).map((c) => c.term));
  let host = ''; try { host = state.origin ? new URL(state.origin).hostname.replace(/^www\./, '') : ''; } catch { host = ''; }
  // Two levels, said above their rows: the site (brand) and the batch of the list page (the rest).
  const heads = { site: `<div class="fx-level">Pour tout le site${host ? ` ${escapeHtml(host)}` : ''}</div>`, batch: `<div class="fx-level">Pour ce lot : ${escapeHtml((state.batch && state.batch.label) || 'cette page')}<span class="hint" style="margin:0"> — la page de liste ouverte</span></div>` };
  const shown = new Set();
  box.innerHTML = state.constants.map((c, i) => {
    const lv = levelOf(c); const head = shown.has(lv) ? '' : (shown.add(lv), heads[lv]);
    return head + fixedRow(c, i, trail, usedTerms);
  }).join('');
  const add = $('#fixed-add'); if (add) add.hidden = Object.keys(ATTRIBUTE_TERMS).every((k) => usedTerms.has(k));
  renderFixedState();
}
function fixedRow(c, i, trail, usedTerms) {
  const label = c.role === 'attribute' ? (ATTRIBUTE_TERMS[c.term] || 'Valeur') : CONSTANT_ROLES[c.role].label;
  const name = c.role === 'attribute'
    ? `<select data-fx="${i}" data-k="term" aria-label="Nom de la valeur fixe">${Object.entries(ATTRIBUTE_TERMS).filter(([k]) => k === c.term || !usedTerms.has(k)).map(([k, txt]) => `<option value="${k}"${k === c.term ? ' selected' : ''}>${escapeHtml(txt)}</option>`).join('')}</select>`
    : `<label for="fx-v-${i}">${escapeHtml(label)}</label>`;
  let value;
  if (c.role === 'status') value = `<select id="fx-v-${i}" data-fx="${i}" data-k="value"><option value="">comme le site (non précisé)</option>${Object.entries(STATUS_VALUES).map(([k, txt]) => `<option value="${k}"${c.value === k ? ' selected' : ''}>${escapeHtml(txt)}</option>`).join('')}</select>`;
  else {
    const ph = { brand: 'ex. adidas', category: 'ex. Homme > Chaussures', product_type: 'ex. Chaussures', tags: 'ex. soldes, été 2026' }[c.role] || 'Valeur pour tous les produits';
    value = `<input type="text" id="fx-v-${i}" data-fx="${i}" data-k="value" value="${escapeAttr(c.value || '')}" placeholder="${escapeAttr(ph)}">`;
  }
  const more = c.role === 'tags' ? '<span class="hint" style="margin:0">séparées par des virgules, ajoutées à celles des pages</span>'
    : c.role === 'status' ? '<span class="hint" style="margin:0">« Brouillon » : importés masqués, à relire avant la vente</span>'
    : `<select data-fx="${i}" data-k="mode" aria-label="Quand appliquer « ${escapeAttr(label)} »">${Object.entries(MODE_TEXT).map(([m, txt]) => `<option value="${m}"${(c.mode || 'always') === m ? ' selected' : ''}>${txt}</option>`).join('')}</select>`;
  const suggest = c.role === 'category' && trail && trail !== c.value ? `<button class="linkbtn" data-fx-trail="${i}" title="Le fil d’Ariane de la page de liste lue">utiliser « ${escapeHtml(trail.slice(0, 60))} »</button>` : '';
  const remove = c.role === 'attribute' ? `<button class="iconbtn" data-fx-del="${i}" title="Retirer cette valeur fixe" aria-label="Retirer cette valeur fixe">✕</button>` : '';
  return `<div class="fixed-row">${name}${value}<div class="fx-more">${more}${suggest}${remove}</div></div>`;
}

// What is saved in the app, said beside « Enregistrer »: the site's profile and this list page's batch, each
// « enregistré », « modifié, non enregistré » or « aucun … enregistré ».
function renderFixedState() {
  const el = $('#fixed-state'); const btn = $('#fixed-save'); if (!el) return;
  const { site, batch } = splitConstants(state.constants || []);
  const sv = state.saved;
  const label = (state.batch && state.batch.label) || 'cette page';
  // « Enregistrer » is always usable on a web page: a click says what happened (never a dead button, 28/10).
  if (btn) btn.disabled = !state.origin;
  if (!state.origin) { el.textContent = 'Ouvrez une page de liste pour enregistrer ses valeurs.'; return; }
  if (!sv.checked) { el.textContent = 'Vérification de ce qui est enregistré…'; return; }
  if (!sv.online) { el.textContent = `Gardé dans ce navigateur seulement : ${appWhy(sv.reason)}.`; return; }
  const savedSiteC = sv.site ? sv.site.constants || [] : null; const savedBatchC = sv.batch ? sv.batch.constants || [] : null;
  const siteSame = savedSiteC ? sameConstants(site, savedSiteC) : !site.length;
  const batchSame = savedBatchC ? sameConstants(batch, savedBatchC) : !batch.length;
  const siteTxt = savedSiteC ? (siteSame ? 'profil enregistré' : 'modifié, non enregistré') : (site.length ? 'non enregistré' : 'aucun profil enregistré');
  const batchTxt = savedBatchC ? (batchSame ? 'enregistré' : 'modifié, non enregistré') : (batch.length ? 'non enregistré' : 'aucune valeur enregistrée');
  el.textContent = `Site : ${siteTxt}. Lot « ${label} » : ${batchTxt}.`;
}
// The app's copy of the site profile and of this page's batch; a level this browser never kept is taken from it.
async function syncSiteValues() {
  const tab = await activeTab();
  const r = await send('site_values', { tabId: tab && tab.id, action: 'get', url: state.batch && state.batch.url });
  if (!r || !r.ok) { state.saved = { site: null, batch: null, online: false, checked: true, reason: (r && r.reason) || 'aucune réponse' }; renderFixedState(); return; }
  state.saved = { site: r.site || null, batch: r.batch || null, online: true, checked: true, reason: '' };
  let changed = false;
  if (!state.local.site && r.site) {
    const cur = state.constants.filter((c) => levelOf(c) === 'batch');
    state.constants = formConstants([...(r.site.constants || []), ...cur]);
    if (Array.isArray(r.site.fields) && r.site.fields.length) { state.fields = r.site.fields.map((f) => ({ hint: '', ...f })); state.card = r.site.card || null; if (r.site.template) state.template = r.site.template; rekey(); renderFields(); }
    changed = true;
  }
  if (!state.local.batch && r.batch) {
    const cur = state.constants.filter((c) => levelOf(c) === 'site');
    state.constants = formConstants([...cur, ...(r.batch.constants || [])]);
    if (r.batch.hub && Array.isArray(r.batch.hub.links)) { state.hub = r.batch.hub; renderHub(); }
    changed = true;
  }
  if (changed) { renderFixed(); if (state.rows) renderResults(state.meta || {}); } else renderFixedState();
}
async function saveFixed() {
  const btn = $('#fixed-save'); const el = $('#fixed-state');
  btn.disabled = true; el.textContent = 'Enregistrement…';
  const { site, batch } = splitConstants(state.constants || []);
  const tab = await activeTab();
  const r = await send('site_values', {
    tabId: tab && tab.id, action: 'set', url: state.batch && state.batch.url,
    site: { constants: site, fields: state.fields, card: state.card, template: state.template },
    batch: batch.length || state.hub ? { constants: batch, label: state.batch && state.batch.label, hub: state.hub || null } : null,
  });
  if (!r || !r.ok) {
    btn.disabled = false; await save();
    el.textContent = `Gardé dans ce navigateur, pas dans l’application : ${appWhy(r && r.reason)}.`; return;
  }
  state.saved = { site: r.site || null, batch: r.batch || null, online: true, checked: true, reason: '' };
  await save();
  el.textContent = `✓ Enregistré dans l’application. ${el.textContent}`;
}

// ---- the product card learned for the site (card-model.mjs) -----------------------------------------------
const cardState = { model: null, savedIn: null };
function renderCard(extra = '') {
  const m = cardState.model; const info = $('#card-info'); if (!info) return;
  $('#card-not').hidden = !m; $('#card-show').hidden = !m; $('#card-forget').hidden = !m;
  $('#card-learn').textContent = m ? '🎯 Ajouter une section / recompter' : '🎯 Montrer une carte produit';
  const where = cardState.savedIn === 'app' ? 'gardée dans l’application' : (cardState.savedIn === 'browser' ? 'gardée dans ce navigateur seulement (l’application est fermée ou plus ancienne que l’extension)' : '');
  info.textContent = m
    ? `✓ Carte apprise${m.sample && m.sample.name ? ` sur « ${m.sample.name.slice(0, 50)} »` : ''} : lien ${m.linkShape || '?'}, titre${m.needs && m.needs.price ? ', prix' : ''} exigés${m.negatives && m.negatives.length ? `, ${m.negatives.length} motif(s) « pas un produit »` : ''}${where ? ` — ${where}` : ''}.${extra ? ` ${extra}` : ''}`
    : `Aucune carte apprise : détection automatique.${extra ? ` ${extra}` : ''}`;
}
const countText = (r) => (r && r.kept != null ? `Sur cette page : ${r.kept} carte(s) produit${r.rejected ? `, ${r.rejected} écartée(s)` : ''}.` : '');
async function refreshCard() {
  const tab = await activeTab();
  const r = await send('card', { tabId: tab && tab.id, action: 'info' });
  Object.assign(cardState, r && r.ok ? { model: r.model || null, savedIn: r.savedIn || null } : { model: null, savedIn: null });
  renderCard(r && !r.ok && r.reason ? `(${r.reason})` : '');
}
async function cardDo(action) {
  const tab = await activeTab(); const info = $('#card-info');
  if (action === 'learn' || action === 'not_product') info.textContent = action === 'learn' ? 'Dans la page, cliquez sur une carte produit… (Échap ou clic droit : annuler)' : 'Dans la page, cliquez sur l’élément qui n’est pas un produit… (Échap ou clic droit : annuler)';
  const r = await withEscape(tab, () => send('card', { tabId: tab && tab.id, action }));
  if (!r || !r.ok) { info.textContent = `Non retenu : ${(r && r.reason) || 'aucune réponse'}.`; return; }
  if ('model' in r) Object.assign(cardState, { model: r.model || null, savedIn: r.savedIn || cardState.savedIn });
  renderCard(r.added ? `Section ajoutée. ${countText(r)}` : countText(r));
}

// ---- a hub page: the block of its sub-collections, kept with the list page's batch ------------------------
function renderHub() {
  const h = state.hub; const info = $('#hub-info'); if (!info) return;
  $('#hub-forget').hidden = !h; $('#hub-name-row').hidden = !h; $('#hub-name').checked = !!(h && h.useName);
  info.textContent = h ? `${h.links.length} sous-collection(s) : ${h.links.slice(0, 6).map((l) => `« ${l.name} »`).join(', ')}${h.links.length > 6 ? '…' : ''}. « Exécuter » les ouvre une à une.` : 'Aucun bloc montré : « Exécuter » lit cette page seulement.';
}
async function hubPick() {
  const tab = await activeTab(); const info = $('#hub-info');
  info.textContent = 'Dans la page, cliquez sur le bloc des sous-collections (molette : agrandir ; Échap ou clic droit : annuler)…';
  const r = await withEscape(tab, () => send('card', { tabId: tab && tab.id, action: 'hub' }));
  if (!r || !r.ok) { info.textContent = `Non retenu : ${(r && r.reason) || 'aucune réponse'}.`; return; }
  state.hub = { links: r.links, useName: true }; save(); renderHub();
}

// ---- following the user's tab: another site, or another list page of the same site ----------------------
// Never while « Exécuter » or « Accepter » runs on the tab (their rows belong to the page they started on).
let switching = false;
async function watchSite() {
  if (switching || running || followed) return;
  const tab = await activeTab(); const url = (tab && tab.url) || '';
  if (url === state.seenUrl) return;
  const page = pageOf(url);
  switching = true;
  try {
    state.seenUrl = url;
    if (page.origin !== state.origin) { await switchSite(); return; }
    if (page.key === (state.batch && state.batch.key)) return;
    // A product page of the site stays in the batch of the list it came from (teaching a field, reading a page).
    const k = tab ? await send('page_kind', { tabId: tab.id }) : null;
    if (k && k.ok && k.kind === 'product') return;
    await switchBatch(page, url);
  } finally { switching = false; }
}
function clearRows() {
  state.rows = null; state.meta = null; state.accepted = null; finished = false; savedRun = null;
  closeExportWarn(); renderResults({});
}
async function switchSite() {
  clearRows();
  await load();
  state.saved = { site: null, batch: null, online: false, checked: false, reason: '' };
  { const sel = $('#template'); if (sel) sel.value = state.template; }
  renderFields(); renderFixed(); bindSettings(); renderPagination(); refreshTaught(); renderHub(); refreshCard();
  delete $('#pag-test-result').dataset.fresh; refreshPagination(); // this site's pagination, not the previous one's
  await syncSiteValues();
  restoreEnrichment();
}
async function switchBatch(page, url) {
  clearRows();
  state.batch = { key: page.key, label: page.label, url };
  let batchC = []; state.local.batch = false; state.hub = null;
  try { const all = await chrome.storage.local.get('panelBatches'); const b = page.key ? (all.panelBatches || {})[page.key] : null; if (b && Array.isArray(b.constants)) { batchC = b.constants.filter((c) => levelOf(c) === 'batch'); state.local.batch = true; } if (b && b.hub && Array.isArray(b.hub.links) && b.hub.links.length) state.hub = b.hub; } catch { /* fresh */ }
  state.constants = formConstants([...state.constants.filter((c) => levelOf(c) === 'site'), ...batchC]);
  state.saved = { ...state.saved, batch: null, checked: false };
  renderFixed(); renderHub();
  await syncSiteValues();
}
function onFixedInput(e) {
  const t = e.target; const i = t.getAttribute('data-fx'); const k = t.getAttribute('data-k');
  if (i == null || !k || !state.constants[Number(i)]) return;
  state.constants[Number(i)][k] = t.value;
  save();
  if (k === 'term') renderFixed();
  if (state.rows) renderResults(state.meta || {});
}
function onFixedClick(e) {
  const tr = e.target.closest('[data-fx-trail]');
  if (tr) { const c = state.constants[Number(tr.getAttribute('data-fx-trail'))]; if (c && state.meta && state.meta.trail) { c.value = state.meta.trail.join(' > '); renderFixed(); save(); if (state.rows) renderResults(state.meta || {}); } return; }
  const del = e.target.closest('[data-fx-del]');
  if (del) { state.constants.splice(Number(del.getAttribute('data-fx-del')), 1); renderFixed(); save(); if (state.rows) renderResults(state.meta || {}); }
}
function addFixed() {
  const used = new Set(state.constants.filter((c) => c.role === 'attribute').map((c) => c.term));
  const term = Object.keys(ATTRIBUTE_TERMS).find((k) => !used.has(k)); if (!term) return;
  state.constants.push({ role: 'attribute', term, value: '', mode: 'always' }); renderFixed(); save();
  const inputs = document.querySelectorAll('#fixed-list input[data-k="value"]'); if (inputs.length) inputs[inputs.length - 1].focus();
}

// ---- Pages tab: how this site's lists load more (kept per site, in the app and in this browser) ----------
const PAG_HINT = {
  auto: 'Sur la page : « charger plus » et défilement ; puis la page suivante (bouton montré, lien « suivant », numéro de page). Jusqu’au maximum de pages.',
  button: 'Page après page avec le bouton « page suivante ». Arrêt : plus de bouton (dernière page), plus de nouveaux produits, total annoncé atteint ou pages maximum.',
  load_more: 'Clic après clic sur « charger plus ». Arrêt : bouton disparu, plus de nouveaux produits, total annoncé atteint ou pages maximum (chaque chargement compte comme une page).',
  infinite: 'Défilement jusqu’en bas de la page, plusieurs fois. Arrêt : plus de nouveaux produits, total annoncé atteint ou pages maximum (chaque chargement compte comme une page).',
  url: 'Pages 2, 3… en changeant le numéro dans l’adresse (?page=2, ?p=2). Arrêt : plus de nouveaux produits, total annoncé atteint ou pages maximum.',
  none: 'Seulement les produits de cette page.',
};
const TEST_ACTION = { button: 'page suivante', url: 'page suivante par l’adresse', load_more: '« charger plus »', infinite: 'défilement' };
const pag = { memo: null, savedIn: null, domain: '' };
const ctlName = (c) => c.text || c.label || 'bouton';
function testLine(lt, old) {
  const what = TEST_ACTION[lt.mode] || 'test';
  let when = ''; if (old && lt.at) { try { when = ` (dernier test, ${new Date(lt.at).toLocaleString('fr-BE', { dateStyle: 'short', timeStyle: 'short' })})`; } catch { when = ''; } }
  if (lt.ok) return `✓ ${what} : +${lt.added} nouveau(x) produit(s) (avant : ${lt.before} sur la page, après : ${lt.after})${when}.`;
  return `✗ ${what} : ${lt.reason || 'aucun nouveau produit'}${when}.`;
}
function renderPagination() {
  const { memo, savedIn, domain } = pag;
  const mode = state.settings.pagination || 'auto';
  $('#pagination-hint').textContent = PAG_HINT[mode] || '';
  const showNext = mode === 'auto' || mode === 'button'; const showMore = mode === 'auto' || mode === 'load_more';
  $('#pick-next-row').hidden = !showNext; $('#next-info').hidden = !showNext;
  $('#pick-more-row').hidden = !showMore; $('#more-info').hidden = !showMore;
  const n = memo && memo.next; const m = memo && memo.loadMore;
  $('#next-info').textContent = n ? `✓ « ${ctlName(n)} » mémorisé pour ce site.` : 'Aucun bouton montré : détection automatique (lien « suivant », numéro de page).';
  $('#forget-next').hidden = !n;
  $('#more-info').textContent = m ? `✓ « ${ctlName(m)} » mémorisé pour ce site.` : 'Aucun bouton montré : détection par son libellé (« Charger plus », « Voir plus »…).';
  $('#forget-more').hidden = !m;
  $('#pag-test').disabled = mode === 'none';
  $('#pag-saved').textContent = !memo ? '' : savedIn === 'app'
    ? `Enregistré pour ${domain || 'ce site'} dans l’application : le logiciel et ce panneau partagent ces réglages.`
    : 'Enregistré dans ce navigateur seulement : l’application est fermée ou plus ancienne que l’extension. Rouvrez cet onglet « Pages » quand elle est lancée et à jour pour le lui transmettre.';
  const out = $('#pag-test-result');
  if (!out.dataset.fresh) out.textContent = memo && memo.lastTest ? testLine(memo.lastTest, true) : '';
}
async function refreshPagination() {
  const tab = await activeTab();
  const r = await send('next_info', { tabId: tab && tab.id });
  if (r && r.ok) {
    // The site's mode kept in the app (shared with the .exe) wins over this browser's copy.
    if (r.memo && r.memo.mode && r.memo.mode !== state.settings.pagination) { state.settings.pagination = r.memo.mode; $('#pagination').value = r.memo.mode; save(); }
    Object.assign(pag, { memo: r.memo || null, savedIn: r.savedIn || null, domain: r.domain || '' });
    renderPagination();
  } else { Object.assign(pag, { memo: null, savedIn: null }); renderPagination(); $('#next-info').textContent = r && r.reason ? `Indisponible : ${r.reason}.` : ''; }
}
async function pickControl(kind) {
  const tab = await activeTab();
  const info = kind === 'load_more' ? $('#more-info') : $('#next-info');
  info.textContent = kind === 'load_more' ? 'Dans la page, cliquez sur le bouton « charger plus »… (Échap ou clic droit : annuler)' : 'Dans la page, cliquez sur le bouton « page suivante »… (Échap ou clic droit : annuler)';
  const r = await withEscape(tab, () => send('pick_next', { tabId: tab && tab.id, kind }));
  if (r && r.ok) { Object.assign(pag, { memo: r.memo || pag.memo, savedIn: r.savedIn || pag.savedIn }); renderPagination(); info.textContent = `✓ « ${r.text || 'bouton'} » mémorisé pour ce site. « Tester » l’essaie sur cette page.`; }
  else info.textContent = `Non retenu : ${(r && r.reason) || 'aucune réponse'}.`; // the reason stays on screen
}
async function forgetControl(kind) {
  const tab = await activeTab();
  const r = await send('forget_next', { tabId: tab && tab.id, kind });
  if (r && r.ok) Object.assign(pag, { memo: r.memo || null, savedIn: r.savedIn || null });
  renderPagination();
}
async function testPagination() {
  const btn = $('#pag-test'); const out = $('#pag-test-result');
  btn.disabled = true; out.dataset.fresh = '1'; out.textContent = 'Test en cours dans la page…';
  const tab = await activeTab();
  const r = await send('pagination_test', { tabId: tab && tab.id, fields: runFields(), card: state.card, mode: state.settings.pagination || 'auto' });
  btn.disabled = false;
  if (!r || !r.ok) { out.textContent = `Test impossible : ${(r && r.reason) || 'aucune réponse'}.`; return; }
  const extra = [];
  if (r.overlays && Array.isArray(r.overlays.closed) && r.overlays.closed.length) extra.push(`fermé avant le clic : ${r.overlays.closed.map((c) => `« ${c} »`).join(', ')}`);
  if (r.overlays && r.overlays.acceptOnly) extra.push('un bandeau ne propose que « Accepter » : laissé ouvert');
  if (r.total && Number.isInteger(r.total.total)) extra.push(`la liste annonce ${r.total.total} produits`);
  if (r.wentBack) extra.push('la liste est revenue à sa première page');
  out.textContent = testLine(r.test, false) + (extra.length ? ` ${extra.join(' · ')}.` : '');
  // The test is kept with the site's settings (the result line above stays as written).
  Object.assign(pag, { memo: { ...(pag.memo || {}), lastTest: r.test }, savedIn: r.savedIn || pag.savedIn });
  renderPagination();
}

function bindSettings() {
  const s = state.settings;
  $('#pagination').value = s.pagination; $('#max-pages').value = s.maxPages; $('#subpages').checked = s.subpages;
  $('#lang').value = s.lang; $('#max-products').value = s.maxProducts;
  $('#pagination').onchange = async (e) => {
    s.pagination = e.target.value; save(); delete $('#pag-test-result').dataset.fresh; renderPagination();
    const tab = await activeTab(); const r = await send('pagination_mode', { tabId: tab && tab.id, mode: s.pagination });
    if (r && r.ok) { Object.assign(pag, { memo: r.memo || pag.memo, savedIn: r.savedIn || pag.savedIn }); renderPagination(); }
  };
  $('#max-pages').onchange = (e) => { s.maxPages = Number(e.target.value) || 5; save(); };
  $('#subpages').onchange = (e) => { s.subpages = e.target.checked; save(); };
  $('#lang').onchange = (e) => { s.lang = e.target.value; save(); };
  $('#max-products').onchange = (e) => { s.maxProducts = Number(e.target.value) || 500; save(); };
  $('#max-product-pages').value = s.maxProductPages || 0;
  $('#max-product-pages').onchange = (e) => { s.maxProductPages = Math.max(0, Math.floor(Number(e.target.value) || 0)); e.target.value = s.maxProductPages; save(); if (state.rows) renderResults(state.meta || {}); };
}

async function main() {
  document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => showTab(b.getAttribute('data-tab'))));
  $('#field-list').addEventListener('input', onFieldInput);
  $('#field-list').addEventListener('click', onFieldClick);
  $('#add-field').addEventListener('click', addField);
  $('#template').addEventListener('change', (e) => applyTemplate(e.target.value));
  $('#ai-detect').addEventListener('click', aiDetect);
  $('#run').addEventListener('click', run);
  $('#run-top').addEventListener('click', run);
  $('#accept').addEventListener('click', accept);
  $('#reject').addEventListener('click', () => { state.rows = null; state.meta = null; state.accepted = null; finished = false; closeExportWarn(); renderResults({}); });
  $('#export-csv').addEventListener('click', exportCsv);
  $('#read-missing').addEventListener('click', readMissing);
  $('#export-accept').addEventListener('click', acceptThenExport);
  $('#export-anyway').addEventListener('click', writeExport);
  $('#export-cancel').addEventListener('click', closeExportWarn);
  $('#export-warn').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeExportWarn(); });
  $('#enrich-stop').addEventListener('click', () => enrichAction('stop'));
  $('#enrich-resume').addEventListener('click', () => enrichAction('resume'));
  $('#enrich-skip').addEventListener('click', () => enrichAction('skip'));
  $('#enrich-end').addEventListener('click', () => enrichAction('stop'));
  $('#enrich-open').addEventListener('click', openPausedPage);
  bindEnrichWatch();
  $('#activate').addEventListener('click', activateSite);
  $('#pick-next').addEventListener('click', () => pickControl('next'));
  $('#pick-more').addEventListener('click', () => pickControl('load_more'));
  $('#forget-next').addEventListener('click', () => forgetControl('next'));
  $('#forget-more').addEventListener('click', () => forgetControl('load_more'));
  $('#pag-test').addEventListener('click', testPagination);
  window.addEventListener('elo-tab', (e) => { if (e.detail === 'pages') { delete $('#pag-test-result').dataset.fresh; refreshPagination(); } });
  $('#job-stop').addEventListener('click', () => { if (currentJob) send('stop', { job_id: currentJob }).then(() => showJob('done', 'Travail abandonné.')); });
  $('#job-resume').addEventListener('click', () => { if (currentJob) send('resume', { job_id: currentJob }).then(() => showJob('running', 'Reprise…')); });
  await load();
  state.learnCols = await learnColumns();
  if (hasChrome && chrome.storage && chrome.storage.onChanged) chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.learnFields) learnColumns().then((c) => { state.learnCols = c; }); });
  { const sel = $('#template'); if (sel) sel.value = state.template; }
  renderFields();
  refreshTaught();
  window.addEventListener('elo-tab', (e) => { if (e.detail === 'fields') refreshTaught(); });
  if (!state.constants) state.constants = FIXED_DEFAULT();
  renderFixed();
  $('#fixed-list').addEventListener('input', onFixedInput);
  $('#fixed-list').addEventListener('change', onFixedInput);
  $('#fixed-list').addEventListener('click', onFixedClick);
  $('#fixed-add').addEventListener('click', addFixed);
  $('#fixed-save').addEventListener('click', saveFixed);
  $('#card-learn').addEventListener('click', () => cardDo('learn'));
  $('#card-not').addEventListener('click', () => cardDo('not_product'));
  $('#card-show').addEventListener('click', () => cardDo('show'));
  $('#card-forget').addEventListener('click', () => cardDo('forget'));
  $('#hub-pick').addEventListener('click', hubPick);
  $('#hub-forget').addEventListener('click', () => { state.hub = null; save(); renderHub(); });
  $('#hub-name').addEventListener('change', (e) => { if (state.hub) { state.hub = { ...state.hub, useName: e.target.checked }; save(); } });
  renderHub(); refreshCard();
  bindSettings();
  renderPagination();
  bindRecipes();
  restoreEnrichment();
  connectPort();
  refreshSite();
  refreshStatus();
  syncSiteValues();
  const s = await send('status'); if (s && s.jobs && s.jobs.length) { currentJob = s.jobs[0]; showJob('running', ''); }
  // Another tab, or another page in this tab: the panel follows (another site, another list page).
  if (hasChrome && chrome.tabs) {
    try { chrome.tabs.onActivated.addListener(() => watchSite()); } catch { /* polled below */ }
    try { chrome.tabs.onUpdated.addListener((id, info, tab) => { if (tab && tab.active && (info.url || info.status === 'complete')) watchSite(); }); } catch { /* polled below */ }
  }
  setInterval(() => { refreshStatus(); refreshSite(); watchSite(); }, 5000);
}
main();
