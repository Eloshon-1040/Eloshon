import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectChallenge, isBackToNormal } from '../challenge/detect.mjs';
import { defaultChallengeRegistry, RESOLUTION } from '../challenge/index.mjs';

// A scripted env for driving strategies deterministically (no real timers).
function makeEnv({ rechecks = [], signal = { aborted: false } } = {}) {
  let t = 0;
  const notes = []; const logs = [];
  const pacer = { resumeGentlyCalls: 0, onResponseCalls: [], resumeGently() { this.resumeGentlyCalls++; }, onResponse(r) { this.onResponseCalls.push(r); } };
  let i = 0;
  return {
    t: () => t,
    now: () => t,
    sleep: async (ms) => { t += ms; },        // virtual time advances on sleep
    notify: (e) => notes.push(e),
    log: (e) => logs.push(e),
    recheck: async () => (i < rechecks.length ? rechecks[i++] : true),
    pacer, signal, notes, logs,
  };
}

test('detect: captcha marker wins over generic challenge', () => {
  const r = detectChallenge({ status: 200, url: 'https://x/p', body: '<div class="cf-turnstile"></div>' });
  assert.equal(r.category, 'captcha');
});

test('detect: 503 with cloudflare body -> challenge', () => {
  const r = detectChallenge({ status: 503, url: 'https://x/p', body: 'Attention Required | Ray ID' });
  assert.equal(r.category, 'challenge');
});

test('detect: 401 -> auth_required; 429 -> rate_limited', () => {
  assert.equal(detectChallenge({ status: 401, url: 'https://x' }).category, 'auth_required');
  assert.equal(detectChallenge({ status: 429, url: 'https://x' }).category, 'rate_limited');
});

test('detect: recipe config extends defaults (custom DOM marker)', () => {
  const cfg = { challenge: { dom_markers: ['data-wall="hard"'] } };
  assert.equal(detectChallenge({ status: 200, url: 'https://x', body: '<div data-wall="hard">' }, cfg).category, 'challenge');
});

test('detect: clean product page -> null; isBackToNormal true', () => {
  const ctx = { status: 200, url: 'https://x/p', body: '<h1>Produit</h1><span>12,99 €</span>' };
  assert.equal(detectChallenge(ctx), null);
  assert.equal(isBackToNormal(ctx), true);
});

test('isBackToNormal: 4xx is never normal', () => {
  assert.equal(isBackToNormal({ status: 403, url: 'https://x' }), false);
});

test('NO false positive: an anti-bot SDK on a NORMAL content page is not a challenge (Leroy Merlin case)', () => {
  // DataDome / PerimeterX / Incapsula inject their SDK into every normal page. A
  // full product listing that merely LOADS the SDK must not be paused as a challenge.
  const datadome = { status: 200, url: 'https://www.leroymerlin.fr/produits/peinture/c/x', body:
    '<html><head><script src="https://js.datadome.co/tags.js" data-datadome></script></head>'
    + '<body><h1>Peinture intérieure</h1><div class="product">Peinture Blanc 2,5 L — 24,90 €</div>'
    + '<script>window.datadomeOptions={};window.DD_RUM={}</script></body></html>' };
  assert.equal(detectChallenge(datadome), null, 'datadome SDK present ≠ challenge');
  assert.equal(detectChallenge({ status: 200, url: 'https://s/c/x', body: '<div id="_px" class="perimeterx"></div><h1>Liste</h1><span>19,99 €</span>' }), null, 'PerimeterX SDK ≠ challenge');
  assert.equal(detectChallenge({ status: 200, url: 'https://s/c/x', body: '<script>window._imperva_incapsula={}</script><h1>Liste</h1>' }), null, 'Incapsula SDK ≠ challenge');
});

test('NO false positive: a cookie/RGPD banner and a loading screen are not challenges', () => {
  assert.equal(detectChallenge({ status: 200, url: 'https://s/c/x', body: '<div id="onetrust-banner-sdk">Nous utilisons des cookies. Accepter / Refuser</div><h1>Jeans</h1><span>89,95 €</span>' }), null);
  assert.equal(detectChallenge({ status: 200, url: 'https://s/c/x', body: '<div class="loading-spinner">Chargement…</div>' }), null);
});

test('REAL challenge is still caught: DataDome captcha iframe, Cloudflare interstitial, captcha widget', () => {
  assert.equal(detectChallenge({ status: 200, url: 'https://s/x', body: '<iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=x"></iframe>' }).category, 'captcha', 'DataDome captcha iframe');
  assert.equal(detectChallenge({ status: 200, url: 'https://s/x', body: '<div id="challenge-form" class="cf_chl_opt"></div>' }).category, 'challenge', 'Cloudflare challenge');
  assert.equal(detectChallenge({ status: 403, url: 'https://s/x', body: 'Attention Required! | Cloudflare — Ray ID: 8a' }).category, 'challenge', 'challenge text');
});

test('REAL challenge: Incapsula block page and Akamai "access denied" are caught; the SDK cookie alone is not', () => {
  const incapsula = '<html><head><META NAME="ROBOTS" CONTENT="NOINDEX, NOFOLLOW"></head><body><iframe id="main-iframe" src="/_Incapsula_Resource?SWUDNSAI=30&xinfo=…&incident_id=999-123">Request unsuccessful. Incapsula incident ID: 999-123</iframe></body></html>';
  assert.equal(detectChallenge({ status: 200, url: 'https://s/x', body: incapsula }).category, 'challenge', 'Incapsula block page');
  const akamai = '<html><head><title>Access Denied</title></head><body><h1>Access Denied</h1><p>You don\'t have permission to access "…" on this server.<br>Reference #18.abcd1234</p></body></html>';
  assert.equal(detectChallenge({ status: 403, url: 'https://s/x', body: akamai }).category, 'challenge', 'Akamai access-denied');
  // Imperva/Incapsula SDK cookie on a normal page (visid_incap_*) ≠ a block.
  assert.equal(detectChallenge({ status: 200, url: 'https://s/c/x', body: '<script>document.cookie="visid_incap_123=abc"</script><h1>Liste</h1><span>19,99 €</span>' }), null, 'incap SDK cookie alone ≠ block');
});

test('REAL challenge: a branded edge refusal page is caught whatever edge number its reference starts with', async () => {
  const { classifyResponse, STATUS } = await import('../../core/detect.mjs');
  // Shape of a live refusal page read in a real browser on 27/10/2026 (reference « 0.… »; the fixture's was « 18.… »),
  // the reference placed after more than 8 KB of inline styles, as on the real page.
  const block = (ref) => `<html lang="fr"><head><title>Boutique</title><style>${'.c{margin:0}'.repeat(800)}</style></head><body><main><span>Reference Error: ${ref}</span><h1>Nous ne pouvons pas vous laisser accéder à notre site pour l’instant.</h1><p>Un problème de sécurité a été automatiquement détecté.</p></main></body></html>`;
  for (const ref of ['0.f601f351.1793133935.19b66a2e', '18.b5c41102.1792911323.1560b3aa', '214.a1b2c3d4.1793000000.9f8e7d6c']) {
    assert.equal(detectChallenge({ url: 'https://s/p/BD7633.html', body: block(ref) })?.category, 'challenge', `extension check: ${ref}`);
    assert.equal(classifyResponse({ status: 200, url: 'https://s/p/BD7633.html', body: block(ref), headers: {} }).code, STATUS.BOT_CHALLENGE, `app check: ${ref}`);
  }
  // Never a block: a JavaScript error message, a product reference, a page that only talks about references.
  for (const body of [
    '<script>try{x()}catch(e){console.log("ReferenceError: x is not defined")}</script><h1>Chaussure</h1><span>99,95 €</span>',
    '<h1>Perceuse</h1><dl><dt>Référence</dt><dd>0.123456</dd><dt>Reference #</dt><dd>4521.33</dd></dl>',
    '<p>Reference error: 12.5 % of the orders were late.</p>',
  ]) assert.equal(detectChallenge({ url: 'https://s/p', body }), null, body.slice(0, 50));
  // A recipe's pattern is a string; an invalid one is ignored, never thrown.
  assert.equal(detectChallenge({ body: '<p>ok</p>' }, { challenge: { text_regex: ['(unclosed'] } }), null);
  assert.equal(detectChallenge({ body: '<p>Blocked id 77-QX</p>' }, { challenge: { text_regex: ['blocked id \\d+-[a-z]{2}'] } })?.category, 'challenge');
});

test('registry: unknown strategy throws a French error', () => {
  const reg = defaultChallengeRegistry();
  assert.throws(() => reg.create('magic'), /inconnue/);
  assert.deepEqual(reg.names().sort(), ['cooldown_retry', 'hand_back', 'human_in_the_loop']);
});

test('human_in_the_loop: resumes when the page returns to normal', async () => {
  const reg = defaultChallengeRegistry();
  const s = reg.create('human_in_the_loop', { solveMs: 100000, pollMs: 1000 });
  const env = makeEnv({ rechecks: [false, false, true] });
  const res = await s.handle({ category: 'challenge', context: {}, env });
  assert.equal(res.resolution, RESOLUTION.RESUMED);
  assert.equal(env.pacer.resumeGentlyCalls, 1);
  assert.ok(env.notes.some((n) => n.code === 'challenge_paused'));
  assert.ok(env.notes.some((n) => n.code === 'challenge_resolved'));
});

test('human_in_the_loop: blocks on timeout', async () => {
  const reg = defaultChallengeRegistry();
  const s = reg.create('human_in_the_loop', { solveMs: 5000, pollMs: 2000 });
  const env = makeEnv({ rechecks: [false, false, false, false, false] });
  const res = await s.handle({ category: 'challenge', context: {}, env });
  assert.equal(res.resolution, RESOLUTION.BLOCKED);
  assert.equal(res.reason, 'timeout');
  // The user is told exactly how long it waited and that it stopped on its own.
  const to = env.notes.find((n) => n.code === 'challenge_timeout');
  assert.ok(to && /Aucune action détectée après 5 s.*arrêt automatique/.test(to.message), to && to.message);
});

test('human_in_the_loop: stops when the operator aborts', async () => {
  const reg = defaultChallengeRegistry();
  const s = reg.create('human_in_the_loop', { solveMs: 100000, pollMs: 1000 });
  const signal = { aborted: true };
  const env = makeEnv({ rechecks: [false], signal });
  const res = await s.handle({ category: 'challenge', context: {}, env });
  assert.equal(res.resolution, RESOLUTION.STOPPED);
});

test('cooldown_retry: waits then asks for retry, honouring Retry-After', async () => {
  const reg = defaultChallengeRegistry();
  const s = reg.create('cooldown_retry', { maxRetries: 3, cooldownMs: 1000, backoffFactor: 2 });
  const env = makeEnv();
  const res = await s.handle({ category: 'rate_limited', context: { status: 429, retryAfterMs: 8000 }, env });
  assert.equal(res.resolution, RESOLUTION.RETRY);
  assert.equal(res.waitedMs, 8000); // Retry-After beat the 1000ms base backoff
  assert.equal(env.pacer.onResponseCalls.length, 1);
});

test('cooldown_retry: exponential backoff without Retry-After', async () => {
  const reg = defaultChallengeRegistry();
  const s = reg.create('cooldown_retry', { maxRetries: 3, cooldownMs: 1000, backoffFactor: 2 });
  const env = makeEnv();
  const r1 = await s.handle({ category: 'challenge', context: { status: 503 }, env });
  const r2 = await s.handle({ category: 'challenge', context: { status: 503 }, env });
  assert.equal(r1.waitedMs, 1000); // 1000 * 2^0
  assert.equal(r2.waitedMs, 2000); // 1000 * 2^1
});

test('cooldown_retry: blocks after maxRetries', async () => {
  const reg = defaultChallengeRegistry();
  const s = reg.create('cooldown_retry', { maxRetries: 2, cooldownMs: 100 });
  const env = makeEnv();
  await s.handle({ category: 'challenge', context: {}, env });
  await s.handle({ category: 'challenge', context: {}, env });
  const r3 = await s.handle({ category: 'challenge', context: {}, env });
  assert.equal(r3.resolution, RESOLUTION.BLOCKED);
  assert.equal(r3.reason, 'retries_exhausted');
});

test('hand_back: blocks immediately with handBack flag', async () => {
  const reg = defaultChallengeRegistry();
  const s = reg.create('hand_back');
  const env = makeEnv();
  const res = await s.handle({ category: 'challenge', context: { status: 403 }, env });
  assert.equal(res.resolution, RESOLUTION.BLOCKED);
  assert.equal(res.handBack, true);
});
