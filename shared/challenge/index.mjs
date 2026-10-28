/**
 * Challenge subsystem barrel + a default registry pre-loaded with the three
 * built-in strategies. Callers can use `defaultChallengeRegistry()` or build
 * their own and register additional legitimate strategies later.
 *
 * PORTABLE: zero Node built-ins, zero dependencies.
 */
import { ChallengeRegistry, ChallengeStrategy, RESOLUTION, CHALLENGE_TIMEOUTS } from './strategy.mjs';
import { detectChallenge, isBackToNormal, DEFAULT_DETECT } from './detect.mjs';
import { humanInTheLoop } from './strategies/human-in-the-loop.mjs';
import { cooldownRetry } from './strategies/cooldown-retry.mjs';
import { handBack } from './strategies/hand-back.mjs';

export { ChallengeRegistry, ChallengeStrategy, RESOLUTION, CHALLENGE_TIMEOUTS };
export { detectChallenge, isBackToNormal, DEFAULT_DETECT };
export { humanInTheLoop, cooldownRetry, handBack };

/** A fresh registry with the built-in strategies registered under stable names. */
export function defaultChallengeRegistry() {
  return new ChallengeRegistry()
    .register('human_in_the_loop', humanInTheLoop)
    .register('cooldown_retry', cooldownRetry)
    .register('hand_back', handBack);
}
