/**
 * `cache.stores` in `tsir.js` (`CACHE-10`, `§ 2.2`).
 *
 * The registry already knows how to validate a store list; this module is the half that
 * knows how to **build** one from configuration, which means two things the runtime registry
 * deliberately does not:
 *
 *   · **A driver is named by string**, so an unknown name is a real possibility and gets
 *     `CAP_DRIVER_MISSING` listing what this build does declare — not a `TypeError` from a
 *     lookup table.
 *   · **Some drivers need something only the application can supply**: a `CacheSql` for
 *     `database`, a namespace for `cloudflare-kv`, a client for `redis` (ADR-0027 § 1).
 *     Those arrive through `bindings`, and a missing one names the store *and* the binding.
 *
 * `memory` and `null` need nothing, which is what makes `tsir cache:probe` runnable in a
 * fresh project before any of this is wired up.
 */

import { clientContract, driverMissing } from './errors.ts';
import { cloudflareKvDriver, type KvNamespaceLike } from './drivers/cloudflare-kv.ts';
import { databaseDriver, type CacheSql } from './drivers/database.ts';
import { memoryDriver } from './drivers/memory.ts';
import { nullDriver } from './drivers/null.ts';
import { redisDriver, type RedisLike } from './drivers/redis.ts';
import type { CacheDriver, Codec } from './port.ts';
import { createCaches, defineStore, type Caches } from './stores.ts';

/** The drivers this build knows, by the name a `tsir.js` writes. */
export const CACHE_DRIVERS = ['memory', 'null', 'database', 'redis', 'cloudflare-kv'] as const;

export type CacheDriverName = (typeof CACHE_DRIVERS)[number];

/** One entry of `cache.stores`, as configuration sees it. */
export interface ConfiguredStore {
  /**
   * The driver name as written in `tsir.js`. Typed as `string`, not `CacheDriverName`: the
   * config is user data that reaches the registry at run time, and an unknown name must fail
   * with `CAP_DRIVER_MISSING` listing the shipped drivers — not be rejected by the type
   * checker as if nobody could ever write it.
   */
  readonly driver: string;
  /** `database`: which connection, when `bindings.databases` holds several. */
  readonly connection?: string | undefined;
  readonly table?: string | undefined;
  readonly tagTable?: string | undefined;
  readonly prefix?: string | undefined;
  /** Round a too-short TTL up to the backend's floor instead of refusing (`cloudflare-kv`). */
  readonly roundTtlUp?: boolean | undefined;
  readonly ttlMs?: number | undefined;
  readonly required?: boolean | undefined;
}

export interface CacheBindings {
  /** Connection name → a `CacheSql`. Required by `driver: 'database'`. */
  readonly databases?: Readonly<Record<string, CacheSql>> | undefined;
  /** Required by `driver: 'cloudflare-kv'`. */
  readonly kv?: Readonly<Record<string, KvNamespaceLike>> | undefined;
  /** Required by `driver: 'redis'`. */
  readonly redis?: Readonly<Record<string, RedisLike>> | undefined;
}

export interface BuildCachesOptions {
  readonly cache?:
    | {
        readonly default?: string | undefined;
        readonly stores?: Readonly<Record<string, ConfiguredStore>> | undefined;
      }
    | undefined;
  readonly bindings?: CacheBindings | undefined;
  /** Refuse an ephemeral default (and every `required` store) — production only. */
  readonly production?: boolean | undefined;
  /** Per-store codecs. A store without one gets `json`. */
  readonly codecs?: Readonly<Record<string, Codec<unknown>>> | undefined;
}

function bindingFor<B>(
  name: string,
  store: string,
  binding: string,
  bindings: Record<string, B> | undefined,
): B {
  const found = bindings?.[name];
  if (found === undefined) {
    throw driverMissing(
      store,
      `a ${binding} binding named "${name}"`,
      `pass \`${binding}s: { ${name}: … }\` to createCaches`,
    );
  }
  return found;
}

/** Build one driver from its configuration. The only place a driver name becomes code. */
export function driverFor(
  store: string,
  definition: ConfiguredStore,
  bindings: CacheBindings = {},
): CacheDriver<never> {
  switch (definition.driver) {
    case 'memory':
      return memoryDriver();
    case 'null':
      return nullDriver();
    case 'database':
      return databaseDriver({
        database: bindingFor(
          definition.connection ?? 'default',
          store,
          'database',
          bindings.databases as Record<string, CacheSql> | undefined,
        ),
        ...(definition.table === undefined ? {} : { table: definition.table }),
        ...(definition.tagTable === undefined ? {} : { tagTable: definition.tagTable }),
      });
    case 'redis':
      return redisDriver({
        client: bindingFor(
          definition.connection ?? 'default',
          store,
          'redis',
          bindings.redis as Record<string, RedisLike> | undefined,
        ),
        ...(definition.prefix === undefined ? {} : { prefix: definition.prefix }),
      });
    case 'cloudflare-kv':
      return cloudflareKvDriver({
        namespace: bindingFor(
          definition.connection ?? 'default',
          store,
          'kv',
          bindings.kv as Record<string, KvNamespaceLike> | undefined,
        ),
        ...(definition.roundTtlUp === true ? { roundTtlUp: true } : {}),
      });
    default: {
      // A driver name this build does not ship: list the ones it does.
      const declared = CACHE_DRIVERS.join(', ');
      throw clientContract(store, String(definition.driver), [`one of ${declared}`]);
    }
  }
}

/**
 * Build the registry a command or an app uses.
 *
 * Validation order matters and is deliberate: names and the default first (so a typo is one
 * clear message), then the drivers. An unknown default is reported before any driver is
 * constructed, because "cache.default is not a store" is the error a person can fix from the
 * message alone.
 */
export function cachesFromConfig(options: BuildCachesOptions): Caches {
  const declared = options.cache?.stores ?? {};
  const names = Object.keys(declared);

  if (names.length === 0) {
    // No configuration at all is the one case that gets a default: a development store, so a
    // fresh project can run its tests before anyone decides anything.
    return createCaches({
      default: 'default',
      stores: { default: defineStore({ driver: memoryDriver() }) },
      ...(options.production === true ? { production: true } : {}),
    }) as unknown as Caches;
  }

  const stores: Record<string, ReturnType<typeof defineStore<unknown, never>>> = {};
  for (const name of names) {
    const definition = declared[name];
    if (definition === undefined) continue;
    const codec = options.codecs?.[name];
    stores[name] = defineStore({
      driver: driverFor(name, definition, options.bindings),
      ...(codec === undefined ? {} : { codec }),
      ...(definition.ttlMs === undefined ? {} : { ttlMs: definition.ttlMs }),
      ...(definition.required === true ? { required: true } : {}),
    });
  }

  const fallbackDefault = names[0];
  const chosen = options.cache?.default ?? fallbackDefault;
  if (chosen === undefined) throw driverMissing('(none)', 'no stores', '@tsir/cache');

  return createCaches({
    default: chosen,
    stores,
    ...(options.production === true ? { production: true } : {}),
  }) as unknown as Caches;
}
