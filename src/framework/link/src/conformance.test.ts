/**
 * Cross-protocol conformance (`Gate P5`).
 *
 * The heading this file defends is *"one `CallContext`, four protocols"*. That claim is
 * only worth anything if the same situation produces the same answer everywhere, so the
 * table below runs one scenario against REST, gRPC and SOAP and asserts the shared
 * contract rather than each adapter's private behaviour:
 *
 *   · a dead context makes **no** transport call, and says `cancelled`;
 *   · a retryable native failure and an unsafe call make **one** attempt;
 *   · the same failure with an idempotency claim makes **three**;
 *   · "the far end is unavailable" is `unavailable` and retryable in all three.
 *
 * WebSocket is absent on purpose: a socket is a session, not a call, and its failure
 * vocabulary (`LNK_WS_CLOSED`, close codes) is asserted in `ws.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { status as grpcStatus, Metadata, type Client, type ServiceError } from '@grpc/grpc-js';

import { OrderService } from './contracts/tsir/orders/v1/orders_pb.ts';
import { createGrpcClient } from './grpc.ts';
import { createRestClient } from './rest.ts';
import { createSoapClient } from './soap.ts';
import { createCallContext, type CallContext, type CallErrorKind } from './types.ts';

interface ProbeResult {
  readonly ok: boolean;
  readonly kind: CallErrorKind | undefined;
  readonly retryable: boolean | undefined;
  /** How many times the protocol touched its transport. */
  readonly attempts: number;
}

interface Probe {
  readonly name: string;
  /** A dead context: the call must not reach the transport. */
  readonly withDeadContext: () => Promise<ProbeResult>;
  /** The far end fails with its native "unavailable", given an idempotency claim. */
  readonly withIdempotency: () => Promise<ProbeResult>;
  /** The same failure without one. */
  readonly withoutIdempotency: () => Promise<ProbeResult>;
}

function context(signal?: AbortSignal): CallContext {
  return createCallContext({
    traceId: 'a'.repeat(32),
    correlationId: 'c-1',
    ...(signal === undefined ? {} : { signal }),
  });
}

const dead = (): CallContext => {
  const controller = new AbortController();
  controller.abort();
  return context(controller.signal);
};

const probe = (result: {
  ok: boolean;
  error?: { kind: CallErrorKind; retryable: boolean };
}): {
  ok: boolean;
  kind: CallErrorKind | undefined;
  retryable: boolean | undefined;
} => ({
  ok: result.ok,
  kind: result.error?.kind,
  retryable: result.error?.retryable,
});

const RETRY = { attempts: 3, backoffMs: 1 } as const;
const breaker = false;

const rest: Probe = {
  name: 'rest',
  async withDeadContext() {
    let calls = 0;
    const client = createRestClient({
      baseUrl: 'https://down.example.com',
      breaker,
      deps: {
        fetch: () => {
          calls += 1;
          return Promise.resolve(new Response('', { status: 503 }));
        },
        now: () => 0,
        sleep: () => Promise.resolve(),
        random: () => 0.5,
      },
    });
    const result = await client.call({ method: 'GET', path: '/x', ctx: dead() });
    return { ...probe(result), attempts: calls };
  },
  async withIdempotency() {
    let calls = 0;
    const client = createRestClient({
      baseUrl: 'https://down.example.com',
      retry: RETRY,
      breaker,
      deps: {
        fetch: () => {
          calls += 1;
          return Promise.resolve(new Response('', { status: 503 }));
        },
        now: () => 0,
        sleep: () => Promise.resolve(),
        random: () => 0.5,
      },
    });
    const result = await client.call({ method: 'GET', path: '/x', ctx: context() });
    return { ...probe(result), attempts: calls };
  },
  async withoutIdempotency() {
    let calls = 0;
    const client = createRestClient({
      baseUrl: 'https://down.example.com',
      retry: RETRY,
      breaker,
      deps: {
        fetch: () => {
          calls += 1;
          return Promise.resolve(new Response('', { status: 503 }));
        },
        now: () => 0,
        sleep: () => Promise.resolve(),
        random: () => 0.5,
      },
    });
    const result = await client.call({ method: 'POST', path: '/x', ctx: context(), body: {} });
    return { ...probe(result), attempts: calls };
  },
};

const soap: Probe = {
  name: 'soap',
  async withDeadContext() {
    let calls = 0;
    const client = createSoapClient({
      endpoint: 'https://down.example.com/soap',
      breaker,
      operations: { Ping: { operation: 'Ping' } },
      deps: {
        fetch: () => {
          calls += 1;
          return Promise.resolve(new Response('', { status: 503 }));
        },
        sleep: () => Promise.resolve(),
        now: () => 0,
        random: () => 0.5,
      },
    });
    const result = await client.call('Ping', {}, { ctx: dead() });
    return { ...probe(result), attempts: calls };
  },
  async withIdempotency() {
    let calls = 0;
    const client = createSoapClient({
      endpoint: 'https://down.example.com/soap',
      retry: RETRY,
      breaker,
      operations: { Ping: { operation: 'Ping' } },
      deps: {
        fetch: () => {
          calls += 1;
          return Promise.resolve(new Response('', { status: 503 }));
        },
        sleep: () => Promise.resolve(),
        now: () => 0,
        random: () => 0.5,
      },
    });
    const result = await client.call('Ping', {}, { ctx: context(), idempotent: true });
    return { ...probe(result), attempts: calls };
  },
  async withoutIdempotency() {
    let calls = 0;
    const client = createSoapClient({
      endpoint: 'https://down.example.com/soap',
      retry: RETRY,
      breaker,
      operations: { Ping: { operation: 'Ping' } },
      deps: {
        fetch: () => {
          calls += 1;
          return Promise.resolve(new Response('', { status: 503 }));
        },
        sleep: () => Promise.resolve(),
        now: () => 0,
        random: () => 0.5,
      },
    });
    const result = await client.call('Ping', {}, { ctx: context() });
    return { ...probe(result), attempts: calls };
  },
};

function grpcProbe(options: {
  readonly ctx: CallContext;
  readonly idempotent?: boolean;
  readonly method?: 'getOrder' | 'createOrder';
  readonly request: { id: string };
}): Promise<ProbeResult> {
  let calls = 0;
  const client = createGrpcClient({
    address: '127.0.0.1:59999',
    service: OrderService,
    ctx: options.ctx,
    retry: RETRY,
    breaker,
    deps: {
      // A channel that always answers UNAVAILABLE, without a socket: the point of the
      // test is the shared semantics, not the transport, which `grpc.test.ts` covers.
      makeClient: () =>
        ({
          makeUnaryRequest: (
            _path: string,
            _serialize: unknown,
            _deserialize: unknown,
            _payload: unknown,
            _metadata: unknown,
            _callOptions: unknown,
            callback: (error: ServiceError | null) => void,
          ) => {
            calls += 1;
            const error: ServiceError = Object.assign(new Error('down'), {
              code: grpcStatus.UNAVAILABLE,
              details: 'down',
              metadata: new Metadata(),
            });
            queueMicrotask(() => {
              callback(error);
            });
            return { cancel: () => undefined };
          },
          close: () => undefined,
        }) as unknown as Client,
      now: () => 0,
      sleep: () => Promise.resolve(),
      random: () => 0.5,
    },
  });

  return client
    .call(options.method ?? 'getOrder', options.request, {
      ...(options.idempotent === undefined ? {} : { idempotent: options.idempotent }),
    })
    .then((result) => ({ ...probe(result), attempts: calls }));
}

const grpc: Probe = {
  name: 'grpc',
  withDeadContext: () => grpcProbe({ ctx: dead(), request: { id: 'o-1' } }),
  withIdempotency: () => grpcProbe({ ctx: context(), request: { id: 'o-1' }, idempotent: true }),
  withoutIdempotency: () =>
    grpcProbe({ ctx: context(), method: 'createOrder', request: { id: 'o-1' } }),
};

const PROBES: readonly Probe[] = [rest, grpc, soap];

describe('cross-protocol conformance (Gate P5)', () => {
  test('a dead context makes no transport call, in every protocol', async () => {
    for (const probeUnderTest of PROBES) {
      const result = await probeUnderTest.withDeadContext();

      expect({ protocol: probeUnderTest.name, ok: result.ok }).toEqual({
        protocol: probeUnderTest.name,
        ok: false,
      });
      expect({ protocol: probeUnderTest.name, attempts: result.attempts }).toEqual({
        protocol: probeUnderTest.name,
        attempts: 0,
      });
      expect({ protocol: probeUnderTest.name, kind: result.kind }).toEqual({
        protocol: probeUnderTest.name,
        kind: 'cancelled',
      });
    }
  });

  test('an idempotent call spends the whole retry budget, in every protocol', async () => {
    for (const probeUnderTest of PROBES) {
      const result = await probeUnderTest.withIdempotency();

      expect({ protocol: probeUnderTest.name, attempts: result.attempts }).toEqual({
        protocol: probeUnderTest.name,
        attempts: 3,
      });
    }
  });

  test('without an idempotency claim, an unsafe call is attempted once, in every protocol', async () => {
    for (const probeUnderTest of PROBES) {
      const result = await probeUnderTest.withoutIdempotency();

      expect({ protocol: probeUnderTest.name, attempts: result.attempts }).toEqual({
        protocol: probeUnderTest.name,
        attempts: 1,
      });
    }
  });

  test('"the far end is unavailable" is the same kind everywhere, and retryable', async () => {
    for (const probeUnderTest of PROBES) {
      const result = await probeUnderTest.withIdempotency();

      expect({ protocol: probeUnderTest.name, kind: result.kind }).toEqual({
        protocol: probeUnderTest.name,
        kind: 'unavailable',
      });
      expect({ protocol: probeUnderTest.name, retryable: result.retryable }).toEqual({
        protocol: probeUnderTest.name,
        retryable: true,
      });
    }
  });
});
