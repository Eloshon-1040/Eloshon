import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Eloshon unlock gateway. Desktop app talks ONLY to this function (decision 2b):
// license auth, server-side quota + accounting, intelligent 3-provider cascade,
// shared-profile reads (short server cache), and capped run_feedback.
// Provider secrets stay server-side. verify_jwt = false (custom license auth).

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
const FC = () => Deno.env.get("FIRECRAWL_API_KEY") || "";
const SF = () => Deno.env.get("SCRAPFLY_API_KEY") || "";
const BD = () => Deno.env.get("BRIGHT_DATA_API_KEY") || "";

// ---- warm-isolate cache (best-effort, short TTL) ----
const cache = new Map<string, { exp: number; v: unknown }>();
const cget = (k: string) => { const e = cache.get(k); if (e && e.exp > Date.now()) return e.v; cache.delete(k); return undefined; };
const cset = (k: string, v: unknown, ttl: number) => cache.set(k, { v, exp: Date.now() + ttl });

async function sha256hex(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function loadConfig(): Promise<any> {
  const c = cget("config"); if (c) return c;
  const { data } = await admin.from("app_config").select("key,value");
  const cfg: any = {}; for (const r of (data || [])) cfg[r.key] = r.value;
  cset("config", cfg, 60000); return cfg;
}

function hostOf(u: string) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } }
function countryFromUrl(u: string): string | null {
  try {
    const url = new URL(u); const p = url.pathname;
    let m = p.match(/[a-z]{2}[_-]([A-Z]{2})(\/|$)/); if (m) return m[1];
    m = p.match(/\/([A-Z]{2})\//); if (m) return m[1];
    const tld = url.hostname.split(".").pop()!.toUpperCase();
    if (tld.length === 2 && tld !== "CO") return tld;
    return null;
  } catch { return null; }
}
const CUR: Record<string, string> = { BE: "EUR", FR: "EUR", DE: "EUR", NL: "EUR", ES: "EUR", IT: "EUR", US: "USD", GB: "GBP", CA: "CAD" };
function detectCurrency(html: string): string | null {
  let m = html.match(/"priceCurrency"\s*:\s*"([A-Z]{3})"/); if (m) return m[1];
  m = html.match(/property="(?:og:|product:)price:currency"\s+content="([A-Z]{3})"/i); if (m) return m[1];
  return null;
}
// A 200 can still be a WAF block/challenge page. Reject those generically (no site names).
function looksBlocked(h: string): boolean {
  return /Access Denied|Reference\s*#\d|Just a moment|cf-browser-verification|challenge-platform|cdn-cgi\/challenge|Pardon Our Interruption|Incapsula incident|Request unsuccessful|You have been blocked/i
    .test(h.slice(0, 8000));
}
// A real page must be non-trivial AND not a challenge/block page.
const realPage = (html: string) => html.length > 8000 && !looksBlocked(html);

// ---- providers: {ok, html, units, status, error} ----
async function firecrawl(url: string, mode: string, country: string | null) {
  const body: any = { url, proxy: mode === "stealth" ? "stealth" : "basic", formats: ["rawHtml"], onlyMainContent: false, timeout: 60000 };
  if (country) body.location = { country };
  const r = await fetch("https://api.firecrawl.dev/v1/scrape", { method: "POST", headers: { Authorization: `Bearer ${FC()}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({} as any));
  const html = j?.data?.rawHtml || "";
  return { ok: !!j.success && realPage(html), html, units: mode === "stealth" ? 5 : 1, status: r.status, error: j.success ? null : (j.error || null) };
}
async function scrapfly(url: string, mode: string, country: string | null) {
  const p = new URLSearchParams({ key: SF(), url });
  if (mode === "asp") { p.set("asp", "true"); p.set("render_js", "true"); }
  if (country) p.set("country", country.toLowerCase());
  const r = await fetch(`https://api.scrapfly.io/scrape?${p.toString()}`);
  const j = await r.json().catch(() => ({} as any));
  const res = j?.result || {}; const html = res.content || "";
  const costObj = j?.context?.cost; const units = (costObj && typeof costObj === "object") ? (costObj.total ?? 0) : (costObj || 0);
  return { ok: !!res.success && realPage(html), html, units, status: res.status_code || r.status, error: res.success ? null : (j?.message || res?.error?.message || null) };
}
let BD_ZONE = "";
async function bdZone(): Promise<string> {
  if (BD_ZONE) return BD_ZONE; const c = cget("bdzone") as string | undefined; if (c) { BD_ZONE = c; return c; }
  const r = await fetch("https://api.brightdata.com/zone/get_active_zones", { headers: { Authorization: `Bearer ${BD()}` } });
  const j = await r.json().catch(() => []); const arr = Array.isArray(j) ? j : (j?.zones || []);
  const z = (arr.find((x: any) => /unlock|unblock/i.test((x.type || "") + (x.name || ""))) || arr[0])?.name || "";
  BD_ZONE = z; cset("bdzone", z, 300000); return z;
}
async function brightdata(url: string, _mode: string, country: string | null) {
  const zone = await bdZone(); if (!zone) return { ok: false, html: "", units: 0, status: 0, error: "no_zone" };
  const body: any = { zone, url, format: "raw", data_format: "html" };
  if (country) body.country = country.toLowerCase();
  const r = await fetch("https://api.brightdata.com/request", { method: "POST", headers: { Authorization: `Bearer ${BD()}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  return { ok: r.status < 400 && realPage(text), html: text, units: 1, status: r.status, error: r.status >= 400 ? text.slice(0, 150) : null };
}
const PROVIDERS: Record<string, { fn: (u: string, m: string, c: string | null) => Promise<any>; provider: string; mode: string }> = {
  firecrawl_normal: { fn: firecrawl, provider: "firecrawl", mode: "normal" },
  firecrawl_stealth: { fn: firecrawl, provider: "firecrawl", mode: "stealth" },
  scrapfly_datacenter: { fn: scrapfly, provider: "scrapfly", mode: "datacenter" },
  scrapfly_asp: { fn: scrapfly, provider: "scrapfly", mode: "asp" },
  brightdata: { fn: brightdata, provider: "brightdata", mode: "unlocker" },
};
const eloCredits = (key: string, cfg: any) => Math.max(1, Math.ceil((cfg.credit_coeff?.[key] ?? 1) * (cfg.credit_margin ?? 1.5)));
function profileKey(dom: any): string | null {
  if (!dom?.best_provider) return null;
  if (dom.best_provider === "brightdata") return "brightdata";
  return dom.best_mode ? `${dom.best_provider}_${dom.best_mode}` : null;
}
async function getProfile(host: string) {
  const k = "prof:" + host; const c = cget(k); if (c !== undefined) return c as any;
  const { data: dom } = await admin.from("domains").select("*").eq("host", host).maybeSingle();
  const { data: rec } = await admin.from("recipes").select("*").eq("host", host).eq("status", "shared").order("version", { ascending: false }).limit(1).maybeSingle();
  const v = { domain: dom || null, recipe: rec || null }; cset(k, v, 30000); return v;
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
// Per-provider max time before the cascade moves to the next one — a slow provider
// must never hold the whole unlock for minutes (app_config.provider_timeout_ms).
function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(onTimeout()), ms))]);
}

Deno.serve(async (req: Request) => {
  let body: any = {}; try { body = await req.json(); } catch { /* */ }
  const action = body.action || "unlock";
  const license = body.license || req.headers.get("x-eloshon-license") || "";
  if (action === "diag") return json({ keys: { firecrawl: !!FC(), scrapfly: !!SF(), brightdata: !!BD() } });
  if (!license) return json({ error: "NO_LICENSE" }, 401);
  const licHash = await sha256hex(license);
  const cfg = await loadConfig();

  if (action === "unlock") {
    const url = body.url; if (!url) return json({ error: "NO_URL" }, 400);
    const host = hostOf(url);
    const { domain } = await getProfile(host);
    let cascade: string[] = (cfg.provider_order || []).filter((k: string) => PROVIDERS[k]);
    const winner = profileKey(domain);
    if (winner && PROVIDERS[winner]) cascade = [winner, ...cascade.filter((k) => k !== winner)];

    const provTimeoutMs = Number(cfg.provider_timeout_ms) || 30000;
    const estimate = eloCredits(cascade[0] || "firecrawl_normal", cfg);
    const q = await admin.rpc("check_quota", { p_license_hash: licHash, p_estimate: estimate });
    const quota = q.data as any;
    if (!quota?.allowed) return json({ ok: false, reason: quota?.reason || "quota_exceeded", quota }, quota?.reason === "unknown_account" ? 401 : 402);

    const enforce = cfg.enforce_url_country === true || cfg.enforce_url_country === "true";
    const country = enforce ? countryFromUrl(url) : null;
    const cap = Number(cfg.max_attempts_per_site ?? 3);
    const attempts: any[] = [];
    for (const key of cascade) {
      if (attempts.length >= cap) break;
      const P = PROVIDERS[key]; const t0 = Date.now();
      let res: any;
      try { res = await withTimeout(P.fn(url, P.mode, country), provTimeoutMs, () => ({ ok: false, html: "", units: 0, status: 0, error: "provider_timeout" })); } catch (e) { res = { ok: false, html: "", units: 0, status: 0, error: String(e) }; }
      const ms = Date.now() - t0;
      attempts.push({ key, provider: P.provider, mode: P.mode, status: res.status, ok: res.ok, ms, error: res.error });
      if (res.ok) {
        const credits = eloCredits(key, cfg);
        await admin.rpc("record_provider_call", { p_license_hash: licHash, p_host: host, p_provider: P.provider, p_mode: P.mode, p_provider_units: res.units, p_eloshon_credits: credits, p_http_status: res.status, p_success: true, p_billing: "eloshon" });
        let mismatch = false; let cur: string | null = null;
        if (country) { cur = detectCurrency(res.html); const exp = CUR[country]; if (cur && exp && cur !== exp) mismatch = true; }
        const stats = (domain?.provider_stats as any) || {};
        stats[key] = { last_measured: new Date().toISOString(), provider_units: res.units, eloshon_credits: credits, success: true, ms };
        await admin.from("domains").upsert({ host, best_provider: P.provider, best_mode: P.mode, best_provider_measured_at: new Date().toISOString(), provider_stats: stats, country: country || domain?.country || null, last_verified: new Date().toISOString(), runs: (domain?.runs || 0) + 1 }, { onConflict: "host" });
        cache.delete("prof:" + host);
        return json({ ok: true, provider: P.provider, mode: P.mode, key, eloshon_credits: credits, provider_units: res.units, country_used: country, country_mismatch: mismatch, detected_currency: cur, ms, htmlBytes: res.html.length, html: body.returnHtml === false ? undefined : res.html, attempts });
      } else {
        await admin.rpc("record_provider_call", { p_license_hash: licHash, p_host: host, p_provider: P.provider, p_mode: P.mode, p_provider_units: 0, p_eloshon_credits: 0, p_http_status: res.status, p_success: false, p_billing: "eloshon" });
      }
    }
    return json({ ok: false, reason: "all_providers_failed", host, attempts, quota }, 502);
  }

  if (action === "profile") {
    const q = await admin.rpc("check_quota", { p_license_hash: licHash, p_estimate: 0 });
    const reason = (q.data as any)?.reason;
    if (reason === "unknown_account" || reason === "account_blocked") return json({ ok: false, reason }, 403);
    const host = body.host; if (!host) return json({ error: "NO_HOST" }, 400);
    const prof = await getProfile(host);
    return json({ ok: true, host, domain: (prof as any).domain, recipe: (prof as any).recipe, server_cache_ttl_s: 30 });
  }

  if (action === "feedback") {
    const q = await admin.rpc("check_quota", { p_license_hash: licHash, p_estimate: 0 });
    const reason = (q.data as any)?.reason;
    if (reason === "unknown_account" || reason === "account_blocked") return json({ ok: false, reason }, 403);
    const clientHash = await sha256hex("fb:" + license);
    const cap = Number(cfg.max_feedback_per_account_per_day ?? 200);
    const since = new Date(); since.setUTCHours(0, 0, 0, 0);
    const { count } = await admin.from("run_feedback").select("*", { count: "exact", head: true }).eq("client_hash", clientHash).gte("created_at", since.toISOString());
    if ((count || 0) >= cap) return json({ ok: false, reason: "feedback_daily_cap", cap }, 429);
    const f = body.feedback || {};
    await admin.from("run_feedback").insert({ host: body.host, recipe_id: f.recipe_id || null, outcome: f.outcome, products_found: f.products_found, duration_ms: f.duration_ms, provider_used: f.provider_used, mode_used: f.mode_used, eloshon_credits: f.eloshon_credits, country_used: f.country_used, country_mismatch: !!f.country_mismatch, client_hash: clientHash });
    return json({ ok: true });
  }

  if (action === "recipe-push") {
    // 2b — a client uploads a recipe it derived (discovery / manual / AI) as a
    // CANDIDATE. Server owns the candidate→shared promotion (after several distinct
    // clients); until shared, `profile` does not serve it to others. Recipe shape is
    // the same jsonb the local domain profile stores (internal_api / manual_selectors).
    const q = await admin.rpc("check_quota", { p_license_hash: licHash, p_estimate: 0 });
    const reason = (q.data as any)?.reason;
    if (reason === "unknown_account" || reason === "account_blocked") return json({ ok: false, reason }, 403);
    const host = body.host; const rec = body.recipe || {};
    if (!host) return json({ error: "NO_HOST" }, 400);
    // link_filter is a valid recipe on its own (a click-to-learn gesture may yield
    // only the listing-link scope), so it counts toward "not empty".
    if (!rec.internal_api && !rec.manual_selectors && !rec.link_filter) return json({ ok: false, reason: "empty_recipe" }, 400);
    await admin.from("domains").upsert({ host }, { onConflict: "host" });
    const { data: last } = await admin.from("recipes").select("version").eq("host", host).order("version", { ascending: false }).limit(1).maybeSingle();
    const version = (((last as any)?.version) || 0) + 1;
    const { error } = await admin.from("recipes").insert({
      host, version, status: "candidate", created_by: "client",
      internal_api: rec.internal_api ?? null, manual_selectors: rec.manual_selectors ?? null,
      link_filter: rec.link_filter ?? null,
      pagination: rec.pagination ?? null, extractor_strategy: rec.extractor_strategy ?? null,
      fields_available: rec.fields_available ?? [],
    });
    if (error) return json({ ok: false, reason: "insert_failed", detail: error.message }, 500);
    return json({ ok: true, host, version });
  }

  return json({ error: "BAD_ACTION" }, 400);
});
