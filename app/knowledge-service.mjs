/**
 * Site knowledge service (app side): the ops the side panel and the scrape engine use to
 * teach, test, list, correct and forget the rules of a site. Everything goes through the
 * domain profile store (one persistence), with the priority rules of shared/knowledge.
 *
 *   learn    — rules designated with the mouse (manual) → stored → CHECKED on other product
 *              pages of the site ("testée : 4/5 fiches · confiance élevée") → stored result
 *   propose  — the generic detection read this page; the values found become PROPOSED rules
 *              (origin 'ai'): they never displace a manual rule
 *   summary  — what the site knows (for the panel)
 *   retire   — the user forgets a field's rules
 *
 * Inputs come from the extension: validated and bounded here.
 */
import { parseHTML } from 'linkedom';
import { newRule, describeRule, testLabel, isGeneral, ruleConfidence, chainFor, emptyKnowledge, auditRule, addRepair, acceptRepair, rejectRepair, undoRepair, upsertRule } from '../shared/knowledge/rules.mjs';
import { isUnstableClass } from '../shared/extract/pick-selector.mjs';
import { testRule, proposeFromValues, ruleFromElement, readRule } from '../shared/knowledge/apply.mjs';
import { condensePage, stateSummary, buildLocatePrompt, parseLocateAnswer, AI_FIELDS } from '../shared/knowledge/ai-locate.mjs';
import { growBlock } from '../shared/knowledge/pick-block.mjs';
import { knownFields } from '../shared/knowledge/rules.mjs';
import { extractProduct } from '../core/extract.mjs';
import { hostKey } from '../core/domain-profile.mjs';
import { pageJsonPayloads } from '../shared/extract/product-group.mjs';
import { productIdsOf } from '../shared/knowledge/state-values.mjs';

export const MAX_SAMPLE_PAGES = 6;
const PAGE_TIMEOUT_MS = 8000;     // one product page
const CHECK_BUDGET_MS = 20000;    // the whole check on other pages
const MAX_RULES = 12;
const FIELD_RE = /^[a-z][a-z0-9_]{0,39}$/i;
const MODES = new Set(['text', 'pairs', 'attr', 'list', 'image']);
const IMAGE_SOURCES = new Set(['dom', 'jsonld', 'microdata', 'og', 'state']);

const httpUrl = (u) => { try { const x = new URL(String(u)); return /^https?:$/.test(x.protocol) ? x.toString() : null; } catch { return null; } };
const bounded = (o, max) => { try { const s = JSON.stringify(o); return s && s.length <= max ? JSON.parse(s) : null; } catch { return null; } };

/** One rule from the extension → a plain rule (or null when it is not usable). */
export function sanitizeRule(r, { scope, learnedFrom, origin }) {
  if (!r || typeof r !== 'object') return null;
  const field = String(r.field || '').trim();
  if (!FIELD_RE.test(field)) return null;
  if (typeof r.selector !== 'string' || !r.selector || r.selector.length > 500) return null;
  const fingerprint = r.fingerprint ? bounded(r.fingerprint, 6000) : null;
  const ex = r.extract && typeof r.extract === 'object' ? r.extract : {};
  const extract = { ...(MODES.has(ex.mode) ? { mode: ex.mode } : {}), ...(typeof ex.attr === 'string' && /^[\w:@-]{1,40}$/.test(ex.attr) ? { attr: ex.attr } : {}), ...(IMAGE_SOURCES.has(ex.source) ? { source: ex.source } : {}), ...(ex.multiline != null ? { multiline: !!ex.multiline } : {}), ...(typeof ex.label === 'string' ? { label: ex.label.slice(0, 80) } : {}) };
  const state = r.state && typeof r.state.key === 'string' && /^[\w:$.-]{1,60}$/.test(r.state.key) ? { key: r.state.key } : null;
  return newRule({ scope, field, origin, selector: r.selector, fingerprint, extract, example: typeof r.example === 'string' ? r.example : '', learnedFrom, ...(state ? { state } : {}), ...(Array.isArray(r.strategies) ? { strategies: r.strategies } : {}) });
}

/** The fields a new site is onboarded for (the product page's standard fields). */
export const ONBOARD_FIELDS = ['name', 'price', 'list_price', 'brand', 'category', 'description', 'variants', 'image', 'availability', 'sku', 'ean', 'technical_specs'];
/** A repair must read on at least this many product pages to be kept. */
export const REPAIR_MIN_OK = 2;
// The generic reader's values for a field (each one located back in the page as a block; the repair keeps
// the block that reads on most product pages). A product's name is usually its page's main title too.
const h1Of = (doc) => { try { const h = doc.querySelector('h1'); const t = h ? String(h.textContent || '').replace(/\s+/g, ' ').trim() : ''; return t.length >= 2 && t.length <= 200 ? t : null; } catch { return null; } };
const DETECTABLE = {
  name: (p, doc) => [h1Of(doc), p.name], brand: (p) => [p.brand], sku: (p) => [p.sku], ean: (p) => [p.gtin],
  description: (p) => [p.description && String(p.description).length >= 30 ? String(p.description) : null],
  technical_specs: (p) => [Array.isArray(p.specs) && p.specs.length >= 2 ? p.specs : null],
  price: (p) => [p.price != null ? { price: p.price, currency: p.currency || null } : null],
  image: (p, doc) => [Array.isArray(p.images) && p.images.length ? p.images : null, doc ? namedImage(doc) : null],
  category: (p, doc) => [Array.isArray(p.breadcrumb) && p.breadcrumb.length ? p.breadcrumb : null, doc ? domTrail(doc) : null],
  availability: (p, doc) => [doc ? stockLine(doc) : null],
};
// Widespread page conventions (never a site's own names): the trail marked « breadcrumb » (class, aria-label,
// schema.org type), the picture whose alt text is the product's name, a short stock statement.
function domTrail(doc) {
  try {
    const box = doc.querySelector('nav[aria-label*="readcrumb" i], [class*="breadcrumb" i], [itemtype*="BreadcrumbList"], [aria-label*="fil d" i]');
    if (!box) return null;
    const steps = [...box.querySelectorAll('li, a')].filter((n) => !n.querySelector('li, a')).map((n) => String(n.textContent || '').replace(/\s+/g, ' ').trim()).filter((t) => t && t.length <= 80);
    const uniq = steps.filter((t, i) => steps.indexOf(t) === i);
    return uniq.length >= 2 ? uniq : null;
  } catch { return null; }
}
function namedImage(doc) {
  try {
    const name = h1Of(doc); if (!name) return null;
    const want = name.toLowerCase().replace(/\s+/g, ' ');
    const img = [...doc.querySelectorAll('img[alt]')].find((i) => String(i.getAttribute('alt') || '').toLowerCase().replace(/\s+/g, ' ').trim() === want);
    const src = img && (img.getAttribute('src') || img.getAttribute('data-src'));
    return src ? [src] : null;
  } catch { return null; }
}
const STOCK_RE = /^(?:in stock|out of stock|en stock|disponible|indisponible|rupture de stock|épuisé|op voorraad|niet op voorraad|auf lager|nicht auf lager|en existencia|agotado|disponibile|esaurito)\b/i;
function stockLine(doc) {
  try {
    for (const e of doc.querySelectorAll('p, span, div, li, strong')) { if (e.children.length > 2) continue; const t = String(e.textContent || '').replace(/\s+/g, ' ').trim(); if (t.length <= 60 && STOCK_RE.test(t)) return t; }
  } catch { /* none */ }
  return null;
}

/** The repairs as the panel shows them (the newest first), with the field and how they were found. */
export function publicRepairs(k) {
  return (Array.isArray(k && k.repairs) ? k.repairs : []).slice(-10).reverse().map((r) => ({ id: r.id, field: r.field, via: r.via, status: r.status, tests: r.tests, at: r.at }));
}

/** A rule as the panel shows it (no selectors or fingerprints), with what is fragile about it. */
export function publicRule(rule, knowledge = null) {
  const c = ruleConfidence(rule); const t = testLabel(rule);
  return {
    warnings: auditRule(rule, knowledge, isUnstableClass),
    strategies: (rule.strategies || []).map((s) => ({ kind: s.kind, requires: s.requires })),
    id: rule.id, scope: rule.scope, field: rule.field, origin: rule.origin, status: rule.status, version: rule.version,
    // tests = OTHER product pages only; taughtOnly = read on the teaching page and nowhere else yet.
    example: rule.example || '', tests: { ok: t.ok, total: t.total }, taughtOnly: !t.total, label: t.label, general: isGeneral(rule), confidence: c.score,
    describe: describeRule(rule), confirmedAi: !!rule.confirmedAi,
  };
}

/**
 * @param {{ profiles:{get:Function, hints:Function, record:Function}, fetchHtml:(url:string)=>Promise<{ok:boolean,html?:string}>, now?:()=>string }} io
 */
export function createKnowledgeService({ profiles, fetchHtml, aiAsker = () => null, now = () => new Date().toISOString() }) {
  const knowledgeOf = (url) => { const p = profiles.get(url); return (p && p.siteKnowledge) || emptyKnowledge(); };
  const findLive = (k, scope, field, selector) => k.rules.find((r) => r.scope === scope && r.field === field && r.selector === selector && r.status !== 'superseded' && r.status !== 'deprecated') || null;

  // `rendered`: product pages the user's browser already built and sent (Map url → html). They are
  // used before any HTTP read — on a site that refuses plain HTTP they are the only readable pages.
  async function samplePages(pageUrl, urls, rendered = null, fetchPage = fetchHtml) {
    const any = pageUrl === 'about:blank'; // retest: the given pages, the learned one included
    const own = rendered instanceof Map ? rendered : null;
    const pool = [...(own ? own.keys() : []), ...(urls || [])];
    const host = any ? hostKey(pool[0] || '') : hostKey(pageUrl); const here = any ? '' : String(pageUrl).split('#')[0];
    const seen = new Set([here]); const picked = [];
    for (const u of pool) { const h = httpUrl(u); if (!h) continue; const k = h.split('#')[0]; if (seen.has(k) || hostKey(h) !== host) continue; seen.add(k); picked.push(h); if (picked.length >= MAX_SAMPLE_PAGES - (any ? 0 : 1)) break; }
    // The pages are read side by side, each with its own time limit and the whole check inside a budget:
    // a slow or blocking site must never keep the panel waiting (a page not read in time is « injoignable »).
    const read = async (u) => {
      const got = own && own.get(String(u).split('#')[0]);
      let timer; const limit = new Promise((resolve) => { timer = setTimeout(() => resolve(null), PAGE_TIMEOUT_MS); });
      let r = null; try { r = got ? { ok: true, html: got } : await Promise.race([fetchPage(u), limit]); } catch { r = null; } finally { clearTimeout(timer); }
      if (!r || !r.ok || !r.html) return { url: u, error: true };
      try {
        let payloads = { json: [], jsonLd: [] }; try { payloads = pageJsonPayloads(String(r.html)); } catch { /* none */ }
        return { url: u, html: String(r.html), doc: parseHTML(String(r.html)).document, payloads: payloads.json, productIds: productIdsOf({ url: u, jsonLd: payloads.jsonLd }) };
      } catch { return { url: u, error: true }; }
    };
    let budgetTimer; const budget = new Promise((resolve) => { budgetTimer = setTimeout(() => resolve('late'), CHECK_BUDGET_MS); });
    const jobs = picked.map((u) => read(u));
    const pages = await Promise.all(jobs.map((j, i) => Promise.race([j, budget]).then((v) => (v === 'late' ? { url: picked[i], error: true } : v))));
    clearTimeout(budgetTimer);
    return pages;
  }

  return {
    summary(url) {
      const k = knowledgeOf(url);
      const ms = (profiles.get(url) || {}).manual_selectors;
      return { ok: true, rules: k.rules.filter((r) => r.status !== 'deprecated').map((r) => publicRule(r, k)), cards: ms && ms.card ? { fields: Object.keys(ms.fields || {}), origin: ms.origin || 'auto' } : null, repairs: publicRepairs(k), log: (k.log || []).slice(-10).reverse() };
    },

    /** Store designated rules, then check each on other product pages of the site. */
    async learn(url, payload = {}) {
      const pageUrl = httpUrl(url); if (!pageUrl) return { ok: false, reason: 'adresse de page invalide' };
      const scope = payload.scope === 'collection' ? 'collection' : 'product';
      const origin = payload.origin === 'ai' ? 'ai' : 'manual';
      const rules = (Array.isArray(payload.rules) ? payload.rules : []).slice(0, MAX_RULES).map((r) => sanitizeRule(r, { scope, learnedFrom: pageUrl, origin })).filter(Boolean);
      if (!rules.length) return { ok: false, reason: 'aucune règle exploitable' };
      profiles.record(pageUrl, { knowledgeRules: rules }, now());
      let k = knowledgeOf(pageUrl);
      const stored = rules.map((r) => findLive(k, scope, r.field, r.selector)).filter(Boolean);
      // Check each rule on OTHER product pages. The page it was learned on is no evidence (the user pointed
      // at it): it is kept apart as `taught`, so a rule checked nowhere else never shows "1/1".
      const pages = scope === 'product' ? await samplePages(pageUrl, payload.sampleUrls, payload.rendered) : [];
      const tests = {};
      const checked = pages.filter((p) => p.doc);
      const out = [];
      for (const r of stored) {
        const t = testRule(r, checked);
        tests[r.id] = { ok: t.ok, total: t.total, urls: t.urls, taught: pageUrl };
        out.push({ id: r.id, field: r.field, failures: t.results.filter((x) => !x.ok).map((x) => ({ url: x.url, reason: x.reason })) });
      }
      if (Object.keys(tests).length) profiles.record(pageUrl, { knowledgeTests: tests }, now());
      k = knowledgeOf(pageUrl);
      return {
        ok: true, scope, sampled: checked.length, unreachable: pages.length - checked.length,
        rules: stored.map((r) => { const live = k.rules.find((x) => x.id === r.id) || r; const f = out.find((o) => o.id === r.id); return { ...publicRule(live, k), failures: f ? f.failures : [] }; }),
      };
    },

    /**
     * The fields the user designated on the LIST page (card + selectors relative to it) become the site's
     * card recipe (`manual_selectors`, the store the panel and the app's replay already share). Only what the
     * app can replay is kept (no « part of a line » / « list of values » columns); nothing is stored unless the
     * recipe reads a name and a link — a partial recipe would only make the automatic read worse.
     */
    learnCards(url, d = {}) {
      const pageUrl = httpUrl(url); if (!pageUrl) return { ok: false, reason: 'adresse de page invalide' };
      if (!d || typeof d.card !== 'string' || !d.card || d.card.length > 300 || d.card === 'body') return { ok: false, reason: 'liste introuvable' };
      const fields = {}; const skipped = [];
      for (const f of Array.isArray(d.fields) ? d.fields.slice(0, 40) : []) {
        if (!f || !FIELD_RE.test(String(f.key || '')) || typeof f.selector !== 'string' || !f.selector || f.selector.length > 400) continue;
        if (f.part || f.all) { skipped.push(f.key); continue; }
        fields[f.key] = { selector: f.selector, attr: typeof f.attr === 'string' && /^[\w:-]{1,40}$/.test(f.attr) ? f.attr : null };
      }
      const prev = (profiles.get(pageUrl) || {}).manual_selectors;
      const merged = prev && prev.card === d.card ? { ...prev, fields: { ...(prev.fields || {}), ...fields } } : { card: d.card, fields };
      const has = (k) => merged.fields[k] || merged.fields[k === 'name' ? 'title' : k];
      if (!has('name') || !has('url')) return { ok: false, reason: 'la recette doit lire au moins le nom et le lien', skipped };
      profiles.record(pageUrl, { manualSelectors: { ...merged, origin: 'manual', sample_url: pageUrl } }, now());
      return { ok: true, fields: Object.keys(merged.fields), skipped };
    },

    /**
     * AI once per site: the fields of this product page that no rule and no generic reader found are
     * located by the model on the condensed page (element numbers or state paths), turned into ordinary
     * rules (origin 'ai'), checked on other product pages, stored — then replayed without the model.
     */
    // force: ask for the given fields even if a rule or the generic readers already cover them (a repair).
    // store: false returns the candidate rules without storing or testing them (the caller checks them).
    async aiComplete(url, { html, sampleUrls = [], fields = null, force = false, store = true } = {}) {
      const pageUrl = httpUrl(url); if (!pageUrl) return { ok: false, reason: 'adresse de page invalide' };
      const ask = aiAsker(pageUrl); if (!ask) return { ok: false, reason: 'ai_key_missing' };
      if (typeof html !== 'string' || html.length < 200) return { ok: false, reason: 'page illisible' };
      let doc; try { doc = parseHTML(html).document; } catch { return { ok: false, reason: 'page illisible' }; }
      let payloads = { json: [], jsonLd: [] }; try { payloads = pageJsonPayloads(html); } catch { /* none */ }
      let product = null; try { product = extractProduct(html, pageUrl).product; } catch { product = null; }
      const p = product || {};
      const generic = {
        description: !!(p.description && String(p.description).length >= 200), technical_specs: Array.isArray(p.specs) && p.specs.length >= 2,
        variants: Array.isArray(p.variants) && p.variants.length >= 2, brand: !!p.brand, image: Array.isArray(p.images) && p.images.length >= 1,
        category: Array.isArray(p.breadcrumb) && p.breadcrumb.length >= 1, sku: !!p.sku, availability: !!p.availability,
        // Asked only when a caller names them (a repair, a first discovery): a list price may simply not exist.
        name: !!p.name, price: p.price != null, list_price: true, ean: !!p.gtin,
      };
      const taught = new Set(knownFields(knowledgeOf(pageUrl), 'product'));
      const missing = (Array.isArray(fields) && fields.length ? fields : Object.keys(AI_FIELDS)).filter((f) => AI_FIELDS[f] && (force || (!taught.has(f) && !generic[f])));
      if (!missing.length) return { ok: true, asked: [], located: [], rules: [], aiCalls: 0 };
      const condensed = condensePage(doc);
      const prompt = buildLocatePrompt({ condensed: condensed.text, url: pageUrl, missing, known: { name: p.name || null, price: p.price ?? null, brand: p.brand || null, sku: p.sku || null }, state: stateSummary(payloads.json) });
      let answerText; try { answerText = await ask(prompt); } catch (e) { return { ok: false, reason: String((e && e.message) || e).slice(0, 200), aiCalls: 1 }; }
      const answer = parseLocateAnswer(answerText, { missing });
      const productIds = productIdsOf({ url: pageUrl, jsonLd: payloads.jsonLd });
      const rules = [];
      for (const [field, where] of Object.entries(answer)) {
        let rule = null;
        if (where.e) {
          let el = condensed.nodes.get(where.e); if (!el) continue;
          // A block answer is widened the way the pointer does it (the whole table, the whole option group).
          if (field === 'technical_specs' || field === 'variants') el = growBlock(el, field);
          const made = ruleFromElement(el, doc, { field, origin: 'ai', url: pageUrl, payloads: payloads.json, html });
          if (made.read.ok) rule = made.rule;
        } else if (where.state) {
          const key = String(where.state).split(/[.[\]]/).filter(Boolean).pop();
          const r = newRule({ scope: 'product', field, origin: 'ai', selector: '__state__', state: { key }, learnedFrom: pageUrl });
          if (readRule(doc, r, { payloads: payloads.json, productIds }).ok) rule = r;
        }
        if (rule) rules.push(rule);
      }
      if (!store) return { ok: true, asked: missing, candidates: rules, aiCalls: 1 };
      if (rules.length) profiles.record(pageUrl, { knowledgeRules: rules }, now());
      // Checked on other product pages of the site, like a designation.
      let k = knowledgeOf(pageUrl);
      const stored = rules.map((r) => findLive(k, 'product', r.field, r.selector)).filter(Boolean);
      const pages = stored.length ? (await samplePages(pageUrl, sampleUrls)).filter((x) => x.doc) : [];
      const tests = {};
      for (const r of stored) { const t = testRule(r, pages); tests[r.id] = { ok: t.ok, total: t.total, urls: t.urls, taught: pageUrl }; }
      if (Object.keys(tests).length) profiles.record(pageUrl, { knowledgeTests: tests }, now());
      k = knowledgeOf(pageUrl);
      return { ok: true, asked: missing, located: stored.map((r) => r.field), rules: stored.map((r) => publicRule(k.rules.find((x) => x.id === r.id) || r, k)), aiCalls: 1 };
    },

    /** The generic detection of a product page → proposed (AI-origin) rules. */
    async propose(url, { html, sampleUrls = [] } = {}) {
      const pageUrl = httpUrl(url); if (!pageUrl) return { ok: false, reason: 'adresse de page invalide' };
      if (typeof html !== 'string' || html.length < 200) return { ok: false, reason: 'page illisible' };
      let product = null;
      try { product = extractProduct(html, pageUrl).product; } catch { product = null; }
      if (!product || (product.price == null && !product.sku && !product.gtin)) return { ok: false, reason: 'aucune fiche produit reconnue sur cette page' };
      const found = {};
      if (product.description && String(product.description).length >= 30) found.description = String(product.description);
      if (product.brand) found.brand = String(product.brand);
      if (product.sku) found.sku = String(product.sku);
      if (Array.isArray(product.specs) && product.specs.length >= 2) found.technical_specs = product.specs;
      let proposals = [];
      try { proposals = proposeFromValues(parseHTML(html).document, found, { url: pageUrl }); } catch { proposals = []; }
      if (proposals.length) profiles.record(pageUrl, { knowledgeRules: proposals }, now());
      let ai = null;
      if (aiAsker(pageUrl)) { try { ai = await this.aiComplete(pageUrl, { html, sampleUrls }); } catch { ai = null; } }
      const k = knowledgeOf(pageUrl);
      return {
        ok: true,
        ai: ai ? { ok: ai.ok, asked: ai.asked || [], located: ai.located || [], reason: ai.reason || null } : null,
        detected: { name: product.name || null, price: product.price ?? null, description: !!found.description, brand: product.brand || null, sku: product.sku || null, specs: found.technical_specs ? found.technical_specs.length : 0 },
        located: proposals.map((r) => r.field),
        rules: k.rules.filter((r) => r.scope === 'product' && r.status !== 'deprecated' && r.status !== 'superseded').map((r) => publicRule(r, k)),
      };
    },

    /** Check again a field's live rule on product pages of the site (after an update, or a « en échec »). */
    async retest(url, { scope = 'product', field, sampleUrls = [], rendered = null } = {}) {
      const pageUrl = httpUrl(url); if (!pageUrl || !FIELD_RE.test(String(field || ''))) return { ok: false, reason: 'champ inconnu' };
      let k = knowledgeOf(pageUrl);
      const rules = k.rules.filter((r) => r.scope === scope && r.field === field && (r.status === 'active' || r.status === 'failing' || r.status === 'proposed'));
      if (!rules.length) return { ok: false, reason: 'rien à revérifier pour ce champ' };
      const key = (u) => String(u || '').split('#')[0];
      const taughtOn = new Set(rules.map((r) => key(r.learnedFrom)).filter(Boolean));
      // Other product pages only: the pages a rule was taught on prove nothing about it.
      const urls = [...new Set([pageUrl, ...rules.flatMap((r) => (r.tests && r.tests.urls) || []), ...(Array.isArray(sampleUrls) ? sampleUrls : [])])].filter((u) => !taughtOn.has(key(u)));
      const pages = (await samplePages('about:blank', urls.slice(0, MAX_SAMPLE_PAGES), rendered)).filter((p) => p.doc && !taughtOn.has(key(p.url)));
      if (!pages.length) return { ok: false, reason: 'aucune autre fiche du site n’a pu être lue pour le test' };
      const tests = {};
      for (const r of rules) { const t = testRule(r, pages); tests[r.id] = { ok: t.ok, total: t.total, urls: t.urls, ...(r.learnedFrom ? { taught: r.learnedFrom } : {}) }; }
      profiles.record(pageUrl, { knowledgeTests: tests }, now());
      k = knowledgeOf(pageUrl);
      return { ok: true, sampled: pages.length, rules: rules.map((r) => publicRule(k.rules.find((x) => x.id === r.id) || r, k)) };
    },

    /** The user forgets what the site knows about a field. */
    retire(url, { scope = 'product', field } = {}) {
      const p = profiles.get(url); if (!p || !p.siteKnowledge || !FIELD_RE.test(String(field || ''))) return { ok: false, reason: 'rien à oublier' };
      const t = now(); const k = JSON.parse(JSON.stringify(p.siteKnowledge)); let n = 0;
      k.rules = k.rules.filter((r) => { const hit = r.scope === scope && r.field === field; if (hit) n++; return !hit; });
      k.updatedAt = t;
      profiles.record(url, { knowledgeReplace: k }, t);
      return { ok: true, removed: n };
    },

    /**
     * Self-healing: rules a real run just made fail get a replacement, found from the cheapest source up —
     * what the pages DECLARE for the field, then the generic detection located back in the page, then (last,
     * counted) the app's AI — and kept only when it reads on at least REPAIR_MIN_OK product pages. A repair of
     * an AI rule is applied (logged, can be undone); a repair of a manual rule is proposed to the user.
     * @param {string} url  @param {{failed:object[], pages?:Map<string,string>, sampleUrls?:string[], allowAi?:boolean}} o
     */
    async repair(url, { failed = [], pages = null, sampleUrls = [], allowAi = true, fetchPage = fetchHtml } = {}) {
      const pageUrl = httpUrl(url);
      const res = { ok: true, proposed: [], applied: [], unrepaired: [], aiCalls: 0 };
      if (!pageUrl || !failed.length) return res;
      const urls = [...(pages instanceof Map ? pages.keys() : []), ...sampleUrls, ...failed.flatMap((r) => (r.tests && r.tests.urls) || [])];
      const pool = (await samplePages('about:blank', urls.slice(0, 40), pages, fetchPage)).filter((p) => p.doc);
      if (pool.length < REPAIR_MIN_OK) { res.ok = false; res.reason = 'pas assez de fiches lisibles pour vérifier une réparation'; res.unrepaired = failed.map((f) => f.field); return res; }
      let k = knowledgeOf(pageUrl);
      const best = (cands) => cands.map((c) => ({ ...c, t: testRule(c.rule, pool) })).filter((c) => c.t.ok >= REPAIR_MIN_OK && c.t.ok / c.t.total >= 0.6).sort((a, b) => b.t.ok / b.t.total - a.t.ok / a.t.total || b.t.ok - a.t.ok)[0] || null;
      for (const f of failed) {
        const base = { scope: f.scope || 'product', field: f.field, origin: 'ai', learnedFrom: pool[0].url };
        // 1. What the pages declare for this field (no selector: it reads the same on every page).
        let pick = best([{ via: 'declared', rule: newRule({ ...base, selector: '__declared__', strategies: [{ kind: 'jsonld', requires: 'static' }] }) }]);
        // 2. The generic detection's value, located back in the page as a block.
        if (!pick && DETECTABLE[f.field]) {
          const cands = [];
          for (const p of pool.slice(0, 2)) {
            let product = null; try { product = extractProduct(p.html, p.url).product; } catch { product = null; }
            for (const v of [...new Set(DETECTABLE[f.field](product || {}, p.doc))]) {
              if (v == null || v === '') continue;
              let made = []; try { made = proposeFromValues(p.doc, { [f.field]: v }, { url: p.url }); } catch { made = []; }
              for (const r of made) cands.push({ via: 'detection', rule: { ...r, learnedFrom: p.url } });
            }
          }
          pick = best(cands);
        }
        // 3. The app's AI, last (counted in the job's AI calls).
        if (!pick && allowAi && aiAsker(pageUrl)) {
          const ai = await this.aiComplete(pool[0].url, { html: pool[0].html, fields: [f.field], force: true, store: false });
          res.aiCalls += ai.aiCalls || 0;
          pick = best((ai.candidates || []).map((r) => ({ via: 'ai', rule: r })));
        }
        if (!pick) { res.unrepaired.push(f.field); continue; }
        const out = addRepair(k, { failed: f, candidate: pick.rule, via: pick.via, tests: pick.t }, now());
        k = out.knowledge;
        (out.repair.status === 'applied' ? res.applied : res.proposed).push({ field: f.field, via: pick.via, tests: { ok: pick.t.ok, total: pick.t.total }, id: out.repair.id });
      }
      profiles.record(pageUrl, { knowledgeReplace: k }, now());
      return res;
    },

    /**
     * First discovery of a site (no developer, no code): on the product pages a run read, every field is
     * looked for from the cheapest source up — what the pages DECLARE, the generic detection located back
     * in the page, then ONE call to the app's AI for the fields still missing — each candidate kept only if
     * it reads on at least REPAIR_MIN_OK pages, and saved as a rule (origin 'ai': a 🎯 always wins over it).
     * Done once per site (`knowledge.onboarded`): the next runs replay the rules without any AI call.
     * @returns {{ ok:boolean, done?:boolean, fields:Object<string,{found:boolean, strategy?:string, via?:string, confidence?:number, tests?:string}>, missing:string[], aiCalls:number, reason?:string }}
     */
    // rows: what the run's list gave for each product (url → {price, images, name…}): located back on its page too.
    async onboard(url, { pages = null, sampleUrls = [], allowAi = true, fetchPage = fetchHtml, rows = null } = {}) {
      const pageUrl = httpUrl(url);
      const out = { ok: true, fields: {}, missing: [], aiCalls: 0 };
      if (!pageUrl) return { ...out, ok: false, reason: 'adresse de page invalide' };
      let k = knowledgeOf(pageUrl);
      if (k.onboarded) return { ...out, done: true };
      const pool = (await samplePages('about:blank', [...(pages instanceof Map ? pages.keys() : []), ...sampleUrls].slice(0, 40), pages, fetchPage)).filter((p) => p.doc);
      if (pool.length < REPAIR_MIN_OK) return { ...out, ok: false, reason: 'pas assez de fiches produit lisibles pour apprendre le site' };
      const taught = new Set(knownFields(k, 'product'));
      const best = (cands) => cands.map((c) => ({ ...c, t: testRule(c.rule, pool) })).filter((c) => c.t.ok >= REPAIR_MIN_OK && c.t.ok / c.t.total >= 0.6).sort((a, b) => b.t.ok / b.t.total - a.t.ok / a.t.total || b.t.ok - a.t.ok)[0] || null;
      const found = {};
      for (const field of ONBOARD_FIELDS) {
        if (taught.has(field)) { out.fields[field] = { found: true, via: 'taught' }; continue; }
        const base = { scope: 'product', field, origin: 'ai', learnedFrom: pool[0].url };
        // 1. Declared by the pages (JSON-LD / microdata / meta).
        let pick = best([{ via: 'declared', rule: newRule({ ...base, selector: '__declared__', strategies: [{ kind: 'jsonld', requires: 'static' }] }) }]);
        // 2. The generic detection's value, located back in the page as a block.
        if (!pick && DETECTABLE[field]) {
          const cands = [];
          for (const p of pool.slice(0, 2)) {
            let product = null; try { product = extractProduct(p.html, p.url).product; } catch { product = null; }
            // The page's own generic read, then what the list said about this very product.
            const listed = rows instanceof Map ? rows.get(String(p.url).split('#')[0]) : null;
            for (const src of [product || {}, listed].filter(Boolean)) {
              for (const v of DETECTABLE[field](src, p.doc)) {
                if (v == null || v === '') continue;
                let made = []; try { made = proposeFromValues(p.doc, { [field]: v }, { url: p.url }); } catch { made = []; }
                for (const r of made) cands.push({ via: 'detection', rule: { ...r, learnedFrom: p.url } });
              }
            }
          }
          pick = best(cands);
        }
        if (pick) found[field] = pick;
      }
      // 3. ONE AI call for the fields the model can locate and nothing else found.
      const askAi = ONBOARD_FIELDS.filter((f) => !found[f] && !taught.has(f) && AI_FIELDS[f]);
      if (askAi.length && allowAi && aiAsker(pageUrl)) {
        const ai = await this.aiComplete(pool[0].url, { html: pool[0].html, fields: askAi, force: true, store: false });
        out.aiCalls += ai.aiCalls || 0;
        for (const f of askAi) { const pick = best((ai.candidates || []).filter((r) => r.field === f).map((r) => ({ via: 'ai', rule: r }))); if (pick) found[f] = pick; }
      }
      for (const [field, pick] of Object.entries(found)) {
        const up = upsertRule(k, { ...pick.rule, tests: { ok: pick.t.ok, total: pick.t.total, urls: pick.t.urls.slice(0, 8), at: now() } }, now());
        k = up.knowledge;
        const stored = k.rules.find((r) => r.id === up.rule.id) || up.rule;
        const strat = pick.via === 'declared' ? (pool.map((p) => readRule(p.doc, stored, { payloads: p.payloads, productIds: p.productIds, html: p.html, url: p.url })).find((r) => r.ok) || {}).strategy : (pick.via === 'ai' ? 'ai' : 'dom');
        out.fields[field] = { found: true, via: pick.via, strategy: strat || pick.via, confidence: ruleConfidence(stored).score, tests: `${pick.t.ok}/${pick.t.total}` };
      }
      for (const f of ONBOARD_FIELDS) if (!out.fields[f]) { out.fields[f] = { found: false }; out.missing.push(f); }
      k.onboarded = { at: now(), pages: pool.length, aiCalls: out.aiCalls, found: Object.keys(found), missing: out.missing };
      k.updatedAt = now();
      profiles.record(pageUrl, { knowledgeReplace: k }, now());
      return out;
    },

    /** Was this site's first discovery done already? (then the runs replay its rules without AI) */
    isOnboarded(url) { return !!knowledgeOf(url).onboarded; },

    /** The user's answer to a repair: accept / reject a proposal, undo an applied repair. */
    repairAction(url, { action, id } = {}) {
      const pageUrl = httpUrl(url); if (!pageUrl || typeof id !== 'string') return { ok: false, reason: 'réparation inconnue' };
      const fn = { accept: acceptRepair, reject: rejectRepair, undo: undoRepair }[action];
      if (!fn) return { ok: false, reason: 'action inconnue' };
      const r = fn(knowledgeOf(pageUrl), id, now());
      if (!r.ok) return { ok: false, reason: 'cette réparation n’est plus en attente' };
      profiles.record(pageUrl, { knowledgeReplace: r.knowledge }, now());
      return { ok: true, ...this.summary(pageUrl) };
    },

    /** What the engine should apply: the knowledge of the host (null when none). */
    forEngine(url) { const h = profiles.hints(url); return h && h.knowledge ? h.knowledge : null; },

    /**
     * The product rules the extension applies itself (panel preview): the live rules only, as the engine
     * reads them (selectors, fingerprints, state keys), bounded. Null when the site was taught nothing.
     */
    forPanel(url) {
      const k = this.forEngine(url); if (!k) return null;
      const rules = k.rules.filter((r) => r.scope === 'product' && r.status !== 'deprecated').slice(0, 80);
      if (!rules.length) return null;
      const out = { version: k.version, rules, updatedAt: k.updatedAt || null };
      return JSON.stringify(out).length <= 400000 ? out : null;
    },
    chainFor: (url, scope, field) => chainFor(knowledgeOf(url), scope, field),
  };
}
