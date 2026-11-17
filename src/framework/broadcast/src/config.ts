/**
 * `broadcast.driver` in `tsir.js` — the registry half of `@tsir/broadcast` (`CAP-006`).
 *
 * Every other capability that resolves a driver from config has the same three parts — a
 * `*_DRIVERS` constant, a `driverFor` switch, and a `*FromConfig` builder — and this package had
 * the constant and the drivers but no way to name one from a file. A project therefore wired its
 * broadcaster in `app.ts`, which meant `tsir doctor` could not report it and a production guard
 * had nowhere to live.
 *
 * The shape is deliberately the same as `@tsir/cache`'s, down to the error code: a reader who has
 * read one registry has read all of them, and a typo in any of them produces the same
 * `CAP_DRIVER_MISSING` with the same "here is what this build ships" hint.
 *
 *   ```ts
 *   // config/broadcast.ts
 *   export default { driver: 'durable-object', connection: 'realtime' };
 *   ```
 *
 * **`memory` is refused in production.** It is the one driver whose subscriber list lives in the
 * isolate, so on Workers it publishes into an array nobody else can see — and it is the driver
 * that leaks (`INF-009`). Allowing it as a production default would be the exact failure the
 * per-target defaults table exists to prevent.
 */

import { TsirError } from '@tsir/container';

import { BROADCAST_DRIVERS, memoryBroadcaster, type Broadcaster } from './broadcaster.ts';
import { durableObjectBroadcaster, type DurableObjectNamespaceLike } from './durable-object.ts';
import { pusherBroadcaster, type PusherLike } from './pusher.ts';
import { redisBroadcaster, type RedisPubSubClient } from './redis.ts';

export type BroadcastDriverName = (typeof BROADCAST_DRIVERS)[number];

/** One `broadcast` block, as configuration sees it. */
export interface ConfiguredBroadcast {
  /**
   * As written in `tsir.js`. Typed `string`, not `BroadcastDriverName`: config is user data that
   * reaches the registry at run time, and an unknown name must fail with a coded error listing
   * what this build ships rather than being rejected as a type error nobody could have written.
   */
  readonly driver: string;
  /** `redis`/`durable-object`: which binding from `bindings`. Default `default`. */
  readonly connection?: string | undefined;
  /** `redis`: keyspace prefix. Default `tsir:broadcast:`. */
  readonly prefix?: string | undefined;
}

export interface BroadcastBindings {
  /** Connection name → a Redis pub/sub client. Required by `driver: 'redis'`. */
  readonly redis?: Readonly<Record<string, RedisPubSubClient>> | undefined;
  /** Connection name → a Durable Object namespace. Required by `driver: 'durable-object'`. */
  readonly realtime?: Readonly<Record<string, DurableObjectNamespaceLike>> | undefined;
  /** Connection name → a Pusher-shaped client. Required by `driver: 'pusher'`. */
  readonly pusher?: Readonly<Record<string, PusherLike>> | undefined;
}

const KIND = 'capability';

function driverMissing(driver: string): TsirError {
  return new TsirError(
    'CAP_DRIVER_MISSING',
    `broadcast names driver "${driver}", which is not registered`,
    {
      kind: KIND,
      hint: `set broadcast.driver to one of: ${BROADCAST_DRIVERS.join(', ')}`,
      context: { driver },
    },
  );
}

function bindingMissing(driver: string, connection: string, expected: string): TsirError {
  return new TsirError(
    'CAP_DRIVER_MISSING',
    `broadcast: the "${driver}" driver has no \`${expected}.${connection}\` binding`,
    {
      kind: KIND,
      hint: `pass the client or namespace in \`bindings.${expected}.${connection}\` — the driver only needs the methods it documents`,
      context: { driver, connection },
    },
  );
}

/** `memory` in production is a subscriber list that dies with the isolate. */
function forbiddenInProduction(driver: string, why: string): TsirError {
  return new TsirError(
    'CAP_FORBIDDEN_IN_PRODUCTION',
    `broadcast driver "${driver}" cannot be the production broadcaster`,
    { kind: KIND, hint: why, context: { driver } },
  );
}

/** Build one broadcaster from its configuration. The only place a driver name becomes code. */
export function broadcasterFor(
  config: ConfiguredBroadcast,
  bindings: BroadcastBindings = {},
  options: { readonly production?: boolean | undefined } = {},
): Broadcaster {
  const connection = config.connection ?? 'default';

  switch (config.driver) {
    case 'memory': {
      if (options.production === true) {
        throw forbiddenInProduction(
          'memory',
          'its subscribers live in the process, so a message published on one isolate reaches nobody; use `durable-object` on Workers, `redis` on Bun or Lambda',
        );
      }
      return memoryBroadcaster();
    }

    case 'redis': {
      const client = bindings.redis?.[connection];
      if (client === undefined) {
        throw bindingMissing('redis', connection, 'redis');
      }
      return redisBroadcaster({
        client,
        ...(config.prefix === undefined ? {} : { prefix: config.prefix }),
      });
    }

    case 'pusher': {
      const client = bindings.pusher?.[connection];
      if (client === undefined) {
        throw bindingMissing('pusher', connection, 'pusher');
      }
      return pusherBroadcaster({ client });
    }

    case 'durable-object': {
      const namespace = bindings.realtime?.[connection];
      if (namespace === undefined) {
        throw bindingMissing('durable-object', connection, 'realtime');
      }
      return durableObjectBroadcaster({ namespace });
    }

    default:
      throw driverMissing(config.driver);
  }
}

/**
 * Build the registry from `tsir.js`.
 *
 * No `broadcast` block is the development case: `memory`, because `make dev` must need no account
 * and no second process. `production: true` refuses it — a project that booted into production
 * with no broadcaster configured would publish into nothing and report success.
 */
export function broadcasterFromConfig(options: {
  readonly broadcast?: ConfiguredBroadcast | undefined;
  readonly bindings?: BroadcastBindings | undefined;
  readonly production?: boolean | undefined;
}): Broadcaster {
  const config = options.broadcast ?? { driver: 'memory' };
  return broadcasterFor(
    config,
    options.bindings ?? {},
    options.production === undefined ? {} : { production: options.production },
  );
}
