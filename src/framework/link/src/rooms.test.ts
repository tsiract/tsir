/**
 * Rooms (`LNK-025`).
 *
 * The claim under test is the one that cannot be checked by reading `rooms.ts`: **a message
 * produced on one isolate reaches a socket accepted by another**. The fake runtime below
 * models the three properties a Durable Object actually provides — one instance per room, a
 * socket list that outlives an eviction, and single-threaded execution — because those are
 * the properties the model relies on. Everything else the real runtime does (the binding,
 * the class export, the migrations entry) is `DPL-010`'s problem, not the room model's.
 */

import { describe, expect, test } from 'bun:test';

import {
  createRoom,
  sendToRoom,
  type Room,
  type RoomPair,
  type RoomServer,
  type RoomSocket,
  type RoomState,
} from './rooms.ts';
import type { WsPrincipal } from './ws.ts';

/* ── a Durable Object, in about seventy lines ────────────────────────────────────── */

class FakeSocket implements RoomSocket {
  readonly sent: string[] = [];
  closed: { code: number; reason: string } | undefined;
  private attachment: unknown = null;
  /** The next `send` throws, as it does for a peer that vanished between frames. */
  failNextSend = false;

  send(data: string): void {
    if (this.closed !== undefined) throw new Error('socket is closed');
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error('peer is gone');
    }
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    this.closed = { code, reason };
  }

  serializeAttachment(value: unknown): void {
    this.attachment = value;
  }

  deserializeAttachment(): unknown {
    return this.attachment;
  }

  frames(): unknown[] {
    return this.sent.map((text) => JSON.parse(text) as unknown);
  }
}

class FakeState implements RoomState {
  readonly accepted: { socket: FakeSocket; tags: readonly string[] }[] = [];

  acceptWebSocket(socket: RoomSocket, tags: readonly string[] = []): void {
    this.accepted.push({ socket: socket as FakeSocket, tags });
  }

  getWebSockets(tag?: string): readonly RoomSocket[] {
    return this.accepted
      .filter((entry) => tag === undefined || entry.tags.includes(tag))
      .map((entry) => entry.socket);
  }
}

interface Frame {
  readonly text: string;
}

interface Reply {
  readonly type: 'echo';
  readonly text: string;
  readonly from: string;
}

const schema = {
  parse(input: unknown): Frame {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const text = (input as { text?: unknown }).text;
    if (typeof text !== 'string') throw new Error('text must be a string');
    return { text };
  },
};

interface HarnessOptions {
  readonly authenticate?:
    | ((handshake: {
        readonly headers: Record<string, string | undefined>;
      }) => WsPrincipal | undefined)
    | undefined;
  readonly onJoin?:
    ((input: { member: { connectionId: string }; room: { id: string } }) => unknown) | undefined;
  readonly onMessage?:
    | ((input: {
        readonly message: Frame;
        readonly member: { connectionId: string };
        readonly room: Room<Reply>;
      }) => unknown)
    | undefined;
  readonly onLeave?:
    | ((input: {
        member: { connectionId: string };
        info: { code: number; reason: string };
      }) => void)
    | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
  readonly maxFrameBytes?: number | undefined;
}

/** One room object over one state, with the pair seam a test drives frame by frame. */
class Harness {
  readonly state = new FakeState();
  private readonly pairs: RoomPair[] = [];
  private counter = 0;
  readonly errors: unknown[] = [];
  readonly joined: string[] = [];
  readonly left: { connectionId: string; code: number }[] = [];
  private server: RoomServer;

  constructor(private readonly options: HarnessOptions = {}) {
    this.server = this.build();
  }

  /** A new object over the same state: what waking from hibernation looks like. */
  restart(): void {
    this.server = this.build();
  }

  private build(): RoomServer {
    return createRoom<Frame, Reply>(this.state, {
      schema,
      deps: {
        pair: () => {
          const next = this.pairs.shift();
          if (next === undefined) throw new Error('connect() must enqueue a pair first');
          return next;
        },
        now: () => 1_700_000_000_000,
        connectionId: () => `c${String((this.counter += 1))}`,
      },
      ...(this.options.authenticate === undefined
        ? {}
        : { authenticate: this.options.authenticate }),
      ...(this.options.maxFrameBytes === undefined
        ? {}
        : { maxFrameBytes: this.options.maxFrameBytes }),
      onJoin: ({ member, room }) => {
        this.joined.push(member.connectionId);
        return this.options.onJoin?.({ member, room }) as Reply | undefined;
      },
      // A hook that is provided is authoritative: whatever it returns is the reply, and
      // whatever it does to the room handle is its business.
      onMessage: ({ message, member, room }) =>
        this.options.onMessage === undefined
          ? { type: 'echo', text: message.text, from: member.connectionId }
          : (this.options.onMessage({ message, member, room }) as Reply | undefined),
      onLeave: ({ member, info }) => {
        this.left.push({ connectionId: member.connectionId, code: info.code });
        this.options.onLeave?.({ member, info });
      },
      onError: (error) => {
        this.errors.push(error);
        this.options.onError?.(error);
      },
    });
  }

  async connect(
    options: { readonly room?: string; readonly user?: string; readonly upgrade?: boolean } = {},
  ): Promise<{ response: Response; socket: FakeSocket }> {
    const socket = new FakeSocket();
    const client = { id: `client-${String(this.counter + 1)}` };
    this.pairs.push({ client, server: socket });

    const headers: Record<string, string> = { 'x-correlation-id': 'corr-1' };
    if (options.upgrade !== false) headers['upgrade'] = 'websocket';
    if (options.user !== undefined) headers['x-user'] = options.user;

    const response = await this.server.fetch(
      new Request(`https://rooms.test/rooms/${options.room ?? 'chat'}`, { headers }),
    );
    return { response, socket };
  }

  async send(socket: FakeSocket, frame: unknown): Promise<void> {
    await this.server.webSocketMessage(socket, JSON.stringify(frame));
  }

  async sendText(socket: FakeSocket, text: string): Promise<void> {
    await this.server.webSocketMessage(socket, text);
  }

  async close(socket: FakeSocket, code = 1000, reason = ''): Promise<void> {
    socket.close(code, reason);
    await this.server.webSocketClose(socket, code, reason);
  }
}

/* ── tests ──────────────────────────────────────────────────────────────────────── */

describe('rooms (LNK-025)', () => {
  test('a message reaches every socket in the room, from whichever isolate accepted it', async () => {
    const harness = new Harness();
    const a = await harness.connect();
    const b = await harness.connect();

    expect(a.response.status).toBe(101);
    expect(b.response.status).toBe(101);

    await harness.send(a.socket, { text: 'hello' });

    // `b` never shared a process with `a`: the room object did the fan-out, which is the
    // whole point of putting it behind a Durable Object.
    expect(b.socket.frames()).toEqual([{ type: 'echo', text: 'hello', from: 'c1' }]);
    expect(a.socket.frames()).toEqual([{ type: 'echo', text: 'hello', from: 'c1' }]);
  });

  test('a socket in another room hears nothing', async () => {
    const harness = new Harness();
    const chat = await harness.connect({ room: 'chat' });
    const prices = await harness.connect({ room: 'prices' });

    await harness.send(chat.socket, { text: 'only for chat' });

    expect(chat.socket.frames()).toHaveLength(1);
    expect(prices.socket.frames()).toEqual([]);
  });

  test('a restarted object still knows its members, and can still broadcast to them', async () => {
    const harness = new Harness();
    const a = await harness.connect({ user: 'ada' });
    await harness.connect({ user: 'grace' });

    harness.restart();

    // The sockets are the runtime's, and the principal rides in the attachment, so
    // nothing had to be kept in a module-level map to survive the eviction.
    const b = await harness.connect({ user: 'linus' });
    await harness.send(b.socket, { text: 'after restart' });

    expect(a.socket.frames()).toEqual([{ type: 'echo', text: 'after restart', from: 'c3' }]);
    expect(b.socket.frames()).toEqual([{ type: 'echo', text: 'after restart', from: 'c3' }]);
  });

  test('a handler may address one member, and may broadcast without the sender', async () => {
    const harness = new Harness({
      onMessage: ({ message, member, room }) => {
        const reply: Reply = { type: 'echo', text: message.text, from: member.connectionId };

        if (message.text === 'whisper') {
          room.broadcast(reply, { except: member.connectionId });
          return undefined;
        }
        if (message.text === 'dm') {
          const other = room.members().find((entry) => entry.connectionId !== member.connectionId);
          if (other !== undefined) room.to(other.connectionId, reply);
          return undefined;
        }
        return undefined;
      },
    });

    const a = await harness.connect();
    const b = await harness.connect();

    await harness.send(a.socket, { text: 'whisper' });
    expect(a.socket.frames()).toEqual([]);
    expect(b.socket.frames()).toEqual([{ type: 'echo', text: 'whisper', from: 'c1' }]);

    await harness.send(a.socket, { text: 'dm' });
    expect(a.socket.frames()).toEqual([]);
    expect(b.socket.frames()).toHaveLength(2);
  });

  test('a frame that is not JSON closes with 1008 and broadcasts nothing', async () => {
    const harness = new Harness();
    const a = await harness.connect();
    const b = await harness.connect();

    await harness.sendText(a.socket, '{not json');

    expect(a.socket.closed).toEqual({ code: 1008, reason: 'malformed frame' });
    expect(b.socket.frames()).toEqual([]);
    expect(harness.errors).toHaveLength(1);
  });

  test('a frame that fails the schema closes with 1008, like defineWsHandler', async () => {
    const harness = new Harness();
    const a = await harness.connect();

    await harness.send(a.socket, { text: 42 });

    expect(a.socket.closed).toEqual({ code: 1008, reason: 'frame failed schema validation' });
    expect(harness.errors).toHaveLength(1);
  });

  test('a frame over the size budget closes with 1009 before it is parsed', async () => {
    const harness = new Harness({ maxFrameBytes: 16 });
    const a = await harness.connect();

    await harness.send(a.socket, { text: 'x'.repeat(64) });

    expect(a.socket.closed).toEqual({ code: 1009, reason: 'frame too large' });
    expect(harness.errors).toHaveLength(0);
  });

  test('a handler that throws closes with 1011 and reports the error', async () => {
    const harness = new Harness({
      onMessage: () => {
        throw new Error('boom');
      },
    });
    const a = await harness.connect();
    const b = await harness.connect();

    await harness.send(a.socket, { text: 'hello' });

    expect(a.socket.closed).toEqual({ code: 1011, reason: 'handler failed' });
    expect(b.socket.frames()).toEqual([]);
    expect(harness.errors).toHaveLength(1);
  });

  test('a peer that is already gone does not stop the broadcast for everyone else', async () => {
    const harness = new Harness();
    const a = await harness.connect();
    const b = await harness.connect();

    a.socket.failNextSend = true;
    await harness.send(b.socket, { text: 'still delivered' });

    expect(a.socket.frames()).toEqual([]);
    expect(b.socket.frames()).toEqual([{ type: 'echo', text: 'still delivered', from: 'c2' }]);
  });

  test('onJoin greets only the socket that joined', async () => {
    const harness = new Harness({
      onJoin: ({ member }) => ({ type: 'echo', text: 'welcome', from: member.connectionId }),
    });
    const a = await harness.connect();
    const b = await harness.connect();

    expect(a.socket.frames()).toEqual([{ type: 'echo', text: 'welcome', from: 'c1' }]);
    expect(b.socket.frames()).toEqual([{ type: 'echo', text: 'welcome', from: 'c2' }]);
  });

  test('onLeave runs once, with the close code the peer sent', async () => {
    const harness = new Harness();
    const a = await harness.connect();

    await harness.close(a.socket, 1001, 'going away');

    expect(harness.left).toEqual([{ connectionId: 'c1', code: 1001 }]);
  });

  test('a request that is not an upgrade is refused with 426, and no socket is accepted', async () => {
    const harness = new Harness();
    const { response } = await harness.connect({ upgrade: false });

    expect(response.status).toBe(426);
    expect(harness.state.accepted).toHaveLength(0);
  });

  test('a refused handshake is a 401 with no socket at all', async () => {
    const harness = new Harness({
      authenticate: (handshake) =>
        handshake.headers['x-user'] === undefined ? undefined : { id: handshake.headers['x-user'] },
    });

    const anonymous = await harness.connect();
    expect(anonymous.response.status).toBe(401);
    expect(harness.state.accepted).toHaveLength(0);

    // A refused handshake consumes no connection id: it never became a member.
    const known = await harness.connect({ user: 'ada' });
    expect(known.response.status).toBe(101);
    expect(harness.joined).toEqual(['c1']);
  });

  test('sendToRoom reports an empty room instead of pretending it delivered', async () => {
    const harness = new Harness();
    const a = await harness.connect();
    await harness.close(a.socket);

    // `close` above removed nothing from the runtime's list — the real runtime does that
    // when the socket is gone, so emulate it here.
    harness.state.accepted.splice(0);

    const empty = sendToRoom(
      {
        id: 'chat',
        size: () => 0,
        members: () => [],
        broadcast: () => 0,
        to: () => false,
      },
      { type: 'echo', text: 'nobody', from: 'c1' },
    );

    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.error).toMatchObject({
      code: 'LNK_ROOM_EMPTY',
      kind: 'not_found',
      retryable: false,
    });
  });
});
