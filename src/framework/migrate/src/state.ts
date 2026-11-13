/**
 * The two tables a migration run touches.
 *
 * `__drizzle_migrations` is Drizzle's own bookkeeping — read here, written here,
 * never redefined. `__tsir_migration_runs` is Tsir's sidecar (`MIG-004`): one row
 * per applied migration, with the run id, host, actor, duration and checksum.
 *
 * Keeping them apart is the point. Drizzle's table answers "is this applied?";
 * the sidecar answers "who applied it, from where, how long did it take, and has
 * anyone seen this checksum before?" — questions a production incident asks and
 * a single `created_at` column cannot answer.
 */

import { TsirError } from '@tsir/core';
import { statement, type Database } from '@tsir/database';

import type { AppliedMigration } from './plan.ts';
import type { JournalEntry } from './journal.ts';

/**
 * The dialects the migration tables are written for.
 *
 * `sqlite` is here because D1 *is* SQLite: every branch below is `=== 'postgres'` with SQLite as
 * the else, so a file-backed connection is the same SQL as a binding-backed one (`CAP-009`).
 * `mysql` is deliberately absent — its DDL is not a branch of these two, and a type that admitted
 * it would turn "we never wrote this" into a runtime syntax error on the first `migrate`.
 */
export type Engine = 'd1' | 'postgres' | 'sqlite';

/**
 * A connection's engine, as a dialect these tables can be written for.
 *
 * `mysql` reaches this and stops here with the MySQL-specific answer rather than a SQL syntax
 * error halfway through a deployment: the two tables would be created with SQLite DDL and the
 * first insert would fail, after some migrations had already run.
 */
export function migrationEngine(capabilities: { readonly engine: string }): Engine {
  const engine = capabilities.engine;
  if (engine === 'd1' || engine === 'postgres' || engine === 'sqlite') return engine;
  throw new TsirError(
    'DB_MIGRATION_ENGINE_UNSUPPORTED',
    `migrations do not support the "${engine}" engine`,
    {
      kind: 'capability',
      hint: 'd1, postgres and sqlite are supported — mysql migrations are not written yet',
      context: { engine },
    },
  );
}

/** Where the two tables live. `schema` is undefined for D1 (no namespaces). */
export interface TableNames {
  readonly journal?: string;
  readonly audit?: string;
  readonly schema?: string;
}

export const JOURNAL_TABLE = '__drizzle_migrations';
export const AUDIT_TABLE = '__tsir_migration_runs';

/** `?` on D1, `$n` on Postgres. */
export function bind(engine: Engine, index: number): string {
  return engine === 'postgres' ? `$${String(index)}` : '?';
}

function tableRef(table: string, schema?: string): string {
  return schema === undefined ? `"${table}"` : `"${schema}"."${table}"`;
}

/**
 * Drizzle's own table definition, matched column for column.
 *
 * Creating it is the one piece of DDL Tsir runs before the first migration: a
 * database that has never been migrated has no such table, and `migrate` on a
 * fresh database is the normal case (`migrate:verify` does nothing else).
 */
export function journalTableDdl(engine: Engine, names: TableNames = {}): string {
  const table = tableRef(names.journal ?? JOURNAL_TABLE, names.schema);
  return engine === 'postgres'
    ? `create table if not exists ${table} ("id" serial primary key, "hash" text not null, "created_at" bigint)`
    : `create table if not exists ${table} ("id" integer primary key autoincrement, "hash" text not null, "created_at" integer)`;
}

export function auditTableDdl(engine: Engine, names: TableNames = {}): string {
  const table = tableRef(names.audit ?? AUDIT_TABLE, names.schema);
  return engine === 'postgres'
    ? `create table if not exists ${table} ("id" serial primary key, "run_id" text not null, "tag" text not null, "checksum" text not null, "host" text not null, "actor" text not null, "duration_ms" integer not null, "applied_at" bigint not null)`
    : `create table if not exists ${table} ("id" integer primary key autoincrement, "run_id" text not null, "tag" text not null, "checksum" text not null, "host" text not null, "actor" text not null, "duration_ms" integer not null, "applied_at" integer not null)`;
}

export interface MigrationRun {
  readonly runId: string;
  readonly tag: string;
  readonly checksum: string;
  readonly host: string;
  readonly actor: string;
  readonly durationMs: number;
  readonly appliedAt: number;
}

/**
 * Reads `__drizzle_migrations`.
 *
 * A missing table is *not* an error: it means "nothing applied yet", which is the
 * state of every fresh database and the state `migrate:verify` requires. The
 * presence of the table is checked by the caller that needs to create it.
 */
export async function readApplied(
  database: Database,
  names: TableNames = {},
): Promise<readonly AppliedMigration[]> {
  const table = tableRef(names.journal ?? JOURNAL_TABLE, names.schema);
  const result = await database.query(
    statement(`select "id", "hash", "created_at" from ${table} order by "created_at" asc`),
  );

  return result.rows.map((row) => {
    const record = row as Record<string, unknown>;
    return {
      ...(typeof record['id'] === 'number' ? { id: record['id'] } : {}),
      hash: typeof record['hash'] === 'string' ? record['hash'] : '',
      // `bigint` on Postgres arrives as a string from some clients; both are the
      // journal's `when` in milliseconds.
      createdAt: toNumber(record['created_at']),
    };
  });
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  // coercion-ok: a `bigint` column read back from Postgres.
  if (typeof value === 'bigint') return Number(value);
  // coercion-ok: numeric columns arrive as text from some clients; a non-numeric
  // value yields NaN, which the planner reports instead of treating as epoch 0.
  if (typeof value === 'string') return Number(value);
  return Number.NaN;
}

/** True when the error is "no such table", the one read failure that means "fresh". */
export function isMissingTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table|does not exist|undefined_table|no such table:/i.test(message);
}

export function insertAppliedStatement(
  engine: Engine,
  entry: JournalEntry,
  checksum: string,
  names: TableNames = {},
): { sql: string; params: readonly unknown[] } {
  const table = tableRef(names.journal ?? JOURNAL_TABLE, names.schema);
  return {
    sql: `insert into ${table} ("hash", "created_at") values (${bind(engine, 1)}, ${bind(engine, 2)})`,
    params: [checksum, entry.when],
  };
}

export function deleteAppliedStatement(
  engine: Engine,
  when: number,
  names: TableNames = {},
): { sql: string; params: readonly unknown[] } {
  const table = tableRef(names.journal ?? JOURNAL_TABLE, names.schema);
  return {
    sql: `delete from ${table} where "created_at" = ${bind(engine, 1)}`,
    params: [when],
  };
}

export function insertRunStatement(
  engine: Engine,
  run: MigrationRun,
  names: TableNames = {},
): {
  sql: string;
  params: readonly unknown[];
} {
  const table = tableRef(names.audit ?? AUDIT_TABLE, names.schema);
  const values = Array.from({ length: 7 }, (_, index) => bind(engine, index + 1)).join(', ');
  return {
    sql: `insert into ${table} ("run_id", "tag", "checksum", "host", "actor", "duration_ms", "applied_at") values (${values})`,
    params: [run.runId, run.tag, run.checksum, run.host, run.actor, run.durationMs, run.appliedAt],
  };
}

/** Recent runs, newest first — what `migrate:status --runs` prints. */
export async function readRuns(
  database: Database,
  names: TableNames = {},
  limit = 20,
): Promise<readonly MigrationRun[]> {
  const table = tableRef(names.audit ?? AUDIT_TABLE, names.schema);
  try {
    const result = await database.query(
      statement(
        `select "run_id", "tag", "checksum", "host", "actor", "duration_ms", "applied_at" from ${table} order by "applied_at" desc`,
      ),
    );
    return result.rows.slice(0, limit).map((row) => {
      const record = row as Record<string, unknown>;
      return {
        runId: text(record['run_id']),
        tag: text(record['tag']),
        checksum: text(record['checksum']),
        host: text(record['host']),
        actor: text(record['actor']),
        durationMs: toNumber(record['duration_ms']),
        appliedAt: toNumber(record['applied_at']),
      };
    });
  } catch (error: unknown) {
    if (isMissingTable(error)) return [];
    throw error;
  }
}
