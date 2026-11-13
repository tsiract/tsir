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
 *
 * **The placeholder is a parameter, not a `?`.** The first version of this wrote `?` literals,
 * which is SQLite's placeholder and not Postgres's — so a `databaseStore` on Postgres failed with
 * `syntax error at or near "?"`. The store cannot ask the database which it is (there is no query
 * yet), so the caller says: `placeholder: 'dollar'`. Default `'question'`, because D1 and SQLite
 * are the defaults everywhere else and a wrong default that fails loudly beats one that fails
 * quietly.
 */
export interface DatabaseStoreOptions {
  /**
   * `question` (`?`, SQLite/D1) or `dollar` (`$1`, Postgres).
   *
   * Passed in rather than sniffed: a store that guessed would be right on D1 and produce a syntax
   * error on Postgres, and the error names the placeholder rather than the config that caused it.
   */
  readonly placeholder?: 'question' | 'dollar' | undefined;
  /** Default `features`. */
  readonly table?: string | undefined;
}

export function databaseStore(
  query: (sql: string, params: readonly unknown[]) => Promise<readonly Record<string, unknown>[]>,
  options: DatabaseStoreOptions = {},
): FeatureStore {
  const dollar = options.placeholder === 'dollar';
  const table = options.table ?? 'features';
  /** `$1`, `$2`, … for Postgres; `?` for everything else. */
  const placeholder = (index: number): string => (dollar ? `$${String(index + 1)}` : '?');

  return {
    async get(name) {
      const rows = await query(
        `SELECT name, description, rule FROM ${table} WHERE name = ${placeholder(0)}`,
        [name],
      );
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
        `INSERT INTO ${table} (name, description, rule) VALUES (${placeholder(0)}, ${placeholder(1)}, ${placeholder(2)}) ON CONFLICT(name) DO UPDATE SET description = excluded.description, rule = excluded.rule`,
        [def.name, def.description ?? null, JSON.stringify(def.rule)],
      );
    },
    async all() {
      const rows = await query(`SELECT name, description, rule FROM ${table}`, []);
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
