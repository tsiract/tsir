/**
 * `redisBroadcaster` — Redis pub/sub driver.
 *
 * Follows the same app-supplied-client rule as `@tsir/cache`'s redis driver
 * (ADR-0027 § 1): no Redis client is a dependency. The app passes a client
 * that knows `publish/subscribe/unsubscribe` and emits `message` events. The
 * broadcaster owns the lifecycle of the Redis subscription per channel: the first local
 * subscriber opens it, the last closes it.
 *
 * Two connections. The client must support the handful of commands it actually uses:
 *
 *   · `publish(channel, message)`
 *   · `subscribe(channel)` / `unsubscribe(channel)`
 *   · `on('message', (channel, message) => void)` (and `off`)
 *
 * A client missing any of those is a startup error, not a runtime TypeError on first use.
 */

import type { BroadcastMessage, Broadcaster, ChannelSubscriber } from './broadcaster.ts';

/** The slice of a Redis client this driver needs. */
export interface RedisPubSubClient {
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  on(event: 'message', listener: (channel: string, message: string) => void): void;
  off?(event: 'message', listener: (channel: string, message: string) => void): void;
}

export interface RedisBroadcasterOptions {
  readonly client: RedisPubSubClient;
  /** Default `tsir:broadcast:`; one Redis is usually shared with other things. */
  readonly prefix?: string | undefined;
}

const REQUIRED: readonly (keyof RedisPubSubClient)[] = [
  'publish',
  'subscribe',
  'unsubscribe',
  'on',
];

export function redisBroadcaster(options: RedisBroadcasterOptions): Broadcaster {
  const prefix = options.prefix ?? 'tsir:broadcast:';
  const { client } = options;

  const missing = REQUIRED.filter((name) => typeof client[name] !== 'function');
  if (missing.length > 0) {
    throw new TypeError(
      `redis broadcaster client is missing required methods: ${missing.join(', ')}`,
    );
  }

  /** Local subscribers keyed by channel name (without the Redis prefix). */
  const channels = new Map<string, Set<ChannelSubscriber>>();

  /** The single `message` listener registered once, dispatch by channel. */
  const onMessage = (redisChannel: string, message: string): void => {
    if (!redisChannel.startsWith(prefix)) return;
    const channel = redisChannel.slice(prefix.length);
    const subs = channels.get(channel);
    if (subs === undefined || subs.size === 0) return;
    let msg: BroadcastMessage;
    try {
      // The app controls the wire format; a malformed frame is dropped.
      msg = JSON.parse(message) as BroadcastMessage;
    } catch {
      return;
    }
    for (const fn of subs) fn(msg);
  };
  client.on('message', onMessage);

  return {
    async publish(channel, event, data) {
      const msg: BroadcastMessage = { channel, event, data };
      await client.publish(`${prefix}${channel}`, JSON.stringify(msg));
    },
    subscribe(channel, fn) {
      let subs = channels.get(channel);
      if (subs === undefined) {
        subs = new Set();
        channels.set(channel, subs);
        // Open the Redis subscription when the first local subscriber arrives.
        void client.subscribe(`${prefix}${channel}`);
      }
      subs.add(fn);
      return () => {
        const current = channels.get(channel);
        if (current === undefined) return;
        current.delete(fn);
        if (current.size === 0) {
          channels.delete(channel);
          void client.unsubscribe(`${prefix}${channel}`);
        }
      };
    },
  };
}
