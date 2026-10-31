import { describe, expect, test } from 'bun:test';

import { abortableSleep, composeSignals, preflight, remainingMs, withTimeout } from './deadline.ts';
import { createCallContext } from './types.ts';

const NOW = 1_800_000_000_000; // a fixed instant, so the tests never depend on wall time

describe('deadlines are absolute, and expire before any I/O (LNK-002)', () => {
  test('remainingMs never goes negative', () => {
    const ctx = createCallContext({ deadline: new Date(NOW + 250) });

    expect(remainingMs(ctx, NOW)).toBe(250);
    expect(remainingMs(ctx, NOW + 250)).toBe(0);
    expect(remainingMs(ctx, NOW + 9_000)).toBe(0);
    expect(remainingMs(createCallContext({}), NOW)).toBeUndefined();
  });

  test('a context that is not finished has no preflight error', () => {
    expect(preflight(createCallContext({ deadline: new Date(NOW + 1_000) }), NOW)).toBeUndefined();
    expect(preflight(createCallContext({}), NOW)).toBeUndefined();
  });

  test('an expired deadline is a timeout even when nobody aborted the signal', () => {
    const error = preflight(createCallContext({ deadline: new Date(NOW - 1) }), NOW);

    expect(error?.kind).toBe('timeout');
    expect(error?.code).toBe('LNK_TIMEOUT');
    expect(error?.retryable).toBe(true);
  });

  test('a caller abort is a cancellation, and a platform timeout is a timeout', () => {
    const cancelled = new AbortController();
    cancelled.abort();
    expect(preflight(createCallContext({ signal: cancelled.signal }), NOW)?.kind).toBe('cancelled');

    const timedOut = new AbortController();
    timedOut.abort(new DOMException('slow', 'TimeoutError'));
    const error = preflight(createCallContext({ signal: timedOut.signal }), NOW);
    expect(error?.kind).toBe('timeout');
    expect(error?.code).toBe('LNK_TIMEOUT');
  });
});

describe('cancellation composes caller and deadline (LNK-003)', () => {
  test('withTimeout aborts the child when the parent aborts', () => {
    const parent = new AbortController();
    const scoped = withTimeout(createCallContext({ signal: parent.signal }), 60_000);

    expect(scoped.ctx.signal.aborted).toBe(false);
    parent.abort(new Error('caller changed its mind'));
    expect(scoped.ctx.signal.aborted).toBe(true);
    scoped.dispose();
  });

  test('withTimeout aborts on its own timeout', async () => {
    const scoped = withTimeout(createCallContext({}), 15);

    expect(scoped.ctx.signal.aborted).toBe(false);
    await abortableSleep(60, new AbortController().signal);
    expect(scoped.ctx.signal.aborted).toBe(true);
    scoped.dispose();
  });

  test('the tighter of the two deadlines wins, and the deadline is absolute', () => {
    // A parent with 10 ms left must not be widened by a 60 s timeout.
    const parent = createCallContext({ deadline: new Date(Date.now() + 10) });
    const scoped = withTimeout(parent, 60_000);

    expect(scoped.ctx.deadline?.getTime()).toBeLessThanOrEqual(parent.deadline?.getTime() ?? 0);
    scoped.dispose();

    // And a child timeout shorter than the parent deadline becomes the child's deadline.
    const wide = createCallContext({ deadline: new Date(Date.now() + 60_000) });
    const tight = withTimeout(wide, 5);
    expect(tight.ctx.deadline?.getTime()).toBeLessThan(wide.deadline?.getTime() ?? 0);
    tight.dispose();
  });

  test('dispose is safe to call twice and leaves nothing running', () => {
    const composed = composeSignals({ signals: [], timeoutMs: 10_000 });
    expect(() => {
      composed.dispose();
      composed.dispose();
    }).not.toThrow();
  });
});

describe('abortable sleep', () => {
  test('wakes early when the signal aborts, and never rejects', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const sleeping = abortableSleep(5_000, controller.signal);

    setTimeout(() => {
      controller.abort();
    }, 5);
    await sleeping;

    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('a zero or negative delay is a no-op, and an aborted signal returns immediately', async () => {
    const controller = new AbortController();
    await abortableSleep(0, controller.signal);
    controller.abort();
    const started = Date.now();
    await abortableSleep(10_000, controller.signal);
    expect(Date.now() - started).toBeLessThan(100);
  });
});
