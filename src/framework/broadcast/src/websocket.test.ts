import { describe, expect, test } from 'bun:test';

import { createWebSocketHandler, memoryBroadcaster } from './index.ts';
import type { WebSocketPrincipal } from './index.ts';

function makeSock(id: number) {
  return { id };
}

function makeSend(): { send: (d: string) => void; frames: unknown[] } {
  const frames: unknown[] = [];
  const send = (d: string): void => {
    frames.push(JSON.parse(d));
  };
  return { send, frames };
}

const principal: WebSocketPrincipal = { subject: 'user-1' };

describe('websocket channels', () => {
  test('public channel subscribes without authorization', async () => {
    const b = memoryBroadcaster();
    const h = createWebSocketHandler({
      broadcaster: b,
      authenticate: async () => principal,
    });
    const sock = makeSock(1);
    const { send, frames } = makeSend();
    h.register(sock, principal);
    await h.handleMessage(sock, JSON.stringify({ subscribe: 'public-room' }), send);

    await b.publish('public-room', 'hello', { a: 1 });
    expect(frames).toContainEqual({ channel: 'public-room', event: 'hello', data: { a: 1 } });
  });

  test('private channel requires authorization to subscribe', async () => {
    const b = memoryBroadcaster();
    const h = createWebSocketHandler({
      broadcaster: b,
      authenticate: async () => principal,
      authorize: async (_p, channel) => channel === 'private-allowed',
    });
    const sock = makeSock(1);
    const { send, frames } = makeSend();
    h.register(sock, principal);

    await h.handleMessage(sock, JSON.stringify({ subscribe: 'private-denied' }), send);
    await b.publish('private-denied', 'x', 1);
    expect(frames).toHaveLength(0);

    await h.handleMessage(sock, JSON.stringify({ subscribe: 'private-allowed' }), send);
    await b.publish('private-allowed', 'y', 2);
    expect(frames).toContainEqual({ channel: 'private-allowed', event: 'y', data: 2 });
  });

  test('private channel without authorize callback is refused', async () => {
    const b = memoryBroadcaster();
    const h = createWebSocketHandler({
      broadcaster: b,
      authenticate: async () => principal,
    });
    const sock = makeSock(1);
    const { send, frames } = makeSend();
    h.register(sock, principal);
    await h.handleMessage(sock, JSON.stringify({ subscribe: 'private-x' }), send);
    await b.publish('private-x', 'y', 2);
    expect(frames).toHaveLength(0);
  });

  test('presence channel joins, lists members, and emits member_added', async () => {
    const b = memoryBroadcaster();
    const h = createWebSocketHandler({
      broadcaster: b,
      authenticate: async () => principal,
      authorize: async (_p) => ({ memberId: _p.subject, memberInfo: { name: _p.subject } }),
    });

    const sock1 = makeSock(1);
    const send1 = makeSend();
    h.register(sock1, { subject: 'alice' });
    await h.handleMessage(sock1, JSON.stringify({ subscribe: 'presence-room' }), send1.send);

    // Alice receives the subscription_succeeded with just herself.
    expect(send1.frames).toContainEqual({
      channel: 'presence-room',
      event: 'pusher:subscription_succeeded',
      data: { members: [{ memberId: 'alice', memberInfo: { name: 'alice' } }] },
    });

    const sock2 = makeSock(2);
    const send2 = makeSend();
    h.register(sock2, { subject: 'bob' });
    await h.handleMessage(sock2, JSON.stringify({ subscribe: 'presence-room' }), send2.send);

    // Bob sees both members.
    expect(send2.frames).toContainEqual({
      channel: 'presence-room',
      event: 'pusher:subscription_succeeded',
      data: {
        members: [
          { memberId: 'alice', memberInfo: { name: 'alice' } },
          { memberId: 'bob', memberInfo: { name: 'bob' } },
        ],
      },
    });

    // Alice is told bob joined.
    expect(send1.frames).toContainEqual({
      channel: 'presence-room',
      event: 'pusher:member_added',
      data: { memberId: 'bob', memberInfo: { name: 'bob' } },
    });
  });

  test('presence channel emits member_removed on unsubscribe', async () => {
    const b = memoryBroadcaster();
    const h = createWebSocketHandler({
      broadcaster: b,
      authenticate: async () => principal,
      authorize: async (_p) => ({ memberId: _p.subject }),
    });

    const sock1 = makeSock(1);
    const send1 = makeSend();
    h.register(sock1, { subject: 'alice' });
    await h.handleMessage(sock1, JSON.stringify({ subscribe: 'presence-room' }), send1.send);

    const sock2 = makeSock(2);
    const send2 = makeSend();
    h.register(sock2, { subject: 'bob' });
    await h.handleMessage(sock2, JSON.stringify({ subscribe: 'presence-room' }), send2.send);

    send1.frames.length = 0;
    await h.handleMessage(sock2, JSON.stringify({ unsubscribe: 'presence-room' }), send2.send);

    expect(send1.frames).toContainEqual({
      channel: 'presence-room',
      event: 'pusher:member_removed',
      data: { memberId: 'bob' },
    });
  });

  test('presence channel emits member_removed when the socket disconnects', async () => {
    const b = memoryBroadcaster();
    const h = createWebSocketHandler({
      broadcaster: b,
      authenticate: async () => principal,
      authorize: async (_p) => ({ memberId: _p.subject }),
    });

    const sock1 = makeSock(1);
    const send1 = makeSend();
    h.register(sock1, { subject: 'alice' });
    await h.handleMessage(sock1, JSON.stringify({ subscribe: 'presence-room' }), send1.send);

    const sock2 = makeSock(2);
    const send2 = makeSend();
    h.register(sock2, { subject: 'bob' });
    await h.handleMessage(sock2, JSON.stringify({ subscribe: 'presence-room' }), send2.send);

    send1.frames.length = 0;
    h.unregister(sock2);

    expect(send1.frames).toContainEqual({
      channel: 'presence-room',
      event: 'pusher:member_removed',
      data: { memberId: 'bob' },
    });
  });

  test('whisper on a private channel is forwarded to other subscribers', async () => {
    const b = memoryBroadcaster();
    const h = createWebSocketHandler({
      broadcaster: b,
      authenticate: async () => principal,
      authorize: async () => true,
    });

    const sock1 = makeSock(1);
    const send1 = makeSend();
    h.register(sock1, principal);
    await h.handleMessage(sock1, JSON.stringify({ subscribe: 'private-chat' }), send1.send);

    const sock2 = makeSock(2);
    const send2 = makeSend();
    h.register(sock2, principal);
    await h.handleMessage(sock2, JSON.stringify({ subscribe: 'private-chat' }), send2.send);

    send1.frames.length = 0;
    send2.frames.length = 0;

    await h.handleMessage(
      sock1,
      JSON.stringify({
        whisper: { channel: 'private-chat', event: 'typing', data: { to: 'bob' } },
      }),
      send1.send,
    );

    // The sender does not receive their own whisper.
    expect(send1.frames).toHaveLength(0);
    // Bob receives it, prefixed with client-.
    expect(send2.frames).toContainEqual({
      channel: 'private-chat',
      event: 'client-typing',
      data: { to: 'bob' },
    });
  });

  test('whisper on a public channel is refused', async () => {
    const b = memoryBroadcaster();
    const h = createWebSocketHandler({
      broadcaster: b,
      authenticate: async () => principal,
    });

    const sock1 = makeSock(1);
    const send1 = makeSend();
    h.register(sock1, principal);
    await h.handleMessage(sock1, JSON.stringify({ subscribe: 'public-room' }), send1.send);

    const sock2 = makeSock(2);
    const send2 = makeSend();
    h.register(sock2, principal);
    await h.handleMessage(sock2, JSON.stringify({ subscribe: 'public-room' }), send2.send);

    send2.frames.length = 0;
    await h.handleMessage(
      sock1,
      JSON.stringify({ whisper: { channel: 'public-room', event: 'x', data: 1 } }),
      send1.send,
    );
    expect(send2.frames).toHaveLength(0);
  });

  test('whisper requires subscription to the channel', async () => {
    const b = memoryBroadcaster();
    const h = createWebSocketHandler({
      broadcaster: b,
      authenticate: async () => principal,
      authorize: async () => true,
    });

    const sock1 = makeSock(1);
    const send1 = makeSend();
    h.register(sock1, principal);
    await h.handleMessage(sock1, JSON.stringify({ subscribe: 'private-a' }), send1.send);

    const sock2 = makeSock(2);
    const send2 = makeSend();
    h.register(sock2, principal);
    await h.handleMessage(sock2, JSON.stringify({ subscribe: 'private-b' }), send2.send);

    await h.handleMessage(
      sock1,
      JSON.stringify({ whisper: { channel: 'private-b', event: 'x', data: 1 } }),
      send1.send,
    );
    expect(send2.frames).toHaveLength(0);
  });
});
