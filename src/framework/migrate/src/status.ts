/**
 * `migrate:status` (`MIG-005`, `MIG-008`).
 *
 * Status is where drift becomes visible *before* a deploy, so it reports four
 * things and exits non-zero for the two that are wrong: drift (an applied file
 * changed) and orphans (an applied row with no file). Pending migrations are not
 * an error — they are the point of running `migrate` next.
 */

import type { Database } from '@tsir/database';

import { readMigrationFolder } from './journal.ts';
import { planMigrations, type MigrationPlan } from './plan.ts';
import {
  isMissingTable,
  readApplied,
  readRuns,
  type MigrationRun,
  type TableNames,
} from './state.ts';

export interface StatusOptions {
  readonly folder: string;
  readonly tables?: TableNames;
  /** How many audit rows to include; `0` skips the query entirely. */
  readonly runs?: number;
}

export interface MigrationStatus {
  /** Which connection was inspected (`MIG-015`). */
  readonly connection: string;
  readonly plan: MigrationPlan;
  /** True when the journal has never been applied to this database. */
  readonly fresh: boolean;
  readonly tags: {
    readonly applied: readonly string[];
    readonly pending: readonly string[];
    readonly drifted: readonly string[];
    readonly orphaned: readonly string[];
  };
  readonly runs: readonly MigrationRun[];
}

export async function migrationStatus(
  database: Database,
  options: StatusOptions,
): Promise<MigrationStatus> {
  const { migrations } = await readMigrationFolder(options.folder);

  let applied;
  try {
    applied = await readApplied(database, options.tables ?? {});
  } catch (error: unknown) {
    // A database with no journal table is fresh, not broken.
    if (isMissingTable(error)) applied = [];
    else throw error;
  }

  const planned = planMigrations(migrations, applied);
  const runs =
    (options.runs ?? 0) > 0 ? await readRuns(database, options.tables ?? {}, options.runs) : [];

  return {
    connection: database.name,
    plan: planned,
    fresh: applied.length === 0,
    tags: {
      applied: planned.applied.map((file) => file.tag),
      pending: planned.pending.map((file) => file.tag),
      drifted: planned.drifted.map((entry) => entry.file.tag),
      orphaned: planned.orphans.map((row) => String(row.createdAt)),
    },
    runs,
  };
}

/**
 * One line for the CLI and the logs: `3 applied · 1 pending`.
 *
 * Counts always print, including zeroes, so two consecutive lines can be diffed;
 * the two *broken* states only appear when they are non-empty, because
 * `0 drifted` in a log is noise that trains people to skim.
 */
export function describeStatus(status: MigrationStatus): string {
  const parts = [
    `${String(status.tags.applied.length)} applied`,
    `${String(status.tags.pending.length)} pending`,
  ];
  if (status.tags.drifted.length > 0) {
    parts.push(`${String(status.tags.drifted.length)} drifted`);
  }
  if (status.tags.orphaned.length > 0) {
    parts.push(`${String(status.tags.orphaned.length)} orphaned`);
  }
  return parts.join(' · ');
}

/** Non-zero when anything is *wrong*, as opposed to merely pending. */
export function statusIsHealthy(status: MigrationStatus): boolean {
  return status.tags.drifted.length === 0 && status.tags.orphaned.length === 0;
}
