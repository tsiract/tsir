/**
 * @tsir/migrate — applying Drizzle journals without losing the database.
 *
 * Three decisions shape this package:
 *
 * 1. **Drizzle's journal stays authoritative** (ADR-0007). Same `meta/_journal.json`,
 *    same `__drizzle_migrations` rows, same `when` keys — Tsir adds checksums,
 *    transaction policy, locking and an audit sidecar, and never a second journal.
 * 2. **Refusal before damage.** Drift is detected before the first write, an empty
 *    migration file is refused rather than marked applied, a rollback without a
 *    down file is refused before the first DROP, and a D1 deployment is told it has
 *    no advisory lock instead of being given a fake one.
 * 3. **Honest results.** Every apply reports what happened per migration,
 *    including `atomic: false` for a `tsir:transaction=off` file and
 *    `lockVerified: false` when the client could not pin the connection the lock
 *    was taken on — so a partially applied schema, or a lock that excludes
 *    nothing, is never mistaken for a safe one.
 *
 * Module map: `journal` reads files, `plan` decides, `state` is the SQL of the two
 * tables, `lock` is the advisory lock, `migrate`/`rollback`/`status` are the verbs,
 * and `guidance` is the pre-flight text.
 */

export {
  checksum,
  JournalError,
  parseJournal,
  parseTransactionPolicy,
  readMigrationFolder,
  splitStatements,
} from './journal.ts';
export { JOURNAL_PATH } from './journal.ts';
export type {
  Journal,
  JournalEntry,
  Migration,
  MigrationFile,
  MigrationFolder,
  TransactionPolicy,
} from './journal.ts';

export { isApplicable, planMigrations } from './plan.ts';
export type { AppliedMigration, DriftedMigration, MigrationPlan } from './plan.ts';

export { AUDIT_TABLE, JOURNAL_TABLE, migrationEngine, readRuns } from './state.ts';
export type { MigrationRun, TableNames } from './state.ts';

export { acquireMigrationLock, advisoryLockKey, lockHeldMessage, lockUnsupported } from './lock.ts';
export { isDefaultMigrationFolder, migrationFolder } from './paths.ts';
export type { MigrationPathOptions } from './paths.ts';
export type { LockHandle } from './lock.ts';

export { driftError, migrate, readAppliedOrEmpty } from './migrate.ts';
export type { AppliedOne, MigrateOptions, MigrateResult } from './migrate.ts';

export { describeStatus, migrationStatus, statusIsHealthy } from './status.ts';
export type { MigrationStatus, StatusOptions } from './status.ts';

export { describeRollback, EMPTY_TARGET, planRollback, rollback } from './rollback.ts';
export type { AppliedWhen, RollbackOptions, RollbackPlan, RollbackResult } from './rollback.ts';

export { preflightGuidance, RUNBOOK } from './guidance.ts';
export type { GuidanceInput } from './guidance.ts';
