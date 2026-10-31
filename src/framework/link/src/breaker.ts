/**
 * Circuit breaker per target (`LNK-005`).
 *
 * A breaker exists to stop hammering something that is already down: after `threshold`
 * consecutive failures the circuit opens, calls fail fast with `LNK_CIRCUIT_OPEN`, and
 * after `cooldownMs` a **single** probe is allowed through. If the probe succeeds the
 * circuit closes; if it fails the circuit re-opens and the cooldown restarts.
 *
 * Two implementation decisions worth naming:
 *
 *   · **No timers.** State is computed from `now()` when it is read, so a breaker with
 *     a 30-second cooldown holds no `setTimeout` and leaks nothing on shutdown. A test
 *     can move a fake clock thirty seconds and watch the transition, with no waiting.
 *   · **Exactly one probe.** Two half-open probes at once is a thundering herd wearing
 *     a safety vest. `allow()` grants a single slot; anything else fails fast until the
 *     probe reports back.
 */

import { callError } from './errors.ts';
import type { CallError } from './types.ts';

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit. Default 5. */
  readonly threshold?: number | undefined;
  /** How long the circuit stays open before a probe is allowed. Default 30_000 ms. */
  readonly cooldownMs?: number | undefined;
  /** Injectable clock — the whole state machine is a pure function of time. */
  readonly now?: (() => number) | undefined;
}

export interface BreakerSnapshot {
  readonly state: BreakerState;
  readonly failures: number;
  /** Epoch ms the circuit opened, or `undefined` while closed. */
  readonly openedAt: number | undefined;
  /** Consecutive successes recorded in the current closed window. */
  readonly successes: number;
}

export interface CircuitBreaker {
  /** Current state, after applying any elapsed cooldown. */
  state(): BreakerState;
  /**
   * Whether a call may proceed. In `half-open` this reserves the single probe slot, so
   * a `true` must be followed by exactly one `onSuccess`/`onFailure`.
   */
  allow(): boolean;
  /** Records a successful call; closes the circuit if it was probing. */
  onSuccess(): void;
  /** Records a failed call; opens the circuit at the threshold, or re-opens on a failed probe. */
  onFailure(): void;
  /** `LNK_CIRCUIT_OPEN` as a `CallError`, for the caller to return as a value. */
  openError(target: string): CallError;
  snapshot(): BreakerSnapshot;
}

export function createCircuitBreaker(options: CircuitBreakerOptions = {}): CircuitBreaker {
  const threshold = options.threshold ?? 5;
  const cooldownMs = options.cooldownMs ?? 30_000;
  const now = options.now ?? Date.now;

  let failures = 0;
  let successes = 0;
  let openedAt: number | undefined;
  let probeInFlight = false;

  function settle(): BreakerState {
    if (openedAt === undefined) return 'closed';
    if (now() - openedAt < cooldownMs) return 'open';
    return 'half-open';
  }

  return {
    state: settle,

    allow() {
      const state = settle();
      if (state === 'closed') return true;
      if (state === 'open') return false;
      if (probeInFlight) return false;
      probeInFlight = true;
      return true;
    },

    onSuccess() {
      // A success in any state means the dependency is answering again.
      failures = 0;
      successes += 1;
      openedAt = undefined;
      probeInFlight = false;
    },

    onFailure() {
      probeInFlight = false;
      if (settle() === 'half-open') {
        // The probe failed: back to open, and the cooldown restarts from now.
        openedAt = now();
        failures = threshold;
        successes = 0;
        return;
      }
      failures += 1;
      successes = 0;
      if (failures >= threshold) openedAt = now();
    },

    openError(target: string) {
      const elapsed = openedAt === undefined ? 0 : now() - openedAt;
      return callError('unavailable', 'LNK_CIRCUIT_OPEN', {
        retryable: true,
        retryAfterMs: Math.max(0, cooldownMs - elapsed),
        cause: { target, openedAt },
      });
    },

    snapshot() {
      return { state: settle(), failures, openedAt, successes };
    },
  };
}
