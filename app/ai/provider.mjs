/**
 * AI-assist model provider — the app-side `askJson` injected into the shared
 * ai-assist core. It calls the Anthropic Messages API with the admin's key (resolved
 * from the SAME encrypted provider store as every paid provider — never shipped, never
 * in the extension). The core builds the prompt and validates the JSON; this only
 * performs the HTTP call and returns the model's text.
 *
 * Runs in the main process only. `fetchImpl` is injectable for tests.
 */

import { withinDeadline, DeadlineError } from '../../shared/net/deadline.mjs';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

/**
 * @param {{apiKey:string, model?:string, maxTokens?:number, fetchImpl?:Function}} opts
 * @returns {(prompt:string)=>Promise<string>} askJson — resolves to the model's text.
 */
export function createAnthropicAsker({ apiKey, model = 'claude-haiku-4-5-20251001', maxTokens = 2048, fetchImpl, onCall, timeoutMs = 60000 } = {}) {
  if (!apiKey) throw new Error('ai_key_missing');
  const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) throw new Error('fetch_unavailable');
  // Usage report for the ledger: model, token counts, status, duration — NEVER the
  // prompt or the model's reply. Best-effort: a failing listener changes nothing.
  const report = (info) => { if (typeof onCall === 'function') { try { onCall({ model, ...info }); } catch { /* ignore */ } } };
  return async function askJson(prompt) {
    const t0 = Date.now();
    // One deadline for the request AND the body read (shared/net/deadline.mjs).
    let res; let data = null; let errText = '';
    try {
      ({ res, data, errText } = await withinDeadline(async (signal) => {
        const r = await doFetch(ANTHROPIC_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model, max_tokens: maxTokens, temperature: 0, messages: [{ role: 'user', content: prompt }] }),
          ...(signal ? { signal } : {}),
        });
        if (!r || !r.ok) { let t = ''; try { t = await r.text(); } catch { /* no body */ } return { res: r, data: null, errText: t }; }
        return { res: r, data: await r.json(), errText: '' };
      }, { timeoutMs }));
    } catch (e) {
      const timedOut = e instanceof DeadlineError && e.kind === 'timeout';
      report({ ok: false, status: 0, reason: timedOut ? 'timeout' : 'network_error', durationMs: Date.now() - t0 });
      if (timedOut) throw new Error(`ai_timeout: no answer within ${timeoutMs} ms`);
      throw e;
    }
    if (!res || !res.ok) {
      const code = res && res.status;
      // Surface Anthropic's own error text (e.g. "model: … not found", "credit balance
      // too low") — not a secret, and the only way to diagnose from the UI.
      let detail = ''; let type = '';
      try { const j = JSON.parse(errText); detail = (j && j.error && (j.error.message || j.error.type)) || ''; type = (j && j.error && j.error.type) || ''; } catch { /* no body */ }
      report({ ok: false, status: code || 0, reason: `ai_http_${code || 'error'}${type ? `:${type}` : ''}`, durationMs: Date.now() - t0 });
      throw new Error(`ai_http_${code || 'error'}${detail ? `: ${String(detail).slice(0, 180)}` : ''}`);
    }
    const u = (data && data.usage) || {};
    report({ ok: true, status: res.status || 200, tokensIn: u.input_tokens ?? null, tokensOut: u.output_tokens ?? null, durationMs: Date.now() - t0 });
    // Messages API returns content blocks; concatenate the text blocks. parseHints in
    // the core handles JSON / code-fenced output, so we return the raw text.
    const text = Array.isArray(data && data.content)
      ? data.content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('')
      : '';
    return text;
  };
}

/** A friendly, non-technical French line for an AI-assist failure (keeps codes to logs). */
export function aiErrorText(err) {
  const s = String((err && err.message) || err || '');
  if (/ai_key_missing/.test(s)) return 'aucune clé d’assistance IA n’est configurée (réglages administrateur)';
  if (/ai_http_401|ai_http_403/.test(s)) return 'la clé d’assistance IA a été refusée';
  if (/ai_http_429/.test(s)) return 'le service d’IA est momentanément saturé — réessayez dans un instant';
  if (/ai_http_/.test(s)) return 'le service d’IA n’a pas pu répondre';
  if (/fetch_unavailable/.test(s)) return 'l’assistance IA n’est pas disponible dans cet environnement';
  return 'l’assistance IA n’a pas abouti';
}
