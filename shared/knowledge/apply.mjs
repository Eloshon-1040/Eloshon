/**
 * Applying site knowledge to a page, testing a rule on several pages, and turning a
 * designated element (🎯) or a detected value (✨) into a rule.
 *
 * `applyKnowledge` answers "what do the learned rules read on THIS page?" with a trace
 * of what was tried (rule → strategy → ok / why not), so a failing rule is visible and
 * counted, and the caller falls back to the generic extractors for what stays empty.
 */
import { resolveRule, fingerprintOf, pageSelector, normLabel } from './dom-locate.mjs';
import { readBlockText, readSpecPairs, specsToObject, stripLabel, readVariants, readImages, groupedText } from './readers.mjs';
import { designatedPrice } from '../extract/money.mjs';
import { chainFor, knownFields, newRule, setTests, PAIR_FIELDS, LIST_FIELDS, IMAGE_FIELDS, MULTILINE_FIELDS, PRICE_FIELDS, GTIN_FIELDS, testLabel, isGeneral } from './rules.mjs';
import { isValidGtin } from '../extract/product-group.mjs';
import { visibleText, priceFromEl } from '../extract/card-recipe.mjs';
import { stateTextFor, stateKeyForText, DESCRIPTION_KEYS } from './state-values.mjs';
import { specsFromState, dedupeSpecs } from '../extract/specs.mjs';
import { structuredOf, matchesStructured } from './structured.mjs';
import { toProductImages, imageUrls, imageKey, validateImageUrl } from '../extract/images.mjs';
import { cleanSku, optionTypeOf } from '../extract/sku.mjs';

const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** Does a value read by a rule look like what the field should hold? (so a wrong block is a FAILURE, not data) */
export function validateValue(field, value, { name = '' } = {}) {
  if (PAIR_FIELDS.has(field)) {
    if (!(Array.isArray(value) && value.length >= 2)) return 'moins de 2 caractéristiques lues';
    // Feature switches of the site's code (« ADIPULSE_ENABLED : off ») are no product characteristics.
    const flag = (p) => /^[A-Z0-9]+(?:_[A-Z0-9]+)+$/.test(String(p && p.name || '')) || /^(true|false|on|off|enabled|disabled|null|undefined)$/i.test(String(p && p.value || ''));
    return value.filter(flag).length * 2 >= value.length ? 'ce sont des réglages techniques du site, pas des caractéristiques' : null;
  }
  if (LIST_FIELDS.has(field)) return Array.isArray(value) && value.length >= 1 ? null : 'aucune variante lue';
  if (IMAGE_FIELDS.has(field)) {
    // Every picture must be a complete, usable address (absolute, http(s), not cut on a transformation segment).
    if (!Array.isArray(value) || !value.length) return 'aucune image dans ce bloc';
    const bad = value.map((im) => validateImageUrl(typeof im === 'string' ? im : (im && im.url))).filter((v) => !v.ok);
    return bad.length ? `${bad.length} image(s) sur ${value.length} sans adresse complète (${bad[0].label})` : null;
  }
  if (PRICE_FIELDS.has(field)) {
    if (!value || typeof value !== 'object' || !Number.isFinite(value.price)) return 'pas un prix lisible (un nombre)';
    if (!(value.price > 0 && value.price < 1e7)) return 'montant hors des valeurs possibles';
    return value.currency ? null : 'prix sans devise (ni dans le bloc ni sur la page)';
  }
  if (GTIN_FIELDS.has(field)) return isValidGtin(value) ? null : 'pas un code EAN/GTIN valide (chiffre de contrôle faux)';
  const v = String(value == null ? '' : value).trim();
  if (!v) return 'bloc vide';
  if (field === 'brand') {
    if (v.length > 60) return 'trop long pour une marque';
    if (!/\p{L}/u.test(v)) return 'une marque contient des lettres';
    if (/^https?:\/\//i.test(v)) return 'c’est une adresse, pas une marque';
  }
  if (field === 'name' && !/\p{L}/u.test(v)) return 'un nom de produit contient des lettres';
  if (field === 'description') {
    if (v.length < 30) return 'texte trop court pour une description';
    if (name && oneLine(v).toLowerCase() === oneLine(name).toLowerCase()) return 'c’est le nom du produit';
    if ((v.match(/\d/g) || []).length > v.length * 0.5) return 'surtout des chiffres';
    return null;
  }
  if (MULTILINE_FIELDS.has(field)) return null;
  // A product name can be a whole sentence (marshydro: « Mars Hydro FC1500 Lampe de culture LED 150W, Bridgelux 3030 &
  // 660nm Rouge profond, … pour tente de culture 70x70cm », up to ~330 characters), and its heading may wrap in the
  // markup: read on one line (readOne), refused only past 500 characters. Before: 200, so these titles could not be taught.
  if (field === 'name') return oneLine(v).length > 500 ? 'trop long pour un nom' : null;
  if (v.length > 200 || /\n/.test(v)) return 'trop long pour ce champ';
  return null;
}

// The element's own text-like value: an attribute when asked, a meta/link/input's value, else its text.
function rawText(el, ex) {
  if (ex.mode === 'attr' && ex.attr) { const v = el.getAttribute(ex.attr); return v == null ? '' : String(v).trim(); }
  const tag = String(el.tagName).toLowerCase();
  if (tag === 'meta') return String(el.getAttribute('content') || '').trim();
  if (tag === 'input') return String(el.getAttribute('value') || '').trim();
  // A price element often carries the machine value too (content / data-price / value attributes).
  const attr = ['content', 'data-price', 'data-value', 'value'].map((a) => el.getAttribute(a)).find((a) => a != null && /\d/.test(a));
  return attr != null && !/\d/.test(visibleText(el)) ? String(attr).trim() : visibleText(el);
}

function readOne(el, rule, ctx) {
  const ex = rule.extract || {};
  if (ex.mode === 'pairs') return readSpecPairs(el);
  if (ex.mode === 'list') return readVariants(el, { parsePrice: designatedPrice });
  // Pictures: the attribute the rule learned first (it gave full addresses on the teaching page), the others as fallback.
  if (ex.mode === 'image' || IMAGE_FIELDS.has(rule.field)) return readImages(el, { pageUrl: (ctx && ctx.url) || null, attr: ex.attr || null });
  // An amount + its currency (the page's currency when the block only shows the figure).
  if (PRICE_FIELDS.has(rule.field)) {
    // Cents split off in a superscript (« 10 <sup>99</sup> ») and a per-unit price beside it are handled by priceFromEl.
    const text = rawText(el, ex);
    const m = (text === visibleText(el) ? priceFromEl(el) : null) || designatedPrice(text);
    return m ? { price: m.price, currency: m.currency || (ctx && ctx.pageCurrency) || null } : null;
  }
  if (GTIN_FIELDS.has(rule.field)) { const d = rawText(el, ex).replace(/\D/g, ''); const runs = d.length > 14 ? (rawText(el, ex).match(/\d{8,14}/g) || []) : [d]; return runs.find((x) => isValidGtin(x)) || d; }
  if (ex.mode === 'attr' && ex.attr) { const v = el.getAttribute(ex.attr); return v == null ? '' : String(v).trim(); }
  const tag = String(el.tagName).toLowerCase();
  if (tag === 'meta') return String(el.getAttribute('content') || '').trim();
  if (tag === 'link') return String(el.getAttribute('href') || '').trim();
  if (tag === 'input') return String(el.getAttribute('value') || '').trim();
  if (rule.field === 'category') {
    // A breadcrumb or a list of category links: its steps, in order, without the « home » step.
    let steps = []; try { steps = [...el.querySelectorAll('li, a')].filter((n) => !n.querySelector('li, a')).map((n) => visibleText(n)).filter((t) => t && t.length <= 80); } catch { steps = []; }
    steps = steps.filter((t, i) => steps.indexOf(t) === i && !/^(accueil|home|startseite|inicio)$/i.test(t));
    if (steps.length >= 2) return steps.join(' > ');
  }
  if (ex.multiline) return readBlockText(el, { dropLabel: ex.label || (rule.fingerprint && rule.fingerprint.anchor && rule.fingerprint.anchor.text) || null });
  // A group of choices (sizes, options) keeps one value per choice instead of gluing them.
  const grouped = groupedText(el); if (grouped) return grouped;
  const text = stripLabel(visibleText(el), ctx && ctx.labels && ctx.labels[rule.field]);
  return rule.field === 'name' ? oneLine(text) : text;
}

/**
 * A name read from a block that is not this page's product: none of its words in the name the page declares (JSON-LD,
 * microdata) nor in its address. marshydro 28/10: a name taught on the first header cell of the specifications table
 * (« FC-1500-Osram » on the lamp pages) read « Product Name », « INPUT », « Humidifier » on the other products.
 * @returns {string|null} the reason, or null when the name fits the page (or the page says nothing to compare)
 */
function nameMismatch(value, ctx) {
  const words = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z]{2,}|\d+/g) || [];
  let declared = ''; try { declared = String((ctx.getStructured().name || {}).value || ''); } catch { declared = ''; }
  let slug = ''; try { slug = decodeURIComponent(new URL(ctx.url).pathname); } catch { slug = ''; }
  // An address says something only when it is made of words (« /products/15l-humidificateur/ », not « /p/3 »).
  const slugWords = words(slug).filter((w) => /[a-z]/.test(w)).length >= 2 ? words(slug) : [];
  const have = new Set([...words(declared), ...slugWords]);
  const mine = [...new Set(words(value))];
  if (!have.size || !mine.length) return null;
  const shared = mine.filter((w) => have.has(w)).length;
  // Measured on the shorter of the two (a whole title against a short address, a short model against a long title).
  return shared * 2 >= Math.min(mine.length, have.size) ? null : `ne correspond pas au produit de cette page (« ${(declared || slug).slice(0, 60)} »)`;
}

/**
 * Read ONE rule on a page.
 * @returns {{ok:boolean, value?:any, strategy?:string, reason?:string}}
 */
export function readRule(doc, rule, ctx = {}) {
  if (PRICE_FIELDS.has(rule.field) && ctx.pageCurrency === undefined) ctx = { ...ctx, pageCurrency: pageCurrencyOf(doc) };
  // What the page declares (JSON-LD / microdata / meta), read once per page and shared by every rule.
  if (!ctx.getStructured) { let s; ctx = { ...ctx, getStructured: () => (s || (s = structuredOf(ctx.html || (doc.documentElement ? doc.documentElement.outerHTML : ''), ctx.url || ''))) }; }
  const declared = () => {
    if (rule.structured === false || !STRUCTURED_FIELDS.has(rule.field)) return null;
    let s = null; try { s = ctx.getStructured()[rule.field]; } catch { s = null; }
    if (!s) return null;
    // Declared pictures come as addresses: the same ProductImage shape as a block read, so every consumer sees one contract.
    const value = IMAGE_FIELDS.has(rule.field) ? toProductImages(s.value, { base: ctx.url || null, source: s.kind }).images : s.value;
    return validateValue(rule.field, value, ctx) ? null : { ok: true, value, strategy: s.kind };
  };
  // 1. The page's own declaration first, when that is what the user designated (it survives any redesign).
  const first = Array.isArray(rule.strategies) && rule.strategies[0] && STRUCTURED_KINDS.has(rule.strategies[0].kind);
  if (first) { const d = declared(); if (d) return d; }
  // 2. The block itself (stored selector → stable attributes → its label → structure).
  let hit = null;
  try { hit = resolveRule(doc, rule); } catch { hit = null; }
  let dom;
  if (!hit) dom = { ok: false, reason: 'bloc introuvable sur cette page' };
  else {
    let value; try { value = readOne(hit.el, rule, ctx); } catch { value = undefined; }
    const bad = value === undefined ? 'lecture impossible' : (validateValue(rule.field, value, ctx) || (rule.field === 'name' ? nameMismatch(value, ctx) : null));
    dom = bad ? { ok: false, strategy: hit.strategy, reason: bad } : { ok: true, value, strategy: hit.strategy };
  }
  if (dom.ok) return dom;
  // A block that only exists once its panel is opened: say it plainly (the executor without a browser cannot read it).
  const domStrategy = Array.isArray(rule.strategies) ? rule.strategies.find((s) => s.kind === 'dom') : null;
  if (domStrategy && domStrategy.requires === 'browser') dom = { ...dom, needsBrowser: true, reason: `${dom.reason} — ce bloc ne s’affiche qu’une fois ouvert dans un navigateur` };
  // 3. Not in the HTML (many shops build the block in the browser): the state key learned at designation,
  // 4. else the same field as the page declares it, 5. else the field's usual state keys (a guess, last).
  const learnedState = fromState(rule, ctx, { guess: false }); if (learnedState) return learnedState;
  const d = first ? null : declared(); const g = fromState(rule, ctx, { guess: true });
  // A declared description is often a one-line shop blurb: the fuller text of the page's state wins over it.
  if (d && g && rule.field === 'description') return String(g.value).length > String(d.value).length * 1.5 ? g : d;
  return d || g || dom;
}

/**
 * The ordered strategies of a new rule: the page's own declaration of the designated value first, when it
 * holds that very value (it reads the same field on every product page, whatever the markup becomes), then
 * the block itself — marked `requires: 'browser'` when it sits in a panel the page opens on demand (a tab,
 * an accordion: often absent from the HTML until opened) — then the learned state key.
 */
function strategiesFor(rule, read, { doc, html, url, el }) {
  let declaredKind = null;
  if (read.ok && STRUCTURED_FIELDS.has(rule.field)) {
    let s = null; try { s = structuredOf(html || (doc.documentElement ? doc.documentElement.outerHTML : ''), url || ''); } catch { s = null; }
    declaredKind = s ? matchesStructured(rule.field, read.value, s) : null;
  }
  const anchor = rule.fingerprint && rule.fingerprint.anchor;
  let inPanel = false; try { inPanel = !!(el && el.closest && el.closest('details, [role="tabpanel"]')); } catch { inPanel = false; }
  const onDemand = inPanel || !!(anchor && (anchor.rel === 'controls' || anchor.rel === 'details'));
  const dom = { kind: 'dom', requires: onDemand ? 'browser' : 'static', ...(onDemand && anchor && anchor.text ? { action: { expand: String(anchor.text).slice(0, 80) } } : {}) };
  // A text read on several lines (description, specs) keeps its paragraphs from the block; the declaration,
  // usually flattened to one line, is its fallback. A short value (name, price, brand…) is best declared.
  const out = declaredKind && !MULTILINE_FIELDS.has(rule.field) ? [{ kind: declaredKind, requires: 'static' }, dom] : [dom, ...(declaredKind ? [{ kind: declaredKind, requires: 'static' }] : [])];
  if (rule.state && rule.state.key) out.push({ kind: 'state', requires: 'static' });
  return out;
}

/** Fields the page may declare itself (structuredOf), and the kinds of declaration. */
const STRUCTURED_FIELDS = new Set(['name', 'brand', 'description', 'price', 'list_price', 'sku', 'ean', 'image', 'images', 'category', 'availability', 'variants', 'technical_specs']);
export const STRUCTURED_KINDS = new Set(['jsonld', 'microdata', 'meta']);

/** The currency the page declares for its offer (meta / microdata / JSON-LD), or null. */
export function pageCurrencyOf(doc) {
  try {
    for (const sel of ['meta[itemprop="priceCurrency"]', 'meta[property="product:price:currency"]', 'meta[property="og:price:currency"]', '[itemprop="priceCurrency"]']) {
      const e = doc.querySelector(sel); const v = e && String(e.getAttribute('content') || visibleText(e) || '').trim().toUpperCase();
      if (v && /^[A-Z]{3}$/.test(v)) return v;
    }
    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) { const m = /"priceCurrency"\s*:\s*"([A-Za-z]{3})"/.exec(s.textContent || ''); if (m) return m[1].toUpperCase(); }
  } catch { /* none */ }
  return null;
}

function fromState(rule, ctx, { guess = true } = {}) {
  const payloads = ctx && ctx.payloads; if (!Array.isArray(payloads) || !payloads.length) return null;
  const ids = (ctx.productIds || []).filter(Boolean);
  const learned = !!(rule.state && rule.state.key);
  // `guess: false` reads only the key learned at designation; `guess: true` only the field's usual keys.
  if (learned === guess) return null;
  try {
    if (PAIR_FIELDS.has(rule.field)) {
      let pairs = []; for (const p of payloads) pairs.push(...specsFromState(p, { productIds: ids }));
      pairs = dedupeSpecs(pairs);
      return validateValue(rule.field, pairs, ctx) ? null : { ok: true, value: pairs, strategy: 'state' };
    }
    const keys = learned ? new Set([String(rule.state.key).toLowerCase().replace(/[_-]/g, '')]) : (rule.field === 'description' ? DESCRIPTION_KEYS : null);
    if (!keys) return null;
    const got = stateTextFor(payloads, { keys, productIds: ids, minLen: rule.field === 'description' ? 30 : 1 });
    if (!got) return null;
    const value = rule.extract && rule.extract.multiline ? got.text : got.text.replace(/\s+/g, ' ').trim();
    return validateValue(rule.field, value, ctx) ? null : { ok: true, value, strategy: 'state' };
  } catch { return null; }
}

/**
 * Apply the knowledge of a scope to a page.
 * @param {Document} doc
 * @param {object} knowledge
 * @param {{scope?:string, fields?:string[]|null, name?:string, labels?:object}} [o]
 * @returns {{values:Object<string,any>, sources:Object<string,{ruleId:string, origin:string, general:boolean, strategy:string}>,
 *   trace:Array<{field:string, ruleId:string, origin:string, status:string, ok:boolean, strategy?:string, reason?:string}>,
 *   outcomes:Array<{ruleId:string, ok:boolean}>}}
 */
export function applyKnowledge(doc, knowledge, { scope = 'product', fields = null, name = '', labels = {}, payloads = null, productIds = [], url = '', html = null } = {}) {
  const out = { values: {}, sources: {}, trace: [], outcomes: [] };
  if (!doc || !knowledge) return out;
  const here = String(url || '').split('#')[0];
  // What the page declares (JSON-LD / microdata / meta): read once, only if a rule needs it.
  let declared = null; const getStructured = () => declared || (declared = structuredOf(html || (doc.documentElement ? doc.documentElement.outerHTML : ''), url));
  let pageCurrency; // read once, only when a price rule needs it
  for (const field of (fields || knownFields(knowledge, scope))) {
    if (PRICE_FIELDS.has(field) && pageCurrency === undefined) pageCurrency = pageCurrencyOf(doc);
    for (const rule of chainFor(knowledge, scope, field)) {
      const r = readRule(doc, rule, { name, labels, payloads, productIds, url, getStructured, pageCurrency: pageCurrency === undefined ? null : pageCurrency });
      out.trace.push({ field, ruleId: rule.id, origin: rule.origin, status: rule.status, ok: r.ok, ...(r.strategy ? { strategy: r.strategy } : {}), ...(r.reason ? { reason: r.reason } : {}), ...(r.needsBrowser ? { needsBrowser: true } : {}) });
      // Only the rule the chain would normally use is judged: an old rule tried as a last resort
      // must not pile up failures on its own. The page a rule was taught on is no evidence (onTaught).
      const onTaught = !!here && !!rule.learnedFrom && String(rule.learnedFrom).split('#')[0] === here;
      if (rule.status !== 'superseded') out.outcomes.push({ ruleId: rule.id, ok: r.ok, ...(onTaught ? { onTaught: true } : {}) });
      if (r.ok) { out.values[field] = r.value; out.sources[field] = { ruleId: rule.id, origin: rule.origin, general: isGeneral(rule), strategy: r.strategy }; break; }
    }
  }
  if (out.values.technical_specs && !out.values.specs) { out.values.specs = out.values.technical_specs; }
  return out;
}

/**
 * Check a rule on several pages of the site ("Règle testée : 4/5 fiches").
 * @param {object} rule
 * @param {Array<{url:string, doc:Document, name?:string}>} pages
 */
export function testRule(rule, pages) {
  const results = (pages || []).map((p) => {
    const r = readRule(p.doc, rule, { name: p.name || '', payloads: p.payloads || null, productIds: p.productIds || [], url: p.url || '' });
    const unit = IMAGE_FIELDS.has(rule.field) ? 'image(s)' : (LIST_FIELDS.has(rule.field) ? 'variante(s)' : 'caractéristiques');
    return { url: p.url, ok: r.ok, strategy: r.strategy || null, reason: r.reason || null, count: r.ok && Array.isArray(r.value) ? r.value.length : null, sample: r.ok ? (Array.isArray(r.value) ? `${r.value.length} ${unit}` : (PRICE_FIELDS.has(rule.field) ? `${r.value.price} ${r.value.currency || ''}`.trim() : String(r.value).slice(0, 80))) : null };
  });
  const ok = results.filter((x) => x.ok).length;
  return { ok, total: results.length, urls: results.map((x) => x.url), results };
}

/** Store the outcome of testRule on the rule in a knowledge object. */
export function applyTestResult(knowledge, ruleId, test, now) { return setTests(knowledge, ruleId, test, now); }

/** The short summary the panel shows for a rule just tested. */
export function summarizeTest(rule) { const t = testLabel(rule); return { ...t, general: isGeneral(rule) }; }

/**
 * A rule from an element the user designated on a product page.
 * @param {Element} el  @param {Document} doc  @param {{field:string, label?:string, url?:string, origin?:string}} o
 */
export function ruleFromElement(el, doc, { field, label = '', url = null, origin = 'manual', scope = 'product', payloads = null, html = null } = {}) {
  const fingerprint = fingerprintOf(el, doc);
  const selector = pageSelector(el, doc);
  // The state key holding the same text, when the page has one (read later if the HTML lacks the block).
  let stateKey = null;
  if (Array.isArray(payloads) && payloads.length && !PAIR_FIELDS.has(field)) { try { stateKey = stateKeyForText(payloads, readBlockText(el)); } catch { stateKey = null; } }
  const rule = newRule({ scope, field, origin, selector, fingerprint, learnedFrom: url, ...(stateKey ? { state: { key: stateKey } } : {}) }, undefined);
  const labels = label ? { [field]: label } : {};
  // Read the block alone first (what the user pointed at), then see whether the page DECLARES that very value.
  const r = readRule(doc, { ...rule, structured: false }, { labels, url });
  rule.strategies = strategiesFor(rule, r, { doc, html, url, el });
  // A picture rule remembers the STRATEGY that produced complete addresses on this page — the source (the
  // block's markup) and the attribute most pictures came from (srcset, data-zoom-image, src…) — not only a
  // selector that counts elements. On another page that attribute is tried first, the others as fallback.
  if (r.ok && IMAGE_FIELDS.has(field)) {
    const tally = {}; for (const im of r.value) if (im && im.attr) tally[im.attr] = (tally[im.attr] || 0) + 1;
    const attr = Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k]) => k)[0] || null;
    rule.extract = { ...rule.extract, mode: 'image', source: 'dom', ...(attr ? { attr } : {}) };
  }
  // Keep a sample even when the block fails the content gate (the user sees what was understood).
  let sample = '';
  if (r.ok && IMAGE_FIELDS.has(field)) sample = `${r.value.length} image(s) : ${imageUrls(r.value).slice(0, 2).join(' , ')}`;
  else if (r.ok && PRICE_FIELDS.has(field)) sample = `${r.value.price} ${r.value.currency || ''}`.trim();
  else if (r.ok) sample = LIST_FIELDS.has(field) ? r.value.map((v) => (v.price != null ? `${v.name} (${v.price})` : v.name)).join(' · ') : (Array.isArray(r.value) ? r.value.slice(0, 3).map((p) => `${p.name} : ${p.value}`).join(' · ') : String(r.value));
  else { try { sample = PAIR_FIELDS.has(field) ? readSpecPairs(el).slice(0, 3).map((p) => `${p.name} : ${p.value}`).join(' · ') : readBlockText(el).slice(0, 200); } catch { sample = ''; } }
  rule.example = sample.slice(0, 200);
  return { rule, read: r, count: r.ok && Array.isArray(r.value) ? r.value.length : null };
}

/**
 * AI-mode proposals: the values the generic detection already found (description, brand,
 * sku, specs…), located back in the rendered page — each one a PROPOSED rule that the
 * user can confirm (becomes manual) or correct (a 🎯 supersedes it).
 * @param {Document} doc
 * @param {Object<string,any>} found  { description?:string, brand?:string, sku?:string, technical_specs?:Array }
 */
export function proposeFromValues(doc, found, { url = null } = {}) {
  const out = [];
  const els = (() => { try { return [...doc.querySelectorAll('body *')].filter((e) => !/^(script|style|noscript|template|svg|head)$/i.test(e.tagName)).slice(0, 6000); } catch { return []; } })();
  const key = (s) => normLabel(s);
  const smallest = (cands) => cands.find((e) => !cands.some((o) => o !== e && e.contains(o))) || null;
  for (const [field, val] of Object.entries(found || {})) {
    if (val == null || val === '') continue;
    let el = null;
    if (PRICE_FIELDS.has(field)) {
      // The smallest short element whose own amount is that price (the figure the page shows).
      const want = typeof val === 'object' ? Number(val.price) : Number(val); if (!Number.isFinite(want)) continue;
      const hold = els.filter((e) => { const t = visibleText(e); if (!t || t.length > 40 || !/\d/.test(t)) return false; const m = priceFromEl(e) || designatedPrice(t); return !!m && Math.abs(m.price - want) < 0.005; });
      el = smallest(hold);
    } else if (IMAGE_FIELDS.has(field)) {
      // The picture that shows that image (same file name in its src / srcset / data-src).
      const first = imageUrls(Array.isArray(val) ? val : [val])[0]; if (!first) continue;
      const file = String(first).split('?')[0].split('/').pop();
      el = file ? (els.find((e) => /^img$/i.test(e.tagName) && ['src', 'data-src', 'srcset', 'data-srcset'].some((a) => String(e.getAttribute(a) || '').includes(file))) || null) : null;
    } else if (field === 'category') {
      // The trail (breadcrumb): the smallest block holding every step, in order.
      const steps = (Array.isArray(val) ? val : String(val).split(/\s+>\s+/)).map((x) => key(x)).filter((x) => x && !/^(accueil|home|startseite|inicio)$/.test(x));
      if (steps.length < 1) continue;
      const hold = els.filter((e) => { if (!/^(ol|ul|nav|div|p|section)$/i.test(e.tagName)) return false; const t = key(visibleText(e)); let at = 0; for (const s of steps) { const i = t.indexOf(s, at); if (i < 0) return false; at = i + s.length; } return t.length <= steps.join(' ').length * 3 + 60; });
      el = smallest(hold);
    } else if (PAIR_FIELDS.has(field)) {
      // The smallest block holding the most of the names.
      const names = (Array.isArray(val) ? val : []).map((p) => key(p.name)).filter(Boolean).slice(0, 12);
      if (names.length < 2) continue;
      const need = Math.ceil(names.length * 0.7);
      const hold = els.filter((e) => { if (!/^(table|dl|ul|ol|div|section|article|tbody)$/i.test(e.tagName)) return false; const t = key(visibleText(e)); return names.filter((n) => t.includes(n)).length >= need; });
      el = smallest(hold);
    } else {
      const want = key(String(val)).slice(0, 80); if (want.length < 3) continue;
      const exact = els.filter((e) => key(visibleText(e)) === key(String(val)));
      const loose = exact.length ? exact : els.filter((e) => { const t = key(visibleText(e)); return field === 'description' ? t.includes(want) && t.length < key(String(val)).length * 1.5 + 80 : false; });
      el = smallest(loose);
    }
    if (!el) continue;
    const { rule, read } = ruleFromElement(el, doc, { field, url, origin: 'ai' });
    if (read.ok) out.push(rule);
  }
  return out;
}

// ---- What the rules read on a product page → a product row (shared by the app and the panel preview) ----
//
// Priority on a row: what the USER designated (a manual rule) overrides what the generic extractors read, on
// every page where it reads a value that passes the field's content check. AI rules only FILL gaps. A rule
// that reads nothing leaves the generic value untouched.

const has = (v) => v != null && v !== '' && !(Array.isArray(v) && !v.length) && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);

// Rule field → the keys of a raw product row it fills.
export const ROW_KEYS = { name: ['name'], price: ['price'], list_price: ['listPrice'], gtin: ['gtin'], description: ['description'], technical_specs: ['specs', 'technical_specs'], specs: ['specs', 'technical_specs'], brand: ['brand'], sku: ['sku'], ean: ['gtin'], mpn: ['mpn'], availability: ['availability'], category: ['category'], variants: ['variants'], image: ['images'], images: ['images'], gallery: ['images'] };
export const rowKeysOf = (field) => ROW_KEYS[field] || [field];

/** Is this field of the row already filled? (a free column counts through `row.columns`) */
export const rowHas = (row, field) => (ROW_KEYS[field] ? has(row[ROW_KEYS[field][0]]) : (has(row[field]) || !!(row.columns && has(row.columns[field]))));

/**
 * Merge what the rules read into a row (mutated). Returns the row keys that were set.
 * @param {object} row  @param {{values:object, sources:object}|null} applied
 */
export function mergeKnowledgeIntoRow(row, applied) {
  const added = [];
  if (!applied || !applied.values) return added;
  for (const [field, value] of Object.entries(applied.values)) {
    if (field === 'specs' && applied.values.technical_specs) continue; // same list, set once below
    const src = applied.sources[field] || {};
    const force = src.origin === 'manual';
    const keys = rowKeysOf(field);
    if (!ROW_KEYS[field]) {
      // A free column the user named: kept as a column of the row.
      const cols = row.columns && typeof row.columns === 'object' ? row.columns : (row.columns = {});
      if (force || !has(cols[field])) { cols[field] = String(value).slice(0, 2000); row[field] = cols[field]; added.push(field); }
      continue;
    }
    if (field === 'image' || field === 'images' || field === 'gallery') {
      // The picture(s) the user pointed at: they lead the row's images (the others found automatically follow).
      const cur = imageUrls(Array.isArray(row.images) ? row.images : []);
      if (!force && cur.length) continue;
      const mine = new Set(imageUrls(value).map(imageKey));
      // The row's serialised form (URLs): the designated pictures first, then the ones found automatically that are other pictures.
      row.images = [...imageUrls(value), ...cur.filter((u) => !mine.has(imageKey(u)))];
      added.push('images'); continue;
    }
    if (PRICE_FIELDS.has(field)) {
      // An amount + currency: the row keeps the figure, and the currency when it has none (or the user designated it).
      if (!force && row[keys[0]] != null && row[keys[0]] !== '') continue;
      row[keys[0]] = value.price;
      if (value.currency && (force || !row.currency)) row.currency = value.currency;
      added.push(keys[0]); continue;
    }
    if (field === 'variants') {
      // The options the user pointed at (sizes, volumes, colours…), in the row's variant shape. The code is the one
      // the page gives the entry (a code attribute) and only when it reads as a SKU — never the entry's label
      // (it became the « Variant SKU » of the export); the type is named by the options' label (« Couleur du produit »).
      if (!force && has(row.variants)) continue;
      const names = [...value.map((v) => v.name), row.color];
      row.variants = value.map((v) => {
        const code = cleanSku(v.code, { names });
        return { ...(code ? { code } : {}), type: optionTypeOf(v.group || ''), name: v.name, ...(v.group ? { label: v.group } : {}), ...(v.price != null ? { price: v.price } : {}), ...(v.availability ? { availability: v.availability } : {}), ...(v.url ? { url: v.url } : {}) };
      });
      added.push('variants'); continue;
    }
    if (field === 'technical_specs' || field === 'specs') {
      if (!force && has(row.specs)) continue;
      row.specs = value.map((p) => ({ group: p.group ?? null, name: p.name, value: p.value }));
      row.technical_specs = specsToObject(value);
      added.push('specs'); continue;
    }
    if (!force && has(row[keys[0]])) continue;
    row[keys[0]] = value;
    if (field === 'description') row.richText = true;
    // A category the user pointed at (a breadcrumb) is THE category: it replaces the trail read automatically.
    if (field === 'category') row.breadcrumb = String(value).split(/\s+>\s+/).map((x) => x.trim()).filter(Boolean);
    added.push(keys[0]);
  }
  return added;
}

/** Add one page's outcomes to the run totals: { ruleId: {ok, fail} }. The teaching page is no evidence. */
export function foldOutcomes(totals, applied) {
  if (!applied) return totals;
  for (const o of applied.outcomes || []) {
    if (o.onTaught) continue;
    const t = totals[o.ruleId] || (totals[o.ruleId] = { ok: 0, fail: 0 });
    if (o.ok) t.ok++; else t.fail++;
  }
  return totals;
}
