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

export { sqliteEngine, postgresEngine } from './drivers.ts';

export { createScoutBootstrap } from './bootstrap.ts';
export type { ScoutBootstrap, ScoutBootstrapOptions } from './bootstrap.ts';
