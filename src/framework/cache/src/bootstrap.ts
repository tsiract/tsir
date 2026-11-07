/**
 * One-call cache bootstrap for apps that use `@tsir/cache`.
 *
 * Replaces the hand-written `modules/system/services/cache.ts` every app
 * previously needed: it builds the named stores from `config/cache.ts`,
 * exposes the `caches` registry, and creates the DI token + value provider
 * the rest of the app wires into its modules.
 */

import { token, valueProvider, type Provider, type Token } from '@tsir/container';

import { cachesFromConfig, type BuildCachesOptions } from './config.ts';
import type { Caches } from './stores.ts';

/** Options for `createCacheBootstrap`. */
export interface CacheBootstrapOptions {
  /** The app's cache configuration (the `cache` field of `BuildCachesOptions`). */
  readonly cache: BuildCachesOptions['cache'];
  /** Bindings for drivers that need a backend (database, redis, kv). */
  readonly bindings?: BuildCachesOptions['bindings'];
  /** Refuse ephemeral defaults in production. */
  readonly production?: boolean;
  /** Per-store codecs. A store without one gets `json`. */
  readonly codecs?: BuildCachesOptions['codecs'];
}

/** Everything an app needs to wire its cache layer. */
export interface CacheBootstrap {
  /** The named cache stores registry. */
  readonly caches: Caches;
  /** DI token for `caches`. */
  readonly cachesToken: Token<Caches>;
  /** Value provider for `caches`. */
  readonly cachesProvider: Provider<Caches>;
}

/**
 * Build the cache layer from `config/cache.ts`.
 *
 * ```ts
 * import { createCacheBootstrap } from '@tsir/cache';
 * import { databases } from '../../database.ts';
 * import config from '../../config/cache.ts';
 *
 * export const { caches, cachesToken, cachesProvider } = createCacheBootstrap({
 *   cache: config,
 *   bindings: { databases: { primary: databases.defaultDatabase } },
 * });
 * ```
 */
export function createCacheBootstrap(options: CacheBootstrapOptions): CacheBootstrap {
  const caches = cachesFromConfig({
    cache: options.cache,
    bindings: options.bindings,
    production: options.production,
    codecs: options.codecs,
  });

  const cachesToken = token<Caches>('caches');
  const cachesProvider = valueProvider(cachesToken, caches);

  return { caches, cachesToken, cachesProvider };
}
