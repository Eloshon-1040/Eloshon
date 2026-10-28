# Runbook — provider admin panel (v0.5.10, owner only)

You run every live test yourself. The build makes **no** live or paid call.

> **Since v0.5.17** the panel is a page: sidebar › **Administration** (lock
> icon), tabs *Fournisseurs*, *Utilisation*, *Domaines*, *Coûts*. Every step
> below still exists in the *Fournisseurs* tab; per-site paid-route opt-in is in
> *Domaines* (it writes `firecrawl.domains` / `brightData.domains` /
> `brightData.scrapingBrowserDomains` for you), and every call, block and cost
> estimate is in *Utilisation*. See `docs/USAGE-LEDGER.md`.
>
> **Since v0.5.18** a listing run also reads the next listing pages and each
> product page over free HTTP (colour, sizes + EAN, gallery, description). The
> result screen says how many pages were read, the total the site announces, and
> warns when the rest of the list loads on scroll and could not be followed. See
> `docs/LISTING-AND-PRODUCT-PAGES.md`.

## 1. Install

Optional — uninstall the previous version first (keeps your userData: config.json,
domain-profiles.json are preserved by the NSIS installer):
```powershell
Get-Package "Eloshon Scraper" -ErrorAction SilentlyContinue | Uninstall-Package
```
Install the new build (path printed by the build; adjust the version):
```powershell
Start-Process "C:\eloshon-scraper\dist\Eloshon Scraper Setup 0.5.10.exe"
```

## 2. First admin unlock (create the passphrase)

- Launch the app. Click the discreet **Administration** button (bottom-left).
- Enter a passphrase twice (≥ 8 chars) and create it. **Store it safely** (a password
  manager): there is **no recovery**. If you forget it, the only path is **Réinitialiser**,
  which erases the passphrase **and all stored keys** — you would re-import them.

## 3. Import your keys

- In the panel, click **Importer un .env** and pick:
```
C:\eloshon-scraper\.env.local
```
- Review the preview (names → provider, e.g. `FIRECRAWL-API-KEY → Firecrawl`), then
  **Importer**. Unrecognised names (Wix/Shopify/…) are listed and ignored. The file is
  read, never copied; values go straight into the OS-encrypted store.

## 4. Test each connection (free only)

- Click **Tester la connexion** on each card. In this build the test is a **free format
  check** ("aucun test gratuit disponible pour ce fournisseur — un test réel serait
  facturé"). It never sends a billable request. A card shows *actif / non configuré /
  incomplet / désactivé*.

## 5. Set the caps (budget guardrails)

- Per card, set **appels/job** and **appels/mois**. For **Bright Data Scraping Browser**
  (billed ~8 $/Go, balance ~7,47 $) the defaults are conservative (≈40 Mo/job, ≈500 Mo &
  4 $/mois). Adjust and **Enregistrer les plafonds**. A hit cap disables the provider with
  a clear status until the month rolls over or you raise it.

## 6. Disable providers one by one (verify the effect)

- Toggle a provider **activé** off → its card shows **désactivé**; a run will not call it
  (credentials are withheld before any billable call). Toggle **Tout désactiver** (master
  kill) → all four show disabled. Re-enable to restore.

## 7. Enable a provider on one domain

- Under **Domaines**, add e.g. `adidas.be`, then tick only the provider(s) you want for
  that domain. Effective use = provider ON **and** domain ON **and** configured **and**
  under caps **and** kill switch OFF.

## 8. Lock and verify as a non-admin

- Click **Verrouiller** (or wait 15 min inactivity, or close the app). Reopen the panel:
  it asks for the passphrase and shows **no** provider name, cost, usage or key state.
  Confirm that nowhere else in the app (reports, exports, job screens, errors) any
  provider detail appears.

## 9. Run your own scraping tests

- Configure a per-domain opt-in as before and run a job on an opted-in domain. Then open
  the panel → **Journal administrateur** and check, per provider: *configuré*,
  *activé pour ce domaine*, *appels*, *coût estimé*, and the *raison* when skipped
  (e.g. "Bright Data : non configuré pour ce domaine"). The **user-facing** job report
  only ever says generic wording ("palier avancé non disponible pour ce site").

## If something fails — what to send back

Send: the exact on-screen message, the provider card status, and the relevant admin-log
row. **Never** send a key value or your passphrase. If "Tester la connexion" or a run
errors, note the status word (non configuré / incomplet / erreur) and the admin-log
`raison`. If the panel says "Stockage sécurisé indisponible", tell me your OS/session
(safeStorage needs an OS keychain/DPAPI); the env-var-NAME fallback still works meanwhile.

## Reset (forgotten passphrase)

Panel → unlock screen → **Phrase oubliée / réinitialiser** → type `REINITIALISER`. Or
manually delete both files in userData and relaunch (then re-import keys):
```powershell
Remove-Item "$env:APPDATA\Eloshon Scraper\admin.json","$env:APPDATA\Eloshon Scraper\providers.secret" -ErrorAction SilentlyContinue
```
