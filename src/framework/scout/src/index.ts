/**
 * @tsir/scout — full-text search.
 *
 * ```ts
 * import { createScoutBootstrap, memoryEngine } from '@tsir/scout';
 *
 * const { engine } = createScoutBootstrap({ engine: memoryEngine() });
 *
 * await engine.index({ id: '1', fields: { title: 'Hello World', body: 'A test post' } });
 * const hits = await engine.search('hello');
 * ```
 */

export {
  memoryEngine,
  type SearchDocument,
  type SearchEngine,
  type SearchResult,
} from './scout.ts';

export { SEARCH_DRIVERS, type SearchDriverName } from './scout.ts';
export { sqliteEngine, postgresEngine } from './drivers.ts';
export { databaseQuery } from './database-query.ts';
export type { QueryableDatabase } from './database-query.ts';

export {
  HOSTED_SEARCH_PROVIDERS,
  HostedSearchError,
  hostedSearch,
  type HostedSearchOptions,
  type HostedSearchProvider,
} from './hosted.ts';

export {
  engineFor,
  searchFromConfig,
  type ConfiguredSearch,
  type EnvRef,
  type QueryFn,
  type SearchBindings,
} from './config.ts';

export { createScoutBootstrap } from './bootstrap.ts';
export type { ScoutBootstrap, ScoutBootstrapOptions } from './bootstrap.ts';
