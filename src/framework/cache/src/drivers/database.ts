/**
 * The `database` driver (`§ 4.1`, `CACHE-6`): Postgres and D1, one table.
 *
 * This is the driver that makes the *other* drivers' refusals meaningful. Tags are not
 * emulated with a keyspace scan anywhere else in this package because here they are a real
 * index; `increment` is not approximated elsewhere because here it is one statement with
 * `RETURNING`.
 *
 * Three design notes:
 *
 *   · **The client is app-supplied** (ADR-0027 § 1). The driver takes a structural
 *     `CacheSql` — `{ capabilities, query }` — which `@tsir/database`'s `Database` already
 *     satisfies, so `@tsir/cache` gains no dependency and one driver serves D1 and Postgres.
 *   · **Placeholders follow the engine.** `?` on D1, `$1` on Postgres
 *     (`DbCapabilities.placeholder`), resolved once per backend from `capabilities`.
 *   · **A counter is a numeric column, not arithmetic on a JSON string.** SQL increments
 *     atomically only on a column it can add to, so `increment` upserts into `counter` and
 *     reports it through `StoredValue.counterValue`; the wrapper rebuilds the codec's counter
 *     form, so `get` still returns the store's declared type.
 */

import type { CacheBackend, CacheDriver, StoredValue } from '../port.ts';

/** The slice of `@tsir/database` this driver needs. `Database` satisfies it structurally. */
export interface CacheSqlStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

export interface CacheSqlResult {
  readonly rows: readonly unknown[];
  readonly changes: number;
}

export interface CacheSql {
  readonly capabilities: {
    readonly engine: 'd1' | 'postgres';
    readonly placeholder: 'question' | 'dollar';
  };
  query(statement: CacheSqlStatement): Promise<CacheSqlResult>;
}

export interface DatabaseDriverOptions {
  readonly database: CacheSql;
  /** Default `cache_entries`. */
  readonly table?: string | undefined;
  /** Default `cache_entry_tags`. */
  readonly tagTable?: string | undefined;
  readonly now?: (() => number) | undefined;
}

export const DATABASE_CAPABILITIES = {
  persistent: true,
  sharedAcrossInstances: true,
  readYourWrites: true,
  tags: true,
  increment: true,
  ttl: true,
  clearAll: true,
} as const;

export interface CacheTableOptions {
  readonly engine: CacheSql['capabilities']['engine'];
  readonly table?: string | undefined;
  readonly tagTable?: string | undefined;
}

/**
 * The DDL, as statements a migration can carry.
 *
 * `tsir cache:table` prints these and a test setup runs them. Written out rather than
 * generated, because a cache table is two columns and an index — and a migration that says
 * what it does is reviewable.
 */
export function cacheTableDdl(options: CacheTableOptions): readonly string[] {
  const table = options.table ?? 'cache_entries';
  const tagTable = options.tagTable ?? 'cache_entry_tags';
  const bigint = options.engine === 'postgres' ? 'BIGINT' : 'INTEGER';

  return [
    `CREATE TABLE IF NOT EXISTS ${table} (\n  key TEXT PRIMARY KEY,\n  value TEXT,\n  counter ${bigint},\n  expires_at ${bigint}\n)`,
    `CREATE TABLE IF NOT EXISTS ${tagTable} (\n  key TEXT NOT NULL,\n  tag TEXT NOT NULL,\n  PRIMARY KEY (key, tag)\n)`,
    // The whole reason tags are supported here and refused elsewhere: invalidation is an
    // index seek, not a scan of the keyspace.
    `CREATE INDEX IF NOT EXISTS ${tagTable}_tag ON ${tagTable} (tag)`,
  ];
}

interface Row extends Record<string, unknown> {
  readonly value?: string | null;
  readonly counter?: unknown;
  readonly expires_at?: unknown;
  readonly removed?: unknown;
}

function finiteOrUndefined(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') return value;
  // coercion-ok: a BIGINT column is an integer timestamp or counter; converting the bigint
  // form is the whole point of the branch, and the range is far inside 2^53.
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'string') return undefined;
  // coercion-ok: BIGINT columns arrive as strings from several Postgres clients; anything
  // that is not a finite number is treated as absent rather than guessed at.
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function databaseDriver(options: DatabaseDriverOptions): CacheDriver<never> {
  const table = options.table ?? 'cache_entries';
  const tagTable = options.tagTable ?? 'cache_entry_tags';
  const now = options.now ?? Date.now;

  return {
    name: 'database',
    capabilities: DATABASE_CAPABILITIES,
    open(): CacheBackend {
      const { database } = options;
      const dollar = database.capabilities.placeholder === 'dollar';

      /** `?` on D1, `$n` on Postgres — from the engine, never from a guess. */
      const p = (index: number): string => (dollar ? `$${String(index)}` : '?');

      const run = async (sql: string, params: readonly unknown[] = []): Promise<readonly Row[]> => {
        const result = await database.query({ sql, params });
        return result.rows as readonly Row[];
      };

      const backend: CacheBackend = {
        name: 'database',
        capabilities: DATABASE_CAPABILITIES,
        now,

        async read(key: string): Promise<StoredValue | undefined> {
          const rows = await run(
            `SELECT value, counter, expires_at FROM ${table} WHERE key = ${p(1)}`,
            [key],
          );
          const row = rows[0];
          if (row === undefined) return undefined;

          const counter = finiteOrUndefined(row.counter);
          return {
            raw: row.value ?? '',
            expiresAt: finiteOrUndefined(row.expires_at),
            ...(counter === undefined ? {} : { counterValue: counter }),
          };
        },

        async write(
          key: string,
          raw: string,
          expiresAt: number | undefined,
          tags: readonly string[],
        ): Promise<void> {
          // One statement for the entry: `counter` is nulled, because writing a value turns a
          // counter row back into a value row rather than leaving two truths in one row.
          await run(
            `INSERT INTO ${table} (key, value, counter, expires_at) VALUES (${p(1)}, ${p(2)}, NULL, ${p(3)}) ` +
              `ON CONFLICT (key) DO UPDATE SET value = excluded.value, counter = NULL, expires_at = excluded.expires_at`,
            [key, raw, expiresAt ?? null],
          );

          // Tags are replaced, not merged: `set` describes the entry as it now is.
          await run(`DELETE FROM ${tagTable} WHERE key = ${p(1)}`, [key]);
          for (const tag of new Set(tags)) {
            await run(`INSERT INTO ${tagTable} (key, tag) VALUES (${p(1)}, ${p(2)})`, [key, tag]);
          }
        },

        async remove(key: string): Promise<boolean> {
          const rows = await run(`DELETE FROM ${table} WHERE key = ${p(1)} RETURNING key`, [key]);
          await run(`DELETE FROM ${tagTable} WHERE key = ${p(1)}`, [key]);
          return rows.length > 0;
        },

        /** `counter + by` under a row lock is the only version of this that is atomic. */
        async increment(key: string, by: number): Promise<number> {
          const rows = await run(
            `INSERT INTO ${table} (key, value, counter, expires_at) VALUES (${p(1)}, NULL, ${p(2)}, NULL) ` +
              `ON CONFLICT (key) DO UPDATE SET counter = COALESCE(${table}.counter, 0) + excluded.counter ` +
              `RETURNING counter`,
            [key, by],
          );
          const value = finiteOrUndefined(rows[0]?.counter);
          if (value === undefined) {
            throw new TypeError(`cache: increment of "${key}" returned no counter`);
          }
          return value;
        },

        async removeTag(tag: string): Promise<number> {
          // Count, delete the entries through the tag index, then the tag rows. Three
          // statements instead of `WHERE key = ANY(...)` so the same SQL runs on D1 and
          // Postgres without an array parameter.
          const [counted] = await run(
            `SELECT COUNT(*) AS removed FROM ${tagTable} WHERE tag = ${p(1)}`,
            [tag],
          );
          await run(
            `DELETE FROM ${table} WHERE key IN (SELECT key FROM ${tagTable} WHERE tag = ${p(1)})`,
            [tag],
          );
          await run(`DELETE FROM ${tagTable} WHERE tag = ${p(1)}`, [tag]);
          return finiteOrUndefined(counted?.removed) ?? 0;
        },

        async clear(): Promise<void> {
          await run(`DELETE FROM ${table}`);
          await run(`DELETE FROM ${tagTable}`);
        },
      };

      return backend;
    },
  };
}

export const databaseCapabilities = DATABASE_CAPABILITIES;
