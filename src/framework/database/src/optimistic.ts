/**
 * Optimistic concurrency (`DB-011`).
 *
 * D1 has no interactive transactions, so the pattern that reads a row, decides,
 * and writes it back cannot hold a lock while it thinks. The portable
 * replacement is a version column:
 *
 * ```sql
 * UPDATE users SET email = ?, version = version + 1 WHERE id = ? AND version = ?
 * ```
 *
 * Zero rows changed means someone else wrote first. That is not an error the
 * caller should treat as "not found" — it is a **conflict**, and the correct
 * response is to re-read and retry, or to tell the user. Collapsing the two is
 * how a lost update becomes silent data corruption.
 *
 * Column and table names are validated as identifiers before they reach the SQL
 * string. They come from code, not from a request, but a helper that interpolates
 * an unvalidated string into SQL is the exact shape of an injection bug, and
 * "it only comes from code" stops being true the first time someone builds a
 * column name from a query parameter.
 */

import type { Database } from './database.ts';
import { statement, type DbStatement } from './driver.ts';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function identifier(value: string, what: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new TypeError(
      `${what} "${value}" is not a valid SQL identifier; use letters, digits and underscores`,
    );
  }
  return `"${value}"`;
}

export interface OptimisticUpdate {
  readonly table: string;
  readonly id: string | number;
  /** The version the caller read. */
  readonly expectedVersion: number;
  /** Column → new value. `undefined` values are rejected (use `null`). */
  readonly set: Readonly<Record<string, unknown>>;
  readonly idColumn?: string;
  readonly versionColumn?: string;
}

/**
 * Builds the guarded `UPDATE`.
 *
 * `version = version + 1` is written by the helper rather than by the caller, so
 * a forgotten bump cannot silently disable the guard.
 */
export function optimisticUpdate(update: OptimisticUpdate): DbStatement {
  const table = identifier(update.table, 'table');
  const idColumn = identifier(update.idColumn ?? 'id', 'id column');
  const versionColumn = identifier(update.versionColumn ?? 'version', 'version column');

  const columns = Object.keys(update.set);
  if (columns.length === 0)
    throw new TypeError('optimisticUpdate needs at least one column to set');

  const assignments: string[] = [];
  const params: unknown[] = [];
  for (const column of columns) {
    assignments.push(`${identifier(column, 'column')} = ?`);
    params.push(update.set[column]);
  }
  assignments.push(`${versionColumn} = ${versionColumn} + 1`);

  return statement(
    `update ${table} set ${assignments.join(', ')} where ${idColumn} = ? and ${versionColumn} = ?`,
    [...params, update.id, update.expectedVersion],
  );
}

export type OptimisticResult =
  | { readonly ok: true; readonly version: number }
  | { readonly ok: false; readonly reason: 'conflict' | 'missing' };

/**
 * Runs the guarded update and distinguishes a conflict from a missing row.
 *
 * `missing` is only reported when the row is provably absent (a follow-up read
 * inside the same call), because "0 rows changed" alone cannot tell a stale
 * version from a deleted row — and answering "not found" for a conflict makes
 * a retry loop give up one attempt too early.
 */
export async function applyOptimistic(
  database: Database,
  update: OptimisticUpdate,
): Promise<OptimisticResult> {
  const change = await database.query(optimisticUpdate(update));
  if (change.changes > 0) return { ok: true, version: update.expectedVersion + 1 };

  const idColumn = identifier(update.idColumn ?? 'id', 'id column');
  const table = identifier(update.table, 'table');
  const found = await database.query(
    statement(`select 1 as present from ${table} where ${idColumn} = ? limit 1`, [update.id]),
  );

  return { ok: false, reason: found.rows.length === 0 ? 'missing' : 'conflict' };
}

export interface RetryOptions {
  /** Total attempts, including the first. Default 3. */
  readonly attempts?: number;
  /** Base delay in ms; doubled per attempt. Default 10. */
  readonly backoffMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Retries a function that reports a conflict, with exponential backoff.
 *
 * Deliberately narrow: it retries only `{ ok: false, reason: 'conflict' }`. A
 * generic "retry on any error" wrapper is how a duplicate insert becomes
 * three duplicate inserts, and D1's `batch()` is not idempotent either.
 */
export async function retryOnConflict<T>(
  work: () => Promise<OptimisticResult & { readonly value?: T }>,
  options: RetryOptions = {},
): Promise<OptimisticResult & { readonly value?: T }> {
  const attempts = options.attempts ?? 3;
  const backoffMs = options.backoffMs ?? 10;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let result = await work();
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    if (result.ok || result.reason !== 'conflict') return result;
    await sleep(backoffMs * 2 ** (attempt - 1));
    result = await work();
  }
  return result;
}
