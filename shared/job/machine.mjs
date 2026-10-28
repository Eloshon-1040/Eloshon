/**
 * Job state machine (Requirement D). Defines the legal lifecycle transitions for
 * a "your browser" job so the service worker, the app controller and the UI all
 * agree on what state a job can move to. Pure and data-only.
 *
 * PORTABLE: zero Node built-ins, zero dependencies.
 *
 * States (align with protocol JOB_STATUS):
 *   idle -> running -> {paused_challenge, blocked, done, stopped, error}
 *   paused_challenge -> {running, blocked, stopped}
 *   running <-> paused_challenge (resume)
 * Terminal: done, blocked, stopped, error.
 */
export const STATE = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED_CHALLENGE: 'paused_challenge',
  BLOCKED: 'blocked',
  DONE: 'done',
  STOPPED: 'stopped',
  ERROR: 'error',
});

export const TERMINAL = Object.freeze([STATE.DONE, STATE.BLOCKED, STATE.STOPPED, STATE.ERROR]);

const TRANSITIONS = Object.freeze({
  [STATE.IDLE]: [STATE.RUNNING, STATE.STOPPED],
  [STATE.RUNNING]: [STATE.PAUSED_CHALLENGE, STATE.BLOCKED, STATE.DONE, STATE.STOPPED, STATE.ERROR],
  [STATE.PAUSED_CHALLENGE]: [STATE.RUNNING, STATE.BLOCKED, STATE.STOPPED, STATE.ERROR],
  [STATE.BLOCKED]: [],
  [STATE.DONE]: [],
  [STATE.STOPPED]: [],
  [STATE.ERROR]: [],
});

export function isTerminal(state) { return TERMINAL.includes(state); }

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

/**
 * Apply a transition, throwing a clear French error on an illegal one.
 * @returns {string} the new state
 */
export function transition(from, to) {
  if (!canTransition(from, to)) {
    throw new Error(`Transition illégale « ${from} » → « ${to} ».`);
  }
  return to;
}
