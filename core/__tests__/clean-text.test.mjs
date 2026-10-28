/**
 * Description/text cleaning — never emit empty HTML or stray "null" tokens as a
 * product description (real cases seen: Lidl "<p>&nbsp;&nbsp;</p>", Colruyt
 * "null Ierse ribeye"). Pure, offline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText } from '../html-meta.mjs';
import { toNormalizedProduct } from '../normalize.mjs';

test('cleanText: empty HTML → null', () => {
  assert.equal(cleanText('<p>&nbsp;&nbsp;</p>'), null);
  assert.equal(cleanText('   '), null);
  assert.equal(cleanText(null), null);
  assert.equal(cleanText('<div><br></div>'), null);
});

test('cleanText: strips a stray leading null/undefined token', () => {
  assert.equal(cleanText('null Ierse ribeye'), 'Ierse ribeye');
  assert.equal(cleanText('undefined Café moulu'), 'Café moulu');
  assert.equal(cleanText('nullable value'), 'nullable value'); // only a standalone token
});

test('cleanText: decodes HEX HTML entities (&#xE9; → é), not just decimal/named', () => {
  // Real leak: tournesols.com description carried literal "synth&#xE9;tique".
  assert.equal(cleanText('gazon synth&#xE9;tique'), 'gazon synthétique');
  assert.equal(cleanText('&#xC9;t&#xE9;'), 'Été');                 // uppercase hex digits
  assert.equal(cleanText('caf&#xe9;'), 'café');                    // lowercase hex digits
  assert.equal(cleanText('a &#x26; b'), 'a & b');                  // hex ampersand
  assert.equal(cleanText('5&#x20AC;'), '5€');                      // multi-digit hex (euro sign)
  // Decimal + named still work (no regression).
  assert.equal(cleanText('caf&#233;'), 'café');
  assert.equal(cleanText('th&eacute;' .replace('&eacute;', '&#xE9;')), 'thé');
});

test('cleanText: strips tags, decodes entities, collapses whitespace', () => {
  assert.equal(cleanText('<p>Bon <b>café</b> &amp; thé</p>'), 'Bon café & thé');
  assert.equal(cleanText('Ligne1<br>Ligne2'), 'Ligne1 Ligne2');
  assert.equal(cleanText('A&#233;B'), 'AéB');
});

test('normalize: garbage descriptions become null / clean text', () => {
  const raw = (over) => ({ name: 'X', description: null, price: 1, images: [], breadcrumb: [], strategy: 's', confidence: 1, ...over });
  assert.equal(toNormalizedProduct(raw({ description: '<p>&nbsp;&nbsp;</p>' })).description, null);
  assert.equal(toNormalizedProduct(raw({ description: 'null Ierse ribeye' })).description, 'Ierse ribeye');
  assert.equal(toNormalizedProduct(raw({ description: '<p>Vrai <b>texte</b></p>' })).description, 'Vrai texte');
});
