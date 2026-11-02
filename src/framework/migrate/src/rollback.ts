/**
 * `migrate:rollback` (`MIG-009`).
 *
 * Drizzle does not generate down migrations. Rather than inventing them — a
 * generated `DROP TABLE` is a data-loss bug with good intentions — Tsir refuses
 * to roll back a migration that has no hand-written `<tag>.down.sql`, and says so
 * before touching anything.
 *
 * The three guards are deliberately redundant, because each one catches a
 * different mistake:
 *
 *   · a down file must exist                    → nobody hand-writes DDL under pressure;
 *   · `--allow-destructive` must be passed      → the operator knows what this does;
 *   · `--confirm <newest tag>` must match       → the operator read *which* one it does it to.
 *
 * Rolling back "to a tag" means: undo everything newer than that tag, newest
 * first, so each step starts from a schema the next one expects.
 */

import { TsirError } from '@tsir/container';
import { statement, type Database } from '@tsir/database';

import { readMigrationFolder, splitStatements, type Migration } from './journal.ts';
import { acquireMigrationLock } from './lock.ts';
import { deleteAppliedStatement, isMissingTable, readApplied, type TableNames } from './state.ts';

export const EMPTY_TARGET = 'empty';

export interface RollbackOptions {
  readonly database: Database;
  readonly folder: string;
  /** Tag of the last migration to keep, or `empty` to undo everything. */
  readonly to: string;
  readonly allowDestructive?: boolean;
  /** The tag typed back by the operator; must equal the newest migration removed. */
  readonly confirm?: string;
  readonly tables?: TableNames;
  readonly name: string;
  readonly waitMs?: number;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

export interface RollbackPlan {
  /** Migrations to undo, newest first. */
  readonly undo: readonly Migration[];
  /** The ones that would remain applied afterwards. */
  readonly keep: readonly Migration[];
}

export interface RollbackResult {
  /** Which connection was rolled back (`MIG-015`). */
  readonly connection: string;
  readonly undone: readonly string[];
  readonly locked: boolean;
  /** See `MigrateResult.lockVerified` — same meaning, same `DB-018` scope. */
  readonly lockVerified: boolean;
  readonly durationMs: number;
}

/** The only thing a plan needs from `__drizzle_migrations`: which `when`s ran. */
export interface AppliedWhen {
  readonly createdAt: number;
}

/**
 * Chooses what to undo. Pure, so the guards can be tested without a database.
 *
 * `applied` is the set of rows in `__drizzle_migrations`: rolling back a migration
 * that was never applied would run DDL against a schema that does not have it, so
 * only applied files are candidates. A row with no file cannot be undone at all —
 * there is no down SQL to run — and is left to `migrate:status` to report as an
 * orphan.
 */
export function planRollback(
  folder: readonly Migration[],
  applied: readonly AppliedWhen[],
  to: string,
): RollbackPlan {
  if (to !== EMPTY_TARGET && !folder.some((file) => file.tag === to)) {
    throw new TsirError('DB_ROLLBACK_UNKNOWN_TARGET', `no migration named "${to}" in the journal`, {
      kind: 'database',
      hint: `known tags: ${folder.map((file) => file.tag).join(', ') || '(none)'} — or pass \`${EMPTY_TARGET}\``,
      context: { to },
    });
  }

  const boundary =
    to === EMPTY_TARGET
      ? Number.NEGATIVE_INFINITY
      : (folder.find((file) => file.tag === to)?.when ?? 0);
  const ran = new Set(applied.map((row) => row.createdAt));
  const candidates = folder.filter((file) => ran.has(file.when));

  return {
    undo: candidates.filter((file) => file.when > boundary).reverse(),
    keep: candidates.filter((file) => file.when <= boundary),
  };
}

export async function rollback(options: RollbackOptions): Promise<RollbackResult> {
  const { database } = options;
  const now = options.now ?? (() => Date.now());
  const started = now();
  const log = options.log ?? (() => undefined);

  const { migrations } = await readMigrationFolder(options.folder);
  let applied;
  try {
    applied = await readApplied(database, options.tables ?? {});
  } catch (error: unknown) {
    if (isMissingTable(error)) applied = [];
    else throw error;
  }

  const target = planRollback(migrations, applied, options.to);

  if (target.undo.length === 0) {
    log('nothing to roll back');
    return {
      connection: database.name,
      undone: [],
      locked: false,
      lockVerified: !lockPossible(database) || database.capabilities.pinnedConnection,
      durationMs: now() - started,
    };
  }

  // Refuse obviously unsafe plans before waiting on a lock. Re-check under the lock below.
  guardRollback(target.undo, options);

  // Same `DB-018` rule as `migrate`: a session-scoped lock only excludes another
  // runner if the DDL runs on the session that holds it.
  if (database.capabilities.pinnedConnection) {
    return database.pinned((scope) => undoAll(options, scope, started, true));
  }
  return undoAll(options, database, started, false);
}

function guardRollback(undo: readonly Migration[], options: RollbackOptions): void {
  if (undo.length === 0) return;
  const missing = undo.filter((file) => file.downSql === undefined);
  if (missing.length > 0) {
    throw new TsirError(
      'DB_ROLLBACK_UNSAFE',
      `no down migration for ${missing.map((file) => file.tag).join(', ')}`,
      {
        kind: 'database',
        hint:
          'drizzle-kit does not generate down migrations; write `<tag>.down.sql` beside the migration, ' +
          'or write the reversal by hand and document it. Tsir will not invent one',
        context: { tag: missing[0]?.tag ?? '' },
      },
    );
  }

  const newest = undo[0]?.tag ?? '';
  if (options.allowDestructive !== true) {
    throw new TsirError('DB_ROLLBACK_DESTRUCTIVE', `rollback to "${options.to}" destroys data`, {
      kind: 'database',
      hint: `re-run with --allow-destructive --confirm ${newest} once you have read the migration runbook`,
      context: { to: options.to },
    });
  }
  if (options.confirm !== newest) {
    throw new TsirError(
      'DB_ROLLBACK_DESTRUCTIVE',
      `confirmation "${options.confirm ?? ''}" does not match "${newest}"`,
      {
        kind: 'database',
        hint: `type the newest migration being undone: --confirm ${newest}`,
        context: { to: options.to },
      },
    );
  }
}

function lockPossible(database: Database): boolean {
  return database.capabilities.engine === 'postgres';
}

/** Takes the lock, runs each down file newest-first, removes its journal row. */
async function undoAll(
  options: RollbackOptions,
  database: Database,
  started: number,
  canVerifyLock: boolean,
): Promise<RollbackResult> {
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => undefined);

  const lock = await acquireMigrationLock(database, {
    connection: database.name,
    name: options.name,
    ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }),
  });
  const lockVerified = lock.supported ? canVerifyLock : true;

  if (!lock.acquired) {
    log('another migration is in progress');
    return {
      connection: database.name,
      undone: [],
      locked: true,
      lockVerified,
      durationMs: now() - started,
    };
  }

  try {
    // A different runner may have changed the journal while this runner waited.
    const { migrations } = await readMigrationFolder(options.folder);
    let applied;
    try {
      applied = await readApplied(database, options.tables ?? {});
    } catch (error: unknown) {
      if (isMissingTable(error)) applied = [];
      else throw error;
    }
    const current = planRollback(migrations, applied, options.to);
    guardRollback(current.undo, options);
    const engine = database.capabilities.engine;
    const undone: string[] = [];

    for (const file of current.undo) {
      const statements = splitStatements(file.downSql ?? '');
      const remove = deleteAppliedStatement(engine, file.when, options.tables ?? {});

      if (database.capabilities.interactiveTx) {
        await database.interactiveTx(async (tx) => {
          for (const sql of statements) await tx.query(statement(sql));
          await tx.query(statement(remove.sql, remove.params));
        });
      } else {
        // D1: one batch, one implicit transaction — the down statements and the
        // journal delete either both happen or neither does.
        await database.batch([
          ...statements.map((sql) => statement(sql)),
          statement(remove.sql, remove.params),
        ]);
      }

      undone.push(file.tag);
      log(`rolled back ${file.tag}`);
    }

    return {
      connection: database.name,
      undone,
      locked: false,
      lockVerified,
      durationMs: now() - started,
    };
  } finally {
    await lock.release();
  }
}

/** Exported for the CLI: a rollback plan is also what `--dry-run` prints. */
export function describeRollback(planValue: RollbackPlan): string {
  if (planValue.undo.length === 0) return 'nothing to roll back';
  return `would undo ${planValue.undo.map((file) => file.tag).join(', ')}`;
}
