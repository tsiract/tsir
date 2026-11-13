/**
 * Built-in feature stores.
 *
 *   · `memoryStore`  — a Map; for tests and single-process dev.
 *   · `databaseStore` — reads/writes a `features` table (caller supplies a query
 *     function so the store is ORM-agnostic).
 *   · `nullStore`    — always returns no flags; useful as a fallback.
 */
import { engineUnsupported } from './errors.ts';
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
 * The DDL a `databaseStore` needs, per engine.
 *
 * The doc comment below told whoever read it what the table looked like, and nothing turned that
 * into a migration — so `tsir.js` could name the `database` driver for flags, the app built it, and
 * the first `active()` failed on a missing table. `@tsir/queue` already ships `queueTableDdl` for the
 * same reason; this is the flag half of that.
 *
 * `rule` is `TEXT` on every engine rather than a JSON column: SQLite and D1 have no JSON type, and
 * the three engines that do disagree about how to query one. The store serialises, so the column is
 * a string and stays one.
 */
export function featureTableDdl(
  options: { readonly engine: 'd1' | 'postgres' | 'mysql' | 'sqlite'; readonly table?: string } = {
    engine: 'postgres',
  },
): readonly string[] {
  const table = options.table ?? 'features';
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (`,
    '  name TEXT PRIMARY KEY,',
    '  description TEXT,',
    '  rule TEXT NOT NULL',
    ')',
  ];
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
  /**
   * The connection's engine, when the caller knows it.
   *
   * Optional because this store only requires a query function, and a test double has no engine.
   * Supplying it turns a silent syntax error into a boot refusal on the one engine whose upsert
   * cannot express this store's `ON CONFLICT (name) DO UPDATE` — MySQL. `dollar` alone cannot
   * distinguish Postgres from MySQL, which is why the flag is not enough.
   */
  readonly engine?: 'd1' | 'postgres' | 'mysql' | 'sqlite' | undefined;
  /** Default `features`. */
  readonly table?: string | undefined;
}

export function databaseStore(
  query: (sql: string, params: readonly unknown[]) => Promise<readonly Record<string, unknown>[]>,
  options: DatabaseStoreOptions = {},
): FeatureStore {
  const dollar = options.placeholder === 'dollar';
  const table = options.table ?? 'features';

  // Constructed, so this is boot time. A store that built and then failed on `set` would lose the
  // flag write and report a syntax error from a layer that never saw the config.
  if (options.engine === 'mysql') {
    throw engineUnsupported(table, options.engine);
  }
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
