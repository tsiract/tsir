/**
 * Drizzle on top of the driver (`DB-002`).
 *
 * There are two ways to put Drizzle in front of D1:
 *
 *   1. hand it the raw `D1Database` binding (`drizzle-orm/d1`), or
 *   2. hand it a callback that executes SQL through *our* driver
 *      (`drizzle-orm/sqlite-proxy`).
 *
 * This package takes (2), because (1) creates a second path to the database that
 * bypasses everything this package exists for: the drain counter during
 * shutdown, the capability checks, query redaction (DB-009) and slow-query
 * logging (DB-009/DB-010 would otherwise only see hand-written calls). Two ways
 * to reach a database is how "why did that query not appear in the logs" becomes
 * an afternoon.
 *
 * The cost is one extra function call per statement. The benefit is that every
 * query Drizzle generates is a `DbStatement` like any other — so a future
 * logging, tracing or metrics layer needs exactly one hook.
 *
 * `drizzle-orm/sqlite-proxy` is dialect-level, not driver-level: it produces SQL
 * for SQLite, which is what D1 speaks. Postgres will use `drizzle-orm/node-postgres`
 * over the Postgres driver (DB-012) with the same one-path rule.
 *
 * ## Two behaviours worth knowing before you debug them
 *
 * 1. **Drizzle wraps every driver error** in a `DrizzleQueryError` whose message
 *    is `Failed query: …`. The original `TsirError` (with its `code`) is on
 *    `cause`. Use `rootCause()` below rather than reading `.code` off the thrown
 *    value — it will be `undefined`.
 * 2. **Raw SQL returns positional rows.** `db.all(sql\`…\`)` has no field
 *    metadata to map, so a row arrives as `[3]`, not `{ count: 3 }`. The query
 *    builder (`db.select().from(users)`) does map, because the table carries the
 *    column definitions. This is the price of the proxy dialect, and it is
 *    consistent: the same shape Drizzle would give you from any proxy driver.
 */

import { type SqliteRemoteDatabase, drizzle } from 'drizzle-orm/sqlite-proxy';

import type { Database } from './database.ts';
import { statement as makeStatement, type DbStatement } from './driver.ts';

/** Drizzle's proxy methods, mapped to what they mean for a driver. */
type ProxyMethod = 'run' | 'all' | 'values' | 'get';

/**
 * Statements that write. They still return rows from `run()` — D1 reports
 * `changes` rather than a result set for those, which is why the driver returns
 * an empty array instead of guessing.
 */
function isRowsQuery(method: ProxyMethod): boolean {
  return method !== 'run';
}

/**
 * Creates a Drizzle instance bound to a `Database`.
 *
 * ```ts
 * const db = createDrizzle(database, { schema });
 * const rows = await db.select().from(users).where(eq(users.id, 7));
 * ```
 *
 * `db.transaction(...)` is available in Drizzle's type but **fails at runtime on
 * D1** — the proxy issues `begin`, which the engine rejects. That is the
 * documented cliff (ADR-0016), and `drizzle.test.ts` asserts the failure rather
 * than leaving it as folklore: use `batch([...])` or optimistic concurrency.
 */
export function createDrizzle<TSchema extends Record<string, unknown>>(
  database: Database,
  config: { readonly schema?: TSchema } = {},
): SqliteRemoteDatabase<TSchema> {
  const callback = async (
    sql: string,
    params: unknown[],
    method: ProxyMethod,
  ): Promise<{ rows: unknown[] }> => {
    const statement: DbStatement = makeStatement(
      sql,
      params,
      isRowsQuery(method) ? 'arrays' : 'objects',
    );
    const result = await database.query(statement);

    // `get` is a single row; the proxy unwraps `rows[0]` itself, so returning the
    // array is correct for both.
    return { rows: [...result.rows] };
  };

  /**
   * The batch path, which is the portable atomic write.
   *
   * Drizzle calls this for `db.batch([...])`. Everything goes through
   * `Database.batch`, so the statements land in one engine transaction — the
   * only atomicity primitive D1 has.
   */
  const batchCallback = async (
    batch: readonly {
      readonly sql: string;
      readonly params: unknown[];
      readonly method: ProxyMethod;
    }[],
  ): Promise<{ rows: unknown[] }[]> => {
    const statements = batch.map((entry) =>
      makeStatement(entry.sql, entry.params, isRowsQuery(entry.method) ? 'arrays' : 'objects'),
    );
    const results = await database.batch(statements);
    return results.map((result) => ({ rows: [...result.rows] }));
  };

  return drizzle(callback, batchCallback, config as never);
}

/**
 * The innermost `cause` of an error chain.
 *
 * Drizzle, `fetch` and most runtimes re-wrap failures. Mapping an error to a
 * status or a log level almost always needs the original, and two lines of
 * `while (error.cause)` scattered across the codebase is how one of them ends up
 * missing.
 */
export function rootCause(error: unknown): unknown {
  let current = error;
  const seen = new Set<unknown>();
  while (
    typeof current === 'object' &&
    current !== null &&
    'cause' in current &&
    !seen.has(current)
  ) {
    seen.add(current);
    const next = (current as { cause?: unknown }).cause;
    if (next === undefined) break;
    current = next;
  }
  return current;
}

/** The `code` of the innermost error that has one, e.g. `DB_CLOSED`. */
export function errorCode(error: unknown): string | undefined {
  const root = rootCause(error);
  if (typeof root !== 'object' || root === null) return undefined;
  const code = (root as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
