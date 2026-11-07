import { describe, expect, test } from 'bun:test';

import { redisBroadcaster, type RedisPubSubClient } from './index.ts';

class FakeRedis implements RedisPubSubClient {
  readonly subs = new Set<string>();
  readonly published: Array<{ channel: string; message: string }> = [];
  private listeners = new Set<(channel: string, message: string) => void>();

  async publish(channel: string, message: string): Promise<number> {
    this.published.push({ channel, message });
    for (const l of this.listeners) l(channel, message);
    return 1;
  }

  async subscribe(channel: string): Promise<void> {
    this.subs.add(channel);
  }

  async unsubscribe(channel: string): Promise<void> {
    this.subs.delete(channel);
  }

  on(event: 'message', listener: (channel: string, message: string) => void): void {
    if (event !== 'message') return;
    this.listeners.add(listener);
  }
}

describe('redis broadcaster', () => {
  test('publishes JSON to the prefixed Redis channel', async () => {
    const redis = new FakeRedis();
    const b = redisBroadcaster({ client: redis });
    await b.publish('orders', 'created', { id: 1 });
    expect(redis.published).toEqual([
      {
        channel: 'tsir:broadcast:orders',
        message: JSON.stringify({ channel: 'orders', event: 'created', data: { id: 1 } }),
      },
    ]);
  });

  test('subscribes to Redis on first local subscriber and unsubscribes on last', () => {
    const redis = new FakeRedis();
    const b = redisBroadcaster({ client: redis });
    expect(redis.subs.has('tsir:broadcast:orders')).toBe(false);

    const unsub = b.subscribe('orders', () => {});
    expect(redis.subs.has('tsir:broadcast:orders')).toBe(true);

    unsub();
    expect(redis.subs.has('tsir:broadcast:orders')).toBe(false);
  });

  test('delivers messages from Redis to local subscribers', async () => {
    const redis = new FakeRedis();
    const b = redisBroadcaster({ client: redis });
    let received: unknown = null;
    b.subscribe('orders', (msg) => {
      received = msg.data;
    });
    await redis.publish(
      'tsir:broadcast:orders',
      JSON.stringify({ channel: 'orders', event: 'created', data: { id: 7 } }),
    );
    expect(received).toEqual({ id: 7 });
  });

  test('ignores Redis messages outside the prefix', async () => {
    const redis = new FakeRedis();
    const b = redisBroadcaster({ client: redis });
    let count = 0;
    b.subscribe('orders', () => {
      count++;
    });
    await redis.publish('other:orders', JSON.stringify({ channel: 'orders', event: 'x', data: 1 }));
    expect(count).toBe(0);
  });

  test('uses a custom prefix', () => {
    const redis = new FakeRedis();
    const b = redisBroadcaster({ client: redis, prefix: 'app:' });
    b.subscribe('orders', () => {});
    expect(redis.subs.has('app:orders')).toBe(true);
  });

  test('refuses a client missing required methods', () => {
    expect(() =>
      redisBroadcaster({
        client: { publish: async () => 0 } as unknown as RedisPubSubClient,
      }),
    ).toThrow(/missing required methods/u);
  });
});
