import { describe, expect, test } from 'bun:test';

import { pusherBroadcaster, type PusherLike } from './index.ts';

class FakePusher implements PusherLike {
  readonly triggers: Array<{ channel: string | readonly string[]; event: string; data: unknown }> =
    [];

  async trigger(channel: string | readonly string[], event: string, data: unknown): Promise<void> {
    this.triggers.push({ channel, event, data });
  }
}

describe('pusher broadcaster', () => {
  test('publishes to the pusher client', async () => {
    const pusher = new FakePusher();
    const b = pusherBroadcaster({ client: pusher });
    await b.publish('orders', 'created', { id: 1 });
    expect(pusher.triggers).toEqual([{ channel: 'orders', event: 'created', data: { id: 1 } }]);
  });

  test('subscribe is a no-op (Pusher delivers over its own socket)', () => {
    const pusher = new FakePusher();
    const b = pusherBroadcaster({ client: pusher });
    const unsub = b.subscribe('orders', () => {});
    expect(typeof unsub).toBe('function');
    unsub();
  });

  test('refuses a client without trigger', () => {
    expect(() => pusherBroadcaster({ client: {} as PusherLike })).toThrow(
      /missing required method: trigger/u,
    );
  });
});
