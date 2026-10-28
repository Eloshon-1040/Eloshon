/**
 * DSL interpreter (Requirement B/C). Executes a recipe's `actions` program using
 * ONLY capabilities injected in `env`, so the same code runs inside the extension
 * (env.page bound to the real tab) and inside Node unit tests (env.page = a mock).
 * The interpreter never hardcodes a site, a selector, a URL or a volume cap —
 * everything comes from the recipe and from env.limits.
 *
 * PORTABLE: zero Node built-ins, zero dependencies.
 *
 * env capabilities:
 *   page: {
 *     waitFor({selector,url_includes,state_key,timeout_ms}) -> Promise<bool>
 *     click(selector,{optional}) -> Promise
 *     type(selector,value,{submit}) -> Promise
 *     select(selector,{value,label}) -> Promise
 *     scroll({selector,to,times,pause_ms}) -> Promise
 *     currentUrl() -> Promise<string>
 *     goto(url) -> Promise<{status,url,body}>          // navigate; returns page ctx
 *     context() -> Promise<{status,url,body}>          // current page ctx (for detection)
 *     fetchInPage(url,opts) -> Promise<{status,body}>  // page-runtime fetch (site injects keys)
 *     settle?() -> Promise                              // wait until the page stops building itself
 *   }
 *   onDetailPage?(url, item) -> Promise                 // followLinks: a detail page is open and built
 *   acceptDetailUrl?(url) -> bool                       // followLinks: which detail URLs may be opened
 *   extractors: { embedded_state, dom, json_ld, internal_api, auto } -> (ctx,spec) => products[]
 *   pacer:      DomainPacer (reserve/onResponse)
 *   challenge:  { registry, detect, strategy, timeouts }
 *   config:     per-site config bag (for type/select value_from)
 *   limits:     { maxListPages, maxDetailPages, maxProducts } (from config; no hardcoded cap)
 *   dedupKey(product) -> string|null
 *   notify(evt), log(entry), sleep(ms), now(), signal:{aborted}, emit(progress)
 *   classifyItem(item) -> {ok, code?, text?}            // optional: drop non-product tiles
 *   classifyPage(ctx, extracted) -> {kind, reasons}     // optional: verdict on a visited detail page
 *
 * The result carries `pageVerdicts` ({rejected, doubtful} tallies with reasons)
 * when those hooks rejected or doubted anything — the WHY, not just a count.
 */
import { validateActions } from './validate.mjs';
import { detectChallenge } from '../challenge/detect.mjs';
import { RESOLUTION } from '../challenge/strategy.mjs';
import { JOB_STATUS } from '../protocol/messages.mjs';
import { tallyVerdict } from '../classify/page-kind.mjs';

const DEFAULT_LIMITS = { maxListPages: 3, maxDetailPages: 5, maxProducts: 10000 };

const defaultDedupKey = (p) => (p && (p.sku || p.id || p.sourceUrl || p.url || (p.name && p.price != null ? `${p.name}|${p.price}` : null))) || null;

/** Pace a network action: wait the reserved time, then let the caller proceed. */
async function pace(env) {
  if (!env.pacer) return;
  const waitMs = env.pacer.reserve(env.now());
  if (waitMs > 0) await env.sleep(waitMs);
}

/**
 * Feed the outcome back to the pacer (adaptive). A browser page states its server time (`serverMs`, request →
 * first byte): that is the latency the pacer weighs. A browser page that cannot state it (`serverMs: null`)
 * feeds no latency: the whole page build (scripts, images, trackers) is not a sign of a strained site, and
 * weighing it slowed every product page down to the 30 s ceiling (36 pages in 1132 s).
 */
function report(env, ctx, latencyMs) {
  if (!env.pacer) return;
  const own = ctx && Object.prototype.hasOwnProperty.call(ctx, 'serverMs') ? ctx.serverMs : undefined;
  const latency = own === undefined ? latencyMs : (Number.isFinite(own) ? own : null);
  env.pacer.onResponse({ status: ctx && ctx.status, ...(latency != null ? { latencyMs: latency } : {}), t: env.now() });
}

/**
 * Run the recipe's action program.
 * @returns {Promise<{status:string, products:Array, pages:number, detailPages:number, reason?:string}>}
 */
export async function runProgram(recipe, env) {
  const limits = { ...DEFAULT_LIMITS, ...(env.limits || {}) };
  const dedupKey = env.dedupKey || defaultDedupKey;
  const log = env.log || (() => {});
  const emit = env.emit || (() => {});
  const dedup = new Set();
  const products = [];
  let pages = 0, detailPages = 0;

  // Page/tile verdicts (shared/classify rules), reported with their reasons.
  let pageVerdicts = null;
  const verdict = (bucket, url, kind, reasons) => {
    pageVerdicts = pageVerdicts || {};
    pageVerdicts[bucket] = tallyVerdict(pageVerdicts[bucket], { url, kind, reasons });
  };
  // Where the time went (ms): list pages, then per product page the pacing wait, the page load, the human-check
  // guard, the settle wait and the page read handed to the caller. The report shows it (no unexplained duration).
  const tStart = env.now();
  const timings = { pacingMs: 0, loadMs: 0, checkMs: 0, settleMs: 0, readMs: 0, detailPages: 0 };
  const lap = async (key, fn) => { const t = env.now(); try { return await fn(); } finally { timings[key] += Math.max(0, env.now() - t); } };
  const fin = (o) => { const total = Math.max(0, env.now() - tStart); const detail = timings.pacingMs + timings.loadMs + timings.checkMs + timings.settleMs + timings.readMs; const out = { ...o, timings: { ...timings, totalMs: total, listMs: Math.max(0, total - detail) } }; return pageVerdicts ? { ...out, pageVerdicts } : out; };

  const actions = recipe.actions || [];
  const check = validateActions(actions, { dsl_version: recipe.dsl_version });
  if (!check.ok) {
    return fin({ status: JOB_STATUS.ERROR, products, pages, detailPages, reason: 'invalid_recipe', errors: check.errors });
  }

  const addProducts = (list) => {
    for (const p of (list || [])) {
      if (products.length >= limits.maxProducts) return true;
      if (env.classifyItem) {
        const v = env.classifyItem(p);
        if (v && v.ok === false) { verdict('rejected', p && (p.url || p.sourceUrl) || null, 'item', [{ code: v.code, text: v.text }]); continue; }
      }
      const key = dedupKey(p);
      if (key != null && dedup.has(key)) continue;
      if (key != null) dedup.add(key);
      products.push(p);
    }
    return false;
  };

  // The most recent extract spec — `paginate` re-applies it to each new page.
  let lastExtract = null;

  // Detect a challenge on the current context and run the configured strategy.
  // Returns 'continue' | 'retry' | a terminal JOB_STATUS.
  async function guard(ctx) {
    if (!env.challenge || !ctx) return 'continue';
    const hit = detectChallenge(ctx, env.challenge.detect || {});
    if (!hit) return 'continue';
    // Inverse content check: an anti-bot marker on a page that ALSO carries
    // extractable product data is a FALSE POSITIVE (e.g. a challenge widget embedded
    // on a normal content page), not a block — never pause a page we can read.
    if (env.hasContent) { try { if (await env.hasContent(ctx)) { log({ event: 'challenge_ignored_has_content', category: hit.category }); return 'continue'; } } catch { /* fall through to strategy */ } }
    const stratName = env.challenge.strategy || 'human_in_the_loop';
    const strat = env.challenge.registry.create(stratName, env.challenge.timeouts || {});
    emit({ phase: 'challenge', category: hit.category });
    const strategyEnv = {
      now: env.now, sleep: env.sleep, notify: env.notify, log,
      pacer: env.pacer, signal: env.signal,
      recheck: async () => { const c = await env.page.context(); return detectChallenge(c, env.challenge.detect || {}) == null; },
    };
    const res = await strat.handle({ category: hit.category, context: { ...ctx, retryAfterMs: ctx.retryAfterMs }, env: strategyEnv });
    if (res.resolution === RESOLUTION.RESUMED) return 'continue';
    if (res.resolution === RESOLUTION.RETRY) return 'retry';
    if (res.resolution === RESOLUTION.STOPPED) return JOB_STATUS.STOPPED;
    return JOB_STATUS.BLOCKED; // blocked / hand-back
  }

  async function doExtract(spec) {
    lastExtract = spec;
    const ctx = await env.page.context();
    const extractor = env.extractors[spec.using] || env.extractors.auto;
    if (!extractor) return null;
    // EXTRACT FIRST. A page we can actually read is never a "challenge" — an anti-bot
    // widget a normal page merely embeds (a contact / newsletter reCAPTCHA on a
    // PrestaShop catalogue like microfluo) must NOT pause a readable catalogue. Only
    // when extraction yields nothing AND a challenge marker is present do we run the
    // challenge strategy — a real interstitial / block returns no products anyway.
    let found = await extractor(ctx, spec);
    if (!(found && found.length) && env.challenge && detectChallenge(ctx, env.challenge.detect || {})) {
      const g = await guard(ctx);
      if (g !== 'continue' && g !== 'retry') return g;    // terminal (stopped / blocked)
      // A handled/cleared challenge may now expose the grid — re-read and extract once.
      const ctx2 = await env.page.context();
      const f2 = await extractor(ctx2, spec);
      if (f2 && f2.length) found = f2;
    }
    log({ event: 'extract', using: spec.using, count: (found || []).length });
    emit({ phase: 'extract', count: (found || []).length, total: products.length });
    addProducts(found);
    return null;
  }

  for (const action of actions) {
    if (env.signal && env.signal.aborted) return fin({ status: JOB_STATUS.STOPPED, products, pages, detailPages });
    const op = action.op;
    try {
      if (op === 'waitFor') {
        await env.page.waitFor({ selector: action.selector, url_includes: action.url_includes, state_key: action.state_key, timeout_ms: action.timeout_ms });
      } else if (op === 'click') {
        await env.page.click(action.selector, { optional: action.optional });
      } else if (op === 'type') {
        const value = action.value != null ? action.value : (env.config ? env.config[action.value_from] : undefined);
        await env.page.type(action.selector, value, { submit: action.submit });
      } else if (op === 'select') {
        const value = action.value != null ? action.value : (env.config ? env.config[action.value_from] : undefined);
        await env.page.select(action.selector, { value, label: action.label });
      } else if (op === 'scroll') {
        await env.page.scroll({ selector: action.selector, to: action.to, times: action.times, pause_ms: action.pause_ms });
      } else if (op === 'extract') {
        const terminal = await doExtract(action);
        if (terminal) return fin({ status: terminal, products, pages, detailPages, reason: terminal === JOB_STATUS.BLOCKED ? 'challenge_blocked' : undefined });
        pages = Math.max(pages, 1);
      } else if (op === 'paginate') {
        const maxPages = Math.min(action.max_pages || limits.maxListPages, limits.maxListPages);
        for (let n = 1; n < maxPages; n++) {
          if (env.signal && env.signal.aborted) return fin({ status: JOB_STATUS.STOPPED, products, pages, detailPages });
          if (products.length >= limits.maxProducts) break;
          await pace(env);
          const t0 = env.now();
          const advanced = env.page.paginate ? await env.page.paginate({ style: action.style, param: action.param, selector: action.selector, cursor_json_path: action.cursor_json_path }) : null;
          const ctx = advanced && advanced.ctx ? advanced.ctx : await env.page.context();
          report(env, ctx, env.now() - t0);
          if (!advanced || advanced.done || !advanced.moved) break;
          pages += 1;
          if (lastExtract) {
            const terminal = await doExtract(lastExtract);
            if (terminal) return fin({ status: terminal, products, pages, detailPages, reason: terminal === JOB_STATUS.BLOCKED ? 'challenge_blocked' : undefined });
          }
        }
      } else if (op === 'followLinks') {
        // The detail URL: the named field, else the usual product-row keys (extractors name it differently).
        const urlOf = (p) => (action.url_field ? p[action.url_field] : (p.url || p.sourceUrl || p.canonicalUrl)) || null;
        const cap = Math.min(action.max_links || limits.maxDetailPages, limits.maxDetailPages);
        const targets = products.filter((p) => { const u = urlOf(p); return u && (!env.acceptDetailUrl || env.acceptDetailUrl(u)); }).slice(0, cap);
        for (const p of targets) {
          if (env.signal && env.signal.aborted) return fin({ status: JOB_STATUS.STOPPED, products, pages, detailPages });
          const target = urlOf(p);
          await lap('pacingMs', () => pace(env));
          const t0 = env.now();
          let ctx = await lap('loadMs', () => env.page.goto(target));
          report(env, ctx, env.now() - t0);
          // A product page that answers with a challenge pauses the job here (the strategy tells the user).
          // A page that reads as a product page is no challenge, whatever widget it embeds (a captcha on a
          // review form): the listing-content check of `guard` cannot see that on a single product page.
          const isProduct = (c) => { try { return !!env.classifyPage && env.classifyPage(c, {}).kind === 'product'; } catch { return false; } };
          let g = isProduct(ctx) ? 'continue' : await lap('checkMs', () => guard(ctx));
          if (g === 'retry') { ctx = await lap('loadMs', () => env.page.goto(target)); g = isProduct(ctx) ? 'continue' : await lap('checkMs', () => guard(ctx)); }
          if (g === JOB_STATUS.STOPPED || g === JOB_STATUS.BLOCKED) return fin({ status: g, products, pages, detailPages, reason: g === JOB_STATUS.BLOCKED ? 'challenge_blocked' : undefined });
          detailPages += 1; timings.detailPages += 1;
          // The page as the browser finished building it (SPA blocks fill in after "load"), handed to the caller.
          if (env.onDetailPage) {
            try { if (env.page.settle) await lap('settleMs', () => env.page.settle()); } catch { /* read what is there */ }
            try { await lap('readMs', () => env.onDetailPage(target, p)); } catch (e) { log({ event: 'detail_page_error', message: String(e && e.message || e) }); }
          }
          if (action.extract) {
            const extractor = env.extractors[action.extract.using] || env.extractors.auto;
            const detail = extractor ? await extractor(ctx, action.extract) : [];
            const d = (detail && detail[0]) || {};
            // Only a page judged to BE a product may fill the listing product. A dead
            // link, or a tile that leads to a listing / non-product page (a category
            // or promo tile), is dropped — same rule as the standard engine. A
            // doubtful page fills gaps but the product is flagged "to verify".
            const pv = env.classifyPage ? env.classifyPage(ctx, d) : null;
            const kind = pv && pv.kind;
            if (kind === 'not_found' || kind === 'listing' || kind === 'non_product') {
              verdict('rejected', target, kind, pv.reasons);
              products.splice(products.indexOf(p), 1);
            } else {
              if (kind === 'uncertain') { verdict('doubtful', target, kind, pv.reasons); p._doubtful = (pv.reasons || []).map((r) => r.text); }
              // Merge detail fields into the matching listing product (fill gaps).
              for (const [k, v] of Object.entries(d)) if (p[k] == null && v != null && v !== '') p[k] = v;
            }
          }
          emit({ phase: 'detail', done: detailPages, total: targets.length });
        }
      } else if (op === 'assert') {
        if (action.min_items != null && products.length < action.min_items) {
          return fin({ status: JOB_STATUS.ERROR, products, pages, detailPages, reason: action.message || `Attendu au moins ${action.min_items} produits, obtenu ${products.length}.` });
        }
        if (action.selector) {
          const ok = await env.page.waitFor({ selector: action.selector, timeout_ms: 1 }).catch(() => false);
          if (!ok) return fin({ status: JOB_STATUS.ERROR, products, pages, detailPages, reason: action.message || `Élément requis introuvable : ${action.selector}.` });
        }
      } else if (op === 'branchOnMarker') {
        const ctx = await env.page.context();
        const hit = detectChallenge(ctx, env.challenge && env.challenge.detect || {});
        if (hit && (hit.category === action.when || action.when === 'blocked')) {
          const g = await guard(ctx);
          if (g === JOB_STATUS.STOPPED || g === JOB_STATUS.BLOCKED) return fin({ status: g, products, pages, detailPages });
        } else if (!hit && !action.else_continue) {
          // no marker and not told to continue: nothing to do
        }
      }
    } catch (e) {
      log({ event: 'action_error', op, message: String(e && e.message || e) });
      if (!(op === 'click' && action.optional)) {
        return fin({ status: JOB_STATUS.ERROR, products, pages, detailPages, reason: `Échec de l'action « ${op} » : ${String(e && e.message || e)}` });
      }
    }
  }

  return fin({ status: JOB_STATUS.DONE, products, pages: Math.max(pages, 1), detailPages });
}
