# First live field test — "your browser" tier (v0.6.0)

Run on your machine, your real Chrome/Edge, your IP. No paid calls. Polite volume:
**≤ 3 listing pages + 5 detail pages per site per run**, adaptive pacing on.

## 0. One-time prerequisites (already done)

- Native host registered under HKCU (Chrome/Edge/Brave) → verified earlier.
- Stable extension ID: `acpkobbipplbgncgjkabebhmpojlndge`.

## 1. Build the extension folder

```powershell
npm run ext:build
```

## 2. Load / reload the extension

- `chrome://extensions` → Developer mode ON → **Load unpacked** → `C:\eloshon-scraper\extension` (or click the circular **reload** arrow on the card if already loaded).
- Confirm the card shows ID **`acpkobbipplbgncgjkabebhmpojlndge`** and **no red "Errors"** button.

## 3. Authorize the domain — IN THE EXTENSION (no config.json, no restart)

Activation is the **extension's host permission**, and it is the single source of
truth. In the extension popup, on the target site, click **« Activer ce domaine »**.
The extension announces its granted domains to the app live (over the bridge), so
the site becomes usable in **Nouveau scraping → Scraper via votre navigateur** the
moment you grant it — no `config.json` edit, no app restart.

`config.json` `yourBrowser.perDomain` is now **optional** and only carries per-domain
*pacing / limits / siteContext* — never activation. A legacy `"enabled": true` entry
still authorizes a domain (backward compatible), but you no longer need one.

```json
{
  "yourBrowser": {
    "pacing": { "baseIntervalMs": 1500 },
    "perDomain": {
      "colruyt.be": { "pacing": { "baseIntervalMs": 2500 } }
    }
  },
  "siteContext": { "colruyt.be": { "placeId": "604" } }
}
```

The store (`placeId`) stays user-configurable in `siteContext` — never hardcoded.

Optional per-run default limits (pre-fill the form; the app clamps them to hard
bounds: products 1–5000, listing pages 1–50, product pages 0–500):

```json
"yourBrowser": {
  "limits": { "maxProducts": 500, "maxListPages": 3, "maxDetailPages": 5 },
  "perDomain": { "<domain>": { "limits": { "maxListPages": 2 } } }
}
```

Pacing (`pacing` global, `perDomain.<domain>.pacing`) is sent with each job and
applied by the extension (floors: `baseIntervalMs` ≥ 800, `minIntervalMs` ≥ 400).
A subdomain (e.g. `www.` or `shop.`) is covered by its parent domain's grant.
The whole tier can be turned off with `yourBrowser.enabled: false` (admin kill-switch).

## 4. Start the app

```powershell
npm start
```

On start you will see in the app log:
`[yourBrowser] pont démarré — en attente de l'extension (autorisation des domaines côté extension)`
(or `inactif (feature_off)` only if `yourBrowser.enabled: false`).

## 5. Expected popup state when it works

Open the extension popup. It must show:
- **Application : connectée** (was "application fermée" before this wiring)
- **Navigateur : Chrome** (or Edge / Brave)
- **Domaine actif** = the site's host; **Autorisation** = *accordée* after you click
  **Activer ce domaine** once (per-domain host permission, your gesture).
- During a run: **Travail : en cours** → on a challenge, **en pause (défi)** with
  *action requise : résous le défi dans l'onglet*, then auto-resume.

## 5b. Launch a run from the app (v0.5.13+)

1. **Nouveau scraping** → paste the start page address (a listing/category page).
2. Under **Mode de scraping**, pick **Scraper via votre navigateur**. It is greyed
   ("Ce mode n'est pas encore configuré pour ce site") for a domain without the
   opt-in flag; it asks to install/connect the extension when the popup is not
   connected.
3. Adjust **Limites de ce scraping** if needed → **Démarrer via votre navigateur**.
4. A background tab opens in Chrome/Edge. The app shows CONNEXION → EN COURS; on a
   challenge, EN PAUSE (DÉFI) with *résous le défi dans l'onglet* — solve it in the
   tab, the run resumes by itself (**Reprendre** is also offered). **Abandonner**
   stops the run.
5. The result appears in **Jobs** with the badge *Votre navigateur*, **Résultats**
   and **Rapport** like any job (blocked/abandoned/failed runs too). No automatic
   retry: a blocked run just reports blocked.

## 6. Test order and what to record

Run **Colruyt first (control)**, then Adidas, Leroy Merlin, Delhaize. For each:

| Field | Note |
|---|---|
| Loaded / Blocked | did the listing render in the tab? |
| Status codes | 200 / 403 / 429 / 456 / 503 seen |
| Challenge shown | none / Cloudflare / DataDome / captcha |
| Strategy | human-in-the-loop / cooldown / hand-back |
| Your solve time | seconds you spent on a challenge, if any |
| Recurrence | how many times the challenge came back |
| Products | count extracted |
| Fill rate | % with name / price / image / url / id |
| Time / page | rough seconds |
| Pacing decisions | from the diagnostic (interval, backoff, cooldown) |

Colruyt note: the API answered **456 after ~40 rapid calls** earlier — the adaptive
pacer should now back off automatically; watch that it does. Adidas (Akamai),
Leroy Merlin (DataDome) and Delhaize are the block-hypothesis tests: a real browser
with your IP/session may pass where cloud tiers failed.

## 7. Send back

The verdict table (this file's columns) filled per site, plus the diagnostic export
(no secrets) if a site misbehaves. That decides "pass / pass-with-human-intervention
/ partial / blocked" per site.

## Notes / limits

- The tier is a real browser: no captcha solving, no fingerprint/IP spoofing, and it
  never clicks or types inside a challenge — you solve those in the tab, it resumes.
- If the popup stays "application fermée" after `npm start`: confirm the opt-in flag
  is set (else the bridge does not start by design) and that the host manifest path
  is valid (`npm run host:gen`).
