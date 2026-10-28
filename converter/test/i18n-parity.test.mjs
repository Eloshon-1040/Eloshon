/**
 * Every user-facing string ships in the four interface languages (French, English, Dutch, Spanish), with the
 * same {placeholders}: a key present in one dictionary only, an empty translation, or a parameter one language
 * forgets to show fails here instead of in the UI. Same for the column editor's catalog (core) and for the few
 * texts the main process shows itself (dialog titles, filter names). French is the reference.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as dicts from '../app/renderer/i18n.js';
import { MAIN_STRINGS, LANGS as MAIN_LANGS, mainText } from '../app/main-i18n.mjs';
import { EDIT_CATALOG, EDIT_GROUPS, EDIT_PRESETS } from '../core/dist/index.mjs';

const { LANGS, LANG_NAMES } = dicts;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = fs.readFileSync(path.join(ROOT, 'app/renderer/app.js'), 'utf8');
const params = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const filled = (v) => typeof v === 'string' && v.trim() !== '';

test('the four interface languages, in the same order for the renderer and the main process', () => {
  assert.deepEqual(LANGS, ['fr', 'en', 'nl', 'es']);
  assert.deepEqual(MAIN_LANGS, LANGS);
  assert.deepEqual(LANG_NAMES, { fr: 'Français', en: 'English', nl: 'Nederlands', es: 'Español' });
  for (const l of LANGS) assert.ok(dicts[l]?.ui && dicts[l]?.diag, `i18n.js exports ${l}`);
});

for (const section of ['ui', 'diag']) {
  for (const lang of ['en', 'nl', 'es']) {
    test(`i18n ${section}: ${lang.toUpperCase()} has every French key, non-empty, with the same placeholders`, () => {
      const a = dicts.fr[section], b = dicts[lang][section];
      assert.deepEqual(Object.keys(a).filter((k) => !(k in b)), [], `keys missing in ${lang}`);
      assert.deepEqual(Object.keys(b).filter((k) => !(k in a)), [], `keys in ${lang} that French does not have`);
      for (const k of Object.keys(a)) {
        assert.ok(filled(b[k]), `${lang}.${section}.${k} is empty`);
        assert.deepEqual(params(b[k]), params(a[k]), `"${k}": FR {${params(a[k])}} vs ${lang} {${params(b[k])}}`);
      }
    });
  }
}

test('French keys are non-empty too', () => {
  for (const section of ['ui', 'diag']) for (const [k, v] of Object.entries(dicts.fr[section])) assert.ok(filled(v), `fr.${section}.${k} is empty`);
});

test('Dutch, Spanish and English follow their own typography (no French spacing, no em dash, real ellipsis)', () => {
  for (const lang of ['en', 'nl', 'es']) for (const section of ['ui', 'diag']) for (const [k, v] of Object.entries(dicts[lang][section])) {
    assert.ok(!/[  ]/.test(v), `${lang}.${section}.${k}: non-breaking space (a French rule)`);
    assert.ok(!/ [:;?!](\s|$)/.test(v), `${lang}.${section}.${k}: space before : ; ? !`);
    assert.ok(!/\.\.\./.test(v), `${lang}.${section}.${k}: "..." instead of "…"`);
    assert.ok(!/—/.test(v), `${lang}.${section}.${k}: em dash used as punctuation`);
  }
});

test('Dutch says « u », Spanish says « usted » (no informal forms)', () => {
  for (const [k, v] of Object.entries({ ...dicts.nl.ui, ...dicts.nl.diag })) assert.ok(!/\b(je|jij|jouw|jou)\b/i.test(v), `nl ${k}: informal form`);
  for (const [k, v] of Object.entries({ ...dicts.es.ui, ...dicts.es.diag })) assert.ok(!/\b(tú|tus|puedes|elige|tienes)\b/i.test(v), `es ${k}: informal form`);
});

test('the column editor (core/src/edit-catalog.ts) speaks the four languages', () => {
  const need = (v, where) => assert.ok(filled(v), `edit catalog ${where}`);
  for (const lang of LANGS) {
    for (const g of EDIT_GROUPS) need(g[lang], `group ${g.id}.${lang}`);
    for (const e of EDIT_CATALOG) {
      need(e[lang]?.label, `${e.op}.${lang}.label`); need(e[lang]?.help, `${e.op}.${lang}.help`);
      for (const a of e.args) { need(a[lang], `${e.op}.args.${a.key}.${lang}`); for (const c of a.choices ?? []) { need(c[lang], `${e.op}.${a.key}.${c.value}.${lang}`); if (c.help) need(c.help[lang], `${e.op}.${a.key}.${c.value}.help.${lang}`); } }
    }
    for (const p of EDIT_PRESETS) { need(p[lang], `preset ${p.id}.${lang}`); need(p.hint?.[lang], `preset ${p.id}.hint.${lang}`); }
  }
});

test('the main process texts exist in the four languages with the same placeholders, unknown language → French', () => {
  for (const lang of LANGS) {
    assert.deepEqual(Object.keys(MAIN_STRINGS[lang]).sort(), Object.keys(MAIN_STRINGS.fr).sort(), `main-i18n ${lang} keys`);
    for (const [k, v] of Object.entries(MAIN_STRINGS[lang])) { assert.ok(filled(v), `main ${lang}.${k}`); assert.deepEqual(params(v), params(MAIN_STRINGS.fr[k]), `main ${lang}.${k} params`); }
  }
  assert.equal(mainText('de', 'filter_all'), MAIN_STRINGS.fr.filter_all);
  assert.equal(mainText('nl', 'tpl_copy', { name: 'A' }), 'A (kopie)');
});

test('main.mjs shows no hard-coded French: dialog titles and filter names come from main-i18n.mjs', () => {
  const MAIN = fs.readFileSync(path.join(ROOT, 'app/main.mjs'), 'utf8');
  for (const s of ['Choisir un fichier', 'Tous les fichiers', 'Dossier de destination', 'Exporter le modèle', 'Importer un modèle', 'modele.eloshon.json']) assert.ok(!MAIN.includes(s), `main.mjs still writes « ${s} »`);
  assert.match(MAIN, /if \('lang' in p && !LANGS\.includes\(p\.lang\)\) delete p\.lang;/, 'config:set accepts only fr|en|nl|es');
});

test('app.js has no language ternary and no hand-picked locale: every text goes through i18n, every number through Intl', () => {
  assert.ok(!/S\.lang === 'fr' \?/.test(APP), 'a « S.lang === \'fr\' ? » ternary is back in app.js');
  assert.ok(!/S\.lang === 'en' \?/.test(APP), 'a « S.lang === \'en\' ? » ternary is back in app.js');
  assert.ok(!/'(fr-FR|en-US|en-GB|nl-BE|nl-NL|es-ES|fr-BE)'/.test(APP), 'a locale with a region is hard-coded in app.js (system.md §3.1)');
  assert.ok(!/\.toLocale(String|DateString|TimeString)\(/.test(APP), 'dates and numbers go through Intl with the interface language');
  assert.ok(!/messageFr\s*:\s*p\.messageEn|\? p\.messageFr/.test(APP), 'engine messages go through problemText()');
  assert.ok(!/toast\('OK'/.test(APP), 'a toast says what happened, in the interface language');
});
