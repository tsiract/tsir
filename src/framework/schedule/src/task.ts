/**
 * Tasks (`§ 4.6`).
 *
 * A task is **a name, a cron and a handler**, and the three defaults are the opinions:
 *
 *   · **overlap is prevented, by default.** A task that takes four minutes on a `*​/1` cron
 *     (every minute) is a task that stacks four copies by minute four. Skipping the overlap is
 *     almost always what was meant, so it is the default and `overlap: 'allow'` is the exception
 *     that has to be written down.
 *   · **a timeout is mandatory**, five minutes, because a cron has no request to time out and a
 *     hung task holds its lock until the TTL — which is the next task's problem, not this one's.
 *   · **the cron is parsed at declaration**, so a bad expression fails where it is written rather
 *     than at the first tick, when the only evidence is a task that never ran.
 */

import { parseCron, type CronSpec } from './cron.ts';

/** What a handler receives. Deliberately small: a cron is not a request. */
export interface TaskContext {
  readonly name: string;
  /** The tick this run belongs to — the cron's scheduled time, not when the run started. */
  readonly scheduledFor: number;
  readonly startedAt: number;
  /** `manual` when an operator ran it through `tsir schedule:run`. */
  readonly trigger: 'cron' | 'manual';
  /** Cooperative cancellation: fires on `timeoutMs` and when a caller aborts the run. */
  readonly signal: AbortSignal;
  log(message: string): void;
}

/**
 * Lifecycle hooks around a task run.
 *
 * `before` runs before the handler; if it throws, the handler is skipped and the run is a
 * failure carrying that error. `onSuccess` runs only after a clean handler; `onFailure` runs
 * only after a handler error or timeout (and receives the error). `after` always runs, after
 * the success/failure hook. Errors from `onSuccess`/`onFailure`/`after` are reported to the
 * observer but do not change the task's outcome — a hook that throws must not turn a successful
 * run into a failed one, or vice versa.
 */
export interface TaskHooks {
  readonly before?: ((context: TaskContext) => void | Promise<void>) | undefined;
  readonly after?: ((context: TaskContext) => void | Promise<void>) | undefined;
  readonly onSuccess?: ((context: TaskContext) => void | Promise<void>) | undefined;
  readonly onFailure?: ((context: TaskContext, error: unknown) => void | Promise<void>) | undefined;
}

export interface TaskDefinition extends TaskHooks {
  /** Unique in a project; the lock key and the `tsir schedule:run` argument. */
  readonly name: string;
  /** The canonical five-field form, after macros are expanded. */
  readonly cron: string;
  readonly spec: CronSpec;
  /** Fixed offset from UTC, in minutes. `480` is UTC+8. Default `0` (UTC). */
  readonly utcOffsetMinutes: number;
  /** IANA timezone, evaluated per tick. Overrides `utcOffsetMinutes` for matching. */
  readonly timezone?: string | undefined;
  /** Milliseconds before the run is cancelled and the lock released. Default 300 000. */
  readonly timeoutMs: number;
  /**
   * What a tick does when the previous run is still going:
   *
   *   · `skip` (default) — take the lock or do nothing. Overlap prevention;
   *   · `allow` — run anyway, with no lock. For a task that must not be skipped and is safe to
   *     run concurrently (a cache warm, an idempotent sweep).
   */
  readonly overlap: 'skip' | 'allow';
  /**
   * When true the scheduler starts the handler and returns immediately (`status: 'ran'`); the
   * handler runs to completion in the background, still holding the overlap lock and still
   * honouring `timeoutMs`. Errors from the background run are reported to the observer. Use for
   * a long task that would otherwise make `runDue` wait — the next tick sees the lock held and
   * skips, which is the point.
   */
  readonly runInBackground: boolean;
  /**
   * When false (default) the task is skipped while the app is in maintenance mode. Set true for
   * a task that must run regardless — a heartbeat, a cleanup of stale maintenance state.
   */
  readonly evenInMaintenanceMode: boolean;
  handle(context: TaskContext): Promise<void> | void;
  readonly description?: string | undefined;
}

export const TASK_DEFAULTS = {
  timeoutMs: 300_000,
  overlap: 'skip',
  utcOffsetMinutes: 0,
  runInBackground: false,
  evenInMaintenanceMode: false,
} as const;

const TASK_NAME = /^[a-z][a-z0-9]*([-.:][a-z0-9]+)*$/u;

export interface DefineTaskInput extends TaskHooks {
  readonly name: string;
  readonly cron: string;
  readonly utcOffsetMinutes?: number | undefined;
  readonly timezone?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly overlap?: 'skip' | 'allow' | undefined;
  readonly runInBackground?: boolean | undefined;
  readonly evenInMaintenanceMode?: boolean | undefined;
  readonly description?: string | undefined;
  handle(context: TaskContext): Promise<void> | void;
}

export function defineTask(input: DefineTaskInput): TaskDefinition {
  if (!TASK_NAME.test(input.name)) {
    throw new TypeError(
      `task name "${input.name}" is not a lowercase name (letters, digits, and \`- . :\` between ` +
        'words) — it is the lock key and the CLI argument, so a space or a capital becomes a ' +
        'task nobody can run',
    );
  }

  const utcOffsetMinutes = input.utcOffsetMinutes ?? TASK_DEFAULTS.utcOffsetMinutes;
  if (!Number.isInteger(utcOffsetMinutes) || Math.abs(utcOffsetMinutes) > 14 * 60) {
    throw new TypeError(
      `task "${input.name}" declares utcOffsetMinutes ${String(utcOffsetMinutes)}, which is not ` +
        'a whole number of minutes between -840 and 840',
    );
  }

  const timeoutMs = input.timeoutMs ?? TASK_DEFAULTS.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError(
      `task "${input.name}" declares timeoutMs ${String(timeoutMs)}, which is not a positive integer`,
    );
  }

  const spec = parseCron(input.cron, {
    utcOffsetMinutes,
    ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
    origin: `task "${input.name}"`,
  });

  // Hooks are wrapped, not assigned by reference: they are methods on the caller's object, and
  // a method separated from its object loses its `this` (`unbound-method`). Captured in locals
  // first so the wrapper can close over a definitely-defined function without a non-null
  // assertion.
  const before = input.before;
  const after = input.after;
  const onSuccess = input.onSuccess;
  const onFailure = input.onFailure;

  return {
    name: input.name,
    cron: spec.expression,
    spec,
    utcOffsetMinutes,
    ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
    timeoutMs,
    overlap: input.overlap ?? TASK_DEFAULTS.overlap,
    runInBackground: input.runInBackground ?? TASK_DEFAULTS.runInBackground,
    evenInMaintenanceMode: input.evenInMaintenanceMode ?? TASK_DEFAULTS.evenInMaintenanceMode,
    ...(input.description === undefined ? {} : { description: input.description }),
    // Wrapped, not assigned by reference: `handle` is a method on the object the caller wrote,
    // and a method separated from its object loses its `this` (`unbound-method`).
    handle: (context) => input.handle(context),
    ...(before === undefined ? {} : { before: (context) => before(context) }),
    ...(after === undefined ? {} : { after: (context) => after(context) }),
    ...(onSuccess === undefined ? {} : { onSuccess: (context) => onSuccess(context) }),
    ...(onFailure === undefined
      ? {}
      : { onFailure: (context, error) => onFailure(context, error) }),
  };
}

export interface TaskRegistry {
  readonly names: readonly string[];
  readonly tasks: readonly TaskDefinition[];
  get(name: string): TaskDefinition | undefined;
}

/** Creation-time duplicate check: a name is a lock key, so two of them share one lock silently. */
export function createTaskRegistry(tasks: readonly TaskDefinition[]): TaskRegistry {
  const byName = new Map<string, TaskDefinition>();
  for (const task of tasks) {
    if (byName.has(task.name)) {
      throw new TypeError(
        `two scheduled tasks are both named "${task.name}" — the name is the lock key, so they ` +
          'would share one lock and one `schedule:run` argument',
      );
    }
    byName.set(task.name, task);
  }

  return {
    names: [...byName.keys()],
    tasks: [...byName.values()],
    get: (name) => byName.get(name),
  };
}
