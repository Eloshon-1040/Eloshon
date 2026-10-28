/**
 * Admin-gated IPC for usage visibility (MAIN process): the usage ledger (summary,
 * filtered pages, CSV export, per-job route chain), the per-domain paid-route
 * opt-in (atomic config.json writes), the cost settings, the free balance read
 * and the admin test-mode plan. Every handler is wrapped by the SAME `gate` as
 * the provider channels: locked session → { ok:false, locked:true }, no data.
 *
 * The renderer only receives ledger lines (no secret by construction), masked
 * provider state, counts and timestamps — never a credential value.
 */
import fs from 'node:fs';
import { PROVIDERS, isConfigured } from '../../core/providers/registry.mjs';
import { isAiConfigured } from '../../core/providers/ai.mjs';
import { PAID_ROUTES, hostKey, normalizeDomain, optInState, optedInDomains, withOptIn, validateOptInConfig, routeDecision, routeByKey } from '../../core/providers/optin.mjs';
import { summarizeLedger, queryLedger, jobEvents, exportRows, toCsv } from '../../core/metering/reader.mjs';
import { effectiveCosts, validateCostsPatch, worstCaseForLaunch, COST_FIELDS } from '../../core/metering/costs.mjs';
import { providerStatus } from '../../core/metering/status.mjs';
import { firecrawlCreditUsage } from '../../core/unlock/firecrawl.mjs';
import { resolveCredentials } from '../../core/providers/registry.mjs';
import { updateConfig } from './config-store.mjs';

export const USAGE_GATED = [
  'usage:summary', 'usage:query', 'usage:export', 'usage:job', 'usage:jobRoutes',
  'optin:table', 'optin:normalize', 'optin:add', 'optin:set',
  'costs:get', 'costs:set', 'balance:refresh', 'admin:testPlan',
];

/** registry id → ledger provider name. */
export const LEDGER_NAME = Object.freeze({ firecrawl: 'firecrawl', 'brightData.webUnlocker': 'webunlocker', 'brightData.scrapingBrowser': 'scrapingbrowser', zyte: 'zyte' });
/** Providers the app can actually call today (Zyte has a lane module but no call site). */
const WIRED = new Set(['firecrawl', 'brightData.webUnlocker', 'brightData.scrapingBrowser']);
const ROUTE_FOR = Object.fromEntries(PAID_ROUTES.map((r) => [r.runtimeId, r]));

const readJsonFile = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };

/** Cache a free balance read ({remaining, resetAt?, planCredits?}) with its timestamp. */
export function saveBalance(balancesFile, id, res, nowMs = Date.now()) {
  if (!balancesFile || !res || !res.ok) return null;
  const b = readJsonFile(balancesFile, {});
  b[id] = { remaining: res.remaining ?? null, at: new Date(nowMs).toISOString(), ...(res.resetAt ? { resetAt: res.resetAt } : {}), ...(res.planCredits != null ? { planCredits: res.planCredits } : {}) };
  try { fs.writeFileSync(balancesFile, JSON.stringify(b, null, 2)); } catch { /* cache only */ }
  return b[id];
}

/** The safe subset of a job's report.json the admin job view shows. */
export function reportView(rep) {
  if (!rep || typeof rep !== 'object') return null;
  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
  const unlock = rep.unlock && typeof rep.unlock === 'object' ? pick(rep.unlock, ['provider', 'attempted', 'ok', 'note', 'error', 'bytes', 'runtimeSec']) : (rep.unlock === true ? { localUnlock: true } : null);
  return {
    status: rep.status ?? null, method: rep.method || (rep.discovery && rep.discovery.method) || null,
    diagnosis: (rep.discovery && rep.discovery.diagnosis) || null,
    accepted: rep.accepted ?? null, detected: rep.detected ?? null, durationMs: rep.durationMs ?? null,
    bytesDownloaded: rep.bytesDownloaded || null, scrapingBrowser: rep.scrapingBrowser || null,
    unlock, credits: rep.credits ?? null, provider: rep.provider || null,
    recipeBootstrap: rep.recipeBootstrap ? pick(rep.recipeBootstrap, ['attempted', 'ok', 'note', 'bytes', 'runtimeSec', 'captcha', 'error']) : null,
    executor: rep.executor || null,
    // Paid routes considered for the page, in order, with each outcome (v0.5.33).
    unlockChain: Array.isArray(rep.unlockChain) ? rep.unlockChain.map((c) => pick(c || {}, ['provider', 'attempted', 'outcome', 'reason', 'products', 'bytes', 'ms', 'timedOut'])) : null,
  };
}

/**
 * @param {object} handlers  the admin handler map (filled in place)
 * @param {Function} gate    the admin enforcement wrapper
 * @param {{ runtime, persist:Function, resolveIo:Function, getMeter?:()=>object|null,
 *   configFile?:string, balancesFile?:string, readJobReport?:(id:string)=>object|null,
 *   pickSavePath?:(name:string)=>Promise<string|null>, knownDomains?:()=>string[],
 *   fetchImpl?:Function, now?:()=>number }} io
 */
export function registerUsageHandlers(handlers, gate, io) {
  const { runtime, persist, resolveIo } = io;
  const now = io.now || Date.now;
  const meter = () => (io.getMeter ? io.getMeter() : null);
  const dirOf = () => { const m = meter(); return m && m.dir ? m.dir : null; };
  const readCfg = () => (io.configFile ? readJsonFile(io.configFile, {}) : (resolveIo().config || {}));
  const readBalances = () => (io.balancesFile ? readJsonFile(io.balancesFile, {}) : {});
  const noLedger = { ok: false, error: 'registre indisponible' };

  // ---- usage ledger ----
  handlers['usage:summary'] = gate(async () => {
    const dir = dirOf();
    const s = dir ? await summarizeLedger(dir, { now: now() }) : { periods: { today: { total: {}, byProvider: {} }, last7d: { total: {}, byProvider: {} }, month: { total: {}, byProvider: {} } }, lastUse: {}, lastEvent: {}, lastError: {}, events: 0, badLines: 0 };
    const cfg = readCfg();
    const balances = readBalances();
    const cards = PROVIDERS.map((p) => {
      const lp = LEDGER_NAME[p.id];
      const r = ROUTE_FOR[p.id];
      const configured = isConfigured(p.id, resolveIo());
      const gateReason = runtime ? runtime.availabilityReason(p.id, null) : null;
      const optInCount = r ? optedInDomains(cfg).filter((d) => optInState(cfg, d)[r.key]).length : null;
      const bal = balances[p.id] || null;
      return {
        id: p.id, label: p.label, provider: lp, wired: WIRED.has(p.id), configured,
        costModel: p.costModel, caps: runtime ? runtime.capFor(p.id) : {}, usage: runtime ? runtime.usageFor(p.id) : {},
        optInCount, gateReason: gateReason === 'not_configured' ? null : gateReason,
        today: s.periods.today.byProvider[lp] || null, month: s.periods.month.byProvider[lp] || null,
        lastUse: s.lastUse[lp] || null, lastEvent: s.lastEvent[lp] || null, lastError: s.lastError[lp] || null,
        balance: bal,
        status: providerStatus({ wired: WIRED.has(p.id), configured, optInCount, gateReason: gateReason === 'not_configured' ? null : gateReason, lastEvent: s.lastEvent[lp] || null, balance: bal }),
      };
    });
    // Routes without a local key: shown from the ledger only.
    const extra = [
      { provider: 'cascade', label: 'Cascade serveur Eloshon', configured: !!(cfg.edgeLicense || cfg.license) },
      { provider: 'scrapfly', label: 'Scrapfly (via la cascade serveur)', configured: null },
      { provider: 'anthropic', label: 'Assistance IA — Claude (Anthropic)', configured: isAiConfigured(resolveIo()) },
      { provider: 'local', label: 'Lecture locale (HTTP, navigateur intégré, nodriver)', configured: true },
      { provider: 'extension', label: 'Votre navigateur (extension)', configured: true },
    ].map((x) => ({ ...x, today: s.periods.today.byProvider[x.provider] || null, month: s.periods.month.byProvider[x.provider] || null, lastUse: s.lastUse[x.provider] || null, lastEvent: s.lastEvent[x.provider] || null, lastError: s.lastError[x.provider] || null }));
    const m = meter();
    return {
      ok: true, periods: s.periods, cards, extra, events: s.events, badLines: s.badLines, firstEventAt: s.firstEventAt || null,
      ledger: m ? m.status() : null,
      killSwitch: runtime ? runtime.isKill() : false,
      legacyRuns: runtime && typeof runtime.externalRuns === 'function' ? runtime.externalRuns(null) : [],
    };
  });

  handlers['usage:query'] = gate(async (filter = {}, page = {}) => {
    const dir = dirOf(); if (!dir) return noLedger;
    const r = await queryLedger(dir, filter || {}, { offset: page.offset || 0, limit: page.limit || 50 });
    return { ok: true, ...r };
  });

  handlers['usage:export'] = gate(async (filter = {}) => {
    const dir = dirOf(); if (!dir) return noLedger;
    if (!io.pickSavePath) return { ok: false, error: 'export indisponible' };
    const rows = await exportRows(dir, filter || {});
    const stamp = new Date(now()).toISOString().slice(0, 10);
    const target = await io.pickSavePath(`eloshon-utilisation-${stamp}.csv`);
    if (!target) return { ok: false, cancelled: true };
    try { fs.writeFileSync(target, '﻿' + toCsv(rows), 'utf8'); } catch (e) { return { ok: false, error: 'écriture impossible', code: String((e && e.code) || 'error') }; }
    return { ok: true, path: target, rows: rows.length };
  });

  handlers['usage:job'] = gate(async (jobId) => {
    if (!jobId || typeof jobId !== 'string') return { ok: false, error: 'job manquant' };
    const dir = dirOf();
    const events = dir ? await jobEvents(dir, jobId) : [];
    let rep = null; try { rep = io.readJobReport ? io.readJobReport(jobId) : null; } catch { rep = null; }
    return { ok: true, jobId, events, report: reportView(rep) };
  });

  // Minimal data for the "Passé par" line (result screen, Jobs list).
  handlers['usage:jobRoutes'] = gate(async (jobId) => {
    if (!jobId || typeof jobId !== 'string') return { ok: false, error: 'job manquant' };
    const dir = dirOf(); if (!dir) return { ok: true, jobId, events: [] };
    const events = (await jobEvents(dir, jobId)).map((e) => ({ ts: e.ts, provider: e.provider, route: e.route, channel: e.channel, outcome: e.outcome, attempted: e.attempted, reason: e.reason, credits: e.credits, costUsd: e.costUsd, testMode: e.testMode, products: e.products }));
    return { ok: true, jobId, events };
  });

  // ---- per-domain opt-in ----
  const tableRows = () => {
    const cfg = readCfg();
    const domains = new Set([...optedInDomains(cfg), ...(runtime ? runtime.domains() : [])]);
    try { for (const d of (io.knownDomains ? io.knownDomains() : [])) if (d) domains.add(String(d)); } catch { /* optional */ }
    const io2 = resolveIo();
    return [...domains].filter(Boolean).sort().map((domain) => {
      const opt = optInState(cfg, domain);
      const routes = PAID_ROUTES.map((r) => {
        const configured = isConfigured(r.runtimeId, io2);
        const blockedBySwitch = runtime ? !runtime.domainEnabled(domain, r.runtimeId) : false;
        const gate0 = runtime ? runtime.availabilityReason(r.runtimeId, domain) : null;
        const d = routeDecision({ configured, optedIn: opt[r.key], testMode: false, gateReason: gate0 === 'not_configured' ? null : gate0 });
        return { key: r.key, label: r.label, optedIn: !!opt[r.key], siteSwitchOn: !blockedBySwitch, configured, allowed: d.allowed, reason: d.reason, caps: runtime ? runtime.capFor(r.runtimeId) : {} };
      });
      return { domain, routes };
    });
  };
  handlers['optin:table'] = gate(() => ({ ok: true, rows: tableRows(), routes: PAID_ROUTES.map((r) => ({ key: r.key, label: r.label })) }));
  handlers['optin:normalize'] = gate((input) => normalizeDomain(input));
  handlers['optin:add'] = gate((input) => {
    const n = normalizeDomain(input); if (!n.ok) return n;
    if (runtime) { runtime.addDomain(n.domain); if (persist) persist(); }
    return { ok: true, domain: n.domain, matches: n.matches, notMatched: n.notMatched, rows: tableRows() };
  });
  handlers['optin:set'] = gate((domainInput, routeKey, on) => {
    const n = normalizeDomain(domainInput); if (!n.ok) return n;
    if (!routeByKey(routeKey)) return { ok: false, error: 'voie inconnue' };
    if (!io.configFile) return { ok: false, error: 'configuration indisponible' };
    const r = updateConfig(io.configFile, (cfg) => withOptIn(cfg, n.domain, routeKey, !!on), { backup: true, validate: validateOptInConfig });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, domain: n.domain, route: routeKey, on: !!on, backupPath: r.backupPath || null, rows: tableRows() };
  });

  // ---- cost settings ----
  handlers['costs:get'] = gate(() => ({ ok: true, costs: effectiveCosts(readCfg()), fields: COST_FIELDS, stored: readCfg().costs || {} }));
  handlers['costs:set'] = gate((patch) => {
    const v = validateCostsPatch(patch); if (!v.ok) return { ok: false, error: v.error };
    if (!io.configFile) return { ok: false, error: 'configuration indisponible' };
    const r = updateConfig(io.configFile, (cfg) => {
      const c = (cfg.costs && typeof cfg.costs === 'object') ? cfg.costs : {};
      for (const [prov, vals] of Object.entries(v.value)) c[prov] = { ...(c[prov] || {}), ...vals };
      cfg.costs = c; return cfg;
    }, { backup: true });
    return r.ok ? { ok: true, costs: effectiveCosts(r.config) } : { ok: false, error: r.error };
  });

  // ---- balances: only documented FREE reads, on demand (never polled) ----
  handlers['balance:refresh'] = gate(async (id) => {
    if (id !== 'firecrawl') return { ok: false, error: 'aucune lecture gratuite du solde pour ce fournisseur' };
    if (!isConfigured('firecrawl', resolveIo())) return { ok: false, error: 'non configuré' };
    const creds = resolveCredentials('firecrawl', resolveIo()); // value stays in main
    const res = await firecrawlCreditUsage(creds.apiKey, { fetchImpl: io.fetchImpl });
    if (!res.ok) return { ok: false, error: res.error || 'lecture impossible' };
    const saved = saveBalance(io.balancesFile, 'firecrawl', res, now());
    return { ok: true, balance: saved || { remaining: res.remaining, at: new Date(now()).toISOString() } };
  });

  // ---- admin test mode: what a test launch on this URL may cost at worst ----
  handlers['admin:testPlan'] = gate((url) => {
    const host = hostKey(url);
    if (!host) return { ok: false, error: 'adresse invalide' };
    const cfg = readCfg(); const io2 = resolveIo(); const costs = effectiveCosts(cfg);
    const opt = optInState(cfg, host);
    const routes = PAID_ROUTES.map((r) => {
      const configured = isConfigured(r.runtimeId, io2);
      const gate0 = runtime ? runtime.availabilityReason(r.runtimeId, host) : null;
      const gateReason = gate0 === 'not_configured' ? null : gate0;
      const withTest = routeDecision({ configured, optedIn: opt[r.key], testMode: true, gateReason });
      return { key: r.key, provider: r.provider, label: r.label, configured, optedIn: !!opt[r.key], gateReason, allowedWithTest: withTest.allowed, reason: withTest.reason, caps: runtime ? runtime.capFor(r.runtimeId) : {}, usage: runtime ? runtime.usageFor(r.runtimeId) : {} };
    });
    const worst = worstCaseForLaunch(routes.map((r) => ({ provider: r.provider, label: r.label, allowed: r.allowedWithTest, caps: r.caps })), costs);
    const bootstrap = !!(cfg.brightData && cfg.brightData.scrapingBrowserBootstrap && cfg.brightData.scrapingBrowserBootstrap[host]);
    return { ok: true, domain: host, routes, worst, bootstrap };
  });

  return USAGE_GATED;
}
