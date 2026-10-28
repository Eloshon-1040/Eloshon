/**
 * recipes.json — the site recipes as one portable, versioned file: what each site taught (rules of its
 * product pages, its list-card recipe, its link filter, its internal-API recipe). Exported from one app or
 * one machine, imported into another; the extension reads them through the app, so both share them.
 *
 *   exportRecipes(profiles, { hosts })          → the file (an object; JSON.stringify it)
 *   planImport(profiles, file)                  → { ok, plan, summary } | { ok:false, reason }   (nothing written)
 *   applyImport(profiles, plan)                 → the new profiles map
 *
 * Merge, per site + scope + field, never silent: every line of the summary says added / replaced / kept /
 * identical, and why (a code the interface words in its language: none_here, same, manual_kept, more_trusted_file,
 * newer_file, more_trusted_here, newer_here, absent_here, other_here; `what` = rule | manual_selectors |
 * link_filter | internal_api). A manual rule is never replaced by an automatic one; otherwise the more trusted rule
 * wins (confidence), then the newer one. A file written by a NEWER app is refused with a clear message; an
 * older one is migrated (shared/knowledge/rules.mjs migrateKnowledge). No secret is ever in the file: the
 * internal-API recipe stores where its key is read, never the key.
 * Pure (no fs): the caller reads / writes the file and keeps the backup.
 */
import { KNOWLEDGE_VERSION, migrateKnowledge, ruleConfidence, emptyKnowledge } from '../shared/knowledge/rules.mjs';

export const RECIPES_FORMAT = 'eloshon-recipes';
export const RECIPES_FILE_VERSION = 1;

const live = (r) => r && (r.status === 'active' || r.status === 'failing' || r.status === 'proposed');
const clone = (o) => JSON.parse(JSON.stringify(o));
const sameRule = (a, b) => a.selector === b.selector && JSON.stringify(a.strategies || []) === JSON.stringify(b.strategies || []) && JSON.stringify((a.state && a.state.key) || null) === JSON.stringify((b.state && b.state.key) || null);
const RECIPE_PARTS = ['manual_selectors', 'link_filter', 'internal_api', 'list_pagination', 'site_values', 'list_batches', 'card_model'];

/** The file for some sites (all of them when `hosts` is empty): rules, list recipe, link filter, API recipe. */
export function exportRecipes(profiles, { hosts = null, now = new Date().toISOString(), appVersion = null } = {}) {
  const sites = {};
  for (const [host, p] of Object.entries(profiles || {})) {
    if (hosts && hosts.length && !hosts.includes(host)) continue;
    if (!p || typeof p !== 'object') continue;
    const k = p.siteKnowledge && Array.isArray(p.siteKnowledge.rules) ? migrateKnowledge(p.siteKnowledge).knowledge : null;
    const site = {};
    if (k && k.rules.some(live)) site.knowledge = { version: k.version, rules: k.rules.filter(live) };
    for (const part of RECIPE_PARTS) if (p[part]) site[part] = clone(p[part]);
    if (Object.keys(site).length) sites[host] = site;
  }
  return { format: RECIPES_FORMAT, version: RECIPES_FILE_VERSION, knowledgeVersion: KNOWLEDGE_VERSION, exportedAt: now, ...(appVersion ? { appVersion } : {}), sites };
}

/**
 * What importing `file` would change — computed, nothing written. Refuses a file from a newer app.
 * @returns {{ok:true, plan:object, summary:{sites:Object<string,Array<{what:string, field?:string, scope?:string, action:string, why:string}>>, counts:object}} | {ok:false, reason:string}}
 */
export function planImport(profiles, file) {
  if (!file || typeof file !== 'object' || file.format !== RECIPES_FORMAT || typeof file.sites !== 'object' || !file.sites) return { ok: false, code: 'not_recipes', reason: 'ce fichier n’est pas un fichier de recettes Eloshon (recipes.json)' };
  if (!(Number(file.version) >= 1)) return { ok: false, code: 'bad_version', reason: 'version du fichier de recettes illisible' };
  if (Number(file.version) > RECIPES_FILE_VERSION || Number(file.knowledgeVersion) > KNOWLEDGE_VERSION) {
    return { ok: false, code: 'newer_app', reason: `ce fichier a été créé par une version plus récente de l’application (format ${file.version}, règles v${file.knowledgeVersion}) : mettez l’application à jour avant de l’importer` };
  }
  const plan = {}; const summary = {}; const counts = { added: 0, replaced: 0, kept: 0, identical: 0 };
  const note = (host, line) => { (summary[host] = summary[host] || []).push(line); counts[line.action] = (counts[line.action] || 0) + 1; };
  for (const [host, site] of Object.entries(file.sites)) {
    if (!/^[a-z0-9.-]{1,253}$/i.test(host) || !site || typeof site !== 'object') continue;
    const cur = (profiles && profiles[host]) || {};
    const p = { rules: [], parts: {} };
    // Rules, per scope + field: the file's live rule against the one in place.
    if (site.knowledge && Array.isArray(site.knowledge.rules)) {
      const incoming = migrateKnowledge({ version: Number(site.knowledge.version) || 1, rules: site.knowledge.rules }).knowledge.rules.filter(live);
      const here = cur.siteKnowledge ? migrateKnowledge(cur.siteKnowledge).knowledge.rules.filter(live) : [];
      for (const r of incoming) {
        if (!r || typeof r.field !== 'string' || typeof r.selector !== 'string') continue;
        const mine = here.filter((x) => x.scope === r.scope && x.field === r.field);
        const best = mine.find((x) => x.status === 'active') || mine[0] || null;
        const line = { what: 'rule', field: r.field, scope: r.scope };
        if (!best) { p.rules.push(r); note(host, { ...line, action: 'added', why: 'none_here' }); continue; }
        if (sameRule(best, r)) { note(host, { ...line, action: 'identical', why: 'same' }); continue; }
        if (best.origin === 'manual' && r.origin !== 'manual') { note(host, { ...line, action: 'kept', why: 'manual_kept' }); continue; }
        const a = ruleConfidence(r).score; const b = ruleConfidence(best).score;
        const newer = String(r.updated || '') > String(best.updated || '');
        if (a > b || (a === b && newer)) { p.rules.push(r); note(host, { ...line, action: 'replaced', why: a > b ? 'more_trusted_file' : 'newer_file', scores: [a, b] }); }
        else note(host, { ...line, action: 'kept', why: a < b ? 'more_trusted_here' : 'newer_here', scores: [a, b] });
      }
    }
    // List recipe, link filter, API recipe: added when missing; a different one in place is kept and said.
    for (const part of RECIPE_PARTS) {
      if (!site[part]) continue;
      const line = { what: part };
      if (!cur[part]) { p.parts[part] = clone(site[part]); note(host, { ...line, action: 'added', why: 'absent_here' }); }
      else if (JSON.stringify(cur[part]) === JSON.stringify(site[part])) note(host, { ...line, action: 'identical', why: 'same' });
      else note(host, { ...line, action: 'kept', why: 'other_here' });
    }
    if (p.rules.length || Object.keys(p.parts).length) plan[host] = p;
  }
  return { ok: true, plan, summary: { sites: summary, counts } };
}

/** Apply a plan (from planImport) to the profiles: the new map (the input is not mutated). */
export function applyImport(profiles, plan, { now = new Date().toISOString() } = {}) {
  const out = clone(profiles || {});
  for (const [host, p] of Object.entries(plan || {})) {
    const prof = out[host] || (out[host] = { runs: 0 });
    let k = prof.siteKnowledge ? migrateKnowledge(prof.siteKnowledge).knowledge : emptyKnowledge();
    for (const r of p.rules || []) {
      // The rule in place for this field becomes history; the imported one is live (its own tests kept).
      for (const x of k.rules) if (x.scope === r.scope && x.field === r.field && live(x)) { x.status = 'superseded'; x.supersededReason = 'replaced_by_import'; x.updated = now; }
      k.rules = k.rules.filter((x) => x.id !== r.id);
      k.rules.push({ ...clone(r), status: r.status === 'proposed' ? 'proposed' : 'active', importedAt: now });
    }
    if ((p.rules || []).length) { k.updatedAt = now; k.log = [...(Array.isArray(k.log) ? k.log : []), { id: `lg_import_${now}`, at: now, action: 'import', fields: p.rules.map((r) => r.field) }].slice(-50); prof.siteKnowledge = k; }
    for (const [part, v] of Object.entries(p.parts || {})) prof[part] = clone(v);
    prof.updatedAt = now;
  }
  return out;
}
