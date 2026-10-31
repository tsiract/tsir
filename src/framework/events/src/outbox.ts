/**
 * The transactional outbox (`§ 4.2`, `§ 4.5`).
 *
 * **Owned here, not by `@tsir/queue`.** The queue knows what a *message* is and how to deliver
 * one; it does not know what a delivery means, which is the whole content of "write this now,
 * send it after the commit". Keeping the writer next to the events it carries is what lets
 * `tsir build` say "a broker connection needs `@tsir/events`" and be telling the truth.
 *
 * D1 has no interactive transactions, so a job cannot be enqueued *inside* the write that
 * caused it. `batch()` is atomic, so the business row and the outbox row commit together — and
 * a relay then publishes what committed. That is the whole mechanism:
 *
 * ```
 *   batch([insert(orders), outbox.record(SendReceipt)])   ── atomic
 *                              │
 *                    relay() ──┴──▶ queue.dispatch ──▶ mark published
 * ```
 *
 * Why it is mandatory on non-transactional brokers and pointless on transactional ones: with a
 * direct dispatch the enqueue is a second, independent write. It can succeed after a rollback
 * (a receipt for an order that does not exist) or fail after a commit (an order with no
 * receipt). Neither is recoverable after the fact; the outbox is the only place both writes
 * share a transaction.
 *
 * `relay()` is deliberately **at-least-once too**: a crash between `dispatch` and
 * `markPublished` publishes the same message again, and the job's `JobContext.id` — which is
 * the outbox row's id — is what makes that harmless.
 */

import { JOB_DEFAULTS } from '@tsir/queue';
import type { JobMessage, Queue, QueueSql } from '@tsir/queue';

export interface OutboxOptions {
  readonly sql: QueueSql;
  /** Default `queue_outbox`. */
  readonly table?: string | undefined;
  readonly now?: (() => number) | undefined;
}

export interface OutboxEntry {
  readonly message: JobMessage;
  readonly publishedAt?: number | undefined;
}

export interface Outbox {
  /**
   * Record a message for the relay. **Pass the caller's batch**, not the outbox's own
   * connection, when the write must be atomic with the business row.
   */
  record(
    message: JobMessage,
    statement?: (sql: string, params: readonly unknown[]) => unknown,
  ): Promise<void>;
  pending(limit?: number): Promise<readonly OutboxEntry[]>;
  markPublished(ids: readonly string[], at?: number): Promise<number>;
  /** Publish everything unpublished. Returns how many messages were handed to the queue. */
  relay(queue: Pick<Queue, 'dispatch'>, limit?: number): Promise<number>;
  size(): Promise<number>;
}

export function createOutbox(options: OutboxOptions): Outbox {
  const table = options.table ?? 'queue_outbox';
  const now = options.now ?? ((): number => Date.now());
  const { sql } = options;
  const dollar = sql.capabilities.placeholder === 'dollar';
  const p = (index: number): string => (dollar ? `$${String(index)}` : '?');

  const run = async (
    statement: string,
    params: readonly unknown[] = [],
  ): Promise<readonly Record<string, unknown>[]> => {
    const result = await sql.query({ sql: statement, params });
    return result.rows as readonly Record<string, unknown>[];
  };

  return {
    async record(message, statement) {
      // The id is the job's id, so a republished message is recognisably the same message.
      const text =
        `INSERT INTO ${table} (id, name, payload, connection, created_at, max_attempts, idempotency_key) ` +
        `VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)})`;
      const params = [
        message.id,
        message.name,
        message.payload,
        message.connection,
        message.createdAt,
        message.maxAttempts,
        message.idempotencyKey ?? null,
      ] as const;

      // With a caller-supplied statement the insert joins *their* batch — that is the whole
      // point, and running it on the outbox's own connection would quietly lose atomicity.
      if (statement !== undefined) {
        statement(text, params);
        return;
      }
      await run(text, params);
    },

    async pending(limit = 100) {
      const rows = await run(
        `SELECT * FROM ${table} WHERE published_at IS NULL ORDER BY created_at ASC LIMIT ${p(1)}`,
        [limit],
      );
      return rows.map((row) => ({
        message: {
          id: String(row['id']),
          name: String(row['name']),
          payload: String(row['payload']),
          connection: String(row['connection']),
          attempts: 0,
          // coercion-ok: a SQL row is `unknown` by contract; these are integer columns.
          maxAttempts: Number(row['max_attempts'] ?? 0) || JOB_DEFAULTS.maxAttempts,
          // coercion-ok: same row, same reasoning — a stored epoch, not text.
          availableAt: Number(row['created_at']),
          createdAt: Number(row['created_at']),
          ...(typeof row['idempotency_key'] === 'string'
            ? { idempotencyKey: row['idempotency_key'] }
            : {}),
        },
      }));
    },

    async markPublished(ids, at) {
      if (ids.length === 0) return 0;
      const stamp = at ?? now();
      let changed = 0;
      for (const id of ids) {
        // `RETURNING id` is what makes the count real: an UPDATE that changed nothing and one
        // that changed a row are indistinguishable without it, and "published 7" is a lie a
        // log cannot afford.
        // The placeholder index and the parameter index must be the same number. They were
        // not: `p(2)`/`p(1)` with `[id, stamp]` is right only for `$n` engines, and on D1 — a
        // `?` engine, and the default database of the default stack — it marked
        // `published_at = '<uuid>'` on a row whose id was the timestamp. Nothing matched, nothing
        // was published, and the relay would re-send the same row forever.
        const rows = await run(
          `UPDATE ${table} SET published_at = ${p(1)} WHERE id = ${p(2)} AND published_at IS NULL RETURNING id`,
          [stamp, id],
        );
        changed += rows.length;
      }
      return changed;
    },

    async relay(queue, limit = 100) {
      const entries = await this.pending(limit);
      if (entries.length === 0) return 0;

      let published = 0;
      for (const entry of entries) {
        // Re-dispatch through the queue so the driver and retry policy are the ones a direct
        // dispatch would have used, and keep the outbox id as the idempotency key: a crash
        // between these two lines republishes the same message, and that is what makes it
        // harmless.
        await queue.dispatch(
          { name: entry.message.name },
          JSON.parse(entry.message.payload) as unknown,
          {
            maxAttempts: entry.message.maxAttempts,
            idempotencyKey: entry.message.idempotencyKey ?? entry.message.id,
          },
        );
        // Marked one at a time: if entry 40 fails, entries 1–39 stay published instead of the
        // whole batch being replayed on the next tick.
        published += await this.markPublished([entry.message.id]);
      }
      return published;
    },

    async size() {
      const [row] = await run(
        `SELECT COUNT(*) AS removed FROM ${table} WHERE published_at IS NULL`,
      );
      // coercion-ok: `COUNT(*)` is a driver-provided scalar, not application data.
      return Number(row?.['removed'] ?? 0);
    },
  };
}
