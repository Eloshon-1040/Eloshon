# Contributing to Eloshon

[Français](CONTRIBUTING.fr.md) · **English**

Thank you for wanting to help! This project is released under the [PolyForm Noncommercial License 1.0.0](LICENSE): the code is open to read, run and improve, but **commercial use is reserved to Eloshon** (see [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)). Contributions are welcome under the agreement below.

## Contribution agreement (required)

By submitting a contribution (pull request, patch, or code in an issue) you declare that:

1. you wrote it, or you have the right to submit it;
2. you publish it under the project's licence (PolyForm Noncommercial 1.0.0);
3. you additionally grant Eloshon a worldwide, perpetual, royalty-free, non-exclusive licence to use, modify, sublicense and distribute your contribution **under any licence, including a commercial one**;
4. you keep the ownership of your contribution.

Sign every commit with `git commit -s` (it adds a `Signed-off-by: Name <email>` line). A pull request without it will not be merged.

## Ways to help

| You are… | Good first contributions |
|---|---|
| A **shop / data person** | A platform export that is mis-read, a column that lands in the wrong field — report it with a small *synthetic* sample |
| A **developer** | Fix a bug with a regression test; add a source or target format; improve an extractor |
| A **translator** | Fix wording or add a missing UI string (Converter: FR/EN/NL/ES; Scraper: also DE) |
| A **writer** | Clarify the README and [`docs/`](docs), add examples |

Browse issues labelled **good first issue** and **help wanted**, or see [`docs/ROADMAP.md`](docs/ROADMAP.md) for ideas.

## Set up

```bash
git clone https://github.com/Eloshon-1040/Eloshon.git
cd Eloshon
npm --prefix converter ci          # Converter
npm ci                             # Scraper
```

Requirements: Windows 10/11, Node.js 22+, npm, Git. See the [README](README.md#quick-start) for how to run each app.

## Workflow

1. **Open an issue first** for anything bigger than a small fix: it avoids work that cannot be merged.
2. Fork the repository and create a branch: `fix/shopify-weight-unit`, `feat/wix-orders`…
3. Make small, focused commits with clear messages (`fix(converter): …`, `feat(scraper): …`), signed with `-s`.
4. Run the tests (below). **One bug fixed = one regression test** that fails before your change and passes after.
5. Open a pull request using the template and describe *what* and *why*.

## Tests

```bash
npm --prefix converter test        # builds the engine, runs the Converter suite
npm test                           # Scraper, extension, native host (build the Converter engine first)
```

The Converter keeps **golden files** in `converter/test/golden` (the exact expected output of each source → target pair). If your change alters an output on purpose, regenerate them with `npm --prefix converter run gen:golden` and explain the diff in the pull request. `npm run smoke:live` and the `verify-*` scripts use real networks: do not run them in a pull request.

## Code conventions

- Match the surrounding code: naming, comment density and idioms. No new framework or build tool without discussion.
- The Converter engine is pure TypeScript in `converter/core/src` (no I/O, deterministic). Anything that touches the file system or Electron belongs in `converter/app`.
- Every visible text exists in **all interface languages** (`converter/app/renderer/i18n*`, `app/renderer/i18n/`); a parity test enforces it. No hard-coded user-facing string.
- No business values hard-coded (prices, limits): read them from configuration.
- Test fixtures are **synthetic**: no real customer data, e-mail addresses, store names or catalogs copied from third-party sites.

## Not accepted

- keys, tokens, passwords, `.env` files;
- personal data or exports of real shops;
- code copied from a project whose licence forbids this reuse;
- work meant to harm a website or a service (attacks, abuse of protections).

## Security

Report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

## Behaviour

Be kind. See the [code of conduct](CODE_OF_CONDUCT.md).
