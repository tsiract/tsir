/**
 * The plan: what is applied, what is pending, what has drifted (`MIG-005`, `MIG-008`).
 *
 * Pure on purpose. Every decision about a migration — apply, skip, refuse — is
 * made here, from data, with no database handle in scope, so the interesting cases
 * (an edited migration, a row with no file, a file applied out of order) are unit
 * tests rather than staging accidents.
 *
 * The join key is `when`: Drizzle stores the journal entry's millisecond
 * timestamp as `created_at`, and that is the only durable link between a row in
 * `__drizzle_migrations` and a file on disk.
 */

import type { MigrationFile } from './journal.ts';

/**
 * One row of `__drizzle_migrations`.
 *
 * `hash` is `sha256(sql)` as Drizzle writes it. An empty hash means the row was
 * written by something that did not hash — `drizzle-kit migrate` on an older
 * version, or a hand-written insert — and an empty hash is *not* drift, because
 * there is nothing to compare it against.
 */
export interface AppliedMigration {
  readonly id?: number;
  readonly hash: string;
  readonly createdAt: number;
}

export interface DriftedMigration<M extends MigrationFile = MigrationFile> {
  readonly file: M;
  /** The digest recorded when the migration was applied. */
  readonly stored: string;
  /** The digest of the file as it is now. */
  readonly actual: string;
}

export interface MigrationPlan<M extends MigrationFile = MigrationFile> {
  /** Files with no applied row, in journal order. */
  readonly pending: readonly M[];
  /** Files whose `when` matches an applied row. */
  readonly applied: readonly M[];
  /** Applied migrations whose file no longer matches the digest that ran. */
  readonly drifted: readonly DriftedMigration<M>[];
  /** Applied rows with no matching journal entry — a file was deleted or never checked out. */
  readonly orphans: readonly AppliedMigration[];
}

/** Joins the journal against the database's applied rows. */
export function planMigrations<M extends MigrationFile>(
  migrations: readonly M[],
  applied: readonly AppliedMigration[],
): MigrationPlan<M> {
  const byWhen = new Map(applied.map((row) => [row.createdAt, row]));
  const pending: M[] = [];
  const done: M[] = [];
  const drifted: DriftedMigration<M>[] = [];

  for (const migration of migrations) {
    const row = byWhen.get(migration.when);
    if (row === undefined) {
      pending.push(migration);
      continue;
    }
    done.push(migration);
    // A mismatch means the file changed after it ran; the database and the
    // repository now disagree about what the schema is, and no amount of re-running
    // fixes that.
    if (row.hash !== '' && row.hash !== migration.checksum) {
      drifted.push({ file: migration, stored: row.hash, actual: migration.checksum });
    }
  }

  const known = new Set(migrations.map((migration) => migration.when));
  const orphans = applied.filter((row) => !known.has(row.createdAt));

  return { pending, applied: done, drifted, orphans };
}

/** True when the plan is safe to execute: nothing drifted. */
export function isApplicable(plan: MigrationPlan): boolean {
  return plan.drifted.length === 0;
}
