/**
 * One-call scheduler bootstrap for apps that use `@tsir/schedule`.
 *
 * Replaces the hand-written `modules/system/services/schedule.ts` every app
 * previously needed: it builds the scheduler from the app's task definitions,
 * exposes the `scheduler`, and creates the DI token + value provider the rest
 * of the app wires into its modules.
 *
 * Tasks and the lock provider are app-specific, so the app passes them in.
 * Use `memoryLock()` for dev and `databaseLock(...)` for production.
 */

import { token, valueProvider, type Provider, type Token } from '@tsir/container';

import { createScheduler, type CreateSchedulerOptions, type Scheduler } from './scheduler.ts';
import type { LockProvider } from './lock.ts';
import type { TaskDefinition } from './task.ts';

/** Options for `createScheduleBootstrap`. */
export interface ScheduleBootstrapOptions {
  /** The app's task definitions. */
  readonly tasks: readonly TaskDefinition[];
  /** The lock provider — `memoryLock()` for dev, `databaseLock(...)` for prod. */
  readonly lock: LockProvider;
  /** Where run-time logs go. Defaults to discarding them. */
  readonly log?: (message: string) => void;
  /** Refuse a per-process lock in production when tasks rely on overlap prevention. */
  readonly production?: boolean;
  readonly now?: CreateSchedulerOptions['now'];
  readonly newOwner?: CreateSchedulerOptions['newOwner'];
  readonly onError?: CreateSchedulerOptions['onError'];
  readonly graceMs?: CreateSchedulerOptions['graceMs'];
  /**
   * When it returns true, cron-triggered tasks are skipped unless they declare
   * `evenInMaintenanceMode: true`. Wire this to your app's maintenance-mode flag.
   */
  readonly isMaintenanceMode?: CreateSchedulerOptions['isMaintenanceMode'];
}

/** Everything an app needs to wire its scheduler. */
export interface ScheduleBootstrap {
  /** The scheduler. */
  readonly scheduler: Scheduler;
  /** DI token for `scheduler`. */
  readonly schedulerToken: Token<Scheduler>;
  /** Value provider for `scheduler`. */
  readonly schedulerProvider: Provider<Scheduler>;
}

/**
 * Build the scheduler from task definitions.
 *
 * ```ts
 * import { createScheduleBootstrap, defineTask, memoryLock } from '@tsir/schedule';
 *
 * const cleanup = defineTask({
 *   name: 'cleanup.stale-sessions',
 *   cron: '0 3 * * *',
 *   handle(context) { context.log(`run ${context.scheduledFor}`); },
 * });
 *
 * export const { scheduler, schedulerToken, schedulerProvider } = createScheduleBootstrap({
 *   tasks: [cleanup],
 *   lock: memoryLock(),
 * });
 * ```
 */
export function createScheduleBootstrap(options: ScheduleBootstrapOptions): ScheduleBootstrap {
  const scheduler = createScheduler({
    tasks: options.tasks,
    lock: options.lock,
    log: options.log,
    production: options.production,
    now: options.now,
    newOwner: options.newOwner,
    onError: options.onError,
    graceMs: options.graceMs,
    ...(options.isMaintenanceMode === undefined
      ? {}
      : { isMaintenanceMode: options.isMaintenanceMode }),
  });

  const schedulerToken = token<Scheduler>('scheduler');
  const schedulerProvider = valueProvider(schedulerToken, scheduler);

  return { scheduler, schedulerToken, schedulerProvider };
}
