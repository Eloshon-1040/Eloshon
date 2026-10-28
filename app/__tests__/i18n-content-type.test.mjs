/**
 * The "Type de contenu" texts exist in the five languages, with the same key set
 * everywhere (no language falls back silently to another).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const LANGS = ['fr', 'en', 'es', 'nl', 'de'];
const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${p}${k}.`) : [[`${p}${k}`, v]]));
const dicts = {};
for (const l of LANGS) dicts[l] = (await import(`../renderer/i18n/${l}.js`)).default;

const NEW_KEYS = [
  'new.contentType', 'new.ct_auto', 'new.ct_product', 'new.ct_video', 'new.ctHint',
  'complete.processedVideosIn', 'complete.processedVideos', 'complete.contentVideos', 'complete.contentVideosAuto',
  'jobs.videos', 'results.colVideo', 'results.colDuration', 'results.subVideos',
  'product.duration', 'product.views', 'product.published', 'product.embed',
  'field.url', 'field.duration', 'field.published', 'field.views', 'field.embed',
  'probe.freeVideo', 'probe.contentVideos', 'eligReason.accepted_video', 'eligReason.to_verify_video_thin',
];

test('every language has the content-type texts, non-empty, without a provider name', () => {
  for (const l of LANGS) {
    const map = new Map(flat(dicts[l]));
    for (const k of NEW_KEYS) {
      assert.ok(map.has(k), `${l}: ${k} missing`);
      assert.ok(String(map.get(k)).trim().length > 0, `${l}: ${k} empty`);
      assert.doesNotMatch(String(map.get(k)), /firecrawl|bright ?data|zyte/i, `${l}: ${k} names a provider`);
    }
  }
});

test('the five languages share one key set', () => {
  const sets = LANGS.map((l) => new Set(flat(dicts[l]).map(([k]) => k)));
  for (let i = 1; i < sets.length; i++) {
    const missing = [...sets[0]].filter((k) => !sets[i].has(k));
    const extra = [...sets[i]].filter((k) => !sets[0].has(k));
    assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, `${LANGS[i]} differs from fr`);
  }
});

test('the hint and the completion line say what happens, in words a beginner can act on', () => {
  assert.match(dicts.fr.new.ctHint, /première page et du plan du site/);
  assert.match(dicts.fr.complete.contentVideosAuto, /reconnu automatiquement/);
  assert.match(dicts.en.new.ctHint, /first page and the sitemap/);
});
