/**
 * Horizon-style queue monitor.
 *
 * Reads the `queue_jobs` and `queue_dead` tables (created by `@tsir/queue`'s
 * database driver) to surface job counts by state, list jobs, fetch a single
 * job, and retry a dead-lettered job.
 *
 * State derivation:
 *   · pending  — `leased_until = 0` AND `available_at <= now`
 *   · running  — `leased_until > now`
 *   · delayed  — `available_at > now` AND `leased_until = 0`
 *   · failed   — in `queue_dead`
 */
import { desc, eq, gt, lte, and, sql, type SQL } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';

/** Drizzle schema for `queue_jobs` (matches `@tsir/queue` DDL). */
export const queueJobs = sqliteTable('queue_jobs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  payload: text('payload').notNull(),
  connection: text('connection').notNull(),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(5),
  availableAt: integer('available_at').notNull(),
  leasedUntil: integer('leased_until').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  lastError: text('last_error'),
  idempotencyKey: text('idempotency_key'),
  requestId: text('request_id'),
});

/** Drizzle schema for `queue_dead` (matches `@tsir/queue` DDL). */
export const queueDead = sqliteTable('queue_dead', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  payload: text('payload').notNull(),
  connection: text('connection').notNull(),
  attempts: integer('attempts').notNull(),
  maxAttempts: integer('max_attempts').notNull(),
  availableAt: integer('available_at').notNull(),
  createdAt: integer('created_at').notNull(),
  lastError: text('last_error'),
  idempotencyKey: text('idempotency_key'),
  requestId: text('request_id'),
});

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

/**
 * Create a queue monitor bound to a Drizzle instance. Works against the
 * `queue_jobs` + `queue_dead` tables created by `@tsir/queue`.
 */
export function createQueueMonitor(drizzle: SqliteRemoteDatabase<Record<string, unknown>>): {
  countsByState(): Promise<JobCounts>;
  listJobs(state?: JobState, limit?: number, offset?: number): Promise<QueueJobRow[]>;
  getJob(id: string): Promise<QueueJobRow | null>;
  retryJob(id: string): Promise<boolean>;
} {
  function deriveState(r: { leasedUntil: number; availableAt: number }, now: number): JobState {
    if (r.leasedUntil > now) return 'running';
    if (r.availableAt > now) return 'delayed';
    return 'pending';
  }

  async function countJobs(where: SQL<unknown> | undefined): Promise<number> {
    const query = drizzle.select({ count: sql<number>`count(*)` }).from(queueJobs);
    const rows = where !== undefined ? await query.where(where) : await query;
    return rows[0]?.count ?? 0;
  }

  return {
    async countsByState(): Promise<JobCounts> {
      const now = Date.now();
      const [pending, running, delayed, failed] = await Promise.all([
        countJobs(and(eq(queueJobs.leasedUntil, 0), lte(queueJobs.availableAt, now))),
        countJobs(gt(queueJobs.leasedUntil, now)),
        countJobs(and(eq(queueJobs.leasedUntil, 0), gt(queueJobs.availableAt, now))),
        (async () => {
          const rows = await drizzle.select({ count: sql<number>`count(*)` }).from(queueDead);
          return rows[0]?.count ?? 0;
        })(),
      ]);
      return { pending, running, delayed, failed };
    },

    async listJobs(state?: JobState, limit = 50, offset = 0): Promise<QueueJobRow[]> {
      if (state === 'failed') {
        const rows = await drizzle
          .select()
          .from(queueDead)
          .orderBy(desc(queueDead.createdAt))
          .limit(limit)
          .offset(offset);
        return rows.map((r) => ({
          id: r.id,
          name: r.name,
          payload: r.payload,
          connection: r.connection,
          attempts: r.attempts,
          maxAttempts: r.maxAttempts,
          availableAt: r.availableAt,
          leasedUntil: 0,
          createdAt: r.createdAt,
          lastError: r.lastError,
          idempotencyKey: r.idempotencyKey,
          requestId: r.requestId,
          state: 'failed' as const,
        }));
      }

      const now = Date.now();
      let where: SQL<unknown> | undefined;
      if (state === 'pending')
        where = and(eq(queueJobs.leasedUntil, 0), lte(queueJobs.availableAt, now));
      else if (state === 'running') where = gt(queueJobs.leasedUntil, now);
      else if (state === 'delayed')
        where = and(eq(queueJobs.leasedUntil, 0), gt(queueJobs.availableAt, now));

      const base = drizzle.select().from(queueJobs);
      const query = where !== undefined ? base.where(where) : base;
      const rows = await query.orderBy(desc(queueJobs.createdAt)).limit(limit).offset(offset);

      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        payload: r.payload,
        connection: r.connection,
        attempts: r.attempts,
        maxAttempts: r.maxAttempts,
        availableAt: r.availableAt,
        leasedUntil: r.leasedUntil,
        createdAt: r.createdAt,
        lastError: r.lastError,
        idempotencyKey: r.idempotencyKey,
        requestId: r.requestId,
        state: deriveState({ leasedUntil: r.leasedUntil, availableAt: r.availableAt }, now),
      }));
    },

    async getJob(id: string): Promise<QueueJobRow | null> {
      const live = await drizzle.select().from(queueJobs).where(eq(queueJobs.id, id)).limit(1);
      const liveRow = live[0];
      if (liveRow !== undefined) {
        return {
          id: liveRow.id,
          name: liveRow.name,
          payload: liveRow.payload,
          connection: liveRow.connection,
          attempts: liveRow.attempts,
          maxAttempts: liveRow.maxAttempts,
          availableAt: liveRow.availableAt,
          leasedUntil: liveRow.leasedUntil,
          createdAt: liveRow.createdAt,
          lastError: liveRow.lastError,
          idempotencyKey: liveRow.idempotencyKey,
          requestId: liveRow.requestId,
          state: deriveState(
            { leasedUntil: liveRow.leasedUntil, availableAt: liveRow.availableAt },
            Date.now(),
          ),
        };
      }

      const dead = await drizzle.select().from(queueDead).where(eq(queueDead.id, id)).limit(1);
      const deadRow = dead[0];
      if (deadRow !== undefined) {
        return {
          id: deadRow.id,
          name: deadRow.name,
          payload: deadRow.payload,
          connection: deadRow.connection,
          attempts: deadRow.attempts,
          maxAttempts: deadRow.maxAttempts,
          availableAt: deadRow.availableAt,
          leasedUntil: 0,
          createdAt: deadRow.createdAt,
          lastError: deadRow.lastError,
          idempotencyKey: deadRow.idempotencyKey,
          requestId: deadRow.requestId,
          state: 'failed' as const,
        };
      }
      return null;
    },

    async retryJob(id: string): Promise<boolean> {
      const dead = await drizzle.select().from(queueDead).where(eq(queueDead.id, id)).limit(1);
      const row = dead[0];
      if (row === undefined) return false;

      const now = Date.now();
      // INSERT + DELETE must be atomic: if the DELETE fails the job would exist
      // in both tables, so run them inside a transaction.
      await drizzle.transaction(async (tx) => {
        await tx.insert(queueJobs).values({
          id: row.id,
          name: row.name,
          payload: row.payload,
          connection: row.connection,
          attempts: 0,
          maxAttempts: row.maxAttempts,
          availableAt: now,
          leasedUntil: 0,
          createdAt: row.createdAt,
          lastError: null,
          ...(row.idempotencyKey !== null ? { idempotencyKey: row.idempotencyKey } : {}),
          ...(row.requestId !== null ? { requestId: row.requestId } : {}),
        });
        await tx.delete(queueDead).where(eq(queueDead.id, id));
      });
      return true;
    },
  };
}
