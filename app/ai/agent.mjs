/**
 * The side panel's chat AGENT (app side: the Claude key never leaves the app). The user talks about the
 * product page open in their browser; the agent reads it with tools that run HERE, on the page snapshot the
 * extension sent, with the same rule engine as every scrape — it says what it detected per field and what
 * is missing, accepts corrections in plain words (« la marque est fausse, regarde dans le fil d'Ariane »),
 * tests a candidate, and saves it as the site's rule (shared schema: the app and the extension replay it).
 *
 *   createAgentService({ knowledge, credentials, fetchImpl, onCall })  → { chat(url, {chatId, message, html, preview}) }
 *
 * The Messages API is called over raw HTTP like the app's other AI calls (app/ai/provider.mjs): a manual
 * tool-use loop, the conversation kept append-only per chat (thinking blocks passed back unchanged), no
 * forced tool choice, a server-side fallback on a refusal. Every model request is reported (ledger) and
 * counted in the reply (`aiCalls`).
 */
import { parseHTML } from 'linkedom';
import { withinDeadline, DeadlineError } from '../../shared/net/deadline.mjs';
import { condensePage } from '../../shared/knowledge/ai-locate.mjs';
import { ruleFromElement, readRule, applyKnowledge, proposeFromValues } from '../../shared/knowledge/apply.mjs';
import { growBlock } from '../../shared/knowledge/pick-block.mjs';
import { pageSelector } from '../../shared/knowledge/dom-locate.mjs';
import { newRule } from '../../shared/knowledge/rules.mjs';
import { structuredOf } from '../../shared/knowledge/structured.mjs';
import { pageJsonPayloads } from '../../shared/extract/product-group.mjs';
import { productIdsOf } from '../../shared/knowledge/state-values.mjs';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const AGENT_DEFAULT_MODEL = 'claude-opus-5-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const MAX_STEPS = 8;              // model requests per user message (tool loop)
const MAX_SESSIONS = 20; const SESSION_TTL_MS = 2 * 3600 * 1000;
const FIELDS = ['name', 'price', 'list_price', 'brand', 'category', 'description', 'variants', 'image', 'availability', 'sku', 'ean', 'technical_specs'];

export const AGENT_SYSTEM = `Tu es l'assistant d'Eloshon Scraper. L'utilisateur a ouvert une fiche produit d'une boutique en ligne et veut que l'application en extraie correctement les champs, puis les mêmes champs sur toutes les fiches du site.

Tu travailles avec des outils qui lisent la page telle que son navigateur l'a construite :
- propose_recipe : ce que l'application lit aujourd'hui pour chaque champ, et d'où (données déclarées par la page, règle apprise, détection) ;
- inspect_page : le plan numéroté des éléments de la page (filtrable par un texte) ;
- test_selector : essaie une façon de lire un champ (un numéro d'élément du plan, un sélecteur CSS, ou « declared » pour les données que la page déclare) et dit ce qu'elle lit ;
- save_recipe : enregistre cette façon de lire le champ comme règle du site ; l'application la vérifie sur d'autres fiches ;
- highlight_element : entoure un élément dans la page de l'utilisateur pour qu'il le voie.

Comment travailler :
- Commence par propose_recipe pour savoir ce qui est trouvé et ce qui manque, puis réponds en français, en phrases courtes : champ par champ, la valeur lue et d'où elle vient, puis les champs manquants.
- Quand l'utilisateur corrige un champ, cherche le bon bloc avec inspect_page, vérifie avec test_selector, montre-le avec highlight_element, et n'appelle save_recipe que lorsque le test lit la bonne valeur. Dis ensuite le résultat de la vérification sur les autres fiches.
- N'invente jamais une valeur : si rien ne la donne sur la page, dis-le.
- Ne parle ni de clés, ni de coûts, ni de fournisseurs.`;

const S = (props, required) => ({ type: 'object', properties: props, required, additionalProperties: false });
const FIELD_PROP = { type: 'string', description: `Le champ : ${FIELDS.join(', ')}, ou un nom de colonne libre (lettres, chiffres, _).` };
const WHERE = {
  element: { type: 'integer', description: 'Numéro d’un élément du plan donné par inspect_page.' },
  selector: { type: 'string', description: 'Un sélecteur CSS (si aucun numéro d’élément ne convient).' },
  source: { type: 'string', enum: ['declared'], description: '« declared » : lire ce que la page déclare elle-même (JSON-LD, microdonnées, balises meta).' },
};
export const AGENT_TOOLS = [
  { name: 'propose_recipe', description: 'Ce que l’application lit aujourd’hui sur cette page pour chaque champ produit (valeur courte et origine : règle apprise, données déclarées par la page, détection), et les champs que rien ne donne.', input_schema: S({}, []) },
  { name: 'inspect_page', description: 'Le plan numéroté des éléments utiles de la page (titres, textes, prix, listes, images). Avec `find`, seulement les lignes qui contiennent ce texte.', input_schema: S({ find: { type: 'string', description: 'Texte à chercher (insensible à la casse).' } }, []) },
  { name: 'test_selector', description: 'Essaie une façon de lire un champ sur cette page et renvoie la valeur lue (ou pourquoi rien n’est lu). N’enregistre rien.', input_schema: S({ field: FIELD_PROP, ...WHERE }, ['field']) },
  { name: 'save_recipe', description: 'Enregistre la façon de lire un champ comme règle du site (elle remplace l’ancienne pour ce champ) et la vérifie sur d’autres fiches du site. À n’utiliser qu’après un test_selector qui lit la bonne valeur.', input_schema: S({ field: FIELD_PROP, ...WHERE }, ['field']) },
  { name: 'highlight_element', description: 'Entoure un élément dans la page de l’utilisateur (il le voit à l’écran).', input_schema: S({ element: WHERE.element, selector: WHERE.selector, label: { type: 'string', description: 'Court texte affiché à côté.' } }, []) },
];

const short = (v) => {
  if (v == null) return null;
  if (Array.isArray(v)) return `${v.length} élément(s) : ${v.slice(0, 4).map((x) => (x && typeof x === 'object' ? (x.name ? `${x.name}${x.price != null ? ` (${x.price})` : ''}` : (x.value != null ? `${x.name || ''} : ${x.value}` : JSON.stringify(x))) : String(x))).join(' · ').slice(0, 300)}`;
  if (typeof v === 'object') return v.price != null ? `${v.price} ${v.currency || ''}`.trim() : JSON.stringify(v).slice(0, 200);
  return String(v).replace(/\s+/g, ' ').trim().slice(0, 300);
};
const FIELD_RE = /^[a-z][a-z0-9_]{0,39}$/i;

/** The tools, bound to ONE page snapshot (built per user message from the html the extension sent). */
export function createPageTools({ html, url, knowledge, actions, sampleUrls = [] }) {
  const doc = parseHTML(String(html || '')).document;
  let payloads = { json: [], jsonLd: [] }; try { payloads = pageJsonPayloads(String(html || '')); } catch { /* none */ }
  const ctx = { payloads: payloads.json, productIds: productIdsOf({ url, jsonLd: payloads.jsonLd }), html: String(html || ''), url };
  let outline = null; const getOutline = () => outline || (outline = condensePage(doc));
  const ruleFor = (input) => {
    const field = String(input.field || '');
    if (!FIELD_RE.test(field)) return { error: 'nom de champ invalide' };
    if (input.source === 'declared') return { rule: newRule({ field, origin: 'manual', selector: '__declared__', strategies: [{ kind: 'jsonld', requires: 'static' }], learnedFrom: url }) };
    if (Number.isInteger(input.element)) {
      let el = getOutline().nodes.get(input.element); if (!el) return { error: `élément ${input.element} introuvable dans le plan` };
      el = growBlock(el, field);
      return { rule: ruleFromElement(el, doc, { field, url, payloads: payloads.json, html: ctx.html }).rule };
    }
    if (typeof input.selector === 'string' && input.selector.trim()) {
      const sel = input.selector.trim().slice(0, 300);
      let el = null; try { el = doc.querySelector(sel); } catch { return { error: 'sélecteur CSS invalide' }; }
      if (!el) return { error: 'aucun élément ne correspond à ce sélecteur sur la page' };
      return { rule: ruleFromElement(growBlock(el, field), doc, { field, url, payloads: payloads.json, html: ctx.html }).rule };
    }
    return { error: 'indique un numéro d’élément, un sélecteur ou source « declared »' };
  };
  return {
    propose_recipe() {
      const k = knowledge && knowledge.forEngine(url);
      const applied = k ? applyKnowledge(doc, k, { url, html: ctx.html, payloads: payloads.json, productIds: ctx.productIds }) : { values: {}, sources: {}, trace: [] };
      let declared = {}; try { declared = structuredOf(ctx.html, url); } catch { declared = {}; }
      const fields = {};
      for (const f of FIELDS) {
        if (applied.values[f] != null) fields[f] = { value: short(applied.values[f]), from: `règle apprise (${applied.sources[f].origin === 'manual' ? 'désignée' : 'automatique'}, ${applied.sources[f].strategy})` };
        else if (declared[f]) fields[f] = { value: short(declared[f].value), from: `données déclarées par la page (${declared[f].kind})` };
        else {
          const failed = (applied.trace || []).filter((t) => t.field === f && !t.ok).map((t) => t.reason)[0];
          fields[f] = { value: null, from: failed ? `règle apprise en échec : ${failed}` : 'rien trouvé' };
        }
      }
      // (`specs` is the same list as technical_specs, under its row name: not a column of its own.)
      for (const [f, v] of Object.entries(applied.values)) if (!fields[f] && f !== 'specs') fields[f] = { value: short(v), from: 'règle apprise (colonne libre)' };
      return { url, fields, missing: Object.entries(fields).filter(([, x]) => x.value == null).map(([f]) => f) };
    },
    inspect_page({ find } = {}) {
      const text = getOutline().text;
      if (!find) return { outline: text.slice(0, 15000), truncated: text.length > 15000 };
      const want = String(find).toLowerCase();
      const lines = text.split('\n').filter((l) => l.toLowerCase().includes(want)).slice(0, 80);
      return { outline: lines.join('\n') || '(aucune ligne ne contient ce texte)', matches: lines.length };
    },
    test_selector(input = {}) {
      const r = ruleFor(input); if (r.error) return { ok: false, reason: r.error };
      const read = readRule(doc, r.rule, ctx);
      return read.ok ? { ok: true, value: short(read.value), strategy: read.strategy, selector: r.rule.selector } : { ok: false, reason: read.reason || 'rien lu', selector: r.rule.selector };
    },
    async save_recipe(input = {}) {
      const r = ruleFor(input); if (r.error) return { ok: false, reason: r.error };
      const read = readRule(doc, r.rule, ctx);
      if (!read.ok) return { ok: false, reason: `cette façon de lire ne lit rien ici (${read.reason || 'rien lu'}) : rien n’est enregistré` };
      if (!knowledge) return { ok: false, reason: 'application indisponible' };
      const res = await knowledge.learn(url, { scope: 'product', origin: 'manual', rules: [{ ...r.rule, example: short(read.value) || '' }], sampleUrls });
      const saved = res && res.ok && res.rules && res.rules[0];
      return saved ? { ok: true, field: input.field, value: short(read.value), checkedOn: `${saved.tests.ok}/${saved.tests.total} autre(s) fiche(s)`, describe: saved.describe } : { ok: false, reason: (res && res.reason) || 'enregistrement impossible' };
    },
    highlight_element(input = {}) {
      let selector = null;
      if (Number.isInteger(input.element)) { const el = getOutline().nodes.get(input.element); if (el) selector = pageSelector(el, doc); }
      else if (typeof input.selector === 'string') selector = input.selector.slice(0, 300);
      if (!selector) return { ok: false, reason: 'élément introuvable' };
      actions.push({ highlight: selector, label: String(input.label || '').slice(0, 60) });
      return { ok: true, selector };
    },
  };
}

/** One Messages API request (raw HTTP, like provider.mjs). Returns the parsed response. */
async function callMessages({ apiKey, model, messages, fetchImpl, timeoutMs, withFallback = true }) {
  const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) throw new Error('fetch_unavailable');
  const body = { model, max_tokens: 16000, system: [{ type: 'text', text: AGENT_SYSTEM, cache_control: { type: 'ephemeral' } }], tools: AGENT_TOOLS, messages, ...(withFallback ? { fallbacks: 'default' } : {}) };
  return withinDeadline(async (signal) => {
    const r = await doFetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', ...(withFallback ? { 'anthropic-beta': FALLBACK_BETA } : {}) },
      body: JSON.stringify(body), ...(signal ? { signal } : {}),
    });
    let text = ''; try { text = await r.text(); } catch { /* none */ }
    let data = null; try { data = JSON.parse(text); } catch { data = null; }
    return { status: r.status, ok: r.ok, data };
  }, { timeoutMs });
}

/**
 * Run the tool loop for one user message. `messages` is the chat so far (mutated: append-only).
 * @returns {Promise<{ ok:boolean, reply:string, aiCalls:number, stop:string|null, reason?:string }>}
 */
export async function runAgentTurn({ apiKey, model, messages, tools, fetchImpl, onCall, timeoutMs = 120000, maxSteps = MAX_STEPS }) {
  let aiCalls = 0; let withFallback = true;
  for (let step = 0; step < maxSteps; step++) {
    const t0 = Date.now();
    let res;
    try { res = await callMessages({ apiKey, model, messages, fetchImpl, timeoutMs, withFallback }); }
    catch (e) {
      const timedOut = e instanceof DeadlineError && e.kind === 'timeout';
      try { onCall && onCall({ ok: false, status: 0, reason: timedOut ? 'timeout' : 'network_error', durationMs: Date.now() - t0, model }); } catch { /* ignore */ }
      return { ok: false, reply: '', aiCalls: aiCalls + 1, stop: null, reason: timedOut ? 'l’assistant n’a pas répondu à temps' : 'le service d’IA est injoignable' };
    }
    aiCalls++;
    const d = res.data || {};
    // A platform that refuses the fallback parameter: the same request once more, without it.
    if (!res.ok && res.status === 400 && withFallback && /fallback/i.test(JSON.stringify(d.error || {}))) { withFallback = false; step--; continue; }
    try { onCall && onCall({ ok: !!res.ok, status: res.status, reason: res.ok ? null : `ai_http_${res.status}`, tokensIn: d.usage && d.usage.input_tokens, tokensOut: d.usage && d.usage.output_tokens, durationMs: Date.now() - t0, model: d.model || model }); } catch { /* ignore */ }
    if (!res.ok) return { ok: false, reply: '', aiCalls, stop: null, reason: res.status === 401 || res.status === 403 ? 'la clé d’assistance IA a été refusée' : (res.status === 429 ? 'le service d’IA est saturé, réessayez dans un instant' : 'le service d’IA n’a pas pu répondre') };
    const content = Array.isArray(d.content) ? d.content : [];
    // The whole assistant turn is kept as is (thinking, fallback, tool_use blocks): the history stays append-only.
    messages.push({ role: 'assistant', content });
    const text = content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('').trim();
    if (d.stop_reason === 'refusal') return { ok: true, reply: text || 'Je ne peux pas aider pour cette demande.', aiCalls, stop: 'refusal' };
    if (d.stop_reason !== 'tool_use') return { ok: true, reply: text || '(pas de réponse)', aiCalls, stop: d.stop_reason || null };
    // Every tool call of the turn, then ALL their results in one user message.
    const results = [];
    for (const b of content.filter((x) => x && x.type === 'tool_use')) {
      const fn = tools[b.name];
      let out; let isError = false;
      if (typeof fn !== 'function') { out = { error: `outil inconnu : ${b.name}` }; isError = true; }
      else { try { out = await fn(b.input && typeof b.input === 'object' ? b.input : {}); } catch (e) { out = { error: String((e && e.message) || e).slice(0, 200) }; isError = true; } }
      results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out).slice(0, 14000), ...(isError ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
  }
  // Out of steps: say it rather than loop on.
  return { ok: true, reply: 'J’ai fait plusieurs essais sans conclure. Dites-moi précisément quel champ corriger et où le trouver sur la page.', aiCalls, stop: 'max_steps' };
}

/** The per-turn context: what changed on the page side since the last message (kept short; tools give the rest). */
function contextBlock({ url, preview, knowledgeSummary }) {
  const rules = ((knowledgeSummary && knowledgeSummary.rules) || []).filter((r) => r.scope === 'product' && r.status !== 'superseded' && r.status !== 'deprecated').map((r) => `${r.field} (${r.origin === 'manual' ? 'désignée' : 'automatique'}, ${r.status}${r.warnings && r.warnings.length ? `, ⚠ ${r.warnings.map((w) => w.code).join('/')}` : ''})`);
  const lines = [`Page ouverte : ${url}`, `Règles déjà apprises sur ce site : ${rules.length ? rules.join(' ; ') : 'aucune'}`];
  if (preview && typeof preview === 'object') lines.push(`Dernier aperçu dans le panneau : ${JSON.stringify(preview).slice(0, 1500)}`);
  return `<contexte>\n${lines.join('\n')}\n</contexte>`;
}

/**
 * @param {{ knowledge:object, credentials:()=>({apiKey:string, model?:string}|null), fetchImpl?:Function, onCall?:Function, now?:()=>number }} io
 */
export function createAgentService({ knowledge, credentials, fetchImpl, onCall, now = Date.now } = {}) {
  const sessions = new Map(); // chatId → { messages, at, url }
  const sweep = () => { for (const [id, s] of sessions) if (now() - s.at > SESSION_TTL_MS) sessions.delete(id); while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value); };
  return {
    /** One user message about the page open in the user's browser. */
    async chat(url, { chatId, message, html, preview = null, sampleUrls = [] } = {}) {
      const creds = credentials ? credentials() : null;
      if (!creds || !creds.apiKey) return { ok: false, reason: 'aucune clé d’assistance IA n’est configurée dans l’application (Administration)' };
      if (typeof message !== 'string' || !message.trim()) return { ok: false, reason: 'message vide' };
      if (typeof html !== 'string' || html.length < 200) return { ok: false, reason: 'la page n’a pas pu être lue' };
      const id = typeof chatId === 'string' && /^[\w-]{4,64}$/.test(chatId) ? chatId : `ch_${now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      sweep();
      const s = sessions.get(id) || { messages: [], at: now(), url };
      const actions = [];
      const tools = createPageTools({ html, url, knowledge, actions, sampleUrls });
      let summary = null; try { summary = knowledge ? knowledge.summary(url) : null; } catch { summary = null; }
      s.messages.push({ role: 'user', content: [{ type: 'text', text: contextBlock({ url, preview, knowledgeSummary: summary }) }, { type: 'text', text: message.trim().slice(0, 4000) }] });
      const r = await runAgentTurn({ apiKey: creds.apiKey, model: creds.model || AGENT_DEFAULT_MODEL, messages: s.messages, tools, fetchImpl, onCall });
      s.at = now(); s.url = url; sessions.set(id, s);
      return { ok: r.ok, chatId: id, reply: r.reply, actions, aiCalls: r.aiCalls, stop: r.stop, ...(r.reason ? { reason: r.reason } : {}) };
    },
    reset(chatId) { return sessions.delete(chatId); },
  };
}
