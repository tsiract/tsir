/**
 * The `cloudflare-queues` driver (`§ 4.2`, `QUEUE-15`) — the production default on Workers.
 *
 * Queues is **push-driven**, and that is the one thing that makes this driver different from
 * every other one: the platform calls your Worker's `queue()` handler with a batch; there is
 * no `receive` to call. The port is a pull port (`reserve`), so the driver bridges the two:
 * `deliver(batch)` takes the platform's batch into an inbox, and `reserve()` hands messages
 * from that inbox to the worker. `ack()`/`retry()` on the platform message become
 * `complete`/`fail`. Everything above the driver — retries, backoff, the dead-letter store,
 * `queue:work --once` — is unchanged, which is the point of having a port.
 *
 * Four honest capability answers:
 *
 *   · **`transactional: false`.** A Queues `send` is an HTTP call to Cloudflare; it cannot
 *     enlist in a D1 `batch()`. This is the whole reason the outbox exists, and why
 *     `requireOutbox` refuses this driver without one.
 *   · **`delay: true`, bounded.** `delaySeconds` goes up to 12 hours; a dispatch asking for
 *     longer is refused rather than silently clamped. A job that runs four hours early is a
 *     bug; one that silently runs *days* early is a support ticket nobody can reproduce.
 *   · **`ordered: false`.** Queues does not guarantee order, and a driver that pretended
 *     otherwise would make a consumer's ordering assumption invisible until traffic grew.
 *   · **`deadLetter` only with a store.** Queues has a native DLQ, but it is the *broker's*:
 *     you can redrive all of it, not replay one message by id. When an SQL client is
 *     supplied the driver keeps `queue_dead` itself (the same table `queue:table` prints), so
 *     `queue:failed`/`queue:retry` behave exactly as they do on the `database` driver. Without
 *     one, `deadLetter` is `false` and the commands say so instead of pretending.
 *
 * Retries are the platform's to schedule (`retry({ delaySeconds })`), and the *decision* is
 * ours: the worker computes the backoff and the driver translates it. One authority, one
 * schedule — a driver that also retried on its own would double every delay.
 */

import { unsupportedOperation } from '../errors.ts';
import { createDeadLetterStore, type DeadLetterStore } from '../dead.ts';
import type { JobMessage, QueueBackend, QueueCapabilities, QueueDriver } from '../port.ts';
import type { QueueSql } from '../sql.ts';

/** Queues' own ceiling: 12 hours of `delaySeconds`. */
export const CLOUDFLARE_QUEUES_MAX_DELAY_SECONDS = 12 * 60 * 60;

export const CLOUDFLARE_QUEUES_CAPABILITIES = {
  transactional: false,
  delay: true,
  cancel: false,
  persistent: true,
  ordered: false,
  deadLetter: true,
  // Queues has no dedupe: the same body sent twice is delivered twice. `JobContext.id` is what
  // makes that harmless, which is why the port promises it rather than promising exactly-once.
  idempotency: false,
} as const satisfies QueueCapabilities;

/** One message as the platform hands it to a `queue()` handler. */
export interface QueueMessageLike {
  readonly id: string;
  readonly body: unknown;
  /** Deliveries so far, **including this one** — exactly what the port wants. */
  readonly attempts: number;
  ack(): void;
  retry(options?: { readonly delaySeconds?: number | undefined }): void;
}

export interface QueueBatchLike {
  readonly queue: string;
  readonly messages: readonly QueueMessageLike[];
}

/** The producer side: the binding a Worker gets from `[[queues.producers]]`. */
export interface QueueProducerLike {
  send(body: unknown, options?: { readonly delaySeconds?: number | undefined }): Promise<unknown>;
  sendBatch?(
    messages: readonly { readonly body: unknown; readonly delaySeconds?: number | undefined }[],
  ): Promise<unknown>;
}

export interface CloudflareQueuesOptions {
  readonly producer: QueueProducerLike;
  /**
   * The dead-letter store. Omit it and the driver reports `deadLetter: false` — it does not
   * quietly ack exhausted messages into the void, it refuses to claim it can list them.
   */
  readonly sql?: QueueSql | undefined;
  /** Default `queue_dead`. */
  readonly deadTable?: string | undefined;
  readonly now?: (() => number) | undefined;
}

/** The backend, plus the one method the platform — not the port — needs. */
export interface PushDrivenBackend extends QueueBackend {
  /** Take a batch from the `queue()` handler. Returns how many were accepted and dropped. */
  deliver(batch: QueueBatchLike): Promise<{ readonly accepted: number; readonly rejected: number }>;
}

interface InboxEntry {
  readonly message: JobMessage;
  readonly delivered: QueueMessageLike;
}

/** A body the driver recognises as one of its own messages. */
function asMessage(body: unknown): JobMessage | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string') return undefined;
  if (typeof candidate.payload !== 'string') return undefined;
  return {
    id: candidate.id,
    name: candidate.name,
    payload: candidate.payload,
    connection: typeof candidate.connection === 'string' ? candidate.connection : 'default',
    attempts: typeof candidate.attempts === 'number' ? candidate.attempts : 0,
    maxAttempts: typeof candidate.maxAttempts === 'number' ? candidate.maxAttempts : 5,
    availableAt: typeof candidate.availableAt === 'number' ? candidate.availableAt : 0,
    createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : 0,
    ...(typeof candidate.idempotencyKey === 'string'
      ? { idempotencyKey: candidate.idempotencyKey }
      : {}),
    ...(typeof candidate.lastError === 'string' ? { lastError: candidate.lastError } : {}),
  };
}

export function cloudflareQueuesDriver(options: CloudflareQueuesOptions): QueueDriver<never> {
  const now = options.now ?? ((): number => Date.now());

  return {
    name: 'cloudflare-queues',
    capabilities:
      options.sql === undefined
        ? { ...CLOUDFLARE_QUEUES_CAPABILITIES, deadLetter: false }
        : CLOUDFLARE_QUEUES_CAPABILITIES,

    open(): QueueBackend {
      // Two maps, because a message has two lives: `inbox` is what the platform delivered and
      // nothing has taken yet, `inFlight` is what a worker holds. `complete`/`fail` must reach
      // the platform message in **both** cases — a driver that forgot the second one would
      // acknowledge nothing and retry nothing, which is the quietest data loss there is.
      const inbox = new Map<string, InboxEntry>();
      const inFlight = new Map<string, InboxEntry>();
      const deadStore: DeadLetterStore | undefined =
        options.sql === undefined
          ? undefined
          : createDeadLetterStore({
              sql: options.sql,
              ...(options.deadTable === undefined ? {} : { table: options.deadTable }),
            });

      const capabilities: QueueCapabilities =
        deadStore === undefined
          ? { ...CLOUDFLARE_QUEUES_CAPABILITIES, deadLetter: false }
          : CLOUDFLARE_QUEUES_CAPABILITIES;

      /**
       * **The queue is the address.** A Worker consumes the queues its
       * `[[queues.consumers]]` declares, and a batch arrives already routed: filtering it by
       * the payload's `connection` would strand a message whose producer wrote a different
       * name — accepted, never run, and invisible except as a queue that never drains. So
       * `reserve` ignores the connection: one backend, one queue, and the platform did the
       * addressing. That is the opposite of the `database` driver, where one table holds every
       * connection and `reserve` must filter.
       */
      const backend: PushDrivenBackend = {
        name: 'cloudflare-queues',
        capabilities,
        now,

        async push(message) {
          const delaySeconds = Math.max(0, Math.ceil((message.availableAt - now()) / 1_000));
          if (delaySeconds > CLOUDFLARE_QUEUES_MAX_DELAY_SECONDS) {
            // Refused, not clamped: the caller asked for a job that runs tomorrow, and a
            // message that quietly arrives noon today is the kind of bug that looks like a
            // scheduling bug in the application for a week.
            throw unsupportedOperation(
              message.connection,
              'cloudflare-queues',
              `a delay of ${String(delaySeconds)} s`,
              `the platform's maximum is ${String(CLOUDFLARE_QUEUES_MAX_DELAY_SECONDS)} s (12 h)`,
            );
          }
          const sendOptions = delaySeconds === 0 ? undefined : { delaySeconds };
          await options.producer.send(message, sendOptions);
        },

        async deliver(batch) {
          let accepted = 0;
          let rejected = 0;

          for (const delivered of batch.messages) {
            const parsed = asMessage(delivered.body);
            if (parsed === undefined) {
              // A message this driver did not write — an older deploy, another producer on the
              // same queue. Acknowledge it: retrying cannot help, and a message that loops
              // forever is a queue-wide outage rather than one bad job.
              delivered.ack();
              rejected += 1;
              continue;
            }

            // The platform's count is the truth about deliveries, and it is what the worker
            // uses as the attempt number — so a retry is never counted twice.
            const message: JobMessage = { ...parsed, attempts: delivered.attempts };
            inbox.set(message.id, { message, delivered });
            accepted += 1;
          }

          return { accepted, rejected };
        },

        async reserve({ limit, now: clock }) {
          const claimed: JobMessage[] = [];
          for (const [id, entry] of inbox) {
            if (claimed.length >= limit) break;
            if (entry.message.availableAt > clock) continue;
            inbox.delete(id);
            inFlight.set(id, entry);
            claimed.push(entry.message);
          }
          return claimed;
        },

        async complete(message) {
          const entry = inFlight.get(message.id) ?? inbox.get(message.id);
          inFlight.delete(message.id);
          inbox.delete(message.id);
          entry?.delivered.ack();
        },

        async fail(message, { error, retryAt }) {
          const entry = inFlight.get(message.id) ?? inbox.get(message.id);
          inFlight.delete(message.id);
          inbox.delete(message.id);

          if (retryAt === undefined) {
            // Exhausted. The message is acknowledged *and* recorded: acking alone loses it,
            // and retrying alone loops it until the platform's own limit gives up silently.
            if (deadStore !== undefined) {
              await deadStore.record({ ...message, lastError: error });
            }
            entry?.delivered.ack();
            return;
          }

          const delaySeconds = Math.max(0, Math.ceil((retryAt - now()) / 1_000));
          entry?.delivered.retry({ delaySeconds });
        },

        async dead(limit) {
          return deadStore === undefined ? [] : deadStore.list(limit);
        },

        async replay(id, clock) {
          if (deadStore === undefined) return false;
          const [message] = (await deadStore.list(1_000)).filter((entry) => entry.id === id);
          if (message === undefined) return false;

          // Replay means "put it back on the platform queue", so it goes through `push` and is
          // redelivered to this same Worker — the same path a fresh dispatch would take.
          await backend.push({ ...message, attempts: 0, availableAt: clock });
          await deadStore.remove(id);
          return true;
        },

        async discard(id) {
          if (deadStore === undefined) return false;
          return deadStore.remove(id);
        },

        async size() {
          // Nothing is stored *here*: what is in flight lives in Cloudflare's queue, and
          // reading it would cost a listing API call this driver deliberately does not make.
          // The remote figure is `wrangler queues info`.
          return 0;
        },

        async purge() {
          inbox.clear();
          inFlight.clear();
          await deadStore?.clear();
        },
      };

      return backend;
    },
  };
}

export const cloudflareQueuesCapabilities = CLOUDFLARE_QUEUES_CAPABILITIES;

/**
 * The Worker's `queue` export, in one line.
 *
 * ```ts
 * export default createCloudflareEntry({ queue: queueConsumer({ backend, worker }) });
 * ```
 *
 * Delivering and draining in the same call is what makes the platform's batch meaningful: the
 * invocation does not return until its own messages are settled, so a crash mid-batch is the
 * platform's redelivery rather than a message sitting in an inbox that died with the isolate.
 */
export function queueConsumer(input: {
  readonly backend: PushDrivenBackend;
  readonly drain: () => Promise<unknown>;
}): (batch: QueueBatchLike) => Promise<void> {
  return async (batch) => {
    await input.backend.deliver(batch);
    await input.drain();
  };
}
