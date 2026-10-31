/**
 * WebSocket (`LNK-021` … `LNK-024`).
 *
 * A socket is a conversation with a lifecycle, not a request. That difference is the
 * whole file: REST can retry a call because it can rebuild it, while a WebSocket has
 * state the client cannot rebuild — subscriptions, half-sent messages, ordering. So:
 *
 *   · **No silent replay.** A send while the socket is not open fails with
 *     `LNK_WS_CLOSED`. Nothing is queued and nothing is re-sent after a reconnect,
 *     because "at-most-once" is a promise a caller can reason about and "maybe twice,
 *     later" is not. Delivery guarantees belong to the application's own
 *     `idempotencyKey`.
 *   · **Every policy violation closes with a code the peer can read** (RFC 6455 § 7.4.1):
 *     `1008` for a frame the contract does not describe, `1009` for a frame over the size
 *     budget, `1013` for backpressure, `1001` when draining, `1011` when a handler throws.
 *   · **The transport is a seam, not an assumption.** Bun's server sockets are
 *     callback-based; Workers and browsers are `EventTarget`s. `open(handshake, sink)`
 *     covers the first, `attach(socket, handshake)` the second, and both run the same
 *     session code — which is also what makes the tests socket-free.
 *   · **Timers are owned.** The session clears its own interval on close, so nothing
 *     outlives the socket and no test has to reach into the event loop.
 */

import { preflight } from './deadline.ts';
import { inboundContext } from './trace.ts';
import { backoffMs, type RetryPolicy } from './retry.ts';
import { callError, invalidLinkConfig, kindForWsClose, urlNotAllowed } from './errors.ts';
import {
  fail,
  ok,
  type CallContext,
  type CallError,
  type CallErrorKind,
  type CallMeta,
  type CallResult,
} from './types.ts';

/** Anything with a `parse` — `@tsir/validate` and zod both satisfy it. */
export interface WsPayloadSchema<T> {
  parse(input: unknown): T;
}

/** The WHATWG subset every event-target transport provides. */
export interface WsSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

/** The callback-side seam: what a transport must be able to do for a session. */
export interface WsSink {
  send(text: string): void;
  close(code: number, reason: string): void;
  /** Bytes still unwritten. Absent means "assume zero" for transports without a buffer. */
  bufferedAmount?: (() => number) | undefined;
}

export interface WsHandshake {
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly query: Readonly<Record<string, string>>;
}

export interface WsPrincipal {
  readonly id: string;
  readonly claims?: Readonly<Record<string, unknown>> | undefined;
}

export type WsLifecycle = 'connecting' | 'reconnecting' | 'open' | 'draining' | 'closed';

export interface WsCloseInfo {
  readonly code: number;
  readonly reason: string;
}

const WS_OPEN = 1;

/* ── server ───────────────────────────────────────────────────────────────────────── */

export interface WsHandlerOptions<In, Out> {
  /** The path this handler serves; transports route on it. */
  readonly path: string;
  /** Validated per frame. Without it, a frame must still be valid JSON. */
  readonly schema?: WsPayloadSchema<In> | undefined;
  /** Returns a principal, or `undefined` to refuse the handshake. */
  readonly authenticate?:
    | ((handshake: WsHandshake) => WsPrincipal | undefined | Promise<WsPrincipal | undefined>)
    | undefined;
  readonly onOpen?:
    | ((input: {
        readonly session: WsSession<Out>;
        readonly principal: WsPrincipal | undefined;
        readonly ctx: CallContext;
      }) => void | Promise<void>)
    | undefined;
  /** Return a value to send it back; return nothing to stay silent. */
  readonly onMessage: (input: {
    readonly message: In;
    readonly principal: WsPrincipal | undefined;
    readonly session: WsSession<Out>;
    readonly ctx: CallContext;
  }) => Out | undefined | void | Promise<Out | undefined | void>;
  readonly onClose?: ((info: WsCloseInfo, principal: WsPrincipal | undefined) => void) | undefined;
  /** Handler and frame errors land here before the socket is closed. */
  readonly onError?: ((error: unknown, frame: unknown) => void) | undefined;

  /** Default 64 KiB, per `14-security.md`. */
  readonly maxFrameBytes?: number | undefined;
  /** Default 1 MiB: a peer this far behind is disconnected, not buffered. */
  readonly maxBufferedBytes?: number | undefined;
  /** Default 60 s with no inbound traffic. */
  readonly idleTimeoutMs?: number | undefined;
  /** Native `ping()` where the transport has one (Bun server sockets) — advisory elsewhere. */
  readonly heartbeat?: { readonly intervalMs?: number } | undefined;
  readonly now?: (() => number) | undefined;
  readonly traceIdFactory?: (() => string) | undefined;
}

export interface WsSession<Out> {
  state(): WsLifecycle;
  bufferedBytes(): number;
  /** Fails with `LNK_WS_CLOSED` when the socket is not open. Never queues. */
  send(value: Out): CallResult<void>;
  /** Close `1001` once the transport's buffer is empty. */
  drain(reason?: string): Promise<void>;
  close(code?: number, reason?: string): void;
  /** Resets the idle timer; any inbound frame or pong counts. */
  noteActivity(): void;
}

/** A server session plus the two callbacks a callback-style transport feeds. */
export interface WsServerSession<Out> extends WsSession<Out> {
  receive(data: string | Uint8Array): void;
  ended(code: number, reason: string): void;
}

export interface WsHandler<Out> {
  readonly path: string;
  readonly limits: {
    readonly maxFrameBytes: number;
    readonly maxBufferedBytes: number;
    readonly idleTimeoutMs: number;
  };
  /** Callback-style transports (Bun `server.upgrade`): drive the session yourself. */
  open(handshake: WsHandshake, sink: WsSink): Promise<WsServerSession<Out> | undefined>;
  /** EventTarget transports (Workers `WebSocketPair`, browser, Node `ws`). */
  attach(socket: WsSocket, handshake: WsHandshake): Promise<WsServerSession<Out> | undefined>;
}

export function defineWsHandler<In, Out>(options: WsHandlerOptions<In, Out>): WsHandler<Out> {
  if (!options.path.startsWith('/')) {
    throw invalidLinkConfig(`ws handler path must start with "/" (got "${options.path}")`);
  }

  const limits = {
    maxFrameBytes: options.maxFrameBytes ?? 64 * 1024,
    maxBufferedBytes: options.maxBufferedBytes ?? 1024 * 1024,
    idleTimeoutMs: options.idleTimeoutMs ?? 60_000,
  };

  async function open(
    handshake: WsHandshake,
    sink: WsSink,
  ): Promise<WsServerSession<Out> | undefined> {
    let principal: WsPrincipal | undefined;
    try {
      principal = await options.authenticate?.(handshake);
    } catch (error) {
      options.onError?.(error, handshake);
      sink.close(1011, 'handshake failed');
      return undefined;
    }

    if (options.authenticate !== undefined && principal === undefined) {
      // Refusing the handshake is the only way to not have a socket at all: opening one
      // and closing it immediately is a race the client would have to interpret.
      sink.close(1008, 'unauthenticated');
      return undefined;
    }

    return createSession(options, sink, principal, limits, handshake);
  }

  return {
    path: options.path,
    limits,
    open,

    async attach(socket, handshake) {
      const session = await open(handshake, {
        send: (text) => {
          socket.send(text);
        },
        close: (code, reason) => closeQuietly(socket, code, reason),
        bufferedAmount: () => socket.bufferedAmount,
      });

      if (session === undefined) return undefined;

      socket.addEventListener('message', (event) => {
        const data = (event as { data?: unknown }).data;
        if (typeof data === 'string' || data instanceof Uint8Array) session.receive(data);
      });
      socket.addEventListener('close', (event) => {
        const info = event as { code?: number; reason?: string };
        session.ended(info.code ?? 1006, info.reason ?? '');
      });

      return session;
    },
  };
}

function createSession<In, Out>(
  options: WsHandlerOptions<In, Out>,
  sink: WsSink,
  principal: WsPrincipal | undefined,
  limits: {
    maxFrameBytes: number;
    maxBufferedBytes: number;
    idleTimeoutMs: number;
  },
  handshake: WsHandshake,
): WsServerSession<Out> {
  const now = options.now ?? Date.now;
  const abort = new AbortController();
  const ctx = inboundContext({
    headers: handshake.headers,
    signal: abort.signal,
    ...(options.traceIdFactory === undefined ? {} : { traceIdFactory: options.traceIdFactory }),
  });

  let lifecycle: WsLifecycle = 'open';
  let lastSeenAt = now();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  const meta = (): CallMeta => ({
    protocol: 'ws',
    target: options.path,
    attempts: 1,
    elapsedMs: 0,
  });

  function scheduleIdleCheck(): void {
    if (lifecycle !== 'open') return;
    const remaining = Math.max(0, limits.idleTimeoutMs - (now() - lastSeenAt));
    idleTimer = setTimeout(() => {
      if (lifecycle !== 'open') return;
      if (now() - lastSeenAt >= limits.idleTimeoutMs) {
        // A half-open socket sitting in a load balancer looks healthy and does nothing.
        // Closing it is what lets the client's own reconnect policy kick in.
        close(1001, 'idle timeout');
        return;
      }
      scheduleIdleCheck();
    }, remaining);
    (idleTimer as { unref?: () => void }).unref?.();
  }

  function stopTimers(): void {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    idleTimer = undefined;
    heartbeatTimer = undefined;
  }

  function close(code = 1000, reason = ''): void {
    if (lifecycle === 'closed') return;
    lifecycle = 'closed';
    stopTimers();
    abort.abort();
    try {
      sink.close(code, reason);
    } catch {
      // The peer is already gone: the transport's close is the truthful one.
    }
  }

  const session: WsServerSession<Out> = {
    state: () => lifecycle,
    bufferedBytes: () => sink.bufferedAmount?.() ?? 0,

    send(value: Out): CallResult<void> {
      if (lifecycle !== 'open') {
        return fail<void>(
          callError('unknown', 'LNK_WS_CLOSED', {
            retryable: false,
            message: 'the socket is not open; messages are not queued or replayed',
          }),
          meta(),
        );
      }

      let text: string;
      try {
        text = JSON.stringify(value);
      } catch (error) {
        return fail<void>(unserializable(error), meta());
      }

      const buffered = sink.bufferedAmount?.() ?? 0;
      if (buffered > limits.maxBufferedBytes) {
        // Buffering here would move the failure from the peer into this process's RSS.
        // 1013 tells a well-behaved peer to slow down instead.
        close(1013, 'backpressure');
        return fail<void>(
          callError('unavailable', 'LNK_WS_BACKPRESSURE', {
            retryable: true,
            message: `bufferedAmount is over the ${String(limits.maxBufferedBytes)}-byte limit`,
          }),
          meta(),
        );
      }

      try {
        sink.send(text);
        return ok(undefined, meta());
      } catch (error) {
        close(1011, 'send failed');
        return fail<void>(
          callError('unknown', 'LNK_WS_SEND_FAILED', {
            retryable: false,
            cause: error,
            message: 'the transport refused the frame',
          }),
          meta(),
        );
      }
    },

    async drain(reason = 'server shutting down') {
      if (lifecycle !== 'open') return;
      lifecycle = 'draining';

      // 1001 only after the buffer empties: a peer mid-write must not lose the last
      // frame to a close that raced ahead of the socket.
      const deadline = now() + 5_000;
      while ((sink.bufferedAmount?.() ?? 0) > 0 && now() < deadline) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 5);
        });
      }
      close(1001, reason);
    },

    close,

    noteActivity() {
      lastSeenAt = now();
    },

    receive(data: string | Uint8Array) {
      if (lifecycle !== 'open') return;
      lastSeenAt = now();
      void handleFrame(data);
    },

    ended(code: number, reason: string) {
      if (lifecycle !== 'closed') {
        lifecycle = 'closed';
        stopTimers();
        abort.abort();
      }
      options.onClose?.({ code, reason }, principal);
    },
  };

  async function handleFrame(data: string | Uint8Array): Promise<void> {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);

    if (byteLength(text) > limits.maxFrameBytes) {
      close(1009, 'frame too large');
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      close(1008, 'invalid JSON');
      return;
    }

    let message: In;
    if (options.schema === undefined) {
      message = parsed as In;
    } else {
      try {
        message = options.schema.parse(parsed);
      } catch (error) {
        // A frame the contract does not describe is a client bug: say so with 1008 and
        // stop guessing, rather than dispatching something half-validated.
        options.onError?.(error, parsed);
        close(1008, 'frame failed schema validation');
        return;
      }
    }

    try {
      const reply = await options.onMessage({ message, principal, session, ctx });
      if (reply !== undefined) session.send(reply);
    } catch (error) {
      options.onError?.(error, message);
      close(1011, 'handler failed');
    }
  }

  void (async () => {
    scheduleIdleCheck();

    const heartbeatMs = options.heartbeat?.intervalMs;
    if (heartbeatMs !== undefined && heartbeatMs > 0) {
      heartbeatTimer = setInterval(() => {
        if (lifecycle !== 'open') return;
        (sink as { ping?: () => void }).ping?.();
      }, heartbeatMs);
      (heartbeatTimer as { unref?: () => void }).unref?.();
    }

    await options.onOpen?.({ session, principal, ctx });
  })();

  return session;
}

function unserializable(error: unknown): CallError {
  return callError('invalid_argument', 'LNK_WS_UNSERIALIZABLE', {
    retryable: false,
    cause: error,
    message: 'the outbound message is not JSON-serialisable',
  });
}

function byteLength(text: string): number {
  // `text.length` counts UTF-16 code units: a 200 KB multi-byte frame would slip past a
  // 64 KB limit that was meant to bound memory.
  return new TextEncoder().encode(text).byteLength;
}

function closeQuietly(socket: WsSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // Already closing: the peer will see the transport's own close code.
  }
}

/* ── client ───────────────────────────────────────────────────────────────────────── */

export interface WsReconnectPolicy {
  readonly attempts: number;
  readonly backoffMs?: number | undefined;
  readonly maxBackoffMs?: number | undefined;
  readonly jitter?: boolean | undefined;
}

export interface WsClientOptions<In> {
  readonly url: string;
  readonly protocols?: string | readonly string[] | undefined;
  readonly ctx: CallContext;
  /** Validates every inbound frame; a bad frame is reported through `onError`. */
  readonly schema?: WsPayloadSchema<In> | undefined;
  readonly reconnect?: WsReconnectPolicy | false | undefined;
  readonly onMessage?: ((message: In) => void) | undefined;
  readonly onState?: ((state: WsLifecycle) => void) | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
  readonly allowedHosts?: readonly string[] | undefined;
  readonly deps?:
    | {
        readonly connect?: (url: string, protocols: string[] | undefined) => WsSocket;
        readonly now?: () => number;
        readonly sleep?: (ms: number) => Promise<void>;
        readonly random?: () => number;
      }
    | undefined;
}

export interface WsClient<Out> {
  state(): WsLifecycle;
  /** Fails with `LNK_WS_CLOSED` unless the socket is open. Never queues, never replays. */
  send(value: Out): CallResult<void>;
  /** A deliberate close: no reconnect follows. */
  close(code?: number, reason?: string): void;
  /** Resolves with the final close, once no further attempt will be made. */
  readonly closed: Promise<WsCloseInfo>;
}

const RECONNECT_DEFAULTS = { attempts: 5, backoffMs: 500, maxBackoffMs: 30_000, jitter: true };

export function createWsClient<Out, In = unknown>(options: WsClientOptions<In>): WsClient<Out> {
  const url = parseWsUrl(options.url, options.allowedHosts);
  const reconnect =
    options.reconnect === false ? undefined : { ...RECONNECT_DEFAULTS, ...options.reconnect };
  if (reconnect !== undefined && reconnect.attempts < 0) {
    throw invalidLinkConfig('ws reconnect.attempts must not be negative');
  }

  const deps = {
    connect:
      options.deps?.connect ??
      ((target: string, protocols: string[] | undefined): WsSocket =>
        new WebSocket(target, protocols)),
    now: options.deps?.now ?? Date.now,
    sleep:
      options.deps?.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    random: options.deps?.random ?? Math.random,
  };

  let socket: WsSocket | undefined;
  let lifecycle: WsLifecycle = 'connecting';
  let deliberate = false;
  let attempt = 0;
  let settle: (info: WsCloseInfo) => void = () => undefined;

  const closed = new Promise<WsCloseInfo>((resolve) => {
    settle = resolve;
  });

  const meta = (): CallMeta => ({ protocol: 'ws', target: url, attempts: 1, elapsedMs: 0 });
  const setState = (next: WsLifecycle): void => {
    lifecycle = next;
    options.onState?.(next);
  };

  function finish(code: number, reason: string): void {
    setState('closed');
    settle({ code, reason });
  }

  function connect(): void {
    setState(attempt === 0 ? 'connecting' : 'reconnecting');

    let next: WsSocket;
    try {
      next = deps.connect(url, normalizeProtocols(options.protocols));
    } catch (error) {
      options.onError?.(error);
      void handleClose(1006, 'connect failed');
      return;
    }
    socket = next;

    next.addEventListener('open', () => {
      attempt = 0;
      setState('open');
    });

    next.addEventListener('message', (event) => {
      const data = (event as { data?: unknown }).data;
      const text =
        typeof data === 'string'
          ? data
          : data instanceof Uint8Array
            ? new TextDecoder().decode(data)
            : undefined;
      if (text === undefined) {
        options.onError?.(new Error('binary frames are not supported'));
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch (error) {
        options.onError?.(error);
        return;
      }

      if (options.schema === undefined) {
        options.onMessage?.(parsed as In);
        return;
      }
      try {
        options.onMessage?.(options.schema.parse(parsed));
      } catch (error) {
        // A bad inbound frame is the peer's bug; report it and let the transport decide.
        options.onError?.(error);
      }
    });

    next.addEventListener('close', (event) => {
      const info = event as { code?: number; reason?: string };
      void handleClose(info.code ?? 1006, info.reason ?? '');
    });

    next.addEventListener('error', (event) => {
      options.onError?.(event);
    });
  }

  async function handleClose(code: number, reason: string): Promise<void> {
    socket = undefined;

    if (deliberate || reconnect === undefined) {
      finish(code, reason);
      return;
    }

    // 1000 and 1001 are statements, not accidents: the peer meant to close, and
    // reconnecting would fight it.
    if (code === 1000 || code === 1001) {
      finish(code, reason);
      return;
    }

    attempt += 1;
    if (attempt > reconnect.attempts) {
      finish(code, reason);
      return;
    }

    const policy: RetryPolicy = {
      attempts: reconnect.attempts + 1,
      backoffMs: reconnect.backoffMs,
      maxBackoffMs: reconnect.maxBackoffMs,
      jitter: reconnect.jitter,
    };
    const delay = backoffMs(policy, attempt, deps.random);
    setState('reconnecting');
    await deps.sleep(delay);

    if (deliberate) {
      finish(code, reason);
      return;
    }
    connect();
  }

  connect();

  return {
    state: () => lifecycle,

    send(value: Out): CallResult<void> {
      if (socket === undefined || lifecycle !== 'open' || socket.readyState !== WS_OPEN) {
        return fail<void>(
          callError('unknown', 'LNK_WS_CLOSED', {
            retryable: false,
            message: 'the socket is not open; nothing is queued and nothing is replayed',
          }),
          meta(),
        );
      }

      let text: string;
      try {
        text = JSON.stringify(value);
      } catch (error) {
        return fail<void>(unserializable(error), meta());
      }

      try {
        socket.send(text);
        return ok(undefined, meta());
      } catch (error) {
        return fail<void>(
          callError('unknown', 'LNK_WS_SEND_FAILED', {
            retryable: false,
            cause: error,
            message: 'the transport refused the frame',
          }),
          meta(),
        );
      }
    },

    close(code = 1000, reason = ''): void {
      deliberate = true;
      if (socket !== undefined) closeQuietly(socket, code, reason);
      else finish(code, reason);
    },

    closed,
  };
}

function normalizeProtocols(
  protocols: string | readonly string[] | undefined,
): string[] | undefined {
  if (protocols === undefined) return undefined;
  return typeof protocols === 'string' ? [protocols] : [...protocols];
}

function parseWsUrl(raw: string, allowedHosts: readonly string[] | undefined): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidLinkConfig(`ws url "${raw}" is not an absolute URL`);
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw invalidLinkConfig(`ws url "${raw}" must use ws or wss`);
  }
  // The same rule as REST: an unencrypted socket to a non-loopback host is a downgrade
  // that must fail at construction, not in production traffic.
  if (url.protocol === 'ws:' && !isLoopback(url.hostname)) {
    throw invalidLinkConfig(`ws url "${raw}" uses ws to a non-loopback host — use wss`);
  }
  if (allowedHosts !== undefined && !allowedHosts.includes(url.host)) {
    throw urlNotAllowed(raw, allowedHosts);
  }
  return url.href;
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/* ── shared with transports and the capability matrix ────────────────────────────── */

/** Why a socket ended, in `CallError` terms — for transports that report upward. */
export function wsCloseError(info: WsCloseInfo, target: string): CallError {
  const mapped = kindForWsClose(info.code);
  const kind: CallErrorKind = mapped === 'closed' ? 'unknown' : mapped;
  const detail = info.reason === '' ? 'no reason' : info.reason;

  return callError(kind, `WS_${String(info.code)}`, {
    retryable: kind === 'unavailable',
    message: `${target} closed with ${String(info.code)} (${detail})`,
  });
}

/** Deadlines apply to the handshake, not the conversation. Exported for adapters. */
export function handshakeExpired(
  ctx: CallContext,
  now: number = Date.now(),
): CallError | undefined {
  return preflight(ctx, now);
}

/* ── rooms ───────────────────────────────────────────────────────────────────────── */

// `rooms.ts` imports only *types* from this file, so this re-export adds no runtime cycle:
// the room model is part of the WebSocket entrypoint because a room is what makes a socket
// survive the process that accepted it (`LNK-025`).
export {
  createRoom,
  emptyRoom,
  sendToRoom,
  type Room,
  type RoomMember,
  type RoomOptions,
  type RoomPair,
  type RoomServer,
  type RoomSocket,
  type RoomState,
} from './rooms.ts';
