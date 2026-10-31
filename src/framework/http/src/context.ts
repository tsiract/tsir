/**
 * The per-request context.
 *
 * One object, created once per request, passed to every stage. It is the only
 * thing middleware, guards, policies and handlers share — there is no ambient
 * `req`/`res`, and no writable bag on the request object itself.
 *
 * `state` exists because middleware legitimately needs to pass a value to a
 * later stage (an authenticated tenant, a parsed idempotency key). It is a `Map`
 * with framework-owned keys under the `tsir.` prefix; nothing reads another
 * package's keys by convention.
 */

import type { Clock } from '@tsir/core';
import type { HttpMethod } from '@tsir/router';

/** What a guard returns when it succeeds. `null` means unauthenticated. */
export interface Principal<T = unknown> {
  /** Stable subject identifier — a user id, a service name, a key id. */
  readonly subject: string;
  /** Guard-defined payload. Typed by the guard, opaque to the framework. */
  readonly data: T;
}

export interface RequestContext {
  /** Correlated through logs, problem responses and `X-Request-Id`. */
  readonly id: string;
  readonly method: HttpMethod;
  readonly url: URL;
  readonly request: Request;
  /** Aborts on client disconnect or route timeout. */
  readonly signal: AbortSignal;
  readonly startedAtMs: number;
  readonly clock: Clock;
  /**
   * Set exactly once, by the guard stage, before binders run. Mutable because a
   * guard legitimately owns it; nothing else may write it.
   */
  principal: Principal | undefined;
  /** Per-request scratch space shared between stages. */
  readonly state: Map<string, unknown>;
  /** Immediate peer address, or the last trusted proxy hop. */
  readonly clientIp: string | undefined;
}

export function createRequestContext(init: Omit<RequestContext, 'state'>): RequestContext {
  return { ...init, state: new Map<string, unknown>() };
}
