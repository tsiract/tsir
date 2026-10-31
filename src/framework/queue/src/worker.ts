/**
 * The worker (`§ 4.2`): reserve, run, complete or fail, repeat — and stop cleanly.
 *
 * The contract a queue worker owes its operator, and how each part is met here:
 *
 *   · **at-least-once, with a lease.** A worker that dies mid-job must not hold the message
 *     forever, so `reserve` takes a lease and the backend expires it (`drivers/*`).
 *   · **retries with backoff.** A failure schedules the next attempt at
 *     `now + retryDelayMs(attempt)`; after `maxAttempts` the message goes to the dead-letter
 *     store, where `queue:failed` can show it and `queue:retry` can replay it.
 *   · **a timeout per attempt.** A job that hangs is a failure, not a worker that quietly
 *     stops making progress. The handler also gets an `AbortSignal`, for the half of the work
 *     that can be interrupted.
 *   · **graceful drain.** `stop()` stops reserving, waits up to `shutdownTimeoutMs` for the
 *     in-flight jobs, then reports what it abandoned. Abandoned messages stay leased and are
 *     redelivered — which is why the drain bound is a *budget*, not a kill.
 *
 * What it deliberately does not do: run handlers in parallel *within* one message, retry on
 * its own schedule (the backend holds `availableAt`), or swallow an unknown job — an
 * unregistered name goes straight to the dead-letter store, because a worker that drops it is
 * a worker that loses data quietly.
 */

import { jobTimeout, unknownJob } from './errors.ts';
import { JOB_DEFAULTS, type JobDefinition, type JobRegistry } from './job.ts';
import { retryDelayMs, type RetryDelayOptions } from './backoff.ts';
import type { JobMessage, QueueBackend } from './port.ts';

export interface WorkerOptions {
  readonly connection: string;
  readonly backend: QueueBackend;
  readonly jobs: JobRegistry;
  /** Messages reserved per poll. Default 1 — concurrency is per worker, not per poll. */
  readonly batchSize?: number | undefined;
  /** Handlers running at once. Default 1: a worker whose concurrency nobody chose is a thundering herd. */
  readonly concurrency?: number | undefined;
  /** How long a reserved message stays invisible. Default 60 s. */
  readonly leaseMs?: number | undefined;
  /** Idle poll interval. Default 1 000 ms. */
  readonly pollMs?: number | undefined;
  /** Budget for in-flight jobs on `stop()`. Default 30 s (`03-core.md` lifecycle). */
  readonly shutdownTimeoutMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly backoff?: RetryDelayOptions | undefined;
  readonly log?: ((line: string) => void) | undefined;
  /** Called after every message; the seam a metrics implementation plugs into. */
  readonly onResult?: ((result: JobResult) => void) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

export type JobOutcome = 'completed' | 'retried' | 'dead';

export interface JobResult {
  readonly id: string;
  readonly name: string;
  readonly attempt: number;
  readonly outcome: JobOutcome;
  readonly durationMs: number;
  readonly error?: string | undefined;
}

export interface Worker {
  /** Process one batch and return what happened. `--once` uses this. */
  drainOnce(): Promise<readonly JobResult[]>;
  /** Poll until `stop()`. Resolves when the drain budget is spent. */
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly running: boolean;
  readonly inFlight: number;
}

/** Race a promise against a timeout, keeping the loser's rejection from going unhandled. */
async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  describe: () => Error,
  shutdown: AbortSignal,
): Promise<T> {
  if (timeoutMs <= 0) return work(shutdown);

  const controller = new AbortController();
  const onShutdown = (): void => controller.abort();
  shutdown.addEventListener('abort', onShutdown, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(describe());
    }, timeoutMs);
  });

  try {
    return await Promise.race([work(controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    shutdown.removeEventListener('abort', onShutdown);
  }
}

export function createWorker(options: WorkerOptions): Worker {
  const now = options.now ?? ((): number => Date.now());
  const sleep =
    options.sleep ??
    ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? ((): void => undefined);
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const leaseMs = options.leaseMs ?? 60_000;

  let running = false;
  let stopping = false;
  const inFlight = new Set<Promise<JobResult>>();
  const shutdown = new AbortController();

  const definitionFor = (message: JobMessage): JobDefinition<unknown> | undefined =>
    options.jobs.get(message.name);

  /** One message, from reserved to completed/failed. Never throws: a worker loop must not die. */
  const runOne = async (message: JobMessage): Promise<JobResult> => {
    const started = now();
    // `reserve` already counted this attempt (`port.ts`); incrementing here would double it.
    const attempt = message.attempts;
    const definition = definitionFor(message);

    // A message for a job this worker does not have — an older deploy's job, a renamed class.
    // It goes straight to the dead-letter store: retrying cannot help, and dropping it loses
    // the only record that the work was ever asked for.
    if (definition === undefined) {
      const error = unknownJob(message.name, options.jobs.names).message;
      await options.backend.fail(message, { error });
      return {
        id: message.id,
        name: message.name,
        attempt,
        outcome: 'dead',
        durationMs: now() - started,
        error,
      };
    }

    const timeoutMs = definition.timeoutMs ?? JOB_DEFAULTS.timeoutMs;

    try {
      const payload: unknown = JSON.parse(message.payload);
      await withTimeout(
        (signal) =>
          Promise.resolve(
            definition.handle({
              payload,
              attempt,
              maxAttempts: message.maxAttempts,
              id: message.id,
              connection: message.connection,
              name: message.name,
              signal,
              log: (line) => log(`  · ${message.name}#${message.id}: ${line}`),
            }),
          ),
        timeoutMs,
        () => jobTimeout(message.name, timeoutMs, attempt),
        shutdown.signal,
      );

      await options.backend.complete(message);
      return {
        id: message.id,
        name: message.name,
        attempt,
        outcome: 'completed',
        durationMs: now() - started,
      };
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);

      // `retryable: false` sends it straight to the dead-letter store: a job that already
      // charged a card must not run twice because the response was lost.
      const canRetry = definition.retryable !== false && attempt < message.maxAttempts;
      if (!canRetry) {
        await options.backend.fail(message, { error: detail });
        return {
          id: message.id,
          name: message.name,
          attempt,
          outcome: 'dead',
          durationMs: now() - started,
          error: detail,
        };
      }

      // The job's own policy wins over the worker's default: a job that is slow to become
      // ready wants a longer base delay than the worker's generic choice.
      const retryAt =
        now() +
        retryDelayMs(attempt, { ...(options.backoff ?? {}), ...(definition.backoff ?? {}) });
      await options.backend.fail(message, { error: detail, retryAt });
      return {
        id: message.id,
        name: message.name,
        attempt,
        outcome: 'retried',
        durationMs: now() - started,
        error: detail,
      };
    }
  };

  /**
   * Reserve what there is capacity for and start it — **without waiting for it**. `start()`
   * needs the unwaiting version: a loop that awaits its own work can never notice `stopping`
   * while a job is stuck, which would make `shutdownTimeoutMs` unreachable and turn a graceful
   * drain into a hang. `drainOnce()` is the waiting version, and that is the whole difference.
   */
  const launch = async (): Promise<Promise<JobResult>[]> => {
    if (inFlight.size >= concurrency) return [];

    const messages = await options.backend.reserve({
      connection: options.connection,
      limit: Math.min(options.batchSize ?? 1, concurrency - inFlight.size),
      now: now(),
      leaseMs,
    });

    return messages.map((message) => {
      const run = runOne(message).then((result) => {
        inFlight.delete(run);
        options.onResult?.(result);
        const suffix = result.error === undefined ? '' : ` — ${result.error}`;
        log(
          `  ${result.outcome === 'completed' ? '✓' : result.outcome === 'dead' ? '✗' : '↻'} ${result.name}#${result.id} (attempt ${String(result.attempt)})${suffix}`,
        );
        return result;
      });
      inFlight.add(run);
      return run;
    });
  };

  const worker: Worker = {
    get running() {
      return running;
    },
    get inFlight() {
      return inFlight.size;
    },

    async drainOnce() {
      const started = await launch();
      if (started.length === 0) return [];
      return Promise.all(started);
    },

    async start() {
      if (running) return;
      running = true;
      stopping = false;

      const pollMs = options.pollMs ?? 1_000;
      while (!stopping) {
        if (inFlight.size >= concurrency) {
          // At capacity: one short wait, or one job finishing, then look again. Not `Promise.all`
          // — that is the hang this loop exists to survive.
          await Promise.race([Promise.race([...inFlight]), sleep(pollMs)]);
          continue;
        }

        const started = await launch();
        // Idle: nothing reserved, so wait before the next poll rather than spinning.
        if (started.length === 0) await sleep(pollMs);
      }

      // Graceful drain: stop reserving (above), then give the in-flight work its budget.
      const budget = options.shutdownTimeoutMs ?? 30_000;
      if (inFlight.size > 0) {
        log(`  · draining ${String(inFlight.size)} in-flight job(s), budget ${String(budget)} ms`);
        await Promise.race([Promise.all([...inFlight]), sleep(budget)]);
      }

      // Anything still running is abandoned: its lease expires and the backend redelivers it.
      if (inFlight.size > 0) {
        log(
          `  · abandoned ${String(inFlight.size)} job(s) — their leases will expire and they will be retried`,
        );
        shutdown.abort();
      }
      running = false;
    },

    async stop() {
      stopping = true;
    },
  };

  return worker;
}
