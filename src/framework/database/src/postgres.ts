/**
 * The Postgres driver (`DB-012`, ADR-0009).
 *
 * Postgres is the escape hatch from D1: real transactions, real constraints, no
 * 10 GB ceiling — at the cost of a network round trip and a connection pool that
 * D1 does not have.
 *
 * ## The client is supplied, not imported
 *
 * This file never imports `postgres` (or `pg`). It is typed against a
 * **structural** subset of `postgres.js`, the way `d1.ts` is typed against a
 * structural `D1Database`: the application creates the client and passes it in.
 * Three things follow, and all three are the point (ADR-0009):
 *
 *   1. `@tsir/database` gains **zero** runtime dependencies for Postgres.
 *   2. A bundle that does not use Postgres cannot contain a Postgres client —
 *      proven by `verify-dist`, not promised.
 *   3. The driver is testable without a server: a fake client that returns rows
 *      is enough, and `type-tests/postgres.types.ts` proves the real client still
 *      satisfies the shape.
 *
 * ## Transactions are a capability, not a comment
 *
 * `interactiveTx` is `true` **only** when the client exposes `begin()`. A driver
 * that claims it otherwise turns a boot-time fact into a 500 on the one request
 * that needed a transaction — the failure mode ADR-0015 exists to prevent.
 * `createDatabase` enforces the correspondence in both directions.
 */

import { TsirError } from '@tsir/core';

import type { DbCapabilities, DbDriver, DbHealth, DbResult, DbStatement } from './driver.ts';

/**
 * The subset of `postgres.js`'s `Sql` the driver uses.
 *
 * `unsafe(sql, params)` is the only way to run parameterised SQL without the
 * tagged-template API — a template tag cannot express "SQL that is already
 * built", which is what a driver is handed.
 */
export interface PgClientLike {
  unsafe(query: string, parameters?: readonly unknown[]): PgQueryLike;
  /** Ends the pool. Absent on a transaction scope, which its parent owns. */
  end?(options?: { readonly timeout?: number }): Promise<void>;
  /**
   * Pins one connection (`DB-018`). `postgres.js` and Bun's `SQL` both provide
   * it; a client without it makes `pinnedConnection` false rather than lying.
   */
  reserve?(): Promise<PgClientLike> | PgClientLike;
  /** Returns a reserved connection to its pool. Called instead of `end()`. */
  release?(): void | Promise<void>;
  /**
   * Opens a transaction and hands the callback a client scoped to it.
   *
   * Its presence *is* the `interactiveTx` capability. On `postgres.js` a nested
   * `begin()` inside a transaction becomes a `SAVEPOINT`, which is why nesting is
   * not special-cased here.
   */
  begin?<T>(work: (scope: PgClientLike) => Promise<T>): Promise<T>;
}

/**
 * What `unsafe()` resolves to: rows, plus the counters `postgres.js` attaches to
 * the result array (`count` for writes, `command`, `state`).
 */
export interface PgResultLike extends ReadonlyArray<Record<string, unknown>> {
  readonly count?: number;
  readonly command?: string;
}

/** A pending query is a thenable, not a `Promise`; `await` is all this needs. */
export interface PgQueryLike extends PromiseLike<PgResultLike> {
  /** Rows as positional arrays, for query builders that map columns by index. */
  raw?(): Promise<readonly unknown[]>;
}

/** Pool size the client should be created with for a deploy target (ADR-0009 § 3). */
export type DeployTargetName = 'bun' | 'lambda' | 'cloudflare';

export interface PoolOptions {
  readonly max: number;
  readonly idle_timeout: number;
  readonly connect_timeout: number;
  readonly application_name?: string;
}

/**
 * The connection ceiling per target.
 *
 * A Lambda function's concurrency *is* its pool: 200 instances × 10 connections
 * is 2 000 sockets against RDS Proxy, which fails as a connection storm long
 * before it fails as a slow query. A Worker on Hyperdrive has already been given
 * a pooler, so opening many connections fights the thing that was supposed to
 * help. Only a long-running server gets the configured number, because there the
 * number is a real tuning knob.
 */
const POOL_CEILING: Readonly<Record<DeployTargetName, number>> = {
  bun: Number.POSITIVE_INFINITY,
  lambda: 1,
  cloudflare: 5,
};

export interface PoolInput {
  readonly target: DeployTargetName;
  /** `database.pool` from config, if the application set one. */
  readonly pool?: {
    readonly max?: number;
    readonly idleTimeoutMs?: number;
    readonly connectTimeoutMs?: number;
  };
  readonly applicationName?: string;
  readonly searchPath?: string;
}

export interface ResolvedPool {
  readonly options: PoolOptions;
  /** True when the target's ceiling lowered the requested size. */
  readonly clamped: boolean;
  readonly max: number;
}

/**
 * Turns configuration into client options, and refuses to open a connection
 * storm.
 *
 * Returned rather than applied so the caller — and the boot log — can see that a
 * `max: 20` on Lambda became `1` instead of wondering why throughput is flat.
 */
export function resolvePool(input: PoolInput): ResolvedPool {
  const requested = input.pool?.max ?? 10;
  const ceiling = POOL_CEILING[input.target];
  const max = Math.min(requested, ceiling);
  const options: PoolOptions = {
    max,
    idle_timeout: Math.round((input.pool?.idleTimeoutMs ?? 30_000) / 1000),
    connect_timeout: Math.round((input.pool?.connectTimeoutMs ?? 10_000) / 1000),
    ...(input.applicationName === undefined ? {} : { application_name: input.applicationName }),
  };
  return { options, clamped: max < requested, max };
}

export interface PostgresDriverOptions {
  readonly client: PgClientLike;
  /** Reported by `health()`; Postgres enforces its own `statement_timeout`. */
  readonly statementTimeoutMs?: number;
  /** Injected for tests; defaults to the platform clock. */
  readonly now?: () => number;
  /** Pool size the client was created with, echoed in `health().detail`. */
  readonly poolMax?: number;
}

/** D1 declares `interactiveTx: false`; Postgres declares what its client can do. */
export function postgresCapabilities(hasBegin: boolean, hasReserve = false): DbCapabilities {
  return Object.freeze({
    interactiveTx: hasBegin,
    // `batch()` needs a transaction to be atomic, so it rides on the same fact.
    batch: hasBegin,
    placeholder: 'dollar',
    engine: 'postgres',
    // `reserve()` is what makes a session-scoped advisory lock mean anything
    // (`MIG-003`): the lock and the work must be the same connection.
    pinnedConnection: hasReserve,
  });
}

function toResult(result: PgResultLike): DbResult {
  const rows = [...result];
  // `postgres.js` reports the affected-row count as `count` on the result array.
  // Falling back to `rows.length` alone would turn a 5-row UPDATE into
  // `changes: 0`, because an UPDATE without RETURNING returns no rows at all.
  const command = result.command?.toUpperCase();
  const changes = result.count ?? (command === 'SELECT' ? rows.length : 0);
  return { rows, changes };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function txError(code: string, message: string, hint: string): TsirError {
  return new TsirError(code, message, { kind: 'database', hint });
}

interface DriverContext {
  readonly capabilities: DbCapabilities;
  readonly now: () => number;
  readonly poolMax?: number;
}

/**
 * Builds a driver over one client.
 *
 * The same function builds the transaction scope: a scope is a driver over the
 * `tx` object `postgres.js` handed to `begin()`, with `ownsConnection: false` so
 * closing it cannot end the pool its parent is still using.
 */
type CloseMode = 'pool' | 'scope' | 'reserved';

function makeDriver(source: PgClientLike, context: DriverContext, closeMode: CloseMode): DbDriver {
  const { capabilities, now } = context;

  function pending(value: DbStatement): PgQueryLike {
    return source.unsafe(value.sql, value.params);
  }

  async function query(value: DbStatement): Promise<DbResult> {
    const result = pending(value);
    if (value.format === 'arrays') {
      if (result.raw === undefined) {
        throw txError(
          'DB_RAW_UNSUPPORTED',
          'the Postgres client cannot return positional rows',
          'implement `raw()` on the client — postgres.js does — because the driver will not guess column order',
        );
      }
      return { rows: await result.raw(), changes: 0 };
    }
    return toResult(await Promise.resolve(result));
  }

  async function batch(statements: readonly DbStatement[]): Promise<readonly DbResult[]> {
    // Bound at extraction: `begin` is a method, a client is allowed to use
    // `this`, and the lint rule that flags unbound methods is right to.
    const open = source.begin?.bind(source);
    if (open === undefined) {
      throw txError(
        'DB_BATCH_UNSUPPORTED',
        'the Postgres client cannot open a transaction, so batch() cannot be atomic',
        'pass a client built by postgres.js (`postgres(url)`); a client without begin() is read-only in effect',
      );
    }
    return open(async (scope) => {
      const results: DbResult[] = [];
      for (const value of statements) {
        results.push(toResult(await Promise.resolve(scope.unsafe(value.sql, value.params))));
      }
      return results;
    });
  }

  async function begin<T>(work: (scope: DbDriver) => Promise<T>): Promise<T> {
    const open = source.begin?.bind(source);
    if (open === undefined) {
      throw txError(
        'DB_TX_INTERACTIVE_UNSUPPORTED',
        'the Postgres client cannot begin a transaction',
        'pass a client built by postgres.js (`postgres(url)`) so BEGIN/COMMIT are real',
      );
    }
    return open(async (scope) => work(makeDriver(scope, context, 'scope')));
  }

  const driver: DbDriver = {
    capabilities,
    query,
    batch,

    async health(): Promise<DbHealth> {
      const started = now();
      try {
        const result = await Promise.resolve(source.unsafe('select 1 as ok'));
        return {
          ok: result.length > 0,
          engine: 'postgres',
          latencyMs: now() - started,
          // A pool is a resource with a size, unlike D1's nothing-to-report.
          detail: context.poolMax === undefined ? {} : { poolMax: context.poolMax },
        };
      } catch (error: unknown) {
        return {
          ok: false,
          engine: 'postgres',
          latencyMs: now() - started,
          detail: {},
          error: describe(error),
        };
      }
    },

    async close(closeOptions): Promise<void> {
      // The client owns the sockets; the driver asks it to end them. A transaction
      // scope has no `end` of its own and must never close its parent's pool; a
      // reserved connection goes back to the pool instead of ending it.
      if (closeMode === 'scope') return;
      if (closeMode === 'reserved') {
        await source.release?.();
        return;
      }
      await source.end?.(
        closeOptions?.timeoutMs === undefined ? {} : { timeout: closeOptions.timeoutMs },
      );
    },
  };

  /**
   * Pins one connection (`DB-018`).
   *
   * Attached only when the client can reserve, so `capabilities.pinnedConnection`
   * stays true exactly while `reserve()` exists — the same honesty rule `begin()`
   * and `interactiveTx` follow.
   */
  async function reserveConnection(): Promise<DbDriver> {
    const pin = source.reserve?.bind(source);
    if (pin === undefined) {
      throw txError(
        'DB_CONNECTION_PIN_UNSUPPORTED',
        'the Postgres client cannot reserve a connection',
        "pass a client built by postgres.js or Bun's SQL — both expose reserve(); a client without it cannot hold a session-scoped lock",
      );
    }
    return makeDriver(await pin(), context, 'reserved');
  }

  // `begin` exists exactly when the client can begin — which is what the
  // capability flag claims. Attaching it unconditionally would make the boot
  // invariant vacuous and hide a client that cannot do transactions at all.
  return {
    ...driver,
    ...(capabilities.interactiveTx ? { begin } : {}),
    ...(context.capabilities.pinnedConnection ? { reserve: reserveConnection } : {}),
  };
}

export function createPostgresDriver(options: PostgresDriverOptions): DbDriver {
  const { client } = options;
  return makeDriver(
    client,
    {
      capabilities: postgresCapabilities(client.begin !== undefined, client.reserve !== undefined),
      now: options.now ?? (() => Date.now()),
      ...(options.poolMax === undefined ? {} : { poolMax: options.poolMax }),
    },
    'pool',
  );
}

/**
 * The Hyperdrive connection source (`DB-014`).
 *
 * A Worker cannot hold a `postgres://` string: the credential is injected by the
 * platform at deploy time and reaches the Worker as a binding. Reading it from
 * the binding is therefore the *only* supported path, and this function exists so
 * that path is one line and validates what it got.
 */
export interface HyperdriveLike {
  readonly connectionString: string;
}

export function hyperdriveConnection(
  binding: HyperdriveLike | undefined,
  name = 'HYPERDRIVE',
): string {
  if (binding === undefined) {
    throw txError(
      'DB_DRIVER_UNAVAILABLE',
      `Hyperdrive binding "${name}" is not available in this Worker`,
      'bind it in wrangler.toml (`hyperdrive = [{ binding = "HYPERDRIVE", id = "…" }]`) and run `tsir dev` against the Workers target',
    );
  }
  if (!/^postgres(ql)?:\/\//.test(binding.connectionString)) {
    throw txError(
      'DB_DRIVER_UNAVAILABLE',
      `Hyperdrive binding "${name}" did not provide a Postgres connection string`,
      'the binding is platform-managed; do not overwrite it with a literal URL',
    );
  }
  return binding.connectionString;
}
