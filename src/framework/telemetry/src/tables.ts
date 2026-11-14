/**
 * Telemetry's tables, built for the engine you are actually on (`INF-010`).
 *
 * These tables used to be `sqliteTable(...)` constants, which was invisible on D1 and SQLite and
 * fatal on Postgres — the documented AWS default. Drizzle does not adapt one dialect's table to
 * another: a `sqliteTable` handed to a `drizzle-orm/node-postgres` instance produces SQLite SQL, and
 * Postgres answers with a syntax error about `strftime`. So the table definitions were not portable
 * code with a wrong default; they were SQLite code, and their types said nothing about it.
 *
 * ## Why a factory instead of two exported pairs
 *
 * `queueJobs`/`requestLogs` are also imported by applications for migrations and by the monitor's
 * own queries. Keeping the four names exported and building the right pair at construction would put
 * the choice back in the caller's hands — the mistake this fixes. Instead `telemetryTables(engine)`
 * returns all four, and the modules that use them take the engine. A wrong engine is then a compile
 * error at the one place that knows, not a runtime error at the first query.
 *
 * `bigint(…, { mode: 'number' })` for Postgres rather than `integer`: the epoch-millisecond columns
 * are `BIGINT` in the queue's own DDL, and reading them as `integer` truncates. The `mode` keeps the
 * TypeScript type `number` on both dialects, so an application never branches on the engine for a
 * timestamp.
 */

import { bigint, integer as pgInteger, pgTable, text as pgText } from 'drizzle-orm/pg-core';
import { integer as sqliteInteger, sqliteTable, text as sqliteText } from 'drizzle-orm/sqlite-core';

/** The engines these tables are built for. `mysql` is deliberately absent: see `telemetryTableDdl`. */
export type TelemetryEngine = 'd1' | 'sqlite' | 'postgres';

export interface TelemetryTableNames {
  readonly requestLogs?: string | undefined;
  readonly queueJobs?: string | undefined;
  readonly queueDead?: string | undefined;
}

/** Every table this package knows the shape of, for whichever engine. */
export interface TelemetryTables {
  readonly requestLogs:
    ReturnType<typeof sqliteTables>['requestLogs'] | PostgresTables['requestLogs'];
  readonly queueJobs: ReturnType<typeof sqliteTables>['queueJobs'] | PostgresTables['queueJobs'];
  readonly queueDead: ReturnType<typeof sqliteTables>['queueDead'] | PostgresTables['queueDead'];
}

function sqliteTables(suffix = ''): {
  requestLogs: ReturnType<typeof buildSqliteRequestLogs>;
  queueJobs: ReturnType<typeof buildSqliteQueueJobs>;
  queueDead: ReturnType<typeof buildSqliteQueueDead>;
} {
  return {
    requestLogs: buildSqliteRequestLogs(`request_logs${suffix}`),
    queueJobs: buildSqliteQueueJobs(`queue_jobs${suffix}`),
    queueDead: buildSqliteQueueDead(`queue_dead${suffix}`),
  };
}

type PostgresTables = ReturnType<typeof postgresTables>;

function buildSqliteRequestLogs(name: string) {
  return sqliteTable(name, {
    id: sqliteText('id').primaryKey(),
    method: sqliteText('method').notNull(),
    path: sqliteText('path').notNull(),
    status: sqliteInteger('status').notNull(),
    durationMs: sqliteInteger('duration_ms').notNull(),
    principalSubject: sqliteText('principal_subject'),
    ip: sqliteText('ip'),
    userAgent: sqliteText('user_agent'),
    // Epoch milliseconds as a plain integer, not `mode: 'timestamp_ms'`: that mode hands back a
    // `Date`, while Postgres's `bigint(…, mode: 'number')` hands back a number, so the same query
    // would return two different types depending on the target — the split this factory exists to
    // remove. The column was already BIGINT/INTEGER in the queue's own DDL.
    createdAt: sqliteInteger('created_at').notNull(),
  });
}

function buildSqliteQueueJobs(name: string) {
  return sqliteTable(name, {
    id: sqliteText('id').primaryKey(),
    name: sqliteText('name').notNull(),
    payload: sqliteText('payload').notNull(),
    connection: sqliteText('connection').notNull(),
    attempts: sqliteInteger('attempts').notNull().default(0),
    maxAttempts: sqliteInteger('max_attempts').notNull().default(5),
    availableAt: sqliteInteger('available_at').notNull(),
    leasedUntil: sqliteInteger('leased_until').notNull().default(0),
    createdAt: sqliteInteger('created_at').notNull(),
    lastError: sqliteText('last_error'),
    idempotencyKey: sqliteText('idempotency_key'),
    requestId: sqliteText('request_id'),
  });
}

function buildSqliteQueueDead(name: string) {
  return sqliteTable(name, {
    id: sqliteText('id').primaryKey(),
    name: sqliteText('name').notNull(),
    payload: sqliteText('payload').notNull(),
    connection: sqliteText('connection').notNull(),
    attempts: sqliteInteger('attempts').notNull(),
    maxAttempts: sqliteInteger('max_attempts').notNull(),
    availableAt: sqliteInteger('available_at').notNull(),
    createdAt: sqliteInteger('created_at').notNull(),
    lastError: sqliteText('last_error'),
    idempotencyKey: sqliteText('idempotency_key'),
    requestId: sqliteText('request_id'),
  });
}

function postgresTables(): {
  requestLogs: ReturnType<typeof buildPostgresRequestLogs>;
  queueJobs: ReturnType<typeof buildPostgresQueueJobs>;
  queueDead: ReturnType<typeof buildPostgresQueueDead>;
} {
  return {
    requestLogs: buildPostgresRequestLogs(),
    queueJobs: buildPostgresQueueJobs(),
    queueDead: buildPostgresQueueDead(),
  };
}

function buildPostgresRequestLogs() {
  return pgTable('request_logs', {
    id: pgText('id').primaryKey(),
    method: pgText('method').notNull(),
    path: pgText('path').notNull(),
    status: pgInteger('status').notNull(),
    durationMs: bigint('duration_ms', { mode: 'number' }).notNull(),
    principalSubject: pgText('principal_subject'),
    ip: pgText('ip'),
    userAgent: pgText('user_agent'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  });
}

function buildPostgresQueueJobs() {
  return pgTable('queue_jobs', {
    id: pgText('id').primaryKey(),
    name: pgText('name').notNull(),
    payload: pgText('payload').notNull(),
    connection: pgText('connection').notNull(),
    attempts: pgInteger('attempts').notNull().default(0),
    maxAttempts: pgInteger('max_attempts').notNull().default(5),
    availableAt: bigint('available_at', { mode: 'number' }).notNull(),
    leasedUntil: bigint('leased_until', { mode: 'number' }).notNull().default(0),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    lastError: pgText('last_error'),
    idempotencyKey: pgText('idempotency_key'),
    requestId: pgText('request_id'),
  });
}

function buildPostgresQueueDead() {
  return pgTable('queue_dead', {
    id: pgText('id').primaryKey(),
    name: pgText('name').notNull(),
    payload: pgText('payload').notNull(),
    connection: pgText('connection').notNull(),
    attempts: pgInteger('attempts').notNull(),
    maxAttempts: pgInteger('max_attempts').notNull(),
    availableAt: bigint('available_at', { mode: 'number' }).notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    lastError: pgText('last_error'),
    idempotencyKey: pgText('idempotency_key'),
    requestId: pgText('request_id'),
  });
}

/**
 * The tables for one engine.
 *
 * Typed as a union of two shapes rather than one loose shape: a caller that branches on the engine
 * still gets a precise type on each branch, and a caller that does not is forced to write code that
 * works for both — which is the property the old constant lacked.
 */
export function telemetryTables(engine: TelemetryEngine): TelemetryTables {
  // Memoised, so `telemetryTables('d1').requestLogs === telemetryTables('d1').requestLogs`. Two
  // table objects with the same name are *not* interchangeable to Drizzle — each carries its own
  // column instances, and a join or a subquery built from both produces duplicate aliases. A caller
  // that keeps a module-level reference and a logger that builds its own would hit that; identity
  // here makes the question disappear rather than documenting a rule nobody remembers.
  const cached = CACHE.get(engine);
  if (cached !== undefined) return cached;
  const built = engine === 'postgres' ? postgresTables() : sqliteTables();
  CACHE.set(engine, built);
  return built;
}

const CACHE = new Map<TelemetryEngine, TelemetryTables>();

/** The `CREATE TABLE` statements, so a migration and the schema cannot disagree. */
export function telemetryTableDdl(engine: TelemetryEngine): readonly string[] {
  // `mysql` is not a `TelemetryEngine` on purpose: `ON CONFLICT`, the missing `RETURNING` and the
  // `?`-placeholder split all differ, and a monitor is read-only enough that shipping a half-tested
  // third dialect is worse than saying which two are supported.
  const big = engine === 'postgres' ? 'BIGINT' : 'INTEGER';
  return [
    `CREATE TABLE IF NOT EXISTS request_logs (\n  id TEXT PRIMARY KEY,\n  method TEXT NOT NULL,\n  path TEXT NOT NULL,\n  status INTEGER NOT NULL,\n  duration_ms ${big} NOT NULL,\n  principal_subject TEXT,\n  ip TEXT,\n  user_agent TEXT,\n  created_at ${big} NOT NULL\n)`,
    `CREATE INDEX IF NOT EXISTS request_logs_created ON request_logs (created_at)`,
    // The queue's own tables, which the monitor only reads. They belong to `@tsir/queue`'s database
    // driver — this repeats the shape so a project that installs telemetry without the queue driver
    // still has a migration to run. `@tsir/queue`'s `queueTableDdl` stays authoritative.
    `CREATE TABLE IF NOT EXISTS queue_jobs (\n  id TEXT PRIMARY KEY,\n  name TEXT NOT NULL,\n  payload TEXT NOT NULL,\n  connection TEXT NOT NULL,\n  attempts INTEGER NOT NULL DEFAULT 0,\n  max_attempts INTEGER NOT NULL DEFAULT 5,\n  available_at ${big} NOT NULL,\n  leased_until ${big} NOT NULL DEFAULT 0,\n  created_at ${big} NOT NULL,\n  last_error TEXT,\n  idempotency_key TEXT,\n  request_id TEXT\n)`,
    `CREATE TABLE IF NOT EXISTS queue_dead (\n  id TEXT PRIMARY KEY,\n  name TEXT NOT NULL,\n  payload TEXT NOT NULL,\n  connection TEXT NOT NULL,\n  attempts INTEGER NOT NULL,\n  max_attempts INTEGER NOT NULL,\n  available_at ${big} NOT NULL,\n  created_at ${big} NOT NULL,\n  last_error TEXT,\n  idempotency_key TEXT,\n  request_id TEXT\n)`,
  ];
}
