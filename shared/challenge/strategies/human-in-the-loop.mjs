/**
 * Built-in strategy #1 — human-in-the-loop. PAUSE the job, keep state, notify
 * (badge + browser notification + app status "action requise : résous le défi
 * dans l'onglet"), poll until the page is back to normal, then resume gently
 * from the exact cursor. Never touches the challenge itself.
 *
 * PORTABLE: zero Node built-ins, zero dependencies.
 */
import { ChallengeStrategy, RESOLUTION } from '../strategy.mjs';

export class HumanInTheLoopStrategy extends ChallengeStrategy {
  get name() { return 'human_in_the_loop'; }

  async handle({ category, context, env }) {
    const start = env.now();
    this.attempts += 1;
    env.notify?.({
      level: 'action_required',
      code: 'challenge_paused',
      category,
      message: 'Action requise : résous le défi dans l\'onglet du navigateur. Le travail reprend automatiquement.',
    });
    env.log?.({ event: 'challenge_paused', category, at: start });

    const { solveMs, pollMs } = this.config;
    while (true) {
      if (env.signal?.aborted) {
        env.log?.({ event: 'challenge_stopped', category, at: env.now() });
        return { resolution: RESOLUTION.STOPPED, category, attempts: this.attempts, waitedMs: env.now() - start };
      }
      const elapsed = env.now() - start;
      if (elapsed >= solveMs) {
        const secs = Math.round(solveMs / 1000);
        env.notify?.({ level: 'blocked', code: 'challenge_timeout', category, message: `Aucune action détectée après ${secs} s : arrêt automatique, le site est marqué « bloqué ».` });
        env.log?.({ event: 'challenge_timeout', category, at: env.now(), waitedMs: elapsed });
        return { resolution: RESOLUTION.BLOCKED, category, attempts: this.attempts, waitedMs: elapsed, reason: 'timeout' };
      }
      const normal = await env.recheck();
      if (normal) {
        env.pacer?.resumeGently(env.now());
        env.notify?.({ level: 'info', code: 'challenge_resolved', category, message: 'Défi résolu — reprise du travail.' });
        env.log?.({ event: 'challenge_resolved', category, at: env.now(), waitedMs: env.now() - start });
        return { resolution: RESOLUTION.RESUMED, category, attempts: this.attempts, waitedMs: env.now() - start };
      }
      await env.sleep(pollMs);
    }
  }
}

export const humanInTheLoop = (config) => new HumanInTheLoopStrategy(config);
