/**
 * A real Postgres client for the integration suites.
 *
 * `@tsir/database` deliberately ships no Postgres driver dependency (ADR-0009):
 * the application creates the client and hands it in. The integration suites are
 * an application, so *they* create one — with Bun's built-in `SQL`, which means
 * proving the framework against a real server costs no dependency at all.
 *
 * Lives in `src/tools/` rather than in a package because three packages
 * (`database`, `migrate`, `seed`) need it and none of them may import the others'
 * test helpers (boundary rules in `src/tools/check-boundaries.ts`).
 *
 * Used only by `*.integration.test.ts`, which `bun test` does not run: the runner
 * `src/tools/test-integration.ts` boots them only when `DATABASE_URL` is set.
 */

import { SQL } from 'bun';

// Type-only and relative on purpose: `src/tools/` is outside the workspace graph,
// so a `@tsir/*` specifier would need the package installed at the repository
// root. A type import costs nothing at runtime and keeps the dependency honest.
import type {
  PgClientLike,
  PgQueryLike,
  PgResultLike,
} from '../framework/database/src/postgres.ts';

type BunSql = InstanceType<typeof SQL>;

/** Rows plus the counters `postgres.js` would attach, so the driver sees one shape. */
function toResult(rows: readonly Record<string, unknown>[], sql: string): PgResultLike {
  const result = Object.assign([...rows], {
    command: /^\s*(insert|update|delete)/i.test(sql) ? 'INSERT' : 'SELECT',
    count: rows.length,
  });
  return result;
}

/**
 * Adapts a Bun `SQL` instance (or a transaction scope of one) to `PgClientLike`.
 *
 * The one concession: `raw()` re-derives positional rows from object rows. Bun
 * returns column order as object key order, which is the order Drizzle's proxy
 * maps by; a statement selecting the same column name twice would collapse in
 * either shape, so no information that matters is lost.
 */
function adapt(source: BunSql): PgClientLike {
  const scope = source as unknown as {
    unsafe(
      sql: string,
      parameters?: readonly unknown[],
    ): Promise<readonly Record<string, unknown>[]>;
    begin?: <T>(fn: (tx: BunSql) => Promise<T>) => Promise<T>;
    savepoint?: <T>(fn: (tx: BunSql) => Promise<T>) => Promise<T>;
    reserve?: () => Promise<BunSql>;
    release?: () => void;
  };

  return {
    unsafe(sql: string, parameters?: readonly unknown[]): PgQueryLike {
      const run = scope.unsafe(sql, parameters ?? []);
      return {
        then<TResult1 = PgResultLike, TResult2 = never>(
          onFulfilled?: ((value: PgResultLike) => TResult1 | PromiseLike<TResult1>) | null,
          onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ): PromiseLike<TResult1 | TResult2> {
          return run.then((rows) => toResult(rows, sql)).then(onFulfilled, onRejected);
        },
        raw: async () => (await run).map((row) => Object.values(row)),
      };
    },
    async begin<T>(work: (scope: PgClientLike) => Promise<T>): Promise<T> {
      // A nested `begin()` is a savepoint in `postgres.js`, and the driver relies
      // on that. Bun's SQL refuses `begin()` inside a transaction and offers
      // `savepoint()` instead, so the adapter maps one onto the other rather than
      // letting the driver discover the difference at runtime.
      const open = (scope.savepoint ?? scope.begin)?.bind(scope);
      if (open === undefined) throw new Error('this SQL scope cannot open a transaction');
      return open((tx) => work(adapt(tx)));
    },
    async reserve(): Promise<PgClientLike> {
      // Bun's `reserve()` pins one connection out of the pool (`DB-018`).
      const pin = scope.reserve?.bind(scope);
      if (pin === undefined) throw new Error('this SQL client cannot reserve a connection');
      return adapt(await pin());
    },
    async end(): Promise<void> {
      // The pool belongs to whoever created it; a scope must not end it.
    },
    release(): void {
      // Only a reserved connection has something to hand back.
      scope.release?.();
    },
  };
}

export interface TestDatabase {
  /** What the framework sees. */
  readonly client: PgClientLike;
  /** Escape hatch for setup and teardown: create/drop tables between tests. */
  run(sql: string, params?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
  /** A client whose pool has exactly one connection, i.e. a pinned session. */
  readonly single: PgClientLike;
  close(): Promise<void>;
}

/**
 * Connects to `DATABASE_URL`.
 *
 * Two clients, on purpose: `client` is a pool (the realistic production shape),
 * `single` has one connection (`max: 1`). The second is what a migration runner
 * needs when it relies on session state, and the integration suite asserts that
 * the framework does not depend on the caller getting that right.
 */
export function connectPostgres(url: string): TestDatabase {
  const pooled = new SQL({ url, max: 5 });
  const single = new SQL({ url, max: 1 });

  return {
    client: adapt(pooled),
    single: adapt(single),
    async run(sql, params) {
      return await pooled.unsafe(sql, params as unknown[]);
    },
    async close() {
      await pooled.close();
      await single.close();
    },
  };
}

/** The URL the suites expect, or `undefined` when the runner was not asked to run them. */
export function databaseUrl(): string | undefined {
  const url = process.env['DATABASE_URL'];
  return url === undefined || url === '' ? undefined : url;
}
