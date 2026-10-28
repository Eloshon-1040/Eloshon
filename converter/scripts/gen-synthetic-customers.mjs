/**
 * Chantier 4 — synthetic Shopify customers fixture.
 *
 * The real export (test/fixtures/shopify-customers-real/customers_export.csv,
 * 4204 real people with names, e-mails, addresses and phone numbers) is NEVER
 * published, not even partially. This script does NOT anonymise it: it reads
 * the real file ONLY to (a) copy the column list verbatim — including the
 * `froonze_cp_custom` metafield columns — and (b) build a denylist of every
 * value that appears in it, so a generated row can never accidentally collide
 * with a real one (a city name or a postcode is enough to help re-identify).
 *
 * Everything written out is invented: names from a fixed made-up pool,
 * addresses on invented street names, e-mails at exemple.com, phone numbers in
 * the Belgian reserved-for-fiction +32 2 555 xx xx range.
 *
 * Deterministic: a fixed seed means re-running produces byte-identical output,
 * so the fixture can be committed and frozen as a golden.
 *
 *   node scripts/gen-synthetic-customers.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseCsv, serializeCsv } from '../core/dist/index.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const REAL = path.join(ROOT, 'test/fixtures/shopify-customers-real/customers_export.csv');
const OUT_DIR = path.join(ROOT, 'test/fixtures/shopify-customers-synthetic');
const OUT = path.join(OUT_DIR, 'customers_export.csv');
const COUNT = 60;

// ── deterministic PRNG (mulberry32) ──────────────────────────────────────────
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = rng(20260922);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

// ── invented pools (no real person, no real company) ─────────────────────────
const FIRST = ['Amaury', 'Berthe', 'Célestin', 'Doriane', 'Edmée', 'Firmin', 'Gaëlle', 'Hilaire', 'Isaure', 'Jocelyn',
  'Kerwan', 'Ludivine', 'Marceau', 'Noémie', 'Odilon', 'Pernelle', 'Quentin', 'Roselyne', 'Séverin', 'Thibaut',
  'Ursule', 'Valérian', 'Wilfried', 'Xavière', 'Yohan', 'Zélie'];
const LAST = ['Vanbrugghe', 'Delcourtois', 'Maerevoet', 'Snauwaert', 'Verhulstyn', 'Dubrunfaut', 'Ghislenghien',
  'Lampaert', 'Rouvroye', 'Tisselin', 'Wauquiez', 'Bracqmont', 'Devlieghere', 'Hanocq', 'Mestdagh',
  'Ockerhout', 'Pirlouit', 'Salembier', 'Truyens', 'Zwaenepoel'];
const STREET = ['Rue des Faisandiers', 'Avenue du Tilleul Creux', 'Chaussée de Blanmoulin', 'Rue Haute-Fontenelle',
  'Drève des Charmilles', 'Clos du Vieux Pressoir', 'Rue de la Verrerie Neuve', 'Boulevard des Ardoisiers',
  'Chemin du Moulin Brûlé', 'Place des Cinq Tilleuls', 'Rue du Pont Cassé', 'Allée des Grèbes'];
// Invented locality names (deliberately NOT real Belgian towns). Their
// postcodes are NOT hardcoded: they are drawn at generation time from the
// Belgian 4-digit shape MINUS every postcode present in the real export, so a
// generated address can never reuse a real one (see assignPostcodes).
const CITY_NAMES = ['Blanmoulin', 'Fontenelles', 'Verrebroek-sur-Dyle', 'Hautrival', 'Neufcharmoy',
  'Pontcassé', 'Ardoisières', 'Grèbelange', 'Tilleulmont', 'Saint-Brugnon'];
const COMPANY = ['Atelier Grèbelange', 'Brasserie du Pont Cassé', 'Comptoir Hautrival', 'Duraflor SPRL',
  'Ébénisterie Tilleulmont', 'Ferronnerie Blanmoulin', 'Graineterie Neufcharmoy', 'Horticole Ardoisières'];
const NOTE = ['', '', '', 'Client fidèle depuis l ouverture', 'Livraison en point relais uniquement',
  'Facturation trimestrielle', 'Contact par e-mail de préférence'];

function main() {
  // (a) columns, verbatim from the real export
  const real = parseCsv(readFileSync(REAL, 'utf8'));
  const headers = real.headers;

  // (b) denylist: every non-empty value of the IDENTIFYING columns of the real
  // file. Enum / boolean / counter columns ("yes", "BE", "2") are excluded —
  // they collide by construction and carry no re-identification risk; it is the
  // free-text and address columns that must never overlap.
  // Columns that identify a person ON THEIR OWN: an e-mail, a street address,
  // a phone number, a VAT number or a free-text note points at one human.
  const IDENTIFYING = headers.filter((h) =>
    /^(Email|Default Address Company|Default Address Address1|Default Address Address2|Default Address City|Default Address Zip|Default Address Phone|Phone|Note)$/.test(h)
    || /froonze_cp_custom\.(company|taxes_number|website_url)/.test(h));
  const deny = new Set();
  for (const row of real.rows) {
    for (const h of IDENTIFYING) {
      const v = String(row[h] ?? '').trim();
      if (v) deny.add(v.toLowerCase());
    }
  }
  // A first name alone identifies nobody (a 4204-row Belgian file contains
  // every common French first name by construction), but a FULL name does —
  // so the pair is denied, not each token.
  const denyFullName = new Set(real.rows
    .map((r) => `${String(r['First Name'] ?? '').trim()} ${String(r['Last Name'] ?? '').trim()}`.trim().toLowerCase())
    .filter((s) => s.length > 1));

  // Each invented locality gets a 4-digit postcode that appears nowhere in the
  // real export. Deterministic: the first free code from a fixed walk.
  const realZips = new Set(real.rows.map((r) => String(r['Default Address Zip'] ?? '').trim()).filter(Boolean));
  const CITY = [];
  let probe = 1301;
  for (const nameOfCity of CITY_NAMES) {
    while (realZips.has(String(probe)) && probe < 9999) probe += 7;
    if (probe >= 9999) throw new Error('no free Belgian postcode left for the synthetic fixture');
    CITY.push([nameOfCity, String(probe)]);
    probe += 7;
  }

  const rows = [];
  const usedEmails = new Set();
  for (let i = 0; i < COUNT; i++) {
    const first = pick(FIRST);
    const last = pick(LAST);
    const [city, zip] = pick(CITY);
    const hasCompany = chance(0.3);
    const company = hasCompany ? pick(COMPANY) : '';
    const n = String(i + 1).padStart(3, '0');
    let email = `${first.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')}.${last.toLowerCase()}${n}@exemple.com`;
    while (usedEmails.has(email)) email = `x${email}`;
    usedEmails.add(email);

    const orders = chance(0.25) ? 0 : int(1, 14);
    const spent = orders === 0 ? '0.00' : (orders * (int(1800, 24000) / 100)).toFixed(2);
    // +32 2 555 xx xx — the 555 block is the conventional fiction range.
    const phone = `+32 2 555 ${String(int(10, 99))} ${String(int(10, 99))}`;

    const row = {};
    for (const h of headers) row[h] = '';
    row['Customer ID'] = String(9000000000000 + i);
    row['First Name'] = first;
    row['Last Name'] = last;
    row['Email'] = email;
    row['Accepts Email Marketing'] = chance(0.45) ? 'yes' : 'no';
    row['Default Address Company'] = company;
    row['Default Address Address1'] = `${int(1, 240)} ${pick(STREET)}`;
    row['Default Address Address2'] = chance(0.2) ? `Boîte ${int(1, 9)}` : '';
    row['Default Address City'] = city;
    row['Default Address Province Code'] = '';
    row['Default Address Country Code'] = 'BE';
    row['Default Address Zip'] = zip;
    row['Default Address Phone'] = chance(0.5) ? phone : '';
    row['Phone'] = phone;
    row['Accepts SMS Marketing'] = chance(0.2) ? 'yes' : 'no';
    row['Total Spent'] = spent;
    row['Total Orders'] = String(orders);
    row['Note'] = pick(NOTE);
    row['Tax Exempt'] = hasCompany && chance(0.3) ? 'yes' : 'no';
    // froonze_cp_custom metafields — present on the real export, kept here so
    // the conversion demo exercises the metafield path too.
    for (const h of headers) {
      if (h.includes('froonze_cp_custom.company')) row[h] = company;
      else if (h.includes('froonze_cp_custom.taxes_number')) row[h] = hasCompany ? `BE0${int(100000000, 999999999)}` : '';
      else if (h.includes('froonze_cp_custom.website_url')) row[h] = hasCompany && chance(0.5) ? `https://www.${company.toLowerCase().replace(/[^a-z]+/g, '-')}.example` : '';
    }
    rows.push(row);
  }

  // Hard guard: no identifying value — and no full name — we emit may collide
  // with a real one.
  const collisions = [];
  for (const [i, row] of rows.entries()) {
    for (const h of IDENTIFYING) {
      const v = String(row[h] ?? '').trim();
      if (v && deny.has(v.toLowerCase())) collisions.push(`row ${i + 1} · ${h} · ${v}`);
    }
    const full = `${row['First Name']} ${row['Last Name']}`.trim().toLowerCase();
    if (denyFullName.has(full)) collisions.push(`row ${i + 1} · full name · ${full}`);
  }
  if (collisions.length) {
    console.error('REFUSED: generated values collide with the real export:\n  ' + collisions.slice(0, 20).join('\n  '));
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT, serializeCsv(headers, rows), 'utf8');
  console.log(`wrote ${rows.length} synthetic customers → ${path.relative(ROOT, OUT)}`);
  console.log(`columns: ${headers.length} (verbatim from the real export, values 100% invented)`);
  console.log(`collision check against ${real.rows.length} real rows: 0`);
}

main();
