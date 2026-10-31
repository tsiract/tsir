/**
 * @tsir/schedule — cron tasks with overlap prevention (`§ 4.6`).
 *
 * Public surface:
 *   defineTask, createTaskRegistry, createScheduler, memoryLock, databaseLock,
 *   scheduleLockDdl, parseCron, matchesCron, nextRunAt
 *
 * A task is a name, a five-field cron and a handler. The trigger is the platform's — a
 * `scheduled` handler on Workers, an EventBridge rule on Lambda, `tsir schedule:work` on Bun — and
 * the scheduler is the part that is the same on all three: which tasks a tick owns, whether the
 * previous run is still going, and what to report when one fails.
 *
 * What this package deliberately does not do: infer a task's schedule from how it is written
 * (a cron is declared), retry a failed run (a cron's retry *is* the next tick), follow the host's
 * time zone (crons are UTC unless the task declares a fixed offset), or pretend a per-process lock
 * prevents overlap across isolates (it says `shared: false`, and production refuses it).
 */

export {
  CRON_FIELDS,
  isValidCron,
  matchesCron,
  nextRunAt,
  nextRuns,
  toUtcCron,
  parseCron,
} from './cron.ts';
export type { CronSpec, ParseCronOptions } from './cron.ts';

export { createTaskRegistry, defineTask, TASK_DEFAULTS } from './task.ts';
export type { DefineTaskInput, TaskContext, TaskDefinition, TaskRegistry } from './task.ts';

export { createScheduler } from './scheduler.ts';
export type {
  CreateSchedulerOptions,
  RunStatus,
  Scheduler,
  TaskOutcome,
  TaskStatus,
} from './scheduler.ts';

export { databaseLock, memoryLock, scheduleLockDdl } from './lock.ts';
export type {
  DatabaseLockOptions,
  LockCapabilities,
  LockHandle,
  LockProvider,
  LockSql,
  LockSqlResult,
  LockSqlStatement,
} from './lock.ts';

export type { ScheduleErrorCode } from './errors.ts';
