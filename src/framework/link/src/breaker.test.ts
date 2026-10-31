/**
 * The circuit breaker (`LNK-005`).
 *
 * The clock is injected, so "thirty seconds later" costs no wall time and the test
 * cannot flake on a slow machine. That is also the design claim: the breaker holds no
 * timer, so there is nothing to leak at shutdown.
 */

import { describe, expect, test } from 'bun:test';

import { createCircuitBreaker } from './breaker.ts';

function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

describe('circuit breaker (LNK-005)', () => {
  test('opens after the threshold, then fails fast', () => {
    const time = clock();
    const breaker = createCircuitBreaker({ threshold: 3, cooldownMs: 1_000, now: time.now });

    expect(breaker.allow()).toBe(true);
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.state()).toBe('closed');

    breaker.onFailure();
    expect(breaker.state()).toBe('open');
    expect(breaker.allow()).toBe(false);

    const error = breaker.openError('https://billing.test');
    expect(error.code).toBe('LNK_CIRCUIT_OPEN');
    expect(error.kind).toBe('unavailable');
    expect(error.retryAfterMs).toBe(1_000);

    time.advance(400);
    expect(breaker.openError('https://billing.test').retryAfterMs).toBe(600);
  });

  test('after the cooldown exactly one probe is allowed', () => {
    const time = clock();
    const breaker = createCircuitBreaker({ threshold: 1, cooldownMs: 1_000, now: time.now });

    breaker.onFailure();
    expect(breaker.state()).toBe('open');

    time.advance(1_000);
    expect(breaker.state()).toBe('half-open');
    expect(breaker.allow()).toBe(true); // the probe
    expect(breaker.allow()).toBe(false); // everybody else waits
  });

  test('a successful probe closes the circuit and resets the count', () => {
    const time = clock();
    const breaker = createCircuitBreaker({ threshold: 2, cooldownMs: 1_000, now: time.now });

    breaker.onFailure();
    breaker.onFailure();
    time.advance(1_000);

    expect(breaker.allow()).toBe(true);
    breaker.onSuccess();

    expect(breaker.state()).toBe('closed');
    expect(breaker.snapshot()).toMatchObject({ failures: 0, openedAt: undefined });
    expect(breaker.allow()).toBe(true);
  });

  test('a failed probe re-opens and restarts the cooldown', () => {
    const time = clock();
    const breaker = createCircuitBreaker({ threshold: 1, cooldownMs: 1_000, now: time.now });

    breaker.onFailure();
    time.advance(1_000);
    expect(breaker.allow()).toBe(true);
    breaker.onFailure();

    expect(breaker.state()).toBe('open');
    expect(breaker.allow()).toBe(false);

    // The cooldown restarted at the probe's failure, not at the original open.
    time.advance(999);
    expect(breaker.allow()).toBe(false);
    time.advance(1);
    expect(breaker.allow()).toBe(true);
  });

  test('successes in the closed state reset the failure streak', () => {
    const time = clock();
    const breaker = createCircuitBreaker({ threshold: 3, now: time.now });

    breaker.onFailure();
    breaker.onFailure();
    breaker.onSuccess();
    breaker.onFailure();
    breaker.onFailure();

    // Still closed (threshold 3) and the streak restarted: two failures since the success.
    expect(breaker.state()).toBe('closed');
    expect(breaker.snapshot().failures).toBe(2);
  });
});
