# Usage ledger, paid-route opt-in and the Administration page (v0.5.17)

Owner-only visibility over every external or routing event: which route ran,
when, for which job and site, with what result, credits and estimated cost.
Ordinary users see none of it.

## 1. Where the ledger lives

```
%APPDATA%\Eloshon Scraper\usage-ledger\ledger.jsonl            ← current file
%APPDATA%\Eloshon Scraper\usage-ledger\ledger-2026-10-001.jsonl ← rotated files (kept forever)
```

- Same folder as `config.json` (Electron `userData`), never in the install
  directory, so an app update never wipes it.
- JSON Lines, UTF-8, **append-only**: one line per event, never rewritten,
  never reset when the month changes, never deleted automatically.
- Rotation: when the current file would pass **5 MiB** (about 12–15k lines),
  it is renamed `ledger-YYYY-MM-NNN.jsonl` (rotation month + sequence) and a
  new `ledger.jsonl` starts. The reader walks every file in order.
- One writer (`core/metering/ledger.mjs`): one append-mode file descriptor, one
  `write` per complete line. The engine's parallel workers are async tasks in
  the same process, so two lines can never interleave (tested with several
  writer threads too).
- A write failure never stops a job: it is counted, reported once in the main
  process log (code only) and shown as a red banner in Administration ›
  Fournisseurs.

## 2. Line format (schema v1)

Every key is always present (`null` when unknown). Since v0.5.37 a 25th field,
`cacheState`, closes the line; lines written before it simply lack the key
(read as `null`, empty cell in the CSV export). Example (masked, pre-0.5.37):

```json
{"v":1,"ts":"2026-10-06T21:19:04.512Z","jobId":"20261006211840-k3p9q","domain":"adidas.be","url":"https://www.adidas.be/homme","provider":"firecrawl","route":"escalation","channel":"direct","outcome":"success","attempted":true,"reason":"test_mode","products":48,"bytes":812000,"durationMs":9400,"credits":1,"units":null,"upstream":null,"model":null,"tokensIn":null,"tokensOut":null,"costUsd":null,"costBasis":"prix unitaire non renseigné","testMode":true,"appVersion":"0.5.17"}
```

| Field | Meaning |
|---|---|
| `ts` | UTC ISO time (the UI shows local time) |
| `jobId`, `domain`, `url` | the job; `url` keeps origin + path only (no query, fragment or credentials) |
| `provider` | `local`, `extension`, `firecrawl`, `webunlocker`, `scrapingbrowser`, `cascade`, `scrapfly`, `anthropic`, `zyte` |
| `route` | sub-route: `escalation`, `bootstrap`, `unlock`/`unlock-page` (cascade), `cascade` (one upstream attempt), `ai-assist`, `nodriver`, free-lane method (`crawl`, `sitemap`, `internal-api`…) |
| `channel` | `local` (no external service), `direct` (the owner's own keys on this machine), `server` (through the Eloshon server cascade) |
| `outcome` | `success`, `empty` (since v0.5.34: the page came back but yielded no product — billed, not a success), `failed`, `timeout`, `quota_exhausted`, `blocked_by_cap`, `blocked_no_optin`, `skipped` |
| `attempted` | `true` only when a request really left the app |
| `reason` | short class (`http_403`, `no_optin`, `cap_reached`, `priority`, `test_mode`, `stalled` — the watchdog stopped the job, since v0.5.39…) — never a raw error body |
| `products`, `bytes`, `durationMs` | what the route produced / downloaded / took |
| `credits` | Firecrawl credits when the API reports them (v2 `data.metadata.creditsUsed`); Eloshon credits for the cascade; `null` = not reported (never guessed) |
| `units`, `upstream` | cascade only: provider units and `provider:mode` that served the page |
| `model`, `tokensIn`, `tokensOut` | Anthropic only (never the prompt or the reply) |
| `costUsd`, `costBasis` | **estimate** from the cost settings (§5); `null` = unknown price |
| `testMode` | `true` for every line of a job launched in admin test mode |
| `cacheState` | (v0.5.37) `hit` = the provider served a copy of the page it already held, `miss` = it fetched the page; `null` when the provider does not say. Today only Firecrawl reports it (v2 `data.metadata.cacheState`) |

Secrets: the writer scrubs every key/licence value the app knows (secure store,
config, env names) from every string, redacts bearer tokens, `key=…`, provider
auth strings and long opaque tokens from `reason`, and drops query strings.

### What is logged where

| Path | File | Lines |
|---|---|---|
| Free lanes (HTTP, sitemap, crawl, recipes, local browser) | `app/controller.mjs` end of `execute` | one `local` line per job |
| Scraping Browser bootstrap (Colruyt pattern) | `app/controller.mjs` `headerBootstrap` | `scrapingbrowser/bootstrap` (incl. skipped by kill switch / cap) |
| Direct escalation Firecrawl / Web Unlocker / Scraping Browser | `app/controller.mjs` escalation block | the attempt + one line per route not used (`blocked_no_optin`, `blocked_by_cap`, `priority`, `one_session_per_job`) |
| nodriver (specialised local browser) | `app/controller.mjs` `unlockRetry` | `local/nodriver` |
| Server cascade | `app/controller.mjs` `cascadeUnlock` (`recordCascadeCall`) | one `cascade` line per page (credits) + one line per upstream attempt (`firecrawl`/`scrapfly`/`webunlocker`, channel `server`) |
| Extension ("votre navigateur") | `app/controller.mjs` `ingestExternalProducts` | `extension` |
| AI assist (Anthropic) | `app/main.mjs` `aiAssist` → `app/ai/provider.mjs` `onCall` | `anthropic/ai-assist` |
| AI locate (first discovery of a site, repair of a failing rule, ✨ on a product page) | `app/controller.mjs` `aiAsker` → `app/ai/provider.mjs` | `anthropic/ai-locate` (one line per model request) |
| Chat agent (side panel « Agent » tab) | `app/controller.mjs` `createAgentService` → `app/ai/agent.mjs` | `anthropic/agent-chat` (one line per model request of the tool loop) |
| Zyte | — | no call site in the app (lane module only) |

The free `local` line’s bytes include the listing pagination and product-page requests (v0.5.18, see `docs/LISTING-AND-PRODUCT-PAGES.md`).

Not logged (free, no quota): edge `estimate`, `profile`, `feedback`,
`recipe-push`, `account_status`, and the Firecrawl free balance read.

## 3. How to read it

- **Administration › Utilisation** (after unlocking): today / 7 days / month
  cards, filters (route, result, dates, domain incl. subdomains, test mode),
  newest-first table, click a job id for its route chain and `report.json`
  fields, **Exporter en CSV** for the current filter.
- **Result screen** (admin unlocked): the line *Passé par : … → …* with credits
  and estimated cost.
- **Jobs** (admin unlocked): the lock button on a row opens that job in
  Utilisation.
- Raw: every file is plain JSON Lines (`Get-Content ledger.jsonl -Tail 20`).

## 4. Paid-route opt-in and test mode

A direct paid route (Firecrawl, Web Unlocker, Scraping Browser) is attempted
only when ALL of these hold — unchanged matching, now visible:

1. the free lanes produced no product;
2. the site is **opted in** for that route (`config.json` lists
   `firecrawl.domains`, `brightData.domains`, `brightData.scrapingBrowserDomains`)
   **or** the launch is in **admin test mode** for that route;
3. its key is configured; the provider is enabled, not blocked for the site by
   the per-site switch, not over a cap, and the kill switch is off.

Order: Firecrawl → Web Unlocker → Scraping Browser, the route that worked last
time for the host first (`domain-profiles.json` `unlockRoute`). Since v0.5.33 the
allowed routes are tried **in that order until one yields products** — at most
`escalation.maxRoutesPerPage` attempts for the page (default 3, `config.json`),
each within `escalation.routeTimeoutMs` (default 120 000 ms; a silent route is
recorded as `timeout` and the chain moves on). Before each attempt the gate is
checked again (a previous attempt may have reached a cap → `blocked_by_cap`).
Still at most one Scraping Browser session per job. Every attempt, every
refusal and every route left out (`priority`, `max_routes`, `stopped`) is a
ledger line; `report.json` `unlockChain` lists the routes in order with their
outcome (admin job view only — users see no provider name). Before v0.5.33 a
single call per job was made, on the first allowed route.

A route whose page came back WITHOUT any product is recorded as `empty` (since
v0.5.34): the request was billed, the chain moves on to the next allowed route,
and the admin usage table shows "Page reçue, aucun produit" with the mention
"Appel payé, aucun produit" in the cost column. `success` now means products were
found. The free-lane equivalent stays `failed` + `no_products`.

Since v0.5.34 a job collects a **content type** (products, listing cards or
videos — `shared/content/profiles.mjs`): `report.json` carries
`contentType` = `{ type, requested, detected }` and `report.txt` a
"content type" line. The ledger line format is unchanged: `products` counts the
rows found whatever the type (a video run counts videos). For a video run the
engine also writes the `detailPages` block ("sample first": the first listed
pages visited, the rest delivered from the list without a request).

Since 2026-10-27 `report.status` is `PARTIAL` (never `OK`) when a finished run
left rows to verify or product pages unread (`report.partial`), and the report
lists the image addresses it rejected (`report.images`, with reasons), the
product addresses it corrected (`report.urls`) and the taught rules the run made
fail (`report.knowledgeInvalidated`) — `report.txt` lines "partial", "images
rejected", "urls corrected", "rules invalidated". The ledger line's `outcome` is
unchanged (`success` = products found). See
`docs/LISTING-AND-PRODUCT-PAGES.md` § 3.

- Opt-in UI: **Administration › Domaines**. The domain is normalised
  (lowercase, no scheme/path, no leading `www.`); `example.com` covers
  `example.com` and `www.example.com`, never `shop.example.com`. Each change is
  written atomically (temp file + rename), the previous file is copied to
  `config.previous.json`, the result is re-read and rolled back on mismatch, and
  a corrupt `config.json` is never overwritten.
- The old per-domain switch is shown next to it as *Interrupteurs du site (non
  bloqué)*: it can only block, never authorise.
- Test mode: on **Nouveau scraping**, visible only when the admin is unlocked.
  It allows the chosen routes for that launch only, shows caps and the worst
  case before a confirmation, is checked again in the main process (dropped if
  the admin is locked), is never written to `config.json`, and is not reused by
  a resume. Every ledger line of that job has `testMode: true`.

## 5. Costs and caps

- **Cost settings** (Administration › Coûts → `config.json` `costs`): the
  defaults are the values already in the code — only the Scraping Browser's
  `8 $/GB`; every other price is empty ("inconnu") until you enter your
  contract price. Estimates only; the provider invoice is the reference.
- **Firecrawl cost basis** (v0.5.37): with `usdPerCredit` set, a line whose
  `credits` the API reported is priced `crédits relevés × X $`; a line without
  reported credits is priced from the settings and marked
  `estimation : …` (`usdPerRequest`, else Firecrawl's published 1 credit per
  page for the lane's options). Before v0.5.37 a line with `credits: null`
  and `usdPerCredit` set was priced 0 $.
- **Firecrawl cache** (API v2, v0.5.37): the lane sends `maxAge`
  (`config.json` `firecrawl.maxAgeMs`, default 3 600 000 = 1 h; 0 = always a
  fresh page). Per Firecrawl's docs (read 2026-10-20) a cached page still
  costs 1 credit: the cache makes a retry faster and spares a failed fresh
  render, it does not lower the bill. Firecrawl skips its cache when the
  request carries `actions` (a wait selector) or `headers`. After a Firecrawl
  page with no product the host gets `unlockCacheBypass: true` in
  `domain-profiles.json` and the next Firecrawl call asks for a fresh page
  (`maxAge: 0`); a page with products clears it.
- **Firecrawl errors** (v0.5.37): `402` (no credits left) stops the lane at
  once — `quota_exhausted`, reason `no_credits`, no retry. `429` and `5xx`
  are retried (at most 3 attempts), honouring `Retry-After` (else 1 s, 2 s),
  only while at least 5 s of `escalation.routeTimeoutMs` remain; out of
  budget → reason `rate_limited` (429) or `http_5xx`. Per the docs a request
  that returned no document costs 0 credits; the ledger still records it as
  one attempted call (the caps count it, unchanged).
- **Caps** are unchanged (same defaults, same checks before each billable
  call). Source of truth: **the ledger**. The cap counters in `config.json`
  `providers.usage` are a fast cache fed by the SAME meter call that writes the
  ledger line (`core/metering/meter.mjs`), and at startup they are raised to the
  ledger's month totals (never lowered, so pre-ledger usage still counts).
  Only `direct` calls that were really sent count; server-cascade calls are
  limited by the server quota, not by these caps.
- **Per job vs per month** (v0.5.33): the `…PerJob` counters (`callsThisJob`,
  `bytesThisJob`) are reset to zero when a job starts (`app/controller.mjs`
  `execute`, `ProviderRuntime.resetJobCounters`), so a per-job cap bounds one job
  only. The `…PerMonth` counters are never reset by a job; they only roll over
  with the UTC month. Before v0.5.33 the per-job counters grew for the whole
  month, so a per-job cap acted as a month cap. Test:
  `core/__tests__/caps-per-job.test.mjs`.
- New: the kill switch, "désactivé" and the Scraping Browser caps now also
  apply to the bootstrap session (it was not gated before).

## 6. Reconciling with the providers

1. Administration › Utilisation → filter the route (e.g. Firecrawl) and the
   dates → **Exporter en CSV**.
2. Firecrawl › Activity Logs: compare the count of lines with
   `attempted=true` and `credits`. Per Firecrawl's billing page (read
   2026-10-20) a page Firecrawl returned is billed even when the site answered
   403/404, a request that returned no document (most `429`/`5xx`, `402`) is
   not; `cacheState: "hit"` lines are billed like the others.
3. Bright Data › Billing › breakdown CSV: one Web Unlocker request per
   `webunlocker` line with `attempted=true`; Browser API cost vs `bytes` of
   `scrapingbrowser` lines (the ledger's CDP byte count is a lower bound,
   measured about 24 % under the invoice on 2026-09-27).
4. Server cascade: `cascade` lines carry the Eloshon credits; upstream attempt
   lines (channel `server`) show which provider was tried. The provider units
   of a failed upstream attempt are not returned by the server (see the
   decision list in the release report).
