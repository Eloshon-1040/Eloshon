/**
 * No raw translation key ever reaches the screen, in any interface language. Every key the renderer asks `t()` for
 * resolves in fr.ui, en.ui, nl.ui AND es.ui (t() reads only `ui`; a UI string left in `diag` was shown as « + ed_add »), the keys built at run time
 * resolve for every value they can take, every field offered in « Modifier » has a label, and every code the
 * engine emits as a warning / loss / error has a text for diag() (else the screen shows the code with spaces).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fr, en, nl, es } from '../app/renderer/i18n.js';
import { columnEditChoices } from '../app/controller.mjs';
import { REASON_CODES, ALERT_CODES, ORIGINS, VALUE_KINDS, GROUPS, UNFED_CODES, TRANSFORM_KEYS, fieldOfCanon } from '../app/step3-rows.mjs';
import { loadReferenceFormatsSync } from '../core/knowledge-proposal/reference.mjs';
import { CUSTOM_CHOICES } from '../core/dist/index.mjs';
// Every place a « case personnalisée » can go, on any platform (core/src/custom-fields.ts).
const PLACES = [...new Set(Object.values(CUSTOM_CHOICES).flat())];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const APP = read('app/renderer/app.js');
const DICTS = [['fr', fr], ['en', en], ['nl', nl], ['es', es]];
const missingIn = (keys, section) => DICTS.flatMap(([lang, d]) => keys.filter((k) => !(k in d[section])).map((k) => `${lang}.${section}.${k}`));

// Step 3 (app/step3-rows.mjs): every code a row can carry has its text, and every field a row can point at has a label.
const STEP3_FAMILIES = {
  s3r_: REASON_CODES, s3a_: ALERT_CODES, s3o_: ORIGINS, s3k_: VALUE_KINDS, s3g_: GROUPS, s3u_: UNFED_CODES, tr_: TRANSFORM_KEYS,
  s3n_lv_: ['ok', 'check', 'uncertain', 'empty', 'ignored', 'unknown'], s3n_f_: ['todo', 'all', 'ok', 'check', 'uncertain', 'empty', 'ignored'],
  s3n_sku_src_: ['reference', 'title', 'title_options', 'barcode'], s3n_sku_case_: ['upper', 'lower', 'keep'], s3n_m_tag_: ['current', 'proposed'],
  s3n_sku_sep_: ['dash', 'under', 'dot'],
  s3c_to_: PLACES, s3c_help_: PLACES,
};

test('every literal t("key") of the renderer resolves in French, English, Dutch and Spanish', () => {
  const keys = [...new Set([...APP.matchAll(/\bt\('([A-Za-z0-9_]+)'\s*[,)]/g)].map((m) => m[1]))];
  assert.ok(keys.length > 200, `keys found: ${keys.length}`);
  assert.deepEqual(missingIn(keys, 'ui'), []);
});

test('keys built at run time resolve for every value they can take', () => {
  // Each prefix concatenated in app.js, with the values the code passes to it.
  const editErrors = [...new Set([...read('core/src/edits.ts').matchAll(/error: '([a-z_]+)'/g)].map((m) => m[1]))];
  assert.ok(editErrors.length >= 4, 'edit error codes read from core/src/edits.ts');
  const families = {
    ed_cmp_:['contains', 'equals', 'startsWith', 'endsWith', 'empty', 'notEmpty', 'regex'],
    ed_err_: editErrors,
    ...STEP3_FAMILIES,
  };
  // The prefixes really used by app.js are exactly these (a new one must be listed here).
  const used = [...new Set([...APP.matchAll(/\bt\('([A-Za-z0-9_]+_)'\s*\+/g)].map((m) => m[1]))].sort();
  assert.deepEqual(used, Object.keys(families).sort(), 'a prefix concatenated in app.js is not covered by this test');
  assert.deepEqual(missingIn(Object.entries(families).flatMap(([p, vs]) => vs.map((v) => p + v)), 'ui'), []);
});

test('every field offered in « Modifier » has a label (never its code path such as shortDescription)', () => {
  const keys = columnEditChoices().map((c) => `canon_${c.replace(/\./g, '_')}`);
  assert.ok(keys.length > 20);
  assert.deepEqual(missingIn(keys, 'ui'), []);
});

test('every code the engine emits as a warning, loss or error has a text in the four languages', () => {
  // problems.ts writes its own messageFr / messageEn; « knowledge_ » is a prefix, not a code.
  const files = [...fs.readdirSync(path.join(ROOT, 'core/src')).filter((f) => f.endsWith('.ts') && f !== 'problems.ts').map((f) => `core/src/${f}`),
    ...fs.readdirSync(path.join(ROOT, 'core/knowledge-proposal')).filter((f) => f.endsWith('.mjs')).map((f) => `core/knowledge-proposal/${f}`)];
  const codes = [...new Set(files.flatMap((f) => [...read(f).matchAll(/code: '([a-z0-9_]+[a-z0-9])'/g)].map((m) => m[1])))];
  assert.ok(codes.length > 50, `codes found: ${codes.length}`);
  assert.deepEqual(missingIn(codes, 'diag'), []);
});

test('step 3: every reason, alert, origin, value kind, theme, consequence and transformation has a text', () => {
  assert.deepEqual(missingIn(Object.entries(STEP3_FAMILIES).flatMap(([p, vs]) => vs.map((v) => p + v)), 'ui'), []);
});

test('step 3: every field a shipped product format writes has a human label (never its code path)', () => {
  const fields = new Set(['attributes', 'sourceExtension', 'options', 'metafields']);
  for (const f of loadReferenceFormatsSync().filter((x) => x.entity === 'products')) for (const e of f.fields ?? []) if (e.canon) for (const c of e.canon.split('+')) fields.add(fieldOfCanon(c));
  const keys = [...fields].map((f) => `canon_${f.replace(/\./g, '_')}`);
  assert.deepEqual(missingIn(keys, 'ui'), []);
});

test('step 3: a reason fits in 45 characters, even with its longest value (system.md 5.6)', () => {
  const longestKind = Math.max(...VALUE_KINDS.map((k) => fr.ui['s3k_' + k].length));
  for (const p of ['s3r_', 's3a_']) for (const c of (p === 's3r_' ? REASON_CODES : ALERT_CODES)) {
    const s = fr.ui[p + c].replace('{kind}', 'x'.repeat(longestKind));
    assert.ok(s.length <= 46, `${p}${c}: ${s.length} characters`);
  }
});

test('step 3: in English, Dutch and Spanish a reason stays within 40 % more than French (system.md 7.6)', () => {
  for (const [lang, d] of DICTS.slice(1)) {
    const longestKind = Math.max(...VALUE_KINDS.map((k) => d.ui['s3k_' + k].length));
    for (const p of ['s3r_', 's3a_']) for (const c of (p === 's3r_' ? REASON_CODES : ALERT_CODES)) {
      const s = d.ui[p + c].replace('{kind}', 'x'.repeat(longestKind));
      assert.ok(s.length <= 64, `${lang}.${p}${c}: ${s.length} characters`);
    }
  }
});

test('step 4: every problem code of core/src/problems.ts has its text (diag « pb_<code> ») in the four languages', () => {
  const codes = [...read('core/src/problems.ts').matchAll(/^\s+([a-z_]+): \{ fr: /gm)].map((m) => m[1]);
  assert.ok(codes.length >= 10, `problem codes found: ${codes.length}`);
  assert.deepEqual(missingIn(codes.map((c) => 'pb_' + c), 'diag'), []);
});

test('step 3: every customer and order field has a label of its own in the four languages (no English fallback)', async () => {
  const { SOURCE_FIELDS } = await import('../core/dist/mapping.mjs');
  const fields = new Set(Object.entries(SOURCE_FIELDS).filter(([f]) => /_(customers|orders)$/.test(f)).flatMap(([, rules]) => rules.filter((r) => r.canon).map((r) => r.canon)));
  assert.ok(fields.size >= 20, `customer and order fields found: ${fields.size}`);
  assert.deepEqual(missingIn([...fields].map((f) => `canon_${f.replace(/\./g, '_')}`), 'ui'), []);
});
