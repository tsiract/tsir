/**
 * Cache store registry.
 *
 * `@tsir/cache` builds named stores from `config/cache.ts`. The default store
 * is `memory` so the app boots without Redis or KV; a `database` store is
 * available by uncommenting it in the config and running `tsir cache:table`.
 *
 * Stores are named: a request can only reach a store declared here. The
 * `caches` object exposes `get(name)` (or `get()` for the default) and
 * `require(name)` for stores that must exist.
 */
import { createCacheBootstrap } from '@tsir/cache';
import { isProduction } from '@tsir/core';
import { databases } from '../../../database.ts';
import appConfig from '../../../config/cache.ts';

export const { caches, cachesToken, cachesProvider } = createCacheBootstrap({
  cache: appConfig,
  bindings: {
    databases: { primary: databases.defaultDatabase },
  },
  // `CAP-007`: without this every production guard in every package is dead code. `APP_ENV` is
  // written by `tsir deploy:build`, so this is what the deployed Worker actually sees.
  production: isProduction(),
});
