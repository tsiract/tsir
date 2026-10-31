/**
 * Retry semantics (`LNK-004`).
 *
 * The first test in this file is the one that matters: a timed-out `POST` without an
 * idempotency key is **not** retried, because "the network failed" does not mean the
 * server did nothing. Everything else is backoff arithmetic.
 */

import { describe, expect, test } from 'bun:test';

import { backoffMs, decideRetry, NO_RETRY, runWithRetry, type RetryPolicy } from './retry.ts';
import { callError } from './errors.ts';
import { createCallContext, fail, ok, type CallResult } from './types.ts';

const POLICY: RetryPolicy = { attempts: 3, backoffMs: 100, maxBackoffMs: 400, jitter: false };
const META = { protocol: 'rest', target: 'https://billing.test', attempts: 1, elapsedMs: 1 };

function decide(overrides: Partial<Parameters<typeof decideRetry>[0]> = {}) {
  return decideRetry({
    policy: POLICY,
    attempt: 1,
    error: callError('unavailable', 'LNK_UNAVAILABLE'),
    idempotent: true,
    elapsedMs: 0,
    random: () => 0.5,
    ...overrides,
  });
}

describe('decideRetry (LNK-004)', () => {
  test('a non-idempotent call without an idempotency key is never retried', () => {
    const decision = decide({ idempotent: false, error: callError('timeout', 'LNK_TIMEOUT') });

    expect(decision.retry).toBe(false);
    expect(decision.reason).toContain('idempotency key');
  });

  test('the same call with a key is retried — the key is the whole difference', () => {
    const decision = decide({ idempotent: true, error: callError('timeout', 'LNK_TIMEOUT') });
    expect(decision.retry).toBe(true);
  });

  test('attempts are bounded, and the policy list filters kinds', () => {
    expect(decide({ attempt: 3 }).retry).toBe(false);
    expect(decide({ error: callError('invalid_argument', 'LNK_INVALID_ARGUMENT') }).retry).toBe(
      false,
    );
    expect(
      decide({
        policy: { ...POLICY, on: ['rate_limited'] },
        error: callError('unavailable', 'LNK_UNAVAILABLE'),
      }).retry,
    ).toBe(false);
  });

  test('Retry-After is a floor, and the budget is a hard stop', () => {
    const honoured = decide({
      error: callError('rate_limited', 'LNK_RATE_LIMITED', { retryAfterMs: 5_000 }),
    });
    expect(honoured).toMatchObject({ retry: true, delayMs: 5_000 });

    const tooLong = decide({
      policy: { ...POLICY, budgetMs: 1_000 },
      error: callError('rate_limited', 'LNK_RATE_LIMITED', { retryAfterMs: 5_000 }),
    });
    expect(tooLong.retry).toBe(false);
    expect(tooLong.reason).toContain('budget');
  });

  test('an error the transport marked non-retryable is respected even if its kind is', () => {
    const decision = decide({ error: callError('timeout', 'LNK_TIMEOUT', { retryable: false }) });
    expect(decision.retry).toBe(false);
  });

  test('NO_RETRY means exactly one attempt', () => {
    expect(NO_RETRY.attempts).toBe(1);
    expect(
      decideRetry({
        policy: NO_RETRY,
        attempt: 1,
        error: callError('timeout', 'LNK_TIMEOUT'),
        idempotent: true,
        elapsedMs: 0,
      }).retry,
    ).toBe(false);
  });
});

describe('backoff (LNK-004)', () => {
  test('exponential, capped, and jittered inside [0, delay]', () => {
    expect(backoffMs({ attempts: 3, backoffMs: 100, maxBackoffMs: 400, jitter: false }, 1)).toBe(
      100,
    );
    expect(backoffMs({ attempts: 3, backoffMs: 100, maxBackoffMs: 400, jitter: false }, 2)).toBe(
      200,
    );
    expect(backoffMs({ attempts: 4, backoffMs: 100, maxBackoffMs: 400, jitter: false }, 3)).toBe(
      400,
    );

    expect(backoffMs({ attempts: 3, backoffMs: 100, jitter: true }, 2, () => 0)).toBe(0);
    expect(backoffMs({ attempts: 3, backoffMs: 100, jitter: true }, 2, () => 0.999)).toBe(200);
  });
});

describe('runWithRetry (LNK-004)', () => {
  const ctx = createCallContext({});

  test('returns as soon as an attempt succeeds, and reports how many were needed', async () => {
    const slept: number[] = [];
    let calls = 0;

    const result = await runWithRetry({
      policy: POLICY,
      ctx,
      idempotent: true,
      attempt: async (): Promise<CallResult<string>> => {
        calls += 1;
        if (calls < 3) return fail(callError('unavailable', 'LNK_UNAVAILABLE'), META);
        return ok('done', META);
      },
      sleep: async (ms) => {
        slept.push(ms);
      },
      random: () => 0.5,
    });

    expect(result.ok).toBe(true);
    expect(result.meta.attempts).toBe(3);
    expect(slept).toEqual([100, 200]);
  });

  test('stops at the last failure and keeps the error', async () => {
    const result = await runWithRetry({
      policy: POLICY,
      ctx,
      idempotent: true,
      attempt: async () => fail<string>(callError('unavailable', 'LNK_UNAVAILABLE'), META),
      sleep: async () => undefined,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('LNK_UNAVAILABLE');
    expect(result.meta.attempts).toBe(3);
  });

  test('does not retry a non-idempotent failure, even when the kind is retryable', async () => {
    let calls = 0;
    const result = await runWithRetry({
      policy: POLICY,
      ctx,
      idempotent: false,
      attempt: async () => {
        calls += 1;
        return fail<string>(callError('timeout', 'LNK_TIMEOUT'), META);
      },
      sleep: async () => undefined,
    });

    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
  });

  test('an abort during the backoff ends the call instead of waiting it out', async () => {
    const controller = new AbortController();
    const aborting = createCallContext({ signal: controller.signal });

    const result = await runWithRetry({
      policy: { attempts: 5, backoffMs: 1_000, jitter: false },
      ctx: aborting,
      idempotent: true,
      attempt: async () => fail<string>(callError('unavailable', 'LNK_UNAVAILABLE'), META),
      sleep: async () => {
        controller.abort();
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('cancelled');
    expect(result.meta.attempts).toBe(1);
  });
});
