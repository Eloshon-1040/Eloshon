/**
 * Site knowledge: reading a designated block (description keeps its paragraphs, specs as
 * pairs), finding it again on other pages and after a redesign, testing a rule on several
 * pages, and the manual / AI priority. Offline (linkedom), generic markup, no site rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { readBlockText, readSpecPairs, specsToObject } from '../knowledge/readers.mjs';
import { ruleFromElement, applyKnowledge, testRule, proposeFromValues } from '../knowledge/apply.mjs';
import { emptyKnowledge, upsertRule, chainFor, recordOutcome, setTests, testLabel, isGeneral, describeRule, newRule, ruleConfidence } from '../knowledge/rules.mjs';

const doc = (html) => parseHTML(`<html><body>${html}</body></html>`).document;
const LONG = (i) => `Cet ordinateur ${i} est pensé pour le travail et la création. `.repeat(3);

// A product page whose description sits in a tab panel and whose specs are a table.
// `salt` changes the generated class names, as a build would.
const pageA = (i, { salt = 'x1a2b3', desc = true, specs = true } = {}) => doc(`
  <header><a href="/">Home</a></header>
  <main class="pdp css-${salt}">
    <h1 class="pdp__title">Laptop ${i}</h1>
    <div class="pdp__price">${900 + i},99 €</div>
    <div class="tabs"><button role="tab" aria-controls="panel-desc">Description</button><button role="tab" aria-controls="panel-specs">Caractéristiques techniques</button></div>
    ${desc ? `<div id="panel-desc" class="tab-panel tw-${salt}"><p>${LONG(i)}</p><p>Garantie 2 ans.</p><ul><li>Écran lumineux</li><li>Clavier rétroéclairé</li></ul></div>` : ''}
    ${specs ? `<div id="panel-specs" class="tab-panel"><table class="spec-table"><tbody>
      <tr><th>Processeur</th><td>Core i${5 + (i % 3)}</td></tr><tr><th>Mémoire vive</th><td>${8 * (1 + (i % 2))} Go</td></tr>
      <tr><th>Stockage</th><td>512 Go SSD</td></tr><tr><th>Écran</th><td>14 pouces</td></tr></tbody></table></div>` : ''}
  </main>`);

test('readBlockText: paragraphs and bullets stay lines, long text is not cut at 2000, buttons are noise', () => {
  const long = 'Phrase utile. '.repeat(400);
  const d = doc(`<div id="b"><h2>Description</h2><p>Premier paragraphe.</p><p>${long}</p><ul><li>Un</li><li>Deux</li></ul><button>Lire la suite</button></div>`);
  const t = readBlockText(d.getElementById('b'), { dropLabel: 'Description' });
  const lines = t.split('\n');
  assert.equal(lines[0], 'Premier paragraphe.', 'its own title is dropped');
  assert.ok(t.length > 5000, `kept ${t.length}`);
  assert.ok(lines.includes('• Un') && lines.includes('• Deux'));
  assert.ok(!/Lire la suite/.test(t));
});

test('readSpecPairs: table, definition list, list items, div rows and plain lines all give label → value pairs', () => {
  const shapes = {
    table: '<table><tr><th>Poids</th><td>1,2 kg</td></tr><tr><th>Couleur</th><td>Gris</td></tr></table>',
    dl: '<dl><dt>Poids</dt><dd>1,2 kg</dd><dt>Couleur</dt><dd>Gris</dd></dl>',
    ul: '<ul><li><span>Poids</span><span>1,2 kg</span></li><li><span>Couleur</span><span>Gris</span></li></ul>',
    liColon: '<ul><li>Poids : 1,2 kg</li><li>Couleur : Gris</li></ul>',
    divs: '<div class="specs"><div class="row"><span class="k">Poids</span><span class="v">1,2 kg</span></div><div class="row"><span class="k">Couleur</span><span class="v">Gris</span></div></div>',
    lines: '<div><p>Poids : 1,2 kg</p><p>Couleur : Gris</p></div>',
  };
  for (const [name, html] of Object.entries(shapes)) {
    const d = doc(`<section id="s">${html}</section>`);
    const pairs = readSpecPairs(d.getElementById('s'));
    assert.deepEqual(specsToObject(pairs), { Poids: '1,2 kg', Couleur: 'Gris' }, name);
  }
});

test('readSpecPairs: several titled groups are kept, a single title is the block’s own heading', () => {
  const d = doc('<div id="s"><h3>Écran</h3><table><tr><td>Taille</td><td>14"</td></tr><tr><td>Type</td><td>IPS</td></tr></table><h3>Mémoire</h3><table><tr><td>RAM</td><td>8 Go</td></tr><tr><td>Type</td><td>DDR5</td></tr></table></div>');
  const pairs = readSpecPairs(d.getElementById('s'));
  assert.equal(pairs.length, 4); assert.equal(pairs[0].group, 'Écran'); assert.equal(pairs[3].group, 'Mémoire');
  const obj = specsToObject(pairs);
  assert.equal(obj['Mémoire · Type'], 'DDR5'); assert.equal(obj.Type, 'IPS');
  const one = readSpecPairs(doc('<div id="s"><h2>Fiche technique</h2><table><tr><td>A</td><td>1</td></tr><tr><td>B</td><td>2</td></tr></table></div>').getElementById('s'));
  assert.equal(one[0].group, null);
});

test('a rule designated on product A reads products B–D (other generated classes) and fails honestly on E', () => {
  const a = pageA(1);
  const { rule, read } = ruleFromElement(a.getElementById('panel-desc'), a, { field: 'description', url: 'https://shop.test/p/1' });
  assert.ok(read.ok); assert.ok(read.value.includes('Garantie 2 ans.'));
  const pages = [2, 3, 4].map((i) => ({ url: `https://shop.test/p/${i}`, doc: pageA(i, { salt: `z9y8x${i}` }) }));
  pages.push({ url: 'https://shop.test/p/5', doc: pageA(5, { desc: false }) });
  const t = testRule(rule, pages);
  assert.equal(t.total, 4); assert.equal(t.ok, 3);
  assert.equal(t.results[3].ok, false);
  const k = setTests(upsertRule(emptyKnowledge(), rule).knowledge, rule.id, t);
  const r = k.rules[0];
  assert.deepEqual([r.tests.ok, r.tests.total], [3, 4]);
  assert.equal(testLabel(r).label, 'élevée'); assert.ok(isGeneral(r));
  assert.match(describeRule(r), /3\/4/);
});

test('technical_specs designated on a table is read as pairs on the other products', () => {
  const a = pageA(1);
  const { rule, read, count } = ruleFromElement(a.getElementById('panel-specs'), a, { field: 'technical_specs' });
  assert.equal(rule.extract.mode, 'pairs'); assert.ok(read.ok); assert.equal(count, 4);
  const k = upsertRule(emptyKnowledge(), rule).knowledge;
  const got = applyKnowledge(pageA(3, { salt: 'q' }), k, { scope: 'product' });
  const obj = specsToObject(got.values.technical_specs);
  assert.equal(obj['Mémoire vive'], '16 Go', 'product 3 has its own value'); assert.equal(obj.Écran, '14 pouces');
  assert.equal(got.values.specs, got.values.technical_specs, 'also exposed as the specs list');
});

test('after a redesign (new ids, classes, markup) the rule is found again by its LABEL, not by luck', () => {
  const a = pageA(1);
  const { rule } = ruleFromElement(a.getElementById('panel-specs'), a, { field: 'technical_specs' });
  const k = upsertRule(emptyKnowledge(), rule).knowledge;
  // Same tab labels, everything else renamed; specs now a definition list.
  const redesigned = doc(`<div class="wrap"><div class="nav"><button role="tab" aria-controls="x-77">Description</button><button role="tab" aria-controls="x-78">Caractéristiques techniques</button></div>
    <section id="x-77"><p>${LONG(9)}</p></section>
    <section id="x-78"><dl><dt>Processeur</dt><dd>Core i7</dd><dt>Écran</dt><dd>15 pouces</dd><dt>Poids</dt><dd>1,4 kg</dd></dl></section></div>`);
  const got = applyKnowledge(redesigned, k, { scope: 'product' });
  assert.equal(got.trace[0].strategy, 'label');
  assert.equal(specsToObject(got.values.technical_specs).Écran, '15 pouces');
  assert.deepEqual(got.outcomes, [{ ruleId: rule.id, ok: true }]);
});

test('a rule whose block is gone reports the failure and counts it; three in a row demote it', () => {
  const a = pageA(1);
  const { rule } = ruleFromElement(a.getElementById('panel-desc'), a, { field: 'description' });
  let k = upsertRule(emptyKnowledge(), rule).knowledge;
  const none = doc('<main><h1>Promo</h1><p>court</p></main>');
  const got = applyKnowledge(none, k);
  assert.equal(got.values.description, undefined);
  assert.equal(got.trace[0].ok, false);
  for (let i = 0; i < 3; i++) k = recordOutcome(k, rule.id, false);
  assert.equal(k.rules[0].status, 'failing');
  k = recordOutcome(k, rule.id, true);
  assert.equal(k.rules[0].status, 'active', 'a success revives it');
});

test('priority: an AI proposal never displaces a manual rule; a manual rule corrects an AI one; history is kept', () => {
  const mk = (origin, selector, extra = {}) => newRule({ scope: 'product', field: 'description', origin, selector, ...extra });
  let k = emptyKnowledge();
  k = upsertRule(k, mk('ai', '.ai-a')).knowledge;
  assert.equal(k.rules[0].status, 'active');
  const man = upsertRule(k, mk('manual', '.real'));
  k = man.knowledge;
  assert.equal(man.change, 'replaced');
  assert.equal(k.rules.find((r) => r.selector === '.ai-a').status, 'superseded');
  assert.equal(k.rules.find((r) => r.selector === '.real').status, 'active');
  const prop = upsertRule(k, mk('ai', '.ai-b'));
  assert.equal(prop.change, 'proposed'); k = prop.knowledge;
  assert.equal(k.rules.find((r) => r.selector === '.ai-b').status, 'proposed');
  assert.equal(chainFor(k, 'product', 'description')[0].selector, '.real');
  // The user designates again, another block: the previous manual rule is superseded, not contradicted.
  k = upsertRule(k, mk('manual', '.newer')).knowledge;
  const active = k.rules.filter((r) => r.status === 'active');
  assert.equal(active.length, 1); assert.equal(active[0].selector, '.newer');
  assert.equal(active[0].version > 1, true);
  assert.ok(k.rules.some((r) => r.selector === '.real' && r.status === 'superseded'));
});

test('a user confirming the AI proposal (same block) is marked as confirmation and trusted more', () => {
  const ai = newRule({ scope: 'product', field: 'description', origin: 'ai', selector: '.d' });
  let k = upsertRule(emptyKnowledge(), ai).knowledge;
  const r = upsertRule(k, newRule({ scope: 'product', field: 'description', origin: 'manual', selector: '.d' }));
  assert.equal(r.change, 'confirmed'); assert.equal(r.rule.confirmedAi, true);
  assert.ok(ruleConfidence(r.rule).score > ruleConfidence(ai).score);
});

test('confidence follows the pages checked: 1/1 is weak, 4/5 high, 1/5 low and not general', () => {
  const mk = (ok, total) => ({ ...newRule({ scope: 'product', field: 'description', selector: '.d' }), tests: { ok, total, urls: [] } });
  assert.equal(testLabel(mk(0, 0)).label, 'non testée');
  assert.equal(testLabel(mk(1, 1)).label, 'faible'); assert.equal(isGeneral(mk(1, 1)), false);
  assert.equal(testLabel(mk(4, 5)).label, 'élevée'); assert.equal(isGeneral(mk(4, 5)), true);
  assert.equal(testLabel(mk(1, 5)).label, 'faible'); assert.equal(isGeneral(mk(1, 5)), false);
  assert.ok(ruleConfidence(mk(4, 5)).score > ruleConfidence(mk(1, 1)).score);
});

test('AI mode: values the generic detection found are located back in the page as PROPOSED rules', () => {
  const a = pageA(1);
  const found = { description: `${LONG(1)}\nGarantie 2 ans.`, technical_specs: [{ name: 'Processeur', value: 'Core i6' }, { name: 'Stockage', value: '512 Go SSD' }, { name: 'Écran', value: '14 pouces' }] };
  const rules = proposeFromValues(a, found, { url: 'https://shop.test/p/1' });
  assert.deepEqual(rules.map((r) => r.field).sort(), ['description', 'technical_specs']);
  assert.ok(rules.every((r) => r.origin === 'ai'));
  // …and a later manual correction wins over them.
  let k = emptyKnowledge(); for (const r of rules) k = upsertRule(k, r).knowledge;
  const man = ruleFromElement(a.querySelector('.pdp__title'), a, { field: 'description' }).rule;
  man.extract.multiline = false;
  const res = upsertRule(k, man);
  assert.equal(chainFor(res.knowledge, 'product', 'description')[0].origin, 'manual');
});
