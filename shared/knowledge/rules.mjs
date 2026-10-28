/**
 * SITE KNOWLEDGE — the rules a site has taught the scraper, whoever taught them.
 *
 * Both detection modes feed this ONE store: the AI proposes (origin 'ai'), the user
 * designates with the mouse (origin 'manual'). Pure functions over a plain object, so
 * the app (domain profile file), the extension and the tests share them.
 *
 *   knowledge = { version, rules:[Rule], updatedAt }
 *   Rule = { id, scope:'product'|'collection', field, origin:'manual'|'ai',
 *            status:'active'|'proposed'|'failing'|'superseded'|'deprecated', version,
 *            selector, fingerprint, extract:{mode:'text'|'pairs'|'attr', attr?, multiline?, label?},
 *            example, learnedFrom, tests:{ok,total,urls[],at,recent,taught?:{url}}, stats:{success,fail,consecutive_fails,last_ok,last_fail},
 *            supersedes, confirmedAi?, created, updated }
 *
 * `tests` counts OTHER product pages only (version 2): the page the rule was taught on is always read
 * right (the user pointed at it), so it is kept apart in `tests.taught` and never counts as evidence.
 * Version 1 counted it once (a rule checked nowhere else showed "1/1"); `migrateKnowledge` removes it.
 *
 * Priority (one answer per field, never two contradicting active rules):
 *   a manual rule always beats an AI one; a new manual rule supersedes the previous one
 *   (history kept); an AI proposal never displaces a manual rule (it stays 'proposed');
 *   a rule that keeps failing becomes 'failing' (tried last) and the chain falls back to
 *   the older rules, then to the generic extractors — never to a wrong value.
 */
// v3: a picture rule carries its strategy (extract.source = where the pictures come from, extract.attr = the
// attribute that gave complete addresses), read as ProductImage (shared/extract/images.mjs); older rules are
// migrated (source 'dom', any attribute) and keep working.
export const KNOWLEDGE_VERSION = 3;
export const MAX_HISTORY = 4;          // superseded rules kept per field
export const FAIL_LIMIT = 3;           // consecutive failures before 'failing' / 'deprecated'
export const GENERAL_MIN_TESTS = 3;    // pages a rule must have been checked on to be general
export const GENERAL_MIN_RATIO = 0.6;
export const RECENT_WINDOW = 20;       // pages the confidence is computed on (the most recent ones)

export const emptyKnowledge = () => ({ version: KNOWLEDGE_VERSION, rules: [], updatedAt: null });

/** The fields whose value is a set of label → value pairs rather than a text. */
export const PAIR_FIELDS = new Set(['technical_specs', 'specs']);
/** The fields whose value is a list of entries (a product's options: sizes, volumes, colours…). */
export const LIST_FIELDS = new Set(['variants']);
/** The fields whose value is picture addresses (one image or a gallery), read from the element's sources, not its text. */
export const IMAGE_FIELDS = new Set(['image', 'images', 'thumbnail', 'gallery']);
/** The fields read as several lines (paragraphs, bullets). */
export const MULTILINE_FIELDS = new Set(['description', 'technical_specs', 'specs']);
/** The fields whose value is an amount + currency ({price, currency}), checked as one. */
export const PRICE_FIELDS = new Set(['price', 'list_price']);
/** The barcode fields: kept only when the GS1 check digit is right. */
export const GTIN_FIELDS = new Set(['ean', 'gtin']);
/** Where a picture rule reads its pictures (the strategy it learned). */
export const IMAGE_RULE_SOURCES = new Set(['dom', 'jsonld', 'microdata', 'og', 'state']);

const clone = (k) => JSON.parse(JSON.stringify(k || emptyKnowledge()));
const hash = (s) => { let h = 5381; for (const c of String(s)) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0; return h.toString(36); };
const iso = (now) => now || new Date().toISOString();

// The origin is part of the id: the AI and the user may point at the very same block (a confirmation) without one overwriting the other.
export function ruleId(scope, field, selector, anchorText, origin = 'manual') { return `${scope}.${field}.${origin === 'ai' ? 'ai' : 'm'}${hash(`${selector}|${anchorText || ''}`)}`; }

/**
 * Build a rule from what a designation or a detection produced.
 * @param {{scope?:string, field:string, origin?:string, selector:string, fingerprint?:object, extract?:object,
 *          example?:string, learnedFrom?:string, tests?:object}} o
 */
export function newRule(o, now) {
  const field = String(o.field || '').trim();
  const mode = (o.extract && o.extract.mode) || (PAIR_FIELDS.has(field) ? 'pairs' : (LIST_FIELDS.has(field) ? 'list' : (IMAGE_FIELDS.has(field) ? 'image' : (o.extract && o.extract.attr ? 'attr' : 'text'))));
  const t = iso(now);
  const anchorText = o.fingerprint && o.fingerprint.anchor && o.fingerprint.anchor.text;
  return {
    id: ruleId(o.scope || 'product', field, o.selector, anchorText, o.origin), scope: o.scope || 'product', field,
    origin: o.origin === 'ai' ? 'ai' : 'manual', status: 'active', version: 1,
    selector: o.selector, fingerprint: o.fingerprint || null,
    // Where the page's embedded state holds the same value (a block the shop renders in the browser only).
    ...(o.state && typeof o.state.key === 'string' ? { state: { key: o.state.key } } : {}),
    // The ordered ways to read the field (the page's declaration, the block, the state), each with what it needs.
    ...(Array.isArray(o.strategies) && cleanStrategies(o.strategies).length ? { strategies: cleanStrategies(o.strategies) } : {}),
    extract: { mode, ...(o.extract && o.extract.attr ? { attr: o.extract.attr } : {}), ...(mode === 'image' ? { source: (o.extract && IMAGE_RULE_SOURCES.has(o.extract.source)) ? o.extract.source : 'dom' } : {}), multiline: o.extract && o.extract.multiline != null ? !!o.extract.multiline : MULTILINE_FIELDS.has(field), ...(o.extract && o.extract.label ? { label: o.extract.label } : {}) },
    example: String(o.example || '').slice(0, 200), learnedFrom: o.learnedFrom || null,
    tests: o.tests || { ok: 0, total: 0, urls: [], at: null },
    stats: { success: 0, fail: 0, consecutive_fails: 0, last_ok: null, last_fail: null },
    supersedes: null, created: t, updated: t,
  };
}

const live = (r) => r.status === 'active' || r.status === 'proposed' || r.status === 'failing';

/** The kinds of strategy a rule may hold, and what each needs from the executor. */
export const STRATEGY_KINDS = new Set(['jsonld', 'microdata', 'meta', 'dom', 'state']);
/** Strategies as stored: known kinds only, `requires` static | browser, an optional « open this panel » action. */
export function cleanStrategies(list) {
  const out = [];
  for (const s of Array.isArray(list) ? list.slice(0, 6) : []) {
    if (!s || !STRATEGY_KINDS.has(s.kind) || out.some((x) => x.kind === s.kind)) continue;
    const expand = s.action && typeof s.action.expand === 'string' ? s.action.expand.slice(0, 80) : null;
    out.push({ kind: s.kind, requires: s.requires === 'browser' ? 'browser' : 'static', ...(expand ? { action: { expand } } : {}) });
  }
  return out;
}

/**
 * Add a rule to the knowledge with the priority rules above. Returns { knowledge, rule, change }
 * where change = 'created' | 'refreshed' | 'replaced' | 'proposed' | 'confirmed'.
 */
export function upsertRule(knowledge, incoming, now) {
  const k = clone(knowledge); const t = iso(now);
  const same = (r) => r.scope === incoming.scope && r.field === incoming.field;
  const cur = k.rules.filter((r) => same(r) && live(r));
  const sameSel = cur.find((r) => r.selector === incoming.selector && r.origin === incoming.origin);
  let change = 'created'; let rule = { ...incoming };

  if (incoming.origin === 'manual') {
    if (sameSel) {
      // The user designated the same block again: refresh it (new fingerprint / example), keep its history.
      Object.assign(sameSel, { fingerprint: incoming.fingerprint || sameSel.fingerprint, extract: incoming.extract, example: incoming.example, learnedFrom: incoming.learnedFrom || sameSel.learnedFrom, status: 'active', version: sameSel.version + 1, updated: t });
      sameSel.stats.consecutive_fails = 0;
      rule = sameSel; change = 'refreshed';
    } else {
      const ai = cur.find((r) => r.origin === 'ai' && r.selector === incoming.selector);
      const prev = cur.filter((r) => r.status !== 'proposed' || r.origin === 'manual').sort((a, b) => (b.updated > a.updated ? 1 : -1))[0];
      for (const r of cur) { r.status = 'superseded'; r.updated = t; r.supersededBy = incoming.id; r.supersededReason = r.origin === 'ai' ? (ai === r ? 'confirmed_by_user' : 'corrected_by_user') : 'replaced_by_user'; }
      rule = { ...incoming, status: 'active', version: Math.max(0, ...k.rules.filter(same).map((r) => r.version)) + 1, supersedes: prev ? prev.id : null, confirmedAi: !!ai, created: t, updated: t };
      k.rules = k.rules.filter((r) => r.id !== incoming.id); k.rules.push(rule); change = ai ? 'confirmed' : (prev ? 'replaced' : 'created');
    }
  } else {
    const manual = cur.find((r) => r.origin === 'manual' && (r.status === 'active' || r.status === 'failing'));
    const old = cur.find((r) => r.origin === 'ai');
    if (old && old.selector === incoming.selector) { old.updated = t; old.example = incoming.example || old.example; rule = old; change = 'refreshed'; }
    else {
      if (old) { old.status = 'superseded'; old.updated = t; old.supersededReason = 'newer_ai'; }
      rule = { ...incoming, status: manual ? 'proposed' : 'active', version: Math.max(0, ...k.rules.filter(same).map((r) => r.version)) + 1, created: t, updated: t };
      k.rules = k.rules.filter((r) => r.id !== incoming.id); k.rules.push(rule); change = manual ? 'proposed' : (old ? 'replaced' : 'created');
    }
  }
  // Bounded history per field.
  const hist = k.rules.filter((r) => same(r) && r.status === 'superseded').sort((a, b) => (b.updated > a.updated ? 1 : -1));
  for (const r of hist.slice(MAX_HISTORY)) k.rules.splice(k.rules.indexOf(r), 1);
  k.updatedAt = t;
  return { knowledge: k, rule, change };
}

/**
 * The rules to try for a field, best first: the active manual rule, the active AI rule, AI proposals,
 * the failing manual rule (tried last of the live ones), then the most recent superseded manual rules.
 */
export function chainFor(knowledge, scope, field) {
  const rs = ((knowledge && knowledge.rules) || []).filter((r) => r.scope === scope && r.field === field);
  const byConf = (a, b) => ruleConfidence(b).score - ruleConfidence(a).score;
  const pick = (f) => rs.filter(f).sort(byConf);
  return [
    ...pick((r) => r.status === 'active' && r.origin === 'manual'),
    ...pick((r) => r.status === 'active' && r.origin === 'ai'),
    ...pick((r) => r.status === 'proposed'),
    ...pick((r) => r.status === 'failing'),
    ...rs.filter((r) => r.status === 'superseded' && r.origin === 'manual').sort((a, b) => (b.updated > a.updated ? 1 : -1)).slice(0, 2),
  ];
}

/** The fields (of a scope) the knowledge has at least one live (active / proposed / failing) rule for. */
export function knownFields(knowledge, scope) {
  return [...new Set(((knowledge && knowledge.rules) || []).filter((r) => r.scope === scope && live(r)).map((r) => r.field))];
}

/** Fold the pages a rule was checked on into its counters (and revive / demote it). */
export function recordOutcome(knowledge, id, ok, { url = null, now } = {}) {
  const k = clone(knowledge); const t = iso(now);
  const r = k.rules.find((x) => x.id === id); if (!r) return k;
  r.stats = r.stats || { success: 0, fail: 0, consecutive_fails: 0 };
  r.tests = r.tests || { ok: 0, total: 0, urls: [], at: null };
  // A rule stored before the recent window existed starts a fresh one: its old counters may be an older engine's.
  const recent = typeof r.tests.recent === 'string' ? r.tests.recent : '';
  if (ok) { r.stats.success++; r.stats.consecutive_fails = 0; r.stats.last_ok = t; if (r.status === 'failing') r.status = 'active'; r.tests.ok++; }
  else { r.stats.fail++; r.stats.consecutive_fails++; r.stats.last_fail = t; if (r.stats.consecutive_fails >= FAIL_LIMIT && (r.status === 'active')) r.status = r.origin === 'manual' ? 'failing' : 'deprecated'; }
  r.tests.recent = (recent + (ok ? '1' : '0')).slice(-RECENT_WINDOW);
  r.tests.ok = [...r.tests.recent].filter((c) => c === '1').length; r.tests.total = r.tests.recent.length; r.tests.at = t;
  if (url && r.tests.urls.length < 8 && !r.tests.urls.includes(url)) r.tests.urls.push(url);
  r.updated = t; k.updatedAt = t;
  return k;
}

/** Replace a rule's tests with a fresh multi-page check ({ok,total,urls} on OTHER pages, `taught` = the teaching page). */
export function setTests(knowledge, id, tests, now) {
  const k = clone(knowledge); const r = k.rules.find((x) => x.id === id); if (!r) return k;
  const recent = ('1'.repeat(Math.max(0, tests.ok)) + '0'.repeat(Math.max(0, tests.total - tests.ok))).slice(-RECENT_WINDOW);
  const taught = tests.taught ? { url: String(tests.taught) } : ((r.tests && r.tests.taught) || (r.learnedFrom ? { url: r.learnedFrom } : null));
  r.tests = { ok: tests.ok, total: tests.total, urls: (tests.urls || []).slice(0, 8), at: iso(now), recent, ...(taught ? { taught } : {}) };
  if (r.status === 'failing' && tests.total && tests.ok / tests.total >= GENERAL_MIN_RATIO) { r.status = 'active'; if (r.stats) r.stats.consecutive_fails = 0; }
  r.updated = iso(now); k.updatedAt = r.updated;
  return k;
}

/** @returns {{label:'élevée'|'moyenne'|'faible'|'non testée', ok:number, total:number, ratio:number}} */
export function testLabel(rule) {
  const { ok = 0, total = 0 } = (rule && rule.tests) || {};
  const ratio = total ? ok / total : 0;
  const label = !total ? 'non testée' : (total >= GENERAL_MIN_TESTS && ratio >= 0.75 ? 'élevée' : (total >= GENERAL_MIN_TESTS && ratio >= 0.5 ? 'moyenne' : 'faible'));
  return { label, ok, total, ratio };
}

/** A rule checked on enough pages, and mostly right, may be applied to the whole site. */
export function isGeneral(rule) {
  const { total, ratio } = testLabel(rule);
  const fails = rule && rule.stats ? rule.stats.consecutive_fails : 0;
  return total >= GENERAL_MIN_TESTS && ratio >= GENERAL_MIN_RATIO && fails < FAIL_LIMIT;
}

/** 0..1 — how far a rule can be trusted (origin, evidence, recent failures). */
export function ruleConfidence(rule) {
  if (!rule) return { score: 0, label: 'faible' };
  const { total, ratio } = testLabel(rule);
  const base = rule.origin === 'manual' ? 0.6 : (rule.confirmedAi ? 0.5 : 0.35);
  const evidence = ratio * Math.min(1, total / 4);
  let score = base * 0.5 + evidence * 0.5 + (rule.origin === 'manual' ? 0.1 : 0);
  score -= ((rule.stats && rule.stats.consecutive_fails) || 0) * 0.15;
  score = Math.max(0, Math.min(1, Math.round(score * 100) / 100));
  return { score, label: testLabel(rule).label };
}

/** A short, honest line for the UI: "Règle testée : 4/5 autres fiches · confiance élevée". */
export function describeRule(rule) {
  const t = testLabel(rule);
  const taughtOnly = !t.total && !!(rule && (rule.learnedFrom || (rule.tests && rule.tests.taught)));
  const tested = t.total ? `testée : ${t.ok}/${t.total} autre(s) fiche(s) récente(s)` : (taughtOnly ? 'lue sur la fiche où elle a été apprise, pas encore testée sur d’autres fiches' : 'pas encore testée');
  const gen = t.total && !isGeneral(rule) ? ' · pas encore générale' : '';
  return `Règle ${tested} · confiance ${t.label}${gen}`;
}

const pageKey = (u) => String(u || '').split('#')[0];

// ---- Repairs: a rule that fails during real runs gets a replacement, checked on several pages ----------
//
//   knowledge.repairs = [{ id, field, scope, failedRuleId, ruleId, via:'declared'|'detection'|'ai',
//                          tests:{ok,total}, status:'proposed'|'applied'|'accepted'|'rejected'|'undone', at }]
//   knowledge.log     = [{ id, at, action:'auto_repair'|'accept'|'reject'|'undo', field, from, to, via }]
// A repair of a MANUAL rule is only proposed (the user accepts or rejects it: a manual rule is never
// overwritten); a repair of an AI rule is applied at once, logged, and can be undone.
export const MAX_REPAIRS = 20;
export const MAX_LOG = 50;
const stamp = (now) => iso(now);
const idOf = (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

function logIt(k, entry, now) {
  k.log = [...(Array.isArray(k.log) ? k.log : []), { id: idOf('lg'), at: stamp(now), ...entry }].slice(-MAX_LOG);
}

/**
 * Record a checked replacement for a failing rule. `candidate` is a rule (origin 'ai'); upsertRule's priority
 * does the rest: it stays 'proposed' next to a live manual rule, it replaces an AI rule.
 * @returns {{ knowledge:object, repair:object }}
 */
export function addRepair(knowledge, { failed, candidate, via, tests }, now) {
  let k = clone(knowledge);
  const up = upsertRule(k, { ...candidate, tests: { ...(candidate.tests || {}), ok: tests.ok, total: tests.total, urls: (tests.urls || []).slice(0, 8), at: stamp(now) } }, now);
  k = up.knowledge;
  const stored = k.rules.find((r) => r.id === up.rule.id);
  const applied = stored && stored.status === 'active';
  const repair = { id: idOf('rp'), field: failed.field, scope: failed.scope, failedRuleId: failed.id, ruleId: stored ? stored.id : candidate.id, via, tests: { ok: tests.ok, total: tests.total }, status: applied ? 'applied' : 'proposed', at: stamp(now) };
  k.repairs = [...(Array.isArray(k.repairs) ? k.repairs : []).filter((r) => !(r.failedRuleId === failed.id && r.status === 'proposed')), repair].slice(-MAX_REPAIRS);
  if (applied) logIt(k, { action: 'auto_repair', field: failed.field, from: failed.id, to: repair.ruleId, via, repairId: repair.id }, now);
  k.updatedAt = stamp(now);
  return { knowledge: k, repair };
}

/** The user accepts a proposed repair: it becomes their rule (manual), the failing one is kept as history. */
export function acceptRepair(knowledge, repairId, now) {
  const k0 = clone(knowledge); const rep = (k0.repairs || []).find((r) => r.id === repairId && r.status === 'proposed');
  if (!rep) return { knowledge: k0, ok: false };
  const cand = k0.rules.find((r) => r.id === rep.ruleId); if (!cand) return { knowledge: k0, ok: false };
  const up = upsertRule(k0, { ...cand, id: ruleId(cand.scope, cand.field, cand.selector, cand.fingerprint && cand.fingerprint.anchor && cand.fingerprint.anchor.text, 'manual'), origin: 'manual', confirmedAi: true }, now);
  const k = up.knowledge;
  const r = k.repairs.find((x) => x.id === repairId); r.status = 'accepted'; r.acceptedRuleId = up.rule.id;
  logIt(k, { action: 'accept', field: rep.field, from: rep.failedRuleId, to: up.rule.id, via: rep.via, repairId }, now);
  return { knowledge: k, ok: true };
}

/** The user rejects a proposed repair: the proposal is set aside, the failing rule stays as it is. */
export function rejectRepair(knowledge, repairId, now) {
  const k = clone(knowledge); const rep = (k.repairs || []).find((r) => r.id === repairId && r.status === 'proposed');
  if (!rep) return { knowledge: k, ok: false };
  rep.status = 'rejected';
  const cand = k.rules.find((r) => r.id === rep.ruleId); if (cand && cand.status === 'proposed') { cand.status = 'superseded'; cand.supersededReason = 'rejected_by_user'; cand.updated = stamp(now); }
  logIt(k, { action: 'reject', field: rep.field, from: rep.failedRuleId, to: rep.ruleId, via: rep.via, repairId }, now);
  return { knowledge: k, ok: true };
}

/** Undo an applied (or accepted) repair: the previous rule is live again, the repair's rule is set aside. */
export function undoRepair(knowledge, repairId, now) {
  const k = clone(knowledge); const rep = (k.repairs || []).find((r) => r.id === repairId && (r.status === 'applied' || r.status === 'accepted'));
  if (!rep) return { knowledge: k, ok: false };
  const t = stamp(now);
  const newId = rep.acceptedRuleId || rep.ruleId;
  const neu = k.rules.find((r) => r.id === newId); if (neu) { neu.status = 'superseded'; neu.supersededReason = 'undone_by_user'; neu.updated = t; }
  const old = k.rules.find((r) => r.id === rep.failedRuleId);
  if (old) { old.status = old.origin === 'manual' ? 'failing' : 'active'; old.updated = t; if (old.stats) old.stats.consecutive_fails = Math.min(old.stats.consecutive_fails || 0, FAIL_LIMIT); }
  rep.status = 'undone';
  logIt(k, { action: 'undo', field: rep.field, from: newId, to: rep.failedRuleId, via: rep.via, repairId }, now);
  k.updatedAt = t;
  return { knowledge: k, ok: true };
}

/** The rules a run just made fail: live before the run, failing / deprecated after it. */
export function newlyFailing(before, after) {
  const was = new Map(((before && before.rules) || []).map((r) => [r.id, r.status]));
  return ((after && after.rules) || []).filter((r) => (r.status === 'failing' || r.status === 'deprecated') && (was.get(r.id) === 'active' || was.get(r.id) === 'proposed'));
}

const FIELDS_THE_PAGE_DECLARES = new Set(['name', 'brand', 'description', 'price', 'list_price', 'sku', 'ean', 'image', 'images', 'category', 'availability', 'variants', 'technical_specs']);

/**
 * What is fragile about a stored rule, with what to do about it — computed, never stored, never deleting
 * anything: the user decides. Codes: positional (found by its position only), generated (relies on class
 * names the site generates at each build), shared_block (another field points at the very same block),
 * failing (failed on the latest product pages), untested (checked on no other product page yet).
 * @param {object} rule  @param {object} knowledge  @param {(c:string)=>boolean} isGenerated
 * @returns {Array<{code:string, text:string, fix:string}>}
 */
export function auditRule(rule, knowledge, isGenerated = () => false) {
  const out = [];
  if (!rule || rule.status === 'superseded' || rule.status === 'deprecated') return out;
  const fp = rule.fingerprint || {};
  const sel = String(rule.selector || '');
  const declared = FIELDS_THE_PAGE_DECLARES.has(rule.field);
  const fallback = declared ? ' Si la page déclare ce champ (données structurées), la règle s’y reporte déjà quand le bloc n’est plus trouvé.' : '';
  const stableAttrs = Object.entries(fp.attrs || {}).filter(([k, v]) => k !== 'role' && !(k === 'id' && isGenerated(v)));
  const stableFpClasses = (fp.classes || []).filter((c) => !isGenerated(c));
  if (sel.startsWith(':scope >') && !(fp.anchor && fp.anchor.text) && !stableAttrs.length && !stableFpClasses.length) {
    out.push({ code: 'positional', text: 'Ce bloc n’est repéré que par sa place dans la page : le moindre changement de mise en page le fait perdre.', fix: `Refaites 🎯 sur ce champ en visant le bloc lui-même (son titre ou son cadre).${fallback}` });
  }
  const classes = (sel.match(/\.((?:\\.|[\w-])+)/g) || []).map((c) => c.slice(1).replace(/\\(.)/g, '$1'));
  if (classes.length && classes.every((c) => isGenerated(c)) && !stableAttrs.length) {
    const byLabel = fp.anchor && fp.anchor.text ? ` Elle reste retrouvée par son titre « ${String(fp.anchor.text).slice(0, 40)} » tant qu’il ne change pas.` : '';
    out.push({ code: 'generated', text: `La règle s’appuie sur des noms de classes que le site génère à chaque mise à jour.${byLabel}`, fix: `Refaites 🎯 sur ce champ : le nouveau repérage évite ces noms.${fallback}` });
  }
  const twin = ((knowledge && knowledge.rules) || []).find((r) => r !== rule && r.id !== rule.id && r.scope === rule.scope && r.field !== rule.field && r.selector === rule.selector && (r.status === 'active' || r.status === 'failing'));
  if (twin) out.push({ code: 'shared_block', text: `Même bloc que le champ « ${twin.field} » : l’un des deux désigne le mauvais bloc.`, fix: `Refaites 🎯 sur le champ dont la valeur est fausse (« ${rule.field} » ou « ${twin.field} »).` });
  if (rule.status === 'failing') out.push({ code: 'failing', text: 'En échec sur les dernières fiches lues.', fix: `Cliquez « revérifier » sur une fiche à jour, ou refaites 🎯 sur ce champ.${fallback}` });
  else if (!(rule.tests && rule.tests.total)) out.push({ code: 'untested', text: 'Pas encore vérifiée sur une autre fiche que celle où elle a été apprise.', fix: 'Elle sera mesurée au prochain scraping, ou cliquez « revérifier ».' });
  return out;
}

/**
 * Bring a stored knowledge object to the current version. Never throws, never drops a rule.
 * v1 → v2: the teaching page leaves the counted tests (it was counted once, first, as a success).
 * A knowledge written by a NEWER app is returned untouched with `newer: true` (never downgraded).
 * @returns {{ knowledge:object, changed:boolean, newer:boolean }}
 */
export function migrateKnowledge(knowledge) {
  if (!knowledge || typeof knowledge !== 'object' || !Array.isArray(knowledge.rules)) return { knowledge, changed: false, newer: false };
  const v = Number(knowledge.version) || 1;
  if (v > KNOWLEDGE_VERSION) return { knowledge, changed: false, newer: true };
  if (v === KNOWLEDGE_VERSION) return { knowledge, changed: false, newer: false };
  const k = clone(knowledge);
  for (const r of k.rules) {
    // v3: a picture rule says where its pictures come from; an older one read the block's every attribute (kept: source 'dom').
    if (IMAGE_FIELDS.has(r.field) || (r.extract && r.extract.mode === 'image')) r.extract = { ...(r.extract || {}), mode: 'image', source: (r.extract && IMAGE_RULE_SOURCES.has(r.extract.source)) ? r.extract.source : 'dom' };
    if (v >= 2) continue;
    const t = r.tests;
    if (!t || typeof t !== 'object' || !r.learnedFrom) continue;
    const taught = pageKey(r.learnedFrom);
    const urls = Array.isArray(t.urls) ? t.urls : [];
    // v1 put the teaching page first in `urls` and counted it as one success.
    if (urls.some((u) => pageKey(u) === taught)) {
      if (typeof t.recent === 'string' && t.recent.length && t.recent.length < RECENT_WINDOW) {
        const i = t.recent.indexOf('1');
        if (i >= 0) t.recent = t.recent.slice(0, i) + t.recent.slice(i + 1);
        t.ok = [...t.recent].filter((c) => c === '1').length; t.total = t.recent.length;
      } else if (typeof t.recent !== 'string') {
        t.ok = Math.max(0, (Number(t.ok) || 0) - 1); t.total = Math.max(0, (Number(t.total) || 0) - 1);
      }
      t.urls = urls.filter((u) => pageKey(u) !== taught);
    }
    t.taught = { url: r.learnedFrom };
  }
  k.version = KNOWLEDGE_VERSION;
  return { knowledge: k, changed: true, newer: false };
}
