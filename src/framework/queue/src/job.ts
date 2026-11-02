/**
 * Jobs (`§ 4.2`).
 *
 * A job is a **name plus a handler plus its retry policy**, declared once and dispatched by
 * name. The name is what travels: the payload is JSON, and the handler is looked up in the
 * worker that receives it, which is why a job class is not serialisable and a job *definition*
 * is all a queue ever needs to agree on.
 *
 * Three defaults are opinionated:
 *
 *   · **5 attempts**, not infinite. A job that fails five times with exponential backoff has
 *     failed, and a dead-letter table that never fills is a dead-letter table nobody watches.
 *   · **Backoff is exponential with jitter**, because a hundred workers retrying on the same
 *     schedule is a thundering herd, and the jitter is what prevents it (`backoff.ts`).
 *   · **A timeout is mandatory-by-default** (30 s). A job with no bound is a worker that stops
 *     reporting health while it still looks alive.
 */

/** What a handler receives. Deliberately small: a worker is not a request scope. */
export interface JobContext<Payload> {
  readonly payload: Payload;
  /** 1 for the first run; the retry policy counts against `maxAttempts`. */
  readonly attempt: number;
  readonly maxAttempts: number;
  /** Stable across retries of the same dispatch — use it as the idempotency key. */
  readonly id: string;
  readonly connection: string;
  readonly name: string;
  /** Origin request id, when the dispatch carried one (OBS-012). */
  readonly requestId?: string | undefined;
  /** Cooperative cancellation: fires on `timeoutMs` and on a worker shutdown. */
  readonly signal: AbortSignal;
  /** Structured progress for logs — never for control flow. */
  log(message: string): void;
}

export interface BackoffOptions {
  /** Delay before the first retry. Default 1 000 ms. */
  readonly baseMs?: number | undefined;
  /** Multiplier per attempt. Default 2. */
  readonly factor?: number | undefined;
  /** Ceiling for one delay. Default 5 minutes. */
  readonly maxMs?: number | undefined;
  /** `0` disables jitter (tests); default `0.2` — ±20 %. */
  readonly jitter?: number | undefined;
}

export interface JobDefinition<Payload> {
  /** The name that travels in the message. Unique in a project. */
  readonly name: string;
  /**
   * Never set. It keeps the payload type on the definition, so `queue.dispatch(job, payload)`
   * can check the payload against the job it is sent to (TST-013).
   */
  readonly __payload?: Payload | undefined;
  handle(context: JobContext<Payload>): Promise<void> | void;
  /** Total attempts, first run included. Default 5. */
  readonly maxAttempts?: number | undefined;
  readonly backoff?: BackoffOptions | undefined;
  /** Default 30 000 ms. `0` means "no timeout", and the worker reports it. */
  readonly timeoutMs?: number | undefined;
  /** Preferred connection; checked against the registry at dispatch. */
  readonly connection?: string | undefined;
  /**
   * Whether retrying this job is safe when the handler may have partially run. Default
   * `true`; `false` sends a failed attempt straight to the dead-letter table, because a job
   * that already charged a card must not be retried just because the response was lost.
   */
  readonly retryable?: boolean | undefined;
  /** Human-readable queue label, for `queue:failed` output and metrics. */
  readonly description?: string | undefined;
}

/** Keep the payload type inferable from `handle`. */
export function defineJob<Payload>(definition: JobDefinition<Payload>): JobDefinition<Payload> {
  return definition;
}

/** The registry a worker dispatches through: name → definition. */
export interface JobRegistry {
  readonly names: readonly string[];
  get(name: string): JobDefinition<unknown> | undefined;
  has(name: string): boolean;
}

export function createJobRegistry(
  jobs: readonly JobDefinition<never>[] | readonly JobDefinition<unknown>[],
): JobRegistry {
  const byName = new Map<string, JobDefinition<unknown>>();

  for (const job of jobs as readonly JobDefinition<unknown>[]) {
    const existing = byName.get(job.name);
    if (existing !== undefined) {
      // Two definitions of one name is a dispatch that runs one of them and nobody knows which.
      throw new TypeError(`queue: duplicate job name "${job.name}"`);
    }
    byName.set(job.name, job);
  }

  return {
    names: [...byName.keys()],
    get: (name) => byName.get(name),
    has: (name) => byName.has(name),
  };
}

/** Retry defaults, exported so a worker and a test agree instead of repeating numbers. */
export const JOB_DEFAULTS = {
  maxAttempts: 5,
  timeoutMs: 30_000,
  backoff: { baseMs: 1_000, factor: 2, maxMs: 300_000, jitter: 0.2 },
} as const;
