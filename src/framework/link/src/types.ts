/**
 * The shared contract every protocol speaks (`LNK-001`).
 *
 * One context in, one result out — for REST, gRPC, SOAP and WebSocket alike. The
 * value of the shape is what it *forbids*:
 *
 *   · **Remote failures do not throw.** A refused connection, a 503, a SOAP fault,
 *     a gRPC `UNAVAILABLE` — all of them arrive as `{ ok: false, error }`. A thrown
 *     error means the caller's own code is wrong (bad schema, missing config), and
 *     those are `TsirError`s raised before any I/O.
 *   · **`CallErrorKind` is the branch point.** Application code switches on `kind`;
 *     `code` is for logs and for the one place that really needs the protocol detail.
 *   · **A result carries its own metadata.** Status, attempt count, duration and the
 *     credential *id* — never the credential itself.
 *
 * Nothing here imports a protocol, a runtime built-in or a validator: this file is
 * the floor the four entrypoints stand on, and it has to compile for Workers too.
 */

/** Why a call failed, in the only vocabulary application code should branch on. */
import { TsirError } from '@tsir/core';
export type CallErrorKind =
  | 'unavailable'
  | 'timeout'
  | 'cancelled'
  | 'unauthenticated'
  | 'permission_denied'
  | 'invalid_argument'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'protocol'
  | 'server'
  | 'unknown';

/** Every kind, in one place: tests iterate this, docs generate from it. */
export const CALL_ERROR_KINDS: readonly CallErrorKind[] = Object.freeze([
  'unavailable',
  'timeout',
  'cancelled',
  'unauthenticated',
  'permission_denied',
  'invalid_argument',
  'not_found',
  'conflict',
  'rate_limited',
  'protocol',
  'server',
  'unknown',
]);

export interface CallError {
  readonly kind: CallErrorKind;
  /** Protocol-specific code, normalized to something loggable (`LNK_TIMEOUT`, `UNAVAILABLE`, …). */
  readonly code: string;
  /** Whether the *same* attempt could plausibly succeed later. The retry layer still decides. */
  readonly retryable: boolean;
  /** Server-provided hint (`Retry-After`, gRPC `retry-after` metadata), when present. */
  readonly retryAfterMs?: number | undefined;
  /**
   * One line an operator can read, in the adapter's words.
   *
   * Kept separate from `cause` because `cause` is whatever the transport threw and is
   * often useless ("TypeError: fetch failed"). It is written by framework code, so it is
   * safe to log, and it must never contain a credential or a request body.
   */
  readonly message?: string | undefined;
  /**
   * The original error, preserved for logs and debugging.
   *
   * Rules: it never crosses a process boundary, it is never serialised into a
   * response, and `CallError`'s `code`/`kind` are what callers branch on. Keeping the
   * cause is how one debugging session replaces an afternoon of guessing.
   */
  readonly cause?: unknown;
}

export interface CallMeta {
  /** The protocol that produced this, e.g. `rest`, `grpc`. One span per call is named after it. */
  readonly protocol: string;
  /** Target as configured (`https://billing.internal`), never a user-supplied string. */
  readonly target: string;
  /** Attempts made, 1-based. A successful first try is 1. */
  readonly attempts: number;
  /** Wall-clock time for the whole call, including retries. */
  readonly elapsedMs: number;
  /** Which credential was used, by id — the secret itself never appears here. */
  readonly credentialId?: string | undefined;
  /** HTTP status or gRPC status, when the protocol has one. */
  readonly status?: number | undefined;
}

export type CallResult<T> =
  | { readonly ok: true; readonly value: T; readonly meta: CallMeta }
  | { readonly ok: false; readonly error: CallError; readonly meta: CallMeta };

/** What a caller supplies. `signal` is required: every call must be cancellable. */
export interface CallContext {
  /** W3C trace id, 32 lowercase hex characters. */
  readonly traceId: string;
  /** Stable per caller-operation id; distinct from the trace so logs can group one unit of work. */
  readonly correlationId: string;
  /** Absolute deadline. Protocols convert it (fetch signal, gRPC deadline, WS frame timeout). */
  readonly deadline?: Date | undefined;
  /** Composed caller signal: aborts on cancellation *and* on deadline expiry. */
  readonly signal: AbortSignal;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly credentials?: ServiceCredential | undefined;
  /**
   * Enables retry for a non-idempotent operation.
   *
   * The retry layer refuses to replay a `POST`/`PATCH`/gRPC mutation without one —
   * "the network failed, try again" is a duplicate-charge generator otherwise.
   */
  readonly idempotencyKey?: string | undefined;
}

/** A credential the call may attach. The secret lives in `headers` and is never logged. */
export interface ServiceCredential {
  /** Stable id for logs and metrics (`svc-billing-prod`, `mtls-1`). */
  readonly id: string;
  readonly scheme: 'bearer' | 'hmac' | 'mtls';
  /** Header values to attach. Never serialise this object. */
  readonly headers: Readonly<Record<string, string>>;
}

/** Narrowing helper: `assertNever` in a switch over kinds is a compile error once a kind is added. */
export function assertNever(value: never, what = 'value'): never {
  throw invalidArgument(`unexpected ${what}: ${JSON.stringify(value)}`);
}

/** Builds a success result with the metadata the call layer already knows. */
export function ok<T>(value: T, meta: CallMeta): CallResult<T> {
  return { ok: true, value, meta };
}

/** Builds a failure result. Symmetric with `ok` so call sites never construct the union by hand. */
export function fail<T = never>(error: CallError, meta: CallMeta): CallResult<T> {
  return { ok: false, error, meta };
}

/**
 * A context with no transport attached, for tests and for the first call in a chain.
 *
 * `signal` has to exist: a context without one would force every protocol to branch on
 * "is this cancellable?", and the answer is always yes.
 */
export function createCallContext(options: {
  readonly traceId?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly deadline?: Date | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly credentials?: ServiceCredential | undefined;
  readonly idempotencyKey?: string | undefined;
  /** Injectable for deterministic tests; defaults to the platform CSPRNG. */
  readonly traceIdFactory?: (() => string) | undefined;
}): CallContext {
  const traceId = options.traceId ?? (options.traceIdFactory ?? randomTraceId)();
  const correlationId = options.correlationId ?? traceId;
  const signal = options.signal ?? new AbortController().signal;

  return {
    traceId,
    correlationId,
    ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
    signal,
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
    ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
  };
}

/** 16 random bytes as hex — the trace-id half of a W3C `traceparent`. */
export function randomTraceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** 8 random bytes as hex — a span id, when a protocol needs one. */
export function randomSpanId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function invalidArgument(message: string): TsirError {
  return new TsirError('LNK_INVALID_ARGUMENT', message, { kind: 'link' });
}
