/**
 * Scout (full-text search) bootstrap for the admin app.
 *
 * Uses the in-memory engine. For production, swap in `sqliteEngine` or
 * `postgresEngine` backed by the `search_index` table.
 */
import { createScoutBootstrap, memoryEngine } from '@tsir/scout';

export const scout = createScoutBootstrap({ engine: memoryEngine() });
export const searchEngineToken = scout.searchEngineToken;
export const searchEngineProvider = scout.searchEngineProvider;
