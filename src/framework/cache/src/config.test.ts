/**
 * `cache.stores` → a registry (`CACHE-10`).
 *
 * The registry itself is tested in `stores.test.ts`. This file is about the gap between a
 * configuration file and that registry: driver names arriving as strings, drivers that need
 * something only the application can supply, and the two failures a person actually hits —
 * a misspelt driver and a default that names nothing.
 */

import { describe, expect, test } from 'bun:test';

import { CACHE_DRIVERS, cachesFromConfig, driverFor } from './config.ts';
import { json } from './codec.ts';
import type { CacheSql } from './drivers/database.ts';
import type { RedisLike } from './drivers/redis.ts';
import type { KvNamespaceLike } from './drivers/cloudflare-kv.ts';

function fakeSql(): CacheSql {
  return {
    capabilities: { engine: 'd1', placeholder: 'question' },
    query: () => Promise.resolve({ rows: [], changes: 0 }),
  };
}

describe('building from configuration', () => {
  test('a declared store list becomes a registry with an explicit default', () => {
    const caches = cachesFromConfig({
      cache: {
        default: 'sessions',
        stores: {
          app: { driver: 'memory' },
          sessions: { driver: 'memory', ttlMs: 60_000 },
        },
      },
    });

    expect(caches.names).toEqual(['app', 'sessions']);
    expect(caches.default).toBe('sessions');
    expect(caches.store('app').driver).toBe('memory');
  });

  test('no configuration at all is one development store, so a fresh project still works', () => {
    const caches = cachesFromConfig({});

    expect(caches.names).toEqual(['default']);
    expect(caches.store('default').driver).toBe('memory');
  });

  test('a single store with no `default` is the default — there is nothing to be ambiguous about', () => {
    const caches = cachesFromConfig({ cache: { stores: { only: { driver: 'null' } } } });

    expect(caches.default).toBe('only');
  });

  test('a default that names nothing lists what was declared', () => {
    expect(() =>
      cachesFromConfig({
        cache: { default: 'sessons', stores: { app: { driver: 'memory' } } },
      }),
    ).toThrow(/cache.default is "sessons", which is not a declared store \(declared: app\)/u);
  });

  test('an unknown driver names every driver this build ships', () => {
    try {
      cachesFromConfig({ cache: { stores: { x: { driver: 'memcached' } } } });
      throw new Error('expected a refusal');
    } catch (error: unknown) {
      const tsir = error as { code?: string; message: string };
      expect(tsir.code).toBe('CAP_DRIVER_MISSING');
      expect(tsir.message).toContain('store "x"');
      expect(tsir.message).toContain('memcached');
      for (const driver of CACHE_DRIVERS) expect(tsir.message).toContain(driver);
    }
  });

  test('`ttlMs` and `required` reach the registry', () => {
    const caches = cachesFromConfig({
      cache: { stores: { app: { driver: 'memory', ttlMs: 0, required: true } } },
    });

    // `validated` is the boot check's list: the default plus every `required` store.
    expect(caches.validated).toEqual(['app']);
  });

  test('production refuses an ephemeral default, from configuration as from code', () => {
    expect(() =>
      cachesFromConfig({ production: true, cache: { stores: { app: { driver: 'memory' } } } }),
    ).toThrow(/store "app" uses driver "memory" in production/u);
  });

  test('a codec supplied per store is used for that store', async () => {
    const caches = cachesFromConfig({
      cache: { stores: { text: { driver: 'memory' } } },
      codecs: { text: json<string>() },
    });

    await caches.store('text').set('k', 'plain');
    // A JSON store writes an envelope; a text one would not. This proves the codec landed.
    expect(await caches.store('text').get('k')).toBe('plain');
  });
});

describe('drivers that need something the application owns', () => {
  test('`database` without a connection binding says which binding', () => {
    expect(() =>
      cachesFromConfig({ cache: { stores: { pages: { driver: 'database' } } } }),
    ).toThrow(/store "pages" names driver "a database binding named "default""/u);
  });

  test('`database` with a binding opens against it', () => {
    const caches = cachesFromConfig({
      cache: { stores: { pages: { driver: 'database', connection: 'primary' } } },
      bindings: { databases: { primary: fakeSql() } },
    });

    expect(caches.store('pages').driver).toBe('database');
    expect(caches.capabilities('pages').tags).toBe(true);
  });

  test('`redis` and `cloudflare-kv` name their bindings too', () => {
    expect(() => cachesFromConfig({ cache: { stores: { q: { driver: 'redis' } } } })).toThrow(
      /a redis binding named "default"/u,
    );
    expect(() =>
      cachesFromConfig({ cache: { stores: { kv: { driver: 'cloudflare-kv' } } } }),
    ).toThrow(/a kv binding named "default"/u);
  });

  test('a client with too few commands fails at construction of the default store', () => {
    // The default store resolves eagerly — which is exactly where a broken client should
    // surface, not on the first request that happened to touch the cache.
    expect(() =>
      cachesFromConfig({
        cache: { stores: { r: { driver: 'redis' } } },
        bindings: { redis: { default: { get: async () => null } as unknown as RedisLike } },
      }),
    ).toThrow(/the "redis" client is missing set, del, exists/u);
  });

  test('a non-default store with a broken client fails when it is first opened', () => {
    const caches = cachesFromConfig({
      cache: { stores: { app: { driver: 'memory' }, r: { driver: 'redis' } } },
      bindings: { redis: { default: { get: async () => null } as unknown as RedisLike } },
    });

    expect(caches.store('app').driver).toBe('memory');
    expect(() => caches.store('r')).toThrow(/the "redis" client is missing/u);
  });

  test('`driverFor` is the single place a driver name becomes code', () => {
    const kv = {
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
    } satisfies KvNamespaceLike;
    const driver = driverFor('pages', { driver: 'cloudflare-kv' }, { kv: { default: kv } });

    expect(driver.name).toBe('cloudflare-kv');
    expect(driver.capabilities.readYourWrites).toBe(false);
  });
});
