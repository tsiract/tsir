/**
 * A D1-compatible binding backed by Bun's `bun:sqlite`.
 *
 * This is the **local dev / CLI fallback**: when no real D1 binding is
 * available (Cloudflare `env` only arrives inside a request, and CLI commands
 * run outside one), a SQLite file stands in for D1 so `migrate`, `db:seed`,
 * `queue:work`, etc. work locally.
 *
 * The shape matches `D1Like` structurally, so `createD1Driver` consumes it
 * without any branching. SQLite and D1 both speak SQL, so the translation is
 * thin: the main work is adapting `D1ResultLike`'s `meta.changes` /
 * `last_row_id` and rejecting D1's unsupported transaction statements.
 *
 * `prepare` is **deferred**: `sqlite.prepare(sql)` is only called when `all`,
 * `raw`, or `run` actually executes. This matters because the D1 driver's
 * `batch` prepares every statement up front — if a later statement (e.g.
 * `CREATE INDEX … ON users`) were prepared before the table-creating
 * statement ran, SQLite would reject it with "no such table".
 *
 * `bun:sqlite` is imported as a **type only** so apps that never use the
 * fallback don't pull it into their bundle.
 */

import type { Database as Sqlite } from 'bun:sqlite';
import type { D1Like, D1ResultLike, D1StatementLike } from './d1.ts';
import { TsirError } from '@tsir/core';

const READ_PREFIXES = /^\s*(select|pragma|with)\b/i;
const TX_STATEMENTS = ['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE'];

function isRead(sql: string): boolean {
  return READ_PREFIXES.test(sql);
}

function hasReturning(sql: string): boolean {
  return /\breturning\b/i.test(sql);
}

function isTx(sql: string): boolean {
  const trimmed = sql.trimStart().toUpperCase();
  return TX_STATEMENTS.some((p) => trimmed.startsWith(p));
}

/**
 * Wrap a `bun:sqlite` `Database` so it satisfies the `D1Like` contract.
 *
 * ```ts
 * import { Database as Sqlite } from 'bun:sqlite';
 * import { createSqliteBinding } from '@tsir/database';
 *
 * const binding = createSqliteBinding(new Sqlite('.tsir/app.db'));
 * ```
 */
export function createSqliteBinding(sqlite: Sqlite): D1Like {
  function wrap(sql: string, params: readonly unknown[]): D1StatementLike {
    return {
      bind(...values: readonly unknown[]): D1StatementLike {
        return wrap(sql, [...params, ...values]);
      },
      all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
        const bound = params as never[];
        if (!isRead(sql) && !hasReturning(sql)) {
          const info = sqlite.prepare(sql).run(...bound);
          return Promise.resolve({
            success: true,
            results: [],
            // coercion-ok: `lastInsertRowid` is a SQLite-provided integer (bigint on Bun); rowids are far inside 2^53.
            meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) },
          } as D1ResultLike<T>);
        }
        const rows = sqlite.prepare(sql).all(...bound) as T[];
        return Promise.resolve({ success: true, results: rows } as D1ResultLike<T>);
      },
      raw<T = unknown[]>(): Promise<readonly T[]> {
        const bound = params as never[];
        const rows = sqlite.prepare(sql).values(...bound) as T[];
        return Promise.resolve(rows);
      },
      run(): Promise<D1ResultLike<never>> {
        const bound = params as never[];
        const info = sqlite.prepare(sql).run(...bound);
        return Promise.resolve({
          success: true,
          results: [],
          // coercion-ok: `lastInsertRowid` is a SQLite-provided integer; rowids are far inside 2^53.
          meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) },
        });
      },
    };
  }

  function prepare(query: string): D1StatementLike {
    return wrap(query, []);
  }

  async function batch<T = Record<string, unknown>>(
    statements: readonly D1StatementLike[],
  ): Promise<readonly D1ResultLike<T>[]> {
    const results: D1ResultLike<T>[] = [];
    sqlite.exec('BEGIN');
    try {
      for (const s of statements) {
        const r = await s.all<T>();
        results.push(r);
      }
      sqlite.exec('COMMIT');
    } catch (err) {
      sqlite.exec('ROLLBACK');
      throw err;
    }
    return results;
  }

  async function exec(
    query: string,
  ): Promise<{ readonly count: number; readonly duration: number }> {
    const start = performance.now();
    if (isTx(query)) {
      throw new TsirError(
        'DB_TX_STATEMENT_UNSUPPORTED',
        `D1 does not support transaction statements: ${query}`,
        {
          kind: 'validation',
          hint: 'use batch([...]) for atomic multi-statement writes instead of BEGIN/COMMIT',
        },
      );
    }
    sqlite.exec(query);
    return { count: 0, duration: performance.now() - start };
  }

  return { prepare, batch, exec };
}
