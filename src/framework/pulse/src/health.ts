/**
 * Health and readiness (`OBS-018`).
 *
 * Two endpoints with two different jobs, and confusing them is how a deployment takes itself down:
 *
 * · **`/health` (liveness)** answers "is this process alive?" and must **never touch a dependency**.
 * A liveness probe that pings the database restarts every worker during a database incident.
 * · **`/ready` (readiness)** answers "should traffic come here?" and touches everything: config
 * loaded, container composed, database reachable, keys valid. It returns `200` with the check
 * summary, or `503` with the failing checks named.
 *
 * The third state is what makes this useful: **`degraded`**. A failing *optional* dependency (a cache,
 * a metrics exporter) is not a reason to pull a healthy instance out of rotation — so a non-critical
 * failure reports `degraded` and keeps the `200`, while a `critical: true` check failing is `503`.
 * The distinction is declared next to the check, where the person who knows the answer can see it.
 *
 * A check that hangs is a failed check: every one runs under `timeoutMs`, and a timeout is reported
 * as `failed` with `reason: 'timeout'` rather than letting a probe hang past its own deadline.
 */

export type CheckStatus = 'ok' | 'failed' | 'skipped';

export interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly critical: boolean;
  readonly durationMs: number;
  /** A short machine-readable reason: `timeout`, `threw`, or whatever the check reported. */
  readonly reason?: string | undefined;
  /** A human sentence. Never a connection string, a password or a DSN. */
  readonly detail?: string | undefined;
}

export interface HealthCheck {
  readonly name: string;
  /** Declared here, next to the code that knows: a cache is not, a database is. */
  readonly critical?: boolean | undefined;
  /** Per-check budget. Default `timeoutMs` from the registry. */
  readonly timeoutMs?: number | undefined;
  /** Return `true`/`undefined` for healthy, or a reason string (or a rejection) for failed. */
  run(): boolean | string | undefined | Promise<boolean | string | undefined>;
}

export interface HealthReport {
  /** `ok` — everything passed. `degraded` — a non-critical check failed. `failed` — a critical one did. */
  readonly status: 'ok' | 'degraded' | 'failed';
  /** The HTTP status readiness should return: 200 for `ok`/`degraded`, 503 for `failed`. */
  readonly httpStatus: 200 | 503;
  readonly checks: readonly CheckResult[];
  readonly durationMs: number;
  readonly ts: string;
  /** Version/commit and anything else `HealthOptions.info` carries. */
  readonly info?: Readonly<Record<string, string>> | undefined;
}

export interface HealthOptions {
  readonly checks?: readonly HealthCheck[] | undefined;
  /** Default 2 000 ms per check. */
  readonly timeoutMs?: number | undefined;
  readonly clock?: (() => number) | undefined;
  /** Called for every failed check, so a readiness probe is also an alert. */
  readonly onFailure?: ((result: CheckResult) => void) | undefined;
  /** Version/commit surfaced in the report, so a probe answers `which` as well as `is it up`. */
  readonly info?: Readonly<Record<string, string>> | undefined;
}

export interface Health {
  /** Liveness: no dependencies, no I/O, no clock skew to worry about. */
  liveness(): { readonly status: 'ok'; readonly httpStatus: 200; readonly uptimeMs: number };
  /** Readiness: every check, in declaration order, under a timeout. */
  ready(): Promise<HealthReport>;
  /** The same report as a `Response`, for an HTTP route to return unchanged. */
  toResponse(report: HealthReport): Response;
}

const DEFAULT_TIMEOUT_MS = 2_000;

export function createHealth(options: HealthOptions = {}): Health {
  const checks = options.checks ?? [];
  const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const clock = options.clock ?? ((): number => Date.now());
  const startedAt = clock();

  const runCheck = async (check: HealthCheck): Promise<CheckResult> => {
    const began = clock();
    const timeoutMs = check.timeoutMs ?? defaultTimeout;
    const critical = check.critical ?? false;

    try {
      const outcome = await withTimeout(
        Promise.resolve().then(() => check.run()),
        timeoutMs,
      );
      const failed = outcome !== true && outcome !== undefined;
      const result: CheckResult = {
        name: check.name,
        status: failed ? 'failed' : 'ok',
        critical,
        durationMs: clock() - began,
        ...(failed ? { reason: 'reported', detail: String(outcome) } : {}),
      };
      if (failed) options.onFailure?.(result);
      return result;
    } catch (error: unknown) {
      const timedOut = error instanceof TimeoutError;
      const result: CheckResult = {
        name: check.name,
        status: 'failed',
        critical,
        durationMs: clock() - began,
        reason: timedOut ? 'timeout' : 'threw',
        detail: timedOut
          ? `the check did not finish within ${String(timeoutMs)} ms`
          : error instanceof Error
            ? error.message
            : String(error),
      };
      options.onFailure?.(result);
      return result;
    }
  };

  return {
    liveness() {
      return { status: 'ok', httpStatus: 200, uptimeMs: clock() - startedAt };
    },

    async ready() {
      const began = clock();
      const results: CheckResult[] = [];
      for (const check of checks) {
        results.push(await runCheck(check));
      }

      const criticalFailure = results.some(
        (result) => result.status === 'failed' && result.critical,
      );
      const anyFailure = results.some((result) => result.status === 'failed');

      return {
        status: criticalFailure ? 'failed' : anyFailure ? 'degraded' : 'ok',
        httpStatus: criticalFailure ? 503 : 200,
        checks: results,
        durationMs: clock() - began,
        ts: new Date(clock()).toISOString(),
        ...(options.info === undefined ? {} : { info: options.info }),
      };
    },

    toResponse(report) {
      return new Response(JSON.stringify(report), {
        status: report.httpStatus,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    },
  };
}

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Resolve or reject after `ms`.
 *
 * A timer is the only thing here that is not injected, because a timeout is by definition about real
 * time; the test that exercises it uses a 5 ms budget rather than a fake clock, which is also the
 * honest test of the behaviour.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(`timed out after ${String(ms)} ms`));
    }, ms);
    // `unref` where it exists: a readiness probe must not keep a CLI process alive.
    (timer as { unref?: () => void }).unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        // A rejection reason that is not an `Error` is wrapped, so a caller's `catch` always gets
        // something it can log: a check that throws a string is a check that threw nothing useful.
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
