/**
 * `schedule.lock` in `tsir.js` — the registry half of the scheduler lock (`CAP-006`).
 *
 * The schema in `@tsir/config` and the zod block in the console both accept a
 * `schedule.lock` section. Nothing read it, so the section validated and then did nothing: an app
 * could name `database`, get a `memoryLock` from its own entry module, and no one would notice
 * until two overlapping ticks ran the same job twice.
 *
 * ## What a lock is for, and why `memory` is refused in production
 *
 * A scheduler on two instances must run each task once. A `memoryLock` is a `Map`: each instance
 * holds its own, so both see the lock as free and both run the job. Payroll runs twice, the digest
 * goes out twice. `memoryLock` is right for `tsir dev` — one process, no table, no migration — and
 * wrong for anything with more than one instance.
 *
 * `database` is the durable one, and it is also the picky one: its acquire is a single upsert whose
 * `WHERE` decides whether an existing lock has expired, and MySQL's `ON DUPLICATE KEY UPDATE` has
 * no `WHERE`. `databaseLock` refuses that engine rather than taking a live lock — which is why the
 * refusal happens at construction and not on the first tick.
 */

import { TsirError } from '@tsir/container';

import { databaseLock, memoryLock, type LockProvider, type LockSql } from './lock.ts';

/** Every lock driver this build ships, in the order an error message lists them. */
export const LOCK_DRIVERS = ['database', 'memory'] as const;

/** The drivers that agree across processes. */
export const PERSISTENT_LOCK_DRIVERS: readonly string[] = ['database'];

/** One `schedule.lock` entry, as configuration sees it. */
export interface ConfiguredLock {
  /**
   * As written in `tsir.js`. Typed `string`, not the union: an unknown name must fail with a
   * message that lists the real ones.
   */
  readonly driver: string;
  /** The table a `database` lock reads. Default `schedule_locks`. */
  readonly table?: string | undefined;
  /** The connection name an app resolves for a `database` lock. Informational here. */
  readonly connection?: string | undefined;
}

export interface LockBuildOptions {
  readonly lock: ConfiguredLock | undefined;
  /** The SQL port a `database` lock reads through. */
  readonly sql?: LockSql | undefined;
  /** `isProduction()` from `@tsir/core`. Opt-in, so a test can build what it wants. */
  readonly production?: boolean | undefined;
  readonly now?: (() => number) | undefined;
}

/**
 * The lock the project names, or `undefined` when it declares none.
 *
 * `undefined` rather than a memory lock: an app that never configured a lock either has one
 * instance — in which case the scheduler's own default is fine and the app should say so — or has
 * several, in which case a `Map` is a duplicated job waiting to happen.
 */
export function lockFromConfig(options: LockBuildOptions): LockProvider | undefined {
  const config = options.lock;
  if (config === undefined) return undefined;

  switch (config.driver) {
    case 'memory':
      // `CAP-007`: the same guard every other capability has, in the one place it was missing.
      // Two instances, each with its own `Map`, both see the lock as free and both run the task.
      if (options.production === true) {
        throw new TsirError(
          'SCHED_LOCK_REFUSED',
          'the "memory" lock is held per process, so a task scheduled on two instances would run twice in production',
          {
            kind: 'capability',
            hint: 'use the `database` lock — a task that runs once needs one place to record that it did',
            context: { driver: 'memory' },
          },
        );
      }
      return memoryLock();
    case 'database': {
      if (options.sql === undefined) {
        throw new TsirError(
          'SCHED_LOCK_REFUSED',
          'the "database" lock needs a SQL connection, and none was supplied',
          {
            kind: 'capability',
            hint: "pass the app's connection, e.g. `sql: databases.defaultDatabase`",
            context: { driver: 'database' },
          },
        );
      }
      return databaseLock({
        sql: options.sql,
        ...(config.table === undefined ? {} : { table: config.table }),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    }
    default:
      throw new TsirError('SCHED_LOCK_REFUSED', `schedule.lock has no "${config.driver}" driver`, {
        kind: 'capability',
        hint: `this build ships: ${LOCK_DRIVERS.join(', ')}`,
        context: { driver: config.driver },
      });
  }
}
