/**
 * The registry and the port (`CAP-001`, `CAP-002`).
 *
 * Three things are under test here, in this order of importance:
 *
 *   1. **Refusals.** An unknown name, a capability the driver lacks, an ephemeral driver as a
 *      production default. Each has a code and names the store *and* its driver, because the
 *      message is the feature.
 *   2. **Serialization is explicit.** A store decodes with the codec it was declared with;
 *      a payload written by someone else's codec is `CAP_CODEC_FAILED`, not `undefined`.
 *   3. **The happy path**, including TTL, tags and atomic increment on the memory driver.
 */

import { describe, expect, test } from 'bun:test';

import { json, text } from './codec.ts';
import { MEMORY_CAPABILITIES, memoryDriver } from './drivers/memory.ts';
import { nullDriver } from './drivers/null.ts';
import { createCache } from './store.ts';
import { assertRequirements, checkRequirements, createCaches, defineStore } from './stores.ts';
import type { CacheDriver, Codec } from './port.ts';

/** A driver that claims durability, for the production guard only. */
function durableDriver(): CacheDriver<never> {
  const inner = memoryDriver();
  return {
    name: 'durable',
    capabilities: { ...MEMORY_CAPABILITIES, persistent: true },
    open: (config?: never) => inner.open(config),
  };
}

interface Session {
  readonly userId: string;
  readonly role: 'admin' | 'user';
}

/** A clock the test owns, so TTL assertions never sleep. */
function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, advance: (ms) => (current += ms) };
}

function registry(options: { production?: boolean; required?: boolean; ttlMs?: number } = {}) {
  const time = clock();
  const caches = createCaches({
    default: 'app',
    ...(options.production === undefined ? {} : { production: options.production }),
    stores: {
      app: defineStore({
        driver: memoryDriver({ now: time.now }),
        codec: json<Session>(),
        ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
      }),
      counter: defineStore({
        driver: memoryDriver({ now: time.now }),
        codec: text(),
        ...(options.required === true ? { required: true } : {}),
      }),
      off: defineStore({ driver: nullDriver(), codec: text() }),
    },
  });
  return { caches, time };
}

describe('the registry', () => {
  test('names are declared order, and the default is explicit', () => {
    const { caches } = registry();

    expect(caches.names).toEqual(['app', 'counter', 'off']);
    expect(caches.default).toBe('app');
    expect(caches.defaultCache.name).toBe('app');
  });

  test('an unknown store is a named error that lists what exists', () => {
    const { caches } = registry();

    expect(() => caches.store('sessons' as 'app')).toThrow(/unknown cache store "sessons"/u);
    expect(() => caches.store('sessons' as 'app')).toThrow(/declared: app, counter, off/u);
    try {
      caches.store('sessons' as 'app');
    } catch (error: unknown) {
      const tsir = error as { code?: string; hint?: string; context?: Record<string, unknown> };
      expect(tsir.code).toBe('CAP_UNKNOWN_STORE');
      expect(tsir.hint).toContain('never falls back to the default');
      expect(tsir.context?.['store']).toBe('sessons');
    }
  });

  test('no stores, or a default nobody declared, fails at construction', () => {
    // `default` cannot even be typed against an empty registry, which is the point.
    expect(() => createCaches({ default: 'app' as never, stores: {} })).toThrow(/no cache stores/u);
    expect(() =>
      createCaches({
        default: 'nope' as 'app',
        stores: { app: defineStore({ driver: nullDriver() }) },
      }),
    ).toThrow(/cache.default is "nope"/u);
  });

  test('the store carries its driver name and capabilities — no per-driver guessing', () => {
    const { caches } = registry();

    expect(caches.store('app').driver).toBe('memory');
    expect(caches.capabilities('app')).toEqual({
      persistent: false,
      sharedAcrossInstances: false,
      readYourWrites: true,
      tags: true,
      increment: true,
      ttl: true,
      clearAll: true,
      locks: true,
    });
    expect(caches.capabilities('off').increment).toBe(false);
  });
});

describe('boot validation (CAP-002)', () => {
  test('only the default and the `required` stores are validated at boot', () => {
    const { caches } = registry({ required: true });

    expect(caches.validated).toEqual(['app', 'counter']);
  });

  test('backends open lazily: a dozen stores is not a dozen connections', () => {
    const { caches } = registry();

    // The default resolves eagerly (a broken default must fail at boot, not at request one),
    // and nothing else does.
    expect(caches.isOpen('app')).toBe(true);
    expect(caches.isOpen('counter')).toBe(false);
    expect(caches.isOpen('off')).toBe(false);

    caches.store('counter');
    expect(caches.isOpen('counter')).toBe(true);
  });

  test('an ephemeral driver as the production default is refused, naming the reason', () => {
    expect(() => registry({ production: true })).toThrow(/uses driver "memory" in production/u);
    try {
      registry({ production: true });
    } catch (error: unknown) {
      const tsir = error as { code?: string; context?: Record<string, unknown> };
      expect(tsir.code).toBe('CAP_FORBIDDEN_IN_PRODUCTION');
      expect(tsir.context?.['driver']).toBe('memory');
    }
  });

  test('a `required` ephemeral store is refused in production — a local one is not', () => {
    const production = (required: boolean): unknown =>
      createCaches({
        default: 'durable',
        production: true,
        stores: {
          durable: defineStore({ driver: durableDriver() }),
          sessions: defineStore({
            driver: memoryDriver(),
            ...(required ? { required: true } : {}),
          }),
        },
      });

    // A `local` store production never resolves is allowed — that is what keeps people from
    // faking a database in local development.
    expect(() => production(false)).not.toThrow();
    expect(() => production(true)).toThrow(/store "sessions" uses driver "memory" in production/u);
  });

  test('requirements are reported all at once, then thrown one at a time', () => {
    const { caches } = registry();

    const problems = checkRequirements(caches, [
      { store: 'off', tags: true, increment: true },
      { store: 'app', persistent: true },
      { store: 'ghost', tags: true },
    ]);

    // Both missing capabilities of one store are reported, not just the first: a boot report
    // that lists every problem saves a restart per problem.
    expect(problems).toHaveLength(4);
    expect(problems[0]?.detail).toContain('store "off" (driver "null") requires tags');
    expect(problems[1]?.detail).toContain('store "off" (driver "null") requires increment');
    expect(problems[2]?.detail).toContain('store "app" (driver "memory") requires persistent');
    expect(problems[3]?.detail).toContain('unknown cache store "ghost"');

    expect(() => assertRequirements(caches, [{ store: 'off', tags: true }])).toThrow(
      /CAP_UNSUPPORTED_OPERATION|does not support/u,
    );
  });

  test('a satisfied requirement block passes', () => {
    const { caches } = registry();

    expect(checkRequirements(caches, [{ store: 'app', tags: true, increment: true }])).toEqual([]);
    expect(() =>
      assertRequirements(caches, [{ store: 'app', readYourWrites: true }]),
    ).not.toThrow();
  });
});

describe('the port, on a real store', () => {
  test('a value round-trips through its declared codec', async () => {
    const { caches } = registry();
    const store = caches.store('app');

    await store.set('u:1', { userId: 'u1', role: 'admin' });

    expect(await store.get('u:1')).toEqual({ userId: 'u1', role: 'admin' });
    expect(await store.has('u:1')).toBe(true);
    expect(await store.has('u:2')).toBe(false);
  });

  test('delete reports whether the key existed', async () => {
    const { caches } = registry();
    const store = caches.store('counter');

    await store.set('k', 'v');

    expect(await store.delete('k')).toBe(true);
    expect(await store.delete('k')).toBe(false);
  });

  test('a TTL expires against the driver clock, and the expired entry is gone', async () => {
    const { caches, time } = registry();
    const store = caches.store('app');

    await store.set('page', { userId: 'u', role: 'user' }, { ttlMs: 1_000 });
    time.advance(999);
    expect(await store.get('page')).toBeDefined();

    time.advance(1);
    expect(await store.get('page')).toBeUndefined();
    // Removal happens on read, so a driver without a sweeper still stops answering.
    expect(await store.has('page')).toBe(false);
  });

  test('a store-level TTL is the default, and a per-call TTL wins', async () => {
    const { caches, time } = registry({ ttlMs: 5_000 });
    const store = caches.store('app');

    await store.set('a', { userId: 'u', role: 'user' });
    await store.set('b', { userId: 'u', role: 'user' }, { ttlMs: 10 });

    time.advance(11);
    expect(await store.get('b')).toBeUndefined();
    expect(await store.get('a')).toBeDefined();
  });

  test('remember computes once and caches the result', async () => {
    const { caches } = registry();
    // A JSON store, so `remember` can prove the generic flows from the declaration.
    const store = caches.store('app');
    let computed = 0;
    const compute = (): Promise<Session> => {
      computed += 1;
      return Promise.resolve({ userId: 'u1', role: 'user' });
    };

    expect((await store.remember('u:1', 1_000, compute)).userId).toBe('u1');
    expect((await store.remember('u:1', 1_000, compute)).userId).toBe('u1');
    expect(computed).toBe(1);
  });

  test('increment is atomic, and an incremented key still reads back', async () => {
    const { caches } = registry();
    const store = caches.store('counter');

    await store.set('hits', '5');

    expect(await store.increment('hits')).toBe(6);
    expect(await store.increment('hits', 10)).toBe(16);
    expect(await store.increment('fresh')).toBe(1);
    // The counter codec is why this line works at all: a bare integer written by the driver
    // would not decode through the store's codec.
    expect(await store.get('hits')).toBe('16');
  });

  test('tags are a real index: invalidating one removes only its entries', async () => {
    const { caches } = registry();
    const store = caches.store('app');

    await store.set('u:1', { userId: 'u1', role: 'user' }, { tags: ['users'] });
    await store.set('u:2', { userId: 'u2', role: 'user' }, { tags: ['users'] });
    await store.set('cfg', { userId: 'x', role: 'user' }, { tags: ['config'] });

    expect(await store.invalidateTag('users')).toBe(2);
    expect(await store.has('u:1')).toBe(false);
    expect(await store.has('cfg')).toBe(true);
  });

  test('clear empties one store and leaves the others alone', async () => {
    const { caches } = registry();

    await caches.store('app').set('a', { userId: 'u', role: 'user' });
    await caches.store('counter').set('b', 'b');
    await caches.store('app').clear();

    expect(await caches.store('app').has('a')).toBe(false);
    expect(await caches.store('counter').has('b')).toBe(true);
  });
});

describe('refusing what the driver cannot do', () => {
  test('the null driver never lies: misses, no tags, no increment', async () => {
    const { caches } = registry();
    const store = caches.store('off');

    await store.set('k', 'v');

    expect(await store.get('k')).toBeUndefined();
    expect(await store.has('k')).toBe(false);
    expect(await store.delete('k')).toBe(false);
    expect(store.increment('k')).rejects.toThrow(/CAP_UNSUPPORTED_OPERATION|atomic increment/u);
    expect(store.invalidateTag('t')).rejects.toThrow(/does not support tags/u);
  });

  test('a tag write on a driver without tags fails at the write, not silently', async () => {
    const { caches } = registry();

    expect(caches.store('off').set('k', 'v', { tags: ['x'] })).rejects.toThrow(
      /store "off" \(driver "null"\) does not support tags/u,
    );
  });

  test('a TTL on a driver without expiry is refused rather than ignored', async () => {
    const { caches } = registry();

    expect(caches.store('off').set('k', 'v', { ttlMs: 10 })).rejects.toThrow(
      /does not support a TTL/u,
    );
  });

  test('the driver name and the store name are both in every message', async () => {
    const { caches } = registry();

    expect(caches.store('off').increment('k')).rejects.toThrow(/store "off" \(driver "null"\)/u);
  });
});

describe('explicit serialization', () => {
  test('a value written by another codec is CAP_CODEC_FAILED, not undefined', async () => {
    // Two ports over one backend: the only way to write a payload the other codec cannot read.
    const backend = memoryDriver().open();
    const asText = createCache({ name: 'legacy', backend, codec: text() });
    const asJson = createCache<Session>({ name: 'legacy', backend, codec: json<Session>() });

    await asText.set('users:1', 'raw text, not an envelope');

    // `text` round-trips anything, including another codec's output.
    expect(await asText.get('users:1')).toBe('raw text, not an envelope');

    // The same row read through a typed store is a named failure, not `undefined`.
    expect(asJson.get('users:1')).rejects.toThrow(/could not encode key "users:1"/u);
  });

  test('the failure names the store, the key and the codec', async () => {
    const backend = memoryDriver().open();
    const asText = createCache({ name: 'sessions', backend, codec: text() });
    const asJson = createCache<Session>({ name: 'sessions', backend, codec: json<Session>() });

    await asText.set('users:1', 'raw');

    try {
      await asJson.get('users:1');
      throw new Error('expected a decode failure');
    } catch (error: unknown) {
      const tsir = error as { code?: string; message: string };
      expect(tsir.code).toBe('CAP_CODEC_FAILED');
      expect(tsir.message).toContain('store "sessions"');
      expect(tsir.message).toContain('users:1');
      expect(tsir.message).toContain('json');
    }
  });

  test('a value with no JSON representation is refused on the way in', async () => {
    const { caches } = registry();

    expect(caches.store('app').set('k', undefined as never)).rejects.toThrow(
      /could not encode key "k": `undefined` is a cache miss, not a value/u,
    );
  });

  test('the envelope is versioned', () => {
    expect(JSON.parse(json<number>().encode(3))).toEqual({ $tsir: 1, v: 3 });
    expect(() => json<number>().decode('{"$tsir":2,"v":3}')).toThrow(/version 2 is not 1/u);
    expect(() => json<number>().decode('[]')).toThrow(/not a tsir JSON envelope/u);
  });
});

describe('the probe', () => {
  test('it reports per store, and the null driver fails honestly', async () => {
    const { caches } = registry();
    const results = await caches.probe();

    expect(results.map((result) => result.store)).toEqual(['app', 'counter', 'off']);
    expect(results[0]).toEqual({ store: 'app', ok: true });
    expect(results[1]).toEqual({ store: 'counter', ok: true });
    expect(results[2]?.ok).toBe(false);
    expect(results[2]?.detail).toContain('round trip');
  });
});

describe('the edges the gate would otherwise miss', () => {
  test('maxEntries evicts oldest-first, and the store stays usable', async () => {
    const caches = createCaches({
      default: 'small',
      stores: {
        small: defineStore({ driver: memoryDriver({ maxEntries: 2 }), codec: json<string>() }),
      },
    });
    const store = caches.store('small');

    await store.set('a', 'a');
    await store.set('b', 'b');
    await store.set('c', 'c');

    expect(await store.has('a')).toBe(false);
    expect(await store.get('b')).toBe('b');
    expect(await store.get('c')).toBe('c');
  });

  test('a codec without a counter form cannot increment, even on a capable driver', async () => {
    const noCounter: Codec<string> = {
      name: 'upper',
      encode: (value) => value.toUpperCase(),
      decode: (raw) => raw.toLowerCase(),
    };
    const caches = createCaches({
      default: 'odd',
      stores: { odd: defineStore({ driver: memoryDriver(), codec: noCounter }) },
    });

    expect(caches.store('odd').increment('n')).rejects.toThrow(
      /does not support increment — the "upper" codec has no counter form/u,
    );
  });

  test('a driver opened without config still works, and a bad one names itself', () => {
    expect(memoryDriver().open().capabilities.tags).toBe(true);
    expect(
      createCaches({
        default: 'off',
        stores: { off: defineStore({ driver: nullDriver() }) },
      }).store('off').driver,
    ).toBe('null');
  });

  test('the kit is importable as data and describes both behaviours', async () => {
    const { conformanceCases } = await import('./conformance.ts');

    expect(conformanceCases({ driver: memoryDriver() }).length).toBeGreaterThan(4);
    expect(conformanceCases({ driver: nullDriver(), behaviour: 'never-store' }).length).toBe(3);
  });
});
