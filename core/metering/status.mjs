/**
 * Provider card status — one code per provider, derived from facts only (is it
 * wired, configured, opted in somewhere, gated, what did its last call return,
 * what did the last free balance read say). The renderer turns the code into
 * French wording; this module never invents a reset date.
 */

/** Ordered: the first matching state wins. */
export const STATUS_CODES = Object.freeze(['not_wired', 'not_configured', 'kill_switch', 'disabled', 'cap_reached', 'quota_exhausted', 'last_call_error', 'no_optin', 'ready']);

/**
 * @param {{ wired?:boolean, configured:boolean, optInCount?:number|null, gateReason?:string|null,
 *   lastEvent?:{outcome:string, ts:string, reason?:string}|null, balance?:{remaining:number|null}|null }} s
 * @returns {{code:string, since?:string|null, reason?:string|null}}
 */
export function providerStatus(s = {}) {
  if (s.wired === false) return { code: 'not_wired' };
  if (!s.configured) return { code: 'not_configured' };
  if (s.gateReason === 'kill_switch') return { code: 'kill_switch' };
  if (s.gateReason === 'disabled') return { code: 'disabled' };
  if (s.gateReason === 'cap_reached') return { code: 'cap_reached' };
  const last = s.lastEvent || null;
  if ((last && last.outcome === 'quota_exhausted') || (s.balance && s.balance.remaining === 0)) return { code: 'quota_exhausted', since: last && last.outcome === 'quota_exhausted' ? last.ts : null, reason: last ? last.reason || null : null };
  if (last && (last.outcome === 'failed' || last.outcome === 'timeout')) return { code: 'last_call_error', since: last.ts, reason: last.reason || null };
  if (s.optInCount === 0) return { code: 'no_optin' };
  return { code: 'ready' };
}
