# Phase 0 — Step 3 : Retiring the standalone repo `C:\eloshon-converter`

> The canonical converter is **`C:\eloshon-scraper\converter\`** (decision #1).
> Phase 0 migrated the only valuable standalone-unique artefact
> (`test/fixtures/scraper/scrap lidl be.csv`, commit `629caa9`). Deleting the
> standalone is **irreversible**, so this guide is ordered like a guarded
> destructive operation: every verification comes BEFORE the first deletion,
> and any failing check means **stop — do not delete anything**.

## 0. Preconditions (all must hold; each command must succeed)

Run in **Git Bash**. Every block prints `OK …` on success; any other output =
stop and investigate before going further.

```bash
# (a) The canonical tree contains everything the standalone tracks, byte-identical
#     (line endings ignored; generated/ignored dirs excluded).
diff -rq --strip-trailing-cr \
  -x node_modules -x .git -x out -x dist -x .claude -x "scratch" \
  -x "shopify-customers-real" -x ".env.local" -x "Nouveau dossier" \
  /c/eloshon-converter /c/eloshon-scraper/converter \
  && echo "OK trees equivalent"
```

The one expected tolerance: the three config files (`package.json`,
`package-lock.json`, `tsconfig.json`) differ **by design** — the canonical side
is the newer/correct one (see `phase0-inventory.md §2`). If the diff reports
ONLY those three files, that is `OK` too. Anything else: stop.

```bash
# (b) Nothing uncommitted is sitting in the standalone besides the known items.
git -C /c/eloshon-converter status --porcelain
# Expected: empty, or ONLY "?? test/fixtures/scraper/scrap lidl be.csv"
# (already migrated). Any other line: stop and triage it first.
```

```bash
# (c) The canonical converter is green from inside the monorepo.
cd /c/eloshon-scraper/converter && npm run typecheck && npm test \
  && echo "OK canonical suite green"
```

```bash
# (d) The migrated fixture really is in the canonical tree and in git.
git -C /c/eloshon-scraper ls-files "converter/test/fixtures/scraper/scrap lidl be.csv" \
  | grep -q . && echo "OK fixture tracked"
```

## 1. Secrets — BY HAND, before anything is deleted

`C:\eloshon-converter\.env.local` was never read during Phase 0. It may hold
connector keys (Wix / Shopify / Shopware / BigCommerce names were observed in
an earlier audit) that are missing from `C:\eloshon-scraper\.env.local`.

1. Open both files yourself and merge any key still needed into
   `C:\eloshon-scraper\.env.local`.
2. While there: **rotate the Wix API key** (it leaked into a session transcript
   via the malformed first line) and fix the malformed lines — `KEY: value`
   must become `KEY=value`, and the two decorative `… ANTHROPIC_API_KEY` lines
   should become real assignments or `#` comments. The hardened importer
   (Phase 0 Step 5) now *warns* on such lines instead of silently dropping
   them, but it still cannot invent the `=`.

## 2. The real-customer export — secure delete, never copy

`C:\eloshon-converter\test\fixtures\shopify-customers-real\customers_export.csv`
holds real personal data of ~4 204 people. Verified in Phase 0: it exists
**only** there (never tracked in any repo; absent from the canonical disk;
blocked by `converter/.gitignore:16` in the monorepo). The tracked synthetic
twin keeps all test coverage.

- Do **not** copy it into the monorepo or anywhere else.
- Securely delete the directory (e.g. with `sdelete -p 3 -r`, or at minimum
  normal deletion followed by recycle-bin purge), or archive it OUTSIDE any
  repository if you have a legal/retention reason to keep it.

## 3. Optional salvage (skip freely; all regenerable/reinstallable)

| Item | If you want it |
|---|---|
| 19 `.claude/skills/` folders (Shopify-analytics pack) absent from the monorepo | copy into `C:\eloshon-scraper\.claude\skills\` (stays untracked by design) |
| `scratch/tools/out/` demo-store API captures (~1.5 MB) | re-runnable via `C:\eloshon-scraper\scratch\tools\*.mjs`; if copying instead, FIRST add `scratch/tools/out/` to the **root** `.gitignore` |
| `out/Eloshon-Converter-Setup-0.1.0.exe` (historical installer) | copy the `.exe` somewhere outside both repos |

## 4. Archive, then delete

```bash
# (e) Full-fidelity archive of the standalone's git history (cheap insurance;
#     the content is replicated in the monorepo, the HISTORY graph is not).
git -C /c/eloshon-converter bundle create \
  /c/eloshon-scraper/converter/docs/archive-eloshon-converter-standalone.bundle --all \
  && git bundle verify /c/eloshon-scraper/converter/docs/archive-eloshon-converter-standalone.bundle \
  && echo "OK bundle archived"
```

Keep the bundle somewhere you back up (it is small — the repo minus
node_modules/out). Do **not** commit it unless you want ~a few MB of history in
the monorepo; moving it to a backup drive is the better home.

```bash
# (f) Only after 0–2 all passed and the bundle verifies:
rm -rf /c/eloshon-converter && echo "standalone retired"
```

## 5. After deletion

- If any editor/session/shortcut still points at `C:\eloshon-converter`, repoint
  it to `C:\eloshon-scraper\converter`.
- The marketing-site demo assets need nothing: `scripts/gen-demo-assets.mjs`
  now finds `C:\eloshon` from the monorepo depth (and honours
  `ELOSHON_SITE_DIR`), and the published assets under
  `C:\eloshon\public\converter-demo` were already verified against the
  canonical goldens by the test suite.
- `C:\eloshon-catalog` stays where it is: the canonical `tsconfig.json` reaches
  it at `../../eloshon-catalog` (verified passing).
