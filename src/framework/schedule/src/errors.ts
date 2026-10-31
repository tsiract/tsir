/**
 * Schedule errors (`§ 4.6`, `§ 8`).
 *
 * The one that carries the design opinion is `SCHED_LOCK_NOT_SHARED`: on Cloudflare a cron fires
 * in **every** isolate that holds the crons, and on Bun/Lambda a slow run can still be going when
 * the next tick arrives. A lock that lives in one process therefore does not prevent overlap — it
 * reports having prevented it, which is worse than not trying.
 *
 * Every message names the task (and the cron, where it helps), because "the scheduler failed" is
 * not an address.
 */

import { TsirError } from '@tsir/container';

export type ScheduleErrorCode =
  | 'SCHED_INVALID_CRON'
  | 'SCHED_DUPLICATE_TASK'
  | 'SCHED_UNKNOWN_TASK'
  | 'SCHED_TASK_FAILED'
  | 'SCHED_TASK_TIMEOUT'
  | 'SCHED_LOCK_NOT_SHARED'
  | 'SCHED_LOCK_REFUSED';

const KIND = 'capability';

export function duplicateTask(name: string): TsirError {
  return new TsirError('SCHED_DUPLICATE_TASK', `two scheduled tasks are both named "${name}"`, {
    kind: KIND,
    hint: 'the name is the lock key and the `tsir schedule:run` argument, so a duplicate is a task that can never be addressed on its own',
    context: { task: name },
  });
}

export function unknownTask(name: string, known: readonly string[]): TsirError {
  return new TsirError(
    'SCHED_UNKNOWN_TASK',
    `unknown scheduled task "${name}" (declared: ${known.length === 0 ? 'none' : known.join(', ')})`,
    {
      kind: KIND,
      hint: 'declare it with `defineTask` and export the list as `tasks` from the app entry',
      context: { task: name },
    },
  );
}

export function taskFailed(
  name: string,
  detail: string,
  options: { readonly scheduledFor: number; readonly durationMs: number },
): TsirError {
  return new TsirError('SCHED_TASK_FAILED', `scheduled task "${name}" failed: ${detail}`, {
    kind: KIND,
    // A cron has no retry to trigger: the next tick is the retry, which is why the failure is
    // reported to the caller *and* logged with the tick it belonged to.
    hint: 'the next tick is the retry — make the task idempotent, or dispatch a job if it needs backoff',
    context: { task: name, scheduledFor: options.scheduledFor, durationMs: options.durationMs },
  });
}

export function taskTimeout(name: string, timeoutMs: number): TsirError {
  return new TsirError(
    'SCHED_TASK_TIMEOUT',
    `scheduled task "${name}" did not finish within ${String(timeoutMs)} ms`,
    {
      kind: KIND,
      hint: 'the lock is released, so the next tick will try again — a task that needs longer than a tick should dispatch a job instead',
      context: { task: name, timeoutMs },
    },
  );
}

export function lockNotShared(provider: string, tasks: readonly string[]): TsirError {
  return new TsirError(
    'SCHED_LOCK_NOT_SHARED',
    `lock provider "${provider}" is per-process, but ${String(tasks.length)} scheduled task(s) rely on it for overlap prevention (${tasks.join(', ')})`,
    {
      kind: KIND,
      hint:
        'use `databaseLock({ sql })` in production — a cron fires in every isolate, so a per-process ' +
        'lock lets each of them run the same task. In development this is fine, which is why ' +
        '`production: true` is what refuses it',
      context: { provider, tasks: tasks.join(',') },
    },
  );
}

export function lockRefused(provider: string, detail: string): TsirError {
  return new TsirError('SCHED_LOCK_REFUSED', `lock provider "${provider}" refused: ${detail}`, {
    kind: KIND,
    hint: 'a lock that cannot prove it is exclusive is not a lock; use the `database` provider on this engine',
    context: { provider },
  });
}
