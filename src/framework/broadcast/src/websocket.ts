/**
 * WebSocket server (Reverb equivalent).
 *
 * Accepts a `Request` (Bun/Node) and upgrades to a WebSocket. The caller provides an
 * `authenticate` callback that resolves the principal from the request; `null` rejects the
 * connection.
 *
 * Channel types, by name prefix:
 *
 *   · no prefix — public channel, no authorization.
 *   · `private-` — private channel, requires `authorize` to return truthy.
 *   · `presence-` — presence channel, requires `authorize` to return the member info;
 *     the server tracks members and emits `pusher:member_added` / `pusher:member_removed`
 *     and a `pusher:subscription_succeeded` frame with the current member list.
 *
 * Client events (whisper): a client may send `{ whisper: { channel, event, data } }` on a
 * private or presence channel it is subscribed to. The server forwards the event (prefixed
 * with `client-`) to every *other* subscriber of that channel. Public channels do not allow
 * whispers, because there is no authorization to lean on.
 *
 * Subprotocol:
 *   → client: { "subscribe": "channel.name" }
 *   → client: { "unsubscribe": "channel.name" }
 *   → client: { "whisper": { "channel": "...", "event": "...", "data": ... } }
 *   ← server: { "channel": "...", "event": "...", "data": ... }
 */
import type { Broadcaster } from './broadcaster.ts';

export interface WebSocketPrincipal {
  subject: string;
  [key: string]: unknown;
}

export interface PresenceMember {
  readonly memberId: string;
  readonly memberInfo?: unknown;
}

/**
 * What `authorize` returns. A boolean gates a private channel. For presence channels,
 * return the member info so the server can track who is in the room.
 */
export type AuthorizeResult = boolean | PresenceMember;

export interface WebSocketServerOptions {
  broadcaster: Broadcaster;
  authenticate: (request: Request) => Promise<WebSocketPrincipal | null>;
  /**
   * Authorization check before subscribing to a channel. Return `true` to allow a
   * private channel; return a `PresenceMember` to join a presence channel (and identify
   * the member). Return `false` (or throw) to refuse.
   */
  authorize?: (principal: WebSocketPrincipal, channel: string) => Promise<AuthorizeResult>;
}

export interface WebSocketConnection {
  principal: WebSocketPrincipal;
  subscriptions: Set<string>;
  /** presence channel → member info for this connection */
  presenceMembers: Map<string, PresenceMember>;
}

export interface WebSocketHandler {
  connections: Map<unknown, WebSocketConnection>;
  handleMessage(socket: unknown, raw: string, send: (data: string) => void): Promise<void>;
  register(socket: unknown, principal: WebSocketPrincipal): void;
  unregister(socket: unknown): void;
}

const PRIVATE_PREFIX = 'private-';
const PRESENCE_PREFIX = 'presence-';
const CLIENT_EVENT_PREFIX = 'client-';

export function createWebSocketHandler(options: WebSocketServerOptions): WebSocketHandler {
  const connections = new Map<unknown, WebSocketConnection>();
  /** presence channel → Map<socket, member> */
  const presence = new Map<string, Map<unknown, PresenceMember>>();

  function isPrivate(channel: string): boolean {
    return channel.startsWith(PRIVATE_PREFIX);
  }

  function isPresence(channel: string): boolean {
    return channel.startsWith(PRESENCE_PREFIX);
  }

  function isProtected(channel: string): boolean {
    return isPrivate(channel) || isPresence(channel);
  }

  /** Send a frame to a socket, swallowing send errors. */
  function sendTo(send: (data: string) => void, frame: unknown): void {
    try {
      send(JSON.stringify(frame));
    } catch {
      // The socket is gone; the next unregister cleans up.
    }
  }

  /** socket → most-recent send function, so presence/whisper frames can reach peers. */
  const socketSend = new Map<unknown, (data: string) => void>();

  function sendersFor(
    channel: string,
    excludeSocket: unknown,
  ): Array<{ socket: unknown; send: (data: string) => void }> {
    const out: Array<{ socket: unknown; send: (data: string) => void }> = [];
    for (const [socket, conn] of connections) {
      if (socket === excludeSocket) continue;
      if (!conn.subscriptions.has(channel)) continue;
      const send = socketSend.get(socket);
      if (send === undefined) continue;
      out.push({ socket, send });
    }
    return out;
  }

  async function handleMessage(
    socket: unknown,
    raw: string,
    send: (data: string) => void,
  ): Promise<void> {
    const conn = connections.get(socket);
    if (conn === undefined) return;
    socketSend.set(socket, send);

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // malformed frame: drop silently
      return;
    }

    if (typeof msg.subscribe === 'string') {
      await handleSubscribe(socket, conn, msg.subscribe, send);
    }

    if (typeof msg.unsubscribe === 'string') {
      handleUnsubscribe(socket, conn, msg.unsubscribe);
    }

    if (msg.whisper !== undefined && typeof msg.whisper === 'object') {
      await handleWhisper(socket, conn, msg.whisper as Record<string, unknown>);
    }
  }

  async function handleSubscribe(
    socket: unknown,
    conn: WebSocketConnection,
    channel: string,
    send: (data: string) => void,
  ): Promise<void> {
    let member: PresenceMember | undefined;

    if (isProtected(channel)) {
      if (options.authorize === undefined) return;
      let result: AuthorizeResult;
      try {
        result = await options.authorize(conn.principal, channel);
      } catch {
        return;
      }
      if (result === false) return;
      if (isPresence(channel)) {
        if (typeof result !== 'object' || result === null) return;
        member = result;
      }
    }

    conn.subscriptions.add(channel);

    // Subscribe the connection to the broadcaster so server-published events reach it.
    options.broadcaster.subscribe(channel, (broadcast) => {
      sendTo(send, broadcast);
    });

    if (isPresence(channel) && member !== undefined) {
      conn.presenceMembers.set(channel, member);
      let members = presence.get(channel);
      if (members === undefined) {
        members = new Map();
        presence.set(channel, members);
      }
      members.set(socket, member);

      // Tell the joiner who is already here.
      sendTo(send, {
        channel,
        event: 'pusher:subscription_succeeded',
        data: { members: [...members.values()] },
      });

      // Tell everyone else a member joined.
      for (const peer of sendersFor(channel, socket)) {
        sendTo(peer.send, {
          channel,
          event: 'pusher:member_added',
          data: member,
        });
      }
    }
  }

  function handleUnsubscribe(socket: unknown, conn: WebSocketConnection, channel: string): void {
    conn.subscriptions.delete(channel);
    const member = conn.presenceMembers.get(channel);
    if (member !== undefined) {
      conn.presenceMembers.delete(channel);
      const members = presence.get(channel);
      if (members !== undefined) {
        members.delete(socket);
        if (members.size === 0) presence.delete(channel);
      }
      for (const peer of sendersFor(channel, socket)) {
        sendTo(peer.send, {
          channel,
          event: 'pusher:member_removed',
          data: member,
        });
      }
    }
  }

  async function handleWhisper(
    socket: unknown,
    conn: WebSocketConnection,
    whisper: Record<string, unknown>,
  ): Promise<void> {
    const channel = typeof whisper.channel === 'string' ? whisper.channel : undefined;
    const event = typeof whisper.event === 'string' ? whisper.event : undefined;
    if (channel === undefined || event === undefined) return;
    // Whispers only on protected channels: a public channel has no authorization to lean on.
    if (!isProtected(channel)) return;
    if (!conn.subscriptions.has(channel)) return;

    const frame = {
      channel,
      event: `${CLIENT_EVENT_PREFIX}${event}`,
      data: whisper.data,
    };

    // Forward to every other subscriber.
    for (const peer of sendersFor(channel, socket)) {
      sendTo(peer.send, frame);
    }
  }

  function unregister(socket: unknown): void {
    const conn = connections.get(socket);
    if (conn !== undefined) {
      // Leave every presence channel this connection was in, emitting member_removed.
      for (const channel of [...conn.presenceMembers.keys()]) {
        handleUnsubscribe(socket, conn, channel);
      }
    }
    connections.delete(socket);
    socketSend.delete(socket);
  }

  return {
    connections,
    handleMessage,
    /** Register a new socket after upgrade. */
    register(socket: unknown, principal: WebSocketPrincipal) {
      connections.set(socket, {
        principal,
        subscriptions: new Set(),
        presenceMembers: new Map(),
      });
    },
    unregister,
  };
}
