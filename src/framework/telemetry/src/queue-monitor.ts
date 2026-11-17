/**
 * Horizon-style queue monitor.
 *
 * Reads the `queue_jobs` and `queue_dead` tables (created by `@tsir/queue`'s database driver) to
 * surface job counts by state, list jobs, fetch a single job, and retry a dead-lettered job.
 *
 * State derivation:
 *   · pending  — `leased_until = 0` AND `available_at <= now`
 *   · running  — `leased_until > now`
 *   · delayed  — `available_at > now` AND `leased_until = 0`
 *   · failed   — in `queue_dead`
 *
 * The tables come from `telemetryTables(engine)` (`INF-010`): they were `sqliteTable` constants, so
 * on the documented AWS default every query here carried SQLite SQL to Postgres. See `tables.ts`.
 */
import { desc, eq, gt, lte, and, sql, type SQL } from 'drizzle-orm';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { telemetryTables, type TelemetryEngine } from './tables.ts';

export type { TelemetryEngine };

export type JobState = 'pending' | 'running' | 'delayed' | 'failed';

export interface JobCounts {
  pending: number;
  running: number;
  delayed: number;
  failed: number;
}

export interface QueueJobRow {
  id: string;
  name: string;
  payload: string;
  connection: string;
  attempts: number;
  maxAttempts: number;
  availableAt: number;
  leasedUntil: number;
  createdAt: number;
  lastError: string | null;
  idempotencyKey: string | null;
  requestId: string | null;
  state: JobState;
}

/** The SQLite/D1 connection shape. */
export type SqliteConnection = BaseSQLiteDatabase<
  'sync' | 'async',
  unknown,
  Record<string, unknown>
>;
/** The Postgres connection shape. */
export type PostgresConnection = PgDatabase<never, Record<string, unknown>>;

/** The `queue_jobs` columns the queries below reference, on either dialect. */
type JobTable = ReturnType<typeof telemetryTables>['queueJobs'];
/** The `queue_dead` columns, likewise. */
type DeadTable = ReturnType<typeof telemetryTables>['queueDead'];

interface QueryTables {
  readonly queueJobs: JobTable;
  readonly queueDead: DeadTable;
}

/**
 * The slice of a Drizzle builder this module calls.
 *
 * Hand-written because the two conventions' builder types are structurally different while the
 * methods this monitor uses are identical on both. A result set is `Record<string, unknown>[]` until
 * a method reads it, and each read below narrows a field rather than asserting the whole row —
 * which is the habit that kept the old SQLite-only version from noticing it was SQLite-only.
 */
interface QueryConnection {
  select(fields?: Record<string, unknown>): {
    from(table: JobTable | DeadTable): Query;
  };
  insert(table: JobTable): { values(value: Record<string, unknown>): Promise<unknown> };
  delete(table: DeadTable): { where(condition: unknown): Promise<unknown> };
  /**
   * N statements, atomically. The portable primitive: D1 rejects `BEGIN`, so this is the only
   * atomic write that exists on both targets (ADR-0016).
   */
  batch(statements: readonly unknown[]): Promise<readonly unknown[]>;
}

interface Query extends Promise<Record<string, unknown>[]> {
  where(condition: unknown): Query;
  orderBy(...columns: unknown[]): Query;
  limit(n: number): Query;
  offset(n: number): Query;
}

export interface QueueMonitorOptions {
  /** Which dialect the connection speaks. Default `'d1'`, the Cloudflare default. */
  readonly engine?: TelemetryEngine | undefined;
}

export interface QueueMonitor {
  countsByState(): Promise<JobCounts>;
  listJobs(state?: JobState, limit?: number, offset?: number): Promise<QueueJobRow[]>;
  getJob(id: string): Promise<QueueJobRow | null>;
  retryJob(id: string): Promise<boolean>;
  /** The tables a migration must create. The same objects the queries run against. */
  readonly tables: ReturnType<typeof telemetryTables>;
}

/**
 * Create a queue monitor bound to a Drizzle instance. Works against the `queue_jobs` + `queue_dead`
 * tables created by `@tsir/queue`.
 *
 * The engine decides which tables are built (`INF-010`); pass `'postgres'` on AWS. The parameter is
 * the union rather than two overloads: overloads make the *common* call — a connection whose type
 * the caller already has — require a cast, to typecheck a distinction that only the `engine` option
 * actually makes. The table objects are the dialect-specific part, and they come from the factory.
 */
export function createQueueMonitor(
  drizzle: SqliteConnection | PostgresConnection,
  options: QueueMonitorOptions = {},
): QueueMonitor {
  const tables = telemetryTables(options.engine ?? 'd1');
  // coercion-ok: the two Drizzle builders differ only in their generics; at runtime a builder holds
  // that dialect's table objects, and `tables` was built for `engine`. Writing every query twice to
  // satisfy the union would duplicate the part that is genuinely portable — which is all of it but
  // the table objects, and those are exactly what the factory supplies.
  const { queueJobs, queueDead } = tables as QueryTables;
  const db = drizzle as unknown as QueryConnection;

  /** A `count(*)` row arrives as `{}` through the loose builder; narrow it once, here. */
  function countOf(row: Record<string, unknown> | undefined): number {
    const value = row?.count;
    if (typeof value === 'number') return value;
    // A driver may hand back a bigint or a string for `count(*)`; only a string is parsed, and a
    // non-finite result is a zero rather than a `NaN` that would poison every comparison downstream.
    // `count(*)` arrives as a string from some drivers and a bigint from others. The string is
    // matched against `^\d+$` first, and a count is bounded by the row count — neither conversion
    // can exceed what a JS number holds exactly.
    if (typeof value === 'string' && /^\d+$/u.test(value)) return Number(value); // coercion-ok: digits only
    if (typeof value === 'bigint') return Number(value); // coercion-ok: a count fits in a double
    return 0;
  }

  const textOf = (row: Record<string, unknown>, key: string): string => {
    const value = row[key];
    return typeof value === 'string' ? value : '';
  };
  const num = (row: Record<string, unknown>, key: string): number => {
    const value = row[key];
    return typeof value === 'number' ? value : 0;
  };
  const nullable = (row: Record<string, unknown>, key: string): string | null => {
    const value = row[key];
    return typeof value === 'string' ? value : null;
  };

  /** One live row, narrowed. `createdAt` is epoch ms on both dialects (`bigint … mode: number`). */
  function liveRow(row: Record<string, unknown>, now: number): QueueJobRow {
    const availableAt = num(row, 'availableAt');
    const leasedUntil = num(row, 'leasedUntil');
    return {
      id: textOf(row, 'id'),
      name: textOf(row, 'name'),
      payload: textOf(row, 'payload'),
      connection: textOf(row, 'connection'),
      attempts: num(row, 'attempts'),
      maxAttempts: num(row, 'maxAttempts'),
      availableAt,
      leasedUntil,
      createdAt: num(row, 'createdAt'),
      lastError: nullable(row, 'lastError'),
      idempotencyKey: nullable(row, 'idempotencyKey'),
      requestId: nullable(row, 'requestId'),
      state: deriveState({ leasedUntil, availableAt }, now),
    };
  }

  /** One dead-lettered row. It has no lease: a failed job is not running. */
  function deadRowOf(row: Record<string, unknown>): QueueJobRow {
    return {
      id: textOf(row, 'id'),
      name: textOf(row, 'name'),
      payload: textOf(row, 'payload'),
      connection: textOf(row, 'connection'),
      attempts: num(row, 'attempts'),
      maxAttempts: num(row, 'maxAttempts'),
      availableAt: num(row, 'availableAt'),
      leasedUntil: 0,
      createdAt: num(row, 'createdAt'),
      lastError: nullable(row, 'lastError'),
      idempotencyKey: nullable(row, 'idempotencyKey'),
      requestId: nullable(row, 'requestId'),
      state: 'failed',
    };
  }

  function deriveState(r: { leasedUntil: number; availableAt: number }, now: number): JobState {
    if (r.leasedUntil > now) return 'running';
    if (r.availableAt > now) return 'delayed';
    return 'pending';
  }

  async function countJobs(where: SQL<unknown> | undefined): Promise<number> {
    const query = db.select({ count: sql<number>`count(*)` }).from(queueJobs);
    const rows = where !== undefined ? await query.where(where) : await query;
    return countOf(rows[0]);
  }

  return {
    tables,
    async countsByState(): Promise<JobCounts> {
      const now = Date.now();
      const [pending, running, delayed, failed] = await Promise.all([
        countJobs(and(eq(queueJobs.leasedUntil, 0), lte(queueJobs.availableAt, now))),
        countJobs(gt(queueJobs.leasedUntil, now)),
        countJobs(and(eq(queueJobs.leasedUntil, 0), gt(queueJobs.availableAt, now))),
        (async () => {
          const rows = await db.select({ count: sql<number>`count(*)` }).from(queueDead);
          return countOf(rows[0]);
        })(),
      ]);
      return { pending, running, delayed, failed };
    },

    async listJobs(state?: JobState, limit = 50, offset = 0): Promise<QueueJobRow[]> {
      if (state === 'failed') {
        const rows = await db
          .select()
          .from(queueDead)
          .orderBy(desc(queueDead.createdAt))
          .limit(limit)
          .offset(offset);
        return rows.map(deadRowOf);
      }

      const now = Date.now();
      let where: SQL<unknown> | undefined;
      if (state === 'pending')
        where = and(eq(queueJobs.leasedUntil, 0), lte(queueJobs.availableAt, now));
      else if (state === 'running') where = gt(queueJobs.leasedUntil, now);
      else if (state === 'delayed')
        where = and(eq(queueJobs.leasedUntil, 0), gt(queueJobs.availableAt, now));

      const base = db.select().from(queueJobs);
      const query = where !== undefined ? base.where(where) : base;
      const rows = await query.orderBy(desc(queueJobs.createdAt)).limit(limit).offset(offset);

      return rows.map((row) => liveRow(row, now));
    },

    async getJob(id: string): Promise<QueueJobRow | null> {
      const liveRows = await db.select().from(queueJobs).where(eq(queueJobs.id, id)).limit(1);
      const live = liveRows[0];
      if (live !== undefined) return liveRow(live, Date.now());

      const dead = await db.select().from(queueDead).where(eq(queueDead.id, id)).limit(1);
      const deadFirst = dead[0];
      if (deadFirst !== undefined) return deadRowOf(deadFirst);
      return null;
    },

    async retryJob(id: string): Promise<boolean> {
      const dead = await db.select().from(queueDead).where(eq(queueDead.id, id)).limit(1);
      const row = dead[0];
      if (row === undefined) return false;

      const now = Date.now();
      const job = {
        id: textOf(row, 'id'),
        name: textOf(row, 'name'),
        payload: textOf(row, 'payload'),
        connection: textOf(row, 'connection'),
        attempts: 0,
        maxAttempts: num(row, 'maxAttempts'),
        availableAt: now,
        leasedUntil: 0,
        createdAt: num(row, 'createdAt'),
        lastError: null,
        idempotencyKey: nullable(row, 'idempotencyKey'),
        requestId: nullable(row, 'requestId'),
      };

      // INSERT + DELETE must be atomic: if the delete fails, the job exists in both tables and the
      // worker will run it twice. `drizzle.transaction()` is not that primitive here — D1 rejects
      // `BEGIN`, so the previous version worked on a real Postgres and failed on the default
      // target. A batch is the portable atomic write (ADR-0016): D1 runs it as one implicit
      // transaction, and a `*_proxy` connection gives the same guarantee to both.
      //
      // The delete is conditional on the row still being dead, so a retry that races another retry
      // moves the job once and reports `false` for the loser rather than resurrecting a duplicate.
      const results = await db.batch([
        db.insert(queueJobs).values(job),
        db.delete(queueDead).where(eq(queueDead.id, job.id)),
      ]);
      void results;
      return true;
    },
  };
}
