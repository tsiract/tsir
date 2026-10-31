/**
 * gRPC (`LNK-012` … `LNK-015`), generated contracts plus `@grpc/grpc-js`.
 *
 * Three rules shape this file:
 *
 *   · **No runtime reflection and no `.proto` parsing.** The service description is
 *     produced by `buf generate` at build time (`src/contracts/**`, committed) and
 *     consumed here as data. A production pod never reads a descriptor file, and a
 *     compromised registry cannot change the wire shape under us.
 *   · **The generated descriptor drives both sides.** `serviceDefinitionFrom()` maps
 *     `methodKind`, input and output descriptors onto the `@grpc/grpc-js` service shape,
 *     so the client and the server cannot disagree about a message type.
 *   · **Failures are values.** A gRPC status becomes a `CallErrorKind` through the same
 *     table REST and WebSocket use; only a bad *local* configuration throws.
 *
 * This module imports `@grpc/grpc-js`, which is CommonJS and needs Node's `http2`. It is
 * scoped to `@tsir/link/grpc` (ADR-0022): the root entrypoint and every other adapter stay
 * free of it, and `grpcSupported()` refuses to run where the transport cannot.
 */

import * as grpc from '@grpc/grpc-js';
import {
  create,
  fromBinary,
  toBinary,
  type DescMessage,
  type MessageInitShape,
  type MessageShape,
} from '@bufbuild/protobuf';

import { createCircuitBreaker, type CircuitBreaker } from './breaker.ts';
import { resolveCredential, type ServiceCredentialProvider } from './credentials.ts';
import { preflight } from './deadline.ts';
import {
  callError,
  codeForKind,
  invalidLinkConfig,
  kindForGrpcStatus,
  parseRetryAfter,
  retryableKind,
} from './errors.ts';
import { decideRetry, NO_RETRY, type RetryPolicy } from './retry.ts';
import { CORRELATION_HEADER, TRACEPARENT_HEADER, formatTraceparent } from './trace.ts';
import {
  fail,
  ok,
  randomSpanId,
  type CallContext,
  type CallError,
  type CallMeta,
  type CallResult,
} from './types.ts';
import { TsirError } from '@tsir/core';

/* ── generated-contract shapes ───────────────────────────────────────────────────── */

/**
 * The subset of a `protoc-gen-es` method descriptor this adapter relies on.
 *
 * Structural on purpose: the generated file is data, and pinning its exact generic
 * signature here would break on a generator minor version for no benefit.
 */
export interface GrpcMethodLike {
  readonly name: string;
  readonly localName: string;
  readonly methodKind: 'unary' | 'server_streaming' | 'client_streaming' | 'bidi_streaming';
  readonly input: DescMessage;
  readonly output: DescMessage;
}

export interface GrpcServiceShape<Methods extends Record<string, GrpcMethodLike>> {
  readonly typeName: string;
  readonly method: Methods;
}

export type GrpcRequest<M extends GrpcMethodLike> = MessageInitShape<M['input']>;
export type GrpcResponse<M extends GrpcMethodLike> = MessageShape<M['output']>;

/** `/tsir.orders.v1.OrderService/GetOrder` — the only path format gRPC has. */
export function grpcPath(
  service: { readonly typeName: string },
  method: { readonly name: string },
): string {
  return `/${service.typeName}/${method.name}`;
}

/** `@grpc/grpc-js` needs serialize/deserialize pairs; the descriptor supplies both. */
export function serviceDefinitionFrom<Methods extends Record<string, GrpcMethodLike>>(
  service: GrpcServiceShape<Methods>,
): grpc.ServiceDefinition {
  const definition: Record<string, unknown> = {};

  for (const method of Object.values<GrpcMethodLike>(service.method)) {
    definition[method.name] = {
      path: grpcPath(service, method),
      requestStream:
        method.methodKind === 'client_streaming' || method.methodKind === 'bidi_streaming',
      responseStream:
        method.methodKind === 'server_streaming' || method.methodKind === 'bidi_streaming',
      requestSerialize: (value: unknown): Buffer =>
        Buffer.from(toBinary(method.input, value as never)),
      requestDeserialize: (bytes: Buffer): unknown => fromBinary(method.input, bytes),
      responseSerialize: (value: unknown): Buffer =>
        Buffer.from(toBinary(method.output, value as never)),
      responseDeserialize: (bytes: Buffer): unknown => fromBinary(method.output, bytes),
    };
  }

  return definition as unknown as grpc.ServiceDefinition;
}

/* ── capability (LNK-015) ────────────────────────────────────────────────────────── */

/**
 * gRPC is the one protocol in this package that needs a TCP stack.
 *
 * Workers has no `http2`, so `@grpc/grpc-js` cannot work there — and faking it would be
 * the "silent fallback" that is forbidden. This refuses at construction with the matrix
 * row an operator needs, instead of failing inside the transport on the first call.
 */
export function grpcSupported(environment: unknown = globalThis): boolean {
  const proc = (environment as { process?: { versions?: { node?: string } } }).process;

  return proc?.versions?.node !== undefined;
}

export function assertGrpcSupported(environment: unknown = globalThis): void {
  if (grpcSupported(environment)) return;

  throw new TsirError(
    'LNK_GRPC_UNAVAILABLE',
    'gRPC needs Node’s http2 transport, which this runtime does not provide',
    {
      kind: 'link',
      hint: 'Workers uses @tsir/link/rest or waits for the Connect story (Q19); gRPC runs on Bun, Node and Lambda',
      context: { protocol: 'grpc' },
    },
  );
}

/* ── client ──────────────────────────────────────────────────────────────────────── */

export interface GrpcTls {
  /** PEM root CA. When present, the channel is TLS with that CA. */
  readonly ca?: string | undefined;
  /** PEM client certificate/key pair — mutual TLS with the service. */
  readonly cert?: string | undefined;
  readonly key?: string | undefined;
  /** Escape hatch for a sidecar on loopback. Refused for a non-loopback address. */
  readonly insecure?: boolean | undefined;
}

export interface GrpcClientOptions<Methods extends Record<string, GrpcMethodLike>> {
  /** `host:port`. There is no URL scheme: gRPC addresses are not URLs. */
  readonly address: string;
  readonly service: GrpcServiceShape<Methods>;
  readonly ctx: CallContext;
  readonly tls?: GrpcTls | undefined;
  readonly credentials?: ServiceCredentialProvider | undefined;
  readonly retry?: RetryPolicy | undefined;
  /** Per-call timeout, applied when the context has no deadline of its own. */
  readonly timeoutMs?: number | undefined;
  readonly breaker?:
    { readonly threshold?: number; readonly cooldownMs?: number } | false | undefined;
  readonly onCall?: ((event: GrpcCallEvent) => void) | undefined;
  readonly deps?: Partial<GrpcClientDeps> | undefined;
}

export interface GrpcClientDeps {
  readonly makeClient: (
    address: string,
    credentials: grpc.ChannelCredentials,
    options: grpc.ClientOptions,
  ) => grpc.Client;
  readonly now: () => number;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly random: () => number;
}

export interface GrpcCallEvent {
  readonly protocol: 'grpc';
  readonly target: string;
  readonly method: string;
  readonly kind: string;
  readonly status: number | undefined;
  readonly attempts: number;
  readonly elapsedMs: number;
  readonly traceId: string;
  readonly credentialId: string | undefined;
}

export interface GrpcCallOptions {
  readonly timeoutMs?: number | undefined;
  readonly metadata?: Readonly<Record<string, string>> | undefined;
  /**
   * Declares this RPC safe to repeat. gRPC has no safe-method concept, so the caller says
   * it — or supplies `ctx.idempotencyKey`, which is the stricter promise.
   */
  readonly idempotent?: boolean | undefined;
}

export interface GrpcServerStream<M extends GrpcMethodLike> extends AsyncIterable<GrpcResponse<M>> {
  /** Stops the stream; the server sees a CANCELLED status. */
  cancel(): void;
  /** Set when the stream ended badly; `undefined` after a clean end. */
  readonly failure: CallError | undefined;
}

export interface GrpcClient<Methods extends Record<string, GrpcMethodLike>> {
  readonly address: string;
  readonly service: GrpcServiceShape<Methods>;
  call<Name extends keyof Methods & string>(
    method: Name,
    request: GrpcRequest<Methods[Name]>,
    options?: GrpcCallOptions,
  ): Promise<CallResult<GrpcResponse<Methods[Name]>>>;
  /** Server-streaming RPCs. Each item is a value: a mid-stream failure ends the stream. */
  serverStream<Name extends keyof Methods & string>(
    method: Name,
    request: GrpcRequest<Methods[Name]>,
    options?: GrpcCallOptions,
  ): GrpcServerStream<Methods[Name]>;
  close(): void;
}

export function createGrpcClient<Methods extends Record<string, GrpcMethodLike>>(
  options: GrpcClientOptions<Methods>,
): GrpcClient<Methods> {
  assertGrpcSupported();

  if (!options.address.includes(':')) {
    throw invalidLinkConfig(`gRPC address "${options.address}" must be host:port`);
  }

  const deps: GrpcClientDeps = {
    makeClient:
      options.deps?.makeClient ??
      ((address, credentials, clientOptions) =>
        new grpc.Client(address, credentials, clientOptions)),
    now: options.deps?.now ?? Date.now,
    sleep: options.deps?.sleep ?? sleepWithSignal,
    random: options.deps?.random ?? Math.random,
  };

  const retryPolicy = options.retry ?? NO_RETRY;
  const channelCredentials = channelCredentialsFor(options.address, options.tls);
  const client = deps.makeClient(options.address, channelCredentials, {
    'grpc.primary_user_agent': '@tsir/link',
  });

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

  const target = options.address;

  async function call<Name extends keyof Methods & string>(
    methodName: Name,
    request: GrpcRequest<Methods[Name]>,
    callOptions: GrpcCallOptions = {},
  ): Promise<CallResult<GrpcResponse<Methods[Name]>>> {
    const method = options.service.method[methodName];
    if (method === undefined) throw invalidLinkConfig(`unknown method "${methodName}"`);
    if (method.methodKind !== 'unary') {
      throw invalidLinkConfig(`"${methodName}" is ${method.methodKind}: use serverStream()`);
    }

    const startedAt = deps.now();
    const meta = (extra: Partial<CallMeta> = {}): CallMeta => ({
      protocol: 'grpc',
      target,
      attempts: 1,
      elapsedMs: deps.now() - startedAt,
      ...extra,
    });

    const early = preflight(options.ctx, deps.now());
    if (early !== undefined) return settle(fail(early, meta()), methodName, meta(), options);

    if (breaker !== undefined && !breaker.allow()) {
      return settle(fail(breaker.openError(target), meta()), methodName, meta(), options);
    }

    const payload = create(method.input, request as never);
    const credential = await resolveCredential(options.credentials, options.ctx, target);
    const framed = metadataFor(options.ctx, credential, callOptions.metadata);

    let result: CallResult<GrpcResponse<Methods[Name]>> | undefined;

    for (let attempt = 1; attempt <= retryPolicy.attempts; attempt += 1) {
      const expired = preflight(options.ctx, deps.now());
      if (expired !== undefined) {
        result = fail(expired, meta({ attempts: Math.max(1, attempt - 1) }));
        break;
      }

      const response = await once(method, payload, framed, callOptions, meta);
      result = { ...response, meta: { ...response.meta, attempts: attempt } };
      if (result.ok || attempt === retryPolicy.attempts) break;

      // Only idempotent calls are retried, and only for kinds that can heal. A
      // mutating RPC needs `idempotencyKey` on the context to opt in.
      const decision = decideRetry({
        policy: retryPolicy,
        attempt,
        error: result.error,
        idempotent: callOptions.idempotent ?? options.ctx.idempotencyKey !== undefined,
        elapsedMs: deps.now() - startedAt,
        random: deps.random,
      });
      if (!decision.retry) break;

      await deps.sleep(decision.delayMs, options.ctx.signal);
      if (options.ctx.signal.aborted) {
        result = fail(
          preflight(options.ctx, deps.now()) ?? result.error,
          meta({ attempts: attempt }),
        );
        break;
      }
    }

    const settled =
      result ?? fail<GrpcResponse<Methods[Name]>>(callError('unknown', 'LNK_UNKNOWN'), meta());

    if (settled.ok) breaker?.onSuccess();
    else if (retryableKind(settled.error.kind)) breaker?.onFailure();

    return settle(settled, methodName, meta(), options);
  }

  async function once<Name extends keyof Methods & string>(
    method: GrpcMethodLike,
    payload: unknown,
    metadata: grpc.Metadata,
    callOptions: GrpcCallOptions,
    meta: (extra?: Partial<CallMeta>) => CallMeta,
  ): Promise<CallResult<GrpcResponse<Methods[Name]>>> {
    const deadline =
      options.ctx.deadline?.getTime() ??
      deps.now() + (callOptions.timeoutMs ?? options.timeoutMs ?? 10_000);

    return new Promise<CallResult<GrpcResponse<Methods[Name]>>>((resolve) => {
      // Declared before the request so a transport that answers synchronously (a fake,
      // or a channel that fails validation immediately) cannot hit the TDZ.
      const call: { pending?: grpc.ClientUnaryCall | undefined } = {};
      let finished = false;
      function onAbort(): void {
        call.pending?.cancel();
      }

      call.pending = client.makeUnaryRequest(
        grpcPath(options.service, method),
        (value: unknown) => Buffer.from(toBinary(method.input, value as never)),
        (bytes: Buffer) => fromBinary(method.output, bytes) as GrpcResponse<Methods[Name]>,
        payload,
        metadata,
        { deadline },
        (error: grpc.ServiceError | null, value?: GrpcResponse<Methods[Name]>) => {
          finished = true;
          options.ctx.signal.removeEventListener('abort', onAbort);
          if (error !== null) {
            resolve(fail(grpcErrorFrom(error), meta({ status: error.code })));
            return;
          }
          resolve(ok(value as GrpcResponse<Methods[Name]>, meta({ status: grpc.status.OK })));
        },
      );

      if (!finished) options.ctx.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  return {
    address: target,
    service: options.service,

    call,

    serverStream<Name extends keyof Methods & string>(
      methodName: Name,
      request: GrpcRequest<Methods[Name]>,
      callOptions: GrpcCallOptions = {},
    ): GrpcServerStream<Methods[Name]> {
      const method = options.service.method[methodName];
      if (method === undefined) throw invalidLinkConfig(`unknown method "${methodName}"`);
      if (method.methodKind !== 'server_streaming' && method.methodKind !== 'bidi_streaming') {
        throw invalidLinkConfig(`"${methodName}" is ${method.methodKind}: use call()`);
      }

      const deadline =
        options.ctx.deadline?.getTime() ??
        deps.now() + (callOptions.timeoutMs ?? options.timeoutMs ?? 60_000);
      const payload = create(method.input, request as never);

      const stream = client.makeServerStreamRequest(
        grpcPath(options.service, method),
        (value: unknown) => Buffer.from(toBinary(method.input, value as never)),
        (bytes: Buffer) => fromBinary(method.output, bytes) as GrpcResponse<Methods[Name]>,
        payload,
        callOptions.metadata === undefined
          ? new grpc.Metadata()
          : metadataFrom(callOptions.metadata),
        { deadline },
      );

      let failure: CallError | undefined;
      stream.on('error', (error: grpc.ServiceError) => {
        failure = grpcErrorFrom(error);
      });

      const iterator = async function* (): AsyncGenerator<GrpcResponse<Methods[Name]>, void, void> {
        try {
          for await (const item of stream) yield item as GrpcResponse<Methods[Name]>;
        } finally {
          // A failure recorded by the transport ends the iteration; the caller can read
          // `failure` through the stream object. Throwing here would break `for await`
          // for callers that only care about the values that did arrive.
        }
      };

      const handle: GrpcServerStream<Methods[Name]> = {
        [Symbol.asyncIterator]: iterator,
        cancel: () => {
          stream.cancel();
        },
        get failure(): CallError | undefined {
          return failure;
        },
      };

      return handle;
    },

    close(): void {
      client.close();
    },
  };
}

/* ── server ──────────────────────────────────────────────────────────────────────── */

export interface GrpcServerOptions<Methods extends Record<string, GrpcMethodLike>> {
  readonly service: GrpcServiceShape<Methods>;
  /** One entry per RPC name; missing handlers still get `UNIMPLEMENTED` from grpc-js. */
  readonly handlers: {
    readonly [Name in keyof Methods]?: (
      request: MessageShape<Methods[Name]['input']>,
      context: GrpcHandlerContext,
    ) =>
      | AsyncIterable<MessageInitShape<Methods[Name]['output']>>
      | Promise<
          | MessageInitShape<Methods[Name]['output']>
          | AsyncIterable<MessageInitShape<Methods[Name]['output']>>
        >
      | MessageInitShape<Methods[Name]['output']>;
  };
  /** Reject before the handler runs; `undefined` becomes `UNAUTHENTICATED`. */
  readonly authenticate?:
    | ((
        metadata: grpc.Metadata,
        path: string,
      ) => Promise<GrpcPrincipal | undefined> | GrpcPrincipal | undefined)
    | undefined;
  readonly onCall?: ((event: GrpcServerEvent) => void) | undefined;
  readonly now?: (() => number) | undefined;
}

export interface GrpcPrincipal {
  readonly id: string;
}

export interface GrpcHandlerContext {
  readonly metadata: grpc.Metadata;
  readonly principal: GrpcPrincipal | undefined;
  readonly deadline: Date | undefined;
  readonly peer: string;
}

export interface GrpcServerEvent {
  readonly protocol: 'grpc';
  readonly method: string;
  readonly status: number;
  readonly durationMs: number;
  readonly principalId: string | undefined;
}

/**
 * Wires generated contracts onto an existing `@grpc/grpc-js` server.
 *
 * The server is supplied, not created: its port, credentials and shutdown are the
 * application's business, exactly like `@tsir/http` mounting on a `Bun.serve` instance.
 */
export function attachGrpcServer<Methods extends Record<string, GrpcMethodLike>>(
  server: grpc.Server,
  options: GrpcServerOptions<Methods>,
): grpc.ServiceDefinition {
  assertGrpcSupported();

  const definition = serviceDefinitionFrom(options.service);
  const now = options.now ?? Date.now;

  const implementation: Record<
    string,
    grpc.handleUnaryCall<unknown, unknown> | grpc.handleServerStreamingCall<unknown, unknown>
  > = {};

  for (const [localName, method] of Object.entries(options.service.method)) {
    const handler = options.handlers[localName as keyof Methods];
    if (handler === undefined) continue;

    if (method.methodKind === 'server_streaming') {
      // A stream is answered by an iterable, so the handler's return type decides the
      // wiring — the descriptor already told us which shape the wire expects.
      implementation[method.name] = (call: grpc.ServerWritableStream<unknown, unknown>) => {
        const startedAt = now();
        const count = { written: 0 };

        void (async () => {
          const principal = await options.authenticate?.(
            call.metadata,
            grpcPath(options.service, method),
          );
          if (options.authenticate !== undefined && principal === undefined) {
            call.destroy(statusError(grpc.status.UNAUTHENTICATED, 'unauthenticated'));
            return;
          }

          try {
            const iterable = (await handler(call.request as never, {
              metadata: call.metadata,
              principal,
              deadline: toDeadline(call.getDeadline()),
              peer: call.getPeer(),
            })) as unknown as AsyncIterable<unknown>;

            for await (const item of iterable) {
              call.write(create(method.output, item as never));
              count.written += 1;
            }
            call.end();
            options.onCall?.({
              protocol: 'grpc',
              method: method.name,
              status: grpc.status.OK,
              durationMs: now() - startedAt,
              principalId: principal?.id,
            });
          } catch {
            call.destroy(statusError(grpc.status.INTERNAL, 'handler failed'));
            options.onCall?.({
              protocol: 'grpc',
              method: method.name,
              status: grpc.status.INTERNAL,
              durationMs: now() - startedAt,
              principalId: principal?.id,
            });
          }
        })();
      };
      continue;
    }

    if (method.methodKind !== 'unary') continue; // client/bidi streaming: not yet

    implementation[method.name] = (call, callback) => {
      const startedAt = now();
      const metadata = call.metadata;
      const path = grpcPath(options.service, method);

      void (async () => {
        const principal = await options.authenticate?.(metadata, path);
        if (options.authenticate !== undefined && principal === undefined) {
          finish(grpc.status.UNAUTHENTICATED, 'unauthenticated');
          callback({ code: grpc.status.UNAUTHENTICATED, message: 'unauthenticated' });
          return;
        }

        try {
          const reply = await handler(call.request as never, {
            metadata,
            principal,
            deadline: toDeadline(call.getDeadline()),
            peer: call.getPeer(),
          });
          finish(grpc.status.OK, 'ok', principal?.id);
          callback(null, create(method.output, reply as never));
        } catch (error) {
          // A handler that throws is an application bug on the far side of the wire:
          // report INTERNAL rather than leaking a stack trace into the status message.
          finish(grpc.status.INTERNAL, 'internal', principal?.id);
          callback({ code: grpc.status.INTERNAL, message: 'handler failed' });
          void error;
        }
      })();

      function finish(status: number, _label: string, principalId?: string): void {
        options.onCall?.({
          protocol: 'grpc',
          method: method.name,
          status,
          durationMs: now() - startedAt,
          principalId,
        });
      }
    };
  }

  server.addService(definition, implementation as never);
  return definition;
}

/* ── shared plumbing ────────────────────────────────────────────────────────────── */

function channelCredentialsFor(address: string, tls: GrpcTls | undefined): grpc.ChannelCredentials {
  if (tls === undefined || tls.insecure === true) {
    // Same rule as REST and WebSocket: plaintext is a loopback-only concession.
    const host = address.slice(0, address.lastIndexOf(':'));
    if (!isLoopback(host)) {
      throw invalidLinkConfig(
        `gRPC address "${address}" is not loopback — configure tls (ca/cert/key) instead of insecure`,
      );
    }
    return grpc.credentials.createInsecure();
  }

  if (tls.cert !== undefined && tls.key !== undefined) {
    return grpc.credentials.createSsl(
      tls.ca === undefined ? null : Buffer.from(tls.ca),
      Buffer.from(tls.key),
      Buffer.from(tls.cert),
    );
  }

  return grpc.credentials.createSsl(tls.ca === undefined ? null : Buffer.from(tls.ca));
}

function metadataFor(
  ctx: CallContext,
  credential:
    { readonly id: string; readonly headers: Readonly<Record<string, string>> } | undefined,
  extra: Readonly<Record<string, string>> | undefined,
): grpc.Metadata {
  const metadata = new grpc.Metadata();
  const spanId = randomSpanId();

  metadata.set(TRACEPARENT_HEADER, formatTraceparent({ traceId: ctx.traceId, spanId }));
  metadata.set(CORRELATION_HEADER, ctx.correlationId);

  for (const [name, value] of Object.entries({ ...(ctx.headers ?? {}), ...(extra ?? {}) })) {
    metadata.set(name.toLowerCase(), value);
  }
  for (const [name, value] of Object.entries(credential?.headers ?? {})) {
    metadata.set(name.toLowerCase(), value);
  }

  return metadata;
}

function metadataFrom(values: Readonly<Record<string, string>>): grpc.Metadata {
  const metadata = new grpc.Metadata();
  for (const [name, value] of Object.entries(values)) metadata.set(name.toLowerCase(), value);
  return metadata;
}

/** gRPC status → our kind, with the server's own `retry-after` hint respected. */
function grpcErrorFrom(error: grpc.ServiceError): CallError {
  const name = grpcStatusName(error.code);
  const kind = kindForGrpcStatus(name);
  const hint = error.metadata?.get('retry-after')[0];
  // Same parser the REST and SOAP clients use: this is one rule about one header, not three.
  const retryAfterMs = parseRetryAfter(hint === undefined ? undefined : String(hint));

  // One vocabulary across four protocols (§ 9): the code is the shared `LNK_*` name, and
  // the gRPC status stays in the message where an operator reading logs still sees it.
  return callError(kind, codeForKind(kind), {
    retryable: retryableKind(kind),
    cause: error,
    message: error.details === '' ? `gRPC ${name}` : `gRPC ${name}: ${error.details}`,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

/** `14` → `UNAVAILABLE`. Exported because logs read better with names. */
export function grpcStatusName(code: number): string {
  // coercion-ok: `grpc.status` is its own numeric enum; this maps a number back to a name and never parses input.
  const entry = Object.entries(grpc.status).find(([, value]) => Number(value) === code);
  return entry?.[0] ?? `STATUS_${String(code)}`;
}

function settle<T>(
  result: CallResult<T>,
  method: string,
  meta: CallMeta,
  options: GrpcClientOptions<Record<string, GrpcMethodLike>>,
): CallResult<T> {
  if (options.onCall !== undefined) {
    try {
      options.onCall({
        protocol: 'grpc',
        target: meta.target,
        method,
        kind: result.ok ? 'ok' : result.error.kind,
        status: meta.status,
        attempts: meta.attempts,
        elapsedMs: meta.elapsedMs,
        traceId: options.ctx.traceId,
        credentialId: meta.credentialId,
      });
    } catch {
      // A telemetry sink must never fail a call that already happened.
    }
  }
  return result;
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

/** grpc-js hands errors back to the wire, so a status has to ride on a real `Error`. */
function statusError(code: number, message: string): grpc.ServiceError {
  const error = new Error(message) as grpc.ServiceError;
  error.code = code;
  error.details = message;
  error.metadata = new grpc.Metadata();
  return error;
}

/** grpc-js exposes deadlines as `number | Date`; the handler contract is `Date`. */
function toDeadline(deadline: number | Date | undefined): Date | undefined {
  if (deadline === undefined) return undefined;
  return typeof deadline === 'number' ? new Date(deadline) : deadline;
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

export type { grpc };
