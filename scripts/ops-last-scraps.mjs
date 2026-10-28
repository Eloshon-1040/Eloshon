/**
 * Report on the latest scraps — READ-ONLY, NO NETWORK. Output is in French (it is read by the owner).
 *
 * Reads, in Eloshon Scraper's data folder (Electron `userData`):
 *   data/jobs/<ID>/job.json + products.json   the job and its products
 *   data/reports/<ID>.json                    the job's report
 *   usage-ledger/*.jsonl                      the usage ledger (through core/metering/reader.mjs)
 * and prints, per job: site, route chain, paid routes tried or refused, cost, list pages, announced
 * total, products, product pages completed, fill rate per column and anomalies. It creates, changes
 * and deletes no file and opens no connection. Used by the project skill eloshon-scraper-ops (§3).
 *
 *   node scripts/ops-last-scraps.mjs                        # the 5 latest jobs of the real folder (Windows)
 *   node scripts/ops-last-scraps.mjs --last 10
 *   node scripts/ops-last-scraps.mjs --job 20261008172332-9xn0z [--job <other id>]
 *   node scripts/ops-last-scraps.mjs --user-data <folder>   # e.g. an isolated test folder
 *   node scripts/ops-last-scraps.mjs --json                 # same content as JSON
 *
 * A column "collapses" when its fill rate is more than COLLAPSE_POINTS below the previous pass of the
 * same site (same 10-point threshold as scripts/smoke-live.mjs), taken from the latest older job of
 * the site that has at least MIN_COMPARE products.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { iterateLedger } from '../core/metering/reader.mjs';
import { PAID_PROVIDERS } from '../core/metering/ledger.mjs';

export const MIN_COMPARE = 5;        // products a previous job needs to serve as a comparison
export const COLLAPSE_POINTS = 10;   // fill-rate drop (in points) reported as a collapse
const LOOKBACK_JOBS = 80;            // how many older jobs are scanned for a previous pass of the same site
const JOB_ID_RE = /^\d{14}-[a-z0-9]+$/i;

// The product columns and their fill rate: one definition with the job report (core/fill-rate.mjs).
export { PRODUCT_FIELDS, isFilled, fillRates } from '../core/fill-rate.mjs';
import { fillRates } from '../core/fill-rate.mjs';

const OUTCOME_FR = {
  success: 'réussite', empty: 'page reçue, aucun produit', failed: 'échec', timeout: 'délai dépassé', quota_exhausted: 'quota épuisé',
  blocked_by_cap: 'plafond atteint (blocked_by_cap)', blocked_no_optin: 'domaine non autorisé (blocked_no_optin)',
};
const LAUNCH_FR = { manual: 'logiciel', 'your-browser': 'votre navigateur (extension)' };

/** One ledger outcome in French; the ledger's own reason code stays visible next to it. */
export function outcomeLabel({ outcome, attempted, reason }) {
  if (outcome === 'skipped') return reason === 'stopped_by_user' ? 'interrompue par l\'utilisateur' : (attempted ? 'ignorée' : 'non utilisée');
  return OUTCOME_FR[outcome] || String(outcome);
}

// ------------------------------------------------------------------ pure helpers

const urlKey = (u) => String(u || '').trim().replace(/#.*$/, '').replace(/\/$/, '');
const COLOUR_TYPE = /couleur|colou?r|kleur|farbe/i;

/** Anomalies of §3 step 4 that can be read from the products alone. */
export function findAnomalies(products) {
  const out = [];
  const sharedBy = (keyOf) => {
    const m = new Map();
    for (const p of products) { const k = keyOf(p); if (k) m.set(k, (m.get(k) || 0) + 1); }
    const dup = [...m.values()].filter((n) => n > 1);
    return { products: dup.reduce((a, n) => a + n, 0), keys: dup.length };
  };
  const dUrl = sharedBy((p) => urlKey(p.source_url));
  if (dUrl.keys) out.push({ code: 'duplicate_url', products: dUrl.products, text: `${dUrl.products} produits partagent ${dUrl.keys} URL (doublons)` });
  const dRef = sharedBy((p) => (p.source_product_id == null ? '' : String(p.source_product_id)));
  if (dRef.keys) out.push({ code: 'duplicate_reference', products: dRef.products, text: `${dRef.products} produits partagent ${dRef.keys} référence(s)` });
  const unnamed = products.filter((p) => Array.isArray(p.variants) && p.variants.some((v) => v && COLOUR_TYPE.test(String(v.type || '')) && !String(v.name || '').trim())).length;
  if (unnamed) out.push({ code: 'colour_without_name', products: unnamed, text: `${unnamed} produits ont des coloris sans nom de couleur` });
  const zero = products.filter((p) => p.price === 0).length;
  if (zero) out.push({ code: 'price_zero', products: zero, text: `${zero} produits ont un prix à 0` });
  const dupImg = products.filter((p) => Array.isArray(p.images) && new Set(p.images).size !== p.images.length).length;
  if (dupImg) out.push({ code: 'duplicate_images', products: dupImg, text: `${dupImg} produits ont la même image plusieurs fois` });
  return out;
}

/** Columns whose fill rate fell by more than `points` since the previous pass. */
export function collapses(current, previous, points = COLLAPSE_POINTS) {
  const out = [];
  for (const f of current.fields) {
    const p = previous.fields.find((x) => x.key === f.key);
    if (p && p.pct != null && f.pct != null && f.pct < p.pct - points) out.push({ key: f.key, label: f.label, from: p.pct, to: f.pct });
  }
  return out;
}

/** The route chain of one job from its ledger lines: lanes tried, paid lanes tried or refused, cost. */
export function summarizeChain(lines) {
  const sorted = lines.map((l, i) => [l, i]).sort((a, b) => (a[0].ts < b[0].ts ? -1 : a[0].ts > b[0].ts ? 1 : a[1] - b[1])).map(([l]) => l);
  const paid = (l) => PAID_PROVIDERS.includes(l.provider);
  const paidAttempted = sorted.filter((l) => paid(l) && l.attempted);
  const refusal = (l) => l.outcome === 'blocked_no_optin' || l.outcome === 'blocked_by_cap';
  const priced = paidAttempted.filter((l) => Number.isFinite(l.costUsd));
  return {
    lines: sorted.length,
    chain: sorted.filter((l) => l.attempted).map((l) => ({ provider: l.provider, route: l.route, outcome: l.outcome, attempted: l.attempted, reason: l.reason, products: l.products, credits: l.credits, channel: l.channel, ...(l.cacheState ? { cacheState: l.cacheState } : {}) })),
    paidAttempted: paidAttempted.length,
    paidProviders: [...new Set(paidAttempted.map((l) => l.provider))],
    refused: sorted.filter((l) => paid(l) && refusal(l)).map((l) => ({ provider: l.provider, outcome: l.outcome, reason: l.reason })),
    notTried: sorted.filter((l) => paid(l) && !l.attempted && !refusal(l)).map((l) => ({ provider: l.provider, outcome: l.outcome, reason: l.reason })),
    costUsd: priced.reduce((a, l) => a + l.costUsd, 0),
    costUnknown: paidAttempted.filter((l) => !Number.isFinite(l.costUsd) && l.provider !== 'cascade').length,
    // Paid calls that came back without any product (billed for nothing).
    paidEmpty: paidAttempted.filter((l) => l.outcome === 'empty' || (l.outcome === 'success' && l.products === 0)).length,
    credits: sorted.reduce((a, l) => a + (Number.isFinite(l.credits) ? l.credits : 0), 0),
    // Paid pages the provider served from its own cache (ledger `cacheState`, v0.5.37).
    cacheHits: paidAttempted.filter((l) => l.cacheState === 'hit').length,
    testMode: sorted.some((l) => l.testMode === true),
  };
}

// ------------------------------------------------------------------ reading

function readJson(file) {
  try { return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) }; }
  catch (e) { return { ok: false, error: e && e.code === 'ENOENT' ? 'absent' : 'illisible' }; }
}

const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; } };

/** Job ids found in data/reports and data/jobs, newest first (ids start with a UTC timestamp). */
export function listJobIds(userData) {
  const ids = new Set();
  const scan = (dir, strip) => { try { for (const n of fs.readdirSync(dir)) { const id = strip ? n.replace(/\.json$/, '') : n; if ((!strip || n.endsWith('.json')) && JOB_ID_RE.test(id)) ids.add(id); } } catch { /* folder absent */ } };
  scan(path.join(userData, 'data', 'reports'), true);
  scan(path.join(userData, 'data', 'jobs'), false);
  return [...ids].sort().reverse();
}

function loadJob(userData, id) {
  const data = path.join(userData, 'data');
  const job = readJson(path.join(data, 'jobs', id, 'job.json'));
  const rep = readJson(path.join(data, 'reports', `${id}.json`));
  const prod = readJson(path.join(data, 'jobs', id, 'products.json'));
  const j = job.ok ? job.value : {};
  const meta = j.meta || {};
  return {
    id, job: j, meta, found: job.ok || rep.ok,
    report: rep.ok ? rep.value : (j.report || null),
    reportSource: rep.ok ? 'rapport' : (j.report ? 'job.json' : 'absent'),
    products: prod.ok && Array.isArray(prod.value) ? prod.value : null,
    productsState: prod.ok ? (Array.isArray(prod.value) ? 'ok' : 'illisible') : prod.error,
    domain: hostOf(meta.origin || (Array.isArray(meta.urls) ? meta.urls[0] : null)),
  };
}

async function readLedger(userData, ids) {
  const dir = path.join(userData, 'usage-ledger');
  const wanted = new Set(ids);
  const byJob = new Map();
  const stats = { badLines: 0 };
  let events = 0; let first = null;
  for await (const o of iterateLedger(dir, stats)) {
    events += 1; if (!first) first = o.ts;
    if (o.jobId && wanted.has(o.jobId)) { if (!byJob.has(o.jobId)) byJob.set(o.jobId, []); byJob.get(o.jobId).push(o); }
  }
  return { dir, present: fs.existsSync(dir), events, badLines: stats.badLines, firstEventAt: first, byJob };
}

function previousPass(userData, all, index, domain, cache) {
  if (!domain) return null;
  for (let i = index + 1; i < all.length && i <= index + LOOKBACK_JOBS; i++) {
    const id = all[i];
    if (!cache.has(id)) cache.set(id, loadJob(userData, id));
    const c = cache.get(id);
    if (c.domain !== domain || !c.products || c.products.length < MIN_COMPARE) continue;
    return { id, method: methodOf(c.report), fill: fillRates(c.products) };
  }
  return null;
}

function methodOf(report) {
  if (!report) return null;
  return report.method || (report.discovery && report.discovery.method) || null;
}

/** Everything the report shows, as plain data. */
export async function buildReport({ userData, last = 5, jobIds = null } = {}) {
  const all = listJobIds(userData);
  const selected = jobIds && jobIds.length ? jobIds : all.slice(0, Math.max(1, last));
  const ledger = await readLedger(userData, selected);
  const cache = new Map();
  const jobs = selected.map((id) => {
    const c = cache.get(id) || loadJob(userData, id);
    cache.set(id, c);
    const r = c.report || {};
    const fill = c.products ? fillRates(c.products) : null;
    const prev = fill ? previousPass(userData, all, all.indexOf(id) >= 0 ? all.indexOf(id) : all.length, c.domain, cache) : null;
    const lines = ledger.byJob.get(id) || [];
    return {
      id, found: c.found, domain: c.domain, createdAt: c.job.createdAt || null,
      status: { report: r.status || null, job: c.job.status || null, reason: c.job.reason ? String(c.job.reason).slice(0, 160) : null, blocked: r.blocked && r.blocked.code ? r.blocked.code : null },
      source: { reportFrom: c.reportSource, products: c.productsState },
      launcher: { provider: c.meta.provider || null, testMode: !!c.meta.testMode },
      method: methodOf(r), byStrategy: r.byStrategy || null, executor: r.executor || null,
      chain: lines.length ? summarizeChain(lines) : null,
      list: {
        pagination: r.pagination ? { mechanism: r.pagination.mechanism || null, pages: r.pagination.pages ?? null, totalAnnounced: r.pagination.totalAnnounced ?? null, stoppedBy: r.pagination.stoppedBy || null, warnings: r.pagination.warnings || [] } : null,
        apiAfterScroll: r.pagination && r.pagination.apiAfterScroll ? { pages: r.pagination.apiAfterScroll.pages, added: r.pagination.apiAfterScroll.added, headersLearned: r.pagination.apiAfterScroll.headersLearned } : null,
        detailPages: r.detailPages ? { listed: r.detailPages.listed ?? null, visited: r.detailPages.visited ?? null, completed: r.detailPages.completed ?? null, failed: r.detailPages.failed ?? null } : null,
      },
      counts: { discovered: r.discovered ?? null, accepted: r.accepted ?? null, toVerify: r.toVerify ?? null, excluded: r.excluded ?? null, inFile: c.products ? c.products.length : null },
      fill,
      anomalies: c.products ? findAnomalies(c.products) : [],
      collapsed: fill && prev ? { since: prev.id, method: prev.method, columns: collapses(fill, prev.fill) } : null,
    };
  });
  return { userData, ledger: { dir: ledger.dir, present: ledger.present, events: ledger.events, badLines: ledger.badLines, firstEventAt: ledger.firstEventAt }, jobs };
}

// ------------------------------------------------------------------ text output

const usd = (n) => `${n.toFixed(4).replace('.', ',')} $`;

function localTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('fr-BE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function costLine(chain) {
  if (!chain) return 'non établi : aucune ligne dans le registre pour ce job (job antérieur au registre, ou registre absent)';
  if (!chain.paidAttempted) return '0 $ (aucune voie payante tentée)';
  const parts = [`${chain.paidAttempted} appel(s) payant(s) tenté(s) : ${chain.paidProviders.join(', ')}`];
  if (chain.credits) parts.push(`${chain.credits} crédit(s)`);
  if (chain.costUsd > 0) parts.push(`${usd(chain.costUsd)} estimés${chain.costUnknown ? `, hors ${chain.costUnknown} appel(s) sans prix renseigné` : ''}`);
  else parts.push('coût estimé inconnu : prix unitaire non renseigné (Administration › Coûts)');
  if (chain.paidEmpty) parts.push(`${chain.paidEmpty} appel(s) payant(s) sans produit`);
  if (chain.cacheHits) parts.push(`${chain.cacheHits} page(s) resservie(s) depuis le cache du fournisseur`);
  return parts.join(' · ');
}

export function formatText(rep) {
  const L = [];
  L.push(`Relevé des derniers scraps — dossier : ${rep.userData}`);
  L.push(rep.ledger.present ? `Registre : ${rep.ledger.events} ligne(s) lue(s)${rep.ledger.badLines ? `, ${rep.ledger.badLines} illisible(s)` : ''}${rep.ledger.firstEventAt ? `, la première date du ${localTime(rep.ledger.firstEventAt)}` : ''}.` : 'Registre : dossier usage-ledger absent.');
  for (const j of rep.jobs) {
    L.push('');
    if (!j.found) { L.push(`■ Job ${j.id} · introuvable : ni job.json ni rapport dans ${rep.userData}`); continue; }
    L.push(`■ Job ${j.id} · ${j.domain || 'site inconnu'} · ${j.status.report || '—'} (job : ${j.status.job || '—'}) · ${localTime(j.createdAt)}`);
    if (j.status.reason || j.status.blocked) L.push(`  Raison      : ${[j.status.reason, j.status.blocked && `blocage ${j.status.blocked}`].filter(Boolean).join(' · ')}`);
    L.push(`  Lancement   : ${LAUNCH_FR[j.launcher.provider] || j.launcher.provider || '—'}${j.launcher.testMode ? ' · mode test administrateur' : ''}`);
    L.push(`  Méthode     : ${j.method || '—'}${j.byStrategy ? ` · ${Object.entries(j.byStrategy).map(([k, v]) => `${k}=${v}`).join(', ') || 'aucun produit lu'}` : ''}${j.executor ? ` · ${j.executor}` : ''}`);
    if (j.chain) {
      L.push(`  Voies       : ${j.chain.chain.map((c) => `${c.provider}${c.route ? '/' + c.route : ''} (${outcomeLabel(c)}${c.reason ? ` [${c.reason}]` : ''}${Number.isFinite(c.products) ? `, ${c.products} produit${c.products > 1 ? 's' : ''}` : ''})`).join(' → ') || 'aucune voie tentée'}`);
      L.push(`  Refusées    : ${j.chain.refused.length ? j.chain.refused.map((r) => `${r.provider} — ${outcomeLabel({ ...r, attempted: false })}${r.reason ? ` [${r.reason}]` : ''}`).join(' · ') : 'aucune'}`);
      if (j.chain.notTried.length) L.push(`  Non tentées : ${j.chain.notTried.map((r) => `${r.provider}${r.reason ? ` [${r.reason}]` : ''}`).join(' · ')}`);
    } else L.push('  Voies       : aucune ligne dans le registre pour ce job');
    L.push(`  Coût        : ${costLine(j.chain)}`);
    const pg = j.list.pagination;
    L.push(`  Liste       : ${pg ? `${pg.mechanism || '—'}, ${pg.pages ?? '—'} page(s) lue(s), total annoncé : ${pg.totalAnnounced ?? 'non donné'}, arrêt : ${pg.stoppedBy || '—'}${pg.warnings.length ? `, avertissements : ${pg.warnings.join(', ')}` : ''}` : 'aucun bloc pagination dans le rapport'}`);
    if (j.list.apiAfterScroll) L.push(`  Après défilement : API du site, ${j.list.apiAfterScroll.pages} page(s), ${j.list.apiAfterScroll.added} produit(s) ajouté(s), ${j.list.apiAfterScroll.headersLearned} en-tête(s) repris de la page`);
    const c = j.counts;
    L.push(`  Produits    : ${c.inFile ?? 'products.json ' + j.source.products} dans products.json · acceptés ${c.accepted ?? '—'}, à vérifier ${c.toVerify ?? '—'}, exclus ${c.excluded ?? '—'}`);
    const dp = j.list.detailPages;
    L.push(`  Fiches      : ${dp ? `${dp.completed ?? '—'} complétée(s) sur ${dp.visited ?? '—'} visitée(s) (${dp.listed ?? '—'} listées, ${dp.failed ?? 0} en échec)` : 'aucun bloc detailPages dans le rapport'}`);
    if (j.fill && j.fill.total) {
      L.push(`  Remplissage (${j.fill.total} produits) : ${j.fill.fields.map((f) => `${f.label} ${f.pct} %`).join(' · ')}`);
      if (j.fill.panelColumns.length) L.push(`  Colonnes du panneau : ${j.fill.panelColumns.map((f) => `${f.label} ${f.pct} %`).join(' · ')}`);
      const empty = j.fill.fields.filter((f) => f.pct === 0).map((f) => f.label);
      const partial = j.fill.fields.filter((f) => f.pct > 0 && f.pct < 100).map((f) => `${f.label} ${f.pct} %`);
      if (empty.length) L.push(`  Vides partout : ${empty.join(', ')} — le site ne les donne peut-être pas ; à confirmer sur une fiche`);
      if (partial.length) L.push(`  Remplis en partie : ${partial.join(', ')} — extraction incomplète, ou donnée absente de certaines fiches`);
    } else L.push(`  Remplissage : aucun produit exploitable (products.json : ${j.source.products})`);
    const flags = [...j.anomalies.map((a) => a.text)];
    if (j.collapsed && j.collapsed.columns.length) flags.push(`colonne(s) en baisse de plus de ${COLLAPSE_POINTS} points depuis le job ${j.collapsed.since}${j.collapsed.method ? ` (méthode ${j.collapsed.method})` : ''} : ${j.collapsed.columns.map((x) => `${x.label} ${x.from} % → ${x.to} %`).join(', ')}`);
    L.push(`  Anomalies   : ${flags.length ? flags.join(' ; ') : 'aucune'}`);
  }
  return L.join('\n');
}

// ------------------------------------------------------------------ command line

export function parseArgs(argv) {
  const o = { last: 5, jobIds: [], userData: null, json: false, help: false, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--last') { const n = Number(argv[++i]); if (Number.isInteger(n) && n > 0) o.last = n; else o.error = '--last attend un entier positif'; }
    else if (a === '--job') { const id = argv[++i]; if (id && JOB_ID_RE.test(id)) o.jobIds.push(id); else o.error = '--job attend un identifiant de job (AAAAMMJJhhmmss-xxxxx)'; }
    else if (a === '--user-data') { const d = argv[++i]; if (d) o.userData = d; else o.error = '--user-data attend un dossier'; }
    else o.error = `option inconnue : ${a}`;
  }
  return o;
}

/** Windows default only: the other systems must give --user-data (no path is guessed). */
export function defaultUserData(env = process.env, platform = process.platform) {
  return platform === 'win32' && env.APPDATA ? path.join(env.APPDATA, 'Eloshon Scraper') : null;
}

const USAGE = 'Usage : node scripts/ops-last-scraps.mjs [--last N] [--job ID]... [--user-data DOSSIER] [--json]';

export async function run(argv, io = {}) {
  const out = io.out || ((s) => process.stdout.write(s + '\n'));
  const err = io.err || ((s) => process.stderr.write(s + '\n'));
  const a = parseArgs(argv);
  if (a.help) { out(USAGE); return 0; }
  if (a.error) { err(`${a.error}\n${USAGE}`); return 2; }
  const userData = a.userData || defaultUserData(io.env, io.platform);
  if (!userData) { err(`Dossier de données introuvable : donne --user-data.\n${USAGE}`); return 2; }
  if (!fs.existsSync(path.join(userData, 'data'))) { err(`Aucun dossier « data » dans ${userData} : rien à relever. Vérifie le chemin passé à --user-data.`); return 1; }
  const rep = await buildReport({ userData, last: a.last, jobIds: a.jobIds });
  out(a.json ? JSON.stringify(rep, null, 2) : formatText(rep));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`Erreur inattendue : ${(e && e.message) || e}\n`); process.exitCode = 1; });
}
