/**
 * The `redis` driver (`CACHE-7`, ADR-0027 § 1): app-supplied client, no dependency.
 *
 * `ioredis` is not allowlisted and neither is any other client. The driver takes the handful
 * of commands it actually uses, so a project that already has a Redis client — or wants a
 * different one, or a pooled wrapper, or a test double — passes its own. The alternative was
 * making `@tsir/cache` depend on a driver library it can only test with a server running.
 *
 * That choice costs one thing, and the driver pays it up front: a client missing a command is
 * a **startup** error (`CAP_DRIVER_MISSING`, naming the method), not a `TypeError` on the
 * request that first hits the cache.
 *
 * Three details worth stating, because each replaces a plausible mistake:
 *
 *   · **TTL is `SET … PX ms`**, one round trip, not `SET` then `PEXPIRE` — a key that exists
 *     forever because the second call failed is the classic version of this bug.
 *   · **Tags are a set per tag** (`tsir:cache:tag:<tag>` → member keys) plus a reverse set per
 *     key, so invalidating a tag is two `DEL`s and never a `SCAN`.
 *   · **`clear()` needs `KEYS`/`SCAN` and is therefore a capability**, not a given: a client
 *     without it refuses, exactly like Cloudflare KV.
 */

import { clientContract, unsupportedOperation } from '../errors.ts';
import type { CacheBackend, CacheDriver, StoredValue } from '../port.ts';

/** The slice of a Redis client this driver needs, in its own command vocabulary. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  /** `set(key, value)`, or `set(key, value, 'PX', ms)` for a TTL. */
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  exists(key: string): Promise<number>;
  incrby(key: string, by: number): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  /**
   * Run a Lua script. Needed for atomic lock release (compare-and-delete). Without it,
   * `locks` is `false` — a non-atomic release can delete someone else's lock.
   */
  eval?(script: string, keys: readonly string[], args: readonly unknown[]): Promise<unknown>;
  /** Only needed by `clear()`; without it the driver advertises `clearAll: false`. */
  keys?(pattern: string): Promise<string[]>;
  /** Atomic write of several commands. Without it, a tagged write is not all-or-nothing. */
  multi?(): RedisPipeline;
}

export interface RedisPipeline {
  set(key: string, value: string, ...args: (string | number)[]): RedisPipeline;
  del(...keys: string[]): RedisPipeline;
  sadd(key: string, ...members: string[]): RedisPipeline;
  exec(): Promise<unknown>;
}

export interface RedisDriverOptions {
  readonly client: RedisLike;
  /** Default `tsir:cache:`; one Redis is usually shared with other things. */
  readonly prefix?: string | undefined;
  /**
   * Defaults to `Date.now`. Injected for tests, and declared on the backend below so the store
   * above it reads the same clock: two independent `Date.now()` calls straddling a millisecond
   * turn a 30 s TTL into `PX 29999`, which is harmless in production and unbearable in a test
   * that asserts the number.
   */
  readonly now?: (() => number) | undefined;
}

/** Commands that must exist before a backend opens, so the error can name them. */
const REQUIRED: readonly (keyof RedisLike)[] = [
  'get',
  'set',
  'del',
  'exists',
  'incrby',
  'sadd',
  'srem',
  'smembers',
];

export function redisDriver(options: RedisDriverOptions): CacheDriver<never> {
  const prefix = options.prefix ?? 'tsir:cache:';
  const { client } = options;
  const now = options.now ?? ((): number => Date.now());

  const missing = REQUIRED.filter((name) => typeof client[name] !== 'function');

  return {
    name: 'redis',
    capabilities: {
      persistent: true,
      sharedAcrossInstances: true,
      // Redis is strongly consistent for a single key: a read after your own write sees it.
      readYourWrites: true,
      tags: true,
      increment: true,
      ttl: true,
      clearAll: typeof client.keys === 'function',
      // Lock release needs an atomic compare-and-delete, which is a Lua script. A client
      // without `eval` cannot release safely, so the capability is false rather than
      // offering a racy check-then-delete that can delete someone else's lock.
      locks: typeof client.eval === 'function',
    },
    open(): CacheBackend {
      if (missing.length > 0) throw clientContract('redis', 'redis', missing);

      const k = (key: string): string => `${prefix}${key}`;
      // Counters live under their own key, because `INCRBY` is arithmetic on a bare integer
      // and an encoded payload is not one. This is the Redis spelling of the `database`
      // driver's numeric column: the value and the counter never share a slot.
      const countKey = (key: string): string => `${prefix}count:${key}`;
      const forward = (key: string): string => `${prefix}tags:${key}`;
      const tagKey = (tag: string): string => `${prefix}tag:${tag}`;

      /**
       * Run several commands as one transaction when the client supports it, and as plain
       * awaited calls when it does not — two explicit paths, because a union of "pipeline or
       * client" would make every call inside the block either a promise nobody awaits or a
       * chain nobody needs.
       */
      const atomically = async (
        queued: (pipeline: RedisPipeline) => void,
        directly: () => Promise<void>,
      ): Promise<void> => {
        if (client.multi === undefined) {
          await directly();
          return;
        }
        const pipeline = client.multi();
        queued(pipeline);
        await pipeline.exec();
      };

      const backend: CacheBackend = {
        name: 'redis',
        // The store takes its clock from here, so the TTL it computes and the one this driver
        // sends are the same instant.
        now,
        capabilities:
          options.client.keys === undefined || options.client.eval === undefined
            ? {
                ...redisCapabilities,
                clearAll: options.client.keys !== undefined,
                locks: options.client.eval !== undefined,
              }
            : redisCapabilities,

        async read(key: string): Promise<StoredValue | undefined> {
          const counter = await client.get(countKey(key));
          if (counter !== null) {
            // coercion-ok: the counter key holds a decimal integer this driver wrote; a value
            // that is not finite is a corrupted entry, and is ignored rather than guessed at.
            const value = Number(counter);
            // coercion-ok: the counter key holds a decimal integer this driver wrote; a value
            // that is not a finite number is treated as a corrupted entry, not guessed at.
            if (Number.isFinite(value)) return { raw: '', counterValue: value };
          }

          const raw = await client.get(k(key));
          return raw === null ? undefined : { raw };
        },

        async write(
          key: string,
          raw: string,
          expiresAt: number | undefined,
          tags: readonly string[],
        ): Promise<void> {
          // `PX` in the same SET: a value with no expiry because the second command failed is
          // a cache that quietly becomes a database.
          const ttl = expiresAt === undefined ? undefined : Math.floor(expiresAt - now());
          if (ttl !== undefined && ttl <= 0) {
            // Already expired. Redis rejects `PX 0`, and storing it anyway would resurrect an
            // entry the caller asked not to exist.
            await client.del(k(key));
            return;
          }
          const setArgs: (string | number)[] = ttl === undefined ? [] : ['PX', ttl];

          const unique = [...new Set(tags)];

          await atomically(
            (pipeline) => {
              pipeline.set(k(key), raw, ...setArgs);
              // Writing a value retires the counter, so one key never holds two truths.
              pipeline.del(countKey(key));
              // Tags are replaced, not merged: `set` describes the entry as it now is, and a
              // stale membership would let someone else's invalidation delete it later.
              pipeline.del(forward(key));
              for (const tag of unique) {
                pipeline.sadd(tagKey(tag), key);
                pipeline.sadd(forward(key), tag);
              }
            },
            async () => {
              await client.set(k(key), raw, ...setArgs);
              await client.del(countKey(key));
              await client.del(forward(key));
              for (const tag of unique) {
                await client.sadd(tagKey(tag), key);
                await client.sadd(forward(key), tag);
              }
            },
          );
        },

        async remove(key: string): Promise<boolean> {
          const existed =
            (await client.exists(k(key))) > 0 || (await client.exists(countKey(key))) > 0;
          if (!existed) return false;

          const tags = await client.smembers(forward(key));
          await client.del(k(key), countKey(key));
          for (const tag of tags) await client.srem(tagKey(tag), key);
          await client.del(forward(key));
          return true;
        },

        async increment(key: string, by: number): Promise<number> {
          // `INCRBY` is atomic server-side, which is the only version of this that is. A
          // counter never coexists with a value: `write` deletes this key, and `read` prefers
          // it, so the port sees exactly one of the two.
          const next = await client.incrby(countKey(key), by);
          if ((await client.exists(k(key))) > 0) await client.del(k(key));
          return next;
        },

        async removeTag(tag: string): Promise<number> {
          const members = await client.smembers(tagKey(tag));
          if (members.length === 0) return 0;

          // Two DELs regardless of how many keys the tag holds, plus one per member for its
          // reverse set. No `SCAN`.
          await client.del(...members.flatMap((key) => [k(key), countKey(key)]));
          await client.del(tagKey(tag));
          for (const key of members) await client.del(forward(key));
          return members.length;
        },

        async clear(): Promise<void> {
          if (client.keys === undefined) {
            throw unsupportedOperation(
              'redis',
              'redis',
              'clear',
              'the client exposes no `keys`/`scan`; delete the prefix or flush the database instead',
            );
          }
          // The one place this driver lists a keyspace, and only its own prefix.
          const found = await client.keys(`${prefix}*`);
          if (found.length > 0) await client.del(...found);
        },

        /**
         * `SET key owner NX PX ttl` — one round trip, atomic server-side. `NX` refuses when
         * the key exists, `PX` sets the TTL in the same command so a lock with no expiry because
         * the second call failed is impossible. Redis returns `OK` or `null`; we coerce to
         * boolean.
         */
        async acquireLock(
          key: string,
          owner: string,
          expiresAt: number | undefined,
        ): Promise<boolean> {
          const ttl = expiresAt === undefined ? undefined : Math.floor(expiresAt - now());
          if (ttl !== undefined && ttl <= 0) {
            // Already expired: refuse rather than store a key the next acquire will immediately
            // consider free.
            return false;
          }
          const args: (string | number)[] = ['NX'];
          if (ttl !== undefined) args.push('PX', ttl);
          const result = await client.set(k(key), owner, ...args);
          return result === 'OK' || result === 'ok';
        },

        /**
         * Atomic compare-and-delete via Lua: the script runs server-side, so no other client
         * can change the value between the `GET` and `DEL`. Without `eval`, the capability is
         * `false` and the store refuses before reaching here.
         */
        async releaseLock(key: string, owner: string): Promise<boolean> {
          if (client.eval === undefined) {
            throw unsupportedOperation(
              'redis',
              'redis',
              'releaseLock',
              'the client exposes no `eval`; atomic lock release requires a Lua script',
            );
          }
          const script =
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
          const result = await client.eval(script, [k(key)], [owner]);
          return result === 1 || result === '1';
        },
      };

      return backend;
    },
  };
}

export const redisCapabilities = {
  persistent: true,
  sharedAcrossInstances: true,
  readYourWrites: true,
  tags: true,
  increment: true,
  ttl: true,
  clearAll: true,
  locks: true,
} as const;
