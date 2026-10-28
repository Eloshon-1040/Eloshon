/**
 * Admin usage display helpers (Points 4–6). The "Passé par" line is ABSENT when
 * the admin is locked (ordinary users see exactly today's screen); otherwise it
 * reads the job's route chain in order, its credits and its estimated cost.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passeParLine, fmtUsd, relTime, reasonText, statusView, providerName, fmtDateTime, fmtBytes, fmtDuration } from '../renderer/admin-usage-ui.js';

const EVENTS = [
  { ts: '2026-10-06T10:00:00Z', provider: 'local', route: 'crawl', channel: 'local', outcome: 'failed', attempted: true, costUsd: 0 },
  { ts: '2026-10-06T10:00:05Z', provider: 'webunlocker', route: 'escalation', channel: 'direct', outcome: 'blocked_no_optin', attempted: false },
  { ts: '2026-10-06T10:00:06Z', provider: 'firecrawl', route: 'escalation', channel: 'direct', outcome: 'success', attempted: true, credits: 2, costUsd: null, testMode: true },
];

test('Passé par: absent when the admin is locked (ordinary users see nothing new)', () => {
  assert.equal(passeParLine(EVENTS, { unlocked: false }), null);
  assert.equal(passeParLine(EVENTS), null);
  assert.equal(passeParLine([], { unlocked: true }), null);
});

test('Passé par: chain in order, credits, unknown cost stated, blocked routes listed, test mode flagged', () => {
  const p = passeParLine(EVENTS, { unlocked: true });
  assert.deepEqual(p.chain, ['Lecture locale (échec)', 'Firecrawl']);
  assert.equal(p.credits, 2);
  assert.match(p.text, /^Passé par : Lecture locale \(échec\) → Firecrawl · 2 crédits · coût estimé inconnu/);
  assert.equal(p.testMode, true);
  assert.deepEqual(p.blocked, ['Bright Data Web Unlocker : site non autorisé']);
});

test('Passé par: a known estimated cost is shown with "≈"', () => {
  const p = passeParLine([{ provider: 'scrapingbrowser', channel: 'direct', outcome: 'success', attempted: true, costUsd: 0.0123 }], { unlocked: true });
  assert.match(p.text, /coût estimé ≈ 0,0123 \$/);
});

test('formatting helpers', () => {
  assert.equal(fmtUsd(null), 'inconnu');
  assert.equal(fmtUsd(0), '0 $');
  assert.equal(fmtUsd(1.5), '≈ 1,50 $');
  assert.equal(relTime(null), 'jamais');
  assert.equal(relTime(new Date(Date.now() - 5 * 60e3).toISOString()), 'il y a 5 min');
  assert.equal(reasonText('http_403'), 'réponse HTTP 403');
  assert.match(reasonText('no_optin'), /onglet Domaines/);
  assert.equal(statusView({ code: 'ready' }).c, 'ok');
  assert.equal(providerName('firecrawl', 'server'), 'Firecrawl (via le serveur)');
  assert.equal(providerName('cascade', 'server'), 'Cascade serveur Eloshon');
  assert.match(fmtDateTime('2026-10-06T19:28:00Z'), /^\d{2}\/\d{2}\/2026 \d{2}:\d{2}$/);
  assert.equal(fmtBytes(2048), '2 Ko');
  assert.equal(fmtDuration(1500), '1,5 s');
});
