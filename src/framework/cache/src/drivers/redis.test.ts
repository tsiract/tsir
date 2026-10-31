/**
 * The `redis` driver (`CACHE-7`).
 *
 * There is no Redis server here, and the driver was designed so there need not be one: it
 * takes an app-supplied client (ADR-0027 § 1), so the fake *is* the client — it holds strings
 * and sets in Maps and speaks the same command names `ioredis` does.
 *
 * What the fake deliberately models, because the driver's correctness depends on it:
 *
 *   · `INCRBY` is atomic and returns the new value (the driver does not compute it);
 *   · `set(..., 'PX', ms)` carries the TTL in one command, and the driver must never send a
 *     separate expire that could fail on its own;
 *   · `multi()` batches command *recording* and runs them on `exec()`.
 */

import { describe, expect, test } from 'bun:test';

import { json } from '../codec.ts';
import { conformanceCases } from '../conformance.ts';
import { createCache } from '../store.ts';
import { redisDriver, type RedisLike, type RedisPipeline } from './redis.ts';

interface FakeOptions {
  readonly multi?: boolean;
  readonly keys?: boolean;
}

function fakeClient(options: FakeOptions = {}) {
  const strings = new Map<string, { value: string; expiresAt?: number }>();
  const sets = new Map<string, Set<string>>();
  const calls: string[] = [];
  let clock = 1_000_000;

  const live = (key: string): string | undefined => {
    const entry = strings.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= clock) {
      strings.delete(key);
      return undefined;
    }
    return entry.value;
  };

  const op = {
    get: (key: string): string | null => live(key) ?? null,
    set: (key: string, value: string, ...args: (string | number)[]): void => {
      const pxIndex = args.findIndex((arg) => String(arg).toUpperCase() === 'PX');
      const px = pxIndex === -1 ? undefined : Number(args[pxIndex + 1]);
      strings.set(key, {
        value,
        ...(px === undefined ? {} : { expiresAt: clock + px }),
      });
    },
    del: (...keys: string[]): number => {
      let removed = 0;
      for (const key of keys) {
        if (strings.delete(key)) removed += 1;
        if (sets.delete(key)) removed += 1;
      }
      return removed;
    },
    exists: (key: string): number => (live(key) === undefined ? 0 : 1),
    incrby: (key: string, by: number): number => {
      const current = Number(live(key) ?? 0);
      const next = current + by;
      strings.set(key, { value: String(next) });
      return next;
    },
    sadd: (key: string, ...members: string[]): number => {
      const set = sets.get(key) ?? new Set<string>();
      let added = 0;
      for (const member of members) {
        if (!set.has(member)) added += 1;
        set.add(member);
      }
      sets.set(key, set);
      return added;
    },
    srem: (key: string, ...members: string[]): number => {
      const set = sets.get(key);
      if (set === undefined) return 0;
      let removed = 0;
      for (const member of members) if (set.delete(member)) removed += 1;
      return removed;
    },
    smembers: (key: string): string[] => [...(sets.get(key) ?? [])],
  };

  const client: RedisLike = {
    get: async (key) => {
      calls.push(`get ${key}`);
      return op.get(key);
    },
    set: async (key, value, ...args) => {
      calls.push(`set ${key}${args.includes('PX') ? ' PX' : ''}`);
      op.set(key, value, ...args);
      return 'OK';
    },
    del: async (...keys) => {
      calls.push(`del ${keys.join(',')}`);
      return op.del(...keys);
    },
    exists: async (key) => op.exists(key),
    incrby: async (key, by) => {
      calls.push(`incrby ${key}`);
      return op.incrby(key, by);
    },
    sadd: async (key, ...members) => op.sadd(key, ...members),
    srem: async (key, ...members) => op.srem(key, ...members),
    smembers: async (key) => op.smembers(key),
    ...(options.multi === false
      ? {}
      : {
          multi: (): RedisPipeline => {
            const queued: (() => void)[] = [];
            const pipeline: RedisPipeline = {
              set: (key, value, ...args) => {
                calls.push(`set ${key}${args.includes('PX') ? ' PX' : ''}`);
                queued.push(() => op.set(key, value, ...args));
                return pipeline;
              },
              del: (...keys) => {
                queued.push(() => op.del(...keys));
                return pipeline;
              },
              sadd: (key, ...members) => {
                queued.push(() => op.sadd(key, ...members));
                return pipeline;
              },
              exec: async () => {
                calls.push(`exec(${String(queued.length)})`);
                for (const run of queued) run();
                return [];
              },
            };
            return pipeline;
          },
        }),
    ...(options.keys === false
      ? {}
      : {
          keys: async (pattern: string): Promise<string[]> => {
            const prefix = pattern.replace(/\*$/u, '');
            return [...strings.keys()].filter((key) => key.startsWith(prefix));
          },
        }),
  };

  return {
    client,
    strings,
    sets,
    calls,
    now: () => clock,
    advance: (ms: number) => (clock += ms),
  };
}

function store(options: FakeOptions = {}) {
  const fake = fakeClient(options);
  // One clock for the store and the driver: with two `Date.now()` reads the TTL can be off by a
  // millisecond, which is the difference between asserting `1_030_000` and asserting nothing.
  const driver = redisDriver({ client: fake.client, now: fake.now });
  return {
    fake,
    driver,
    cache: createCache<string>({ name: 'redis', backend: driver.open(), codec: json<string>() }),
  };
}

describe('the client contract', () => {
  test('a client missing a command fails at startup, naming every missing method', () => {
    const partial = { get: async () => null } as unknown as RedisLike;
    const driver = redisDriver({ client: partial });

    expect(() => driver.open()).toThrow(/the "redis" client is missing set, del, exists/u);
    try {
      driver.open();
    } catch (error: unknown) {
      expect((error as { code?: string }).code).toBe('CAP_DRIVER_MISSING');
      expect((error as { hint?: string }).hint).toContain('pass a real client');
    }
  });

  test('advertising `clearAll` follows whether the client can list', () => {
    expect(redisDriver({ client: fakeClient().client }).capabilities.clearAll).toBe(true);
    expect(redisDriver({ client: fakeClient({ keys: false }).client }).capabilities.clearAll).toBe(
      false,
    );
  });
});

describe('the commands it sends', () => {
  test('a TTL travels inside SET … PX, never as a second call', async () => {
    const { cache, fake } = store();

    await cache.set('k', 'v', { ttlMs: 30_000 });

    expect(fake.calls).toContain('set tsir:cache:k PX');
    expect(fake.calls.some((call) => call.startsWith('pexpire'))).toBe(false);
    expect(fake.strings.get('tsir:cache:k')?.expiresAt).toBe(1_030_000);
  });

  test('a tagged write is one transaction: the value and its tag sets together', async () => {
    const { cache, fake } = store();

    await cache.set('user:1', 'v', { tags: ['users'] });

    // set + del(old tags) + del(counter) + 2 sadd (tag→key, key→tag), in one exec.
    expect(fake.calls).toContain('exec(5)');
    expect(fake.sets.get('tsir:cache:tag:users')?.has('user:1')).toBe(true);
    expect(fake.sets.get('tsir:cache:tags:user:1')?.has('users')).toBe(true);
  });

  test('without `multi` it still works — the write is simply not atomic', async () => {
    const { cache, fake } = store({ multi: false });

    await cache.set('k', 'v', { tags: ['t'] });

    expect(fake.sets.get('tsir:cache:tag:t')?.has('k')).toBe(true);
  });

  test('increment is INCRBY on its own key, and reads back through the codec', async () => {
    const { cache, fake } = store();

    expect(await cache.increment('hits')).toBe(1);
    expect(await cache.increment('hits', 4)).toBe(5);
    expect(fake.calls.filter((call) => call.startsWith('incrby'))).toHaveLength(2);

    // The counter lives under `count:` because INCRBY needs a bare integer; `get` still
    // decodes it through the store's codec rather than handing back a raw string.
    expect(fake.strings.get('tsir:cache:count:hits')?.value).toBe('5');
    // The store is declared `json<string>`; a counter is a number in JSON, so this is the
    // value the codec produces — no cast, no special case in the read path.
    expect(await cache.get('hits')).toBe(5 as unknown as string);
  });

  test('writing a value retires the counter, so one key never holds two truths', async () => {
    const { cache, fake } = store();

    await cache.increment('k');
    await cache.set('k', 'value');

    expect(fake.strings.has('tsir:cache:count:k')).toBe(false);
    expect(await cache.get('k')).toBe('value');
  });

  test('invalidateTag is two DELs, not a SCAN of the keyspace', async () => {
    const { cache, fake } = store();

    await cache.set('a', '1', { tags: ['users'] });
    await cache.set('b', '2', { tags: ['users'] });
    await cache.set('c', '3', { tags: ['other'] });

    expect(await cache.invalidateTag('users')).toBe(2);
    expect(fake.sets.get('tsir:cache:tag:users')).toBeUndefined();
    expect(await cache.get('c')).toBe('3');
  });

  test('delete drops the key and both directions of its tag membership', async () => {
    const { cache, fake } = store();

    await cache.set('k', 'v', { tags: ['t'] });
    expect(await cache.delete('k')).toBe(true);
    expect(await cache.delete('k')).toBe(false);

    expect(fake.sets.get('tsir:cache:tag:t')?.size ?? 0).toBe(0);
    expect(fake.sets.get('tsir:cache:tags:k')).toBeUndefined();
  });

  test('clear deletes only its own prefix', async () => {
    const fake = fakeClient();
    await fake.client.set('someone-else:key', 'x');
    const driver = redisDriver({ client: fake.client });
    const cache = createCache<string>({
      name: 'redis',
      backend: driver.open(),
      codec: json<string>(),
    });

    await cache.set('k', 'v');
    await cache.clear();

    expect(await cache.get('k')).toBeUndefined();
    expect(await fake.client.get('someone-else:key')).toBe('x');
  });

  test('an entry expires against the client clock', async () => {
    const { cache, fake } = store();

    await cache.set('k', 'v', { ttlMs: 1_000 });
    fake.advance(999);
    expect(await cache.get('k')).toBe('v');

    fake.advance(1);
    expect(await cache.get('k')).toBeUndefined();
  });

  test('the conformance kit passes', async () => {
    const fake = fakeClient();
    const driver = redisDriver({ client: fake.client });

    for (const conformanceCase of conformanceCases({ driver, store: 'redis' })) {
      await conformanceCase.run();
    }
  });
});

describe('what it refuses', () => {
  test('clear without `keys` is refused twice over: by the port and by the driver', async () => {
    const fake = fakeClient({ keys: false });
    const driver = redisDriver({ client: fake.client });

    // The port refuses first, because the capability says so.
    const cache = createCache<string>({
      name: 'redis',
      backend: driver.open(),
      codec: json<string>(),
    });
    expect(cache.clear()).rejects.toThrow(/does not support clear/u);

    // And the driver refuses too, for anyone holding the backend directly.
    expect(driver.open().clear()).rejects.toThrow(/the client exposes no `keys`/u);
  });
});
