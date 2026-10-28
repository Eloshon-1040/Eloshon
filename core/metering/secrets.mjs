/**
 * Every secret VALUE the app currently knows (provider keys, AI key, licence),
 * gathered from the same resolution order as the lanes (secure store → config →
 * env NAME). Used ONLY to scrub those exact values out of anything written to
 * the usage ledger — never logged, never returned to the renderer.
 */
import { PROVIDERS, resolveField } from '../providers/registry.mjs';
import { AI_PROVIDER } from '../providers/ai.mjs';

export function collectSecrets({ secure = {}, config = {}, env = {} } = {}) {
  const out = new Set();
  const io = { secure: secure || {}, config: config || {}, env: env || {} };
  for (const p of [...PROVIDERS, AI_PROVIDER]) {
    for (const f of p.fields) {
      if (!f.secret) continue;
      try { const { value } = resolveField(p, f, io); if (value) out.add(String(value)); } catch { /* ignore */ }
    }
  }
  const bd = (config && config.brightData) || {};
  for (const k of ['browserAuth', 'browserPassword', 'apiKey']) if (bd[k]) out.add(String(bd[k]));
  for (const k of ['BRD_BROWSER_PASSWORD', 'BRIGHT-DATA-AGENT-KEY']) if (env && env[k]) out.add(String(env[k]));
  if (config && config.edgeLicense) out.add(String(config.edgeLicense));
  return [...out].filter((v) => v.length >= 6);
}
