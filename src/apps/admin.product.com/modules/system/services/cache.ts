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
import { databases } from '../../../database.ts';
import appConfig from '../../../config/cache.ts';

export const { caches, cachesToken, cachesProvider } = createCacheBootstrap({
  cache: appConfig,
  bindings: {
    databases: { primary: databases.defaultDatabase },
  },
});
