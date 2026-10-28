# Phase 0 — Step 0 : Inventory & equivalence (standalone ↔ canonical)

> Date : 2026-10-03. Read-only inventory executed before any Phase 0 change.
> Decision implemented: **canonical engine = `C:\eloshon-scraper\converter\`** ;
> the standalone repo `C:\eloshon-converter` is retired (owner-executed, see
> `phase0-retire-standalone.md`). Every claim below was verified on disk and in
> git history; the standalone was only read, never written.

## 1. Repos involved

| Repo | Role | State at inventory |
|---|---|---|
| `C:\eloshon-scraper` | Monorepo (GitHub `Eloshon-1040/apps`), contains the canonical `converter/` | branch `feat/v0.5.10-providers-panel` @ `75f62b1`, clean tree; local `main` is stale; `origin/main` (locally known) = `a177fd9` (PR #12, v0.5.11) and is **content-wise an ancestor of the feature branch** (only the merge-commit node differs) |
| `C:\eloshon-converter` | Standalone converter (retired) | own git repo, last commit `1c07990` (2026-09-22 18:19), clean except one untracked fixture |
| `C:\eloshon-catalog` | `@eloshon/catalog` (pivot types, `.eloshon`, ports) | separate unversioned-from-here dependency; type-only consumer |

History note **[OBSERVATION]**: the canonical copy absorbed the standalone tree the same evening as the standalone's last commit (`776688b`, 19:56) and then advanced past it (`440c5a0` “pre-generate ICO icons to avoid electron-builder OOM”, 20:56, + lockfile regeneration to 0.1.1). **Canonical is strictly newer wherever the two differ.**

## 2. Equivalence result (file-by-file, line-ending-insensitive)

**[OBSERVATION]** 433 git-tracked files are identical on both sides (`diff -rq --strip-trailing-cr`, excluding `node_modules`/`.git`/`out`/`core/dist`; even the gitignored `core/dist` build output is byte-identical). The only differences:

| File | Difference | Verdict |
|---|---|---|
| `package.json` | icons: standalone `build/icon.png` vs canonical `build/icon.ico` (win/mac/linux, lines 54/66/73) | canonical newer (`440c5a0`), keeps `build/icon.ico` (tracked, 7-image ICO incl. 256×256). **Do not migrate.** Caveat: `.ico` is wrong for the mac/linux targets — fixed in Step 2. |
| `package-lock.json` | standalone still says `0.1.0` (stale vs its own `package.json` 0.1.1) | canonical consistent. **Do not migrate.** |
| `tsconfig.json` | catalog path `../eloshon-catalog` vs `../../eloshon-catalog` | each correct for its own nesting depth; canonical value (`../../` → `C:\eloshon-catalog`) is the right one for the surviving location. **Do not migrate.** |

Tracked files unique to one side:
- Standalone only: `scratch/tools/*.mjs` (9 extraction scripts) — **already present byte-identical and tracked at the monorepo root** `C:\eloshon-scraper\scratch\tools\`. Zero loss.
- Canonical only: `converter/build/icon.ico` (the 440c5a0 addition).

## 3. Migration list (what Step 1 moves; everything else is covered)

1. **MIGRATED (Step 1):** `test/fixtures/scraper/scrap lidl be.csv` — 1.5 KB real Lidl-BE scrape sample (no PII), created in the standalone *after* the monorepo import, untracked there; the only substantive content that existed solely in the standalone. Committed in the canonical copy.
2. **OWNER, BY HAND, NEVER COMMIT:** any keys in `C:\eloshon-converter\.env.local` still missing from `C:\eloshon-scraper\.env.local` (contents deliberately not read in Phase 0). Then securely delete the standalone file. This is the only item whose silent retirement could lose secrets.
3. **OWNER, OPTIONAL (untracked by design):** 19 Shopify-analytics skill folders in `C:\eloshon-converter\.claude\skills\` absent from `C:\eloshon-scraper\.claude\skills\` (5 others already there byte-identical). Reinstallable pack — copy only if still used.
4. **OWNER, OPTIONAL (regenerable):** `scratch/tools/out/` demo-store API captures (~1.5 MB) — regenerable by the 9 scripts; if hand-copied to the monorepo root, first add a `scratch/tools/out/` rule to the **root** `.gitignore` (only `converter/.gitignore` has it today).
5. **NEVER MIGRATE — securely delete with the standalone:** `C:\eloshon-converter\test\fixtures\shopify-customers-real\customers_export.csv` (real personal data of ~4 204 people; 518 681 bytes). Verified: never tracked in either repo; absent from canonical disk; `converter/.gitignore:16` blocks the path in the monorepo (`git check-ignore` confirmed). The tracked synthetic twin `test/fixtures/shopify-customers-synthetic/` keeps all test coverage.
6. Disposable, no action: `out/` installers (standalone additionally holds the obsolete 0.1.0 setup), the empty `test/fixtures/live/Nouveau dossier/`, `.mcp.json` (identical).

## 4. How the canonical copy resolves `@eloshon/catalog` and its scripts

**[OBSERVATION]**
- `tsconfig.json:7` → `../../eloshon-catalog/index.d.ts` → `C:\eloshon-catalog\index.d.ts` (exists). `tsc --noEmit` (TypeScript 5.9.3) verified **exit 0** from `C:\eloshon-scraper\converter`.
- The dependency is type-only: the sole reference is `core/src/types.ts:139-152` (`export type { … } from '@eloshon/catalog'`, all 25 names verified present in the catalog); transpiled `core/dist/types.mjs` is `export {}`. **No runtime import of the catalog anywhere** (grep over `core/dist` + `app/`); the packaged app never needs it.
- Every npm script is safe when run with cwd = `converter/` (i.e. `npm --prefix converter run …`): all scripts and tests anchor paths via `import.meta.url` (e.g. `scripts/build-engine.mjs:12`, `test/regression.test.mjs:20`). `node --test` glob expansion needs Node ≥ 21 on Windows (installed: v24.18.0).

**[NÉCESSITÉ TECHNIQUE]** One anchor broke in the move and fails the suite today: `test/demo-assets.test.mjs:23-25` and `scripts/gen-demo-assets.mjs:20-22` resolve the marketing site as `ROOT/../eloshon/public/converter-demo` — correct from `C:\eloshon-converter`, wrong from `C:\eloshon-scraper\converter` (would even publish into a stray `C:\eloshon-scraper\eloshon\`). The real site assets exist at `C:\eloshon\public\converter-demo` (manifest present). Fixed in Step 1 by a single shared, env-overridable resolver (`ELOSHON_SITE_DIR`), exported by the generator and imported by the test so the two can never drift again.

Baselines before any Phase 0 change **[OBSERVATION]**:
- Converter suite (`npm test` in `converter/`): **316 pass / 1 fail** — only the demo-assets anchor above.
- Scraper suite (`npm test` at root): **950 pass / 0 fail / 1 skipped**.

## 5. Packaging independence (input to Step 2)

**[OBSERVATION]**
- Scraper installer: electron-builder from the repo root → `dist/`, files globs `app/**, core/**, shared/**, lib/**, native-host/**` — **`converter/**` is not included** (`package.json:42-53`), and output dirs/artifact names cannot collide (`dist/Eloshon Scraper Setup *.exe` vs `converter/out/Eloshon-Converter-Setup-*.exe`).
- Converter installer: `npm run dist` inside `converter/` → `converter/out/`; `build/icon.ico` valid (7 sizes incl. 256×256); buildResources picked up by path, not by `files`.
- Both toolchains currently resolve to identical electron 44.4.1 / electron-builder 26.15.3, from **separate** `node_modules`. No code signing configured anywhere (both installers unsigned — SmartScreen will warn; owner decision before distribution).
- Runtime-coverage audit of the converter `build.files` globs: **every runtime import / fs-read is covered** (full enumeration in the Step 0 run); `core/knowledge-proposal/schema.json` is excluded but is test-only today (latent trap noted — README calls it “validation runtime”).

**[NÉCESSITÉ TECHNIQUE]** gaps closed in Step 2 (gate-the-artifact rules):
- `scripts/build-engine.mjs` is the only thing standing between a fresh clone and a **broken installer** (electron-builder tolerates the unmatched gitignored `core/dist/**/*` glob; the packaged app would crash at `app/controller.mjs:12`). It must clean `core/dist` before building and fail non-zero unless it produced > 0 modules including `index.mjs`.
- The scraper build’s exclusion of `converter/` is implicit (positive globs). A `!converter/**` guard makes it explicit.
- A root-level `dist:converter` script makes the independent build discoverable and keeps `npm run dist` (with its build:engine gate) the only documented path.
- Converter mac/linux icons point at `.ico` (invalid there); win stays `.ico`.

## 6. Gitignore / secrets posture (input to Step 1)

**[OBSERVATION]** `git check-ignore -v` verified: `converter/core/dist`, `converter/out`, `converter/node_modules`, `converter/.env.local`, and the real-customers dir are all ignored; nothing generated is tracked. Gaps: `converter/.env` is covered **only** by the root `.gitignore:17` (would become committable if converter were ever split out again); `.env.<suffix>` variants that are not `.local` (e.g. `.env.production`) and `*.secret` files are ignored **nowhere**. Step 1 adds `.env`, `.env.*`, `*.secret` to `converter/.gitignore`.

## 7. Out-of-scope observations recorded for later phases

- `verify-core` / `verify-controller` import `core/dist` without running `build:engine` first → fail on fresh clone until `npm run build:engine` (left as-is; `npm test`/`npm run dist` both chain the build).
- `tsc` covers `core/src` only; `app/`, `scripts/`, knowledge `.mjs` are never typechecked.
- Catalog coupling is by absolute machine layout (two levels above the repo root) with no commit pin — a clone without `C:\eloshon-catalog` fails typecheck (runtime unaffected).
- Scraper `mac.icon` also points at `.ico` (`package.json:82`) — same latent mac issue as the converter’s; not touched in Phase 0 (scraper installer must not be altered beyond the `!converter/**` guard).
