/**
 * Retry policy (`LNK-004`): idempotency first, budget second, backoff third.
 *
 * The order matters, because the classic outage is not "the call failed" — it is
 * "the call succeeded but we replayed it". So `decideRetry` refuses to retry a
 * non-idempotent operation unless the caller supplied an idempotency key, no matter
 * how retryable the error looks. A `POST /invoices` that timed out may well have
 * created the invoice.
 *
 * The rest is standard and deliberately boring:
 *
 *   · exponential backoff with **full jitter** (random between 0 and the computed
 *     delay), because synchronised retries from a fleet turn one blip into a
 *     thundering herd;
 *   · a server's `Retry-After` is a **floor**, not a suggestion — retrying sooner is
 *     how a rate limit becomes a ban;
 *   · a total `budgetMs`, so a call with three retries cannot outlive its deadline
 *     by minutes;
 *   · cancellation wins over backoff: an abort during the sleep returns immediately.
 */

import { abortableSleep, preflight } from './deadline.ts';
import { callError, retryableKind } from './errors.ts';
import {
  fail,
  type CallContext,
  type CallError,
  type CallErrorKind,
  type CallResult,
} from './types.ts';

export interface RetryPolicy {
  /** Total attempts including the first. `1` means "do not retry". */
  readonly attempts: number;
  /** Base delay in ms; doubled per attempt. Default 100. */
  readonly backoffMs?: number | undefined;
  /** Cap for a single delay. Default 2_000. */
  readonly maxBackoffMs?: number | undefined;
  /** Full jitter. Default `true`; turning it off is for tests and single clients. */
  readonly jitter?: boolean | undefined;
  /** Kinds that may be retried. Default: every kind `retryableKind` says yes to. */
  readonly on?: readonly CallErrorKind[] | undefined;
  /** Upper bound for the whole call including sleeps. Exceeding it stops retrying. */
  readonly budgetMs?: number | undefined;
}

export const NO_RETRY: RetryPolicy = Object.freeze({ attempts: 1 });

export interface RetryDecisionContext {
  readonly policy: RetryPolicy;
  /** 1-based number of the attempt that just failed. */
  readonly attempt: number;
  readonly error: CallError;
  /** Whether replaying this operation is safe (idempotent method, or an idempotency key). */
  readonly idempotent: boolean;
  /** Time spent so far, including prior sleeps. */
  readonly elapsedMs: number;
  /** Injectable for deterministic tests; defaults to `Math.random`. */
  readonly random?: (() => number) | undefined;
}

export type RetryDecision =
  | { readonly retry: false; readonly reason: string }
  | { readonly retry: true; readonly delayMs: number; readonly reason: string };

/** Pure decision — every input explicit, so the matrix is testable without timers. */
export function decideRetry(input: RetryDecisionContext): RetryDecision {
  const { policy, attempt, error, idempotent, elapsedMs } = input;

  if (attempt >= policy.attempts) {
    return { retry: false, reason: `attempt ${String(attempt)} of ${String(policy.attempts)}` };
  }

  if (!error.retryable || !retryableKind(error.kind)) {
    return { retry: false, reason: `kind "${error.kind}" is not retryable` };
  }

  if (policy.on !== undefined && !policy.on.includes(error.kind)) {
    return { retry: false, reason: `kind "${error.kind}" is not in the policy's retry list` };
  }

  if (!idempotent) {
    return {
      retry: false,
      reason: 'the operation is not idempotent and carried no idempotency key',
    };
  }

  const delayMs = backoffMs(policy, attempt, input.random ?? Math.random);
  // `Retry-After` is a floor: waiting less than the server asked turns a 429 into a ban.
  const honoured = Math.max(delayMs, error.retryAfterMs ?? 0);

  if (policy.budgetMs !== undefined && elapsedMs + honoured > policy.budgetMs) {
    return {
      retry: false,
      reason: `the ${String(policy.budgetMs)} ms budget would be exceeded (${String(
        elapsedMs + honoured,
      )} ms)`,
    };
  }

  return {
    retry: true,
    delayMs: honoured,
    reason: error.retryAfterMs === undefined ? 'backoff' : 'server asked us to wait',
  };
}

/** Exponential delay with optional full jitter. Exported for the tests and the docs. */
export function backoffMs(
  policy: RetryPolicy,
  attempt: number,
  random: () => number = Math.random,
): number {
  const base = policy.backoffMs ?? 100;
  const cap = policy.maxBackoffMs ?? 2_000;
  const exponential = Math.min(cap, base * 2 ** (attempt - 1));
  if (policy.jitter === false) return exponential;
  // Full jitter: uniform in [0, exponential]. Predictable retries are synchronised retries.
  return Math.round(random() * exponential);
}

export interface RunWithRetryOptions<T> {
  readonly policy: RetryPolicy;
  readonly ctx: CallContext;
  /** True for safe methods (`GET`, `HEAD`, `PUT`, `DELETE`) or when a key is present. */
  readonly idempotent: boolean;
  /** One attempt. Returns a `CallResult`; must not throw for remote failures. */
  readonly attempt: (attempt: number) => Promise<CallResult<T>>;
  readonly onDecision?: ((decision: RetryDecision, attempt: number) => void) | undefined;
  /** Injectable sleep, for tests that must not actually wait. */
  readonly sleep?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
  readonly random?: (() => number) | undefined;
}

/**
 * Runs `attempt` until it succeeds, the policy says stop, or the caller aborts.
 *
 * Returns the last `CallResult` with `meta.attempts` filled in — including on success,
 * because "it worked on the third try" is a fact the caller wants in its logs.
 */
export async function runWithRetry<T>(options: RunWithRetryOptions<T>): Promise<CallResult<T>> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const startedAt = now();

  let last: CallResult<T> | undefined;

  for (let attempt = 1; attempt <= options.policy.attempts; attempt += 1) {
    // A deadline that passed while we were waiting is a timeout, not another attempt.
    const expired = preflight(options.ctx, now());
    if (expired !== undefined) {
      return withAttempts(
        last === undefined ? fail<T>(expired, emptyMeta()) : fail<T>(expired, last.meta),
        Math.max(1, attempt - 1),
      );
    }

    last = await options.attempt(attempt);

    if (last.ok || attempt === options.policy.attempts) {
      return withAttempts(last, attempt);
    }

    if (options.ctx.signal.aborted) {
      // The caller gave up: say so, rather than reporting the transport error that
      // happened to arrive first. `preflight` distinguishes timeout from cancellation.
      return withAttempts(
        fail<T>(
          preflight(options.ctx, now()) ?? callError('cancelled', 'LNK_CANCELLED'),
          last.meta,
        ),
        attempt,
      );
    }

    const decision = decideRetry({
      policy: options.policy,
      attempt,
      error: last.error,
      idempotent: options.idempotent,
      elapsedMs: now() - startedAt,
      ...(options.random === undefined ? {} : { random: options.random }),
    });
    options.onDecision?.(decision, attempt);

    if (!decision.retry) return withAttempts(last, attempt);

    await sleep(decision.delayMs, options.ctx.signal);
    if (options.ctx.signal.aborted) {
      return withAttempts(
        fail<T>(
          preflight(options.ctx, now()) ?? callError('cancelled', 'LNK_CANCELLED'),
          last.meta,
        ),
        attempt,
      );
    }
  }

  // Unreachable: the loop always returns. Kept so the function has a total type.
  return withAttempts(last ?? fail<T>(callError('unknown', 'LNK_UNKNOWN'), emptyMeta()), 1);
}

function withAttempts<T>(result: CallResult<T>, attempts: number): CallResult<T> {
  return { ...result, meta: { ...result.meta, attempts } };
}

function emptyMeta() {
  return { protocol: 'unknown', target: 'unknown', attempts: 1, elapsedMs: 0 };
}
