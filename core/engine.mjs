/**
 * Scraping engine orchestrator:
 *
 *   DISCOVERY → FETCH → EXTRACTION → NORMALISATION → DEDUP → ELIGIBILITY → REPORT
 *
 * It NEVER writes to a DB and NEVER decides eligibility itself: it calls the
 * configured evaluator (core/eligibility) and produces NormalizedProduct[] + a
 * report. A caller turns accepted rows into a CSV. A broken page never aborts
 * the run.
 */
import { Fetcher } from './http-fetcher.mjs';
import { isEditorialPage } from './html-meta.mjs';
import { toNormalizedProduct } from './normalize.mjs';
import { detailUnreadVerdict } from './detail-enrich.mjs';
import { detectPlatform, shopifyJsonUrl, shopifyProductToRaw } from './platform.mjs';
import { BrowserSession, browserAvailable } from './browser.mjs';
import { dedupKey, originOf, absoluteUrl } from './url-utils.mjs';
import { classifyResponse, STATUS } from './detect.mjs';
import { discoverProducts, isProductLink, scopeProductLinks } from './discover.mjs';
import { extractListing } from './listing.mjs';
import { evaluateEligibility } from './eligibility/index.mjs';
import { validate } from './validate.mjs';
import { recover } from './recovery.mjs';
import { classifyHtmlPage, mergeRules, tallyVerdict, REJECTED_KINDS, PAGE_KIND, REASON_LABEL, REASON_TEXT } from '../shared/classify/page-kind.mjs';
import { readerFor } from './content-reader.mjs';
import { fillRates, fillLine } from './fill-rate.mjs';
import { applyKnowledgeToHtml, mergeKnowledgeIntoRow, foldOutcomes } from './site-knowledge.mjs';

// Eligibility is a REPLACEABLE local layer (core/eligibility). The engine never
// decides on its own — it just calls the configured evaluator. No business rules
// live here; swap the module (or add profiles) to specialise. A caller may also
// inject its own via config.evaluateEligibility.
async function loadEligibility() { return evaluateEligibility; }

/** Concurrency pool with a cooperative stop flag (for clean early-stop on block). */
async function pool(items, worker, concurrency, shouldStop) {
  let i = 0;
  let processed = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      if (shouldStop && shouldStop()) return;
      const idx = i++;
      await worker(items[idx], idx);
      processed++;
    }
  });
  await Promise.all(runners);
  return processed;
}

const isEmptyField = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);

// Same-host product links a page exposes (structured listing cards + product-URL
// anchors). Used to tell a LISTING (a grid of product links) from a real fiche:
// generic, no site rules. A fiche's few "related products" links stay below the
// grid threshold at the call site; a category's many do not.
function listingLinks(html, baseUrl) {
  if (!html) return [];
  let host = ''; try { host = new URL(baseUrl).hostname.replace(/^www\./, ''); } catch { return []; }
  const sameHost = (u) => { try { return new URL(u).hostname.replace(/^www\./, '') === host; } catch { return false; } };
  const out = new Set();
  for (const card of extractListing(html, baseUrl).cards) { const u = card.sourceUrl; if (u && sameHost(u)) out.add(u.split('#')[0]); }
  const re = /<a\b[^>]*href=["']([^"'#\s]+)["']/gi; let m;
  while ((m = re.exec(html))) { const abs = absoluteUrl(m[1], baseUrl); if (abs && sameHost(abs) && isProductLink(abs)) out.add(abs.split('#')[0]); }
  return [...out];
}
/** Fill only the EMPTY fields of `base` from `extra` (never downgrade a good value). */
function fillGaps(base, extra) {
  if (!extra) return base;
  const out = { ...base };
  for (const k of Object.keys(extra)) if (isEmptyField(out[k]) && !isEmptyField(extra[k])) out[k] = extra[k];
  return out;
}

/**
 * @param {{
 *   store: { slug: string },
 *   origin?: string, urls?: string[],
 *   limit?: number, concurrency?: number,
 *   defaultProductType?: string|null, categorySlug?: string|null, lang?: 'fr'|'en',
 *   useBrowser?: boolean, fetcher?: Fetcher, onProgress?: (n:number,total:number)=>void,
 *   recovery?: boolean, recoveryMaxAttempts?: number, device?: 'auto'|'desktop'|'mobile',
 *   onRecovery?: (info:{url:string,ok:boolean,via:object|null,verdict:string,escalate:string,attempts:number,trace:object[]})=>void,
 *   onEscalation?: (info:{phase:string,url:string,ok:boolean,code?:string,reason:string})=>void
 * }} config
 *   onEscalation (F3): called when a recovery-driven browser escalation is
 *   attempted, with its outcome. Browser is used only as an escalation after
 *   HTTP + recovery fail, never as the default path, and never to auto-solve.
 *   recovery (default OFF): when true, a first non-usable HTTP attempt tries
 *   alternative public representations (core/recovery.mjs) before the browser
 *   lane. OFF → behaviour is byte-identical to before this option existed.
 */
export async function runScrape(config) {
  if (!config?.store) throw new Error('runScrape: config.store is required (may have an empty slug for unassigned scrapes)');
  const started = Date.now();
  const fetcher = config.fetcher || new Fetcher({ minDelayMs: 600 });
  const limit = config.limit ?? 1000;
  const concurrency = Math.min(config.concurrency ?? 4, 8);
  // The content type's reader (core/content-reader.mjs): how a page is read and
  // judged, which links are items, which rule accepts a row. Products by default.
  const reader = readerFor(config.contentType);
  const isEligible = config.evaluateEligibility || reader.eligibility || await loadEligibility();

  const report = {
    store: config.store.slug,
    contentType: { type: reader.id, requested: config.contentTypeRequested || reader.id, detected: config.contentTypeDetected || null },
    status: STATUS.OK, // final source status
    discovered: 0, fetched: 0, detected: 0, normalized: 0,
    incomplete: 0, accepted: 0, excluded: 0, toVerify: 0,
    networkErrors: 0, parseErrors: 0, browserRequired: 0, duplicates: 0, denied: 0,
    notAProductPage: 0,
    byStatus: {}, // counts per detected status code
    byStrategy: {}, // counts per extraction strategy that produced a product (jsonld/embedded/dom/shopify/…)
    blocked: null, // { code, reason, url } when the source was stopped
    remaining: 0, resumeUrls: [], // for resuming later
    sitemapsRead: [], notes: [], errors: [], startedAt: new Date(started).toISOString(),
  };
  const bump = (code) => { report.byStatus[code] = (report.byStatus[code] || 0) + 1; };
  // Image addresses rejected and product addresses corrected during normalisation (report.images / report.urls).
  const imageDiag = { rejectedImages: [], urlsCorrected: 0, urlSamples: [] };
  // Shared "is this a product page?" rules (shared/classify) — config-overridable.
  const pageRules = mergeRules(config.pageRules);
  // Record WHY a page was rejected / kept as doubtful (report.json: reasons + samples).
  const recordPageVerdict = (bucket, url, v) => {
    report.pageVerdicts = report.pageVerdicts || {};
    report.pageVerdicts[bucket] = tallyVerdict(report.pageVerdicts[bucket], { url, kind: v.kind, reasons: v.reasons });
  };
  const pageReason = (kind, code, detail = null) => ({ kind, reasons: [{ code, detail, text: REASON_TEXT[code](detail) }] });

  // ── DISCOVERY ──────────────────────────────────────────────────────────
  let urls = [];
  let seeds = new Map(); // dedupKey(url) → listing card (partial RawProduct) for enrichment
  const listingCards = Array.isArray(config.cardsWithoutUrl) ? config.cardsWithoutUrl : [];
  if (config.urls && (config.urls.length || listingCards.length)) {
    urls = config.urls;
    // Seeds from a SEPARATE discovery pass (the GUI runs discover then runScrape):
    // complete listing cards (name/price/gtin/image) so a fiche that yields nothing
    // (SPA shell) still delivers the product from its seed — never a silent drop.
    if (config.seeds instanceof Map) seeds = config.seeds;
    report.notes.push(`discovery: ${urls.length} URL(s) provided${config.seeds instanceof Map ? ` (+${config.seeds.size} seeds)` : ''}`);
  } else if (config.origin) {
    // Automatic discovery: sitemap → categories/listings → pagination → products.
    const disc = await discoverProducts(fetcher, config.origin, {
      maxProducts: limit, maxPages: config.maxPages, maxDepth: config.maxDepth,
      // F2 → discovery (opt-in; OFF → unchanged): let a blocked catalogue fetch
      // try alternative representations before giving up.
      recovery: config.recovery, recoveryMaxAttempts: config.recoveryMaxAttempts,
      device: config.device, onRecovery: config.onRecovery,
      // Collection scoping (learned link_filter recipe + scope-to-collection flag).
      linkFilter: config.linkFilter, scopeToCollection: config.scopeToCollection,
      contentType: reader.id,
    });
    urls = disc.urls;
    seeds = disc.seeds || seeds;
    report.discovery = disc.report;
    report.discoveryDiagnosis = disc.report.diagnosis || null;
    report.notes.push(`discovery: ${disc.report.method} — ${disc.report.pagesCrawled} pages crawled, ${disc.report.productUrls} product URLs`, ...disc.report.notes);
    // When discovery finds nothing, say WHY in the user's terms rather than a bare
    // "0 product URLs" — the honest failure class (blocked / needs a browser /
    // data present but not extracted / genuinely no signal), so a "none found" is
    // never mistaken for one of the others.
    if (disc.report.productUrls === 0 && disc.report.diagnosis && disc.report.diagnosis !== 'ok') {
      report.notes.push(`no product URLs discovered — reason: ${disc.report.diagnosis}${disc.report.diagnosisReason ? ` (${disc.report.diagnosisReason})` : ''}`);
    }
    if (disc.report.stopped) { report.status = disc.report.stopped.code; report.blocked = disc.report.stopped; }
  } else {
    throw new Error('runScrape: provide config.urls or config.origin');
  }

  // Dedup discovery by canonical key, cap at limit.
  const seenKeys = new Set();
  const unique = [];
  for (const u of urls) {
    const k = dedupKey(u);
    if (seenKeys.has(k)) { report.duplicates++; continue; }
    seenKeys.add(k); unique.push(u);
    if (unique.length >= limit) break;
  }
  report.discovered = unique.length;

  // ── FETCH → EXTRACT → NORMALISE → ELIGIBILITY ──────────────────────────
  const products = [];
  const outKeys = new Set();
  let done = 0;
  let stop = null; // set to { code, reason, url } on a terminal block → stop source cleanly
  // Circuit breaker: if requests keep failing (connection resets, repeated
  // challenges) and nothing succeeds, stop instead of hammering the source.
  const breaker = Math.max(3, config.breaker ?? 6);
  let consecFail = 0; let lastFailCode = null;
  // A refusal (403…) of ONE address is that page's: skipped, reported, the run goes
  // on. Only `deniedStreak` refusals in a row mean the site refuses the run.
  const deniedStreak = Math.max(1, Number(config.deniedStreak) || 3);
  let consecDenied = 0; let lastDenied = null;

  // Browser fallback: HTTP-first. Use Playwright only for CSR pages, capped.
  // Auto-on when Playwright is installed unless explicitly disabled. A session
  // can be injected (config.browserSession) for testing.
  const injectedSession = config.browserSession || null;
  const sessionFactory = config.getBrowserSession || null; // shared with discovery
  const wantBrowser = config.useBrowser !== false && (!!injectedSession || !!sessionFactory || await browserAvailable());
  const maxBrowser = config.maxBrowser ?? 40;
  let browserUsed = 0;
  let session = null;
  const acquireSession = async () => {
    if (session) return session;
    if (injectedSession) { session = injectedSession; return session; }
    if (sessionFactory) { session = await sessionFactory(); return session; } // may be null
    session = new BrowserSession({ userAgent: fetcher.userAgent });
    return session;
  };
  // 4d — a hard per-page render budget. render() already bounds its own goto/reload,
  // but a single stubborn page (an anti-bot that stalls a wait/evaluate) must never
  // hold the whole run: a wall-clock race caps EACH render so the pool moves on and
  // the page is simply counted as browser-unrenderable. Configurable via Settings
  // (renderTimeoutMs); defaults from the run timeout. Generic — a time bound, not a
  // site rule.
  // An explicit renderTimeoutMs is honoured as-is (min 200ms — lets a test pin a
  // tiny budget); otherwise the auto default keeps a safe 15s floor so a normal
  // render is never cut short.
  const renderBudgetMs = Number.isFinite(Number(config.renderTimeoutMs)) && Number(config.renderTimeoutMs) > 0
    ? Math.max(200, Number(config.renderTimeoutMs))
    : Math.max(15000, (Number(config.timeoutMs) || 30000) + 12000);
  const renderBounded = async (s, url) => {
    let timer;
    const cap = new Promise((resolve) => { timer = setTimeout(() => resolve({ html: null, status: 0, error: 'render budget exceeded', block: null, __timedOut: true }), renderBudgetMs); });
    try { return await Promise.race([s.render(url, { timeoutMs: Math.min(Math.max(renderBudgetMs - 3000, 1000), 30000) }), cap]); }
    finally { clearTimeout(timer); }
  };
  report.playwrightAvailable = !!injectedSession || !!sessionFactory || await browserAvailable();

  // One admission path for every row (a fetched page, a card without a link, a
  // listed item kept from its card): normalisation, dedup by identity, the content
  // type's acceptance rule, the counters, the delivery. Returns null for a duplicate.
  const admit = (raw, { url = null, pageDoubt = null, keyFallback = null } = {}) => {
    report.detected++;
    if (raw.strategy) report.byStrategy[raw.strategy] = (report.byStrategy[raw.strategy] || 0) + 1;
    const np = toNormalizedProduct(raw, {
      storeSlug: config.store.slug,
      defaultProductType: config.defaultProductType ?? null, categorySlug: config.categorySlug ?? null,
      diag: imageDiag,
    });
    // Dedup by strongest identity (source_product_id) then URL key — never by title.
    const idKey = np.source_product_id ? `id:${np.source_product_id}` : (keyFallback ? keyFallback(np) : `url:${dedupKey(np.source_url || url)}`);
    if (outKeys.has(idKey)) { report.duplicates++; return null; }
    outKeys.add(idKey);
    if (reader.incomplete(np)) report.incomplete++;
    report.normalized++;
    let verdict = isEligible(np);
    // A doubtful page never ends "accepted": to verify, with the page's reason.
    if (pageDoubt && verdict.status !== 'excluded') {
      verdict = { ...verdict, status: 'to_verify', code: 'to_verify_page_doubtful', reason: pageDoubt.reasons.map((x) => x.text).join(' ; ') };
    }
    // A row whose own product page failed and that still lacks what the page gives is "to verify", with the list.
    if (verdict.status === 'accepted') { const dv = detailUnreadVerdict(raw, np); if (dv) verdict = { ...verdict, ...dv }; }
    np.__eligibility = verdict; // attach for the caller/preview (not a DB field)
    if (verdict.status === 'accepted') report.accepted++;
    else if (verdict.status === 'excluded') report.excluded++;
    else report.toVerify++;
    products.push(np);
    config.onProduct?.(np);
    return np;
  };
  // Sample first (readers whose listed cards already carry the item — videos): the
  // first `detailSample` seeded pages are visited; when none adds anything to its
  // card, the remaining seeded URLs are delivered from their cards, without a request.
  const sampleN = Math.max(1, Number(config.detailSample) || 3);
  const sample = { candidates: 0, visited: 0, completed: 0, unchanged: 0, skipped: 0 };
  let sampleStop = false;
  const SAMPLE_FIELDS = ['description', 'images', 'category', 'breadcrumb', 'rating', 'reviewCount'];
  const noteSample = (raw, seed) => {
    sample.visited++;
    const cols = (o) => Object.keys((o && o.columns) || {});
    const gained = SAMPLE_FIELDS.some((k) => isEmptyField(seed[k]) && !isEmptyField(raw[k])) || cols(raw).some((k) => !cols(seed).includes(k));
    if (gained) sample.completed++; else sample.unchanged++;
    if (sample.visited >= sampleN && sample.completed === 0) sampleStop = true;
  };
  if (reader.sampleFirst) sample.candidates = unique.filter((u) => seeds.has(dedupKey(u))).length;

  const processed = await pool(unique, async (url) => {
   try {
    // Cooperative pause/stop for a GUI caller (opt-in via config.control).
    // No control passed (CLI, tests) → these are no-ops.
    if (config.control) {
      if (config.control.waitIfPaused) await config.control.waitIfPaused();
      if (config.control.stopped) return;
    }
    // Sample first: the first pages added nothing to their cards → this row comes
    // from its card, without a request.
    const seedAtStart = reader.sampleFirst && sampleStop ? seeds.get(dedupKey(url)) : null;
    if (seedAtStart) {
      done++; if (config.onProgress) config.onProgress(done, unique.length);
      sample.skipped++;
      admit({ ...seedAtStart }, { url });
      return;
    }
    const r = await fetcher.get(url);
    done++; if (config.onProgress) config.onProgress(done, unique.length);

    // Classify BEFORE trusting the body as a product. A challenge/captcha page
    // is never treated as content; a terminal block stops the whole source.
    const { product: preProduct, needsBrowser: nb } = r.ok ? reader.extract(r.body, r.url) : { product: null, needsBrowser: false };
    // What a recovered representation yields, read with THIS content type's reader
    // (the recovery ladder itself validates with the product extractor).
    const recoveredRaw = (rec) => {
      if (!rec || !rec.ok) return null;
      if (reader.id === 'product') return rec.product || null;
      const res = rec.result;
      return res && res.body ? reader.extract(res.body, res.url || url).product : null;
    };
    const resp = classifyResponse({ status: r.status, url: r.url, requestedUrl: r.requestedUrl || url, body: r.body, error: r.error, headers: r.headers, needsBrowser: nb });
    bump(resp.code);

    // `raw` is hoisted so a terminal-response recovery (below) can seed it and
    // fall through into the SAME pipeline, rather than a parallel one.
    let raw = null;
    // F3 (opt-in): set when HTTP recovery is exhausted but the ladder judges a
    // browser could plausibly help (JS render / challenge). It only escalates —
    // never bypasses — and is derived from recovery, so OFF → always false.
    let escalateBrowser = false;
    let renderedUrl = false; // guards against rendering the same URL twice
    // Where `raw` came from — the page the verdict is taken on (HTTP body by
    // default; a recovered representation or a browser render replaces it).
    let pageHtml = r.body || ''; let pageStatus = r.status; let pageUrl = r.url || url;
    const adoptRecovered = (rec) => { if (rec.result) { pageHtml = rec.result.body || pageHtml; pageStatus = rec.result.status; pageUrl = rec.result.url || pageUrl; } };

    if (resp.terminal) {
      // F2 (opt-in): before giving up on a terminal response (Access Denied /
      // challenge / rate-limited), try alternative PUBLIC representations of the
      // SAME resource. This is NOT a bypass — it fetches a different public URL
      // that may simply not be gated. Flag OFF → skipped → behaviour identical.
      if (config.recovery && !stop) {
        const fv = validate(r, { product: null, needsBrowser: nb });
        const rec = await recover({
          url, fetcher, original: { result: r, verdict: fv },
          device: config.device || 'auto', maxAttempts: config.recoveryMaxAttempts ?? 4,
        });
        config.onRecovery?.({ url, ok: rec.ok, via: rec.via, verdict: rec.verdict, escalate: rec.escalate, attempts: rec.attempts, trace: rec.trace });
        const recRaw = recoveredRaw(rec);
        if (recRaw) { raw = recRaw; report.recovered = (report.recovered || 0) + 1; adoptRecovered(rec); }
        else if (rec.escalate === 'browser') escalateBrowser = true; // F3: HTTP exhausted → a browser may help
      }
      if (!raw) {
        // Interactive + browser available → let the browser handle it so a human
        // can solve the challenge/login manually (no automatic bypass). Otherwise
        // stop safely, keeping what we have and not hammering the source.
        const canIntervene = wantBrowser && config.interactive && browserUsed < maxBrowser && !stop;
        // F3: recovery may recommend an AUTOMATIC (non-interactive) browser
        // escalation. It still never auto-solves — if the browser is blocked too,
        // the run stops cleanly below.
        const canEscalate = wantBrowser && escalateBrowser && browserUsed < maxBrowser && !stop;
        if (!canIntervene && !canEscalate) {
          if (resp.code === STATUS.ACCESS_DENIED) lastDenied = { code: resp.code, reason: resp.reason, url, retryAfter: resp.retryAfter };
          if (resp.code === STATUS.ACCESS_DENIED && ++consecDenied < deniedStreak) {
            report.denied++;
            if (report.errors.length < 50) report.errors.push(`${url} → ${resp.reason} (page skipped)`);
            return;
          }
          if (resp.code === STATUS.ACCESS_DENIED) report.denied++;
          if (!stop) stop = { code: resp.code, reason: resp.code === STATUS.ACCESS_DENIED && deniedStreak > 1 ? `${resp.reason} on ${consecDenied} pages in a row` : resp.reason, url, retryAfter: resp.retryAfter };
          return;
        }
        // else fall through to the browser block below.
      }
      // recovered (raw set) → fall through to the common pipeline below.
    } else
    if (resp.code === STATUS.NETWORK_ERROR) {
      report.networkErrors++;
      lastFailCode = STATUS.NETWORK_ERROR;
      if (report.errors.length < 50) report.errors.push(`${url} → ${resp.reason}`);
      // Circuit breaker: many consecutive failures with zero successes → stop.
      if (++consecFail >= breaker && report.fetched === 0 && !stop) {
        stop = { code: lastFailCode, reason: `circuit breaker: ${consecFail} consecutive failures, source unreachable or blocking`, url, retryAfter: null };
      }
      return;
    }
    consecFail = 0; consecDenied = 0; // a real page came back → reset the breakers
    report.fetched++;

    // Platform-native structured data first (optimisation, not a dependency).
    if (!raw && reader.platformFeeds && detectPlatform(r.body) === 'shopify') {
      const jsonUrl = shopifyJsonUrl(r.url);
      if (jsonUrl) {
        const jr = await fetcher.get(jsonUrl, { accept: 'application/json' });
        if (jr.ok && jr.kind === 'json') { try { raw = shopifyProductToRaw(JSON.parse(jr.body), r.url); } catch { /* fall through */ } }
      }
    }
    if (!raw) {
      raw = preProduct;
      // ── F2 recovery ladder (opt-in via config.recovery; OFF → this whole block
      //    is skipped, so behaviour stays byte-identical). Runs ONLY when the first
      //    attempt is NOT a usable product; tries alternative PUBLIC representations
      //    over HTTP (with a product-identity re-check) and hands a usable/incomplete
      //    product to the SAME pipeline below. It never launches a browser itself —
      //    a failure a browser could fix leaves `raw` null so the existing browser
      //    block runs unchanged. Terminal responses were already offered recovery
      //    in the terminal branch above, so they are excluded here (no double try).
      if (config.recovery && !stop && !resp.terminal) {
        const fv = validate(r, { product: reader.id === 'product' ? raw : null, needsBrowser: nb });
        const usableNow = reader.id === 'product' ? fv.usable : reader.usable(raw);
        if (!usableNow) {
          const rec = await recover({
            url, fetcher, original: { result: r, verdict: fv },
            device: config.device || 'auto', maxAttempts: config.recoveryMaxAttempts ?? 4,
          });
          config.onRecovery?.({ url, ok: rec.ok, via: rec.via, verdict: rec.verdict, escalate: rec.escalate, attempts: rec.attempts, trace: rec.trace });
          const recRaw = recoveredRaw(rec);
          if (recRaw) { raw = recRaw; report.recovered = (report.recovered || 0) + 1; adoptRecovered(rec); }
          else if (rec.escalate === 'browser') escalateBrowser = true; // F3: HTTP exhausted → a browser may help
        }
      }
      if (!raw && (nb || resp.code === STATUS.JAVASCRIPT_REQUIRED || resp.terminal || escalateBrowser)) {
        report.browserRequired++;
        const s = (wantBrowser && browserUsed < maxBrowser && !stop) ? await acquireSession() : null;
        if (s) {
          browserUsed++;
          const rendered = await renderBounded(s, url);
          renderedUrl = true;
          if (rendered.__timedOut) report.renderTimeouts = (report.renderTimeouts || 0) + 1;
          if (rendered.block && rendered.block.terminal) {
            // Protection detected under the browser too → stop cleanly, no bypass.
            if (!stop) stop = { code: rendered.block.code, reason: `${rendered.block.reason} (under browser)`, url, retryAfter: rendered.block.retryAfter };
            config.onEscalation?.({ phase: 'extraction', url, ok: false, code: rendered.block.code, reason: `${rendered.block.reason} (under browser)` });
            return;
          }
          if (rendered.html) { raw = reader.extract(rendered.html, r.url).product; if (raw) { pageHtml = rendered.html; if (rendered.status) pageStatus = rendered.status; } }
          // Browser→HTTP handoff: reuse the session cookies just obtained so the
          // rest of the run can fetch over cheap HTTP (no-op if no jar).
          try { if (fetcher.jar && typeof s.cookies === 'function') fetcher.jar.setFromBrowser(await s.cookies()); } catch { /* ignore */ }
          if (escalateBrowser) {
            // F3 trace: outcome of a recovery-driven browser escalation.
            config.onEscalation?.({ phase: 'extraction', url, ok: !!raw, reason: raw ? 'rendered a usable page' : (rendered.error || 'no product after render') });
            if (!raw && rendered.error && report.errors.length < 50) report.errors.push(`${url} → browser escalation: ${rendered.error}`);
          }
        } else if (!report.playwrightAvailable && !report._pwNoted) {
          report._pwNoted = true;
          report.notes.push('some pages require JavaScript; install Playwright to render them (pnpm add -D playwright && npx playwright install chromium)');
        }
      }
    }
    // Listing → fiche enrichment: fill the gaps the fiche left with the listing
    // card (the fiche keeps priority — never overwrite a reliable value), or use
    // the card itself as the product when the fiche gave nothing usable.
    const seed = seeds.get(dedupKey(url));
    let seedOnly = false; // product built from its listing card alone (the fiche gave nothing)
    if (seed) {
      if (raw) {
        const changed = Object.keys(seed).some((k) => isEmptyField(raw[k]) && !isEmptyField(seed[k]));
        raw = fillGaps(raw, seed);
        if (changed) report.enriched = (report.enriched || 0) + 1;
      } else { raw = { ...seed }; seedOnly = true; }
    }
    // The product page as read (the caller keeps a few: a site's first discovery and a rule's repair are
    // checked on the pages the run already read, without asking the site again).
    if (reader.id === 'product' && raw && !seedOnly && pageHtml) { try { config.onProductPage?.(pageUrl, pageHtml); } catch { /* never breaks a run */ } }
    // SITE KNOWLEDGE: what the site taught (🎯 / detection) read on this product page — a general manual
    // rule overrides the generic read, any other rule only fills a gap; its outcome is counted.
    if (config.knowledge && reader.id === 'product' && raw && !seedOnly && pageHtml) {
      const ap = applyKnowledgeToHtml(pageHtml, config.knowledge, { name: raw.name || '', url: pageUrl });
      if (ap) {
        const kr = report.knowledge || (report.knowledge = { rules: {}, fields: {} });
        foldOutcomes(kr.rules, ap);
        for (const f of mergeKnowledgeIntoRow(raw, ap)) kr.fields[f] = (kr.fields[f] || 0) + 1;
      }
    }

    // Harvest a listing page's product links into the queue (bounded by `limit`
    // + `seenKeys`; collection scoping = same graduated fail-open as discovery).
    const harvestListing = (body, baseUrl) => {
      let links = reader.itemLinks ? reader.itemLinks(body, baseUrl) : listingLinks(body, baseUrl);
      if (reader.itemLinks) {
        let host = ''; try { host = new URL(baseUrl).hostname.replace(/^www\./, ''); } catch { host = ''; }
        links = links.filter((u) => { try { return new URL(u).hostname.replace(/^www\./, '') === host; } catch { return false; } });
      }
      // A product listing is a grid of at least 6 links; another content type lists from 3.
      if (links.length < (reader.id === 'product' ? 6 : 3)) return { links: links.length, added: 0 };
      // Collection scoping is a product-grid notion; another content type keeps every link.
      const scoped = reader.id === 'product' ? scopeProductLinks(body, baseUrl, links, { linkFilter: config.linkFilter, report }) : { keep: null };
      let added = 0;
      for (const link of links) { const k = dedupKey(link); if (scoped.keep && !scoped.keep.has(k)) continue; if (seenKeys.has(k) || unique.length >= limit) continue; seenKeys.add(k); unique.push(link); added++; }
      report.reclassifiedListings = (report.reclassifiedListings || 0) + 1;
      if (added) report.harvestedLinks = (report.harvestedLinks || 0) + added;
      return { links: links.length, added };
    };

    // 4a — a page with NO price, NO sku, NO gtin is not a product. When it exposes
    // a GRID of same-host product links it is a LISTING → harvest those links into
    // the queue and drop the page (this also avoids a wasted browser render on it,
    // 4d). A page with few/no product links is KEPT (a genuine on-request / "sur
    // devis" product with no displayed price stays 'to_verify', never dropped).
    // Generic: no site rules; the grid threshold separates a fiche's few related
    // links from a category's many. Bounded by `limit` + `seenKeys` — no runaway.
    if (raw && reader.thin(raw)) {
      // The ≥6 reclassification threshold stays unscoped (see harvestListing).
      const h = harvestListing(r.body, r.url);
      if (h.links >= 6) { recordPageVerdict('rejected', url, pageReason(PAGE_KIND.LISTING, 'listing_links', h.links)); return; } // link source, not a product
    }

    // 4a-bis (defense-in-depth) — an editorial page (blog / guide / FAQ / news)
    // can carry a stray price from a related-product widget and pass as a product
    // (the tournesols "Gazon et pelouse…" leak). Drop it UNLESS it has hard product
    // identity (gtin/sku) or declares Product schema (isEditorialPage guards that).
    // Not gated on a grid — a listing was already harvested above.
    if (raw && reader.dropEditorial && !raw.gtin && !raw.sku && isEditorialPage(r.body)) {
      report.notAProductPage++;
      report.editorialDropped = (report.editorialDropped || 0) + 1;
      const d = (report.dropped = report.dropped || { notAProductPage: 0, parseErrors: 0, samples: [] });
      d.notAProductPage += 1;
      if (d.samples.length < 10) d.samples.push(url);
      recordPageVerdict('rejected', url, pageReason(PAGE_KIND.NON_PRODUCT, 'editorial_page'));
      return; // editorial page, not a product
    }

    // Complete an INCOMPLETE HTTP product (a name but no price) by rendering the
    // page once — price/description are often client-rendered (CSR). Opt-in via
    // config.recovery, bounded by maxBrowser, at most one render/URL, and it only
    // FILLS gaps (never downgrades, never invents). A block under the browser is
    // recorded but does not stop the whole source for one incomplete product.
    if (raw && reader.completable(raw) && config.recovery && !renderedUrl
        && wantBrowser && browserUsed < maxBrowser && !stop) {
      const s = await acquireSession();
      if (s) {
        browserUsed++;
        const rendered = await renderBounded(s, url);
        renderedUrl = true;
        if (rendered.__timedOut) report.renderTimeouts = (report.renderTimeouts || 0) + 1;
        if (rendered.block && rendered.block.terminal) {
          config.onEscalation?.({ phase: 'extraction', url, ok: false, code: rendered.block.code, reason: `${rendered.block.reason} (under browser, incomplete)` });
        } else if (rendered.html) {
          const r2 = reader.extract(rendered.html, r.url).product;
          if (r2) { raw = fillGaps(raw, r2); const still = reader.completable(raw); config.onEscalation?.({ phase: 'extraction', url, ok: !still, reason: !still ? 'completed via browser render' : 'still incomplete after render' }); }
          try { if (fetcher.jar && typeof s.cookies === 'function') fetcher.jar.setFromBrowser(await s.cookies()); } catch { /* ignore */ }
        }
      }
    }
    // 4e — shared page verdict (shared/classify/page-kind.mjs, same rules as the
    // extension tier). A dead page, a listing or a non-product page never becomes a
    // product; a doubtful one is kept but forced to "to verify" with its reason.
    // Taken on the page `raw` came from. A product built from its listing card
    // alone is card evidence from the listing (existing contract: a card survives
    // a missing fiche) — not re-judged on the fiche it failed to get.
    let pageDoubt = null;
    if (raw && !seedOnly) {
      const v = reader.classify(pageHtml, { url: pageUrl, status: pageStatus, extracted: raw, rules: pageRules });
      if (v && REJECTED_KINDS.includes(v.kind)) {
        if (v.kind === PAGE_KIND.LISTING) harvestListing(pageHtml, pageUrl);
        report.notAProductPage++;
        const d = (report.dropped = report.dropped || { notAProductPage: 0, parseErrors: 0, samples: [] });
        d.notAProductPage += 1;
        if (d.samples.length < 10) d.samples.push(url);
        recordPageVerdict('rejected', url, v);
        return;
      }
      if (v && v.kind === PAGE_KIND.UNCERTAIN) { pageDoubt = v; recordPageVerdict('doubtful', url, v); }
    }

    if (!raw) {
      // A content type whose pages are read by their own signals (videos): a page
      // without an item of its own that LISTS items is a listing → harvest its links.
      if (reader.itemLinks && resp.code === STATUS.OK && pageHtml) {
        const h = harvestListing(pageHtml, pageUrl);
        if (h.links >= 3) { recordPageVerdict('rejected', url, pageReason(PAGE_KIND.LISTING, 'video_listing', h.links)); return; }
      }
      // A dead URL (404/410) is a missing page, not a parse error — say so.
      if (resp.code === STATUS.NOT_FOUND) {
        report.notAProductPage++;
        const d = (report.dropped = report.dropped || { notAProductPage: 0, parseErrors: 0, samples: [] });
        d.notAProductPage += 1;
        if (d.samples.length < 10) d.samples.push(url);
        recordPageVerdict('rejected', url, classifyHtmlPage('', { url, status: r.status === 410 ? 410 : 404, rules: pageRules }));
        return;
      }
      // R2 visibility: a URL dropped without a product is counted AND sampled in
      // the report (never thrown away in silence). Report/logs only, never the UI.
      const kind = resp.code === STATUS.OK ? 'notAProductPage' : 'parseErrors';
      if (kind === 'notAProductPage') report.notAProductPage++; else report.parseErrors++;
      const d = (report.dropped = report.dropped || { notAProductPage: 0, parseErrors: 0, samples: [] });
      d[kind] += 1;
      if (d.samples.length < 10) d.samples.push(url);
      return;
    }
    const np = admit(raw, { url, pageDoubt });
    if (np && reader.sampleFirst && seed && !seedOnly) noteSample(raw, seed);
   } finally {
    // Mark URL handled (for resume) regardless of outcome. A URL that stopped
    // the source is NOT marked processed, so resume retries it.
    if ((!stop || stop.url !== url) && !(config.control && config.control.stopped)) config.onProcessed?.(url);
   }
  }, concurrency, () => stop !== null || !!(config.control && config.control.stopped));

  // Cards read from the listing itself, with a price and an id but no page of their
  // own (the listing's data names the entity; nothing to fetch): the same
  // normalisation, dedup and eligibility as a fetched page, without a request. A
  // fetched page of the same id (above) wins over its card.
  let listedOnly = 0;
  for (const card of listingCards) {
    if (!card || card.price == null || !(card.sku || card.gtin)) continue;
    if (stop || (config.control && config.control.stopped)) break;
    const np = admit({ ...card }, { keyFallback: (p) => `name:${(p.name || '').toLowerCase()}` });
    if (np) listedOnly++;
  }
  if (reader.sampleFirst && sample.candidates) {
    report.detailPages = { listed: sample.candidates, candidates: sample.candidates, visited: sample.visited, completed: sample.completed, unchanged: sample.unchanged, failed: 0, skipped: sample.skipped, reasons: sample.skipped ? { sample_no_data: sample.skipped } : {}, stoppedEarly: sampleStop ? 'sample_no_data' : null };
    if (sampleStop) report.notes.push(`sample first: the first ${sample.visited} page(s) added nothing to their listed cards — ${sample.skipped} item(s) delivered from the list without a request`);
  }
  if (listedOnly) { report.listedOnly = listedOnly; report.notes.push(`${listedOnly} product(s) read from the listing page itself (a card with an id and a price, no page link)`); }

  // Close only a session we created ourselves (injected/factory sessions are
  // owned by the caller, e.g. the CLI reuses one across discovery + extraction).
  if (session && !injectedSession && !sessionFactory) { await session.close(); }
  report.browserUsed = browserUsed;

  // One job-log line per RUN (not per URL) for the dropped/scoped counters —
  // details + samples stay in the report, nothing new reaches the renderer.
  if (report.dropped && (report.dropped.notAProductPage || report.dropped.parseErrors)) {
    report.notes.push(`dropped without product: ${report.dropped.notAProductPage} not-a-product page(s), ${report.dropped.parseErrors} parse error(s) — samples in report.dropped`);
  }
  if (report.scopedOut) report.notes.push(`collection scope: ${report.scopedOut} off-grid link(s) skipped (samples in report.scopedOutSamples)`);

  // GUI Stop button: user asked to stop (no protection block). Resumable.
  if (config.control && config.control.stopped && !stop) {
    report.status = 'STOPPED_BY_USER';
    report.remaining = Math.max(0, unique.length - processed);
    report.resumeUrls = unique.slice(processed, processed + 2000);
    report.notes.push('stopped by user (resumable). No bypass attempted.');
  }

  // Every page refused and none read: the source refused the run (diagnosed, never a
  // silent empty result), even when the streak was never reached.
  if (!stop && lastDenied && report.fetched === 0) stop = { ...lastDenied, reason: `${lastDenied.reason} on every page read` };
  if (stop) {
    report.status = stop.code;
    report.blocked = stop;
    report.remaining = Math.max(0, unique.length - processed);
    // Resume list = URLs not yet processed (cap the stored list to keep the report small).
    report.resumeUrls = unique.slice(processed, processed + 2000);
    report.notes.push(`source stopped safely: ${stop.code} (${stop.reason}). No bypass attempted.`);
    if (stop.retryAfter) report.notes.push(`server asked to retry after ~${stop.retryAfter}s`);
  }

  report.durationMs = Date.now() - started;
  report.fetchStats = fetcher.stats;
  attachDiagnostics(report, imageDiag);
  applyPartialStatus(report);
  return { products, report };
}

/**
 * The normalisation diagnostics on a report: image addresses rejected (with their reason) and product
 * addresses corrected (tracking parameters dropped, canonical taken). Nothing is hidden: a rejected
 * address is listed, never exported silently.
 * @param {object} report  @param {{rejectedImages:Array, urlsCorrected:number, urlSamples?:Array}} diag
 */
export function attachDiagnostics(report, diag) {
  if (!report || !diag) return report;
  const rejected = Array.isArray(diag.rejectedImages) ? diag.rejectedImages : [];
  const byReason = {}; for (const r of rejected) byReason[r.reason] = (byReason[r.reason] || 0) + 1;
  report.images = { rejected: rejected.length, byReason, samples: rejected.slice(0, 25) };
  report.urls = { corrected: Number(diag.urlsCorrected) || 0, samples: (diag.urlSamples || []).slice(0, 10) };
  // Values read as SKU that are labels / phrases / option names: removed (the SKU stays empty) and listed here.
  const skus = Array.isArray(diag.rejectedSkus) ? diag.rejectedSkus : [];
  const skuReasons = {}; for (const r of skus) skuReasons[r.reason] = (skuReasons[r.reason] || 0) + 1;
  report.skus = { rejected: skus.length, byReason: skuReasons, samples: skus.slice(0, 25) };
  return report;
}

/**
 * An honest final status: a run that ended but left something unread is PARTIAL — never "OK":
 *   - rows to verify;
 *   - product pages that failed or were skipped (a visit cap, a stop), except "the sample showed the pages
 *     add nothing";
 *   - the app's browser stopped re-reading product pages (`browserPagesStop`: a human check, its budget);
 *   - product pages the extension did not read for this job (`yourBrowserPages`: blocked, never opened);
 *   - a site rule that failed on the product pages this run read (`knowledgeInvalidated`);
 *   - a list read in the user's browser that ended short of the total it announced (`pagination`, your-browser).
 * A stopped / blocked run keeps its own code.
 */
export function applyPartialStatus(report) {
  if (!report || !/^(OK|ok)$/.test(String(report.status || ''))) return report;
  const d = report.detailPages || null;
  const reasons = (d && d.reasons) || {};
  // Pages that failed, plus pages skipped for a reason other than "the sample showed the pages add nothing".
  const unread = d ? (Number(d.failed) || 0) + Math.max(0, (Number(d.skipped) || 0) - (Number(reasons.sample_no_data) || 0)) : 0;
  const ext = report.yourBrowserPages || null;
  const extUnread = ext ? (Number(ext.blocked) || 0) + (Number(ext.notOpened) || 0) : 0;
  const browserStop = report.browserPagesStop || null;
  const rules = Array.isArray(report.knowledgeInvalidated) ? report.knowledgeInvalidated.map((r) => r && r.field).filter(Boolean) : [];
  // A list read in the user's browser that ended short of the total it announced, for no limit the user set.
  const pg = report.pagination || null;
  const listShort = !!(pg && pg.mechanism === 'your-browser' && Array.isArray(pg.warnings) && pg.warnings.includes('total_not_reached'));
  const incomplete = (Number(report.toVerify) || 0) > 0 || unread > 0 || extUnread > 0 || !!browserStop || rules.length > 0 || listShort;
  if (incomplete) {
    report.status = 'PARTIAL';
    report.partial = {
      toVerify: Number(report.toVerify) || 0, pagesUnread: unread,
      ...(extUnread ? { extensionPagesUnread: extUnread } : {}),
      ...(browserStop ? { browserStop, browserNotReread: Number(report.browserPagesNotRead) || 0 } : {}),
      ...(rules.length ? { rulesInvalidated: rules } : {}),
      ...(listShort ? { listShort: { announced: pg.totalAnnounced, read: pg.read != null ? pg.read : null } } : {}),
      ...(d && d.reasons ? { reasons: d.reasons } : {}),
    };
  }
  return report;
}

/** Compact human byte size (B/KB/MB) for reports. */
export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / (1024 * 1024)).toFixed(2)} MB`;
}

/** Human-readable SCRAPE REPORT block. */
/** " — raisons : page d’erreur « introuvable » ×1, grille de prix ×2" (empty when none). */
function verdictBreakdown(bag) {
  if (!bag || !bag.byReason) return '';
  const parts = Object.entries(bag.byReason).map(([code, n]) => `${REASON_LABEL[code] || code} ×${n}`);
  return parts.length ? ` — raisons : ${parts.join(', ')}` : '';
}

// A reader's id as a person reads it on the « products read by » line.
const STRATEGY_LABEL = { 'your-browser': 'your browser (extension)' };

const secs = (ms) => `${((Number(ms) || 0) / 1000).toFixed(1)} s`;
/**
 * Where a run's time went (report.timings): the extension's own steps when it read the pages, then the app's
 * steps. « pacing wait » is the spacing kept between two pages of one site.
 */
export function timingsLine(t) {
  if (!t) return '';
  const parts = [];
  const e = t.extension;
  if (e) parts.push(`extension ${secs(e.totalMs)}: list ${secs(e.listMs)}, pacing wait ${secs(e.pacingMs)}, page loads ${secs(e.loadMs)}, human-check guard ${secs(e.checkMs)}, settle ${secs(e.settleMs)}, page reads ${secs(e.readMs)} (${e.detailPages || 0} product page(s))`);
  const a = t.app || {};
  const app = [['listMs', 'list'], ['productPagesMs', 'product pages'], ['browserRereadsMs', 'of which browser re-reads'], ['sideDataMs', 'stock & reviews'], ['exportMs', 'export'], ['otherMs', 'normalise & record']]
    .filter(([k]) => a[k] != null).map(([k, label]) => `${label} ${secs(a[k])}`);
  if (app.length) parts.push(`app: ${app.join(', ')}`);
  return `${t.totalMs != null ? `total ${secs(t.totalMs)} — ` : ''}${parts.join('; ')}`;
}

export function formatReport(rep) {
  const lines = [
    'SCRAPE REPORT',
    `store:              ${rep.store}`,
    `status:             ${rep.status}`,
    ...(rep.contentType && rep.contentType.type ? [`content type:       ${rep.contentType.type}${rep.contentType.requested === 'auto' ? ` (recognised automatically${rep.contentType.detected ? `: ${rep.contentType.detected}` : ': no signal, products by default'})` : ''}`] : []),
    `URLs discovered:    ${rep.discovered}`,
    `pages fetched:      ${rep.fetched}`,
    `products detected:  ${rep.detected}`,
    `products normalized:${rep.normalized}`,
    `  → accepted:       ${rep.accepted}`,
    `  → to verify:      ${rep.toVerify}`,
    `  → excluded:       ${rep.excluded}`,
    `incomplete:         ${rep.incomplete}`,
    `not-a-product page: ${rep.notAProductPage}`,
    ...(rep.pageVerdicts && rep.pageVerdicts.rejected ? [`rejected pages:     ${rep.pageVerdicts.rejected.count}${verdictBreakdown(rep.pageVerdicts.rejected)}`] : []),
    ...(rep.pageVerdicts && rep.pageVerdicts.doubtful ? [`doubtful page:      ${rep.pageVerdicts.doubtful.count} kept as "to verify"${verdictBreakdown(rep.pageVerdicts.doubtful)}`] : []),
    `duplicates skipped: ${rep.duplicates}`,
    `network errors:     ${rep.networkErrors}`,
    ...(rep.denied ? [`refused pages:      ${rep.denied} (HTTP refusal of that address; skipped)`] : []),
    `parse errors:       ${rep.parseErrors}`,
    `browser required:   ${rep.browserRequired}`,
    `browser used:       ${rep.browserUsed || 0}${rep.playwrightAvailable === false ? ' (Playwright not installed)' : ''}`,
    ...(rep.renderTimeouts ? [`render timeouts:     ${rep.renderTimeouts} (page(s) over the render budget)`] : []),
    `sitemaps read:      ${(rep.sitemapsRead || []).length}`,
    `duration:           ${((rep.durationMs || 0) / 1000).toFixed(1)}s`,
  ];
  // Executor + plain-language outcome — only set by external executors (the
  // "your browser" extension tier); absent on every engine run (back-compat).
  if (rep.executor) lines.push(`executed in:        ${rep.executor}`);
  if (rep.userReason) lines.push(`result:             ${rep.userReason}`);
  // Bytes downloaded (Item 6) — real bandwidth per job + per accepted product, the
  // cost signal to weigh before any per-GB proxy. Only shown once measured.
  if (rep.bytesDownloaded && typeof rep.bytesDownloaded.total === 'number') {
    const b = rep.bytesDownloaded;
    lines.push(`bytes downloaded:   ${fmtBytes(b.total)} (http ${fmtBytes(b.http || 0)}, browser ${fmtBytes(b.browser || 0)}${b.unlocker ? `, unlocker ${fmtBytes(b.unlocker)}` : ''}${b.firecrawl ? `, firecrawl ${fmtBytes(b.firecrawl)}` : ''}${b.scrapingBrowser ? `, scraping-browser ${fmtBytes(b.scrapingBrowser)}` : ''})`);
    if (rep.scrapingBrowser && rep.scrapingBrowser.runtimeSec != null) lines.push(`  scraping-browser session: ${rep.scrapingBrowser.runtimeSec}s runtime (billed per hour)`);
    if (rep.bytesPerAcceptedProduct != null) lines.push(`  → per product:    ${fmtBytes(rep.bytesPerAcceptedProduct)}/accepted`);
  }
  // Discovery outcome — so a "0 URLs discovered" run explains WHY (blocked / needs
  // a browser / no signal) instead of reading like a silent success.
  if (rep.discovery) {
    const d = rep.discovery;
    lines.push(`discovery method:   ${d.method || '—'}`);
    if (d.diagnosis) lines.push(`discovery result:   ${d.diagnosis}${d.diagnosisReason ? ` — ${d.diagnosisReason}` : ''}`);
    if (d.stopped) lines.push(`discovery stopped:  ${d.stopped.code} — ${d.stopped.reason} (no bypass attempted)`);
    if (d.browserPagesRendered) lines.push(`browser pages:      ${d.browserPagesRendered} rendered during discovery`);
    if (d.complement) {
      const c = d.complement; const o = c.outOfScope || {};
      lines.push(`sitemap complement: ${c.added} added, ${c.checked} checked against the listing scope (language ${c.scope && c.scope.language || 'none'}, category ${c.scope && c.scope.category || 'none'}); out of scope: language ${o.language || 0}, category ${o.category || 0}, pattern ${o.pattern || 0}${c.sitemapReread ? `; scoped re-read of ${c.rereadSitemaps || 0} sitemap(s)` : ''}`);
    }
    if (d.listingBlocked) lines.push(`listing blocked:    ${d.listingBlocked.url} — no sitemap URL in its scope, no off-topic product added`);
  }
  if (rep.selectorRecipe && rep.selectorRecipe.skipped) {
    const s = rep.selectorRecipe;
    lines.push(`Learned selectors: not used — ${s.rows} row(s) read, ${Math.round(s.emptyNameRatio * 100)}% without name, ${Math.round(s.emptyPriceRatio * 100)}% without price (the page changed); other methods used`);
  }
  // Listing pagination: mechanism, pages, announced total, why it stopped, warnings.
  if (rep.pagination) {
    const p = rep.pagination;
    lines.push(`pagination:         ${p.mechanism || 'none'} — ${p.pages ?? '?'} page(s)${p.totalAnnounced != null ? `, site announces ${p.totalAnnounced} product(s)` : ''}${p.stoppedBy ? `, stopped: ${p.stoppedBy}` : ''}`);
    if (p.browserScroll) lines.push(`  browser scroll:   ${p.browserScroll.cards} card(s) seen, ${p.browserScroll.added} added${p.browserScroll.blocked ? `, blocked: ${p.browserScroll.blocked}` : ''}`);
    if (p.apiAfterScroll) lines.push(`  then site API:    ${p.apiAfterScroll.pages} page(s), ${p.apiAfterScroll.added} added (${p.apiAfterScroll.headersLearned} request header(s) seen in the page), stopped by ${p.apiAfterScroll.stoppedBy}`);
    // API headers (names only, never a value): read from the recipe's specs, or found
    // in the page's public scripts after a refusal — with how many files were read.
    if (p.apiHeaders) {
      const a = p.apiHeaders;
      const where = a.source === 'recipe' ? 'from the recipe' : `in the page's public scripts (${a.filesRead ?? 0} of ${a.filesListed ?? 0} file(s) read${a.filesBeyondCap ? `, ${a.filesBeyondCap} beyond the cap` : ''})`;
      const names = (a.names || []).join(', ');
      lines.push(`  api headers:      ${a.found ? `found ${where}: ${names}` : `not found ${where}`}${a.retried ? (a.accepted ? ' — the API accepted them' : ' — the API still refused') : ''}${a.rejected && a.rejected.length ? ` — refused: ${a.rejected.join(', ')}` : ''}${a.error ? ` — ${a.error}` : ''}`);
    }
    if (p.warnings && p.warnings.length) lines.push(`  warnings:         ${p.warnings.join(', ')}${p.detail && (p.detail.status || p.detail.error) ? ` (${[p.detail.status ? `HTTP ${p.detail.status}` : null, p.detail.error].filter(Boolean).join(' ')})` : ''}`);
  }
  // Product pages visited to complete the listing (colour, sizes, EAN, gallery…).
  if (rep.detailPages) {
    const d = rep.detailPages;
    const why = Object.entries(d.reasons || {}).map(([k, n]) => `${k}×${n}`).join(', ');
    lines.push(`product pages:      ${d.completed} completed, ${d.unchanged} unchanged, ${d.failed} failed, ${d.skipped} skipped (${d.visited} visited)${why ? ` — ${why}` : ''}${d.stoppedEarly ? ` — stopped early: ${d.stoppedEarly}` : ''}`);
  }
  // Why the status is PARTIAL: rows to verify, product pages left unread.
  if (rep.partial) {
    const p = rep.partial;
    const more = [
      p.extensionPagesUnread ? `${p.extensionPagesUnread} product page(s) not read by the extension` : null,
      p.browserStop ? `app browser re-reads stopped (${p.browserStop})` : null,
      p.rulesInvalidated && p.rulesInvalidated.length ? `site rule(s) failing on pages read: ${p.rulesInvalidated.join(', ')}` : null,
    ].filter(Boolean);
    lines.push(`partial:            ${p.toVerify} product(s) to verify, ${p.pagesUnread} product page(s) unread${p.reasons ? ` (${Object.entries(p.reasons).map(([k, n]) => `${k}×${n}`).join(', ')})` : ''}${more.length ? `; ${more.join('; ')}` : ''}`);
  }
  if (rep.yourBrowserPages) {
    const e = rep.yourBrowserPages;
    lines.push(`extension pages:    ${e.read} read of ${e.toRead} in your browser${e.blocked ? `, ${e.blocked} blocked (human check or failure)` : ''}${e.notOpened ? `, ${e.notOpened} not opened${e.limit ? ` (limit ${e.limit.max})` : ''}` : ''}`);
  }
  if (rep.fill && rep.fill.total) lines.push(`fill rate:          ${fillLine(rep.fill)}`);
  if (rep.timings) lines.push(`time spent:         ${timingsLine(rep.timings)}`);
  if (rep.manifest && rep.manifest.status) lines.push(`export manifest:    ${rep.manifest.status}${rep.manifest.files && rep.manifest.files.length ? ` (${rep.manifest.files.join(', ')})` : ''}`);
  // Image addresses rejected (with their reason) and product addresses corrected — never silent.
  if (rep.images && (rep.images.rejected || rep.images.samples)) {
    const r = rep.images;
    lines.push(`images rejected:    ${r.rejected}${r.rejected ? ` — ${Object.entries(r.byReason || {}).map(([k, n]) => `${k}×${n}`).join(', ')}` : ''}`);
    for (const s of (r.samples || []).slice(0, 5)) lines.push(`  ${s.product || '—'} : ${s.url} (${s.label || s.reason})`);
  }
  if (rep.skus && rep.skus.rejected) {
    lines.push(`skus rejected:      ${rep.skus.rejected} — ${Object.entries(rep.skus.byReason || {}).map(([k, n]) => `${k}×${n}`).join(', ')} (the SKU stays empty)`);
    for (const s of (rep.skus.samples || []).slice(0, 5)) lines.push(`  ${s.product || '—'} : « ${s.value} » (${s.label || s.reason})`);
  }
  if (rep.urls && rep.urls.corrected) lines.push(`urls corrected:     ${rep.urls.corrected} (canonical address taken, tracking parameters dropped)`);
  // Taught rules that failed on the pages of this run (now "failing": tried last, the generic readers fill in).
  if (rep.knowledgeInvalidated && rep.knowledgeInvalidated.length) lines.push(`rules invalidated:  ${rep.knowledgeInvalidated.map((r) => `${r.field} (${r.ruleId}${r.reason ? `: ${r.reason}` : ''})`).join(', ')}`);
  // Stock per size + reviews asked with the requests a product page makes itself.
  if (rep.sideData) {
    const s = rep.sideData;
    if (s.learned) lines.push(`stock & reviews:    learned on one product page (${s.pageRequests} JSON request(s) seen) — stock: ${s.learned.availability ? 'yes' : 'no'}, reviews: ${s.learned.rating ? 'yes' : 'no'}${s.requests != null ? `; ${s.requests} request(s), ${s.failed || 0} failed, stock for ${s.availabilityRows || 0}, reviews for ${s.ratingRows || 0}` : ''}${s.stoppedBy ? ` — stopped by ${s.stoppedBy}` : ''}`);
    else if (s.reason) lines.push(`stock & reviews:    not read — ${s.reason}`);
  }
  // Product pages the APP's own (local) browser re-read after plain HTTP was refused or lacked the taught blocks.
  // Not the extension: what the user's browser read is on the « extension pages » line.
  if (rep.pagesViaBrowser || rep.browserPagesStop) {
    const stop = rep.browserPagesStop === 'human_check' ? 'arrêtées par une vérification humaine' : rep.browserPagesStop ? `arrêtées : ${rep.browserPagesStop}` : '';
    const ext = rep.detailAccess && rep.detailAccess.counts && rep.detailAccess.counts.extension ? Number(rep.detailAccess.counts.extension.ok) || 0 : 0;
    const notRead = Number(rep.browserPagesNotRead) || 0;
    lines.push(`relectures par le navigateur de l'app: ${rep.pagesViaBrowser || 0} fiche(s)${stop ? ` — ${stop}` : ''}${stop && notRead ? ` : ce navigateur n'a pas pu relire ${notRead} fiche(s)` : ''}${stop && ext ? `, l'extension en a lu ${ext}` : ''}`);
  }
  if (rep.listedOnly) lines.push(`from the listing:   ${rep.listedOnly} product(s) read from the listing page itself (card with an id and a price, no page link)`);
  // The job's own product limit (the form's "max products") cut the page: the page had more.
  if (rep.productLimit && rep.productLimit.max != null) lines.push(`product limit:      ${rep.productLimit.max} (the form's maximum)${rep.productLimit.read != null ? ` — ${rep.productLimit.read} card(s) read on the page, ${rep.productLimit.kept} kept` : ' reached'}`);
  if (rep.categoryTrail) lines.push(`category trail:     "${rep.categoryTrail.trail.join(' > ')}" (${rep.categoryTrail.source}) given to ${rep.categoryTrail.products} product(s)`);
  if (rep.blocked) {
    lines.push(
      '--- SOURCE STOPPED (no bypass attempted) ---',
      `reason:             ${rep.blocked.code} — ${rep.blocked.reason}`,
      `products recovered: ${rep.normalized}`,
      `products remaining: ${rep.remaining}`,
      rep.blocked.resumable === false ? 'action:             scrape stopped safely' : 'action:             scrape stopped safely (resumable)',
    );
  }
  const codes = Object.keys(rep.byStatus || {});
  if (codes.length) lines.push(`status breakdown:   ${codes.map((c) => `${c}=${rep.byStatus[c]}`).join('  ')}`);
  const strats = Object.keys(rep.byStrategy || {});
  // How each product was read (the reader: a platform recipe, structured data, your browser…), not where the time went.
  if (strats.length) lines.push(`products read by:   ${strats.map((s) => `${STRATEGY_LABEL[s] || s}=${rep.byStrategy[s]}`).join('  ')}`);
  // WHY pages were rejected / doubtful — a few concrete examples (full list in report.json).
  for (const [bucket, label] of [['rejected', 'rejected pages'], ['doubtful', 'doubtful pages']]) {
    const b = rep.pageVerdicts && rep.pageVerdicts[bucket];
    if (!b || !b.samples || !b.samples.length) continue;
    lines.push(`--- ${label} (examples) ---`);
    for (const smp of b.samples.slice(0, 5)) lines.push(`  ${smp.url || '—'} : ${(smp.reasons || []).join(' ; ')}`);
  }
  return lines.join('\n');
}
