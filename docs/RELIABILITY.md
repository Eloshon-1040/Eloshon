# Run reliability (app 0.5.39–0.5.40, audit step 1 — P0)

What keeps a job from hanging, from stopping for a wrong reason, from hammering a
site, or from losing what it learned. Every item below has its test in
`core/__tests__/p0-*.test.mjs` / `shared/__tests__/p0-*.test.mjs` (hand-built
fixtures, loopback servers, no network).

## 1. One deadline per HTTP exchange (B1)

A request's deadline covers the headers **and the body**. The main `Fetcher`
keeps its timer until the body is read and races the read against the abort;
every other client goes through `shared/net/deadline.mjs` (`fetchWithin`,
`withinDeadline`): Firecrawl (scrape + credit check), Web Unlocker, Zyte, the
recipe / platform HTTP, the recipe server client, the AI provider (60 s).
Setting: `timeoutMs` (20 000 ms).

## 2. Per-host spacing that holds under concurrency (B6)

`HostPacer` books each request's slot **before** waiting, so parallel workers
queue `rateLimitMs` apart (they used to read the same "last request" time and
fire together). The main Fetcher and the recipe / platform HTTP share one pacer.

## 3. 429 Too Many Requests (B8)

Retried after `Retry-After` (seconds or a date; else 1 s then 2 s), within
`retries`, never a wait longer than 60 s (`maxRetryAfterMs` of the Fetcher) and
never once a stop was asked. The wait moves the host's next slot for every
parallel request. A longer wait than allowed is not made: the 429 is reported
(RATE_LIMITED, a site-wide stop, as before).

## 4. Recipe replays, platform feeds, recipe server (B7)

`defaultHttpGet` (shared/internal-api.mjs): deadline over the whole exchange,
the run's User-Agent unless the recipe sets one, the shared pacer, retry of 429
and 5xx. The recipe server (edge) client: 20 s, 180 s for the server-side
unlock.

## 5. Challenge detection (B3)

`core/detect.mjs` uses the challenge-PAGE markers of `shared/challenge/detect.mjs`
(the list the extension uses) — never a bare anti-bot SDK name (`datadome`,
`_px`, `perimeterx`, `incapsula`, `imperva` load on every normal page of a
protected site). A 2xx page carrying structured product data (JSON-LD
Product / Offer / ItemList, microdata Product, `og:type` product) is content
before any marker is checked.

## 6. A refused product page (B10)

A 403 on one address is that page's: skipped, counted (`report.denied`,
"refused pages" in report.txt), the run goes on. The source stops after
`deniedStreak` refusals in a row (3; 1 = stop at the first), or when every page
was refused and none read. Challenge, captcha, login and rate limit still stop
the source at once.

## 7. Learned recipes on disk (B5)

`core/profile-file.mjs`: `domain-profiles.json` is written atomically (temp +
rename + read-back) and the previous version is kept as
`domain-profiles.previous.json`. A file that is not valid JSON is renamed
`domain-profiles.corrupt-<time>.json` (never overwritten) and the previous
version is used. A file that exists but cannot be read (locked, permission)
makes the run read-only: nothing is written.

## 8. Recipe patterns (B9)

`shared/safe-regex.mjs` checks every recipe pattern before it runs (recipes may
come from the recipe server; JavaScript gives a regex no time limit): at most
400 characters, flags `i m s u`, no back-reference, no unbounded or >10-times
repeated group holding an unbounded repetition unless a mandatory atom of the
group separates its iterations, no repeated alternation, no two side-by-side
unbounded repetitions that can take the same characters. The text a pattern
reads is capped at 1 000 000 characters. Refused: `recipe … unsafe pattern
(reason)`, the recipe lane fails cleanly.

## 9. Settings that reach the engine (B4)

Every key of `core/config.mjs` `DEFAULTS` (except `outputDir` and the form's
`browser`) is forwarded from the app's `config.json` (`%APPDATA%\Eloshon
Scraper\config.json`) by `jobConfigOverrides()` — for a launch, a resume, an
extension ingest, nodriver and the server cascade. A value of the wrong kind is
ignored (the default stays); the form's limits win over the saved ones.
Objects are deep-merged onto their defaults.

| Key | Default | What it does |
|---|---|---|
| `timeoutMs`, `retries`, `rateLimitMs`, `workers` | 20 000, 2, 600, 4 | HTTP deadline, retries, per-host spacing, parallel pages |
| `maxPages`, `maxProducts`, `maxDepth`, `maxBrowser` | 150, 1000, 3, 40 | discovery and job bounds |
| `renderTimeoutMs` | null | local browser budget per page (null = max(15 s, timeoutMs + 12 s)) |
| `headless` | true | false = show the local browser (intervention is always visible) |
| `csrFewThreshold`, `scopeToCollection`, `recovery` | 2, true, true | browser pass trigger, collection scope, recovery ladder |
| `breaker`, `deniedStreak` | 6, 3 | network failures / refusals in a row before the source stops |
| `quality` | see config.mjs | post-run quality gate thresholds |
| `detailPages`, `listPagination`, `sideData` | see config.mjs | product-page completion, listing pagination, stock and reviews |
| `escalation` | 3 routes × 120 000 ms | paid escalation chain |
| `weightEstimate` | enabled, 1 kg/l, +10 % | liquid weight estimate (`enabled: false` turns it off) |
| `browserPageGapMs` | 3000 | spacing of pages read in the local browser |
| `watchdog` | stallMs 120 000, stopGraceMs 30 000 | see §10 |
| `catalogueTtl*Ms` | 7 / 7 / 14 days | site catalogue re-test periods |

## 10. Watchdog (B2)

The heartbeat runs for the WHOLE job, the last phase (category trail, stock
and reviews) and the browser close included. No progress for
`watchdog.stallMs` → the job is stopped as stalled and its signal aborts every
external wait (HTTP, recipe HTTP; the local browser is closed so its pending
page operations reject; `BrowserSession.close()` kills the browser process
after 10 s). A stop not finished `watchdog.stopGraceMs` after it was asked is
released the same way. The local browser gets a "a human solves it" handler
ONLY in intervention mode (a visible browser the user asked for), and that wait
ends with the job's signal (0.5.40 — before, a headless run met by a 403 waited
forever for a human who could not see the page: the real Adidas freeze).
Reason: status `stopped:stalled`, `stoppedByUser:
false`, `done.stalled`, `report.stopReason: 'stalled'`, ledger reason
`stalled`; end screen « Scraping arrêté : plus aucune progression », Jobs list
« Sans progression » (5 languages). The products already read are kept; the
job is resumable.

## Real checks (free, isolated, 0 $, 2026-10-21)

- mediamarkt.be TV listing: 30 products, 30 accepted, unchanged.
- adidas.be `/homme` (the job that froze for more than 10 minutes on
  2026-10-20): with 0.5.39 the watchdog fired at 124 s but the job still never
  ended (a headless human-intervention wait — fixed in 0.5.40); with 0.5.40 it
  ends in 107 s as `stopped:ACCESS_DENIED`, 3 products accepted (1 before: a
  single 403 no longer stops the source).
