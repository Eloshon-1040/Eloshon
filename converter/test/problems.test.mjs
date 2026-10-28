/**
 * Line-by-line problems + actions (ÉTAPE 4): severity classification (honest —
 * blocking only when the import truly fails), exact source lines, "Corriger"
 * through convert(), and "Ignorer" semantics.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convert, serializeCsv, analyzeProblems } from '../core/dist/index.mjs';

const csv = (headers, rows) => serializeCsv(headers, rows);

test('problems: no-title is blocking → canExport false; correction unblocks', () => {
  const file = csv(['Handle', 'Title', 'Variant Price', 'Variant SKU'], [
    { Handle: 'p1', Title: '', 'Variant Price': '10.00', 'Variant SKU': 'SKU1' },
  ]);
  const r1 = analyzeProblems(file, { direction: 'shopify-to-woocommerce' });
  assert.equal(r1.ok, true);
  const noTitle = r1.problems.find((p) => p.code === 'no_title');
  assert.ok(noTitle);
  assert.equal(noTitle.severity, 'blocking');
  assert.equal(noTitle.line, 2);
  assert.equal(noTitle.lineExact, true);
  assert.equal(r1.canExport, false);

  // Correct the title (line 2, field title) → no more blocker.
  const corrections = { 2: { title: 'Ma robe' } };
  const r2 = analyzeProblems(file, { direction: 'shopify-to-woocommerce', corrections });
  assert.equal(r2.problems.some((p) => p.code === 'no_title'), false);
  assert.equal(r2.canExport, true);

  // And the export actually carries the corrected value.
  const out = convert(file, { direction: 'shopify-to-woocommerce', expectPlatform: 'shopify', corrections });
  assert.equal(out.ok, true);
  assert.equal(out.rows.find((r) => r['Name'])['Name'], 'Ma robe');
});

test('problems: duplicate SKU is blocking for Woo/BC, warning for Shopify/Wix', () => {
  const file = csv(['Handle', 'Title', 'Variant Price', 'Variant SKU'], [
    { Handle: 'p1', Title: 'A', 'Variant Price': '10.00', 'Variant SKU': 'DUP' },
    { Handle: 'p2', Title: 'B', 'Variant Price': '12.00', 'Variant SKU': 'DUP' },
  ]);
  const woo = analyzeProblems(file, { direction: 'shopify-to-woocommerce' });
  const dupW = woo.problems.find((p) => p.code === 'duplicate_sku');
  assert.equal(dupW.severity, 'blocking');
  assert.equal(woo.canExport, false);

  const wix = analyzeProblems(file, { direction: 'shopify-to-wix' });
  const dupX = wix.problems.find((p) => p.code === 'duplicate_sku');
  assert.equal(dupX.severity, 'warning');
  assert.equal(wix.canExport, true, 'a warning does not block export');
});

test('problems: exact variant line for a missing price on the 2nd variant', () => {
  const file = csv(['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Variant Price', 'Variant SKU'], [
    { Handle: 'sofa', Title: 'Sofa', 'Option1 Name': 'Taille', 'Option1 Value': 'Petit', 'Variant Price': '100.00', 'Variant SKU': 'SOFA-P' }, // line 2
    { Handle: 'sofa', 'Option1 Value': 'Grand', 'Variant Price': '', 'Variant SKU': 'SOFA-G' }, // line 3, no price
  ]);
  const r = analyzeProblems(file, { direction: 'shopify-to-woocommerce' });
  const mp = r.problems.find((p) => p.code === 'missing_price');
  assert.ok(mp);
  assert.equal(mp.line, 3);
  assert.equal(mp.variant, 'SOFA-G');
  assert.equal(mp.severity, 'warning');

  // Correcting that exact line+field feeds the right variant on export.
  const out = convert(file, { direction: 'shopify-to-woocommerce', expectPlatform: 'shopify', corrections: { 3: { price: '59.90' } } });
  const grand = out.rows.find((row) => row['SKU'] === 'SOFA-G');
  assert.equal(grand['Regular price'], '59.9');
});

test('problems: negative stock is a warning with a 0 suggestion', () => {
  const file = csv(['Handle', 'Title', 'Variant Price', 'Variant SKU', 'Variant Inventory Qty'], [
    { Handle: 'p1', Title: 'A', 'Variant Price': '10.00', 'Variant SKU': 'S1', 'Variant Inventory Qty': '-3' },
  ]);
  const r = analyzeProblems(file, { direction: 'shopify-to-woocommerce' });
  const ns = r.problems.find((p) => p.code === 'negative_stock');
  assert.equal(ns.severity, 'warning');
  assert.equal(ns.suggestion, '0');
});

test('problems: ignore removes a warning but never a blocker', () => {
  const file = csv(['Handle', 'Title', 'Variant Price', 'Variant SKU', 'Variant Inventory Qty'], [
    { Handle: 'p1', Title: '', 'Variant Price': '10.00', 'Variant SKU': 'S1', 'Variant Inventory Qty': '-3' }, // no title (blocking) + neg stock (warning)
  ]);
  const r0 = analyzeProblems(file, { direction: 'shopify-to-woocommerce' });
  const warn = r0.problems.find((p) => p.code === 'negative_stock');
  const block = r0.problems.find((p) => p.code === 'no_title');

  const r1 = analyzeProblems(file, { direction: 'shopify-to-woocommerce', ignored: [warn.id] });
  assert.equal(r1.problems.some((p) => p.id === warn.id), false, 'ignored warning removed from active');
  assert.equal(r1.ignored.some((p) => p.id === warn.id), true, 'kept in the ignored list (undoable)');

  const r2 = analyzeProblems(file, { direction: 'shopify-to-woocommerce', ignored: [block.id] });
  assert.equal(r2.problems.some((p) => p.id === block.id), true, 'a blocker cannot be ignored');
  assert.equal(r2.canExport, false);
});

test('problems: customer no-email blocking + duplicate email warning (exact lines)', () => {
  const file = csv(['First Name', 'Last Name', 'Email', 'Accepts Email Marketing'], [
    { 'First Name': 'A', 'Last Name': 'A', Email: 'a@example.com', 'Accepts Email Marketing': 'yes' }, // line 2
    { 'First Name': 'B', 'Last Name': 'B', Email: '', 'Accepts Email Marketing': 'no' }, // line 3, no email
    { 'First Name': 'C', 'Last Name': 'C', Email: 'a@example.com', 'Accepts Email Marketing': 'yes' }, // line 4, dup
  ]);
  const r = analyzeProblems(file, { direction: 'shopify-to-woocommerce' });
  assert.equal(r.entity, 'customers');
  const noEmail = r.problems.find((p) => p.code === 'customer_no_email');
  assert.equal(noEmail.severity, 'blocking');
  assert.equal(noEmail.line, 3);
  const dup = r.problems.find((p) => p.code === 'duplicate_email');
  assert.equal(dup.severity, 'warning');
  assert.equal(dup.line, 4);
  assert.equal(r.canExport, false);
});

test('problems: FR + EN messages are both present', () => {
  const file = csv(['Handle', 'Title', 'Variant Price', 'Variant SKU'], [{ Handle: 'p1', Title: '', 'Variant Price': '10', 'Variant SKU': 'S1' }]);
  const p = analyzeProblems(file, { direction: 'shopify-to-woocommerce' }).problems[0];
  assert.ok(p.messageFr.length > 0 && p.messageEn.length > 0);
  assert.notEqual(p.messageFr, p.messageEn);
});
