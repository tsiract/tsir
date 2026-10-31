/**
 * The request pipeline.
 *
 *   match → acceptable? → middleware → guards → policies → bind → handler
 *         → serialize → finalize, with exactly one error boundary around all of it
 *
 * This module is Web-standard: `Request` in, `Response` out. That is what lets
 * the same route table run on Bun, Workers and Lambda, and what makes the tests
 * here need no server at all.
 *
 * Two rules the implementation bends over backwards to keep:
 *   · `onError` never throws. A broken error mapper must not become an
 *     unhandled rejection.
 *   · a route timeout produces a response even if the handler ignores its
 *     abort signal.
 */

import { type Clock, isTsirError, normalizeError, systemClock, TsirError } from '@tsir/core';
import {
  createMatcher,
  type ControllerClass,
  type HttpMethod,
  type PolicyRef,
  type RouteEntry,
  type RouteTable,
} from '@tsir/router';
import { type ValidationIssue, validate, ValidationError } from '@tsir/validate';

import { bindRequest, type MultipartParser } from './bind.ts';
import type { BodyLimits } from './body.ts';
import { createRequestContext, type Principal, type RequestContext } from './context.ts';
import { problemResponse } from './problems.ts';

export type Next = () => Promise<Response>;

export type Middleware = (ctx: RequestContext, next: Next) => Promise<Response> | Response;

export type Guard = (ctx: RequestContext) => Promise<Principal | null> | Principal | null;

export type Decision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason?: string };

export type Policy = (ctx: RequestContext, ref: PolicyRef) => Promise<Decision> | Decision;

/**
 * The single object a handler receives. It takes what it declares.
 *
 * `principal` is present in the type and absent at runtime unless the route
 * declared `principal: true` — which the router refuses without a guard
 * (`RTR_PRINCIPAL_WITHOUT_GUARD`), so a handler that reads it cannot be reached
 * unauthenticated.
 */
export interface HandlerContext<P = Principal> {
  readonly params: unknown;
  readonly query: unknown;
  readonly body: unknown;
  readonly headers: unknown;
  readonly ctx: RequestContext;
  readonly principal?: P | undefined;
}

export type RouteHandler = (context: HandlerContext) => unknown;

/** Explicit response shape for status/header variants. */
export interface ResponsePlan {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface HttpOptions {
  readonly maxBodyBytes?: number;
  readonly maxJsonDepth?: number;
  readonly defaultTimeoutMs?: number;
  readonly trailingSlash?: 'strict' | 'ignore';
  readonly clock?: Clock;
  /** Global middleware, in order, before any route middleware. */
  readonly middleware?: readonly Middleware[];
  /** Route middleware, addressed by the token a route declares. */
  readonly middlewareByToken?: Readonly<Record<string, Middleware>>;
  readonly guards?: Readonly<Record<string, Guard>>;
  /**
   * `multipart/form-data` parser. Import it from `@tsir/http/multipart` and pass
   * it here — uploads are opt-in so an edge bundle that never accepts a file
   * does not carry the parser.
   */
  readonly multipart?: MultipartParser;
  /**
   * `WWW-Authenticate` challenge sent with every 401 (RFC 9110 § 15.5.2).
   *
   * A 401 without a challenge is a protocol error: it tells the client the
   * request failed but not how to authenticate. Set to `''` to omit it when the
   * scheme is genuinely not describable.
   */
  readonly authChallenge?: string;
  readonly policies?: Readonly<Record<string, Policy>>;
  /** Instantiate a controller. Defaults to `new Controller()`. */
  readonly resolveController?: (controller: ControllerClass, ctx: RequestContext) => unknown;
  /** Last-resort mapper. Must return a Response; its own throw is swallowed. */
  readonly onError?: (error: unknown, ctx: RequestContext) => Response | undefined;
  /** Extra headers on every response — CORS, security headers. */
  readonly responseHeaders?: Readonly<Record<string, string>>;
  /** CORS. Off unless configured; preflight is answered by the pipeline. */
  readonly cors?: CorsOptions;
  /**
   * Validate what handlers return against `meta.response` (`HTP-013`).
   *
   * `dev` logs and passes the body through, `always` answers 500, `never` checks
   * nothing. Anything but `never` costs a second validation pass per request, so
   * production services that care about latency use `never` and rely on tests.
   */
  readonly responseValidation?: ResponseValidationMode;
  /**
   * Receives every audit event: all denials, plus allowed decisions whose policy
   * was declared `audit: true`. Route it to the log sink from ADR-0017.
   */
  readonly onAudit?: (event: AuditEvent) => void;
  /** Called when a response fails its schema. Default: silent. */
  readonly onInvalidResponse?: (failure: InvalidResponse) => void;
}

export type ResponseValidationMode = 'dev' | 'always' | 'never';

/**
 * One authorization decision, as recorded (`HTP-011`).
 *
 * Shaped like the framework's log record: a stable event name,
 * a correlation id and flat fields a query language can filter on — never a
 * prose sentence. `allowed` is present on every record so a consumer never has
 * to infer it from the absence of `reason`.
 */
export interface AuditEvent {
  readonly event: 'authz.decision';
  readonly ts: number;
  readonly requestId: string;
  readonly route: string;
  readonly method: HttpMethod;
  readonly subject: string | null;
  readonly resource: string;
  readonly action: string;
  readonly allowed: boolean;
  readonly reason?: string;
}

export interface InvalidResponse {
  readonly route: RouteEntry;
  readonly ctx: RequestContext;
  readonly issues: readonly ValidationIssue[];
}

export interface CorsOptions {
  /** Exact origins, or `['*']`. Wildcard with credentials is a boot error. */
  readonly origins: readonly string[];
  readonly methods?: readonly HttpMethod[];
  readonly headers?: readonly string[];
  readonly exposeHeaders?: readonly string[];
  readonly credentials?: boolean;
  readonly maxAgeSeconds?: number;
}

export type FetchHandler = (request: Request) => Promise<Response>;

const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_MAX_JSON_DEPTH = 32;
const DEFAULT_TIMEOUT_MS = 30_000;

function requestId(): string {
  return crypto.randomUUID();
}

/**
 * Combines abort signals without `AbortSignal.any`, which is not available on
 * every runtime Tsir targets. Listener cleanup is handled by the returned abort.
 */
function linkSignals(signals: readonly AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}

function isResponsePlan(value: unknown): value is ResponsePlan {
  if (typeof value !== 'object' || value === null || value instanceof Response) return false;
  const keys = Object.keys(value);
  if (keys.length === 0) return false;
  return keys.every((key) => key === 'status' || key === 'body' || key === 'headers');
}

const BODYLESS = new Set([204, 304]);

export function createFetchHandler(table: RouteTable, options: HttpOptions = {}): FetchHandler {
  const matcher = createMatcher(table, {
    ...(options.trailingSlash === undefined ? {} : { trailingSlash: options.trailingSlash }),
  });
  const clock = options.clock ?? systemClock();
  const limits: BodyLimits = {
    maxBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    maxDepth: options.maxJsonDepth ?? DEFAULT_MAX_JSON_DEPTH,
  };
  const globalMiddleware = options.middleware ?? [];
  const middlewareByToken = options.middlewareByToken ?? {};
  const guardRegistry = options.guards ?? {};
  const policyRegistry = options.policies ?? {};
  const defaultTimeout = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  // A declared token with no implementation is a wiring bug that would otherwise
  // surface as a 401 on a route nobody can reach. Fail at construction instead.
  for (const route of table.routes) {
    for (const token of route.guards) {
      if (guardRegistry[token] === undefined) {
        throw new TsirError(
          'HTP_UNKNOWN_GUARD',
          `Route ${route.method} ${route.path} declares guard "${token}", which is not registered`,
          {
            kind: 'http',
            hint: 'pass it in createFetchHandler({ guards: { [token]: guard } }) or remove it from the route',
            context: { token, path: route.path },
          },
        );
      }
    }
    for (const policy of route.policies) {
      const key = `${policy.resource}:${policy.action}`;
      if (policyRegistry[key] === undefined) {
        throw new TsirError(
          'HTP_UNKNOWN_POLICY',
          `Route ${route.method} ${route.path} declares policy "${key}", which is not registered`,
          {
            kind: 'http',
            hint: 'register it in createFetchHandler({ policies: { "resource:action": policy } })',
            context: { policy: key, path: route.path },
          },
        );
      }
    }
  }

  /**
   * CORS is answered by the pipeline, not by middleware, for two reasons: a
   * preflight `OPTIONS` never matches a route (so it cannot be reached through
   * normal matching), and a denied origin must still get a normal response —
   * just without the headers — rather than an error the browser reports as a
   * network failure.
   */
  // Wildcard + credentials is the classic CORS footgun: browsers reject the
  // combination, so a service that ships it has CORS that appears configured and
  // silently does nothing. Refuse it at construction.
  if (options.cors?.origins.includes('*') === true && options.cors.credentials === true) {
    throw new TsirError(
      'HTP_CORS_WILDCARD_CREDENTIALS',
      'cors.origins "*" cannot be combined with credentials: true',
      {
        kind: 'http',
        hint: 'list the allowed origins explicitly, or set credentials: false',
        context: { origins: options.cors.origins.join(', ') },
      },
    );
  }

  function allowedOrigin(request: Request): string | undefined {
    const rules = options.cors;
    if (rules === undefined) return undefined;
    const origin = request.headers.get('origin');
    if (origin === null || origin === '') return undefined;
    if (rules.origins.includes('*')) return '*';
    return rules.origins.includes(origin) ? origin : undefined;
  }

  function corsHeaders(request: Request): Record<string, string> {
    const rules = options.cors;
    const origin = allowedOrigin(request);
    if (rules === undefined || origin === undefined) return {};

    const headers: Record<string, string> = {
      'access-control-allow-origin': origin,
      // Never a bare `*` here: the response depends on the request's Origin, so
      // caching it without this would serve one origin's headers to another.
      vary: 'Origin',
    };
    if (rules.credentials === true) headers['access-control-allow-credentials'] = 'true';
    if (rules.exposeHeaders !== undefined && rules.exposeHeaders.length > 0) {
      headers['access-control-expose-headers'] = rules.exposeHeaders.join(', ');
    }
    return headers;
  }

  /** `OPTIONS` + `Access-Control-Request-Method`: answer without touching a route. */
  function preflight(request: Request): Response | undefined {
    const rules = options.cors;
    if (rules === undefined) return undefined;
    if (request.method.toUpperCase() !== 'OPTIONS') return undefined;
    if (request.headers.get('access-control-request-method') === null) return undefined;

    const origin = allowedOrigin(request);
    const headers: Record<string, string> = { ...corsHeaders(request) };

    // A denied origin gets no CORS headers at all. Deliberately still a 204:
    // the browser is the authority on whether the caller may proceed, and a
    // 403 here would be indistinguishable from a real authorisation failure.
    if (origin !== undefined) {
      headers['access-control-allow-methods'] = (
        rules.methods ?? ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
      ).join(', ');
      const requested = request.headers.get('access-control-request-headers');
      const allowed = rules.headers;
      if (allowed !== undefined && allowed.length > 0) {
        headers['access-control-allow-headers'] = allowed.join(', ');
      } else if (requested !== null) {
        headers['access-control-allow-headers'] = requested;
      }
      if (rules.maxAgeSeconds !== undefined) {
        headers['access-control-max-age'] = String(rules.maxAgeSeconds);
      }
    }

    return new Response(null, { status: 204, headers });
  }

  function finalize(response: Response, request: Request, id: string): Response {
    const headers = new Headers(response.headers);
    headers.set('x-request-id', id);
    for (const [key, value] of Object.entries(options.responseHeaders ?? {}))
      headers.set(key, value);
    for (const [key, value] of Object.entries(corsHeaders(request))) {
      if (key === 'vary' && headers.has('vary'))
        headers.set('vary', `${headers.get('vary')}, ${value}`);
      else headers.set(key, value);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  function frame(route: RouteEntry, request: Request, id: string): RequestContext {
    const timeoutMs = route.meta.timeoutMs ?? defaultTimeout;
    const signal = linkSignals([request.signal, AbortSignal.timeout(timeoutMs)]);
    return createRequestContext({
      id,
      method: route.method,
      url: new URL(request.url),
      request,
      signal,
      startedAtMs: clock.monotonicMs(),
      clock,
      principal: undefined,
      clientIp: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined,
    });
  }

  async function execute(route: RouteEntry, ctx: RequestContext): Promise<Response> {
    const timeoutMs = route.meta.timeoutMs ?? defaultTimeout;
    return runStage(route, ctx, timeoutMs);
  }

  /** Middleware → guards → policies → bind → handler → serialize. */
  async function runCore(route: RouteEntry, ctx: RequestContext): Promise<Response> {
    const url = ctx.url;

    for (const token of route.guards) {
      const guard = guardRegistry[token];
      if (guard === undefined) continue;
      const principal = await guard(ctx);
      if (principal === null) {
        const challenge = options.authChallenge ?? 'Bearer';
        return problemResponse('HTP_UNAUTHENTICATED', {
          instance: url.pathname,
          requestId: ctx.id,
          ...(challenge === '' ? {} : { headers: { 'www-authenticate': challenge } }),
        });
      }
      ctx.principal = principal;
    }

    for (const ref of route.policies) {
      const policy = policyRegistry[`${ref.resource}:${ref.action}`];
      if (policy === undefined) continue;
      const decision = await policy(ctx, ref);

      // Denials are always auditable: "who was refused what" is the question a
      // compliance review asks. Allowed decisions are recorded only when the
      // route asked for it, because logging every successful read is how audit
      // trails become too expensive to keep.
      if (!decision.allowed || ref.audit === true) {
        options.onAudit?.({
          event: 'authz.decision',
          ts: ctx.clock.now().getTime(),
          requestId: ctx.id,
          route: route.path,
          method: route.method,
          subject: ctx.principal?.subject ?? null,
          resource: ref.resource,
          action: ref.action,
          allowed: decision.allowed,
          ...(decision.allowed
            ? {}
            : decision.reason === undefined
              ? {}
              : { reason: decision.reason }),
        });
      }

      if (!decision.allowed) {
        return problemResponse('HTP_FORBIDDEN', {
          instance: url.pathname,
          requestId: ctx.id,
          ...(decision.reason === undefined ? {} : { detail: decision.reason }),
        });
      }
    }

    const matched = matcher.match(ctx.method, url.pathname);
    const params = matched.kind === 'matched' ? matched.params : {};

    const bound = await bindRequest(route, ctx.request, url, params, limits, options.multipart);
    switch (bound.kind) {
      case 'not-acceptable':
        return problemResponse('HTP_NOT_ACCEPTABLE', {
          instance: url.pathname,
          requestId: ctx.id,
          detail: `this route produces ${(route.meta.produces ?? []).join(', ') || 'no declared type'}`,
        });
      case 'unsupported-media-type':
        return problemResponse('HTP_UNSUPPORTED_MEDIA_TYPE', {
          instance: url.pathname,
          requestId: ctx.id,
          detail: `expected ${(route.meta.consumes ?? ['application/json']).join(', ')}`,
        });
      case 'too-large':
        return problemResponse('HTP_BODY_TOO_LARGE', {
          instance: url.pathname,
          requestId: ctx.id,
          detail: `body exceeds ${limits.maxBytes} bytes`,
        });
      case 'malformed':
        return problemResponse('HTP_MALFORMED_BODY', {
          instance: url.pathname,
          requestId: ctx.id,
          detail: bound.detail,
        });
      case 'mime-mismatch':
        // The declared type and the bytes disagree. Answering 422 rather than
        // storing it is the whole point of sniffing: a `.png` whose magic
        // number says `application/zip` is not a PNG, whatever the client said.
        return problemResponse('HTP_MIME_MISMATCH', {
          instance: url.pathname,
          requestId: ctx.id,
          detail: `${bound.field}: declared ${bound.declared}, content is ${bound.sniffed}`,
        });
      case 'validation':
        return problemResponse('HTP_VALIDATION_FAILED', {
          instance: url.pathname,
          requestId: ctx.id,
          issues: bound.issues,
        });
      case 'bound':
        break;
    }

    const instance = resolveController(route, ctx);
    const handler: unknown = Reflect.get(instance as object, route.handler) as unknown;
    if (typeof handler !== 'function') {
      throw new TsirError('HTP_BAD_HANDLER', `${route.path} handler disappeared at runtime`, {
        kind: 'http',
        context: { handler: route.handler },
      });
    }

    const args: HandlerContext = {
      ...bound.value,
      ctx,
      ...(route.meta.principal === true ? { principal: ctx.principal } : {}),
    };

    const result: unknown = await (handler as RouteHandler).call(instance, args);

    return await serialize(route, result, ctx);
  }

  function resolveController(route: RouteEntry, ctx: RequestContext): unknown {
    if (options.resolveController !== undefined)
      return options.resolveController(route.controller, ctx);
    // `ControllerClass` is abstract so that abstract base classes may carry
    // decorators; instantiation happens here and only here.
    const Ctor = route.controller as new () => unknown;
    return new Ctor();
  }

  const responseMode: ResponseValidationMode = options.responseValidation ?? 'dev';

  /**
   * Checks the value a handler produced against `meta.response` (`HTP-013`).
   *
   * Validation runs on the *value*, before serialization, so the error names the
   * field the handler got wrong rather than pointing at JSON text. A handler that
   * returns a `Response` opts out — the framework cannot see inside it.
   */
  async function checkResponse(
    route: RouteEntry,
    body: unknown,
    ctx: RequestContext,
  ): Promise<Response | undefined> {
    const schema = route.meta.response;
    if (schema === undefined || responseMode === 'never') return undefined;

    const result = await validate(schema, body);
    if (result.ok) return undefined;

    const failure: InvalidResponse = { route, ctx, issues: result.issues };
    options.onInvalidResponse?.(failure);

    // `dev` reports the same problem a test would, without turning an otherwise
    // valid payload into an outage. `always` is for services whose consumers
    // depend on the contract more than on availability.
    if (responseMode === 'dev') return undefined;
    return problemResponse('HTP_RESPONSE_INVALID', {
      instance: ctx.url.pathname,
      requestId: ctx.id,
      issues: result.issues,
    });
  }

  async function serialize(
    route: RouteEntry,
    result: unknown,
    ctx: RequestContext,
  ): Promise<Response> {
    if (isResponse(result)) return result;

    const declared: number = route.meta.status ?? 200;
    let status: number = declared;
    let body: unknown;
    const headers: Record<string, string> = {};

    if (isResponsePlan(result)) {
      status = result.status ?? declared;
      body = result.body;
      for (const [key, value] of Object.entries(result.headers ?? {})) headers[key] = value;
    } else {
      body = result;
    }

    const invalid = await checkResponse(route, body, ctx);
    if (invalid !== undefined) return invalid;

    if (BODYLESS.has(status)) {
      if (body !== undefined && body !== null) {
        // A route whose status forbids a body returned one. That is a framework
        // error, not a 500 the caller caused, and it says exactly what happened.
        return problemResponse('HTP_BODY_NOT_ALLOWED', {
          instance: ctx.url.pathname,
          requestId: ctx.id,
          detail: `status ${status} cannot carry a body`,
        });
      }
      return new Response(null, { status, headers });
    }

    if (body === undefined) return new Response(null, { status, headers });

    if (body instanceof Uint8Array) {
      if (headers['content-type'] === undefined)
        headers['content-type'] = 'application/octet-stream';
      return new Response(body, { status, headers });
    }

    if (typeof body === 'string') {
      if (headers['content-type'] === undefined)
        headers['content-type'] = 'text/plain; charset=utf-8';
      return new Response(body, { status, headers });
    }

    headers['content-type'] ??= 'application/json; charset=utf-8';
    return new Response(JSON.stringify(body), { status, headers });
  }

  /** Wraps the whole pipeline in exactly one error boundary plus the timeout. */
  async function runStage(
    route: RouteEntry,
    ctx: RequestContext,
    timeoutMs: number,
  ): Promise<Response> {
    const chain = [...globalMiddleware, ...routeMiddleware(route)];

    const terminal = async (): Promise<Response> => runCore(route, ctx);

    let index = -1;
    const dispatch = async (position: number): Promise<Response> => {
      if (position <= index) {
        throw new TsirError(
          'HTP_MIDDLEWARE_NEXT_TWICE',
          'middleware called next() more than once',
          {
            kind: 'http',
            context: { position },
          },
        );
      }
      index = position;
      const current = chain[position];
      if (current === undefined) return terminal();
      return current(ctx, () => dispatch(position + 1));
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<Response>((resolve) => {
      timer = setTimeout(() => {
        resolve(
          problemResponse('HTP_TIMEOUT', {
            instance: ctx.url.pathname,
            requestId: ctx.id,
            detail: `no response within ${timeoutMs} ms`,
          }),
        );
      }, timeoutMs);
    });

    try {
      const work = dispatch(0);
      // The handler may ignore its abort signal; the race guarantees a response
      // anyway, and the signal tells well-behaved code to stop working.
      const response = await Promise.race([work, timeout]);
      work.catch(() => undefined);
      return response;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Route-declared middleware, resolved by token, in declaration order. */
  function routeMiddleware(route: RouteEntry): readonly Middleware[] {
    const resolved: Middleware[] = [];
    for (const token of route.middleware) {
      const middleware = middlewareByToken[token];
      if (middleware === undefined) {
        throw new TsirError(
          'HTP_UNKNOWN_MIDDLEWARE',
          `Route ${route.method} ${route.path} declares middleware "${token}", which is not registered`,
          {
            kind: 'http',
            hint: 'pass it in createFetchHandler({ middlewareByToken: { [token]: middleware } })',
            context: { token, path: route.path },
          },
        );
      }
      resolved.push(middleware);
    }
    return resolved;
  }

  return async function handle(request: Request): Promise<Response> {
    const id = requestId();
    const url = new URL(request.url);
    const method = request.method.toUpperCase() as HttpMethod;

    // Before matching: a preflight must be answered even when the route declares
    // no OPTIONS handler, and must not run guards — the browser sends no
    // credentials on it.
    const preflightResponse = preflight(request);
    if (preflightResponse !== undefined) {
      const headers = new Headers(preflightResponse.headers);
      headers.set('x-request-id', id);
      return new Response(null, { status: preflightResponse.status, headers });
    }

    const matched = matcher.match(method, url.pathname);
    if (matched.kind === 'not-found') {
      return finalize(
        problemResponse('HTP_ROUTE_NOT_FOUND', { instance: url.pathname, requestId: id }),
        request,
        id,
      );
    }
    if (matched.kind === 'bad-path') {
      return finalize(
        problemResponse('HTP_BAD_REQUEST', {
          instance: url.pathname,
          requestId: id,
          detail: matched.reason,
        }),
        request,
        id,
      );
    }
    if (matched.kind === 'method-not-allowed') {
      return finalize(
        problemResponse('HTP_METHOD_NOT_ALLOWED', {
          instance: url.pathname,
          requestId: id,
          headers: { allow: matched.allow.join(', ') },
        }),
        request,
        id,
      );
    }

    const ctx = frame(matched.route, request, id);

    try {
      const response = await execute(matched.route, ctx);
      const shaped = matched.head
        ? new Response(null, { status: response.status, headers: response.headers })
        : response;
      return finalize(shaped, request, id);
    } catch (error) {
      const mapped = mapError(error, ctx);
      return finalize(mapped, request, id);
    }
  };

  function mapError(error: unknown, ctx: RequestContext): Response {
    if (options.onError !== undefined) {
      try {
        const custom = options.onError(error, ctx);
        if (custom !== undefined) return custom;
      } catch {
        // A throwing mapper must not mask the original failure.
      }
    }

    if (error instanceof ValidationError) {
      return problemResponse('HTP_VALIDATION_FAILED', {
        instance: ctx.url.pathname,
        requestId: ctx.id,
        issues: error.issues,
      });
    }

    if (isTsirError(error) && error.code === 'VLD_INVALID') {
      return problemResponse('HTP_VALIDATION_FAILED', {
        instance: ctx.url.pathname,
        requestId: ctx.id,
      });
    }

    const normalized = normalizeError(error, 'HTP_HANDLER_ERROR');
    // The client gets the code and the request id; the stack goes to the log.
    return problemResponse('HTP_HANDLER_ERROR', {
      instance: ctx.url.pathname,
      requestId: ctx.id,
      ...(normalized.code === 'HTP_HANDLER_ERROR' ? {} : { detail: normalized.code }),
    });
  }
}
