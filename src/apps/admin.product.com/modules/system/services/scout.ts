/**
 * Scout (full-text search) bootstrap for the admin app.
 *
 * Uses the in-memory engine. For production, swap in `sqliteEngine` or
 * `postgresEngine` backed by the `search_index` table.
 */
import { createScoutBootstrap, memoryEngine } from '@tsir/scout';
import { isProduction } from '@tsir/core';

// `CAP-007`: a `memory` index that dies with the isolate is an empty search box after every cold
// start. Refused in production, where the configuration to fix is one block in `tsir.js`.
export const scout = createScoutBootstrap({
  ...(isProduction() ? { search: { driver: 'memory' } } : { engine: memoryEngine() }),
  production: isProduction(),
});
export const searchEngineToken = scout.searchEngineToken;
export const searchEngineProvider = scout.searchEngineProvider;
