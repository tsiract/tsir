/**
 * `tsir schedule:*` (`§ 4.6`, `SCHED-*`).
 *
 * Four commands, each the answer to a question asked with a terminal open:
 *
 *   · `schedule:list` — "what runs, when does it run next, and is it stuck?" One row per task,
 *     in declaration order, with the next fire time in UTC *and* in the task's own offset —
 *     because "03:00" and "19:00 UTC" are the same row read by two different people.
 *   · `schedule:run <name>` — "run it now." Refused while another run holds the lock, unless
 *     `--force`, which is the operator's escape hatch and says so.
 *   · `schedule:work` — "be the clock." One tick with `--once` (what a `scheduled` handler
 *     calls), or a loop that ticks on the minute until SIGTERM.
 *   · `schedule:table` — "what do I migrate?" The lock DDL, per engine.
 *
 * Where the registry comes from: the app entry's `tasks` export (`defineTask` list), and — like
 * `queue:*` — nothing else. A CLI that invented tasks would be a second declaration of the
 * schedule, and the first thing to drift. The lock comes from the entry's `lock` export when
 * there is one, otherwise `schedule.lock` in `tsir.js`, otherwise `memoryLock()` — which is
 * per-process, and `schedule:work` says so out loud because that is exactly the difference
 * between one tick and four on a platform with four isolates.
 */

import { pathToFileURL } from 'node:url';

import {
  createScheduler,
  memoryLock,
  databaseLock,
  scheduleLockDdl,
  type LockProvider,
  type Scheduler,
  type TaskDefinition,
  type TaskOutcome,
  type TaskStatus,
} from '@tsir/schedule';

import { boolFlag, parseArgs, stringFlag, type ParsedArgs } from '../args.ts';
import { EXIT, fail, info, style, UsageError, jsonDocument, symbols } from '../output.ts';
import { loadProject, type LoadedProject } from '../project.ts';
import { databasesFrom } from './queue.ts';

/**
 * Tasks are recognised by shape, not by a brand.
 *
 * An app that builds them with `defineTask` and exports the array is the contract; anything else
 * is a message rather than a crash inside a tick. `spec` is checked too: it is what the scheduler
 * matches against, and a task without one would silently never fire.
 */
function isTaskList(value: unknown): value is readonly TaskDefinition[] {
  return (
    Array.isArray(value) &&
    value.every((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null) return false;
      const candidate = entry as Record<string, unknown>;
      return (
        typeof candidate['name'] === 'string' &&
        typeof candidate['cron'] === 'string' &&
        typeof candidate['handle'] === 'function' &&
        typeof candidate['spec'] === 'object' &&
        candidate['spec'] !== null
      );
    })
  );
}

/**
 * The entry's tasks.
 *
 * Exported because `deploy:plan` needs the same list: the schedules a graph carries and the
 * tasks a worker runs are the same declaration read by two consumers, and reading it twice with
 * two implementations is how a project ends up deploying a unit whose cron nobody runs.
 */
export function tasksFrom(module: { readonly tasks?: unknown }): readonly TaskDefinition[] {
  return isTaskList(module.tasks) ? module.tasks : [];
}

/** A `LockProvider`, by shape: the port is four methods and a name. */
function isLock(value: unknown): value is LockProvider {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['name'] === 'string' &&
    typeof candidate['acquire'] === 'function' &&
    typeof candidate['release'] === 'function' &&
    typeof candidate['inspect'] === 'function'
  );
}

interface ResolvedSchedule {
  readonly scheduler: Scheduler;
  readonly lock: LockProvider;
  readonly tasks: readonly TaskDefinition[];
  readonly source: string;
  readonly lockSource: string;
}

/**
 * The lock the project declared, or the only one a CLI can honestly default to.
 *
 * `memory` is per-process, which on a laptop is exactly right and on Workers means every isolate
 * takes its own lock. The scheduler already refuses that combination under `production: true`
 * (`SCHED_LOCK_NOT_SHARED`); this resolver only has to say *which* lock it picked, so the
 * person reading the output knows whether "overlap is prevented" is a fact or a hope.
 */
async function resolveLock(
  project: LoadedProject,
): Promise<{ lock: LockProvider; source: string }> {
  if (isLock(project.exports['lock'])) {
    return { lock: project.exports['lock'], source: `${project.entryPath} (lock)` };
  }

  const declared = project.config.schedule?.lock;
  if (declared === undefined || declared.driver === 'memory') {
    return {
      lock: memoryLock(),
      source:
        declared === undefined
          ? 'memory (default — per process; declare `schedule.lock` for a shared one)'
          : `${project.configPath} (schedule.lock: memory)`,
    };
  }

  if (declared.driver !== 'database') {
    throw new UsageError(
      `unknown schedule lock driver "${declared.driver}"`,
      'the ones that exist are "memory" (per process) and "database" (d1, postgres) — or export a `lock` from the app entry',
    );
  }

  const connection = declared.connection ?? project.config.database?.default ?? 'default';
  const sql = databasesFrom(project.exports)[connection];
  if (sql === undefined) {
    throw new UsageError(
      `schedule.lock uses the database driver on connection "${connection}", which the app entry does not export`,
      'export `database` (the default connection) or `databases` (a `Connections` registry) from the entry — the lock queries the same client the app runs on',
    );
  }

  const table = declared.table;
  return {
    lock: databaseLock({ sql, ...(table === undefined ? {} : { table }) }),
    source: `${project.configPath} (schedule.lock: database · ${connection})`,
  };
}

async function resolveSchedule(
  project: LoadedProject,
  options: { readonly production?: boolean } = {},
): Promise<ResolvedSchedule> {
  const module = (await import(pathToFileURL(project.entryPath).href)) as {
    readonly tasks?: unknown;
  };
  const tasks = tasksFrom(module);
  if (tasks.length === 0) {
    throw new UsageError(
      'no tasks are declared',
      'export `tasks = [nightlyReport, …]` from the app entry, each built with `defineTask({ name, cron, handle })`',
    );
  }

  const { lock, source: lockSource } = await resolveLock(project);

  return {
    // Built once, here: `schedule:work --production` must fail before the first tick, not after
    // the first task that would have overlapped.
    scheduler: createScheduler({
      tasks,
      lock,
      ...(options.production === true ? { production: true } : {}),
    }),
    lock,
    tasks,
    source: project.entryPath,
    lockSource,
  };
}

/** An instant from `--at`: epoch milliseconds, or anything `Date.parse` reads. */
function atFlag(args: ParsedArgs): number | undefined {
  const value = stringFlag(args, '--at');
  if (value === undefined) return undefined;

  if (/^\d+$/u.test(value)) {
    // coercion-ok: a digit-only flag is an epoch in milliseconds, and the branch above is the
    // proof; `Number.isFinite` still rejects a value past `MAX_SAFE_INTEGER`.
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new UsageError(
      `--at "${value}" is not a time`,
      'pass epoch milliseconds or an ISO-8601 instant (`2026-11-01T19:00:00Z`)',
    );
  }
  return parsed;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/**
 * A local wall clock, from an instant and a fixed offset.
 *
 * Written out rather than formatting through `Date`, because `Date` would use the machine's zone
 * and this column is the *task's* zone — two different answers that look the same in a terminal.
 */
function wallClock(at: number | undefined, utcOffsetMinutes: number): string {
  if (at === undefined) return '—';
  const date = new Date(at + utcOffsetMinutes * 60_000);
  const hours = pad(Math.trunc(Math.abs(utcOffsetMinutes) / 60));
  const minutes = pad(Math.abs(utcOffsetMinutes) % 60);
  const off =
    utcOffsetMinutes === 0 ? 'UTC' : `UTC${utcOffsetMinutes > 0 ? '+' : '-'}${hours}:${minutes}`;
  return (
    `${String(date.getUTCFullYear())}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} ${off}`
  );
}

function describeOutcome(outcome: TaskOutcome): string {
  const detail = outcome.error === undefined ? '' : ` ${style.dim(outcome.error)}`;
  return `${String(outcome.durationMs)} ms${detail}`;
}

function statusJson(status: TaskStatus): Record<string, unknown> {
  return {
    name: status.name,
    cron: status.cron,
    utcOffsetMinutes: status.utcOffsetMinutes,
    ...(status.timezone === undefined ? {} : { timezone: status.timezone }),
    overlap: status.overlap,
    nextRunAt: status.nextRunAt === undefined ? null : new Date(status.nextRunAt).toISOString(),
    localNextRun:
      status.nextRunAt === undefined ? null : wallClock(status.nextRunAt, status.utcOffsetMinutes),
    lockedBy: status.lockedBy ?? null,
    lockedUntil:
      status.lockedUntil === undefined ? null : new Date(status.lockedUntil).toISOString(),
    description: status.description ?? null,
  };
}

// ─── schedule:list ──────────────────────────────────────────────────────────

export async function scheduleListCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--at': { type: 'string', description: 'where "next" starts (default: now)' },
    '--json': { type: 'boolean', description: 'machine-readable list' },
  });
  const json = boolFlag(args, '--json');

  try {
    const project = await loadProject(process.cwd());
    const { scheduler, tasks, lockSource } = await resolveSchedule(project);
    const at = atFlag(args) ?? Date.now();
    const statuses = await scheduler.describe(at);

    if (json) {
      info(
        jsonDocument({
          at: new Date(at).toISOString(),
          lock: lockSource,
          tasks: statuses.map(statusJson),
        }),
      );
      return EXIT.ok;
    }

    info(`  ${style.bold('schedule:list')} ${style.dim(`· ${lockSource}`)}`);
    info('');

    const width = Math.max(...statuses.map((status) => status.name.length), 4);
    for (const status of statuses) {
      const overlap =
        status.overlap === 'skip' ? style.dim('skip-on-overlap') : style.yellow('allow-overlap');
      info(`  ${style.bold(status.name.padEnd(width))}  ${status.cron}  ${overlap}`);
      const next = status.nextRunAt;
      info(
        `  ${' '.repeat(width)}  ${style.dim('next')} ${wallClock(next, status.utcOffsetMinutes)}` +
          (next === undefined ? '' : ` ${style.dim(`· ${new Date(next).toISOString()}`)}`),
      );
      if (status.lockedBy !== undefined) {
        info(
          `  ${' '.repeat(width)}  ${style.yellow('running')} ${status.lockedBy}` +
            (status.lockedUntil === undefined
              ? ''
              : ` ${style.dim(`until ${new Date(status.lockedUntil).toISOString()}`)}`),
        );
      }
      if (status.description !== undefined) {
        info(`  ${' '.repeat(width)}  ${style.dim(status.description)}`);
      }
    }
    info('');
    info(
      `  ${style.dim(
        `${String(tasks.length)} task(s) · run one with \`tsir schedule:run <name>\` · tick with \`tsir schedule:work --once\``,
      )}`,
    );
    return EXIT.ok;
  } catch (error: unknown) {
    return fail(error, json);
  }
}

// ─── schedule:run ───────────────────────────────────────────────────────────

export async function scheduleRunCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--force': {
      type: 'boolean',
      description: 'run even if another run holds the lock (does not release it)',
    },
    '--at': { type: 'string', description: 'the tick this run belongs to (default: now)' },
    '--json': { type: 'boolean', description: 'machine-readable result' },
  });
  const json = boolFlag(args, '--json');
  const name = args.positionals[0];

  if (name === undefined) {
    return fail(
      new UsageError(
        'schedule:run needs a task name',
        'list them with `tsir schedule:list` — running "everything" is `tsir schedule:work --once`',
      ),
      json,
    );
  }

  try {
    const project = await loadProject(process.cwd());
    const { scheduler, lockSource } = await resolveSchedule(project);
    const at = atFlag(args);
    const outcome = await scheduler.run(name, {
      ...(at === undefined ? {} : { at }),
      ...(boolFlag(args, '--force') ? { force: true } : {}),
    });

    if (json) {
      info(jsonDocument({ lock: lockSource, ...outcome }));
      return outcome.status === 'failed' || outcome.status === 'timeout' ? EXIT.failure : EXIT.ok;
    }

    const mark =
      outcome.status === 'ran'
        ? style.green(symbols.check)
        : outcome.status === 'busy'
          ? style.yellow('·')
          : outcome.status === 'skipped'
            ? style.dim('·')
            : style.red(symbols.cross);
    info(`  ${mark} ${style.bold(name)} ${outcome.status} ${style.dim(describeOutcome(outcome))}`);

    if (outcome.status === 'busy') {
      info(
        `  ${style.dim('another run holds the lock — wait for it, or pass --force to run anyway')}`,
      );
      // Not a failure: the lock did its job. A pipeline that treats it as one would retry a run
      // that is already happening.
      return EXIT.ok;
    }
    if (outcome.status === 'skipped') {
      info(
        style.dim(
          '  the app is in maintenance mode and this task does not declare evenInMaintenanceMode',
        ),
      );
      // Not a failure: the task was deliberately not run.
      return EXIT.ok;
    }
    if (outcome.status === 'timeout') {
      info(
        `  ${style.dim('the handler ignored the abort signal; the lock was released so the next tick can try')}`,
      );
    }
    return outcome.status === 'ran' ? EXIT.ok : EXIT.failure;
  } catch (error: unknown) {
    return fail(error, json);
  }
}

// ─── schedule:work ──────────────────────────────────────────────────────────

export async function scheduleWorkCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--once': { type: 'boolean', description: 'run the tasks due right now, then exit' },
    '--at': { type: 'string', description: 'pretend it is this instant (with --once)' },
    '--production': {
      type: 'boolean',
      description: 'refuse a per-process lock when a task relies on overlap prevention',
    },
    '--json': { type: 'boolean', description: 'machine-readable results' },
  });
  const json = boolFlag(args, '--json');
  const once = boolFlag(args, '--once');

  try {
    const project = await loadProject(process.cwd());
    const { scheduler, tasks, lockSource, source } = await resolveSchedule(project, {
      production: boolFlag(args, '--production'),
    });

    if (once) {
      const at = atFlag(args) ?? Date.now();
      const outcomes = await scheduler.runDue(at);

      if (json) {
        info(
          jsonDocument({
            at: new Date(at).toISOString(),
            lock: lockSource,
            due: outcomes.length,
            outcomes,
          }),
        );
      } else if (outcomes.length === 0) {
        info(`  ${style.dim(`· nothing is due at ${new Date(at).toISOString()}`)}`);
      } else {
        info(`  ${style.bold('schedule:work --once')} ${style.dim(`· ${lockSource}`)}`);
        for (const outcome of outcomes) {
          const mark =
            outcome.status === 'ran'
              ? style.green(symbols.check)
              : outcome.status === 'busy'
                ? style.yellow('·')
                : style.red(symbols.cross);
          info(
            `  ${mark} ${outcome.task} ${outcome.status} ${style.dim(describeOutcome(outcome))}`,
          );
        }
      }

      // A failed or timed-out task out of one tick is what this command exists to notice: in
      // `--once` mode it *is* the smoke test, and a cron has no retry to fall back on.
      return outcomes.some((outcome) => outcome.status === 'failed' || outcome.status === 'timeout')
        ? EXIT.failure
        : EXIT.ok;
    }

    info(`  ${style.bold('schedule:work')} ${style.dim(`· ${lockSource} · ${source}`)}`);
    info(
      `  ${style.dim(
        `${String(tasks.length)} task(s) · ticks on the minute boundary · SIGTERM to stop`,
      )}`,
    );
    info('');

    const controller = new AbortController();
    const stop = (signal: string): void => {
      info('');
      info(`  ${style.dim(`· ${signal} received — finishing the tick, then exiting`)}`);
      controller.abort(new Error(signal));
    };
    const onTerm = (): void => {
      stop('SIGTERM');
    };
    const onInt = (): void => {
      stop('SIGINT');
    };
    process.once('SIGTERM', onTerm);
    process.once('SIGINT', onInt);

    // One tick per minute, by construction: the loop sleeps to the *next* minute boundary rather
    // than adding a fixed interval, so a tick that takes 12 s does not drift a minute per hour
    // and skip a task whose whole window is one minute wide.
    const failures: TaskOutcome[] = [];
    try {
      while (!controller.signal.aborted) {
        const now = Date.now();
        const outcomes = await scheduler.runDue(now, { signal: controller.signal });
        for (const outcome of outcomes) {
          const mark =
            outcome.status === 'ran'
              ? style.green(symbols.check)
              : outcome.status === 'busy'
                ? style.yellow('·')
                : style.red(symbols.cross);
          info(
            `  ${style.dim(new Date(now).toISOString())} ${mark} ${outcome.task} ` +
              `${outcome.status} ${style.dim(describeOutcome(outcome))}`,
          );
          if (outcome.status === 'failed' || outcome.status === 'timeout') failures.push(outcome);
        }
        if (outcomes.length > 0) info('');

        if (controller.signal.aborted) break;
        await sleepUntilNextMinute(controller.signal);
      }
    } finally {
      process.off('SIGTERM', onTerm);
      process.off('SIGINT', onInt);
    }

    info(
      `  ${style.dim(
        `stopped · ${String(failures.length)} failed run(s) this session — a cron is retried by the next tick, not by this process`,
      )}`,
    );
    return EXIT.ok;
  } catch (error: unknown) {
    return fail(error, json);
  }
}

/** Sleep until the next minute boundary, or until the signal aborts. */
function sleepUntilNextMinute(signal: AbortSignal): Promise<void> {
  const now = Date.now();
  const next = Math.floor(now / 60_000) * 60_000 + 60_000;
  return new Promise((resolve) => {
    const timer = setTimeout(finish, Math.max(0, next - now));
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

// ─── schedule:table ─────────────────────────────────────────────────────────

export async function scheduleTableCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--engine': { type: 'string', description: "'postgres' (default) or 'd1'" },
    '--table': { type: 'string', description: 'default schedule_locks' },
    '--json': { type: 'boolean', description: 'one JSON document' },
  });

  const engine = stringFlag(args, '--engine') ?? 'postgres';
  if (engine !== 'postgres' && engine !== 'd1') {
    return fail(
      new UsageError(`--engine must be "postgres" or "d1" (got "${engine}")`),
      boolFlag(args, '--json'),
    );
  }

  const table = stringFlag(args, '--table');
  const statements = scheduleLockDdl({
    engine,
    ...(table === undefined ? {} : { table }),
  });

  if (boolFlag(args, '--json')) {
    info(jsonDocument({ engine, statements }));
    return EXIT.ok;
  }

  info(`  ${style.bold(`schedule locks · ${engine}`)}`);
  info('');
  for (const statement of statements) {
    info(`${statement};`);
    info('');
  }
  info(
    `  ${style.dim(
      "next: add these to a migration — `tsir make:migration` · a lock's TTL is its task's timeout plus the grace (60 s), so a crashed run frees its own name",
    )}`,
  );
  return EXIT.ok;
}
