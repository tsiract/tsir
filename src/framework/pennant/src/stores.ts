/**
 * Built-in feature stores.
 *
 *   · `memoryStore`  — a Map; for tests and single-process dev.
 *   · `databaseStore` — reads/writes a `features` table (caller supplies a query
 *     function so the store is ORM-agnostic).
 *   · `nullStore`    — always returns no flags; useful as a fallback.
 */
import type { FeatureDefinition, FeatureRule, FeatureStore } from './pennant.ts';

export function memoryStore(initial: readonly FeatureDefinition[] = []): FeatureStore {
  const map = new Map<string, FeatureDefinition>();
  for (const def of initial) map.set(def.name, def);
  return {
    async get(name) {
      return map.get(name) ?? null;
    },
    async set(def) {
      map.set(def.name, def);
    },
    async all() {
      return [...map.values()];
    },
  };
}

export function nullStore(): FeatureStore {
  return {
    async get() {
      return null;
    },
    async set() {},
    async all() {
      return [];
    },
  };
}

/**
 * A database-backed store. The caller supplies a `query` function that runs a
 * parameterised SQL statement and returns rows. This keeps the store free of
 * any specific ORM.
 *
 * Expected table shape:
 *   CREATE TABLE features (
 *     name TEXT PRIMARY KEY,
 *     description TEXT,
 *     rule TEXT NOT NULL  -- JSON-serialised FeatureRule
 *   );
 */
export function databaseStore(
  query: (sql: string, params: readonly unknown[]) => Promise<readonly Record<string, unknown>[]>,
): FeatureStore {
  return {
    async get(name) {
      const rows = await query('SELECT name, description, rule FROM features WHERE name = ?', [
        name,
      ]);
      const row = rows[0];
      if (row === undefined) return null;
      const description = typeof row.description === 'string' ? row.description : undefined;
      const rule = JSON.parse(String(row.rule)) as FeatureRule;
      return {
        name: String(row.name),
        ...(description !== undefined ? { description } : {}),
        rule,
      };
    },
    async set(def) {
      await query(
        'INSERT INTO features (name, description, rule) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET description = excluded.description, rule = excluded.rule',
        [def.name, def.description ?? null, JSON.stringify(def.rule)],
      );
    },
    async all() {
      const rows = await query('SELECT name, description, rule FROM features', []);
      return rows.map((row) => {
        const description = typeof row.description === 'string' ? row.description : undefined;
        const rule = JSON.parse(String(row.rule)) as FeatureRule;
        return {
          name: String(row.name),
          ...(description !== undefined ? { description } : {}),
          rule,
        };
      });
    },
  };
}
