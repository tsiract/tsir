/**
 * The driver contract (`DB-001`).
 *
 * A driver is a *transport*, not an ORM and not a query builder: it takes SQL
 * and bound parameters and returns rows. Drizzle sits above this, translating
 * `sqliteTable`/`pgTable` queries into exactly these calls.
 *
 * Two decisions are baked into the shape:
 *
 * 1. **Capabilities are declared, not discovered.** `interactiveTx` is `false`
 *    on D1 — `BEGIN`/`COMMIT`/`SAVEPOINT` are rejected outright, and Drizzle's
 *    `transaction()` throws. Code that needs a real transaction asks at boot and
 *    fails there, rather than discovering it under load (`DB-006`, `DB-007`).
 * 2. **`batch` is the atomicity primitive.** On D1, `batch([...])` is a single
 *    implicit transaction; on Postgres it is one transaction wrapping the same
 *    statements. Writing against `batch` means the same application code is
 *    correct on both engines, which writing against `BEGIN` would not be.
 */

/** What a driver can and cannot do. Read once at boot, never re-probed. */
export interface DbCapabilities {
  /** `false` on D1: no `BEGIN`, no savepoints, no interactive transactions. */
  readonly interactiveTx: boolean;
  /** Multi-statement `batch()` executed as one atomic unit. */
  readonly batch: boolean;
  /** `?` placeholders (SQLite) vs `$1` (Postgres) — Drizzle generates per dialect. */
  readonly placeholder: 'question' | 'dollar';
  /**
   * The engine name shown in logs and health output.
   *
   * `sqlite` is a file and `d1` is Cloudflare's SQLite-as-a-binding: the same dialect, a different
   * lifetime, and a health line that must not claim a binding the connection does not have
   * (`DB-027`, `CAP-009`). A union that called both `d1` would make the one place an operator
   * looks unable to tell them apart.
   */
  readonly engine: 'd1' | 'postgres' | 'mysql' | 'sqlite';
  /**
   * `reserve()` exists, so one connection can be pinned for the duration of a
   * unit of work.
   *
   * Session state — an advisory lock above all (`MIG-003`) — is meaningless on a
   * pool: take the lock on connection A, run the work on B, and nothing is
   * excluded. Declaring the capability is how `migrate` knows whether its lock is
   * real instead of assumed.
   */
  readonly pinnedConnection: boolean;
}

/**
 * Row format the caller wants back.
 *
 * `objects` is the default and what application code reads. `arrays` is
 * positional, in select order — required by query builders that map columns by
 * index (Drizzle's SQLite proxy), and the reason D1 exposes `.raw()` at all.
 * Guessing the mapping by asking for objects and re-ordering them is how a
 * query builder silently returns the wrong column when two have the same name.
 */
export type RowFormat = 'objects' | 'arrays';

/** A bound statement: SQL, parameters, and how rows should come back. */
export interface DbStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly format?: RowFormat;
}

/**
 * One statement's result.
 *
 * `rows` is `unknown[]` on purpose: the driver cannot know a schema. Typing
 * happens one layer up, where Drizzle knows the table (`InferSelectModel`).
 * Casting here would move the unsafe step to the wrong place.
 */
export interface DbResult {
  readonly rows: readonly unknown[];
  readonly changes: number;
  /** SQLite `last_insert_rowid()` / Postgres `RETURNING` — driver-defined. */
  readonly lastInsertRowid?: number | bigint;
}

export interface DbHealth {
  readonly ok: boolean;
  readonly engine: DbCapabilities['engine'];
  readonly latencyMs: number;
  /** Driver-specific counters: pool size, open connections. Empty on D1. */
  readonly detail: Readonly<Record<string, number>>;
  readonly error?: string;
}

/**
 * What every driver must implement. Deliberately small — a driver that grows
 * features becomes a second ORM.
 */
export interface DbDriver {
  readonly capabilities: DbCapabilities;
  /** One statement. */
  query(statement: DbStatement): Promise<DbResult>;
  /** N statements, atomically, in order. */
  batch(statements: readonly DbStatement[]): Promise<readonly DbResult[]>;
  /**
   * Runs `work` inside a real transaction (`DB-013`), handing it a driver scoped
   * to that transaction.
   *
   * Present exactly when `capabilities.interactiveTx` is true — `createDatabase`
   * refuses a driver where the two disagree, in either direction. A driver that
   * declares the capability without implementing this turns a boot-time fact into
   * a request-time 500 (ADR-0015).
   */
  begin?<T>(work: (scope: DbDriver) => Promise<T>): Promise<T>;
  /**
   * Pins one connection and returns a driver bound to it (`DB-018`).
   *
   * Present exactly when `capabilities.pinnedConnection` is true. Closing the
   * returned driver returns the connection to its pool instead of ending it.
   */
  reserve?(): Promise<DbDriver>;
  /** `SELECT 1` plus whatever counters the engine exposes. Never throws. */
  health(): Promise<DbHealth>;
  /** Releases every handle. Safe to call twice. */
  close(options?: { readonly timeoutMs?: number }): Promise<void>;
}

/** Statements are immutable values; freezing catches accidental reuse-and-mutate. */
export function statement(
  sql: string,
  params: readonly unknown[] = [],
  format: RowFormat = 'objects',
): DbStatement {
  return Object.freeze({ sql, params: Object.freeze([...params]), format });
}
