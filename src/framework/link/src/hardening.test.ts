/**
 * The edges of the shared core: fallbacks, defensive branches, and the errors that are
 * programming mistakes rather than wire events.
 *
 * The `AbortSignal.any` case is the interesting one. Workers and older Bun builds do not
 * all have it, so `composeSignals` has a listener fallback; the test stubs it out and
 * asserts the fallback still aborts, still disposes, and still keeps the parent's reason.
 */

import { afterEach, describe, expect, test } from 'bun:test';

import { composeSignals } from './deadline.ts';
import {
  callError,
  invalidLinkConfig,
  kindForSoapFault,
  parseRetryAfter,
  retryableKind,
  schemaViolation,
  urlNotAllowed,
} from './errors.ts';
import { NO_RETRY, runWithRetry } from './retry.ts';
import { inboundContext, outboundHeaders } from './trace.ts';
import {
  CALL_ERROR_KINDS,
  createCallContext,
  fail,
  ok,
  randomSpanId,
  randomTraceId,
  type CallErrorKind,
} from './types.ts';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN = '00f067aa0ba902b7';
const META = { protocol: 'rest', target: 'https://billing.test', attempts: 1, elapsedMs: 0 };

afterEach(() => {
  // The stub below deletes this when the platform has no `any` at all.
  if (ORIGINAL_ANY !== undefined) {
    (AbortSignal as unknown as { any: unknown }).any = ORIGINAL_ANY;
  }
});

const ORIGINAL_ANY = (AbortSignal as unknown as { any?: unknown }).any;

describe('composeSignals fallbacks (LNK-003)', () => {
  test('a lone timeout needs no listener bookkeeping', () => {
    const composed = composeSignals({ signals: [], timeoutMs: 5_000 });
    expect(composed.signal.aborted).toBe(false);
    composed.dispose();
    composed.dispose();
  });

  test('a lone signal is passed through untouched, and no signal means never aborts', () => {
    const controller = new AbortController();
    const composed = composeSignals({ signals: [controller.signal] });
    expect(composed.signal).toBe(controller.signal);

    const none = composeSignals({ signals: [] });
    expect(none.signal.aborted).toBe(false);
    none.dispose();
  });

  test('without AbortSignal.any the listener fallback still aborts, and dispose unhooks it', () => {
    (AbortSignal as unknown as { any: unknown }).any = undefined;

    const parent = new AbortController();
    const composed = composeSignals({ signals: [parent.signal], timeoutMs: 60_000 });

    expect(composed.signal.aborted).toBe(false);
    parent.abort(new Error('parent gave up'));
    expect(composed.signal.aborted).toBe(true);
    expect((composed.signal.reason as Error).message).toBe('parent gave up');

    // Dispose unhooks the listeners rather than leaving them on the parents: two
    // sources, then dispose, then abort — the child must stay untouched.
    const first = new AbortController();
    const second = new AbortController();
    const unhooked = composeSignals({ signals: [first.signal, second.signal] });
    unhooked.dispose();
    first.abort();
    second.abort();
    expect(unhooked.signal.aborted).toBe(false);
    composed.dispose();
  });

  test('a source that is already aborted aborts the child immediately', () => {
    const already = new AbortController();
    already.abort(new Error('too late'));
    const composed = composeSignals({ signals: [already.signal], timeoutMs: 60_000 });

    expect(composed.signal.aborted).toBe(true);
    composed.dispose();
  });
});

describe('programming errors are TsirErrors (LNK-008)', () => {
  test('each one names the fix and carries a stable code', () => {
    // These builders *return* the error so a call site can decide to throw; asserting on
    // the return value is the only assertion Bun's `toThrow` cannot fake (it also passes
    // when a function simply returns an `Error`).
    const schema = schemaViolation('CreateInvoice', 'amount must be positive');
    expect(schema.message).toBe('CreateInvoice failed local validation: amount must be positive');
    expect(schema.code).toBe('LNK_SCHEMA');

    const url = urlNotAllowed('http://169.254.169.254', ['https://api.billing.test']);
    expect(url.message).toContain('not in the configured allowlist');
    expect(url.code).toBe('LNK_URL_NOT_ALLOWED');
    expect(url.context).toMatchObject({ url: 'http://169.254.169.254' });

    const config = invalidLinkConfig('baseUrl must be absolute');
    expect(config.code).toBe('LNK_INVALID_CONFIG');
    expect(config.kind).toBe('link');
  });

  test('retryability has no silent default: an unknown kind is a programming error', () => {
    expect(() => retryableKind('invented' as CallErrorKind)).toThrow(/CallErrorKind/);
    expect(CALL_ERROR_KINDS).toContain('unknown');
  });

  test('a SOAP fault with no code is unknown, and an uppercase code still matches', () => {
    expect(kindForSoapFault('')).toBe('unknown');
    expect(kindForSoapFault('SOAP:CLIENT')).toBe('invalid_argument');
  });

  test('a numeric Retry-After larger than any sensible wait is still returned', () => {
    expect(parseRetryAfter('86400')).toBe(86_400_000);
  });
});

describe('retry hard stops (LNK-004)', () => {
  const ctx = createCallContext({});

  test('a deadline that expires during the attempt turns the failure into a timeout', async () => {
    const expired = createCallContext({ deadline: new Date(Date.now() - 1) });
    const result = await runWithRetry({
      policy: { attempts: 3, backoffMs: 1, jitter: false },
      ctx: expired,
      idempotent: true,
      attempt: async () => fail<string>(callError('unavailable', 'LNK_UNAVAILABLE'), META),
      sleep: async () => undefined,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('timeout');
    expect(result.meta.attempts).toBe(1);
  });

  test('a policy of one attempt never calls the decision logic', async () => {
    const decisions: string[] = [];
    const result = await runWithRetry({
      policy: NO_RETRY,
      ctx,
      idempotent: false,
      attempt: async () => fail<string>(callError('unavailable', 'LNK_UNAVAILABLE'), META),
      onDecision: (decision) => decisions.push(String(decision.retry)),
    });

    expect(decisions).toEqual([]);
    expect(result.ok).toBe(false);
  });

  test('a zero-attempt policy terminates instead of falling through the loop', async () => {
    let calls = 0;
    const result = await runWithRetry({
      policy: { attempts: 0 },
      ctx,
      idempotent: true,
      attempt: async () => {
        calls += 1;
        return ok('never', META);
      },
    });

    expect(calls).toBe(0);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('LNK_UNKNOWN');
  });
});

describe('helpers the adapters rely on (LNK-001, LNK-006)', () => {
  test('ids are hex, the right length, and not repeats', () => {
    const trace = randomTraceId();
    const span = randomSpanId();

    expect(trace).toMatch(/^[0-9a-f]{32}$/);
    expect(span).toMatch(/^[0-9a-f]{16}$/);
    expect(randomTraceId()).not.toBe(trace);
    expect(randomSpanId()).not.toBe(span);
  });

  test('outbound headers produce a fresh span id when the caller has none', () => {
    const { headers, spanId } = outboundHeaders(createCallContext({ traceId: TRACE }));
    expect(spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(headers['traceparent']).toBe(`00-${TRACE}-${spanId}-01`);
  });

  test('inbound headers are lowercased before lookup, so casing cannot lose the trace', () => {
    const ctx = inboundContext({
      headers: { TraceParent: `00-${TRACE}-${SPAN}-00` },
      signal: new AbortController().signal,
    });

    expect(ctx.traceId).toBe(TRACE);
    // The trace id survives the round trip; sampling is re-decided locally because
    // `CallContext` carries no sampling flag (the transport contract).
    expect(outboundHeaders(ctx, { spanId: SPAN }).headers['traceparent']).toBe(
      `00-${TRACE}-${SPAN}-01`,
    );
  });
});
