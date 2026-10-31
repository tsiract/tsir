/**
 * REST over `fetch` (`LNK-009`, `LNK-010`, `LNK-011`).
 *
 * Everything protocol-independent lives above this file; this is the adapter that turns
 * one HTTP exchange into a `CallResult` and back. Three decisions are worth stating:
 *
 *   · **`fetch` is injected, not imported.** Tests drive the client with a fake fetch; a
 *     Workers bundle supplies the platform's own. Nothing here reads `globalThis` at
 *     module scope, so the entrypoint stays portable.
 *   · **Neither body is trusted.** Request bodies are validated before the first byte
 *     leaves the process — a local bug throws `TsirError` — and response bodies are
 *     validated before the caller sees them; a remote mismatch is a `protocol` failure,
 *     because it is the other side's bug, not ours.
 *   · **Responses are read with a byte budget.** `await response.text()` on a hostile
 *     upstream is how a claimed 4 MiB becomes a 4 GiB heap: the stream is read chunk by
 *     chunk and abandoned the moment the budget is exceeded (`14-security.md`).
 */

import { createCircuitBreaker, type CircuitBreaker } from './breaker.ts';
import { resolveCredential, type ServiceCredentialProvider } from './credentials.ts';
import { preflight, withTimeout } from './deadline.ts';
import {
  assertHttpsUrl,
  callError,
  invalidLinkConfig,
  kindForHttpStatus,
  parseRetryAfter,
  retryableKind,
  schemaViolation,
  urlNotAllowed,
} from './errors.ts';
import { decideRetry, NO_RETRY, type RetryPolicy } from './retry.ts';
import { outboundHeaders } from './trace.ts';
import {
  fail,
  ok,
  type CallContext,
  type CallError,
  type CallMeta,
  type CallResult,
  type ServiceCredential,
} from './types.ts';

/** Zod-shaped and `@tsir/validate`-shaped: anything with a `parse`. */
export interface Schema<T> {
  parse(input: unknown): T;
}

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

export interface RestCallOptions<TResponse> {
  readonly method: HttpMethod;
  /** Path relative to `baseUrl`. Absolute URLs are refused: a base URL is config. */
  readonly path: string;
  readonly ctx: CallContext;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>> | undefined;
  /** Validated before anything is sent. A failure here is a `TsirError`, not a call failure. */
  readonly body?: unknown;
  readonly bodySchema?: Schema<unknown> | undefined;
  readonly response?: Schema<TResponse> | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Makes an unsafe method retryable, and travels as `Idempotency-Key`. */
  readonly idempotencyKey?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly responseType?: 'json' | 'text' | 'none' | undefined;
}

export interface RestClientOptions {
  readonly baseUrl: string;
  readonly defaultHeaders?: Readonly<Record<string, string>> | undefined;
  readonly retry?: RetryPolicy | undefined;
  readonly timeoutMs?: number | undefined;
  /** Hard cap on a response body. 8 MiB per `14-security.md`. */
  readonly maxResponseBytes?: number | undefined;
  readonly breaker?:
    { readonly threshold?: number; readonly cooldownMs?: number } | false | undefined;
  readonly credentials?: ServiceCredentialProvider | undefined;
  /**
   * Hosts this client may talk to. When omitted, the base URL's own host is the
   * allowlist; when present, a base URL outside it is a startup error.
   */
  readonly allowedHosts?: readonly string[] | undefined;
  /** Observability hook: one event per call — `link_calls_total` and the client span. */
  readonly onCall?: ((event: CallEvent) => void) | undefined;
  /** Test seams. Production code passes nothing. */
  readonly deps?: Partial<RestClientDeps> | undefined;
}

export interface RestClientDeps {
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
  readonly now: () => number;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly random: () => number;
}

/** The metric's label set, plus the fields a span needs. */
export interface CallEvent {
  readonly protocol: 'rest';
  readonly target: string;
  readonly kind: string;
  readonly status: number | undefined;
  readonly attempts: number;
  readonly elapsedMs: number;
  readonly traceId: string;
  readonly credentialId: string | undefined;
}

export interface RestClient {
  readonly baseUrl: string;
  readonly target: string;
  call<TResponse = unknown>(options: RestCallOptions<TResponse>): Promise<CallResult<TResponse>>;
  /** Breaker state, for health endpoints and tests. */
  readonly breaker: { state(): string };
}

const SAFE_METHODS: ReadonlySet<HttpMethod> = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export function createRestClient(options: RestClientOptions): RestClient {
  const baseUrl = parseBaseUrl(options.baseUrl);
  assertHostAllowed(baseUrl, options.allowedHosts);

  const retryPolicy = normalizeRetry(options.retry);
  const defaultTimeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_BYTES;
  const deps = resolveDeps(options.deps);

  const breaker: CircuitBreaker | undefined =
    options.breaker === false
      ? undefined
      : createCircuitBreaker({
          ...(options.breaker?.threshold === undefined
            ? {}
            : { threshold: options.breaker.threshold }),
          ...(options.breaker?.cooldownMs === undefined
            ? {}
            : { cooldownMs: options.breaker.cooldownMs }),
          now: deps.now,
        });

  const target = `${baseUrl.origin}${baseUrl.pathname === '/' ? '' : baseUrl.pathname.replace(/\/$/, '')}`;

  return {
    baseUrl: baseUrl.href,
    target,
    breaker: { state: () => breaker?.state() ?? 'closed' },

    async call<TResponse = unknown>(
      call: RestCallOptions<TResponse>,
    ): Promise<CallResult<TResponse>> {
      const url = buildUrl(baseUrl, call);
      // Local validation happens before anything else: a bad payload is our bug, so it
      // throws instead of becoming a "remote" failure the caller might retry.
      const payload = serializeBody(call);
      const idempotencyKey = call.idempotencyKey ?? call.ctx.idempotencyKey;
      const idempotent = SAFE_METHODS.has(call.method) || idempotencyKey !== undefined;
      const startedAt = deps.now();
      const meta = (extra: Partial<CallMeta> = {}): CallMeta => ({
        protocol: 'rest',
        target,
        attempts: 1,
        elapsedMs: deps.now() - startedAt,
        ...extra,
      });

      const early = preflight(call.ctx, deps.now());
      if (early !== undefined) return settle(fail<TResponse>(early, meta()), call, options);

      // Fail fast while the target is known-bad; after the cooldown exactly one probe
      // is let through, and its outcome decides whether the circuit closes.
      if (breaker !== undefined && !breaker.allow()) {
        return settle(fail<TResponse>(breaker.openError(target), meta()), call, options);
      }

      const credential = await resolveCredential(options.credentials, call.ctx, url);
      const scoped = withTimeout(call.ctx, call.timeoutMs ?? defaultTimeoutMs, deps.now());

      try {
        let result: CallResult<TResponse> | undefined;

        for (let attempt = 1; attempt <= retryPolicy.attempts; attempt += 1) {
          // A deadline that passed while backing off is a timeout, not another attempt.
          const expired = preflight(scoped.ctx, deps.now());
          if (expired !== undefined) {
            result = fail<TResponse>(expired, meta({ attempts: Math.max(1, attempt - 1) }));
            break;
          }

          const response = await exchange<TResponse>({
            call,
            target,
            url,
            payload,
            idempotencyKey,
            credential,
            signal: scoped.ctx,
            maxBytes,
            deps,
          });
          result = { ...response, meta: { ...response.meta, attempts: attempt } };

          if (result.ok || attempt === retryPolicy.attempts) break;

          const decision = decideRetry({
            policy: retryPolicy,
            attempt,
            error: result.error,
            idempotent,
            elapsedMs: deps.now() - startedAt,
            random: deps.random,
          });
          if (!decision.retry) break;

          await deps.sleep(decision.delayMs, scoped.ctx.signal);
        }

        const settled = result ?? fail<TResponse>(callError('unknown', 'LNK_UNKNOWN'), meta());

        if (settled.ok) breaker?.onSuccess();
        else if (retryableKind(settled.error.kind)) breaker?.onFailure();

        return settle(
          { ...settled, meta: { ...settled.meta, elapsedMs: deps.now() - startedAt } },
          call,
          options,
        );
      } finally {
        scoped.dispose();
      }
    },
  };
}

interface ExchangeInput<TResponse> {
  readonly call: RestCallOptions<TResponse>;
  readonly target: string;
  readonly url: string;
  readonly payload: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly credential: ServiceCredential | undefined;
  readonly signal: CallContext;
  readonly maxBytes: number;
  readonly deps: RestClientDeps;
}

/** One round trip. Retries call this again; nothing here is stateful. */
async function exchange<TResponse>(
  input: ExchangeInput<TResponse>,
): Promise<CallResult<TResponse>> {
  const { call, deps } = input;
  const startedAt = deps.now();
  const meta = (status?: number): CallMeta => ({
    protocol: 'rest',
    target: input.target,
    attempts: 1,
    elapsedMs: deps.now() - startedAt,
    ...(status === undefined ? {} : { status }),
    ...(input.credential === undefined ? {} : { credentialId: input.credential.id }),
  });

  const headers: Record<string, string> = {
    ...(call.headers ?? {}),
    ...(input.payload === undefined ? {} : { 'content-type': 'application/json' }),
    ...(input.idempotencyKey === undefined ? {} : { 'idempotency-key': input.idempotencyKey }),
    ...(input.credential?.headers ?? {}),
  };
  // Trace headers are applied last: a caller-supplied `traceparent` must not win over
  // the one this call is actually part of.
  const outbound = outboundHeaders(input.signal, { extra: headers }).headers;

  let response: Response;
  try {
    response = await deps.fetch(input.url, {
      method: call.method,
      headers: outbound,
      ...(input.payload === undefined ? {} : { body: input.payload }),
      signal: input.signal.signal,
      // Redirects are followed by nobody: a 3xx from an internal service is a
      // misconfiguration, and auto-following would leak credentials to the target.
      redirect: 'manual',
    });
  } catch (error) {
    const reason = preflight(input.signal, deps.now());
    if (reason !== undefined) return fail<TResponse>(reason, meta());
    return fail<TResponse>(
      callError('unavailable', 'LNK_NETWORK', {
        retryable: true,
        cause: error,
        message: `the request to ${input.url} never completed`,
      }),
      meta(),
    );
  }

  if (!response.ok)
    return fail<TResponse>(httpFailure(response, deps.now()), meta(response.status));

  return readBody<TResponse>(response, input, meta(response.status));
}

function httpFailure(response: Response, now: number): CallError {
  const status = response.status;
  const kind = kindForHttpStatus(status);
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), now);

  return callError(kind, `HTTP_${String(status)}`, {
    retryable: retryableKind(kind),
    message: `upstream returned ${String(status)}${response.statusText === '' ? '' : ` ${response.statusText}`}`,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

async function readBody<TResponse>(
  response: Response,
  input: ExchangeInput<TResponse>,
  meta: CallMeta,
): Promise<CallResult<TResponse>> {
  const responseType = input.call.responseType ?? 'json';

  if (responseType === 'none') {
    // Drain without buffering: the connection stays reusable and nothing is parsed.
    await response.body?.cancel().catch(() => undefined);
    return ok(undefined as TResponse, meta);
  }

  if (responseType === 'json' && !isJson(response.headers.get('content-type'))) {
    await response.body?.cancel().catch(() => undefined);
    return fail<TResponse>(
      callError('protocol', 'LNK_CONTENT_TYPE', {
        retryable: false,
        message: `expected a JSON response, got "${response.headers.get('content-type') ?? 'none'}"`,
      }),
      meta,
    );
  }

  // A declared length is cheap to check and saves reading a body we will reject anyway.
  const declaredBytes = parseByteCount(response.headers.get('content-length'));
  if (declaredBytes !== undefined && declaredBytes > input.maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return fail<TResponse>(tooLarge(input.maxBytes, declaredBytes), meta);
  }

  const read = await readLimited(response.body, input.maxBytes);
  if (!read.ok) return fail<TResponse>(tooLarge(input.maxBytes, read.bytes), meta);

  if (responseType === 'text') return ok(read.text as TResponse, meta);

  let parsed: unknown;
  try {
    parsed = read.text.trim() === '' ? undefined : (JSON.parse(read.text) as unknown);
  } catch (error) {
    return fail<TResponse>(
      callError('protocol', 'LNK_INVALID_JSON', {
        retryable: false,
        cause: error,
        message: 'the response body is not valid JSON',
      }),
      meta,
    );
  }

  if (input.call.response === undefined) return ok(parsed as TResponse, meta);

  try {
    return ok(input.call.response.parse(parsed), meta);
  } catch (error) {
    return fail<TResponse>(
      callError('protocol', 'LNK_SCHEMA', {
        retryable: false,
        cause: error,
        message: 'the response did not match the declared schema',
      }),
      meta,
    );
  }
}

function tooLarge(limit: number, actual: number): CallError {
  return callError('protocol', 'LNK_BODY_TOO_LARGE', {
    retryable: false,
    message: `the response body exceeds the ${String(limit)}-byte limit (${String(actual)} bytes)`,
  });
}

/** Reads at most `maxBytes`, abandoning the stream instead of buffering past the cap. */
async function readLimited(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ ok: true; text: string; bytes: number } | { ok: false; bytes: number }> {
  if (body === null) return { ok: true, text: '', bytes: 0 };

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, bytes };
      }
      text += decoder.decode(value, { stream: true });
    }
    return { ok: true, text: text + decoder.decode(), bytes };
  } finally {
    reader.releaseLock();
  }
}

/** `Content-Length` per RFC 9110 is decimal digits; anything else is treated as absent. */
function parseByteCount(header: string | null): number | undefined {
  if (header === null || !/^\d{1,15}$/.test(header.trim())) return undefined;
  // coercion-ok: the pattern above proves `header` is decimal digits.
  const bytes = Number.parseInt(header, 10);

  return Number.isFinite(bytes) ? bytes : undefined;
}

function isJson(contentType: string | null): boolean {
  if (contentType === null) return false;
  const media = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  return media === 'application/json' || media.endsWith('+json');
}

function serializeBody(call: RestCallOptions<unknown>): string | undefined {
  if (call.body === undefined) return undefined;

  let body: unknown = call.body;
  if (call.bodySchema !== undefined) {
    // A payload that fails its own schema is our bug, not the network's: it becomes a
    // `TsirError` (`LNK_SCHEMA`) and never leaves the process.
    try {
      body = call.bodySchema.parse(call.body);
    } catch (error) {
      throw schemaViolation(
        `the request body for ${call.method} ${call.path}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return typeof body === 'string' ? body : JSON.stringify(body);
}

function buildUrl(baseUrl: URL, call: RestCallOptions<unknown>): string {
  const path = call.path;
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw invalidLinkConfig(
      `path must be relative to baseUrl and start with a single "/" (got "${path}")`,
    );
  }

  const url = new URL(baseUrl.href);
  url.pathname = `${baseUrl.pathname.replace(/\/$/, '')}${path}`;
  for (const [key, value] of Object.entries(call.query ?? {})) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  return url.href;
}

function parseBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidLinkConfig(`baseUrl "${raw}" is not an absolute URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalidLinkConfig(`baseUrl "${raw}" must use http or https`);
  }
  return url;
}

function assertHostAllowed(baseUrl: URL, allowedHosts: readonly string[] | undefined): void {
  // TLS verification is on by default, so plain http is a downgrade worth catching at
  // boot rather than in an incident review (`14-security.md`).
  assertHttpsUrl(baseUrl, 'baseUrl');
  if (allowedHosts !== undefined && !allowedHosts.includes(baseUrl.host)) {
    throw urlNotAllowed(baseUrl.href, allowedHosts);
  }
}

function normalizeRetry(retry: RetryPolicy | undefined): RetryPolicy {
  if (retry === undefined) return NO_RETRY;
  if (retry.attempts < 1) throw invalidLinkConfig('retry.attempts must be at least 1');
  if (retry.backoffMs !== undefined && retry.backoffMs < 0) {
    throw invalidLinkConfig('retry.backoffMs must not be negative');
  }
  return retry;
}

function resolveDeps(overrides: Partial<RestClientDeps> | undefined): RestClientDeps {
  return {
    fetch: overrides?.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    now: overrides?.now ?? Date.now,
    sleep: overrides?.sleep ?? sleepWithSignal,
    random: overrides?.random ?? Math.random,
  };
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
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

/** Emits the call event, then returns the result unchanged. Sinks cannot fail a call. */
function settle<T>(
  result: CallResult<T>,
  call: RestCallOptions<T>,
  options: RestClientOptions,
): CallResult<T> {
  if (options.onCall !== undefined) {
    try {
      options.onCall({
        protocol: 'rest',
        target: result.meta.target,
        kind: result.ok ? 'ok' : result.error.kind,
        status: result.meta.status,
        attempts: result.meta.attempts,
        elapsedMs: result.meta.elapsedMs,
        traceId: call.ctx.traceId,
        credentialId: result.meta.credentialId,
      });
    } catch {
      // An observability sink must never break a call that already happened.
    }
  }
  return result;
}

export type { CallError, CallMeta, CallResult };
