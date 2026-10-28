/**
 * "Scraper via votre navigateur" — launch rules (pure). Generic by construction:
 * the fake domains below are NOT real sites; the same code path must serve any.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hostOf, matchEnabledDomain, matchPermittedDomain, availability, buildLaunch, resolveLimits, defaultLimits,
  resolvePacing, resolveChallengeTimeouts, toExtensionRecipe, outcomeFor, LIMIT_BOUNDS, MESSAGES,
} from '../your-browser/launch.mjs';

const CFG = {
  yourBrowser: {
    limits: { maxProducts: 200 },
    pacing: { baseIntervalMs: 1500 },
    perDomain: {
      'boutique-alpha.test': { enabled: true, limits: { maxListPages: 4 }, pacing: { baseIntervalMs: 2500 } },
      'www.magasin-beta.example': { enabled: true },
      'off-gamma.test': { enabled: false },
    },
  },
  siteContext: { 'boutique-alpha.test': { placeId: '42' } },
};
const UP = { started: true, connected: true, browser: 'chrome', busy: false };
// The extension connected but has authorized these domains live (its host grant).
const UP_PERM = (domains) => ({ ...UP, permittedDomains: domains });

test('hostOf: http(s) only, lowercase, www stripped; rejects junk', () => {
  assert.equal(hostOf('https://WWW.Boutique-Alpha.test/rayon?x=1'), 'boutique-alpha.test');
  assert.equal(hostOf('http://shop.magasin-beta.example'), 'shop.magasin-beta.example');
  for (const bad of ['', 'boutique-alpha.test', 'javascript:alert(1)', 'file:///c:/x', 'ftp://a.be', null, 42, 'https://localhost/']) assert.equal(hostOf(bad), null, String(bad));
});

test('matchEnabledDomain: exact or parent domain, enabled===true only, www-insensitive', () => {
  assert.equal(matchEnabledDomain(CFG, 'boutique-alpha.test').key, 'boutique-alpha.test');
  assert.equal(matchEnabledDomain(CFG, 'shop.magasin-beta.example').key, 'magasin-beta.example');
  assert.equal(matchEnabledDomain(CFG, 'off-gamma.test'), null, 'enabled:false is refused');
  assert.equal(matchEnabledDomain(CFG, 'evilboutique-alpha.test'), null, 'suffix must be a real parent domain');
  assert.equal(matchEnabledDomain({}, 'boutique-alpha.test'), null);
});

test('matchPermittedDomain: exact or parent domain from the extension grant, longest wins', () => {
  assert.equal(matchPermittedDomain(['levi.test', 'shop.levi.test'], 'shop.levi.test'), 'shop.levi.test');
  assert.equal(matchPermittedDomain(['levi.test'], 'www.levi.test'), 'levi.test');
  assert.equal(matchPermittedDomain(['levi.test'], 'evillevi.test'), null, 'suffix must be a real parent');
  assert.equal(matchPermittedDomain([], 'levi.test'), null);
  assert.equal(matchPermittedDomain(null, 'levi.test'), null);
});

test('a domain authorized ONLY in the extension (no config entry) is immediately usable — no config, no restart', () => {
  // Levi's is not in CFG.perDomain at all; the extension has granted it live.
  const av = availability(CFG, 'https://www.levi.test/fr_FR/vetements', UP_PERM(['levi.test']));
  assert.equal(av.ok, true);
  assert.equal(av.domain, 'levi.test');
  assert.equal(av.enabled, true);
  // The product-page limit follows the product limit unless the config sets it (every listed product gets its page).
  assert.deepEqual(av.limits, { maxProducts: 200, maxListPages: LIMIT_BOUNDS.maxListPages.def, maxDetailPages: 200 }, 'global config limits, default per-domain, pages = products');
  const b = buildLaunch({ startUrl: 'https://www.levi.test/fr_FR/vetements', store: 'levi' }, { config: CFG, svc: UP_PERM(['levi.test']), jobId: 'j' });
  assert.equal(b.ok, true);
  assert.equal(b.spec.domain, 'levi.test');
  assert.equal(b.spec.recipe.mode, 'auto', 'no recipe → generic extraction');
  assert.deepEqual(b.spec.pacing, { baseIntervalMs: 1500 }, 'global pacing (no per-domain override)');
});

test('connected but the site is not authorized in the extension → activate-in-extension message (no restart)', () => {
  const r = buildLaunch({ startUrl: 'https://pas-autorise.test/cat' }, { config: CFG, svc: UP, jobId: 'j' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'domain_not_activated');
  assert.match(r.message, /Activer ce domaine/);
  assert.doesNotMatch(r.message, /config\.json|yourBrowser|perDomain/i, 'no config internals');
});

test('a config perDomain entry still authorizes (backward compatible) and provides pacing/limits', () => {
  const av = availability(CFG, 'https://boutique-alpha.test/rayon', UP);
  assert.equal(av.ok, true);
  assert.equal(av.enabled, true);
  const off = buildLaunch({ startUrl: 'https://off-gamma.test/' }, { config: CFG, svc: UP, jobId: 'j' });
  assert.equal(off.code, 'domain_not_activated', 'enabled:false config is not an activation');
});

test('extension not connected → friendly message, whatever the domain', () => {
  const r = buildLaunch({ startUrl: 'https://boutique-alpha.test/c' }, { config: CFG, svc: { ...UP, connected: false }, jobId: 'j' });
  assert.equal(r.code, 'extension_not_connected');
  assert.equal(r.message, 'Installez et connectez l’extension Eloshon Scraper dans votre navigateur pour utiliser ce mode.');
  assert.doesNotMatch(r.message, /E_|ECONN|pipe|native|host|bridge/i);
});

test('malformed renderer input is rejected with a French message', () => {
  for (const bad of [null, undefined, 'https://boutique-alpha.test', [], 42]) {
    const r = buildLaunch(bad, { config: CFG, svc: UP, jobId: 'j' });
    assert.equal(r.ok, false); assert.equal(r.code, 'invalid_request'); assert.equal(r.message, MESSAGES.invalid_request);
  }
  const r2 = buildLaunch({ startUrl: 'pas une url' }, { config: CFG, svc: UP, jobId: 'j' });
  assert.equal(r2.code, 'invalid_url');
});

test('two different domains go through the SAME code path (no hardcoding)', () => {
  const a = buildLaunch({ startUrl: 'https://boutique-alpha.test/rayon/1', store: 'alpha' }, { config: CFG, svc: UP, jobId: 'ja', hints: { internalApi: { type: 'internal_api', endpoint_tpl: 'https://api.boutique-alpha.test/p?o={offset}' } } });
  const b = buildLaunch({ startUrl: 'https://www.magasin-beta.example/cat', store: 'beta' }, { config: CFG, svc: UP, jobId: 'jb', hints: null });
  assert.ok(a.ok && b.ok);
  assert.equal(a.spec.domain, 'boutique-alpha.test');
  assert.equal(b.spec.domain, 'magasin-beta.example');
  assert.equal(a.spec.recipe.domain, 'boutique-alpha.test');
  assert.equal(b.spec.recipe.domain, 'magasin-beta.example');
  assert.equal(a.spec.start_url, 'https://boutique-alpha.test/rayon/1');
  assert.equal(b.spec.recipe.start_url, 'https://www.magasin-beta.example/cat');
  assert.deepEqual(Object.keys(a.spec).sort(), Object.keys(b.spec).sort(), 'identical spec shape for both sites');
  assert.equal(a.spec.config.placeId, '42', 'site context comes from config, not code');
  assert.deepEqual(b.spec.config, {});
});

test('the renderer can NOT choose the domain, recipe or pacing', () => {
  const r = buildLaunch({ startUrl: 'https://boutique-alpha.test/', domain: 'autre.test', recipe: { mode: 'actions', actions: [{ evil: 1 }] }, pacing: { baseIntervalMs: 1 } }, { config: CFG, svc: UP, jobId: 'j', hints: null });
  assert.equal(r.spec.domain, 'boutique-alpha.test');
  assert.equal(r.spec.recipe.mode, 'auto');
  assert.equal(r.spec.recipe.actions, undefined);
  assert.equal(r.spec.pacing.baseIntervalMs, 2500);
});

test('limits: defaults from config (global ← per-domain), user input clamped to hard bounds', () => {
  // maxDetailPages has no fixed default: it follows maxProducts (capped at its bound) unless set in the config or the form.
  assert.deepEqual(defaultLimits(CFG, 'boutique-alpha.test'), { maxProducts: 200, maxListPages: 4, maxDetailPages: 200 });
  assert.deepEqual(defaultLimits({}, null), { maxProducts: 500, maxListPages: 3, maxDetailPages: 500 });
  assert.equal(defaultLimits({ yourBrowser: { limits: { maxProducts: 2000 } } }, null).maxDetailPages, LIMIT_BOUNDS.maxDetailPages.max, 'pages follow products up to their own bound');
  assert.equal(defaultLimits({ yourBrowser: { limits: { maxProducts: 200, maxDetailPages: 5 } } }, null).maxDetailPages, 5, 'a configured page limit wins');
  const r = resolveLimits(CFG, 'boutique-alpha.test', { maxProducts: 1e9, maxListPages: -3, maxDetailPages: 'abc' });
  assert.equal(r.maxProducts, LIMIT_BOUNDS.maxProducts.max, 'never unbounded');
  assert.equal(r.maxListPages, LIMIT_BOUNDS.maxListPages.min);
  assert.equal(r.maxDetailPages, LIMIT_BOUNDS.maxDetailPages.max, 'non-numeric → follows the products asked for (capped)');
  assert.equal(resolveLimits(CFG, 'boutique-alpha.test', { maxProducts: 10 }).maxDetailPages, 10, 'a run of 10 products opens 10 product pages, never 5');
  assert.equal(resolveLimits(CFG, 'boutique-alpha.test', { maxProducts: 10, maxDetailPages: 3 }).maxDetailPages, 3, 'the form may still choose fewer pages');
  assert.equal(resolveLimits({ yourBrowser: { limits: { maxDetailPages: 5 } } }, null, { maxProducts: 10 }).maxDetailPages, 5, 'a configured page limit stays');
  const huge = resolveLimits({ yourBrowser: { limits: { maxProducts: 1e9 } } }, null, {});
  assert.equal(huge.maxProducts, LIMIT_BOUNDS.maxProducts.max, 'config cannot exceed the bounds either');
});

test('pacing: config pacing is forwarded, unknown keys dropped, safety floors applied', () => {
  assert.deepEqual(resolvePacing(CFG, 'boutique-alpha.test'), { baseIntervalMs: 2500 });
  assert.deepEqual(resolvePacing(CFG, 'www.magasin-beta.example'), { baseIntervalMs: 1500 });
  const p = resolvePacing({ yourBrowser: { pacing: { baseIntervalMs: 10, minIntervalMs: 1, burst: 50, evil: 'x', backoffFactor: 1 } } }, null);
  assert.equal(p.baseIntervalMs, 800); assert.equal(p.minIntervalMs, 400); assert.equal(p.burst, 3); assert.equal(p.backoffFactor, 1.5);
  assert.equal(p.evil, undefined);
});

test('challenge timeouts: shorter default (2 min), config-overridable, clamped', () => {
  assert.deepEqual(resolveChallengeTimeouts({}), { solveMs: 120000, pollMs: 3000 });
  assert.deepEqual(resolveChallengeTimeouts({ yourBrowser: { challenge: { solveMs: 90000, pollMs: 5000 } } }), { solveMs: 90000, pollMs: 5000 });
  // Clamped to sane bounds (20 s–10 min, 1 s–15 s) — never unbounded or zero.
  assert.equal(resolveChallengeTimeouts({ yourBrowser: { challenge: { solveMs: 9_000_000 } } }).solveMs, 600000);
  assert.equal(resolveChallengeTimeouts({ yourBrowser: { challenge: { solveMs: 1 } } }).solveMs, 20000);
  assert.equal(resolveChallengeTimeouts({ yourBrowser: { challenge: { pollMs: 0 } } }).pollMs, 3000);
  // The tier forwards it in the spec so the extension applies it.
  const b = buildLaunch({ startUrl: 'https://boutique-alpha.test/c' }, { config: { ...CFG, yourBrowser: { ...CFG.yourBrowser, challenge: { solveMs: 60000 } } }, svc: UP, jobId: 'j' });
  assert.equal(b.spec.challenge.solveMs, 60000);
});

test('recipe: internal_api > learned DOM selectors > generic auto', () => {
  const ctx = { domain: 'x.test', startUrl: 'https://x.test/c' };
  assert.equal(toExtensionRecipe({ internalApi: { type: 'internal_api' } }, ctx).kind, 'internal_api');
  const dom = toExtensionRecipe({ manualSelectors: { card: '.tile', fields: { name: { selector: '.t', attr: null }, url: { selector: 'a', attr: 'href' } } } }, ctx);
  assert.equal(dom.kind, 'dom');
  assert.deepEqual(dom.recipe.selectors, { name: '.t', url: 'a@href' });
  assert.equal(dom.recipe.item_selector, '.tile');
  assert.equal(toExtensionRecipe(null, ctx).kind, 'auto');
});

test('outcomes map to the job vocabulary with non-technical texts', () => {
  assert.deepEqual(outcomeFor({ status: 'done', products: [{}] }), { status: 'done', blocked: null, stoppedByUser: false, text: '' });
  assert.match(outcomeFor({ status: 'done', products: [] }).text, /Aucun produit/);
  const perm = outcomeFor({ status: 'blocked', reason: 'permission_required' });
  assert.equal(perm.status, 'stopped:permission_required'); assert.match(perm.text, /Activer ce domaine/);
  assert.equal(outcomeFor({ status: 'blocked', reason: 'HTTP 403 akamai' }).status, 'stopped:blocked');
  assert.doesNotMatch(outcomeFor({ status: 'blocked', reason: 'HTTP 403 akamai' }).text, /403|akamai/i);
  assert.deepEqual(outcomeFor({ status: 'stopped' }).stoppedByUser, true);
  assert.equal(outcomeFor({ status: 'error', reason: 'TypeError: x is undefined' }).text, 'Le scraping via votre navigateur a échoué.');
  assert.match(outcomeFor({ status: 'error', reason: 'extension_disconnected' }).text, /connexion avec l’extension/);
});
