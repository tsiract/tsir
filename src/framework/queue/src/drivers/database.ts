/**
 * The `database` driver (`§ 4.2`): Postgres first, D1 with a claim query.
 *
 * Postgres gives this driver its dream primitive — `SELECT … FOR UPDATE SKIP LOCKED` — so two
 * workers never claim the same row and neither waits for the other. D1 has no row locks, so
 * the claim is a single `UPDATE … WHERE id IN (SELECT … LIMIT n) RETURNING *`: still one
 * statement, still atomic, which is the property that matters.
 *
 * Both dialect differences are resolved from `capabilities`, never guessed:
 * `?` vs `$n`, and `skipLocked` (true only where the engine really has it).
 *
 * The three tables are deliberately one schema (`queue.ts`'s DDL): `queue_jobs` (pending,
 * leased, delayed), `queue_dead` (dead letters), `queue_outbox` (the transactional outbox,
 * `outbox.ts`).
 */

import type { JobMessage, QueueBackend, QueueCapabilities, QueueDriver } from '../port.ts';
import type { QueueSql } from '../sql.ts';

export const DATABASE_QUEUE_CAPABILITIES = {
  transactional: true,
  delay: true,
  cancel: true,
  persistent: true,
  ordered: true,
  deadLetter: true,
  // A `seen` set here, a partial unique index on `database`: the store enforces it.
  idempotency: true,
} as const satisfies QueueCapabilities;

export interface DatabaseQueueOptions {
  readonly sql: QueueSql;
  /** Default `queue_jobs`. */
  readonly table?: string | undefined;
  /** Default `queue_dead`. */
  readonly deadTable?: string | undefined;
  readonly now?: (() => number) | undefined;
}

/** The DDL a migration carries: two queue tables and the outbox. */
export function queueTableDdl(
  options: {
    readonly engine: QueueSql['capabilities']['engine'];
    readonly table?: string;
    readonly deadTable?: string;
    readonly outboxTable?: string;
  } = { engine: 'postgres' },
): readonly string[] {
  const table = options.table ?? 'queue_jobs';
  const dead = options.deadTable ?? 'queue_dead';
  const outbox = options.outboxTable ?? 'queue_outbox';
  const bigint = options.engine === 'postgres' ? 'BIGINT' : 'INTEGER';

  return [
    `CREATE TABLE IF NOT EXISTS ${table} (\n  id TEXT PRIMARY KEY,\n  name TEXT NOT NULL,\n  payload TEXT NOT NULL,\n  connection TEXT NOT NULL,\n  attempts INTEGER NOT NULL DEFAULT 0,\n  max_attempts INTEGER NOT NULL DEFAULT 5,\n  available_at ${bigint} NOT NULL,\n  leased_until ${bigint} NOT NULL DEFAULT 0,\n  created_at ${bigint} NOT NULL,\n  last_error TEXT,\n  idempotency_key TEXT\n)`,
    // The claim query's only real requirement: an index on (available_at, leased_until).
    `CREATE INDEX IF NOT EXISTS ${table}_due ON ${table} (available_at, leased_until)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ${table}_idempotency ON ${table} (idempotency_key) WHERE idempotency_key IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS ${dead} (\n  id TEXT PRIMARY KEY,\n  name TEXT NOT NULL,\n  payload TEXT NOT NULL,\n  connection TEXT NOT NULL,\n  attempts INTEGER NOT NULL,\n  max_attempts INTEGER NOT NULL,\n  available_at ${bigint} NOT NULL,\n  created_at ${bigint} NOT NULL,\n  last_error TEXT,\n  idempotency_key TEXT\n)`,
    `CREATE TABLE IF NOT EXISTS ${outbox} (\n  id TEXT PRIMARY KEY,\n  name TEXT NOT NULL,\n  payload TEXT NOT NULL,\n  connection TEXT NOT NULL,\n  created_at ${bigint} NOT NULL,\n  max_attempts INTEGER NOT NULL DEFAULT 5,\n  idempotency_key TEXT,\n  published_at ${bigint}\n)`,
    `CREATE INDEX IF NOT EXISTS ${outbox}_unpublished ON ${outbox} (published_at)`,
  ];
}

interface Row extends Record<string, unknown> {
  readonly id?: string;
  readonly name?: string;
  readonly payload?: string;
  readonly connection?: string;
  readonly attempts?: number | string;
  readonly max_attempts?: number | string;
  readonly available_at?: number | string;
  readonly created_at?: number | string;
  readonly last_error?: string | null;
  readonly idempotency_key?: string | null;
  readonly removed?: number | string;
}

function int(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return value;
  if (value === null || value === undefined) return fallback;
  // coercion-ok: a BIGINT column arrives as bigint, and a queue timestamp is nowhere near 2^53.
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    // coercion-ok: SQLite/D1 hand integer columns back as strings; `Number.isFinite` rejects
    // the garbage instead of turning "" into 0.
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function toMessage(row: Row): JobMessage {
  return {
    id: row.id ?? '',
    name: row.name ?? '',
    payload: row.payload ?? '',
    connection: row.connection ?? '',
    attempts: int(row.attempts),
    maxAttempts: int(row.max_attempts, 5),
    availableAt: int(row.available_at),
    createdAt: int(row.created_at),
    ...(row.last_error === null || row.last_error === undefined
      ? {}
      : { lastError: row.last_error }),
    ...(row.idempotency_key === null || row.idempotency_key === undefined
      ? {}
      : { idempotencyKey: row.idempotency_key }),
  };
}

export function databaseQueueDriver(options: DatabaseQueueOptions): QueueDriver<never> {
  const table = options.table ?? 'queue_jobs';
  const deadTable = options.deadTable ?? 'queue_dead';
  const now = options.now ?? ((): number => Date.now());

  return {
    name: 'database',
    capabilities: DATABASE_QUEUE_CAPABILITIES,
    open(): QueueBackend {
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

      const backend: QueueBackend = {
        name: 'database',
        capabilities: DATABASE_QUEUE_CAPABILITIES,
        now,

        async push(message) {
          const params = [
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
          ];

          if (message.idempotencyKey === undefined) {
            await run(
              `INSERT INTO ${table} (id, name, payload, connection, attempts, max_attempts, available_at, created_at, last_error, idempotency_key) VALUES (${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(p).join(', ')})`,
              params,
            );
            return;
          }

          // A duplicate idempotency key is the backend saying "already queued", not an error.
          await run(
            `INSERT INTO ${table} (id, name, payload, connection, attempts, max_attempts, available_at, created_at, last_error, idempotency_key) VALUES (${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(p).join(', ')}) ON CONFLICT (idempotency_key) DO NOTHING`,
            params,
          );
        },

        async reserve({ connection, limit, now: clock, leaseMs }) {
          const due = `available_at <= ${p(1)} AND leased_until <= ${p(1)} AND connection = ${p(2)}`;

          // Postgres: the rows are locked for the duration of the statement, so a second
          // worker skips them instead of waiting (`SKIP LOCKED`).
          // D1: one statement — the UPDATE claims and returns in the same breath.
          const rows = await run(
            `UPDATE ${table} SET leased_until = ${p(3)}, attempts = attempts + 1 ` +
              `WHERE id IN (SELECT id FROM ${table} WHERE ${due} ORDER BY available_at LIMIT ${dollar ? '$4' : '?'}` +
              `${dollar ? ' FOR UPDATE SKIP LOCKED' : ''}) RETURNING *`,
            [clock, connection, clock + leaseMs, limit],
          );

          return rows.map(toMessage);
        },

        async complete(message) {
          await run(`DELETE FROM ${table} WHERE id = ${p(1)}`, [message.id]);
        },

        async fail(message, { error, retryAt }) {
          if (retryAt === undefined) {
            // Exhausted: move the row, do not delete it — the dead-letter store is the record.
            await run(
              `INSERT INTO ${deadTable} (id, name, payload, connection, attempts, max_attempts, available_at, created_at, last_error, idempotency_key) ` +
                `SELECT id, name, payload, connection, attempts, max_attempts, available_at, created_at, ${p(2)}, idempotency_key FROM ${table} WHERE id = ${p(1)}`,
              [message.id, error],
            );
            await run(`DELETE FROM ${table} WHERE id = ${p(1)}`, [message.id]);
            return;
          }

          await run(
            `UPDATE ${table} SET attempts = ${p(3)}, available_at = ${p(2)}, leased_until = 0, last_error = ${p(4)} WHERE id = ${p(1)}`,
            [message.id, retryAt, message.attempts, error],
          );
        },

        async dead(limit) {
          const rows = await run(
            `SELECT * FROM ${deadTable} ORDER BY created_at ASC LIMIT ${p(1)}`,
            [limit],
          );
          return rows.map(toMessage);
        },

        async replay(id, clock) {
          const rows = await run(`SELECT * FROM ${deadTable} WHERE id = ${p(1)}`, [id]);
          const row = rows[0];
          if (row === undefined) return false;

          const message = toMessage(row);
          await run(
            `INSERT INTO ${table} (id, name, payload, connection, attempts, max_attempts, available_at, created_at, last_error, idempotency_key) ` +
              `VALUES (${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(p).join(', ')})`,
            [
              message.id,
              message.name,
              message.payload,
              message.connection,
              0,
              message.maxAttempts,
              clock,
              message.createdAt,
              null,
              message.idempotencyKey ?? null,
            ],
          );
          await run(`DELETE FROM ${deadTable} WHERE id = ${p(1)}`, [id]);
          return true;
        },

        async discard(id) {
          const rows = await run(`DELETE FROM ${deadTable} WHERE id = ${p(1)} RETURNING id`, [id]);
          if (rows.length > 0) return true;
          const live = await run(`DELETE FROM ${table} WHERE id = ${p(1)} RETURNING id`, [id]);
          return live.length > 0;
        },

        async size() {
          const [row] = await run(`SELECT COUNT(*) AS removed FROM ${table}`);
          return int(row?.removed);
        },

        async purge() {
          await run(`DELETE FROM ${table}`);
          await run(`DELETE FROM ${deadTable}`);
        },
      };

      return backend;
    },
  };
}

export const databaseQueueCapabilities = DATABASE_QUEUE_CAPABILITIES;
