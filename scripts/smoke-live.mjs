/**
 * Live regression panel (Part 3) — runs the REAL controller against real sites and
 * compares each result to a stored baseline, so a fix for one site can't silently
 * break another. Recorded/mocked unit tests can't catch cross-site regressions;
 * this can. Run before every PR.
 *
 *   node scripts/smoke-live.mjs                 # run + compare to baseline, exit 1 on any drop
 *   node scripts/smoke-live.mjs --update-baseline   # accept current results as the new baseline
 *   node scripts/smoke-live.mjs --only lidl-section # run a subset (substring match on key)
 *
 * Windows / PowerShell: `node scripts\smoke-live.mjs` (plain Node, no shell tricks).
 *
 * NETWORK: needs outbound access to the target hosts. In a restricted cloud
 * environment add these to the egress allowlist:
 *   www.lidl.be, www.colruyt.be, apip.colruyt.be, www.brico.be,
 *   www.allbirdsbenelux.nl, adoboloco.com, www.frenchtoday.com
 *   (+ brd.superproxy.io:9222 wss for the opt-in PAID Scraping Browser targets)
 * (Baselines must be captured on a network that can reach them.)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appDirs, ensureDirs } from '../lib/osenv.mjs';
import { createController } from '../app/controller.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(__dirname, 'smoke-baseline.json');

// Best-effort load of .env.local so the PAID escalation tiers (Bright Data / Firecrawl)
// have their keys when validating the opt-in unlock sites below. Never printed; the
// file is gitignored. Absent keys → those targets are skipped (see runOne), never a
// false regression on a machine/CI without them.
(function loadEnvLocal() {
  try {
    const p = path.join(__dirname, '..', '.env.local');
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_-]+)=(.*)$/i);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, '');
    }
  } catch { /* no .env.local → paid targets skip */ }
})();

// Edit the exact category/campaign URLs to current ones as sites change.
// Lidl campaign /a<ID> URLs are EPHEMERAL (they rotate weekly), so the live panel
// pins two stable /s<ID> SECTIONS instead — both exercise the categoryId recipe
// variant. The campaign variant stays covered offline by core/__tests__/recipe-lidl.test.mjs.
const TARGETS = [
  { key: 'lidl-section-food', url: 'https://www.lidl.be/c/fr-BE/aliments-boissons/s10068374', browser: true },
  { key: 'lidl-section-nonfood', url: 'https://www.lidl.be/c/fr-BE/cuisine-menage/s10067764', browser: true },
  { key: 'colruyt-root', url: 'https://www.colruyt.be/fr/produits?page=1', browser: true },
  // colruyt-category: the REAL category path. `/fr/produits/boissons` was STALE —
  // Colruyt itself 404s it as a non-existent product fiche ("Snif… produit
  // introuvable"). Real categories live under /produits/toutes-les-categories/… .
  // v0.5.9: served FREE by the repaired colruyt-be.json recipe (key + category id
  // read over plain HTTP) → strategy internal-api instead of the old 0-product crawl.
  { key: 'colruyt-category', url: 'https://www.colruyt.be/fr/produits/toutes-les-categories/boissons/eau', browser: true },
  { key: 'brico', url: 'https://www.brico.be/fr/chauffage-climatisation/ventilateurs/he09/', browser: true },
  { key: 'allbirds-shopify', url: 'https://www.allbirdsbenelux.nl/collections/mens', browser: false },
  { key: 'adoboloco-woo', url: 'https://adoboloco.com/shop/', browser: true },
  { key: 'frenchtoday-woo', url: 'https://www.frenchtoday.com/shop/', browser: true },
  // Positive BROWSER-LANE proof (Item 3): a genuinely client-side-rendered listing
  // whose raw HTML carries only an empty skeleton grid (no product data) — the HTTP
  // lane discovers 0, the browser lane renders + extracts the full catalogue. Stable,
  // ToS-friendly scraping-practice site, no anti-bot. This is the panel's proof that
  // the browser lane yields a positive result (brico now uses embedded-state; Colruyt
  // is anti-bot-blocked, so neither proves it).
  { key: 'scrapingcourse-csr', url: 'https://www.scrapingcourse.com/javascript-rendering', browser: true },
  // PAID unlock-tier proof (v0.5.6) — opt-in escalation validated end to end. KEY-GATED:
  // skipped (not a regression) on a machine without the provider key. Capped small
  // (proof-of-concept, minimal credit spend). Nike (Akamai + Next.js SPA) is unlocked
  // by Bright Data and its __NEXT_DATA__ products are read by the generic SPA-state
  // extractor (core/spa-state.mjs).
  { key: 'nike-spa', url: 'https://www.nike.com/w/mens-shoes-nik1zy7ok', browser: false, requires: 'BRIGHT-DATA-API-KEY',
    config: { brightData: { domains: ['nike.com'] } }, maxProducts: 15 },
  // PAID browser-BOOTSTRAP proof (v0.5.9) — the Scraping Browser only captures the
  // app's API key in ONE short session (mode 'always', so it is exercised even while
  // the free key source works), then colruyt-be.json replays over HTTP with the store
  // from siteContext. DOUBLE-GATED: BROWSER_AUTH *and* exactly ELOSHON_SMOKE_PAID=1,
  // so a routine panel run never opens a billed session. Two stores → the store is
  // selectable by config (886 prices differ from 604 on this category).
  { key: 'colruyt-bootstrap-604', url: 'https://www.colruyt.be/fr/produits/toutes-les-categories/boissons/eau', browser: false,
    requires: ['BROWSER_AUTH', 'ELOSHON_SMOKE_PAID=1'], config: colruytBootstrap('604'), maxProducts: 8 },
  { key: 'colruyt-bootstrap-886', url: 'https://www.colruyt.be/fr/produits/toutes-les-categories/boissons/eau', browser: false,
    requires: ['BROWSER_AUTH', 'ELOSHON_SMOKE_PAID=1'], config: colruytBootstrap('886'), maxProducts: 8 },
];
function colruytBootstrap(placeId) {
  return {
    brightData: {
      // Observe the product-search BFF service's own calls (the earliest one carries
      // the same app key) — never a different gateway service's key.
      scrapingBrowserBootstrap: { 'colruyt.be': { requestUrlPattern: '^https://apip[.]colruyt[.]be/gateway/emec[.]colruyt[.]protected[.]bffsvc/', headers: ['X-CG-APIKey'], mode: 'always' } },
      scrapingBrowserCountry: { 'colruyt.be': 'be' },
    },
    siteContext: { 'colruyt.be': { placeId } },
  };
}

const args = process.argv.slice(2);
const UPDATE = args.includes('--update-baseline');
const only = (() => { const i = args.indexOf('--only'); return i >= 0 ? args[i + 1] : null; })();
const pct = (num, den) => (den ? Math.round((num / den) * 100) : 0);
const nonEmpty = (v) => v != null && String(v).trim() !== '' && !/^data:image\/svg\+xml/i.test(String(v));

async function runOne(t) {
  // `requires`: an env name that must be set, or 'NAME=value' that must match
  // exactly (the paid opt-in: ELOSHON_SMOKE_PAID=0 / =false must NOT spend).
  const missing = [].concat(t.requires || []).find((r) => {
    const [name, want] = String(r).split('=');
    return want != null ? process.env[name] !== want : !process.env[name];
  });
  if (missing) return { key: t.key, skipped: `no ${missing}` };
  const maxProducts = t.maxProducts || 120;
  const dirs = ensureDirs(appDirs(fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-smoke-'))));
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 4, recovery: true, maxProducts, maxPages: 20, ...(t.config || {}) }), 'utf8');
  let done = null;
  const ctrl = createController({ dirs, emit: (type, p) => { if (type === 'done') done = p; } });
  const t0 = Date.now();
  try { await ctrl.start({ origin: t.url, store: 'smoke', browser: t.browser !== false, intervene: false, provider: 'manual', limits: { maxProducts, maxPages: 20 } }); }
  catch (e) { return { key: t.key, error: String((e && e.message) || e), ms: Date.now() - t0 }; }
  const counts = (done && done.counts) || {};
  const products = done ? ctrl.jobProducts(done.jobId) : [];
  const n = products.length;
  const bytes = (done && done.bytesDownloaded) || null;
  return {
    key: t.key,
    strategy: (done && done.method) || (done && done.diagnosis) || 'none',
    accepted: counts.accepted || 0,
    products: n,
    fillName: pct(products.filter((p) => nonEmpty(p.name)).length, n),
    fillPrice: pct(products.filter((p) => p.price != null).length, n),
    fillImage: pct(products.filter((p) => nonEmpty(p.image_url)).length, n),
    ms: Date.now() - t0,
    // Bytes downloaded (Item 6) — informational only; NOT part of the regression
    // compare (bandwidth varies run to run). Total + per-accepted-product.
    bytes: bytes ? bytes.total : null,
    bytesPerProduct: (done && done.bytesPerAcceptedProduct) ?? null,
    // Scraping Browser session runtime (s) — reported for the remote-browser lane only.
    sbRuntimeSec: (done && done.scrapingBrowser && done.scrapingBrowser.runtimeSec) ?? null,
    error: null,
  };
}

/** Compact byte size for the panel line. */
function fmtBytes(v) {
  const n = Number(v) || 0;
  if (!v && v !== 0) return '—';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / (1024 * 1024)).toFixed(2)}MB`;
}

// NOTE on variable sites: `brico` (a time-bounded browser crawl) and
// `allbirds-shopify` (sitemap-complement discovery) legitimately vary run to run.
// brico in particular THROTTLES this IP under repeated crawls — its accepted count
// was observed from 120 down to ~72 across back-to-back runs. Their baseline
// `accepted` is therefore a deliberately loose FLOOR (well below the observed
// minimum) so ordinary variance/throttling never trips a false regression, while a
// real collapse (single digits / 0) still does. Do NOT "raise" these floors to a
// single lucky high run.
function compare(cur, base) {
  if (!base) return { flags: ['NEW (no baseline)'] };
  const flags = [];
  if (cur.error) flags.push('ERROR: ' + cur.error);
  // A BLOCKED / non-productive site (0 accepted in BOTH baseline and now) can land
  // on a different "blocked" strategy label run to run — anti-bot variance flips
  // colruyt-root between crawl and crawl+browser, both yielding 0 accepted. That is
  // not a regression; only flag a strategy change when the site actually produces
  // products (so a real lane change on Lidl/brico/… still trips).
  const bothBlocked = cur.accepted === 0 && base.accepted === 0;
  if (cur.strategy !== base.strategy && !bothBlocked) flags.push(`strategy ${base.strategy}→${cur.strategy}`);
  if (cur.accepted < base.accepted) flags.push(`accepted ${base.accepted}→${cur.accepted}`);
  for (const k of ['fillName', 'fillPrice', 'fillImage']) if (cur[k] < base[k] - 10) flags.push(`${k} ${base[k]}%→${cur[k]}%`);
  return { flags };
}

(async () => {
  const baseline = (() => { try { return JSON.parse(fs.readFileSync(BASELINE, 'utf8')); } catch { return {}; } })();
  const targets = only ? TARGETS.filter((t) => t.key.includes(only)) : TARGETS;
  const results = {}; let regressions = 0;
  for (const t of targets) {
    process.stdout.write(`▶ ${t.key} … `);
    const r = await runOne(t);
    if (r.skipped) { if (UPDATE && baseline[t.key]) results[t.key] = baseline[t.key]; console.log(`skipped (${r.skipped}) — not compared`); continue; }
    results[t.key] = r;
    const { flags } = UPDATE ? { flags: [] } : compare(r, baseline[t.key]);
    const bytesStr = (r.bytes != null ? ` bytes=${fmtBytes(r.bytes)}${r.bytesPerProduct != null ? `(${fmtBytes(r.bytesPerProduct)}/prod)` : ''}` : '')
      + (r.sbRuntimeSec != null ? ` sb-runtime=${r.sbRuntimeSec}s` : '');
    const line = r.error ? `ERROR (${r.error})` : `strategy=${r.strategy} accepted=${r.accepted}/${r.products} name=${r.fillName}% price=${r.fillPrice}% img=${r.fillImage}%${bytesStr} ${(r.ms / 1000).toFixed(1)}s`;
    if (flags.length && !flags[0].startsWith('NEW')) regressions++;
    console.log(`${line}${flags.length ? '  ⚠ ' + flags.join('; ') : (UPDATE ? '' : '  ✓')}`);
  }
  if (UPDATE) { fs.writeFileSync(BASELINE, JSON.stringify(results, null, 2)); console.log(`\nBaseline written: ${BASELINE}`); process.exit(0); }
  console.log(`\n${regressions ? `✗ ${regressions} regression(s)` : '✓ no regressions vs baseline'}`);
  process.exit(regressions ? 1 : 0);
})();
