/**
 * registrableHost / sameSite (url-utils): a product fiche that lives on a
 * locale/region subdomain must count as the same SITE as the listing, so grids
 * whose links point at nl./fr./m. twins are not silently dropped. Measured need:
 * AliExpress serves /item/ links on nl.aliexpress.com off a www.aliexpress.com
 * listing. The ccTLD SLD exception keeps shop.co.uk and blog.co.uk distinct-safe.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registrableHost, sameSite } from '../url-utils.mjs';

test('registrableHost: plain two-label and subdomains collapse to the registrable domain', () => {
  assert.equal(registrableHost('aliexpress.com'), 'aliexpress.com');
  assert.equal(registrableHost('www.aliexpress.com'), 'aliexpress.com');
  assert.equal(registrableHost('nl.aliexpress.com'), 'aliexpress.com');
  assert.equal(registrableHost('m.shop.example.com'), 'example.com');
});

test('registrableHost: public ccTLD SLDs keep three labels', () => {
  assert.equal(registrableHost('shop.example.co.uk'), 'example.co.uk');
  assert.equal(registrableHost('www.example.com.au'), 'example.com.au');
  assert.equal(registrableHost('boutique.example.gouv.fr'), 'example.gouv.fr');
});

test('sameSite: locale subdomain of the same registrable domain matches', () => {
  assert.equal(sameSite('https://www.aliexpress.com/w/x.html', 'https://nl.aliexpress.com/item/1.html'), true);
  assert.equal(sameSite('https://shop.example.com/c', 'https://m.example.com/p/1'), true);
});

test('sameSite: different registrable domains, and same-SLD siblings, do NOT match', () => {
  assert.equal(sameSite('https://example.com/c', 'https://evil.com/p'), false);
  assert.equal(sameSite('https://shop.co.uk/c', 'https://blog.co.uk/p'), false); // both are bare public SLDs
});

test('sameSite: garbage input never throws', () => {
  assert.equal(sameSite('not a url', 'https://x.com'), false);
  assert.equal(sameSite('', ''), false);
});
