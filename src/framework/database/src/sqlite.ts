/**
 * The `sqlite` engine (`CAP-009`, `DB-027`).
 *
 * `sqlite` was in the capability map and not in `DATABASE_ENGINES`. The distinction matters to an
 * application: the framework *has* SQLite — `sqlite-binding.ts` stands in for D1 in the CLI and in
 * `wrangler dev` — but there was no way to say "this connection is a SQLite file" in
 * `config/database.ts`. A single-binary deployment, a test suite, an embedded read model and a
 * local-first desktop build are all SQLite, and all of them were expressed as `d1` with a binding
 * nobody had.
 *
 * ## Not a second SQLite
 *
 * D1 *is* SQLite, so this driver and `d1.ts` must not drift. `createD1Driver` is given a
 * `D1Like`; `createSqliteBinding` produces exactly one from a `bun:sqlite` handle. So this
 * driver is the D1 driver plus a handle, and the only thing that can disagree between them is the
 * statement translation, which there is now only one of.
 *
 * ## What differs from D1, and why the capabilities say so
 *
 * A file is not a service: it has a session, so `BEGIN`/`COMMIT` are real and `interactiveTx` is
 * `true` — a claim D1 cannot make and this must not inherit. `batch` stays `true` (it is D1's
 * `batch`, which already wraps a transaction). `pinnedConnection` is `false`: Bun's SQLite handle
 * is one connection, so pinning is a no-op rather than a capability.
 *
 * The driver never imports `bun:sqlite` at module scope — it takes the handle. The same reason as
 * `bootstrap.ts`: a static import drags a Bun builtin into every bundle that imports
 * `@tsir/database`, and a Workers build rejects it outright.
 */

import { TsirError } from '@tsir/core';

import { createD1Driver } from './d1.ts';
import type { DbCapabilities, DbDriver, DbHealth, DbResult, DbStatement } from './driver.ts';
import { createSqliteBinding } from './sqlite-binding.ts';

/**
 * The verbatim `bun:sqlite` surface this driver touches.
 *
 * Structural, like every other driver boundary here: a test passes a fake, and the real handle is
 * only ever `import`ed by the caller that has one.
 */
export interface SqliteLike {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    values(...params: unknown[]): unknown[][];
  };
  exec(sql: string): void;
  close(): void;
}

/**
 * `interactiveTx: true` is the whole difference from `D1_CAPABILITIES`, and it is a fact about the
 * file rather than a promise this driver makes: `BEGIN IMMEDIATE` on a file is a real lock.
 */
export const SQLITE_CAPABILITIES: DbCapabilities = Object.freeze({
  interactiveTx: true,
  batch: true,
  placeholder: 'question',
  // `driver.ts` names the engine. `d1` is the same SQLite, reached differently, and reporting it
  // as `d1` would make health output claim a binding this driver has no way to have.
  engine: 'sqlite',
  pinnedConnection: false,
});

export interface SqliteDriverOptions {
  /** An open `bun:sqlite` handle. The caller owns opening and closing the file. */
  readonly handle: SqliteLike;
  /** Engine statement cap. SQLite has no server-side timeout; this is the caller's patience. */
  readonly statementTimeoutMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}

/**
 * Build the driver.
 *
 * ```ts
 * import { Database as Sqlite } from 'bun:sqlite';
 * import { createSqliteDriver } from '@tsir/database';
 *
 * const db = createSqliteDriver({ handle: new Sqlite('.tsir/app.db') });
 * ```
 */
/**
 * The transaction boundary, shared by the driver and by the deferred wrapper in `from-config.ts`.
 *
 * Extracted because the wrapper must forward `begin` for the capability it declares, and a second
 * copy of `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` is a second chance to get the rollback wrong.
 */
export function sqliteBegin<T>(
  handle: SqliteLike,
  inner: DbDriver,
  work: (tx: DbDriver) => Promise<T>,
): Promise<T> {
  handle.exec('BEGIN IMMEDIATE');
  const tx: DbDriver = {
    capabilities: SQLITE_CAPABILITIES,
    query: (statement) => inner.query(statement),
    batch: (statements) => inner.batch(statements),
    begin: () =>
      Promise.reject(
        new TsirError('DB_TX_NESTED_UNSUPPORTED', 'nested transaction on a sqlite file', {
          kind: 'validation',
          hint: 'the outer transaction already covers this work — return from it and commit once',
        }),
      ),
    health: async () => ({ ...(await inner.health()), engine: 'sqlite' }),
    close: () => Promise.resolve(),
  };
  return work(tx).then(
    (value) => {
      handle.exec('COMMIT');
      return value;
    },
    (error: unknown) => {
      handle.exec('ROLLBACK');
      throw error;
    },
  );
}

export function createSqliteDriver(options: SqliteDriverOptions): DbDriver {
  // Every statement goes through the D1 translation, so `changes`/`last_row_id` and the
  // read-versus-write decision are the same code the local CLI fallback already runs.
  const inner = createD1Driver({
    binding: createSqliteBinding(
      options.handle as unknown as Parameters<typeof createSqliteBinding>[0],
    ),
    ...(options.statementTimeoutMs === undefined
      ? {}
      : { statementTimeoutMs: options.statementTimeoutMs }),
  });

  return {
    capabilities: SQLITE_CAPABILITIES,

    query(statement: DbStatement): Promise<DbResult> {
      return inner.query(statement);
    },

    batch(statements: readonly DbStatement[]): Promise<readonly DbResult[]> {
      return inner.batch(statements);
    },

    async health(): Promise<DbHealth> {
      // The inner driver is the D1 driver, so it reports `engine: 'd1'` — true of the code path and
      // false of this connection. An operator reading health output would be told to look for a
      // Cloudflare binding that does not exist.
      const health = await inner.health();
      return { ...health, engine: 'sqlite' };
    },

    /**
     * `interactiveTx` is declared `true`, so this must do more than `batch`: a transaction that
     * is not atomic is worse than one that is refused. `BEGIN IMMEDIATE` takes the write lock at
     * the start rather than at the first write, so two writers cannot both get as far as believing
     * they hold it.
     */
    begin<T>(work: (tx: DbDriver) => Promise<T>): Promise<T> {
      return sqliteBegin(options.handle, inner, work);
    },

    close(): Promise<void> {
      // The handle is the caller's. An application that opened the file knows whether anything
      // else is using it; closing it here would pull the file out from under a second driver.
      return Promise.resolve();
    },
  };
}
