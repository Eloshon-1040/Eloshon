/**
 * The field catalogue only knew English and French header names (audit): a Dutch,
 * German or Spanish file lost its title and every row failed with
 * product_no_title. Each language below must reach the right canon field, and a
 * file whose title column has a name nobody knows gets the best candidate
 * PROPOSED (never a silent failure, never an automatic guess).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, semanticAnalyze } from '../core/dist/index.mjs';

function analyse(headers, rows) {
  const t = parseCsv([headers.join(';'), ...rows.map((r) => r.join(';'))].join('\n'));
  const report = semanticAnalyze(t.headers, t.rows, 'products', { formatId: 'x', decisions: [] });
  return Object.fromEntries(report.columns.map((c) => [c.column, c]));
}
const canonOf = (cols, column) => cols[column].best?.canon;

const PRODUCTS = [['Stoel', '59,90', '12'], ['Tafel', '129,00', '3'], ['Bank', '249,00', '1']];

const CASES = {
  nl: {
    headers: ['Productnaam', 'Prijs', 'Voorraad', 'Gewicht', 'Merk', 'Beschrijving', 'Artikelnummer', 'Afbeelding'],
    expect: { Productnaam: 'title', Prijs: 'price', Voorraad: 'inventoryQty', Gewicht: 'grams', Merk: 'vendor', Beschrijving: 'bodyHtml', Artikelnummer: 'sku', Afbeelding: 'images' },
    rows: [['Stoel', '59,90', '12', '4,5', 'Ikea', 'Mooie stoel van hout', 'A-100', 'https://x.nl/a.jpg'], ['Tafel', '129,00', '3', '12', 'Ikea', 'Grote tafel eiken', 'A-101', 'https://x.nl/b.jpg'], ['Bank', '249,00', '1', '30', 'Ikea', 'Comfortabele bank', 'A-102', 'https://x.nl/c.jpg']],
  },
  de: {
    headers: ['Artikelbezeichnung', 'Preis', 'Bestand', 'Hersteller', 'Kategorie', 'Artikelnummer'],
    expect: { Artikelbezeichnung: 'title', Preis: 'price', Bestand: 'inventoryQty', Hersteller: 'vendor', Kategorie: 'categories', Artikelnummer: 'sku' },
    rows: [['Stuhl Holz natur', '59,90', '12', 'Ikea', 'Möbel', 'A-100'], ['Tisch Eiche massiv', '129,00', '3', 'Ikea', 'Möbel', 'A-101'], ['Sofa Leder braun', '249,00', '1', 'Ikea', 'Möbel', 'A-102']],
  },
  es: {
    headers: ['Nombre del producto', 'Precio', 'Existencias', 'Marca', 'Categoría', 'Referencia'],
    expect: { 'Nombre del producto': 'title', Precio: 'price', Existencias: 'inventoryQty', Marca: 'vendor', 'Categoría': 'categories', Referencia: 'sku' },
    rows: [['Silla de madera', '59,90', '12', 'Ikea', 'Muebles', 'A-100'], ['Mesa de roble', '129,00', '3', 'Ikea', 'Muebles', 'A-101'], ['Sofá de cuero', '249,00', '1', 'Ikea', 'Muebles', 'A-102']],
  },
  it: {
    headers: ['Nome prodotto', 'Prezzo', 'Giacenza', 'Marca', 'Codice articolo'],
    expect: { 'Nome prodotto': 'title', Prezzo: 'price', Giacenza: 'inventoryQty', Marca: 'vendor', 'Codice articolo': 'sku' },
    rows: [['Sedia in legno', '59,90', '12', 'Ikea', 'A-100'], ['Tavolo in rovere', '129,00', '3', 'Ikea', 'A-101'], ['Divano in pelle', '249,00', '1', 'Ikea', 'A-102']],
  },
  ca: {
    headers: ['Nom del producte', 'Preu', 'Estoc', 'Marca', 'Referència'],
    expect: { 'Nom del producte': 'title', Preu: 'price', Estoc: 'inventoryQty', Marca: 'vendor', 'Referència': 'sku' },
    rows: [['Cadira de fusta', '59,90', '12', 'Ikea', 'A-100'], ['Taula de roure', '129,00', '3', 'Ikea', 'A-101'], ['Sofà de cuir', '249,00', '1', 'Ikea', 'A-102']],
  },
};

for (const [lang, c] of Object.entries(CASES)) {
  test(`${lang}: every header reaches its canon field`, () => {
    const cols = analyse(c.headers, c.rows);
    for (const [column, canon] of Object.entries(c.expect)) {
      assert.equal(canonOf(cols, column), canon, `${lang} · ${column}`);
      assert.ok(['auto', 'suggest'].includes(cols[column].status), `${lang} · ${column} status ${cols[column].status}`);
    }
    assert.equal(cols[c.headers[0]].status, 'auto', `${lang}: the title must be recognised without asking`);
  });
}

test('FR: "Masse en grammes" is a weight, not a stock quantity', () => {
  const cols = analyse(['Désignation', 'Masse en grammes', 'Prix de vente'], [['Chaise', '500', '59,90'], ['Table', '750', '129,00'], ['Banc', '640', '89,50']]);
  assert.equal(canonOf(cols, 'Masse en grammes'), 'grams');
});

test('a title column with a name nobody knows is PROPOSED, not lost', () => {
  const cols = analyse(['Code', 'Libellé interne', 'Zzz'], [['A1', 'Chaise en bois naturel', 'x'], ['A2', 'Table en chêne massif', 'y'], ['A3', 'Canapé cuir brun', 'z']]);
  const col = cols['Libellé interne'];
  assert.equal(col.status, 'suggest', 'never automatic');
  assert.equal(col.best.canon, 'title');
  assert.ok(col.best.reasons.includes('fallback:title-candidate'));
  assert.notEqual(cols.Code.best?.canon, 'title');
});

test('no fallback when the file has a title, or no plausible text column', () => {
  const withTitle = analyse(['Titre', 'Description interne'], [['Chaise', 'xx yy zz aa'], ['Table', 'bb cc dd ee'], ['Banc', 'ff gg hh ii']]);
  assert.equal(withTitle['Description interne'].best?.reasons?.includes('fallback:title-candidate') ?? false, false);
  const numbersOnly = analyse(['A', 'B'], [['1', '10'], ['2', '20'], ['3', '30']]);
  assert.ok(Object.values(numbersOnly).every((c) => !(c.best?.reasons ?? []).includes('fallback:title-candidate')));
});
