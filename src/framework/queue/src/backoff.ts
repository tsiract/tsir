/**
 * Backoff (`§ 4.2`): exponential, capped, jittered, and deterministic when told to be.
 *
 * The formula is `min(maxMs, baseMs × factor^(attempt-1))`, then jittered by ±`jitter`. Two
 * properties matter more than the curve:
 *
 *   · **capped** — an uncapped exponential reaches "retry in three weeks", which is a
 *     dead-letter table with extra steps;
 *   · **jittered** — a hundred workers that failed at the same moment must not retry at the
 *     same moment, which is exactly what an unjittered backoff produces.
 *
 * `jitter: 0` exists so tests can assert exact delays; production never sets it.
 */

import { JOB_DEFAULTS, type BackoffOptions } from './job.ts';

export interface RetryDelayOptions extends BackoffOptions {
  /** Injected so a test can pin the jitter without pinning `Math.random`. */
  readonly random?: (() => number) | undefined;
}

/**
 * The delay before attempt `attempt + 1`, in ms. `attempt` is the attempt that just failed.
 *
 * `attempt = 1` → `baseMs` (± jitter): the first retry is the base delay, not `factor × base`.
 */
export function retryDelayMs(attempt: number, options: RetryDelayOptions = {}): number {
  const base = options.baseMs ?? JOB_DEFAULTS.backoff.baseMs;
  const factor = options.factor ?? JOB_DEFAULTS.backoff.factor;
  const max = options.maxMs ?? JOB_DEFAULTS.backoff.maxMs;
  const jitter = options.jitter ?? JOB_DEFAULTS.backoff.jitter;

  const exponent = Math.max(0, attempt - 1);
  const raw = Math.min(max, base * Math.pow(factor, exponent));
  if (jitter === 0) return Math.round(raw);

  // A retry delay is not a secret: spreading retries across a window needs a cheap,
  // unpredictable-enough number, and a CSPRNG here would be noise with no threat model.
  const random = options.random?.() ?? Math.random(); // crypto-ok: jitter, not a secret
  // `random()` is in [0, 1): map it to [-jitter, +jitter] around the raw delay.
  const offset = (random * 2 - 1) * jitter;
  return Math.max(0, Math.round(raw * (1 + offset)));
}

/** The whole schedule up to `maxAttempts - 1` retries — what `queue:failed` prints. */
export function retrySchedule(
  maxAttempts: number,
  options: RetryDelayOptions = {},
): readonly number[] {
  const delays: number[] = [];
  for (let attempt = 1; attempt < maxAttempts; attempt += 1)
    delays.push(retryDelayMs(attempt, options));
  return delays;
}

/** `1 s · 2 s · 4 s · 8 s`, for a log line a person can read. */
export function describeSchedule(maxAttempts: number, options: RetryDelayOptions = {}): string {
  const delays = retrySchedule(maxAttempts, { jitter: 0, ...options });
  return delays
    .map((ms) => (ms >= 1_000 ? `${String(ms / 1_000)} s` : `${String(ms)} ms`))
    .join(' · ');
}
