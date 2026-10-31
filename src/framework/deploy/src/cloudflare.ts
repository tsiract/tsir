/**
 * Cloudflare Workers adapter (`DPL-008`).
 *
 * A Worker is not "a function" — it is an export shape. `fetch`, `queue` and `scheduled`
 * are three different triggers with three different failure semantics, and the least
 * privilege the platform offers is simply **not exporting the ones a unit does not
 * serve**: a queue unit with a `fetch` export is a queue unit with a public URL.
 *
 * So this adapter does three things and nothing else:
 *
 *   · **It exports only what the unit declares.** A unit with `queue` and no `fetch`
 *     produces an object with `queue` alone.
 *   · **It turns a failure into the platform's decision.** An uncaught error in `fetch`
 *     becomes a problem+json `500` (a Worker that throws returns Cloudflare's own error
 *     page, which no client can parse); an uncaught error in `queue` becomes
 *     `retryAll()` or `ackAll()` depending on whether retrying could help; an uncaught
 *     error in `scheduled` is reported and swallowed, because a cron invocation has no
 *     retry to trigger.
 *   · **It stays a seam.** No `node:`, no `wrangler`, no `@cloudflare/workers-types` —
 *     the shapes below are the four methods a unit actually touches, so the whole adapter
 *     is testable with plain objects and bundles for the browser target.
 */

import { problemResponse, type HttpErrorCode, type ProblemOptions } from '@tsir/http';

/** The slice of `ExecutionContext` a unit may use. */
export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

/** The slice of `Message` a unit may use. */
export interface QueueMessageLike<Body = unknown> {
  readonly id: string;
  readonly body: Body;
  readonly attempts?: number;
}

/** The slice of `MessageBatch` a unit may use. */
export interface QueueBatchLike<Body = unknown> {
  readonly queue: string;
  readonly messages: readonly QueueMessageLike<Body>[];
  ackAll(): void;
  retryAll(options?: { readonly delaySeconds?: number }): void;
}

/** The slice of `ScheduledController` a unit may use. */
export interface ScheduledControllerLike {
  readonly scheduledTime: number;
  readonly cron: string;
}

export type CloudflareTrigger = 'fetch' | 'queue' | 'scheduled';

/** What one unit serves. Every member is optional: a unit declares its own triggers. */
export interface CloudflareUnit<Env> {
  readonly unit: string;
  readonly fetch?:
    | ((request: Request, env: Env, execution: ExecutionContextLike) => Promise<Response>)
    | undefined;
  readonly queue?: ((batch: QueueBatchLike, env: Env) => Promise<void>) | undefined;
  readonly scheduled?:
    ((controller: ScheduledControllerLike, env: Env) => Promise<void>) | undefined;
}

export interface CloudflareHandler<Env> {
  readonly fetch?:
    | ((request: Request, env: Env, execution: ExecutionContextLike) => Promise<Response>)
    | undefined;
  readonly queue?: ((batch: QueueBatchLike, env: Env) => Promise<void>) | undefined;
  readonly scheduled?:
    ((controller: ScheduledControllerLike, env: Env) => Promise<void>) | undefined;
}

export interface CloudflareOptions {
  /** Reported before the platform sees the failure. Never given the response body. */
  readonly onError?:
    | ((
        error: unknown,
        info: { readonly unit: string; readonly trigger: CloudflareTrigger },
      ) => void)
    | undefined;
  /** How long a retried queue message waits. Default: the platform's own backoff. */
  readonly retryDelaySeconds?: number | undefined;
  /** Replaces the default problem code for an uncaught `fetch` error. */
  readonly problemFor?:
    | ((error: unknown) => { readonly code: HttpErrorCode; readonly options?: ProblemOptions })
    | undefined;
}

/**
 * Whether an error is worth retrying.
 *
 * Deliberately duck-typed: a queue handler may throw a `CallError` from `@tsir/link`, a
 * `TsirError` from any package, or an `Error` of its own. The contract is one field —
 * `retryable` — and the absence of it means "do not retry", because retrying a bug in a
 * loop is how one bad message becomes a queue-wide outage.
 */
export function isRetryable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const retryable = (error as { retryable?: unknown }).retryable;
  if (retryable === true) return true;
  if (retryable === false) return false;
  const kind = (error as { kind?: unknown }).kind;
  return kind === 'unavailable' || kind === 'timeout' || kind === 'rate_limited';
}

export function toCloudflareHandler<Env = unknown>(
  unit: CloudflareUnit<Env>,
  options: CloudflareOptions = {},
): CloudflareHandler<Env> {
  const report = (error: unknown, trigger: CloudflareTrigger): void => {
    options.onError?.(error, { unit: unit.unit, trigger });
  };

  const handler: {
    fetch?: (request: Request, env: Env, execution: ExecutionContextLike) => Promise<Response>;
    queue?: (batch: QueueBatchLike, env: Env) => Promise<void>;
    scheduled?: (controller: ScheduledControllerLike, env: Env) => Promise<void>;
  } = {};

  const serve = unit.fetch;
  if (serve !== undefined) {
    handler.fetch = async (request, env, execution) => {
      try {
        return await serve(request, env, execution);
      } catch (error) {
        report(error, 'fetch');
        // The response body never carries the message or the stack: a Worker error page is
        // worse (unparseable), and echoing an internal message is an information leak.
        if (options.problemFor !== undefined) {
          const mapped = options.problemFor(error);
          return problemResponse(mapped.code, mapped.options ?? {});
        }
        return problemResponse('HTP_HANDLER_ERROR', {
          detail: `the ${unit.unit} unit failed to handle the request`,
        });
      }
    };
  }

  const consume = unit.queue;
  if (consume !== undefined) {
    handler.queue = async (batch, env) => {
      try {
        await consume(batch, env);
      } catch (error) {
        report(error, 'queue');
        if (isRetryable(error)) {
          batch.retryAll(
            options.retryDelaySeconds === undefined
              ? {}
              : { delaySeconds: options.retryDelaySeconds },
          );
          return;
        }
        // A message the handler cannot process will not become processable by being handed
        // back: acknowledge it, so one poison message does not block the queue forever.
        batch.ackAll();
      }
    };
  }

  const run = unit.scheduled;
  if (run !== undefined) {
    handler.scheduled = async (controller, env) => {
      try {
        await run(controller, env);
      } catch (error) {
        // A cron has no retry to trigger, so throwing only marks the invocation failed.
        // Report it and return normally: the next tick is the retry.
        report(error, 'scheduled');
      }
    };
  }

  // The local object is built as `CloudflareHandler`'s shape, so returning it is the
  // contract: an accidental extra property would be a trigger the platform starts calling.
  return handler;
}

/** Which triggers a unit exports — used by `deploy:plan` and by the emitter's checks. */
export function triggersOf<Env>(unit: CloudflareUnit<Env>): readonly CloudflareTrigger[] {
  const triggers: CloudflareTrigger[] = [];
  if (unit.fetch !== undefined) triggers.push('fetch');
  if (unit.queue !== undefined) triggers.push('queue');
  if (unit.scheduled !== undefined) triggers.push('scheduled');
  return triggers;
}
