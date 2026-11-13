/**
 * The applier (`MIG-002`, `MIG-006`, `MIG-007`).
 *
 * The order of operations is the contract:
 *
 *   1. read the folder, read the applied rows, **refuse on drift** — before any
 *      write, because a drift error discovered after three migrations applied is
 *      not a refusal, it is an outage;
 *   2. take the advisory lock (Postgres) on a **pinned** connection and re-read
 *      under it, since another runner may have applied migrations while this one
 *      waited;
 *   3. create the journal and audit tables if they do not exist;
 *   4. apply each pending migration according to its own transaction policy, then
 *      write its audit row;
 *   5. stop at the first failure, with the error wrapped so it names the tag and
 *      the statement — never "best effort".
 *
 * Step 2 is why the whole run happens inside `Database.pinned(fn)` when the
 * driver can reserve (`DB-018`): `pg_try_advisory_lock` is session-scoped, so a
 * lock taken on one pooled connection and DDL run on another excludes nothing.
 * When the client cannot reserve, the run still proceeds — a single-runner deploy
 * is the normal case — but it reports `lockVerified: false` instead of pretending.
 */

import { TsirError } from '@tsir/container';
import { statement, type Database } from '@tsir/database';

import { readMigrationFolder, type Migration } from './journal.ts';
import { planMigrations, type AppliedMigration, type MigrationPlan } from './plan.ts';
import { acquireMigrationLock, lockHeldMessage } from './lock.ts';
import {
  auditTableDdl,
  insertAppliedStatement,
  insertRunStatement,
  isMissingTable,
  journalTableDdl,
  migrationEngine,
  readApplied,
  type TableNames,
} from './state.ts';

export interface MigrateOptions {
  readonly database: Database;
  /** Folder holding `meta/_journal.json` and the `.sql` files. */
  readonly folder: string;
  readonly tables?: TableNames;
  /** Owner of the lock, and the `application_name` that scopes it. */
  readonly name: string;
  readonly host?: string;
  readonly actor?: string;
  /** Wait up to this long for another runner; `0` reports and returns. */
  readonly waitMs?: number;
  /** Planned but not executed: the report says what *would* run. */
  readonly dryRun?: boolean;
  readonly runId?: string;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

export interface AppliedOne {
  readonly tag: string;
  readonly durationMs: number;
  /** False when `-- tsir:transaction=off` made the migration non-atomic. */
  readonly atomic: boolean;
}

export interface MigrateResult {
  /** Which connection was migrated (`MIG-015`) — the journal and lock are its own. */
  readonly connection: string;
  /** Tags applied by this run, in order. */
  readonly applied: readonly AppliedOne[];
  /** Tags still pending after this run (only non-empty for a dry run or a lock). */
  readonly pending: readonly string[];
  /** True when another runner held the lock; nothing was applied and that is fine. */
  readonly locked: boolean;
  /** False on D1: there is no advisory lock to take. */
  readonly lockSupported: boolean;
  /**
   * True when the lock was taken on a pinned session, or when there was no lock to
   * take at all (D1). False when the client cannot reserve: the advisory lock was
   * then acquired on a pooled connection and may not cover the DDL that followed.
   */
  readonly lockVerified: boolean;
  readonly drift: readonly string[];
  readonly orphaned: readonly string[];
  readonly durationMs: number;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function migrationFailed(
  file: Migration,
  error: unknown,
  context: { readonly statementIndex: number; readonly sql: string; readonly transaction: boolean },
): TsirError {
  const preview = context.sql.length > 160 ? `${context.sql.slice(0, 160)}…` : context.sql;
  return new TsirError(
    'DB_MIGRATION_FAILED',
    `migration "${file.tag}" failed at statement ${String(context.statementIndex + 1)}: ${preview}`,
    {
      kind: 'database',
      hint: context.transaction
        ? 'the transaction was rolled back; fix the SQL and run `tsir migrate` again'
        : 'this migration runs with `tsir:transaction=off`, so earlier statements in it may have been applied — inspect the schema before retrying',
      context: { tag: file.tag, statement: context.statementIndex },
      cause: error,
    },
  );
}

/** A journal entry with no SQL is a broken repository, not a no-op migration. */
function emptyMigration(file: Migration): TsirError {
  return new TsirError('DB_MIGRATION_EMPTY', `migration "${file.tag}" contains no statements`, {
    kind: 'database',
    hint: 'delete the file and its journal entry, or write the SQL it was meant to contain — an empty migration still marks the schema as migrated',
    context: { tag: file.tag },
  });
}

export function driftError(planValue: MigrationPlan): TsirError {
  const first = planValue.drifted[0];
  const tags = planValue.drifted.map((entry) => entry.file.tag).join(', ');
  return new TsirError('DB_MIGRATION_DRIFT', `applied migration(s) changed on disk: ${tags}`, {
    kind: 'database',
    hint:
      'an applied migration must never be edited — write a new migration that corrects it. ' +
      'If the edit was intentional on a database you own, revert the file so its checksum matches again',
    ...(first === undefined
      ? {}
      : { context: { tag: first.file.tag, stored: first.stored, actual: first.actual } }),
  });
}

/**
 * Runs one migration's statements plus its bookkeeping, atomically when the
 * engine allows it.
 */
async function applyOne(
  database: Database,
  file: Migration,
  tables: TableNames,
): Promise<{ readonly atomic: boolean }> {
  const engine = migrationEngine(database.capabilities);
  const journal = insertAppliedStatement(
    engine,
    { idx: file.idx, tag: file.tag, when: file.when, version: '7' },
    file.checksum,
    tables,
  );

  if (!file.transaction) {
    // Non-atomic by declaration. Each statement is its own round trip; the
    // journal row goes last so a crash mid-file leaves the migration pending.
    for (const [index, sql] of file.statements.entries()) {
      try {
        await database.query(statement(sql));
      } catch (error: unknown) {
        throw migrationFailed(file, error, { statementIndex: index, sql, transaction: false });
      }
    }
    await database.query(statement(journal.sql, journal.params));
    return { atomic: false };
  }

  if (database.capabilities.interactiveTx) {
    await database.interactiveTx(async (tx) => {
      for (const [index, sql] of file.statements.entries()) {
        try {
          await tx.query(statement(sql));
        } catch (error: unknown) {
          throw migrationFailed(file, error, { statementIndex: index, sql, transaction: true });
        }
      }
      await tx.query(statement(journal.sql, journal.params));
    });
    return { atomic: true };
  }

  // D1: `batch()` is the transaction. One batch = one implicit transaction, so
  // the statements and the journal row commit or roll back together.
  try {
    await database.batch([
      ...file.statements.map((sql) => statement(sql)),
      statement(journal.sql, journal.params),
    ]);
  } catch (error: unknown) {
    // The batch tells us *that* it failed, not which statement: D1's error
    // carries the message and offset, so report the tag and the whole file's
    // first statement, and let the message speak for the rest.
    throw migrationFailed(file, error, {
      statementIndex: 0,
      sql: file.statements[0] ?? '',
      transaction: true,
    });
  }
  return { atomic: true };
}

export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const { database } = options;
  const { migrations } = await readMigrationFolder(options.folder);

  const initial = planMigrations(
    migrations,
    await readAppliedOrEmpty(database, options.tables ?? {}),
  );
  if (initial.drifted.length > 0) throw driftError(initial);

  const empty = initial.pending.find((file) => file.statements.length === 0);
  if (empty !== undefined) throw emptyMigration(empty);

  // Nothing to lock for a report or an already-current database, and opening a
  // second connection to say "nothing to do" is a cost with no benefit.
  if (options.dryRun === true || initial.pending.length === 0) {
    return report(options, initial, database);
  }

  // The pinned scope is what makes the advisory lock mean anything (`DB-018`).
  // On a client that cannot reserve, run on the pool and say the lock is unverified.
  if (database.capabilities.pinnedConnection) {
    return database.pinned((scope) => runUnderLock(options, scope, true));
  }
  return runUnderLock(options, database, false);
}

/** A dry run or a no-op run: no lock, no writes, the same report shape. */
function report(options: MigrateOptions, plan: MigrationPlan, database: Database): MigrateResult {
  const now = options.now ?? (() => Date.now());
  const started = now();
  const lockSupported = database.capabilities.engine === 'postgres';
  return {
    connection: database.name,
    applied: [],
    pending: plan.pending.map((file) => file.tag),
    locked: false,
    lockSupported,
    // Nothing was locked, so nothing is unverified — except on a pooled Postgres
    // client, where a *future* lock would be equally unverified.
    lockVerified: !lockSupported || database.capabilities.pinnedConnection,
    drift: [],
    orphaned: plan.orphans.map((row) => String(row.createdAt)),
    durationMs: now() - started,
  };
}

/**
 * The piece that must be exclusive: re-read, ensure tables, apply, audit.
 *
 * `db` is the pinned scope when the driver can reserve, otherwise the pool.
 */
async function runUnderLock(
  options: MigrateOptions,
  database: Database,
  canVerifyLock: boolean,
): Promise<MigrateResult> {
  const now = options.now ?? (() => Date.now());
  const started = now();
  const tables = options.tables ?? {};
  const log = options.log ?? (() => undefined);

  const { migrations } = await readMigrationFolder(options.folder);
  const initial = planMigrations(migrations, await readAppliedOrEmpty(database, tables));
  if (initial.drifted.length > 0) throw driftError(initial);

  const lock = await acquireMigrationLock(database, {
    connection: database.name,
    name: options.name,
    ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }),
  });
  const lockVerified = lock.supported ? canVerifyLock : true;

  if (!lock.acquired) {
    log(lockHeldMessage(options.name, database.name));
    return {
      connection: database.name,
      applied: [],
      pending: initial.pending.map((file) => file.tag),
      locked: true,
      lockSupported: lock.supported,
      lockVerified,
      drift: [],
      orphaned: [],
      durationMs: now() - started,
    };
  }

  try {
    // Re-read under the lock: another runner may have applied migrations while
    // this one waited, and re-applying them is exactly the bug the lock prevents.
    const current = planMigrations(migrations, await readAppliedOrEmpty(database, tables));
    if (current.drifted.length > 0) throw driftError(current);
    if (current.pending.length === 0) {
      log('no pending migrations (another runner applied them)');
      return {
        connection: database.name,
        applied: [],
        pending: [],
        locked: false,
        lockSupported: lock.supported,
        lockVerified,
        drift: [],
        orphaned: current.orphans.map((row) => String(row.createdAt)),
        durationMs: now() - started,
      };
    }

    await ensureTables(database, tables);

    const runId = options.runId ?? randomRunId();
    const applied: AppliedOne[] = [];

    for (const file of current.pending) {
      for (const warning of file.warnings) log(`warning: ${warning}`);
      if (!file.transaction) {
        log(`warning: "${file.tag}" declares tsir:transaction=off — it is not atomic`);
      }

      const fileStarted = now();
      const outcome = await applyOne(database, file, tables);
      const durationMs = now() - fileStarted;
      applied.push({ tag: file.tag, durationMs, atomic: outcome.atomic });

      // The migration is committed at this point. The audit row is written
      // after it so it can carry the real duration — and a failure to write it
      // must not fail or roll back work that already happened.
      const run = insertRunStatement(
        migrationEngine(database.capabilities),
        {
          runId,
          tag: file.tag,
          checksum: file.checksum,
          host: options.host ?? 'unknown',
          actor: options.actor ?? 'unknown',
          durationMs,
          appliedAt: now(),
        },
        tables,
      );
      try {
        await database.query(statement(run.sql, run.params));
      } catch (error: unknown) {
        log(
          `warning: migration "${file.tag}" applied but its audit row was not written (${describe(error)})`,
        );
      }

      log(
        `applied ${file.tag} in ${String(durationMs)} ms${outcome.atomic ? '' : ' (non-atomic)'}`,
      );
    }

    return {
      connection: database.name,
      applied,
      pending: [],
      locked: false,
      lockSupported: lock.supported,
      lockVerified,
      drift: [],
      orphaned: current.orphans.map((row) => String(row.createdAt)),
      durationMs: now() - started,
    };
  } finally {
    await lock.release();
  }
}

/**
 * `readApplied` against a database that may not have the table yet.
 *
 * A fresh database has no `__drizzle_migrations`, and that is the normal starting
 * point — treating "no table" as an error would make `migrate` unusable exactly
 * where it is most needed.
 */
export async function readAppliedOrEmpty(
  database: Database,
  tables: TableNames = {},
): Promise<readonly AppliedMigration[]> {
  try {
    return await readApplied(database, tables);
  } catch (error: unknown) {
    if (isMissingTable(error)) return [];
    throw error;
  }
}

/** Creates both tables once per run; `if not exists` keeps it idempotent. */
export async function ensureTables(database: Database, tables: TableNames = {}): Promise<void> {
  const engine = migrationEngine(database.capabilities);
  await database.query(statement(journalTableDdl(engine, tables)));
  await database.query(statement(auditTableDdl(engine, tables)));
}

/** Random, but not `Math.random` — a run id that two processes cannot collide on. */
function randomRunId(): string {
  return crypto.randomUUID();
}
