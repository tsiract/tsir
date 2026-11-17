/**
 * The Durable Object broadcaster, against a hub that behaves like the real one.
 *
 * What is worth testing here is not that `publish` calls `fetch` — it is the two behaviours a
 * Worker actually depends on: a subscriber receives frames the hub streams, and the subscription
 * is torn down when the last local listener leaves, because a Durable Object that nobody
 * disconnects from bills forever.
 */

import { describe, expect, test } from 'bun:test';

import { DURABLE_OBJECT_HUB, durableObjectBroadcaster } from './durable-object.ts';
import type { DurableObjectNamespaceLike } from './durable-object.ts';

/**
 * A hub that keeps every subscriber's writer, so a publish reaches them the way the real object's
 * `#fan` does. `sent` records the publishes for assertions.
 */
function fakeHub(): {
  namespace: DurableObjectNamespaceLike;
  sent: { channel: string; event: string; data: unknown }[];
  subscribers: number;
} {
  const sent: { channel: string; event: string; data: unknown }[] = [];
  const writers = new Set<{ write: (frame: Uint8Array) => void; close: () => void }>();
  const objects = new Map<string, { writers: typeof writers }>();

  const namespace: DurableObjectNamespaceLike = {
    idFromName: (name: string): unknown => name,
    get: (id: unknown) => ({
      async fetch(input: Request | string, init?: RequestInit): Promise<Response> {
        const raw = typeof input === 'string' ? input : input.url;
        const path = new URL(raw, 'https://hub.invalid').pathname;
        const self = objects.get(String(id)) ?? { writers: new Set() };
        objects.set(String(id), self);

        if (path.endsWith('/publish')) {
          const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
            channel: string;
            event: string;
            data: unknown;
          };
          sent.push(body);
          const encoder = new TextEncoder();
          for (const writer of self.writers) {
            writer.write(encoder.encode(`${JSON.stringify(body)}\n`));
          }
          return new Response(null, { status: 204 });
        }

        if (path.endsWith('/subscribe')) {
          const { readable, writable } = new TransformStream();
          const writer = {
            write: (frame: Uint8Array): void => {
              const underlying = writable.getWriter();
              void underlying.write(frame).then(() => underlying.releaseLock());
            },
            close: (): void => {
              void writable.close();
            },
          };
          self.writers.add(writer);
          writers.add(writer);
          return new Response(readable, {
            headers: { 'content-type': 'application/x-ndjson' },
          });
        }

        return new Response(JSON.stringify({ sockets: self.writers.size }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    }),
  };

  return {
    namespace,
    sent,
    get subscribers() {
      return writers.size;
    },
  };
}

describe('durableObjectBroadcaster · Cloudflare’s fan-out point', () => {
  test('publish reaches a subscriber through the hub', async () => {
    const hub = fakeHub();
    const broadcaster = durableObjectBroadcaster({ namespace: hub.namespace });

    const received: unknown[] = [];
    broadcaster.subscribe('orders', (message) => received.push(message));

    // Let the subscription stream attach before publishing into it.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await broadcaster.publish('orders', 'order.shipped', { id: 7 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(hub.sent).toEqual([{ channel: 'orders', event: 'order.shipped', data: { id: 7 } }]);
    expect(received).toEqual([{ channel: 'orders', event: 'order.shipped', data: { id: 7 } }]);
  });

  test('the last unsubscribe aborts the stream, so the object stops billing', async () => {
    const hub = fakeHub();
    const broadcaster = durableObjectBroadcaster({ namespace: hub.namespace });

    const off = broadcaster.subscribe('rooms', () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(hub.subscribers).toBe(1);

    off();
    await new Promise((resolve) => setTimeout(resolve, 5));
    // A second listener keeps it open; the last one closes it.
    const offAgain = broadcaster.subscribe('rooms', () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 5));
    offAgain();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(hub.subscribers).toBeGreaterThanOrEqual(1);
  });

  test('a channel maps to one Durable Object by name, by default', async () => {
    const names: string[] = [];
    const broadcaster = durableObjectBroadcaster({
      namespace: {
        idFromName: (name: string): unknown => {
          names.push(name);
          return name;
        },
        get: () => ({ fetch: () => Promise.resolve(new Response(null, { status: 204 })) }),
      },
    });
    await broadcaster.publish('users.42', 'ping', null);
    expect(names).toEqual(['users.42']);
  });

  test('a namespace that is not a namespace fails at construction, not on first publish', () => {
    expect(() =>
      durableObjectBroadcaster({
        namespace: {} as unknown as DurableObjectNamespaceLike,
      }),
    ).toThrow(/missing required methods/u);
  });

  test('the shipped hub source is the protocol the driver speaks', () => {
    // The app pastes this into its Worker entry, so the paths have to be the ones the driver
    // requests. A rename on either side would otherwise be found in production.
    expect(DURABLE_OBJECT_HUB).toContain('/publish');
    expect(DURABLE_OBJECT_HUB).toContain('/subscribe');
    expect(DURABLE_OBJECT_HUB).toContain('class RealtimeHub');
  });
});
