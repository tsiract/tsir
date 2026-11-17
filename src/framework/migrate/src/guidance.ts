/**
 * Pre-flight guidance (`MIG-011`).
 *
 * Printed by every migration command that runs against a production database.
 * This is not decoration: the expensive migration failures are not SQL errors,
 * they are a missing snapshot, a lock taken on a hot table during peak traffic,
 * and a rollback plan that was never written because the forward path "obviously
 * worked". The text names all three before the first statement runs.
 */

export const RUNBOOK = 'src/docs/migrations.md';

export interface GuidanceInput {
  readonly engine: 'd1' | 'postgres' | 'sqlite';
  /** Where the migration is running: `production` prints the checklist. */
  readonly environment: string;
  readonly pending: number;
  /** Statements that cannot run in a transaction (`tsir:transaction=off`). */
  readonly nonTransactional?: readonly string[];
}

export function preflightGuidance(input: GuidanceInput): readonly string[] {
  if (input.environment !== 'production') return [];

  const lines = [
    `pre-flight: ${String(input.pending)} migration(s) about to run against production`,
    '  1. snapshot or PITR window verified, and a restore has been tried before (not just enabled)',
    '  2. lock impact: a migration that rewrites a hot table holds locks for its whole duration',
    '  3. rollback plan: which `--to` target, and whether it is destructive',
  ];

  if (input.engine === 'postgres') {
    lines.push(
      '  4. one runner only — the advisory lock covers this, but a manual `psql` session does not',
    );
  } else {
    lines.push('  4. D1 has no advisory lock: run this from the migrate unit only');
  }

  if ((input.nonTransactional ?? []).length > 0) {
    lines.push(
      `  ! non-atomic: ${input.nonTransactional?.join(', ') ?? ''} run with tsir:transaction=off — a failure leaves the schema between versions`,
    );
  }

  lines.push(`  runbook: ${RUNBOOK}`);
  return lines;
}
