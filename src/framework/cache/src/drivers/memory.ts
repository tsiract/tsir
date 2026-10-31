/**
 * The in-process driver (`§ 4.1`).
 *
 * Honest about what it is: `persistent: false`, `sharedAcrossInstances: false`. Those two
 * flags are why it is refused as a *production default* — a per-isolate cache in production
 * is not a slow cache, it is a different cache per instance, and every "why is this user
 * seeing the old value" ticket starts there.
 *
 * It keeps its own clock (injectable) rather than reading `Date.now` at call sites, so TTL
 * behaviour is testable without sleeping — the same reason `@tsir/migrate` takes `now`.
 */

import type { CacheBackend, CacheDriver, StoredValue } from '../port.ts';

export interface MemoryDriverOptions {
  /** Milliseconds. Defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
  /** Upper bound on entries before the oldest is evicted. Default: unbounded. */
  readonly maxEntries?: number | undefined;
}

interface Entry {
  readonly raw: string;
  readonly expiresAt: number | undefined;
  readonly tags: readonly string[];
}

export const MEMORY_CAPABILITIES = {
  persistent: false,
  sharedAcrossInstances: false,
  readYourWrites: true,
  tags: true,
  increment: true,
  ttl: true,
  clearAll: true,
} as const;

/**
 * Automatic increment uses a real integer stored **beside** the encoded value, because the
 * value it replaced may have been written by any codec and `JSON.parse`-ing an unknown
 * payload to add one to it is exactly the implicit parse this package refuses.
 */
export function memoryDriver(options: MemoryDriverOptions = {}): CacheDriver<never> {
  return {
    name: 'memory',
    capabilities: MEMORY_CAPABILITIES,
    open(): CacheBackend {
      const entries = new Map<string, Entry>();
      const now = options.now ?? Date.now;

      const readEntry = (key: string): Entry | undefined => {
        const entry = entries.get(key);
        if (entry === undefined) return undefined;
        if (entry.expiresAt !== undefined && entry.expiresAt <= now()) {
          entries.delete(key);
          return undefined;
        }
        return entry;
      };

      const evict = (): void => {
        const max = options.maxEntries;
        if (max === undefined || entries.size <= max) return;
        // Insertion order is the eviction order: a Map iterates oldest first, and anything
        // cleverer (LRU on read) changes what the tests observe for a benefit nobody asked for.
        for (const key of entries.keys()) {
          if (entries.size <= max) break;
          entries.delete(key);
        }
      };

      const backend: CacheBackend = {
        name: 'memory',
        capabilities: MEMORY_CAPABILITIES,
        now,

        async read(key: string): Promise<StoredValue | undefined> {
          const entry = readEntry(key);
          if (entry === undefined) return undefined;
          return { raw: entry.raw, expiresAt: entry.expiresAt, tags: entry.tags };
        },

        async write(
          key: string,
          raw: string,
          expiresAt: number | undefined,
          tags: readonly string[] = [],
        ): Promise<void> {
          entries.set(key, { raw, expiresAt, tags: [...tags] });
          evict();
        },

        async remove(key: string): Promise<boolean> {
          return entries.delete(key);
        },

        async increment(
          key: string,
          by: number,
          _expiresAt: number | undefined,
          counter,
        ): Promise<number> {
          const entry = readEntry(key);
          const current = entry === undefined ? 0 : counter.read(entry.raw);
          if (current === undefined) {
            throw new TypeError(`cache: key "${key}" does not hold a counter`);
          }
          const next = current + by;
          // Keep the entry's expiry: a counter that silently becomes immortal on first
          // increment is a rate limiter that stops resetting. Rewrite through the counter
          // codec so `get` can decode it — a counter you cannot read is not a counter.
          entries.set(key, {
            raw: counter.write(next),
            expiresAt: entry?.expiresAt,
            tags: entry?.tags ?? [],
          });
          evict();
          return next;
        },

        async removeTag(tag: string): Promise<number> {
          let removed = 0;
          for (const [key, entry] of entries) {
            if (!entry.tags.includes(tag)) continue;
            entries.delete(key);
            removed += 1;
          }
          return removed;
        },

        async clear(): Promise<void> {
          entries.clear();
        },
      };

      return backend;
    },
  };
}

/** The capabilities above, for a caller that needs to assert on them. */
export const memoryCapabilities = MEMORY_CAPABILITIES;
