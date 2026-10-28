/**
 * Built-in strategy #2 — cooldown-and-retry with backoff. Waits (honouring a
 * Retry-After if present, else exponential backoff from a base cooldown), tells
 * the pacer to back off, and asks the caller to re-attempt. After maxRetries it
 * gives up so the app can move to the next tier. Never touches the challenge.
 *
 * PORTABLE: zero Node built-ins, zero dependencies.
 */
import { ChallengeStrategy, RESOLUTION } from '../strategy.mjs';

export class CooldownRetryStrategy extends ChallengeStrategy {
  get name() { return 'cooldown_retry'; }

  async handle({ category, context, env }) {
    this.attempts += 1;
    const { maxRetries, cooldownMs, backoffFactor } = this.config;
    if (this.attempts > maxRetries) {
      env.notify?.({ level: 'blocked', code: 'cooldown_exhausted', category, message: `Site toujours bloqué après ${maxRetries} tentatives. Passage au niveau suivant.` });
      env.log?.({ event: 'cooldown_exhausted', category, attempts: this.attempts });
      return { resolution: RESOLUTION.BLOCKED, category, attempts: this.attempts, waitedMs: 0, reason: 'retries_exhausted' };
    }
    const retryAfterMs = context?.retryAfterMs && context.retryAfterMs > 0 ? context.retryAfterMs : 0;
    const backoff = cooldownMs * Math.pow(backoffFactor, this.attempts - 1);
    const waitMs = Math.max(retryAfterMs, backoff);
    env.pacer?.onResponse({ status: context?.status, challenge: true, retryAfterMs, t: env.now() });
    env.notify?.({ level: 'info', code: 'cooldown_wait', category, message: `Pause de ${Math.round(waitMs / 1000)}s avant nouvelle tentative (${this.attempts}/${maxRetries}).` });
    env.log?.({ event: 'cooldown_wait', category, attempts: this.attempts, waitMs });
    if (env.signal?.aborted) return { resolution: RESOLUTION.STOPPED, category, attempts: this.attempts, waitedMs: 0 };
    await env.sleep(waitMs);
    if (env.signal?.aborted) return { resolution: RESOLUTION.STOPPED, category, attempts: this.attempts, waitedMs: waitMs };
    return { resolution: RESOLUTION.RETRY, category, attempts: this.attempts, waitedMs: waitMs };
  }
}

export const cooldownRetry = (config) => new CooldownRetryStrategy(config);
