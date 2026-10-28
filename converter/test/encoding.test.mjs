import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeBytes } from '../lib/encoding.mjs';
import { parseCsv } from '../core/dist/index.mjs';

const cp1252 = (s) => Uint8Array.from(Array.from(s, (c) => ({ 'é': 0xe9, 'É': 0xc9, 'è': 0xe8, 'ç': 0xe7, '€': 0x80, 'ß': 0xdf }[c] ?? c.charCodeAt(0))));

test('a Windows-1252 file keeps its accents instead of becoming replacement characters', () => {
  const r = decodeBytes(cp1252('Nom;Prix\nÉbène;12,50 €\nGarçon;3\n'));
  assert.equal(r.encoding, 'windows-1252');
  assert.equal(r.replacementChars, 0);
  assert.deepEqual(parseCsv(r.text).rows.map((x) => x.Nom), ['Ébène', 'Garçon']);
});

test('UTF-8 stays UTF-8, with or without a BOM', () => {
  const body = new TextEncoder().encode('Nom;Prix\nÉbène;1\n');
  assert.equal(decodeBytes(body).encoding, 'utf-8');
  assert.equal(decodeBytes(body).text, 'Nom;Prix\nÉbène;1\n');
  const withBom = Uint8Array.from([0xef, 0xbb, 0xbf, ...body]);
  const r = decodeBytes(withBom);
  assert.equal(r.encoding, 'utf-8');
  assert.equal(r.text.charCodeAt(0), 'N'.charCodeAt(0), 'BOM removed');
});

test('UTF-16 with a BOM, and UTF-16 without one, are read', () => {
  const s = 'Nom;Prix\nÉbène;1\n';
  const le = new Uint8Array(2 + s.length * 2);
  le[0] = 0xff; le[1] = 0xfe;
  for (let i = 0; i < s.length; i++) { le[2 + i * 2] = s.charCodeAt(i) & 0xff; le[3 + i * 2] = s.charCodeAt(i) >> 8; }
  assert.equal(decodeBytes(le).text, s);
  assert.equal(decodeBytes(le).encoding, 'utf-16le');
  const noBom = le.slice(2);
  const r = decodeBytes(noBom);
  assert.equal(r.encoding, 'utf-16le');
  assert.equal(r.text, s);
});

test('characters already lost at the source are counted, not hidden', () => {
  const r = decodeBytes(new TextEncoder().encode('Nom\n�b�ne\n'));
  assert.equal(r.encoding, 'utf-8');
  assert.equal(r.replacementChars, 2);
});
