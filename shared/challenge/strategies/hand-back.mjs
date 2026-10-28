/**
 * Built-in strategy #3 — hand back to the app. Do not wait, do not ask the
 * human; report the domain as "blocked" for this tier so the controller moves on
 * to the next tier (e.g. a paid provider). The cleanest seam for the tier chain.
 *
 * PORTABLE: zero Node built-ins, zero dependencies.
 */
import { ChallengeStrategy, RESOLUTION } from '../strategy.mjs';

export class HandBackStrategy extends ChallengeStrategy {
  get name() { return 'hand_back'; }

  async handle({ category, context, env }) {
    this.attempts += 1;
    env.notify?.({ level: 'blocked', code: 'hand_back', category, message: 'Ce niveau ne peut pas passer ce site — transfert au niveau suivant.' });
    env.log?.({ event: 'hand_back', category, status: context?.status });
    return { resolution: RESOLUTION.BLOCKED, category, attempts: this.attempts, waitedMs: 0, reason: 'hand_back', handBack: true };
  }
}

export const handBack = (config) => new HandBackStrategy(config);
