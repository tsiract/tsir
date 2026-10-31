/**
 * Trace and correlation propagation (`LNK-006`).
 *
 * W3C `traceparent` is the one header every observability stack understands, so it is
 * the only trace format this package invents anything for — and it invents nothing:
 * `00-<32 hex>-<16 hex>-<2 hex flags>`, validated strictly.
 *
 * `x-correlation-id` travels beside it. They are not the same thing and keeping both
 * is deliberate:
 *
 *   · a **trace id** follows one request across services and is sampled;
 *   · a **correlation id** groups one *unit of work* the caller chose — one job, one
 *     invoice import, one retry chain — and is never sampled away.
 *
 * Collapsing them means either losing the business grouping or sampling away the thing
 * an operator asked for by name.
 */

import { TsirError } from '@tsir/core';
import { CALL_ERROR_KINDS, randomSpanId, randomTraceId, type CallContext } from './types.ts';

export const TRACEPARENT_HEADER = 'traceparent';
export const CORRELATION_HEADER = 'x-correlation-id';

export interface Traceparent {
  readonly version: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly sampled: boolean;
}

const TRACEPARENT_PATTERN = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);

/**
 * Parses `traceparent`, returning `undefined` for anything invalid.
 *
 * Invalid is a real category: a missing header, another vendor's format, draft
 * versions, all-zero ids. None of those are errors — a call must still be made — but a
 * malformed id must never be echoed back as if it were valid, so the caller starts a
 * new trace instead.
 */
export function parseTraceparent(value: string | null | undefined): Traceparent | undefined {
  if (value === null || value === undefined) return undefined;
  const match = TRACEPARENT_PATTERN.exec(value.trim().toLowerCase());
  if (match === null) return undefined;

  const [, version, traceId, spanId, flags] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  // Version `ff` is forbidden by the spec; all-zero ids are invalid.
  if (version === 'ff' || traceId === ZERO_TRACE || spanId === ZERO_SPAN) return undefined;

  // coercion-ok: `flags` is two hex digits, already proven by the pattern above; this is
  // the explicit hex→number transform, not an implicit cast of untrusted input.
  const flagsValue = parseInt(flags, 16);

  return { version, traceId, spanId, sampled: (flagsValue & 0x01) === 1 };
}

/** Formats a `traceparent` for an outbound call. The span is the client span. */
export function formatTraceparent(input: {
  readonly traceId: string;
  readonly spanId: string;
  readonly sampled?: boolean | undefined;
}): string {
  if (!/^[0-9a-f]{32}$/.test(input.traceId)) {
    throw invalidArgument(`traceId must be 32 lowercase hex characters, got "${input.traceId}"`);
  }
  if (!/^[0-9a-f]{16}$/.test(input.spanId)) {
    throw invalidArgument(`spanId must be 16 lowercase hex characters, got "${input.spanId}"`);
  }
  return `00-${input.traceId}-${input.spanId}-${input.sampled === false ? '00' : '01'}`;
}

export interface OutboundHeaders {
  readonly headers: Readonly<Record<string, string>>;
  /** The span this call opened; useful when the protocol wants its own metadata too. */
  readonly spanId: string;
}

/**
 * The headers an outbound call carries: caller headers first, then trace headers.
 *
 * Trace headers win over caller-supplied ones of the same name — a caller that sets
 * `traceparent` by hand is either re-propagating (fine, same value) or confused, and
 * silently sending a stale trace id is worse than overriding it.
 */
export function outboundHeaders(
  ctx: CallContext,
  options: {
    readonly spanId?: string | undefined;
    readonly extra?: Readonly<Record<string, string>> | undefined;
    readonly spanIdFactory?: (() => string) | undefined;
  } = {},
): OutboundHeaders {
  const spanId = options.spanId ?? (options.spanIdFactory ?? randomSpanId)();
  const headers: Record<string, string> = { ...(ctx.headers ?? {}), ...(options.extra ?? {}) };

  headers[TRACEPARENT_HEADER] = formatTraceparent({ traceId: ctx.traceId, spanId });
  headers[CORRELATION_HEADER] = ctx.correlationId;

  return { headers, spanId };
}

/**
 * A context derived from inbound headers — the server side of propagation.
 *
 * A server that receives no `traceparent` starts one; that is the correct behaviour and
 * not a fallback: drops in tracing must never drop the request.
 */
export function inboundContext(input: {
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  readonly deadline?: Date | undefined;
  readonly traceIdFactory?: (() => string) | undefined;
}): CallContext {
  // Header maps from Bun, Node and Workers are case-insensitive in HTTP but not as
  // JavaScript objects: `TraceParent` must not silently start a new trace.
  const read = (name: string): string | undefined => {
    const direct = input.headers[name];
    if (direct !== undefined) return direct;
    for (const [key, value] of Object.entries(input.headers)) {
      if (key.toLowerCase() === name) return value;
    }
    return undefined;
  };

  const traceparent = parseTraceparent(read(TRACEPARENT_HEADER));
  const traceId = traceparent?.traceId ?? (input.traceIdFactory ?? randomTraceId)();
  const correlationId = read(CORRELATION_HEADER) ?? traceId;

  return {
    traceId,
    correlationId,
    signal: input.signal,
    ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
  };
}

/** Every kind, re-exported for the normalization table's tests (§ 9). */
export { CALL_ERROR_KINDS };

function invalidArgument(message: string): TsirError {
  return new TsirError('LNK_INVALID_ARGUMENT', message, { kind: 'link' });
}
