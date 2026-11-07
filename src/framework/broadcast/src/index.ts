/**
 * @tsir/broadcast — real-time channels.
 *
 * ```ts
 * import { createBroadcastBootstrap, memoryBroadcaster } from '@tsir/broadcast';
 *
 * const { broadcaster } = createBroadcastBootstrap();
 * broadcaster.subscribe('orders', (msg) => console.log(msg));
 * await broadcaster.publish('orders', 'created', { id: 1 });
 * ```
 */

export {
  memoryBroadcaster,
  type BroadcastMessage,
  type Broadcaster,
  type ChannelSubscriber,
} from './broadcaster.ts';

export { redisBroadcaster, type RedisBroadcasterOptions, type RedisPubSubClient } from './redis.ts';

export { pusherBroadcaster, type PusherBroadcasterOptions, type PusherLike } from './pusher.ts';

export {
  createWebSocketHandler,
  type AuthorizeResult,
  type PresenceMember,
  type WebSocketConnection,
  type WebSocketPrincipal,
  type WebSocketServerOptions,
} from './websocket.ts';

export {
  createEcho,
  type EchoChannel,
  type EchoOptions,
  type EchoPresenceChannel,
  type EchoPrivateChannel,
} from './echo.ts';

export { createBroadcastBootstrap } from './bootstrap.ts';
export type { BroadcastBootstrap, BroadcastBootstrapOptions } from './bootstrap.ts';
