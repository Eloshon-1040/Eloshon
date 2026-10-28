import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerBadge } from '../admin/status-badge.mjs';

test('BUG1 status: a configured provider shows "actif" (save reflected without restart)', () => {
  assert.deepEqual(providerBadge({ configured: true, incomplete: false }, { enabled: true }, false), { t: 'actif', c: 'ok' });
});

test('unconfigured → "non configuré"; partially filled → "incomplet"', () => {
  assert.equal(providerBadge({ configured: false, incomplete: false }, { enabled: true }, false).t, 'non configuré');
  assert.equal(providerBadge({ configured: false, incomplete: true }, { enabled: true }, false).t, 'incomplet');
});

test('disabled switch and master kill take precedence over configured', () => {
  assert.equal(providerBadge({ configured: true }, { enabled: false }, false).t, 'désactivé');
  assert.match(providerBadge({ configured: true }, { enabled: true }, true).t, /interrupteur général/);
});
