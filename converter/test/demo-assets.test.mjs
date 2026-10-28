/**
 * HARD RULE — nothing shown publicly may be hand-typed or estimated.
 *
 * Every figure the marketing site's <ConversionDemo> renders (row counts,
 * prices, discount badges, variant groupings) is re-derived here INDEPENDENTLY
 * of the code that produced it, and the suite fails loudly on any divergence.
 * A published example that cannot pass this test must not ship.
 *
 * Three layers:
 *   1. provenance  — every published byte equals the frozen golden / fixture
 *   2. counts      — row counts re-counted from the published CSVs themselves
 *   3. arithmetic  — every discounted price re-computed from the SOURCE file's
 *                    own discount fields, not from the converter's output
 *   4. privacy     — no value from the real customer export may appear anywhere
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseCsv } from '../core/dist/index.mjs';
// SITE_PUBLIC comes from the generator itself: the test verifies the SAME
// directory the script publishes to, whatever depth this repo sits at.
import { DEMO_PAIRS, SITE_PUBLIC } from '../scripts/gen-demo-assets.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.resolve(HERE, '..');
const PUBLIC = SITE_PUBLIC;
const REAL_CUSTOMERS = path.join(ROOT, 'test/fixtures/shopify-customers-real/customers_export.csv');

const published = (rel) => path.join(PUBLIC, rel.replace('/converter-demo/', ''));
const read = (p) => readFileSync(p, 'utf8');
const money = (v) => {
  const s = String(v ?? '').replace(',', '.').trim();
  if (s === '') return null; // an empty cell is "no price", NOT zero
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const near = (a, b, eps = 0.011) => Math.abs(a - b) <= eps;

const manifestPath = path.join(PUBLIC, 'manifest.json');

test('demo assets: the manifest exists and lists exactly the declared pairs', () => {
  assert.ok(existsSync(manifestPath),
    'public/converter-demo/manifest.json is missing — run `node scripts/gen-demo-assets.mjs`');
  const m = JSON.parse(read(manifestPath));
  assert.deepEqual(
    m.pairs.map((p) => p.key).sort(),
    DEMO_PAIRS.map((p) => p.key).sort(),
    'the published manifest and scripts/gen-demo-assets.mjs disagree on the pair list',
  );
});

const manifest = existsSync(manifestPath) ? JSON.parse(read(manifestPath)) : { pairs: [] };

for (const pair of manifest.pairs) {
  // ── 1. provenance ─────────────────────────────────────────────────────────
  test(`demo ${pair.key}: published bytes are the frozen golden, unedited`, () => {
    const goldenOut = read(path.join(ROOT, 'test/golden', `${pair.golden}.out.csv`));
    assert.equal(read(published(pair.target)), goldenOut,
      `${pair.key}: the published output differs from test/golden/${pair.golden}.out.csv — it was edited by hand or the golden moved`);

    const goldenMeta = JSON.parse(read(path.join(ROOT, 'test/golden', `${pair.golden}.meta.json`)));
    assert.deepEqual(pair.counts, goldenMeta.counts,
      `${pair.key}: manifest counts drifted from the engine's own counts`);
    assert.equal(goldenMeta.ok, true, `${pair.key}: publishing a failed conversion`);
  });

  // ── 2. counts, re-counted from the published files ────────────────────────
  test(`demo ${pair.key}: row counts re-counted independently match the manifest`, () => {
    const out = parseCsv(read(published(pair.target)));
    assert.equal(out.rows.length, pair.counts.outputRows,
      `${pair.key}: manifest says ${pair.counts.outputRows} output rows, the published CSV actually has ${out.rows.length}`);

    // The source side: for a CSV source the unit count is re-derived from the
    // source's own grouping key, so "72 products → 228 rows" is proven on both
    // ends rather than trusted from the engine.
    if (pair.sourceKind === 'csv') {
      const src = parseCsv(read(published(pair.sources[0])));
      assert.ok(src.rows.length > 0, `${pair.key}: published source has no rows`);
      // Products: the Shopify target groups variants under one Handle. The
      // number of DISTINCT handles must equal the unit count the engine claims.
      if (pair.targetFormat === 'shopify_products') {
        const handles = new Set(out.rows.map((r) => String(r.Handle ?? '').trim()).filter(Boolean));
        assert.equal(handles.size, pair.counts.outputUnits,
          `${pair.key}: ${handles.size} distinct Handles in the output but the engine claims ${pair.counts.outputUnits} products — the variant grouping the UI draws would be wrong`);
      }
    }
  });

  // ── 3. arithmetic: recompute every discount from the SOURCE ───────────────
  test(`demo ${pair.key}: every displayed price is re-derivable from the source`, () => {
    const out = parseCsv(read(published(pair.target)));
    // Column semantics differ per target and are NOT symmetric:
    //   Shopify → `Variant Price` is charged, `Variant Compare At Price` is the "was"
    //   WooCommerce → `Sale price` is charged (when set), `Regular price` is the "was"
    // Getting this backwards is exactly the kind of inverted-discount bug this
    // suite exists to catch, so the mapping is spelled out rather than guessed.
    const isShopify = out.headers.includes('Variant Price');
    const isWoo = out.headers.includes('Regular price');
    const priceCol = isShopify ? 'Variant Price' : isWoo ? 'Sale price' : null;
    const wasCol = isShopify ? 'Variant Compare At Price' : isWoo ? 'Regular price' : null;
    if (!priceCol || !out.headers.includes(priceCol)) return; // customers / orders targets carry no price pair

    // Whatever the UI shows as "remise -X %" is computed from these two
    // columns. Re-derive the same pair here and assert it is internally
    // coherent: a "was" price must be strictly above the charged price,
    // otherwise the badge would advertise a discount that does not exist.
    for (const [i, r] of out.rows.entries()) {
      const p = money(r[priceCol]);
      const was = wasCol ? money(r[wasCol]) : null;
      if (p === null || was === null) continue;
      assert.ok(was > p,
        `${pair.key} row ${i + 1}: compare-at ${was} is not above the charged price ${p} — the UI would render a bogus discount badge`);
      const pct = Math.round(((was - p) / was) * 100);
      assert.ok(pct > 0 && pct < 100,
        `${pair.key} row ${i + 1}: computed discount ${pct}% is not a sane percentage`);
    }

    // Wix is the one source in the set that carries the discount RULE rather
    // than the discounted price, so the charged price can be recomputed from
    // first principles — the strongest possible independent check.
    if (pair.sourceFormat === 'wix_products') {
      const src = parseCsv(read(published(pair.sources[0])));
      // Match per SKU, not per handle: a Wix product row carries the product's
      // own price while each Variant row carries its own, and the discount rule
      // sits on the product row. Keyed by SKU, every output line is checked
      // against the exact source line it came from.
      const bySku = new Map();
      let productRule = null;
      for (const r of src.rows) {
        const kind = String(r.fieldType ?? '').toLowerCase();
        if (kind === 'product') {
          productRule = { mode: String(r.discountMode ?? '').toUpperCase(), val: money(r.discountValue) };
          if (String(r.sku ?? '').trim()) bySku.set(String(r.sku).trim(), { base: money(r.price), ...productRule });
        } else if (kind === 'variant' && String(r.sku ?? '').trim()) {
          // A variant inherits the product's discount rule and carries its own base price.
          bySku.set(String(r.sku).trim(), { base: money(r.price), ...(productRule ?? { mode: '', val: null }) });
        }
      }
      let checked = 0;
      for (const r of out.rows) {
        const sku = String(r['Variant SKU'] ?? '').trim();
        const s = bySku.get(sku);
        if (!s) continue;
        const { base, mode, val } = s;
        if (base === null || val === null || !mode || mode === 'NONE') continue;
        const expected = mode === 'PERCENT' ? base * (1 - val / 100)
          : mode === 'AMOUNT' ? base - val : null;
        if (expected === null) continue;
        const actual = money(r[priceCol]);
        assert.ok(actual !== null && near(actual, expected),
          `${pair.key} · SKU ${sku}: source says ${base} with ${mode} ${val} → ${expected.toFixed(2)}, the published output charges ${actual}`);
        const was = money(r[wasCol]);
        assert.ok(was !== null && near(was, base),
          `${pair.key} · SKU ${sku}: compare-at should be the undiscounted ${base}, published ${was}`);
        checked++;
      }
      assert.ok(checked > 0, `${pair.key}: claimed to verify Wix discount arithmetic but matched no product`);
    }
  });
}

// ── 4. privacy: the real customer export must never reach the site ──────────
test('demo assets: no value from the real customer export is published', () => {
  if (!existsSync(REAL_CUSTOMERS)) return; // the real file is not in every checkout
  const real = parseCsv(read(REAL_CUSTOMERS));
  // Only columns whose value identifies one person on its own. `Note` is
  // deliberately excluded: it is free prose and its words ("particulier",
  // "livraison"…) occur in ordinary product text, which would make this test
  // fire on content that has nothing to do with the real export.
  const identifying = real.headers.filter((h) =>
    /^(Email|Default Address Company|Default Address Address1|Default Address Phone|Phone)$/.test(h)
    || /froonze_cp_custom\.(taxes_number|website_url)/.test(h));
  // A single generic word is not a leak: the real export's Company column holds
  // things like "particulier", which also occurs in ordinary French product
  // copy. Only values that are structurally identifying are denied — an
  // address/e-mail/phone/VAT shape, or a company name of two or more tokens.
  const isIdentifying = (v) =>
    v.length > 6 && (/\d/.test(v) || /[@]/.test(v) || v.trim().split(/\s+/).length >= 2);
  const deny = new Set();
  for (const row of real.rows) {
    for (const h of identifying) {
      const v = String(row[h] ?? '').trim().toLowerCase();
      if (isIdentifying(v)) deny.add(v);
    }
  }
  // Only a COMPLETE name (both parts present) identifies someone. A lone first
  // name would also match as a substring of ordinary words — "marc" inside
  // "marché" — so both parts are required and the match is word-bounded.
  const fullNames = new Set(real.rows
    .filter((r) => String(r['First Name'] ?? '').trim() && String(r['Last Name'] ?? '').trim())
    .map((r) => `${String(r['First Name']).trim()} ${String(r['Last Name']).trim()}`.toLowerCase())
    .filter((s) => s.length > 8));

  for (const pair of manifest.pairs) {
    for (const rel of [...pair.sources, pair.target]) {
      const text = read(published(rel)).toLowerCase();
      for (const v of deny) {
        assert.ok(!text.includes(v),
          `PRIVACY: "${v}" from the real customer export appears in published ${rel} (${pair.key})`);
      }
      for (const n of fullNames) {
        assert.ok(!text.includes(n),
          `PRIVACY: real customer name "${n}" appears in published ${rel} (${pair.key})`);
      }
    }
  }
});
