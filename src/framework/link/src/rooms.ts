/**
 * Rooms (`LNK-025`).
 *
 * A {@link WsHandler | socket handler} is one conversation in whatever process accepted it.
 * A **room** is a set of sockets that must see each other's messages no matter which
 * process accepted them — chat, a collaborative document, a live price ticker. Without a
 * coordinator each isolate fans out to its own sockets and the other isolates never hear
 * it, which is the classic "works with one user, silently wrong with two" bug.
 *
 * On Workers the coordinator already exists: a Durable Object is a single-threaded instance
 * with a stable identity, and the runtime hands it the sockets. This file is the model for
 * that — written against the **shape** of the Durable Object API rather than its types, for
 * three reasons:
 *
 *   · `@tsir/link` must bundle for Workers without depending on `@cloudflare/workers-types`,
 *     and the room code is the same code on Bun, Node and a laptop;
 *   · the semantics that matter (ordering, single-writer, hibernation) are the runtime's,
 *     and a test can model them exactly;
 *   · the deployment half — declaring the binding, the class export, the `migrations`
 *     entry — belongs to `@tsir/deploy` (`DPL-010`), not to the protocol package.
 *
 * What the model guarantees, in the terms the rooms contract asks for:
 *
 *   · **Cross-isolate fan-out.** Every socket in a room is registered with the same room
 *     tag, and a broadcast walks the runtime's own socket list. A client that connected to
 *     isolate A receives a message produced on isolate B, because neither isolate is doing
 *     the fan-out.
 *   · **One writer, therefore an order.** The room object executes one message at a time;
 *     a broadcast is a loop, not a race. Nothing here adds a queue that would break that.
 *   · **Hibernation is normal.** State lives in the socket attachment and in
 *     `state.storage`, never in a module-level map, so an evicted-and-restarted object
 *     still finds its members through `getWebSockets()`.
 *   · **No invented frames.** `onMessage` may return a value, which is broadcast; returning
 *     nothing stays silent. `onJoin` may return a value, which goes to the joining socket
 *     only. Presence is `members()` plus those two hooks, not a bespoke protocol.
 */

import { inboundContext } from './trace.ts';
import { callError, invalidLinkConfig } from './errors.ts';
import { fail, ok, type CallContext, type CallError, type CallResult } from './types.ts';
import type { WsCloseInfo, WsHandshake, WsPayloadSchema, WsPrincipal } from './ws.ts';

/** The Workers socket surface a room needs: send, close, carry an attachment. */
export interface RoomSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

/** The `DurableObjectState` surface a room needs — injected, never imported. */
export interface RoomState {
  acceptWebSocket(socket: RoomSocket, tags?: readonly string[]): void;
  getWebSockets(tag?: string): readonly RoomSocket[];
}

export interface RoomPair {
  /** The socket handed back to the client in the 101 response. */
  readonly client: unknown;
  readonly server: RoomSocket;
}

export interface RoomMember {
  readonly connectionId: string;
  readonly room: string;
  readonly principal: WsPrincipal | undefined;
  readonly joinedAt: number;
}

/** What a handler can do to the room it is running inside. */
export interface Room<Out> {
  readonly id: string;
  /** Live sockets, as the runtime reports them — hibernated ones included. */
  size(): number;
  members(): readonly RoomMember[];
  /** Sends to every member, optionally skipping the sender. Returns deliveries attempted. */
  broadcast(value: Out, options?: { readonly except?: string | undefined }): number;
  /** Sends to one connection. `false` when that connection is gone. */
  to(connectionId: string, value: Out): boolean;
}

export interface RoomOptions<In, Out> {
  /** Room id from the request. Default: the last path segment, or `main`. */
  readonly roomOf?: ((request: Request) => string) | undefined;
  /** Validated per frame; a malformed frame closes `1008`, as in `defineWsHandler`. */
  readonly schema?: WsPayloadSchema<In> | undefined;
  /** Refusing here is a `401` with no socket — the same choice `defineWsHandler` makes. */
  readonly authenticate?:
    | ((handshake: WsHandshake) => WsPrincipal | undefined | Promise<WsPrincipal | undefined>)
    | undefined;
  /** Return a value to greet the joining socket with it; return nothing to stay silent. */
  readonly onJoin?:
    | ((input: {
        readonly member: RoomMember;
        readonly room: Room<Out>;
        readonly ctx: CallContext;
      }) => Out | undefined | void | Promise<Out | undefined | void>)
    | undefined;
  /** Return a value to broadcast it to the room; return nothing to stay silent. */
  readonly onMessage: (input: {
    readonly message: In;
    readonly member: RoomMember;
    readonly room: Room<Out>;
    readonly ctx: CallContext;
  }) => Out | undefined | void | Promise<Out | undefined | void>;
  readonly onLeave?:
    | ((input: {
        readonly member: RoomMember;
        readonly info: WsCloseInfo;
        readonly room: Room<Out>;
      }) => void | Promise<void>)
    | undefined;
  readonly onError?: ((error: unknown, frame: unknown) => void) | undefined;
  /** Default 64 KiB, per `14-security.md`. */
  readonly maxFrameBytes?: number | undefined;
  readonly traceIdFactory?: (() => string) | undefined;
  readonly deps?:
    | {
        readonly pair?: (() => RoomPair) | undefined;
        readonly now?: (() => number) | undefined;
        readonly connectionId?: (() => string) | undefined;
      }
    | undefined;
}

/** The Durable Object methods a room implements, with hibernation-style handlers. */
export interface RoomServer {
  fetch(request: Request): Promise<Response>;
  webSocketMessage(socket: RoomSocket, message: string | ArrayBuffer): Promise<void>;
  webSocketClose(socket: RoomSocket, code: number, reason: string): Promise<void>;
  webSocketError(socket: RoomSocket, error: unknown): void;
  /** The room this server is currently serving — for tests and for logging. */
  roomOf(request: Request): string;
  readonly limits: { readonly maxFrameBytes: number };
}

const ROOM_TAG_PREFIX = 'room:';
const DEFAULT_ROOM = 'main';

interface Attachment extends RoomMember {
  readonly traceId: string;
  readonly correlationId: string;
}

function isAttachment(value: unknown): value is Attachment {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Attachment).connectionId === 'string' &&
    typeof (value as Attachment).room === 'string'
  );
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function headersOf(request: Request): Readonly<Record<string, string | undefined>> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

function defaultRoomOf(request: Request): string {
  const url = new URL(request.url);
  const query = url.searchParams.get('room');
  if (query !== null && query !== '') return query;

  const segments = url.pathname.split('/').filter((segment) => segment !== '');
  return segments.at(-1) ?? DEFAULT_ROOM;
}

export function createRoom<In = string, Out = unknown>(
  state: RoomState,
  options: RoomOptions<In, Out>,
): RoomServer {
  const maxFrameBytes = options.maxFrameBytes ?? 64 * 1024;
  const now = options.deps?.now ?? (() => Date.now());
  const connectionId = options.deps?.connectionId ?? (() => crypto.randomUUID());
  const roomOf = options.roomOf ?? defaultRoomOf;

  // Live abort controllers, per connection. Deliberately not persisted: after hibernation a
  // message is handled in a fresh execution, so a controller from a previous one has no
  // waiter to abort. `webSocketClose` aborts the one that does exist.
  const controllers = new Map<string, AbortController>();

  const memberOf = (socket: RoomSocket): RoomMember | undefined => {
    const attachment = socket.deserializeAttachment();
    if (!isAttachment(attachment)) return undefined;
    return {
      connectionId: attachment.connectionId,
      room: attachment.room,
      principal: attachment.principal,
      joinedAt: attachment.joinedAt,
    };
  };

  const tagOf = (room: string): string => `${ROOM_TAG_PREFIX}${room}`;

  function contextFor(member: RoomMember, attachment: Attachment): CallContext {
    let controller = controllers.get(member.connectionId);
    if (controller === undefined) {
      controller = new AbortController();
      controllers.set(member.connectionId, controller);
    }
    return inboundContext({
      headers: { traceparent: attachment.traceId },
      signal: controller.signal,
      ...(options.traceIdFactory === undefined ? {} : { traceIdFactory: options.traceIdFactory }),
    });
  }

  const roomFor = (room: string): Room<Out> => {
    const sockets = (): readonly RoomSocket[] => state.getWebSockets(tagOf(room));

    const deliver = (socket: RoomSocket, value: Out): boolean => {
      try {
        socket.send(JSON.stringify(value));
        return true;
      } catch {
        // A peer that is already gone is not a failure of the room: the close handler
        // will remove it. Rethrowing would turn one dead socket into a room-wide outage.
        return false;
      }
    };

    return {
      id: room,
      size: () => sockets().length,
      members: () => sockets().flatMap((socket) => memberOf(socket) ?? []),
      broadcast(value, broadcastOptions) {
        let attempted = 0;
        for (const socket of sockets()) {
          const member = memberOf(socket);
          if (member === undefined) continue;
          if (broadcastOptions?.except === member.connectionId) continue;
          attempted += 1;
          deliver(socket, value);
        }
        return attempted;
      },
      to(target, value) {
        for (const socket of sockets()) {
          const member = memberOf(socket);
          if (member?.connectionId !== target) continue;
          return deliver(socket, value);
        }
        return false;
      },
    };
  };

  const report = (error: unknown): void => {
    options.onError?.(error, undefined);
  };

  return {
    limits: { maxFrameBytes },
    roomOf,

    async fetch(request) {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('expected a WebSocket upgrade', { status: 426 });
      }

      let principal: WsPrincipal | undefined;
      try {
        principal = await options.authenticate?.({
          path: new URL(request.url).pathname,
          headers: headersOf(request),
          query: Object.fromEntries(new URL(request.url).searchParams),
        });
      } catch (error) {
        report(error);
        return new Response('handshake failed', { status: 401 });
      }

      if (options.authenticate !== undefined && principal === undefined) {
        // No socket at all, rather than a socket closed 1008: a client that never upgraded
        // gets an HTTP status it can act on, and there is no half-open state to clean up.
        return new Response('unauthenticated', { status: 401 });
      }

      const pairFactory =
        options.deps?.pair ??
        (() => {
          const Pair = (globalThis as { WebSocketPair?: new () => Record<string, RoomSocket> })
            .WebSocketPair;
          if (Pair === undefined) {
            throw invalidLinkConfig('createRoom needs a WebSocketPair global, or pass deps.pair');
          }
          const pair = new Pair();
          return { client: pair['0'], server: pair['1'] as RoomSocket };
        });

      const pair = pairFactory();
      const room = roomOf(request);
      const joinedAt = now();
      const ctxHeaders = headersOf(request);
      const member: RoomMember = {
        connectionId: connectionId(),
        room,
        principal,
        joinedAt,
      };

      // The attachment is the only per-connection state that survives hibernation, so the
      // trace context rides along with the principal rather than in a map.
      const attachment: Attachment = {
        ...member,
        traceId: ctxHeaders['traceparent'] ?? '',
        correlationId: ctxHeaders['x-correlation-id'] ?? '',
      };
      pair.server.serializeAttachment(attachment);
      state.acceptWebSocket(pair.server, [tagOf(room)]);

      const ctx = contextFor(member, attachment);
      try {
        const greeting = await options.onJoin?.({ member, room: roomFor(room), ctx });
        if (greeting !== undefined) pair.server.send(JSON.stringify(greeting));
      } catch (error) {
        report(error);
        pair.server.close(1011, 'join failed');
        controllers.delete(member.connectionId);
        return new Response(null, { status: 101, webSocket: pair.client } as ResponseInit);
      }

      return new Response(null, { status: 101, webSocket: pair.client } as ResponseInit);
    },

    async webSocketMessage(socket, message) {
      const attachment = socket.deserializeAttachment();
      if (!isAttachment(attachment)) {
        // A socket this room never admitted — or one whose attachment was corrupted.
        socket.close(1008, 'unknown connection');
        return;
      }

      const member: RoomMember = {
        connectionId: attachment.connectionId,
        room: attachment.room,
        principal: attachment.principal,
        joinedAt: attachment.joinedAt,
      };

      const text =
        typeof message === 'string' ? message : new TextDecoder().decode(new Uint8Array(message));

      if (byteLength(text) > maxFrameBytes) {
        socket.close(1009, 'frame too large');
        controllers.delete(member.connectionId);
        return;
      }

      let frame: unknown;
      try {
        frame = JSON.parse(text);
      } catch (error) {
        report(error);
        socket.close(1008, 'malformed frame');
        controllers.delete(member.connectionId);
        return;
      }

      let parsed: In;
      try {
        parsed = options.schema === undefined ? (frame as In) : options.schema.parse(frame);
      } catch (error) {
        // A frame the contract does not describe is a client bug: say so with 1008, the
        // same code `defineWsHandler` uses, and leave the rest of the room alone.
        report(error);
        socket.close(1008, 'frame failed schema validation');
        controllers.delete(member.connectionId);
        return;
      }

      const room = roomFor(member.room);
      try {
        const reply = await options.onMessage({
          message: parsed,
          member,
          room,
          ctx: contextFor(member, attachment),
        });
        if (reply !== undefined) room.broadcast(reply);
      } catch (error) {
        report(error);
        socket.close(1011, 'handler failed');
        controllers.delete(member.connectionId);
      }
    },

    async webSocketClose(socket, code, reason) {
      const member = memberOf(socket);
      controllers.get(member?.connectionId ?? '')?.abort();
      if (member !== undefined) controllers.delete(member.connectionId);
      if (member === undefined) return;

      try {
        await options.onLeave?.({ member, info: { code, reason }, room: roomFor(member.room) });
      } catch (error) {
        report(error);
      }
    },

    webSocketError(socket, error) {
      const member = memberOf(socket);
      controllers.get(member?.connectionId ?? '')?.abort();
      if (member !== undefined) controllers.delete(member.connectionId);
      report(error);
    },
  };
}

/* ── helpers for the local (non-Durable-Object) case ─────────────────────────────── */

/** A `CallError` for a broadcast that found nobody — useful as a log line, not a throw. */
export function emptyRoom(room: string): CallError {
  return callError('not_found', 'LNK_ROOM_EMPTY', {
    retryable: false,
    message: `room "${room}" has no live sockets`,
  });
}

/** Delivers a value and reports it as a `CallResult`, for callers that prefer that shape. */
export function sendToRoom<Out>(room: Room<Out>, value: Out): CallResult<number> {
  const delivered = room.broadcast(value);
  if (delivered > 0)
    return ok(delivered, { protocol: 'ws', target: room.id, attempts: 1, elapsedMs: 0 });
  return fail(emptyRoom(room.id), {
    protocol: 'ws',
    target: room.id,
    attempts: 1,
    elapsedMs: 0,
  });
}
