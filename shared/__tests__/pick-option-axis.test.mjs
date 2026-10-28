// Phase 6: a 🎯 designation on a picker the shopper chooses from (size buttons, colour swatches, radios) is an
// option axis: the whole group, its name as the page writes it, and each value's price when the page shows one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { pickField, groupAxisName } from '../extract/pick-selector.mjs';
import { listValues, valueWithPrice } from '../extract/card-recipe.mjs';

const PAGE = `<html><body>
  <h1>Eau de parfum Rose</h1>
  <div class="size-block"><span class="lbl">Contenance :</span>
    <ul class="sizes"><li><button class="size-btn" aria-pressed="true">30 ML <span>77,70 €</span></button></li><li><button class="size-btn">50 ML <span>115,50 €</span></button></li></ul></div>
  <fieldset class="col"><legend>Couleur</legend>
    <label class="sw"><input type="radio" name="c" value="Rose"><span>Rose</span></label><label class="sw"><input type="radio" name="c" value="Ambre"><span>Ambre</span></label></fieldset>
</body></html>`;

test('a click on one size button takes the whole picker, its name and each size with its price', () => {
  const { document } = parseHTML(PAGE);
  const btn = document.querySelectorAll('button.size-btn')[1];
  // The field is called « Champ 1 »: the picker itself makes it a list (no name needed).
  const r = pickField(btn, { doc: document, fieldKey: 'champ_1', page: true });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.chooser, true);
  assert.equal(r.axis, 'Contenance');
  assert.equal(r.sample, '30 ML : 77.70 | 50 ML : 115.50');
  // The cell every page gives for this field (what readCards writes): the same values, prices included.
  assert.deepEqual(listValues([...document.querySelectorAll(`ul.sizes > ${r.all}`)]), ['30 ML : 77.70', '50 ML : 115.50']);
});

test('radio swatches in a fieldset: the legend names the axis', () => {
  const { document } = parseHTML(PAGE);
  const r = pickField(document.querySelectorAll('label.sw span')[0], { doc: document, fieldKey: 'champ_2', page: true });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.axis, 'Couleur');
  assert.equal(r.sample, 'Rose | Ambre');
});

test('a price needs its currency: « 38,5 » stays a size; « Choisissez une taille » names the axis « taille »', () => {
  assert.equal(valueWithPrice('38,5'), '38,5');
  assert.equal(valueWithPrice('M — €12.99'), 'M : 12.99');
  assert.equal(valueWithPrice('12,99 €'), '12,99 €', 'a price alone is not a value');
  const { document } = parseHTML('<div><p>Choisissez une taille :</p><div class="g" ><a>S</a><a>M</a></div></div>');
  assert.equal(groupAxisName(document.querySelector('.g'), document), 'taille');
  assert.deepEqual(listValues([...document.querySelectorAll('.g a')]), ['S', 'M']);
});
