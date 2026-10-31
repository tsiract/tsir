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

export interface TaskDefinition {
  /** Unique in a project; the lock key and the `tsir schedule:run` argument. */
  readonly name: string;
  /** The canonical five-field form, after macros are expanded. */
  readonly cron: string;
  readonly spec: CronSpec;
  /** Fixed offset from UTC, in minutes. `480` is UTC+8. Default `0` (UTC). */
  readonly utcOffsetMinutes: number;
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
  handle(context: TaskContext): Promise<void> | void;
  readonly description?: string | undefined;
}

export const TASK_DEFAULTS = { timeoutMs: 300_000, overlap: 'skip', utcOffsetMinutes: 0 } as const;

const TASK_NAME = /^[a-z][a-z0-9]*([-.:][a-z0-9]+)*$/u;

export interface DefineTaskInput {
  readonly name: string;
  readonly cron: string;
  readonly utcOffsetMinutes?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly overlap?: 'skip' | 'allow' | undefined;
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

  const spec = parseCron(input.cron, { utcOffsetMinutes, origin: `task "${input.name}"` });

  return {
    name: input.name,
    cron: spec.expression,
    spec,
    utcOffsetMinutes,
    timeoutMs,
    overlap: input.overlap ?? TASK_DEFAULTS.overlap,
    ...(input.description === undefined ? {} : { description: input.description }),
    // Wrapped, not assigned by reference: `handle` is a method on the object the caller wrote,
    // and a method separated from its object loses its `this` (`unbound-method`).
    handle: (context) => input.handle(context),
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
