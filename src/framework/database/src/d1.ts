/**
 * The D1 driver (`DB-001`, default per ADR-0016).
 *
 * D1 is a Cloudflare binding, not a network service: a Worker receives a
 * `D1Database` object and talks to it in-process. Two consequences shape this
 * file:
 *
 * 1. **No connection management.** There is no pool, no `connect()`, no idle
 *    timeout to tune. `close()` is a no-op by design, and saying so is more
 *    honest than pretending there is something to release.
 * 2. **No interactive transactions.** `BEGIN`, `COMMIT`, `ROLLBACK` and
 *    `SAVEPOINT` are rejected by the engine. `batch()` is the only atomicity
 *    primitive, so it is not an optimisation here — it is the transaction.
 *
 * The binding is typed **structurally** rather than importing
 * `@cloudflare/workers-types`: that package is a 2 MB type dump, it would be a
 * runtime-neutrality violation to depend on it, and the driver only uses six
 * methods. Anything matching the shape works — Miniflare in dev, a real binding
 * in production, a fake in tests.
 */

import type { DbCapabilities, DbDriver, DbHealth, DbResult, DbStatement } from './driver.ts';

/** The subset of `D1PreparedStatement` the driver uses. */
export interface D1StatementLike {
  bind(...values: readonly unknown[]): D1StatementLike;
  all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
  /**
   * Results as positional arrays, in select order. This is the primitive a
   * query builder needs; re-ordering object rows by hand is how columns go
   * missing when two share a name.
   */
  raw?<T = unknown[]>(options?: { readonly columnNames?: boolean }): Promise<readonly T[]>;
  run(): Promise<D1ResultLike<never>>;
}

/** The subset of `D1Database` the driver uses. */
export interface D1Like {
  prepare(query: string): D1StatementLike;
  batch<T = Record<string, unknown>>(
    statements: readonly D1StatementLike[],
  ): Promise<readonly D1ResultLike<T>[]>;
  exec(query: string): Promise<{ readonly count: number; readonly duration: number }>;
}

/** The subset of `D1Result` the driver reads. */
export interface D1ResultLike<T> {
  readonly results?: readonly T[];
  readonly success: boolean;
  readonly error?: string;
  readonly meta?: {
    readonly changes?: number;
    readonly last_row_id?: number;
    readonly duration?: number;
  };
}

export const D1_CAPABILITIES: DbCapabilities = Object.freeze({
  interactiveTx: false,
  batch: true,
  placeholder: 'question',
  engine: 'd1',
  // A D1 binding *is* one connection to one database: every statement runs on the
  // same session, so there is nothing to reserve. Declaring `false` is what makes
  // `migrate` say "D1 has no advisory lock" instead of pretending to hold one.
  pinnedConnection: false,
});

export interface D1DriverOptions {
  readonly binding: D1Like;
  /** Statement time limit reported in health output; D1 itself caps at 30 s. */
  readonly statementTimeoutMs?: number;
  /** Injected for tests; defaults to the platform clock. */
  readonly now?: () => number;
}

function toError(result: D1ResultLike<unknown>): Error {
  return new Error(result.error ?? 'D1 statement failed');
}

/**
 * D1 reports failure in the result object rather than by throwing, so every call
 * has to check `success` explicitly. Missing that check is how a failed write
 * looks like a successful no-op.
 */
function checkResult<T>(result: D1ResultLike<T>): D1ResultLike<T> {
  if (!result.success) throw toError(result);
  return result;
}

export function createD1Driver(options: D1DriverOptions): DbDriver {
  const { binding } = options;
  const now = options.now ?? (() => Date.now());

  function prepare(statement: DbStatement): D1StatementLike {
    const prepared = binding.prepare(statement.sql);
    return statement.params.length === 0 ? prepared : prepared.bind(...statement.params);
  }

  function toRows(result: D1ResultLike<unknown>): readonly unknown[] {
    return result.results ?? [];
  }

  function toResult(result: D1ResultLike<unknown>): DbResult {
    const rows = toRows(result);
    const changes = result.meta?.changes ?? (rows.length === 0 ? 0 : rows.length);
    const lastRowId = result.meta?.last_row_id;

    return {
      rows,
      changes,
      ...(lastRowId === undefined ? {} : { lastInsertRowid: lastRowId }),
    };
  }

  return {
    capabilities: D1_CAPABILITIES,

    async query(statementValue: DbStatement): Promise<DbResult> {
      const prepared = prepare(statementValue);

      // Positional rows come from `raw()`, which is the engine's own answer. The
      // fallback exists because `raw` is optional in the structural type (a test
      // double need not implement it), and it is documented as lossy: it derives
      // order from object keys.
      if (statementValue.format === 'arrays') {
        if (prepared.raw !== undefined) {
          try {
            const rows = await prepared.raw();
            return { rows, changes: 0 };
          } catch (error: unknown) {
            // A statement that returns no rows (an INSERT) has nothing to read;
            // `raw()` on some bindings rejects. Fall through to `all()`.
            if (!/no rows|not a query/i.test(error instanceof Error ? error.message : ''))
              throw error;
          }
        }
        const result = checkResult(await prepared.all());
        return {
          rows: toRows(result).map((row) => Object.values(row as Record<string, unknown>)),
          changes: 0,
        };
      }

      return toResult(checkResult(await prepared.all()));
    },

    /**
     * One `batch()` call, which D1 executes as a single implicit transaction:
     * every statement commits or none does. The statements are prepared eagerly
     * because `batch` requires the full list before execution — the same
     * restriction the application code lives with.
     */
    async batch(statements: readonly DbStatement[]): Promise<readonly DbResult[]> {
      const prepared = statements.map(prepare);
      const results = await binding.batch(prepared);
      return results.map((result) => toResult(checkResult(result)));
    },

    async health(): Promise<DbHealth> {
      const started = now();
      try {
        const result = checkResult(await binding.prepare('SELECT 1 AS ok').all());
        return {
          ok: (result.results?.length ?? 0) > 0,
          engine: 'd1',
          latencyMs: now() - started,
          // D1 has no pool to report. Returning invented counters would make a
          // dashboard look richer and mean less.
          detail: {},
        };
      } catch (error: unknown) {
        return {
          ok: false,
          engine: 'd1',
          latencyMs: now() - started,
          detail: {},
          error: error instanceof Error ? error.message : 'unknown health failure',
        };
      }
    },

    async close(): Promise<void> {
      // Nothing to release: the binding is owned by the runtime, and a Worker
      // has no long-lived connection to drain. Implemented rather than omitted so
      // callers can treat every driver the same.
    },
  };
}
