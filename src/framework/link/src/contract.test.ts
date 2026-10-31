/**
 * The shared contract and the normalization table (`LNK-001`, `LNK-008`).
 *
 * The interesting assertions here are totality ones: every kind has a retryability
 * answer, every HTTP status class maps somewhere, every gRPC status name is known. A
 * table with a hole produces `undefined` at 3 a.m., which is exactly the failure this
 * file exists to prevent.
 */

import { describe, expect, test } from 'bun:test';

import {
  callError,
  codeForKind,
  kindForGrpcStatus,
  kindForHttpStatus,
  kindForSoapFault,
  kindForWsClose,
  parseRetryAfter,
  retryableKind,
} from './errors.ts';
import {
  assertNever,
  CALL_ERROR_KINDS,
  createCallContext,
  fail,
  ok,
  type CallErrorKind,
  type CallMeta,
} from './types.ts';

const META: CallMeta = {
  protocol: 'rest',
  target: 'https://example.test',
  attempts: 1,
  elapsedMs: 3,
};

describe('CallResult narrows without throwing (LNK-001)', () => {
  test('a success carries its value and metadata', () => {
    const result = ok({ id: 1 }, META);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.id).toBe(1);
    expect(result.meta.attempts).toBe(1);
  });

  test('a failure is a value, not an exception', () => {
    const result = fail(callError('unavailable', 'LNK_UNAVAILABLE'), META);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.kind).toBe('unavailable');
    expect(result.error.retryable).toBe(true);
  });

  test('every kind has a retryability answer, and the kind list has no duplicates', () => {
    expect(new Set(CALL_ERROR_KINDS).size).toBe(CALL_ERROR_KINDS.length);

    const expected: Record<CallErrorKind, boolean> = {
      unavailable: true,
      timeout: true,
      cancelled: false,
      unauthenticated: false,
      permission_denied: false,
      invalid_argument: false,
      not_found: false,
      conflict: false,
      rate_limited: true,
      protocol: false,
      server: false,
      unknown: false,
    };

    for (const kind of CALL_ERROR_KINDS) {
      expect(retryableKind(kind)).toBe(expected[kind]);
    }
    // The exhaustive switch means a new kind fails to compile rather than defaulting.
    expect(CALL_ERROR_KINDS.length).toBe(12);
  });

  test('assertNever names the value it was given', () => {
    expect(() => assertNever('surprise' as never, 'CallErrorKind')).toThrow(
      /CallErrorKind.*surprise/,
    );
  });

  test('a context without a signal still gets one that can never abort', () => {
    const ctx = createCallContext({ traceId: 'a'.repeat(32) });
    expect(ctx.signal.aborted).toBe(false);
    expect(ctx.correlationId).toBe('a'.repeat(32));
  });
});

describe('HTTP status → kind (LNK-008)', () => {
  test('each class maps to the kind an operator would expect', () => {
    const table: readonly [number, CallErrorKind][] = [
      [400, 'invalid_argument'],
      [401, 'unauthenticated'],
      [403, 'permission_denied'],
      [404, 'not_found'],
      [408, 'timeout'],
      [409, 'conflict'],
      [422, 'invalid_argument'],
      [425, 'conflict'],
      [429, 'rate_limited'],
      [500, 'unavailable'],
      [502, 'unavailable'],
      [503, 'unavailable'],
      [504, 'unavailable'],
      [507, 'server'],
      [301, 'unknown'],
      [0, 'unknown'],
    ];

    for (const [status, kind] of table) {
      expect(kindForHttpStatus(status)).toBe(kind);
    }
  });

  test('only the retryable statuses are marked retryable', () => {
    expect(retryableKind(kindForHttpStatus(503))).toBe(true);
    expect(retryableKind(kindForHttpStatus(429))).toBe(true);
    expect(retryableKind(kindForHttpStatus(400))).toBe(false);
    expect(retryableKind(kindForHttpStatus(401))).toBe(false);
  });
});

describe('gRPC status → kind (LNK-008)', () => {
  test('the full status set is covered, with no gaps', () => {
    const table: readonly [string, CallErrorKind][] = [
      ['OK', 'unknown'],
      ['CANCELLED', 'cancelled'],
      ['UNKNOWN', 'unknown'],
      ['INVALID_ARGUMENT', 'invalid_argument'],
      ['DEADLINE_EXCEEDED', 'timeout'],
      ['NOT_FOUND', 'not_found'],
      ['ALREADY_EXISTS', 'conflict'],
      ['PERMISSION_DENIED', 'permission_denied'],
      ['RESOURCE_EXHAUSTED', 'rate_limited'],
      ['FAILED_PRECONDITION', 'invalid_argument'],
      ['ABORTED', 'conflict'],
      ['OUT_OF_RANGE', 'invalid_argument'],
      ['UNIMPLEMENTED', 'server'],
      ['INTERNAL', 'server'],
      ['UNAVAILABLE', 'unavailable'],
      ['DATA_LOSS', 'server'],
      ['UNAUTHENTICATED', 'unauthenticated'],
      ['SOMETHING_NEW', 'unknown'],
    ];

    for (const [status, kind] of table) {
      expect(kindForGrpcStatus(status)).toBe(kind);
    }
  });
});

describe('kind → code (LNK-008)', () => {
  test('every kind has one LNK_ code, and no two share one', () => {
    const codes = CALL_ERROR_KINDS.map((kind) => codeForKind(kind));

    expect(codes.filter((code) => !code.startsWith('LNK_'))).toEqual([]);
    expect(new Set(codes).size).toBe(CALL_ERROR_KINDS.length);
    // Spelled out for the kinds a caller branches on: this is `§ 9`'s table, not a guess.
    expect(codeForKind('unavailable')).toBe('LNK_UNAVAILABLE');
    expect(codeForKind('permission_denied')).toBe('LNK_PERMISSION_DENIED');
    expect(codeForKind('server')).toBe('LNK_SERVER');
    expect(codeForKind('rate_limited')).toBe('LNK_RATE_LIMITED');
  });
});

describe('SOAP fault → kind (LNK-008)', () => {
  test('standard codes map by fault side, and a contract map overrides', () => {
    expect(kindForSoapFault('soap:Client')).toBe('invalid_argument');
    expect(kindForSoapFault('env:Sender')).toBe('invalid_argument');
    expect(kindForSoapFault('soap:Server', {})).toBe('server');
    expect(kindForSoapFault('env:Receiver')).toBe('server');
    expect(kindForSoapFault('soap:MustUnderstand')).toBe('protocol');
    expect(kindForSoapFault('soap:VersionMismatch')).toBe('protocol');
    expect(kindForSoapFault('app:QuotaExceeded')).toBe('unknown');
    expect(kindForSoapFault('app:QuotaExceeded', { 'app:QuotaExceeded': 'rate_limited' })).toBe(
      'rate_limited',
    );
  });
});

describe('WebSocket close → kind (LNK-008)', () => {
  test('normal closes are not failures; policy violations are', () => {
    expect(kindForWsClose(1000)).toBe('closed');
    expect(kindForWsClose(1001)).toBe('closed');
    expect(kindForWsClose(1008)).toBe('protocol');
    expect(kindForWsClose(1009)).toBe('protocol');
    expect(kindForWsClose(1013)).toBe('unavailable');
    expect(kindForWsClose(1011)).toBe('server');
    expect(kindForWsClose(4401)).toBe('unauthenticated');
    expect(kindForWsClose(4403)).toBe('permission_denied');
    expect(kindForWsClose(4321)).toBe('unknown');
  });
});

describe('Retry-After parsing (LNK-011 inputs)', () => {
  test('delta-seconds, HTTP dates and junk', () => {
    expect(parseRetryAfter('30')).toBe(30_000);
    expect(parseRetryAfter(' 0 ')).toBe(0);
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter('-5')).toBeUndefined();

    const now = Date.parse('2026-10-28T00:00:00Z');
    expect(parseRetryAfter('Wed, 28 Oct 2026 00:00:30 GMT', now)).toBe(30_000);
    // A date in the past means "now", never a negative wait.
    expect(parseRetryAfter('Wed, 28 Oct 2026 00:00:00 GMT', now + 5_000)).toBe(0);
  });
});
