/**
 * recipes.json: the sites' recipes as one versioned file, exported from one app and imported into another,
 * merged per site + scope + field and NEVER silently: the preview says, line by line, added / replaced / kept
 * / identical and why; a designated (manual) rule is never replaced by an automatic one; a file from a newer
 * app is refused, an older one migrated; applying keeps a dated copy of domain-profiles.json first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportRecipes, planImport, applyImport, RECIPES_FORMAT } from '../recipes-file.mjs';
import { newRule, KNOWLEDGE_VERSION } from '../../shared/knowledge/rules.mjs';
import { appDirs, ensureDirs } from '../../lib/osenv.mjs';
import { createController } from '../../app/controller.mjs';

const at = '2026-10-25T10:00:00.000Z';
const rule = (field, selector, extra = {}) => ({ ...newRule({ field, selector, learnedFrom: 'https://shop.test/p/1' }, at), ...extra });
const tested = (ok, total) => ({ tests: { ok, total, urls: [], recent: '1'.repeat(ok) + '0'.repeat(total - ok) } });

const MINE = {
  'shop.test': {
    runs: 3,
    siteKnowledge: { version: KNOWLEDGE_VERSION, rules: [
      rule('brand', '.marque', { origin: 'manual', ...tested(2, 4) }),           // weak but designated here
      rule('description', '.desc', { origin: 'ai', ...tested(1, 4) }),          // weak automatic
      rule('name', 'h1', { origin: 'ai', ...tested(4, 4) }),                     // same as the file's
    ] },
    manual_selectors: { card: '.card', fields: { name: { selector: '.t' } } },
  },
};
const THEIRS = {
  'shop.test': {
    runs: 9,
    siteKnowledge: { version: KNOWLEDGE_VERSION, rules: [
      rule('brand', '.brand-new', { origin: 'ai', ...tested(4, 4) }),           // automatic: never replaces a designated one
      rule('description', '.desc-v2', { origin: 'manual', ...tested(4, 4) }),   // better: replaces
      rule('name', 'h1', { origin: 'ai', ...tested(4, 4) }),                    // identical
      rule('price', '.prix', { origin: 'manual', ...tested(3, 4) }),            // new field: added
      rule('sku', '.ref', { origin: 'ai', status: 'deprecated' }),             // dead rules are not exported
    ] },
    manual_selectors: { card: '.tile', fields: { name: { selector: '.n' } } },  // another list recipe here: kept
    internal_api: { endpoint_tpl: 'https://shop.test/api?q={q}', headers: { 'x-key': { from: 'page', pattern: 'key' } } },
  },
  'other.test': { siteKnowledge: { version: KNOWLEDGE_VERSION, rules: [rule('name', '.title', { origin: 'manual', ...tested(3, 3) })] } },
};

test('export: live rules and recipes per site, versioned, no dead rule, no secret value', () => {
  const f = exportRecipes(THEIRS, { now: at, appVersion: '9.9.9' });
  assert.equal(f.format, RECIPES_FORMAT); assert.equal(f.version, 1); assert.equal(f.knowledgeVersion, KNOWLEDGE_VERSION);
  assert.deepEqual(Object.keys(f.sites).sort(), ['other.test', 'shop.test']);
  assert.ok(!f.sites['shop.test'].knowledge.rules.some((r) => r.field === 'sku'), 'a deprecated rule stays home');
  assert.deepEqual(f.sites['shop.test'].internal_api.headers['x-key'], { from: 'page', pattern: 'key' }, 'where a key is read, never a key');
  assert.deepEqual(Object.keys(exportRecipes(THEIRS, { hosts: ['other.test'] }).sites), ['other.test']);
});

test('import preview: every change said with why; a designated rule is never replaced by an automatic one', () => {
  const r = planImport(MINE, exportRecipes(THEIRS, { now: at }));
  assert.equal(r.ok, true);
  const lines = Object.fromEntries(r.summary.sites['shop.test'].map((l) => [l.field || l.what, [l.action, l.why]]));
  assert.deepEqual(lines.brand, ['kept', 'manual_kept']);
  assert.deepEqual(lines.description, ['replaced', 'more_trusted_file']);
  assert.deepEqual(lines.name, ['identical', 'same']);
  assert.deepEqual(lines.price, ['added', 'none_here']);
  assert.deepEqual(lines.manual_selectors, ['kept', 'other_here']);
  assert.deepEqual(lines.internal_api, ['added', 'absent_here']);
  assert.deepEqual(r.summary.counts, { added: 3, replaced: 1, kept: 2, identical: 1 });
  // Applied: the plan only, the input untouched, the replaced rule kept as history.
  const out = applyImport(MINE, r.plan, { now: at });
  const live = (h, f) => out[h].siteKnowledge.rules.filter((x) => x.field === f && x.status === 'active').map((x) => x.selector);
  assert.deepEqual(live('shop.test', 'brand'), ['.marque']); assert.deepEqual(live('shop.test', 'description'), ['.desc-v2']);
  assert.deepEqual(live('shop.test', 'price'), ['.prix']); assert.deepEqual(live('other.test', 'name'), ['.title']);
  assert.ok(out['shop.test'].siteKnowledge.rules.some((x) => x.selector === '.desc' && x.status === 'superseded'), 'history kept');
  assert.equal(out['shop.test'].manual_selectors.card, '.card'); assert.ok(out['shop.test'].internal_api);
  assert.equal(MINE['shop.test'].siteKnowledge.rules.length, 3, 'the input is never mutated');
});

test('a file from a newer app is refused with a clear message; a v1 rules file is migrated', () => {
  const f = exportRecipes(THEIRS, { now: at });
  const newer = planImport(MINE, { ...f, knowledgeVersion: KNOWLEDGE_VERSION + 1 });
  assert.equal(newer.ok, false); assert.equal(newer.code, 'newer_app'); assert.match(newer.reason, /plus récente/);
  assert.equal(planImport(MINE, { ...f, version: 2 }).code, 'newer_app');
  assert.equal(planImport(MINE, { hello: 1 }).code, 'not_recipes');
  const v1 = { format: RECIPES_FORMAT, version: 1, knowledgeVersion: 1, sites: { 'new.test': { knowledge: { version: 1, rules: [{ ...rule('name', '.t', { origin: 'manual' }), tests: { ok: 1, total: 1, urls: ['https://shop.test/p/1'], recent: '1' } }] } } } };
  const r = planImport({}, v1);
  assert.equal(r.ok, true);
  assert.equal(r.plan['new.test'].rules[0].tests.total, 0, 'migrated: the teaching page is no evidence');
});

test('through the app: preview, then apply with a dated copy of the profiles file kept first; nothing applied without the preview', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-recipes-'));
  const dirs = ensureDirs(appDirs(root));
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1 }));
  fs.writeFileSync(path.join(dirs.data, 'domain-profiles.json'), JSON.stringify(MINE));
  const ctl = createController({ dirs, emit: () => {} });
  const file = exportRecipes(THEIRS, { now: at });
  assert.equal(ctl.recipesApply('imp_unknown').ok, false, 'no preview, nothing applied');
  const p = ctl.recipesPreview(file);
  assert.equal(p.ok, true); assert.equal(p.summary.counts.added, 3);
  const a = ctl.recipesApply(p.previewId);
  assert.equal(a.ok, true); assert.deepEqual(a.sites.sort(), ['other.test', 'shop.test']);
  const copies = fs.readdirSync(dirs.data).filter((f) => /^domain-profiles\.before-import-.*\.json$/.test(f));
  assert.equal(copies.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dirs.data, copies[0]), 'utf8'))), ['shop.test'], 'the copy is the file before the import');
  const now = JSON.parse(fs.readFileSync(path.join(dirs.data, 'domain-profiles.json'), 'utf8'));
  assert.ok(now['other.test']);
  assert.equal(ctl.recipesApply(p.previewId).ok, false, 'a preview is applied once');
  const back = ctl.recipesExport({});
  assert.ok(back.sites['other.test'] && back.sites['shop.test'].knowledge.rules.some((r) => r.field === 'price'), 'exported again from the app');
});
