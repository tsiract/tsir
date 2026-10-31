/**
 * Deadlines and cancellation (`LNK-002`, `LNK-003`).
 *
 * A deadline is an **absolute** moment (`ctx.deadline`), and every protocol converts
 * it to its own unit: `fetch` gets an `AbortSignal`, gRPC gets milliseconds, WebSocket
 * gets a per-frame timer. Converting a *duration* at each hop is how a call chain ends
 * up with a 2-second budget that lives for 8 seconds across three services.
 *
 * Two properties are load-bearing:
 *
 *   1. **An expired context never performs I/O.** `preflight()` is the first line of
 *      every client: a deadline that passed while the caller was queuing must not open
 *      a socket just to close it.
 *   2. **Cancellation composes, it does not replace.** The caller's signal and the
 *      deadline both abort the same composed signal, so a `ctx.signal.abort()` during a
 *      retry sleep end the call immediately rather than after the backoff.
 */

import { callError } from './errors.ts';
import type { CallContext, CallError } from './types.ts';

/** Milliseconds left, or `undefined` when there is no deadline. Never negative. */
export function remainingMs(ctx: CallContext, now: number = Date.now()): number | undefined {
  if (ctx.deadline === undefined) return undefined;
  return Math.max(0, ctx.deadline.getTime() - now);
}

/**
 * Why the context is already finished, if it is.
 *
 * Cancelled and timed out are different answers on purpose: one means the caller
 * changed its mind, the other means the budget ran out, and an operator reading
 * dashboards needs to tell those apart.
 */
export function preflight(ctx: CallContext, now: number = Date.now()): CallError | undefined {
  if (ctx.signal.aborted) {
    const reason: unknown = ctx.signal.reason;
    // `AbortSignal.timeout` sets a `TimeoutError` DOMException as the reason; a manual
    // abort carries whatever the caller passed. The deadline is checked too, because a
    // caller may abort with no reason at all.
    const timedOut = isTimeoutReason(reason) || (remainingMs(ctx, now) ?? 1) === 0;
    return timedOut
      ? callError('timeout', 'LNK_TIMEOUT', {
          cause: reason,
        })
      : callError('cancelled', 'LNK_CANCELLED', { cause: reason });
  }

  if ((remainingMs(ctx, now) ?? 1) === 0) {
    return callError('timeout', 'LNK_TIMEOUT');
  }
  return undefined;
}

function isTimeoutReason(reason: unknown): boolean {
  return (
    typeof reason === 'object' &&
    reason !== null &&
    'name' in reason &&
    (reason as { name?: unknown }).name === 'TimeoutError'
  );
}

export interface ComposedSignal {
  readonly signal: AbortSignal;
  /** Removes listeners and clears the timer. Call it when the call finishes, always. */
  dispose(): void;
}

/**
 * One signal that follows several sources.
 *
 * Uses the platform's `AbortSignal.any` when it exists (Bun, Node ≥ 20, Workers); the
 * fallback keeps a listener per source and removes them in `dispose()`. Without that
 * cleanup, a long-lived caller signal accumulates one listener per call — a leak that
 * only shows up under load, which is the worst time to find it.
 */
export function composeSignals(input: {
  readonly signals: readonly (AbortSignal | undefined)[];
  readonly timeoutMs?: number | undefined;
}): ComposedSignal {
  const sources = input.signals.filter((signal): signal is AbortSignal => signal !== undefined);
  const timeoutMs = input.timeoutMs;

  if (timeoutMs !== undefined && sources.length === 0) {
    // No timer to clean up: the platform owns it.
    return { signal: AbortSignal.timeout(Math.max(0, timeoutMs)), dispose: () => undefined };
  }

  if (timeoutMs === undefined) {
    const anyOf = anySignal(sources);
    return anyOf;
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => {
      controller.abort(new DOMException('deadline exceeded', 'TimeoutError'));
    },
    Math.max(0, timeoutMs),
  );
  // A pending timer must not keep the process alive.
  (timer as { unref?: () => void }).unref?.();

  const anyOf = anySignal([...sources, controller.signal]);
  return {
    signal: anyOf.signal,
    dispose: () => {
      clearTimeout(timer);
      anyOf.dispose();
    },
  };
}

function anySignal(signals: readonly AbortSignal[]): ComposedSignal {
  if (signals.length === 0) {
    return { signal: new AbortController().signal, dispose: () => undefined };
  }
  if (signals.length === 1) {
    return { signal: signals[0] as AbortSignal, dispose: () => undefined };
  }

  const platform = AbortSignal as unknown as {
    any?: (signals: readonly AbortSignal[]) => AbortSignal;
  };
  if (typeof platform.any === 'function') {
    return { signal: platform.any(signals), dispose: () => undefined };
  }

  const controller = new AbortController();
  const listeners = signals.map((signal) => {
    const onAbort = (): void => {
      controller.abort(signal.reason);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    return { signal, onAbort };
  });

  return {
    signal: controller.signal,
    dispose: () => {
      for (const { signal, onAbort } of listeners) signal.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * A child context with a tighter deadline.
 *
 * The child's signal aborts when *either* the parent's does or the child deadline
 * passes. Callers must `dispose()` the handle when the call finishes — that is what
 * removes the listener from the parent signal.
 */
export function withTimeout(
  ctx: CallContext,
  timeoutMs: number,
  now: number = Date.now(),
): { readonly ctx: CallContext; dispose(): void } {
  const parentDeadline = remainingMs(ctx, now);
  const effective = parentDeadline === undefined ? timeoutMs : Math.min(parentDeadline, timeoutMs);
  const composed = composeSignals({ signals: [ctx.signal], timeoutMs: effective });

  const deadline = new Date(now + effective);
  return {
    ctx: {
      ...ctx,
      signal: composed.signal,
      // The tighter of the two: a parent deadline earlier than this timeout wins.
      deadline:
        ctx.deadline === undefined || deadline.getTime() < ctx.deadline.getTime()
          ? deadline
          : ctx.deadline,
    },
    // Wrapped so the method keeps its receiver (`unbound-method`).
    dispose: () => {
      composed.dispose();
    },
  };
}

/** Sleeps, but wakes immediately if the signal aborts. Used by the retry backoff. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal.aborted) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    (timer as { unref?: () => void }).unref?.();

    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}
