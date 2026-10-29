# Roadmap & ideas for contributors

A living list of things we would love help with. Each item is meant to be a **small, self-contained issue**. Pick one, comment on (or open) the matching issue so nobody duplicates work, then follow [CONTRIBUTING.md](../CONTRIBUTING.md).

Legend: 🟢 good first issue · 🟡 some familiarity with the code needed · 🔴 deeper design work

## Eloshon Converter

- 🟢 **Add a UI language** (German, Italian, Portuguese): copy an existing `i18n-*.js` file in `converter/app/renderer`, translate, and make the parity test pass.
- 🟢 **Review the wording** of the review step (Step 4) messages in your language: clear for a non-technical shop owner?
- 🟢 **Add a regression sample**: found an export that mis-maps a column? Add a *synthetic* file under `converter/test/fixtures` and a golden test.
- 🟡 **More localised header dictionaries** for WooCommerce exports (the French one lives in `converter/core/src/localized-headers.ts`): add the language of your admin panel.
- 🟡 **New target platform** (e.g. PrestaShop as a *destination*; today it is a source only): see how `wix.ts` / `bigcommerce.ts` serialise, and `converter/docs/adapters-design.md`.
- 🟡 **Better "unknown format" learning**: suggest column meanings from value shapes (EAN, weights, URLs, HTML) and cover them with tests.
- 🔴 **Customers and orders** for more platform pairs: see `converter/docs/phase6` and `phase7`.

## Eloshon Scraper & extension

- 🟢 **Documentation**: a step-by-step "teach the scraper a new site" guide with screenshots (see `docs/EXTENSION.md` and `docs/SITE-KNOWLEDGE.md`).
- 🟡 **`robots.txt` support** (`Disallow`, `Crawl-delay`) as an opt-in, honoured by default for polite crawling.
- 🟡 **More extraction archetypes**: describe a site shape that fails and add a generic reader with a test (see `docs/archetypes-and-limits.md`). Reader logic must stay generic — never keyed on a site name.
- 🟡 **Listing detection fallbacks** for pages without clear product cards.
- 🔴 **macOS and Linux** support for the desktop app and the native-messaging bridge.

## Project health

- 🟢 **Screenshots / GIFs** of the apps in your language for the README.
- 🟢 **Typos and broken links** in `docs/`.
- 🟡 **Release workflow**: a GitHub Action that builds the Windows installers on a version tag and attaches them to a Release.
- 🟡 **Test speed**: find slow tests and make them faster without losing coverage.

Have another idea? Open an [issue](../../../issues/new/choose) — a clear problem statement is already a great contribution.
