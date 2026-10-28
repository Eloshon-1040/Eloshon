/**
 * The user can edit a file before it is converted: rename / add / delete a column, replace,
 * remove, add or cut text, insert a character at chosen places, fix a price in cents,
 * slugify… Each operation is a ready-made formula whose help text carries a worked example;
 * those examples are RUN here, so the documentation cannot drift from the code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, convert, applyEdits, applyEditsToText, previewEdits, expandPreset, EDIT_CATALOG, EDIT_GROUPS, EDIT_PRESETS } from '../core/dist/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const one = (op, value, args, extra = {}) => {
  const t = { headers: ['c'], rows: [{ c: value }], malformed: [] };
  const { table, report } = applyEdits(t, [{ id: 'e', op, column: 'c', args, ...extra }]);
  return { value: table.rows[0].c, report: report[0] };
};

test('every catalogue example gives exactly the output its help text promises', () => {
  const cellOps = EDIT_CATALOG.filter((e) => e.example);
  assert.ok(cellOps.length >= 25);
  for (const e of cellOps) {
    const r = one(e.op, e.example.value, e.example.args);
    assert.equal(r.report.error, undefined, e.op);
    assert.equal(r.value, e.example.out, `${e.op}: ${JSON.stringify(e.example.value)}`);
  }
});

test('the catalogue is complete: both languages, a Sheets formula, a known group, every presets op exists', () => {
  const groups = new Set(EDIT_GROUPS.map((g) => g.id));
  const ops = new Set(EDIT_CATALOG.map((e) => e.op));
  assert.equal(ops.size, EDIT_CATALOG.length, 'no duplicated operation');
  for (const e of EDIT_CATALOG) {
    assert.ok(groups.has(e.group), e.op);
    assert.ok(e.fr.label && e.fr.help && e.en.label && e.en.help && e.sheets, e.op);
    for (const a of e.args) assert.ok(a.fr && a.en, `${e.op}.${a.key}`);
  }
  for (const p of EDIT_PRESETS) for (const x of p.edits) assert.ok(ops.has(x.op), `${p.id} → ${x.op}`);
});

test('insert a character at chosen places: from the start, several at once, from the end', () => {
  assert.equal(one('insert_at', '1599', { text: '.', positions: '3' }).value, '15.99');
  assert.equal(one('insert_at', '1234567', { text: ',', positions: '2, 5' }).value, '1,234,567', 'inserted BEFORE the 2nd and the 5th character of the original text');
  assert.equal(one('insert_at', '1599', { text: '.', positions: '2', fromEnd: true }).value, '15.99', '2 characters before the end');
  assert.equal(one('insert_at', 'ab', { text: '-', positions: '9' }).value, 'ab', 'a position past the end is ignored');
});

test('remove commas / cut a start / cut an end / replace a start by another', () => {
  assert.equal(one('remove', '1,299,00', { text: ',' }).value, '129900');
  assert.equal(one('prefix_remove', 'https://old.be/p/1', { text: 'https://old.be' }).value, '/p/1');
  assert.equal(one('prefix_remove', 'other', { text: 'https://old.be' }).value, 'other', 'nothing to cut');
  const t = { headers: ['url'], rows: [{ url: 'https://old.be/p/1' }, { url: 'https://old.be/p/2' }], malformed: [] };
  const { table } = applyEdits(t, [{ id: '1', op: 'prefix_remove', column: 'url', args: { text: 'https://old.be' } }, { id: '2', op: 'prefix_add', column: 'url', args: { text: 'https://new.be' } }]);
  assert.deepEqual(table.rows.map((r) => r.url), ['https://new.be/p/1', 'https://new.be/p/2']);
});

test('column operations: rename, duplicate then transform, add, join, delete', () => {
  const t = { headers: ['name', 'brand', 'price'], rows: [{ name: 'Vodka Blanc', brand: 'Eristoff', price: '1599' }], malformed: [] };
  const { table, report } = applyEdits(t, [
    { id: '1', op: 'rename_column', column: 'name', args: { to: 'title' } },
    { id: '2', op: 'copy_column', column: 'title', args: { to: 'slug' } },
    { id: '3', op: 'slugify', column: 'slug', args: {} },
    { id: '4', op: 'join_columns', column: '*', args: { columns: ['brand', 'title'], sep: ' - ', to: 'full' } },
    { id: '5', op: 'add_column', column: '*', args: { to: 'store', text: 'Delhaize' } },
    { id: '6', op: 'delete_column', column: 'brand', args: {} },
  ]);
  assert.deepEqual(report.map((r) => r.error), [undefined, undefined, undefined, undefined, undefined, undefined]);
  assert.deepEqual(table.headers, ['title', 'slug', 'full', 'price', 'store']);
  assert.deepEqual(table.rows[0], { title: 'Vodka Blanc', slug: 'vodka-blanc', price: '1599', full: 'Eristoff - Vodka Blanc', store: 'Delhaize' });
});

test('one column or all columns, and only on the rows that match a condition', () => {
  const t = { headers: ['a', 'b', 'kind'], rows: [{ a: ' x ', b: ' y ', kind: 'alcool' }, { a: ' p ', b: ' q ', kind: 'eau' }], malformed: [] };
  const all = applyEdits(t, [{ id: '1', op: 'trim', column: '*', args: {} }]).table;
  assert.deepEqual(all.rows.map((r) => [r.a, r.b]), [['x', 'y'], ['p', 'q']]);
  const some = applyEdits(t, [{ id: '1', op: 'upper', column: 'a', args: {}, when: { column: 'kind', equals: 'alcool' } }]).table;
  assert.deepEqual(some.rows.map((r) => r.a), [' X ', ' p ']);
  const empty = applyEdits({ headers: ['a'], rows: [{ a: '' }, { a: 'z' }], malformed: [] }, [{ id: '1', op: 'fill_empty', column: 'a', args: { text: '0' } }]).table;
  assert.deepEqual(empty.rows.map((r) => r.a), ['0', 'z']);
});

test('a bad edit is reported and skipped, it never stops the others or throws', () => {
  const t = { headers: ['a'], rows: [{ a: 'Vodka' }], malformed: [] };
  const { table, report } = applyEdits(t, [
    { id: 'missing', op: 'upper', column: 'nope', args: {} },
    { id: 'regex', op: 'regex_replace', column: 'a', args: { pattern: '(' } },
    { id: 'unknown', op: 'teleport', column: 'a', args: {} },
    { id: 'exists', op: 'copy_column', column: 'a', args: { to: 'a' } },
    { id: 'ok', op: 'lower', column: 'a', args: {} },
  ]);
  assert.deepEqual(report.map((r) => r.error), ['column_missing', 'regex_invalid', 'unknown_op', 'column_exists', undefined]);
  assert.equal(table.rows[0].a, 'vodka');
});

test('the original table is never modified', () => {
  const t = { headers: ['a'], rows: [{ a: 'X' }], malformed: [] };
  applyEdits(t, [{ id: '1', op: 'lower', column: 'a', args: {} }]);
  assert.equal(t.rows[0].a, 'X');
});

test('applyEditsToText: CSV in, CSV out; no edits or JSON = the same text', () => {
  const csv = 'a;b\nVodka;1599\n';
  assert.equal(applyEditsToText(csv, []), csv);
  assert.equal(applyEditsToText('[{"a":1}]', [{ id: '1', op: 'upper', column: 'a', args: {} }]), '[{"a":1}]');
  const out = applyEditsToText(csv, [{ id: '1', op: 'number', column: 'b', args: { action: 'divide', value: 100 } }]);
  assert.deepEqual(parseCsv(out).rows, [{ a: 'Vodka', b: '15.99' }]);
});

test('presets expand to real edits aimed at the chosen column', () => {
  const edits = expandPreset('slug_from_title', 'name_fr');
  assert.deepEqual(edits.map((e) => [e.op, e.column]), [['copy_column', 'name_fr'], ['slugify', 'name_fr_slug']]);
  assert.equal(edits[0].args.to, 'name_fr_slug');
  const { table } = applyEdits({ headers: ['name_fr'], rows: [{ name_fr: 'Eristoff | Vodka | Blanc' }], malformed: [] }, edits);
  assert.equal(table.rows[0].name_fr_slug, 'eristoff-vodka-blanc');
  assert.deepEqual(expandPreset('nope', 'x'), []);
});

test('preview: before / after of the first rows of a column', () => {
  const csv = 'name,price\nA,1599\nB,1479\n';
  const p = previewEdits(csv, [{ id: '1', op: 'number', column: 'price', args: { action: 'divide', value: 100 } }], 'price');
  assert.deepEqual(p.before, ['1599', '1479']);
  assert.deepEqual(p.after, ['15.99', '14.79']);
  assert.equal(p.report[0].changed, 2);
});

test('end to end: a scraper export with prices in cents and "|" titles is fixed before conversion', () => {
  const header = 'slug_fr,slug_en,name_fr,name_en,description_fr,description_en,price,category_slug,barcode,hs_code,weight_kg,image_url,store_slug,source_url,source_product_id,source_category,product_type,storage_info,is_alcoholic';
  const row = (n, price) => `${n.toLowerCase().replace(/\W+/g, '-')},,"${n}","${n}",,,${price},,,,0.7,https://x/${n.length}.jpg,delhaize,https://x/p/${n.length},S${n.length},Alcool,,,true`;
  const csv = [header, row('Eristoff | Vodka | Blanc | 37,5% ALC.', '1599'), row('Smirnoff | Vodka | 37.5% ALC.', '1479')].join('\n');

  const raw = convert(csv, { direction: 'eloshon-to-shopify', expectPlatform: 'eloshon' });
  assert.equal(raw.ok, true);
  assert.equal(raw.rows[1]['Variant Price'], '1479.00', 'as scraped: cents');

  const edited = applyEditsToText(csv, [
    { id: '1', op: 'number', column: 'price', args: { action: 'divide', value: 100 } },
    { id: '2', op: 'join_segments', column: 'name_fr', args: { sep: '|', with: ' ' } },
    { id: '3', op: 'dedupe_words', column: 'name_fr', args: {} },
  ]);
  const res = convert(edited, { direction: 'eloshon-to-shopify', expectPlatform: 'eloshon' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.rows.map((r) => r['Variant Price']), ['15.99', '14.79']);
  assert.deepEqual(res.rows.map((r) => r['Title']), ['Eristoff Vodka Blanc 37,5% ALC.', 'Smirnoff Vodka 37.5% ALC.']);
});

test('a line of a scraper file pasted whole into its first cell is split back into columns', () => {
  const header = 'slug_fr,slug_en,name_fr,name_en,description_fr,description_en,price,category_slug,barcode,hs_code,weight_kg,image_url,store_slug,source_url,source_product_id,source_category,product_type,storage_info,is_alcoholic';
  const good = 'a-1,a-1,"Vodka A","Vodka A",,,15.99,,,,0.7,https://x/1.jpg,delhaize,https://x/p/1,S1,Alcool,,,true';
  const wholeLine = '"b-2,b-2,""Vodka | B"",""Vodka | B"",,,14.79,,,,0.7,https://x/2.jpg,delhaize,https://x/p/2,S2,Alcool,,,true"' + ','.repeat(18);
  const t = parseCsv([header, good, wholeLine].join('\n'));
  assert.equal(t.rows.length, 2);
  assert.equal(t.rows[1].name_fr, 'Vodka | B');
  assert.equal(t.rows[1].price, '14.79');
  assert.deepEqual(t.unwrappedLines, [3]);
  const res = convert([header, good, wholeLine].join('\n'), { direction: 'eloshon-to-shopify', expectPlatform: 'eloshon' });
  assert.equal(res.counts.failedUnits, 0, 'no more "Produit sans titre"');
  assert.ok(res.warnings.some((w) => w.code === 'rows_unwrapped' && w.params.count === 1));
});

test('a price column that looks like cents is suggested, a column of round euros is not', async () => {
  const { suggestEdits } = await import('../core/dist/index.mjs');
  const cents = ['name,price', ...[1599, 1479, 1445, 2229, 1549, 4599].map((p, i) => `P${i},${p}`)].join('\n');
  assert.deepEqual(suggestEdits(cents), [{ kind: 'cents', column: 'price', sample: '1599 → 15.99' }]);
  const euros = ['name,price', ...[1200, 1500, 900, 2000, 1000, 3500].map((p, i) => `P${i},${p}`)].join('\n');
  assert.deepEqual(suggestEdits(euros), [], 'whole hundreds are euros');
  const decimals = ['name,price', ...[15.99, 14.79, 14.45, 22.29, 15.49, 45.99].map((p, i) => `P${i},${p}`)].join('\n');
  assert.deepEqual(suggestEdits(decimals), []);
  assert.deepEqual(suggestEdits('[{"price":1599}]'), []);
});

test('set_cell: one cell typed by hand, by row and column; a missing row or column is harmless', () => {
  const t = { headers: ['a', 'b'], rows: [{ a: '1', b: 'x' }, { a: '2', b: 'y' }], malformed: [] };
  const { table, report } = applyEdits(t, [
    { id: 'm1', op: 'set_cell', column: 'b', args: { row: 2, text: 'Nouveau texte' } },
    { id: 'm2', op: 'set_cell', column: 'b', args: { row: 9, text: 'ignoré' } },
    { id: 'm3', op: 'set_cell', column: 'zz', args: { row: 1, text: 'ignoré' } },
  ]);
  assert.deepEqual(table.rows.map((r) => r.b), ['x', 'Nouveau texte']);
  assert.equal(report[0].changed, 1);
  assert.equal(report[1].changed, 0);
  assert.equal(report[2].error, 'column_missing');
  assert.equal(t.rows[1].b, 'y', 'the input table is never mutated');
});

test('words_from: the brand is the first word of the title, multi-word brands come from the known list', () => {
  const titles = ['adidas Samba OG', 'Under Armour Hovr Sonic', 'new balance 574', 'Nike Air Max', 'Marque Inconnue Deux'];
  const t = { headers: ['Title', 'Vendor'], rows: titles.map((Title) => ({ Title, Vendor: '' })), malformed: [] };
  const first = applyEdits(t, [{ id: '1', op: 'words_from', column: 'Vendor', args: { from: 'Title' } }]).table;
  assert.deepEqual(first.rows.map((r) => r.Vendor), ['adidas', 'Under', 'new', 'Nike', 'Marque']);
  const learned = applyEdits(t, [{ id: '1', op: 'words_from', column: 'Vendor', args: { from: 'Title', known: 'Under Armour\nNew Balance' } }]);
  assert.deepEqual(learned.table.rows.map((r) => r.Vendor), ['adidas', 'Under Armour', 'new balance', 'Nike', 'Marque'], 'accent- and case-insensitive, original spelling kept');
  const none = applyEdits(t, [{ id: '1', op: 'words_from', column: 'Vendor', args: { from: 'Title', known: 'Under Armour', fallback: 'none' } }]).table;
  assert.deepEqual(none.rows.map((r) => r.Vendor), ['', 'Under Armour', '', '', '']);
  const two = applyEdits(t, [{ id: '1', op: 'words_from', column: 'Vendor', args: { from: 'Title', count: 2 } }]).table;
  assert.equal(two.rows[4].Vendor, 'Marque Inconnue');
  const keep = applyEdits({ ...t, rows: [{ Title: 'Nike Air', Vendor: 'Mine' }] }, [{ id: '1', op: 'words_from', column: 'Vendor', args: { from: 'Title', onlyEmpty: true } }]).table;
  assert.equal(keep.rows[0].Vendor, 'Mine');
  assert.equal(applyEdits(t, [{ id: '1', op: 'words_from', column: 'Vendor', args: { from: 'nope' } }]).report[0].error, 'column_missing');
  const created = applyEdits({ headers: ['Title'], rows: [{ Title: 'Nike Air' }], malformed: [] }, [{ id: '1', op: 'words_from', column: 'Vendor', args: { from: 'Title' } }]).table;
  assert.deepEqual(created.headers, ['Title', 'Vendor']);
  assert.equal(created.rows[0].Vendor, 'Nike');
});

test('template: other columns and the current value dropped where you want them', () => {
  const t = { headers: ['Vendor', 'Title'], rows: [{ Vendor: 'Nike', Title: 'Air Max' }], malformed: [] };
  const { table } = applyEdits(t, [{ id: '1', op: 'template', column: 'Title', args: { text: '{vendor}-{this} {inconnu}' } }]);
  assert.equal(table.rows[0].Title, 'Nike-Air Max {inconnu}');
});

test('"Colour : A / B / C" becomes "A-B-C" with the one-click recipe', () => {
  const edits = expandPreset('values_after_colon_joined', 'Option1 Value');
  const { table } = applyEdits({ headers: ['Option1 Value'], rows: [{ 'Option1 Value': 'Couleur du produit : Aurora Coffee / Magic Mauve / Gum' }, { 'Option1 Value': 'Default Title' }], malformed: [] }, edits);
  assert.deepEqual(table.rows.map((r) => r['Option1 Value']), ['Aurora Coffee-Magic Mauve-Gum', 'Default Title']);
});

// « Nettoyer le code »: the marshydro.eu export (WooCommerce, scraped) carried its technical specs as
// <h3><ul><li><strong> glued to the text, and its categories kept entities such as &#8243; and &#038;.
const BODY = 'Le Kit Drip & Auto-Drain favorise une germination rapide des graines.\nCliquez pour ajouter le Kit Drip.\n'
  + '<h3>Caractéristiques techniques</h3><ul><li><strong>Spectrum</strong> : 660-665nm,2800-3000K, 4800-5000K</li>'
  + '<li><strong>Power Draw</strong> : 150W±5%</li><li><strong>Coverage</strong> : 80x80cm</li>'
  + '<li><strong>Amp Draw</strong> : 1.27A@AC120V 0.638A@AC240V</li><li><strong>Manuel</strong> : Download</li></ul>';

test('clean_code « Texte seul »: tags gone, entities decoded, one « • » line per <li>, a line per paragraph or heading', () => {
  assert.equal(one('clean_code', BODY, { mode: 'text' }).value, [
    'Le Kit Drip & Auto-Drain favorise une germination rapide des graines.',
    'Cliquez pour ajouter le Kit Drip.',
    'Caractéristiques techniques',
    '• Spectrum : 660-665nm,2800-3000K, 4800-5000K',
    '• Power Draw : 150W±5%',
    '• Coverage : 80x80cm',
    '• Amp Draw : 1.27A@AC120V 0.638A@AC240V',
    '• Manuel : Download',
  ].join('\n'));
  // the categories of the same export: numeric (decimal, with a leading zero, hex) and named entities
  assert.equal(one('clean_code', 'Tentes 24&#8243; &#038; plus', { mode: 'text' }).value, 'Tentes 24″ & plus');
  assert.equal(one('clean_code', 'Lampes &amp; LED&nbsp;&nbsp;Pro &#x2033; &eacute;t&eacute;', { mode: 'text' }).value, 'Lampes & LED Pro ″ été');
  assert.equal(one('clean_code', '<p>Un</p><p>Deux<br>Trois</p><p>&nbsp;</p>', { mode: 'text' }).value, 'Un\nDeux\nTrois', '<br> and </p> break the line, the empty paragraph leaves no empty line');
  assert.equal(one('clean_code', '<style>p{color:red}</style><!-- note --><script>alert(1)</script>  Texte   seul  ', { mode: 'text' }).value, 'Texte seul', 'scripts, styles and comments go with their content');
  assert.equal(one('clean_code', 'Prix < 10 € et > 5 €', { mode: 'text' }).value, 'Prix < 10 € et > 5 €', 'a lone « < » is text, not a tag');
  assert.equal(one('clean_code', '<a title="a>b" href="/x">Lien</a>', { mode: 'text' }).value, 'Lien', 'a « > » inside a quoted attribute does not end the tag');
  assert.equal(one('clean_code', '&bogus; &#0; &#xD800;', { mode: 'text' }).value, '&bogus; &#0; &#xD800;', 'an unknown or invalid entity stays as written');
  assert.equal(one('clean_code', 'Déjà propre', { mode: 'text' }).report.changed, 0, 'a clean text is not touched');
});

test('clean_code « HTML propre »: structure tags kept bare, the rest removed, entities decoded except < > &', () => {
  assert.equal(one('clean_code', BODY, { mode: 'html' }).value,
    'Le Kit Drip & Auto-Drain favorise une germination rapide des graines.\nCliquez pour ajouter le Kit Drip.\n'
    + '<h3>Caractéristiques techniques</h3><ul><li><strong>Spectrum</strong> : 660-665nm,2800-3000K, 4800-5000K</li>'
    + '<li><strong>Power Draw</strong> : 150W±5%</li><li><strong>Coverage</strong> : 80x80cm</li>'
    + '<li><strong>Amp Draw</strong> : 1.27A@AC120V 0.638A@AC240V</li><li><strong>Manuel</strong> : Download</li></ul>',
    'already clean structure: nothing but the « & » changes (it was plain text, it stays)');
  const messy = '<div class="desc" style="color:red"><p style="margin:0" data-x="1">Lampe <b>LED</b> <i>pro</i> <a href="https://x.be">voir</a><img src="a.jpg"></p>'
    + '<!-- wp:paragraph --><script>track()</script><style>.a{}</style><p></p><p>&nbsp;</p><ul><li></li></ul>'
    + '<h1>Titre</h1><h6>Petit</h6><span>24&#8243; &#038; plus</span><br/>'
    + '<table class="t"><tbody><tr><th>Taille</th><td></td></tr></tbody></table></div>';
  assert.equal(one('clean_code', messy, { mode: 'html' }).value,
    '<p>Lampe <strong>LED</strong> <em>pro</em> voir</p><h2>Titre</h2><h4>Petit</h4>24″ &amp; plus<br><table><tr><th>Taille</th><td></td></tr></table>');
  assert.equal(one('clean_code', '&lt;script&gt;alert(1)&lt;/script&gt; &#60;b&#62;', { mode: 'html' }).value, '&lt;script&gt;alert(1)&lt;/script&gt; &lt;b&gt;', 'an encoded « < » never becomes a real tag');
  assert.equal(one('clean_code', '<P ALIGN=center>Haut</P><BR>', { mode: 'html' }).value, '<p>Haut</p>', 'upper-case tags read like lower-case ones; a trailing <br> goes');
});

test('clean_code: « Texte seul » is the default mode, and the edit works on the output file too (Body (HTML))', () => {
  assert.equal(one('clean_code', '<p>A</p><ul><li>B</li></ul>', {}).value, 'A\n• B');
  const csv = 'Handle,Body (HTML)\r\nh1,"<p class=""x"">Texte</p><ul><li>Point</li></ul>"\r\n';
  const out = applyEditsToText(csv, [{ id: '1', op: 'clean_code', column: 'Body (HTML)', args: { mode: 'text' } }]);
  assert.deepEqual(parseCsv(out).rows[0], { Handle: 'h1', 'Body (HTML)': 'Texte\n• Point' }, 'the line break survives the CSV round trip');
  const entry = EDIT_CATALOG.find((e) => e.op === 'clean_code');
  assert.deepEqual(entry.args[0].choices.map((c) => c.value), ['text', 'html']);
  for (const c of entry.args[0].choices) for (const lang of ['fr', 'en', 'nl', 'es']) assert.ok(c.help?.[lang], `clean_code ${c.value} help ${lang}`);
});
