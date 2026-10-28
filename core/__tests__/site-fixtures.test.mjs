/**
 * Real product pages (saved 25/10/2026 in a real Chrome, lightened like the extension sends them:
 * fixtures/sites/*.product.html.gz) read with the rules taught on these sites (taught-rules.v1.json,
 * migrated on load like the app does). The SAME rule module runs in both engines — the app's
 * (shared/knowledge) and the copy the extension loads (extension/vendor/shared/knowledge) — and must
 * give the same answer field by field. Only values checked by hand are asserted; the known wrong reads
 * are listed (they are what the next items fix), never locked in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseHTML } from 'linkedom';
import { applyKnowledgeToHtml } from '../site-knowledge.mjs';
import { migrateKnowledge, KNOWLEDGE_VERSION } from '../../shared/knowledge/rules.mjs';
import { detectChallenge } from '../../shared/challenge/detect.mjs';
import { classifyHtmlPage } from '../../shared/classify/page-kind.mjs';
import { pageJsonPayloads } from '../../shared/extract/product-group.mjs';
import { productIdsOf } from '../../shared/knowledge/state-values.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(HERE, 'fixtures', 'sites');
const page = (name) => zlib.gunzipSync(fs.readFileSync(path.join(FX, name))).toString('utf8');
const TAUGHT = JSON.parse(fs.readFileSync(path.join(FX, 'taught-rules.v1.json'), 'utf8')).sites;
const knowledgeOf = (host) => migrateKnowledge(TAUGHT[host]).knowledge;
const teachingUrl = (host) => knowledgeOf(host).rules[0].learnedFrom;
const read = (host) => applyKnowledgeToHtml(page(`${host}.product.html.gz`), knowledgeOf(host), { url: teachingUrl(host) });

// The extension's own copy of the rule module (built by scripts/build-extension.mjs before the suite).
const VENDOR = path.join(HERE, '..', '..', 'extension', 'vendor', 'shared', 'knowledge', 'apply.mjs');
async function readWithExtensionModule(host) {
  const { applyKnowledge } = await import(pathToFileURL(VENDOR).href);
  const html = page(`${host}.product.html.gz`); const url = teachingUrl(host);
  const payloads = pageJsonPayloads(html);
  return applyKnowledge(parseHTML(html).document, knowledgeOf(host), { scope: 'product', url, payloads: payloads.json, productIds: productIdsOf({ url, jsonLd: payloads.jsonLd }) });
}

test('the stored v1 rules migrate (teaching page out of the counts) and every taught field is tried', () => {
  for (const host of Object.keys(TAUGHT)) {
    const k = knowledgeOf(host);
    assert.equal(k.version, KNOWLEDGE_VERSION, host);
    // v3: every picture rule carries the strategy it reads with (an older rule: the block's markup, any attribute).
    for (const r of k.rules.filter((x) => /^(image|images|gallery|thumbnail)$/.test(x.field))) assert.equal(r.extract.source, 'dom', `${host}: ${r.id} has no picture source`);
    assert.ok(k.rules.every((r) => !r.tests || !(r.tests.urls || []).includes(r.learnedFrom)), `${host}: teaching page left the tested pages`);
  }
});

test('Sephora product page: brand, name and description read by the taught rules', () => {
  const v = read('sephora.fr').values;
  assert.equal(v.brand, 'DIOR');
  assert.match(v.name, /^J'adore Eau de Parfum/);
  assert.match(v.description, /J'adore, le parfum pour femme de légende/);
});

test('ICI PARIS XL product page: every taught field reads', () => {
  const v = read('iciparisxl.be').values;
  assert.match(v.description, /Miss Dior Rose N'Roses est une eau de toilette/);
  assert.equal(v.brand.toLowerCase(), 'dior');
  assert.equal(v.category, 'Parfum');
  assert.equal(v.variants.length, 4); assert.equal(v.variants[0].name, '30 ML'); assert.equal(v.variants[0].price, 65.44);
  assert.ok(v.technical_specs.length >= 5); assert.ok(v.image.length >= 1);
});

test('MediaMarkt product page: name, brand, category, images, specs and description read', () => {
  const v = read('mediamarkt.be').values;
  assert.equal(v.name, 'SAMSUNG Galaxy A17 4G - 128GB - Black');
  assert.equal(v.brand, 'SAMSUNG'); assert.equal(v.category, 'GSM');
  assert.equal(v.image.length, 9); assert.ok(v.technical_specs.length >= 90);
  assert.match(v.description, /Super AMOLED de 6,7 pouces/);
});

test('Adidas product page: name, category and colourways read', () => {
  const v = read('adidas.be').values;
  assert.equal(v.name, 'Chaussure Handball Spezial'); assert.equal(v.category, 'Chaussures');
  assert.equal(v.variants.length, 13);
});

test('the extension’s copy of the rule module gives the same answer as the app, field by field', async () => {
  for (const host of Object.keys(TAUGHT)) {
    const app = read(host); const ext = await readWithExtensionModule(host);
    assert.deepEqual(Object.keys(ext.values).sort(), Object.keys(app.values).sort(), host);
    for (const f of Object.keys(app.values)) assert.deepEqual(ext.values[f], app.values[f], `${host}.${f}`);
  }
});

test('what each page DECLARES (JSON-LD / microdata), read without any rule', async () => {
  const { structuredOf } = await import('../../shared/knowledge/structured.mjs');
  const s = (host) => structuredOf(page(`${host}.product.html.gz`), teachingUrl(host));
  const se = s('sephora.fr');
  assert.equal(se.price.kind, 'microdata'); assert.deepEqual(se.price.value, { price: 89, currency: 'EUR' });
  assert.equal(se.brand.value, 'DIOR'); assert.match(se.name.value, /^J'adore Eau de Parfum/);
  assert.ok(se.variants.value.length >= 2 && se.variants.value.every((v) => v.price > 0), 'one offer per volume, each priced');
  assert.match(se.variants.value[0].name, /^\d+\s?ml$/i, 'the option, not the product name again');
  const ad = s('adidas.be');
  assert.deepEqual(ad.price.value, { price: 110, currency: 'EUR' }, 'a ProductGroup: the price of the page’s own variant');
  assert.match(ad.description.value, /^Cette chaussure adidas Handball Spezial/);
  const mm = s('mediamarkt.be');
  assert.equal(mm.ean.value, '8806097651192'); assert.equal(mm.category.value, 'Téléphone & Objets connectés > GSM > Smartphone Samsung', 'the product itself is not a category');
  const ic = s('iciparisxl.be');
  assert.ok(!/&lt;|<p>/.test(ic.description.value), 'escaped markup decoded and dropped');
  assert.equal(ic.variants.value.length, 4); assert.equal(ic.variants.value[0].price, 65.44);
});

test('stored rules that broke are rescued by what the page declares; site switches are never « characteristics »', () => {
  const ad = read('adidas.be');
  assert.match(ad.values.description, /^Cette chaussure adidas Handball Spezial/, 'the folded accordion is not in the page: the declared description');
  assert.equal(ad.sources.description.strategy, 'jsonld');
  // The site's feature flags are refused; since 28/10 the page's own « usps » are its characteristics.
  const specs = (ad.values.technical_specs || []).map((s) => `${s.group || ''} ${s.name} ${s.value}`);
  assert.ok(!specs.some((s) => /ADIPULSE|NEWSLETTER|\b(on|off)\b/i.test(s)), 'feature flags of the site’s code are refused');
  assert.ok(specs.some((s) => /Tige Cuir/.test(s)), 'the declared details are read');
  const se = read('sephora.fr');
  assert.equal(se.sources.variants.strategy, 'microdata', 'the size list block is not in the page: the declared offers');
  assert.ok(se.values.variants.length >= 2);
});

test('fragile rules are flagged with what to do — never deleted', async () => {
  const { auditRule } = await import('../../shared/knowledge/rules.mjs');
  const { isUnstableClass } = await import('../../shared/extract/pick-selector.mjs');
  const codes = (host, field) => { const k = knowledgeOf(host); const r = k.rules.find((x) => x.field === field && x.status !== 'superseded'); return auditRule(r, k, isUnstableClass).map((w) => w.code); };
  // (Its selector differs from the variants' one past the first levels: positional, not shared.)
  assert.deepEqual(codes('adidas.be', 'category').filter((c) => c !== 'untested'), ['positional'], 'found by its position only');
  assert.ok(codes('adidas.be', 'description').includes('generated'), 'relies on build-hashed, state-dependent classes');
  assert.ok(codes('mediamarkt.be', 'variants').includes('failing'));
  assert.deepEqual(codes('iciparisxl.be', 'brand').filter((c) => c !== 'untested'), [], 'a sound rule is not flagged');
});

test('a new designation records its strategies: the page’s declaration first for a short field, the block for a text', async () => {
  const { ruleFromElement } = await import('../../shared/knowledge/apply.mjs');
  const html = page('adidas.be.product.html.gz'); const doc = parseHTML(html).document;
  const name = ruleFromElement(doc.querySelector('h1[data-testid="product-title"]'), doc, { field: 'name', url: teachingUrl('adidas.be'), html });
  assert.deepEqual(name.rule.strategies.map((s) => s.kind), ['jsonld', 'dom']);
  const mmHtml = page('mediamarkt.be.product.html.gz'); const mm = parseHTML(mmHtml).document;
  const h1 = mm.querySelector('h1');
  const r = ruleFromElement(h1, mm, { field: 'name', url: teachingUrl('mediamarkt.be'), html: mmHtml });
  assert.ok(!/mms-ui-/.test(r.rule.selector), `no generated class in a new selector: ${r.rule.selector}`);
});

test('edge refusal pages are recognised as blocks; real product pages are never taken for one', () => {
  for (const host of ['sephora.fr', 'adidas.be']) assert.ok(detectChallenge({ body: page(`${host}.blocked.html.gz`) }, {}), `${host}: block page`);
  for (const host of Object.keys(TAUGHT)) {
    assert.equal(classifyHtmlPage(page(`${host}.product.html.gz`), { url: teachingUrl(host) }).kind, 'product', `${host}: product page`);
  }
});
