/**
 * The port implementation (`CAP-001`): one backend plus one codec makes one `Cache<T>`.
 *
 * Everything policy-shaped lives here, so no driver has to remember it:
 *
 *   · **serialization** — the driver only ever sees strings;
 *   · **expiry** — `ttlMs` becomes an absolute timestamp computed from the driver's clock,
 *     and an expired entry is a miss;
 *   · **tags** — refused with `CAP_UNSUPPORTED_OPERATION` when the driver has no tag index,
 *     rather than emulated with a keyspace scan (`§ 4.1`);
 *   · **increment** — refused when it is not atomic on that driver, because an
 *     increment that is a read-modify-write is a lost update under load.
 *
 * Refusing is the interesting half. A cache that silently degrades — tags that "work" by
 * scanning, increments that are approximate — produces bugs that only appear under the load
 * that made them worth caching in the first place.
 */

import { guardCodec } from './codec.ts';
import { unsupportedOperation } from './errors.ts';
import type { Cache, CacheBackend, CacheEntryOptions, Codec } from './port.ts';

export interface StoreOptions<T> {
  readonly name: string;
  readonly backend: CacheBackend;
  readonly codec: Codec<T>;
  /** Store-level default TTL, in ms. Per-call `ttlMs` wins. */
  readonly ttlMs?: number | undefined;
}

function clock(backend: CacheBackend): () => number {
  return backend.now === undefined ? Date.now : () => backend.now?.() ?? Date.now();
}

function expired(expiresAt: number | undefined, now: number): boolean {
  return expiresAt !== undefined && expiresAt <= now;
}

export function createCache<T>(options: StoreOptions<T>): Cache<T> {
  const { name, backend } = options;
  const capabilities = backend.capabilities;
  const now = clock(backend);

  /** Every path that reads a value runs the same codec guard, so a bad payload names its key. */
  const decode = (raw: string, key: string): T => guardCodec(options.codec, name, key).decode(raw);
  const encode = (value: T, key: string): string =>
    guardCodec(options.codec, name, key).encode(value);

  const readLive = async (key: string): Promise<T | undefined> => {
    const stored = await backend.read(key);
    if (stored === undefined) return undefined;
    if (expired(stored.expiresAt, now())) {
      // A driver that cannot expire on read leaves the row behind; removing it here keeps
      // "expired means gone" true without forcing every driver to implement a sweeper.
      await backend.remove(key);
      return undefined;
    }
    if (stored.counterValue !== undefined) {
      const counter = options.codec.counter;
      if (counter === undefined) {
        throw unsupportedOperation(
          name,
          backend.name,
          'reading a counter',
          `the "${options.codec.name}" codec has no counter form`,
        );
      }
      // Rebuild the encoded form from the number, so `get` returns the store's declared type.
      return decode(counter.write(stored.counterValue), key);
    }
    return decode(stored.raw, key);
  };

  const ttlFor = (setAt: number, requested: number | undefined): number | undefined => {
    const ttl = requested ?? options.ttlMs;
    if (ttl === undefined) return undefined;
    if (!capabilities.ttl) {
      throw unsupportedOperation(
        name,
        backend.name,
        'a TTL',
        'every entry in this store lives forever',
      );
    }
    return setAt + ttl;
  };

  const requireTags = (tags: readonly string[] | undefined): void => {
    if (tags === undefined || tags.length === 0) return;
    if (!capabilities.tags) {
      throw unsupportedOperation(
        name,
        backend.name,
        'tags',
        'tag invalidation needs a real index, and this driver has none — a keyspace scan is not a substitute',
      );
    }
  };

  const cache: Cache<T> = {
    name,
    driver: backend.name,
    capabilities,

    async get(key: string): Promise<T | undefined> {
      return readLive(key);
    },

    async has(key: string): Promise<boolean> {
      return (await readLive(key)) !== undefined;
    },

    async set(key: string, value: T, setOptions: CacheEntryOptions = {}): Promise<void> {
      requireTags(setOptions.tags);
      const setAt = now();
      await backend.write(
        key,
        encode(value, key),
        ttlFor(setAt, setOptions.ttlMs),
        setOptions.tags ?? [],
      );
    },

    async delete(key: string): Promise<boolean> {
      return backend.remove(key);
    },

    async remember(
      key: string,
      ttlMs: number,
      compute: () => Promise<T>,
      rememberOptions: CacheEntryOptions = {},
    ): Promise<T> {
      const hit = await readLive(key);
      if (hit !== undefined) return hit;

      // Outside any lock, deliberately (`port.ts`): two concurrent misses may both compute.
      // A cache that hides that behind a lock charges every store for one store's need.
      const value = await compute();
      await cache.set(key, value, { ...rememberOptions, ttlMs });
      return value;
    },

    async increment(key: string, by = 1): Promise<number> {
      if (!capabilities.increment) {
        throw unsupportedOperation(
          name,
          backend.name,
          'atomic increment',
          'a read-modify-write increment loses updates under concurrency, so it is not offered',
        );
      }
      const counter = options.codec.counter;
      if (counter === undefined) {
        throw unsupportedOperation(
          name,
          backend.name,
          'increment',
          `the "${options.codec.name}" codec has no counter form, so the value could never be read back`,
        );
      }
      // A counter has no TTL here: extending it on increment would make the window depend on
      // traffic, which is a rate limiter that never resets.
      return backend.increment(key, by, undefined, counter);
    },

    async invalidateTag(tag: string): Promise<number> {
      if (!capabilities.tags) {
        throw unsupportedOperation(name, backend.name, 'tags');
      }
      return backend.removeTag(tag);
    },

    async clear(): Promise<void> {
      if (!capabilities.clearAll) {
        throw unsupportedOperation(
          name,
          backend.name,
          'clear',
          'emptying this backend would mean listing the whole keyspace — delete the namespace or the table instead',
        );
      }
      await backend.clear();
    },
  };

  return cache;
}
