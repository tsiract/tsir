/**
 * Migration errors (`MIG-*`). The codes keep the `DB_` prefix: callers see one database family.
 *
 * The union is the registry: `bun src/tools/check-error-codes.ts` fails when a code is thrown
 * without being listed here, and when a listed code is removed from the baseline.
 */

export type MigrateErrorCode =
  | 'DB_MIGRATION_FAILED'
  | 'DB_MIGRATION_EMPTY'
  | 'DB_MIGRATION_DRIFT'
  | 'DB_MIGRATION_LOCK_UNSUPPORTED'
  | 'DB_ROLLBACK_UNKNOWN_TARGET'
  | 'DB_ROLLBACK_UNSAFE'
  | 'DB_ROLLBACK_DESTRUCTIVE'
  | 'DB_MIGRATION_ENGINE_UNSUPPORTED';
