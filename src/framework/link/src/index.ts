/**
 * `@tsir/link` — the shared half of service-to-service calls.
 *
 * This entrypoint is protocol-free on purpose: importing it gives you the contract
 * (`CallContext`, `CallResult`, `CallError`), the policies that every protocol shares
 * (deadline, retry, breaker, credentials, trace propagation) and the normalization
 * table. Nothing here imports `fetch`, `@grpc/grpc-js` or an XML parser, so a
 * Workers bundle that only needs the types pays for the types.
 *
 * The protocol entrypoints (`/rest`, `/grpc`, `/soap`, `/ws`) each add their own
 * dependency closure and are imported where they are used — that is what keeps a gRPC
 * service from shipping an XML parser (ADR-0004).
 */

export {
  assertNever,
  CALL_ERROR_KINDS,
  createCallContext,
  fail,
  ok,
  randomSpanId,
  randomTraceId,
} from './types.ts';
export type {
  CallContext,
  CallError,
  CallErrorKind,
  CallMeta,
  CallResult,
  ServiceCredential,
} from './types.ts';

export {
  callError,
  invalidLinkConfig,
  kindForGrpcStatus,
  kindForHttpStatus,
  kindForSoapFault,
  kindForWsClose,
  parseRetryAfter,
  retryableKind,
  schemaViolation,
  urlNotAllowed,
} from './errors.ts';
export type { LinkErrorCode } from './errors.ts';

export { abortableSleep, composeSignals, preflight, remainingMs, withTimeout } from './deadline.ts';
export type { ComposedSignal } from './deadline.ts';

export { backoffMs, decideRetry, NO_RETRY, runWithRetry } from './retry.ts';
export type {
  RetryDecision,
  RetryDecisionContext,
  RetryPolicy,
  RunWithRetryOptions,
} from './retry.ts';

export { createCircuitBreaker } from './breaker.ts';
export type {
  BreakerSnapshot,
  BreakerState,
  CircuitBreaker,
  CircuitBreakerOptions,
} from './breaker.ts';

export {
  CORRELATION_HEADER,
  formatTraceparent,
  inboundContext,
  outboundHeaders,
  parseTraceparent,
  TRACEPARENT_HEADER,
} from './trace.ts';
export type { OutboundHeaders, Traceparent } from './trace.ts';

export {
  bearerCredentialProvider,
  redactCredential,
  resolveCredential,
  staticCredentialProvider,
  validateCredential,
} from './credentials.ts';
export type { CredentialRequest, ServiceCredentialProvider } from './credentials.ts';
