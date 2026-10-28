import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planImport, extractValues } from '../providers/import-env.mjs';
import { zyteConfig, zyteFetch } from '../unlock/zyte.mjs';

const ENV = [
  '# comment',
  'BRIGHT-DATA-API-KEY=FAKE_BD',
  'BROWSER_AUTH="FAKE_BROWSER_AUTH"',
  'FIRECRAWL-API-KEY=FAKE_FC',
  'ZYTE_API_KEY=FAKE_ZYTE',
  'WIX_SECRET_KEY=FAKE_WIX',   // unmapped (not a scraping provider)
  'EMPTY=',
].join('\n');

test('planImport maps known NAMES to provider fields and lists unmapped — no values', () => {
  const plan = planImport(ENV);
  const json = JSON.stringify(plan);
  assert.ok(!/FAKE_/.test(json), 'preview must not contain any value');
  const byName = Object.fromEntries(plan.mapped.map((m) => [m.name, m]));
  assert.equal(byName['BRIGHT-DATA-API-KEY'].providerId, 'brightData.webUnlocker');
  assert.equal(byName['BRIGHT-DATA-API-KEY'].field, 'apiKey');
  assert.equal(byName['BROWSER_AUTH'].providerId, 'brightData.scrapingBrowser');
  assert.equal(byName['FIRECRAWL-API-KEY'].providerId, 'firecrawl');
  assert.equal(byName['ZYTE_API_KEY'].providerId, 'zyte');
  assert.ok(plan.unmapped.includes('WIX_SECRET_KEY'));
});

test('extractValues returns the value-map for the secure store (main only), quotes stripped', () => {
  const vals = extractValues(ENV);
  assert.equal(vals['brightData.webUnlocker'].apiKey, 'FAKE_BD');
  assert.equal(vals['brightData.scrapingBrowser'].browserAuth, 'FAKE_BROWSER_AUTH'); // quotes stripped
  assert.equal(vals.firecrawl.apiKey, 'FAKE_FC');
  assert.equal(vals.zyte.apiKey, 'FAKE_ZYTE');
  assert.equal(vals.WIX_SECRET_KEY, undefined); // unmapped not extracted
});

test('zyteConfig reads config then ZYTE_API_KEY env NAME', () => {
  assert.equal(zyteConfig({ zyte: { apiKey: 'FAKE' } }, {}).configured, true);
  assert.equal(zyteConfig({}, { ZYTE_API_KEY: 'FAKE' }).configured, true);
  assert.equal(zyteConfig({}, {}).configured, false);
});

test('zyteFetch: not configured is inert (no request)', async () => {
  let called = 0;
  const r = await zyteFetch('https://x/p', { apiKey: null, fetchImpl: async () => { called++; return { status: 200, json: async () => ({}) }; } });
  assert.equal(r.ok, false);
  assert.equal(r.note, 'not_configured');
  assert.equal(called, 0);
});

test('zyteFetch: httpResponseBody (base64) decoded to html', async () => {
  const html = '<html><h1>Produit</h1></html>';
  const fetchImpl = async (url, opts) => {
    assert.equal(url, 'https://api.zyte.com/v1/extract');
    assert.match(opts.headers.Authorization, /^Basic /);
    assert.ok(JSON.parse(opts.body).httpResponseBody === true);
    return { status: 200, json: async () => ({ httpResponseBody: Buffer.from(html, 'utf8').toString('base64') }) };
  };
  const r = await zyteFetch('https://x/p', { apiKey: 'FAKE', fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.html, html);
  assert.ok(r.bytes > 0);
});

test('zyteFetch: browser mode requests browserHtml', async () => {
  const fetchImpl = async (url, opts) => { assert.equal(JSON.parse(opts.body).browserHtml, true); return { status: 200, json: async () => ({ browserHtml: '<html>ok</html>' }) }; };
  const r = await zyteFetch('https://x/p', { apiKey: 'FAKE', browser: true, fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.html, '<html>ok</html>');
});

test('zyteFetch: 401 maps to auth_error and never throws', async () => {
  const fetchImpl = async () => ({ status: 401, json: async () => ({ detail: 'invalid key' }) });
  const r = await zyteFetch('https://x/p', { apiKey: 'FAKE', fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.note, 'auth_error');
});

test('zyteFetch never leaks the key into the returned object/errors', async () => {
  const fetchImpl = async () => ({ status: 500, json: async () => ({ detail: 'boom' }) });
  const r = await zyteFetch('https://x/p', { apiKey: 'FAKE_ZYTE_SECRET', fetchImpl });
  assert.ok(!JSON.stringify(r).includes('FAKE_ZYTE_SECRET'));
});
