import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorFromSpecs, toNormalizedProduct } from '../normalize.mjs';

const specs = [
  { group: 'Affichage', name: 'Écran couleur', value: 'Oui' },
  { group: 'Boîtier', name: 'Modèle', value: 'KX-TU110EXC' },
  { group: 'Boîtier', name: 'Couleur (selon le fabriquant)', value: 'Bleu' },
];

test('colorFromSpecs: the colour a page states in its specs; never « Écran couleur », never a yes/no', () => {
  assert.equal(colorFromSpecs(specs), 'Bleu');
  assert.equal(colorFromSpecs([{ name: 'Écran couleur', value: 'Oui' }, { name: 'Nombre de couleurs', value: '16' }]), null);
  assert.equal(colorFromSpecs([{ name: 'Couleur', value: 'Non' }]), null);
  assert.equal(colorFromSpecs(undefined, { 'Color': 'Black' }), 'Black');
  assert.equal(colorFromSpecs(undefined, undefined), null);
  // a bundle (phone + case) states one colour per item: no single colour, so none is guessed
  assert.equal(colorFromSpecs([{ name: 'Couleur', value: 'Silver' }, { name: 'Couleur', value: 'Transparent' }]), null);
  assert.equal(colorFromSpecs([{ name: 'Couleur', value: 'Bleu' }, { name: 'Couleur du boîtier', value: 'bleu' }]), 'Bleu');
});

test('a product keeps the colour its own reader found; the specs only fill an empty one (CSV cell)', () => {
  const base = { name: 'PANASONIC GSM Easy Use KX-TU110EXC Bleu', price: 39.99, sourceUrl: 'https://s.test/p/1', specs };
  assert.equal(toNormalizedProduct({ ...base }).color, 'Bleu');
  assert.equal(toNormalizedProduct({ ...base, color: 'Noir' }).color, 'Noir');
  assert.equal(toNormalizedProduct({ ...base, specs: undefined }).color, null);
});
