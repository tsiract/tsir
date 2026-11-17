/**
 * @tsir/broadcast — real-time channels (Echo + Reverb equivalent).
 *
 * A `Broadcaster` sends messages to channels. A `Channel` is a pub/sub topic
 * scoped by name. Drivers:
 *   · `memoryBroadcaster` — in-process pub/sub (dev/tests).
 *   · `redisBroadcaster`  — Redis pub/sub (multi-process).
 *
 * The WebSocket server (`createWebSocketServer`) accepts connections,
 * authenticates them via a callback, and subscribes them to channels. A
 * client-side `Echo`-style helper is also provided for browser use.
 */

/**
 * The broadcasters this build ships, by the name a `tsir.js` writes.
 *
 * `memory` and `redis`/`pusher` are process- and vendor-shaped; `durable-object` is Cloudflare's
 * fan-out point and the only one that works on Workers at all, because there is no process there
 * to hold a listener list.
 */
export const BROADCAST_DRIVERS = ['memory', 'redis', 'pusher', 'durable-object'] as const;

export type BroadcastDriverName = (typeof BROADCAST_DRIVERS)[number];

export interface BroadcastMessage {
  channel: string;
  event: string;
  data: unknown;
}

export interface ChannelSubscriber {
  (msg: BroadcastMessage): void;
}

export interface Broadcaster {
  publish(channel: string, event: string, data: unknown): Promise<void>;
  subscribe(channel: string, fn: ChannelSubscriber): () => void;
}

export function memoryBroadcaster(): Broadcaster {
  const channels = new Map<string, Set<ChannelSubscriber>>();

  return {
    async publish(channel, event, data) {
      const subs = channels.get(channel);
      if (subs === undefined) return;
      const msg: BroadcastMessage = { channel, event, data };
      for (const fn of subs) fn(msg);
    },
    subscribe(channel, fn) {
      let subs = channels.get(channel);
      if (subs === undefined) {
        subs = new Set();
        channels.set(channel, subs);
      }
      subs.add(fn);
      return () => {
        subs?.delete(fn);
        if (subs?.size === 0) channels.delete(channel);
      };
    },
  };
}
