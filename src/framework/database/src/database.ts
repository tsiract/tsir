/**
 * The `Database` contract (`DB-004`, `DB-006`).
 *
 * One object an application injects; it owns a driver, tracks in-flight work for
 * a bounded shutdown, and refuses operations the engine cannot honour *before*
 * they reach it.
 *
 * The transaction story is the whole design (ADR-0016):
 *
 * - `batch([...])` is the portable atomic write and always available.
 * - `interactiveTx(fn)` exists, but on D1 it throws
 *   `DB_TX_INTERACTIVE_UNSUPPORTED` at call time — and `declare()` refuses the
 *   component at boot, which is the error a developer can actually act on.
 *
 * Refusing early is deliberate. A driver that silently degraded `transaction()`
 * into a sequence of statements would pass every test written against a fake and
 * corrupt data in production.
 */

import { type Clock, systemClock } from '@tsir/core';

import {
  statement,
  type DbCapabilities,
  type DbDriver,
  type DbHealth,
  type DbResult,
  type DbStatement,
} from './driver.ts';
import {
  capabilityLie,
  databaseClosed,
  emptyBatch,
  interactiveTxUnsupported,
  pinnedConnectionLie,
  pinnedConnectionUnsupported,
  requirementsMissing,
  requiresInteractiveTx,
  transactionDepthExceeded,
  unknownConnection,
  unsupportedTransactionOption,
} from './errors.ts';
import { paramType, type QueryLogLevel, type QueryLogger, scrubSql, shouldLog } from './logging.ts';

export interface DatabaseOptions<Names extends string = string> {
  readonly driver: DbDriver;
  /**
   * Connection name, used by `db.connection(name)` and (DB-021) by every log line
   * and span. A database created outside a registry defaults to `'default'`: a
   * name that is true rather than a placeholder.
   */
  readonly name?: string | undefined;
  /**
   * Resolves a sibling connection by name (ADR-0019).
   *
   * Supplied by `createConnections()`; a standalone `Database` has none, and then
   * `connection()` can only resolve its own name — an unknown name is an error
   * listing exactly that one, which is the honest answer for a single-connection
   * application.
   */
  readonly lookup?: ((name: string) => Database<Names>) | undefined;
  /** Queries allowed in flight during `close()` before it stops waiting. */
  readonly drainTimeoutMs?: number | undefined;
  /** `off` never logs; `slow` logs only statements over the threshold. */
  readonly logging?: QueryLogLevel | undefined;
  readonly slowQueryMs?: number | undefined;
  /** Receives redacted events — parameter *types*, never values (DB-009). */
  readonly log?: QueryLogger | undefined;
  /**
   * Nesting depth of transaction scopes. Internal: `interactiveTx()` sets it, so
   * a scope can enforce the savepoint cap (`DB_TX_DEPTH_EXCEEDED`).
   */
  readonly depth?: number | undefined;
  /**
   * Per-statement cap used to decide when an open transaction is suspicious
   * (`3 ×` this). The engine enforces its own timeout; this is a warning.
   */
  readonly statementTimeoutMs?: number | undefined;
  /** Injected in tests so a duration assertion is not a timing race. */
  readonly clock?: Clock | undefined;
}

/** Shutdown budget for one `close()` call. */
export interface CloseOptions {
  /** How long to wait for in-flight statements. `0` stops waiting immediately. */
  readonly drainTimeoutMs?: number | undefined;
}

export interface Database<Names extends string = string> {
  readonly capabilities: DbCapabilities;
  /** This connection's name (ADR-0019). `db.connection(db.name)` returns `db`. */
  readonly name: string;
  /**
   * The named connection (`DB-019`, ADR-0019) — Laravel's `DB::connection('x')`,
   * without a service locator.
   *
   * `Names` is the literal union the generator emits, so a typo is a compile error
   * in application code. The runtime check is for the other case: a `tsir.js`
   * edited without a rebuild, where the type still says the old name.
   *
   * The returned object is the *same contract*: same `batch`, same capabilities of
   * that driver, and no cross-connection transaction — a transaction belongs to one
   * physical database, so `connection()` inside `interactiveTx` on another
   * connection starts a second, unrelated transaction (ADR-0019 § 6).
   */
  connection(name: Names): Database<Names>;
  /** One statement, returning rows. */
  query(statement: DbStatement): Promise<DbResult>;
  /** N statements, atomically. Throws `DB_BATCH_EMPTY` on an empty list. */
  batch(statements: readonly DbStatement[]): Promise<readonly DbResult[]>;
  /**
   * A real transaction. Only available when `capabilities.interactiveTx` is true;
   * otherwise it throws instead of approximating one.
   *
   * `options` decides whether the work may be replayed: retries happen only for
   * serialization failures and deadlocks, and only when `idempotent` is set.
   */
  interactiveTx<T>(
    fn: (tx: Database<Names>) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
  /**
   * Pins one connection for the duration of `work` (`DB-018`).
   *
   * Renamed from `connection()` by ADR-0019 § 9: the name now belongs to the
   * registry, and a pin is a different promise — *same session*, not *same name*.
   *
   * Needed whenever the work depends on **session state**: an advisory lock
   * (`pg_try_advisory_lock`), `SET LOCAL`, a temp table, a prepared statement.
   * On a pool those are meaningless, because the next statement may run on a
   * different connection — `migrate` uses this so its lock and its DDL are the
   * same session.
   *
   * Throws `DB_CONNECTION_PIN_UNSUPPORTED` when the driver cannot reserve, which
   * is why the capability is declared rather than discovered at the worst moment.
   */
  pinned<T>(fn: (db: Database<Names>) => Promise<T>): Promise<T>;
  /** `SELECT 1` plus engine counters. Never throws — a down database is data, not an exception. */
  health(): Promise<DbHealth>;
  /**
   * Waits for in-flight work (bounded), then closes the driver. Idempotent.
   *
   * `drainTimeoutMs` overrides the per-database default for *this* close. The
   * registry uses it to spend one shutdown budget across every connection instead
   * of multiplying it by the number of connections (`DB-021`): the first call
   * wins, because a second shutdown is not a second shutdown.
   */
  close(options?: CloseOptions): Promise<void>;
  readonly closed: boolean;
}

/**
 * Savepoint nesting cap (`DB-013`).
 *
 * Not a memory limit: a transaction nested 16 deep means the unit of work has no
 * owner, and the failure that follows is a lock held for the whole request.
 */
const MAX_TX_DEPTH = 16;

const DEFAULT_DRAIN_MS = 5_000;

/**
 * Declares that a component needs capabilities the driver may not have (`DB-007`).
 *
 * Called at boot from the composition root. On D1 this fails for
 * `interactiveTx: true` with the exact fix in the message, instead of surfacing
 * as a 500 on the one request that happened to need the transaction.
 */
export function declare(
  database: Database,
  component: string,
  requires: { readonly interactiveTx?: boolean },
): void {
  if (requires.interactiveTx === true && !database.capabilities.interactiveTx) {
    throw requiresInteractiveTx(component, database.capabilities.engine);
  }
}

/**
 * Refuses a driver whose capability flag and implementation disagree.
 *
 * Both directions matter. `interactiveTx: true` without `begin()` fails on the
 * first request that needs a transaction; `begin()` with `interactiveTx: false`
 * means application code that correctly asks at boot is told the driver cannot
 * do something it can, and is steered into a workaround it does not need.
 */
function assertCapabilitiesAreHonest(driver: DbDriver): void {
  const declared = driver.capabilities.interactiveTx;
  const implemented = driver.begin !== undefined;
  if (declared !== implemented) {
    throw capabilityLie(driver.capabilities.engine, declared, implemented);
  }

  const pinnable = driver.capabilities.pinnedConnection;
  const reserves = driver.reserve !== undefined;
  if (pinnable !== reserves) {
    throw pinnedConnectionLie(driver.capabilities.engine, pinnable, reserves);
  }
}

/**
 * A component's declared database needs.
 *
 * Deliberately a plain record rather than a second module system: a module's
 * `requires` in `@tsir/core` is about runtime capabilities (filesystem, sockets);
 * this is about the *engine*, and the two are checked in different places.
 */
export interface DatabaseRequirement {
  readonly component: string;
  readonly interactiveTx?: boolean;
}

/**
 * The boot check (`DB-007`).
 *
 * Called from the composition root — normally the module that owns the database
 * provider, in its `onStart` — with every component that needs more than the D1
 * baseline. Failing here turns "this endpoint 500s on production only" into a
 * message at boot that names the component and the fix.
 *
 * Unlike `declare()`, this reports **all** unsatisfied components at once.
 */
export function assertRequirements(
  database: Database,
  requirements: readonly DatabaseRequirement[],
): void {
  if (database.capabilities.interactiveTx) return;

  const unsatisfied = requirements
    .filter((requirement) => requirement.interactiveTx === true)
    .map((requirement) => requirement.component);
  if (unsatisfied.length === 0) return;

  throw requirementsMissing(unsatisfied, database.capabilities.engine);
}

/**
 * Options for one transaction (`DB-013`).
 *
 * No option is on by default except the first attempt: retrying is a decision
 * about the *callback*, and the person who wrote the callback is the only one who
 * knows whether replaying it is safe.
 */
export interface TransactionOptions {
  /** `SET TRANSACTION READ ONLY` — a write fails with SQLSTATE 25006. Postgres only. */
  readonly readOnly?: boolean;
  /** Declares that replaying the callback is safe. Required for any retry. */
  readonly idempotent?: boolean;
  /** Total attempts when `idempotent` is set. Default 3. */
  readonly attempts?: number;
  /** Base delay, doubled per attempt. Default 20 ms. */
  readonly backoffMs?: number;
  /** Injected for tests so backoff costs no wall-clock time. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** SQLSTATEs where the *same* work can succeed on a second attempt. */
const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(['40001', '40P01']);

/**
 * True when the failure is a serialization failure (`40001`) or a deadlock
 * (`40P01`) — and nothing else.
 *
 * Deliberately not "retry any error": a unique-violation retry is a duplicate
 * insert, and a connection-refused retry is a retry storm. The error is read
 * through `cause` because Drizzle and the drivers re-wrap.
 */
export function isSerializationFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (typeof current === 'object') {
      // Two shapes, both real: postgres.js puts SQLSTATE in `code`, Bun's SQL
      // puts it in `errno` and leaves `code` as `ERR_POSTGRES_SERVER_ERROR`.
      // Reading only one of them means retries silently stop working when the
      // client changes — a bug that only shows up under contention.
      const error = current as { code?: unknown; errno?: unknown; cause?: unknown };
      for (const candidate of [error.code, error.errno]) {
        if (typeof candidate === 'string' && RETRYABLE_SQLSTATES.has(candidate)) return true;
      }
      current = error.cause;
      continue;
    }
    break;
  }
  return false;
}

export function createDatabase<Names extends string = string>(
  options: DatabaseOptions<Names>,
): Database<Names> {
  const { driver } = options;
  assertCapabilitiesAreHonest(driver);
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_MS;
  const clock = options.clock ?? systemClock();
  const statementTimeoutMs = options.statementTimeoutMs ?? 5_000;
  const level: QueryLogLevel = options.logging ?? 'slow';
  const depth = options.depth ?? 0;
  const slowQueryMs = options.slowQueryMs ?? 200;
  const connectionName = options.name ?? 'default';

  let inFlight = 0;
  let closed = false;
  let closing: Promise<void> | undefined;
  let idle: (() => void)[] = [];

  function assertOpen(): void {
    if (closed) throw databaseClosed();
  }

  function settle(callback: () => void): void {
    if (inFlight === 0) {
      callback();
      return;
    }
    idle.push(callback);
  }

  /** Emits a redacted event when the level asks for one. */
  function report(statement: DbStatement, startedMs: number, rows: number, error?: unknown): void {
    const logger = options.log;
    if (logger === undefined) return;

    const durationMs = clock.monotonicMs() - startedMs;
    const ok = error === undefined;
    if (!shouldLog(level, durationMs, slowQueryMs, ok)) return;

    logger({
      event: 'db.query',
      connection: connectionName,
      level,
      sql: scrubSql(statement.sql),
      paramTypes: statement.params.map(paramType),
      paramCount: statement.params.length,
      durationMs,
      rows,
      ok,
      ...(ok ? {} : { error: error instanceof Error ? error.message : 'unknown error' }),
    });
  }

  /** Runs one statement with timing and logging around it. */
  async function runLogged(statement: DbStatement): Promise<DbResult> {
    const started = clock.monotonicMs();
    try {
      const result = await driver.query(statement);
      report(statement, started, result.rows.length);
      return result;
    } catch (error: unknown) {
      // Failed statements are logged at every level except `off`: a fast error is
      // still an error worth seeing.
      report(statement, started, 0, error);
      throw error;
    }
  }

  /** Every driver call goes through here, so `close()` can count them. */
  async function track<T>(work: () => Promise<T>): Promise<T> {
    assertOpen();
    inFlight += 1;
    try {
      return await work();
    } finally {
      inFlight -= 1;
      if (inFlight === 0) {
        const waiting = idle;
        idle = [];
        for (const callback of waiting) callback();
      }
    }
  }

  const database: Database<Names> = {
    capabilities: driver.capabilities,

    name: connectionName,

    connection(name) {
      const target = String(name);
      // The default connection resolves to itself rather than to a copy: two
      // objects over one driver would double-count in-flight work at `close()`.
      if (target === connectionName) return database;

      const lookup = options.lookup;
      if (lookup === undefined) throw unknownConnection(target, [connectionName]);
      return lookup(target);
    },

    get closed(): boolean {
      return closed;
    },

    query(statementValue) {
      return track(() => runLogged(statementValue));
    },

    async batch(statements) {
      // An empty batch is a caller bug: usually a conditional that produced no
      // statements. Failing loudly beats "succeeded, changed nothing".
      if (statements.length === 0) throw emptyBatch();

      // Each statement is timed and logged individually, but they are executed
      // as one atomic unit: a log line must not imply an independence the
      // transaction does not have.
      const started = clock.monotonicMs();
      try {
        const results = await track(() => driver.batch(statements));
        const durationMs = clock.monotonicMs() - started;
        for (const [index, statementValue] of statements.entries()) {
          const rows = results[index]?.rows.length ?? 0;
          if (options.log !== undefined && shouldLog(level, durationMs, slowQueryMs, true)) {
            options.log({
              event: 'db.query',
              connection: connectionName,
              level,
              sql: scrubSql(statementValue.sql),
              paramTypes: statementValue.params.map(paramType),
              paramCount: statementValue.params.length,
              durationMs,
              rows,
              ok: true,
            });
          }
        }
        return results;
      } catch (error: unknown) {
        for (const statementValue of statements) {
          report(statementValue, started, 0, error);
        }
        throw error;
      }
    },

    async interactiveTx<T>(
      fn: (tx: Database<Names>) => Promise<T>,
      txOptions: TransactionOptions = {},
    ): Promise<T> {
      // Postgres implements this through `driver.begin` (DB-013). D1 cannot: the
      // engine rejects BEGIN, so the capability is false and the call refuses
      // with the reason and the fix — a fake transaction is worse than none.
      // Bound, not merely referenced: a driver method is allowed to use `this`,
      // and the lifecycle must not depend on how it happened to be defined.
      const begin = driver.begin?.bind(driver);
      if (begin === undefined) throw interactiveTxUnsupported(driver.capabilities.engine);
      if (depth >= MAX_TX_DEPTH) throw transactionDepthExceeded(MAX_TX_DEPTH);

      if (txOptions.readOnly === true && driver.capabilities.engine !== 'postgres') {
        throw unsupportedTransactionOption('readOnly', driver.capabilities.engine);
      }
      if (txOptions.readOnly === true && depth > 0) {
        // `SET TRANSACTION` describes the whole transaction and Postgres rejects
        // it inside a savepoint — silently dropping it would be worse than the
        // error, because the caller would think the write was rejected.
        throw unsupportedTransactionOption(
          'readOnly (a nested transaction inherits its parent)',
          driver.capabilities.engine,
        );
      }

      // Retry is opt-in and narrow: only a *serialization* failure or a deadlock
      // can succeed on a second attempt, and only if the callback is idempotent —
      // replaying a transaction that sent an email is not a retry, it is a bug.
      const attempts = txOptions.idempotent === true ? (txOptions.attempts ?? 3) : 1;
      const backoffMs = txOptions.backoffMs ?? 20;
      const sleep =
        txOptions.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

      for (let attempt = 1; ; attempt += 1) {
        try {
          // The whole transaction is one unit of in-flight work: `close()` will
          // not return until it has committed or rolled back.
          return await track(() =>
            begin(async (scopedDriver) => {
              const scoped = createDatabase({
                ...options,
                driver: scopedDriver,
                depth: depth + 1,
              });
              // A transaction held open is a lock held open. The warning is the
              // only signal a user gets before the timeouts cascade.
              const warnAfterMs = statementTimeoutMs * 3;
              const leakWarning =
                options.log === undefined
                  ? undefined
                  : setTimeout(() => {
                      options.log?.({
                        event: 'db.transaction.open',
                        connection: connectionName,
                        level,
                        depth,
                        readOnly: txOptions.readOnly === true,
                        warnAfterMs,
                      });
                    }, warnAfterMs);

              try {
                if (txOptions.readOnly === true) {
                  // First statement inside the transaction, which is the only
                  // place Postgres accepts it.
                  await scoped.query(statement('set transaction read only'));
                }
                return await fn(scoped);
              } finally {
                if (leakWarning !== undefined) clearTimeout(leakWarning);
                // Closes the *scope*, not the connection: the driver's scoped
                // close is a no-op. This is what makes a query after the callback
                // settle fail with DB_CLOSED instead of running outside its tx.
                await scoped.close();
              }
            }),
          );
        } catch (error: unknown) {
          if (attempt >= attempts || !isSerializationFailure(error)) throw error;
          await sleep(backoffMs * 2 ** (attempt - 1));
        }
      }
    },

    async pinned<T>(fn: (db: Database<Names>) => Promise<T>): Promise<T> {
      // Bound, not merely referenced: `reserve` is a driver method and the
      // lifecycle must not depend on how it happens to be defined.
      const reserve = driver.reserve?.bind(driver);
      if (reserve === undefined || !driver.capabilities.pinnedConnection) {
        throw pinnedConnectionUnsupported(driver.capabilities.engine);
      }

      // The whole pinned scope is one unit of in-flight work: `close()` must not
      // hand the connection back while the caller is still using it.
      return track(async () => {
        const pinnedDriver = await reserve();
        const pinned = createDatabase({ ...options, driver: pinnedDriver });
        try {
          return await fn(pinned);
        } finally {
          // Returns the connection to the pool; it does not end the pool.
          await pinned.close();
        }
      });
    },

    health() {
      // Health must answer even after close: a readiness probe during shutdown
      // should see "not ok", not an exception.
      if (closed) {
        return Promise.resolve({
          ok: false,
          engine: driver.capabilities.engine,
          latencyMs: 0,
          detail: {},
          error: 'database is closed',
        });
      }
      return driver.health();
    },

    close(closeOptions) {
      if (closing !== undefined) return closing;

      const drainBudgetMs = Math.max(0, closeOptions?.drainTimeoutMs ?? drainTimeoutMs);

      closing = (async () => {
        closed = true;
        // Bounded drain: a stuck query must not turn shutdown into a hang. The
        // timeout is the promise race, not a timer the caller has to clear.
        if (inFlight > 0) {
          await Promise.race([
            new Promise<void>((resolve) => settle(resolve)),
            new Promise<void>((resolve) => {
              setTimeout(resolve, drainBudgetMs);
            }),
          ]);
        }
        await driver.close({ timeoutMs: drainBudgetMs });
      })();

      return closing;
    },
  };

  return database;
}
