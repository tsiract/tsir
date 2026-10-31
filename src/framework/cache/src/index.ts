/**
 * @tsir/cache — named cache stores over one port (`CAP-001`, `CAP-002`).
 *
 * Public surface:
 *   createCaches, defineStore, assertRequirements, checkRequirements,
 *   json, text, guardCodec
 *
 * Drivers are subpaths, one manifest per dependency (`ADR-0022`, `ADR-0027`):
 *   `@tsir/cache/memory` · `/null` · `/database` · `/redis` · `/cloudflare-kv`
 *
 * What this package deliberately does not do: fall back to a default store for an unknown
 * name, `JSON.parse` a payload nobody declared a codec for, or emulate a capability the
 * driver does not have.
 */

export { createCaches, defineStore, assertRequirements, checkRequirements } from './stores.ts';
export type {
  Caches,
  CachesOptions,
  StoreDefinition,
  StoreRequirement,
  StoreValue,
} from './stores.ts';

export { createCache } from './store.ts';
export type { StoreOptions } from './store.ts';

export { guardCodec, json, text } from './codec.ts';
export type { JsonEnvelope } from './codec.ts';

export type {
  Cache,
  CacheBackend,
  CacheCapabilities,
  CacheDriver,
  CacheEntryOptions,
  Codec,
  StoredValue,
} from './port.ts';

export { CACHE_DRIVERS, cachesFromConfig, driverFor } from './config.ts';
export type {
  BuildCachesOptions,
  CacheBindings,
  CacheDriverName,
  ConfiguredStore,
} from './config.ts';
export { cacheTableDdl } from './drivers/database.ts';

export { conformanceCases } from './conformance.ts';
export type { ConformanceCase, ConformanceOptions } from './conformance.ts';

export type { CacheErrorCode } from './errors.ts';
