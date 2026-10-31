/**
 * The dead-letter store for **broker-backed** drivers (`§ 4.2`, `QUEUE-15`/`16`).
 *
 * Cloudflare Queues and SQS both have their own redrive story — Queues has a native DLQ,
 * SQS has a redrive policy — and both are *the broker's*, not the application's: the
 * messages sit in a queue the app can read only with the same client it uses to consume,
 * and "replay" means "redrive the whole DLQ", not "retry this one message".
 *
 * The port promises something narrower and more useful: `dead(limit)`, `replay(id)`,
 * `discard(id)`. So a broker driver keeps its own dead-letter **table**, next to the
 * outbox — the same three columns the `database` driver uses, in the same database, which
 * is what makes `tsir queue:failed` and `tsir queue:retry` work identically across drivers.
 *
 * Why this is not shared with `drivers/database.ts`: that driver moves a row *within* the
 * database (`INSERT INTO queue_dead SELECT … FROM queue_jobs`), which is one atomic
 * statement. Here the message was never in the database at all — it is copied out of a
 * platform object — so the statements are genuinely different operations that happen to
 * share a table shape.
 */

import type { JobMessage } from './port.ts';
import type { QueueSql } from './sql.ts';

export interface DeadLetterStoreOptions {
  readonly sql: QueueSql;
  /** Default `queue_dead` — the same table `tsir queue:table` prints. */
  readonly table?: string | undefined;
}

export interface DeadLetterStore {
  /** Record a message the driver gave up on. */
  record(message: JobMessage): Promise<void>;
  list(limit: number): Promise<readonly JobMessage[]>;
  /** Remove one, reporting whether it was there. */
  remove(id: string): Promise<boolean>;
  clear(): Promise<void>;
}

interface Row extends Record<string, unknown> {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly payload?: unknown;
  readonly connection?: unknown;
  readonly attempts?: unknown;
  readonly max_attempts?: unknown;
  readonly available_at?: unknown;
  readonly created_at?: unknown;
  readonly last_error?: unknown;
  readonly idempotency_key?: unknown;
}

function integer(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // coercion-ok: SQLite hands integer columns back as strings; a non-finite value falls back.
  if (typeof value === 'string' && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

const text = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

function toMessage(row: Row): JobMessage {
  const error = row.last_error;
  const key = row.idempotency_key;
  return {
    // A SQL row is `unknown` by contract; `text()` narrows rather than stringifying a value that
    // might be an object into `[object Object]`.
    id: text(row.id),
    name: text(row.name),
    payload: text(row.payload),
    connection: text(row.connection),
    attempts: integer(row.attempts),
    maxAttempts: integer(row.max_attempts, 5) || 5,
    availableAt: integer(row.available_at),
    createdAt: integer(row.created_at),
    ...(typeof error === 'string' ? { lastError: error } : {}),
    ...(typeof key === 'string' ? { idempotencyKey: key } : {}),
  };
}

export function createDeadLetterStore(options: DeadLetterStoreOptions): DeadLetterStore {
  const table = options.table ?? 'queue_dead';
  const { sql } = options;
  const dollar = sql.capabilities.placeholder === 'dollar';
  const p = (index: number): string => (dollar ? `$${String(index)}` : '?');

  const run = async (
    statement: string,
    params: readonly unknown[] = [],
  ): Promise<readonly Row[]> => {
    const result = await sql.query({ sql: statement, params });
    return result.rows as readonly Row[];
  };

  return {
    async record(message) {
      await run(
        `INSERT INTO ${table} (id, name, payload, connection, attempts, max_attempts, available_at, created_at, last_error, idempotency_key) ` +
          `VALUES (${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(p).join(', ')})`,
        [
          message.id,
          message.name,
          message.payload,
          message.connection,
          message.attempts,
          message.maxAttempts,
          message.availableAt,
          message.createdAt,
          message.lastError ?? null,
          message.idempotencyKey ?? null,
        ],
      );
    },

    async list(limit) {
      const rows = await run(`SELECT * FROM ${table} ORDER BY created_at ASC LIMIT ${p(1)}`, [
        limit,
      ]);
      return rows.map(toMessage);
    },

    async remove(id) {
      const rows = await run(`DELETE FROM ${table} WHERE id = ${p(1)} RETURNING id`, [id]);
      return rows.length > 0;
    },

    async clear() {
      await run(`DELETE FROM ${table}`);
    },
  };
}
