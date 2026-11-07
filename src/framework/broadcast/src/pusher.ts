/**
 * `pusherBroadcaster` — Pusher Channels driver.
 *
 * Pusher does the same app-supplied-client rule as the redis driver: no SDK dependency. The app
 * passes a `PusherLike` client whose `trigger` method knows how to push an event to one or more
 * channels (the Pusher REST API or a local SDK).
 *
 * Pusher channels and presence channels use the channel name as given; the broadcaster does not prefix. The
 * authorize callback on the websocket server is what gates membership and presence auth.
 */

import type { Broadcaster } from './broadcaster.ts';

/** The slice of a Pusher client this driver needs. */
export interface PusherLike {
  /** Trigger an event on one or more channels. */
  trigger(channel: string | readonly string[], event: string, data: unknown): Promise<unknown>;
}

export interface PusherBroadcasterOptions {
  readonly client: PusherLike;
}

export function pusherBroadcaster(options: PusherBroadcasterOptions): Broadcaster {
  const { client } = options;

  if (typeof client.trigger !== 'function') {
    throw new TypeError('pusher broadcaster client is missing required method: trigger');
  }

  return {
    async publish(channel, event, data) {
      await client.trigger(channel, event, data);
    },
    subscribe() {
      // Pusher delivers to a websocket directly: the server only publishes. Subscribing server-side
      // is a no-op — clients listen over the Pusher socket.
      return () => {};
    },
  };
}
