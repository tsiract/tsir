/**
 * WebSocket (`LNK-021` … `LNK-024`).
 *
 * Most of these tests never open a socket: the handler takes a `sink`, the client takes a
 * `connect` factory, and the fakes below record exactly what crossed the wire. The last
 * describe block does use a real `Bun.serve` socket, because "the default `connect` wires
 * a real `WebSocket`" is a claim a fake cannot prove.
 */

import { describe, expect, test } from 'bun:test';

import {
  createWsClient,
  defineWsHandler,
  handshakeExpired,
  wsCloseError,
  type WsHandshake,
  type WsPayloadSchema,
  type WsServerSession,
  type WsSocket,
} from './ws.ts';
import { createCallContext } from './types.ts';

interface OrderMessage {
  readonly type: 'subscribe' | 'unsubscribe';
  readonly channel: string;
}

const OrderSchema: WsPayloadSchema<OrderMessage> = {
  parse(input: unknown): OrderMessage {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const value = input as Record<string, unknown>;
    if (value['type'] !== 'subscribe' && value['type'] !== 'unsubscribe') {
      throw new Error('type must be subscribe or unsubscribe');
    }
    if (typeof value['channel'] !== 'string') throw new Error('channel must be a string');
    return { type: value['type'], channel: value['channel'] };
  },
};

function handshake(overrides: Partial<WsHandshake> = {}): WsHandshake {
  return { path: '/ws/orders', headers: {}, query: {}, ...overrides };
}

interface SinkHarness {
  readonly sent: string[];
  closed: { code: number; reason: string } | undefined;
  buffered: number;
}

function sinkHarness(): SinkHarness {
  return { sent: [], closed: undefined, buffered: 0 };
}

function sinkOf(harness: SinkHarness) {
  return {
    send: (text: string) => {
      harness.sent.push(text);
    },
    close: (code: number, reason: string) => {
      harness.closed = { code, reason };
    },
    bufferedAmount: () => harness.buffered,
  };
}

/** `receive()` is fire-and-forget by design; tests await the work it scheduled. */
async function receive(
  session: WsServerSession<OrderMessage> | undefined,
  data: string,
): Promise<void> {
  session?.receive(data);
  await Bun.sleep(0);
}

/** An `EventTarget` socket, for the client and for `attach()`. */
class FakeSocket implements WsSocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  closedWith: { code: number; reason: string } | undefined;
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code: code ?? 1000, reason: reason ?? '' };
    this.readyState = 3;
    this.emit('close', { code: this.closedWith.code, reason: this.closedWith.reason });
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }
}

describe('server: frame policy (LNK-021)', () => {
  test('a valid frame is validated, dispatched, and the reply is sent', async () => {
    const harness = sinkHarness();
    const seen: string[] = [];
    const handler = defineWsHandler<OrderMessage, OrderMessage>({
      path: '/ws/orders',
      schema: OrderSchema,
      onMessage: ({ message }) => {
        seen.push(message.channel);
        return { type: 'subscribe', channel: message.channel };
      },
    });

    const session = await handler.open(handshake(), sinkOf(harness));
    await receive(session, JSON.stringify({ type: 'subscribe', channel: 'orders' }));

    expect(seen).toEqual(['orders']);
    expect(harness.sent).toEqual([JSON.stringify({ type: 'subscribe', channel: 'orders' })]);
    expect(session?.state()).toBe('open');
  });

  test('invalid JSON closes 1008 and says so', async () => {
    const harness = sinkHarness();
    const handler = defineWsHandler<OrderMessage, OrderMessage>({
      path: '/ws/orders',
      onMessage: () => undefined,
    });

    const session = await handler.open(handshake(), sinkOf(harness));
    await receive(session, '{not json');

    expect(harness.closed).toEqual({ code: 1008, reason: 'invalid JSON' });
    expect(session?.state()).toBe('closed');
  });

  test('a frame the schema rejects closes 1008, and the error reaches onError', async () => {
    const harness = sinkHarness();
    const errors: unknown[] = [];
    const handler = defineWsHandler<OrderMessage, OrderMessage>({
      path: '/ws/orders',
      schema: OrderSchema,
      onMessage: () => undefined,
      onError: (error) => errors.push(error),
    });

    const session = await handler.open(handshake(), sinkOf(harness));
    await receive(session, JSON.stringify({ type: 'explode', channel: 'orders' }));

    expect(harness.closed).toEqual({ code: 1008, reason: 'frame failed schema validation' });
    expect(errors).toHaveLength(1);
  });

  test('an oversize frame closes 1009 — measured in bytes, not code units', async () => {
    const harness = sinkHarness();
    const handler = defineWsHandler<OrderMessage, OrderMessage>({
      path: '/ws/orders',
      maxFrameBytes: 64,
      onMessage: () => undefined,
    });

    const session = await handler.open(handshake(), sinkOf(harness));
    // 40 × 'é' is 40 code units but 80 UTF-8 bytes.
    await receive(session, 'é'.repeat(40));

    expect(harness.closed).toEqual({ code: 1009, reason: 'frame too large' });
  });

  test('a handler that throws closes 1011 instead of leaving a half-answered socket', async () => {
    const harness = sinkHarness();
    const errors: unknown[] = [];
    const handler = defineWsHandler<OrderMessage, OrderMessage>({
      path: '/ws/orders',
      schema: OrderSchema,
      onMessage: () => {
        throw new Error('database down');
      },
      onError: (error) => errors.push(error),
    });

    const session = await handler.open(handshake(), sinkOf(harness));
    await receive(session, JSON.stringify({ type: 'subscribe', channel: 'orders' }));

    expect(harness.closed).toEqual({ code: 1011, reason: 'handler failed' });
    expect((errors[0] as Error).message).toBe('database down');
  });

  test('a refused handshake never becomes a session', async () => {
    const harness = sinkHarness();
    const handler = defineWsHandler<OrderMessage, OrderMessage>({
      path: '/ws/orders',
      authenticate: () => undefined,
      onMessage: () => undefined,
    });

    const session = await handler.open(handshake(), sinkOf(harness));

    expect(session).toBeUndefined();
    expect(harness.closed).toEqual({ code: 1008, reason: 'unauthenticated' });
  });

  test('the principal and the inbound trace context reach the handler', async () => {
    const harness = sinkHarness();
    const trace = '4bf92f3577b34da6a3ce929d0e0e4736';
    let principalId = '';
    let traceId = '';

    const handler = defineWsHandler<OrderMessage, OrderMessage>({
      path: '/ws/orders',
      authenticate: (handshakeIn) => ({ id: String(handshakeIn.query['token'] ?? 'anonymous') }),
      onMessage: ({ principal, ctx }) => {
        principalId = principal?.id ?? '';
        traceId = ctx.traceId;
        return undefined;
      },
    });

    const session = await handler.open(
      handshake({
        query: { token: 'user-7' },
        headers: { traceparent: `00-${trace}-00f067aa0ba902b7-01` },
      }),
      sinkOf(harness),
    );
    await receive(session, JSON.stringify({ type: 'subscribe', channel: 'orders' }));

    expect(principalId).toBe('user-7');
    expect(traceId).toBe(trace);
  });
});

describe('server: backpressure, drain and idle (LNK-023, LNK-024)', () => {
  test('a peer over the buffer limit is closed with 1013, not buffered', async () => {
    const harness = sinkHarness();
    const handler = defineWsHandler<OrderMessage, OrderMessage>({
      path: '/ws/orders',
      maxBufferedBytes: 100,
      onMessage: () => undefined,
    });

    const session = await handler.open(handshake(), sinkOf(harness));
    harness.buffered = 101;

    const result = session?.send({ type: 'subscribe', channel: 'orders' });

    expect(result?.ok).toBe(false);
    if (result?.ok !== false) throw new Error('expected a failure');
    expect(result.error.code).toBe('LNK_WS_BACKPRESSURE');
    expect(result.error.retryable).toBe(true);
    expect(harness.closed).toEqual({ code: 1013, reason: 'backpressure' });
  });

  test('drain sends 1001 after the buffer empties, and later sends are values', async () => {
    const harness = sinkHarness();
    const handler = defineWsHandler<OrderMessage, OrderMessage>({
      path: '/ws/orders',
      onMessage: () => undefined,
    });

    const session = await handler.open(handshake(), sinkOf(harness));
    await session?.drain('deploying');

    expect(harness.closed).toEqual({ code: 1001, reason: 'deploying' });
    expect(session?.state()).toBe('closed');

    const late = session?.send({ type: 'subscribe', channel: 'orders' });
    expect(late?.ok).toBe(false);
  });

  test('an idle socket is closed with 1001, and activity keeps it alive (LNK-023)', async () => {
    const harness = sinkHarness();
    const handler = defineWsHandler<OrderMessage, OrderMessage>({
      path: '/ws/orders',
      idleTimeoutMs: 25,
      onMessage: () => undefined,
    });

    const idle = await handler.open(handshake(), sinkOf(harness));
    expect(idle?.state()).toBe('open');
    await Bun.sleep(60);
    expect(harness.closed).toEqual({ code: 1001, reason: 'idle timeout' });

    const harness2 = sinkHarness();
    const kept = await handler.open(handshake(), sinkOf(harness2));
    for (let index = 0; index < 5; index += 1) {
      await Bun.sleep(10);
      kept?.noteActivity();
    }
    expect(kept?.state()).toBe('open');
    expect(harness2.closed).toBeUndefined();
    kept?.close();
  });

  test('a transport close the session did not initiate still runs onClose once', async () => {
    const harness = sinkHarness();
    const closes: { code: number; reason: string }[] = [];
    const handler = defineWsHandler<OrderMessage, OrderMessage>({
      path: '/ws/orders',
      onMessage: () => undefined,
      onClose: (info) => closes.push(info),
    });

    const session = await handler.open(handshake(), sinkOf(harness));
    session?.ended(1006, 'transport gone');

    expect(closes).toEqual([{ code: 1006, reason: 'transport gone' }]);
    expect(session?.state()).toBe('closed');
  });
});

describe('client: lifecycle, no replay, reconnect (LNK-022)', () => {
  function clientWith(
    sockets: FakeSocket[],
    options: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    const slept: number[] = [];
    const states: string[] = [];
    const messages: unknown[] = [];
    const errors: unknown[] = [];
    let index = 0;

    const client = createWsClient<OrderMessage>({
      url: 'wss://orders.test/ws',
      ctx: createCallContext({ traceId: 'a'.repeat(32) }),
      reconnect: { attempts: options.attempts ?? 2, jitter: false },
      onMessage: (message) => messages.push(message),
      onState: (state) => states.push(state),
      onError: (error) => errors.push(error),
      deps: {
        connect: () => {
          const socket = sockets[Math.min(index, sockets.length - 1)];
          index += 1;
          if (socket === undefined) throw new Error('no scripted socket');
          return socket;
        },
        sleep: async (ms) => {
          slept.push(ms);
          await options.sleep?.(ms);
        },
        random: () => 0.5,
      },
    });

    return { client, slept, states, messages, errors, sockets };
  }

  test('sending before the socket opens fails instead of queueing', async () => {
    const socket = new FakeSocket();
    socket.readyState = 0;
    const { client } = clientWith([socket]);

    const result = client.send({ type: 'subscribe', channel: 'orders' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('LNK_WS_CLOSED');
    expect(socket.sent).toEqual([]);
  });

  test('an open socket sends JSON and delivers inbound messages', async () => {
    const socket = new FakeSocket();
    const { client, messages, errors } = clientWith([socket]);
    socket.open();

    expect(client.state()).toBe('open');
    expect(client.send({ type: 'subscribe', channel: 'orders' }).ok).toBe(true);
    expect(socket.sent).toEqual([JSON.stringify({ type: 'subscribe', channel: 'orders' })]);

    socket.emit('message', { data: JSON.stringify({ type: 'subscribe', channel: 'invoices' }) });
    expect(messages).toEqual([{ type: 'subscribe', channel: 'invoices' }]);
    expect(errors).toEqual([]);
  });

  test('a close reconnects with backoff, and nothing is replayed onto the new socket', async () => {
    const first = new FakeSocket();
    const second = new FakeSocket();
    const { client, slept, states } = clientWith([first, second]);

    first.open();
    client.send({ type: 'subscribe', channel: 'orders' });
    first.close(1013, 'backpressure');

    await Bun.sleep(5);
    second.open();

    expect(slept).toEqual([500]);
    expect(states).toContain('reconnecting');
    expect(client.state()).toBe('open');
    // At-most-once: the message sent before the outage is gone, not queued.
    expect(second.sent).toEqual([]);
  });

  test('reconnects stop at the policy and the final close is reported', async () => {
    const sockets = [new FakeSocket(), new FakeSocket(), new FakeSocket(), new FakeSocket()];
    const { client } = clientWith(sockets, { attempts: 2 });

    sockets[0]?.open();
    sockets[0]?.close(1011, 'server error');
    await Bun.sleep(10);
    sockets[1]?.close(1011, 'server error');
    await Bun.sleep(10);
    sockets[2]?.close(1011, 'server error');

    const final = await client.closed;
    expect(final).toEqual({ code: 1011, reason: 'server error' });
    expect(client.state()).toBe('closed');
    expect(client.send({ type: 'subscribe', channel: 'orders' }).ok).toBe(false);
  });

  test('a deliberate close never reconnects, whatever the code', async () => {
    const socket = new FakeSocket();
    const { client, slept } = clientWith([socket]);
    socket.open();

    client.close(1000, 'done');
    const info = await client.closed;

    expect(info).toEqual({ code: 1000, reason: 'done' });
    expect(slept).toEqual([]);
    expect(client.state()).toBe('closed');
  });

  test('1001 from the server is respected: draining is not a failure to retry', async () => {
    const socket = new FakeSocket();
    const { client, slept } = clientWith([socket]);
    socket.open();

    socket.close(1001, 'server shutting down');

    expect(await client.closed).toEqual({ code: 1001, reason: 'server shutting down' });
    expect(slept).toEqual([]);
  });
});

describe('socket failures map to CallError kinds (LNK-008)', () => {
  test('close codes become retryable or terminal, and never hide the code', () => {
    expect(wsCloseError({ code: 1013, reason: 'backpressure' }, 'wss://x')).toMatchObject({
      kind: 'unavailable',
      code: 'WS_1013',
      retryable: true,
    });
    expect(wsCloseError({ code: 1008, reason: 'bad frame' }, 'wss://x')).toMatchObject({
      kind: 'protocol',
      retryable: false,
    });
    expect(wsCloseError({ code: 4401, reason: 'token expired' }, 'wss://x')).toMatchObject({
      kind: 'unauthenticated',
      code: 'WS_4401',
    });
    expect(wsCloseError({ code: 1000, reason: '' }, 'wss://x')).toMatchObject({
      kind: 'unknown',
      code: 'WS_1000',
      message: 'wss://x closed with 1000 (no reason)',
    });
  });

  test('insecure and mistyped URLs are refused at construction', () => {
    const base = { ctx: createCallContext({}) };

    expect(() => createWsClient({ ...base, url: 'wss://orders.test' })).not.toThrow();
    expect(() => createWsClient({ ...base, url: 'ws://localhost:8080/ws' })).not.toThrow();
    expect(() => createWsClient({ ...base, url: 'ws://orders.test/ws' })).toThrow(/use wss/);
    expect(() => createWsClient({ ...base, url: 'https://orders.test/ws' })).toThrow(/ws or wss/);
    expect(() => createWsClient({ ...base, url: 'nope' })).toThrow(/not an absolute URL/);
    expect(() =>
      createWsClient({ ...base, url: 'wss://orders.test/ws', allowedHosts: ['other.test'] }),
    ).toThrow(/allowlist/);
  });
});

describe('a real socket (integration)', () => {
  test('Bun.serve → handler session → client, with the default WebSocket connect', async () => {
    const received: OrderMessage[] = [];
    const handler = defineWsHandler<OrderMessage, OrderMessage>({
      path: '/ws/orders',
      schema: OrderSchema,
      onMessage: ({ message }) => {
        received.push(message);
        return { type: 'subscribe', channel: `${message.channel}:ack` };
      },
    });

    interface SocketData {
      session?: WsServerSession<OrderMessage> | undefined;
    }

    const server = Bun.serve<SocketData>({
      port: 0,
      fetch(request, server_) {
        // Bun server sockets are callback based: the transport drives the session.
        const upgraded = server_.upgrade(request, { data: {} });
        return upgraded ? undefined : new Response('upgrade failed', { status: 400 });
      },
      websocket: {
        async open(ws) {
          ws.data.session = await handler.open(
            { path: '/ws/orders', headers: {}, query: {} },
            {
              send: (text) => ws.send(text),
              close: (code, reason) => ws.close(code, reason),
              bufferedAmount: () => ws.getBufferedAmount(),
            },
          );
        },
        message(ws, raw) {
          if (typeof raw === 'string') ws.data.session?.receive(raw);
        },
      },
    });

    const messages: OrderMessage[] = [];
    const client = createWsClient<OrderMessage, OrderMessage>({
      url: `ws://localhost:${String(server.port)}/ws/orders`,
      ctx: createCallContext({}),
      schema: OrderSchema,
      reconnect: false,
      onMessage: (message) => messages.push(message),
    });

    // Wait for the state, not for a guessed number of milliseconds.
    for (let waited = 0; client.state() !== 'open' && waited < 2_000; waited += 10) {
      await Bun.sleep(10);
    }
    expect(client.state()).toBe('open');

    expect(client.send({ type: 'subscribe', channel: 'orders' }).ok).toBe(true);
    for (let waited = 0; messages.length === 0 && waited < 2_000; waited += 10) {
      await Bun.sleep(10);
    }

    expect(received).toEqual([{ type: 'subscribe', channel: 'orders' }]);
    expect(messages).toEqual([{ type: 'subscribe', channel: 'orders:ack' }]);

    client.close(1000, 'done');
    await client.closed;
    await server.stop(true);
  });
});

describe('edges: attach, unserialisable sends, heartbeat, client failures', () => {
  test('attach() wires an EventTarget socket: frames in, replies out, closes reported', async () => {
    const closes: { code: number; reason: string }[] = [];
    const handler = defineWsHandler<OrderMessage, OrderMessage>({
      path: '/ws/orders',
      schema: OrderSchema,
      onMessage: ({ message }) => ({ type: 'subscribe', channel: message.channel }),
      onClose: (info) => closes.push(info),
    });

    const socket = new FakeSocket();
    const session = await handler.attach(socket, handshake());
    expect(session).toBeDefined();

    socket.emit('message', { data: JSON.stringify({ type: 'subscribe', channel: 'orders' }) });
    await Bun.sleep(0);
    expect(socket.sent).toEqual([JSON.stringify({ type: 'subscribe', channel: 'orders' })]);

    socket.close(1000, 'bye');
    expect(closes).toEqual([{ code: 1000, reason: 'bye' }]);
  });

  test('attach() refuses the handshake on the socket itself', async () => {
    const handler = defineWsHandler<OrderMessage, OrderMessage>({
      path: '/ws/orders',
      authenticate: () => undefined,
      onMessage: () => undefined,
    });

    const socket = new FakeSocket();
    const session = await handler.attach(socket, handshake());

    expect(session).toBeUndefined();
    expect(socket.closedWith).toEqual({ code: 1008, reason: 'unauthenticated' });
  });

  test('a handshake that throws closes 1011 and reports the error', async () => {
    const errors: unknown[] = [];
    const harness = sinkHarness();
    const handler = defineWsHandler<OrderMessage, OrderMessage>({
      path: '/ws/orders',
      authenticate: () => {
        throw new Error('auth service down');
      },
      onMessage: () => undefined,
      onError: (error) => errors.push(error),
    });

    const session = await handler.open(handshake(), sinkOf(harness));

    expect(session).toBeUndefined();
    expect(harness.closed).toEqual({ code: 1011, reason: 'handshake failed' });
    expect((errors[0] as Error).message).toBe('auth service down');
  });

  test('a value that cannot be serialised is a CallError, not a crash', async () => {
    const harness = sinkHarness();
    const handler = defineWsHandler<OrderMessage, Record<string, unknown>>({
      path: '/ws/orders',
      onMessage: () => undefined,
    });

    const session = await handler.open(handshake(), sinkOf(harness));
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    const result = session?.send(circular);

    expect(result?.ok).toBe(false);
    if (result?.ok !== false) throw new Error('expected a failure');
    expect(result.error.code).toBe('LNK_WS_UNSERIALIZABLE');
    expect(session?.state()).toBe('open');
  });

  test('a transport that refuses a frame closes 1011 with LNK_WS_SEND_FAILED', async () => {
    let closed: { code: number; reason: string } | undefined;
    const handler = defineWsHandler<OrderMessage, OrderMessage>({
      path: '/ws/orders',
      onMessage: () => undefined,
    });

    const session = await handler.open(handshake(), {
      send: () => {
        throw new Error('socket gone');
      },
      close: (code, reason) => {
        closed = { code, reason };
      },
    });

    const result = session?.send({ type: 'subscribe', channel: 'orders' });

    expect(result?.ok).toBe(false);
    if (result?.ok !== false) throw new Error('expected a failure');
    expect(result.error.code).toBe('LNK_WS_SEND_FAILED');
    expect(closed).toEqual({ code: 1011, reason: 'send failed' });
  });

  test('the heartbeat pings transports that have a native ping', async () => {
    let pings = 0;
    const handler = defineWsHandler<OrderMessage, OrderMessage>({
      path: '/ws/orders',
      heartbeat: { intervalMs: 5 },
      onMessage: () => undefined,
    });

    const sink = Object.assign(sinkOf(sinkHarness()), {
      ping: () => {
        pings += 1;
      },
    });
    const session = await handler.open(handshake(), sink);

    await Bun.sleep(30);
    expect(pings).toBeGreaterThan(0);
    session?.close();
    const afterClose = pings;
    await Bun.sleep(20);
    expect(pings).toBe(afterClose);
  });

  test('bufferedBytes reports the transport buffer', async () => {
    const harness = sinkHarness();
    const handler = defineWsHandler<OrderMessage, OrderMessage>({
      path: '/ws/orders',
      onMessage: () => undefined,
    });

    const session = await handler.open(handshake(), sinkOf(harness));
    harness.buffered = 42;

    expect(session?.bufferedBytes()).toBe(42);
  });

  test('a client whose connect throws reports it and gives up per policy', async () => {
    const errors: unknown[] = [];
    const states: string[] = [];
    const client = createWsClient<OrderMessage>({
      url: 'wss://orders.test/ws',
      ctx: createCallContext({}),
      reconnect: { attempts: 1, jitter: false },
      onError: (error) => errors.push(error),
      onState: (state) => states.push(state),
      deps: {
        connect: () => {
          throw new Error('no route to host');
        },
        sleep: async () => {
          await Bun.sleep(1);
        },
        random: () => 0.5,
      },
    });

    const info = await client.closed;

    expect(info.code).toBe(1006);
    expect(errors.length).toBeGreaterThan(0);
    expect(states).toContain('closed');
  });

  test('inbound frames the client cannot use are reported, not thrown', async () => {
    const schema = OrderSchema;
    const errors: string[] = [];
    const messages: unknown[] = [];
    const socket = new FakeSocket();

    createWsClient<OrderMessage, OrderMessage>({
      url: 'wss://orders.test/ws',
      ctx: createCallContext({}),
      schema,
      reconnect: false,
      onMessage: (message) => messages.push(message),
      onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
      deps: { connect: () => socket },
    });

    socket.open();
    socket.emit('message', { data: new Uint8Array([1, 2, 3]).buffer });
    socket.emit('message', { data: '{oops' });
    socket.emit('message', { data: JSON.stringify({ type: 'explode', channel: 'x' }) });
    socket.emit('message', { data: JSON.stringify({ type: 'subscribe', channel: 'orders' }) });

    expect(messages).toEqual([{ type: 'subscribe', channel: 'orders' }]);
    expect(errors).toContain('binary frames are not supported');
    expect(errors.length).toBe(3);
  });

  test('protocols are normalised to an array before the transport sees them', () => {
    const seen: (string[] | undefined)[] = [];
    const socket = new FakeSocket();

    createWsClient<OrderMessage>({
      url: 'wss://orders.test/ws',
      protocols: 'orders.v1',
      ctx: createCallContext({}),
      reconnect: false,
      deps: {
        connect: (_url, protocols) => {
          seen.push(protocols);
          return socket;
        },
      },
    });

    createWsClient<OrderMessage>({
      url: 'wss://orders.test/ws',
      protocols: ['orders.v1', 'orders.v2'],
      ctx: createCallContext({}),
      reconnect: false,
      deps: {
        connect: (_url, protocols) => {
          seen.push(protocols);
          return socket;
        },
      },
    });

    expect(seen).toEqual([['orders.v1'], ['orders.v1', 'orders.v2']]);
  });

  test('a deliberate close during backoff stops the loop immediately', async () => {
    const sockets = [new FakeSocket(), new FakeSocket()];
    let index = 0;
    const holder: { client?: ReturnType<typeof createWsClient<OrderMessage>> } = {};

    const client = createWsClient<OrderMessage>({
      url: 'wss://orders.test/ws',
      ctx: createCallContext({}),
      reconnect: { attempts: 3, backoffMs: 5, jitter: false },
      deps: {
        connect: () => {
          const socket = sockets[Math.min(index, sockets.length - 1)];
          index += 1;
          if (socket === undefined) throw new Error('no socket');
          return socket;
        },
        sleep: async () => {
          holder.client?.close(1000, 'shutdown');
          await Bun.sleep(1);
        },
        random: () => 0.5,
      },
    });

    holder.client = client;
    sockets[0]?.open();
    sockets[0]?.close(1011, 'boom');

    expect(await client.closed).toEqual({ code: 1000, reason: 'shutdown' });
    expect(index).toBe(1);
  });

  test('handshake deadlines are checked before a socket is opened', () => {
    const live = createCallContext({ deadline: new Date(Date.now() + 1_000) });
    const expired = createCallContext({ deadline: new Date(Date.now() - 1) });

    expect(handshakeExpired(live)).toBeUndefined();
    expect(handshakeExpired(expired)?.code).toBe('LNK_TIMEOUT');
  });

  test('every RFC close code we speak maps to a kind', () => {
    const table: [number, boolean][] = [
      [1000, false],
      [1001, false],
      [1009, false],
      [1011, false],
      [1013, true],
      [4401, false],
      [4403, false],
      [4999, false],
    ];

    for (const [code, retryable] of table) {
      expect(wsCloseError({ code, reason: 'x' }, 'wss://a').retryable).toBe(retryable);
    }
  });
});
