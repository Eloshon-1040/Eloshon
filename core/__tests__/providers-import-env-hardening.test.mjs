/**
 * Phase 0 — env-importer hardening (SYNTHETIC fixture only, never a real .env).
 *
 * The real-world failure: .env.local lines written as `KEY: value`, decorative
 * prose lines, a BOM on line 1, `export KEY=…` prefixes. Before Phase 0 these
 * were SILENTLY dropped (filtered on `includes('=')` with no trace), and a
 * BOM'd or export-prefixed real variable was swallowed. Contract now:
 *   - malformed / decorative / blank lines are SKIPPED with a warning that
 *     carries line number + reason + at most a NAME — never a value;
 *   - a real variable is never swallowed: BOM stripped, `export ` stripped;
 *   - nothing ever throws;
 *   - extractValues stays value-safe and aligned with planImport.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planImport, extractValues } from '../providers/import-env.mjs';

const SYNTH = [
  '﻿ZYTE_API_KEY=FAKE_ZYTE_FROM_BOM_LINE',       // BOM on line 1 must not hide the name
  '# a comment line',
  '',
  '   ',
  'FIRECRAWL_API_KEY: FAKE_COLON_VALUE',               // ':' instead of '=' on a KNOWN name → warn WITH name
  'BADKEY: FAKE_COLON_VALUE2',                         // ':' on an UNKNOWN name → warn, name withheld
  ' Scraper -   BRIGHTDATA_API_KEY',                   // decorative prose → warn, skip
  'export BROWSER_AUTH=FAKE_EXPORTED',                 // sh-style export → real variable
  '1BAD=FAKE_INVALID_NAME_VALUE',                      // invalid identifier → warn, skip
  'GOOD_UNKNOWN=FAKE_UNKNOWN',                         // valid but unmapped (existing behavior)
  'brd-customer-abc123-zone-x:FAKE_SECRET_HALF',       // bare user:pass-shaped credential line
].join('\n');

test('hardened planImport: warnings carry line + reason + name only — never a value', () => {
  const plan = planImport(SYNTH);
  const json = JSON.stringify(plan);
  assert.ok(!/FAKE_/.test(json), 'no value may ever appear in the preview/plan');

  assert.ok(Array.isArray(plan.warnings), 'plan.warnings exists');
  const byLine = Object.fromEntries(plan.warnings.map((w) => [w.line, w]));

  // KEY: value → the name surfaces ONLY when it is a KNOWN provider env name
  // (closed vocabulary); anything else before a ':' may be half a credential.
  assert.equal(byLine[5].reason, 'colon-separator');
  assert.equal(byLine[5].name, 'FIRECRAWL_API_KEY');
  assert.equal(byLine[6].reason, 'colon-separator');
  assert.equal(byLine[6].name, null, 'unknown colon-name is withheld');

  // decorative prose → skipped; a KNOWN provider env name mentioned in the
  // prose is surfaced (same closed vocabulary), never free text.
  assert.equal(byLine[7].reason, 'no-separator');
  assert.equal(byLine[7].name, null);
  assert.deepEqual(byLine[7].mentions, ['BRIGHTDATA_API_KEY']);

  // invalid identifier → skipped, name withheld.
  assert.equal(byLine[9].reason, 'invalid-name');
  assert.equal(byLine[9].name, null);

  // the user:pass-shaped line: warned, and its username half NEVER appears.
  assert.equal(byLine[11].reason, 'colon-separator');
  assert.equal(byLine[11].name, null);
  assert.ok(!json.includes('brd-customer'), 'credential fragment must not leak into warnings');

  // exactly these five lines warn — comments/blanks stay silent.
  assert.deepEqual(plan.warnings.map((w) => w.line).sort((a, b) => a - b), [5, 6, 7, 9, 11]);
});

test('hardened planImport: real variables are never swallowed (BOM, export)', () => {
  const plan = planImport(SYNTH);
  const byName = Object.fromEntries(plan.mapped.map((m) => [m.name, m]));
  assert.equal(byName.ZYTE_API_KEY.providerId, 'zyte', 'BOM line 1 variable recognised');
  assert.equal(byName.BROWSER_AUTH.providerId, 'brightData.scrapingBrowser', 'export-prefixed variable recognised');
  assert.ok(plan.unmapped.includes('GOOD_UNKNOWN'));
  assert.ok(!plan.unmapped.includes('BADKEY'), 'a malformed line is a warning, not an unmapped variable');
});

test('hardened extractValues: aligned with the plan, still value-safe', () => {
  const vals = extractValues(SYNTH);
  assert.equal(vals.zyte.apiKey, 'FAKE_ZYTE_FROM_BOM_LINE');
  assert.equal(vals['brightData.scrapingBrowser'].browserAuth, 'FAKE_EXPORTED');
  // the malformed colon line must not resurface as a value anywhere
  assert.ok(!JSON.stringify(vals).includes('FAKE_COLON_VALUE'));
});

test('hardened importer: garbage input never throws', () => {
  for (const txt of [null, undefined, '', '﻿', ':::', '=', '=x', 'a'.repeat(10000), 'K=\nK2']) {
    assert.doesNotThrow(() => planImport(txt));
    assert.doesNotThrow(() => extractValues(txt));
  }
});
