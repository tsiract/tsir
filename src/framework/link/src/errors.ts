/**
 * Error normalization (`LNK-008`): four protocols, one vocabulary.
 *
 * The table is the deliverable. REST says `503`, gRPC says `UNAVAILABLE`, SOAP says
 * `soap:Server` with a `faultcode`, WebSocket says `1013` — an application that has
 * to remember which is which has four `if` chains and one bug. Here they all become
 * a `CallErrorKind`, and the protocol's own code is kept in `code` for logs.
 *
 * Two rules this file encodes:
 *
 *   1. **Failures are values.** `callError()` builds a `CallError`; nothing throws.
 *      `TsirError` is reserved for programming mistakes — a schema that does not
 *      validate locally, a URL that is not allowlisted — which are bugs in the
 *      caller, not events on the wire (`LNK_SCHEMA`, `LNK_URL_NOT_ALLOWED`).
 *   2. **Retryability is a property of the kind, plus server hints.** `timeout`,
 *      `unavailable` and `rate_limited` may succeed later; `invalid_argument`,
 *      `unauthenticated` and `permission_denied` never will, and retrying them is
 *      how an outage becomes a pile of duplicate work.
 */

import { TsirError } from '@tsir/core';

import { assertNever, type CallError, type CallErrorKind } from './types.ts';

/**
 * Codes that appear in `CallError.code`. Prefix `LNK_` matches the failure table in § 9. Every literal
 * `LNK_` code passed to `callError()` must be listed here; `check-error-codes` enforces it.
 */
export type LinkErrorCode =
  | 'LNK_TIMEOUT'
  | 'LNK_CANCELLED'
  | 'LNK_UNAVAILABLE'
  | 'LNK_RATE_LIMITED'
  | 'LNK_UNAUTHENTICATED'
  | 'LNK_PERMISSION_DENIED'
  | 'LNK_INVALID_ARGUMENT'
  | 'LNK_NOT_FOUND'
  | 'LNK_CONFLICT'
  | 'LNK_PROTOCOL'
  | 'LNK_SERVER'
  | 'LNK_UNKNOWN'
  | 'LNK_CIRCUIT_OPEN'
  | 'LNK_WS_CLOSED'
  | 'LNK_ROOM_EMPTY'
  | 'LNK_SOAP_FAULT'
  | 'LNK_SCHEMA'
  | 'LNK_GRPC_UNAVAILABLE'
  | 'LNK_URL_NOT_ALLOWED'
  | 'LNK_INVALID_CONFIG'
  | 'LNK_NETWORK'
  | 'LNK_CONTENT_TYPE'
  | 'LNK_INVALID_JSON'
  | 'LNK_BODY_TOO_LARGE'
  | 'LNK_WS_BACKPRESSURE'
  | 'LNK_WS_SEND_FAILED'
  | 'LNK_WS_UNSERIALIZABLE';

/**
 * Whether an identical request could succeed if sent again.
 *
 * `timeout` is retryable, and that is a deliberate decision rather than optimism: a
 * timeout means *we do not know* whether the server processed it, which is exactly why
 * the retry layer still refuses non-idempotent calls without an idempotency key.
 */
export function retryableKind(kind: CallErrorKind): boolean {
  switch (kind) {
    case 'timeout':
    case 'unavailable':
    case 'rate_limited':
      return true;
    case 'cancelled':
    case 'unauthenticated':
    case 'permission_denied':
    case 'invalid_argument':
    case 'not_found':
    case 'conflict':
    case 'protocol':
    case 'server':
    case 'unknown':
      return false;
    default:
      return assertNever(kind, 'CallErrorKind');
  }
}

/** Builds a `CallError` from a kind and the protocol's own code. */
export function callError(
  kind: CallErrorKind,
  code: string,
  options: {
    readonly retryable?: boolean | undefined;
    readonly retryAfterMs?: number | undefined;
    readonly cause?: unknown;
    readonly message?: string | undefined;
  } = {},
): CallError {
  return {
    kind,
    code,
    retryable: options.retryable ?? retryableKind(kind),
    ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
    ...(options.cause === undefined ? {} : { cause: options.cause }),
    ...(options.message === undefined ? {} : { message: options.message }),
  };
}

/** kind → the `LNK_*` code that goes in `CallError.code` (§ 9's table, in code). */
export function codeForKind(kind: CallErrorKind): LinkErrorCode {
  switch (kind) {
    case 'timeout':
      return 'LNK_TIMEOUT';
    case 'cancelled':
      return 'LNK_CANCELLED';
    case 'unavailable':
      return 'LNK_UNAVAILABLE';
    case 'rate_limited':
      return 'LNK_RATE_LIMITED';
    case 'unauthenticated':
      return 'LNK_UNAUTHENTICATED';
    case 'permission_denied':
      return 'LNK_PERMISSION_DENIED';
    case 'invalid_argument':
      return 'LNK_INVALID_ARGUMENT';
    case 'not_found':
      return 'LNK_NOT_FOUND';
    case 'conflict':
      return 'LNK_CONFLICT';
    case 'protocol':
      return 'LNK_PROTOCOL';
    case 'server':
      return 'LNK_SERVER';
    case 'unknown':
      return 'LNK_UNKNOWN';
    default:
      return assertNever(kind, 'CallErrorKind');
  }
}

/**
 * HTTP status → kind. Used by REST and by the SOAP server, which is HTTP underneath.
 *
 * 4xx mapping is by meaning, not by pattern: `408` is a timeout, `429` is retryable
 * with a hint, `409` is a conflict (the mutation already happened), and every other
 * 4xx client error is `invalid_argument` except the two auth ones.
 */
export function kindForHttpStatus(status: number): CallErrorKind {
  if (status === 408) return 'timeout';
  if (status === 425) return 'conflict'; // Too Early: a state problem, not a syntax one
  if (status === 429) return 'rate_limited';
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'permission_denied';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status >= 500 && status <= 504) return 'unavailable';
  if (status >= 400 && status < 500) return 'invalid_argument';
  if (status >= 500) return 'server';
  return 'unknown';
}

/** The canonical gRPC status names `@grpc/grpc-js` reports, mapped to our kinds. */
export function kindForGrpcStatus(status: string): CallErrorKind {
  switch (status) {
    case 'OK':
      return 'unknown'; // not an error; mapped so the table is total
    case 'CANCELLED':
      return 'cancelled';
    case 'UNKNOWN':
      return 'unknown';
    case 'INVALID_ARGUMENT':
    case 'FAILED_PRECONDITION':
    case 'OUT_OF_RANGE':
      return 'invalid_argument';
    case 'DEADLINE_EXCEEDED':
      return 'timeout';
    case 'NOT_FOUND':
      return 'not_found';
    case 'ALREADY_EXISTS':
    case 'ABORTED':
      return 'conflict';
    case 'PERMISSION_DENIED':
      return 'permission_denied';
    case 'UNAUTHENTICATED':
      return 'unauthenticated';
    case 'RESOURCE_EXHAUSTED':
      return 'rate_limited';
    case 'UNIMPLEMENTED':
    case 'INTERNAL':
    case 'DATA_LOSS':
      return 'server';
    case 'UNAVAILABLE':
      return 'unavailable';
    default:
      return 'unknown';
  }
}

/**
 * SOAP 1.1/1.2 fault codes → kind.
 *
 * SOAP is where "map the code" becomes guesswork, so the rule is explicit: the
 * standard `Client`/`Sender` codes are the caller's fault (`invalid_argument`), the
 * standard `Server`/`Receiver` codes are the callee's (`server`), and every
 * application-defined `detail` code is `unknown` unless the contract's own map says
 * otherwise — which is what `soapFaultKind` takes as an argument.
 */
export function kindForSoapFault(
  faultCode: string,
  mapping: Readonly<Record<string, CallErrorKind>> = {},
): CallErrorKind {
  const configured = mapping[faultCode];
  if (configured !== undefined) return configured;

  // `soap:Client` (1.1), `env:Sender` (1.2), and their `VersionMismatch`/`MustUnderstand` forms.
  if (/client|sender/i.test(faultCode)) return 'invalid_argument';
  if (/server|receiver/i.test(faultCode)) return 'server';
  if (/mustunderstand/i.test(faultCode)) return 'protocol';
  if (/versionmismatch/i.test(faultCode)) return 'protocol';
  return 'unknown';
}

/**
 * WebSocket close codes → kind (`LNK-021`…`LNK-024`).
 *
 * `1000`/`1001` are *normal* closes: a drained connection is not a failure, and
 * treating it as one would make every deploy look like an incident. `1008` is a policy
 * violation (a frame that failed validation), `1013` is "try later" and is retryable.
 */
export function kindForWsClose(code: number): CallErrorKind | 'closed' {
  if (code === 1000 || code === 1001) return 'closed';
  if (code === 1002 || code === 1003 || code === 1007 || code === 1008 || code === 1009) {
    return 'protocol';
  }
  if (code === 1011) return 'server';
  if (code === 1012 || code === 1013) return 'unavailable';
  if (code === 1014) return 'unavailable';
  if (code === 4401) return 'unauthenticated';
  if (code === 4403) return 'permission_denied';
  return 'unknown';
}

/**
 * Parses `Retry-After`, which is either delta-seconds or an HTTP date.
 *
 * Both forms are real and servers use both; a parser that handles one turns a
 * `Retry-After: 30` into `NaN` and a retry policy into a busy loop.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;

  if (/^\d+$/.test(trimmed)) {
    // coercion-ok: `Retry-After` delta-seconds is by definition a number; the regex above rejects the rest.
    return Number(trimmed) * 1000;
  }

  // A leading `-` is not a date and not a delta: `Date.parse('-5')` happily returns
  // a year in the distant past, which would become "retry immediately".
  if (trimmed.startsWith('-')) return undefined;

  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

/** A caller-side mistake: the request failed local validation, so nothing was sent. */
export function schemaViolation(what: string, detail: string): TsirError {
  return new TsirError('LNK_SCHEMA', `${what} failed local validation: ${detail}`, {
    kind: 'link',
    hint: 'the request never left the process: fix the payload or the schema',
    context: { what },
  });
}

/** A URL that is not allowlisted (`14-security.md`): never called, because it never is. */
export function urlNotAllowed(url: string, allowlist: readonly string[]): TsirError {
  return new TsirError('LNK_URL_NOT_ALLOWED', `"${url}" is not in the configured allowlist`, {
    kind: 'link',
    hint: 'outbound URLs come from validated config; user-influenced URLs need an allowlist',
    context: { url, allowlist: allowlist.join(',') },
  });
}

/** Bad client configuration: caught at construction, not on the first call. */
/**
 * Service-to-service calls use TLS. `http:` is allowed only for loopback, because a test
 * server on `127.0.0.1` cannot have a certificate and loopback traffic does not leave the
 * machine.
 */
export function assertHttpsUrl(url: URL, what: string): void {
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return;
  throw invalidLinkConfig(
    `${what} "${url.href}" uses ${url.protocol} to a non-loopback host — service calls must use https`,
  );
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function invalidLinkConfig(detail: string): TsirError {
  return new TsirError('LNK_INVALID_CONFIG', detail, {
    kind: 'link',
    hint: 'link clients are built once, at boot — a bad base URL is a startup failure, not a request failure',
  });
}
