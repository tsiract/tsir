/**
 * The `null` driver (`§ 4.1`): always misses, never stores.
 *
 * Its job is a test shape — "does this code path depend on cache warmth?" — and it is
 * useful precisely because it cannot lie: `get` is always `undefined`, `has` is always
 * `false`, and `increment` is **not supported** rather than returning 0.
 *
 * An `increment` returning 0 would look like a working counter that never advances, which is
 * how a rate limiter passes its tests and fails in production. The driver advertises
 * `increment: false` and the port refuses with `CAP_UNSUPPORTED_OPERATION`.
 */

import type { CacheBackend, CacheDriver } from '../port.ts';

export const NULL_CAPABILITIES = {
  persistent: false,
  sharedAcrossInstances: false,
  readYourWrites: false,
  tags: false,
  increment: false,
  ttl: false,
  clearAll: true,
  locks: false,
} as const;

export function nullDriver(): CacheDriver<never> {
  return {
    name: 'null',
    capabilities: NULL_CAPABILITIES,
    open(): CacheBackend {
      return {
        name: 'null',
        capabilities: NULL_CAPABILITIES,

        read: () => Promise.resolve(undefined),
        write: () => Promise.resolve(),
        remove: () => Promise.resolve(false),
        // No parameters: a never-store driver has nothing to do with any of them, and
        // naming them would suggest it might one day.
        increment: (): Promise<number> =>
          Promise.reject(new Error('cache: the null driver cannot increment')),
        removeTag: () => Promise.resolve(0),
        clear: () => Promise.resolve(),
        // A never-store driver cannot hold a lock: there is nothing to acquire or release.
        acquireLock: (): Promise<boolean> =>
          Promise.reject(new Error('cache: the null driver cannot hold a lock')),
        releaseLock: (): Promise<boolean> =>
          Promise.reject(new Error('cache: the null driver cannot hold a lock')),
      };
    },
  };
}

export const nullCapabilities = NULL_CAPABILITIES;
