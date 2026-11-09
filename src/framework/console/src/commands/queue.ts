/**
 * `tsir queue:*` (`CAP-004`, `§ 4.2`).
 *
 * Four commands, each the answer to a question someone asks with a terminal open:
 *
 *   · `queue:work` — "run the jobs for this connection." The connection is a **flag**, not a
 *     global: a worker is configured for a connection, and a project with a `default` and a
 *     `heavy` queue runs two workers, not one that guesses. `--once` drains a single batch,
 *     which is what a deploy smoke test and a `scheduled` handler both need.
 *   · `queue:failed` — "what is in the dead-letter store?" A listing, so it exits 0 whether the
 *     store is empty or not.
 *   · `queue:retry` — "put this back." Requires the id (or `--all`) and `--yes`; a replay re-runs
 *     work against real dependencies, and "retry everything" is a decision someone makes on
 *     purpose.
 *   · `queue:table` — "what do I migrate?" The DDL the `database` driver queries, per engine.
 *
 * Where the registry comes from: the app entry's `queues` export when there is one (the same
 * contract as `database`/`databases`), otherwise `queue.connections` in `tsir.js` built with
 * `createQueues` — which is enough for a fresh project to see the commands work. Jobs come from
 * the entry's `jobs` export; without one, `queue:work` refuses rather than polling a queue it
 * cannot run.
 */

import { pathToFileURL } from 'node:url';

import {
  createQueues,
  createJobRegistry,
  queueTableDdl,
  QUEUE_DRIVERS,
  type JobDefinition,
  type JobRegistry,
  type JobResult,
  type Queues,
  type QueueSql,
  type SyncExecutor,
} from '@tsir/queue';

import { boolFlag, parseArgs, stringFlag, type ParsedArgs } from '../args.ts';
import { EXIT, fail, info, style, UsageError, jsonDocument, symbols } from '../output.ts';
import { loadProject, type LoadedProject } from '../project.ts';

/** Duck-types the exported registry, so a wrong export is a message and not a crash. */
function isQueues(value: unknown): value is Queues {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.connection === 'function' &&
    typeof candidate.backend === 'function' &&
    typeof candidate.worker === 'function' &&
    typeof candidate.default === 'string' &&
    Array.isArray(candidate.names)
  );
}

/**
 * Jobs are recognised by shape, not by a brand: an app that defines them with `defineJob` and
 * exports the array is the contract, and anything else is a message rather than a crash five
 * minutes into a worker loop.
 */
function isJobList(value: unknown): value is readonly JobDefinition<unknown>[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry: unknown) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { name?: unknown }).name === 'string' &&
        typeof (entry as { handle?: unknown }).handle === 'function',
    )
  );
}

/**
 * An `@tsir/events` registry, recognised by shape (`EVT-4`).
 *
 * A `queued` listener *is* a job, named `event:<event>:<listener>`. If the entry exports the
 * registry but the worker never learns those job names, the relay's dispatch is
 * `CAP_UNKNOWN_JOB` — at publish time, hours after the thing that was supposed to work. So the
 * worker reads them off the registry, keyed the same way `createQueues` keys its own.
 */
interface EventsRegistryLike {
  readonly names: readonly string[];
  jobs(): readonly JobDefinition<unknown>[];
}

function isEvents(value: unknown): value is EventsRegistryLike {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate['names']) && typeof candidate['jobs'] === 'function';
}

/**
 * The entry's jobs, plus the deliveries an exported events registry brings.
 *
 * Deduplicated by name, keeping the app's own definition: an app that already wired
 * `events.jobs()` into its list is the normal case, and registering the same name twice is a
 * `TypeError` at registry creation (two handlers for one message name is a coin flip, not a
 * configuration).
 */
export function jobsFrom(module: {
  readonly jobs?: unknown;
  readonly events?: unknown;
}): readonly JobDefinition<unknown>[] {
  const declared = isJobList(module.jobs) ? module.jobs : [];
  const names = new Set(declared.map((job) => job.name));
  const fromEvents = isEvents(module.events) ? module.events.jobs() : [];
  return [...declared, ...fromEvents.filter((job) => !names.has(job.name))];
}

interface ResolvedQueues {
  readonly queues: Queues;
  readonly jobs: JobRegistry;
  readonly source: string;
}

async function resolveQueues(project: LoadedProject): Promise<ResolvedQueues> {
  const module = (await import(pathToFileURL(project.entryPath).href)) as {
    readonly queues?: unknown;
    readonly jobs?: unknown;
    readonly database?: unknown;
    readonly databases?: unknown;
  };

  const delivered = jobsFrom(module);
  const jobs = createJobRegistry(delivered);

  if (isQueues(module.queues)) {
    return { queues: module.queues, jobs, source: `${project.entryPath} (queues)` };
  }

  const databases = databasesFrom(module);
  const executors = executorsFrom(project);
  const queue = project.config.queue;
  const queues = createQueues({
    ...(queue === undefined ? {} : { queue }),
    jobs: delivered,
    ...(Object.keys(databases).length === 0 && Object.keys(executors).length === 0
      ? {}
      : {
          bindings: {
            ...(Object.keys(databases).length === 0 ? {} : { databases }),
            ...(Object.keys(executors).length === 0 ? {} : { executors }),
          },
        }),
  });
  return { queues, jobs, source: `${project.configPath} (queue.connections)` };
}

/**
 * The SQL clients a `database` connection can bind to.
 *
 * Structural, exactly like the driver: anything with `query` and `capabilities` is a client, so
 * this does not import `@tsir/database` and does not care which one the app chose. Exported
 * because `schedule:*` needs the same list for its `database` lock — one resolver, so a project
 * cannot end up with a queue that sees its client and a lock that does not.
 */
export function databasesFrom(module: {
  readonly database?: unknown;
  readonly databases?: unknown;
}): Record<string, QueueSql> {
  const isSql = (value: unknown): value is QueueSql =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { query?: unknown }).query === 'function' &&
    typeof (value as { capabilities?: unknown }).capabilities === 'object';

  const found: Record<string, QueueSql> = {};
  if (isSql(module.database)) found['default'] = module.database;

  const named = module.databases;
  if (
    typeof named === 'object' &&
    named !== null &&
    typeof (named as { connection?: unknown }).connection === 'function'
  ) {
    // A `Connections` registry: ask it for each declared name rather than poking at internals.
    const registry = named as { names?: readonly string[]; connection: (name: string) => unknown };
    for (const name of registry.names ?? []) {
      const client = registry.connection(name);
      if (isSql(client)) found[name] = client;
    }
  } else if (typeof named === 'object' && named !== null) {
    for (const [name, client] of Object.entries(named)) {
      if (isSql(client)) found[name] = client;
    }
  }
  return found;
}

/**
 * A `sync` connection needs *something* to run a job inline, and the CLI is not that thing — but
 * without an executor the registry refuses to build the connection at all, which would turn
 * "this connection cannot be drained" into `CAP_DRIVER_MISSING` and send someone looking for a
 * missing binding instead of a queue with nothing in it. So the console supplies the only honest
 * executor it has: one that says the job cannot run here.
 */
function executorsFrom(project: LoadedProject): Record<string, SyncExecutor> {
  const declared = project.config.queue?.connections ?? {};
  const executors: Record<string, SyncExecutor> = {};

  for (const [name, connection] of Object.entries(declared)) {
    if (connection.driver !== 'sync') continue;
    executors[name] = (message) =>
      Promise.reject(
        new Error(
          `connection "${name}" uses the sync driver: "${message.name}" runs inside the dispatch that created it, and there is no dispatch in a CLI command`,
        ),
      );
  }
  return executors;
}

/** A numeric flag, refused rather than coerced to `NaN` or `0`. */
function numberFlag(args: ParsedArgs, name: string): number | undefined {
  const value = stringFlag(args, name);
  if (value === undefined) return undefined;
  // coercion-ok: a CLI flag is the one place a string is *meant* to be a number;
  // `Number.isFinite` below rejects "", "abc" and "1e999" instead of accepting 0.
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new UsageError(
      `--${name.replace(/^--/, '')} expects a non-negative number (got "${value}")`,
    );
  }
  return parsed;
}

/** Resolves a connection name against the registry, with the declared names in the message. */
function connectionFlag(args: ParsedArgs, queues: Queues): string {
  // Never from the positionals: `queue:retry <id>` puts the message id there, and a command
  // that read both would report an unknown *connection* for a perfectly good message.
  const name = stringFlag(args, '--connection') ?? queues.default;
  if (!queues.names.includes(name)) {
    throw new UsageError(
      `unknown queue connection "${name}"`,
      `declared: ${queues.names.join(', ')} — a worker is configured for a connection, never for "the queue"`,
    );
  }
  return name;
}

// ─── queue:table ────────────────────────────────────────────────────────────

export async function queueTableCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--engine': { type: 'string', description: "'postgres' (default) or 'd1'" },
    '--table': { type: 'string', description: 'default queue_jobs' },
    '--dead-table': { type: 'string', description: 'default queue_dead' },
    '--outbox-table': { type: 'string', description: 'default queue_outbox' },
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
  const deadTable = stringFlag(args, '--dead-table');
  const outboxTable = stringFlag(args, '--outbox-table');
  const statements = queueTableDdl({
    engine,
    ...(table === undefined ? {} : { table }),
    ...(deadTable === undefined ? {} : { deadTable }),
    ...(outboxTable === undefined ? {} : { outboxTable }),
  });

  if (boolFlag(args, '--json')) {
    info(jsonDocument({ engine, statements }));
    return EXIT.ok;
  }

  info(`  ${style.bold(`queue tables · ${engine}`)}`);
  info('');
  for (const statement of statements) {
    info(`${statement};`);
    info('');
  }
  info(
    `  ${style.dim('next: add these to a migration — `tsir make:migration` · the outbox table is written by `@tsir/events`')}`,
  );
  return EXIT.ok;
}

// ─── queue:work ─────────────────────────────────────────────────────────────

export async function queueWorkCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--connection': {
      type: 'string',
      description: 'which connection to drain (default: the declared default)',
    },
    '--once': {
      type: 'boolean',
      description: 'drain one batch and exit — what a scheduled handler runs',
    },
    '--concurrency': { type: 'string', description: 'jobs in flight at once (default 1)' },
    '--batch-size': { type: 'string', description: 'messages reserved per poll (default 1)' },
    '--json': { type: 'boolean', description: 'machine-readable results' },
  });
  const json = boolFlag(args, '--json');

  let resolved: ResolvedQueues;
  let connection: string;
  try {
    resolved = await resolveQueues(await loadProject(process.cwd()));
    connection = connectionFlag(args, resolved.queues);
  } catch (error: unknown) {
    return fail(error, json);
  }

  const { queues, jobs, source } = resolved;
  const queue = queues.connection(connection);

  if (jobs.names.length === 0) {
    return fail(
      new UsageError(
        'no jobs are registered',
        'export `jobs = [SendReceipt, …]` from the app entry — a worker with no registry would dead-letter every message it reserved',
      ),
      json,
    );
  }

  if (!queue.capabilities.persistent) {
    return fail(
      new UsageError(
        `connection "${connection}" uses the "${queue.driver}" driver, which has nothing to drain`,
        queue.driver === 'sync'
          ? 'the sync driver runs the job inside `dispatch`, so a worker would poll an empty store forever'
          : 'this driver keeps messages in the process that dispatched them, so a worker in another process would never see one',
      ),
      json,
    );
  }

  const concurrency = numberFlag(args, '--concurrency');
  const batchSize = numberFlag(args, '--batch-size');
  const worker = queues.worker(connection, {
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(batchSize === undefined ? {} : { batchSize }),
  });

  const summarise = (results: readonly JobResult[]): Record<string, number> => {
    const counts = { completed: 0, retried: 0, dead: 0 };
    for (const result of results) counts[result.outcome] += 1;
    return counts;
  };

  if (boolFlag(args, '--once')) {
    const results = await worker.drainOnce();
    const counts = summarise(results);

    if (json) {
      info(
        jsonDocument({
          ok: counts.dead === 0,
          source,
          connection,
          driver: queue.driver,
          drained: results.length,
          ...counts,
          results: results.map((result) => ({
            id: result.id,
            name: result.name,
            attempt: result.attempt,
            outcome: result.outcome,
            durationMs: result.durationMs,
            ...(result.error === undefined ? {} : { error: result.error }),
          })),
        }),
      );
    } else {
      info(
        `  ${style.bold('queue:work --once')} ${style.dim(`· ${connection} · ${queue.driver}`)}`,
      );
      for (const result of results) {
        const mark =
          result.outcome === 'completed'
            ? style.green(symbols.check)
            : result.outcome === 'dead'
              ? style.red(symbols.cross)
              : style.yellow('↻');
        const detail = result.error === undefined ? '' : ` ${style.dim(result.error)}`;
        info(`  ${mark} ${result.name}#${result.id} (attempt ${String(result.attempt)})${detail}`);
      }
      info('');
      info(
        `  ${String(results.length)} drained · ${String(counts.completed)} completed · ${String(counts.retried)} retried · ${String(counts.dead)} dead`,
      );
    }

    // A dead letter out of a single batch is a failure a pipeline should notice: in `--once`
    // mode this command *is* the smoke test.
    return counts.dead === 0 ? EXIT.ok : EXIT.failure;
  }

  info(
    `  ${style.bold('queue:work')} ${style.dim(`· ${connection} · ${queue.driver} · ${source}`)}`,
  );
  info(
    `  ${style.dim(`${String(jobs.names.length)} job(s) registered · stop with SIGTERM for a graceful drain`)}`,
  );
  info('');

  const stopOn = (signal: 'SIGTERM' | 'SIGINT'): (() => void) => {
    const handler = (): void => {
      info('');
      info(`  ${style.dim(`· ${signal} received — draining, then exiting`)}`);
      void worker.stop();
    };
    process.once(signal, handler);
    return (): void => {
      process.off(signal, handler);
    };
  };
  const detach = [stopOn('SIGTERM'), stopOn('SIGINT')];

  try {
    await worker.start();
  } finally {
    for (const detachOne of detach) detachOne();
  }

  info(
    `  ${style.green(symbols.check)} worker stopped · ${String(worker.inFlight)} job(s) still in flight`,
  );
  return EXIT.ok;
}

// ─── queue:failed ───────────────────────────────────────────────────────────

export async function queueFailedCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--connection': {
      type: 'string',
      description: 'which connection to read (default: the declared default)',
    },
    '--limit': { type: 'string', description: 'how many dead letters to list (default 50)' },
    '--json': { type: 'boolean', description: 'machine-readable list' },
  });
  const json = boolFlag(args, '--json');

  try {
    const { queues } = await resolveQueues(await loadProject(process.cwd()));
    const connection = connectionFlag(args, queues);
    const limit = numberFlag(args, '--limit') ?? 50;
    const dead = await queues.backend(connection).dead(limit);

    if (json) {
      info(
        jsonDocument({
          connection,
          count: dead.length,
          failed: dead.map((message) => ({
            id: message.id,
            name: message.name,
            attempts: message.attempts,
            maxAttempts: message.maxAttempts,
            availableAt: message.availableAt,
            createdAt: message.createdAt,
            ...(message.lastError === undefined ? {} : { error: message.lastError }),
          })),
        }),
      );
      return EXIT.ok;
    }

    info(`  ${style.bold('queue:failed')} ${style.dim(`· ${connection}`)}`);
    if (dead.length === 0) {
      info('');
      info(`  ${style.green(symbols.check)} the dead-letter store is empty`);
      return EXIT.ok;
    }

    for (const message of dead) {
      info('');
      info(
        `  ${style.red(symbols.cross)} ${message.name}#${message.id} ${style.dim(`(${String(message.attempts)}/${String(message.maxAttempts)} attempts)`)}`,
      );
      info(`    ${style.dim(message.lastError ?? 'no error recorded')}`);
    }
    info('');
    info(
      `  ${style.dim(`retry one with \`tsir queue:retry <id> --connection ${connection} --yes\``)}`,
    );
    return EXIT.ok;
  } catch (error: unknown) {
    return fail(error, json);
  }
}

// ─── queue:retry ────────────────────────────────────────────────────────────

export async function queueRetryCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--connection': { type: 'string', description: 'which connection to replay into' },
    '--all': { type: 'boolean', description: 'replay everything in the dead-letter store' },
    '--limit': { type: 'string', description: 'with --all: at most this many (default 50)' },
    '--yes': { type: 'boolean', description: 'confirm; without it the command only reports' },
    '--json': { type: 'boolean', description: 'machine-readable result' },
  });
  const json = boolFlag(args, '--json');
  const all = boolFlag(args, '--all');
  const id = args.positionals[0];

  if (!all && id === undefined) {
    return fail(
      new UsageError(
        'queue:retry needs a message id, or --all',
        'list them with `tsir queue:failed` — a replay re-runs real work, so it is never the default',
      ),
      json,
    );
  }

  try {
    const { queues } = await resolveQueues(await loadProject(process.cwd()));
    const connection = connectionFlag(args, queues);
    const backend = queues.backend(connection);

    if (!boolFlag(args, '--yes')) {
      const target = all
        ? `every dead letter on "${connection}" (at most ${String(numberFlag(args, '--limit') ?? 50)})`
        : `"${String(id)}" on "${connection}"`;
      info(`  ${style.dim('·')} would replay ${target} — re-run with --yes`);
      return EXIT.ok;
    }

    if (!all) {
      const replayed = await backend.replay(String(id), Date.now());
      if (!replayed) {
        return fail(
          new UsageError(
            `no dead letter "${String(id)}" on connection "${connection}"`,
            'list them with `tsir queue:failed`',
          ),
          json,
        );
      }
      if (json) {
        info(jsonDocument({ ok: true, connection, replayed: [String(id)] }));
        return EXIT.ok;
      }
      info(
        `  ${style.green(symbols.check)} replayed ${String(id)} on ${connection} ${style.dim('(fresh attempt budget)')}`,
      );
      return EXIT.ok;
    }

    const limit = numberFlag(args, '--limit') ?? 50;
    const dead = await backend.dead(limit);
    const replayed: string[] = [];
    for (const message of dead) {
      if (await backend.replay(message.id, Date.now())) replayed.push(message.id);
    }

    if (json) {
      info(jsonDocument({ ok: true, connection, replayed, failed: dead.length - replayed.length }));
      return EXIT.ok;
    }
    info(
      `  ${style.green(symbols.check)} replayed ${String(replayed.length)} of ${String(dead.length)} dead letter(s) on ${connection}`,
    );
    return EXIT.ok;
  } catch (error: unknown) {
    return fail(error, json);
  }
}

/** The driver names `tsir.js` may write, exposed so `doctor` can suggest them. */
export const QUEUE_DRIVER_NAMES: readonly string[] = QUEUE_DRIVERS;
