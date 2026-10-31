/**
 * Drizzle on top of the driver, Postgres edition.
 *
 * The reasoning is the same as `drizzle.ts` (`05-database.md § 2.2`), and the
 * alternatives are the same shape:
 *
 *   1. `drizzle-orm/postgres-js` — hand Drizzle the raw client. A second path to
 *      the database that bypasses the drain counter, the capability checks and
 *      query redaction.
 *   2. `drizzle-orm/pg-proxy` — hand Drizzle a callback into *our* `Database`.
 *      Every generated statement is a `DbStatement` like any other.
 *
 * This file takes (2). The consequence must be stated rather than discovered:
 * **Drizzle's `db.transaction()` throws on this dialect** — pg-proxy raises
 * "Transactions are not supported by the Postgres Proxy driver". That is not a
 * gap in the driver: a transaction is a property of the *connection*, and the
 * connection belongs to `Database`. Use `database.interactiveTx()` (DB-013), and
 * bind a Drizzle instance to the transaction-scoped database it hands you:
 *
 * ```ts
 * await database.interactiveTx(async (tx) => {
 *   const dtx = createPgDrizzle(tx);
 *   await dtx.insert(users).values({ email });
 * });
 * ```
 *
 * Rows are requested positionally (`format: 'arrays'`), for the same reason as
 * SQLite: `mapResultRow` indexes columns by position, and a proxy has no field
 * metadata to re-order objects by. The query builder is exact; hand-written
 * `db.execute(sql\`…\`)` returns rows in select order.
 */

import { type PgRemoteDatabase, drizzle } from 'drizzle-orm/pg-proxy';

import type { Database } from '../database.ts';
import { statement as makeStatement, type DbStatement } from '../driver.ts';

/** pg-proxy's methods: rows or a write, nothing else. */
type ProxyMethod = 'all' | 'execute';

export function createPgDrizzle<TSchema extends Record<string, unknown>>(
  database: Database,
  config: { readonly schema?: TSchema } = {},
): PgRemoteDatabase<TSchema> {
  const callback = async (
    sql: string,
    params: unknown[],
    method: ProxyMethod,
  ): Promise<{ rows: unknown[] }> => {
    const statement: DbStatement = makeStatement(
      sql,
      params,
      method === 'all' ? 'arrays' : 'objects',
    );
    const result = await database.query(statement);
    return { rows: [...result.rows] };
  };

  return drizzle(callback, config as never);
}
