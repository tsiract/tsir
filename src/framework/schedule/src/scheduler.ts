/**
 * The scheduler (`§ 4.6`): the tick, the lock, and the four ways a run can end.
 *
 * ```
 *   tick(at) ──▶ due tasks ──▶ acquire lock ──▶ handle() ──▶ release
 *                                   │
 *                                   └── held ──▶ skipped (overlap prevented)
 * ```
 *
 * Everything here follows from one fact: **a cron has no retry**. There is no dead-letter store
 * behind a scheduled task and no backoff between ticks — the next tick *is* the retry. So the
 * scheduler reports every outcome (never swallowing a failure), releases the lock on failure and
 * timeout (so the next tick can try), and keeps the TTL as the crash bound for the run that never
 * returned at all.
 *
 * `busy` is not a failure. It is the lock doing its job: the previous run of the same task is
 * still going, so this tick has nothing to do. It is reported separately because "skipped because
 * it was still running" and "ran and failed" are different pages in an on-call rotation.
 *
 * **Duplicated ticks are possible and are not hidden.** A platform that retries an invocation,
 * or two isolates racing a lock that expires between them, can run one task twice for one tick;
 * the lock prevents *overlap*, not duplication. Tasks are expected to be idempotent, and the
 * `scheduledFor` in the context is the key to make them so.
 */

import { matchesCron, nextRunAt } from './cron.ts';
import { lockNotShared, taskFailed, taskTimeout, unknownTask } from './errors.ts';
import type { LockProvider } from './lock.ts';
import { createTaskRegistry, type TaskDefinition, type TaskRegistry } from './task.ts';

export type RunStatus = 'ran' | 'failed' | 'timeout' | 'busy' | 'skipped';

export interface TaskOutcome {
  readonly task: string;
  readonly status: RunStatus;
  /** The tick this run belongs to: the cron's scheduled time, or `at` for a manual run. */
  readonly scheduledFor: number;
  readonly trigger: 'cron' | 'manual';
  readonly durationMs: number;
  /** Set for `failed` and `timeout`. */
  readonly error?: string | undefined;
}

/** What `tsir schedule:list` prints, per task. */
export interface TaskStatus {
  readonly name: string;
  readonly cron: string;
  readonly utcOffsetMinutes: number;
  readonly timezone?: string | undefined;
  readonly overlap: 'skip' | 'allow';
  readonly nextRunAt: number | undefined;
  readonly lockedBy: string | undefined;
  readonly lockedUntil: number | undefined;
  readonly description: string | undefined;
}

export interface CreateSchedulerOptions {
  readonly tasks: readonly TaskDefinition[];
  readonly lock: LockProvider;
  readonly now?: (() => number) | undefined;
  /** Owner ids for lock handles. Injectable so a test can name the run it expects. */
  readonly newOwner?: (() => string) | undefined;
  readonly log?: ((message: string) => void) | undefined;
  /** Reported for `failed`/`timeout` as well as logged — the seam an observer wires into. */
  readonly onError?: ((error: unknown, outcome: TaskOutcome) => void) | undefined;
  /**
   * Refuse a per-process lock (`SCHED_LOCK_NOT_SHARED`) when any task relies on overlap
   * prevention. A cron fires in every isolate, so a per-process lock does not prevent overlap —
   * it reports having prevented it, which is worse than not trying.
   */
  readonly production?: boolean | undefined;
  /** Added to a task's timeout to get its lock TTL. Default 60 000 ms. */
  readonly graceMs?: number | undefined;
  /**
   * When it returns true, cron-triggered tasks are skipped unless they declare
   * `evenInMaintenanceMode: true`. Manual runs always run. A task skipped this way is reported
   * as `status: 'skipped'` so an observer can tell "did not run" from "ran" and "failed".
   */
  readonly isMaintenanceMode?: (() => boolean | Promise<boolean>) | undefined;
}

export interface Scheduler {
  readonly names: readonly string[];
  /** Tasks whose cron fires at `at`, in declaration order. */
  due(at: number): readonly TaskDefinition[];
  /** Run one task now. `force` runs it without the lock — the operator's escape hatch. */
  run(
    name: string,
    options?: {
      readonly at?: number | undefined;
      readonly force?: boolean | undefined;
      readonly signal?: AbortSignal | undefined;
    },
  ): Promise<TaskOutcome>;
  /** Run everything due at `at`. One task failing never stops the others. */
  runDue(
    at: number,
    options?: { readonly signal?: AbortSignal | undefined },
  ): Promise<readonly TaskOutcome[]>;
  /** The `scheduled` handler shape both deploy adapters hand a unit. */
  scheduled(input: {
    readonly at: number;
    readonly signal?: AbortSignal | undefined;
  }): Promise<readonly TaskOutcome[]>;
  /** What `schedule:list` prints: the cron, the next run, and who holds the lock. */
  describe(at: number): Promise<readonly TaskStatus[]>;
  /** The registry, for a caller that wants `due()` without the runner. */
  readonly registry: TaskRegistry;
}

const silence = (): void => undefined;

export function createScheduler(options: CreateSchedulerOptions): Scheduler {
  const registry = createTaskRegistry(options.tasks);
  const now = options.now ?? ((): number => Date.now());
  const newOwner = options.newOwner ?? ((): string => crypto.randomUUID());
  const graceMs = options.graceMs ?? 60_000;
  const log = options.log ?? silence;

  if (options.production === true && !options.lock.capabilities.shared) {
    const locked = registry.tasks
      .filter((task) => task.overlap === 'skip')
      .map((task) => task.name);
    if (locked.length > 0) throw lockNotShared(options.lock.name, locked);
  }

  // The one implementation of "does it fire now", shared with the CLI and the lock-free path:
  // two copies of this rule is how `schedule:list` and the tick start disagreeing.
  const dueTasks = (at: number): readonly TaskDefinition[] =>
    registry.tasks.filter((task) => matchesCron(task.spec, at));

  async function runOne(
    task: TaskDefinition,
    run: {
      readonly at: number;
      readonly trigger: 'cron' | 'manual';
      readonly force: boolean;
      readonly signal?: AbortSignal | undefined;
    },
  ): Promise<TaskOutcome> {
    const startedAt = now();
    const base = {
      task: task.name,
      scheduledFor: run.at,
      trigger: run.trigger,
      durationMs: 0,
    } as const;

    // Maintenance mode only gates cron ticks: an operator running `schedule:run` explicitly
    // asked for the task, so it runs regardless. A skipped tick is reported, not swallowed —
    // "did not run because the app is down for maintenance" is a different page from "failed".
    if (run.trigger === 'cron' && !task.evenInMaintenanceMode) {
      const down =
        options.isMaintenanceMode === undefined ? false : await options.isMaintenanceMode();
      if (down) {
        log(`  ${task.name}: skipped — maintenance mode is on`);
        return { ...base, status: 'skipped', durationMs: 0 };
      }
    }

    const owner = newOwner();

    // `allow` tasks take no lock at all: taking one and releasing it immediately would only hide
    // that two copies can run at once, which is what the declaration asks for.
    let handle: { readonly expiresAt: number } | undefined;
    if (!run.force && task.overlap === 'skip') {
      handle = await options.lock.acquire({
        name: task.name,
        owner,
        // The TTL is the crash bound: a run cannot outlive its timeout by more than the timer
        // and the grace, so a dead process frees the name without an operator.
        ttlMs: task.timeoutMs + graceMs,
        now: startedAt,
      });
      if (handle === undefined) {
        const holder = await options.lock.inspect(task.name, startedAt);
        log(`  ${task.name}: still running (${holder?.owner ?? 'unknown'}) — this tick is skipped`);
        return { ...base, status: 'busy', durationMs: 0 };
      }
    }

    // A background run holds the lock until the handler finishes, but `runDue` does not wait
    // for it: the next tick sees the lock and skips, which is the whole point. Errors are still
    // reported to the observer, just asynchronously.
    if (task.runInBackground) {
      void executeTask(task, run, { startedAt, owner, handle }).catch((error: unknown) => {
        // `executeTask` reports its own errors through `onError`; a rejection here would be a
        // bug in the error-reporting path itself, so surface it rather than silently drop it.
        const detail = error instanceof Error ? error.message : String(error);
        log(`  ${task.name}: background run error-reporting failed — ${detail}`);
      });
      return { ...base, status: 'ran', durationMs: 0 };
    }

    return executeTask(task, run, { startedAt, owner, handle });
  }

  /**
   * The body of a run: hooks, the handler, the timeout, and the lock release.
   *
   * Shared by the foreground and background paths so a background run has exactly the same
   * semantics as a foreground one — same timeout, same hooks, same lock release — the only
   * difference is that the caller does not `await` it.
   */
  async function executeTask(
    task: TaskDefinition,
    run: {
      readonly at: number;
      readonly trigger: 'cron' | 'manual';
      readonly force: boolean;
      readonly signal?: AbortSignal | undefined;
    },
    state: {
      readonly startedAt: number;
      readonly owner: string;
      readonly handle: { readonly expiresAt: number } | undefined;
    },
  ): Promise<TaskOutcome> {
    const { startedAt, owner, handle } = state;
    const base = {
      task: task.name,
      scheduledFor: run.at,
      trigger: run.trigger,
      durationMs: 0,
    } as const;

    const controller = new AbortController();
    const abortFromCaller = (): void => {
      controller.abort(run.signal?.reason);
    };
    run.signal?.addEventListener('abort', abortFromCaller, { once: true });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(taskTimeout(task.name, task.timeoutMs));
        resolve('timeout');
      }, task.timeoutMs);
      // A pending timeout must not keep a CLI process alive for five minutes after it finished.
      (timer as { unref?: () => void }).unref?.();
    });

    const context = {
      name: task.name,
      scheduledFor: run.at,
      startedAt,
      trigger: run.trigger,
      signal: controller.signal,
      log: (message: string) => {
        log(`  ${task.name}: ${message}`);
      },
    };

    let outcome: TaskOutcome;
    try {
      // `before` runs first and can refuse the run by throwing: a precondition hook that fails
      // means the handler must not start, and the run is a failure carrying that error.
      await task.before?.(context);

      const result = await Promise.race([
        Promise.resolve(task.handle(context)).then(() => 'done' as const),
        timeout,
      ]);

      const durationMs = now() - startedAt;
      if (result === 'timeout') {
        outcome = {
          ...base,
          status: 'timeout',
          durationMs,
          error: `did not finish within ${String(task.timeoutMs)} ms`,
        };
        log(`  ${task.name}: timed out after ${String(task.timeoutMs)} ms`);
        options.onError?.(taskTimeout(task.name, task.timeoutMs), outcome);
        await runHook(task.onFailure, context, taskTimeout(task.name, task.timeoutMs));
      } else {
        outcome = { ...base, status: 'ran', durationMs };
        log(`  ${task.name}: ran in ${String(durationMs)} ms (${run.trigger})`);
        await runHook(task.onSuccess, context);
      }
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      const durationMs = now() - startedAt;
      outcome = { ...base, status: 'failed', durationMs, error: detail };
      log(`  ${task.name}: failed after ${String(durationMs)} ms — ${detail}`);
      options.onError?.(
        taskFailed(task.name, detail, { scheduledFor: run.at, durationMs }),
        outcome,
      );
      await runHook(task.onFailure, context, error);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      run.signal?.removeEventListener('abort', abortFromCaller);
      // `after` runs on every path — success, failure, timeout — after the success/failure hook.
      // It is for cleanup that must happen whether the run worked or not.
      await runHook(task.after, context);
      // Released on every path, including failure and timeout: the lock exists to stop *overlap*,
      // not to stop the next tick. A crash skips this and the TTL covers it.
      if (handle !== undefined) {
        await options.lock.release({ name: task.name, owner, now: now() });
      }
    }

    return outcome;
  }

  /**
   * Run a lifecycle hook, swallowing and reporting its errors.
   *
   * A hook must not change the task's outcome: a flaky `after` must not turn a successful run
   * into a failed one (and a flaky `onSuccess` must not hide a real failure). Hook errors go
   * to the observer and the log, and the run continues with whatever outcome it already had.
   */
  async function runHook(
    hook: ((...args: never[]) => void | Promise<void>) | undefined,
    context: { readonly name: string },
    ...args: unknown[]
  ): Promise<void> {
    if (hook === undefined) return;
    try {
      // `context` is always the first hook argument; `args` carries the rest (e.g. the error
      // for `onFailure`). Hooks are typed to accept `(context)` or `(context, error)`.
      await hook(context as never, ...(args as never[]));
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      log(`  ${context.name}: hook failed — ${detail}`);
    }
  }

  const runDue = async (
    at: number,
    runOptions: { readonly signal?: AbortSignal | undefined } = {},
  ): Promise<readonly TaskOutcome[]> => {
    const outcomes: TaskOutcome[] = [];
    for (const task of dueTasks(at)) {
      outcomes.push(
        await runOne(task, {
          at,
          trigger: 'cron',
          force: false,
          ...(runOptions.signal === undefined ? {} : { signal: runOptions.signal }),
        }),
      );
    }
    return outcomes;
  };

  return {
    names: registry.names,
    registry,

    due(at) {
      return dueTasks(at);
    },

    async run(name, runOptions = {}) {
      const task = registry.get(name);
      if (task === undefined) throw unknownTask(name, registry.names);
      const at = runOptions.at ?? now();
      return runOne(task, {
        at,
        trigger: 'manual',
        force: runOptions.force === true,
        ...(runOptions.signal === undefined ? {} : { signal: runOptions.signal }),
      });
    },

    runDue,

    scheduled(input) {
      // Nothing is caught here on purpose: `runDue` does not throw for a *task* failure (it
      // reports one), so what can still reject is the lock provider itself — which does need to
      // be visible, because a scheduler that cannot take a lock cannot prevent overlap.
      return runDue(input.at, {
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    },

    async describe(at) {
      const statuses: TaskStatus[] = [];
      for (const task of registry.tasks) {
        const lock =
          task.overlap === 'skip' ? await options.lock.inspect(task.name, at) : undefined;
        statuses.push({
          name: task.name,
          cron: task.cron,
          utcOffsetMinutes: task.utcOffsetMinutes,
          ...(task.timezone === undefined ? {} : { timezone: task.timezone }),
          overlap: task.overlap,
          nextRunAt: nextRunAt(task.spec, at),
          lockedBy: lock?.owner,
          lockedUntil: lock?.expiresAt,
          description: task.description,
        });
      }
      return statuses;
    },
  };
}
