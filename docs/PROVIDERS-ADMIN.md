# Providers admin panel — design note (v0.5.10)

Owner-only management of the paid scraping providers **inside** the desktop app:
Bright Data Web Unlocker, Bright Data Scraping Browser, Firecrawl, Zyte. Enter /
replace / delete credentials, test the connection (free only), set caps, see usage,
enable/disable per provider and per domain. ADMIN-ONLY, enforced in the main
process. No live/paid call is made by this feature's build; the owner runs the
live tests.

## Secrets hygiene (non-negotiable)

- Secret VALUES live only in the OS-encrypted secure store (Electron `safeStorage`,
  blob under userData). Never in `config.json`, logs, IPC messages, reports,
  diagnostics or the renderer.
- The renderer only ever receives booleans, masked state (`configured`/`incomplete`),
  timestamps and counts — never a value.
- Env-var-NAME fallback (today's mechanism) is kept: resolution order is
  **secure store → config.json block → env var NAME**.

## Hook points (minimal, additive — safe alongside feat/v0.6.0)

| Where | Change |
|---|---|
| `app/main.mjs` whenReady | create `AdminSession` + `SecureStore` + `ProviderRuntime`; register admin-gated IPC (few lines). |
| `app/preload.cjs` | add a small `admin` surface (invoke-only). |
| `app/controller.mjs` (paid-lane section ~ lines 377, 586–622) | before each billable call, consult `runtime.isAvailable(providerId, domain)`; record usage / skip reason for the admin log. When nothing is configured, `isAvailable` reflects today's `configured` check → **behaviour unchanged**. |
| `app/renderer/*` + `i18n/*` | new "Administration" entry + "Fournisseurs" panel. |

Injection: after `appCfg = readJson(configFile)`, `runtime.applyTo(appCfg)` merges
decrypted creds into `appCfg.brightData/firecrawl/zyte` (secure store first). The
existing `*Config(appCfg, env)` lanes then work unchanged.

## Files to add

```
core/providers/registry.mjs     # descriptors (id,label,fields[secret],capabilities,costModel,envNames,configPath,freeCheck?)
core/providers/runtime.mjs      # switches + per-domain toggles + caps + usage + effective availability + admin log (pure, injected storage)
core/providers/import-env.mjs   # map .env NAMES -> provider fields (names/booleans only, values never logged)
core/unlock/zyte.mjs            # minimal Zyte lane (HTTP + browserHtml), creds via registry
app/admin/secure-store.mjs      # safeStorage wrapper (set/replace/delete/has/test/import) — main process
app/admin/session.mjs           # scrypt passphrase hash, unlock/lock, auto-lock, growing failure delays, reset
app/admin/ipc.mjs               # admin-gated IPC handlers (enforcement wrapper: every handler checks the session)
```

## Data formats (migration-safe, additive)

- `config.json`: **new optional** `providers` block — switches + caps + per-domain
  toggles + usage counters (NO secrets). Absent ⇒ all defaults, feature dormant.
- `admin.json` (userData): `{ scrypt: {salt, N, r, p, hashHex}, autoLockMs, failCount, lockedUntil }` — never a plaintext passphrase.
- `providers.secret` (userData): safeStorage-encrypted JSON `{ [providerId]: {field:value} }`.
- Per-domain toggles reuse the existing `domain-profiles.json` / `siteContext`
  shape (a `providers` sub-object per domain) — recipe content/revisions untouched.

## Admin lock design

- Locked by default. First unlock creates the passphrase (entered twice) → stored as
  scrypt hash (`node:crypto`, N=16384,r=8,p=1, 32-byte salt). Unlock = verify hash.
- Auto-lock after inactivity (default 15 min, editable) and on app close.
- Growing delay after failures: `min(2^fails * 1s, 5 min)`; persisted in `admin.json`.
- **Enforcement**: every provider IPC handler runs through `requireAdmin()` in the
  main process; when locked it returns a generic refusal `{ok:false, locked:true}`
  with no data. Renderer state is never trusted.
- Non-admins see nothing: the only entry point is a discreet "Administration" item
  that asks for the passphrase; no provider name/cost/usage appears anywhere else
  (report, export, logs, diagnostics, errors).

### Passphrase reset procedure (no backdoor)

There is no recovery of a forgotten passphrase. Reset = delete `admin.json` AND
`providers.secret` (the secure store), then relaunch: the panel returns to
"create passphrase", and **all provider keys must be re-imported**. Exposed as an
explicit "Réinitialiser l'administration (efface les clés)" action requiring a typed
confirmation, and runnable manually by deleting those two files in userData.

## Owner identification

`edgeLicense` exists in config (value never read here). It COULD identify the owner,
but a licence check is an entitlement, not an auth secret. Default stays the
passphrase; using `edgeLicense` is an [USER DECISION] option.

## Provider cost models & free checks

- **Bright Data Web Unlocker**: per successful request. Free check: none documented
  as free → format check only ("aucun test gratuit disponible").
- **Bright Data Scraping Browser**: billed by TRAFFIC (~$8/GB; balance ~$7.47 →
  conservative default caps). Free check: format only.
- **Firecrawl**: credit-based (1 credit per scraped page for the lane's options).
  Free check: `GET /v2/team/credit-usage` (read-only, no scrape; API v2 since
  v0.5.37, answer `remainingCredits`, `planCredits`, `billingPeriodEnd`).
- **Zyte**: per successful request, price varies with site difficulty. Free check:
  none billable → format only. Lane per Zyte API docs (HTTP body + browserHtml).

Every "test connection" uses only a documented-free call or a local format check;
it NEVER sends a billable request.

## Licence seam (PROPOSAL only — not built)

To sell paid tiers without shipping keys to customers: provider calls route through
the owner's backend, authenticated by an opaque licence token; the backend holds the
keys and enforces per-customer caps. The `ProviderRuntime.isAvailable` +
`resolveCredentials` seam is where a "remote credential provider" would plug in.
