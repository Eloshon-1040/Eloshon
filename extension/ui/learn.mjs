/**
 * "Fiche produit" tab — teach the site on ONE product page. The user designates, with the
 * mouse, the block of each field that only the product page holds (description, technical
 * specifications, brand…); the rule is stored by the app for the whole site, checked on
 * other product pages, and used later when a collection of this site is scraped. The ✨
 * button proposes the same rules from the page's own data; a 🎯 always wins over it.
 *
 * Nothing here is cosmetic: every button goes through the service worker to the app
 * (knowledge_pick / knowledge_learn / knowledge_propose / knowledge_summary / knowledge_forget).
 */
import { fieldMeaning, suggestRole, freeKey, ROLES, ROLE_LABEL } from '../vendor/shared/extract/field-meaning.mjs';
import { previewLines } from '../vendor/shared/knowledge/preview.mjs';

const $ = (sel) => document.querySelector(sel);
const hasChrome = typeof chrome !== 'undefined' && chrome.runtime;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const BASE_FIELDS = [
  { field: 'name', label: 'Nom du produit' },
  { field: 'price', label: 'Prix' },
  { field: 'list_price', label: 'Prix barré (avant remise)' },
  { field: 'description', label: 'Description' },
  { field: 'technical_specs', label: 'Caractéristiques techniques' },
  { field: 'variants', label: 'Variantes (tailles, contenances, couleurs…)' },
  { field: 'image', label: 'Images' },
  { field: 'brand', label: 'Marque' },
  { field: 'category', label: 'Collection / catégorie' },
  { field: 'sku', label: 'Référence' },
  { field: 'ean', label: 'Code EAN' },
  { field: 'availability', label: 'Disponibilité' },
];
const STATUS_TEXT = { active: 'active', proposed: 'proposée (à confirmer)', failing: 'en échec — à refaire', superseded: 'remplacée', deprecated: 'abandonnée' };
const ORIGIN_TEXT = { manual: 'manuelle', ai: 'IA' };

// The app that answers is older than this panel: it cannot store rules (nothing would be kept).
const OLD_APP_HTML = '<b>Application à mettre à jour</b><div class="hint" style="margin:4px 0 0">L’application Eloshon ouverte est une version plus ancienne que l’extension : elle ne sait pas encore enregistrer les champs appris ici, donc rien n’est gardé. Ferme-la et lance la nouvelle version, puis recommence.</div>';
const reasonText = (r) => (/demande inconnue/.test((r && r.reason) || '') ? 'l’application ouverte est trop ancienne pour enregistrer ce champ (voir l’encadré rouge)' : ((r && r.reason) || 'pas de réponse de l’application'));
let custom = [];            // fields the user added on this tab
let rules = [];             // what the app knows about this site
let repairs = [];           // repairs of rules that failed during runs (proposed / applied / …)
let pending = null;         // a block just designated, waiting for "Enregistrer ce champ"
// Fields whose rule is being saved / checked on other pages. NEVER blocks the panel: the user keeps designating the next field.
const saving = new Map();

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
const toast = (m) => { const t = $('#learn-toast'); if (t) t.textContent = m || ''; };
// A field the user added that is now a base field (e.g. « Image ») is shown once.
const fieldsAll = () => [...BASE_FIELDS, ...custom.filter((c) => !BASE_FIELDS.some((b) => b.field === c.field))];
const ruleOf = (field) => rules.filter((r) => r.field === field && r.scope === 'product' && r.status !== 'superseded' && r.status !== 'deprecated').sort((a, b) => (a.origin === 'manual' ? -1 : 1) - (b.origin === 'manual' ? -1 : 1))[0] || null;

async function loadCustom() {
  if (!hasChrome || !chrome.storage) return;
  try { const all = await chrome.storage.local.get('learnFields'); custom = Array.isArray(all.learnFields) ? all.learnFields.filter((f) => f && f.field && f.label).slice(0, 12) : []; } catch { custom = []; }
}
async function saveCustom() { try { await chrome.storage.local.set({ learnFields: custom }); } catch { /* ignore */ } }

function renderFields() {
  const box = $('#learn-fields'); if (!box) return;
  box.innerHTML = fieldsAll().map((f, i) => {
    const r = ruleOf(f.field);
    const line = saving.has(f.field)
      ? '<div class="picked">⏳ Enregistré — vérification de ce champ sur d’autres fiches du site en cours… tu peux continuer avec un autre champ.</div>'
      : r
      ? `<div class="picked"><span class="badge ${esc(r.origin)}">${esc(ORIGIN_TEXT[r.origin] || r.origin)}</span> ${esc(STATUS_TEXT[r.status] || r.status)} · ${esc(r.describe)}${r.example ? ` · « ${esc(String(r.example).slice(0, 60))} »` : ''}</div>`
      : '<div class="picked">Pas encore appris — clique sur 🎯 puis sur le bloc dans la fiche produit.</div>';
    return `<div class="field"><div class="top"><span class="ico">${f.field === 'technical_specs' ? '☰' : (f.field === 'variants' ? '▦' : (f.field === 'image' ? '🖼' : (f.field === 'price' || f.field === 'list_price' ? '€' : '¶')))}</span><span style="flex:1;font-weight:600">${esc(f.label)}</span>${i >= BASE_FIELDS.length ? `<button class="iconbtn" data-act="drop" data-i="${i}" title="Retirer ce champ">✕</button>` : ''}<button class="iconbtn" data-act="pick" data-i="${i}" title="Désigner à la souris">🎯</button></div>${i >= BASE_FIELDS.length ? roleLine(f, i) : ''}${line}</div>`;
  }).join('');
}

const VIA_TEXT = { declared: 'données que la page déclare', detection: 'détection automatique', ai: 'IA de l’application' };
// Repairs of rules that failed during a scraping: a proposal waits for the user, an automatic one can be undone.
function repairsHtml() {
  const label = (f) => fieldsAll().find((x) => x.field === f)?.label || f;
  return repairs.filter((r) => r.status === 'proposed' || r.status === 'applied').map((r) => `<div class="card ${r.status === 'proposed' ? 'bad' : 'ok'}"><div><b>${esc(label(r.field))}</b> — ${r.status === 'proposed' ? 'votre règle échoue sur les dernières fiches ; réparation proposée' : 'règle réparée automatiquement'} (${esc(VIA_TEXT[r.via] || r.via)}, vérifiée sur ${esc(r.tests.ok)}/${esc(r.tests.total)} fiches).</div><div class="row" style="margin-top:4px">${r.status === 'proposed' ? `<button class="btn primary sm" data-act="repair-accept" data-id="${esc(r.id)}">✓ Accepter</button><button class="btn ghost sm" data-act="repair-reject" data-id="${esc(r.id)}">Refuser</button>` : `<button class="btn ghost sm" data-act="repair-undo" data-id="${esc(r.id)}">Annuler la réparation</button>`}</div></div>`).join('');
}

function renderRules() {
  const box = $('#learn-rules'); if (!box) return;
  const live = rules.filter((r) => r.scope === 'product' && r.status !== 'superseded' && r.status !== 'deprecated');
  if (!live.length && !repairs.length) { box.innerHTML = '<div class="hint">Rien d’appris pour l’instant.</div>'; return; }
  box.innerHTML = repairsHtml() + live.map((r) => `<div class="card"><div class="row"><b>${esc(fieldsAll().find((f) => f.field === r.field)?.label || r.field)}</b> <span class="badge ${esc(r.origin)}">${esc(ORIGIN_TEXT[r.origin] || r.origin)}</span> <span class="badge">v${esc(r.version)}</span><button class="linkbtn" style="margin-left:auto" data-act="retest" data-field="${esc(r.field)}">revérifier</button><button class="linkbtn" data-act="forget" data-field="${esc(r.field)}">oublier</button></div><div class="hint" style="margin:4px 0 0">${esc(STATUS_TEXT[r.status] || r.status)} · ${esc(r.describe)}${r.general ? ' · appliquée à tout le site' : ''}</div>${(r.warnings || []).filter((w) => w.code !== 'untested').map((w) => `<div class="hint" style="margin:4px 0 0;color:#b4232a">⚠ ${esc(w.text)} <b>${esc(w.fix)}</b></div>`).join('')}</div>`).join('');
}

function renderPending() {
  const box = $('#learn-pending'); if (!box) return;
  if (!pending) { box.innerHTML = ''; return; }
  const r = pending.result;
  // One line per entry, typed by field (pictures as thumbnails + their address, specs as "name : value",
  // variants as "30 ml — 49.99 € (épuisé)"): shared/knowledge/preview.mjs, the only formatter.
  const lines = previewLines(pending.field, r.sample);
  const sample = lines.map((l) => (l.image ? `<div class="pic"><img src="${esc(l.image)}" alt="" loading="lazy" referrerpolicy="no-referrer"><span>${esc(l.text)}</span></div>` : `<div>${esc(l.text)}</div>`)).join('');
  box.innerHTML = r.ok
    ? `<div class="card ok"><div><b>Compris :</b> « ${esc(pending.label)} » = ${esc(r.summary)}</div><div class="sample">${sample}</div><div class="hint" style="margin:4px 0">Enregistre seulement ce champ, puis le vérifie en arrière-plan sur quelques autres fiches du site. Cela ne lance aucun scraping : continue avec les autres champs.</div><div class="row"><button class="btn primary sm" data-act="save">✓ Enregistrer ce champ</button><button class="btn sm" data-act="redo">Refaire</button><button class="btn ghost sm" data-act="cancel">Annuler</button></div></div>`
    : `<div class="card bad"><div><b>Non retenu :</b> ${esc(r.reason || 'bloc illisible')}</div>${sample ? `<div class="sample">${sample}</div>` : ''}<div class="row"><button class="btn sm" data-act="redo">Refaire</button><button class="btn ghost sm" data-act="cancel">Fermer</button></div></div>`;
}

async function refresh() {
  const tab = await activeTab();
  const k = await send('knowledge_summary', { tabId: tab && tab.id });
  if (k && k.ok) { rules = k.rules || []; repairs = k.repairs || []; }
  const old = !!(k && !k.ok && /demande inconnue/.test(k.reason || ''));
  const warn = $('#learn-app');
  if (warn) { warn.style.display = old ? 'block' : 'none'; warn.innerHTML = old ? OLD_APP_HTML : ''; }
  renderFields(); renderRules();
  const pk = await send('page_kind', { tabId: tab && tab.id });
  const el = $('#learn-page');
  if (el) el.textContent = pk && pk.ok ? (pk.kind === 'product' ? '✓ Cette page est une fiche produit : tu peux désigner les blocs.' : (pk.kind === 'listing' ? 'Cette page est une liste de produits — ouvre une fiche produit pour désigner la description et les caractéristiques.' : 'Cette page n’est pas reconnue comme une fiche produit : si c’en est une, tu peux quand même désigner les blocs.')) : '';
}

async function pickField(i) {
  const f = fieldsAll()[i]; if (!f) return;
  toast(`Dans la page, clique sur le bloc « ${f.label} » (molette : agrandir / réduire). Échap ou clic droit pour annuler.`);
  const tab = await activeTab();
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); send('pick_cancel', { tabId: tab && tab.id }); } };
  document.addEventListener('keydown', onKey, true);
  let r;
  try { r = await send('knowledge_pick', { tabId: tab && tab.id, field: f.field, label: f.label }); } finally { document.removeEventListener('keydown', onKey, true); }
  if (r && !r.ok && r.reason === 'annulé') { toast(`Désignation de « ${f.label} » annulée.`); return; }
  pending = { field: f.field, label: f.label, index: i, result: r || { ok: false, reason: 'aucune réponse' } };
  toast(pending.result.ok ? 'Vérifie ce que le système a compris, puis enregistre.' : '');
  renderPending();
}

// "Enregistrer ce champ": the designation leaves the card at once and the app stores it, then checks it on other
// product pages in the background — the panel stays usable (another 🎯, another tab). Nothing waits on the test.
async function savePending() {
  if (!pending || !pending.result.ok) return;
  const job = pending; pending = null; renderPending();
  const r0 = job.result; const tab = await activeTab();
  saving.set(job.field, true); renderFields();
  toast(`« ${job.label} » enregistré. Vérification sur d’autres fiches du site en cours… Tu peux continuer avec un autre champ.`);
  let r;
  try { r = await send('knowledge_learn', { tabId: tab && tab.id, rule: r0.rule, pageUrl: r0.pageUrl, sampleUrls: r0.sampleUrls }); }
  finally { saving.delete(job.field); }
  if (!r || !r.ok) {
    // The rule is stored before the test starts: a slow answer is not a lost rule — show what the app holds.
    toast(`« ${job.label} » non enregistré : ${reasonText(r)}.`);
    await refresh(); return;
  }
  const mine = (r.rules || []).find((x) => x.field === job.field) || (r.rules || [])[0];
  const fails = mine && mine.failures && mine.failures.length ? ` Échecs : ${mine.failures.slice(0, 2).map((x) => x.reason).join(' ; ')}.` : '';
  const bc = r.browserCheck || null;
  const viaBrowser = bc && bc.read ? ` Vérifiée sur ${bc.read} autre(s) fiche(s) ouverte(s) dans votre navigateur (le site refuse la lecture directe).` : '';
  const challenged = bc && bc.challenged ? ` ${bc.challenged} fiche(s) ont affiché une vérification « êtes-vous humain ? » : ouvrez une fiche du site dans ce navigateur, répondez-y, puis cliquez « revérifier ».` : '';
  const none = r.sampled === 0 || (bc && !bc.read) ? ' Aucune autre fiche du site n’a pu être lue pour le test : la règle est enregistrée mais pas encore testée ailleurs que sur cette fiche ; sa fiabilité se mesurera au prochain scraping.' : '';
  toast(`✓ « ${job.label} » enregistré et vérifié. ${mine ? mine.describe : ''}${r.unreachable && !(bc && bc.read) ? ` (${r.unreachable} fiche(s) non lue(s))` : ''}.${fails}${viaBrowser}${challenged}${none}`);
  await refresh();
}

async function aiPropose() {
  const btn = $('#learn-ai'); if (btn) btn.disabled = true;
  toast('✨ Analyse de la fiche… (quelques secondes)');
  try {
    const tab = await activeTab();
    const r = await send('knowledge_propose', { tabId: tab && tab.id });
    if (!r || !r.ok) { toast(`IA : ${reasonText(r)}.`); await refresh(); return; }
    const d = r.detected || {};
    const bits = [d.description ? 'description' : null, d.specs ? `${d.specs} caractéristique(s)` : null, d.brand ? 'marque' : null, d.sku ? 'référence' : null].filter(Boolean);
    const aiLine = r.ai ? (r.ai.ok ? (r.ai.located.length ? ` L’IA a trouvé : ${r.ai.located.join(', ')} (vérifié sur d’autres fiches).` : (r.ai.asked.length ? ` L’IA n’a rien trouvé de plus pour : ${r.ai.asked.join(', ')}.` : '')) : (r.ai.reason === 'ai_key_missing' ? '' : ` IA indisponible : ${r.ai.reason}.`)) : ' (Clé IA non configurée dans l’application : seule la détection automatique a été utilisée.)';
    toast(`✓ Fiche reconnue${bits.length ? ` : ${bits.join(', ')}` : ''}. ${r.located && r.located.length ? `Règles proposées : ${r.located.join(', ')} — confirme-les ou corrige-les avec 🎯.` : 'Aucun bloc retrouvé par la détection automatique.'}${aiLine}`);
    await refresh();
  } finally { if (btn) btn.disabled = false; }
}

// A field the user adds keeps the name typed; its role for the Converter is suggested and can be changed. A name
// that looks like a field already listed (« Nom de variante » next to « Nom du produit ») never blocks: at most a hint.
function addField() {
  const input = $('#learn-newname'); const clean = ((input && input.value) || '').trim().slice(0, 40);
  if (!clean) { toast('Écrivez d’abord le nom du champ (ex. « Garantie »).'); return; }
  const role = suggestRole({ label: clean });
  const field = freeKey(clean, new Set(fieldsAll().map((f) => f.field)));
  const fold = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  const near = fieldsAll().find((f) => fold(f.label) === fold(clean) || (BASE_FIELDS.some((b) => b.field === f.field) && f.field === fieldMeaning({ label: clean }) && role !== 'variant_name' && role !== 'size' && role !== 'color' && role !== 'option'));
  custom.push({ field, label: clean, role }); saveCustom(); renderFields(); if (input) input.value = '';
  toast(near
    ? `« ${clean} » ajouté. Il ressemble à « ${near.label} » : si c’est le même renseignement, désignez plutôt « ${near.label} » ; sinon, gardez ce champ et vérifiez son rôle.`
    : `« ${clean} » ajouté, rôle pour le Converter : ${ROLE_LABEL[role]} (modifiable). Cliquez sur 🎯 puis sur le bloc dans la fiche produit.`);
}

function roleLine(f, i) {
  const cur = f.role || suggestRole(f);
  return `<div class="meaning"><label>Rôle pour le Converter <select data-role-i="${i}" aria-label="Rôle de « ${esc(f.label)} » pour le Converter">${ROLES.map((r) => `<option value="${r}"${r === cur ? ' selected' : ''}>${esc(ROLE_LABEL[r])}</option>`).join('')}</select></label></div>`;
}

async function main() {
  await loadCustom();
  const root = $('#pane-learn'); if (!root) return;
  root.addEventListener('change', (e) => {
    const sel = e.target.closest && e.target.closest('select[data-role-i]'); if (!sel) return;
    const f = fieldsAll()[Number(sel.getAttribute('data-role-i'))]; const c = f && custom.find((x) => x.field === f.field);
    if (c && ROLES.includes(sel.value)) { c.role = sel.value; saveCustom(); toast(`Rôle de « ${c.label} » : ${ROLE_LABEL[c.role]}.`); }
  });
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.getAttribute('data-act');
    if (act === 'pick') pickField(Number(b.getAttribute('data-i')));
    else if (act === 'drop') { const f = fieldsAll()[Number(b.getAttribute('data-i'))]; if (f) custom = custom.filter((c) => c.field !== f.field); saveCustom(); renderFields(); }
    else if (act === 'save') savePending();
    else if (act === 'redo') { const i = pending ? pending.index : -1; pending = null; renderPending(); if (i >= 0) pickField(i); }
    else if (act === 'cancel') { pending = null; renderPending(); toast(''); }
    else if (act === 'retest') { const field = b.getAttribute('data-field'); toast('Vérification de ce champ sur quelques fiches du site…'); const tab = await activeTab(); const r = await send('knowledge_retest', { tabId: tab && tab.id, field }); toast(r && r.ok ? `✓ ${(r.rules && r.rules[0] && r.rules[0].describe) || 'Revérifié'}.` : `Revérification impossible : ${reasonText(r)}.`); refresh(); }
    else if (act === 'repair-accept' || act === 'repair-reject' || act === 'repair-undo') {
      const tab = await activeTab(); const action = act.slice(7);
      const r = await send('knowledge_repair', { tabId: tab && tab.id, action, id: b.getAttribute('data-id') });
      toast(r && r.ok ? ({ accept: 'Réparation acceptée : elle devient votre règle pour ce champ.', reject: 'Réparation refusée : votre règle reste telle quelle.', undo: 'Réparation annulée : la règle précédente est de nouveau utilisée.' })[action] : `Impossible : ${(r && r.reason) || 'aucune réponse'}`);
      refresh();
    }
    else if (act === 'forget') { const tab = await activeTab(); const r = await send('knowledge_forget', { tabId: tab && tab.id, field: b.getAttribute('data-field') }); toast(r && r.ok ? 'Règles oubliées pour ce champ.' : `Impossible : ${(r && r.reason) || 'aucune réponse'}`); refresh(); }
  });
  $('#learn-ai').addEventListener('click', aiPropose);
  $('#learn-add').addEventListener('click', addField);
  window.addEventListener('elo-propose', aiPropose);
  window.addEventListener('elo-tab', (e) => { if (e.detail === 'learn') refresh(); });
  renderFields();
}
main();
